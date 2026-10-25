'use strict';
// The PC TV: the shared TV (src/tv-core.js) with the PC's own players and controls. Live sites
// and YouTube play in Electron webviews (cropped to the video by src/isolate.js), files play in a
// video element, video lengths are measured here, and it's driven by the keyboard and mouse wheel.

const $ = (s) => document.querySelector(s);
const screenEl = $('#screen');
const localVideo = $('#local');

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('rtv.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('rtv.' + k, JSON.stringify(v));
    } catch {}
  },
};

let live = null; // the live channel's webview: { wv, ch, since, watch, ready, clicked }
let ytNow = null; // a scheduled YouTube video's webview: { wv, poll, ready }
let filePlay = null; // the file in the video element: { stallTimer }

// ---------- Video lengths ----------
// Measured once (by ffprobe in the Library, or here in a hidden player) and kept by file.

let durations = {};
const probes = new Map(); // channel number -> promise

function probe(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      v.removeAttribute('src');
      v.load();
      resolve(d);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) return finish(v.duration);
      // Some WebM files don't store their length; seeking to the end makes the browser find it.
      v.ondurationchange = () => Number.isFinite(v.duration) && finish(v.duration);
      v.currentTime = 1e101;
    };
    v.onerror = () => finish(0);
    setTimeout(() => finish(0), 20000);
    v.src = file.url;
  });
}

let saveTimer = 0;
function ensureProbed(ch) {
  if (probes.has(ch.number)) return probes.get(ch.number);
  const borrowed = (ch.blocks || []).filter((b) => b.channel != null).flatMap((b) => (tvc.state.all.find((c) => c.number === Number(b.channel)) || { episodes: [] }).episodes);
  const files = [...ch.episodes, ...borrowed, ...ch.bumpers, ...ch.commercials].filter((f) => {
    // ffprobe already measured it: no need to load it in a hidden player.
    if (f.dur && !(f.key in durations)) durations[f.key] = f.dur;
    return !(f.key in durations);
  });
  const run = (async () => {
    const queue = files.slice();
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        durations[f.key] = await probe(f);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    tvc.state.cycles.delete(ch.number);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => tv.saveDurations(durations), 500);
  })();
  probes.set(ch.number, run);
  return run;
}

// ---------- Files ----------

// A file (on this PC, a linked drive or another Retro TV) in the video element, watched for
// errors and for stalling.
function playFile(cur, ctl) {
  filePlay = { stallTimer: 0 };
  const me = filePlay;
  localVideo.onloadedmetadata = () => {
    if (!ctl.current()) return;
    localVideo.currentTime = Math.min(cur.offset, Math.max(0, (localVideo.duration || Infinity) - 1));
    localVideo.play().catch(() => {});
  };
  localVideo.onplaying = () => {
    clearTimeout(me.stallTimer);
    ctl.started();
  };
  localVideo.onwaiting = () => {
    if (!cur.ok) return;
    clearTimeout(me.stallTimer);
    me.stallTimer = setTimeout(() => ctl.current() && ctl.stalled(), 20000);
  };
  localVideo.onended = () => ctl.finished();
  localVideo.onerror = () => {
    const code = localVideo.error && localVideo.error.code;
    const local = /^file:/.test(cur.file.url || '');
    // Couldn't decode, or a file on this computer that won't open: rest it for longer.
    ctl.failed(['', 'stopped', 'network error', "couldn't decode", 'missing or unsupported'][code] || 'error', code === 3 || (code === 4 && local));
  };
  localVideo.src = cur.file.stream || cur.file.url;
  localVideo.classList.add('on');
  applyVolume();
}

// ---------- YouTube videos on scheduled channels ----------

