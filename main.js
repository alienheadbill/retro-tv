const { app, BrowserWindow, screen, ipcMain, net, session, shell, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const { spawn } = require('child_process');
const { Library } = require('./lib/library');
const { DownloadManager } = require('./lib/downloads');
const { findTool } = require('./lib/probe');
const { Converter } = require('./lib/convert');
const { YouTubeChannels } = require('./lib/youtube-channels');
const { HomeServer } = require('./lib/home-server');
const funnel = require('./lib/funnel');
const channelChecks = require('./lib/channel-checks');
const { Catalog } = require('./lib/catalog');
const { TVmaze } = require('./lib/sources/tvmaze');
const { describe: describeFolder, showFor, LinkedProbes } = require('./lib/linked');
const { safeName, isVideo, IMPORT_EXT } = require('./lib/paths');
const sources = require('./lib/sources');

const ROOT = __dirname;
// RTV_CONFIG / RTV_USER_DATA / RTV_HIDDEN: used by scripts/tv-test.js to run a hidden TV on test
// settings, without touching the real channels, health records or screen.
const CONFIG_FILE = process.env.RTV_CONFIG ? path.resolve(process.env.RTV_CONFIG) : path.join(ROOT, 'channels.json');
if (process.env.RTV_USER_DATA) app.setPath('userData', path.resolve(process.env.RTV_USER_DATA));
const HIDDEN = !!process.env.RTV_HIDDEN;
let MEDIA_DIR = path.join(ROOT, 'media');
const LIVE_TYPES = new Set(['twitch', 'vaughn', 'owncast', 'web']);

// Sites see a plain Chrome browser, not Electron (some players refuse unknown browsers).
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|retro-tv)\/\S+/g, '');
// A TV starts talking as soon as it's on.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win;
let managerWin = null;
let config;
let library = null;
let downloads = null;
let converter = null;
let youtube = null;
let home = null;
let linkedProbes = null;
let catalog = null;

async function readConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const settings = raw.settings || {};
  MEDIA_DIR = path.resolve(ROOT, process.env.RTV_MEDIA || settings.mediaFolder || 'media');
  openLibrary();
  library.scan();
  const enabled = (raw.channels || []).filter((c) => c.enabled !== false);
  const live = enabled.filter((c) => LIVE_TYPES.has(c.type)).map((c) => ({ ...c, number: Number(c.number) }));
  // YouTube channels: cached playlists/streams, refreshed in the background when stale.
  await youtube.prepare(enabled, notifyTv);
  const sharedBumpers = listVideos(path.join(MEDIA_DIR, 'bumpers'));
  const sharedCommercials = listVideos(path.join(MEDIA_DIR, 'commercials'));
  // Built in channel order so "dedupeAgainst" can see the channels before it.
  const built = new Map();
  const ytScheduled = enabled
    .filter((c) => c.type === 'youtube')
    .sort((a, b) => a.number - b.number)
    .map((c) => youtube.scheduled(c, sharedBumpers, sharedCommercials, built));
  const ytLive = enabled.filter((c) => c.type === 'youtube-live').map((c) => youtube.live(c));
  const locals = scanLocalChannels(settings);
  addRemoteShows(locals, await remoteLineup(settings), settings);
  return { settings, channels: [...live, ...ytLive, ...ytScheduled, ...locals] };
}

// ---------- Shows shared by another Retro TV (settings.publicServer) ----------
// e.g. the laptop with the drives, shared over the internet. Its folder channels' videos join the
// same-numbered channels here, streamed from it while it's on.

