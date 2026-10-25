// File-name and path safety for anything that comes from the network or the Library window.
const path = require('path');
const fs = require('fs');

const { VIDEO_EXTS, IMPORT_EXTS } = require('./meta');

const VIDEO_EXT = new Set(VIDEO_EXTS);
const IMPORT_EXT = new Set(IMPORT_EXTS);
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// A single path segment that's safe on Windows: no separators, no control or reserved
// characters, no trailing dots/spaces, not a device name, not too long.
function safeName(name, fallback = 'file') {
  let s = String(name || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!s || s === '.' || s === '..') s = fallback;
  if (RESERVED.test(s)) s = '_' + s;
  if (s.length > 180) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 180 - ext.length).trim() + ext;
  }
  return s;
}

// Resolve `rel` under `root` and refuse anything that escapes it.
function inside(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  const back = path.relative(base, full);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(`Path escapes ${base}: ${rel}`);
  }
  return full;
}

// "name.mp4" -> "name (2).mp4" ... until it doesn't exist. Never overwrite.
function uniquePath(full, taken = () => false) {
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const stem = path.basename(full, ext);
  let candidate = full;
  for (let i = 2; fs.existsSync(candidate) || taken(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

const isVideo = (p) => VIDEO_EXT.has(path.extname(p).toLowerCase());
const isImportable = (p) => IMPORT_EXT.has(path.extname(p).toLowerCase());

module.exports = { VIDEO_EXT, IMPORT_EXT, safeName, inside, uniquePath, isVideo, isImportable };
