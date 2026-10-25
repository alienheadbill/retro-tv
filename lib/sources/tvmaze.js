'use strict';
// TVmaze (tvmaze.com): free TV show and episode lists, no key needed. Used by lib/catalog.js to
// know what episodes a show has. Every answer is kept (a week for shows still running, a month
// for ended ones), and requests are spaced out to stay well inside TVmaze's limit (20 per 10 s).
const fs = require('fs');
const path = require('path');

const API = 'https://api.tvmaze.com';
const GAP = 600; // ms between requests
const DAY = 86400e3;

class TVmaze {
  constructor({ cacheFile, fetchImpl = fetch, gap = GAP }) {
    this.cacheFile = cacheFile;
    this.fetch = fetchImpl;
    this.gap = gap;
    this.next = 0;
    this.cache = { searches: {}, shows: {} };
    try {
      Object.assign(this.cache, JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    } catch {}
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
    }, 500);
  }

  async get(url) {
    const wait = this.next - Date.now();
    this.next = Math.max(Date.now(), this.next) + this.gap;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await this.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('TVmaze is busy; try again in a minute');
    if (!res.ok) throw new Error(`TVmaze answered ${res.status}`);
    return res.json();
  }

  // Shows matching a name, best first: [{ id, name, premiered, ended, network, score }].
  async search(name) {
    const q = String(name).trim().toLowerCase();
    const hit = this.cache.searches[q];
    if (hit && Date.now() - hit.at < 30 * DAY) return hit.results;
    const list = (await this.get(`${API}/search/shows?q=${encodeURIComponent(q)}`)) || [];
    const results = list.map(({ score, show: s }) => ({
      id: s.id,
      name: s.name,
      premiered: s.premiered || null,
      ended: s.ended || null,
      network: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
      score,
    }));
    this.cache.searches[q] = { at: Date.now(), results };
    this.save();
    return results;
  }

  // A show and every episode, specials included: { show, episodes: [{ season, number, name, airdate, runtime, special }] }.
  async show(id) {
    const hit = this.cache.shows[id];
    const fresh = hit && Date.now() - hit.at < (hit.show.ended ? 30 : 7) * DAY;
    if (fresh) return hit;
    const s = await this.get(`${API}/shows/${encodeURIComponent(id)}`);
    if (!s) return null;
    const specials = (await this.get(`${API}/shows/${encodeURIComponent(id)}/episodes?specials=1`)) || [];
    const episodes = specials.map((e) => ({
      season: e.season,
      number: e.number, // null for specials
      name: e.name,
      airdate: e.airdate || null,
      runtime: e.runtime || null,
      special: e.number == null || e.type !== 'regular',
    }));
    const value = {
      at: Date.now(),
      show: {
        id: s.id,
        name: s.name,
        premiered: s.premiered || null,
        ended: s.ended || null,
        network: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
        genres: s.genres || [],
        runtime: s.runtime || s.averageRuntime || null,
        image: (s.image && s.image.medium) || null,
        summary: String(s.summary || '').replace(/<[^>]+>/g, ''),
      },
      episodes,
    };
    this.cache.shows[id] = value;
    this.save();
    return value;
  }
}

module.exports = { TVmaze };