let remote = { url: null, at: 0, data: null, text: '' };
async function remoteLineup(settings, force = false) {
  const url = String(settings.publicServer || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  if (!force && remote.url === url && Date.now() - remote.at < 5 * 60000) return remote.data;
  let data = null;
  try {
    const hello = await (await fetch(url + '/api/hello', { signal: AbortSignal.timeout(6000) })).json();
    // This computer's own address: its shows are here already.
    if (hello.app === 'retro-tv-home' && hello.name !== os.hostname()) {
      const r = await fetch(url + '/api/lineup', { signal: AbortSignal.timeout(15000) });
      if (r.ok) data = await r.json();
    }
  } catch {}
  remote = { url, at: Date.now(), data, text: JSON.stringify(data) };
  return data;
}

function addRemoteShows(channels, data, settings) {
  if (!data || !Array.isArray(data.channels)) return;
  const url = remote.url;
  const files = (list) =>
    (list || []).map((v) => ({
      url: `${url}/media/${encodeURIComponent(v.id)}`,
      key: 'remote:' + v.id,
      title: v.title,
      show: v.show || '',
      broadcast: !!v.broadcast,
      airDate: v.airDate || null,
      year: v.year || null,
      network: v.network || null,
      rating: v.rating || null,
      dur: v.dur || null,
      playable: true,
    }));
  for (const p of data.channels) {
    if (!p.episodes || !p.episodes.length) continue;
    let ch = channels.find((c) => c.number === p.number);
    if (!ch) {
      ch = {
        type: 'local', number: p.number, name: p.name, folder: null, folderName: null,
        order: p.order || settings.localOrder || 'shuffle', mode: p.mode || 'episodes', breaks: p.breaks || null,
        blocks: p.blocks || [], rating: p.rating || null, description: p.description || '',
        episodes: [], unplayable: 0, bumpers: files(p.bumpers), commercials: files(p.commercials),
      };
      channels.push(ch);
    }
    ch.episodes.push(...files(p.episodes));
    if (!ch.bumpers.length) ch.bumpers = files(p.bumpers);
    if (!ch.commercials.length) ch.commercials = files(p.commercials);
  }
}

function openLibrary() {
  if (library && library.root === MEDIA_DIR) return;
  library = new Library(MEDIA_DIR);
  youtube = new YouTubeChannels(path.join(MEDIA_DIR, '.retrotv', 'youtube.json'));
  catalog = new Catalog({
    file: path.join(MEDIA_DIR, '.retrotv', 'catalog.json'),
    tvmaze: new TVmaze({ cacheFile: path.join(MEDIA_DIR, '.retrotv', 'tvmaze.json') }),
  });
  downloads = new DownloadManager({
    root: MEDIA_DIR,
    stateFile: path.join(MEDIA_DIR, '.retrotv', 'downloads.json'),
    allows: sources.allowsDownload,
    library,
  });
  const forward = (job) => toManager('job', job);
  downloads.on('change', (job) => {
    forward(job);
    if (job.status === 'done' || job.status === 'duplicate') notifyTv();
  });
  downloads.on('progress', forward);
  downloads.on('removed', (id) => toManager('job-removed', id));
  downloads.on('cleared', () => toManager('jobs-cleared'));
  downloads.pump();
  converter = new Converter({ library, tools });
  converter.on('change', (job) => toManager('convert', job));
  converter.on('done', notifyTv);
}

// Optional per-channel settings in media/channels/<n> <Name>/channel.json.
const CHANNEL_KEYS = ['mode', 'order', 'breaks', 'blocks', 'rating', 'description', 'note'];
function readChannelJson(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, 'channel.json'), 'utf8'));
  } catch {
    return {};
  }
}

// media/channels/<number> <Name>/ becomes a scheduled channel from your own files.
// Subfolders become show names; folders starting with "_" hold that channel's own
// _bumpers and _commercials, which replace the shared media/bumpers and media/commercials.
function scanLocalChannels(settings) {
  const dir = path.join(MEDIA_DIR, 'channels');
  const sharedBumpers = listVideos(path.join(MEDIA_DIR, 'bumpers'));
  const sharedCommercials = listVideos(path.join(MEDIA_DIR, 'commercials'));
  const channels = !fs.existsSync(dir) ? [] : fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const m = d.name.match(/^(\d+)\s+(.+)$/);
      if (!m) return null;
      const folder = path.join(dir, d.name);
      const cj = readChannelJson(folder);
      const broadcastChannel = cj.mode === 'broadcast';
      const bumpers = listVideos(path.join(folder, '_bumpers'));
      const commercials = listVideos(path.join(folder, '_commercials'));
      const episodes = listVideos(folder, true).map((e) => (broadcastChannel ? { ...e, broadcast: true } : e));
      return {
        type: 'local',
        number: Number(m[1]),
        name: m[2],
        folder,
        folderName: d.name,
        order: cj.order || settings.localOrder || 'shuffle',
        mode: cj.mode || 'episodes',
        breaks: cj.breaks || null,
        blocks: Array.isArray(cj.blocks) ? cj.blocks : [],
        rating: cj.rating || null,
        description: cj.description || '',
        episodes: episodes.filter((e) => e.playable),
        unplayable: episodes.filter((e) => !e.playable).length,
        bumpers: bumpers.length ? bumpers : sharedBumpers,
        commercials: commercials.length ? commercials : sharedCommercials,
      };
    })
    .filter(Boolean);
  addLinkedFolders(channels, settings, { sharedBumpers, sharedCommercials });
  return channels;
}

// ---------- Linked folders (videos on other drives, used in place) ----------

function probes() {
  if (!linkedProbes) {
    linkedProbes = new LinkedProbes(path.join(app.getPath('userData'), 'linked-probes.json'));
    linkedProbes.on('progress', (s) => {
      toManager('linked', s);
      if (s.done % 200 === 0) linkedChanged();
    });
    linkedProbes.on('done', () => {
      toManager('linked', linkedProbes.status());
      linkedChanged();
    });
  }
  return linkedProbes;
}