// One scheduled YouTube video in YouTube's own watch page, cropped to the video, starting where
// the schedule says. Moves on when the video really ends (an ad first can delay it).
function playYouTube(cur, ctl) {
  const file = cur.file;
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:tv');
  wv.setAttribute('src', `https://www.youtube.com/watch?v=${file.youtube}&t=${Math.floor(cur.offset)}s`);
  const me = { wv, poll: 0, ready: false };
  wv.addEventListener('dom-ready', () => {
    if (!ctl.current() || ytNow !== me) return;
    me.ready = true;
    wv.insertCSS(RTV_ISOLATE.css).catch(() => {});
    wv.executeJavaScript(RTV_ISOLATE.js())
      .then(() => file.crop && wv.executeJavaScript(`window.__rtv.crop = ${JSON.stringify(file.crop)}`))
      .then(applyVolume, () => {});
  });
  screenEl.insertBefore(wv, $('#standby'));
  ytNow = me;

  const started = Date.now();
  const expected = ((file.dur || cur.loc.item.dur) - cur.offset) * 1000;
  let idleSince = 0;
  let lastT = -1;
  let stuckSince = 0;
  me.poll = setInterval(async () => {
    if (!ctl.current() || ytNow !== me) return;
    let s = null;
    if (me.ready) try {
      s = await wv.executeJavaScript(`(() => {
        const v = document.querySelector('.rtv-target');
        const p = document.querySelector('#movie_player');
        const err = document.querySelector('.ytp-error');
        if (err && err.offsetParent !== null) return { error: true };
        return v && v.tagName === 'VIDEO' ? { t: v.currentTime, d: v.duration, ended: v.ended, paused: v.paused, ad: !!(p && p.classList.contains('ad-showing')), skip: window.__rtv && __rtv.skip } : null;
      })()`);
    } catch {}
    if (ytNow !== me) return;
    if (s && s.error) return ctl.failed('removed, private or blocked', true);
    if (s && !s.paused && !s.ad) ctl.started();
    // Playing but not moving (and not an ad): stuck buffering.
    if (s && cur.ok && !s.paused && !s.ad) {
      if (s.t !== lastT) stuckSince = 0;
      else if (!stuckSince) stuckSince = Date.now();
      else if (Date.now() - stuckSince > 25000) return ctl.stalled();
      lastT = s.t;
    }
    // A skippable ad: press Skip, as a person would (YouTube ignores scripted clicks on it).
    if (s && s.ad && s.skip) clickAt(wv, s.skip.x, s.skip.y);
    if (s && !s.ad && (s.ended || (s.d && s.t >= s.d - 1))) return ctl.finished();
    if (!s && Date.now() - started > 30000) return ctl.failed('the video never appeared');
    if (Date.now() - started > expected + 10 * 60000) return ctl.finished(); // never sit on a stuck page
    if (s && s.paused && !s.ad) {
      // "Are you still watching?" and friends: press play again.
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince > 6000) {
        wv.executeJavaScript(`document.querySelector('.rtv-target') && document.querySelector('.rtv-target').play()`).catch(() => {});
        idleSince = 0;
      }
    } else idleSince = 0;
    if (s && !s.paused) tvc.standby(null);
  }, 2000);
}

// Stop whatever the scheduled channel is playing (a file or a YouTube video).
function stopItem() {
  if (ytNow) {
    clearInterval(ytNow.poll);
    ytNow.wv.remove();
    ytNow = null;
  }
  if (filePlay) clearTimeout(filePlay.stallTimer);
  filePlay = null;
  localVideo.onloadedmetadata = localVideo.onended = localVideo.onerror = localVideo.onplaying = localVideo.onwaiting = null;
  localVideo.pause();
  localVideo.removeAttribute('src');
  localVideo.load();
  localVideo.classList.remove('on');
}

// ---------- Live channels (other sites' players) ----------

const hasStatus = (ch) => ch.type === 'owncast' || ch.type === 'twitch' || ch.type === 'youtube-live';

function liveUrl(ch) {
  const id = encodeURIComponent(ch.channel || '');
  switch (ch.type) {
    case 'twitch':
      return `https://player.twitch.tv/?channel=${id}&parent=localhost&autoplay=true&muted=false`;
    case 'vaughn':
      return `https://vaughn.live/${id}`;
    case 'owncast':
      return new URL('/embed/video', ch.url).href;
    case 'youtube-live': {
      // The stream's current video (it changes when a 24/7 stream restarts).
      const vid = (tvc.state.status.get(ch.number) || {}).videoId || ch.videoId;
      return vid ? `https://www.youtube.com/watch?v=${vid}` : null;
    }
    default:
      return ch.url;
  }
}

const noInternet = () => tvc.standby('NO SIGNAL', 'The internet is down. Your own channels still work.');

