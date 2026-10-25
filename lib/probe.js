// Media inspection with ffprobe (optional: everything still works without it).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// What Chromium (and so the TV) can play without conversion.
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le']);
const PLAYABLE_CONTAINER = /^(mov,mp4,m4a,3gp,3g2,mj2|matroska,webm|ogg)$/;

function findTool(name, configured) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];
  // The setting may name the folder or one of the .exe files in it.
  if (configured) candidates.push(path.join(path.extname(configured) ? path.dirname(configured) : configured, exe));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  if (process.env.LOCALAPPDATA) {
    const winget = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    candidates.push(path.join(winget, 'Links', exe));
    // `winget install Gyan.FFmpeg` unpacks to Packages\Gyan.FFmpeg_*\ffmpeg-<ver>-*\bin and only
    // updates PATH for programs started afterwards, so look there directly too.
    try {
      for (const pkg of fs.readdirSync(path.join(winget, 'Packages')).filter((d) => /ffmpeg/i.test(d))) {
        for (const build of fs.readdirSync(path.join(winget, 'Packages', pkg)).sort().reverse()) {
          candidates.push(path.join(winget, 'Packages', pkg, build, 'bin', exe));
        }
      }
    } catch {}
  }
  candidates.push(path.join('C:\\ffmpeg\\bin', exe));
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  }) || null;
}

function ratio(s) {
  if (!s || s === '0/0' || s === 'N/A') return null;
  const [a, b] = String(s).split(/[/:]/).map(Number);
  return b ? a / b : Number.isFinite(a) ? a : null;
}

function aspectLabel(dar) {
  if (!dar) return null;
  if (Math.abs(dar - 4 / 3) < 0.04) return '4:3';
  if (Math.abs(dar - 16 / 9) < 0.04) return '16:9';
  return dar.toFixed(2) + ':1';
}

// ffprobe JSON -> the fields Retro TV cares about.
function parseProbe(data) {
  const streams = data.streams || [];
  const fmt = data.format || {};
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle').length;
  const duration = Number(fmt.duration) || (v && Number(v.duration)) || null;
  let dar = v && ratio(v.display_aspect_ratio);
  if (v && !dar && v.width && v.height) dar = (v.width * (ratio(v.sample_aspect_ratio) || 1)) / v.height;
  const fieldOrder = (v && v.field_order) || 'unknown';
  const out = {
    container: fmt.format_name || null,
    duration,
    size: Number(fmt.size) || null,
    bitrate: Number(fmt.bit_rate) || null,
    vcodec: v ? v.codec_name : null,
    width: v ? v.width : null,
    height: v ? v.height : null,
    fps: v ? Math.round((ratio(v.avg_frame_rate) || ratio(v.r_frame_rate) || 0) * 100) / 100 || null : null,
    fieldOrder,
    interlaced: ['tt', 'bb', 'tb', 'bt'].includes(fieldOrder),
    dar: dar ? Math.round(dar * 1000) / 1000 : null,
    aspect: aspectLabel(dar),
    vbitrate: v ? Number(v.bit_rate) || null : null,
    acodec: a ? a.codec_name : null,
    abitrate: a ? Number(a.bit_rate) || null : null,
    channels: a ? a.channels || null : null,
    subtitles: subs,
  };
  out.playable =
    !!out.vcodec &&
    PLAYABLE_VIDEO.has(out.vcodec) &&
    (!out.acodec || PLAYABLE_AUDIO.has(out.acodec)) &&
    PLAYABLE_CONTAINER.test(out.container || '');
  return out;
}

function probe(file, ffprobe) {
  return new Promise((resolve) => {
    if (!ffprobe) return resolve(null);
    execFile(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ error: (stderr || err.message).trim().slice(0, 300) });
        try {
          const p = parseProbe(JSON.parse(stdout));
          if (stderr && stderr.trim()) p.warnings = stderr.trim().slice(0, 300);
          resolve(p);
        } catch (e) {
          resolve({ error: 'Unreadable ffprobe output: ' + e.message });
        }
      }
    );
  });
}

const { qualityScore } = require('./meta');

module.exports = { findTool, parseProbe, probe, qualityScore, aspectLabel };
