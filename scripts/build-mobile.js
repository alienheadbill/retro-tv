// Builds the phone app into dist-mobile/: shared TV code from src/ and lib/, the phone files
// from mobile/, and config.js generated from channels.json and media/channels/*/channel.json.
// The PIN is never copied: the phone app is published on the web.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-mobile');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });

const copy = (from, to = path.basename(from)) => fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to));

// Shared with the desktop TV.
// The TV itself (tv-core.js) and its schedule, health, profile, effect and guide code.
for (const f of ['schedule.js', 'health.js', 'profiles.js', 'effects.js', 'guide.js', 'tv-core.js']) copy('src/' + f);
copy('lib/meta.js');
copy('lib/sources/archive-core.js');
copy('src/fonts/VT323-Regular.ttf', 'fonts/VT323-Regular.ttf');
// The TV styles size things by the screen; on the phone they size by the TV box instead.
fs.writeFileSync(path.join(OUT, 'style.css'), read('src/style.css').replace(/(\d)vmin\b/g, '$1cqmin').replace(/(\d)vh\b/g, '$1cqh').replace(/(\d)vw\b/g, '$1cqw'));

// Phone-only files.
for (const f of ['index.html', 'phone.css', 'db.js', 'phone-lib.js', 'tv.js', 'manage.js', 'update.js', 'report.js', 'manifest.webmanifest']) copy('mobile/' + f);
for (const f of fs.readdirSync(path.join(ROOT, 'mobile', 'icons'))) copy('mobile/icons/' + f, 'icons/' + f);

// Lineup and settings from the desktop config.
const cfg = JSON.parse(read('channels.json'));
const s = cfg.settings || {};
const settings = {
  startChannel: 20,
  crt: s.crt !== false,
  localOrder: s.localOrder,
  breaks: s.breaks,
  defaultProfile: s.defaultProfile,
  profiles: s.profiles,
  profileSchedule: s.profileSchedule,
  // A Retro TV sharing its shows with everyone (Phone at home, passcode off): every visitor gets them.
  publicServer: s.publicServer || null,
  // "Report a problem" (mobile/report.js): only the Web3Forms key, never the owner's address.
  reports: s.reports && s.reports.web3formsKey ? { web3formsKey: s.reports.web3formsKey } : null,
};
const enabled = (cfg.channels || []).filter((c) => c.enabled !== false);
const pick = (c) => ({ number: c.number, name: c.name, type: c.type, channel: c.channel, url: c.url, description: c.description, rating: c.rating });
// Only players that can be embedded in a web page work on the phone.
const live = enabled.filter((c) => c.type === 'owncast' || c.type === 'twitch').map(pick);
const desktopOnly = enabled.filter((c) => c.type === 'vaughn' || c.type === 'web').map((c) => ({ number: c.number, name: c.name }));

const chanDir = path.join(ROOT, 'media', 'channels');
const channels = fs.existsSync(chanDir)
  ? fs.readdirSync(chanDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+\s+.+$/.test(d.name))
      .map((d) => {
        let cj = {};
        try {
          cj = JSON.parse(fs.readFileSync(path.join(chanDir, d.name, 'channel.json'), 'utf8'));
        } catch {}
        const { mode, order, breaks, blocks, rating, description, note } = cj;
        return { number: Number(d.name.split(' ')[0]), name: d.name.replace(/^\d+\s+/, ''), mode, order, breaks, blocks, rating, description, note };
      })
      .sort((a, b) => a.number - b.number)
  : [];

// YouTube channels, resolved on the PC (the phone can't read YouTube's pages itself). Only videos
// that allow embedding are kept: the phone plays them in YouTube's embedded player.
async function youtubeChannels() {
  const { YouTubeChannels } = require('../lib/youtube-channels');
  const ytc = new YouTubeChannels(path.join(ROOT, 'media', '.retrotv', 'youtube.json'));
  await ytc.prepare(enabled);
  const compact = (list) =>
    list.map((f) => ({
      id: f.youtube,
      title: f.title,
      show: f.show,
      dur: f.dur,
      ...(f.crop ? { crop: f.crop } : {}),
      // Order "grouped": series/event, part and date.
      ...(f.group != null ? { group: f.group } : {}),
      ...(f.part != null ? { part: f.part } : {}),
      ...(f.when ? { when: f.when } : {}),
    }));
  const built = new Map();
  const scheduled = enabled.filter((c) => c.type === 'youtube').sort((a, b) => a.number - b.number).map((c) => {
    const ch = ytc.scheduled(c, [], [], built);
    return { ...ch, episodes: compact(ch.episodes), bumpers: compact(ch.bumpers), commercials: compact(ch.commercials) };
  });
  const ids = scheduled.flatMap((c) => [...c.episodes, ...c.bumpers, ...c.commercials].map((v) => v.id));
  const ok = await ytc.checkEmbeddable(ids);
  for (const c of scheduled) for (const k of ['episodes', 'bumpers', 'commercials']) c[k] = c[k].filter((v) => ok[v.id] !== false);
  const allLives = enabled.filter((c) => c.type === 'youtube-live').map((c) => {
    const l = ytc.live(c);
    return { number: l.number, name: l.name, type: 'youtube-live', channelId: l.channelId, videoId: l.videoId, description: l.description, rating: l.rating };
  });
  // A stream whose owner turned embedding off plays only on the PC (it opens YouTube's own page).
  const liveOk = await ytc.checkEmbeddable(allLives.map((l) => l.videoId).filter(Boolean));
  const lives = allLives.filter((l) => !l.videoId || liveOk[l.videoId] !== false);
  for (const l of allLives) if (!lives.includes(l)) desktopOnly.push({ number: l.number, name: l.name });
  return { scheduled, lives };
}

(async () => {
const version = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const yt = await youtubeChannels();
fs.writeFileSync(
  path.join(OUT, 'config.js'),
  `// Generated by scripts/build-mobile.js from the desktop's channels.json and channel.json files.\n` +
    `window.RTV_DEFAULTS = ${JSON.stringify({ version, settings, live, desktopOnly, channels, youtube: yt.scheduled, youtubeLive: yt.lives }, null, 1)};\n` +
    // What's new, newest first (mobile/changelog.json).
    `window.RTV_CHANGELOG = ${JSON.stringify(JSON.parse(read('mobile/changelog.json')), null, 1)};\n`
);

// Offline cache: every file in the build.
const assets = ['./'];
(function walk(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + '/');
    else assets.push(prefix + e.name);
  }
})(OUT, '');
fs.writeFileSync(path.join(OUT, 'sw.js'), read('mobile/sw.js').replace('__VERSION__', version).replace('__ASSETS__', JSON.stringify(assets)));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`Built dist-mobile (version ${version}): ${assets.length} files, ${live.length + yt.lives.length} live channels, ${channels.length} folder channels, ${yt.scheduled.length} YouTube channels (${yt.scheduled.reduce((s, c) => s + c.episodes.length, 0)} videos)`);
})();