// Listing a big drive takes a moment, so each folder's listing is kept for a few minutes.
const linkedScans = new Map();
function linkedVideos(l) {
  const hit = linkedScans.get(l.path);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.vids;
  const vids = listVideos(l.path, true, l.show != null ? l.show : showFor(l.path));
  linkedScans.set(l.path, { at: Date.now(), vids });
  return vids;
}

function linkedChanged() {
  if (home) home.cached = null;
  notifyTv();
}

function addLinkedFolders(channels, settings, { sharedBumpers, sharedCommercials }) {
  const need = [];
  for (const l of settings.linkedFolders || []) {
    if (!l || !l.path || !fs.existsSync(l.path)) continue; // drive not plugged in
    const n = Number(l.channel);
    let ch = channels.find((c) => c.number === n);
    if (!ch) {
      ch = {
        type: 'local', number: n, name: l.name || path.basename(l.path), folder: null, folderName: null,
        order: settings.localOrder || 'shuffle', mode: 'episodes', breaks: null, blocks: [], rating: null, description: '',
        episodes: [], unplayable: 0, bumpers: sharedBumpers, commercials: sharedCommercials,
      };
      channels.push(ch);
    }
    for (const v of linkedVideos(l)) {
      const p = probes().get(v.key);
      if (!p) need.push({ key: v.key, file: fileURLToPath(v.url) });
      const e = !p ? v : p.error ? { ...v, playable: false } : { ...v, dur: v.dur || p.duration || null, playable: p.playable !== false };
      if (ch.mode === 'broadcast') e.broadcast = true;
      if (e.playable) ch.episodes.push(e);
      else ch.unplayable++;
    }
  }
  if (need.length) probes().measure(need, tools().ffprobe);
}

function readSettingsFile() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function writeSettingsFile(raw) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n');
}

// recurse: episode folders, where each subfolder is a show. Bumper/commercial folders are flat.
// Library metadata (show, title, air date, broadcast, rating, probed duration) wins over names.
function listVideos(folder, recurse = false, show = '') {
  if (!fs.existsSync(folder)) return [];
  const out = [];
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    const full = path.join(folder, e.name);
    if (e.isDirectory()) {
      if (recurse && !e.name.startsWith('_')) out.push(...listVideos(full, true, show || e.name));
      continue;
    }
    if (!isVideo(e.name)) continue;
    const st = fs.statSync(full);
    const entry = library.get(library.rel(full)) || {};
    const meta = entry.meta || {};
    const probe = entry.probe || {};
    out.push({
      url: pathToFileURL(full).href,
      key: `${full}|${st.size}|${Math.floor(st.mtimeMs)}`,
      title: meta.title || prettify(e.name),
      show: meta.show || show,
      broadcast: !!meta.broadcast,
      airDate: meta.airDate || null,
      year: meta.year || null,
      network: meta.network || null,
      rating: meta.rating || null,
      dur: probe.duration || null,
      // Without ffprobe we can't tell; let the player try.
      playable: probe.playable !== false || !probe.vcodec,
    });
  }
  return out;
}

function prettify(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickDisplay(pref) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (Number.isInteger(pref) && displays[pref]) return displays[pref];
  if (pref === 'primary') return primary;
  return displays.find((d) => d.id !== primary.id) || primary;
}

function placeOn(display) {
  win.setFullScreen(false);
  win.setBounds(display.bounds);
  win.setFullScreen(true);
}

async function createWindow() {
  config = await readConfig();
  const display = pickDisplay(config.settings.display);
  win = new BrowserWindow({
    ...display.bounds,
    backgroundColor: '#000000',
    frame: false,
    show: false,
    autoHideMenuBar: true,
    title: 'Retro TV',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      webviewTag: true,
    },
  });
  if (HIDDEN) win.webContents.setAudioMuted(true);
  win.once('ready-to-show', () => {
    if (HIDDEN) return;
    win.show();
    placeOn(display);
  });
  win.on('closed', () => app.quit());
  win.loadFile(path.join(ROOT, 'src', 'index.html'));
}

// The Library window: a normal desktop window on the main monitor, so the TV keeps playing.
function openManager() {
  if (managerWin && !managerWin.isDestroyed()) {
    managerWin.show();
    managerWin.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  managerWin = new BrowserWindow({
    width: Math.min(1400, area.width - 80),
    height: Math.min(900, area.height - 80),
    x: area.x + 40,
    y: area.y + 40,
    backgroundColor: '#111318',
    title: 'Retro TV Library',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'manager', 'preload.js'), contextIsolation: true, sandbox: true },
  });
  managerWin.webContents.on('will-navigate', (e) => e.preventDefault());
  managerWin.on('closed', () => (managerWin = null));
  managerWin.loadFile(path.join(ROOT, 'manager', 'index.html'));
}

function toManager(type, data) {
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('lib:event', { type, data });
}

let notifyTimer = 0;
function notifyTv() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => win && !win.isDestroyed() && win.webContents.send('tv:changed'), 400);
}

