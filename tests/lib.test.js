// Unit tests for the main-process library modules. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { safeName, inside, uniquePath } = require('../lib/paths');
const { parseProbe, qualityScore } = require('../lib/probe');
const { Library, guessMeta } = require('../lib/library');
const archive = require('../lib/sources/archive-org');
const { DownloadManager } = require('../lib/downloads');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-test-'));

test('safeName strips separators, reserved names and trailing dots', () => {
  assert.equal(safeName('../../evil/..\\x.mp4'), '.. .. evil .. x.mp4');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('nul.mp4'), '_nul.mp4');
  assert.equal(safeName('show: part 1?.mp4'), 'show part 1 .mp4');
  assert.equal(safeName('trailing...  '), 'trailing');
  assert.equal(safeName(''), 'file');
  assert.ok(safeName('a'.repeat(400) + '.mp4').length <= 180);
  assert.ok(safeName('a'.repeat(400) + '.mp4').endsWith('.mp4'));
});

test('inside refuses paths that escape the root', () => {
  const root = tmpDir();
  assert.equal(inside(root, 'channels/20 Kids/a.mp4'), path.join(root, 'channels', '20 Kids', 'a.mp4'));
  assert.throws(() => inside(root, '../outside.mp4'));
  assert.throws(() => inside(root, 'C:\\Windows\\x.mp4'));
  assert.throws(() => inside(root, ''));
});

test('uniquePath never returns an existing file', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'a.mp4'), 'x');
  fs.writeFileSync(path.join(root, 'a (2).mp4'), 'x');
  assert.equal(uniquePath(path.join(root, 'a.mp4')), path.join(root, 'a (3).mp4'));
  assert.equal(uniquePath(path.join(root, 'b.mp4')), path.join(root, 'b.mp4'));
});

