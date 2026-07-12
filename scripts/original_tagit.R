# =============================================================================
# Plant Photo Captioner
# A small Shiny app to caption plant photos on a Mac, choosing species from
# a list, then import them into Apple Photos with the captions already attached.
#
# WHAT IT DOES
#   1. Reads a folder of photos (JPEG / HEIC / TIFF / common RAW), scales to
#      thousands of files
#   2. Shows each photo with the date taken, GPS (if any), and a nearby
#      locality hint from the observation log
#   3. Lets you pick one or more taxa from a searchable list, or type a new
#      one; family is filled in automatically and can be added when missing
#   4. Suggests taxa from an observation log (what you saw near that time) -
#      click a suggestion, or press 1-9 to add it
#   5. "Recently used" taxa appear as one-tap buttons
#   6. "cf." checkbox marks an uncertain determination
#   7. Copy the last saved caption (button or 'c') - fast for repeats
#   8. Rotate (button or 'r'), zoom (click the photo, click again to undo),
#      skip / delete / mark "can't determine" (button or 'i'), one-level
#      undo (button or 'u')
#   9. Photos are physically organized by status as you work: untouched
#      photos stay in PHOTO_FOLDER, captioned ones move to _labelled,
#      skipped ones to _skipped, undetermined ones to _undetermined (caption
#      "Indet."), deleted ones to _deleted (recoverable). A "Show:" filter
#      lets you view any combination of these five states.
#  10. Progress bar + status badge (untouched / labelled / skipped /
#      undetermined / deleted)
#  11. Writes the caption into the photo's metadata with exiftool; optionally
#      appends genuinely new taxa to the backbone file so they persist
#  12. Apple Photos then reads that caption automatically when you import
#
# ONE-TIME SETUP (in Terminal)
#   brew install exiftool          # writes / reads the caption metadata
#   (sips is built into macOS and is used for previews and rotation)
#   In R:  install.packages(c("shiny", "dplyr", "readr", "jsonlite", "leaflet"))
#
# HOW THE CAPTION REACHES APPLE PHOTOS
#   The app writes three standard fields that Photos reads as the "caption":
#     IPTC:Caption-Abstract, XMP-dc:Description, EXIF:ImageDescription
#   After captioning, bring the photos into Photos by EITHER:
#     - Photos app:  File > Import, choose the folder, or
#     - osxphotos:   osxphotos import /path/to/folder --exiftool
#   Tip: caption ONE photo first and import it to confirm the result, before
#   doing the whole batch. (RAW files can behave differently from JPEG/HEIC.)
#
# Originals are written in place (creation date preserved). Keep a backup of
# the folder before a big run.
#
# KEYBOARD SHORTCUTS (ignored while typing in a text field)
#   Right / Left  - next / previous photo
#   1-9           - add that numbered suggestion to the taxon list
#   r             - rotate the current photo 90 degrees
#   c             - copy the last saved caption into the box
#   u             - undo the last save / skip / delete / rotate / undetermined
#   i             - mark "can't determine" (writes "Indet.", moves to _undetermined)
#   Delete        - delete the photo, but only if no taxon is chosen yet
#   Enter         - save and advance (or pick the highlighted taxon first)
# =============================================================================

library(shiny)
library(dplyr)
library(readr)
library(jsonlite)
library(leaflet)
library(httr)
library(sf)

# -----------------------------------------------------------------------------
# 0. Configuration  --  edit these paths to match your machine
# -----------------------------------------------------------------------------
PHOTO_FOLDER     <- "/Users/marco/Desktop/photos_to_caption/PHOTO_FOLDER"
SPECIES_FILE     <- "/Users/marco/Desktop/photos_to_caption/Checklist_2017.csv"   # columns: Taxonname, Familie
OBSERVATION_FILE <- "/Users/marco/Desktop/photos_to_caption/observations.csv"     # UTF-16 tab-separated, quoted; date_start is yyyy-mm-dd HH:MM:SS
INAT_TOKEN_FILE <- file.path(path.expand("~"), ".plant_captioner_inat_token")
# Note: these are plain absolute paths. Do NOT wrap an absolute path in here(),
# since here() appends its argument to the project root rather than replacing
# it, which silently produces a broken nested path.

# Remembers the last photo folder used, so the startup picker can suggest it.
LAST_FOLDER_FILE <- file.path(path.expand("~"), ".plant_captioner_last_folder")

SUGGESTION_WINDOW_MINUTES <- 5   # match log entries within +/- this many minutes
PREVIEW_WIDTH_PX       <- 2000   # on-screen preview width (originals untouched)
MAX_SUGGESTIONS        <- 10     # how many date-matched species to offer
MAX_RECENT             <- 6      # how many recently-used taxa to keep as buttons
GROW_BACKBONE          <- TRUE   # append newly used taxa (with family) to SPECIES_FILE
INAT_CV_MAX  <- 8   # how many iNaturalist computer-vision suggestions to show

# Local GBIF occurrence-download zip, used to build a species list near the
# photos. Streamed in chunks, never loaded whole.
GBIF_ZIP_FILE    <- "/Users/marco/qfield_species/0026084-260507073636908.zip"
GBIF_RADIUS_KM   <- 100                                              # radius around the photos' centre
GBIF_SPECIES_OUT <- "/Users/marco/qfield_species/species_near_photos.csv"  # written here

# If the camera's clock was wrong, correct every photo's recorded time by this
# many hours (fractional values like 1.5 are fine). This affects only the
# "Date taken" shown in the app and the observation-log suggestion matching -
# it does NOT change the time stored in the photo files themselves.
#   Camera was set TOO EARLY (its clock lagged behind real time)  -> positive
#   Camera was set TOO LATE  (its clock ran ahead of real time)   -> negative
CAMERA_CLOCK_OFFSET_HOURS <- 0   # e.g. 1 = add one hour to every recorded time

# Photos are physically moved between these subfolders of PHOTO_FOLDER as
# their status changes. Untouched photos stay in PHOTO_FOLDER itself.
LABELLED_DIR      <- "_labelled"      # captioned photos land here
SKIPPED_DIR       <- "_skipped"       # set-aside photos land here
DELETED_DIR       <- "_deleted"       # discarded photos land here (recoverable)
UNDETERMINED_DIR  <- "_undetermined"  # "looked, but can't determine it" land here
UNDETERMINED_CAPTION <- "Indet."      # caption written for undetermined photos

# Extensions we will display + caption
IMAGE_PATTERN <- "(?i)\\.(jpe?g|heic|png|tiff?|cr2|cr3|nef|arw|raf|dng|orf|rw2)$"

# -----------------------------------------------------------------------------
# 1. Helper functions
# -----------------------------------------------------------------------------

# Pull a column from an exiftool data.frame, returning NA if it is absent
get_col <- function(df, name) if (name %in% names(df)) df[[name]] else NA

# Read GPS for a single photo on demand (signed decimal degrees, or NA/NA).
# -n makes exiftool return plain decimal numbers with the N/S/E/W hemisphere
# already folded into the sign, so we don't have to handle the Ref tags.
read_gps <- function(path) {
  raw <- suppressWarnings(
    system2("exiftool",
            c("-json", "-n", "-GPSLatitude", "-GPSLongitude", shQuote(path)),
            stdout = TRUE, stderr = FALSE)
  )
  raw  <- paste(raw, collapse = "")
  meta <- if (nzchar(trimws(raw))) tryCatch(fromJSON(raw), error = function(e) NULL)
  if (is.null(meta)) return(list(lat = NA_real_, lon = NA_real_))
  list(lat = suppressWarnings(as.numeric(get_col(meta, "GPSLatitude"))),
       lon = suppressWarnings(as.numeric(get_col(meta, "GPSLongitude"))))
}

# Remove GPS from a photo's metadata, in place (creation date preserved).
strip_gps <- function(path) {
  system2("exiftool",
          c("-overwrite_original_in_place", "-m", "-gps:all=", shQuote(path)),
          stdout = FALSE, stderr = FALSE)
}

# Write signed decimal GPS back into a photo - used to undo a removal. The
# hemisphere ref is derived from the sign (N/S for lat, E/W for lon).
write_gps <- function(path, lat, lon) {
  if (is.na(lat) || is.na(lon)) return(invisible())
  lat_ref <- if (lat >= 0) "N" else "S"
  lon_ref <- if (lon >= 0) "E" else "W"
  system2("exiftool",
          c("-overwrite_original_in_place", "-m", "-n",
            shQuote(paste0("-GPSLatitude=",     abs(lat))),
            shQuote(paste0("-GPSLatitudeRef=",  lat_ref)),
            shQuote(paste0("-GPSLongitude=",    abs(lon))),
            shQuote(paste0("-GPSLongitudeRef=", lon_ref)),
            shQuote(path)),
          stdout = FALSE, stderr = FALSE)
}

