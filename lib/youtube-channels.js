// YouTube channels from channels.json, resolved into the same channel objects the TV schedules.
//
//   { "type": "youtube", "playlists": ["PL...", { "id": "PL...", "show": "Rugrats" }],
//     "videos": ["id", ...], "commercials": ["PL..."], "bumpers": ["PL..."], "order": "shuffle", ... }
//     A scheduled 24/7 channel built from playlists and/or hand-picked videos, optionally with
//     commercial and bumper playlists for the breaks. A playlist can name its show for the guide.
//   { "type": "youtube-live", "channelId": "UC...", "match": "title words" }
//     A channel's 24/7 live stream, found by title (streams get a new video ID when they restart).
//
// Results are cached in media/.retrotv/youtube.json so the TV starts instantly.
const fs = require('fs');
const path = require('path');
const yt = require('./sources/youtube');

const TTL = { playlist: 3 * 86400e3, video: 30 * 86400e3, live: 20 * 60e3, channel: 3 * 86400e3 };

// A playlist entry is an ID/URL, or { id, show, match }.
const fromChannels = (c) => [].concat(c.fromChannel || []).filter((f) => f && f.handle);
const listId = (p) => yt.idFrom(p && typeof p === 'object' ? p.id : p, 'playlist');

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ');
// The distinctive words of a show name ("The Powerpuff Girls" -> powerpuff, girls).
const keywords = (s) => fold(s).split(' ').filter((w) => w.length > 2 && !['the', 'and', 'show'].includes(w));
const mentions = (title, words) => {
  const t = fold(title);
  return words.some((w) => t.includes(w));
};

// ---------- Language ----------

// Titles of other-language uploads: language/dub words, "episode"/"chapter" in other languages,
// non-Latin scripts, and flags of non-English-speaking countries. ("Latino Heat" is an English
// documentary, so "latino" only counts as dub wording.)
const FOREIGN_WORDS = /\b(espa[nñ]ol|castellano|doblaje|doblado|dublad[oa]|dublagem|legendado|subtitulado|portugu[eê]s|fran[cç]ais|vostfr|deutsch|italiano|polski|t[uü]rk[cç]e|nederlands|dansk|svenska|norsk|suomi|hindi|tamil|telugu|tagalog|bahasa|episodio|epis[oó]dio|cap[ií]tulos?|temporada|aflevering|avsnitt|afsnit|folgen?|ganze|en vivo|ao vivo|en direct|completos?)\b|\(latino\)|latino\)|audio latino|espa[nñ]ol latino|\bvf\b/i;
const FOREIGN_SCRIPT = /[Ѐ-ӿ֐-ۿऀ-෿฀-๿぀-ヿ㐀-鿿가-힯]/;
const ENGLISH_FLAGS = new Set(['🇺🇸', '🇬🇧', '🇨🇦', '🇦🇺', '🇳🇿', '🇮🇪']);
function looksForeign(title) {
  const t = String(title || '');
  if (FOREIGN_WORDS.test(t) || FOREIGN_SCRIPT.test(t)) return true;
  const flags = t.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || [];
  return flags.some((f) => !ENGLISH_FLAGS.has(f));
}

// ---------- Framing (see lib/framing.js) ----------

// A measured picture box -> { x, y, w, h } to crop to, 'drop' when the picture is too small to be
// worth watching, or null to show the video as it is. Only centered boxes are trusted: bars and
// backgrounds sit evenly around the picture, while an off-center box is more likely a scene where
// part of the shot just didn't move.
function framed(m) {
  if (!m || !m.w) return null;
  const centered = Math.abs(m.x + m.w / 2 - 0.5) < 0.06 && Math.abs(m.y + m.h / 2 - 0.5) < 0.06;
  if (!centered) return null;
  if (m.w * m.h < 0.4 || m.w < 0.5 || m.h < 0.5) return 'drop';
  return { x: m.x, y: m.y, w: m.w, h: m.h };
}

// ---------- Duplicate detection (the same event or match uploaded more than once) ----------

