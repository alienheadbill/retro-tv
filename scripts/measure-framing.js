// Measures where the picture sits in every scheduled YouTube video (see lib/framing.js) and stores
// it in media/.retrotv/youtube.json. The app does this by itself for new videos; this script does it
// all at once. Run with: npx electron scripts/measure-framing.js
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { YouTubeChannels } = require('../lib/youtube-channels');
const { measureAll } = require('../lib/framing');

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'channels.json'), 'utf8'));
  const media = path.resolve(path.join(__dirname, '..'), (cfg.settings || {}).mediaFolder || 'media');
  const ytc = new YouTubeChannels(path.join(media, '.retrotv', 'youtube.json'));
  await ytc.prepare(cfg.channels);
  const ids = ytc.episodeIds(cfg.channels);
  const t0 = Date.now();
  const n = await measureAll(ids, ytc.cache.framing, {
    onProgress: (done, total) => {
      console.log(`  ${done}/${total}`);
      ytc.save();
    },
  });
  ytc.save();
  const res = ids.map((id) => ytc.cache.framing[id]).filter(Boolean);
  const boxed = res.filter((r) => r.w).length;
  console.log(`measured ${n} new of ${ids.length} videos in ${Math.round((Date.now() - t0) / 1000)}s; ${boxed} have a picture smaller than the frame`);
  app.quit();
});
