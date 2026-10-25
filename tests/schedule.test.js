// Tests for src/schedule.js (a browser script), loaded into a sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'schedule.js'), 'utf8') + '\nthis.Schedule = Schedule;', ctx);
const { Schedule } = ctx;

// Arrays made inside the sandbox have a different prototype; compare plain copies.
const plain = (x) => JSON.parse(JSON.stringify(x));
const file = (url, extra = {}) => ({ url, key: url, title: url, show: '', ...extra });
const dur = (map) => (f) => map[f.url] || 0;
const at = (y, mo, d, h, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

function channel(extra = {}) {
  return {
    number: 21,
    order: 'sequential',
    episodes: [file('a', { show: 'Dexter' }), file('b', { show: 'Dexter' }), file('c', { show: 'DBZ' })],
    bumpers: [file('bump')],
    commercials: [file('ad1'), file('ad2')],
    ...extra,
  };
}
const D = dur({ a: 600, b: 600, c: 1200, bump: 10, ad1: 30, ad2: 30 });

test('episodes get a bumper and commercials after them', () => {
  const s = Schedule.build(channel(), D, { bumpers: 1, commercials: 2 });
  assert.equal(s.total, 600 + 600 + 1200 + 3 * 70);
  assert.deepEqual(plain(s.segments[0].items.map((i) => i.kind)), ['show', 'bumper', 'commercial', 'commercial']);
});

test('complete broadcasts get no extra breaks and play in air-date order', () => {
  const ch = channel({
    mode: 'broadcast',
    episodes: [file('late', { broadcast: true, airDate: '2004-11-20' }), file('early', { broadcast: true, airDate: '2001-09-02' })],
  });
  const s = Schedule.build(ch, dur({ late: 7200, early: 3600, bump: 10, ad1: 30, ad2: 30 }), { bumpers: 1, commercials: 3 });
  assert.equal(s.total, 10800);
  assert.deepEqual(plain(s.segments.map((g) => g.title)), ['early', 'late']);
  assert.ok(s.segments.every((g) => g.items.length === 1));
});

test('tuning in lands mid-show at the right offset, and the loop wraps', () => {
  const s = Schedule.build(channel({ commercials: [], bumpers: [] }), D, { bumpers: 0, commercials: 0 });
  const t = new Date(2000, 0, 1).getTime() + 700 * 1000; // 100 s into episode b
  const loc = Schedule.locate(s, t);
  assert.equal(loc.item.file.url, 'b');
  assert.equal(Math.round(loc.offset), 100);
  const wrapped = Schedule.locate(s, t + s.total * 1000);
  assert.equal(wrapped.item.file.url, 'b');
});

test('blocks take over at their times, on their days, and borrow other channels', () => {
  const toonami = { number: 30, episodes: [file('dbz1', { show: 'Dragon Ball Z' }), file('sm1', { show: 'Sailor Moon' })] };
  const ch = channel({
    blocks: [
      { name: 'Toonami', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '17:00', end: '19:00', channel: 30, shows: ['Dragon Ball Z'] },
      { name: 'Fridays', days: ['fri'], start: '19:00', end: '21:00', shows: ['Dexter'] },
      { name: 'Overnight', start: '23:00', end: '02:00', shows: ['DBZ'] },
    ],
  });
  const durs = dur({ a: 600, b: 600, c: 1200, dbz1: 1320, sm1: 1320, bump: 10, ad1: 30, ad2: 30 });
  const s = Schedule.build(ch, durs, { bumpers: 0, commercials: 0 }, (n) => (n === 30 ? toonami : null));
  assert.equal(s.blocks.length, 3);

  // Friday 2026-10-23
  const fri5pm = Schedule.locate(s, at(2026, 10, 23, 17, 30));
  assert.equal(fri5pm.block, 'Toonami');
  assert.equal(fri5pm.item.file.url, 'dbz1');
  assert.equal(fri5pm.contextEnd, at(2026, 10, 23, 19, 0));
  assert.equal(Schedule.locate(s, at(2026, 10, 23, 19, 30)).block, 'Fridays');
  assert.ok(['a', 'b'].includes(Schedule.locate(s, at(2026, 10, 23, 19, 30)).item.file.url));
  // Saturday: no Toonami
  assert.equal(Schedule.locate(s, at(2026, 10, 24, 17, 30)).block, null);
  // Overnight block crosses midnight
  assert.equal(Schedule.locate(s, at(2026, 10, 24, 1, 0)).block, 'Overnight');
  // Outside blocks, the regular rotation runs until the next block starts
  const noon = Schedule.locate(s, at(2026, 10, 23, 12, 0));
  assert.equal(noon.block, null);
  assert.equal(noon.contextEnd, at(2026, 10, 23, 17, 0));
});

test('guide listings are contiguous and switch at block edges', () => {
  const ch = channel({ blocks: [{ name: 'Fridays', days: ['fri'], start: '19:00', end: '21:00', shows: ['Dexter'] }] });
  const s = Schedule.build(ch, D, { bumpers: 0, commercials: 0 });
  const from = at(2026, 10, 23, 18, 0);
  const to = at(2026, 10, 23, 22, 0);
  const l = Schedule.listings(s, from, to);
  assert.ok(l.length > 3);
  assert.ok(l[0].start <= from + 1);
  for (let i = 1; i < l.length; i++) assert.equal(l[i].start, l[i - 1].end, `gap at ${i}`);
  assert.ok(l.some((x) => x.block === 'Fridays' && x.start === at(2026, 10, 23, 19, 0)));
  assert.ok(l.filter((x) => x.block === 'Fridays').every((x) => x.show === 'Dexter'));
  assert.equal(l[l.length - 1].end >= to, true);
});

test('an empty block falls back to the regular rotation', () => {
  const ch = channel({ blocks: [{ name: 'Nothing', start: '00:00', end: '23:59', shows: ['Not A Show'] }] });
  const s = Schedule.build(ch, D, { bumpers: 0, commercials: 0 });
  assert.equal(s.blocks.length, 0);
  assert.ok(Schedule.locate(s, at(2026, 10, 23, 12, 0)));
});
