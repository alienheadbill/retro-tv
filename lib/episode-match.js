'use strict';
// What a video file's name says about which episode it is: show, season, episode, episode title,
// or a complete broadcast. Builds on lib/meta.js (dates, networks, S01E02) with the other common
// ways episodes get named, and says how sure it is:
//   high    S02E04, 2x04, "Season 1 Episode 3"
//   medium  an episode number without a season ("Episode 12", "Ep 12", "E12")
//   low     nothing numbered: the name has to match an episode title (done by lib/catalog.js)
// It never invents anything: what the name doesn't say stays empty.
const { guessMeta, BROADCAST_HINT } = require('./meta');

const clean = (s) => String(s || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

// Text left over around a marker: "Dexters Laboratory - " -> "Dexters Laboratory".
const trimSeparators = (s) => clean(s).replace(/^[\s\-–—:|,#]+|[\s\-–—:|,#(]+$/g, '').trim();

const PATTERNS = [
  // S02E04, S2 E4, s02.e04, S02E04E05 (the first episode)
  { re: /\bS(\d{1,2})\s?[ .]?E(\d{1,3})(?:\s?-?E\d{1,3})?\b/i, confidence: 'high', season: 1, episode: 2 },
  // 2x04
  { re: /\b(\d{1,2})x(\d{2,3})\b/i, confidence: 'high', season: 1, episode: 2 },
  // Season 1 Episode 3, Season 1, Episode 3, Season 1 Ep 3, Series 2 Episode 5
  { re: /\b(?:Season|Series)\s*(\d{1,2})\s*[,:\-–]?\s*(?:Episode|Ep\.?)\s*(\d{1,3})\b/i, confidence: 'high', season: 1, episode: 2 },
  // Episode 12, Ep 12, Ep. 12, E12, #12
  { re: /\b(?:Episode|Ep\.?)\s*(\d{1,3})\b/i, confidence: 'medium', episode: 1 },
  { re: /(?:^|[\s\-–—_.])E(\d{2,3})\b/, confidence: 'medium', episode: 1 },
];

// name: the file name (or path); showHint: the show folder it sits in, if any.
function matchEpisode(name, showHint = '') {
  const file = String(name).split(/[\\/]/).pop();
  const base = file.replace(/\.[^.]+$/, '');
  const text = clean(base);
  const meta = guessMeta(String(name));
  const out = {
    show: clean(showHint) || null,
    season: null,
    episode: null,
    title: null,
    year: meta.year || null,
    airDate: meta.airDate || null,
    network: meta.network || null,
    broadcast: BROADCAST_HINT.test(text) || /\bfull broadcast\b/i.test(base),
    confidence: 'low',
  };
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    if (p.season) out.season = Number(m[p.season]);
    out.episode = Number(m[p.episode]);
    out.confidence = p.confidence;
    const before = trimSeparators(text.slice(0, m.index));
    const after = trimSeparators(text.slice(m.index + m[0].length));
    if (!out.show && before) out.show = before;
    // What follows the marker is usually the episode's title (unless it's just quality tags).
    const title = after.replace(/\b(720p|1080p|480p|dvdrip|webrip|web-dl|hdtv|x264|x265|h264|hevc|aac|mp3|xvid|bluray|vhs)\b.*$/i, '').trim();
    if (title && !/^\d+$/.test(title)) out.title = title;
    break;
  }
  if (!out.show) {
    // No marker: "Show - Something" names the show, but a bare "random clip" names nothing, and
    // "Cartoon Network - Full Broadcast - 2003" names a network, not a show.
    const parts = text.split(/\s[-–—|]\s/);
    const first = trimSeparators(parts[0]);
    if (parts.length > 1 && first && !out.broadcast) out.show = first;
  }
  return out;
}

module.exports = { matchEpisode };