# Read date-taken + any existing caption for every photo, in ONE exiftool call
# Read date-taken + any existing caption for every photo across all four
# status locations (the root folder for untouched, plus the three subfolders),
# in ONE exiftool call. Each row is tagged with the status it was found under.
read_photo_metadata <- function(folder) {
  scan_one <- function(dir, status) {
    files <- list.files(dir, pattern = IMAGE_PATTERN, full.names = TRUE)
    if (length(files) == 0) return(tibble(path = character(), status = character()))
    tibble(path = files, status = status)
  }
  located <- bind_rows(
    scan_one(folder,                                 "untouched"),
    scan_one(file.path(folder, LABELLED_DIR),        "labelled"),
    scan_one(file.path(folder, SKIPPED_DIR),         "skipped"),
    scan_one(file.path(folder, UNDETERMINED_DIR),    "undetermined"),
    scan_one(file.path(folder, DELETED_DIR),         "deleted")
  )
  if (nrow(located) == 0) {
    return(tibble(path = character(), filename = character(),
                  datetime = as.POSIXct(character()),
                  date = as.Date(character()), caption = character(),
                  lat = numeric(), lon = numeric(),
                  inat_url = character(), status = character()))
  }
  files <- located$path
  
  # Start from the file list itself, so photos with no EXIF still show up
  photos <- located %>%
    mutate(filename = basename(path), datetime = as.POSIXct(NA), caption = "",
           lat = NA_real_, lon = NA_real_, inat_url = "")
  
  # Ask exiftool for date + caption. The file list is passed via an argument
  # file (-@) so this works for thousands of photos without hitting the
  # command-line length limit. Files without those tags (e.g. screenshots)
  # produce no output, so we treat the result defensively.
  argfile <- tempfile(fileext = ".txt")
  writeLines(files, argfile)
  on.exit(unlink(argfile), add = TRUE)
  raw <- suppressWarnings(
    system2("exiftool",
            c("-json", "-s", "-DateTimeOriginal", "-Caption-Abstract",
              "-GPSLatitude#", "-GPSLongitude#", "-XMP-dc:Identifier", "-@", argfile),
            stdout = TRUE, stderr = FALSE)
  )
  raw  <- paste(raw, collapse = "")
  meta <- if (nzchar(trimws(raw))) tryCatch(fromJSON(raw), error = function(e) NULL)
  
  # Merge in whatever exiftool did return, matched by file path
  if (!is.null(meta) && "SourceFile" %in% names(meta)) {
    caption_raw <- get_col(meta, "Caption-Abstract")
    ident_raw   <- get_col(meta, "Identifier")
    found <- tibble(
      path     = meta$SourceFile,
      datetime = as.POSIXct(get_col(meta, "DateTimeOriginal"),
                            format = "%Y:%m:%d %H:%M:%S"),
      caption  = ifelse(is.na(caption_raw), "", caption_raw),
      lat      = suppressWarnings(as.numeric(get_col(meta, "GPSLatitude"))),
      lon      = suppressWarnings(as.numeric(get_col(meta, "GPSLongitude"))),
      inat_url = ifelse(is.na(ident_raw), "", ident_raw)
    )
    photos <- photos %>%
      select(path, filename, status) %>%
      left_join(found, by = "path") %>%
      mutate(caption  = ifelse(is.na(caption),  "", caption),
             inat_url = ifelse(is.na(inat_url), "", inat_url))
  }
  
  photos %>%
    mutate(datetime = datetime + CAMERA_CLOCK_OFFSET_HOURS * 3600,  # correct camera clock
           date     = as.Date(datetime)) %>%
    arrange(datetime, filename)
}

# Compute a non-colliding destination path for moving a file into a status
# subfolder (appends _1, _2, ... if a file with that name is already there).
dest_path_for <- function(subdir, filename) {
  dir <- file.path(PHOTO_FOLDER, subdir)
  dir.create(dir, showWarnings = FALSE)
  dest <- file.path(dir, filename)
  if (!file.exists(dest)) return(dest)
  base <- tools::file_path_sans_ext(filename)
  ext  <- tools::file_ext(filename)
  i <- 1
  repeat {
    candidate <- file.path(dir, sprintf("%s_%d.%s", base, i, ext))
    if (!file.exists(candidate)) return(candidate)
    i <- i + 1
  }
}

# Move a file, returning TRUE on success. Paths already identical counts as
# success (nothing to do). Used so the in-memory row is only updated when the
# move actually happened on disk.
move_file <- function(old_path, new_path) {
  if (identical(new_path, old_path)) return(TRUE)
  isTRUE(suppressWarnings(file.rename(old_path, new_path)))
}

# Where a file should end up for a given status, or its current path
# unchanged if it is already sitting in the right subfolder (avoids treating
# a file as colliding with itself when re-saving an already-moved photo).
move_target <- function(old_path, subdir) {
  target_dir <- normalizePath(file.path(PHOTO_FOLDER, subdir), mustWork = FALSE)
  current_dir <- normalizePath(dirname(old_path), mustWork = FALSE)
  if (identical(current_dir, target_dir)) old_path
  else dest_path_for(subdir, basename(old_path))
}

# Startup reconciliation: a photo can end up with a caption already written
# in its metadata but still sitting in PHOTO_FOLDER or _skipped - e.g. it was
# captioned before this folder-based organization existed, or captioned by
# some other tool. Sweep any such photo into _labelled (or _undetermined, if
# its caption is the "can't determine it" marker) and mark it accordingly, so
# the app's folders and the "Show:" filter reflect the true caption state
# every time the script is run, not just the state at first launch.
reconcile_already_captioned <- function(photos) {
  idx <- which(photos$status %in% c("untouched", "skipped") & photos$caption != "")
  if (length(idx) == 0) return(list(photos = photos, moved = 0L))
  moved <- 0L
  for (i in idx) {
    old_path <- photos$path[i]
    is_indet <- identical(photos$caption[i], UNDETERMINED_CAPTION)
    target   <- if (is_indet) UNDETERMINED_DIR else LABELLED_DIR
    new_path <- move_target(old_path, target)
    ok <- TRUE
    if (!identical(new_path, old_path)) {
      ok <- isTRUE(suppressWarnings(file.rename(old_path, new_path)))
    }
    if (ok) {
      photos$path[i]   <- new_path
      photos$status[i] <- if (is_indet) "undetermined" else "labelled"
      moved <- moved + 1L
    }
  }
  list(photos = photos, moved = moved)
}



# Make a small JPEG preview the browser can show (handles HEIC / RAW too).
# The preview filename is sanitised (no spaces / special chars) so it works
# as an image URL.
make_preview <- function(path, cache_dir) {
  safe_name <- gsub("[^A-Za-z0-9._-]", "_", basename(path))
  out <- file.path(cache_dir, preview_name(path))
  if (!file.exists(out)) {
    system2("sips",
            c("-s", "format", "jpeg",
              "--resampleWidth", as.character(PREVIEW_WIDTH_PX),
              shQuote(path), "-o", shQuote(out)),
            stdout = FALSE, stderr = FALSE)
  }
  out
}

# Write the caption into the three fields Apple Photos reads.
# -overwrite_original_in_place keeps the file's original creation date
# (only the modified date changes).
write_caption <- function(path, caption) {
  system2("exiftool",
          c("-overwrite_original_in_place", "-m",
            shQuote(paste0("-IPTC:Caption-Abstract=", caption)),
            shQuote(paste0("-XMP-dc:Description=",    caption)),
            shQuote(paste0("-EXIF:ImageDescription=", caption)),
            shQuote(path)),
          stdout = FALSE, stderr = FALSE)
}

# Species recorded near the photo's time, closest first (gap measured in minutes)
suggest_species <- function(photo_time, obs_log, window_minutes) {
  if (is.na(photo_time) || nrow(obs_log) == 0) return(character(0))
  obs_log %>%
    mutate(gap = abs(as.numeric(difftime(datetime, photo_time, units = "mins")))) %>%
    filter(gap <= window_minutes) %>%
    arrange(gap) %>%
    distinct(species) %>%
    pull(species)
}

# Localities recorded near the photo's time, closest first (no duplicates,
# blanks dropped) - shown as a hint, not written into the caption
suggest_localities <- function(photo_time, obs_log, window_minutes) {
  if (is.na(photo_time) || nrow(obs_log) == 0) return(character(0))
  obs_log %>%
    mutate(gap = abs(as.numeric(difftime(datetime, photo_time, units = "mins")))) %>%
    filter(gap <= window_minutes, !is.na(locality), locality != "") %>%
    arrange(gap) %>%
    distinct(locality) %>%
    pull(locality)
}

# Strip the taxonomic authority from a name, keeping only the genus, species,
# and any infraspecific rank + epithet (subsp./var./subvar./f./ssp.) - the
# authority can appear either right after the species epithet or after the
# infraspecific epithet, in either case wrapped in "()" and/or ending in ".":
#   "Anthriscus sylvestris (L.) Hoffm."                   -> "Anthriscus sylvestris"
#   "Anthriscus sylvestris (L.) Hoffm. subsp. sylvestris" -> "Anthriscus sylvestris subsp. sylvestris"
#   "Anthriscus sylvestris subsp. alpina (Vill.) Gremli"  -> "Anthriscus sylvestris subsp. alpina"
strip_authority <- function(name) {
  if (is.na(name) || name == "") return(name)
  rank_markers <- c("subsp.", "var.", "subvar.", "f.", "ssp.")
  tokens <- strsplit(name, "\\s+")[[1]]
  keep <- character(0)
  for (i in seq_along(tokens)) {
    tok <- tokens[i]
    low <- tolower(tok)
    if (i == 1) {
      keep <- c(keep, tok)                                # genus - always kept
    } else if (low %in% rank_markers) {
      keep <- c(keep, tok)                                # rank marker - kept
    } else if (grepl("\\.$", tok) && !(low %in% rank_markers)) {
      next                                                # author abbreviation, e.g. "Hoffm." or "fil."
    } else if (grepl("^[A-Z(]", tok)) {
      next                                                # author surname or "(Author)"
    } else if (low %in% c("&", "et", "ex")) {
      next                                                # author connector, e.g. "Rchb. & Zahlbr."
    } else {
      keep <- c(keep, tok)                                # lowercase taxon epithet
    }
  }
  paste(keep, collapse = " ")
}

# Ask iNaturalist's computer-vision model what this photo might be, weighted by
# the photo's location and date. Needs a JWT (paste it into the app's token
# field). Returns taxon names best-first, or character(0) on any failure.
inat_cv_suggest <- function(path, lat, lon, observed_on, token) {
  if (is.null(token) || trimws(token) == "") return(character(0))
  # The model wants a 299x299 JPEG with the aspect ratio squashed to fill it.
  # sips -z forces an exact height x width (it does NOT preserve aspect ratio),
  # which is exactly the "squashed" image the endpoint expects.
  squashed <- tempfile(fileext = ".jpg")
  system2("sips", c("-s", "format", "jpeg", "-z", "299", "299",
                    shQuote(path), "-o", shQuote(squashed)),
          stdout = FALSE, stderr = FALSE)
  on.exit(unlink(squashed), add = TRUE)
  
  body <- list(image = upload_file(squashed, type = "image/jpeg"))
  if (!is.na(lat) && !is.na(lon)) { body$lat <- lat; body$lng <- lon }
  if (nzchar(observed_on))        body$observed_on <- observed_on
  
  resp <- tryCatch(
    POST("https://api.inaturalist.org/v1/computervision/score_image",
         add_headers(Authorization = paste("Bearer", trimws(token))),
         body = body, encode = "multipart"),
    error = function(e) NULL)
  if (is.null(resp) || http_error(resp)) return(character(0))
  
  results <- content(resp)$results
  if (is.null(results) || length(results) == 0) return(character(0))
  names_out <- vapply(results, function(r) {
    nm <- r$taxon$name
    if (is.null(nm)) NA_character_ else nm
  }, character(1))
  names_out[!is.na(names_out)]
}

