# tagit Photos Helper

Lets the [browser version of tagit](../docs/) tag photos straight from your
Apple Photos library — no export, no import, no copies. It's a small helper
app that runs on your own Mac and talks to the tagit web page over
`127.0.0.1` only.

## What it does, in plain terms

- You click **Connect to Photos** in tagit. That launches the helper and
  pairs the two automatically — tagit generates a secret, hands it to the
  helper inside the launch link, and connects the moment the helper answers
  with it. No code to copy. (A manual paste-the-code fallback still exists in
  the dialog if automatic pairing ever fails.)
- The helper listens on `127.0.0.1:8765` — a port that's only reachable from
  this Mac, never from your network — and answers only to a page on its
  fixed allowlist of tagit addresses, carrying the current pairing secret.
- macOS's own Photos permission dialog is all-or-nothing on the Mac (unlike
  iPhone/iPad, there's no "Select Photos…" option here — confirmed against
  Apple's own framework headers). So the real safety boundary is enforced by
  the helper itself, one step later: **you pick exactly one album**, right in
  tagit (with thumbnails), and from then on the helper only ever knows about
  photos in that album — nothing else in your library is fetched, listed, or
  written to, no matter what. Your last album is remembered, so reconnecting
  is a single click.
- Captions and keywords are written using Photos' own scripting interface
  (the same mechanism AppleScript automation uses) — not by exporting a copy,
  editing it, and re-importing it. The photo never leaves Photos.
- The helper has no window at all — just a small icon in the menu bar (click
  it for status and to quit). Nothing ever pops up or grabs focus on its own.
- Ending access is immediate and can be done from either side: **Disconnect &
  quit helper** in tagit's dialog, or **Quit Helper** from the menu bar icon.
  It also quits by itself after an hour with no activity, so access never
  quietly lingers.

## Setup

**One-time build**, then the Connect button in tagit does everything from
then on.

1. **Build it** (needs Xcode's command-line tools):
   ```bash
   cd photos-helper
   ./build-app.sh
   ```
   This creates `dist/tagit Photos Helper.app`, plus a demo-mode launcher
   (see below).
2. **Open it once by hand** — double-click `dist/tagit Photos Helper.app`
   (it's unsigned, so the first launch needs an extra step: right-click →
   **Open** → **Open** again in the dialog that appears; this registers it
   with macOS so tagit's web page can launch it directly afterward). A small
   icon appears in the menu bar — that's the whole UI. Quit it from there.
3. **From then on**, just click **Connect to Photos** in tagit and approve
   the browser's "open app" prompt. **The first real run only**, macOS will
   also ask twice:
   - *"tagit Photos Helper" would like to access your photos* → this is
     all-or-nothing on macOS (see above for why); allow it.
   - *"tagit Photos Helper" would like to control "Photos"* → this is the
     Automation permission that lets it write captions/keywords. Allow it —
     without it, captions can't be saved.
4. **Pick an album** in tagit's own picker, and start tagging. Next time,
   your last album is used automatically.
5. **When you're done**: **Connect to Photos → Disconnect & quit helper**
   (or **Quit Helper** from its menu bar icon).

The pairing secret is never saved anywhere (not in the browser, not on
disk) — it's minted fresh for every connection and lives only in memory on
both sides.

### Troubleshooting: the Connect button does nothing

This means macOS hasn't registered the helper's `tagitphotos://` link yet —
usually because it's never been opened once by hand (step 2 above), or it was
moved/deleted after being registered. Open `dist/tagit Photos Helper.app`
directly once (double-click it in Finder), then try the button again.

If tagit says it can't connect, an old helper instance may still be running
from before — quit it (its menu bar icon, or Control-C if it's in a
terminal), rebuild with `./build-app.sh` if you changed the source, and
reconnect.

### Trying it risk-free with fake photos first

`dist/Try Demo Mode.command` runs the helper against fake, in-memory photos —
useful for seeing the whole flow work (including tagit's album picker)
without pointing it at your real library. It runs in a Terminal window and
prints a pairing code for the dialog's manual "Connect with code" path, and
never touches Photos or asks for any permission at all.

## What's not supported yet

Because the helper never rewrites the image's pixel data, two byte-level
features from the folder-based workflow aren't available for Photos library
images: **Rotate** and the **watermark**. Everything else — determination,
captions, keywords, characteristic tags, star ratings, marking as non-taxon,
delete, undo, estimated-location (PhotosKit does support writing GPS),
iNaturalist identify/create/sync (including grouping several photos into one
observation), and the already-posted-photo screener — works the same as the
folder workflow.

Status (untouched/tagged/deleted/non-taxon) has no folder to move photos
into in Photos, so it's tracked with a hidden keyword instead (e.g.
`tagit:tagged`) that's written alongside your real keywords and stripped
back out before anything is shown to you. Star ratings and characteristic
tags (Dormant, Flowering, Fruiting, Detail, Habitat), by contrast, are
normal, visible keywords — searchable in Photos itself; rating a photo 5
stars also sets Photos' native favorite.

Loading a big album is fast: the initial photo list comes from PhotosKit
alone (no AppleScript), and captions/keywords — the slow part, since they go
through Photos' scripting interface — stream in afterward in the background,
prioritized around whichever photo you're actually looking at.

## Advanced: running from source / a different port

`./build-app.sh` is the normal path. For development:

```bash
swift run PhotosHelper --demo              # fake data, safe to run yourself
swift run PhotosHelper --port 9000          # non-default port
swift run PhotosHelper --origin http://localhost:5173   # trust an extra origin
```

The default trusted origins are the published tagit site and the local dev
server tagit is normally served from during development — see
`Sources/PhotosHelper/Security.swift`.
