# tagit

Caption plant and animal photos with species names, then organise them — running
entirely in your web browser, on your own computer. Nothing is uploaded to any
server: the photos and their metadata never leave your machine.

There are two versions in this repository:

| | Browser version (`docs/`) | Original desktop version (`tagit.R`) |
|---|---|---|
| **Install** | none — just open a web page | R + exiftool + sips (macOS) |
| **Runs on** | Chrome / Edge / Brave / Arc (full); Safari / Firefox (limited) | macOS |
| **Photo formats** | JPEG only | JPEG, HEIC, TIFF, RAW |
| **Best for** | sharing with others, quick JPEG tagging | your own full workflow incl. RAW/HEIC |

---

## Browser version — quick start

1. **Open the page.** Once published (see below) it lives at a URL like
   `https://<your-username>.github.io/tagit/`. You can also run it locally with
   any static server, e.g. `python3 -m http.server --directory docs`.
2. **Choose a taxonomy** (recommended) under **Setup & tools**:
   - pick a **bundled taxonomy** from the dropdown (files placed in
     `docs/taxonomies/`, columns `taxon`, `family` — see that folder's README), or
   - **upload your own** and choose which columns are the taxon and the family;
     your uploads are remembered in your browser.

   Optionally also load an **observation log** CSV/TSV with a taxon column and a
   date column (`date_start` / `datetime`) to get time-based suggestions.
3. **Open a photo folder** (Chrome/Edge/Brave/Arc) — or **drag JPEGs** anywhere
   on the page.
4. **Tag:** pick one or more taxa (type to search or add a new name), tick *cf.*
   if uncertain, then **Save caption & next**. Suggestions and recently-used
   taxa are one click (or press 1–9).

As you work, files are physically organised inside the folder you opened:

- **Save** → written caption + moved to `_labelled/`
- **Skip** → `_skipped/`
- **Can't determine** → `_undetermined/` (caption `Indet.`)
- **Delete** → `_deleted/` (recoverable)

The caption is written into the three metadata fields Apple Photos reads as the
"caption": `IPTC:Caption-Abstract`, `XMP-dc:description`, `EXIF:ImageDescription`.
After tagging, import the folder into Photos (`File > Import`) and the captions
come across automatically.

### Keyboard shortcuts

`←` `→` navigate · `1`–`9` pick that suggestion · `Delete` discard (only when
no taxon is selected). Typing any letter with nothing focused jumps straight
into the taxon search box — Rotate/Undo/Can't-determine/Same-as-previous are
one click away as buttons rather than shortcut letters, so a letter always
means "start a search." In the search box, type an abbreviation of each word
(e.g. `dro rot` for *Drosera rotundifolia*, `dact fuch` for *Dactylorhiza
maculata* subsp. *fuchsii*) and press `Enter` to save that match and move to
the next photo in one step.

### Tagging straight from Apple Photos

Instead of opening a folder, click **Connect to Photos** to tag photos
directly in your Apple Photos library — no export, no import. It talks to a
small helper app that runs on your own Mac; see
[`photos-helper/README.md`](photos-helper/README.md) for setup and exactly
what permissions it asks for and why.

### Limitations of the browser version

- **JPEG only.** RAW (CR2/NEF/ARW/DNG…) and HEIC can't be viewed or written in a
  browser. Use the R desktop version for those.
- **Full folder read/write** (opening a folder and organising files in place)
  needs the File System Access API — **Chrome, Edge, Brave, or Arc**. In Safari
  and Firefox you can still drag photos in and download captioned copies, but
  files aren't organised in place.
- **iNaturalist** (paste an API token in the *iNaturalist* tab): *Identify* gives AI
  suggestions with confidence scores, editable right there as the caption to save;
  *Create observation* posts the photo to your account and links the
  observation URL into the file; *Sync IDs from iNat* re-checks every linked photo
  and updates captions that have become research grade with a different consensus
  taxon. (The **GBIF species-list builder** from the R version isn't ported.)
- **Keywords**: on save, genus, species, family and any taxonomy attributes
  (e.g. `invasive`) are written to the photo's keywords (deduplicated), separate
  from the caption. You can add your own keywords per photo too.
- **Multiple taxonomies** can be active at once; each may carry extra attribute
  columns. See `docs/taxonomies/README.md`.
- **Watermark**: optionally burn a small text watermark into saved photos
  (EXIF is preserved).
- **Map**: photos with GPS get a *Show map* control alongside the other photo
  info; it appears as a small OpenStreetMap preview in the photo's
  bottom-right corner — click it to enlarge.

---

## Publishing on GitHub Pages

The browser version is a static site, so GitHub Pages hosts it for free.

1. Make this folder its own repository (it is currently untracked inside another
   repo). From `tagit/`:
   ```bash
   git init
   git add .
   git commit -m "tagit: browser version"
   gh repo create tagit --public --source=. --push   # or create the repo on github.com and push
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, then choose **`main`** and the **`/docs`** folder, and **Save**.
3. After a minute the site is live at
   `https://<your-username>.github.io/tagit/`. Share that link — anyone can use
   it, no install.

The `docs/` folder is fully self-contained — the two metadata libraries
(`exifr`, `piexifjs`) are vendored under `docs/vendor/`, so the tool works
offline with no external requests once the page has loaded.

---

## Original desktop version (`tagit.R`)

A Shiny app with the full feature set (RAW/HEIC via `sips`, robust metadata via
`exiftool`, iNaturalist computer-vision suggestions and observation posting, and
a local GBIF occurrence-zip species-list builder). One-time setup:

```bash
brew install exiftool
# in R:
install.packages(c("shiny", "dplyr", "readr", "jsonlite", "leaflet", "httr", "sf"))
```

Edit the paths in the **Configuration** block at the top of `tagit.R`, then run
it from R (`shiny::runApp("tagit.R")` or open it in RStudio and click *Run App*).
