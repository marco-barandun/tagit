# Bundled taxonomies

Drop taxonomy CSV files in this folder and they appear automatically in the
app's **Taxonomy** dropdown (under *Setup & tools*).

## File format

A **CSV or Excel (`.xlsx`)** file with (at least) these two columns:

| column   | meaning                          |
|----------|----------------------------------|
| `taxon`  | the scientific name (e.g. `Carex flava`) |
| `family` | the family (e.g. `Cyperaceae`)   |

**Any additional columns are treated as attributes** — for example `invasive`,
`status`, `red_list`, `origin`. These are **not** written into the photo's
caption, but they *are* added to the photo's **keywords** on save, alongside the
genus, species (full name) and family. A boolean-style value (`yes`/`true`/`1`/
`x`) contributes the column name as a keyword; any other value contributes the
value itself. Example row:

```
taxon,family,invasive,origin
Impatiens glandulifera,Balsaminaceae,yes,Asia
```

→ caption `Impatiens glandulifera (Balsaminaceae)`, keywords
`Impatiens, Impatiens glandulifera, Balsaminaceae, invasive, Asia`.

Taxonomic authorities are stripped automatically
(`Carex flava (L.) Reichard` → `Carex flava`).

## Multiple taxonomies

Several taxonomies can be active at once (tick them in the app). They are merged
by taxon name; attributes from all active taxonomies are combined. All bundled
files here are enabled by default on first run.

## File naming → display name

Name files like:

```
taxonomy_<Group>_<Rest_of_the_name>.csv
```

The app turns the filename into a readable label: the first segment becomes a
group, the rest becomes the name. For example:

```
taxonomy_Plants_InfoFlora_Checklist_2017.csv   →   "Plants - InfoFlora Checklist 2017"
taxonomy_Birds_Switzerland_2023.csv            →   "Birds - Switzerland 2023"
```

(The `taxonomy_` prefix is optional; without it, underscores just become spaces.)

## How they are discovered

- **Running locally** (e.g. via `run.command`): files here are detected
  automatically — just drop a CSV in and reload.
- **Published on GitHub Pages**: static hosting can't list a folder, so also
  regenerate `index.json` after adding/removing files:

  ```bash
  cd docs/taxonomies
  ls taxonomy_*.csv *.csv 2>/dev/null | sort -u | \
    python3 -c 'import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))' > index.json
  ```

Users can always upload their own taxonomy from within the app instead, with a
column picker — those are remembered in their browser.