function playLive(ch, t) {
  if (!navigator.onLine) return noInternet();
  const url = liveUrl(ch);
  if (!url) {
    // A YouTube stream we haven't found yet: look again, and tune in if it's on.
    tvc.offAir(ch, {});
    tvc.refreshStatus(ch, true).then((st) => t === tvc.token && st && st.online && tvc.tune(tvc.state.index, { quiet: true }));
    return;
  }
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:tv');
  wv.setAttribute('src', url);
  wv.addEventListener('dom-ready', () => {
    if (t !== tvc.token || !live) return;
    live.ready = true;
    wv.insertCSS(RTV_ISOLATE.css).catch(() => {});
    wv.executeJavaScript(RTV_ISOLATE.js(ch.start)).then(applyVolume, () => {});
  });
  screenEl.insertBefore(wv, $('#standby'));
  live = { wv, ch, since: Date.now(), watch: 0, ready: false, clicked: false };
  const me = live;
  const health = tvc.health;

  // If nothing is playing after a while, show a standby card instead of a frozen page.
  live.watch = setInterval(async () => {
    if (t !== tvc.token || live !== me) return;
    let s = null;
    if (me.ready) try {
      s = await wv.executeJavaScript('window.__rtv ? { found: __rtv.found, playing: __rtv.playing, frame: __rtv.frame, skip: __rtv.skip } : null');
    } catch {}
    if (s && s.skip) clickAt(wv, s.skip.x, s.skip.y); // YouTube ad: press Skip
    const st = tvc.state.status.get(ch.number);
    // A player that's there but idle gets one real click in the middle, like pressing play.
    // Players inside an iframe (YouTube) can't report whether they're playing, so they get
    // their click later, once the page has had time to start them itself.
    const clickAfter = s && s.frame ? 12000 : 4000;
    if (s && s.found && !s.playing && !me.clicked && Date.now() - me.since > clickAfter) {
      me.clicked = true;
      clickCenter(wv);
    }
    // Players inside an iframe can't say whether they're playing: those stay "unverified".
    if (s && s.playing && !me.ok) {
      me.ok = true;
      health.ok('live:' + ch.number, { loadMs: Date.now() - me.since, kind: ch.type });
    }
    if (s && (s.playing || s.frame)) tvc.standby(null);
    else if (!navigator.onLine) noInternet();
    else if (st && !st.online) tvc.offAir(ch, st);
    else if (Date.now() - me.since > 15000) {
      tvc.standby('PLEASE STAND BY', `${ch.name} is having technical difficulties`);
      // One fresh start of the page, then it counts as a failure.
      if (!me.reloaded && Date.now() - me.since > 30000) {
        me.reloaded = true;
        me.clicked = false;
        try {
          wv.reload();
        } catch {}
      } else if (me.reloaded && !me.failed && Date.now() - me.since > 60000) {
        me.failed = true;
        health.fail('live:' + ch.number, { reason: 'never started playing', kind: ch.type });
        // A 24/7 YouTube stream may have restarted under a new video: look it up afresh.
        if (ch.type === 'youtube-live') {
          tvc.refreshStatus(ch, true).then((st) => t === tvc.token && live === me && st && st.videoId && st.videoId !== url.split('v=')[1] && tvc.tune(tvc.state.index, { quiet: true }));
        }
      }
    }
  }, 2000);

  if (hasStatus(ch)) tvc.refreshStatus(ch).then((st) => t === tvc.token && st && !st.online && tvc.offAir(ch, st));
}

function stopLive() {
  if (!live) return;
  clearInterval(live.watch);
  live.wv.remove();
  live = null;
}

function clickCenter(wv) {
  const r = wv.getBoundingClientRect();
  clickAt(wv, Math.round(r.width / 2), Math.round(r.height / 2));
}

// A real (trusted) click inside a webview, at page coordinates.
function clickAt(wv, x, y) {
  const at = { x, y, button: 'left', clickCount: 1 };
  wv.sendInputEvent({ type: 'mouseMove', x, y });
  wv.sendInputEvent({ type: 'mouseDown', ...at });
  wv.sendInputEvent({ type: 'mouseUp', ...at });
}

// ---------- Sound ----------

function applyVolume() {
  const { volume, muted } = tvc.state;
  localVideo.volume = volume;
  localVideo.muted = muted;
  for (const w of [live, ytNow]) {
    if (!w || !w.ready) continue;
    try {
      w.wv.setAudioMuted(muted);
      w.wv.executeJavaScript(`window.__rtv && (__rtv.volume = ${volume}, __rtv.muted = ${muted})`).catch(() => {});
    } catch {}
  }
}

