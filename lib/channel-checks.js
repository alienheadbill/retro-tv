'use strict';
// Channel checks for the Library's Channel health tab: asks each provider whether a channel is on
// the air, without playing anything. Honest about what it can't know: a site that answers isn't
// proof its player works, so those are "unverified".
//   status: healthy | degraded | unavailable | unverified
//   temporary: true when it's expected to come back by itself (a stream that's off the air)
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

function makeGet(fetchImpl, timeout) {
  return (url, opts = {}) =>
    fetchImpl(url, {
      ...opts,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US', Cookie: 'CONSENT=YES+1; SOCS=CAI', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(timeout),
    });
}

const result = (status, note, extra = {}) => ({ status, note, ...extra });

async function pluto(get) {
  const boot = await (await get(`https://boot.pluto.tv/v4/start?appName=web&appVersion=9.0.0&deviceVersion=140.0.0&deviceModel=web&deviceMake=chrome&deviceType=web&clientID=${crypto.randomUUID()}&clientModelNumber=1.0.0`)).json();
  const r = await get('https://service-channels.clusters.pluto.tv/v2/guide/channels?channelIds=&offset=0&limit=1000&sort=number%3Aasc', { headers: { Authorization: 'Bearer ' + boot.sessionToken } });
  return new Set(((await r.json()).data || []).map((c) => c.slug));
}

const plutoSlug = (url) => (/pluto\.tv\/.*live-tv\/(?:[^/]+\/)?([^/?#]+)/.exec(url || '') || [])[1] || null;

// One channel. ctx: { get, plutoSlugs (Set or null), live (cached YouTube live lookups) }
async function checkChannel(ch, ctx) {
  const { get } = ctx;
  try {
    switch (ch.type) {
      case 'web': {
        const slug = plutoSlug(ch.url);
        if (slug) {
          if (!ctx.plutoSlugs) return result('unverified', "Couldn't reach Pluto's guide to check");
          return ctx.plutoSlugs.has(slug) ? result('healthy', "In Pluto's current lineup") : result('unavailable', "Not in Pluto's lineup any more (renamed or removed)");
        }
        const r = await get(ch.url, { redirect: 'follow' });
        return r.ok ? result('unverified', 'Site is up; its player can only be checked by watching') : result('unavailable', `Site answered ${r.status}`, { temporary: r.status >= 500 });
      }
      case 'owncast': {
        const s = await (await get(new URL('/api/status', ch.url).href)).json();
        return s.online ? result('healthy', s.streamTitle ? `On the air: ${s.streamTitle}` : 'On the air') : result('unavailable', 'Off the air right now', { temporary: true });
      }
      case 'twitch': {
        const r = await get('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers: { 'Client-ID': TWITCH_WEB_CLIENT_ID, 'Content-Type': 'text/plain' },
          body: JSON.stringify({ query: 'query($login: String!) { user(login: $login) { stream { title } } }', variables: { login: ch.channel } }),
        });
        const u = (await r.json()).data.user;
        if (!u) return result('unavailable', 'This Twitch channel no longer exists');
        return u.stream ? result('healthy', `On the air: ${u.stream.title}`) : result('unavailable', 'Off the air right now', { temporary: true });
      }
      case 'vaughn': {
        const r = await get(`https://vaughn.live/${ch.channel}`);
        return r.ok ? result('unverified', 'Page is up; live status can only be checked by watching') : result('unverified', "Vaughn doesn't allow automatic checks; watch it to see");
      }
      case 'youtube-live': {
        const id = ch.videoId;
        if (!id) return result('unavailable', 'No live stream found on the channel right now', { temporary: true });
        const o = await get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
        if (o.status === 401 || o.status === 403) return result('degraded', 'Live, but its owner blocks embedding: plays on the PC TV only');
        if (o.status === 404) return result('unavailable', 'That stream ended; the TV looks for the new one when tuned', { temporary: true });
        if (!o.ok) return result('unverified', `YouTube answered ${o.status}`);
        const html = await (await get(`https://www.youtube.com/watch?v=${id}`)).text();
        if (/google\.com\/sorry/.test(html) || html.length < 5000) return result('unverified', 'Stream exists (YouTube limited the live check)');
        return /"isLiveNow":true/.test(html) ? result('healthy', 'Live') : result('unavailable', 'That video is no longer live; the TV looks for the new one when tuned', { temporary: true });
      }
      case 'youtube':
      case 'local': {
        const n = (ch.episodes || []).length;
        if (!n) return result('unavailable', ch.type === 'youtube' ? 'No playable videos in its playlists' : 'No videos yet');
        return result('healthy', `${n.toLocaleString()} videos`);
      }
      default:
        return result('unverified', 'No check for this kind of channel');
    }
  } catch (e) {
    return result('unverified', `Couldn't check (${e.name === 'TimeoutError' ? 'timed out' : 'no connection'})`, { temporary: true });
  }
}

// Every channel, a few at a time. Returns { at, channels: { [number]: result } }.
async function checkAll(channels, { fetchImpl = fetch, timeout = 12000, concurrency = 4 } = {}) {
  const get = makeGet(fetchImpl, timeout);
  let plutoSlugs = null;
  if (channels.some((c) => c.type === 'web' && plutoSlug(c.url))) {
    try {
      plutoSlugs = await pluto(get);
    } catch {}
  }
  const ctx = { get, plutoSlugs };
  const out = {};
  const queue = channels.slice();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const ch = queue.shift();
        out[ch.number] = { ...(await checkChannel(ch, ctx)), at: Date.now() };
      }
    })
  );
  return { at: Date.now(), channels: out };
}

module.exports = { checkChannel, checkAll, plutoSlug, makeGet };
