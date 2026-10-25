'use strict';

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

const state = {
  settings: {},
  all: [], // every channel from the config
  channels: [], // what the current profile can see, in channel order
  profile: null, // key into settings.profiles
  scheduledProfile: null,
  index: 0,
  last: null,
  volume: 0.8,
  muted: false,
  durations: {},
  cycles: new Map(), // channel number -> schedule cycle
  probes: new Map(), // channel number -> promise
  status: new Map(), // channel number -> { online, title, gone } for Twitch and Owncast channels
};

const hasStatus = (ch) => ch.type === 'owncast' || ch.type === 'twitch' || ch.type === 'youtube-live';

let token = 0; // bumps on every tune, so stale callbacks know to give up
let live = null; // { wv, ch, since, watch }
let localNow = null; // current schedule position on a local channel: { ch, loc, file, sub, slotStart, slotEnd }

// ---------- Playback health (src/health.js) ----------
// How every source has behaved, kept between runs. A failed source rests before it's tried again,
// and the schedule never changes because of it: its time slot gets a stand-in instead.

const health = Health.monitor({ records: store.get('health', {}) });
const keyOf = (f) => f.key || f.url;
const kindOf = (f) => (f.youtube ? 'youtube' : f.stream || /^https?:/.test(f.url || '') ? 'remote' : 'file');
// What actually aired (stand-ins included), newest last.
const played = store.get('played', []);
let lastLogged = '';

function logAired(ch, scheduled, file, reason) {
  const id = `${ch.number}|${keyOf(scheduled)}|${keyOf(file)}`;
  if (id === lastLogged) return;
  lastLogged = id;
  played.push({ at: Date.now(), ch: ch.number, scheduled: scheduled.title, aired: file.title, standIn: file !== scheduled || undefined, reason: reason || undefined });
  if (played.length > 200) played.splice(0, played.length - 200);
  store.set('played', played);
}

function channelHealth(ch) {
  if (ch.type === 'local') return health.channelStatus(ch.episodes.map(keyOf));
  return health.status('live:' + ch.number);
}

// Saved and sent to the Library every few seconds, when something changed.
setInterval(() => {
  if (!health.takeChanged()) return;
  store.set('health', health.all());
  if (!tv.reportHealth) return;
  tv.reportHealth({
    at: Date.now(),
    channels: state.all.map((ch) => {
      const keys = ch.type === 'local' ? ch.episodes.map(keyOf) : ['live:' + ch.number];
      const recs = keys.map((k) => health.get(k)).filter(Boolean);
      const bad = recs.filter((r) => r.failures > 0);
      return {
        number: ch.number,
        status: channelHealth(ch),
        sources: keys.length,
        failing: bad.length,
        lastOk: Math.max(0, ...recs.map((r) => r.lastOk || 0)) || null,
        lastFail: Math.max(0, ...recs.map((r) => r.lastFail || 0)) || null,
        lastError: (bad.sort((a, b) => b.lastFail - a.lastFail)[0] || {}).lastError || null,
      };
    }),
    aired: played.slice(-40),
  });
}, 5000);

// ---------- Local files: durations and schedules ----------

const durationOf = (f) => state.durations[f.key] || 0;

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

// Local channels as the current profile sees them (rating-filtered episodes), by number.
// Time blocks can borrow another channel's shows, even one the profile doesn't list.
const viewed = new Map();
const lookup = (n) => viewed.get(n) || null;

let saveTimer = 0;
function ensureProbed(ch) {
  if (state.probes.has(ch.number)) return state.probes.get(ch.number);
  const borrowed = (ch.blocks || []).filter((b) => b.channel != null).flatMap((b) => (lookup(Number(b.channel)) || { episodes: [] }).episodes);
  const files = [...ch.episodes, ...borrowed, ...ch.bumpers, ...ch.commercials].filter((f) => {
    // ffprobe already measured it: no need to load it in a hidden player.
    if (f.dur && !(f.key in state.durations)) state.durations[f.key] = f.dur;
    return !(f.key in state.durations);
  });
  const run = (async () => {
    const queue = files.slice();
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        state.durations[f.key] = await probe(f);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    state.cycles.delete(ch.number);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => tv.saveDurations(state.durations), 500);
  })();
  state.probes.set(ch.number, run);
  return run;
}

function cycleFor(ch) {
  if (!state.cycles.has(ch.number)) {
    const breaks = { bumpers: 1, commercials: 3, ...(state.settings.breaks || {}), ...(ch.breaks || {}) };
    state.cycles.set(ch.number, Schedule.build(withOrder(ch), durationOf, breaks, lookup));
  }
  return state.cycles.get(ch.number);
}

