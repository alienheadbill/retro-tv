// The media library index: media/.retrotv/library.json, keyed by media-relative path.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inside, uniquePath, safeName, isImportable } = require('./paths');
const { probe } = require('./probe');

const { placement, guessMeta } = require('./meta');

function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

class Library {
  constructor(mediaDir) {
    this.root = path.resolve(mediaDir);
    this.dataDir = path.join(this.root, '.retrotv');
    this.file = path.join(this.dataDir, 'library.json');
    this.entries = {};
    this.load();
  }

  load() {
    try {
      this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8')).entries || {};
    } catch {
      this.entries = {};
    }
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  rel(full) {
    return path.relative(this.root, full).split(path.sep).join('/');
  }

  abs(rel) {
    return inside(this.root, rel);
  }

  // Walk media/ and bring the index up to date. Files that vanished are flagged, not forgotten,
  // so their metadata survives a drive being unplugged.
  scan() {
    const seen = new Set();
    const walk = (dir) => {
      let list;
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (isImportable(e.name) && !e.name.endsWith('.part')) {
          const rel = this.rel(full);
          const st = fs.statSync(full);
          seen.add(rel);
          const old = this.entries[rel];
          const entry = {
            ...(old || {}),
            path: rel,
            size: st.size,
            mtime: Math.floor(st.mtimeMs),
            missing: false,
            meta: { ...guessMeta(rel), ...((old && old.meta) || {}) },
          };
          if (old && (old.size !== st.size || old.mtime !== entry.mtime)) {
            delete entry.probe;
            delete entry.md5;
          }
          this.entries[rel] = entry;
        }
      }
    };
    walk(this.root);
    for (const rel of Object.keys(this.entries)) if (!seen.has(rel)) this.entries[rel].missing = true;
    this.save();
    return this.list();
  }

  list() {
    return Object.values(this.entries).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  get(rel) {
    return this.entries[rel] || null;
  }

  update(rel, patch) {
    const e = this.entries[rel];
    if (!e) throw new Error('Not in library: ' + rel);
    e.meta = { ...e.meta, ...patch };
    for (const k of Object.keys(e.meta)) if (e.meta[k] === null || e.meta[k] === '') delete e.meta[k];
    this.save();
    return e;
  }

  // Add (or refresh) an entry for a file that just arrived, with known metadata.
  add(full, meta = {}, extra = {}) {
    const rel = this.rel(full);
    const st = fs.statSync(full);
    this.entries[rel] = {
      ...(this.entries[rel] || {}),
      path: rel,
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
      missing: false,
      ...extra,
      meta: { ...guessMeta(rel), ...meta, importedAt: new Date().toISOString() },
    };
    this.save();
    return this.entries[rel];
  }

  findByMd5(md5) {
    return md5 ? this.list().find((e) => e.md5 === md5 && !e.missing) || null : null;
  }

  findBySource(sourceUrl) {
    return this.list().find((e) => e.meta && e.meta.sourceUrl === sourceUrl && !e.missing) || null;
  }

  // Move a library file somewhere else inside media/ (e.g. inbox -> a channel's show folder).
  move(rel, destDirRel, newName) {
    const from = this.abs(rel);
    const destDir = this.abs(destDirRel);
    fs.mkdirSync(destDir, { recursive: true });
    const to = uniquePath(path.join(destDir, safeName(newName || path.basename(from))));
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(from);
    }
    const entry = this.entries[rel];
    delete this.entries[rel];
    const newRel = this.rel(to);
    // The new folder decides role and show; everything else the user set is kept.
    const meta = { ...guessMeta(newRel), ...(entry ? entry.meta : {}), ...placement(newRel.split('/')) };
    this.entries[newRel] = { ...(entry || {}), path: newRel, meta };
    this.save();
    return this.entries[newRel];
  }

  // Copy a file from anywhere on disk into media/ (the original is never touched).
  async importCopy(src, destDirRel, meta = {}) {
    if (!isImportable(src)) throw new Error('Not a video or subtitle file: ' + path.basename(src));
    const destDir = this.abs(destDirRel);
    fs.mkdirSync(destDir, { recursive: true });
    const to = uniquePath(path.join(destDir, safeName(path.basename(src))));
    await fs.promises.copyFile(src, to, fs.constants.COPYFILE_EXCL);
    return this.add(to, { source: 'import', ...meta });
  }

  async hash(rel) {
    const e = this.entries[rel];
    e.md5 = await md5File(this.abs(rel));
    this.save();
    return e;
  }

  async probe(rel, ffprobe) {
    const e = this.entries[rel];
    if (!e || e.missing) return e;
    const p = await probe(this.abs(rel), ffprobe);
    if (p) {
      e.probe = { ...p, at: new Date().toISOString() };
      this.save();
    }
    return e;
  }
}

module.exports = { Library, guessMeta, placement, md5File };
