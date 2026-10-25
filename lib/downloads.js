// Download queue: resumable HTTP(S) transfers into media/, verified, deduplicated, never overwriting.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { inside, safeName, uniquePath, isImportable } = require('./paths');

const UA = 'RetroTV/1.0 (personal household media manager)';
const KEEP_FREE = 2 * 1024 ** 3; // never fill the disk past the last 2 GB

class DownloadManager extends EventEmitter {
  constructor({ root, stateFile, allows, library, concurrency = 2 }) {
    super();
    this.root = path.resolve(root);
    this.stateFile = stateFile;
    this.allows = allows;
    this.library = library;
    this.concurrency = concurrency;
    this.active = new Map(); // id -> AbortController
    this.jobs = [];
    try {
      this.jobs = JSON.parse(fs.readFileSync(stateFile, 'utf8')).jobs || [];
    } catch {}
    // Anything that was mid-transfer when the app closed picks up where it left off.
    for (const j of this.jobs) if (j.status === 'downloading' || j.status === 'verifying') j.status = 'queued';
    this.saveTimer = 0;
  }

  save(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs: this.jobs }, null, 1));
      fs.renameSync(tmp, this.stateFile);
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, 2000);
  }

  list() {
    return this.jobs.map((j) => ({ ...j }));
  }

  find(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error('No such download');
    return j;
  }

  // spec: { url, name, size?, md5?, destDir? (media-relative, default "inbox"), meta? }
  add(spec) {
    if (!this.allows(spec.url)) throw new Error('Downloads from this site are not supported');
    const name = safeName(spec.name || decodeURIComponent(new URL(spec.url).pathname.split('/').pop()), 'video.mp4');
    if (!isImportable(name)) throw new Error('Not a video or subtitle file: ' + name);
    const destDir = spec.destDir || 'inbox';
    inside(this.root, path.join(destDir, name)); // throws if it would land outside media/

    const sameJob = this.jobs.find((j) => j.url === spec.url && ['queued', 'downloading', 'paused', 'verifying'].includes(j.status));
    if (sameJob) return { job: sameJob, duplicate: 'queue' };
    const have = (this.library && (this.library.findBySource(spec.url) || this.library.findByMd5(spec.md5))) || null;
    if (have) return { job: null, duplicate: 'library', entry: have };

    const job = {
      id: crypto.randomUUID(),
      url: spec.url,
      name,
      destDir,
      size: Number(spec.size) || null,
      md5: spec.md5 || null,
      meta: { sourceUrl: spec.url, ...(spec.meta || {}) },
      status: 'queued',
      received: 0,
      speed: 0,
      error: null,
      added: new Date().toISOString(),
    };
    this.jobs.push(job);
    this.save();
    this.emit('change', job);
    this.pump();
    return { job };
  }

  pause(id) {
    const j = this.find(id);
    if (this.active.has(id)) this.active.get(id).abort('pause');
    if (j.status === 'queued' || j.status === 'downloading') j.status = 'paused';
    j.speed = 0;
    this.save(true);
    this.emit('change', j);
  }

  resume(id) {
    const j = this.find(id);
    if (['paused', 'error'].includes(j.status)) {
      j.status = 'queued';
      j.error = null;
      this.emit('change', j);
      this.pump();
    }
  }

  // Removing a job you asked to remove also removes its unfinished .part file. Finished files stay.
  remove(id) {
    const j = this.find(id);
    j.removed = true;
    // An active transfer deletes its own .part once its file handle is closed (see run()).
    if (this.active.has(id)) this.active.get(id).abort('remove');
    else if (j.status !== 'done') this.deletePart(j);
    this.jobs = this.jobs.filter((x) => x !== j);
    this.save(true);
    this.emit('removed', id);
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status !== 'done' && j.status !== 'duplicate');
    this.save(true);
    this.emit('cleared');
  }

  deletePart(j) {
    try {
      fs.unlinkSync(this.partPath(j));
    } catch {}
  }

  partPath(j) {
    return inside(this.root, path.join(j.destDir, j.name + '.part'));
  }

  pump() {
    for (const j of this.jobs) {
      if (this.active.size >= this.concurrency) break;
      if (j.status === 'queued' && !this.active.has(j.id)) this.run(j);
    }
  }

  async run(j) {
    const ctrl = new AbortController();
    this.active.set(j.id, ctrl);
    j.status = 'downloading';
    j.error = null;
    this.emit('change', j);
    try {
      await this.transfer(j, ctrl.signal);
    } catch (e) {
      if (ctrl.signal.aborted) {
        // paused or removed: state already set by pause()/remove()
      } else {
        j.status = 'error';
        j.error = e.message;
        j.speed = 0;
      }
    } finally {
      this.active.delete(j.id);
      if (j.removed) this.deletePart(j);
      else this.emit('change', j);
      this.save(true);
      this.pump();
    }
  }

  async transfer(j, signal) {
    const part = this.partPath(j);
    fs.mkdirSync(path.dirname(part), { recursive: true });
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;

    const headers = { 'User-Agent': UA };
    if (have > 0) headers.Range = `bytes=${have}-`;
    const res = await fetch(j.url, { headers, signal, redirect: 'follow' });
    if (!this.allows(res.url)) throw new Error('Download was redirected to an unsupported site');
    if (res.status === 416 && j.size && have === j.size) {
      // Already have every byte; fall through to verification.
    } else if (!(res.status === 200 || res.status === 206)) {
      throw new Error(`Server answered ${res.status}`);
    }
    if (/text\/html/i.test(res.headers.get('content-type') || '')) throw new Error('Got a web page instead of a file');
    if (res.status === 200 && have > 0) have = 0; // server ignored the Range: start over

    const length = Number(res.headers.get('content-length')) || 0;
    if (!j.size && length) j.size = have + length;
    if (j.size && fs.statfsSync) {
      const fsInfo = fs.statfsSync(path.dirname(part));
      if (fsInfo.bavail * fsInfo.bsize - (j.size - have) < KEEP_FREE) throw new Error('Not enough free disk space');
    }

    const hash = j.md5 ? crypto.createHash('md5') : null;
    if (hash && have > 0) {
      await pipeline(fs.createReadStream(part, { end: have - 1 }), new Transform({ transform: (c, _e, cb) => (hash.update(c), cb()) }));
    }
    j.received = have;

    if (res.status !== 416) {
      let windowStart = Date.now();
      let windowBytes = 0;
      let lastEmit = 0;
      const meter = new Transform({
        transform: (chunk, _e, cb) => {
          if (hash) hash.update(chunk);
          j.received += chunk.length;
          windowBytes += chunk.length;
          const now = Date.now();
          if (now - windowStart >= 1000) {
            const rate = (windowBytes * 1000) / (now - windowStart);
            j.speed = j.speed ? Math.round(j.speed * 0.6 + rate * 0.4) : Math.round(rate);
            windowStart = now;
            windowBytes = 0;
          }
          if (now - lastEmit > 500) {
            lastEmit = now;
            this.emit('progress', j);
            this.save();
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' }), { signal });
    }

    j.status = 'verifying';
    j.speed = 0;
    this.emit('change', j);
    const got = fs.statSync(part).size;
    if (j.size && got !== j.size) throw new Error(`Incomplete: got ${got} of ${j.size} bytes`);
    const md5 = hash ? hash.digest('hex') : null;
    if (j.md5 && md5 !== j.md5.toLowerCase()) {
      fs.truncateSync(part, 0); // the bytes are bad; a retry starts clean
      throw new Error('Checksum mismatch: the file was corrupted in transit. Retry to download again.');
    }

    const dupe = md5 && this.library && this.library.findByMd5(md5);
    const dest = uniquePath(inside(this.root, path.join(j.destDir, j.name)));
    fs.renameSync(part, dest);
    const entry = this.library ? this.library.add(dest, j.meta, md5 ? { md5 } : {}) : null;
    j.path = entry ? entry.path : path.relative(this.root, dest);
    j.status = dupe ? 'duplicate' : 'done';
    if (dupe) j.error = `Same file as ${dupe.path}`;
    j.finished = new Date().toISOString();
  }
}

module.exports = { DownloadManager };