// Sports and wrestling channels ("order": "grouped") play in history order or at random; ORDER
// on the remote switches the channel you're on. Series and events stay in order either way.
function withOrder(ch) {
  const pref = ch.order === 'grouped' ? store.get('order.' + ch.number, null) : null;
  if (!pref) return ch;
  return { ...ch, groupOrder: pref === 'history' ? ch.historyOrder || 'date' : 'shuffle' };
}

function toggleOrder() {
  const ch = state.channels[state.index];
  if (!ch || ch.order !== 'grouped') return flashOsd('ORDER', 'THIS CHANNEL ALWAYS PLAYS AT RANDOM', 2500);
  const next = withOrder(ch).groupOrder === 'shuffle' ? 'history' : 'random';
  store.set('order.' + ch.number, next);
  state.cycles.delete(ch.number);
  tune(state.index, { quiet: true });
  flashOsd(next === 'history' ? 'IN HISTORY ORDER' : 'AT RANDOM', ch.name.toUpperCase(), 3000);
}

function listings(ch, from, to) {
  if (ch.type === 'local') {
    const sub = localNow && localNow.ch.number === ch.number && localNow.sub ? localNow : null;
    return Schedule.listings(cycleFor(ch), from, to).map((p) =>
      sub && Math.abs(p.start - sub.slotStart) < 2000 ? { ...p, title: `${showLabel(sub.file)} (stand-in)`, substituted: true } : { ...p, title: showLabel(p) }
    );
  }
  if (!navigator.onLine) return [{ live: true, off: true, title: 'No signal: the internet is down', start: from, end: to }];
  const st = state.status.get(ch.number);
  const off = !!st && !st.online;
  const title = (!off && st && st.title) || ch.description || ch.name;
  return [{ live: true, off, title, start: from, end: to }];
}

const showLabel = (p) => (p.show && p.show !== p.title && !p.title.startsWith(p.show) ? `${p.show}: ${p.title}` : p.title);

// ---------- Tuning ----------

function teardown() {
  if (live) {
    clearInterval(live.watch);
    live.wv.remove();
    live = null;
  }
  clearTimeout(blockTimer);
  clearTimeout(slotTimer);
  stopItem();
  localNow = null;
  standby(null);
}

// Stop whatever the scheduled channel is playing (a file or a YouTube video).
function stopItem() {
  if (ytNow) {
    clearInterval(ytNow.poll);
    ytNow.wv.remove();
    ytNow = null;
  }
  if (localPlay) {
    clearTimeout(localPlay.loadTimer);
    clearTimeout(localPlay.stallTimer);
    localPlay = null;
  }
  localVideo.onloadedmetadata = localVideo.onended = localVideo.onerror = localVideo.onplaying = localVideo.onwaiting = null;
  localVideo.pause();
  localVideo.removeAttribute('src');
  localVideo.load();
  localVideo.classList.remove('on');
}

function standby(big, small = '') {
  const el = $('#standby');
  el.hidden = !big;
  if (big) {
    el.querySelector('.big').textContent = big;
    el.querySelector('.small').textContent = small;
  }
}

function tune(i, { quiet = false } = {}) {
  const n = state.channels.length;
  if (!n) return;
  i = ((i % n) + n) % n;
  if (i !== state.index) state.last = state.index;
  state.index = i;
  const ch = state.channels[i];
  store.set('channel', ch.number);
  const t = ++token;

  Effects.snow(quiet ? 300 : 650, state.muted ? 0 : state.volume);
  teardown();
  showOsd(ch);
  if (ch.type === 'local') playLocal(ch, t);
  else playLive(ch, t);
  setTimeout(() => t === token && showBanner(), 700);
}

function tuneNumber(num) {
  const i = state.channels.findIndex((c) => c.number === num);
  if (i >= 0) tune(i);
  else flashOsd(String(num).padStart(2, '0'), 'NO SIGNAL');
}

// ---------- Live channels (other sites' players) ----------

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
      const vid = (state.status.get(ch.number) || {}).videoId || ch.videoId;
      return vid ? `https://www.youtube.com/watch?v=${vid}` : null;
    }
    default:
      return ch.url;
  }
}

const noInternet = () => standby('NO SIGNAL', 'The internet is down. Your own channels still work.');

