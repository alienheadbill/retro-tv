// Where the actual show is inside a YouTube video's frame. Fan uploads often shrink the picture
// onto a decorative background, and 4:3 shows get uploaded with black bars. YouTube publishes three
// auto-generated stills from different points in every video (mq1-3.jpg, 320x180): pixels that
// never change across them are background or bars, and the box where they do change is the show.
//
// Result per video: { x, y, w, h } as fractions of the 16:9 frame (the box to fill the screen
// with), or { full: true } when the picture already fills the frame. Needs Electron (nativeImage).
const { nativeImage } = require('electron');

const W = 320;
const H = 180;
const CHANGE = 22; // luma difference that counts as "this pixel changed"
const ACTIVE = 0.06; // a row/column belongs to the picture when this share of it changed

async function frame(id, n) {
  const res = await fetch(`https://i.ytimg.com/vi/${id}/mq${n}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`thumbnail ${res.status}`);
  const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
  const size = img.getSize();
  const bmp = (size.width === W && size.height === H ? img : img.resize({ width: W, height: H })).toBitmap(); // BGRA
  const luma = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) luma[i] = 0.114 * bmp[i * 4] + 0.587 * bmp[i * 4 + 1] + 0.299 * bmp[i * 4 + 2];
  return luma;
}

function bounds(counts, total, length) {
  let a = 0;
  let b = length - 1;
  while (a < length && counts[a] / total < ACTIVE) a++;
  while (b > a && counts[b] / total < ACTIVE) b--;
  return a >= b ? null : [a, b + 1];
}

async function measure(id) {
  const frames = await Promise.all([1, 2, 3].map((n) => frame(id, n)));
  const cols = new Uint32Array(W);
  const rows = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const lo = Math.min(frames[0][i], frames[1][i], frames[2][i]);
      const hi = Math.max(frames[0][i], frames[1][i], frames[2][i]);
      if (hi - lo > CHANGE) {
        cols[x]++;
        rows[y]++;
      }
    }
  }
  const bx = bounds(cols, H, W);
  const by = bounds(rows, W, H);
  // Nothing moved (a still image, or identical frames): can't tell, leave it alone.
  if (!bx || !by) return { unknown: true };
  const box = { x: bx[0] / W, y: by[0] / H, w: (bx[1] - bx[0]) / W, h: (by[1] - by[0]) / H };
  if (box.w > 0.94 && box.h > 0.94) return { full: true };
  return Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
}

// Measures every id missing from `store` (an object id -> result), a few at a time.
async function measureAll(ids, store, { concurrency = 8, onProgress } = {}) {
  const queue = [...new Set(ids)].filter((id) => !(id in store));
  let done = 0;
  const total = queue.length;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          store[id] = await measure(id);
        } catch {
          // No thumbnails (removed video): try again another time.
        }
        if (onProgress && ++done % 200 === 0) onProgress(done, total);
      }
    })
  );
  return total;
}

module.exports = { measure, measureAll };