let volTimer = 0;
function showVolume() {
  const el = $('#vol');
  const bars = Math.round(tvc.state.volume * 20);
  el.textContent = tvc.state.muted ? 'MUTE' : `VOLUME ${'|'.repeat(bars)}${'.'.repeat(20 - bars)}`;
  el.classList.add('on');
  clearTimeout(volTimer);
  volTimer = setTimeout(() => el.classList.remove('on'), 2500);
}

// ---------- The shared TV ----------

const tvc = TVCore.create({
  store,
  durationOf: (f) => durations[f.key] || 0,
  kindOf: (f) => (f.youtube ? 'youtube' : f.stream || /^https?:/.test(f.url || '') ? 'remote' : 'file'),
  async prepare(ch, t) {
    if (ch.episodes.some((f) => !(f.key in durations))) tvc.standby('PLEASE STAND BY', 'Setting up the schedule...');
    await ensureProbed(ch);
  },
  playFile,
  playYouTube,
  stopItem,
  playLive,
  stopLive,
  hasStatus,
  status: async (ch, force) => tv.status(ch.number, force),
  applyVolume,
  showVolume,
  snowVolume: () => tvc.state.volume,
  noShows: (ch) => ['NO SHOWS YET', ch.folder ? `Add videos to ${ch.folder}` : 'Add videos in the Library window'],
  // Measure the new lineup's videos in the background, so the guide fills in.
  lineupChanged() {
    probes.clear();
    setTimeout(() => tvc.state.channels.forEach((ch) => ch.type === 'local' && ensureProbed(ch)), 0);
  },
  reportHealth: (report) => tv.reportHealth && tv.reportHealth(report),
  healthLimit: 800,
});

function toggleCrt() {
  const on = !document.body.classList.contains('crt');
  document.body.classList.toggle('crt', on);
  store.set('crt', on);
}

const help = $('#help');
const menu = $('#menu');

// ---------- Profiles and PIN (keyboard) ----------

// PIN pad: resolves true if the right PIN is typed. No PIN set means no lock.
let pinResolve = null;
let pinDigits = '';
function askPin(reason) {
  const pin = String(tvc.state.settings.pin || '');
  if (!pin) return Promise.resolve(true);
  pinDigits = '';
  menu.replaceChildren(h2(reason), lineEl('PIN  ' + '_'.repeat(pin.length), 'pin'), lineEl('Esc to cancel', 'hint'));
  menu.hidden = false;
  return new Promise((resolve) => (pinResolve = resolve));
}

function pinKey(e) {
  const pin = String(tvc.state.settings.pin || '');
  const finish = (ok) => {
    menu.hidden = true;
    const r = pinResolve;
    pinResolve = null;
    r(ok);
  };
  if (e.key === 'Escape') return finish(false);
  if (e.key === 'Backspace') pinDigits = pinDigits.slice(0, -1);
  else if (/^[0-9]$/.test(e.key)) pinDigits += e.key;
  menu.querySelector('.pin').textContent = 'PIN  ' + '*'.repeat(pinDigits.length) + '_'.repeat(Math.max(0, pin.length - pinDigits.length));
  if (pinDigits.length >= pin.length) {
    if (pinDigits === pin) return finish(true);
    pinDigits = '';
    menu.querySelector('.pin').textContent = 'WRONG PIN';
  }
}

const h2 = (text) => Object.assign(document.createElement('h2'), { textContent: text });
const lineEl = (text, cls = '') => Object.assign(document.createElement('div'), { textContent: text, className: cls });

function openProfileMenu() {
  const profiles = tvc.profiles();
  const ids = Object.keys(profiles);
  if (!ids.length) return tvc.flashOsd('NO PROFILES', 'SEE README', 2500);
  menu.replaceChildren(
    h2('WHO\'S WATCHING?'),
    ...ids.map((id, i) => lineEl(`${i + 1}  ${(profiles[id].label || id).toUpperCase()}${profiles[id].locked ? '  (PIN)' : ''}${id === tvc.state.profile ? '  <' : ''}`)),
    lineEl('Press a number. Esc to cancel', 'hint')
  );
  menu.hidden = false;
  menu.dataset.mode = 'profiles';
}

