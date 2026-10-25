'use strict';
// The home server: your own phone plays the shows on this PC's drive, over your home network (or
// Tailscale when you're out). It's off until you turn it on in the Library window. A phone pairs
// once with the passcode shown there and gets its own key, unless the passcode is turned off
// ("open"): then anyone who has the address can watch. Only private-network addresses are
// answered, and only the videos on your folder channels are served (never a path the phone names).
// It also serves the phone app itself, so the phone can open it from this PC's address.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// What iPhones and iPads play in a web page.
const PHONE_EXT = /\.(mp4|m4v|mov)$/i;
const TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};
const MAX_TRIES = 5; // wrong passcodes per 10 minutes before pairing pauses
const LINEUP_TTL = 60000;

// Home networks, Tailscale (100.64.0.0/10 and fd7a:...), link-local and this PC itself.
function isPrivate(addr) {
  let a = String(addr || '').toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (!m) return false;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
}

const isTailscale = (ip, name) => /tailscale/i.test(name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
const VIRTUAL = /vethernet|virtualbox|vmware|wsl|hyper-v|loopback|bluetooth/i;

// Where a phone can reach this PC: home network addresses first, then Tailscale, then the PC's name.
function addresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.internal || n.family !== 'IPv4' || !isPrivate(n.address) || VIRTUAL.test(name)) continue;
      out.push({ url: `http://${n.address}:${port}/`, kind: isTailscale(n.address, name) ? 'tailscale' : 'home', adapter: name });
    }
  }
  out.sort((a, b) => (a.kind === 'home' ? 0 : 1) - (b.kind === 'home' ? 0 : 1));
  out.push({ url: `http://${os.hostname().toLowerCase()}.local:${port}/`, kind: 'name', adapter: '' });
  return out;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');

class HomeServer extends EventEmitter {
  // lineup(): { channels: [{ number, name, mode, ..., episodes, bumpers, commercials }] } where
  // each video has { file (full path), title, show, dur, ... }.
  constructor({ stateFile, appDir, lineup, name = os.hostname() }) {
    super();
    this.stateFile = stateFile;
    this.appDir = appDir;
    this.lineupFn = lineup;
    this.name = name;
    this.server = null;
    this.error = null;
    this.files = new Map();
    this.cached = null;
    this.fails = [];
    this.state = { enabled: false, open: false, port: 8787, code: newCode(), devices: [] };
    try {
      Object.assign(this.state, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    } catch {}
  }

  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  changed() {
    this.emit('change', this.status());
  }

  status() {
    const s = this.state;
    const counts = this.cached ? this.cached.counts : null;
    return {
      enabled: s.enabled,
      open: !!s.open,
      running: !!(this.server && this.server.listening),
      port: s.port,
      code: s.code,
      error: this.error,
      appBuilt: fs.existsSync(path.join(this.appDir, 'index.html')),
      addresses: addresses(s.port),
      devices: s.devices.map(({ id, name, paired, seen }) => ({ id, name, paired, seen })),
      counts,
    };
  }

  async setEnabled(on) {
    this.state.enabled = !!on;
    this.save();
    if (on) await this.start();
    else await this.stop();
    this.changed();
  }

  async setPort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Pick a port from 1024 to 65535');
    this.state.port = p;
    this.save();
    if (this.state.enabled) {
      await this.stop();
      await this.start();
    }
    this.changed();
  }

  setOpen(on) {
    this.state.open = !!on;
    this.save();
    this.changed();
  }

  newCode() {
    this.state.code = newCode();
    this.fails = [];
    this.save();
    this.changed();
  }

  forget(id) {
    this.state.devices = id ? this.state.devices.filter((d) => d.id !== id) : [];
    this.save();
    this.changed();
  }