app.whenReady().then(() => {
  // Channel pages get no permissions (notifications, camera, location...).
  session.fromPartition('persist:tv').setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  // "Server only" (Retro TV Server.cmd): just the Library window, for a computer that shares its
  // drives but isn't a TV. The home server keeps running while it's open.
  if (process.argv.includes('--server')) openManager();
  else createWindow();
  startHome();
  setInterval(async () => {
    try {
      const before = remote.text;
      await remoteLineup(readSettingsFile().settings || {}, true);
      if (remote.text !== before) notifyTv();
    } catch {}
  }, 5 * 60000);
});

app.on('web-contents-created', (_e, contents) => {
  // No popups or new windows, ever: ad networks love them.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (HIDDEN) contents.setAudioMuted(true);
  contents.on('will-attach-webview', (_ev, prefs) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
  });
  // Channel pages never get the keyboard (players have their own shortcuts, and a page that
  // grabs focus would swallow the remote). Every key goes to the TV instead.
  if (contents.getType() === 'webview') {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' && input.type !== 'keyUp' && input.type !== 'char') return;
      event.preventDefault();
      const host = contents.hostWebContents;
      if (input.type === 'keyDown' && host && !host.isDestroyed()) host.send('tv:key', { key: input.key, ctrl: input.control });
    });
  }
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => home && home.stop());

// ---------- TV window ----------

ipcMain.handle('config', async () => {
  config = await readConfig();
  return config;
});

const durationsFile = () => path.join(app.getPath('userData'), 'durations.json');

ipcMain.handle('durations:get', () => {
  try {
    return JSON.parse(fs.readFileSync(durationsFile(), 'utf8'));
  } catch {
    return {};
  }
});

ipcMain.handle('durations:set', (_e, data) => {
  fs.writeFileSync(durationsFile(), JSON.stringify(data));
});

// The public client id Twitch's own website uses for its GraphQL API.
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// Is a live channel on the air, and what's it showing? { online, title, gone } or null if unknown.
ipcMain.handle('channel:status', async (_e, number, force) => {
  const ch = config.channels.find((c) => c.number === number);
  try {
    if (ch && ch.type === 'owncast') {
      const res = await net.fetch(new URL('/api/status', ch.url).href);
      const s = await res.json();
      return { online: !!s.online, title: s.streamTitle || '' };
    }
    if (ch && ch.type === 'youtube-live') {
      // The TV asks about every live channel each minute: answer from the cache (looked up within
      // the last 20 minutes) unless the TV says the stream it had didn't work.
      const hit = (!force && youtube.cachedLive(ch)) || (await youtube.refreshLive(ch));
      if (hit && hit.id) ch.videoId = hit.id;
      return { online: !!(hit && hit.id), title: (hit && hit.title) || '', videoId: (hit && hit.id) || null };
    }
    if (ch && ch.type === 'twitch') {
      const res = await net.fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': TWITCH_WEB_CLIENT_ID, 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          query: 'query($login: String!) { user(login: $login) { stream { title } } }',
          variables: { login: ch.channel },
        }),
      });
      const user = (await res.json()).data.user;
      if (!user) return { online: false, title: '', gone: true };
      return { online: !!user.stream, title: user.stream ? user.stream.title : '' };
    }
  } catch {}
  return null;
});

ipcMain.on('display:next', () => {
  const displays = screen.getAllDisplays();
  const current = screen.getDisplayMatching(win.getBounds());
  const i = displays.findIndex((d) => d.id === current.id);
  placeOn(displays[(i + 1) % displays.length]);
});

ipcMain.on('library:open', () => openManager());

ipcMain.on('quit', () => app.quit());

// ---------- Home server (the phone plays this PC's shows) ----------

// The folder channels as the phone sees them: real file paths (the server turns them into ids)
// and the lengths the TV has measured.
function homeLineup() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const settings = raw.settings || {};
  if (!library) {
    MEDIA_DIR = path.resolve(ROOT, process.env.RTV_MEDIA || settings.mediaFolder || 'media');
    openLibrary();
    library.scan();
  }
  let durations = {};
  try {
    durations = JSON.parse(fs.readFileSync(durationsFile(), 'utf8'));
  } catch {}
  const withFile = (f) => ({ ...f, file: fileURLToPath(f.url), dur: f.dur || durations[f.key] || null });
  return {
    channels: scanLocalChannels(settings).map((c) => ({
      ...c,
      episodes: c.episodes.map(withFile),
      bumpers: c.bumpers.map(withFile),
      commercials: c.commercials.map(withFile),
    })),
  };
}

function startHome() {
  home = new HomeServer({
    stateFile: path.join(app.getPath('userData'), 'home-server.json'),
    appDir: path.join(ROOT, 'dist-mobile'),
    lineup: homeLineup,
  });
  home.on('change', (s) => toManager('home', s));
  if (home.state.enabled) home.start();
}

