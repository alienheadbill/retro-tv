'use strict';
// Linked folders: videos on other drives (or a network share) used where they are, without
// copying. channels.json "settings.linkedFolders": [{ "path": "E:/Media/Rugrats", "channel": 22 }].
// Subfolders become show names, like channel folders. A drive that isn't plugged in is skipped.
// Lengths are measured with ffprobe in the background and remembered by file (path, size, date).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { isVideo, isImportable } = require('./paths');
const { probe } = require('./probe');

// What's in a folder: videos the TV can use and ones that need converting first, counted all the way down.
function count(folder) {
  let videos = 0;
  let convert = 0;
  let bytes = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (isVideo(e.name)) {
        videos++;
        try {
          bytes += fs.statSync(full).size;
        } catch {}
      } else if (isImportable(e.name)) convert++;
    }
  };
  walk(folder);
  return { videos, convert, bytes };
}

// A picked folder, one level down, for choosing which subfolder goes to which channel.
function describe(folder) {
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  const direct = entries.filter((e) => e.isFile() && (isVideo(e.name) || isImportable(e.name))).length;
  const subfolders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && !/^system volume information$/i.test(e.name))
    .map((e) => ({ name: e.name, path: path.join(folder, e.name), ...count(path.join(folder, e.name)) }))
    .filter((s) => s.videos || s.convert)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { path: folder, name: path.basename(folder) || folder, direct, subfolders, ...count(folder) };
}

// Loose videos in a linked show folder belong to that show; a folder of show folders lets each
// subfolder name its show.
function showFor(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true }).some((e) => e.isFile() && isVideo(e.name)) ? path.basename(folder) : '';
  } catch {
    return '';
  }
}

class LinkedProbes extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.cache = {};
    this.queue = [];
    this.queued = new Set();
    this.running = 0;
    this.done = 0;
    this.total = 0;
    try {
      this.cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }

  get(key) {
    return this.cache[key] || null;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.cache));
    }, 1000);
  }

  // files: [{ key, file }] not measured yet. Two at a time, so a network drive isn't swamped.
  measure(files, ffprobe) {
    if (!ffprobe) return;
    for (const f of files) {
      if (this.cache[f.key] || this.queued.has(f.key)) continue;
      this.queued.add(f.key);
      this.queue.push(f);
      this.total++;
    }
    while (this.running < 2 && this.queue.length) this.next(ffprobe);
  }

  async next(ffprobe) {
    const f = this.queue.shift();
    if (!f) return;
    this.running++;
    const p = await probe(f.file, ffprobe);
    this.running--;
    this.queued.delete(f.key);
    this.done++;
    if (p && !p.error && p.duration) this.cache[f.key] ={ duration: p.duration, playable: p.playable, vcodec: p.vcodec, acodec: p.acodec, container: p.container };
    else this.cache[f.key] = { error: (p && p.error) || 'Could not read' };
    this.save();
    this.emit('progress', this.status());
    if (this.queue.length) this.next(ffprobe);
    else if (!this.running) {
      this.done = 0;
      this.total = 0;
      this.emit('done');
    }
  }

  status() {
    return { measuring: this.total > 0 && this.done < this.total, done: this.done, total: this.total };
  }
}

module.exports = { count, describe, showFor, LinkedProbes };