async function profileMenuKey(e) {
  const profiles = tvc.profiles();
  const ids = Object.keys(profiles);
  menu.hidden = true;
  delete menu.dataset.mode;
  const id = ids[Number(e.key) - 1];
  if (!id || id === tvc.state.profile) return;
  if (profiles[id].locked && !(await askPin(`UNLOCK ${(profiles[id].label || id).toUpperCase()}`))) return;
  tvc.setProfile(id);
}

async function openLibraryWindow() {
  if (await askPin('LIBRARY')) tv.openLibrary();
}

// ---------- The remote (keyboard and mouse wheel) ----------

document.addEventListener('keydown', (e) => remoteKey(e));
tv.onKey((k) => remoteKey({ key: k.key, ctrlKey: k.ctrl, preventDefault() {} }));

function remoteKey(e) {
  const k = e.key;
  const s = tvc.state;
  if (e.ctrlKey && k.toLowerCase() === 'q') return turnOff();
  if (e.ctrlKey && k.toLowerCase() === 'd') return tv.nextDisplay();
  if (pinResolve) return pinKey(e);
  if (menu.dataset.mode === 'profiles') return profileMenuKey(e);
  if (!help.hidden) {
    help.hidden = true;
    return;
  }
  if (Guide.isOpen() && Guide.key(e)) return;

  if (k === 'ArrowUp' || k === 'PageUp') tvc.tune(s.index + 1);
  else if (k === 'ArrowDown' || k === 'PageDown') tvc.tune(s.index - 1);
  else if (k === 'ArrowRight' || k === '+' || k === '=') tvc.changeVolume(0.05);
  else if (k === 'ArrowLeft' || k === '-' || k === '_') tvc.changeVolume(-0.05);
  else if (/^[0-9]$/.test(k)) tvc.typeDigit(k);
  else if (k === 'Enter' && tvc.enterDigits()) {
    // tuned to the typed number
  } else if (k === 'Backspace' && s.last != null) tvc.tune(s.last);
  else if (k.toLowerCase() === 'm') tvc.toggleMute();
  else if (k.toLowerCase() === 'g') Guide.open(tvc.guideApi());
  else if (k.toLowerCase() === 'i' || k === 'Enter') tvc.showBanner();
  else if (k.toLowerCase() === 'c') toggleCrt();
  else if (k.toLowerCase() === 'p' && live && live.ready) clickCenter(live.wv);
  else if (k.toLowerCase() === 'k') openProfileMenu();
  else if (k.toLowerCase() === 'o') tvc.toggleOrder();
  else if (k.toLowerCase() === 'l') openLibraryWindow();
  else if (k.toLowerCase() === 'h' || k === '?' || k === 'F1') help.hidden = false;
  else return;
  e.preventDefault();
}

let wheelAt = 0;
document.addEventListener(
  'wheel',
  (e) => {
    const now = Date.now();
    if (now - wheelAt < 250) return;
    wheelAt = now;
    const d = e.deltaY < 0 ? 1 : -1;
    if (Guide.isOpen()) Guide.scrollBy(-d);
    else tvc.tune(tvc.state.index + d);
  },
  { passive: true }
);

async function turnOff() {
  tvc.teardown();
  await Effects.power('off');
  tv.quit();
}

// ---------- Power on ----------

async function loadConfig() {
  const cfg = await tv.config();
  tvc.setLineup(cfg.settings, cfg.channels);
}

// The Library window changed something (download finished, file moved): pick it up live.
tv.onChanged(async () => {
  await loadConfig();
  const wasIdle = !tvc.localNow && !tvc.liveOn;
  const kept = tvc.applyProfile();
  if (!tvc.state.channels.length) return;
  if (!kept || wasIdle) tvc.tune(tvc.state.index, { quiet: true });
});

window.addEventListener('online', () => live && tvc.tune(tvc.state.index, { quiet: true }));
window.addEventListener('offline', () => live && noInternet());

(async function boot() {
  await loadConfig();
  durations = await tv.durations();
  document.body.classList.toggle('crt', store.get('crt', tvc.state.settings.crt !== false));
  tvc.start();
  Effects.power('on');
  if (!tvc.state.channels.length) {
    tvc.standby('NO CHANNELS', 'Add channels to channels.json or videos to media/channels');
    return;
  }
  tvc.tune(tvc.state.index, { quiet: true });
})();