// Rebuilds dist-mobile/ (the phone app files the home server hands out).
let homeBuild = null;
function buildPhoneApp() {
  return runPhoneScript('build-mobile.js', []);
}

// Builds the phone app and publishes it to the website (scripts/deploy-mobile.js: needs git and
// the GitHub sign-in this PC publishes with). notes: [title, ...changes] for What's New, optional.
function publishPhoneApp(notes) {
  const args = (Array.isArray(notes) ? notes : []).map((n) => String(n).trim()).filter(Boolean).slice(0, 10);
  return runPhoneScript('deploy-mobile.js', args);
}

function runPhoneScript(script, args) {
  if (homeBuild) return homeBuild;
  homeBuild = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    const last = () => out.trim().split('\n').pop();
    child.on('close', (code) => (code === 0 ? resolve(last()) : reject(new Error(last() || 'Build failed'))));
  }).finally(() => {
    homeBuild = null;
    home && home.changed();
  });
  return homeBuild;
}

// ---------- Library window ----------

// Library calls are only answered for the Library window itself.
function libHandle(name, fn) {
  ipcMain.handle(name, (e, ...args) => {
    if (!managerWin || e.sender !== managerWin.webContents) throw new Error('Not allowed');
    return fn(...args);
  });
}

const tools = () => ({
  ffprobe: findTool('ffprobe', config && config.settings.ffprobePath),
  ffmpeg: findTool('ffmpeg', config && config.settings.ffprobePath),
});

function channelFolders() {
  const dir = path.join(MEDIA_DIR, 'channels');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+\s+.+$/.test(d.name))
    .map((d) => {
      const folder = path.join(dir, d.name);
      const shows = fs
        .readdirSync(folder, { withFileTypes: true })
        .filter((s) => s.isDirectory() && !s.name.startsWith('_'))
        .map((s) => s.name);
      return { folder: d.name, number: Number(d.name.split(' ')[0]), name: d.name.replace(/^\d+\s+/, ''), shows, settings: readChannelJson(folder) };
    })
    .sort((a, b) => a.number - b.number);
}

libHandle('lib:overview', async () => {
  if (!config) config = await readConfig();
  return {
    mediaDir: MEDIA_DIR,
    sources: sources.describe(),
    channels: channelFolders(),
    tools: tools(),
    entries: library.scan(),
    jobs: downloads.list(),
    conversions: converter.list(),
  };
});

// What converting a file would do (probes it first if needed).
libHandle('lib:convert-describe', (rel, opts) => converter.describe(rel, opts || {}));

libHandle('lib:convert', (rels, opts) =>
  [].concat(rels).map((rel) => {
    try {
      return { rel, ok: true, job: converter.add(rel, opts || {}) };
    } catch (e) {
      return { rel, ok: false, error: e.message };
    }
  })
);

libHandle('lib:convert-job', (id, action) => {
  if (action === 'cancel') converter.cancel(id);
  else if (action === 'clear') converter.clearFinished();
  return converter.list();
});

libHandle('lib:search', (source, opts) => sources.get(source).search(opts || {}));

libHandle('lib:item', async (source, id) => {
  const item = await sources.get(source).item(id);
  const queued = new Set(downloads.list().filter((j) => !['error'].includes(j.status)).map((j) => j.url));
  for (const f of item.files) {
    const have = library.findBySource(f.url) || library.findByMd5(f.md5);
    if (have) f.have = have.path;
    if (queued.has(f.url)) f.queued = true;
  }
  return item;
});

// specs: [{ url, name, size, md5, destDir, meta }] from an item listing.
libHandle('lib:enqueue', (specs) =>
  (specs || []).map((s) => {
    try {
      const name = safeName(String(s.name || '').split('/').join(' - '));
      const destDir = String(s.destDir || 'inbox').split('/').map((seg) => safeName(seg, '_')).join('/');
      const r = downloads.add({ url: s.url, name, size: s.size, md5: s.md5, destDir, meta: s.meta || {} });
      return { name, ok: true, duplicate: r.duplicate || null, have: r.entry ? r.entry.path : null };
    } catch (e) {
      return { name: s.name, ok: false, error: e.message };
    }
  })
);

libHandle('lib:jobs', () => downloads.list());

libHandle('lib:job', (id, action) => {
  if (action === 'pause') downloads.pause(id);
  else if (action === 'resume') downloads.resume(id);
  else if (action === 'remove') downloads.remove(id);
  else if (action === 'clear') downloads.clearFinished();
  return downloads.list();
});

const META_KEYS = ['title', 'show', 'season', 'episode', 'network', 'year', 'airDate', 'category', 'rating', 'broadcast', 'embeddedAds', 'notes'];
libHandle('lib:update', (rel, patch) => {
  const clean = {};
  for (const k of META_KEYS) if (patch && k in patch) clean[k] = patch[k];
  const e = library.update(rel, clean);
  notifyTv();
  return e;
});

