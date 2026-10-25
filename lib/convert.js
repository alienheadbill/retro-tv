// Make files playable on the TV with FFmpeg, doing as little to them as possible:
//   remux     - streams are already H.264 + AAC/MP3, just rewrap into MP4 (lossless, fast)
//   audio     - H.264 video is copied, only the audio is re-encoded to AAC
//   transcode - video re-encoded to H.264 (CRF 18), deinterlaced if interlaced, aspect kept
// The original file is never modified or deleted; the result is a new .mp4 next to it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { uniquePath, safeName } = require('./paths');
const { probe } = require('./probe');

const COPY_AUDIO = new Set(['aac', 'mp3']);

// What to do with a probed file. opts: { deinterlace: 'auto'|true|false, normalize, forceTranscode }
function plan(p, opts = {}) {
  if (!p || p.error) throw new Error(p && p.error ? `Can't read this file: ${p.error}` : 'Inspect the file first');
  if (!p.vcodec) throw new Error('No video stream found');
  const deinterlace = opts.deinterlace === 'auto' || opts.deinterlace == null ? !!p.interlaced : !!opts.deinterlace;
  const video = p.vcodec === 'h264' && !deinterlace && !opts.forceTranscode ? 'copy' : 'x264';
  const audio = !p.acodec ? 'none' : COPY_AUDIO.has(p.acodec) && !opts.normalize ? 'copy' : 'aac';
  const mode = video === 'copy' ? (audio === 'aac' ? 'audio' : 'remux') : 'transcode';
  const reasons = [];
  if (video === 'copy') reasons.push(`Video is already H.264: copied untouched`);
  else reasons.push(`Video is ${p.vcodec}${deinterlace ? ', interlaced' : ''}: re-encoded to H.264 (CRF ${opts.crf || 18}, slow preset)${deinterlace ? ' with bwdif deinterlacing' : ''}`);
  if (audio === 'copy') reasons.push(`Audio is ${p.acodec}: copied untouched`);
  else if (audio === 'aac') reasons.push(`Audio is ${p.acodec}: re-encoded to AAC 192 kb/s${opts.normalize ? ' with loudness evened out' : ''}`);
  else reasons.push('No audio');
  if (p.aspect) reasons.push(`Aspect ${p.aspect} kept`);
  return { mode, video, audio, deinterlace, normalize: !!opts.normalize, crf: opts.crf || 18, preset: opts.preset || 'slow', reasons };
}

function buildArgs(input, output, pl, p) {
  const args = ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', '-fflags', '+genpts', '-i', input];
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');
  if (pl.video === 'copy') args.push('-c:v', 'copy');
  else {
    args.push('-c:v', 'libx264', '-preset', pl.preset, '-crf', String(pl.crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high');
    if (pl.deinterlace) args.push('-vf', 'bwdif=mode=send_frame:parity=auto:deint=all');
    if (p.dar) args.push('-aspect', String(p.dar));
  }
  if (pl.audio === 'copy') args.push('-c:a', 'copy');
  else if (pl.audio === 'aac') {
    args.push('-c:a', 'aac', '-b:a', '192k');
    if (pl.normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
  }
  args.push('-movflags', '+faststart', '-max_muxing_queue_size', '4096', '-f', 'mp4', '-n', output);
  return args;
}

// DVD titles are split into VTS_01_1.VOB, VTS_01_2.VOB... (VTS_01_0 is the menu). Downloads
// from the Internet Archive keep the names, possibly with the folder flattened into them.
function vobSegments(full) {
  const m = /^(.*VTS_\d\d)_([1-9])\.VOB$/i.exec(path.basename(full));
  if (!m) return { inputs: [full], name: path.basename(full).replace(/\.[^.]+$/, '') };
  const dir = path.dirname(full);
  const re = new RegExp('^' + m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_([1-9])\\.VOB$', 'i');
  const inputs = fs
    .readdirSync(dir)
    .map((f) => [f, re.exec(f)])
    .filter(([, r]) => r)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([f]) => path.join(dir, f));
  // "Show - VIDEO_TS - VTS_01" -> "Show"; a raw VIDEO_TS folder takes its parent folder's name.
  // Titles other than the first get "(title N)".
  const n = Number(/VTS_(\d\d)$/i.exec(m[1])[1]);
  const title =
    m[1].replace(/VTS_\d\d$/i, '').replace(/[\s-]*VIDEO_TS[\s-]*$/i, '').replace(/[\s-]+$/, '').trim() ||
    (/^video_ts$/i.test(path.basename(dir)) ? path.basename(path.dirname(dir)) : 'DVD');
  return { inputs, name: n === 1 ? title : `${title} (title ${n})` };
}

function run(ffmpeg, args, duration, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let tail = '';
    let buf = '';
    proc.stderr.on('data', (d) => (tail = (tail + d).slice(-3000)));
    proc.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && duration) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    const abort = () => proc.kill();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', abort);
      if (signal && signal.aborted) return reject(new Error('Cancelled'));
      if (code === 0) return resolve();
      const msg = tail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
      reject(new Error(`FFmpeg failed (${code}): ${msg}`));
    });
  });
}

