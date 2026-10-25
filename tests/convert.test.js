// Conversion tests with real FFmpeg on generated media. Skipped when FFmpeg isn't installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { findTool, probe } = require('../lib/probe');
const { plan, vobSegments, Converter } = require('../lib/convert');
const { Library, md5File } = require('../lib/library');

const ffmpeg = findTool('ffmpeg');
const ffprobe = findTool('ffprobe');
const skip = !ffmpeg || !ffprobe ? 'FFmpeg is not installed' : false;

// Generated test clips: color bars + a tone.
function make(file, seconds, args) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=720x480:rate=30000/1001:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...args, '-y', file]);
}

const until = (conv, id) =>
  new Promise((resolve) => {
    const check = (j) => j.id === id && ['done', 'error', 'cancelled'].includes(j.status) && (conv.off('change', check), resolve(j));
    conv.on('change', check);
  });

test('plan picks the least destructive conversion', () => {
  assert.equal(plan({ vcodec: 'h264', acodec: 'aac' }).mode, 'remux');
  assert.equal(plan({ vcodec: 'h264', acodec: 'ac3' }).mode, 'audio');
  assert.equal(plan({ vcodec: 'mpeg2video', acodec: 'ac3', interlaced: true }).mode, 'transcode');
  assert.equal(plan({ vcodec: 'mpeg2video', acodec: 'ac3', interlaced: true }).deinterlace, true);
  assert.equal(plan({ vcodec: 'h264', acodec: 'aac', interlaced: true }).mode, 'transcode', 'interlaced H.264 gets deinterlaced');
  assert.equal(plan({ vcodec: 'h264', acodec: 'aac', interlaced: true }, { deinterlace: false }).mode, 'remux');
  assert.equal(plan({ vcodec: 'h264', acodec: 'aac' }, { normalize: true }).audio, 'aac');
  assert.throws(() => plan({ error: 'moov atom not found' }), /Can't read/);
});

test('real conversions: DVD VOB join + deinterlace, AVI, AC-3 audio, MKV remux', { skip, timeout: 240000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-conv-'));
  const dir = path.join(root, 'inbox');
  fs.mkdirSync(dir);
  const dvd = ['-vf', 'setfield=tff', '-c:v', 'mpeg2video', '-b:v', '6M', '-flags', '+ilme+ildct', '-aspect', '4:3', '-c:a', 'ac3', '-f', 'vob'];
  make(path.join(dir, 'CCF - VIDEO_TS - VTS_01_0.VOB'), 1, dvd);
  make(path.join(dir, 'CCF - VIDEO_TS - VTS_01_1.VOB'), 4, dvd);
  make(path.join(dir, 'CCF - VIDEO_TS - VTS_01_2.VOB'), 2, dvd);
  make(path.join(dir, 'Toy Ad 1999.avi'), 3, ['-c:v', 'mpeg4', '-vtag', 'XVID', '-q:v', '3', '-c:a', 'libmp3lame']);
  make(path.join(dir, 'Bumper ac3.mp4'), 2, ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'ac3']);
  make(path.join(dir, 'Episode.mkv'), 2, ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac']);
  const vobMd5 = await md5File(path.join(dir, 'CCF - VIDEO_TS - VTS_01_1.VOB'));

  const seg = vobSegments(path.join(dir, 'CCF - VIDEO_TS - VTS_01_1.VOB'));
  assert.deepEqual(seg.inputs.map((f) => path.basename(f)), ['CCF - VIDEO_TS - VTS_01_1.VOB', 'CCF - VIDEO_TS - VTS_01_2.VOB'], 'menu segment skipped');
  assert.equal(seg.name, 'CCF');
  const raw = path.join(root, 'Hey Arnold Tape', 'VIDEO_TS');
  fs.mkdirSync(raw, { recursive: true });
  fs.writeFileSync(path.join(raw, 'VTS_02_1.VOB'), '');
  assert.equal(vobSegments(path.join(raw, 'VTS_02_1.VOB')).name, 'Hey Arnold Tape (title 2)');

  const lib = new Library(root);
  lib.scan();
  const conv = new Converter({ library: lib, tools: () => ({ ffmpeg, ffprobe }) });

  const d = await conv.describe('inbox/CCF - VIDEO_TS - VTS_01_1.VOB');
  assert.equal(d.mode, 'transcode');
  assert.equal(d.deinterlace, true);
  assert.equal(d.segments.length, 2);

  const results = {};
  for (const rel of ['inbox/CCF - VIDEO_TS - VTS_01_1.VOB', 'inbox/Toy Ad 1999.avi', 'inbox/Bumper ac3.mp4', 'inbox/Episode.mkv']) {
    const job = conv.add(rel, { normalize: rel.endsWith('.avi') });
    results[rel] = await until(conv, job.id);
  }

  const vob = results['inbox/CCF - VIDEO_TS - VTS_01_1.VOB'];
  assert.equal(vob.status, 'done', vob.error);
  assert.equal(vob.out, 'inbox/CCF.mp4');
  const vp = lib.get(vob.out).probe;
  assert.equal(vp.vcodec, 'h264');
  assert.equal(vp.acodec, 'aac');
  assert.equal(vp.playable, true);
  assert.equal(vp.aspect, '4:3', 'display aspect preserved');
  assert.equal(vp.interlaced, false, 'deinterlaced');
  assert.ok(Math.abs(vp.duration - 6) < 0.6, `both segments joined (${vp.duration}s)`);
  assert.equal(lib.get(vob.out).meta.convertedFrom, 'inbox/CCF - VIDEO_TS - VTS_01_1.VOB');
  assert.equal(lib.get('inbox/CCF - VIDEO_TS - VTS_01_2.VOB').meta.convertedTo, vob.out);
  assert.equal(await md5File(path.join(dir, 'CCF - VIDEO_TS - VTS_01_1.VOB')), vobMd5, 'original untouched');

  const avi = results['inbox/Toy Ad 1999.avi'];
  assert.equal(avi.status, 'done', avi.error);
  assert.equal(avi.mode, 'transcode');
  assert.equal(lib.get(avi.out).probe.playable, true);
  assert.equal(lib.get(avi.out).meta.year, 1999, 'metadata carried over');

  const ac3 = results['inbox/Bumper ac3.mp4'];
  assert.equal(ac3.status, 'done', ac3.error);
  assert.equal(ac3.mode, 'audio');
  assert.equal(ac3.out, 'inbox/Bumper ac3 (2).mp4', 'never overwrites the original');

  const mkv = results['inbox/Episode.mkv'];
  assert.equal(mkv.status, 'done', mkv.error);
  assert.equal(mkv.mode, 'remux');
  assert.equal((await probe(path.join(root, mkv.out), ffprobe)).container.startsWith('mov,mp4'), true);

  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.converting')), 'no temp files left');
});

test('cancelling a conversion removes the partial file', { skip, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-conv-'));
  fs.mkdirSync(path.join(root, 'inbox'));
  make(path.join(root, 'inbox', 'long.avi'), 60, ['-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'libmp3lame']);
  const lib = new Library(root);
  lib.scan();
  const conv = new Converter({ library: lib, tools: () => ({ ffmpeg, ffprobe }) });
  const job = conv.add('inbox/long.avi', { preset: 'veryslow' });
  await new Promise((resolve) => conv.on('change', (j) => j.status === 'running' && j.progress > 0 && resolve()));
  conv.cancel(job.id);
  const end = await until(conv, job.id);
  assert.equal(end.status, 'cancelled');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(fs.readdirSync(path.join(root, 'inbox')).filter((f) => f !== 'long.avi'), []);
});
