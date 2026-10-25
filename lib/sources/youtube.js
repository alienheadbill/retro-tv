// YouTube, read from its public pages (no API key): playlists with every video's length, search
// for playlists and live streams, and whether a video allows embedding (the phone needs that).
// Nothing is downloaded; the videos always play in YouTube's own player.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };

const SEARCH_FILTER = { playlist: 'EgIQAw%3D%3D', live: 'EgJAAQ%3D%3D', video: 'EgIQAQ%3D%3D' };

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
  return res.text();
}

function initialData(html) {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html);
  if (!m) throw new Error("Couldn't read the YouTube page");
  return JSON.parse(m[1]);
}

function innertube(html) {
  return {
    key: (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1],
    version: (/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1] || '2.20260101.00.00',
  };
}

// Every object under `root` that has `key`, plus continuation tokens.
function collect(root, key) {
  const found = [];
  let next = null;
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    if (o[key]) found.push(o[key]);
    // The first token is the list's own "load more"; later ones belong to other page parts.
    if (!next && o.continuationCommand && o.continuationCommand.token) next = o.continuationCommand.token;
    for (const v of Object.values(o)) walk(v);
  })(root);
  return { found, next };
}

const seconds = (text) => {
  const parts = String(text || '').split(':').map(Number);
  if (!parts.length || parts.some(isNaN)) return 0;
  return parts.reduce((s, n) => s * 60 + n, 0);
};

const textOf = (l) => (((l.metadata || {}).lockupMetadataViewModel || {}).title || {}).content || '';

// A lockup's badge text: a length ("23:54"), "LIVE", or "123 videos" for playlists.
function badges(l) {
  const out = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    if (o.thumbnailBadgeViewModel && o.thumbnailBadgeViewModel.text) out.push(o.thumbnailBadgeViewModel.text);
    for (const v of Object.values(o)) walk(v);
  })(l.contentImage || {});
  return out;
}

function videoFrom(l) {
  if (l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
  const b = badges(l);
  const dur = seconds(b.find((x) => /^\d+(:\d{2}){1,2}$/.test(x)));
  return { id: l.contentId, title: textOf(l), dur, live: b.some((x) => /live/i.test(x)) };
}

// A playlist's title and videos (up to `max`), each { id, title, dur }.
async function playlist(listId, max = 600) {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(listId)) throw new Error('Not a YouTube playlist ID: ' + listId);
  const html = await get(`https://www.youtube.com/playlist?list=${listId}`);
  const data = initialData(html);
  const title = (/"pageHeaderViewModel":\{"title":\{"dynamicTextViewModel":\{"text":\{"content":"((?:[^"\\]|\\.)*)"/.exec(html) || [])[1];
  const it = innertube(html);
  let { found, next } = collect(data, 'lockupViewModel');
  const items = found.map(videoFrom).filter(Boolean);
  while (next && items.length < max && it.key) {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${it.key}&prettyPrint=false`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: it.version, hl: 'en', gl: 'US' } }, continuation: next }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) break;
    ({ found, next } = collect(await res.json(), 'lockupViewModel'));
    items.push(...found.map(videoFrom).filter(Boolean));
  }
  const seen = new Set();
  return {
    id: listId,
    title: title ? JSON.parse(`"${title}"`) : listId,
    items: items.filter((v) => v.dur > 0 && !seen.has(v.id) && seen.add(v.id)).slice(0, max),
  };
}

const runs = (t) => (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(''))) || '';

// type: 'playlist' | 'live' | 'video'. Returns [{ id, title, kind, count?, dur?, channel? }].
// Search results come in two formats: newer "lockups" and older "videoRenderer" (live results).
async function search(query, type = 'playlist') {
  const html = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${SEARCH_FILTER[type] || ''}`);
  const data = initialData(html);
  const lockups = collect(data, 'lockupViewModel').found.map((l) => {
    if (l.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
      const count = badges(l).map((x) => /(\d[\d,]*)\s+videos?/i.exec(x)).find(Boolean);
      return { kind: 'playlist', id: l.contentId, title: textOf(l), count: count ? Number(count[1].replace(/,/g, '')) : null };
    }
    const v = videoFrom(l);
    return v && { kind: v.live ? 'live' : 'video', ...v };
  });
  const renderers = collect(data, 'videoRenderer').found.map((v) => {
    const live = /LIVE/i.test(JSON.stringify(v.badges || []) + JSON.stringify(v.thumbnailOverlays || []));
    return {
      kind: live ? 'live' : 'video',
      id: v.videoId,
      title: runs(v.title),
      dur: seconds(runs(v.lengthText)),
      live,
      channel: runs(v.ownerText),
      channelId: (((v.ownerText || {}).runs || [])[0] || {}).navigationEndpoint?.browseEndpoint?.browseId || null,
    };
  });
  const seen = new Set();
  return [...lockups, ...renderers].filter((r) => r && r.id && !seen.has(r.id) && seen.add(r.id));
}

// The channel behind a handle (@name) or channel URL: { id: 'UC...', title }.
async function channel(handleOrId) {
  if (/^UC[A-Za-z0-9_-]{22}$/.test(handleOrId)) return { id: handleOrId };
  const h = String(handleOrId).replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/^@?/, '@');
  const html = await get(`https://www.youtube.com/${h}`);
  const id = (/"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html) || /"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(html) || [])[1];
  const title = (/<meta property="og:title" content="([^"]*)"/.exec(html) || [])[1];
  if (!id) throw new Error('No such YouTube channel: ' + handleOrId);
  return { id, title };
}