const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10', xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15', xvi: '16', xvii: '17', xviii: '18', xix: '19', xx: '20' };
const FILLER = new Set(['full', 'match', 'matches', 'show', 'event', 'wwe', 'wwf', 'vault', 'official', 'hd', 'english', 'ppv', 'live', 'from', 'the', 'a', 'an', 'of', 'at', 'in', 'on', 'and', 'vs', 'v', 'with', 'episode', 'classic', 'wrestling', 'video', 'part', 'pt', 'complete', 'length', 'tv', 'dsf']);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const year4 = (y) => (y.length === 4 ? y : Number(y) < 30 ? '20' + y : '19' + y);
const dateTok = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `d${year4(y)}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}` : null);

// Dates in any common format, as exact "dYYYYMMDD" tokens, removed from the text.
function takeDates(s) {
  const dates = [];
  const keep = (tok) => (tok && dates.push(tok), ' ');
  s = s
    .replace(/\b((?:19|20)\d\d)[\/.\- ](\d{1,2})[\/.\- ](\d{1,2})\b/g, (_, y, m, d) => keep(dateTok(y, +m, +d)))
    .replace(/\b(\d{1,2})[\/.\- ](\d{1,2})[\/.\- ](\d{4}|\d{2})\b/g, (_, a, b, y) => keep(+a > 12 ? dateTok(y, +b, +a) : dateTok(y, +a, +b)))
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d\d)\b/gi, (_, mo, d, y) => keep(dateTok(y, MONTHS.indexOf(mo.toLowerCase().slice(0, 3)) + 1, +d)))
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+((?:19|20)\d\d)\b/gi, (_, d, mo, y) => keep(dateTok(y, MONTHS.indexOf(mo.toLowerCase().slice(0, 3)) + 1, +d)));
  return { s, dates };
}

// A title's meaningful words: exact dates as tokens, roman numerals as numbers, filler dropped.
function titleTokens(title) {
  const { s, dates } = takeDates(String(title || ''));
  const words = fold(s).split(' ').filter((w) => w && !FILLER.has(w)).map((w) => ROMAN[w] || w);
  return new Set([...words, ...dates]);
}

const isDate = (w) => /^d\d{8}$/.test(w);
const isYear = (w) => /^(19|20)\d\d$/.test(w);
const isNum = (w) => /^\d+$/.test(w) && !isYear(w);

// Facts that tell two uploads apart: exact dates, years (including a date's year), other numbers.
function facts(tokens) {
  const dates = [...tokens].filter(isDate);
  const years = new Set([...[...tokens].filter(isYear), ...dates.map((d) => d.slice(1, 5))]);
  return { dates: new Set(dates), years, nums: new Set([...tokens].filter(isNum)) };
}
const disjoint = (a, b) => a.size && b.size && ![...a].some((x) => b.has(x));
const differ = (a, b) => a.size && b.size && (a.size !== b.size || [...a].some((x) => !b.has(x)));

// Same upload? The lengths must agree, nothing may contradict (a different date, year or number),
// and the titles must say the same thing. One title may carry an extra date or year the other lacks.
function sameVideo(a, b) {
  const diff = Math.abs(a.dur - b.dur);
  if (diff > Math.max(60, 0.03 * Math.max(a.dur, b.dur))) return false;
  const A = a.tokens;
  const B = b.tokens;
  const fa = facts(A);
  const fb = facts(B);
  if (disjoint(fa.dates, fb.dates) || disjoint(fa.years, fb.years) || differ(fa.nums, fb.nums)) return false;
  // The titles must say exactly the same thing once dates and filler are set aside ("World Title"
  // vs "Title" are different matches).
  const wordsA = new Set([...A].filter((w) => !isDate(w) && !isYear(w)));
  const wordsB = new Set([...B].filter((w) => !isDate(w) && !isYear(w)));
  if (!wordsA.size || wordsA.size !== wordsB.size || [...wordsA].some((w) => !wordsB.has(w))) return false;
  // Only when both titles pin the video down (a date, year or number on each side) may the
  // lengths differ by a trimmed intro; otherwise ("...on ESPN" twice, or one dated and one not,
  // which could be any episode) they must be within 20 seconds.
  const pinned = (f) => f.dates.size || f.years.size || f.nums.size;
  return pinned(fa) && pinned(fb) ? true : diff <= 20;
}

