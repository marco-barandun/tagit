// =============================================================================
// metadata.js — read & write JPEG caption / orientation entirely in the browser
//
// Reading uses exifr (comprehensive: EXIF, GPS, XMP, IPTC).
// Writing uses piexifjs for the EXIF block, plus hand-built XMP (APP1) and
// IPTC (APP13) segments, so all three fields Apple Photos treats as the
// "caption" are written together:
//     EXIF:ImageDescription, XMP-dc:description, IPTC:Caption-Abstract
//
// Everything here operates on the raw bytes of a JPEG (Uint8Array). Nothing is
// uploaded anywhere — the file never leaves the machine.
// =============================================================================

const TagMeta = (() => {
  // ---- byte helpers --------------------------------------------------------
  function u8ToBinary(u8) {
    let s = "";
    const CHUNK = 0x8000;                       // chunk to avoid arg-count limits
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return s;
  }
  function binaryToU8(bin) {
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 0xff;
    return u8;
  }
  const enc = new TextEncoder();
  function strBytes(str) { return enc.encode(str); }      // UTF-8
  function asciiBytes(str) {
    const u8 = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i) & 0xff;
    return u8;
  }
  function toAscii(s) { return s.replace(/[^\x00-\x7F]/g, "?"); }
  function matchAt(u8, off, str) {
    for (let i = 0; i < str.length; i++) {
      if (u8[off + i] !== str.charCodeAt(i)) return false;
    }
    return true;
  }
  function concat(chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  // ---- reading -------------------------------------------------------------
  // Returns { datetime: Date|null, lat, lon, caption, orientation }.
  async function readMeta(file) {
    let data = {};
    try {
      data = await exifr.parse(file, {
        tiff: true, ifd0: true, exif: true, gps: true, xmp: true, iptc: true,
        translateKeys: true, translateValues: false, reviveValues: true,
        mergeOutput: true
      }) || {};
    } catch (e) { data = {}; }

    let dt = data.DateTimeOriginal || data.CreateDate || data.ModifyDate || null;
    if (dt && !(dt instanceof Date)) dt = new Date(dt);
    if (dt && isNaN(dt.getTime())) dt = null;

    const lat = (typeof data.latitude === "number") ? data.latitude : null;
    const lon = (typeof data.longitude === "number") ? data.longitude : null;

    // Prefer IPTC Caption-Abstract, then XMP description, then EXIF ImageDescription
    let caption =
      data["Caption-Abstract"] || data.Caption || data.description ||
      data.ImageDescription || "";
    if (caption && typeof caption === "object") {         // XMP alt-lang object
      caption = caption.value || caption["x-default"] || "";
    }
    caption = (caption || "").toString().trim();

    let orientation = data.Orientation;
    if (typeof orientation !== "number") orientation = 1;

    // Keywords: XMP dc:subject (array) or IPTC Keywords (array or delimited string)
    let keywords = data.subject || data.Keywords || data.keywords || [];
    if (typeof keywords === "string") keywords = keywords.split(/[;,]\s*/);
    if (!Array.isArray(keywords)) keywords = keywords ? [String(keywords)] : [];
    keywords = [...new Set(keywords.map((k) => String(k).trim()).filter(Boolean))];

    // iNaturalist observation link, stashed in XMP dc:identifier
    let inatUrl = data.Identifier || data.identifier || "";
    if (Array.isArray(inatUrl)) inatUrl = inatUrl[0] || "";
    inatUrl = String(inatUrl || "").trim();

    return { datetime: dt, lat, lon, caption, orientation, keywords, inatUrl };
  }

  // ---- EXIF ImageDescription (via piexif) ----------------------------------
  function setExifTag(u8, tag, value) {
    const bin = u8ToBinary(u8);
    let obj;
    try { obj = piexif.load(bin); }
    catch (e) { obj = { "0th": {}, Exif: {}, GPS: {}, "1st": {}, thumbnail: null }; }
    obj["0th"][tag] = value;
    const exifStr = piexif.dump(obj);
    return binaryToU8(piexif.insert(exifStr, bin));
  }

  // ---- XMP (APP1) ----------------------------------------------------------
  function xmlEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function buildXmpPacket(caption, keywords, identifier) {
    const esc = xmlEsc(caption);
    const subj = (keywords && keywords.length)
      ? "<dc:subject><rdf:Bag>" + keywords.map((k) => "<rdf:li>" + xmlEsc(k) + "</rdf:li>").join("") + "</rdf:Bag></dc:subject>"
      : "";
    const ident = identifier ? "<dc:identifier>" + xmlEsc(identifier) + "</dc:identifier>" : "";
    return (
      '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">' +
      "<dc:description><rdf:Alt>" +
      '<rdf:li xml:lang="x-default">' + esc + "</rdf:li>" +
      "</rdf:Alt></dc:description>" +
      "<photoshop:Headline>" + esc + "</photoshop:Headline>" +
      subj + ident +
      "</rdf:Description></rdf:RDF></x:xmpmeta>" +
      '<?xpacket end="w"?>'
    );
  }
  function buildXmpApp1(caption, keywords, identifier) {
    const ns = strBytes("http://ns.adobe.com/xap/1.0/\0");   // trailing NUL included
    const body = strBytes(buildXmpPacket(caption, keywords, identifier));
    const payloadLen = ns.length + body.length;
    const lenField = payloadLen + 2;                          // includes the length bytes
    const seg = new Uint8Array(4 + payloadLen);
    seg[0] = 0xff; seg[1] = 0xe1;
    seg[2] = (lenField >> 8) & 0xff; seg[3] = lenField & 0xff;
    seg.set(ns, 4);
    seg.set(body, 4 + ns.length);
    return seg;
  }

  // ---- IPTC (APP13 / Photoshop 8BIM) --------------------------------------
  function iptcDataset(record, dataset, valueBytes) {
    const head = new Uint8Array(5);
    head[0] = 0x1c; head[1] = record; head[2] = dataset;
    head[3] = (valueBytes.length >> 8) & 0xff; head[4] = valueBytes.length & 0xff;
    return concat([head, valueBytes]);
  }
  function buildIptcApp13(caption, keywords) {
    const captionBytes = strBytes(caption);                  // UTF-8
    const charset = iptcDataset(0x01, 0x5a, new Uint8Array([0x1b, 0x25, 0x47])); // 1:90 = ESC % G (UTF-8)
    const version = iptcDataset(0x02, 0x00, new Uint8Array([0x00, 0x02]));       // 2:00 record version
    const cap     = iptcDataset(0x02, 0x78, captionBytes);                       // 2:120 Caption-Abstract
    const parts = [charset, version, cap];
    for (const k of (keywords || [])) {                                          // 2:25 Keywords (repeatable)
      const kb = strBytes(k);
      if (kb.length && kb.length < 64) parts.push(iptcDataset(0x02, 0x19, kb));
    }
    let iptc = concat(parts);
    if (iptc.length % 2 === 1) iptc = concat([iptc, new Uint8Array([0x00])]);    // pad to even

    const sig = asciiBytes("8BIM");
    const idAndName = new Uint8Array([0x04, 0x04, 0x00, 0x00]);  // resource 0x0404 + empty name
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, iptc.length, false);  // big-endian
    const bim = concat([sig, idAndName, size, iptc]);

    const psHeader = strBytes("Photoshop 3.0\0");                // 14 bytes incl NUL
    const payload = concat([psHeader, bim]);
    const lenField = payload.length + 2;
    const seg = new Uint8Array(4 + payload.length);
    seg[0] = 0xff; seg[1] = 0xed;
    seg[2] = (lenField >> 8) & 0xff; seg[3] = lenField & 0xff;
    seg.set(payload, 4);
    return seg;
  }

  // Strip any existing XMP APP1 + Photoshop APP13, then insert fresh ones just
  // before the start-of-scan marker (everything else is copied verbatim).
  function injectXmpIptc(u8, caption, keywords, identifier) {
    if (u8[0] !== 0xff || u8[1] !== 0xd8) return u8;          // not a JPEG
    const xmpSeg = buildXmpApp1(caption, keywords, identifier);
    const iptcSeg = buildIptcApp13(caption, keywords);
    const out = [u8.subarray(0, 2)];                          // SOI
    let i = 2, inserted = false;
    const N = u8.length;
    while (i < N) {
      if (u8[i] !== 0xff) { out.push(u8.subarray(i)); break; }
      let marker = u8[i + 1];
      while (marker === 0xff && i + 2 < N) { i++; marker = u8[i + 1]; } // skip fill bytes
      if (marker === 0xda || marker === 0xd9) {               // SOS / EOI: insert, copy rest
        if (!inserted) { out.push(xmpSeg, iptcSeg); inserted = true; }
        out.push(u8.subarray(i));
        break;
      }
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { // standalone, no length
        out.push(u8.subarray(i, i + 2)); i += 2; continue;
      }
      const len = (u8[i + 2] << 8) | u8[i + 3];
      const segEnd = i + 2 + len;
      let skip = false;
      if (marker === 0xe1 && matchAt(u8, i + 4, "http://ns.adobe.com/xap/1.0/")) skip = true;
      if (marker === 0xed && matchAt(u8, i + 4, "Photoshop 3.0")) skip = true;
      if (!skip) out.push(u8.subarray(i, segEnd));
      i = segEnd;
    }
    if (!inserted) out.push(xmpSeg, iptcSeg);
    return concat(out);
  }

  // ---- public: write caption + keywords + iNaturalist link -----------------
  // caption  -> EXIF ImageDescription, XMP dc:description, IPTC Caption-Abstract
  // keywords -> XMP dc:subject, IPTC Keywords (array, deduplicated by caller)
  // identifier -> XMP dc:identifier (used to link an iNaturalist observation)
  function writeCaption(u8, caption, keywords, identifier) {
    let out = u8;
    try { out = setExifTag(out, piexif.ImageIFD.ImageDescription, toAscii(caption)); }
    catch (e) { console.warn("EXIF caption write skipped:", e); }
    out = injectXmpIptc(out, caption, keywords || [], identifier || "");
    return out;
  }

  // ---- public: rotate losslessly by advancing the EXIF orientation ---------
  const ORIENT_CW = { 1: 6, 6: 3, 3: 8, 8: 1, 2: 7, 7: 4, 4: 5, 5: 2 };
  function rotateCW(u8, currentOrientation) {
    const next = ORIENT_CW[currentOrientation] || 6;
    try { return { bytes: setExifTag(u8, piexif.ImageIFD.Orientation, next), orientation: next }; }
    catch (e) { return { bytes: u8, orientation: currentOrientation }; }
  }

  // ---- public: copy the EXIF block from one JPEG into another --------------
  // Used after watermarking (which re-encodes the pixels and drops EXIF) to
  // restore date/GPS/orientation from the original.
  function copyExif(srcU8, destU8) {
    try {
      let obj;
      try { obj = piexif.load(u8ToBinary(srcU8)); } catch (e) { return destU8; }
      const exifStr = piexif.dump(obj);
      return binaryToU8(piexif.insert(exifStr, u8ToBinary(destU8)));
    } catch (e) { return destU8; }
  }

  return { readMeta, writeCaption, rotateCW, copyExif };
})();
