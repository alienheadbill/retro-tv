// Channel checks (lib/channel-checks.js) against fake provider answers. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAll, plutoSlug } = require('../lib/channel-checks');

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const text = (body, status = 200) => new Response(body, { status });

function fakeFetch(routes) {
  return async (url) => {
    for (const [match, reply] of routes) if (url.includes(match)) return typeof reply === 'function' ? reply(url) : reply.clone();
    throw Object.assign(new Error('no route'), { name: 'TypeError' });
  };
}

test('Pluto channels are checked against its current lineup', async () => {
  assert.equal(plutoSlug('https://pluto.tv/us/live-tv/90s-kids'), '90s-kids');
  assert.equal(plutoSlug('https://pluto.tv/live-tv/pokemon?x=1'), 'pokemon');
  const fetchImpl = fakeFetch([
    ['boot.pluto.tv', json({ sessionToken: 't' })],
    ['service-channels', json({ data: [{ slug: '90s-kids' }] })],
  ]);
  const r = await checkAll(
    [
      { number: 70, type: 'web', url: 'https://pluto.tv/us/live-tv/90s-kids' },
      { number: 71, type: 'web', url: 'https://pluto.tv/us/live-tv/gone-channel' },
    ],
    { fetchImpl }
  );
  assert.equal(r.channels[70].status, 'healthy');
  assert.equal(r.channels[71].status, 'unavailable');
});

test('a web page that answers is only "unverified": its player might still not work', async () => {
  const r = await checkAll([{ number: 2, type: 'web', url: 'https://example.com/' }], { fetchImpl: fakeFetch([['example.com', text('<html>')]]) });
  assert.equal(r.channels[2].status, 'unverified');
});

test('streams off the air are unavailable for now, a deleted Twitch channel for good', async () => {
  const fetchImpl = fakeFetch([
    ['on.example/api/status', json({ online: true, streamTitle: 'Cartoons' })],
    ['off.example/api/status', json({ online: false })],
    ['gql.twitch.tv', (url) => json({ data: { user: null } })],
  ]);
  const r = await checkAll(
    [
      { number: 15, type: 'owncast', url: 'https://on.example' },
      { number: 16, type: 'owncast', url: 'https://off.example' },
      { number: 11, type: 'twitch', channel: 'gone' },
    ],
    { fetchImpl }
  );
  assert.equal(r.channels[15].status, 'healthy');
  assert.equal(r.channels[16].status, 'unavailable');
  assert.equal(r.channels[16].temporary, true);
  assert.equal(r.channels[11].status, 'unavailable');
  assert.ok(!r.channels[11].temporary);
});

test('YouTube live: blocked embedding, an ended stream, and a live one', async () => {
  const big = 'x'.repeat(6000);
  const fetchImpl = fakeFetch([
    ['oembed?url=https://www.youtube.com/watch?v=blocked', text('', 401)],
    ['oembed?url=https://www.youtube.com/watch?v=ended', text('', 404)],
    ['oembed?url=https://www.youtube.com/watch?v=live', json({ title: 'x' })],
    ['oembed?url=https://www.youtube.com/watch?v=over', json({ title: 'x' })],
    ['watch?v=live', text(big + '"isLiveNow":true')],
    ['watch?v=over', text(big + '"isLiveNow":false')],
  ]);
  const r = await checkAll(
    [
      { number: 202, type: 'youtube-live', videoId: 'blocked' },
      { number: 203, type: 'youtube-live', videoId: 'ended' },
      { number: 204, type: 'youtube-live', videoId: 'live' },
      { number: 205, type: 'youtube-live', videoId: 'over' },
      { number: 206, type: 'youtube-live', videoId: null },
    ],
    { fetchImpl }
  );
  assert.equal(r.channels[202].status, 'degraded');
  assert.equal(r.channels[203].status, 'unavailable');
  assert.equal(r.channels[203].temporary, true);
  assert.equal(r.channels[204].status, 'healthy');
  assert.equal(r.channels[205].status, 'unavailable');
  assert.equal(r.channels[206].status, 'unavailable');
});

test('Vaughn, scheduled channels, and a check that fails to connect', async () => {
  const fetchImpl = fakeFetch([['vaughn.live', text('blocked', 403)]]);
  const r = await checkAll(
    [
      { number: 4, type: 'vaughn', channel: 'x' },
      { number: 300, type: 'youtube', episodes: [{}, {}] },
      { number: 20, type: 'local', episodes: [] },
      { number: 15, type: 'owncast', url: 'https://nowhere.example' },
    ],
    { fetchImpl }
  );
  assert.equal(r.channels[4].status, 'unverified');
  assert.equal(r.channels[300].status, 'healthy');
  assert.equal(r.channels[20].status, 'unavailable');
  assert.equal(r.channels[15].status, 'unverified', "can't reach the check: not proof it's down");
  assert.equal(r.channels[15].temporary, true);
});
