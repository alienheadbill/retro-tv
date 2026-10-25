// Linked folders: counting a drive's videos, suggesting show names, and measuring in the background.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { count, describe, showFor, LinkedProbes } = require('../lib/linked');
const { findTool } = require('../lib/probe');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-linked-'));
  const put = (rel, bytes = 10) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), Buffer.alloc(bytes));
  };
  put('Rugrats/Season 1/Rugrats 101.mp4', 100);
  put('Rugrats/Season 1/Rugrats 102.mkv', 100);
  put('Rugrats/Rugrats Movie.avi', 50);
  put('Pokemon/Pokemon 001.mp4', 100);
  put('Pokemon/notes.txt');
  put('Empty Folder/readme.txt');
  put('$RECYCLE.BIN/old.mp4');
  put('loose.mp4', 10);
  return root;
}

test('a picked folder lists its show folders with what they hold', () => {
  const root = tree();
  const d = describe(root);
  assert.deepEqual(d.subfolders.map((s) => s.name), ['Pokemon', 'Rugrats'], 'folders without videos and system folders are left out');
  const rugrats = d.subfolders.find((s) => s.name === 'Rugrats');
  assert.equal(rugrats.videos, 2);
  assert.equal(rugrats.convert, 1, 'the AVI needs converting first');
  assert.equal(rugrats.bytes, 200);
  assert.equal(d.direct, 1, 'one loose video at the top');
  assert.equal(count(root).videos, 4);
});

test('loose videos are named after their folder; a folder of shows lets subfolders name them', () => {
  const root = tree();
  assert.equal(showFor(path.join(root, 'Pokemon')), 'Pokemon');
  assert.equal(showFor(path.join(root, 'Rugrats')), '', 'Rugrats holds a season folder, not videos');
  assert.equal(showFor(path.join(root, 'missing')), '');
});

const ffprobe = findTool('ffprobe');
const ffmpeg = findTool('ffmpeg');
test('lengths are measured in the background and remembered', { skip: !ffprobe || !ffmpeg ? 'FFmpeg not installed' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-probe-'));
  const clip = path.join(dir, 'clip.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  fs.writeFileSync(path.join(dir, 'broken.mp4'), 'not a video');
  const cacheFile = path.join(dir, 'probes.json');
  const p = new LinkedProbes(cacheFile);
  const finished = new Promise((resolve) => p.on('done', resolve));
  p.measure([{ key: 'a', file: clip }, { key: 'b', file: path.join(dir, 'broken.mp4') }, { key: 'a', file: clip }], ffprobe);
  assert.equal(p.status().total, 2, 'the same file is only queued once');
  await finished;
  assert.ok(Math.abs(p.get('a').duration - 3) < 0.5);
  assert.equal(p.get('a').playable, true);
  assert.ok(p.get('b').error, 'a broken file is remembered as unreadable, not retried forever');
  await new Promise((r) => setTimeout(r, 1200)); // the cache is saved shortly after
  assert.ok(new LinkedProbes(cacheFile).get('a'), 'remembered across restarts');
});
