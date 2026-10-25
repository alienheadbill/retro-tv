// Playback health and recovery (src/health.js). Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const Health = require('../src/health');

const clock = (t = 1e12) => {
  const c = { t, now: () => c.t, add: (ms) => (c.t += ms) };
  return c;
};
const MIN = 60000;

test('a source is unverified until tried, healthy once it plays', () => {
  const c = clock();
  const h = Health.monitor({ now: c.now });
  assert.equal(h.status('a'), 'unverified');
  assert.equal(h.usable('a'), true);
  h.ok('a', { loadMs: 1234.4 });
  assert.equal(h.status('a'), 'healthy');
  assert.equal(h.get('a').loadMs, 1234);
});

test('failures rest a source, doubling each time, then it counts as unavailable', () => {
  const c = clock();
  const h = Health.monitor({ now: c.now, base: MIN, max: 60 * MIN, unavailableAfter: 3 });
  h.fail('a', { reason: 'network' });
  assert.equal(h.status('a'), 'degraded');
  assert.equal(h.usable('a'), false);
  c.add(MIN);
  assert.equal(h.usable('a'), true, 'rested 1 minute');
  h.fail('a');
  c.add(MIN);
  assert.equal(h.usable('a'), false, 'second rest is 2 minutes');
  c.add(MIN);
  assert.equal(h.usable('a'), true);
  h.fail('a');
  assert.equal(h.status('a'), 'unavailable');
  for (let i = 0; i < 10; i++) h.fail('a');
  assert.ok(h.get('a').retryAt - c.t <= 60 * MIN, 'never rests longer than the maximum');
  h.ok('a');
  assert.equal(h.status('a'), 'healthy', 'one success clears it');
  assert.equal(h.usable('a'), true);
});

test('a source that is gone for good rests the longest right away', () => {
  const c = clock();
  const h = Health.monitor({ now: c.now, max: 6 * 60 * MIN });
  h.fail('yt:x', { reason: 'removed', permanent: true });
  assert.equal(h.status('yt:x'), 'unavailable');
  c.add(5 * 60 * MIN);
  assert.equal(h.usable('yt:x'), false);
  c.add(61 * MIN);
  assert.equal(h.usable('yt:x'), true);
});

test('stalls mark a source degraded for a while', () => {
  const c = clock();
  const h = Health.monitor({ now: c.now });
  h.ok('a');
  h.stall('a');
  h.stall('a');
  assert.equal(h.status('a'), 'healthy');
  h.stall('a');
  assert.equal(h.status('a'), 'degraded');
  c.add(31 * MIN);
  assert.equal(h.status('a'), 'healthy');
});

test('a channel is only unavailable when all its sources are', () => {
  const h = Health.monitor({ now: () => 1e12, unavailableAfter: 1 });
  assert.equal(h.channelStatus(['a', 'b']), 'unverified');
  h.fail('a');
  assert.equal(h.channelStatus(['a', 'b']), 'unavailable');
  h.ok('b');
  assert.equal(h.channelStatus(['a', 'b']), 'degraded');
  h.ok('a');
  assert.equal(h.channelStatus(['a', 'b']), 'healthy');
});

test('recovery tries the same source, then another source, then a stand-in', () => {
  assert.equal(Health.nextStep({ retries: 0 }), 'retry');
  assert.equal(Health.nextStep({ retries: 1 }), 'substitute');
  assert.equal(Health.nextStep({ retries: 0, permanent: true }), 'substitute', 'no point retrying a removed video');
  assert.equal(Health.nextStep({ retries: 1, alternates: 2, alternatesTried: 0 }), 'alternate');
  assert.equal(Health.nextStep({ retries: 1, alternates: 2, alternatesTried: 2 }), 'substitute');
  assert.equal(Health.nextStep({ retries: 2 }, 3), 'retry');
});

test('stand-ins prefer the same show, skip resting sources, and are the same for the same slot', () => {
  const pool = [
    { key: 'a1', show: 'Dexter', dur: 1300 },
    { key: 'a2', show: 'Dexter', dur: 1300 },
    { key: 'a3', show: 'Dexter', dur: 1300 },
    { key: 'b1', show: 'Ed Edd n Eddy', dur: 1300 },
    { key: 'z0', show: 'Dexter', dur: 0 },
  ];
  const failed = pool[0];
  const pick = Health.substitute(failed, pool, { seed: 'slot-1' });
  assert.equal(pick.show, 'Dexter');
  assert.notEqual(pick.key, 'a1');
  assert.notEqual(pick.key, 'z0', 'nothing without a length');
  assert.equal(Health.substitute(failed, pool, { seed: 'slot-1' }).key, pick.key, 'deterministic');
  const other = Health.substitute(failed, pool, { seed: 'slot-1', exclude: [pick.key] });
  assert.ok(other && other.key !== pick.key && other.show === 'Dexter');
  const resting = new Set(['a2', 'a3']);
  assert.equal(Health.substitute(failed, pool, { seed: 's', usable: (k) => !resting.has(k) }).key, 'b1', 'falls back to another show');
  assert.equal(Health.substitute(failed, [failed], {}), null, 'nothing left');
});
