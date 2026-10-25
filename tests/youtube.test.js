// The duplicate finder for YouTube channels, with real titles from the wrestling playlists.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupe } = require('../lib/youtube-channels');

const v = (id, title, minutes) => ({ youtube: id, title, dur: Math.round(minutes * 60) });
const dropped = (list) => dedupe(list).dropped.map(([d]) => d.youtube);

test('the same event uploaded again is caught, whatever the date or numeral format', () => {
  assert.deepEqual(dropped([v('a', 'NWA Clash Of The Champions 1', 114), v('b', 'NWA Clash of the Champions I (03-27-1988)', 114.2)]), ['b']);
  assert.deepEqual(dropped([v('a', 'NWA Clash Of The Champions 4', 112), v('b', 'NWA Clash Of The Champions IV', 109)]), ['b']);
  assert.deepEqual(dropped([v('a', 'NWA/AWA Nite of Champions II. DEC. 29, 1985.', 147), v('b', 'NWA AWA Nite of Champions II 29 12 1985', 147)]), ['b']);
  assert.deepEqual(dropped([v('a', 'AWA (American Wrestling Association) - SuperClash II (05-02-1987)', 149), v('b', '1987 05 02 American Wrestling Association   Superclash II   AWA   Full', 149)]), ['b']);
  assert.deepEqual(dropped([v('a', 'AWA All Star Wrestling 5/14/1988', 45), v('b', 'AWA All-Star Wrestling  5/14/88', 45.2)]), ['b']);
});

test('different episodes, years and matches are kept apart', () => {
  // Weekly shows: same title, different dates.
  assert.deepEqual(dropped([v('a', 'AWA All Star Wrestling 6/25/1988', 44), v('b', 'AWA All Star Wrestling 2/20/1988', 44)]), []);
  assert.deepEqual(dropped([v('a', 'WWF Wrestling Challenge 6/6/87', 40), v('b', 'WWF Wrestling Challenge 6/13/87', 41)]), []);
  // Different years of the same event.
  assert.deepEqual(dropped([v('a', 'Survivor Series 1992', 150), v('b', 'Survivor Series 1993', 151)]), []);
  // Titles that differ by a word are different matches.
  assert.deepEqual(dropped([v('a', 'FULL MATCH: Money in the Bank Ladder Match for a WWE Title Contract', 29.6), v('b', 'FULL MATCH: Money in the Bank Ladder Match for a WWE World Title Contract', 29.8)]), []);
  // Same wrestlers, different events.
  assert.deepEqual(dropped([v('a', 'Bret Hart vs. Owen Hart: WrestleMania X', 20), v('b', 'Bret Hart vs. Owen Hart: SummerSlam 1994', 20)]), []);
  // Generic titles with nothing to tell them apart only merge when the lengths match closely.
  assert.deepEqual(dropped([v('a', 'AWA Championship Wrestling on ESPN', 48), v('b', 'AWA Championship Wrestling on ESPN', 49.5)]), []);
  assert.deepEqual(dropped([v('a', 'AWA Championship Wrestling on ESPN', 48), v('b', 'AWA Championship Wrestling on ESPN', 48.1)]), ['b']);
});

test('the same video ID is kept once, and the first listing wins', () => {
  const r = dedupe([v('a', 'Royal Rumble 1988', 36), v('a', 'Royal Rumble 1988', 36), v('b', 'FULL MATCH  1988 Royal Rumble Match: Royal Rumble 1988', 36)]);
  assert.equal(r.repeats, 1);
  assert.deepEqual(r.kept.map((x) => x.youtube), ['a']);
});

test('dedupeBy treats the same year and game number as one video', () => {
  const { dedupeBy } = require('../lib/youtube-channels');
  const by = [String.raw`\b((?:19|20)\d\d)\b`, String.raw`\b(?:game|gm|g)\.?\s*#?([1-7])\b`];
  const list = [
    { title: '1993 06 09 NBA Finals G 1 Chicago Bulls @ Phoenix Suns' },
    { title: '1993 NBA Finals Bulls at Suns Game 1 Full Game' },
    { title: 'Bulls vs Suns game 2 1993 NBA Finals' },
    { title: '1997 NBA Finals Game 1 Utah Jazz at Chicago Bulls' },
    { title: 'Finals classic, no numbers' },
  ];
  assert.deepEqual(dedupeBy(list, by).map((v) => v.title), [list[0].title, list[2].title, list[3].title, list[4].title]);
});
