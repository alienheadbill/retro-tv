// The episode catalog: filename matching, and have / missing / duplicates against a stand-in
// TVmaze. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { matchEpisode } = require('../lib/episode-match');
const { Catalog, norm } = require('../lib/catalog');
const { TVmaze } = require('../lib/sources/tvmaze');

test('episode numbers, show names and titles come out of common file names', () => {
  const a = matchEpisode('Dexters.Laboratory.S02E04.mp4');
  assert.equal(a.show, 'Dexters Laboratory');
  assert.equal(a.season, 2);
  assert.equal(a.episode, 4);
  assert.equal(a.confidence, 'high');

  const b = matchEpisode('Ed Edd n Eddy - Season 1 Episode 3.mp4');
  assert.deepEqual([b.show, b.season, b.episode, b.confidence], ['Ed Edd n Eddy', 1, 3, 'high']);

  const c = matchEpisode('Cartoon Network - Full Broadcast - 2003.mp4');
  assert.equal(c.broadcast, true);
  assert.equal(c.network, 'Cartoon Network');
  assert.equal(c.year, 2003);
  assert.equal(c.show, null, 'a network recording is not a show');

  const d = matchEpisode('Rugrats 2x05 - Angelica Breaks a Leg 480p.mkv');
  assert.deepEqual([d.season, d.episode, d.title], [2, 5, 'Angelica Breaks a Leg']);

  const e = matchEpisode('Bakugan Battle Brawlers Episode 12.mp4');
  assert.deepEqual([e.show, e.season, e.episode, e.confidence], ['Bakugan Battle Brawlers', null, 12, 'medium']);

  const f = matchEpisode('The Tick Loves Santa.mp4', 'The Tick');
  assert.deepEqual([f.show, f.episode, f.confidence], ['The Tick', null, 'low'], 'the folder names the show');

  assert.equal(matchEpisode('random clip.mp4').show, null, 'a bare name with no numbers names no show');
  assert.equal(matchEpisode('Dexters Laboratory - Behind the Scenes.mp4').show, 'Dexters Laboratory');
});

test('show names compare loosely', () => {
  assert.equal(norm('The Powerpuff Girls (1998)'), norm('powerpuff girls'));
  assert.equal(norm('Ed, Edd n Eddy'), norm('ed edd n eddy'));
  assert.equal(norm("Dexter's Laboratory"), norm('Dexters.Laboratory'.replace('.', ' ')));
});

// A stand-in TVmaze: one show with two seasons of three episodes, plus a special.
function fakeTvmaze() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-cat-'));
  const routes = {
    '/search/shows?q=dexters%20laboratory': [{ score: 0.9, show: { id: 1, name: "Dexter's Laboratory", premiered: '1996-04-28', ended: '2003-11-20', network: { name: 'Cartoon Network' } } }],
    '/search/shows?q=mystery%20show': [{ score: 0.5, show: { id: 9, name: 'A Different Mystery Show' } }],
    '/shows/1': { id: 1, name: "Dexter's Laboratory", premiered: '1996-04-28', ended: '2003-11-20', network: { name: 'Cartoon Network' } },
    '/shows/1/episodes?specials=1': [
      { season: 1, number: 1, name: 'Changes', type: 'regular' },
      { season: 1, number: 2, name: 'Dee Dee and the Man', type: 'regular' },
      { season: 1, number: 3, name: 'The Big Cheese', type: 'regular' },
      { season: 2, number: 1, name: 'Dexter Dodgeball', type: 'regular' },
      { season: 2, number: 2, name: 'Sister Dexter', type: 'regular' },
      { season: 2, number: 3, name: 'Ego Trip', type: 'regular' },
      { season: 2, number: null, name: 'Christmas Special', type: 'insignificant_special' },
    ],
  };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const key = url.replace('https://api.tvmaze.com', '');
    if (!(key in routes)) return new Response('[]', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  };
  const tvmaze = new TVmaze({ cacheFile: path.join(dir, 'tvmaze.json'), fetchImpl, gap: 0 });
  return { tvmaze, dir, calls: () => calls };
}

test('the catalog finds what you have, what is missing and what you have twice', async () => {
  const { tvmaze, dir } = fakeTvmaze();
  const cat = new Catalog({ file: path.join(dir, 'catalog.json'), tvmaze });
  const files = [
    { key: 'a', name: 'Dexters.Laboratory.S01E01.mp4' },
    { key: 'b', name: 'Dexters Laboratory 1x02 (copy).mp4' },
    { key: 'c', name: "Dexters.Laboratory.S01E02.mp4" },
    { key: 'd', name: 'Ego Trip.mp4', show: 'Dexters Laboratory' },
    { key: 'e', name: 'Dexters Laboratory Episode 4.mp4' },
    { key: 'f', name: 'Dexters Laboratory - Behind the Scenes.mp4' },
    { key: 'g', name: 'Cartoon Network - Full Broadcast - 2003.mp4' },
  ];
  const r = await cat.build(files);
  assert.equal(r.shows.length, 1);
  const s = r.shows[0];
  assert.equal(s.name, "Dexter's Laboratory", 'named as TVmaze names it');
  assert.equal(s.guess, false, 'an exact match, apostrophe or not');
  assert.equal(s.total, 6, 'specials are not counted as missing');
  assert.equal(s.have, 4, 'S1E1, S1E2, S2E3 by title, and S2E1 as episode 4 of the series');
  assert.equal(s.missing, 2);
  assert.deepEqual(s.seasons.map((x) => [x.season, x.have, x.total]), [[1, 2, 3], [2, 2, 3]]);
  assert.equal(s.duplicates.length, 1, 'S1E2 twice');
  assert.equal(s.duplicates[0].files.length, 2);
  assert.deepEqual(s.unmatched.map((f) => f.key), ['f']);
  assert.deepEqual(r.broadcasts.map((f) => f.key), ['g']);
  const ego = s.seasons[1].episodes.find((e) => e.name === 'Ego Trip');
  assert.equal(ego.files[0].match.confidence, 'title');
});

test('corrections win, and TVmaze answers are kept', async () => {
  const fake = fakeTvmaze();
  const cat = new Catalog({ file: path.join(fake.dir, 'catalog.json'), tvmaze: fake.tvmaze });
  const files = [{ key: 'x', name: 'Mystery Show S01E01.mp4' }, { key: 'y', name: 'Dexters.Laboratory.S01E01.mp4' }];
  let r = await cat.build(files);
  const mystery = r.shows.find((s) => s.key === norm('Mystery Show'));
  assert.equal(mystery.tvmaze, null, 'not found (stand-in has no episodes for it)');

  // A wrong file placement, corrected: it's really S2E2.
  cat.setFile('y', { show: 'Dexters Laboratory', season: 2, episode: 2 });
  // The mystery show isn't on TVmaze at all.
  cat.setShow('Mystery Show', null);
  const before = fake.calls();
  r = await cat.build(files);
  const dex = r.shows.find((s) => s.tvmaze);
  const sister = dex.seasons[1].episodes.find((e) => e.name === 'Sister Dexter');
  assert.equal(sister.files[0].match.confidence, 'yours');
  assert.equal(fake.calls(), before, 'everything came from the kept answers');

  // Corrections survive a restart.
  const again = new Catalog({ file: path.join(fake.dir, 'catalog.json'), tvmaze: fake.tvmaze });
  assert.deepEqual(again.fixes.files.y, { show: 'Dexters Laboratory', season: 2, episode: 2 });
});