function playLive(ch, t) {
  if (!navigator.onLine) return noInternet();
  const url = liveUrl(ch);
  if (!url) {
    // A YouTube stream we haven't found yet: look again, and tune in if it's on.
    offAir(ch, {});
    refreshStatus(ch).then((st) => t === token && st && st.online && tune(state.index, { quiet: true }));
    return;
  }
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:tv');
  wv.setAttribute('src', url);
  wv.addEventListener('dom-ready', () => {
    if (t !== token) return;
    live.ready = true;
    wv.insertCSS(RTV_ISOLATE.css).catch(() => {});
    wv.executeJavaScript(RTV_ISOLATE.js(ch.start)).then(applyVolume, () => {});
  });
  screenEl.insertBefore(wv, $('#standby'));
  live = { wv, ch, since: Date.now(), watch: 0, ready: false, clicked: false };

  // If nothing is playing after a while, show color bars instead of a frozen page.
  live.watch = setInterval(async () => {
    if (t !== token || !live) return;
    let s = null;
    if (live.ready) try {
      s = await wv.executeJavaScript('window.__rtv ? { found: __rtv.found, playing: __rtv.playing, frame: __rtv.frame, skip: __rtv.skip } : null');
    } catch {}
    if (s && s.skip) clickAt(wv, s.skip.x, s.skip.y); // YouTube ad: press Skip
    const st = state.status.get(ch.number);
    // A player that's there but idle gets one real click in the middle, like pressing play.
    // Players inside an iframe (YouTube) can't report whether they're playing, so they get
    // their click later, once the page has had time to start them itself.
    const clickAfter = s && s.frame ? 12000 : 4000;
    if (s && s.found && !s.playing && !live.clicked && Date.now() - live.since > clickAfter) {
      live.clicked = true;
      clickCenter(wv);
    }
    // Players inside an iframe can't say whether they're playing: those stay "unverified".
    if (s && s.playing && !live.ok) {
      live.ok = true;
      health.ok('live:' + ch.number, { loadMs: Date.now() - live.since, kind: ch.type });
    }
    if (s && (s.playing || s.frame)) standby(null);
    else if (!navigator.onLine) noInternet();
    else if (st && !st.online) offAir(ch, st);
    else if (Date.now() - live.since > 15000) {
      standby('PLEASE STAND BY', `${ch.name} is having technical difficulties`);
      // One fresh start of the page, then it counts as a failure.
      if (!live.reloaded && Date.now() - live.since > 30000) {
        live.reloaded = true;
        live.clicked = false;
        try {
          wv.reload();
        } catch {}
      } else if (live.reloaded && !live.failed && Date.now() - live.since > 60000) {
        live.failed = true;
        health.fail('live:' + ch.number, { reason: 'never started playing', kind: ch.type });
      }
    }
  }, 2000);

  if (hasStatus(ch)) {
    refreshStatus(ch).then((st) => t === token && st && !st.online && offAir(ch, st));
  }
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

function offAir(ch, st) {
  standby('OFF THE AIR', st.gone ? `${ch.name} has signed off for good` : `${ch.name} isn't broadcasting right now`);
}

async function refreshStatus(ch) {
  const s = await tv.status(ch.number);
  if (s) state.status.set(ch.number, s);
  return s;
}

// ---------- Local channels (your own files) ----------

async function playLocal(ch, t) {
  if (!ch.episodes.length) {
    standby('NO SHOWS YET', `Add videos to ${ch.folder}`);
    return;
  }
  if (ch.episodes.some((f) => !(f.key in state.durations))) standby('PLEASE STAND BY', 'Setting up the schedule...');
  await ensureProbed(ch);
  if (t !== token) return;
  standby(null);
  playLocalAt(ch, Date.now(), t);
}

let blockTimer = 0;
let slotTimer = 0;
let localPlay = null; // the file playing in the local player: { ...cur, loadTimer, stallTimer }

// Plays what the schedule says is on at `at`. opts (from recovery): { file, offset } plays that
// instead in this time slot; retries / altTried / tried count what's been attempted for it.
function playLocalAt(ch, at, t, opts = {}) {
  clearTimeout(blockTimer);
  clearTimeout(slotTimer);
  const cyc = cycleFor(ch);
  const loc = Schedule.locate(cyc, at);
  if (!loc) {
    standby('NO SIGNAL', "None of this channel's videos would play");
    return;
  }
  const scheduled = loc.item.file;
  const slotStart = Math.round(at - loc.offset * 1000);
  const slotEnd = slotStart + Math.round(loc.item.dur * 1000);
  const cur = { ch, t, loc, scheduled, slotStart, slotEnd, retries: opts.retries || 0, altTried: opts.altTried || 0, tried: opts.tried || [], reason: opts.reason };
  cur.file = opts.file || scheduled;
  cur.offset = opts.file ? opts.offset || 0 : loc.offset;
  // The scheduled source failed recently and is resting: go straight to a stand-in.
  if (!opts.file && !opts.force && !health.usable(keyOf(scheduled))) {
    const sub = standIn(cur, []);
    if (!sub) return standbyUntil(cur);
    cur.file = sub.file;
    cur.offset = sub.offset;
    cur.reason = 'scheduled video is unavailable';
  }
  localNow = { ch, loc, file: cur.file, sub: cur.file !== scheduled ? { original: scheduled } : null, slotStart, slotEnd, startedAt: Date.now() };
  if (loc.item.kind === 'show') logAired(ch, scheduled, cur.file, cur.reason);
  // A time block starting (or ending) mid-show cuts over, like the real schedule did.
  const untilSwitch = loc.contextEnd - Date.now();
  if (untilSwitch < (loc.item.dur - loc.offset) * 1000 && untilSwitch < 2 ** 31 - 1) {
    blockTimer = setTimeout(() => t === token && playLocalAt(ch, Date.now() + 250, t), Math.max(0, untilSwitch) + 100);
  }
  // A stand-in only fills its slot; then the schedule carries on as planned.
  if (cur.file !== scheduled) slotTimer = setTimeout(() => t === token && playLocalAt(ch, Date.now() + 250, t), Math.max(0, slotEnd - Date.now()) + 100);
  stopItem();
  standby(null);
  if (cur.file.youtube) return playYouTubeItem(cur);
  playFile(cur);
}

// A stand-in for the slot: the same show first, then the channel's other programs of that kind
// (episodes for episodes, ads for ads). It joins in progress if it's long enough, like the
// scheduled one would have.
function standIn(cur, exclude) {
  const kind = cur.loc.item.kind;
  const pool = (kind === 'bumper' ? cur.ch.bumpers : kind === 'commercial' ? cur.ch.commercials : cur.ch.episodes).map((f) => ({ ...f, dur: durationOf(f) }));
  const pick = Health.substitute(cur.scheduled, pool, { usable: health.usable, seed: `${cur.ch.number}|${cur.slotStart}`, exclude: [...cur.tried, ...exclude] });
  if (!pick) return null;
  const file = (pick.key && pool.find((f) => f.key === pick.key)) || pick;
  const elapsed = (Date.now() - cur.slotStart) / 1000;
  return { file, offset: pick.dur > elapsed + 30 ? Math.max(0, elapsed) : 0 };
}

// Nothing left to play in this slot: a standby card until the next one.
function standbyUntil(cur) {
  localNow = { ch: cur.ch, loc: cur.loc, file: cur.scheduled, sub: null, slotStart: cur.slotStart, slotEnd: cur.slotEnd, startedAt: Date.now() };
  stopItem();
  standby('PLEASE STAND BY', "We'll be right back");
  slotTimer = setTimeout(() => cur.t === token && playLocalAt(cur.ch, Date.now() + 250, cur.t), Math.max(0, cur.slotEnd - Date.now()) + 100);
}

// Something in a slot failed: try again, another copy of it, or a stand-in (see src/health.js).
function recover(cur, reason, permanent = false) {
  if (cur.t !== token || cur.done) return;
  cur.done = true;
  const { ch, t } = cur;
  health.fail(keyOf(cur.file), { reason, permanent, kind: kindOf(cur.file) });
  const isScheduled = cur.file === cur.scheduled;
  const alternates = (cur.scheduled.alternates || []).length;
  const step = isScheduled || cur.altTried ? Health.nextStep({ retries: cur.retries, permanent, alternates, alternatesTried: cur.altTried }) : 'substitute';
  if (step === 'retry') return playLocalAt(ch, Date.now(), t, { retries: cur.retries + 1, force: true, reason });
  if (step === 'alternate') {
    return playLocalAt(ch, Date.now(), t, { file: cur.scheduled.alternates[cur.altTried], offset: (Date.now() - cur.slotStart) / 1000, altTried: cur.altTried + 1, retries: cur.retries, reason });
  }
  const sub = standIn(cur, [keyOf(cur.file)]);
  if (!sub) return standbyUntil(cur);
  playLocalAt(ch, Date.now(), t, { file: sub.file, offset: sub.offset, tried: [...cur.tried, keyOf(cur.file)], retries: 99, reason });
}

// Whatever was playing in the slot finished. A stand-in shorter than its slot hands over to
// another one; otherwise the schedule moves on.
function finished(cur) {
  if (cur.t !== token || cur.done) return;
  cur.done = true;
  health.ok(keyOf(cur.file), { kind: kindOf(cur.file) });
  if (cur.file !== cur.scheduled && Date.now() < cur.slotEnd - 3000) {
    const sub = standIn(cur, [keyOf(cur.file)]);
    if (!sub) return standbyUntil(cur);
    return playLocalAt(cur.ch, Date.now(), cur.t, { file: sub.file, offset: 0, tried: [...cur.tried, keyOf(cur.file)], retries: 99, reason: cur.reason });
  }
  playLocalAt(cur.ch, Date.now() + 750, cur.t);
}

// A file (on this PC, a linked drive or another Retro TV) in the local player, watched for
// errors, for not starting, and for stalling.
function playFile(cur) {
  const started = Date.now();
  localPlay = cur;
  let playing = false;
  cur.loadTimer = setTimeout(() => !playing && recover(cur, 'took too long to start'), 25000);
  localVideo.onloadedmetadata = () => {
    if (cur.t !== token) return;
    localVideo.currentTime = Math.min(cur.offset, Math.max(0, (localVideo.duration || Infinity) - 1));
    localVideo.play().catch(() => {});
  };
  localVideo.onplaying = () => {
    if (cur.t !== token) return;
    clearTimeout(cur.stallTimer);
    if (playing) return;
    playing = true;
    clearTimeout(cur.loadTimer);
    health.ok(keyOf(cur.file), { loadMs: Date.now() - started, kind: kindOf(cur.file) });
  };
  localVideo.onwaiting = () => {
    if (cur.t !== token || !playing) return;
    clearTimeout(cur.stallTimer);
    cur.stallTimer = setTimeout(() => {
      health.stall(keyOf(cur.file));
      recover(cur, 'stalled while playing');
    }, 20000);
  };
  localVideo.onended = () => finished(cur);
  localVideo.onerror = () => {
    const code = localVideo.error && localVideo.error.code;
    const local = /^file:/.test(cur.file.url || '');
    // Couldn't decode, or a file on this computer that won't open: rest it for longer.
    recover(cur, ['', 'stopped', 'network error', "couldn't decode", 'missing or unsupported'][code] || 'error', code === 3 || (code === 4 && local));
  };
  localVideo.src = cur.file.stream || cur.file.url;
  localVideo.classList.add('on');
  applyVolume();
  if (cur.loc.item.kind === 'show' && cur.offset < 2) setTimeout(() => cur.t === token && showBanner(), 1000);
}

// ---------- YouTube videos on scheduled channels ----------

// Plays one scheduled YouTube video in YouTube's own watch page, cropped to the video, starting
// where the schedule says. Moves on when the video really ends (an ad first can delay it).
let ytNow = null; // { wv, poll, ready }
function playYouTubeItem(cur) {
  const { ch, t, file } = cur;
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:tv');
  wv.setAttribute('src', `https://www.youtube.com/watch?v=${file.youtube}&t=${Math.floor(cur.offset)}s`);
  const me = { wv, poll: 0, ready: false };
  wv.addEventListener('dom-ready', () => {
    if (t !== token || ytNow !== me) return;
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
  let playing = false;
  let lastT = -1;
  let stuckSince = 0;
  const next = () => ytNow === me && finished(cur);
  const skip = (reason, permanent) => ytNow === me && recover(cur, reason, permanent);
  me.poll = setInterval(async () => {
    if (t !== token || ytNow !== me) return;
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
    const elapsed = Date.now() - started;
    if (s && s.error) return skip('removed, private or blocked', true);
    if (s && !s.paused && !s.ad && !playing) {
      playing = true;
      health.ok(keyOf(file), { loadMs: Date.now() - started, kind: 'youtube' });
    }
    // Playing but not moving (and not an ad): stuck buffering.
    if (s && playing && !s.paused && !s.ad) {
      if (s.t !== lastT) stuckSince = 0;
      else if (!stuckSince) stuckSince = Date.now();
      else if (Date.now() - stuckSince > 25000) {
        health.stall(keyOf(file));
        return skip('stalled while playing');
      }
      lastT = s.t;
    }
    // A skippable ad: press Skip, as a person would (YouTube ignores scripted clicks on it).
    if (s && s.ad && s.skip) clickAt(wv, s.skip.x, s.skip.y);
    if (s && !s.ad && (s.ended || (s.d && s.t >= s.d - 1))) return next();
    if (!s && elapsed > 30000) return skip('the video never appeared');
    if (elapsed > expected + 10 * 60000) return next(); // never sit on a stuck page
    if (s && s.paused && !s.ad) {
      // "Are you still watching?" and friends: press play again.
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince > 6000) {
        wv.executeJavaScript(`document.querySelector('.rtv-target') && document.querySelector('.rtv-target').play()`).catch(() => {});
        idleSince = 0;
      }
    } else idleSince = 0;
    if (s && !s.paused) standby(null);
  }, 2000);
  if (cur.loc.item.kind === 'show' && cur.offset < 2) setTimeout(() => t === token && showBanner(), 1500);
}

// ---------- Sound ----------

function applyVolume() {
  localVideo.volume = state.volume;
  localVideo.muted = state.muted;
  for (const w of [live, ytNow]) {
    if (!w || !w.ready) continue;
    try {
      w.wv.setAudioMuted(state.muted);
      w.wv.executeJavaScript(`window.__rtv && (__rtv.volume = ${state.volume}, __rtv.muted = ${state.muted})`).catch(() => {});
    } catch {}
  }
}

function changeVolume(d) {
  state.muted = false;
  state.volume = Math.round(Math.min(1, Math.max(0, state.volume + d)) * 20) / 20;
  store.set('volume', state.volume);
  applyVolume();
  showVolume();
}

function toggleMute() {
  state.muted = !state.muted;
  applyVolume();
  showVolume();
}

// ---------- On-screen stuff ----------

let osdTimer = 0;
function flashOsd(big, small, ms = 3000) {
  const el = $('#osd');
  el.querySelector('.ch').textContent = big;
  el.querySelector('.name').textContent = small;
  el.classList.add('on');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.classList.remove('on'), ms);
}

const showOsd = (ch) => flashOsd(`CH ${String(ch.number).padStart(2, '0')}`, ch.name.toUpperCase());

let volTimer = 0;
function showVolume() {
  const el = $('#vol');
  const bars = Math.round(state.volume * 20);
  el.textContent = state.muted ? 'MUTE' : `VOLUME ${'|'.repeat(bars)}${'.'.repeat(20 - bars)}`;
  el.classList.add('on');
  clearTimeout(volTimer);
  volTimer = setTimeout(() => el.classList.remove('on'), 2500);
}

let bannerTimer = 0;
function showBanner() {
  const ch = state.channels[state.index];
  if (!ch) return;
  const el = $('#banner');
  const now = Date.now();
  const clock = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let nowText;
  let nextText = '';
  let progress = null;

  let netText = ch.name;
  if (ch.type === 'local' && localNow && localNow.ch.number === ch.number) {
    const lst = Schedule.listings(cycleFor(ch), now, now + 6 * 3600e3);
    const cur = lst[0];
    const nxt = lst[1];
    const file = localNow.file || localNow.loc.item.file;
    if (cur.block) netText += ` · ${cur.block}`;
    nowText = localNow.loc.item.kind === 'show' ? showLabel(cur) : `${showLabel(cur)} (commercial break)`;
    if (localNow.sub && localNow.loc.item.kind === 'show') nowText = `${showLabel(file)} (standing in for ${showLabel(localNow.sub.original)})`;
    if (cur.broadcast) {
      const aired = file.airDate ? new Date(file.airDate + 'T12:00').toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : file.year;
      nextText = ['Original broadcast', file.network, aired && `aired ${aired}`].filter(Boolean).join(' · ');
    } else if (nxt) nextText = `Up next at ${new Date(nxt.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${showLabel(nxt)}`;
    progress = Math.min(1, (now - cur.start) / (cur.end - cur.start));
  } else {
    nowText = listings(ch, now, now + 1)[0].title;
    const st = state.status.get(ch.number);
    nextText = ch.type === 'local' || (st && !st.online) ? '' : 'LIVE';
  }

  el.innerHTML = `
    <div class="num"></div>
    <div class="mid"><div class="net"></div><div class="now"></div><div class="next"></div></div>
    <div class="clock"></div>`;
  el.querySelector('.num').textContent = String(ch.number).padStart(2, '0');
  el.querySelector('.net').textContent = netText;
  el.querySelector('.now').textContent = nowText;
  const next = el.querySelector('.next');
  next.textContent = nextText;
  if (nextText === 'LIVE') next.className = 'next live';
  if (progress != null) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = '<i></i>';
    bar.firstChild.style.width = progress * 100 + '%';
    el.querySelector('.mid').appendChild(bar);
  }
  el.querySelector('.clock').textContent = clock;
  el.classList.add('on');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('on'), 5000);
}