# Look up an iNaturalist taxon id for a name, so a created observation carries a
# real identification rather than only a free-text guess. Returns NULL if the
# name isn't found (the observation still gets created, just as a guess).
inat_taxon_id <- function(name, token) {
  if (is.null(name) || trimws(name) == "") return(NULL)
  resp <- tryCatch(
    GET("https://api.inaturalist.org/v1/taxa",
        query = list(q = name, per_page = 1),
        add_headers(Authorization = paste("Bearer", trimws(token)))),
    error = function(e) NULL)
  if (is.null(resp) || http_error(resp)) return(NULL)
  results <- content(resp)$results
  if (is.null(results) || length(results) == 0) return(NULL)
  results[[1]]$id
}

# Create an iNaturalist observation for this photo and attach the photo to it,
# using the photo's own date and GPS. Returns the new observation's URL, or a
# string beginning "ERROR:" describing what went wrong.
inat_create_observation <- function(taxon_name, lat, lon, observed_on,
                                    photo_path, token) {
  token <- trimws(token)
  if (token == "") return("ERROR: no iNaturalist token set")
  
  taxon_id <- inat_taxon_id(taxon_name, token)
  
  obs <- list(species_guess = taxon_name, observed_on_string = observed_on)
  if (!is.null(taxon_id))          obs$taxon_id  <- taxon_id
  if (!is.na(lat) && !is.na(lon)) { obs$latitude <- lat; obs$longitude <- lon }
  
  created <- tryCatch(
    POST("https://api.inaturalist.org/v1/observations",
         add_headers(Authorization = paste("Bearer", token)),
         body = list(observation = obs), encode = "json"),
    error = function(e) NULL)
  if (is.null(created) || http_error(created))
    return("ERROR: could not create the observation (check token / connection)")
  
  obs_id <- content(created)$id
  if (is.null(obs_id)) return("ERROR: observation created but no id returned")
  url <- paste0("https://www.inaturalist.org/observations/", obs_id)
  remember_inat_url(photo_path, url)      # stash the link in the photo itself
  
  # Attach the photo. iNat wants a JPEG, so send a downsized JPEG copy - this
  # also lets HEIC / RAW originals upload cleanly.
  jpg <- tempfile(fileext = ".jpg")
  system2("sips", c("-s", "format", "jpeg", "--resampleWidth", "2048",
                    shQuote(photo_path), "-o", shQuote(jpg)),
          stdout = FALSE, stderr = FALSE)
  on.exit(unlink(jpg), add = TRUE)
  
  attached <- tryCatch(
    POST("https://api.inaturalist.org/v1/observation_photos",
         add_headers(Authorization = paste("Bearer", token)),
         body = list(`observation_photo[observation_id]` = obs_id,
                     file = upload_file(jpg, type = "image/jpeg")),
         encode = "multipart"),
    error = function(e) NULL)
  
  if (is.null(attached) || http_error(attached))
    return(paste0("ERROR: observation created (", url, ") but the photo upload failed"))
  url
}

# Save / load the token so it survives closing R. Stored as two lines: the
# token, then the Unix time it was saved. Reused only if < 24h old.
save_inat_token <- function(token) {
  token <- trimws(token)
  if (token == "") return(invisible())
  writeLines(c(token, as.character(as.numeric(Sys.time()))), INAT_TOKEN_FILE)
}
load_inat_token <- function() {
  if (!file.exists(INAT_TOKEN_FILE)) return("")
  lines <- tryCatch(readLines(INAT_TOKEN_FILE, warn = FALSE),
                    error = function(e) character(0))
  if (length(lines) < 2) return("")
  saved_at <- suppressWarnings(as.numeric(lines[2]))
  if (is.na(saved_at) || (as.numeric(Sys.time()) - saved_at) > 24 * 3600) return("")
  lines[1]
}

# ---- iNaturalist: remembering which photo maps to which observation ----

# We stash the observation URL in the photo's own XMP dc:Identifier field. It's
# the standard "identifier" slot, so it won't collide with the caption fields,
# and it travels with the file when it moves between _labelled / _skipped / etc.
remember_inat_url <- function(path, url) {
  system2("exiftool",
          c("-overwrite_original_in_place", "-m",
            shQuote(paste0("-XMP-dc:Identifier=", url)),
            shQuote(path)),
          stdout = FALSE, stderr = FALSE)
}

# Recover the numeric observation id from a stored URL ("" if there is none).
inat_id_from_url <- function(url) {
  if (is.null(url) || is.na(url) || url == "") return("")
  sub(".*/observations/", "", url)
}

# Ask iNaturalist for the current quality grade + consensus taxon of many
# observations at once (bulk GET, chunked into <=100 ids to stay polite).
# Reading public observations needs no token, but we send it if we have one.
inat_fetch_status <- function(ids, token) {
  ids <- unique(ids[ids != ""])
  empty <- tibble(id = character(), quality_grade = character(),
                  inat_taxon = character())
  if (length(ids) == 0) return(empty)
  token  <- trimws(token)
  chunks <- split(ids, ceiling(seq_along(ids) / 100))
  results <- lapply(chunks, function(chunk) {
    resp <- tryCatch(
      GET("https://api.inaturalist.org/v1/observations",
          query = list(id = paste(chunk, collapse = ","), per_page = 200),
          add_headers(Authorization = paste("Bearer", token))),
      error = function(e) NULL)
    if (is.null(resp) || http_error(resp)) return(NULL)
    obs <- content(resp)$results
    if (is.null(obs) || length(obs) == 0) return(NULL)
    tibble(
      id            = vapply(obs, function(o) as.character(o$id), character(1)),
      quality_grade = vapply(obs, function(o) {
        qg <- o$quality_grade; if (is.null(qg)) "" else qg
      }, character(1)),
      inat_taxon    = vapply(obs, function(o) {
        nm <- o$taxon$name; if (is.null(nm)) "" else nm
      }, character(1))
    )
  })
  out <- bind_rows(results)
  if (nrow(out) == 0) empty else out
}

# From the current photos + fetched status, keep only photos whose observation
# is now research grade AND whose consensus taxon differs from our caption.
build_review_queue <- function(photos, status) {
  photos %>%
    mutate(id = vapply(inat_url, inat_id_from_url, character(1))) %>%
    filter(id != "") %>%
    left_join(status, by = "id") %>%
    filter(quality_grade == "research",
           !is.na(inat_taxon), inat_taxon != "",
           # keep only where the caption does NOT already contain the iNat taxon
           !mapply(grepl, inat_taxon, caption, fixed = TRUE)) %>%
    select(path, caption, inat_taxon)
}

# Build a plant species list (with family) from a local GBIF occurrence-download
# zip, keeping only taxa recorded inside `search_area` - a buffered convex hull
# around the photos, passed in as an sf polygon in lon/lat (EPSG:4326). The zip
# is streamed in chunks so even a 100 GB+ uncompressed archive stays off the
# heap. Writes a two-column CSV (Taxonname, Familie), the same shape as the
# checklist backbone, and returns the number of species written.
build_species_list_from_gbif_zip <- function(zip_path, bb, out_path) {
  stopifnot(file.exists(zip_path))
  
  # GBIF downloads are tab-separated. A SIMPLE_CSV download holds one <key>.csv;
  # a Darwin Core Archive holds occurrence.txt. Pick whichever is the big one.
  entries <- unzip(zip_path, list = TRUE)
  inner <- entries$Name[grepl("occurrence\\.txt$", entries$Name)]
  if (length(inner) == 0) inner <- entries$Name[grepl("\\.csv$", entries$Name)]
  if (length(inner) == 0) stop("No occurrence.txt or .csv found inside the zip.")
  inner <- inner[which.max(entries$Length[match(inner, entries$Name)])]
  
  # Confirm the columns we need are present (reading just the header line).
  header  <- system(paste("unzip -p", shQuote(zip_path), shQuote(inner), "| head -1"),
                    intern = TRUE)
  cols    <- strsplit(header, "\t")[[1]]
  needed  <- c("kingdom", "family", "species", "decimalLatitude", "decimalLongitude")
  missing <- setdiff(needed, cols)
  if (length(missing) > 0)
    stop("Archive is missing expected column(s): ", paste(missing, collapse = ", "))
  
  # `bb` (passed in) is the lon/lat bounding box of the buffered search area.
  # Occurrences are kept by fast min/max comparisons against it - this is a
  # rectangle around the hull, not the hull itself.
  
  scanned <- 0L
  # Each chunk is filtered to plant species whose coordinates fall inside the
  # bounding box; only those tiny results are returned and row-bound as we go.
  collect <- DataFrameCallback$new(function(chunk, pos) {
    scanned <<- scanned + nrow(chunk)
    cat(sprintf("  scanned %d rows...\n", scanned))
    chunk %>%
      filter(kingdom == "Plantae",
             !is.na(species), species != "",
             !is.na(family),  family  != "",
             !is.na(decimalLatitude), !is.na(decimalLongitude),
             decimalLongitude >= bb["xmin"], decimalLongitude <= bb["xmax"],
             decimalLatitude  >= bb["ymin"], decimalLatitude  <= bb["ymax"]) %>%
      distinct(species, family)
  })
  
  found <- read_delim_chunked(
    pipe(paste("unzip -p", shQuote(zip_path), shQuote(inner))),
    collect, delim = "\t", quote = "", chunk_size = 250000, progress = FALSE,
    col_types = cols_only(
      kingdom          = col_character(),
      family           = col_character(),
      species          = col_character(),
      decimalLatitude  = col_double(),
      decimalLongitude = col_double()))
  
  species_list <- found %>%
    distinct(species, family) %>%
    arrange(species) %>%
    transmute(Taxonname = species, Familie = family)
  
  write_csv(species_list, out_path)
  nrow(species_list)
}

