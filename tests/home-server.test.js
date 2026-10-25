// The home server: pairing, the lineup, video ranges and what it refuses. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HomeServer, isPrivate } = require('../lib/home-server');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-home-'));

async function setup() {
  const dir = tmpDir();
  const app = path.join(dir, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><title>Retro TV</title>');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'not for phones');
  const video = path.join(dir, 'Episode 1.mp4');
  fs.writeFileSync(video, Buffer.from([...Array(1000).keys()].map((i) => i % 256)));
  const lineup = () => ({
    channels: [
      {
        number: 22,
        name: 'Cartoons',
        episodes: [
          {
            file: video, title: 'Episode 1', show: 'Show', dur: 1320,
            // Backup copies: the phone gets the ones it can play.
            alternates: [{ file: path.join(dir, 'Episode 1 copy.mp4'), title: 'Episode 1 copy', dur: 1320 }, { file: path.join(dir, 'Episode 1.avi'), title: 'Episode 1', dur: 1320 }],
          },
          { file: path.join(dir, 'Episode 2.avi'), title: 'Episode 2', dur: 1320 },
          { file: path.join(dir, 'Episode 3.mp4'), title: 'Episode 3', dur: null },
        ],
        bumpers: [],
        commercials: [],
      },
    ],
  });
  const home = new HomeServer({ stateFile: path.join(dir, 'state.json'), appDir: app, lineup, name: 'TEST-PC' });
  home.state.port = 0;
  await home.setEnabled(true);
  const base = `http://127.0.0.1:${home.boundPort}`;
  return { home, base, dir };
}

const pair = (base, code) => fetch(base + '/api/pair', { method: 'POST', body: JSON.stringify({ code, device: 'Test phone' }) });

test('only private-network addresses count as home', () => {
  for (const a of ['127.0.0.1', '192.168.1.20', '10.0.0.5', '172.20.1.1', '100.101.1.2', '::1', '::ffff:192.168.0.9', 'fd7a:115c::1', 'fe80::1']) assert.equal(isPrivate(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '', undefined]) assert.equal(isPrivate(a), false, String(a));
});

test('a phone pairs with the passcode, then gets the lineup and plays videos by range', async () => {
  const { home, base } = await setup();
  try {
    const hello = await (await fetch(base + '/api/hello')).json();
    assert.equal(hello.app, 'retro-tv-home');
    assert.equal(hello.name, 'TEST-PC');

    assert.equal((await fetch(base + '/api/lineup')).status, 401);
    assert.equal((await pair(base, '000000' === home.state.code ? '111111' : '000000')).status, 403);
    const r = await pair(base, home.state.code);
    assert.equal(r.status, 200);
    const { token } = await r.json();
    assert.equal(home.status().devices.length, 1);

    const lineup = await (await fetch(base + '/api/lineup', { headers: { Authorization: 'Bearer ' + token } })).json();
    const eps = lineup.channels[0].episodes;
    assert.equal(eps.length, 1, 'only the playable, measured mp4');
    assert.equal(eps[0].title, 'Episode 1');
    assert.deepEqual(eps[0].alternates.map((a) => a.title), ['Episode 1 copy'], 'backup copies the phone can play');
    assert.ok(home.files.has(eps[0].alternates[0].id), 'and the server will hand it out');
    assert.ok(!JSON.stringify(lineup).includes(path.sep + 'Episode'), 'no file paths sent to the phone');
    assert.deepEqual(home.status().counts, { ready: 1, needsConvert: 1, unmeasured: 1 });

    const media = `${base}/media/${eps[0].id}`;
    assert.equal((await fetch(media)).status, 401);
    const part = await fetch(`${media}?k=${encodeURIComponent(token)}`, { headers: { Range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
    const bytes = Buffer.from(await part.arrayBuffer());
    assert.equal(bytes.length, 100);
    assert.equal(bytes[0], 100);
    const whole = await fetch(`${media}?k=${encodeURIComponent(token)}`);
    assert.equal(whole.status, 200);
    assert.equal((await whole.arrayBuffer()).byteLength, 1000);

    // Forgetting the phone takes its key away.
    home.forget();
    assert.equal((await fetch(base + '/api/lineup', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
  } finally {
    await home.stop();
  }
});

test('wrong passcodes pause pairing, and app files outside the app folder are refused', async () => {
  const { home, base } = await setup();
  try {
    const wrong = home.state.code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) assert.equal((await pair(base, wrong)).status, 403);
    assert.equal((await pair(base, home.state.code)).status, 429, 'locked out even with the right code');
    home.newCode();
    assert.equal((await pair(base, home.state.code)).status, 200, 'a new passcode clears the lockout');

    assert.equal((await fetch(base + '/')).status, 200);
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/%2e%2e%5csecret.txt', '/.git/config']) {
      const res = await fetch(base + p);
      assert.notEqual(res.status, 200, p);
      assert.ok(!(await res.text()).includes('not for phones'), p);
    }
  } finally {
    await home.stop();
  }
});

test('with the passcode off, anyone with the address can get the lineup and the videos', async () => {
  const { home, base } = await setup();
  try {
    assert.equal((await fetch(base + '/api/lineup')).status, 401);
    home.setOpen(true);
    const hello = await (await fetch(base + '/api/hello')).json();
    assert.equal(hello.open, true);
    const lineup = await fetch(base + '/api/lineup');
    assert.equal(lineup.status, 200);
    const id = (await lineup.json()).channels[0].episodes[0].id;
    assert.equal((await fetch(`${base}/media/${id}`, { headers: { Range: 'bytes=0-9' } })).status, 206);
    home.setOpen(false);
    assert.equal((await fetch(`${base}/media/${id}`)).status, 401, 'turning the passcode back on locks it again');
  } finally {
    await home.stop();
  }
});