function toggleCrt() {
  const on = !document.body.classList.contains('crt');
  document.body.classList.toggle('crt', on);
  store.set('crt', on);
}

const help = $('#help');
const menu = $('#menu');

// ---------- Profiles ----------

const profiles = () => state.settings.profiles || {};
const currentProfile = () => profiles()[state.profile] || null;

// Rebuild the visible lineup for the current profile, staying on the same channel if we can.
function applyProfile() {
  const p = currentProfile();
  const curNum = state.channels[state.index] && state.channels[state.index].number;
  viewed.clear();
  for (const ch of state.all) {
    if (ch.type === 'local') viewed.set(ch.number, { ...ch, episodes: ch.episodes.filter((f) => Profiles.allowsFile(p, f, ch)) });
  }
  // Folder channels with nothing (watchable) in them stay off the dial.
  state.channels = state.all
    .map((ch) => (ch.type === 'local' ? viewed.get(ch.number) : ch))
    .filter((ch) => Profiles.allowsChannel(p, ch) && (ch.type !== 'local' || ch.episodes.length));
  state.cycles.clear();
  state.probes.clear();
  const i = state.channels.findIndex((c) => c.number === curNum);
  state.index = i >= 0 ? i : 0;
  state.last = null;
  return i >= 0;
}

function setProfile(id, { announce = true } = {}) {
  if (!profiles()[id]) return;
  state.profile = id;
  store.set('profile', id);
  const kept = applyProfile();
  if (announce) flashOsd(profiles()[id].label || id.toUpperCase(), 'PROFILE', 3000);
  if (!state.channels.length) {
    teardown();
    return standby('NO CHANNELS', 'This profile has no channels with anything to watch');
  }
  if (!kept || !localNow) tune(state.index, { quiet: true });
  for (const ch of state.channels) if (ch.type === 'local') ensureProbed(ch);
}

