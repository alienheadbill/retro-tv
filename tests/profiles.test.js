const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'profiles.js'), 'utf8') + '\nthis.Profiles = Profiles;', ctx);
const { Profiles } = ctx;

test('channel lists accept numbers, ranges and *', () => {
  assert.equal(Profiles.matches(['4', '5', '20-24'], 22), true);
  assert.equal(Profiles.matches(['4', '5', '20-24'], 40), false);
  assert.equal(Profiles.matches('*', 40), true);
  assert.equal(Profiles.matches(undefined, 40), true);
});

test('rating caps apply to channels and files', () => {
  const kids = { channels: ['20-29'], maxRating: 'TV-Y7' };
  assert.equal(Profiles.allowsChannel(kids, { number: 21 }), true);
  assert.equal(Profiles.allowsChannel(kids, { number: 21, rating: 'TV-14' }), false);
  assert.equal(Profiles.allowsChannel(kids, { number: 40 }), false);
  assert.equal(Profiles.allowsFile(kids, { rating: 'TV-Y' }), true);
  assert.equal(Profiles.allowsFile(kids, { rating: 'TV-PG' }), false);
  assert.equal(Profiles.allowsFile(kids, {}), true);
  assert.equal(Profiles.allowsFile({ ...kids, allowUnrated: false }, {}), false);
  assert.equal(Profiles.allowsFile(null, { rating: 'TV-MA' }), true);
});

test('"always" channels ignore the rating cap, for channels and their files', () => {
  const family = { channels: ['20-24', '400-499'], maxRating: 'TV-PG', always: ['400-499'] };
  assert.equal(Profiles.allowsChannel(family, { number: 404, rating: 'TV-14' }), true);
  assert.equal(Profiles.allowsChannel(family, { number: 22, rating: 'TV-14' }), false);
  assert.equal(Profiles.allowsChannel(family, { number: 500, rating: 'TV-G' }), false);
  assert.equal(Profiles.allowsFile(family, { rating: 'TV-14' }, { number: 410 }), true);
  assert.equal(Profiles.allowsFile(family, { rating: 'TV-14' }, { number: 22 }), false);
});

test('the profile schedule picks the most recent switch, across midnight and weekdays', () => {
  const settings = {
    profileSchedule: [
      { at: '07:00', profile: 'kids' },
      { at: '19:30', profile: 'family' },
      { at: '22:00', profile: 'late', days: ['fri', 'sat'] },
    ],
  };
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026; the 23rd is a Friday
  assert.equal(Profiles.scheduled(settings, at(23, 8)), 'kids');
  assert.equal(Profiles.scheduled(settings, at(23, 20)), 'family');
  assert.equal(Profiles.scheduled(settings, at(23, 23)), 'late');
  assert.equal(Profiles.scheduled(settings, at(24, 2)), 'late'); // Saturday 2am, still Friday's late night
  assert.equal(Profiles.scheduled(settings, at(22, 23)), 'family'); // Thursday: no late night
  assert.equal(Profiles.scheduled({}, at(23, 8)), null);
});