// One conversion at a time; conversions are CPU-heavy.
class Converter extends EventEmitter {
  constructor({ library, tools }) {
    super();
    this.library = library;
    this.tools = tools; // () => { ffmpeg, ffprobe }
    this.jobs = [];
    this.current = null;
  }

  list() {
    return this.jobs.map(({ ctrl, ...j }) => ({ ...j }));
  }

  // Probe (if needed) and describe what converting `rel` would do.
  async describe(rel, opts = {}) {
    const { ffprobe } = this.tools();
    if (!ffprobe) throw new Error('FFmpeg is not installed');
    const full = this.library.abs(rel);
    const seg = vobSegments(full);
    let p;
    if (seg.inputs.length > 1) p = await probe('concat:' + seg.inputs.join('|'), ffprobe);
    else {
      const e = this.library.get(rel);
      p = (e && e.probe) || ((await this.library.probe(rel, ffprobe)) || {}).probe;
    }
    const pl = plan(p, opts);
    return { ...pl, probe: p, segments: seg.inputs.map((f) => this.library.rel(f)), outName: safeName(seg.name) + '.mp4' };
  }

  add(rel, opts = {}) {
    if (this.jobs.some((j) => j.rel === rel && ['queued', 'running'].includes(j.status))) throw new Error('Already converting this file');
    const job = { id: crypto.randomUUID(), rel, opts, status: 'queued', progress: 0, error: null, out: null, mode: null };
    this.jobs.push(job);
    this.emit('change', this.public(job));
    this.pump();
    return this.public(job);
  }

  cancel(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    if (j.status === 'running') j.ctrl.abort();
    else if (j.status === 'queued') {
      j.status = 'cancelled';
      this.emit('change', this.public(j));
    }
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => ['queued', 'running'].includes(j.status));
  }

  public(j) {
    const { ctrl, ...rest } = j;
    return { ...rest };
  }

  async pump() {
    if (this.current) return;
    const j = this.jobs.find((x) => x.status === 'queued');
    if (!j) return;
    this.current = j;
    j.status = 'running';
    j.ctrl = new AbortController();
    this.emit('change', this.public(j));
    let tmp = null;
    try {
      const { ffmpeg } = this.tools();
      if (!ffmpeg) throw new Error('FFmpeg is not installed');
      const d = await this.describe(j.rel, j.opts);
      j.mode = d.mode;
      j.reasons = d.reasons;
      const dir = path.dirname(this.library.abs(j.rel));
      const final = uniquePath(path.join(dir, d.outName));
      tmp = final + '.converting';
      const input = d.segments.length > 1 ? 'concat:' + d.segments.map((r) => this.library.abs(r)).join('|') : this.library.abs(j.rel);
      let last = 0;
      await run(ffmpeg, buildArgs(input, tmp, d, d.probe), d.probe.duration, (f) => {
        j.progress = f;
        if (Date.now() - last > 700) {
          last = Date.now();
          this.emit('change', this.public(j));
        }
      }, j.ctrl.signal);
      fs.renameSync(tmp, final);
      tmp = null;
      const src = this.library.get(j.rel) || { meta: {} };
      const { title, role, importedAt, convertedTo, ...keep } = src.meta || {};
      const out = this.library.add(final, { ...keep, convertedFrom: j.rel, conversion: d.mode });
      await this.library.probe(out.path, this.tools().ffprobe);
      for (const r of d.segments) if (this.library.get(r)) this.library.update(r, { convertedTo: out.path });
      j.out = out.path;
      j.progress = 1;
      j.status = 'done';
    } catch (e) {
      j.status = j.ctrl.signal.aborted ? 'cancelled' : 'error';
      j.error = j.status === 'error' ? e.message : null;
      if (tmp) fs.rm(tmp, { force: true }, () => {});
    } finally {
      this.current = null;
      this.emit('change', this.public(j));
      if (j.status === 'done') this.emit('done', this.public(j));
      this.pump();
    }
  }
}

module.exports = { plan, buildArgs, vobSegments, run, Converter };
