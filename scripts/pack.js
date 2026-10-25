// Packs Retro TV into one zip for setting it up on another computer (see docs/LAPTOP-SETUP.md).
// Leaves out what that computer makes for itself or shouldn't get: node_modules, the website's
// publishing folder, videos, and this computer's library index (its file paths mean nothing there).
//   node scripts/pack.js [output.zip]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// The desktop (Windows may keep it in OneDrive), or the home folder.
const desktop = [path.join(os.homedir(), 'Desktop'), process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop')].find((d) => d && fs.existsSync(d)) || os.homedir();
const out = path.resolve(process.argv[2] || path.join(desktop, 'RetroTV-setup.zip'));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-pack-'));
const dest = path.join(stage, 'RetroTV');
fs.mkdirSync(dest);

const SKIP = new Set(['node_modules', '.deploy', '.git', '.claude', 'RetroTV-setup.zip']);
function copy(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) if (!SKIP.has(name)) copy(path.join(from, name), path.join(to, name));
  } else fs.copyFileSync(from, to);
}

for (const name of fs.readdirSync(ROOT)) {
  if (SKIP.has(name) || name === 'media') continue;
  copy(path.join(ROOT, name), path.join(dest, name));
}
// From media/: the channel folders' settings (not videos) and the YouTube lists, so the lineup matches.
const media = path.join(ROOT, 'media');
for (const sub of ['bumpers', 'commercials', 'inbox']) fs.mkdirSync(path.join(dest, 'media', sub), { recursive: true });
const chans = path.join(media, 'channels');
if (fs.existsSync(chans)) {
  for (const c of fs.readdirSync(chans)) {
    fs.mkdirSync(path.join(dest, 'media', 'channels', c), { recursive: true });
    const cj = path.join(chans, c, 'channel.json');
    if (fs.existsSync(cj)) fs.copyFileSync(cj, path.join(dest, 'media', 'channels', c, 'channel.json'));
  }
}
const yt = path.join(media, '.retrotv', 'youtube.json');
if (fs.existsSync(yt)) {
  fs.mkdirSync(path.join(dest, 'media', '.retrotv'), { recursive: true });
  fs.copyFileSync(yt, path.join(dest, 'media', '.retrotv', 'youtube.json'));
}
// The PIN stays on this computer.
const cfgFile = path.join(dest, 'channels.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
if (cfg.settings) {
  delete cfg.settings.pin;
  delete cfg.settings.linkedFolders;
  delete cfg.settings.mediaFolder;
  delete cfg.settings.ffprobePath;
}
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');

fs.rmSync(out, { force: true });
// Windows' own tar makes zips (-a picks the format from the name).
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
try {
  if (process.platform === 'win32') execFileSync(tar, ['-a', '-c', '-f', out, '-C', stage, 'RetroTV']);
  else execFileSync('zip', ['-qr', out, 'RetroTV'], { cwd: stage });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
console.log(`Packed ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