// Can this video play in an embedded player (on the phone)? oEmbed answers 401/403 when the
// owner blocks embedding and 404 when it's gone. Anything else (like 429, "slow down") is
// "don't know" and gets asked again next time.
async function embeddable(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (res.ok) return true;
    if ([401, 403, 404].includes(res.status)) return false;
    return null;
  } catch {
    return null;
  }
}

// A channel's streams that are live right now: [{ id, title }]. 24/7 streams get a new video ID
// whenever they restart, so live channels are stored as channel + title words and found here.
async function liveStreams(channelId) {
  const html = await get(`https://www.youtube.com/channel/${channelId}/streams`);
  const data = initialData(html);
  const out = [];
  for (const v of collect(data, 'videoRenderer').found) {
    if (/LIVE/i.test(JSON.stringify(v.badges || []) + JSON.stringify(v.thumbnailOverlays || []))) out.push({ id: v.videoId, title: runs(v.title) });
  }
  for (const l of collect(data, 'lockupViewModel').found) {
    const v = videoFrom(l);
    if (v && v.live) out.push({ id: v.id, title: v.title });
  }
  const seen = new Set();
  return out.filter((v) => !seen.has(v.id) && seen.add(v.id));
}

// The live stream on `channelId` whose title contains every word of `match` (or the first one).
async function findLive(channelId, match = '') {
  const words = String(match).toLowerCase().split(/\s+/).filter(Boolean);
  const lives = await liveStreams(channelId);
  return lives.find((v) => words.every((w) => v.title.toLowerCase().includes(w))) || (words.length ? null : lives[0]) || null;
}

// A channel's public playlists: [{ id, title, count }].
async function channelPlaylists(handleOrId, max = 500) {
  const ch = String(handleOrId).startsWith('UC') ? `channel/${handleOrId}` : '@' + String(handleOrId).replace(/^@/, '');
  const html = await get(`https://www.youtube.com/${ch}/playlists`);
  const it = innertube(html);
  const fromLockups = (found) =>
    found
      .filter((l) => l.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST')
      .map((l) => {
        const count = badges(l).map((x) => /(\d[\d,]*)\s+videos?/i.exec(x)).find(Boolean);
        return { id: l.contentId, title: textOf(l), count: count ? Number(count[1].replace(/,/g, '')) : null };
      });
  let { found, next } = collect(initialData(html), 'lockupViewModel');
  const out = fromLockups(found);
  while (next && out.length < max && it.key) {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${it.key}&prettyPrint=false`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: it.version, hl: 'en', gl: 'US' } }, continuation: next }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) break;
    ({ found, next } = collect(await res.json(), 'lockupViewModel'));
    const more = fromLockups(found);
    if (!more.length) break;
    out.push(...more);
  }
  const seen = new Set();
  return out.filter((p) => !seen.has(p.id) && seen.add(p.id));
}

// One video's title and length, for hand-picked video lists.
async function video(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Not a YouTube video ID: ' + id);
  const html = await get(`https://www.youtube.com/watch?v=${id}`);
  const dur = Number((/"lengthSeconds":"(\d+)"/.exec(html) || [])[1]) || 0;
  const title = (/<meta name="title" content="([^"]*)"/.exec(html) || [])[1] || id;
  return { id, title: title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), dur };
}

// Accepts a bare ID or any youtube.com / youtu.be link.
function idFrom(s, kind) {
  s = String(s).trim();
  const list = /[?&]list=([A-Za-z0-9_-]+)/.exec(s);
  if (kind === 'playlist') return list ? list[1] : s;
  const v = /(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([A-Za-z0-9_-]{11})/.exec(s);
  return v ? v[1] : s;
}

module.exports = { playlist, video, search, channel, channelPlaylists, embeddable, liveStreams, findLive, seconds, idFrom };