  start() {
    if (this.server) return Promise.resolve();
    this.error = null;
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch(() => send(res, 500, 'Something went wrong')));
      server.on('error', (e) => {
        this.error = e.code === 'EADDRINUSE' ? `Port ${this.state.port} is already in use. Pick another one.` : e.message;
        this.server = null;
        this.changed();
        resolve();
      });
      server.listen(this.state.port, '0.0.0.0', () => {
        this.server = server;
        // Tests ask for port 0; remember the one we got.
        this.boundPort = server.address().port;
        this.changed();
        resolve();
      });
    });
  }

  stop() {
    const s = this.server;
    this.server = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections && s.closeAllConnections();
    });
  }

  // The lineup the phone sees: only videos it can play, each under an id instead of a path.
  lineup(force = false) {
    if (!force && this.cached && Date.now() - this.cached.at < LINEUP_TTL) return this.cached;
    const raw = this.lineupFn() || { channels: [] };
    const files = new Map();
    const counts = { ready: 0, needsConvert: 0, unmeasured: 0 };
    const pick = (list, isShow) =>
      (list || []).flatMap((f) => {
        if (!f || !f.file) return [];
        if (!PHONE_EXT.test(f.file)) {
          if (isShow) counts.needsConvert++;
          return [];
        }
        if (!(f.dur > 0)) {
          if (isShow) counts.unmeasured++;
          return [];
        }
        if (isShow) counts.ready++;
        const id = sha(f.file).slice(0, 24);
        files.set(id, f.file);
        const { title, show, dur, broadcast, airDate, year, network, rating } = f;
        return [{ id, title, show: show || '', dur, broadcast: !!broadcast, airDate: airDate || null, year: year || null, network: network || null, rating: rating || null }];
      });
    const channels = (raw.channels || []).map((c) => ({
      number: c.number,
      name: c.name,
      mode: c.mode || 'episodes',
      order: c.order || null,
      breaks: c.breaks || null,
      blocks: Array.isArray(c.blocks) ? c.blocks : [],
      rating: c.rating || null,
      description: c.description || '',
      episodes: pick(c.episodes, true),
      bumpers: pick(c.bumpers),
      commercials: pick(c.commercials),
    }));
    this.files = files;
    this.cached = { at: Date.now(), data: { name: this.name, channels, counts }, counts };
    return this.cached;
  }

  device(token) {
    if (!token) return null;
    const hash = sha(token);
    const d = this.state.devices.find((x) => x.hash === hash);
    if (d && Date.now() - (d.seen || 0) > 60000) {
      d.seen = Date.now();
      this.save();
    }
    return d || null;
  }

  async handle(req, res) {
    // Never answer the internet, even if a router forwards the port by mistake.
    if (!isPrivate(req.socket.remoteAddress)) return send(res, 403, 'Retro TV only answers your own network');
    // The phone app may also be opened from GitHub over https (when this PC is reached by https).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return send(res, 204);

    const url = new URL(req.url, 'http://home');
    const p = url.pathname;
    const bearer = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];

    const allowed = (token) => this.state.open || !!this.device(token);
    if (p === '/api/hello') return json(res, 200, { app: 'retro-tv-home', name: this.name, open: !!this.state.open, paired: allowed(bearer) });

    if (p === '/api/pair' && req.method === 'POST') {
      const now = Date.now();
      this.fails = this.fails.filter((t) => now - t < 10 * 60000);
      if (this.fails.length >= MAX_TRIES) return json(res, 429, { error: 'Too many wrong passcodes. Wait a few minutes and try again.' });
      let body = {};
      try {
        body = JSON.parse(await readBody(req, 2048));
      } catch {
        return json(res, 400, { error: 'Bad request' });
      }
      const code = String(body.code || '').replace(/\D/g, '');
      const ok = this.state.open || (code.length === this.state.code.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(this.state.code)));
      if (!ok) {
        this.fails.push(now);
        return json(res, 403, { error: "That passcode isn't right. Check the Library window on the PC." });
      }
      const token = crypto.randomBytes(24).toString('base64url');
      const device = { id: crypto.randomBytes(6).toString('hex'), name: String(body.device || 'Phone').slice(0, 60), hash: sha(token), paired: now, seen: now };
      this.state.devices.push(device);
      this.save();
      this.changed();
      return json(res, 200, { token, name: this.name });
    }

    if (p === '/api/lineup') {
      if (!allowed(bearer)) return json(res, 401, { error: 'Not paired' });
      return json(res, 200, this.lineup(url.searchParams.has('fresh')).data);
    }

    if (p.startsWith('/media/')) {
      // Video players can't send headers, so the phone's key comes in the address.
      if (!allowed(url.searchParams.get('k') || bearer)) return send(res, 401, 'Not paired');
      const id = p.slice(7);
      let file = this.files.get(id);
      if (!file) file = this.lineup(true) && this.files.get(id);
      if (!file) return send(res, 404, 'Not found');
      return sendFile(req, res, file, { cache: 'private, max-age=3600' });
    }

    return this.serveApp(req, res, p);
  }

  serveApp(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Not allowed');
    if (!fs.existsSync(path.join(this.appDir, 'index.html'))) {
      return send(res, 503, 'The phone app files aren\'t built yet. On the PC, open the Library window, "Phone at home" tab, and press "Update phone app files".');
    }
    let rel;
    try {
      rel = decodeURIComponent(p);
    } catch {
      return send(res, 400, 'Bad address');
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.resolve(this.appDir, '.' + rel);
    const inside = full.startsWith(path.resolve(this.appDir) + path.sep);
    if (!inside || rel.split('/').some((seg) => seg.startsWith('.'))) return send(res, 404, 'Not found');
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'Not found');
    return sendFile(req, res, full, { cache: 'no-cache' });
  }
}

function send(res, status, text = '') {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too big'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// A file with byte-range support (phones fetch video in pieces and seek with ranges).
function sendFile(req, res, file, { cache }) {
  return new Promise((resolve) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        send(res, 404, 'Not found');
        return resolve();
      }
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, 'Last-Modified': st.mtime.toUTCString() };
      let start = 0;
      let end = st.size - 1;
      let status = 200;
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        if (m[1]) {
          start = Number(m[1]);
          if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
        } else {
          start = Math.max(0, st.size - Number(m[2]));
        }
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          res.end();
          return resolve();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || st.size === 0) {
        res.end();
        return resolve();
      }
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      stream.on('close', resolve);
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  });
}

module.exports = { HomeServer, isPrivate, addresses, PHONE_EXT };
