// =============================================================================
// app.js — tagit in the browser
//
// A zero-install, browser-only version of tagit.R. Point it at a local folder
// of JPEGs (or drag some in), pick a taxon, and it writes the caption into the
// photo's metadata and organises the file into status subfolders — all on the
// user's own machine. Nothing is uploaded.
//
// Full folder read/write needs the File System Access API (Chrome/Edge/Brave/
// Arc). In other browsers it falls back to "drag in → tag → download a copy".
// =============================================================================

(() => {
  "use strict";

  // ---- config (mirrors tagit.R) -------------------------------------------
  const CFG = {
    suggestionWindowMin: 5,
    cameraClockOffsetHours: 0,
    maxSuggestions: 10,
    maxRecent: 6,
    labelledDir: "_labelled",
    skippedDir: "_skipped",
    undeterminedDir: "_undetermined",
    deletedDir: "_deleted",
    undeterminedCaption: "Indet.",
  };
  const IMAGE_RE = /\.(jpe?g)$/i;                 // browser build handles JPEG only
  const STATUS_DIRS = {
    labelled: CFG.labelledDir, skipped: CFG.skippedDir,
    undetermined: CFG.undeterminedDir, deleted: CFG.deletedDir,
  };
  const SUBDIR_NAMES = Object.values(STATUS_DIRS);

  // ---- state ---------------------------------------------------------------
  const S = {
    mode: null,            // "fs" (File System Access), "download", or "applephotos"
    rootHandle: null,      // DirectoryHandle in fs mode
    subHandles: {},        // cached status subfolder handles
    applePhotos: { baseUrl: "http://127.0.0.1:8765", token: "", albumTitle: "" },  // local helper connection (token kept in memory only)
    photos: [],            // [{name,status,fileHandle,parentHandle,file,datetime,lat,lon,approxLat,approxLon,approxUncertaintyM,caption,orientation,url}]
    idx: 0,
    selected: [],          // chosen taxa (chips)
    cf: false,
    recent: [],
    lastCaption: "",
    undo: null,
    backbone: new Map(),   // taxon -> family (merged from active taxonomies)
    taxAttrs: new Map(),   // taxon -> { attrColumn: value }
    choices: [],           // sorted taxon names for the search box
    taxonomies: [],        // registry: [{id, name, source, file?}]
    activeTaxonomies: new Set(),   // ids of taxonomies in use (several at once)
    taxonomyCache: new Map(),      // id -> records[] {taxon, family, attrs}
    obs: [],               // [{species, datetime:Date, locality}]
    sessionFamilies: new Map(),
    statusFilter: new Set(["untouched", "preexisting", "labelled", "skipped", "undetermined", "deleted"]),
    multiSel: new Set(),   // filmstrip multi-selection (photo indices)
    selAnchor: null,       // anchor index for shift-click ranges
    metaToken: 0,          // invalidates in-flight background metadata reads on reload
    inatToken: "",         // iNaturalist API token (browser-only)
    inatResults: [],       // last CV suggestions
    inatResultsFor: null,  // photo the CV suggestions belong to
    mapVisible: false,     // map toggle (persisted)
    infoVisible: true,     // photo-info panel (map/date/time/caption/keywords) toggle
    watermark: { enabled: false, text: "", position: "br", font: "sans", sizePct: 2.8 },  // optional burned-in watermark
    perSpeciesFolders: false,  // organize _labelled into one subfolder per species (off by default)
    lastApproxLocation: null,  // {lat, lon, radiusM} last manually-picked approximate location (for reuse)
    estimateTarget: null,      // photo the estimate-location modal is currently reviewing
    estimateResult: null,      // {lat, lon, method, basis} pending confirmation
  };

  // ---- tiny DOM helpers ----------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    if (props.style) n.setAttribute("style", props.style);
    for (const k of [].concat(kids)) n.append(k);
    return n;
  };
  const toast = (msg, kind = "info", ms = 3500) => {
    const t = el("div", { className: `toast ${kind}`, textContent: msg });
    $("toasts").append(t);
    setTimeout(() => t.remove(), ms);
  };

  // ---- persistence: settings, recent, backbone/obs, folder handle ----------
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("tagit." + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("tagit." + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("tagit." + k); } catch {} },
  };
  // Session-scoped twin of LS — survives reloads, gone when the browser
  // closes. Used for the iNaturalist token when "remember" is off.
  const SS = {
    get(k, d) { try { return JSON.parse(sessionStorage.getItem("tagit." + k)) ?? d; } catch { return d; } },
    set(k, v) { try { sessionStorage.setItem("tagit." + k, JSON.stringify(v)); } catch {} },
    del(k) { try { sessionStorage.removeItem("tagit." + k); } catch {} },
  };
  // IndexedDB — only to remember the last directory handle across reloads.
  const idb = {
    db: null,
    open() {
      return new Promise((res) => {
        const r = indexedDB.open("tagit", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
      });
    },
    async put(k, v) { if (!this.db) return; const tx = this.db.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); },
    get(k) {
      return new Promise((res) => {
        if (!this.db) return res(null);
        const r = this.db.transaction("kv").objectStore("kv").get(k);
        r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
      });
    },
    del(k) { if (!this.db) return; this.db.transaction("kv", "readwrite").objectStore("kv").delete(k); },
  };

  // ---- taxonomy helpers (ported from tagit.R) ------------------------------
  const RANK_MARKERS = new Set(["subsp.", "var.", "subvar.", "f.", "ssp."]);
  function stripAuthority(name) {
    if (!name) return name;
    const tokens = name.trim().split(/\s+/);
    const keep = [];
    tokens.forEach((tok, i) => {
      const low = tok.toLowerCase();
      if (i === 0) keep.push(tok);
      else if (RANK_MARKERS.has(low)) keep.push(tok);
      else if (/\.$/.test(tok)) { /* author abbrev e.g. Hoffm. */ }
      else if (/^[A-Z(]/.test(tok)) { /* author surname or (Author) */ }
      else if (low === "&" || low === "et" || low === "ex") { /* connector */ }
      else keep.push(tok);
    });
    return keep.join(" ");
  }
  function lookupFamily(taxon) {
    if (!taxon) return "";
    if (S.backbone.has(taxon)) return S.backbone.get(taxon);
    const lower = taxon.toLowerCase();
    for (const [k, v] of S.backbone) if (k.toLowerCase() === lower) return v;
    return "";
  }
  function familyFor(taxon) {
    const f = lookupFamily(taxon);
    return f || S.sessionFamilies.get(taxon) || "";
  }
  function applyCf(taxon) {
    const parts = taxon.split(" ");
    return parts.length >= 2
      ? `${parts[0]} cf. ${parts.slice(1).join(" ")}`
      : `cf. ${taxon}`;
  }
  function composeCaption(taxon, family) {
    if (!taxon) return "";
    return family ? `${taxon} (${family})` : taxon;
  }
  function composeForTaxa(taxa) {
    return taxa.map((t) => {
      let fam = familyFor(t);
      if (!fam && taxa.length === 1) {
        const boxed = $("familyBox") && $("familyBox").value.trim();
        if (boxed) fam = boxed;
      }
      const name = S.cf ? applyCf(t) : t;
      return composeCaption(name, fam);
    }).filter(Boolean).join(", ");
  }
  function attrsOf(taxon) { return S.taxAttrs.get(taxon) || {}; }

  // Build the keyword set for a set of taxa: genus, full name (species), family
  // and any taxonomy attributes (e.g. "invasive"), all deduplicated. The caption
  // itself never carries attributes — only these keywords do.
  const BOOL_TRUE = /^(yes|true|1|x|y|ja|wahr|si|oui)$/i;
  function autoKeywords(taxa) {
    const kws = [];
    const push = (s) => {
      s = (s || "").toString().trim();
      if (s && !kws.some((k) => k.toLowerCase() === s.toLowerCase())) kws.push(s);
    };
    for (const t of taxa) {
      if (!t) continue;
      const clean = t.replace(/\s+cf\.\s+/i, " ").trim();     // keywords ignore the cf. marker
      push(clean.split(/\s+/)[0]);                            // genus
      push(clean);                                            // full name (species)
      let fam = familyFor(t);
      if (!fam && $("familyBox")) fam = $("familyBox").value.trim();
      if (fam) push(fam);                                     // family
      const attrs = attrsOf(t);
      for (const [col, val] of Object.entries(attrs)) push(BOOL_TRUE.test(val) ? col : val);
    }
    return kws;
  }
  function parseManualKeywords(str) {
    return (str || "").split(/[;,\n]/).map((s) => s.trim()).filter(Boolean);
  }
  function keywordsForSave(taxa) {
    const kws = autoKeywords(taxa);
    for (const m of parseManualKeywords($("keywordsBox") && $("keywordsBox").value)) {
      if (!kws.some((k) => k.toLowerCase() === m.toLowerCase())) kws.push(m);
    }
    return kws;
  }
  // Extra keywords on a photo that aren't derivable from its taxa (the manual ones).
  function manualKeywordsFromPhoto(p) {
    if (!p || !p.keywords || !p.keywords.length) return [];
    const auto = new Set(autoKeywords(taxaFromCaption(p.caption)).map((k) => k.toLowerCase()));
    return p.keywords.filter((k) => !auto.has(k.toLowerCase()));
  }
  // Same auto+manual merge doSave() uses, just sourcing "manual" from the
  // photo's own existing keywords instead of the (single, currently-focused)
  // keywords box — needed for a bulk pass across many photos at once.
  function recomputedKeywordsFor(p, taxa) {
    const kws = autoKeywords(taxa);
    for (const m of manualKeywordsFromPhoto(p)) {
      if (!kws.some((k) => k.toLowerCase() === m.toLowerCase())) kws.push(m);
    }
    return kws;
  }
  // Setup & tools: "Refresh keywords for already-captioned photos" — re-derive
  // genus/species/family/attribute keywords from the current taxonomy for
  // every photo that already has a real caption (skips "Indet." — there's no
  // taxon to derive anything from), previewing the change count before
  // writing anything.
  async function refreshAllKeywords() {
    const candidates = S.photos.filter((p) => p.caption && p.caption !== CFG.undeterminedCaption);
    if (!candidates.length) { toast("No captioned photos here to check.", "info", 4500); return; }
    const updates = [];
    for (const p of candidates) {
      const taxa = taxaFromCaption(p.caption);
      if (!taxa.length) continue;
      const next = recomputedKeywordsFor(p, taxa);
      const norm = (arr) => arr.map((k) => k.toLowerCase()).sort().join("|");
      if (norm(p.keywords || []) !== norm(next)) updates.push({ p, next });
    }
    if (!updates.length) { toast(`Checked ${candidates.length} captioned photo(s) — keywords are already up to date.`, "info", 6000); return; }
    const preview = updates.slice(0, 8).map((u) => `• ${u.p.name}`).join("\n");
    const more = updates.length > 8 ? `\n…and ${updates.length - 8} more` : "";
    if (!confirm(`Update keywords on ${updates.length} of ${candidates.length} captioned photo(s), based on the current taxonomy?\n${preview}${more}`)) return;
    setBusy("Updating keywords…");
    let n = 0;
    try {
      for (const { p, next } of updates) {
        try {
          await writeCaptionKeywords(p, p.caption, next, p.inatUrl);
          p.keywords = next; p.url = null;
          n++;
        } catch (e) { console.warn("keyword refresh failed for", p.name, e); }
      }
      render();
      toast(`Updated keywords on ${n} of ${updates.length} photo(s).`, "info", 6000);
    } finally { setBusy(null); }
  }
  function taxaFromCaption(caption) {
    if (!caption) return [];
    return caption.split(",").map((p) =>
      p.trim().replace(/\s*\(.*\)$/, "").replace(/ cf\./g, "").trim()
    ).filter(Boolean);
  }
  // Lets "dro rot" find "Drosera rotundifolia" and "dact fuch" find
  // "Dactylorhiza maculata subsp. fuchsii" — each typed word just needs to
  // prefix some word of the candidate, in order (not necessarily adjacent),
  // so abbreviating genus + species (skipping any subsp./var. in between)
  // works without needing the exact substring.
  function matchesAbbrev(candidateLower, queryWords) {
    const cWords = candidateLower.split(/\s+/);
    let ci = 0;
    for (const qw of queryWords) {
      let found = false;
      while (ci < cWords.length) {
        ci++;
        if (cWords[ci - 1].startsWith(qw)) { found = true; break; }
      }
      if (!found) return false;
    }
    return true;
  }

  // ---- CSV / observation parsing ------------------------------------------
  function decodeText(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
    return new TextDecoder("utf-8").decode(buf);
  }
  // Minimal delimited parser handling quoted fields; delimiter auto-detected.
  function parseDelimited(text) {
    text = text.replace(/^﻿/, "");
    const firstLine = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
    const delim = (firstLine.split("\t").length > firstLine.split(",").length) ? "\t" : ",";
    const rows = [];
    let field = "", row = [], inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return { header: [], rows: [] };
    const header = rows[0].map((h) => h.trim());
    const objs = rows.slice(1).filter((r) => r.length && r.some((x) => x !== "")).map((r) => {
      const o = {};
      header.forEach((h, i) => (o[h] = r[i] !== undefined ? r[i] : ""));
      return o;
    });
    return { header, rows: objs };
  }
  // Parse a taxonomy file buffer into { header, rows } — supports CSV/TSV and
  // Excel (.xlsx/.xls) via the vendored SheetJS build.
  function parseSpreadsheetBuffer(buf, name) {
    if (/\.xlsx?$/i.test(name) && typeof XLSX !== "undefined") {
      const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) return { header: [], rows: [] };
      const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
      if (!grid.length) return { header: [], rows: [] };
      const header = grid[0].map((h) => String(h == null ? "" : h).trim());
      const rows = grid.slice(1)
        .filter((r) => r.some((c) => String(c == null ? "" : c).trim() !== ""))
        .map((r) => { const o = {}; header.forEach((h, i) => (o[h] = r[i] == null ? "" : String(r[i]))); return o; });
      return { header, rows };
    }
    return parseDelimited(decodeText(buf));
  }
  function pick(obj, names) {
    for (const n of names) {
      const key = Object.keys(obj).find((k) => k.toLowerCase() === n.toLowerCase());
      if (key && obj[key] != null && obj[key] !== "") return obj[key];
    }
    return "";
  }

  function loadObservations(rows) {
    S.obs = [];
    for (const r of rows) {
      const sp = stripAuthority((pick(r, ["taxon_orig", "species", "taxon", "scientificName"]) || "").trim());
      const dstr = pick(r, ["date_start", "datetime", "date", "observed_on", "eventDate"]);
      const dt = dstr ? new Date(dstr.replace(" ", "T")) : null;
      const locality = pick(r, ["locality_descript", "locality", "place"]);
      if (sp && dt && !isNaN(dt.getTime())) S.obs.push({ species: sp, datetime: dt, locality });
    }
    rebuildChoices();
    LS.set("obs", S.obs.map((o) => ({ ...o, datetime: o.datetime.toISOString() })));
    $("obsStatus").textContent = `${S.obs.length} observations loaded`;
  }
  function rebuildChoices() {
    const set = new Set(S.backbone.keys());
    for (const o of S.obs) set.add(o.species);
    S.choices = [...set].sort((a, b) => a.localeCompare(b));
  }

  // ---- taxonomy registry: bundled files + user uploads ---------------------
  // Turn a filename into a readable label:
  //   taxonomy_Plants_InfoFlora_Checklist_2017.csv -> "Plants - InfoFlora Checklist 2017"
  function taxonomyDisplayName(filename) {
    let base = filename.replace(/\.[^.]+$/, "").replace(/^taxonomy[_-]/i, "");
    const parts = base.split(/_+/).filter(Boolean);
    if (parts.length <= 1) return parts.join(" ") || filename;
    return parts[0] + " - " + parts.slice(1).join(" ");
  }
  // Find bundled taxonomies: the directory autoindex works when served locally
  // (python http.server); a manifest (index.json) is the fallback for GitHub Pages.
  async function discoverBundled() {
    const fromAutoindex = async () => {
      try {
        const res = await fetch("taxonomies/", { cache: "no-store" });
        if (!res.ok) return [];
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        return [...doc.querySelectorAll("a[href]")]
          .map((a) => a.getAttribute("href")).filter((h) => /\.(csv|tsv|xlsx?)$/i.test(h))
          .map((h) => decodeURIComponent(h.split("/").pop()))
          .filter((n) => !/^(~\$|\.)/.test(n));                // skip Excel lock + hidden files
      } catch { return []; }
    };
    const fromManifest = async () => {
      try {
        const res = await fetch("taxonomies/index.json", { cache: "no-store" });
        if (!res.ok) return [];
        const j = await res.json();
        return Array.isArray(j) ? j.map((x) => (typeof x === "string" ? x : x.file)).filter(Boolean) : [];
      } catch { return []; }
    };
    let files = await fromAutoindex();
    if (!files.length) files = await fromManifest();
    return [...new Set(files)];
  }

  async function buildTaxonomyRegistry() {
    S.taxonomies = [];
    for (const file of await discoverBundled())
      S.taxonomies.push({ id: "bundled:" + file, name: taxonomyDisplayName(file), source: "bundled", file });
    for (const u of LS.get("userTaxonomies", []))
      S.taxonomies.push({ id: u.id, name: u.name, source: "user" });
    renderTaxonomyList();
  }
  // Checkbox list — several taxonomies can be active at once.
  function renderTaxonomyList() {
    const box = $("taxonomyList");
    if (!box) return;
    box.innerHTML = "";
    if (!S.taxonomies.length) {
      box.append(el("p", { className: "hint", textContent: "None available yet — upload one below, or add files to the taxonomies/ folder." }));
      return;
    }
    const group = (label, src) => {
      const items = S.taxonomies.filter((t) => t.source === src);
      if (!items.length) return;
      box.append(el("div", { className: "tx-group", textContent: label }));
      items.forEach((t) => {
        const row = el("label", { className: "tx-row" });
        const cb = el("input", { type: "checkbox" });
        cb.checked = S.activeTaxonomies.has(t.id);
        cb.addEventListener("change", () => toggleTaxonomy(t.id, cb.checked));
        row.append(cb, el("span", { className: "tx-name", textContent: t.name }));
        if (src === "user") {
          const del = el("button", { className: "tx-del", textContent: "×", title: "Remove this uploaded taxonomy" });
          del.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); removeUserTaxonomy(t.id); });
          row.append(del);
        }
        box.append(row);
      });
    };
    group("Bundled", "bundled");
    group("Your uploads", "user");
  }

  function detectCol(rowObj, names) {
    for (const n of names) { const k = Object.keys(rowObj).find((x) => x.toLowerCase() === n.toLowerCase()); if (k) return k; }
    return "";
  }
  // Parse rows into records {taxon, family, attrs}. Every column that isn't the
  // taxon or family becomes an attribute (e.g. "invasive", "status", …).
  function rowsToRecords(rows, taxonCol, familyCol) {
    const out = [];
    if (!rows.length) return out;
    const tc = taxonCol || detectCol(rows[0], ["taxon", "species", "Taxonname", "scientificName", "tnrs_species"]);
    const fc = familyCol || detectCol(rows[0], ["family", "Familie"]);
    for (const r of rows) {
      const t = stripAuthority(((tc ? r[tc] : "") || "").trim());
      if (!t) continue;
      const f = ((fc ? r[fc] : "") || "").trim();
      const attrs = {};
      for (const [k, v] of Object.entries(r)) {
        if (k === tc || k === fc) continue;
        const val = (v == null ? "" : String(v)).trim();
        if (val) attrs[k] = val;
      }
      out.push({ taxon: t, family: f, attrs });
    }
    return out;
  }

  async function loadTaxonomyRecords(id) {
    if (S.taxonomyCache.has(id)) return S.taxonomyCache.get(id);
    const entry = S.taxonomies.find((t) => t.id === id);
    let records = [];
    try {
      if (entry && entry.source === "bundled") {
        const res = await fetch("taxonomies/" + entry.file, { cache: "no-store" });
        if (res.ok) records = rowsToRecords(parseSpreadsheetBuffer(await res.arrayBuffer(), entry.file).rows, entry.taxonCol, entry.familyCol);
      } else if (entry) {
        const rec = await idb.get("tax:" + id);
        if (rec) records = rec.records || (rec.pairs || []).map(([taxon, family]) => ({ taxon, family, attrs: {} }));
      }
    } catch (e) { console.error("taxonomy load failed", id, e); }
    S.taxonomyCache.set(id, records);
    return records;
  }

  function mergeRecord(rec) {
    if (!rec || !rec.taxon) return;
    if (!S.backbone.has(rec.taxon)) S.backbone.set(rec.taxon, rec.family || "");
    else if (!S.backbone.get(rec.taxon) && rec.family) S.backbone.set(rec.taxon, rec.family);
    const cur = S.taxAttrs.get(rec.taxon) || {};
    if (rec.attrs) for (const [k, v] of Object.entries(rec.attrs)) if (v && !cur[k]) cur[k] = v;
    S.taxAttrs.set(rec.taxon, cur);
  }
  // Rebuild the merged taxon table from all active taxonomies + saved additions.
  async function rebuildTaxa() {
    S.backbone = new Map();
    S.taxAttrs = new Map();
    for (const id of S.activeTaxonomies) {
      const records = await loadTaxonomyRecords(id);
      for (const rec of records) mergeRecord(rec);
    }
    for (const rec of (await idb.get("taxadd:global")) || []) mergeRecord(rec);
    rebuildChoices();
    updateTaxonomyStatus();
  }
  function updateTaxonomyStatus() {
    if (!$("taxonomyStatus")) return;
    const n = S.activeTaxonomies.size;
    $("taxonomyStatus").textContent = S.backbone.size ? `${S.backbone.size} taxa · ${n} active` : "";
  }
  async function toggleTaxonomy(id, on) {
    if (on) S.activeTaxonomies.add(id); else S.activeTaxonomies.delete(id);
    LS.set("activeTaxonomies", [...S.activeTaxonomies]);
    setBusy("Loading taxonomies…");
    try { await rebuildTaxa(); } finally { setBusy(null); }
  }
  function removeUserTaxonomy(id) {
    S.activeTaxonomies.delete(id);
    S.taxonomyCache.delete(id);
    LS.set("userTaxonomies", LS.get("userTaxonomies", []).filter((u) => u.id !== id));
    LS.set("activeTaxonomies", [...S.activeTaxonomies]);
    idb.del("tax:" + id);
    buildTaxonomyRegistry();
    rebuildTaxa();
    toast("Removed taxonomy.", "info");
  }
  // Add a newly determined taxon+family to a global additions overlay + the live table.
  function growTaxonomy(taxon, family) {
    if (!taxon || !family || S.backbone.get(taxon)) return;   // skip if already known with a family
    S.backbone.set(taxon, family);
    if (!S.taxAttrs.has(taxon)) S.taxAttrs.set(taxon, {});
    if (!S.choices.includes(taxon)) { S.choices.push(taxon); S.choices.sort((a, b) => a.localeCompare(b)); }
    updateTaxonomyStatus();
    idb.get("taxadd:global").then((list) => {
      list = list || [];
      if (!list.some((r) => r.taxon === taxon)) { list.push({ taxon, family, attrs: {} }); idb.put("taxadd:global", list); }
    });
  }

  // ---- taxonomy upload with column mapping ---------------------------------
  let pendingUpload = null;                                 // { rows, header, filename }
  const guessCol = (header, regexes) => header.find((h) => regexes.some((re) => re.test(h))) || header[0] || "";
  function beginTaxonomyUpload(file, buf) {
    let parsed;
    try { parsed = parseSpreadsheetBuffer(buf, file.name); }
    catch (e) { console.error(e); toast("Couldn't read that file: " + (e.message || e), "warn", 7000); return; }
    const { header, rows } = parsed;
    if (!header.length) { toast("That file has no readable columns.", "warn"); return; }
    pendingUpload = { rows, header, filename: file.name };
    $("taxNameInput").value = taxonomyDisplayName(file.name);
    const fill = (sel, guess) => {
      sel.innerHTML = "";
      header.forEach((h) => sel.append(el("option", { value: h, textContent: h })));
      if (guess) sel.value = guess;
    };
    const taxonGuess = guessCol(header, [/^taxon\b/i, /^taxon/i, /species/i, /scientific/i, /binomial/i, /name/i]);
    const rest = header.filter((h) => h !== taxonGuess);
    const famGuess = guessCol(rest, [/fam/i]) || rest[0] || taxonGuess;
    fill($("taxColSelect"), taxonGuess);
    fill($("famColSelect"), famGuess);
    $("taxonomyMapper").hidden = false;
  }
  async function commitTaxonomyUpload() {
    if (!pendingUpload) return;
    const name = $("taxNameInput").value.trim() || taxonomyDisplayName(pendingUpload.filename);
    const records = rowsToRecords(pendingUpload.rows, $("taxColSelect").value, $("famColSelect").value);
    if (!records.length) { toast("No taxa found with those columns — check your selection.", "warn", 6000); return; }
    const id = "user:" + Date.now();
    await idb.put("tax:" + id, { id, name, source: "user", records });
    const list = LS.get("userTaxonomies", []); list.push({ id, name }); LS.set("userTaxonomies", list);
    S.taxonomyCache.set(id, records);
    S.activeTaxonomies.add(id); LS.set("activeTaxonomies", [...S.activeTaxonomies]);
    pendingUpload = null;
    $("taxonomyMapper").hidden = true; $("taxonomyFile").value = "";
    await buildTaxonomyRegistry();
    await rebuildTaxa();
    renderTaxonomyList();
    toast(`Added taxonomy “${name}” (${records.length} taxa) and enabled it.`, "info");
  }
  function cancelTaxonomyUpload() {
    pendingUpload = null; $("taxonomyMapper").hidden = true; $("taxonomyFile").value = "";
  }

  // ---- suggestions ---------------------------------------------------------
  function suggestSpecies(photoTime) {
    if (!photoTime || !S.obs.length) return [];
    const w = CFG.suggestionWindowMin;
    return [...new Set(
      S.obs
        .map((o) => ({ sp: o.species, gap: Math.abs((o.datetime - photoTime) / 60000) }))
        .filter((x) => x.gap <= w)
        .sort((a, b) => a.gap - b.gap)
        .map((x) => x.sp)
    )].slice(0, CFG.maxSuggestions);
  }
  function suggestLocality(photoTime) {
    if (!photoTime || !S.obs.length) return "";
    const w = CFG.suggestionWindowMin;
    const hit = S.obs
      .filter((o) => o.locality && Math.abs((o.datetime - photoTime) / 60000) <= w)
      .sort((a, b) => Math.abs(a.datetime - photoTime) - Math.abs(b.datetime - photoTime))[0];
    return hit ? hit.locality : "";
  }

  // ---- iNaturalist computer-vision suggestions -----------------------------
  function isoDate(d) {
    if (!d) return "";
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }
  // The CV model wants a 299x299 JPEG with the aspect ratio squashed to fill it.
  async function squashTo299(file) {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas"); c.width = 299; c.height = 299;
    c.getContext("2d").drawImage(bmp, 0, 0, 299, 299);   // exact size = squashed, as iNat expects
    if (bmp.close) bmp.close();
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  }
  async function inatIdentify() {
    const p = current();
    if (!p) return;
    const token = requireInatToken();
    if (!token) return;
    setBusy("Asking iNaturalist…");
    try {
      const img = await squashTo299(await getFile(p));
      const fd = new FormData();
      fd.append("image", img, "photo.jpg");
      if (p.lat != null && p.lon != null) { fd.append("lat", p.lat); fd.append("lng", p.lon); }
      else if (p.approxLat != null && p.approxLon != null) { fd.append("lat", p.approxLat); fd.append("lng", p.approxLon); }
      if (p.datetime) fd.append("observed_on", isoDate(p.datetime));
      const res = await fetch("https://api.inaturalist.org/v1/computervision/score_image", {
        method: "POST", headers: { Authorization: "Bearer " + token }, body: fd,
      });
      if (res.status === 401) throw new Error("token invalid or expired — get a fresh one");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const sugg = (data.results || [])
        .map((r) => ({
          name: r.taxon && r.taxon.name,
          score: r.combined_score != null ? r.combined_score : r.vision_score,
        }))
        .filter((s) => s.name).slice(0, 8);
      S.inatResults = sugg;
      S.inatResultsFor = p;
      renderInat();
      if (!sugg.length) toast("iNaturalist returned no suggestions for this photo.", "info");
    } catch (e) {
      console.error(e);
      toast("iNaturalist request failed: " + (e.message || e) + ".", "warn", 9000);
    } finally { setBusy(null); }
  }
  function renderInat() {
    const box = $("inatResults"); if (!box) return;
    box.innerHTML = "";
    const sugg = (S.inatResultsFor === current()) ? S.inatResults : [];
    if (!sugg.length) return;
    sugg.forEach((s) => box.append(el("button", {
      className: "chip-btn", title: "Add to determination",
      onclick: () => {
        addTaxon(s.name);
        updateCaptionBox();   // refresh the caption box even if this taxon was already selected
        if (!S.choices.includes(s.name)) { S.choices.push(s.name); S.choices.sort((a, b) => a.localeCompare(b)); }
      },
    }, [
      el("span", { className: "chip-name", textContent: s.name }),
      ...(s.score != null ? [el("span", { className: "chip-score", textContent: Math.round(s.score) + "%" })] : []),
    ])));
  }
  // The photo being identified, shown zoomable inside the iNaturalist tab
  // itself (the modal backdrop otherwise hides the main stage entirely, so
  // there was no way to actually look at the photo while picking a suggestion).
  async function renderInatPhotoStage() {
    const modal = $("inatModal");
    const img = $("inatPhotoImg"), meta = $("inatPhotoMeta");
    if (!modal || modal.hidden || !img || !meta) return;
    const p = current();
    if (!p) { img.src = ""; meta.innerHTML = ""; meta.hidden = true; resetInatZoom(); return; }
    resetInatZoom();
    try {
      if (!p.url) p.url = URL.createObjectURL(await getFile(p));
      img.src = p.url;
    } catch (e) { console.warn("preview failed", e); img.src = ""; }
    meta.innerHTML = "";
    meta.append(el("div", { className: "meta-filename", textContent: p.name }));
    if (p.datetime) {
      meta.append(el("div", { textContent: "Date: " + fmtDay(p.datetime) }));
      meta.append(el("div", { textContent: "Time: " + fmtTime(p.datetime) }));
    } else meta.append(el("div", { textContent: "Date taken: unknown" }));
    meta.append(captionRow(p));
    if (p.keywords && p.keywords.length) {
      meta.append(el("div", { className: "meta-overlay-kw", textContent: p.keywords.join(" · ") }));
    }
    meta.hidden = !S.infoVisible;
  }
  function updateInatStatus(state) {
    const has = !!(S.inatToken && S.inatToken.trim());
    const tag = $("inatStatus"); const hint = $("inatHint");
    if (hint) hint.textContent = has ? "" : "Paste your token below to enable AI identification.";
    if (!tag) return;
    if (state) tag.textContent = state;                    // e.g. "✓ marco" / "check failed"
    else tag.textContent = has ? "token set — press Check" : "";
  }
  // Verify the token by calling an endpoint that requires authentication, and
  // report who it belongs to (mirrors the desktop app's "signed in as").
  async function inatVerify() {
    const token = (S.inatToken || "").trim();
    if (!token) { toast("Paste your iNaturalist token first.", "warn"); return; }
    setBusy("Checking token…");
    try {
      const res = await fetch("https://api.inaturalist.org/v1/users/me", {
        headers: { Authorization: "Bearer " + token },
      });
      if (res.status === 401) throw new Error("token invalid or expired");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const login = data.results && data.results[0] && data.results[0].login;
      updateInatStatus(login ? "✓ signed in as " + login : "✓ token valid");
      toast(login ? "iNaturalist token works — signed in as " + login + "." : "iNaturalist token is valid.", "info");
    } catch (e) {
      console.error(e);
      updateInatStatus("✗ check failed");
      toast("Token check failed: " + (e.message || e) + ".", "warn", 8000);
    } finally { setBusy(null); }
  }

  // ---- iNaturalist: create an observation and link it to the photo ---------
  const inatIdFromUrl = (url) => { const m = (url || "").match(/observations\/(\d+)/); return m ? m[1] : ""; };
  // The observation link is rendered as a clickable href, but it can arrive
  // from untrusted places — the XMP metadata of a dragged-in JPEG, or an API
  // response. Never trust it as-is: rebuild it from the numeric id or drop
  // it, so a crafted file can't smuggle a javascript: URL into the page.
  const sanitizeInatUrl = (url) => {
    const id = inatIdFromUrl(url);
    return id ? `https://www.inaturalist.org/observations/${id}` : "";
  };
  async function resizeJpeg(file, maxDim) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  }
  async function rewritePhotoBytes(p, bytes) {
    if (S.mode === "download") downloadBytes(p.name, bytes);
    else { p.fileHandle = await writeBytesTo(p.parentHandle, p.name, bytes); p.url = null; }
  }

  async function inatCreateObservation() {
    const p = current(); if (!p) return;
    const token = requireInatToken();
    if (!token) return;
    const taxa = S.selected.length ? S.selected : taxaFromCaption(p.caption);
    const name = (taxa[0] || "").trim();
    if (!name) { toast("Pick a taxon for this photo first.", "warn"); return; }
    if (p.inatUrl && !confirm("This photo is already linked to an observation. Create another?")) return;
    const geoLabel = { open: "public", obscured: "obscured", private: "private" }[($("inatGeo") && $("inatGeo").value) || "open"];
    const hasRealGps = p.lat != null && p.lon != null;
    const geoNote = hasRealGps ? `Coordinates will be ${geoLabel}.`
      : (p.approxLat != null ? `No GPS on this photo — using your approximate location (±${fmtRadius(p.approxUncertaintyM)}, ${geoLabel}).`
      : "No location will be attached (no GPS, and no approximate location picked).");
    if (!confirm(`Post an iNaturalist observation for “${name}”?\n${geoNote}\nThis posts to your public iNaturalist account.`)) return;
    setBusy("Creating iNaturalist observation…");
    try {
      let taxonId = null;
      try {
        const tr = await fetch("https://api.inaturalist.org/v1/taxa?per_page=1&q=" + encodeURIComponent(name),
          { headers: { Authorization: "Bearer " + token } });
        if (tr.ok) { const tj = await tr.json(); taxonId = tj.results && tj.results[0] && tj.results[0].id; }
      } catch { /* still create as a free-text guess */ }

      const geo = ($("inatGeo") && $("inatGeo").value) || "open";
      const obs = { species_guess: name, geoprivacy: geo };
      if (p.datetime) obs.observed_on_string = fmtDate(p.datetime);
      if (taxonId) obs.taxon_id = taxonId;
      if (p.lat != null && p.lon != null) {
        obs.latitude = p.lat; obs.longitude = p.lon;
      } else if (p.approxLat != null && p.approxLon != null) {
        // A manually-picked approximate point, not the photo's real GPS —
        // positional_accuracy tells iNaturalist to show it as an uncertainty
        // circle rather than a misleadingly precise pin.
        obs.latitude = p.approxLat; obs.longitude = p.approxLon;
        obs.positional_accuracy = p.approxUncertaintyM;
      }

      const cr = await fetch("https://api.inaturalist.org/v1/observations", {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ observation: obs }),
      });
      if (cr.status === 401) throw new Error("token invalid or expired");
      if (!cr.ok) throw new Error("could not create the observation (HTTP " + cr.status + ")");
      const cj = await cr.json();
      const obsId = cj.id || (cj.results && cj.results[0] && cj.results[0].id);
      if (!obsId) throw new Error("observation created but no id returned");
      const url = "https://www.inaturalist.org/observations/" + obsId;

      try {
        const img = await resizeJpeg(await getFile(p), 2048);
        const fd = new FormData();
        fd.append("observation_photo[observation_id]", String(obsId));
        fd.append("file", img, "photo.jpg");
        await fetch("https://api.inaturalist.org/v1/observation_photos",
          { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
      } catch (e) { console.warn("photo upload to iNaturalist failed", e); }

      // Use the taxa just posted (not p.caption) — if the photo hasn't been
      // saved yet in this session, p.caption is still empty and would silently
      // wipe the caption while still creating a real iNaturalist observation.
      const caption = composeForTaxa(taxa) || p.caption || "";
      const keywords = keywordsForSave(taxa);
      await writeCaptionKeywords(p, caption, keywords, url);
      p.inatUrl = url;                                       // link it into the photo's metadata
      p.caption = caption; p.keywords = keywords;
      render();
      showInatCelebration(url);
    } catch (e) {
      console.error(e); toast("iNaturalist observation failed: " + (e.message || e) + ".", "warn", 9000);
    } finally { setBusy(null); }
  }

  // A small moment of celebration when an observation goes live — posting to
  // iNaturalist is the payoff of the whole workflow, not just another save.
  let inatCelebrateTimer = null;
  function showInatCelebration(url) {
    const box = $("inatCelebrate");
    if (!box) { toast("Observation created and linked to the photo.", "info", 6000); return; }
    $("inatCelebrateLink").href = url;
    box.hidden = false;
    clearTimeout(inatCelebrateTimer);
    inatCelebrateTimer = setTimeout(() => { box.hidden = true; }, 6000);
  }

  // Check every linked photo: if its observation is research grade with a
  // consensus taxon that differs from the caption, update the caption + keywords.
  async function inatSyncObservations() {
    const token = (S.inatToken || "").trim();
    const linked = S.photos.filter((p) => inatIdFromUrl(p.inatUrl));
    if (!linked.length) { toast("No photos here are linked to an iNaturalist observation yet.", "info", 5000); return; }
    setBusy("Checking iNaturalist…");
    try {
      const ids = [...new Set(linked.map((p) => inatIdFromUrl(p.inatUrl)))];
      const statusById = {};
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const r = await fetch("https://api.inaturalist.org/v1/observations?per_page=200&id=" + chunk.join(","),
          token ? { headers: { Authorization: "Bearer " + token } } : undefined);
        if (!r.ok) continue;
        const j = await r.json();
        for (const o of (j.results || [])) statusById[String(o.id)] = { grade: o.quality_grade, taxon: o.taxon && o.taxon.name };
      }
      const updates = [];
      for (const p of linked) {
        const st = statusById[inatIdFromUrl(p.inatUrl)];
        if (!st || st.grade !== "research" || !st.taxon) continue;
        if ((p.caption || "").toLowerCase().includes(st.taxon.toLowerCase())) continue;
        updates.push({ p, taxon: st.taxon });
      }
      if (!updates.length) { toast(`Checked ${ids.length} observation(s) — no captions need updating.`, "info", 6000); return; }
      const list = updates.slice(0, 6).map((u) => `• ${u.p.name}: ${u.taxon}`).join("\n");
      if (!confirm(`${updates.length} research-grade observation(s) differ from your caption:\n${list}\n\nUpdate the photo captions to iNaturalist's ID?`)) return;
      let n = 0;
      for (const { p, taxon } of updates) {
        const caption = composeCaption(taxon, familyFor(taxon));
        const keywords = autoKeywords([taxon]);
        await writeCaptionKeywords(p, caption, keywords, p.inatUrl);
        p.caption = caption; p.keywords = keywords;
        n++;
      }
      render();
      toast(`Updated ${n} caption(s) from iNaturalist.`, "info", 6000);
    } catch (e) {
      console.error(e); toast("iNaturalist sync failed: " + (e.message || e) + ".", "warn", 9000);
    } finally { setBusy(null); }
  }

  // If no token is set, complain and open the iNaturalist tab to the token
  // field instead of failing silently — shared by every iNaturalist entry point.
  function requireInatToken() {
    const token = (S.inatToken || "").trim();
    if (token) return token;
    toast("Add your iNaturalist token first.", "warn", 6000);
    openModal("inatModal");
    setTimeout(() => { $("inatToken") && $("inatToken").focus(); }, 50);
    return null;
  }

  // ---- iNaturalist: screen an old collection for photos you already posted -
  // Two-stage match: (1) same date/time within a window, (2) perceptual-hash
  // image similarity for anything that passes stage 1. You confirm each match
  // side-by-side; confirming adopts the iNat ID as the caption/keywords and
  // links the observation, so an already-identified old photo doesn't need to
  // be tagged again by hand.

  // Difference hash (dHash) — robust to resizing/recompression (exactly what
  // happens when iNat re-encodes an upload), cheap to compute with Canvas
  // alone. Returns a 72-bit vector as a BigInt.
  async function pHashFromBlob(blob) {
    const SIZE = 9; // 9x8 grid of comparisons -> 72 bits
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas"); c.width = SIZE; c.height = SIZE - 1;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0, SIZE, SIZE - 1);
    if (bmp.close) bmp.close();
    const { data } = ctx.getImageData(0, 0, SIZE, SIZE - 1);
    const gray = [];
    for (let i = 0; i < data.length; i += 4) gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    let hash = 0n, bit = 0n;
    for (let y = 0; y < SIZE - 1; y++) {
      for (let x = 0; x < SIZE - 1; x++) {
        const idx = y * SIZE + x;
        if (gray[idx] > gray[idx + 1]) hash |= 1n << bit;
        bit++;
      }
    }
    return hash;
  }
  function hammingDistance(a, b) {
    let x = a ^ b, count = 0;
    while (x) { count += Number(x & 1n); x >>= 1n; }
    return count;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function inatObsSummary(o) {
    let dt = null;
    if (o.time_observed_at) dt = new Date(o.time_observed_at);
    else if (o.observed_on_string) dt = new Date(o.observed_on_string.replace(" ", "T"));
    else if (o.observed_on) dt = new Date(o.observed_on);
    if (dt && isNaN(dt.getTime())) dt = null;
    const taxonName = (o.taxon && o.taxon.name) || o.species_guess || "";
    const photo = o.photos && o.photos[0];
    let photoUrl = photo && (photo.url || "");
    if (photoUrl) photoUrl = photoUrl.replace(/square/, "medium");
    return {
      // Always rebuild the link from the numeric id — never pass an API-supplied
      // URL through to an href (see sanitizeInatUrl).
      id: o.id, uri: "https://www.inaturalist.org/observations/" + o.id,
      datetime: dt, taxonName, photoUrl, qualityGrade: o.quality_grade || "",
    };
  }
  // Paginated fetch of the account's observations in a date range. Capped at
  // 5 pages (1000 observations) and lightly throttled to stay polite to the API.
  async function fetchInatObservationsInRange(token, userId, d1, d2) {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const url = `https://api.inaturalist.org/v1/observations?user_id=${userId}&d1=${d1}&d2=${d2}&per_page=200&page=${page}&order=asc&order_by=observed_on`;
      const res = await fetch(url, { headers: token ? { Authorization: "Bearer " + token } : {} });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      out.push(...(json.results || []));
      if (out.length >= (json.total_results || 0) || (json.results || []).length === 0) break;
      await sleep(250);
    }
    return out;
  }

  // Stage 1 (date/time) + stage 2 (image similarity), building a review queue.
  async function inatScreenCollection(windowMinutes) {
    const token = requireInatToken();
    if (!token) return;

    setBusy("Checking your iNaturalist account…");
    let who;
    try {
      const res = await fetch("https://api.inaturalist.org/v1/users/me", { headers: { Authorization: "Bearer " + token } });
      if (!res.ok) throw new Error("token invalid or expired");
      const data = await res.json();
      who = data.results && data.results[0];
    } catch (e) { setBusy(null); toast("Couldn’t verify your token: " + (e.message || e), "warn", 8000); return; }
    if (!who) { setBusy(null); toast("Couldn’t identify your iNaturalist account.", "warn"); return; }

    // Every photo with a date is a candidate, regardless of status — not just
    // untouched ones. Someone may have already hand-labelled, skipped or even
    // deleted a photo before finding this screening tool, and still wants it
    // checked and linked against their iNaturalist account.
    const candidates = S.photos.filter((p) => p.datetime);
    if (!candidates.length) { setBusy(null); toast("No dated photos to screen (still-loading dates are skipped — try again in a moment).", "info", 7000); return; }

    const times = candidates.map((p) => p.datetime.getTime());
    const pad = 24 * 3600 * 1000;
    const d1 = new Date(Math.min(...times) - pad).toISOString().slice(0, 10);
    const d2 = new Date(Math.max(...times) + pad).toISOString().slice(0, 10);

    setBusy("Fetching your iNaturalist observations…");
    let obsRaw;
    try { obsRaw = await fetchInatObservationsInRange(token, who.id, d1, d2); }
    catch (e) { setBusy(null); toast("Couldn’t fetch observations: " + (e.message || e), "warn", 8000); return; }
    const obsList = obsRaw.map(inatObsSummary).filter((o) => o.datetime && o.photoUrl);
    if (!obsList.length) { setBusy(null); toast("No dated iNaturalist observations with photos found in that range.", "info", 7000); return; }

    const queue = [];
    for (const p of candidates) {
      const matches = obsList
        .map((o) => ({ o, gapMin: Math.abs(o.datetime - p.datetime) / 60000 }))
        .filter((x) => x.gapMin <= windowMinutes)
        .sort((a, b) => a.gapMin - b.gapMin);
      if (matches.length) queue.push({ photo: p, matches, candIdx: 0 });
    }
    if (!queue.length) { setBusy(null); toast(`Checked ${obsList.length} observation(s) — no time matches within ±${windowMinutes} min.`, "info", 7000); return; }

    setBusy(`Comparing photos… 0/${queue.length}`);
    let done = 0;
    for (const item of queue) {
      let localHash = null;
      try { localHash = await pHashFromBlob(await getFile(item.photo)); } catch (e) { /* leave unscored */ }
      for (const m of item.matches) {
        if (localHash == null) { m.score = null; continue; }
        try {
          const resp = await fetch(m.o.photoUrl);
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          const blob = await resp.blob();
          const remoteHash = await pHashFromBlob(blob);
          m.score = hammingDistance(localHash, remoteHash);
        } catch (e) { m.score = null; }
        await sleep(200);                                    // be polite to iNat's API/CDN
      }
      item.matches.sort((a, b) => (a.score ?? 999) - (b.score ?? 999));
      done++; setBusy(`Comparing photos… ${done}/${queue.length}`);
    }
    setBusy(null);

    S.matchQueue = queue;
    S.matchQueueIdx = 0;
    S.matchSummary = { linked: 0, skipped: 0, total: queue.length };
    openModal("inatMatchModal");
    renderMatchReview();
  }

  function scoreLabel(score) {
    if (score == null) return { cls: "unknown", text: "Similarity unknown" };
    if (score <= 8) return { cls: "high", text: "High match confidence" };
    if (score <= 16) return { cls: "medium", text: "Possible match" };
    return { cls: "low", text: "Low similarity" };
  }

  async function renderMatchReview() {
    const queue = S.matchQueue;
    if (!queue || S.matchQueueIdx >= queue.length) { finishMatchReview(); return; }
    const item = queue[S.matchQueueIdx];
    const cand = item.matches[item.candIdx];
    const p = item.photo;

    $("matchProgress").textContent =
      `Photo ${S.matchQueueIdx + 1} of ${queue.length}` +
      (item.matches.length > 1 ? ` — candidate ${item.candIdx + 1} of ${item.matches.length}` : "");

    if (!p.url) { try { p.url = URL.createObjectURL(await getFile(p)); } catch (e) { /* ignore */ } }
    $("matchLocalImg").src = p.url || "";
    $("matchLocalMeta").innerHTML = "";
    $("matchLocalMeta").append(el("div", { textContent: p.name }));
    $("matchLocalMeta").append(el("div", { textContent: p.datetime ? fmtDate(p.datetime) : "date unknown" }));

    $("matchInatImg").src = cand.o.photoUrl || "";
    $("matchInatMeta").innerHTML = "";
    $("matchInatMeta").append(el("div", { textContent: cand.o.taxonName || "(no ID yet)" }));
    $("matchInatMeta").append(el("div", { textContent: cand.o.datetime ? fmtDate(cand.o.datetime) : "date unknown" }));
    const linkDiv = el("div");
    linkDiv.append(el("a", { href: cand.o.uri, target: "_blank", rel: "noopener", textContent: "View on iNaturalist ↗" }));
    $("matchInatMeta").append(linkDiv);

    const sc = scoreLabel(cand.score);
    const badge = $("matchScoreBadge");
    badge.className = "match-score " + sc.cls;
    badge.textContent = sc.text + (cand.gapMin < 1 ? " · same minute" : ` · ${cand.gapMin.toFixed(1)} min apart`);
  }

  async function matchConfirmSame() {
    const queue = S.matchQueue;
    const item = queue[S.matchQueueIdx];
    const cand = item.matches[item.candIdx];
    const p = item.photo;
    setBusy("Linking…");
    try {
      const taxonName = cand.o.taxonName;
      const caption = taxonName ? composeCaption(taxonName, familyFor(taxonName)) : CFG.undeterminedCaption;
      const keywords = taxonName ? autoKeywords([taxonName]) : [];
      p.inatUrl = cand.o.uri;
      // No taxon on the matched observation yet ("Unknown"/unidentified) — file
      // it as undetermined rather than labelled, so the status badge matches
      // the "Indet." caption instead of implying a real determination.
      const nextStatus = taxonName ? "labelled" : "undetermined";
      if (S.mode === "applephotos") {
        await applyStatus(p, nextStatus, caption, null, taxonName ? [taxonName] : null, keywords, null);
      } else {
        const origBytes = S.mode === "fs" ? await getFileBytes(p) : null;
        const bytes = await composeSaveBytes(p, caption, keywords);
        await applyStatus(p, nextStatus, caption, bytes, taxonName ? [taxonName] : null, keywords, origBytes);
      }
      S.matchSummary.linked++;
    } catch (e) {
      console.error(e); toast("Couldn’t link this photo: " + (e.message || e), "warn", 7000);
    } finally { setBusy(null); }
    S.matchQueueIdx++;
    render();
    renderMatchReview();
  }
  function matchNotAMatch() {
    const item = S.matchQueue[S.matchQueueIdx];
    item.candIdx++;
    if (item.candIdx >= item.matches.length) S.matchQueueIdx++;
    renderMatchReview();
  }
  function matchSkipPhoto() {
    S.matchSummary.skipped++;
    S.matchQueueIdx++;
    renderMatchReview();
  }
  function finishMatchReview() {
    $("inatMatchModal").hidden = true;
    const s = S.matchSummary;
    if (s) toast(`Screening done — linked ${s.linked} of ${s.total} photo(s).`, "info", 7000);
    S.matchQueue = null; S.matchSummary = null;
  }

  // ---- map (real Leaflet maps, not an OSM iframe embed) ---------------------
  // A small always-in-place preview sits in the photo's bottom-right corner;
  // clicking it opens a larger, fully interactive view in a modal. Both use
  // the same OSM tiles the old iframe embed did, but as same-origin Leaflet
  // maps we render the location marker ourselves — any color we like, and it
  // stays correctly anchored through pan/zoom since it's real map content,
  // not a CSS dot guessing at the iframe's internal view state.
  const MARKER_STYLE = { radius: 7, color: "#fff", weight: 2, fillColor: "#e0362f", fillOpacity: 1 };
  function addTileLayer(map) {
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);
  }
  let cornerMap = null, cornerMarker = null;
  function ensureCornerMap() {
    if (cornerMap) return cornerMap;
    cornerMap = L.map("mapCornerFrame", {
      zoomControl: false, attributionControl: false, dragging: false,
      scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
      keyboard: false, touchZoom: false, tap: false, fadeAnimation: false,
    });
    addTileLayer(cornerMap);
    return cornerMap;
  }
  let largeMap = null, largeMarker = null;
  function ensureLargeMap() {
    if (largeMap) return largeMap;
    largeMap = L.map("mapFrameLarge");
    addTileLayer(largeMap);
    return largeMap;
  }
  function renderPhotoControls() {
    const p = current();
    const hasGps = p && p.lat != null && p.lon != null;
    const corner = $("mapCorner");
    if (!hasGps) { corner.hidden = true; return; }
    if (S.mapVisible) {
      corner.hidden = false;
      const map = ensureCornerMap();
      map.setView([p.lat, p.lon], 15);
      if (cornerMarker) cornerMarker.setLatLng([p.lat, p.lon]);
      else cornerMarker = L.circleMarker([p.lat, p.lon], MARKER_STYLE).addTo(map);
      // The container was just un-hidden (or created at zero size) — Leaflet
      // needs a nudge once it actually has real dimensions to lay tiles out
      // correctly.
      setTimeout(() => map.invalidateSize(), 0);
    } else {
      corner.hidden = true;
    }
  }
  // The "Show/Hide map" control lives inline with the other photo info, added
  // as a row in #meta by render() (only when the photo has GPS).
  function mapToggleRow() {
    const btn = el("button", { id: "mapToggleBtn", className: "meta-map-btn" });
    btn.textContent = S.mapVisible ? "Hide map" : "Show map ↴";
    btn.onclick = () => {
      S.mapVisible = !S.mapVisible; LS.set("mapVisible", S.mapVisible);
      btn.textContent = S.mapVisible ? "Hide map" : "Show map ↴";
      renderPhotoControls();
    };
    return btn;
  }
  function openMapModal() {
    const p = current();
    if (!p || p.lat == null || p.lon == null) return;
    openModal("mapModal");
    const map = ensureLargeMap();
    map.setView([p.lat, p.lon], 17);
    if (largeMarker) largeMarker.setLatLng([p.lat, p.lon]);
    else largeMarker = L.circleMarker([p.lat, p.lon], MARKER_STYLE).addTo(map);
    // The modal (and so #mapFrameLarge) was hidden until openModal() just ran
    // — Leaflet needs a nudge once it's actually visible and sized.
    setTimeout(() => map.invalidateSize(), 50);
  }

  // ---- estimate location from nearby (in time) GPS-tagged photos -----------
  // For a photo with no GPS: find the closest-in-time photos in this folder
  // that DO have real GPS, treat them as a little track, and interpolate (or,
  // if this photo falls outside all of them in time, extrapolate) a position.
  // Confirming writes it into the photo's real EXIF GPS — unlike the
  // approximate-location picker, which is deliberately never written to the
  // file since it's just a rough hint for iNaturalist.
  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  // Only real GPS (never approxLat/approxLon — that's a manual, low-confidence
  // hint, not something to chain further estimates off of) counts as a track point.
  function estimateLocationFor(p) {
    if (!p || !p.datetime) return null;
    const tracked = S.photos
      .filter((q) => q !== p && q.datetime && q.lat != null && q.lon != null)
      .sort((a, b) => a.datetime - b.datetime);
    if (!tracked.length) return null;
    const t = p.datetime.getTime();

    let idx = tracked.findIndex((q) => q.datetime.getTime() > t);
    if (idx === -1) idx = tracked.length;
    const beforePts = tracked.slice(Math.max(0, idx - 2), idx);   // up to 2, ascending, both < t
    const afterPts = tracked.slice(idx, idx + 2);                 // up to 2, ascending, both > t
    const lerp = (a, b, f) => a + (b - a) * f;

    if (beforePts.length && afterPts.length) {
      const b = beforePts[beforePts.length - 1], a = afterPts[0];
      const bt = b.datetime.getTime(), at = a.datetime.getTime();
      const f = at === bt ? 0 : (t - bt) / (at - bt);
      return { lat: lerp(b.lat, a.lat, f), lon: lerp(b.lon, a.lon, f), method: "interpolated", basis: [b, a] };
    }
    if (beforePts.length >= 2) {
      const [b1, b2] = beforePts;                                 // b2 is the closer one
      const dt = b2.datetime.getTime() - b1.datetime.getTime();
      const f = dt === 0 ? 0 : (t - b2.datetime.getTime()) / dt;
      return { lat: lerp(b1.lat, b2.lat, 1 + f), lon: lerp(b1.lon, b2.lon, 1 + f), method: "extrapolated", basis: [b1, b2] };
    }
    if (afterPts.length >= 2) {
      const [a1, a2] = afterPts;                                  // a1 is the closer one
      const dt = a2.datetime.getTime() - a1.datetime.getTime();
      const f = dt === 0 ? 0 : (a1.datetime.getTime() - t) / dt;
      return { lat: lerp(a2.lat, a1.lat, 1 + f), lon: lerp(a2.lon, a1.lon, 1 + f), method: "extrapolated", basis: [a1, a2] };
    }
    const only = beforePts[0] || afterPts[0];
    return { lat: only.lat, lon: only.lon, method: "nearest", basis: [only] };
  }
  function describeEstimate(p, est) {
    const parts = est.basis.map((b) => {
      const gapMin = Math.round(Math.abs(p.datetime - b.datetime) / 60000);
      return `“${b.name}” (${fmtTime(b.datetime)}, ${gapMin} min away)`;
    });
    // How far apart the two basis photos actually are — a useful sanity check
    // on the interpolation/extrapolation (a big distance over a short time
    // gap means whoever was carrying the camera was moving fast, so trust
    // the estimate less).
    const distNote = est.basis.length === 2
      ? ` They're ${fmtRadius(Math.round(haversineM(est.basis[0].lat, est.basis[0].lon, est.basis[1].lat, est.basis[1].lon)))} apart.`
      : "";
    if (est.method === "interpolated") return `Interpolated between ${parts.join(" and ")}.${distNote}`;
    if (est.method === "extrapolated") return `Extrapolated from the trend between ${parts.join(" and ")} — no photo brackets this one in time, so treat this as a rougher guess.${distNote}`;
    return `Based on the single nearest dated, GPS-tagged photo: ${parts[0]} — no trend available, so this just reuses its position.`;
  }
  let estimateMap = null, estimateLayer = null, estimatePointMarker = null;
  function ensureEstimateMap() {
    if (estimateMap) return estimateMap;
    estimateMap = L.map("estimateLocationMap");
    addTileLayer(estimateMap);
    // The estimate is a starting point, not a verdict — clicking the map
    // moves the point, so it can be fine-tuned before anything is written.
    estimateMap.on("click", (e) => {
      if (!S.estimateResult) return;
      S.estimateResult = { ...S.estimateResult, lat: e.latlng.lat, lon: e.latlng.lng, method: "manual" };
      redrawEstimatePoint();
      $("estimateLocationExplain").textContent = "Custom point — picked by hand on the map. Click again to move it, or use a button below.";
    });
    return estimateMap;
  }
  function redrawEstimatePoint() {
    const est = S.estimateResult;
    if (!est || !estimateMap) return;
    if (estimatePointMarker) estimatePointMarker.setLatLng([est.lat, est.lon]);
    else estimatePointMarker = L.circleMarker([est.lat, est.lon], MARKER_STYLE).addTo(estimateMap);
  }
  // The single photo closest in time that has real GPS — offered as a
  // one-click alternative to the interpolated estimate.
  function nearestGpsPhoto(p) {
    if (!p || !p.datetime) return null;
    let best = null, bestGap = Infinity;
    for (const q of S.photos) {
      if (q === p || !q.datetime || q.lat == null || q.lon == null) continue;
      const gap = Math.abs(q.datetime - p.datetime);
      if (gap < bestGap) { bestGap = gap; best = q; }
    }
    return best ? { photo: best, gapMin: Math.round(bestGap / 60000) } : null;
  }
  function openEstimateLocationModal() {
    const p = current();
    if (!p) return;
    if (!p.datetime) { toast("This photo has no date/time, so it can't be matched against nearby photos.", "warn", 6000); return; }
    const est = estimateLocationFor(p);
    if (!est) { toast("No other dated, GPS-tagged photos in this folder to estimate from.", "info", 6000); return; }
    S.estimateTarget = p; S.estimateResult = est;

    openModal("estimateLocationModal");
    const map = ensureEstimateMap();
    if (estimateLayer) { try { estimateLayer.remove(); } catch { /* half-added layers */ } estimateLayer = null; }
    if (estimatePointMarker) { try { estimatePointMarker.remove(); } catch { } estimatePointMarker = null; }
    const points = est.basis.map((b) => [b.lat, b.lon]);
    // Set the view BEFORE adding any vector layers: on a freshly-created map,
    // layers added pre-view initialize deferred inside fitBounds, and
    // Leaflet's renderer then updates against half-projected paths
    // (undefined _pxBounds → crash deep in Bounds.intersects).
    // With only one basis point, est.lat/lon equals it exactly — a
    // zero-size bounds, which would make fitBounds zoom in to the max
    // level instead of a sensible overview.
    if (points.length > 1) {
      map.fitBounds(L.latLngBounds([...points, [est.lat, est.lon]]).pad(0.35));
    } else {
      map.setView([est.lat, est.lon], 14);
    }
    const group = L.layerGroup();
    if (points.length > 1) L.polyline(points, { color: "#4a90d9", weight: 2, dashArray: "5,6" }).addTo(group);
    est.basis.forEach((b) => {
      L.circleMarker([b.lat, b.lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#4a90d9", fillOpacity: 1 })
        .bindTooltip(`${b.name} — ${fmtTime(b.datetime)}`)
        .addTo(group);
    });
    estimateLayer = group.addTo(map);
    redrawEstimatePoint();
    setTimeout(() => map.invalidateSize(), 50);

    // Offer "same spot as the photo taken closest in time" as a one-click
    // alternative to the interpolated guess.
    const nearest = nearestGpsPhoto(p);
    const snapBtn = $("estimateSnapBtn");
    if (snapBtn) {
      snapBtn.hidden = !nearest;
      if (nearest) {
        snapBtn.textContent = `Use “${nearest.photo.name}”'s location (closest in time, ${nearest.gapMin} min away)`;
        snapBtn.onclick = () => {
          S.estimateResult = { ...S.estimateResult, lat: nearest.photo.lat, lon: nearest.photo.lon, method: "nearest" };
          redrawEstimatePoint();
          estimateMap.setView([nearest.photo.lat, nearest.photo.lon], Math.max(estimateMap.getZoom(), 15));
          $("estimateLocationExplain").textContent =
            `Same location as “${nearest.photo.name}” (${nearest.gapMin} min ${nearest.photo.datetime < p.datetime ? "earlier" : "later"}). Click the map to fine-tune before saving.`;
        };
      }
    }

    $("estimateLocationExplain").textContent = describeEstimate(p, est) + " Click the map to adjust the red point before saving.";
  }
  async function confirmEstimatedLocation() {
    const p = S.estimateTarget, est = S.estimateResult;
    if (!p || !est) return;
    setBusy("Writing location…");
    try {
      if (S.mode === "applephotos") {
        // PhotosKit's change API does support writing an asset's location
        // (unlike caption/keywords) — the helper does it natively.
        await apFetch(`/photos/${encodeURIComponent(p.assetId)}/location`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat: est.lat, lon: est.lon }),
        });
      } else {
        const bytes = TagMeta.writeGps(await getFileBytes(p), est.lat, est.lon);
        if (S.mode === "download") downloadBytes(p.name, bytes);
        else p.fileHandle = await writeBytesTo(p.parentHandle, p.name, bytes);
        p.url = null;   // file bytes changed; Photos-mode pixels didn't
      }
      p.lat = est.lat; p.lon = est.lon;
      closeModal("estimateLocationModal");
      S.estimateTarget = null; S.estimateResult = null;
      render();
      toast("Location written to the photo.", "info");
    } catch (e) {
      console.error(e); toast("Couldn't write the location: " + (e.message || e), "warn", 7000);
    } finally { setBusy(null); }
  }
  function estimateLocationRow() {
    const btn = el("button", { id: "estimateLocBtn", className: "meta-map-btn", textContent: "Estimate location…" });
    btn.onclick = openEstimateLocationModal;
    return btn;
  }

  // ---- approximate location (photos with no GPS) ----------------------------
  // iNaturalist's identification and observation-creation both do better with
  // *some* location — a click-to-place point with a visible uncertainty
  // circle, so it's clear this isn't the photo's real GPS, just a rough area.
  // Zooming in suggests a tighter precision automatically; the dropdown sets
  // it directly and always wins over the auto-suggestion until you zoom again.
  const APPROX_RADIUS_OPTIONS = [25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 250000];
  function fmtRadius(m) {
    return m >= 1000 ? `${+(m / 1000).toFixed(1)} km` : `${m} m`;
  }
  // Coarse zoom (whole country/continent visible) = wide, uncertain area;
  // tight zoom (streets/buildings visible) = a small radius.
  function radiusForZoom(zoom) {
    if (zoom >= 19) return 25;
    if (zoom >= 17) return 100;
    if (zoom >= 15) return 250;
    if (zoom >= 13) return 1000;
    if (zoom >= 11) return 5000;
    if (zoom >= 9) return 10000;
    if (zoom >= 7) return 20000;
    if (zoom >= 5) return 50000;
    if (zoom >= 3) return 100000;
    return 250000;
  }
  let approxMap = null, approxMarker = null, approxCircle = null;
  function ensureApproxMap() {
    if (approxMap) return approxMap;
    approxMap = L.map("approxLocationMap", { attributionControl: false });
    addTileLayer(approxMap);
    L.control.attribution({ prefix: false }).addTo(approxMap);
    const select = $("approxPrecisionSelect");
    if (select && !select.children.length) {
      APPROX_RADIUS_OPTIONS.forEach((m) => select.append(el("option", { value: String(m), textContent: fmtRadius(m) })));
    }
    approxMap.on("click", (e) => {
      const p = current();
      if (!p) return;
      const radius = select ? +select.value : radiusForZoom(approxMap.getZoom());
      setApproxLocation(p, e.latlng.lat, e.latlng.lng, radius);
    });
    // Only nudges the *suggestion* shown in the dropdown — an already-placed
    // point's radius doesn't change just because you panned around to look
    // at something else; it only changes on the next click or manual pick.
    approxMap.on("zoomend", () => {
      if (select) select.value = String(radiusForZoom(approxMap.getZoom()));
    });
    return approxMap;
  }
  function clearApproxDrawing() {
    if (approxCircle) { approxCircle.remove(); approxCircle = null; }
    if (approxMarker) { approxMarker.remove(); approxMarker = null; }
  }
  function drawApproxPoint(lat, lon, radiusM) {
    const map = ensureApproxMap();
    if (approxCircle) approxCircle.setLatLng([lat, lon]).setRadius(radiusM);
    else approxCircle = L.circle([lat, lon], {
      radius: radiusM, color: "#e0362f", weight: 1.5, fillColor: "#e0362f", fillOpacity: 0.12,
    }).addTo(map);
    if (approxMarker) approxMarker.setLatLng([lat, lon]);
    else approxMarker = L.circleMarker([lat, lon], MARKER_STYLE).addTo(map);
  }
  function updateApproxLocationStatus(p) {
    const status = $("approxLocationStatus"), clearBtn = $("approxLocationClearBtn"), reuseBtn = $("approxLocationReuseBtn");
    if (!status) return;
    const has = p && p.approxLat != null;
    status.textContent = has
      ? `Approximate location set (±${fmtRadius(p.approxUncertaintyM)}) — ${p.approxLat.toFixed(3)}, ${p.approxLon.toFixed(3)}`
      : "No approximate location set.";
    if (clearBtn) clearBtn.hidden = !has;
    if (reuseBtn) reuseBtn.hidden = has || !S.lastApproxLocation;
  }
  function setApproxLocation(p, lat, lon, radiusM) {
    p.approxLat = lat; p.approxLon = lon; p.approxUncertaintyM = radiusM;
    S.lastApproxLocation = { lat, lon, radiusM };
    LS.set("lastApproxLocation", S.lastApproxLocation);
    drawApproxPoint(lat, lon, radiusM);
    const select = $("approxPrecisionSelect");
    if (select) select.value = String(radiusM);
    updateApproxLocationStatus(p);
  }
  function clearApproxLocation(p) {
    p.approxLat = null; p.approxLon = null; p.approxUncertaintyM = null;
    clearApproxDrawing();
    updateApproxLocationStatus(p);
  }
  function renderApproxLocationBox() {
    const box = $("approxLocationBox");
    if (!box) return;
    const p = current();
    const hasRealGps = p && p.lat != null && p.lon != null;
    const modal = $("inatModal");
    if (!p || hasRealGps || !modal || modal.hidden) { box.hidden = true; return; }
    box.hidden = false;
    const map = ensureApproxMap();
    const select = $("approxPrecisionSelect");
    clearApproxDrawing();
    if (p.approxLat != null) {
      map.setView([p.approxLat, p.approxLon], 8);
      drawApproxPoint(p.approxLat, p.approxLon, p.approxUncertaintyM);
      if (select) select.value = String(p.approxUncertaintyM);
    } else if (S.lastApproxLocation) {
      map.setView([S.lastApproxLocation.lat, S.lastApproxLocation.lon], 6);
      if (select) select.value = String(radiusForZoom(map.getZoom()));
    } else {
      map.setView([20, 0], 2);
      if (select) select.value = String(radiusForZoom(map.getZoom()));
    }
    updateApproxLocationStatus(p);
    setTimeout(() => map.invalidateSize(), 0);
  }

  // ---- folder loading ------------------------------------------------------
  async function verifyPermission(handle, write) {
    const opts = { mode: write ? "readwrite" : "read" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return (await handle.requestPermission(opts)) === "granted";
  }

  async function openFolder() {
    if (!window.showDirectoryPicker) {
      toast("This browser can't open a folder. Use Chrome/Edge, or drag photos in below.", "warn", 6000);
      return;
    }
    let handle;
    try { handle = await window.showDirectoryPicker({ mode: "readwrite" }); }
    catch (e) { if (e.name !== "AbortError") toast("Couldn't open the folder: " + (e.message || e), "warn", 7000); return; }
    await useFolder(handle);
    idb.put("lastFolder", handle);
  }
  async function reopenLastFolder() {
    const handle = await idb.get("lastFolder");
    if (!handle) return;
    if (!(await verifyPermission(handle, true))) return;
    await useFolder(handle);
  }
  // The Delete button's "→ _deleted" sub-label describes a folder move that
  // only happens in fs/download mode — Apple Photos mode just hides the photo
  // behind a marker keyword instead, so the label needs to say that.
  function updateDeleteLabel() {
    const sub = document.querySelector("#deleteBtn .sub");
    if (sub) sub.textContent = S.mode === "applephotos" ? "→ hidden" : "→ _deleted";
  }

  async function useFolder(handle) {
    S.mode = "fs";
    S.rootHandle = handle;
    S.subHandles = {};
    S.applePhotos.token = "";
    $("folderName").textContent = handle.name;
    updateDeleteLabel();
    await scanAndLoad();
  }

  const OTHER_IMG_RE = /\.(heic|heif|cr2|cr3|nef|arw|raf|dng|orf|rw2|png|tiff?|gif|webp|bmp|avif)$/i;

  async function scanAndLoad() {
    const stats = { files: 0, jpeg: 0, unsupported: 0, subdirs: 0, exts: {} };
    try {
      setBusy("Scanning folder…");
      const photos = [];
      await collectFrom(S.rootHandle, "untouched", photos, null, stats);
      for (const [status, dir] of Object.entries(STATUS_DIRS)) {
        try {
          const sub = await S.rootHandle.getDirectoryHandle(dir);
          await collectFrom(sub, status, photos, dir, stats);
        } catch { /* subfolder doesn't exist yet */ }
      }
      reportScan(stats, photos.length);
      beginSession(photos);                 // shows photos immediately; dates load after
    } catch (e) {
      console.error("scan failed", e);
      toast("Could not read this folder: " + (e.message || e), "warn", 8000);
    } finally {
      setBusy(null);
    }
  }

  // Order photos, show the first one right away, then read EXIF dates/GPS in the
  // background. Reading is deferred so a slow or malformed file can never stop
  // the photos from appearing — the single biggest source of "nothing loads".
  function beginSession(photos) {
    photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    S.photos = photos;
    S.idx = photos.findIndex((p) => p.status === "untouched");
    if (S.idx < 0) S.idx = 0;
    S.undo = null;
    S.inatResults = []; S.inatResultsFor = null;
    S.multiSel.clear(); S.selAnchor = null; S._filmSig = null;
    clearSelection();
    render();
    // Apple Photos mode already gets datetime/GPS/caption/keywords from the
    // helper (authoritative — AppleScript/PhotosKit, not the file bytes), and
    // its images may carry no EXIF at all (demo mode) — re-reading EXIF here
    // would just blank those fields out or fight with the real values.
    if (photos.length && S.mode !== "applephotos") loadMetaInBackground(photos);
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("metadata read timed out")), ms)),
    ]);
  }

  async function loadMetaInBackground(photos) {
    const token = ++S.metaToken;
    // Read the photo on screen first, so its date/GPS/suggestions appear at once.
    const order = photos.slice();
    const cur = S.photos[S.idx];
    const ci = order.indexOf(cur);
    if (ci > 0) { order.splice(ci, 1); order.unshift(cur); }

    let done = 0;
    for (const p of order) {
      if (token !== S.metaToken) return;                 // a newer load superseded us
      try {
        const file = await getFile(p);
        const m = await withTimeout(TagMeta.readMeta(file), 6000);
        p.datetime = m.datetime ? new Date(m.datetime.getTime() + CFG.cameraClockOffsetHours * 3600000) : null;
        p.lat = m.lat; p.lon = m.lon; p.orientation = m.orientation;
        p.keywords = m.keywords || []; p.inatUrl = sanitizeInatUrl(m.inatUrl);
        if (!p.caption) p.caption = m.caption;            // keep a caption we already know
        if (p === S.photos[S.idx]) render();              // refresh date/suggestions live
      } catch (e) { /* leave this photo's date blank; it still tags fine */ }
      done++;
      if (token === S.metaToken && done % 12 === 0)
        setBusy(done < order.length ? `Reading photo info… ${done}/${order.length}` : null);
    }
    if (token === S.metaToken) { setBusy(null); render(); }
  }
  async function collectFrom(dirHandle, status, out, dirKey = null, stats = null) {
    for await (const [name, h] of dirHandle.entries()) {
      if (h.kind === "directory") {
        if (status === "untouched") { if (stats && !SUBDIR_NAMES.includes(name)) stats.subdirs++; continue; }
        // Inside a status folder (e.g. per-species subfolders under
        // _labelled), recurse one level so photos organized that way are
        // still found — regardless of whether that setting is on right now.
        await collectFrom(h, status, out, dirKey ? `${dirKey}/${name}` : name, stats);
        continue;
      }
      if (stats) stats.files++;
      if (IMAGE_RE.test(name)) {
        if (stats) stats.jpeg++;
        out.push({
          name, status, fileHandle: h, parentDir: dirKey, parentHandle: dirHandle,
          datetime: null, lat: null, lon: null, approxLat: null, approxLon: null, approxUncertaintyM: null,
          caption: "", keywords: [], inatUrl: "", orientation: 1, url: null,
        });
      } else if (stats && OTHER_IMG_RE.test(name)) {
        stats.unsupported++;
        const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        stats.exts[ext] = (stats.exts[ext] || 0) + 1;
      }
    }
  }
  // Tell the user in plain language what the scan found — especially when nothing loads.
  function reportScan(stats, loaded) {
    const folder = S.rootHandle ? S.rootHandle.name : "folder";
    if (loaded > 0) {
      $("folderName").textContent = `${folder} — ${loaded} JPEG${loaded === 1 ? "" : "s"}` +
        (stats.unsupported ? ` (${stats.unsupported} non-JPEG skipped)` : "");
      toast(`Loaded ${loaded} JPEG photo${loaded === 1 ? "" : "s"}.`, "info");
      return;
    }
    let msg;
    if (stats.unsupported > 0) {
      const kinds = Object.entries(stats.exts).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${v} .${k}`).join(", ");
      msg = `No JPEGs here — this browser build reads JPEG only. Skipped ${kinds}. ` +
            `For HEIC/RAW use the desktop tagit.R version.`;
    } else if (stats.files === 0 && stats.subdirs > 0) {
      msg = `This folder has no files at its top level, but ${stats.subdirs} subfolder(s). ` +
            `Open the subfolder that actually holds the photos.`;
    } else if (stats.files === 0) {
      msg = `This folder is empty.`;
    } else {
      msg = `No JPEG (.jpg/.jpeg) files found (${stats.files} other file${stats.files === 1 ? "" : "s"} here).`;
    }
    $("folderName").textContent = `${folder} — no JPEGs found`;
    toast(msg, "warn", 10000);
  }
  // ---- Apple Photos source (via the local tagit Photos Helper) -------------
  // A third source alongside "fs" and "download": photos picked from the
  // user's real Photos library through Apple's Limited Photos Access picker,
  // served by a tiny helper app running on 127.0.0.1. Photos has no folder-
  // move concept, so status ("labelled"/"skipped"/…) is instead tracked with
  // reserved keywords written back alongside the real caption/keywords — never
  // shown to the user, stripped before display, re-applied on save. The linked
  // iNaturalist observation (normally stashed in XMP, which this source never
  // writes) is tracked the same way.
  const APPLE_PHOTOS_STATUS_KW = {
    labelled: "tagit:labelled", skipped: "tagit:skipped",
    undetermined: "tagit:undetermined", deleted: "tagit:deleted",
  };
  const INAT_KW_PREFIX = "tagit:inat:";
  function statusFromKeywords(keywords) {
    for (const [status, kw] of Object.entries(APPLE_PHOTOS_STATUS_KW)) if (keywords.includes(kw)) return status;
    return "untouched";
  }
  function stripReservedKeywords(keywords) {
    const marks = new Set(Object.values(APPLE_PHOTOS_STATUS_KW));
    return (keywords || []).filter((k) => !marks.has(k) && !k.startsWith(INAT_KW_PREFIX));
  }
  function inatUrlFromKeywords(keywords) {
    const kw = (keywords || []).find((k) => k.startsWith(INAT_KW_PREFIX));
    const id = kw ? kw.slice(INAT_KW_PREFIX.length) : "";
    // Digits only — the marker keyword is user-editable in Photos itself.
    return /^\d+$/.test(id) ? `https://www.inaturalist.org/observations/${id}` : "";
  }
  function withReservedKeywords(keywords, status, inatUrl) {
    const clean = stripReservedKeywords(keywords);
    const mark = APPLE_PHOTOS_STATUS_KW[status];
    const id = inatIdFromUrl(inatUrl);
    return [...clean, ...(mark ? [mark] : []), ...(id ? [INAT_KW_PREFIX + id] : [])];
  }

  async function apFetch(path, opts = {}) {
    // A hung helper (or one that quit mid-request) must never freeze the UI
    // forever — 60s is generous even for an iCloud image download.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch(S.applePhotos.baseUrl + path, {
        ...opts,
        headers: { ...(opts.headers || {}), "X-Tagit-Token": S.applePhotos.token },
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(e && e.name === "AbortError"
        ? "the helper took too long to respond"
        : "could not reach the helper — is it running?");
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    return res;
  }

  // Persist caption+keywords(+inatUrl, +status) to the current source, used by
  // the iNaturalist create/sync/refresh helpers which write outside of the
  // main Save/Skip/Undetermined/Delete flow (that flow goes through
  // applyStatus/commit instead).
  async function writeCaptionKeywords(p, caption, keywords, inatUrl) {
    if (S.mode === "applephotos") {
      const wire = withReservedKeywords(keywords, p.status, inatUrl != null ? inatUrl : p.inatUrl);
      await apFetch(`/photos/${encodeURIComponent(p.assetId)}/caption`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption, keywords: wire }),
      });
    } else {
      const bytes = TagMeta.writeCaption(await getFileBytes(p), caption, keywords, inatUrl || "");
      await rewritePhotoBytes(p, bytes);
    }
  }

  // Write caption/keywords/status to the helper and return an undo() closure —
  // the applephotos counterpart to commit() (which only handles fs/download).
  async function commitApplePhotos(p, status, caption, keywords) {
    const prev = { caption: p.caption, keywords: p.keywords.slice(), status: p.status, inatUrl: p.inatUrl };
    const nextCaption = caption != null ? caption : p.caption;
    const nextKeywords = keywords != null ? keywords : p.keywords;
    const wire = withReservedKeywords(nextKeywords, status, p.inatUrl);
    await apFetch(`/photos/${encodeURIComponent(p.assetId)}/caption`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption: nextCaption, keywords: wire }),
    });
    return {
      undo: async () => {
        try {
          const wirePrev = withReservedKeywords(prev.keywords, prev.status, prev.inatUrl);
          await apFetch(`/photos/${encodeURIComponent(p.assetId)}/caption`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ caption: prev.caption, keywords: wirePrev }),
          });
        } catch (e) { console.warn("undo failed", e); }
      },
    };
  }

  async function connectToApplePhotos(baseUrl, token) {
    const prevUrl = S.applePhotos.baseUrl, prevToken = S.applePhotos.token;
    S.applePhotos.baseUrl = baseUrl; S.applePhotos.token = token;
    let health;
    try {
      const res = await apFetch("/health");
      health = await res.json();
    } catch (e) {
      S.applePhotos.baseUrl = prevUrl; S.applePhotos.token = prevToken;
      throw e;
    }
    if (health.albumSelected) {
      S.applePhotos.albumTitle = health.album || "Photos";
      await useApplePhotos();
    } else {
      await chooseAlbumFlow();
    }
  }

  // The album choice IS the safety boundary in Photos mode (macOS's own
  // permission dialog is all-or-nothing) — the helper exposes photos from
  // exactly one album, chosen here, and nothing else. The last-used album is
  // remembered so reconnecting is one click, not a re-pick every time.
  async function chooseAlbumFlow(forcePicker = false) {
    setBusy("Loading your albums…");
    let albums;
    try {
      const res = await apFetch("/albums");
      albums = (await res.json()).albums;
    } finally { setBusy(null); }
    if (!albums || !albums.length) {
      toast("No albums with photos found in your Photos library — create one in Photos first.", "warn", 9000);
      return;
    }
    if (!forcePicker) {
      const remembered = LS.get("photosAlbumId", null);
      const match = remembered && albums.find((a) => a.id === remembered);
      if (match) {
        await selectApplePhotosAlbum(match);
        toast(`Using album “${match.title}” — click Connect to Photos to switch albums.`, "info", 6000);
        return;
      }
    }
    openAlbumPickerModal(albums);
  }

  async function selectApplePhotosAlbum(album) {
    setBusy("Opening album…");
    try {
      await apFetch("/album", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: album.id }),
      });
      LS.set("photosAlbumId", album.id);
      S.applePhotos.albumTitle = album.title;
      closeModal("photosAlbumModal");
      closeModal("photosConnectModal");
      await useApplePhotos();
    } finally { setBusy(null); }
  }

  function openAlbumPickerModal(albums) {
    const container = $("photosAlbumGrid");
    container.innerHTML = "";
    const current = LS.get("photosAlbumId", null);
    // Thumbnails need the pairing token, so <img src> can't fetch them
    // directly — and with hundreds of albums, requesting them all at once
    // would queue minutes of work on the helper. Load each cover only when
    // its card actually scrolls into view.
    const thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver.unobserve(entry.target);
        const { albumId } = entry.target.dataset;
        apFetch(`/albums/${encodeURIComponent(albumId)}/thumbnail`)
          .then((r) => r.blob()).then((b) => { entry.target.src = URL.createObjectURL(b); })
          .catch(() => { /* no local thumbnail — the placeholder background stays */ });
      }
    }, { root: container, rootMargin: "300px" });

    // Group albums the way Photos' own sidebar does — by their folder path
    // (helper already sorts: top-level albums first, then folder by folder).
    const groups = new Map();
    for (const a of albums) {
      const key = a.folder || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    for (const [folder, items] of groups) {
      const grid = el("div", { className: "album-grid" });
      for (const a of items) {
        const img = el("img", { alt: "" });
        img.dataset.albumId = a.id;
        const card = el("button", { type: "button", className: "album-card" + (a.id === current ? " current" : "") }, [
          img,
          el("span", { className: "album-card-title", textContent: a.title }),
          ...(a.count != null ? [el("span", { className: "album-card-count", textContent: `${a.count} photo${a.count === 1 ? "" : "s"}` })] : []),
        ]);
        card.dataset.searchText = (folder + " " + a.title).toLowerCase();
        card.onclick = () => selectApplePhotosAlbum(a).catch((e) => {
          toast("Couldn't open that album: " + (e.message || e), "warn", 7000);
        });
        grid.append(card);
        thumbObserver.observe(img);
      }
      const group = el("div", { className: "album-group" });
      if (folder) group.append(el("div", { className: "album-group-title", textContent: folder }));
      group.append(grid);
      container.append(group);
    }

    // With a big album collection, typing beats scrolling — matches the
    // album name or its folder.
    const search = $("photosAlbumSearch");
    if (search) {
      search.value = "";
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        for (const group of container.children) {
          let any = false;
          for (const card of group.querySelectorAll(".album-card")) {
            const show = !q || card.dataset.searchText.includes(q);
            card.style.display = show ? "" : "none";
            if (show) any = true;
          }
          group.style.display = any ? "" : "none";
        }
      };
    }
    openModal("photosAlbumModal");
    if (search) setTimeout(() => search.focus(), 50);
  }

  function randomPairSecret() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // One-click connect: generate the pairing secret HERE, hand it to the
  // helper inside the launch URL, and poll until the helper (new or already
  // running — the OS routes the URL to a running instance, which just adopts
  // the new secret) answers with it. No code to copy. Safe because knowing
  // the secret alone is not enough: every request must also come from an
  // allowlisted tagit origin.
  async function launchHelperAutoPair() {
    const secret = randomPairSecret();
    const baseUrl = (($("photosConnectUrl") && $("photosConnectUrl").value.trim()) || "http://127.0.0.1:8765").replace(/\/+$/, "");
    const hint = $("photosConnectHint");
    hint.textContent = "Launching the helper… approve the browser's “open app” prompt, and macOS's Photos prompts if they appear.";
    // location.replace, not location.href: the launch URL carries the pairing
    // secret, and replace() doesn't add a history entry — so the secret never
    // lands in the browser's history.
    window.location.replace("tagitphotos://start?pair=" + secret);
    const deadline = Date.now() + 90000;   // generous — first run includes permission dialogs
    while (Date.now() < deadline) {
      await sleep(1000);
      if ($("photosConnectModal").hidden) return;          // user gave up / closed the dialog
      if (S.applePhotos.token === secret) return;          // already connected meanwhile
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 900);
        const res = await fetch(baseUrl + "/health", { headers: { "X-Tagit-Token": secret }, signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) {
          hint.textContent = "Connected — loading your albums…";
          try {
            await connectToApplePhotos(baseUrl, secret);
          } catch (e) {
            console.error(e);
            hint.textContent = "Connected to the helper, but then: " + (e.message || e);
            return;
          }
          if (S.mode === "applephotos") closeModal("photosConnectModal");
          toast("Connected to Photos.", "info", 4000);
          return;
        }
      } catch { /* helper not up yet — keep polling */ }
    }
    hint.textContent = "Couldn't connect automatically. If the helper never opened, it needs its one-time setup (see the instructions link). If an older helper is still running from before, quit it and try again — or connect manually below.";
  }
  async function useApplePhotos() {
    S.mode = "applephotos";
    S.rootHandle = null;
    $("folderName").textContent = S.applePhotos.albumTitle;
    updateDeleteLabel();
    await scanAndLoadApplePhotos();
  }
  async function scanAndLoadApplePhotos() {
    setBusy("Loading photos…");
    try {
      const res = await apFetch("/photos");
      const data = await res.json();
      const photos = (data.photos || []).map((ap) => {
        const rawKw = ap.keywords || [];
        const caption = ap.caption || "";
        const keywords = stripReservedKeywords(rawKw);
        let status = statusFromKeywords(rawKw);
        // A photo tagit hasn't touched (no tagit: marker) but which already
        // carries a caption or real keywords isn't "untouched" — it was
        // captioned elsewhere (Photos itself, a previous import, another
        // tool). Surface it as its own "already tagged" category so it's
        // visible and filterable, instead of hiding among the blank ones.
        if (status === "untouched" && (caption.trim() || keywords.length)) status = "preexisting";
        return {
          name: ap.filename, status,
          assetId: ap.id, fileHandle: null, parentDir: null, parentHandle: null,
          datetime: ap.dateTaken ? new Date(ap.dateTaken) : null,
          lat: ap.lat != null ? ap.lat : null, lon: ap.lon != null ? ap.lon : null,
          approxLat: null, approxLon: null, approxUncertaintyM: null,
          caption, keywords,
          inatUrl: inatUrlFromKeywords(rawKw), orientation: 1, url: null,
        };
      });
      const n = photos.length;
      $("folderName").textContent = `${S.applePhotos.albumTitle} — ${n} photo${n === 1 ? "" : "s"}`;
      toast(`Loaded ${n} photo${n === 1 ? "" : "s"} from Photos.`, "info");
      beginSession(photos);
    } catch (e) {
      console.error(e);
      toast("Couldn't load photos from the helper: " + (e.message || e), "warn", 8000);
    } finally { setBusy(null); }
  }

  // ---- drag & drop fallback (download mode) --------------------------------
  function acceptDroppedFiles(fileList) {
    const all = [...fileList];
    const files = all.filter((f) => IMAGE_RE.test(f.name));
    if (!files.length) {
      const other = all.filter((f) => OTHER_IMG_RE.test(f.name)).length;
      toast(other ? `No JPEGs — ${other} HEIC/RAW/PNG can't be read in the browser.`
                  : "No JPEG (.jpg/.jpeg) files in what you dropped.", "warn", 8000);
      return;
    }
    S.mode = "download";
    S.rootHandle = null;
    S.applePhotos.token = "";
    updateDeleteLabel();
    $("folderName").textContent = `${files.length} dropped photo${files.length === 1 ? "" : "s"} — captions download as copies`;
    const photos = files.map((file) => ({
      name: file.name, status: "untouched", file, fileHandle: null, parentDir: null, parentHandle: null,
      datetime: null, lat: null, lon: null, approxLat: null, approxLon: null, approxUncertaintyM: null,
      caption: "", keywords: [], inatUrl: "", orientation: 1, url: null,
    }));
    toast(`Loaded ${files.length} JPEG photo${files.length === 1 ? "" : "s"} (download mode).`, "info");
    beginSession(photos);
  }

  // ---- file operations -----------------------------------------------------
  // Re-acquire a live file handle when it's been cleared (after a move/rotate),
  // so revisiting or re-saving a photo never fails on a stale handle.
  async function ensureHandle(p) {
    if (!p.fileHandle && p.parentHandle) p.fileHandle = await p.parentHandle.getFileHandle(p.name);
    return p.fileHandle;
  }
  async function getFile(p) {
    if (S.mode === "applephotos") {
      if (p._apBlob) return p._apBlob;
      const res = await apFetch(`/photos/${encodeURIComponent(p.assetId)}/image`);
      p._apBlob = new File([await res.blob()], p.name, { type: "image/jpeg" });
      return p._apBlob;
    }
    if (p.file) return p.file;
    return (await ensureHandle(p)).getFile();
  }
  async function getFileBytes(p) {
    return new Uint8Array(await (await getFile(p)).arrayBuffer());
  }
  // Gets or creates a (possibly nested) folder under the root, e.g.
  // subHandle("_labelled", "Drosera rotundifolia") for the per-species option.
  async function subHandle(...segments) {
    const key = segments.join("/");
    if (!S.subHandles[key]) {
      let dir = S.rootHandle;
      for (const seg of segments) dir = await dir.getDirectoryHandle(seg, { create: true });
      S.subHandles[key] = dir;
    }
    return S.subHandles[key];
  }
  async function writeBytesTo(dirHandle, name, bytes) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return fh;
  }
  function downloadBytes(name, bytes) {
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Folder names can't contain these on Windows (and some are awkward on
  // macOS too); collapse whitespace and drop trailing dots while we're at it.
  function sanitizeFolderName(name) {
    return (name || "").replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().replace(/\.+$/, "") || "Unknown";
  }

  // Write `bytes` for photo p and move it to `status`. In fs mode this rewrites
  // the file into the status subfolder and removes the original; in download
  // mode it just downloads the modified copy. Returns before/after for undo.
  // `taxa` (the determined species) is only used when saving as "labelled"
  // with the per-species-folders setting on.
  async function commit(p, bytes, status, taxa) {
    if (S.mode === "download") {
      if (bytes) downloadBytes(p.name, bytes);
      return { undo: () => {} };
    }
    const statusDir = STATUS_DIRS[status] || null;         // null = stay at root (untouched)
    let segments = statusDir ? [statusDir] : null;
    if (status === "labelled" && S.perSpeciesFolders && statusDir && taxa && taxa[0]) {
      segments = [statusDir, sanitizeFolderName(taxa[0].replace(/\s+cf\.\s+/i, " ").trim())];
    }
    const targetDir = segments ? segments.join("/") : null;
    const alreadyThere = (p.parentDir || null) === targetDir;
    const srcParent = p.parentHandle, srcName = p.name;
    let destParent, destName = p.name;

    let destHandle;
    if (alreadyThere) {
      destParent = p.parentHandle;
      destHandle = bytes ? await writeBytesTo(destParent, destName, bytes)
                         : await destParent.getFileHandle(destName);
    } else {
      destParent = segments ? await subHandle(...segments) : S.rootHandle;
      destName = await freeName(destParent, p.name);
      const finalBytes = bytes || (await getFileBytes(p));
      destHandle = await writeBytesTo(destParent, destName, finalBytes);
      await srcParent.removeEntry(srcName);
    }
    const prev = { parentHandle: srcParent, parentDir: p.parentDir, name: srcName };
    p.parentHandle = destParent; p.parentDir = targetDir; p.name = destName;
    p.fileHandle = destHandle;                             // keep a live handle
    p.url = null;                                          // preview cache invalid
    // undo closure: move the file back to where it came from
    return {
      undo: async () => {
        try {
          if (!alreadyThere) {
            const origBytes = await (await destParent.getFileHandle(destName)).getFile().then((f) => f.arrayBuffer());
            await writeBytesTo(prev.parentHandle, prev.name, new Uint8Array(origBytes));
            await destParent.removeEntry(destName);
            p.parentHandle = prev.parentHandle; p.parentDir = prev.parentDir; p.name = prev.name;
          }
          p.fileHandle = null; p.url = null;
        } catch (e) { console.warn("undo failed", e); }
      },
    };
  }
  async function freeName(dirHandle, name) {
    const exists = async (n) => { try { await dirHandle.getFileHandle(n); return true; } catch { return false; } };
    if (!(await exists(name))) return name;
    const dot = name.lastIndexOf(".");
    const base = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot) : "";
    let i = 1;
    while (await exists(`${base}_${i}${ext}`)) i++;
    return `${base}_${i}${ext}`;
  }

  // ---- filmstrip + multi-select --------------------------------------------
  // A row of thumbnails above the photo: click to jump, shift-click to select
  // a range, Cmd/Ctrl-click to toggle one — selections feed the bulk bar.
  let filmObserver = null;
  async function thumbUrlFor(p) {
    if (p._thumbUrl) return p._thumbUrl;
    if (S.mode === "applephotos") {
      const res = await apFetch(`/photos/${encodeURIComponent(p.assetId)}/thumbnail`);
      p._thumbUrl = URL.createObjectURL(await res.blob());
    } else {
      const bmp = await createImageBitmap(await getFile(p), { resizeWidth: 160, resizeQuality: "low" });
      const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.7));
      p._thumbUrl = URL.createObjectURL(blob);
    }
    return p._thumbUrl;
  }
  function rebuildFilmstrip() {
    const strip = $("filmstrip");
    if (!strip) return;
    if (filmObserver) filmObserver.disconnect();
    strip.innerHTML = "";
    const vis = visibleIdx();
    if (!vis.length) { strip.hidden = true; updateBulkBar(); return; }
    strip.hidden = false;
    filmObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        filmObserver.unobserve(en.target);
        const p = S.photos[+en.target.dataset.idx];
        if (p) thumbUrlFor(p).then((u) => { en.target.src = u; }).catch(() => {});
      }
    }, { root: strip, rootMargin: "500px" });
    for (const i of vis) {
      const p = S.photos[i];
      const img = el("img", { alt: "" });
      img.dataset.idx = i;
      if (p._thumbUrl) img.src = p._thumbUrl;
      const dot = el("span", { className: "film-dot" });
      const cell = el("button", { type: "button", className: "film-cell", title: p.name }, [img, dot]);
      cell.dataset.idx = i;
      cell.onclick = (e) => onFilmCellClick(i, e);
      strip.append(cell);
      if (!p._thumbUrl) filmObserver.observe(img);
    }
    syncFilmstrip();
  }
  // Cheap per-render pass: highlight current/selected, refresh status dots,
  // keep the current photo scrolled into view. No DOM rebuilding.
  function syncFilmstrip() {
    const strip = $("filmstrip");
    if (!strip || strip.hidden) { updateBulkBar(); return; }
    for (const cell of strip.children) {
      const i = +cell.dataset.idx;
      const p = S.photos[i];
      cell.classList.toggle("multisel", S.multiSel.has(i));
      cell.classList.toggle("current", i === S.idx);
      const dot = cell.querySelector(".film-dot");
      if (p && dot) dot.style.background = STATUS_LABEL[p.status].color;
    }
    const cur = strip.querySelector(".film-cell.current");
    if (cur) cur.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateBulkBar();
  }
  function onFilmCellClick(i, e) {
    if (e.shiftKey && S.selAnchor != null) {
      const vis = visibleIdx();
      const a = vis.indexOf(S.selAnchor), b = vis.indexOf(i);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let k = lo; k <= hi; k++) S.multiSel.add(vis[k]);
      }
      syncFilmstrip();
    } else if (e.metaKey || e.ctrlKey) {
      if (S.multiSel.has(i)) S.multiSel.delete(i); else S.multiSel.add(i);
      S.selAnchor = i;
      syncFilmstrip();
    } else {
      S.selAnchor = i;
      S.multiSel.clear();
      S.idx = i;
      syncSelectionFromCaption();
      render();
    }
  }
  function clearMultiSel() {
    S.multiSel.clear(); S.selAnchor = null;
    syncFilmstrip();
  }
  function updateBulkBar() {
    const bar = $("bulkBar");
    if (!bar) return;
    const n = S.multiSel.size;
    bar.hidden = n < 2;
    if (n >= 2) $("bulkCount").textContent = `${n} photos selected —`;
  }
  // One action applied to every selected photo, with ONE undo covering the
  // whole batch (the per-photo undos are chained under a single snapshot).
  async function bulkApply(action) {
    const targets = [...S.multiSel].sort((a, b) => a - b).map((i) => S.photos[i]).filter(Boolean);
    if (targets.length < 2) return;
    let caption = null, taxa = null, keywords = null;
    if (action === "labelled") {
      caption = $("captionBox").value.trim();
      if (!caption) { toast("Type or pick a caption first — it will be applied to every selected photo.", "info", 5000); return; }
      taxa = taxaFromCaption(caption);
      keywords = keywordsForSave(taxa);
    }
    const verb = { labelled: "Label", skipped: "Skip", undetermined: "Mark undetermined", deleted: "Delete" }[action];
    if (!confirm(`${verb} ${targets.length} photos${action === "labelled" ? ` as “${caption}”` : ""}? One Undo reverts the whole batch.`)) return;
    const pre = {
      photos: S.photos.map((q) => ({ ...q, fileHandle: null, url: null, _apBlob: null })),
      idx: S.idx, lastCaption: S.lastCaption, recent: [...S.recent],
    };
    const undos = [];
    let done = 0, failed = 0;
    setBusy(`${verb}ing…`);
    try {
      for (const p of targets) {
        try {
          if (action === "labelled") {
            if (S.mode === "applephotos") {
              await applyStatus(p, "labelled", caption, null, taxa, keywords, null);
            } else {
              const origBytes = S.mode === "fs" ? await getFileBytes(p) : null;
              const bytes = await composeSaveBytes(p, caption, keywords);
              await applyStatus(p, "labelled", caption, bytes, taxa, keywords, origBytes);
            }
          } else if (action === "undetermined") {
            let bytes = null, origBytes = null;
            if (S.mode !== "applephotos") {
              origBytes = S.mode === "fs" ? await getFileBytes(p) : null;
              try { bytes = await composeSaveBytes(p, CFG.undeterminedCaption, []); } catch { /* move anyway */ }
            }
            await applyStatus(p, "undetermined", CFG.undeterminedCaption, bytes, null, [], origBytes);
          } else {
            await applyStatus(p, action, null, null, null);
          }
          if (S.undo && S.undo.fileUndo) undos.push(S.undo.fileUndo);
          done++;
        } catch (e) { console.warn("bulk action failed for", p.name, e); failed++; }
        setBusy(`${verb}ing… ${done + failed}/${targets.length}`);
      }
    } finally { setBusy(null); }
    S.undo = { ...pre, fileUndo: async () => {
      for (const u of undos.reverse()) { try { await u(); } catch (e) { console.warn(e); } }
    } };
    clearMultiSel();
    ensureVisible();
    render();
    toast(`${done} photo${done === 1 ? "" : "s"} updated${failed ? `, ${failed} failed` : ""}. One Undo reverts all of it.`, failed ? "warn" : "info", 6000);
  }

  // ---- CSV export ----------------------------------------------------------
  function csvField(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;   // spreadsheet formula-injection guard
    if (/[",\n;]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function exportCsv() {
    if (!S.photos.length) { toast("Nothing to export — open a folder or connect to Photos first.", "info", 4500); return; }
    const rows = [["filename", "status", "caption", "keywords", "date", "latitude", "longitude", "inaturalist"].join(",")];
    for (const p of S.photos) {
      rows.push([
        csvField(p.name), csvField(p.status), csvField(p.caption),
        csvField((p.keywords || []).join("; ")),
        csvField(p.datetime ? fmtDate(p.datetime) : ""),
        csvField(p.lat != null ? p.lat.toFixed(6) : ""),
        csvField(p.lon != null ? p.lon.toFixed(6) : ""),
        csvField(p.inatUrl || ""),
      ].join(","));
    }
    // BOM so Excel opens it as UTF-8 without an import wizard.
    const blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `tagit-${fmtDay(new Date())}.csv` });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`Exported ${S.photos.length} photo${S.photos.length === 1 ? "" : "s"} to CSV.`, "info", 4000);
  }

  // ---- the core actions ----------------------------------------------------
  function current() { return S.photos[S.idx]; }
  function visibleIdx() {
    return S.photos.map((p, i) => (S.statusFilter.has(p.status) ? i : -1)).filter((i) => i >= 0);
  }
  function goNext() {
    const after = visibleIdx().filter((i) => i > S.idx);
    if (after.length) { S.idx = after[0]; syncSelectionFromCaption(); render(); return true; }
    return false;
  }
  function goPrev() {
    const before = visibleIdx().filter((i) => i < S.idx);
    if (before.length) { S.idx = before[before.length - 1]; syncSelectionFromCaption(); render(); return true; }
    return false;
  }
  // ---- end-of-folder recap -------------------------------------------------
  function computeSessionStats() {
    const labelled = S.photos.filter((p) => p.status === "labelled");
    const taxa = new Set(), keywords = new Set();
    for (const p of labelled) {
      for (const t of taxaFromCaption(p.caption)) taxa.add(t.toLowerCase());
      for (const k of (p.keywords || [])) keywords.add(k.toLowerCase());
    }
    return {
      total: S.photos.length,
      labelled: labelled.length,
      undetermined: S.photos.filter((p) => p.status === "undetermined").length,
      skipped: S.photos.filter((p) => p.status === "skipped").length,
      deleted: S.photos.filter((p) => p.status === "deleted").length,
      taxa: taxa.size,
      keywords: keywords.size,
    };
  }
  function showCongrats() {
    const s = computeSessionStats();
    $("congratsSub").textContent = `You worked through ${s.total} photo${s.total === 1 ? "" : "s"} in this folder.`;
    const stat = (label, value) => el("div", { className: "congrats-stat" }, [
      el("div", { className: "congrats-num", textContent: String(value) }),
      el("div", { className: "congrats-label", textContent: label }),
    ]);
    const box = $("congratsStats"); box.innerHTML = "";
    box.append(stat("Labelled", s.labelled));
    box.append(stat("Taxa identified", s.taxa));
    box.append(stat("Keywords added", s.keywords));
    if (s.undetermined) box.append(stat("Undetermined", s.undetermined));
    if (s.skipped) box.append(stat("Skipped", s.skipped));
    if (s.deleted) box.append(stat("Deleted", s.deleted));
    closeAllModals();               // don't let an open utility modal obscure the celebration
    $("congratsOverlay").hidden = false;
  }
  function hideCongrats() { $("congratsOverlay").hidden = true; }

  // ---- generic modal open/close (iNaturalist, Navigate & act) --------------
  function openModal(id) { $(id).hidden = false; }
  // The match-review modal needs to report its summary and clear S.matchQueue
  // whenever it closes — not just via its own × button, but also Escape and
  // clicking the backdrop, so an abandoned review never leaves stale queue
  // state or skips the "done" toast.
  function closeModal(id) {
    if (id === "inatMatchModal" && S.matchQueue) { finishMatchReview(); return; }
    $(id).hidden = true;
  }
  function closeAllModals() {
    document.querySelectorAll(".modal-overlay:not([hidden])").forEach((m) => {
      if (m.id === "inatMatchModal" && S.matchQueue) finishMatchReview();
      else m.hidden = true;
    });
  }

  // Move on after an action; if the view is exhausted, say so — and if the
  // whole folder is actually done (nothing left untouched), celebrate it.
  function afterAdvanceFailed() {
    syncSelectionFromCaption();
    render();
    const remainingUntouched = S.photos.filter((p) => p.status === "untouched").length;
    if (S.photos.length && remainingUntouched === 0) showCongrats();
    else toast("All caught up — nothing more to show in the current “Show” filter.", "info", 2800);
  }
  function advance() {
    if (!goNext()) afterAdvanceFailed();
  }
  function ensureVisible() {
    const vis = visibleIdx();
    if (!vis.length || vis.includes(S.idx)) return;
    const after = vis.filter((i) => i >= S.idx);
    S.idx = after.length ? after[0] : vis[vis.length - 1];
  }

  function snapshot(fileUndo) {
    // Null the handle/preview on the copies so revisiting after undo re-acquires
    // a fresh handle (the file may have been moved, invalidating the old one).
    S.undo = {
      photos: S.photos.map((p) => ({ ...p, fileHandle: null, url: null })),
      idx: S.idx, lastCaption: S.lastCaption, recent: [...S.recent], fileUndo,
    };
  }
  async function doUndo() {
    if (!S.undo) return;
    const u = S.undo;
    try { await u.fileUndo(); } catch (e) { console.warn(e); }
    S.photos = u.photos; S.idx = Math.min(u.idx, S.photos.length - 1);
    S.lastCaption = u.lastCaption; S.recent = u.recent; S.undo = null;
    syncSelectionFromCaption();
    render();
  }

  function noteRecent(taxa) {
    if (!taxa.length) return;
    S.recent = [...new Set([...taxa, ...S.recent])].slice(0, CFG.maxRecent);
    LS.set("recent", S.recent);
  }
  function rememberFamilies(taxa) {
    for (const t of taxa) {
      let fam = familyFor(t);
      if (!fam && taxa.length === 1 && $("familyBox")) fam = $("familyBox").value.trim();
      if (!fam) continue;
      if (!S.sessionFamilies.has(t)) S.sessionFamilies.set(t, fam);
      growTaxonomy(t, fam);                                 // add new taxa to the taxonomy so they persist
    }
  }

  // Shared move+record: write optional bytes, move to `status`, snapshot for undo.
  // origBytes (fs mode only) restores the file's original metadata on undo.
  async function applyStatus(p, status, caption, bytes, taxa, keywords, origBytes) {
    const before = { ...p };
    const res = S.mode === "applephotos" ? await commitApplePhotos(p, status, caption, keywords) : await commit(p, bytes, status, taxa);
    let fileUndo = res.undo;
    if (origBytes && S.mode === "fs") {
      const baseUndo = res.undo;
      fileUndo = async () => {
        await baseUndo();                                        // move the file back
        try { await writeBytesTo(p.parentHandle, p.name, origBytes); }  // restore original metadata
        catch (e) { console.warn("metadata restore on undo failed", e); }
      };
    }
    snapshot(fileUndo);
    Object.assign(S.undo.photos[S.photos.indexOf(p)], before, { fileHandle: null, url: null });
    if (caption != null) { p.caption = caption; S.lastCaption = caption; }
    if (keywords != null) p.keywords = keywords;
    p.status = status;
    if (taxa) { rememberFamilies(taxa); noteRecent(taxa); }
  }

  // Assemble the bytes to write: original (optionally watermarked) + caption,
  // keywords and any existing iNaturalist link.
  async function composeSaveBytes(p, caption, keywords) {
    let bytes = await getFileBytes(p);
    if (S.watermark.enabled && S.watermark.text.trim())
      bytes = await applyWatermark(bytes, S.watermark.text.trim(), p.orientation, S.watermark);
    return TagMeta.writeCaption(bytes, caption, keywords, p.inatUrl || "");
  }

  // Burn a text watermark into the image at the chosen corner, font and size,
  // then restore the original EXIF (date/GPS/orientation) which the canvas
  // re-encode drops.
  const WM_FONT_STACK = {
    sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    mono: "ui-monospace, 'SF Mono', Menlo, monospace",
  };
  async function applyWatermark(u8, text, orientation, opts) {
    try {
      const bmp = await createImageBitmap(new Blob([u8], { type: "image/jpeg" }));
      const w = bmp.width, h = bmp.height;
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();

      const sizePct = (opts && opts.sizePct) || 2.8;
      const fontStack = WM_FONT_STACK[(opts && opts.font) || "sans"] || WM_FONT_STACK.sans;
      const position = (opts && opts.position) || "br";
      const fs = Math.max(11, Math.round(Math.min(w, h) * (sizePct / 100)));
      const pad = Math.round(fs * 0.7);
      ctx.font = `600 ${fs}px ${fontStack}`;

      const atRight = position === "br" || position === "tr";
      const atBottom = position === "br" || position === "bl";
      ctx.textAlign = atRight ? "right" : "left";
      ctx.textBaseline = atBottom ? "bottom" : "top";
      const x = atRight ? w - pad : pad;
      const y = atBottom ? h - pad : pad;

      ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillText(text, x + 1, y + 1);
      ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillText(text, x, y);

      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
      return TagMeta.copyExif(u8, new Uint8Array(await blob.arrayBuffer()));
    } catch (e) { console.warn("watermark failed, saving without it", e); return u8; }
  }

  async function finalizeCaptionSave(p, caption, taxa) {
    if (!p) return false;
    if (S._saving) return false;   // a double-click/double-Enter must not save twice
    S._saving = true;
    setBusy("Saving…");
    try {
      const keywords = keywordsForSave(taxa);
      if (S.mode === "applephotos") {
        await applyStatus(p, "labelled", caption, null, taxa, keywords, null);
      } else {
        const origBytes = S.mode === "fs" ? await getFileBytes(p) : null;
        const bytes = await composeSaveBytes(p, caption, keywords);
        await applyStatus(p, "labelled", caption, bytes, taxa, keywords, origBytes);
      }
      return true;
    } catch (e) {
      console.error(e);
      toast("Couldn’t save this photo: " + (e.message || e), "warn", 7000);
      return false;
    } finally { S._saving = false; setBusy(null); }
  }

  async function doSave() {
    const caption = $("captionBox").value.trim();
    if (!caption) { toast("Add a taxon or type a caption first.", "info", 2500); return; }
    // Derive taxa from the caption text itself (not S.selected) so keywords stay
    // correct even after the text was set some other way (copy last, typed by
    // hand, filled from an iNaturalist suggestion) without S.selected being kept
    // in sync.
    if (await finalizeCaptionSave(current(), caption, taxaFromCaption(caption))) advance();
  }
  async function instantSave(taxa) {
    const caption = composeForTaxa(taxa);
    if (!caption) return;
    if (await finalizeCaptionSave(current(), caption, taxa)) advance();
  }
  async function saveSameAsPrevious() {
    if (!S.lastCaption) { toast("Nothing saved yet to reuse.", "info", 2500); return; }
    const caption = S.lastCaption;
    if (await finalizeCaptionSave(current(), caption, taxaFromCaption(caption))) {
      toast(caption, "info", 1600);
      advance();
    }
  }

  async function markUndetermined() {
    const p = current();
    if (!p) return;
    setBusy("Saving…");
    try {
      const keywords = parseManualKeywords($("keywordsBox") && $("keywordsBox").value);
      if (S.mode === "applephotos") {
        await applyStatus(p, "undetermined", CFG.undeterminedCaption, null, null, keywords, null);
      } else {
        const origBytes = S.mode === "fs" ? await getFileBytes(p) : null;
        let bytes = null;
        try { bytes = await composeSaveBytes(p, CFG.undeterminedCaption, keywords); }
        catch (e) { console.warn("caption write failed, moving anyway", e); }
        await applyStatus(p, "undetermined", CFG.undeterminedCaption, bytes, null, keywords, origBytes);
      }
      advance();
    } catch (e) {
      console.error(e); toast("Couldn’t mark undetermined: " + (e.message || e), "warn", 7000);
    } finally { setBusy(null); }
  }
  async function skipCurrent() {
    const p = current();
    if (!p) return;
    try { await applyStatus(p, "skipped", null, null, null); advance(); }
    catch (e) { console.error(e); toast("Couldn’t skip: " + (e.message || e), "warn", 7000); }
  }
  async function discardCurrent() {
    const p = current();
    if (!p) return;
    try {
      await applyStatus(p, "deleted", null, null, null);
      if (!goNext()) { ensureVisible(); afterAdvanceFailed(); }
    } catch (e) { console.error(e); toast("Couldn’t delete: " + (e.message || e), "warn", 7000); }
  }
  async function rotateCurrent() {
    const p = current();
    if (!p) return;
    if (S.mode === "applephotos") { toast("Rotating isn't available for Photos library images yet.", "info", 5000); return; }
    setBusy("Rotating…");
    try {
      const { bytes, orientation } = TagMeta.rotateCW(await getFileBytes(p), p.orientation);
      if (S.mode === "download") downloadBytes(p.name, bytes);
      else p.fileHandle = await writeBytesTo(p.parentHandle, p.name, bytes);
      p.orientation = orientation; p.url = null;
    } catch (e) { toast("Rotate failed: " + (e.message || e), "warn"); }
    setBusy(null);
    render();
  }
  // Mirror the caption text between the sidebar box and the iNaturalist tab's
  // copy of it, so either one can be edited/saved from and both stay truthful.
  function setCaptionBox(text) {
    if ($("captionBox")) $("captionBox").value = text;
    if ($("inatCaptionBox")) $("inatCaptionBox").value = text;
  }
  // Load a photo's existing caption into "Caption to save" (and the selection
  // behind it) — wired to the caption line shown on the photo, so adopting
  // what's already there is one click instead of retyping it.
  function adoptCaption(p) {
    if (!p || !p.caption) return;
    S.selected = taxaFromCaption(p.caption);
    S.cf = /cf\./.test(p.caption);
    if ($("cfBox")) $("cfBox").checked = S.cf;
    setCaptionBox(p.caption);
    renderFamilyBox();
    toast("Caption loaded into “Caption to save”.", "info", 2200);
  }
  // The caption line of the photo-info overlay — clickable when there is one.
  function captionRow(p) {
    if (!p.caption) return el("div", { textContent: "No caption yet" });
    return el("div", {
      className: "meta-caption-row",
      textContent: "Caption: " + p.caption,
      title: "Click to load into “Caption to save”",
      onclick: () => adoptCaption(p),
    });
  }
  // ---- selection ------------------------------------------------------------
  function addTaxon(t) {
    t = t.trim();
    if (t && !S.selected.includes(t)) { S.selected.push(t); renderSelection(); updateCaptionBox(); }
  }
  function clearSelection() {
    S.selected = []; S.cf = false;
    if ($("cfBox")) $("cfBox").checked = false;
    setCaptionBox("");
    if ($("keywordsBox")) $("keywordsBox").value = "";
    renderSelection(); renderFamilyBox();
  }
  // Re-derive the taxon selection (and the caption box) from the current photo's
  // stored caption, so moving between photos always shows the right state and
  // never leaves the previous photo's caption stuck in the box.
  function syncSelectionFromCaption() {
    const p = current();
    S.selected = p ? taxaFromCaption(p.caption) : [];
    S.cf = p ? /cf\./.test(p.caption) : false;
    if ($("cfBox")) $("cfBox").checked = S.cf;
    renderSelection();
    setCaptionBox(composeForTaxa(S.selected));
    if ($("keywordsBox")) $("keywordsBox").value = manualKeywordsFromPhoto(p).join(", ");
    renderFamilyBox();
    // Never leave leftover search text (or a blinking cursor) sitting in the
    // taxon search box on the new photo — typing again should always start
    // a fresh search, not append to whatever was typed for the last one.
    const taxonInput = $("taxonInput");
    if (taxonInput) { taxonInput.value = ""; taxonInput.blur(); }
  }
  function updateCaptionBox() {
    setCaptionBox(composeForTaxa(S.selected));
    renderFamilyBox();
  }

  // =========================================================================
  // Rendering
  // =========================================================================
  function setBusy(msg) {
    $("busy").textContent = msg || "";
    $("busy").style.display = msg ? "block" : "none";
  }

  async function render() {
    const p = current();
    // The "Already tagged" status only ever occurs in Apple Photos mode —
    // its filter chip stays out of the folder workflow entirely.
    const preSeg = document.querySelector(".seg-preexisting");
    if (preSeg) preSeg.hidden = S.mode !== "applephotos";
    if (S._zoomPhoto !== p) {
      S._zoomPhoto = p; resetZoom();
      if (!$("mapModal").hidden) closeModal("mapModal");  // don't leave the old photo's location showing
    }
    renderCounts();
    if (!p) {
      $("photo").src = "";
      $("meta").hidden = true; $("meta").innerHTML = "";
      $("statusCorner").textContent = ""; $("statusCorner").hidden = true;
      renderSuggestions(); renderRecent(); renderSelection();
      renderInat(); renderPhotoControls(); renderInatPhotoStage(); renderApproxLocationBox();
      S._filmSig = null; rebuildFilmstrip();
      return;
    }
    // preview
    try {
      if (!p.url) p.url = URL.createObjectURL(await getFile(p));
      $("photo").src = p.url;
    } catch (e) {
      console.warn("preview failed", e);
      $("photo").src = "";
      toast("Couldn't load this photo's image: " + (e.message || e), "warn", 8000);
    }
    // Photos-mode images come over HTTP one at a time — quietly warm up the
    // next visible photo so advancing feels instant. And since each fetched
    // image is cached as a blob, evict the ones far from the current photo,
    // or a few hundred photos of browsing would quietly hold hundreds of MB.
    if (S.mode === "applephotos") {
      const after = visibleIdx().filter((i) => i > S.idx);
      const next = after.length ? S.photos[after[0]] : null;
      if (next && !next._apBlob) getFile(next).catch(() => {});
      S.photos.forEach((q, i) => {
        if (q._apBlob && Math.abs(i - S.idx) > 10) {
          if (q.url) { URL.revokeObjectURL(q.url); q.url = null; }
          q._apBlob = null;
        }
      });
    }

    // Everything about this photo overlays the bottom of the photo itself —
    // filename first, then date/time/locality/caption/keywords/link. Status
    // sits separately, bottom-right corner (under the map preview if shown).
    $("meta").innerHTML = "";
    $("meta").append(el("div", { className: "meta-filename", textContent: p.name }));
    const corner = $("statusCorner");
    corner.hidden = false;
    corner.textContent = STATUS_LABEL[p.status].text;
    corner.style.color = STATUS_LABEL[p.status].color;

    const bits = [];
    if (p.datetime) { bits.push("Date: " + fmtDay(p.datetime)); bits.push("Time: " + fmtTime(p.datetime)); }
    else bits.push("Date taken: unknown");
    const loc = suggestLocality(p.datetime);
    if (loc) bits.push("Locality (log): " + loc);
    for (const b of bits) $("meta").append(el("div", { textContent: b }));
    $("meta").append(captionRow(p));
    if (p.keywords && p.keywords.length) {
      $("meta").append(el("div", { className: "meta-overlay-kw", textContent: p.keywords.join(" · ") }));
    }
    if (p.inatUrl) {
      const d = el("div", { className: "meta-link" });
      d.append(el("a", { href: p.inatUrl, target: "_blank", rel: "noopener", textContent: "iNaturalist observation ↗" }));
      $("meta").append(d);
    }
    if (p.lat != null && p.lon != null) $("meta").append(mapToggleRow());
    else $("meta").append(estimateLocationRow());
    $("meta").hidden = !S.infoVisible;

    renderSuggestions(); renderRecent(); renderSelection();
    renderInat(); renderPhotoControls(); renderInatPhotoStage();
    // Keep the approximate-location box in sync on every render — without
    // this, saving/navigating inside the iNaturalist tab left the previous
    // photo's map showing even on photos that already have GPS.
    renderApproxLocationBox();
    // Filmstrip: full rebuild only when the set of visible photos (or a
    // status) actually changed; plain navigation just re-syncs highlights.
    const filmSig = visibleIdx().map((i) => i + S.photos[i].status[0]).join("|");
    if (filmSig !== S._filmSig) { S._filmSig = filmSig; rebuildFilmstrip(); }
    else syncFilmstrip();
    if (!$("captionBox").value) updateCaptionBox();
  }

  const STATUS_LABEL = {
    untouched: { text: "○ untouched", color: "#7a857d" },
    preexisting: { text: "◑ already tagged", color: "#3b7cc4" },
    labelled: { text: "✓ labelled", color: "#2f8f5b" },
    skipped: { text: "• skipped", color: "#b7791f" },
    undetermined: { text: "? undetermined", color: "#6d5bd0" },
    deleted: { text: "✗ deleted", color: "#c0392b" },
  };
  const _p2 = (n) => String(n).padStart(2, "0");
  function fmtDate(d) { return `${fmtDay(d)} ${fmtTime(d)}`; }
  function fmtDay(d) { return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`; }
  function fmtTime(d) { return `${_p2(d.getHours())}:${_p2(d.getMinutes())}`; }
  function renderCounts() {
    const c = { untouched: 0, preexisting: 0, labelled: 0, skipped: 0, undetermined: 0, deleted: 0 };
    for (const p of S.photos) c[p.status]++;
    const total = Math.max(S.photos.length, 1);
    const done = c.labelled + c.skipped + c.deleted;
    $("barDone").style.width = Math.round((100 * done) / total) + "%";
    if ($("barPre")) $("barPre").style.width = Math.round((100 * c.preexisting) / total) + "%";
    $("barUndet").style.width = Math.round((100 * c.undetermined) / total) + "%";
    // "already tagged" only exists in Apple Photos mode — only mention it
    // when there actually are some, so the folder workflow's text is unchanged.
    const parts = [`${c.untouched} untouched`];
    if (c.preexisting) parts.push(`${c.preexisting} already tagged`);
    parts.push(`${c.labelled} labelled`, `${c.skipped} skipped`,
               `${c.undetermined} undetermined`, `${c.deleted} deleted`);
    $("progressText").textContent =
      parts.join(", ") + ` (showing #${S.photos.length ? S.idx + 1 : 0} of ${S.photos.length})`;
  }
  function renderSuggestions() {
    // The whole section stays hidden until an observation log is loaded —
    // no point showing "no matches" when there's nothing to match against.
    if ($("suggSection")) $("suggSection").hidden = S.obs.length === 0;
    if (!S.obs.length) return;
    const box = $("suggestions"); box.innerHTML = "";
    const sp = current() ? suggestSpecies(current().datetime) : [];
    if (!sp.length) { box.append(el("em", { textContent: "No observation-log matches near this time.", className: "muted" })); return; }
    sp.forEach((s, i) => {
      const label = i < 9 ? `${i + 1}: ${s}` : s;
      box.append(el("button", { className: "chip-btn", textContent: label, onclick: () => instantSave([...new Set([...S.selected, s])]) }));
    });
  }
  function renderRecent() {
    const box = $("recent"); box.innerHTML = "";
    if (!S.recent.length) { box.append(el("em", { textContent: "None yet — saved taxa appear here.", className: "muted" })); return; }
    // Adds to the current determination without saving/advancing — picking a
    // recently-used taxon is a starting point you might still adjust (add a
    // second taxon, tick cf.) before actually saving.
    S.recent.forEach((s) => box.append(el("button", { className: "chip-btn", textContent: s, onclick: () => addTaxon(s) })));
  }
  // Selected taxa aren't shown as chips — the caption box (and the photo
  // overlay once saved) already reflects them, so a separate chip list would
  // just duplicate that and cost vertical space. Kept as a no-op so existing
  // call sites don't need to change.
  function renderSelection() {}
  function renderFamilyBox() {
    const holder = $("familyHolder"); holder.innerHTML = "";
    if (S.selected.length === 1 && !lookupFamily(S.selected[0])) {
      const prefill = S.sessionFamilies.get(S.selected[0]) || "";
      holder.append(el("label", { className: "field-label", textContent: "Family (new taxon — added to your taxonomy on save)" }));
      const inp = el("input", { id: "familyBox", className: "input", value: prefill, placeholder: "e.g. Asteraceae" });
      inp.addEventListener("input", () => { setCaptionBox(composeForTaxa(S.selected)); });
      holder.append(inp);
    }
  }

  // ---- photo zoom & pan ----------------------------------------------------
  // Shared by the main stage image and the iNaturalist tab's own photo preview
  // — wires click-to-zoom, wheel-zoom and drag-to-pan onto any (img, stage)
  // pair, and returns a reset() for that pair.
  function wireZoom(img, stage) {
    let scale = 1, tx = 0, ty = 0, dragging = false, sx = 0, sy = 0, moved = false;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const apply = () => {
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      img.style.cursor = scale > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in";
    };
    const zoomAt = (clientX, clientY, factor) => {
      const rect = img.getBoundingClientRect();
      const cx = clientX - (rect.left + rect.width / 2);
      const cy = clientY - (rect.top + rect.height / 2);
      const s2 = clamp(scale * factor, 1, 8);
      tx += cx * (1 - s2 / scale);
      ty += cy * (1 - s2 / scale);
      scale = s2;
      if (scale <= 1.001) { scale = 1; tx = 0; ty = 0; }
      apply();
    };
    const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };

    stage.addEventListener("wheel", (e) => {
      if (!img.getAttribute("src")) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.18 : 1 / 1.18);
    }, { passive: false });

    img.addEventListener("mousedown", (e) => {
      moved = false;                                       // reset at the start of every press
      if (scale <= 1) return;                              // only pan when zoomed in
      dragging = true; sx = e.clientX - tx; sy = e.clientY - ty;
      e.preventDefault(); apply();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      tx = e.clientX - sx; ty = e.clientY - sy; moved = true; apply();
    });
    window.addEventListener("mouseup", () => { if (dragging) { dragging = false; apply(); } });

    img.addEventListener("click", (e) => {
      if (moved) { moved = false; return; }              // a drag, not a click
      if (scale === 1) zoomAt(e.clientX, e.clientY, 2.5); // click to zoom in at point
      else reset();                                       // click again to zoom out
    });
    img.addEventListener("dblclick", (e) => { e.preventDefault(); reset(); });
    return reset;
  }
  let resetZoom = () => {};
  function setupZoom() {
    const stage = document.querySelector(".stage");
    const img = $("photo");
    if (stage && img) resetZoom = wireZoom(img, stage);
  }
  let resetInatZoom = () => {};
  function setupInatZoom() {
    const stage = document.querySelector(".inat-stage");
    const img = $("inatPhotoImg");
    if (stage && img) resetInatZoom = wireZoom(img, stage);
  }

  // ---- autocomplete dropdown ----------------------------------------------
  function setupAutocomplete() {
    const input = $("taxonInput");
    const menu = $("acMenu");
    let items = [], matches = [], hi = -1;
    const close = () => { menu.style.display = "none"; items = []; matches = []; hi = -1; };
    const open = () => {
      const q = input.value.trim().toLowerCase();
      menu.innerHTML = "";
      matches = [];
      if (q) {
        const qWords = q.split(/\s+/).filter(Boolean);
        matches = S.choices.filter((c) => {
          const lc = c.toLowerCase();
          return lc.includes(q) || matchesAbbrev(lc, qWords);
        }).slice(0, 50);
      }
      items = matches.slice();
      const exact = q && S.choices.some((c) => c.toLowerCase() === q);
      matches.forEach((m, i) => {
        menu.append(el("div", { className: "ac-item", textContent: m, onmousedown: (e) => { e.preventDefault(); pickItem(m); } }));
      });
      if (q && !exact) {
        const addTxt = `＋ Add “${input.value.trim()}”`;
        items.push(input.value.trim());
        menu.append(el("div", { className: "ac-item ac-add", textContent: addTxt, onmousedown: (e) => { e.preventDefault(); pickItem(input.value.trim()); } }));
      }
      menu.style.display = items.length ? "block" : "none";
      hi = -1;
    };
    const pickItem = (t) => { addTaxon(t); input.value = ""; close(); input.focus(); };
    // Enter on a recognized taxon (typed abbreviation or arrow-key pick) is a
    // "this is my final answer" gesture — save immediately and move on, so a
    // whole photo can be tagged with one short type + Enter, no extra click.
    const pickMatchAndAdvance = (t) => {
      const taxa = [...new Set([...S.selected, t])];
      input.value = ""; close();
      // This moves to the next photo — leave the search box unfocused
      // there (syncSelectionFromCaption() clears/blurs it), rather than
      // re-focusing it here just to have it wiped out immediately after.
      instantSave(taxa);
    };
    const highlight = () => {
      [...menu.children].forEach((c, i) => c.classList.toggle("hi", i === hi));
    };
    input.addEventListener("input", open);
    input.addEventListener("focus", open);
    input.addEventListener("blur", () => setTimeout(close, 150));
    input.addEventListener("keydown", (e) => {
      if (menu.style.display === "none" && e.key !== "Enter") return;
      if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hi + 1, menu.children.length - 1); highlight(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(hi - 1, 0); highlight(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (hi >= 0 && items[hi] !== undefined) {
          if (hi < matches.length) pickMatchAndAdvance(items[hi]); else pickItem(items[hi]);
        } else if (matches.length) pickMatchAndAdvance(matches[0]);
        else if (input.value.trim()) pickItem(input.value.trim());
        else doSave();
      } else if (e.key === "Escape") close();
    });
  }

  // =========================================================================
  // Wiring
  // =========================================================================
  async function onManualConnectClick() {
    const token = $("photosConnectToken").value.trim();
    const baseUrl = ($("photosConnectUrl").value.trim() || "http://127.0.0.1:8765").replace(/\/+$/, "");
    if (!token) { $("photosConnectHint").textContent = "Paste the pairing code from the helper's window first."; return; }
    $("photosConnectHint").textContent = "Connecting…";
    try {
      await connectToApplePhotos(baseUrl, token);
      if (S.mode === "applephotos") closeModal("photosConnectModal");
      $("photosConnectToken").value = "";
      $("photosConnectHint").textContent = "";
    } catch (e) {
      console.error(e);
      $("photosConnectHint").textContent = "Couldn't connect: " + (e.message || e) + " — check the helper is running and the code is correct.";
    }
  }

  // Clicking "Connect to Photos" while already connected manages the
  // connection (change album / disconnect) instead of starting over.
  function onConnectPhotosButton() {
    $("photosConnectHint").textContent = "";
    const connected = S.mode === "applephotos" && S.applePhotos.token;
    $("photosConnectSetup").hidden = !!connected;
    $("photosConnectedBox").hidden = !connected;
    if (connected) $("photosConnectedAlbum").textContent = S.applePhotos.albumTitle || "Photos";
    openModal("photosConnectModal");
  }

  async function disconnectApplePhotos() {
    try { await apFetch("/quit", { method: "POST" }); } catch { /* helper may already be gone */ }
    S.applePhotos.token = "";
    S.mode = null;
    S.photos = []; S.idx = 0; S.undo = null;
    $("folderName").textContent = "No folder open";
    updateDeleteLabel();
    closeModal("photosConnectModal");
    render();
    toast("Disconnected — the helper has quit, and access to Photos is closed.", "info", 6000);
  }

  function wireButtons() {
    $("openFolder").onclick = openFolder;
    if ($("emptyOpen")) $("emptyOpen").onclick = openFolder;
    if ($("connectPhotosBtn")) $("connectPhotosBtn").onclick = onConnectPhotosButton;
    if ($("photosConnectBtn")) $("photosConnectBtn").onclick = onManualConnectClick;
    if ($("launchHelperLink")) $("launchHelperLink").onclick = (e) => { e.preventDefault(); launchHelperAutoPair(); };
    if ($("photosChangeAlbumBtn")) $("photosChangeAlbumBtn").onclick = () => {
      chooseAlbumFlow(true).catch((e) => toast("Couldn't list albums: " + (e.message || e), "warn", 7000));
    };
    if ($("photosDisconnectBtn")) $("photosDisconnectBtn").onclick = disconnectApplePhotos;
    $("saveBtn").onclick = doSave;
    $("copyLastBtn").onclick = saveSameAsPrevious;
    if ($("inatSaveBtn")) $("inatSaveBtn").onclick = doSave;

    // Keep the sidebar caption box and the iNaturalist tab's copy of it in sync
    // when either is edited by hand.
    $("captionBox").addEventListener("input", (e) => {
      if ($("inatCaptionBox")) $("inatCaptionBox").value = e.target.value;
    });
    if ($("inatCaptionBox")) $("inatCaptionBox").addEventListener("input", (e) => {
      $("captionBox").value = e.target.value;
    });

    // back to the setup page (taxonomies, iNaturalist, watermark, settings)
    $("setupBtn").onclick = () => openModal("setupModal");
    $("helpBtn").onclick = () => openModal("helpModal");

    // toggle the photo-info panel (map / date / time / caption / keywords)
    const toggleInfoVisible = () => {
      S.infoVisible = !S.infoVisible;
      LS.set("infoVisible", S.infoVisible);
      applyInfoVisibility();
    };
    $("infoToggleBtn").onclick = toggleInfoVisible;
    if ($("inatInfoToggleBtn")) $("inatInfoToggleBtn").onclick = toggleInfoVisible;

    // end-of-folder recap
    $("congratsCloseBtn").onclick = hideCongrats;
    $("congratsOverlay").addEventListener("click", (e) => { if (e.target.id === "congratsOverlay") hideCongrats(); });

    // iNaturalist post celebration
    if ($("inatCelebrateClose")) $("inatCelebrateClose").onclick = () => { $("inatCelebrate").hidden = true; clearTimeout(inatCelebrateTimer); };
    if ($("inatCelebrate")) $("inatCelebrate").addEventListener("click", (e) => {
      if (e.target.id === "inatCelebrate") { $("inatCelebrate").hidden = true; clearTimeout(inatCelebrateTimer); }
    });

    // iNaturalist / Navigate & act: full-height modals opened from a slim row
    $("inatModalBtn").onclick = () => { openModal("inatModal"); renderInatPhotoStage(); renderApproxLocationBox(); };
    $("navModalBtn").onclick = () => openModal("navModal");

    // Approximate-location picker (photos with no GPS)
    if ($("approxLocationClearBtn")) $("approxLocationClearBtn").onclick = () => { const p = current(); if (p) clearApproxLocation(p); };
    if ($("approxLocationReuseBtn")) $("approxLocationReuseBtn").onclick = () => {
      const p = current();
      if (p && S.lastApproxLocation) {
        const { lat, lon, radiusM } = S.lastApproxLocation;
        setApproxLocation(p, lat, lon, radiusM || radiusForZoom(ensureApproxMap().getZoom()));
        ensureApproxMap().setView([lat, lon], 8);
      }
    };
    // Changing precision by hand always wins — if a point is already placed,
    // resize its circle immediately rather than waiting for the next click.
    if ($("approxPrecisionSelect")) $("approxPrecisionSelect").addEventListener("change", (e) => {
      const p = current();
      const radiusM = +e.target.value;
      if (p && p.approxLat != null) {
        p.approxUncertaintyM = radiusM;
        drawApproxPoint(p.approxLat, p.approxLon, radiusM);
        S.lastApproxLocation = { lat: p.approxLat, lon: p.approxLon, radiusM };
        LS.set("lastApproxLocation", S.lastApproxLocation);
        updateApproxLocationStatus(p);
      }
    });

    // Estimate location from nearby (in time) GPS-tagged photos
    $("estimateLocationConfirmBtn").onclick = confirmEstimatedLocation;
    $("estimateLocationCancelBtn").onclick = () => closeModal("estimateLocationModal");

    // Small corner map preview on the photo — click (or Enter/Space) to enlarge
    $("mapCorner").addEventListener("click", openMapModal);
    $("mapCorner").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMapModal(); }
    });
    document.querySelectorAll(".modal-close").forEach((btn) => {
      btn.onclick = () => closeModal(btn.dataset.close);
    });
    document.querySelectorAll(".modal-overlay").forEach((overlay) => {
      overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(overlay.id); });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("congratsOverlay").hidden) hideCongrats();
      if ($("inatCelebrate") && !$("inatCelebrate").hidden) { $("inatCelebrate").hidden = true; clearTimeout(inatCelebrateTimer); }
      if (S.multiSel.size) clearMultiSel();
      closeAllModals();
    });
    $("prevBtn").onclick = goPrev;
    $("nextBtn").onclick = goNext;
    $("rotateBtn").onclick = rotateCurrent;
    $("undoBtn").onclick = doUndo;
    $("skipBtn").onclick = skipCurrent;
    $("undetBtn").onclick = markUndetermined;
    $("deleteBtn").onclick = discardCurrent;

    $("cfBox").addEventListener("change", (e) => { S.cf = e.target.checked; updateCaptionBox(); });

    // status filter checkboxes
    document.querySelectorAll("#statusFilter input").forEach((cb) => {
      cb.checked = S.statusFilter.has(cb.value);
      cb.addEventListener("change", () => {
        if (cb.checked) S.statusFilter.add(cb.value); else S.statusFilter.delete(cb.value);
        ensureVisible(); render();
      });
    });

    // taxonomy chooser (multi-select list rendered by renderTaxonomyList) + upload
    $("uploadTaxonomyBtn").onclick = () => $("taxonomyFile").click();
    $("taxonomyFile").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      beginTaxonomyUpload(f, await f.arrayBuffer());
    });
    $("taxAddBtn").onclick = commitTaxonomyUpload;
    $("taxCancelBtn").onclick = cancelTaxonomyUpload;
    $("refreshKeywordsBtn").onclick = refreshAllKeywords;
    if ($("exportCsvBtn")) $("exportCsvBtn").onclick = exportCsv;

    // filmstrip bulk actions
    if ($("bulkApplyBtn")) $("bulkApplyBtn").onclick = () => bulkApply("labelled");
    if ($("bulkSkipBtn")) $("bulkSkipBtn").onclick = () => bulkApply("skipped");
    if ($("bulkUndetBtn")) $("bulkUndetBtn").onclick = () => bulkApply("undetermined");
    if ($("bulkDeleteBtn")) $("bulkDeleteBtn").onclick = () => bulkApply("deleted");
    if ($("bulkClearBtn")) $("bulkClearBtn").onclick = clearMultiSel;

    // observation log
    $("obsFile").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      loadObservations(parseDelimited(decodeText(await f.arrayBuffer())).rows);
      renderSuggestions();                                  // reveal the section immediately
    });

    // manual keywords: re-compose is not needed (kept separate from caption),
    // but keep the box in sync-friendly state on the current photo.

    // watermark
    $("wmEnable").checked = S.watermark.enabled;
    $("wmText").value = S.watermark.text;
    $("wmPosition").value = S.watermark.position;
    $("wmFont").value = S.watermark.font;
    $("wmSize").value = S.watermark.sizePct;
    const saveWm = () => {
      S.watermark = {
        enabled: $("wmEnable").checked,
        text: $("wmText").value,
        position: $("wmPosition").value,
        font: $("wmFont").value,
        sizePct: Math.min(10, Math.max(1, (+$("wmSize").value) || 2.8)),
      };
      LS.set("watermark", S.watermark);
    };
    $("wmEnable").addEventListener("change", saveWm);
    $("wmText").addEventListener("input", saveWm);
    $("wmPosition").addEventListener("change", saveWm);
    $("wmFont").addEventListener("change", saveWm);
    $("wmSize").addEventListener("change", saveWm);

    // folder organization
    $("perSpeciesFolders").checked = S.perSpeciesFolders;
    $("perSpeciesFolders").addEventListener("change", (e) => {
      S.perSpeciesFolders = e.target.checked;
      LS.set("perSpeciesFolders", S.perSpeciesFolders);
    });

    // iNaturalist
    $("inatAskBtn").onclick = inatIdentify;
    $("inatCheckBtn").onclick = inatVerify;
    $("inatObsBtn").onclick = inatCreateObservation;
    $("inatSyncBtn").onclick = inatSyncObservations;

    // Screen an old collection for photos already posted to iNaturalist
    $("inatScreenBtn").onclick = () => openModal("inatScreenConfigModal");
    $("screenStartBtn").onclick = () => {
      const win = Math.max(1, +$("screenWindowMin").value || 5);
      closeModal("inatScreenConfigModal");
      inatScreenCollection(win);
    };
    $("matchSameBtn").onclick = matchConfirmSame;
    $("matchNotBtn").onclick = matchNotAMatch;
    $("matchSkipBtn").onclick = matchSkipPhoto;
    // Its × button, the backdrop, and Escape all route through closeModal /
    // closeAllModals, which special-case this modal id to call
    // finishMatchReview() — see closeModal().

    $("inatGeo").value = LS.get("inatGeo", "open");
    $("inatGeo").addEventListener("change", (e) => LS.set("inatGeo", e.target.value));
    $("inatToken").value = S.inatToken;
    updateInatStatus();
    // The token page shows a JSON snippet like {"api_token":"eyJhb…"} — most
    // people copy the whole thing. Accept that as-is and dig the token out,
    // so pasting can never be done "wrong".
    const normalizeInatToken = (raw) => {
      raw = (raw || "").trim();
      if (raw.includes("api_token")) {
        try {
          const j = JSON.parse(raw);
          if (j.api_token) return String(j.api_token);
        } catch {
          const m = raw.match(/"api_token"\s*:\s*"([^"]+)"/);
          if (m) return m[1];
        }
      }
      return raw;
    };
    // The token grants write access to the user's iNaturalist account for
    // ~24h — where it's kept is their call. "Remember" = localStorage
    // (survives browser restarts); off = sessionStorage (gone when the
    // browser closes). Default is off for anyone who hasn't opted in.
    const storeInatToken = () => {
      if (S.inatTokenRemember) { LS.set("inatToken", S.inatToken); SS.del("inatToken"); }
      else { SS.set("inatToken", S.inatToken); LS.del("inatToken"); }
    };
    if ($("inatRemember")) {
      $("inatRemember").checked = !!S.inatTokenRemember;
      $("inatRemember").addEventListener("change", (e) => {
        S.inatTokenRemember = e.target.checked;
        storeInatToken();
      });
    }
    $("inatToken").addEventListener("input", (e) => {
      const clean = normalizeInatToken(e.target.value);
      if (clean !== e.target.value) e.target.value = clean;
      S.inatToken = clean;
      storeInatToken();
      updateInatStatus();
    });
    // Pasting a token is a complete gesture — verify it right away instead
    // of making the user find and press Check too.
    $("inatToken").addEventListener("paste", () => {
      setTimeout(() => { if ((S.inatToken || "").length > 40) inatVerify(); }, 50);
    });

    // settings
    $("windowMin").value = CFG.suggestionWindowMin;
    $("clockOffset").value = CFG.cameraClockOffsetHours;
    $("windowMin").addEventListener("change", (e) => { CFG.suggestionWindowMin = +e.target.value || 5; LS.set("windowMin", CFG.suggestionWindowMin); render(); });
    $("clockOffset").addEventListener("change", (e) => { CFG.cameraClockOffsetHours = +e.target.value || 0; LS.set("clockOffset", CFG.cameraClockOffsetHours); });
  }

  function wireDropzone() {
    const dz = document.body;
    ["dragover", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => e.preventDefault()));
    dz.addEventListener("dragover", () => $("dropHint").classList.add("active"));
    dz.addEventListener("dragleave", () => $("dropHint").classList.remove("active"));
    dz.addEventListener("drop", async (e) => {
      $("dropHint").classList.remove("active");
      if (e.dataTransfer.files.length) await acceptDroppedFiles(e.dataTransfer.files);
    });
  }

  function wireKeyboard() {
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
      if (!S.photos.length) return;
      // Page-level shortcuts stay off while a dialog is open (Setup, Help,
      // Navigate & act, …) — otherwise a stray letter typed while focus sits
      // on a button inside one yanks focus to the taxon search box hidden
      // behind it, and arrows/digits/Delete would act on the background
      // photo while you're mid-dialog. The one deliberate exception is the
      // iNaturalist tab: it IS a photo-tagging surface, so navigation and
      // suggestion shortcuts keep working there (letters still don't grab
      // the search box, which is hidden behind it).
      const openOverlay = document.querySelector(".modal-overlay:not([hidden])");
      const inatOnly = !!openOverlay && openOverlay.id === "inatModal" &&
        !document.querySelector(".modal-overlay:not([hidden]):not(#inatModal)");
      const celebration = !$("congratsOverlay").hidden || ($("inatCelebrate") && !$("inatCelebrate").hidden);
      if ((openOverlay && !inatOnly) || celebration) return;
      const k = e.key;
      // Typing a letter with nothing focused starts a taxon search instead
      // of a stray single-letter shortcut — a species name is what you're
      // almost always about to type. Rotate/undo/etc. stay one click away
      // as buttons; digits and navigation keys are left alone below since
      // taxon names don't start with those.
      if (/^[a-zA-Z]$/.test(k) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!inatOnly) $("taxonInput").focus();
        return;
      }
      if (k === "ArrowRight") { e.preventDefault(); goNext(); }
      else if (k === "ArrowLeft") { e.preventDefault(); goPrev(); }
      else if (/^[1-9]$/.test(k)) {
        e.preventDefault();
        const sp = suggestSpecies(current().datetime);
        const n = +k;
        if (n <= sp.length) instantSave([...new Set([...S.selected, sp[n - 1]])]);
      } else if (k === "Delete" || k === "Backspace") {
        if (!S.selected.length) { e.preventDefault(); discardCurrent(); }
      }
    });
  }

  // ---- restore persisted data ---------------------------------------------
  function restore() {
    const obs = LS.get("obs", null);
    if (obs) { S.obs = obs.map((o) => ({ ...o, datetime: new Date(o.datetime) })); rebuildChoices(); $("obsStatus").textContent = `${S.obs.length} observations loaded (saved)`; }
    S.recent = LS.get("recent", []);
    // Token: localStorage if the user opted into remembering, else the
    // session-only copy. "Remember" state is inferred from where it lives.
    S.inatToken = LS.get("inatToken", "") || SS.get("inatToken", "");
    S.inatTokenRemember = !!LS.get("inatToken", "");
    S.mapVisible = LS.get("mapVisible", false);
    S.infoVisible = LS.get("infoVisible", true);
    S.watermark = LS.get("watermark", { enabled: false, text: "", position: "br", font: "sans", sizePct: 2.8 });
    S.perSpeciesFolders = LS.get("perSpeciesFolders", false);
    S.lastApproxLocation = LS.get("lastApproxLocation", null);
    CFG.suggestionWindowMin = LS.get("windowMin", CFG.suggestionWindowMin);
    CFG.cameraClockOffsetHours = LS.get("clockOffset", CFG.cameraClockOffsetHours);
  }

  // Show/hide the on-photo info overlay (filename, status, date, time,
  // caption, keywords), and reflect the state on the toggle button.
  function applyInfoVisibility() {
    if ($("meta")) $("meta").hidden = !S.infoVisible || !current();
    if ($("statusCorner")) $("statusCorner").hidden = !S.infoVisible || !current();
    if ($("inatPhotoMeta")) $("inatPhotoMeta").hidden = !S.infoVisible || !current();
    const btn = $("infoToggleBtn");
    btn.setAttribute("aria-pressed", String(S.infoVisible));
    btn.title = S.infoVisible ? "Hide photo info (filename, status, date, time, caption, keywords)" : "Show photo info (filename, status, date, time, caption, keywords)";
    const inatBtn = $("inatInfoToggleBtn");
    if (inatBtn) inatBtn.setAttribute("aria-pressed", String(S.infoVisible));
  }

  // ---- boot ----------------------------------------------------------------
  async function boot() {
    window.addEventListener("unhandledrejection", (e) => {
      console.error("unhandled", e.reason);
      toast("Unexpected error: " + (e.reason?.message || e.reason), "warn", 7000);
    });
    if (!window.showDirectoryPicker) $("noFsWarning").style.display = "block";
    await idb.open();
    restore();
    applyInfoVisibility();
    wireButtons(); wireDropzone(); wireKeyboard(); setupAutocomplete(); setupZoom(); setupInatZoom();
    render();
    // Discover taxonomies. On first run, enable all bundled ones by default;
    // otherwise restore the set the user had active (several can be on at once).
    await buildTaxonomyRegistry();
    const saved = LS.get("activeTaxonomies", null);
    if (saved === null) S.activeTaxonomies = new Set(S.taxonomies.filter((t) => t.source === "bundled").map((t) => t.id));
    else S.activeTaxonomies = new Set(saved.filter((id) => S.taxonomies.some((t) => t.id === id)));
    LS.set("activeTaxonomies", [...S.activeTaxonomies]);
    renderTaxonomyList();
    await rebuildTaxa();
    // offer to reopen last folder (needs a click for permission on most builds)
    const last = await idb.get("lastFolder");
    if (last) {
      $("reopenBtn").style.display = "inline-block";
      $("reopenBtn").textContent = `Reopen “${last.name}”`;
      $("reopenBtn").onclick = reopenLastFolder;
    }
    // First-ever visit: show the how-it-works/privacy panel unprompted, so
    // "nothing is uploaded" isn't just a small badge someone has to notice.
    if (!LS.get("seenWelcome", false)) {
      LS.set("seenWelcome", true);
      openModal("helpModal");
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