# Bounding box (lon/lat) of the photos' minimum convex polygon expanded outward
# by `radius_km`. Build the convex hull of the photo points, buffer it by the
# radius in Swiss LV95 (metres, accurate for CH), then take the bounding box of
# that buffered hull - a plain lon/lat rectangle the occurrence filter can test
# with fast min/max comparisons.
photo_search_bbox <- function(lats, lons, radius_km) {
  pts <- sf::st_as_sf(data.frame(lon = lons, lat = lats),
                      coords = c("lon", "lat"), crs = 4326)
  buffered <- pts %>%
    sf::st_union() %>%
    sf::st_convex_hull() %>%
    sf::st_transform(2056) %>%           # Swiss LV95: metres, metre-accurate here
    sf::st_buffer(radius_km * 1000) %>%
    sf::st_transform(4326)               # back to lon/lat
  sf::st_bbox(buffered)
}

# Remember / recall the last photo folder used, so it can be suggested next time.
save_last_folder <- function(folder) {
  writeLines(folder, LAST_FOLDER_FILE)
}
load_last_folder <- function() {
  if (!file.exists(LAST_FOLDER_FILE)) return(PHOTO_FOLDER)   # fall back to the config default
  folder <- tryCatch(readLines(LAST_FOLDER_FILE, warn = FALSE)[1],
                     error = function(e) PHOTO_FOLDER)
  if (is.na(folder) || folder == "" || !dir.exists(folder)) PHOTO_FOLDER else folder
}
# Ensure the backbone file ends in a newline before we append, so the first
# new taxon starts on its own line instead of gluing onto the last row.
ensure_trailing_newline <- function(path) {
  size <- if (file.exists(path)) file.info(path)$size else 0
  if (is.na(size) || size == 0) return(invisible())
  con <- file(path, "rb"); on.exit(close(con))
  seek(con, where = size - 1)
  if (!identical(readBin(con, "raw", 1), as.raw(0x0a)))
    cat("\n", file = path, append = TRUE)
}

# Cache filename for a photo's preview. Includes the parent folder name so two
# photos that share a filename (e.g. from two camera cards) don't collide.
preview_name <- function(path) {
  safe <- gsub("[^A-Za-z0-9._-]", "_",
               file.path(basename(dirname(path)), basename(path)))
  paste0(tools::file_path_sans_ext(safe), ".jpg")
}

# -----------------------------------------------------------------------------
# 2. Load the species backbone and observation log
# -----------------------------------------------------------------------------
# The backbone provides the taxon names you choose from plus their family.
backbone <- if (file.exists(SPECIES_FILE)) {
  read_csv(SPECIES_FILE, show_col_types = FALSE) %>%
    select(Taxonname, Familie) %>%
    filter(!is.na(Taxonname)) %>%
    mutate(Taxonname = vapply(Taxonname, strip_authority, character(1))) %>%
    distinct(Taxonname, .keep_all = TRUE)
} else {
  tibble(Taxonname = character(0), Familie = character(0))
}

# Quick lookup: taxon name -> family. Returns "" when the taxon is not in the
# backbone (e.g. a taxon that only appears in the observation log). Tries an
# exact match first, then falls back to a case-insensitive match in case the
# two sources capitalize a name slightly differently.
family_of <- setNames(backbone$Familie, backbone$Taxonname)
family_of_lower <- setNames(backbone$Familie, tolower(backbone$Taxonname))
lookup_family <- function(taxon) {
  if (is.null(taxon) || taxon == "") return("")
  fam <- unname(family_of[taxon])
  if (is.na(fam)) fam <- unname(family_of_lower[tolower(taxon)])
  if (is.na(fam)) "" else fam
}

# Build the caption: "Taxonname (Familie)", or just the taxon if no family.
compose_caption <- function(taxon, family) {
  if (is.null(taxon) || taxon == "") return("")
  if (is.null(family) || is.na(family) || family == "") taxon
  else paste0(taxon, " (", family, ")")
}

# Recover just the taxon name from a stored caption, so revisiting a photo
# re-selects the right entry in the dropdown.
taxa_from_caption <- function(caption) {
  if (is.null(caption) || is.na(caption) || caption == "") return(character(0))
  parts     <- trimws(strsplit(caption, ",")[[1]])
  no_family <- sub(" \\(.*\\)$", "", parts)      # drop the "(Family)" suffix
  trimws(gsub(" cf\\.", "", no_family))          # drop an uncertain "cf." marker
}

# Mark a determination uncertain: "Carex flava" -> "Carex cf. flava"
apply_cf <- function(taxon) {
  parts <- strsplit(taxon, " ")[[1]]
  if (length(parts) >= 2) paste(parts[1], "cf.", paste(parts[-1], collapse = " "))
  else paste("cf.", taxon)
}

# Quote a value for safe appending to the backbone CSV
csv_field <- function(x) {
  if (grepl("[,\"\n]", x)) paste0('"', gsub('"', '""', x), '"') else x
}

# The observation export is UTF-16 encoded and tab-separated (a database
# export that happens to be named .csv). Decode it explicitly, drop a
# byte-order mark if present, then parse it as a normal TSV.
read_observations <- function(path) {
  con   <- file(path, encoding = "UTF-16LE")
  lines <- readLines(con, warn = FALSE)
  close(con)
  lines[1] <- sub("^\uFEFF", "", lines[1])
  read_tsv(paste(lines, collapse = "\n"),
           col_types = cols(.default = col_character()))
}

obs_log <- if (file.exists(OBSERVATION_FILE)) {
  raw_obs <- read_observations(OBSERVATION_FILE)
  if (!"locality_descript" %in% names(raw_obs)) raw_obs$locality_descript <- NA_character_
  raw_obs %>%
    transmute(
      # Normalised the same way as the backbone's Taxonname (trimmed, any
      # stray authority stripped) so family lookup matches reliably even if
      # taxon_orig occasionally carries whitespace or authority remnants.
      species  = vapply(trimws(`taxon_orig`), strip_authority, character(1)),
      datetime = as.POSIXct(date_start, format = "%Y-%m-%d %H:%M:%S"),
      locality = locality_descript
    ) %>%
    filter(!is.na(species), !is.na(datetime))
} else {
  tibble(species = character(0), datetime = as.POSIXct(character(0)),
         locality = character(0))
}

# Master dropdown = taxa from the backbone plus anything in the observation log
species_choices <- sort(unique(c(backbone$Taxonname, obs_log$species)))

# ---- Startup diagnostics: sanity-check the data that suggestions depend on ----
# Printed once to the R console when the app launches, so a timing problem is
# visible immediately rather than discovered photo by photo.
cat("\n--- Plant Photo Captioner: startup check ---\n")
cat(sprintf("Backbone:     %d taxa loaded from %s\n", nrow(backbone), SPECIES_FILE))
cat(sprintf("Observations: %d rows loaded from %s\n", nrow(obs_log), OBSERVATION_FILE))
if (nrow(obs_log) > 0) {
  cat(sprintf("  date_start range: %s  to  %s  (local time, as parsed)\n",
              format(min(obs_log$datetime)), format(max(obs_log$datetime))))
  obs_species <- unique(obs_log$species)
  matched <- sum(vapply(obs_species, function(s) lookup_family(s) != "", logical(1)))
  cat(sprintf("  %d of %d distinct observation-log species matched a family in the backbone\n",
              matched, length(obs_species)))
  if (matched < length(obs_species)) {
    unmatched <- head(setdiff(obs_species, backbone$Taxonname), 5)
    cat("  e.g. not found in backbone:", paste(unmatched, collapse = " | "), "\n")
  }
} else {
  cat("  WARNING: no observation rows parsed - check OBSERVATION_FILE and its date_start format.\n")
}
cat("--- end startup check ---\n\n")

# Folder where on-screen previews are cached (originals are never touched)
CACHE_DIR <- file.path(tempdir(), "plant_previews")
dir.create(CACHE_DIR, showWarnings = FALSE)

INITIAL_TOKEN <- load_inat_token()