test('parseProbe reads codecs, aspect, interlacing and playability', () => {
  const p = parseProbe({
    format: { format_name: 'mpeg', duration: '3618.1', size: '1073739776', bit_rate: '2374000' },
    streams: [
      { codec_type: 'video', codec_name: 'mpeg2video', width: 720, height: 480, sample_aspect_ratio: '8:9', display_aspect_ratio: '4:3', field_order: 'tt', avg_frame_rate: '30000/1001' },
      { codec_type: 'audio', codec_name: 'ac3', bit_rate: '192000', channels: 2 },
    ],
  });
  assert.equal(p.aspect, '4:3');
  assert.equal(p.interlaced, true);
  assert.equal(p.fps, 29.97);
  assert.equal(p.playable, false);
  const mp4 = parseProbe({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1320' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 640, height: 480, field_order: 'progressive', avg_frame_rate: '30/1' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  });
  assert.equal(mp4.playable, true);
  assert.equal(mp4.aspect, '4:3');
  assert.equal(mp4.interlaced, false);
});

test('qualityScore prefers originals, then resolution, then bitrate', () => {
  assert.ok(qualityScore({ original: true, height: 240 }) > qualityScore({ original: false, height: 1080 }));
  assert.ok(qualityScore({ height: 480, bitrate: 1e6 }) > qualityScore({ height: 360, bitrate: 9e6 }));
  assert.ok(qualityScore({ height: 480, bitrate: 2e6 }) > qualityScore({ height: 480, bitrate: 1e6 }));
});

test('guessMeta reads dates, episodes, networks and broadcast hints from paths', () => {
  const a = guessMeta('inbox/[z303-as001] Adult Swim 12.26.04.mp4');
  assert.equal(a.network, 'Adult Swim');
  assert.equal(a.airDate, '2004-12-26');
  assert.equal(a.role, 'unassigned');
  const b = guessMeta('channels/21 Cartoon Network/Dexter\'s Laboratory/S02E05 Dee Dee Locks.mp4');
  assert.equal(b.show, "Dexter's Laboratory");
  assert.equal(b.season, 2);
  assert.equal(b.episode, 5);
  assert.equal(b.network, 'Cartoon Network');
  const c = guessMeta('inbox/1999-12-10 Cartoon Network, Dragon Tales on WQED.mp4');
  assert.equal(c.airDate, '1999-12-10');
  const d = guessMeta('inbox/VHS Recording - Cartoon Cartoon Fridays 2000 Full Broadcast.mp4');
  assert.equal(d.broadcast, true);
  assert.equal(guessMeta('channels/21 CN/_bumpers/x.mp4').role, 'bumper');
  assert.equal(guessMeta('commercials/toy.mp4').role, 'commercial');
});

test('archive.org item parsing ranks originals and flags what needs conversion', () => {
  const item = archive.parseItem(fixture('ia-item-adultswim.json'));
  assert.equal(item.id, 'zzAdultSwimBroadcasts');
  assert.ok(item.files.length > 0);
  assert.ok(item.files.every((f) => f.url.startsWith('https://archive.org/download/zzAdultSwimBroadcasts/')));
  const inu = item.files.find((f) => f.name.startsWith('Inuyasha'));
  assert.equal(inu.original, true);
  assert.equal(inu.md5, 'f92cf04dfdf0286e21be8b7a6136251a');
  assert.equal(inu.recommended, true);
  assert.equal(inu.playable, true);
  assert.ok(inu.bitrate > 0);
  // Every group recommends exactly one file.
  const groups = {};
  for (const f of item.files.filter((x) => !x.subtitle)) groups[f.group] = (groups[f.group] || 0) + (f.recommended ? 1 : 0);
  assert.ok(Object.values(groups).every((n) => n === 1));

  const ccf = archive.parseItem(fixture('ia-item-ccf2000.json'));
  const vob = ccf.files.find((f) => f.name.endsWith('VTS_01_1.VOB'));
  assert.equal(vob.playable, false);
  assert.equal(vob.needsConversion, true);
  assert.equal(ccf.broadcastHint, true);
  // The playable h.264 copy of a VOB is recommended over the unplayable original.
  const rec = ccf.files.filter((f) => f.recommended);
  assert.ok(rec.length > 0 && rec.every((f) => f.playable));
});

test('archive.org search parsing and query building', () => {
  const r = archive.parseSearch(fixture('ia-search-toonami.json'));
  assert.ok(r.total > 0);
  assert.ok(r.items.length > 0 && r.items[0].url.startsWith('https://archive.org/details/'));
  const q = archive.buildQuery({ text: 'toonami', scope: 'vhskids', yearFrom: 1999, yearTo: 2003, category: 'broadcast' });
  assert.match(q, /"toonami"/);
  assert.match(q, /collection:\(vhskids\)/);
  assert.match(q, /year:\[1999 TO 2003\]/);
  assert.match(q, /mediatype:\(movies\)/);
  assert.equal(archive.allows('https://dn721800.ca.archive.org/0/items/x/y.mp4'), true);
  assert.equal(archive.allows('https://archive.org.evil.com/x.mp4'), false);
  assert.equal(archive.allows('http://archive.org/x.mp4'), false);
});

test('library scans, imports without touching originals, and moves into channels', async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', 'Adult Swim 2004-10-11.mp4'), 'video');
  const lib = new Library(root);
  const list = lib.scan();
  assert.equal(list.length, 1);
  assert.equal(list[0].meta.network, 'Adult Swim');

  const outside = path.join(tmpDir(), 'Rugrats S01E01.mp4');
  fs.writeFileSync(outside, 'rugrats');
  const imported = await lib.importCopy(outside, 'inbox');
  assert.ok(fs.existsSync(outside), 'original stays where it was');
  assert.equal(imported.meta.season, 1);

  const moved = lib.move(imported.path, 'channels/22 Nickelodeon/Rugrats');
  assert.equal(moved.path, 'channels/22 Nickelodeon/Rugrats/Rugrats S01E01.mp4');
  assert.equal(moved.meta.show, 'Rugrats');
  assert.equal(moved.meta.role, 'show');
  assert.equal(lib.get(imported.path), null);

  lib.update(moved.path, { network: 'Nickelodeon', year: 1991 });
  const again = new Library(root);
  assert.equal(again.get(moved.path).meta.year, 1991);

  fs.unlinkSync(path.join(root, moved.path));
  again.scan();
  assert.equal(again.get(moved.path).missing, true, 'vanished files are flagged, not forgotten');
});

// A tiny file server that supports Range requests, for the download tests.
function server(body, { ignoreRange = false } = {}) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>nope</html>');
      }
      const m = !ignoreRange && /bytes=(\d+)-/.exec(req.headers.range || '');
      if (m) {
        const start = Number(m[1]);
        res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': body.length - start, 'accept-ranges': 'bytes' });
        return res.end(body.subarray(start));
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length });
      // Send slowly in pieces so a pause can land mid-transfer.
      let i = 0;
      const step = () => {
        if (res.destroyed) return;
        if (i >= body.length) return res.end();
        res.write(body.subarray(i, i + 64 * 1024));
        i += 64 * 1024;
        setTimeout(step, 5);
      };
      step();
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}