// target: { channel: "<n> <Name>", show?: string, role?: "show"|"bumper"|"commercial" }
//      or { shared: "bumpers"|"commercials" } or { inbox: true }
libHandle('lib:assign', (rels, target) => {
  let dest;
  if (target.inbox) dest = 'inbox';
  else if (target.shared === 'bumpers' || target.shared === 'commercials') dest = target.shared;
  else {
    const folder = channelFolders().find((c) => c.folder === target.channel);
    if (!folder) throw new Error('No such channel folder');
    dest = `channels/${folder.folder}`;
    if (target.role === 'bumper') dest += '/_bumpers';
    else if (target.role === 'commercial') dest += '/_commercials';
    else if (target.show) dest += '/' + safeName(target.show);
  }
  const moved = [].concat(rels).map((rel) => library.move(rel, dest));
  notifyTv();
  return moved;
});

libHandle('lib:import', async (destDir) => {
  const r = await dialog.showOpenDialog(managerWin, {
    title: 'Import videos into Retro TV',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: [...IMPORT_EXT].map((x) => x.slice(1)) }],
  });
  if (r.canceled) return [];
  const out = [];
  for (const f of r.filePaths) {
    try {
      out.push({ ok: true, entry: await library.importCopy(f, destDir || 'inbox') });
    } catch (e) {
      out.push({ ok: false, name: path.basename(f), error: e.message });
    }
  }
  notifyTv();
  return out;
});

libHandle('lib:probe', async (rels) => {
  const ffprobe = tools().ffprobe;
  if (!ffprobe) throw new Error('ffprobe is not installed');
  const list = rels && rels.length ? rels : library.list().filter((e) => !e.missing && !e.probe).map((e) => e.path);
  let done = 0;
  for (const rel of list) {
    await library.probe(rel, ffprobe);
    toManager('probe', { rel, done: ++done, total: list.length, entry: library.get(rel) });
  }
  notifyTv();
  return done;
});

libHandle('lib:hash', async (rel) => library.hash(rel));

libHandle('lib:open-source', (url) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !(u.hostname === 'archive.org' || u.hostname.endsWith('.archive.org'))) throw new Error('Not a source page');
  return shell.openExternal(u.href);
});

libHandle('lib:reveal', (rel) => shell.showItemInFolder(library.abs(rel)));

libHandle('lib:channel-create', (number, name) => {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error('Channel numbers are 1 to 999');
  if (channelFolders().some((c) => c.number === n)) throw new Error(`Channel ${n} already exists`);
  fs.mkdirSync(library.abs(`channels/${n} ${safeName(name, 'Channel')}`), { recursive: true });
  notifyTv();
  return channelFolders();
});