# -----------------------------------------------------------------------------
# 3. User interface
# -----------------------------------------------------------------------------
ui <- fluidPage(
  tags$head(
    tags$title("Plant Photo Captioner"),
    tags$style(HTML("
      /* Foldable sections - native <details>, no JavaScript needed */
      details.fold          { border: 1px solid #ddd; border-radius: 6px;
                              padding: 4px 10px; margin-bottom: 8px; }
      details.fold > summary { cursor: pointer; font-weight: 600; padding: 4px 0; }

      /* Fixed height so the layout never jumps as suggestions change */
      .sugg-btn    { margin: 0 6px 6px 0; }
      .sugg-area   { height: 76px; overflow-y: auto; margin-bottom: 4px; }
      .recent-area { height: 40px; overflow-y: auto; margin-bottom: 4px; }
      .cv-area     { height: 76px; overflow-y: auto; margin-bottom: 4px; }

      /* Compact inline checkboxes so cf. sits on one line, and the Show:
         row (Untouched / Labelled / ...) fits on one line too */
      .tight-checks .checkbox-inline,
      .tight-checks .shiny-options-group label {
        font-size: 12px; margin-right: 10px; padding-left: 18px;
      }
      .tight-checks .shiny-options-group { margin-top: 2px; }

      .inat-panel  { text-align: left; }
      .photo-box   { text-align: center; }
      .photo-wrap  { position: relative; display: inline-block; max-width: 100%; }
      .meta-block  { margin: 4px 0 6px 0; line-height: 1.35; color: #444; }
      hr           { margin: 8px 0; }

      /* Safety net: if the sidebar is ever taller than the window it scrolls
         on its own, so the photo stays put and fully visible */
      .well { max-height: calc(100vh - 20px); overflow-y: auto; }

      .map-overlay {
        position: absolute; bottom: 12px; right: 12px;
        width: 240px; height: 170px; z-index: 50;
        border: 2px solid white; border-radius: 6px; overflow: hidden;
        box-shadow: 0 2px 10px rgba(0,0,0,0.45);
      }
      /* Photo as large as the window allows. This 72vh is the one knob to turn
         if you want it bigger or smaller - also change it in the renderImage
         line (step 4) so they match. */
      #photo { overflow: hidden; }
      #photo img { cursor: zoom-in; transition: transform 0.1s ease-out;
                   max-height: 72vh; max-width: 100%; }
    ")),
    # Keyboard shortcuts. They are ignored while you are typing in a field, so
    # arrow keys, delete and rotate never interfere with the search box.
    tags$script(HTML("
      document.addEventListener('keydown', function(e) {
        var tag = (e.target.tagName || '').toLowerCase();
        var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
        if (typing) return;
        var k = e.key;
        var nav = ['ArrowRight','ArrowLeft','Delete','Backspace'];
        var letters = ['r','c','u','i','s'];
        var isDigit = (k >= '1' && k <= '9');
        if (nav.indexOf(k) === -1 && letters.indexOf(k.toLowerCase()) === -1 && !isDigit) return;
        e.preventDefault();
        Shiny.setInputValue('key_event', {key: k, n: Date.now()}, {priority: 'event'});
      });
      // Enter behaviour in the taxon box:
      //  - if you are actively typing a search (the box has text in it),
      //    Enter picks/creates that taxon - selectize handles it natively.
      //  - if the box is empty (nothing being typed), Enter saves and
      //    advances to the next photo instead.
      // Checked on the CAPTURE phase, before selectize's own handler runs,
      // so we see the state as it was when Enter was pressed, not after
      // selectize has already cleared the box from picking.
      document.addEventListener('keydown', function(e) {
        if (e.key !== 'Enter') return;
        var active = document.activeElement;
        var inSelectize = active && active.tagName === 'INPUT' &&
                          active.closest && active.closest('.selectize-control');
        if (inSelectize && active.value && active.value.trim().length > 0) return;
        e.preventDefault();
        Shiny.setInputValue('enter_save', Date.now(), {priority: 'event'});
      }, true);
      // Click the photo to zoom to 1:1 at that point; click again to zoom out.
      (function bind() {
        var box = document.getElementById('photo');
        if (!box) { setTimeout(bind, 300); return; }
        function reset(img) {
          img.style.transform = '';
          img.style.cursor = 'zoom-in';
          img.removeAttribute('data-zoomed');
        }
        box.addEventListener('click', function(e) {
          var img = box.querySelector('img');
          if (!img || e.target !== img) return;
          if (img.getAttribute('data-zoomed') === '1') { reset(img); return; }
          var rect = img.getBoundingClientRect();
          var x = (e.clientX - rect.left) / rect.width * 100;
          var y = (e.clientY - rect.top) / rect.height * 100;
          var factor = img.naturalWidth ? (img.naturalWidth / rect.width) : 2.5;
          img.style.transformOrigin = x + '% ' + y + '%';
          img.style.transform = 'scale(' + factor + ')';
          img.style.cursor = 'zoom-out';
          img.setAttribute('data-zoomed', '1');
        });
        // Reset zoom whenever the displayed photo changes
        new MutationObserver(function(muts) {
          muts.forEach(function(m) {
            if (m.attributeName === 'src') {
              var img = box.querySelector('img'); if (img) reset(img);
            }
          });
        }).observe(box, { attributes: true, subtree: true, attributeFilter: ['src'] });
      })();
    "))
  ),
  sidebarLayout(
    sidebarPanel(
      width = 4,
      
      h4("Suggestions for this time"),
      div(class = "sugg-area", uiOutput("suggestions")),
      h4("Recently used"),
      div(class = "recent-area", uiOutput("recent_ui")),
      tags$hr(),
      
      selectizeInput("species", "Taxa (add one or more)", choices = NULL,
                     multiple = TRUE,
                     options = list(placeholder = "Type to search or add a new name...",
                                    maxOptions = 50,
                                    create = TRUE)),
      div(class = "tight-checks",
          checkboxInput("cf", "Uncertain determination (cf.)", value = FALSE)),
      uiOutput("family_ui"),
      textInput("caption_final", "Caption to save (edit if needed)",
                value = "", width = "100%"),
      actionButton("save", "Save caption & next", class = "btn-primary",
                   width = "100%"),
      actionButton("copy_last", "Copy last caption (c)",
                   width = "100%", style = "margin-top:8px;"),
      tags$hr(),
      
      # Navigation + per-photo actions, two per row to keep the sidebar short.
      # (Left / Right arrow keys still move between photos.)
      fluidRow(
        column(6, actionButton("prev", "Previous", width = "100%")),
        column(6, actionButton("nxt",  "Next",     width = "100%"))
      ),
      fluidRow(
        style = "margin-top:8px;",
        column(6, actionButton("rotate", "Rotate 90\u00b0 (r)", width = "100%")),
        column(6, actionButton("undo",   "Undo last (u)",       width = "100%"))
      ),
      fluidRow(
        style = "margin-top:8px;",
        column(6, actionButton("skip",         "Skip (set aside)",    width = "100%")),
        column(6, actionButton("undetermined", "Can't determine (i)", width = "100%"))
      ),
      actionButton("delete", "Delete photo (move to _deleted)",
                   class = "btn-danger", width = "100%",
                   style = "margin-top:8px;"),
      tags$hr(),
      
      div(class = "tight-checks",
          checkboxGroupInput("status_filter", "Show:",
                             choices = c("Untouched"    = "untouched",
                                         "Labelled"     = "labelled",
                                         "Skipped"      = "skipped",
                                         "Undetermined" = "undetermined",
                                         "Deleted"      = "deleted"),
                             selected = "untouched", inline = TRUE)),
      uiOutput("progressbar"),
      strong(textOutput("progress"))
    ),
    
    mainPanel(
      width = 8,
      div(class = "photo-box",
          div(class = "photo-wrap",
              imageOutput("photo", width = "auto", height = "auto"),
              uiOutput("map_overlay")),
          h4(textOutput("filename")),
          uiOutput("status"),
          div(class = "meta-block",
              textOutput("datetaken"),
              textOutput("gps"),
              textOutput("locality"),
              textOutput("current_caption"),
              uiOutput("inat_obs_link"),
              uiOutput("map_toggle_btn"),
              uiOutput("gps_clear_btn")),
          
          # Folded by default so the photo gets the full height. Open it when
          # you want CV suggestions or to post an observation.
          # Everything you touch rarely lives here, folded away so the photo
          # gets the full height: point at a different folder, build the GBIF
          # species list, or use iNaturalist.
          tags$details(class = "fold",
                       style = "max-width:640px; margin:6px auto 0 auto;",
                       tags$summary("Setup & tools"),
                       div(style = "margin-top:8px; text-align:left;",
                           
                           h5("Photo folder"),
                           textInput("photo_folder", NULL, value = load_last_folder(),
                                     width = "100%"),
                           actionButton("load_folder", "Load this folder",
                                        class = "btn-primary", width = "100%"),
                           
                           tags$hr(),
                           h5("Species list"),
                           actionButton("build_gbif_list", "Build species list from GBIF zip",
                                        width = "100%", class = "btn-default"),
                           
                           tags$hr(),
                           h5("iNaturalist"),
                           uiOutput("inat_token_status"),
                           fluidRow(
                             column(9, passwordInput("inat_token", NULL, width = "100%",
                                                     value = INITIAL_TOKEN,
                                                     placeholder = "Paste token (expires in 24h)")),
                             column(3, actionButton("inat_verify", "Check", width = "100%"))
                           ),
                           tags$a(href = "https://www.inaturalist.org/users/api_token",
                                  target = "_blank", "Get / refresh token",
                                  style = "font-size:12px;"),
                           fluidRow(
                             style = "margin-top:8px;",
                             column(6, actionButton("cv_fetch", "Ask iNaturalist (photo + GPS)",
                                                    width = "100%")),
                             column(6, actionButton("inat_obs", "Create observation",
                                                    width = "100%"))
                           ),
                           actionButton("inat_recheck", "Re-check iNat status", width = "100%",
                                        class = "btn-default",
                                        style = "margin-top:8px; font-size:12px; padding:4px;"),
                           div(class = "cv-area", uiOutput("cv_suggestions"))
                       )
          )
      )
    )
  )
)

# -----------------------------------------------------------------------------
# 4. Server
# -----------------------------------------------------------------------------
server <- function(input, output, session) {
  
  # Photos start empty; the folder picker (auto-fired once at launch) fills them.
  rv <- reactiveValues(photos = read_photo_metadata(character(0)),
                       idx = 1, undo = NULL)
  
  # Point the app at a folder: set the global PHOTO_FOLDER (used by the file-move
  # helpers), load + reconcile its photos, print a quick timing sanity check,
  # and land on the first untouched one.
  load_folder <- function(folder) {
    if (!dir.exists(folder)) {
      showNotification(sprintf("Folder not found: %s", folder), type = "error")
      return()
    }
    PHOTO_FOLDER <<- folder
    save_last_folder(folder)
    
    photos0    <- read_photo_metadata(folder)
    reconciled <- reconcile_already_captioned(photos0)
    if (reconciled$moved > 0)
      cat(sprintf("Moved %d already-captioned photo(s) into %s or %s\n",
                  reconciled$moved, LABELLED_DIR, UNDETERMINED_DIR))
    
    # ---- startup diagnostic (runs on each folder load): do photo timestamps
    # actually fall near observation-log entries? Prints the closest log match
    # (in minutes) for the first few photos, so a timezone/clock mismatch is
    # visible immediately rather than discovered one photo at a time. ----
    local({
      timed <- photos0 %>% filter(!is.na(datetime))
      cat(sprintf("Photos: %d found, %d have a usable timestamp\n",
                  nrow(photos0), nrow(timed)))
      if (CAMERA_CLOCK_OFFSET_HOURS != 0) {
        cat(sprintf("CAMERA_CLOCK_OFFSET_HOURS = %s is already applied below ",
                    CAMERA_CLOCK_OFFSET_HOURS))
        cat("(times shown are corrected, not the camera's raw clock).\n")
      }
      if (nrow(timed) > 0 && nrow(obs_log) > 0) {
        sample_n <- min(5, nrow(timed))
        cat(sprintf("Nearest observation-log match for the first %d timestamped photos:\n",
                    sample_n))
        for (i in seq_len(sample_n)) {
          gaps <- abs(as.numeric(difftime(obs_log$datetime, timed$datetime[i], units = "mins")))
          best <- which.min(gaps)
          cat(sprintf("  %s (%s) -> nearest: %s, %.1f min away\n",
                      timed$filename[i], format(timed$datetime[i]),
                      obs_log$species[best], gaps[best]))
        }
        cat(sprintf("Suggestions only show within %d minutes - if the gaps above are\n",
                    SUGGESTION_WINDOW_MINUTES))
        cat("much larger than that, the camera clock and the log are out of sync.\n")
      }
      cat("\n")
    })
    
    untouched <- which(reconciled$photos$status == "untouched")
    rv$photos <- reconciled$photos
    rv$idx    <- if (length(untouched)) untouched[1] else 1
    rv$undo   <- NULL
  }
  
  observeEvent(input$load_folder, { load_folder(input$photo_folder) })
  
  # Load the suggested folder automatically when the app starts.
  observeEvent(TRUE, { load_folder(input$photo_folder) }, once = TRUE)
  
  refresh     <- reactiveVal(0)             # bump to force the preview to re-render
  last_caption <- reactiveVal("")           # the most recently saved caption
  recent       <- reactiveVal(character(0)) # recently-used taxa (most recent first)
  grown        <- reactiveVal(character(0)) # taxa appended to the backbone this session
  
  # Fill the dropdown once
  updateSelectizeInput(session, "species", choices = species_choices)
  
  current <- reactive({ req(nrow(rv$photos) > 0); rv$photos[rv$idx, ] })
  
  # GPS read live for the photo on screen, rather than once at startup
  current_gps <- reactive({
    req(nrow(rv$photos) > 0)
    row <- current()
    list(lat = row$lat, lon = row$lon)
  })
  
  # Remove the current photo's GPS (for a clearly-wrong reading). Snapshots the
  # old coords first, so pressing u / Undo writes them straight back.
  clear_gps <- function() {
    if (nrow(rv$photos) == 0) return()
    row  <- rv$idx
    path <- rv$photos$path[row]
    lat  <- rv$photos$lat[row]
    lon  <- rv$photos$lon[row]
    if (is.na(lat) || is.na(lon)) return()   # nothing to remove
    
    snapshot(function() write_gps(path, lat, lon))   # rv$photos itself is restored by do_undo
    strip_gps(path)
    rv$photos$lat[row] <- NA_real_
    rv$photos$lon[row] <- NA_real_
  }
  observeEvent(input$gps_clear, { clear_gps() })
  
  # Button shows only when the photo actually has GPS to remove
  output$gps_clear_btn <- renderUI({
    g <- current_gps()
    if (is.na(g$lat) || is.na(g$lon)) return(NULL)
    actionButton("gps_clear", "Remove GPS (wrong)", class = "btn-default",
                 style = "margin-top:4px; margin-left:8px; font-size:12px; padding:2px 8px;")
  })
  
  # ---- iNaturalist: CV suggestions + observation creation ----
  cv_results <- reactiveVal(character(0))
  
  observeEvent(input$cv_fetch, {
    g        <- current_gps()
    when     <- current()$datetime
    when_str <- if (is.na(when)) "" else format(when, "%Y-%m-%d")
    showNotification("Asking iNaturalist\u2026", type = "message", duration = 2)
    res <- inat_cv_suggest(current()$path, g$lat, g$lon, when_str, input$inat_token)
    cv_results(head(res, INAT_CV_MAX))
    if (length(res) == 0)
      showNotification("No iNaturalist suggestions (check token / connection).",
                       type = "warning")
  })
  
  output$cv_suggestions <- renderUI({
    sp <- cv_results()
    if (length(sp) == 0)
      return(em("Press the button for iNaturalist suggestions.", style = "color:#999;"))
    tagList(lapply(seq_along(sp), function(i) {
      actionButton(paste0("cv_", i), sp[i], class = "btn-default sugg-btn")
    }))
  })
  
  # A CV suggestion click adds that taxon to the box (you can then edit, save
  # locally, or push it to iNat) - it does not save on its own. iNat names may
  # not be in your backbone, so we add the name to the dropdown's choices too.
  lapply(seq_len(INAT_CV_MAX), function(i) {
    observeEvent(input[[paste0("cv_", i)]], {
      sp <- cv_results()
      if (i <= length(sp)) {
        pick <- sp[i]
        updateSelectizeInput(session, "species",
                             choices  = sort(unique(c(species_choices, input$species, pick))),
                             selected = unique(c(input$species, pick)))
      }
    }, ignoreInit = TRUE)
  })
  
  observeEvent(input$inat_obs, {
    taxa <- input$species
    if (is.null(taxa) || length(taxa) == 0) {
      showNotification("Pick a taxon first.", type = "warning"); return()
    }
    if (is.null(input$inat_token) || trimws(input$inat_token) == "") {
      showNotification("Set your iNaturalist token first.", type = "warning"); return()
    }
    g   <- current_gps()
    loc <- if (is.na(g$lat) || is.na(g$lon)) "no GPS" else sprintf("%.4f, %.4f", g$lat, g$lon)
    showModal(modalDialog(
      title = "Create iNaturalist observation?",
      tags$p(sprintf("Taxon: %s", taxa[1])),
      tags$p(sprintf("Location: %s", loc)),
      tags$p(sprintf("Photo: %s", current()$filename)),
      tags$p("This posts to your public iNaturalist account.", style = "color:#888;"),
      footer = tagList(
        modalButton("Cancel"),
        actionButton("inat_obs_confirm", "Create observation", class = "btn-primary")
      )
    ))
  })
  
  observeEvent(input$inat_obs_confirm, {
    removeModal()
    taxa     <- input$species
    g        <- current_gps()
    when     <- current()$datetime
    when_str <- if (is.na(when)) "" else format(when, "%Y-%m-%d %H:%M")
    showNotification("Creating observation\u2026", type = "message", duration = 3)
    url <- inat_create_observation(taxa[1], g$lat, g$lon, when_str,
                                   current()$path, input$inat_token)
    if (startsWith(url, "ERROR")) {
      showNotification(url, type = "error", duration = 8)
    } else {
      rv$photos$inat_url[rv$idx] <- url          # so the link shows without relaunch
      showNotification(
        tagList("Observation created: ", tags$a(href = url, target = "_blank", url)),
        type = "message", duration = 10)
    }
  })
  
  # ---- iNaturalist: token verification + status badge ----
  # Verify a token by calling an auth-required endpoint. Returns the iNat login
  # name on success, or NULL if the token is missing / invalid / expired.
  inat_whoami <- function(token) {
    if (is.null(token) || trimws(token) == "") return(NULL)
    resp <- tryCatch(
      GET("https://api.inaturalist.org/v1/users/me",
          add_headers(Authorization = paste("Bearer", trimws(token)))),
      error = function(e) NULL)
    if (is.null(resp) || http_error(resp)) return(NULL)
    content(resp)$results[[1]]$login
  }
  
  token_login <- reactiveVal(NULL)   # login name if last check succeeded
  
  observeEvent(input$inat_verify, {
    who <- inat_whoami(input$inat_token)
    token_login(who)
    if (is.null(who)) {
      showNotification("Token missing, invalid, or expired.", type = "error")
    } else {
      save_inat_token(input$inat_token)          # remember it for next time
      showNotification(paste("Signed in as", who), type = "message")
    }
  })
  
  # A token remembered from a previous session: verify it once at launch so its
  # status shows green without a manual click.
  observeEvent(TRUE, {
    if (nzchar(INITIAL_TOKEN)) token_login(inat_whoami(INITIAL_TOKEN))
  }, once = TRUE)
  
  # ---- iNaturalist: re-check posted observations for research-grade updates ----
  review_queue <- reactiveVal(NULL)   # pending updates to confirm, one per row
  
  run_inat_status_check <- function(announce = TRUE) {
    ids <- vapply(rv$photos$inat_url, inat_id_from_url, character(1))
    if (all(ids == "")) {
      if (announce)
        showNotification("No posted iNaturalist observations to check.",
                         type = "message")
      return()
    }
    if (announce) showNotification("Checking iNaturalist\u2026", type = "message",
                                   duration = 3)
    status <- inat_fetch_status(ids, isolate(input$inat_token))
    queue  <- build_review_queue(rv$photos, status)
    review_queue(queue)
    if (nrow(queue) > 0) {
      show_next_review()
    } else if (announce) {
      showNotification("iNaturalist checked \u2014 no captions need updating.",
                       type = "message")
    }
  }
  
  # Show the next queued update as a modal; the user keeps theirs or takes iNat's.
  show_next_review <- function() {
    q <- review_queue()
    if (is.null(q) || nrow(q) == 0) { removeModal(); return() }
    item <- q[1, ]
    showModal(modalDialog(
      title = "iNaturalist update \u2014 research grade",
      tags$p(tags$strong(basename(item$path))),
      tags$p(sprintf("Your caption: %s", item$caption)),
      tags$p(sprintf("iNaturalist consensus: %s", item$inat_taxon)),
      tags$p(sprintf("%d to review.", nrow(q)), style = "color:#888;"),
      footer = tagList(
        actionButton("review_skip",   "Keep mine"),
        actionButton("review_accept", "Use iNat name", class = "btn-primary")
      ),
      easyClose = FALSE
    ))
  }
  
  observeEvent(input$review_accept, {
    q <- review_queue()
    if (is.null(q) || nrow(q) == 0) { removeModal(); return() }
    item    <- q[1, ]
    caption <- compose_caption(item$inat_taxon, lookup_family(item$inat_taxon))
    row     <- which(rv$photos$path == item$path)
    if (length(row) == 1) {
      old_path <- rv$photos$path[row]
      new_path <- move_target(old_path, LABELLED_DIR)   # no-op if already there
      write_caption(old_path, caption)
      moved_ok <- move_file(old_path, new_path)
      rv$photos$path[row]    <- if (moved_ok) new_path else old_path
      rv$photos$caption[row] <- caption
      rv$photos$status[row]  <- "labelled"
    }
    review_queue(q[-1, ])
    show_next_review()
  })
  
  observeEvent(input$review_skip, {
    q <- review_queue()
    if (!is.null(q)) review_queue(q[-1, ])
    show_next_review()
  })
  
  observeEvent(input$inat_recheck, { run_inat_status_check(announce = TRUE) })
  
  # At launch, quietly re-check everything already posted and queue any updates.
  observeEvent(TRUE, { run_inat_status_check(announce = FALSE) }, once = TRUE)
  
  # A fresh edit of the token invalidates the last successful check
  observeEvent(input$inat_token, { token_login(NULL) }, ignoreInit = TRUE)
  
  output$inat_token_status <- renderUI({
    if (!is.null(token_login()))
      tags$span(paste0("\u2713 signed in as ", token_login()),
                style = "color:#4caf50; font-size:12px;")
    else if (is.null(input$inat_token) || trimws(input$inat_token) == "")
      tags$span("\u25cb no token set", style = "color:#888; font-size:12px;")
    else
      tags$span("\u2022 token entered \u2014 press \u201cCheck token\u201d",
                style = "color:#e69500; font-size:12px;")
  })
  
  # Photos to step through: any status currently checked in the "Show:" filter
  visible_idx <- reactive({
    sel <- input$status_filter
    if (is.null(sel) || length(sel) == 0) return(integer(0))
    which(rv$photos$status %in% sel)
  })
  go_next <- function() {
    after <- visible_idx(); after <- after[after > rv$idx]
    if (length(after)) rv$idx <- after[1]
  }
  go_prev <- function() {
    before <- visible_idx(); before <- before[before < rv$idx]
    if (length(before)) rv$idx <- before[length(before)]
  }
  # After an action removes the current photo from view, land on a visible one
  ensure_visible <- function() {
    vis <- visible_idx()
    if (length(vis) == 0 || rv$idx %in% vis) return()
    after <- vis[vis >= rv$idx]
    rv$idx <- if (length(after)) after[1] else vis[length(vis)]
  }
  
  # ---- One-level undo ----
  # Take a snapshot before a mutating action. file_undo() reverses any change
  # made on disk (rewriting a caption, moving a deleted file back, etc.).
  snapshot <- function(file_undo = function() {}) {
    rv$undo <- list(photos = rv$photos, idx = rv$idx, file_undo = file_undo,
                    last_caption = last_caption(), recent = recent())
  }
  do_undo <- function() {
    u <- rv$undo
    if (is.null(u)) return()
    u$file_undo()
    rv$photos <- u$photos
    rv$idx    <- min(u$idx, nrow(u$photos))
    last_caption(u$last_caption)
    recent(u$recent)
    rv$undo   <- NULL
  }
  
  # ---- Family + backbone growth ----
  added_family <- reactiveValues(map = list())   # families typed this session
  family_for <- function(taxon) {
    fam <- lookup_family(taxon)
    if (fam == "" && !is.null(added_family$map[[taxon]])) fam <- added_family$map[[taxon]]
    fam
  }
  # Remember families for the taxa just used, and (optionally) append genuinely
  # new taxa to the backbone file so they persist to next session.
  remember_and_grow <- function(taxa) {
    for (t in taxa) {
      fam <- family_for(t)
      if (fam == "" && length(taxa) == 1 &&
          !is.null(input$family) && trimws(input$family) != "")
        fam <- trimws(input$family)
      if (fam == "") next
      if (is.null(added_family$map[[t]])) added_family$map[[t]] <- fam
      if (isTRUE(GROW_BACKBONE) && !(t %in% backbone$Taxonname) && !(t %in% grown())) {
        if (length(grown()) == 0) ensure_trailing_newline(SPECIES_FILE)   # <- here, correct
        cat(sprintf("%s,%s\n", csv_field(t), csv_field(fam)),
            file = SPECIES_FILE, append = TRUE)
        grown(c(grown(), t))
      }
    }
  }
  
  # ---- Photo display ----
  output$photo <- renderImage({
    req(nrow(rv$photos) > 0)
    refresh()                        # re-render after a rotation
    preview <- make_preview(current()$path, CACHE_DIR)
    list(src = preview, contentType = "image/jpeg",
         style = "max-width:100%; max-height:72vh; border:1px solid #ddd;")
  }, deleteFile = FALSE)
  
  output$filename  <- renderText({ current()$filename })
  output$datetaken <- renderText({
    d <- current()$datetime
    if (is.na(d)) "Date taken: unknown"
    else paste("Date taken:", format(d, "%Y-%m-%d %H:%M"))
  })
  output$current_caption <- renderText({
    cap <- current()$caption
    if (cap == "") "No caption yet" else paste("Current caption:", cap)
  })
  # Link to this photo's iNaturalist observation, if one was created for it
  output$inat_obs_link <- renderUI({
    url <- current()$inat_url
    if (is.null(url) || is.na(url) || url == "") return(NULL)
    tags$div(
      tags$a(href = url, target = "_blank", "View on iNaturalist \u2197"),
      style = "margin-top:2px;")
  })
  output$gps <- renderText({
    g <- current_gps()
    if (is.na(g$lat) || is.na(g$lon)) "GPS: none"
    else sprintf("GPS: %.5f, %.5f", g$lat, g$lon)
  })
  output$locality <- renderText({
    nearby <- suggestions_locality()
    if (length(nearby) == 0) "" else paste("Locality (log):", nearby[1])
  })
  
  # ---- Map: a small overlay in the photo's bottom-right corner, shown only
  # when the current photo has GPS and the toggle button has it switched on ----
  map_visible <- reactiveVal(FALSE)
  observeEvent(input$toggle_map, { map_visible(!map_visible()) })
  
  output$map_toggle_btn <- renderUI({
    g <- current_gps()
    if (is.na(g$lat) || is.na(g$lon)) return(NULL)
    label <- if (isTRUE(map_visible())) "Hide map" else "Show map"
    actionButton("toggle_map", label, style = "margin-top:4px;")
  })
  
  output$map_overlay <- renderUI({
    g <- current_gps()
    if (is.na(g$lat) || is.na(g$lon) || !isTRUE(map_visible())) return(NULL)
    div(class = "map-overlay", leafletOutput("map", height = "100%", width = "100%"))
  })
  output$map <- renderLeaflet({
    g <- current_gps()
    req(!is.na(g$lat), !is.na(g$lon))
    leaflet() %>%
      addTiles() %>%
      addMarkers(lng = g$lon, lat = g$lat) %>%
      setView(lng = g$lon, lat = g$lat, zoom = 16)
  })
  output$status <- renderUI({
    p <- current()
    label <- switch(p$status,
                    labelled     = "\u2713 labelled",
                    skipped      = "\u2022 skipped",
                    undetermined = "? undetermined",
                    deleted      = "\u2717 deleted",
                    "\u25cb untouched"
    )
    color <- switch(p$status,
                    labelled = "#4caf50", skipped = "#e69500", undetermined = "#7a6fd1",
                    deleted = "#d9534f", "#888"
    )
    tags$span(label, style = sprintf("color:%s; font-weight:bold;", color))
  })
  output$progressbar <- renderUI({
    total <- max(nrow(rv$photos), 1)                       # avoid divide-by-zero
    # "Done" = anything that has left the main folder (i.e. not untouched).
    # Undetermined photos are drawn in yellow; the rest of the done set in green.
    undetermined_pct <- round(100 * sum(rv$photos$status == "undetermined") / total)
    other_done_pct   <- round(100 * sum(rv$photos$status %in%
                                          c("labelled", "skipped", "deleted")) / total)
    div(style = "display:flex; background:#eee; border-radius:5px;
                 height:18px; margin-bottom:6px; overflow:hidden;",
        div(style = sprintf("background:#4caf50; height:18px; width:%d%%;", other_done_pct)),
        div(style = sprintf("background:#e6b800; height:18px; width:%d%%;", undetermined_pct)))
  })
  output$progress <- renderText({
    counts <- table(factor(rv$photos$status,
                           levels = c("untouched", "labelled", "skipped",
                                      "undetermined", "deleted")))
    sprintf("%d untouched, %d labelled, %d skipped, %d undetermined, %d deleted (showing #%d of %d)",
            counts["untouched"], counts["labelled"], counts["skipped"],
            counts["undetermined"], counts["deleted"], rv$idx, nrow(rv$photos))
  })
  
  # ---- Suggestions from the observation log ----
  suggestions <- reactive({
    suggest_species(current()$datetime, obs_log, SUGGESTION_WINDOW_MINUTES) %>%
      head(MAX_SUGGESTIONS)
  })
  suggestions_locality <- reactive({
    suggest_localities(current()$datetime, obs_log, SUGGESTION_WINDOW_MINUTES)
  })
  output$suggestions <- renderUI({
    sp <- suggestions()
    if (length(sp) == 0) return(em("No observation-log matches near this time."))
    tagList(lapply(seq_along(sp), function(i) {
      label <- if (i <= 9) paste0(i, ": ", sp[i]) else sp[i]
      actionButton(paste0("sugg_", i), label, class = "btn-default sugg-btn")
    }))
  })
  # One observer per suggestion slot: a click saves that taxon (plus anything
  # already selected) right away and advances to the next photo
  lapply(seq_len(MAX_SUGGESTIONS), function(i) {
    observeEvent(input[[paste0("sugg_", i)]], {
      sp <- suggestions()
      if (i <= length(sp)) instant_save(unique(c(input$species, sp[i])))
    }, ignoreInit = TRUE)
  })
  
  # ---- Recently-used taxa: one-tap buttons for species you've just applied ----
  output$recent_ui <- renderUI({
    rc <- recent()
    if (length(rc) == 0)
      return(em("None yet \u2014 saved taxa will appear here.", style = "color:#999;"))
    tagList(lapply(seq_along(rc), function(i) {
      actionButton(paste0("recent_", i), rc[i], class = "btn-default sugg-btn")
    }))
  })
  lapply(seq_len(MAX_RECENT), function(i) {
    observeEvent(input[[paste0("recent_", i)]], {
      rc <- recent()
      if (i <= length(rc)) instant_save(unique(c(input$species, rc[i])))
    }, ignoreInit = TRUE)
  })
  
  # When the displayed photo changes (navigation, save, or delete),
  # re-select the taxon from any existing caption
  observeEvent(current()$path, {
    cap <- current()$caption
    updateSelectizeInput(session, "species", selected = taxa_from_caption(cap))
    updateCheckboxInput(session, "cf", value = grepl("cf\\.", cap))
  })
  
  # Move the current photo into the _deleted subfolder (recoverable - it
  # still appears in the app when "Deleted" is checked in the Show: filter)
  discard_current <- function() {
    if (nrow(rv$photos) == 0) return()
    row      <- rv$idx
    old_path <- rv$photos$path[row]
    new_path <- move_target(old_path, DELETED_DIR)
    
    snapshot(function() {
      if (!identical(new_path, old_path)) suppressWarnings(file.rename(new_path, old_path))
    })
    
    if (!move_file(old_path, new_path)) {
      showNotification("Could not move the photo.", type = "error")
      return()
    }
    rv$photos$path[row]   <- new_path
    rv$photos$status[row] <- "deleted"   # or "skipped"
    ensure_visible()                     # (discard) / go_next() (skip)
  }
  
  # Rotate the current photo 90 degrees clockwise (writes the original in
  # place, so the creation date is kept), then refresh its preview.
  rotate_current <- function() {
    if (nrow(rv$photos) == 0) return()
    p <- rv$photos[rv$idx, ]
    system2("sips", c("-r", "90", shQuote(p$path)), stdout = FALSE, stderr = FALSE)
    safe <- gsub("[^A-Za-z0-9._-]", "_", p$filename)
    preview <- file.path(CACHE_DIR, preview_name(p$path))
    if (file.exists(preview)) unlink(preview)
    refresh(refresh() + 1)
  }
  
  # Keyboard: left/right arrows navigate; r rotates; digits 1-9 add that
  # suggestion; c toggles "cf."; u undoes; i marks "can't determine";
  # Delete/Backspace discards the photo, but only when no taxon has been
  # chosen yet ("when I haven't typed")
  observeEvent(input$key_event, {
    if (nrow(rv$photos) == 0) return()
    key <- input$key_event$key
    if (key == "ArrowRight") {
      go_next()
    } else if (key == "ArrowLeft") {
      go_prev()
    } else if (key %in% c("r", "R")) {
      rotate_current()
    } else if (key %in% c("c", "C")) {
      copy_last()
    } else if (key %in% c("u", "U")) {
      do_undo()
    } else if (key %in% c("i", "I")) {
      mark_undetermined()
    } else if (key %in% c("s", "S")) {
      save_same_as_previous()
    } else if (grepl("^[1-9]$", key)) {
      add_suggestion(as.integer(key))
    } else if (key %in% c("Delete", "Backspace")) {
      if (!length(input$species)) discard_current()
    }
  })
  
  observeEvent(input$rotate,        { rotate_current() })
  observeEvent(input$undetermined,  { mark_undetermined() })
  
  # The Delete button always discards (an explicit, deliberate action)
  observeEvent(input$delete, { discard_current() })
  
  # Real-time caption preview across all selected taxa, joined by ", ".
  # "cf." marks the determination uncertain. When exactly one taxon is selected
  # and it has no family, the Family box supplies it. You can always edit the
  # Caption box by hand afterwards.
  # Compose a caption directly from a taxa vector (not from input$species),
  # so a button click can save immediately without waiting for the
  # update->client->server round-trip that input$species normally needs.
  compose_for_taxa <- function(taxa) {
    if (length(taxa) == 0) return("")
    parts <- vapply(taxa, function(t) {
      fam  <- family_for(t)
      name <- if (isTRUE(input$cf)) apply_cf(t) else t
      compose_caption(name, fam)
    }, character(1))
    paste(parts, collapse = ", ")
  }
  
  live_caption <- reactive({
    taxa <- input$species
    if (is.null(taxa) || length(taxa) == 0) return("")
    parts <- vapply(taxa, function(t) {
      fam   <- family_for(t)
      if (fam == "" && length(taxa) == 1 &&
          !is.null(input$family) && trimws(input$family) != "")
        fam <- trimws(input$family)
      name <- if (isTRUE(input$cf)) apply_cf(t) else t
      compose_caption(name, fam)
    }, character(1))
    paste(parts, collapse = ", ")
  })
  
  observeEvent(list(input$species, input$family, input$cf), {
    updateTextInput(session, "caption_final", value = live_caption())
  }, ignoreInit = TRUE, ignoreNULL = FALSE)
  
  # Show a Family box only when a single taxon is selected and it has no family
  # (the common "one new taxon" case). For several taxa, edit families in the box.
  output$family_ui <- renderUI({
    taxa <- input$species
    if (length(taxa) != 1 || lookup_family(taxa) != "") return(NULL)
    prefill <- added_family$map[[taxa]]
    textInput("family", "Family (not in backbone \u2014 add it)",
              value = if (is.null(prefill)) "" else prefill)
  })
  
  # Record taxa just used, most-recent first
  note_recent <- function(taxa) {
    if (length(taxa)) recent(head(unique(c(taxa, recent())), MAX_RECENT))
  }
  
  # ---- Shared save logic: write the caption metadata, move the file into
  # _labelled, update the in-memory row, and snapshot for undo. snapshot()
  # is taken BEFORE any mutation so the in-memory revert is correct, and the
  # file_undo closure captures the already-known old/new paths by value so
  # it works correctly even after rv$idx has moved on to later photos.
  finalize_caption_save <- function(row, caption, taxa) {
    old_caption <- rv$photos$caption[row]
    old_path    <- rv$photos$path[row]
    new_path    <- move_target(old_path, LABELLED_DIR)
    
    snapshot(function() {
      if (!identical(new_path, old_path)) suppressWarnings(file.rename(new_path, old_path))
      write_caption(old_path, old_caption)
    })
    
    write_caption(old_path, caption)              # (or UNDETERMINED_CAPTION)
    moved_ok <- move_file(old_path, new_path)
    if (!moved_ok)
      showNotification("Caption written, but the file move failed.", type = "warning")
    
    rv$photos$path[row]    <- if (moved_ok) new_path else old_path
    rv$photos$caption[row] <- caption
    rv$photos$status[row]  <- "labelled"          # or "undetermined"
    
    remember_and_grow(taxa)
    note_recent(taxa)
    last_caption(caption)
  }
  
  # ---- Mark "can't determine": writes the Indet. marker caption, moves the
  # photo into _undetermined, and advances - a distinct outcome from Skip
  # (which means "haven't looked yet"), recording that an ID was attempted
  # and genuinely isn't possible from this photo.
  mark_undetermined <- function() {
    if (nrow(rv$photos) == 0) return()
    row         <- rv$idx
    old_caption <- rv$photos$caption[row]
    old_path    <- rv$photos$path[row]
    new_path    <- move_target(old_path, UNDETERMINED_DIR)
    
    snapshot(function() {
      if (!identical(new_path, old_path)) suppressWarnings(file.rename(new_path, old_path))
      write_caption(old_path, old_caption)
    })
    
    write_caption(old_path, UNDETERMINED_CAPTION)
    moved_ok <- move_file(old_path, new_path)
    if (!moved_ok)
      showNotification("Caption written, but the file move failed.", type = "warning")
    
    rv$photos$path[row]    <- if (moved_ok) new_path else old_path
    rv$photos$caption[row] <- UNDETERMINED_CAPTION
    rv$photos$status[row]  <- "undetermined"
    
    last_caption(UNDETERMINED_CAPTION)
    go_next()
  }
  
  # --- Build GBIF species list
  observeEvent(input$build_gbif_list, {
    coords <- rv$photos %>% filter(!is.na(lat), !is.na(lon))
    if (nrow(coords) == 0) {
      showNotification("No photo GPS found - can't build a search area.", type = "error")
      return()
    }
    bb <- photo_search_bbox(coords$lat, coords$lon, GBIF_RADIUS_KM)
    showNotification(
      sprintf("Scanning GBIF archive within %d km of the photo area (%d located photos) - this can take several minutes. Watch the R console for progress.",
              GBIF_RADIUS_KM, nrow(coords)),
      id = "gbif", duration = NULL, type = "message")
    n <- tryCatch(
      build_species_list_from_gbif_zip(GBIF_ZIP_FILE, bb, GBIF_SPECIES_OUT),
      error = function(e) {
        showNotification(conditionMessage(e), type = "error", duration = 10)
        NA_integer_
      })
    removeNotification("gbif")
    if (!is.na(n))
      showNotification(sprintf("Wrote %d species to %s", n, GBIF_SPECIES_OUT),
                       type = "message", duration = 10)
  })
  
  # ---- Instant save: used by suggestion/recent-taxa clicks (and the 1-9
  # shortcut) - composes the caption from the given taxa right away and
  # saves + advances in one step, with no separate Save click needed ----
  instant_save <- function(taxa) {
    caption <- compose_for_taxa(taxa)
    if (caption == "") return()
    finalize_caption_save(rv$idx, caption, taxa)
    go_next()
  }
  
  # ---- Save: write the editable Caption box to the current photo, then advance ----
  do_save <- function() {
    caption <- input$caption_final
    if (is.null(caption) || trimws(caption) == "") return()
    caption <- trimws(caption)
    finalize_caption_save(rv$idx, caption, input$species)
    go_next()
  }
  
  # ---- Copy the last saved caption into the editable box (you then Save) ----
  copy_last <- function() {
    if (nzchar(last_caption()))
      updateTextInput(session, "caption_final", value = last_caption())
  }
  
  # ---- Apply the previously-saved caption to this photo and advance. Handy for
  # a burst of shots of the same plant. Whatever was last saved (including an
  # "Indet." marker) is reused as-is; does nothing if nothing has been saved yet.
  save_same_as_previous <- function() {
    cap <- last_caption()
    if (!nzchar(cap)) return()
    finalize_caption_save(rv$idx, cap, taxa_from_caption(cap))
    go_next()
  }
  observeEvent(input$same_prev, { save_same_as_previous() })
  
  # ---- Add the Nth date-suggestion to the current selection and save it ----
  add_suggestion <- function(n) {
    sp <- suggestions()
    if (n >= 1 && n <= length(sp)) instant_save(unique(c(input$species, sp[n])))
  }
  
  observeEvent(input$save,       { do_save() })
  observeEvent(input$enter_save, { do_save() })
  observeEvent(input$copy_last,  { copy_last() })
  observeEvent(input$undo,       { do_undo() })
  
  # ---- Navigation ----
  observeEvent(input$prev, { go_prev() })
  observeEvent(input$nxt,  { go_next() })
  observeEvent(input$skip, {
    row      <- rv$idx
    old_path <- rv$photos$path[row]
    new_path <- move_target(old_path, SKIPPED_DIR)
    
    snapshot(function() {
      if (!identical(new_path, old_path)) suppressWarnings(file.rename(new_path, old_path))
    })
    
    if (!identical(new_path, old_path)) suppressWarnings(file.rename(old_path, new_path))
    rv$photos$path[row]   <- new_path
    rv$photos$status[row] <- "skipped"
    go_next()
  })
  # When the visibility filter changes, jump to a photo that's still shown
  observeEvent(input$status_filter, {
    ensure_visible()
  }, ignoreInit = TRUE)
}

# -----------------------------------------------------------------------------
# 5. Run
# -----------------------------------------------------------------------------
shinyApp(ui, server)