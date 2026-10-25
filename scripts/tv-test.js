// Runs the real PC TV hidden, on throwaway test settings, and checks it from outside through
// Chrome's DevTools protocol. Nothing on screen, no sound, and the real channels, health records
// and durations are untouched.
//   node scripts/tv-test.js            offline checks
//   node scripts/tv-test.js --online   also a real YouTube channel and a live stream
// Scenario: a channel shared by a stand-in "other computer" whose schedule includes an episode
// that's missing. When its slot comes up, the TV must retry it once, then play a stand-in from the
// same show, mark it in the guide, and pick the schedule back up on time.
// Needs FFmpeg for the two short test videos.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HomeServer } = require('../lib/home-server');
const { findTool } = require('../lib/probe');

const ROOT = path.join(__dirname, '..');
const PORT = 9339;
const ONLINE = process.argv.includes('--online');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ffmpeg = findTool('ffmpeg');
  if (!ffmpeg) return console.log('FFmpeg is needed for the test videos (winget install Gyan.FFmpeg).');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-tvtest-'));
  const vids = path.join(work, 'videos');
  fs.mkdirSync(vids);
  fs.mkdirSync(path.join(work, 'media'));
  const make = (name, src, hz) =>
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `${src}=size=320x240:rate=15:duration=40`, '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=40`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(vids, name)]);
  make('Show 1.mp4', 'testsrc2', 300);
  make('Show 2.mp4', 'smptebars', 600);
  // A folder channel on this "PC" (its lengths get measured by the TV itself).
  const folder = path.join(work, 'media', 'channels', '30 Folder Test', 'Bars');
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(path.join(vids, 'Show 2.mp4'), path.join(folder, 'Bars 1.mp4'));
  fs.copyFileSync(path.join(vids, 'Show 1.mp4'), path.join(folder, 'Bars 2.mp4'));
  // A show whose first episode will break, with another copy of it elsewhere in the library.
  const copyShow = path.join(work, 'media', 'channels', '40 Copy Test', 'Test Pattern');
  const backups = path.join(work, 'media', 'backups', 'Test Pattern');
  fs.mkdirSync(copyShow, { recursive: true });
  fs.mkdirSync(backups, { recursive: true });
  fs.copyFileSync(path.join(vids, 'Show 2.mp4'), path.join(copyShow, 'Test Pattern S01E01.mp4'));
  fs.copyFileSync(path.join(vids, 'Show 1.mp4'), path.join(copyShow, 'Test Pattern S01E02.mp4'));
  fs.copyFileSync(path.join(vids, 'Show 2.mp4'), path.join(backups, 'Test Pattern 1x01.mp4'));

  // The "other computer": a home server whose lineup has one episode that isn't there.
  const v = (name, show) => ({ file: path.join(vids, name), title: name.replace(/\.mp4$/, ''), show, dur: 40 });
  const home = new HomeServer({
    stateFile: path.join(work, 'home.json'),
    appDir: path.join(work, 'none'),
    name: 'TV-TEST-SERVER',
    lineup: () => ({ channels: [{ number: 20, name: 'Test Channel', episodes: [v('Missing Episode.mp4', 'Test Pattern'), v('Show 1.mp4', 'Test Pattern'), v('Show 2.mp4', 'Color Bars')], bumpers: [], commercials: [] }] }),
  });
  home.state.port = 0;
  home.state.open = true;
  await home.setEnabled(true);
  const server = `http://127.0.0.1:${home.boundPort}`;

  const config = path.join(work, 'channels.json');
  // Online: two real channels from the lineup, with this PC's cached YouTube lists.
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'channels.json'), 'utf8')).channels;
  const extra = ONLINE ? real.filter((c) => c.number === 305 || c.number === 9) : [];
  if (ONLINE) {
    fs.mkdirSync(path.join(work, 'media', '.retrotv'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'media', '.retrotv', 'youtube.json'), path.join(work, 'media', '.retrotv', 'youtube.json'));
  }
  fs.writeFileSync(config, JSON.stringify({ settings: { startChannel: 20, publicServer: server, breaks: { bumpers: 0, commercials: 0 } }, channels: extra }));
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const child = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, RTV_CONFIG: config, RTV_USER_DATA: path.join(work, 'userdata'), RTV_MEDIA: path.join(work, 'media'), RTV_HIDDEN: '1' },
    stdio: 'ignore',
  });

  let ws;
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  };
  try {
    ws = await connect();
    const evaluate = cdp(ws);
    await waitFor(evaluate, `typeof tvc !== 'undefined' && tvc.state.channels.some((c) => c.number === 20)`, 30000);
    check('the TV starts and lists the shared channel', true);

    // The remote: keys go through the same handler the keyboard uses.
    const key = (k) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)} }))`);
    const text = async (sel) => String(await evaluate(`document.querySelector(${JSON.stringify(sel)}).innerText`)).replace(/\s+/g, ' ').trim();
    await waitFor(evaluate, `tvc.state.channels.some((c) => c.number === 30)`, 30000);
    await key('3');
    await key('0');
    await sleep(6000);
    const f = await evaluate(`({ ch: tvc.state.channels[tvc.state.index].number, file: tvc.localNow && tvc.localNow.file.title, t: document.querySelector('#local').currentTime })`);
    check('typing 3 0 tunes the folder channel, and its file plays', f.ch === 30 && /^Bars/.test(f.file || '') && f.t > 0, `ch ${f.ch}, ${f.file}, ${(f.t || 0).toFixed(1)} s in`);
    await key('i');
    await sleep(300);
    const banner = await text('#banner');
    check('the banner shows the channel and what is on', /30/.test(banner) && /Bars/.test(banner), banner.slice(0, 80));
    await key('m');
    const muted = await evaluate(`tvc.state.muted && document.querySelector('#local').muted && /MUTE/.test(document.querySelector('#vol').textContent)`);
    await key('m');
    check('M mutes and unmutes', muted && (await evaluate(`!tvc.state.muted`)));
    await key('ArrowUp');
    await sleep(800);
    const up = await evaluate(`tvc.state.channels[tvc.state.index].number`);
    await key('Backspace');
    await sleep(800);
    const back = await evaluate(`tvc.state.channels[tvc.state.index].number`);
    check('channel up and back (last channel)', up !== 30 && back === 30, `${up} then ${back}`);
    await key('g');
    await sleep(400);
    const rows = await evaluate(`Guide.isOpen() && document.querySelectorAll('#guide .guide-row, #guide .row').length`);
    await key('Escape');
    check('G opens the guide', rows > 0, `${rows} rows`);
    await key('o');
    check('O on a channel without history order says so', /RANDOM/.test(await text('#osd')));

    // Rapid surfing: five presses in half a second start one player (the channel it lands on),
    // and the channels flicked past aren't counted as failures. From 40 it never lands on 20, whose
    // missing episode is checked below.
    await evaluate(`tvc.tuneNumber(40)`);
    await sleep(3000);
    await evaluate(`(() => {
      // What each player start played: a file's address, or a webview (YouTube and live sites).
      window.__starts = [];
      const v = document.querySelector('#local');
      v.addEventListener('loadstart', () => window.__starts.push(v.currentSrc || v.src));
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.tagName === 'WEBVIEW' && window.__starts.push('webview')))).observe(document.querySelector('#screen'), { childList: true });
      window.__failsBefore = JSON.parse(JSON.stringify(tvc.health.all()));
      window.__from = tvc.state.index;
    })()`);
    for (let i = 0; i < 5; i++) {
      await key('ArrowUp');
      await sleep(100);
    }
    await sleep(4000);
    // Only the channel it lands on may start (its schedule can move on to the next video meanwhile:
    // the test videos are 40 s long).
    const surf = await evaluate(`({
      starts: window.__starts.length,
      elsewhere: (() => {
        const ch = tvc.state.channels[tvc.state.index];
        const own = new Set([...(ch.episodes || []), ...(ch.bumpers || []), ...(ch.commercials || [])].map((f) => new URL(f.stream || f.url, location.href).href));
        return window.__starts.filter((s) => !own.has(s.split('#')[0])).length;
      })(),
      moved: (tvc.state.index - window.__from + 5 * tvc.state.channels.length) % tvc.state.channels.length,
      expected: 5 % tvc.state.channels.length,
      playing: !!(tvc.localNow || tvc.liveOn),
      // The channel it lands on really plays, so its failures (the missing episode) are real ones.
      newFails: (() => {
        const landed = new Set((tvc.state.channels[tvc.state.index].episodes || []).map(tvc.keyOf));
        return Object.entries(tvc.health.all()).filter(([k]) => !landed.has(k)).reduce((n, [k, r]) => n + Math.max(0, (r.failures || 0) - ((window.__failsBefore[k] || {}).failures || 0)), 0);
      })(),
    })`);
    check('five quick CH up presses start only the channel they land on', surf.starts >= 1 && surf.elsewhere === 0 && surf.moved === surf.expected && surf.playing, `${surf.starts} started, ${surf.elsewhere} on channels flicked past`);
    check('the channels flicked past are not counted as failures', surf.newFails === 0, `${surf.newFails} new`);

    // Wait for the missing episode's slot, tuned to the channel.
    const until = await evaluate(`(() => {
      const ch = tvc.state.channels.find((c) => c.number === 20);
      const l = Schedule.listings(tvc.cycleFor(ch), Date.now(), Date.now() + 200000).find((p) => p.title === 'Missing Episode' && p.start > Date.now() + 2000);
      return l ? l.start - Date.now() : null;
    })()`);
    if (until == null) throw new Error('the missing episode is never scheduled');
    console.log(`     waiting ${Math.round(until / 1000)} s for the missing episode's slot...`);
    const before = await evaluate(`Schedule.listings(tvc.cycleFor(tvc.state.channels.find((c) => c.number === 20)), Date.now(), Date.now() + 400000).map((p) => [p.start, p.title])`);
    // The TV starts on 20, so the episode may already have failed (and be resting): start clean.
    await sleep(Math.max(0, until - 1000));
    await evaluate(`tvc.health.ok(tvc.keyOf(tvc.state.channels.find((c) => c.number === 20).episodes.find((e) => e.title === 'Missing Episode')))`);
    await sleep(5000);
    await evaluate(`tvc.tune(tvc.state.channels.findIndex((c) => c.number === 20), { quiet: true })`);
    await sleep(8000);
    const s = await evaluate(`(() => {
      const ch = tvc.state.channels[tvc.state.index];
      const miss = ch.episodes.find((e) => e.title === 'Missing Episode');
      const v = document.querySelector('#local');
      const now = tvc.localNow;
      return {
        playing: now && now.file.title,
        standingInFor: now && now.sub && now.sub.original.title,
        failures: (tvc.health.get(tvc.keyOf(miss)) || {}).failures,
        record: tvc.health.get(tvc.keyOf(miss)),
        log: tvc.played.slice(-4),
        videoTime: v.currentTime,
        videoPaused: v.paused,
        guideNow: tvc.listings(ch, Date.now(), Date.now() + 1)[0].title,
        aired: tvc.played.slice(-1)[0],
      };
    })()`);
    check('the missing episode was tried twice (once more after the first failure)', s.failures === 2, s.failures === 2 ? 'failures: 2' : JSON.stringify({ record: s.record, log: s.log }));
    check('a stand-in from the same show is playing', s.standingInFor === 'Missing Episode' && s.playing === 'Show 1' && !s.videoPaused && s.videoTime > 0, `${s.playing}, ${s.videoTime.toFixed(1)} s in`);
    check('the guide marks it as a stand-in', /stand-in/.test(s.guideNow), s.guideNow);
    check('the stand-in is logged as what aired', !!(s.aired && s.aired.standIn && s.aired.scheduled === 'Missing Episode'));
    const after = await evaluate(`Schedule.listings(tvc.cycleFor(tvc.state.channels.find((c) => c.number === 20)), Date.now(), Date.now() + 200000).map((p) => [p.start, p.title])`);
    const same = after.filter((a) => a[0] > Date.now() + 1000).every((a) => before.some((b) => b[0] === a[0] && b[1] === a[1]));
    check("the rest of the schedule didn't move", same);

    // Backup copies: S01E01 gets the library's other copy of it. The scheduled file then goes
    // missing; when its slot comes, the TV plays the copy, not a stand-in.
    const alts = await evaluate(`(tvc.state.channels.find((c) => c.number === 40).episodes.find((e) => e.title === 'Test Pattern S01E01').alternates || []).map((a) => a.title)`);
    check('an episode gets its other copy from the library as a backup', alts.length === 1 && alts[0] === 'Test Pattern 1x01', alts.join(', ') || 'none');
    // Both episodes measured (the TV does that in the background) before the file goes.
    await waitFor(evaluate, `(() => {
      const titles = Schedule.listings(tvc.cycleFor(tvc.state.channels.find((c) => c.number === 40)), Date.now(), Date.now() + 200000).map((p) => p.title);
      return titles.includes('Test Pattern S01E01') && titles.includes('Test Pattern S01E02');
    })()`, 30000);
    fs.rmSync(path.join(copyShow, 'Test Pattern S01E01.mp4'), { maxRetries: 5 });
    const untilCopy = await evaluate(`(() => {
      const ch = tvc.state.channels.find((c) => c.number === 40);
      const l = Schedule.listings(tvc.cycleFor(ch), Date.now(), Date.now() + 200000).find((p) => p.title === 'Test Pattern S01E01' && p.start > Date.now() + 2000);
      return l ? l.start - Date.now() : null;
    })()`);
    if (untilCopy == null) throw new Error('S01E01 is never scheduled');
    console.log(`     waiting ${Math.round(untilCopy / 1000)} s for the broken episode's slot...`);
    await sleep(untilCopy + 4000);
    await evaluate(`tvc.tuneNumber(40)`);
    await sleep(8000);
    const c = await evaluate(`(() => {
      const ch = tvc.state.channels[tvc.state.index];
      const ep = ch.episodes.find((e) => e.title === 'Test Pattern S01E01');
      const now = tvc.localNow;
      const v = document.querySelector('#local');
      return {
        ch: ch.number,
        playing: now && now.file.title,
        standIn: !!(now && now.sub),
        failures: (tvc.health.get(tvc.keyOf(ep)) || {}).failures,
        videoTime: v.currentTime,
        guideNow: tvc.listings(ch, Date.now(), Date.now() + 1)[0].title,
        aired: tvc.played.slice(-1)[0],
      };
    })()`);
    check('the broken episode was tried, then its backup copy plays', c.ch === 40 && c.failures >= 1 && c.playing === 'Test Pattern 1x01' && c.videoTime > 0, `${c.playing}, failures ${c.failures}, ${(c.videoTime || 0).toFixed(1)} s in`);
    check("a backup copy isn't called a stand-in", !c.standIn && !/stand-in/.test(c.guideNow) && !!(c.aired && c.aired.copy && !c.aired.standIn), c.guideNow);

    if (ONLINE) {
      // A scheduled YouTube channel: YouTube's watch page in a webview, playing where the schedule says.
      await evaluate(`tvc.tuneNumber(305)`);
      await sleep(25000);
      const y = await evaluate(`(async () => {
        const f = tvc.localNow && tvc.localNow.file;
        let t = null;
        try { t = await ytNow.wv.executeJavaScript("(document.querySelector('.rtv-target') || {}).currentTime"); } catch {}
        return { youtube: f && f.youtube, ready: !!(ytNow && ytNow.ready), t, ok: f ? (tvc.health.get(tvc.keyOf(f)) || {}).lastOk : null, standIn: !!(tvc.localNow && tvc.localNow.sub) };
      })()`);
      check('a scheduled YouTube channel plays in the webview', !!y.youtube && y.ready && y.t > 0 && !!y.ok, `${y.youtube}, ${y.t == null ? '?' : y.t.toFixed(0)} s, stand-in: ${y.standIn}`);
      // A live channel: the site's own player.
      await evaluate(`tvc.tuneNumber(9)`);
      await sleep(25000);
      const l = await evaluate(`({ ready: !!(live && live.ready), ok: !!(live && live.ok), standby: document.querySelector('#standby').hidden ? null : document.querySelector('#standby').innerText.replace(/\\n/g, ' ') })`);
      check('a live stream plays (or says why not)', l.ready && (l.ok || !!l.standby), l.ok ? 'playing' : l.standby);
    }
  } catch (e) {
    check(`test ran (${e.message})`, false);
  } finally {
    if (ws) ws.close();
    child.kill();
    await home.stop();
    await sleep(500);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exitCode = failed ? 1 : 0;
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const tv = pages.find((p) => p.type === 'page' && /src[\\/]index\.html/.test(p.url));
      if (tv) {
        const ws = new WebSocket(tv.webSocketDebuggerUrl);
        await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
        return ws;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("the TV window didn't open");
}

function cdp(ws) {
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  };
  return (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (msg) => {
        const r = msg.result || {};
        if (r.exceptionDetails) reject(new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
        else resolve(r.result ? r.result.value : undefined);
      });
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
}

async function waitFor(evaluate, expr, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`timed out waiting for: ${expr}`);
}

main();