// PIN pad: resolves true if the right PIN is typed. No PIN set means no lock.
let pinResolve = null;
let pinDigits = '';
function askPin(reason) {
  const pin = String(state.settings.pin || '');
  if (!pin) return Promise.resolve(true);
  pinDigits = '';
  menu.replaceChildren(h2(reason), lineEl('PIN  ' + '_'.repeat(pin.length), 'pin'), lineEl('Esc to cancel', 'hint'));
  menu.hidden = false;
  return new Promise((resolve) => (pinResolve = resolve));
}

function pinKey(e) {
  const pin = String(state.settings.pin || '');
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
  const ids = Object.keys(profiles());
  if (!ids.length) return flashOsd('NO PROFILES', 'SEE README', 2500);
  menu.replaceChildren(
    h2('WHO\'S WATCHING?'),
    ...ids.map((id, i) => lineEl(`${i + 1}  ${(profiles()[id].label || id).toUpperCase()}${profiles()[id].locked ? '  (PIN)' : ''}${id === state.profile ? '  <' : ''}`)),
    lineEl('Press a number. Esc to cancel', 'hint')
  );
  menu.hidden = false;
  menu.dataset.mode = 'profiles';
}

async function profileMenuKey(e) {
  const ids = Object.keys(profiles());
  menu.hidden = true;
  delete menu.dataset.mode;
  const id = ids[Number(e.key) - 1];
  if (!id || id === state.profile) return;
  if (profiles()[id].locked && !(await askPin(`UNLOCK ${(profiles()[id].label || id).toUpperCase()}`))) return;
  setProfile(id);
}