const until = (dm, id, statuses) =>
  new Promise((resolve) => {
    const check = () => {
      const j = dm.jobs.find((x) => x.id === id);
      if (j && statuses.includes(j.status)) {
        dm.off('change', check);
        resolve(j);
      }
    };
    dm.on('change', check);
    check();
  });

function manager(root, lib) {
  return new DownloadManager({
    root,
    stateFile: path.join(root, '.retrotv', 'downloads.json'),
    allows: (u) => u.startsWith('http://127.0.0.1:'),
    library: lib,
  });
}

test('downloads verify md5, resume after pause, and never overwrite', async () => {
  const body = crypto.randomBytes(3 * 1024 * 1024);
  const md5 = crypto.createHash('md5').update(body).digest('hex');
  const { s, base } = await server(body);
  try {
    const root = tmpDir();
    const lib = new Library(root);
    const dm = manager(root, lib);
    fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(root, 'inbox', 'show.mp4'), 'already here');

    const { job } = dm.add({ url: `${base}/show.mp4`, name: 'show.mp4', size: body.length, md5, meta: { network: 'Nickelodeon' } });
    await new Promise((r) => setTimeout(r, 120));
    dm.pause(job.id);
    await new Promise((r) => setTimeout(r, 100));
    const partSize = fs.statSync(path.join(root, 'inbox', 'show.mp4.part')).size;
    assert.ok(partSize > 0 && partSize < body.length, `paused mid-transfer (${partSize} bytes)`);

    dm.resume(job.id);
    const done = await until(dm, job.id, ['done', 'error']);
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.path, 'inbox/show (2).mp4');
    assert.equal(fs.readFileSync(path.join(root, 'inbox', 'show.mp4'), 'utf8'), 'already here');
    assert.ok(fs.readFileSync(path.join(root, 'inbox', 'show (2).mp4')).equals(body));
    assert.equal(lib.get('inbox/show (2).mp4').md5, md5);
    assert.equal(lib.get('inbox/show (2).mp4').meta.network, 'Nickelodeon');

    // Same source again: recognised as already in the library.
    assert.equal(dm.add({ url: `${base}/show.mp4`, name: 'show.mp4', md5 }).duplicate, 'library');
  } finally {
    s.close();
  }
});

test('downloads reject bad checksums, web pages, bad hosts and unsafe names', async () => {
  const body = crypto.randomBytes(200 * 1024);
  const { s, base } = await server(body, { ignoreRange: true });
  try {
    const root = tmpDir();
    const dm = manager(root, new Library(root));
    const { job } = dm.add({ url: `${base}/a.mp4`, name: 'a.mp4', md5: '0'.repeat(32) });
    const bad = await until(dm, job.id, ['done', 'error']);
    assert.equal(bad.status, 'error');
    assert.match(bad.error, /Checksum mismatch/);

    const page = dm.add({ url: `${base}/page`, name: 'b.mp4' }).job;
    const pageResult = await until(dm, page.id, ['done', 'error']);
    assert.match(pageResult.error, /web page/);

    assert.throws(() => dm.add({ url: 'https://evil.example/x.mp4', name: 'x.mp4' }), /not supported/);
    assert.throws(() => dm.add({ url: `${base}/x.exe`, name: 'x.exe' }), /Not a video/);
    const sneaky = dm.add({ url: `${base}/c.mp4`, name: '..\\..\\Windows\\c.mp4' }).job;
    assert.ok(!sneaky.name.includes('\\') && !sneaky.name.includes('/'));
    dm.remove(sneaky.id);
    assert.throws(() => dm.add({ url: `${base}/d.mp4`, name: 'd.mp4', destDir: '../../outside' }), /escapes/);
  } finally {
    s.close();
  }
});