// Drops repeated videos: the same ID, or the same event/match uploaded again. Earlier entries win,
// so list the best source (e.g. the official channel) first. Returns { kept, dropped: [[dup, of]] }.
const pad = (n) => String(n).padStart(2, '0');
const okDate = (y, m, d) => m >= 1 && m <= 12 && (d == null || (d >= 1 && d <= 31)) && y >= 1950 && y <= 2099;

// When something happened, from its title: "YYYY-MM-DD", "YYYY-MM" or "YYYY" (sortable), or null.
// Reads "April 22, 1985", "Oct. 21, 1994", "1/2/1988", "10/22/85", "09-28-1985", "1993 06 09",
// "June 1988", a plain year, and WrestleMania's Roman numerals.
function dateFromTitle(title) {
  const t = String(title || '');
  let m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d\d)\b/i.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    if (okDate(+m[3], mo, +m[2])) return `${m[3]}-${pad(mo)}-${pad(m[2])}`;
  }
  m = /\b((?:19|20)\d\d)[/\-. ](\d{1,2})[/\-. ](\d{1,2})\b/.exec(t);
  if (m && okDate(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /\b(\d{1,2})[/\-. ](\d{1,2})[/\-. ]((?:19|20)?\d\d)\b/.exec(t);
  if (m) {
    const y = year4(m[3]);
    if (okDate(+y, +m[1], +m[2])) return `${y}-${pad(m[1])}-${pad(m[2])}`;
  }
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+((?:19|20)\d\d)\b/i.exec(t);
  if (m) return `${m[2]}-${pad(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1)}`;
  m = /\b((?:19|20)\d\d)\b/.exec(t);
  if (m) return m[1];
  m = /\bwrestlemania\s+([ivxl]+)\b/i.exec(t);
  if (m) {
    const n = roman(m[1]);
    if (n) return String(1984 + n);
  }
  return null;
}

function roman(s) {
  const v = { i: 1, v: 5, x: 10, l: 50 };
  let n = 0;
  const a = s.toLowerCase();
  for (let i = 0; i < a.length; i++) {
    const cur = v[a[i]];
    const next = v[a[i + 1]] || 0;
    n += cur < next ? -cur : cur;
  }
  return n > 0 && n < 100 ? n : 0;
}

// The event a single match comes from, from titles like "FULL MATCH: A vs. B | Title Match:
// Royal Rumble 2004" or "... : Raw, June 15, 2009". Only when it names a date or year (or a
// numbered WrestleMania), so "SummerSlam" alone doesn't lump every SummerSlam together.
function eventOf(title) {
  const last = String(title || '').split(/[:|—]/).pop().trim();
  if (!last || !dateFromTitle(last)) return null;
  return last.toLowerCase().replace(/^wwe\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// "order": "grouped" channels: each video's group, its place in it and when it happened.
//   "groupBy": "playlist" (each source playlist is one event), "event" (from the title), or
//              a list of patterns whose captures make the key (e.g. the Finals year)
//   "partBy":  a pattern capturing the part number (e.g. the game); otherwise playlist order
function sequence(episodes, c) {
  const by = c.groupBy;
  const res = Array.isArray(by) ? by.map((p) => new RegExp(p, 'i')) : null;
  const partRe = c.partBy ? new RegExp(c.partBy, 'i') : null;
  return episodes.map((f) => {
    let group = null;
    if (by === 'playlist') group = f.list || null;
    else if (by === 'event') group = eventOf(f.title);
    else if (res) {
      const ms = res.map((re) => re.exec(f.title));
      if (ms.every(Boolean)) group = ms.map((m) => (m[1] ?? m[0]).toLowerCase()).join('|');
    }
    const pm = partRe && partRe.exec(f.title);
    const part = pm ? Number(pm[1] ?? pm[0]) : f.pos;
    return { ...f, group, part: Number.isFinite(part) ? part : null, when: dateFromTitle(f.title) };
  });
}

// Keeps the first video for each key made from the patterns' matches; videos where a pattern
// doesn't match are kept as they are.
function dedupeBy(list, patterns) {
  const res = patterns.map((p) => new RegExp(p, 'i'));
  const seen = new Set();
  return list.filter((v) => {
    const parts = res.map((re) => re.exec(v.title));
    if (parts.some((m) => !m)) return true;
    const key = parts.map((m) => (m[1] ?? m[0]).toLowerCase()).join('|');
    return !seen.has(key) && seen.add(key);
  });
}

function dedupe(list) {
  const seen = new Set();
  const byId = list.filter((v) => !seen.has(v.youtube || v.id) && seen.add(v.youtube || v.id));
  const items = byId.map((v, i) => ({ v, i, dur: v.dur, tokens: titleTokens(v.title) }));
  const sorted = items.slice().sort((a, b) => a.dur - b.dur);
  const dupOf = new Map();
  for (let x = 0; x < sorted.length; x++) {
    for (let y = x + 1; y < sorted.length && sorted[y].dur - sorted[x].dur <= Math.max(60, 0.03 * sorted[y].dur); y++) {
      const a = sorted[x];
      const b = sorted[y];
      if (sameVideo(a, b)) {
        const [keep, drop] = a.i < b.i ? [a, b] : [b, a];
        if (!dupOf.has(drop.i)) dupOf.set(drop.i, keep.i);
      }
    }
  }
  return {
    kept: items.filter((it) => !dupOf.has(it.i)).map((it) => it.v),
    dropped: [...dupOf].map(([d, k]) => [byId[d], byId[k]]),
    repeats: list.length - byId.length,
  };
}

class YouTubeChannels {
  constructor(file) {
    this.file = file;
    try {
      this.cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.cache = {};
    }
    for (const k of ['playlists', 'videos', 'lives', 'embeddable', 'channels', 'framing']) this.cache[k] = this.cache[k] || {};
    this.pending = new Map();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.cache));
    fs.renameSync(tmp, this.file);
  }

  // Fetch once at a time per key; returns the cached value.
  fetch(kind, key, fn) {
    const id = `${kind}:${key}`;
    if (!this.pending.has(id)) {
      this.pending.set(
        id,
        fn()
          .then((value) => {
            const store = { playlist: 'playlists', video: 'videos', live: 'lives', channel: 'channels' }[kind];
            this.cache[store][key] = Array.isArray(value) ? { lists: value, at: Date.now() } : { ...value, at: Date.now() };
            this.save();
          })
          .catch(() => {})
          .finally(() => this.pending.delete(id))
      );
    }
    return this.pending.get(id);
  }

  // Everything a channel list needs. Missing entries are fetched now (so new channels work on
  // first start); stale ones refresh in the background and `onUpdate` is called after.
  async prepare(channels, onUpdate) {
    const now = Date.now();
    const waits = [];
    const background = [];
    const need = (kind, key, store, fn) => {
      const hit = this.cache[store][key];
      if (!hit) waits.push(this.fetch(kind, key, fn));
      else if (now - hit.at > TTL[kind]) background.push(this.fetch(kind, key, fn));
    };
    for (const c of channels) {
      if (c.enabled === false) continue;
      if (c.type === 'youtube') {
        for (const field of ['playlists', 'commercials', 'bumpers']) {
          for (const p of c[field] || []) {
            const id = listId(p);
            need('playlist', id, 'playlists', () => yt.playlist(id, c.max || 600));
          }
        }
        // "fromChannel": every playlist a YouTube channel publishes (new ones get picked up).
        for (const { handle } of fromChannels(c)) need('channel', handle, 'channels', () => yt.channelPlaylists(handle));
        for (const v of c.videos || []) {
          const id = yt.idFrom(v, 'video');
          need('video', id, 'videos', () => yt.video(id));
        }
      } else if (c.type === 'youtube-live' && c.channelId) {
        const key = `${c.channelId}|${c.match || ''}`;
        need('live', key, 'lives', async () => (await yt.findLive(c.channelId, c.match)) || { id: null, title: '' });
      }
    }
    // Don't hold the TV up forever on a slow network.
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 45000))]);
    // Second pass: the playlists of "fromChannel" channels, now that their lists are known.
    const more = [];
    for (const c of channels) {
      if (c.enabled === false || c.type !== 'youtube') continue;
      for (const p of this.channelLists(c)) {
        const hit = this.cache.playlists[p.id];
        if (!hit) more.push(this.fetch('playlist', p.id, () => yt.playlist(p.id, c.max || 600)));
        else if (now - hit.at > TTL.playlist) background.push(this.fetch('playlist', p.id, () => yt.playlist(p.id, c.max || 600)));
      }
    }
    await Promise.race([Promise.all(more), new Promise((r) => setTimeout(r, 120000))]);
    if (background.length && onUpdate) Promise.all(background).then(onUpdate);
  }

  // Every episode video on the scheduled YouTube channels (for framing measurement).
  episodeIds(channels) {
    const ids = [];
    for (const c of channels) {
      if (c.enabled === false || c.type !== 'youtube') continue;
      for (const v of this.items(c, 'playlists', c.show, { raw: true })) ids.push(v.youtube);
    }
    return [...new Set(ids)];
  }

  // The playlists a "fromChannel" setting selects: { handle, show, skip / only: "regex for
  // playlist titles", limit: newest N }, or a list of them (several promotions or networks).
  channelLists(c) {
    return fromChannels(c).flatMap((f) => {
      const hit = this.cache.channels[f.handle];
      if (!hit) return [];
      const skip = f.skip ? new RegExp(f.skip, 'i') : null;
      // "only": playlist titles to take (the rest are left out); "limit": the newest N of them.
      const only = f.only ? new RegExp(f.only, 'i') : null;
      let lists = hit.lists.filter((p) => (!skip || !skip.test(p.title)) && (!only || only.test(p.title)));
      if (f.limit) lists = lists.slice(0, f.limit);
      // YouTube lists a channel's playlists newest first; "oldestFirst" turns that around.
      if (f.oldestFirst) lists = lists.slice().reverse();
      return lists.map((p) => ({ ...p, show: f.show }));
    });
  }

  // Videos from playlists / video IDs as schedulable files. Fan "full episodes" playlists are
  // often padded with clips and unrelated videos, so episodes are filtered:
  //   - shorter than `minMinutes` (default 6) or longer than `maxMinutes` (if set): dropped
  //   - when most of a playlist's titles name its show, the ones that don't are dropped
  //     (or set "match": "words" on the playlist to choose the words yourself)
  // opts.raw: skip the framing step (used when collecting videos to measure).
  items(c, field, show, opts = {}) {
    const out = [];
    const broadcast = c.mode === 'broadcast';
    const episodes = field === 'playlists';
    const min = episodes ? (c.minMinutes ?? 6) * 60 : 0;
    const max = episodes && c.maxMinutes ? c.maxMinutes * 60 : Infinity;
    // Playlists listed by hand, then (for episodes) every playlist "fromChannel" picks up.
    // Those are taken whole (no title matching), named after their YouTube channel's "show".
    const sources = [...(c[field] || []), ...(episodes ? this.channelLists(c).map((p) => ({ id: p.id, show: p.show, whole: true })) : [])];
    for (const p of sources) {
      const list = this.cache.playlists[listId(p)];
      if (!list) continue;
      // Only { id, show, match } entries carry options (a plain string has a .match method!).
      const opt = p && typeof p === 'object' ? p : {};
      const name = opt.show || show || list.title;
      const items = list.items || [];
      let words = opt.match ? keywords(opt.match) : null;
      if (!words && episodes && opt.show && !opt.whole) {
        const k = keywords(opt.show);
        if (k.length && items.filter((v) => mentions(v.title, k)).length / Math.max(items.length, 1) >= 0.5) words = k;
      }
      items.forEach((v, pos) => {
        if (v.dur < min || v.dur > max) return;
        if (words && !mentions(v.title, words)) return;
        // Shrunk onto a background or boxed in bars: crop to the picture, or drop it if it's tiny.
        const box = !opts.raw && episodes ? framed(this.cache.framing[v.id]) : null;
        if (box === 'drop') return;
        out.push({ ...this.file_(v, name, broadcast, box), list: list.id, pos });
      });
    }
    if (field === 'playlists') {
      for (const v of c.videos || []) {
        const hit = this.cache.videos[yt.idFrom(v, 'video')];
        if (hit && hit.dur) out.push(this.file_(hit, show || c.name, broadcast));
      }
    }
    return out;
  }

  file_(v, show, broadcast, crop) {
    const f = { url: 'yt:' + v.id, key: 'yt:' + v.id, youtube: v.id, title: v.title, show: show || '', dur: v.dur, broadcast, playable: true };
    if (crop) f.crop = crop;
    return f;
  }

  // A youtube channel as the TV sees it (a scheduled channel, like a media folder).
  // `built` maps channel number -> episodes of channels already built (in number order), for
  // "dedupeAgainst". Options:
  //   "skip": "regex"            drop episodes whose title matches (e.g. other languages)
  //   "dedupe": true             drop re-uploads of the same event/match within this channel
  //   "dedupeAgainst": [400]     also drop anything already on those channels
  //   "dedupeBy": ["regex", ...] titles whose patterns all match with the same text are one
  //                              video (first capture group of each); e.g. year + game number
  scheduled(c, sharedBumpers, sharedCommercials, built = new Map()) {
    // English only unless a channel says otherwise ("languages": "any").
    const english = (list) => (c.languages === 'any' ? list : list.filter((e) => !looksForeign(e.title)));
    let episodes = english(this.items(c, 'playlists', c.show));
    if (c.skip) {
      const re = new RegExp(c.skip, 'i');
      episodes = episodes.filter((e) => !re.test(e.title));
    }
    // "only": video titles to keep, e.g. full fights out of an event's promos and interviews.
    if (c.only) {
      const re = new RegExp(c.only, 'i');
      episodes = episodes.filter((e) => re.test(e.title));
    }
    if (c.dedupe || c.dedupeAgainst) {
      const others = (c.dedupeAgainst || []).flatMap((n) => built.get(Number(n)) || []);
      const otherIds = new Set(others.map((v) => v.youtube));
      const kept = new Set(dedupe([...others, ...episodes]).kept.map((v) => v.youtube));
      episodes = episodes.filter((e) => kept.has(e.youtube) && !otherIds.has(e.youtube));
      // dedupe() keeps the first of repeated IDs; drop our own later repeats too.
      const seen = new Set();
      episodes = episodes.filter((e) => !seen.has(e.youtube) && seen.add(e.youtube));
    }
    if (c.dedupeBy) episodes = dedupeBy(episodes, c.dedupeBy);
    if (c.order === 'grouped') episodes = sequence(episodes, c);
    built.set(Number(c.number), episodes);
    const bumpers = english(this.items(c, 'bumpers'));
    const commercials = english(this.items(c, 'commercials'));
    return {
      type: 'local',
      source: 'youtube',
      number: Number(c.number),
      name: c.name,
      order: c.order || 'shuffle',
      groupOrder: c.groupOrder || null,
      historyOrder: c.historyOrder || null,
      mode: c.mode || 'episodes',
      breaks: c.breaks || null,
      blocks: Array.isArray(c.blocks) ? c.blocks : [],
      rating: c.rating || null,
      description: c.description || '',
      episodes,
      unplayable: 0,
      bumpers: bumpers.length ? bumpers : sharedBumpers,
      commercials: commercials.length ? commercials : sharedCommercials,
    };
  }

  live(c) {
    const hit = this.cache.lives[`${c.channelId}|${c.match || ''}`];
    return { ...c, number: Number(c.number), videoId: (hit && hit.id) || null, liveTitle: (hit && hit.title) || '' };
  }

  // Look the live stream up again (it may have restarted under a new video ID).
  async refreshLive(c) {
    const key = `${c.channelId}|${c.match || ''}`;
    await this.fetch('live', key, async () => (await yt.findLive(c.channelId, c.match)) || { id: null, title: '' });
    return this.cache.lives[key] || null;
  }

  // For the phone: which videos can play in YouTube's embedded player. Cached for good.
  async checkEmbeddable(ids, concurrency = 6) {
    const todo = [...new Set(ids)].filter((id) => !(id in this.cache.embeddable));
    const queue = todo.slice();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (queue.length) {
          const id = queue.shift();
          const ok = await yt.embeddable(id);
          if (ok !== null) this.cache.embeddable[id] = ok;
        }
      })
    );
    if (todo.length) this.save();
    return this.cache.embeddable;
  }
}

module.exports = { YouTubeChannels, dedupe, dedupeBy, dateFromTitle, eventOf, sequence, titleTokens, looksForeign, framed };