let shareApproval = null; // Tailscale's one-time "allow Funnel" page, when it asks for it
libHandle('lib:home', async (action, arg) => {
  if (action === 'enable') await home.setEnabled(!!arg);
  else if (action === 'port') await home.setPort(arg);
  else if (action === 'code') home.newCode();
  else if (action === 'open') home.setOpen(!!arg);
  else if (action === 'share') {
    if (arg) {
      if (!home.state.enabled) await home.setEnabled(true);
      const r = await funnel.enable(home.state.port);
      if (r.needsApproval) {
        shareApproval = r.needsApproval;
        return { status: home.status(), building: !!homeBuild, share: { ...(await funnel.status(home.state.port)), needsApproval: r.needsApproval } };
      }
    } else await funnel.disable();
  } else if (action === 'approve') {
    // Only Tailscale's own approval page.
    if (shareApproval && /^https:\/\/login\.tailscale\.com\//.test(shareApproval)) shell.openExternal(shareApproval);
  }
  else if (action === 'forget') home.forget(arg || null);
  else if (action === 'refresh') home.lineup(true);
  else if (action === 'build') return { built: await buildPhoneApp(), status: home.status() };
  else if (action === 'publish') return { built: await publishPhoneApp(arg), status: home.status() };
  else if (action === 'status' && !home.cached) {
    try {
      home.lineup();
    } catch {}
  }
  return { status: home.status(), building: !!homeBuild, share: await funnel.status(home.state.port) };
});

// Linked folders: what's linked, picking a folder to link, saving and removing links.
function linkedList() {
  const raw = readSettingsFile();
  const folders = channelFolders();
  return (raw.settings.linkedFolders || []).map((l) => {
    const connected = fs.existsSync(l.path);
    const vids = connected ? linkedVideos(l) : [];
    const ch = folders.find((c) => c.number === Number(l.channel));
    return {
      path: l.path,
      channel: Number(l.channel),
      channelName: ch ? ch.name : l.name || path.basename(l.path),
      connected,
      videos: vids.length,
      measured: vids.filter((v) => v.dur || (probes().get(v.key) && probes().get(v.key).duration)).length,
    };
  });
}

// Channel numbers that are free for new folder channels, from 25 up.
function freeNumbers(raw, howMany = 40) {
  const used = new Set([
    ...(raw.channels || []).map((c) => Number(c.number)),
    ...channelFolders().map((c) => c.number),
    ...(raw.settings.linkedFolders || []).map((l) => Number(l.channel)),
  ]);
  const out = [];
  for (let n = 25; n < 1000 && out.length < howMany; n++) if (!used.has(n) && !(n >= 70 && n <= 199)) out.push(n);
  return out;
}

// ---------- Channel health (Library tab) ----------
// Two views of every channel: what its provider says right now (lib/channel-checks.js, on request),
// and how it has actually been playing on the TV (src/health.js, reported by the TV window).

let tvHealth = null;
let lastChecks = { at: null, channels: {} };
let checking = null;

ipcMain.on('tv:health', (e, data) => {
  if (!win || e.sender !== win.webContents) return;
  tvHealth = data;
  toManager('health', healthView());
});

const PROVIDERS = { web: 'Web page', owncast: 'Owncast', twitch: 'Twitch', vaughn: 'Vaughn', 'youtube-live': 'YouTube live', youtube: 'YouTube playlists', local: 'Your videos' };

function healthView() {
  const played = (tvHealth && tvHealth.channels) || [];
  const channels = ((config && config.channels) || [])
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((ch) => {
      const n = (ch.episodes || []).length;
      const provider = ch.type === 'web' && channelChecks.plutoSlug(ch.url) ? 'Pluto TV' : ch.type === 'local' && ch.source === 'youtube' ? 'YouTube playlists' : PROVIDERS[ch.type] || ch.type;
      return {
        number: ch.number,
        name: ch.name,
        provider,
        check: lastChecks.channels[ch.number] || null,
        playback: played.find((p) => p.number === ch.number) || null,
        fallback: ch.type === 'local' || ch.source === 'youtube' ? (n > 1 ? `${(n - 1).toLocaleString()} stand-ins` : 'Standby card') : ch.type === 'youtube-live' ? 'Finds the new stream' : 'Standby card',
      };
    });
  return { checkedAt: lastChecks.at, checking: !!checking, reportedAt: tvHealth && tvHealth.at, channels, aired: (tvHealth && tvHealth.aired) || [] };
}

// ---------- Episode catalog (Library, Shows tab) ----------

// Every show video: the library's files (not bumpers or commercials) and the linked drives'.
function catalogFiles() {
  const out = [];
  for (const e of library.list()) {
    const m = e.meta || {};
    if (e.missing || !isVideo(e.path) || m.role === 'bumper' || m.role === 'commercial') continue;
    out.push({ key: 'lib:' + e.path, name: e.path, show: m.show || '', size: e.size, dur: e.probe && e.probe.duration, height: e.probe && e.probe.height });
  }
  for (const l of (readSettingsFile().settings || {}).linkedFolders || []) {
    if (!l || !fs.existsSync(l.path)) continue;
    for (const v of linkedVideos(l)) out.push({ key: v.key, name: fileURLToPath(v.url), show: v.show || '', dur: v.dur || null });
  }
  return out;
}

let lastCatalog = null;
let cataloguing = null;
libHandle('lib:catalog', async (action, arg) => {
  if (!config) config = await readConfig();
  if (action === 'build') {
    if (!cataloguing) {
      cataloguing = catalog
        .build(catalogFiles(), { onProgress: (done, total) => toManager('catalog', { done, total }) })
        .then((r) => (lastCatalog = { ...r, at: Date.now() }))
        .finally(() => (cataloguing = null));
    }
    await cataloguing;
  } else if (action === 'search') {
    return { results: await catalog.tvmaze.search(String(arg || '')) };
  } else if (action === 'set-show') {
    catalog.setShow(arg.name, arg.id);
  } else if (action === 'set-file') {
    catalog.setFile(arg.key, arg.fix || null);
  }
  return lastCatalog;
});

libHandle('lib:health', async (action, arg) => {
  if (!config) config = await readConfig();
  const chans = config.channels.map((c) => ({ ...c, type: c.source === 'youtube' ? 'youtube' : c.type }));
  if (action === 'check') {
    if (!checking) {
      checking = channelChecks
        .checkAll(chans)
        .then((r) => (lastChecks = r))
        .finally(() => {
          checking = null;
          toManager('health', healthView());
        });
    }
    toManager('health', healthView());
    await checking;
  } else if (action === 'check-one') {
    const ch = chans.find((c) => c.number === Number(arg));
    if (ch && ch.type === 'youtube-live') {
      // Look for the channel's current stream first (24/7 streams restart under new videos).
      const hit = await youtube.refreshLive(ch).catch(() => null);
      if (hit && hit.id && hit.id !== ch.videoId) {
        ch.videoId = hit.id;
        const real = config.channels.find((c) => c.number === ch.number);
        if (real) real.videoId = hit.id;
        notifyTv();
      }
    }
    if (ch) {
      const r = await channelChecks.checkAll([ch]);
      lastChecks.channels[ch.number] = r.channels[ch.number];
    }
  }
  return healthView();
});

libHandle('lib:linked', async (action, arg) => {
  if (action === 'pick') {
    const r = await dialog.showOpenDialog(managerWin, {
      title: 'Pick a folder or drive with videos',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return { folder: describeFolder(r.filePaths[0]), channels: channelFolders().map(({ number, name }) => ({ number, name })), free: freeNumbers(readSettingsFile()) };
  }
  if (action === 'save') {
    // arg: [{ path, channel } or { path, newChannel: { number, name, kids, family } }]
    const raw = readSettingsFile();
    raw.settings = raw.settings || {};
    const list = raw.settings.linkedFolders || [];
    for (const item of arg || []) {
      const p = path.resolve(String(item.path || ''));
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`Can't find ${p}`);
      let n = Number(item.channel);
      if (item.newChannel) {
        n = Number(item.newChannel.number);
        if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error('Channel numbers are 1 to 999');
        if (!channelFolders().some((c) => c.number === n)) {
          fs.mkdirSync(library.abs(`channels/${n} ${safeName(item.newChannel.name || path.basename(p), 'Channel')}`), { recursive: true });
        }
        for (const id of ['kids', 'family']) {
          const prof = raw.settings.profiles && raw.settings.profiles[id];
          if (item.newChannel[id] && prof && Array.isArray(prof.channels) && !prof.channels.includes(String(n))) prof.channels.push(String(n));
        }
      }
      if (!Number.isInteger(n)) throw new Error('Pick a channel for ' + path.basename(p));
      const at = list.findIndex((l) => path.resolve(l.path) === p);
      const entry = { path: p.split(path.sep).join('/'), channel: n };
      if (at >= 0) list[at] = entry;
      else list.push(entry);
      linkedScans.delete(entry.path);
    }
    raw.settings.linkedFolders = list;
    writeSettingsFile(raw);
    linkedChanged();
  } else if (action === 'remove') {
    const raw = readSettingsFile();
    raw.settings.linkedFolders = (raw.settings.linkedFolders || []).filter((l) => l.path !== arg);
    writeSettingsFile(raw);
    linkedScans.delete(arg);
    linkedChanged();
  } else if (action === 'rescan') {
    linkedScans.clear();
    linkedChanged();
  }
  return { linked: linkedList(), measuring: probes().status(), ffprobe: !!tools().ffprobe };
});

// A setup file for the phone app: lineup, time blocks, profiles, and the details of every video
// the phone can play, so copied files are recognized by name. The PIN stays on the PC.
libHandle('lib:export-phone', async () => {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const { pin, ffprobePath, mediaFolder, linkedFolders, display, ...settings } = raw.settings || {};
  const folders = channelFolders();
  const entries = library
    .list()
    .filter((e) => !e.missing && /\.(mp4|m4v|mov)$/i.test(e.path))
    .map((e) => {
      const parts = e.path.split('/');
      const folder = parts[0] === 'channels' ? folders.find((c) => c.folder === parts[1]) : null;
      const m = e.meta || {};
      return {
        name: parts[parts.length - 1],
        size: e.size,
        channel: folder ? folder.number : null,
        role: m.role === 'unassigned' ? 'show' : m.role || 'show',
        show: m.show || '',
        title: m.title,
        season: m.season,
        episode: m.episode,
        network: m.network,
        year: m.year,
        airDate: m.airDate,
        rating: m.rating,
        broadcast: !!m.broadcast,
      };
    });
  const data = {
    kind: 'retro-tv-phone-setup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    channels: folders.map((c) => ({ number: c.number, name: c.name, ...c.settings })),
    entries,
  };
  const r = await dialog.showSaveDialog(managerWin, {
    title: 'Save the setup for your phone',
    defaultPath: path.join(app.getPath('documents'), 'Retro TV phone setup.json'),
    filters: [{ name: 'Retro TV setup', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 1));
  shell.showItemInFolder(r.filePath);
  return { path: r.filePath, channels: data.channels.length, entries: entries.length };
});

libHandle('lib:channel-settings', (folderName, patch) => {
  const folder = channelFolders().find((c) => c.folder === folderName);
  if (!folder) throw new Error('No such channel folder');
  const file = library.abs(`channels/${folder.folder}/channel.json`);
  const next = { ...readChannelJson(path.dirname(file)) };
  for (const k of CHANNEL_KEYS) if (patch && k in patch) {
    if (patch[k] === null || patch[k] === '') delete next[k];
    else next[k] = patch[k];
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  notifyTv();
  return channelFolders();
});