async function openLibraryWindow() {
  if (await askPin('LIBRARY')) tv.openLibrary();
}

// ---------- The remote ----------

let digits = '';
let digitTimer = 0;
function typeDigit(d) {
  digits += d;
  flashOsd(`CH ${digits.padEnd(2, '-')}`, '', 2000);
  clearTimeout(digitTimer);
  const maxNum = Math.max(...state.channels.map((c) => c.number));
  const go = () => {
    const n = Number(digits);
    digits = '';
    tuneNumber(n);
  };
  if (Number(digits + '0') > maxNum || digits.length >= 3) go();
  else digitTimer = setTimeout(go, 1500);
}

function guideApi() {
  return {
    channels: state.channels,
    current: () => state.index,
    listings,
    tune: (i) => tune(i),
  };
}

document.addEventListener('keydown', (e) => remoteKey(e));
tv.onKey((k) => remoteKey({ key: k.key, ctrlKey: k.ctrl, preventDefault() {} }));

function remoteKey(e) {
  const k = e.key;
  if (e.ctrlKey && k.toLowerCase() === 'q') return turnOff();
  if (e.ctrlKey && k.toLowerCase() === 'd') return tv.nextDisplay();
  if (pinResolve) return pinKey(e);
  if (menu.dataset.mode === 'profiles') return profileMenuKey(e);
  if (!help.hidden) {
    help.hidden = true;
    return;
  }
  if (Guide.isOpen() && Guide.key(e)) return;

  if (k === 'ArrowUp' || k === 'PageUp') tune(state.index + 1);
  else if (k === 'ArrowDown' || k === 'PageDown') tune(state.index - 1);
  else if (k === 'ArrowRight' || k === '+' || k === '=') changeVolume(0.05);
  else if (k === 'ArrowLeft' || k === '-' || k === '_') changeVolume(-0.05);
  else if (/^[0-9]$/.test(k)) typeDigit(k);
  else if (k === 'Enter' && digits) {
    clearTimeout(digitTimer);
    const n = Number(digits);
    digits = '';
    tuneNumber(n);
  } else if (k === 'Backspace' && state.last != null) tune(state.last);
  else if (k.toLowerCase() === 'm') toggleMute();
  else if (k.toLowerCase() === 'g') Guide.open(guideApi());
  else if (k.toLowerCase() === 'i' || k === 'Enter') showBanner();
  else if (k.toLowerCase() === 'c') toggleCrt();
  else if (k.toLowerCase() === 'p' && live && live.ready) clickCenter(live.wv);
  else if (k.toLowerCase() === 'k') openProfileMenu();
  else if (k.toLowerCase() === 'o') toggleOrder();
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
    else tune(state.index + d);
  },
  { passive: true }
);

