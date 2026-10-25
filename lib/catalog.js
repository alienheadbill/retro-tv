'use strict';
// The episode catalog: for each show in your files, which episodes you have, which are missing,
// which you have more than once, and which files it couldn't place. Shows and episode lists come
// from TVmaze (lib/sources/tvmaze.js); files are matched by name (lib/episode-match.js), then by
// episode title when the name has no numbers. Your corrections (a show matched to the wrong
// series, a file on the wrong episode) are kept and always win. Nothing is ever moved or deleted.
const fs = require('fs');
const path = require('path');
const { matchEpisode } = require('./episode-match');

// "The Powerpuff Girls (1998)" and "powerpuff girls" are the same show.
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\((19|20)\d\d\)/g, ' ')
    .replace(/['’]/g, '') // "Dexter's" in TVmaze, "Dexters" in file names
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();

const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1));
function overlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

class Catalog {
  constructor({ file, tvmaze }) {
    this.file = file;
    this.tvmaze = tvmaze;
    this.fixes = { shows: {}, files: {} };
    try {
      Object.assign(this.fixes, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {}
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.fixes, null, 2));
  }

  // A show (by the name in your files) is really TVmaze show `id` (null: not on TVmaze).
  setShow(name, id) {
    this.fixes.shows[norm(name)] = { id: id == null ? null : Number(id) };
    this.save();
  }

  // A file is really { show, season, episode }, or { ignore: true }; null forgets the correction.
  setFile(key, fix) {
    if (fix) this.fixes.files[key] = fix;
    else delete this.fixes.files[key];
    this.save();
  }

  // files: [{ key, name (file name or path), show (its show folder, if any), size, dur, height }]
  // Returns { shows: [...], broadcasts: [...], unsorted: [...] }. onProgress(done, total) while
  // looking shows up.
  async build(files, { onProgress } = {}) {
    const groups = new Map();
    const broadcasts = [];
    const unsorted = [];
    for (const f of files) {
      const fix = this.fixes.files[f.key];
      if (fix && fix.ignore) continue;
      const m = { ...matchEpisode(f.name, f.show), ...(fix || {}) };
      if (fix) m.confidence = 'yours';
      const file = { key: f.key, name: String(f.name).split(/[\\/]/).pop(), size: f.size || null, dur: f.dur || null, height: f.height || null, match: m };
      if (m.broadcast && m.season == null && m.episode == null && !fix) {
        broadcasts.push(file);
        continue;
      }
      if (!m.show) {
        unsorted.push(file);
        continue;
      }
      const k = norm(m.show);
      if (!groups.has(k)) groups.set(k, { key: k, name: m.show, files: [] });
      groups.get(k).files.push(file);
    }

    const shows = [];
    let done = 0;
    for (const g of groups.values()) {
      shows.push(await this.showReport(g));
      if (onProgress) onProgress(++done, groups.size);
    }
    shows.sort((a, b) => a.name.localeCompare(b.name));
    return { shows, broadcasts, unsorted };
  }

  // Which TVmaze show a name means: your correction, else an exact name match, else the best
  // search result (marked as a guess, for you to check).
  async findShow(name) {
    const fix = this.fixes.shows[norm(name)];
    if (fix) return fix.id == null ? { none: true } : { id: fix.id, sure: true };
    const results = await this.tvmaze.search(name);
    const exact = results.find((r) => norm(r.name) === norm(name));
    if (exact) return { id: exact.id, sure: true };
    if (results[0]) return { id: results[0].id, sure: false };
    return { none: true };
  }

  async showReport(g) {
    const report = { key: g.key, name: g.name, tvmaze: null, guess: false, files: g.files.length, total: null, have: 0, missing: 0, duplicates: [], unmatched: [], seasons: [], error: null };
    let listing = null;
    try {
      const found = await this.findShow(g.name);
      if (!found.none) {
        listing = await this.tvmaze.show(found.id);
        report.guess = !found.sure;
      }
    } catch (e) {
      report.error = e.message;
    }
    if (!listing) {
      // Not on TVmaze (or offline): just what the files say.
      report.unmatched = g.files;
      return report;
    }
    report.tvmaze = listing.show;
    report.name = listing.show.name;
    const regular = listing.episodes.filter((e) => !e.special).sort((a, b) => a.season - b.season || a.number - b.number);
    const byKey = new Map(regular.map((e) => [`${e.season}x${e.number}`, { ...e, files: [] }]));

    for (const f of g.files) {
      const m = f.match;
      let ep = null;
      if (m.season != null && m.episode != null) ep = byKey.get(`${m.season}x${m.episode}`);
      else if (m.episode != null && regular[m.episode - 1]) {
        // An episode number without a season counts through the whole series.
        const e = regular[m.episode - 1];
        ep = byKey.get(`${e.season}x${e.number}`);
      }
      if (!ep) {
        // No numbers (or numbers that don't exist): the episode's title, if it's in the name.
        const title = m.title || f.name.replace(/\.[^.]+$/, '');
        let best = null;
        let score = 0;
        for (const e of byKey.values()) {
          const s = norm(e.name) && norm(title).includes(norm(e.name)) ? 1 : overlap(title, e.name);
          if (s > score) {
            score = s;
            best = e;
          }
        }
        if (best && score >= 0.6) {
          ep = best;
          f.match = { ...m, confidence: m.confidence === 'yours' ? 'yours' : 'title' };
        }
      }
      if (ep) ep.files.push(f);
      else report.unmatched.push(f);
    }

    const seasons = new Map();
    for (const e of byKey.values()) {
      if (!seasons.has(e.season)) seasons.set(e.season, { season: e.season, total: 0, have: 0, episodes: [] });
      const s = seasons.get(e.season);
      s.total++;
      if (e.files.length) s.have++;
      s.episodes.push(e);
      if (e.files.length > 1) report.duplicates.push({ season: e.season, number: e.number, name: e.name, files: e.files });
    }
    report.seasons = [...seasons.values()];
    report.total = regular.length;
    report.have = report.seasons.reduce((n, s) => n + s.have, 0);
    report.missing = report.total - report.have;
    return report;
  }
}

module.exports = { Catalog, norm };