async function turnOff() {
  teardown();
  await Effects.power('off');
  tv.quit();
}

// ---------- Power on ----------

async function loadConfig() {
  const cfg = await tv.config();
  state.settings = cfg.settings || {};
  state.all = cfg.channels.slice().sort((a, b) => a.number - b.number);
}

// The Library window changed something (download finished, file moved): pick it up live.
tv.onChanged(async () => {
  await loadConfig();
  const wasIdle = !localNow && !live;
  const kept = applyProfile();
  if (!state.channels.length) return;
  if (!kept || wasIdle) tune(state.index, { quiet: true });
  for (const ch of state.channels) if (ch.type === 'local') ensureProbed(ch);
});

window.addEventListener('online', () => live && tune(state.index, { quiet: true }));
window.addEventListener('offline', () => live && noInternet());

(async function boot() {
  await loadConfig();
  state.durations = await tv.durations();
  state.volume = store.get('volume', 0.8);
  document.body.classList.toggle('crt', store.get('crt', state.settings.crt !== false));

  const refreshAll = () => state.all.filter(hasStatus).forEach(refreshStatus);
  refreshAll();
  setInterval(refreshAll, 60000);

  // Profile: the schedule wins at power-on (so the kids' morning is always the kids' lineup),
  // then the last one used, then the default.
  const ids = Object.keys(profiles());
  state.scheduledProfile = Profiles.scheduled(state.settings);
  const want = [state.scheduledProfile, store.get('profile', null), state.settings.defaultProfile].find((id) => id && profiles()[id]);
  state.profile = want || ids[0] || null;
  setInterval(() => {
    const s = Profiles.scheduled(state.settings);
    if (s && s !== state.scheduledProfile) {
      state.scheduledProfile = s;
      setProfile(s);
    }
  }, 30000);

  state.channels = [];
  applyProfile();
  const startNum = store.get('channel', state.settings.startChannel);
  const i = state.channels.findIndex((c) => c.number === startNum);
  state.index = i >= 0 ? i : 0;

  Effects.power('on');
  if (!state.channels.length) {
    standby('NO CHANNELS', 'Add channels to channels.json or videos to media/channels');
    return;
  }
  tune(state.index, { quiet: true });
  // Schedule the rest of the local channels in the background so the guide fills in.
  for (const ch of state.channels) if (ch.type === 'local') ensureProbed(ch);
})();
