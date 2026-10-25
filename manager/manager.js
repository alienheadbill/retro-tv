'use strict';
// Retro TV Library window: find media in archives, download it, organize it into channels.

const L = window.library;
const $ = (s, root = document) => root.querySelector(s);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const fmtBytes = (n) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtDur = (s) => {
  if (!s) return '';
  s = Math.round(s);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};
const fmtKbps = (b) => (b ? `${Math.round(b / 1000).toLocaleString()} kb/s` : '');

let toastTimer = 0;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 8000 : 4000);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    return null;
  }
}

const state = {
  overview: null,
  query: null,
  page: 1,
  item: null,
  jobs: new Map(),
  conversions: new Map(),
  entries: [],
  picked: new Set(), // library rows ticked for compare
  entry: null,
};

// ---------- Tabs ----------

document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'library' || b.dataset.tab === 'channels') refresh();
    if (b.dataset.tab === 'home') loadHome();
    if (b.dataset.tab === 'drives') loadDrives();
    if (b.dataset.tab === 'health') loadHealth();
  })
);

async function refresh() {
  const o = await attempt(() => L.overview());
  if (!o) return;
  state.overview = o;
  state.entries = o.entries;
  for (const j of o.jobs) state.jobs.set(j.id, j);
  for (const c of o.conversions) state.conversions.set(c.id, c);
  renderTools();
  renderJobs();
  renderConversions();
  renderLibrary();
  renderChannels();
}

function renderTools() {
  const t = state.overview.tools;
  $('#tools').replaceChildren(
    h('span', { class: t.ffmpeg && t.ffprobe ? 'ok' : 'no', title: t.ffmpeg || 'Install FFmpeg (winget install Gyan.FFmpeg) to inspect and convert files' }, t.ffmpeg && t.ffprobe ? 'FFmpeg ready' : 'FFmpeg not installed'),
    ' · ',
    h('span', { title: state.overview.mediaDir }, 'media: ' + state.overview.mediaDir)
  );
  $('#probe-all').disabled = !t.ffprobe;
  $('#convert-all').disabled = !t.ffmpeg;
}

// Where a download or a move should go, as chosen in a destination picker.
function destinationPicker(defaults = {}) {
  const channels = state.overview.channels;
  const where = h(
    'select',
    { name: 'where' },
    h('option', { value: 'inbox' }, 'Inbox (sort later)'),
    h('optgroup', { label: 'Channel' }, channels.map((c) => h('option', { value: 'ch:' + c.folder, selected: defaults.where === 'ch:' + c.folder }, c.folder))),
    h('option', { value: 'shared:bumpers' }, 'Shared bumpers (all channels)'),
    h('option', { value: 'shared:commercials' }, 'Shared commercials (all channels)')
  );
  const role = h('select', { name: 'role' },
    h('option', { value: 'show' }, 'as a show'),
    h('option', { value: 'bumper', selected: defaults.role === 'bumper' }, "as this channel's bumper"),
    h('option', { value: 'commercial', selected: defaults.role === 'commercial' }, "as this channel's commercial"));
  const listId = 'shows-' + Math.random().toString(36).slice(2);
  const show = h('input', { name: 'show', placeholder: 'Show folder (optional)', list: listId, value: defaults.show || '' });
  const datalist = h('datalist', { id: listId });
  const sync = () => {
    const ch = where.value.startsWith('ch:') ? channels.find((c) => 'ch:' + c.folder === where.value) : null;
    role.disabled = !ch;
    show.disabled = !ch || role.value !== 'show';
    datalist.replaceChildren(...(ch ? ch.shows.map((s) => h('option', { value: s })) : []));
  };
  where.addEventListener('change', sync);
  role.addEventListener('change', sync);
  sync();
  return {
    el: h('div', { class: 'row' }, h('label', null, 'Put it in', where), h('label', null, 'Role', role), h('label', null, 'Show', show), datalist),
    // media-relative folder for downloads
    destDir() {
      if (where.value === 'inbox') return 'inbox';
      if (where.value.startsWith('shared:')) return where.value.slice(7);
      const base = 'channels/' + where.value.slice(3);
      if (role.value === 'bumper') return base + '/_bumpers';
      if (role.value === 'commercial') return base + '/_commercials';
      return show.value.trim() ? base + '/' + show.value.trim() : base;
    },
    // target for lib:assign
    target() {
      if (where.value === 'inbox') return { inbox: true };
      if (where.value.startsWith('shared:')) return { shared: where.value.slice(7) };
      return { channel: where.value.slice(3), role: role.value, show: show.value.trim() };
    },
  };
}

const RATINGS = ['', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
const ratingSelect = (value) => h('select', { name: 'rating' }, RATINGS.map((r) => h('option', { value: r, selected: r === (value || '') }, r || 'Not rated')));

// ---------- Find ----------

const searchForm = $('#search');

async function runSearch(page = 1) {
  const f = Object.fromEntries(new FormData(searchForm));
  state.query = f;
  state.page = page;
  $('#results-info').textContent = 'Searching...';
  const r = await attempt(() => L.search('archive', { ...f, page, rows: 36 }));
  if (!r) return ($('#results-info').textContent = '');
  $('#results-info').textContent = r.total ? `${r.total.toLocaleString()} items` : 'Nothing found. Try fewer words or a wider scope.';
  $('#results').replaceChildren(
    ...r.items.map((it) =>
      h(
        'div',
        { class: 'card', 'data-id': it.id, onclick: () => openItem(it.id) },
        h('img', { src: it.thumb, alt: '', loading: 'lazy' }),
        h(
          'div',
          { class: 'body' },
          h('div', { class: 't', title: it.title }, it.title),
          h('div', { class: 'm' }, [it.year || (it.date || '').slice(0, 4), it.size ? fmtBytes(it.size) : '', `${(it.downloads || 0).toLocaleString()} downloads`].filter(Boolean).join(' · ')),
          it.broadcastHint ? h('div', null, h('span', { class: 'badge broadcast' }, 'Broadcast with ads')) : null
        )
      )
    )
  );
  const pages = Math.ceil(r.total / r.rows);
  $('#pager').replaceChildren(
    h('button', { disabled: page <= 1, onclick: () => runSearch(page - 1) }, 'Previous'),
    h('span', { class: 'muted' }, `Page ${page} of ${Math.max(pages, 1)}`),
    h('button', { disabled: page >= pages, onclick: () => runSearch(page + 1) }, 'Next')
  );
  $('.results-wrap').scrollTop = 0;
}

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(1);
});

async function openItem(id) {
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
  const pane = $('#item');
  pane.hidden = false;
  pane.replaceChildren(h('div', { class: 'muted' }, 'Loading files...'));
  const it = await attempt(() => L.item('archive', id));
  if (!it) return (pane.hidden = true);
  state.item = it;

  const dest = destinationPicker();
  const network = h('input', { name: 'network', placeholder: 'Network', value: (state.query && state.query.network) || '' });
  const year = h('input', { name: 'year', type: 'number', placeholder: 'Year', value: it.year || '' });
  const broadcast = h('input', { type: 'checkbox', checked: it.broadcastHint });
  const rating = ratingSelect('');

  const videos = it.files.filter((f) => !f.subtitle);
  const subs = it.files.filter((f) => f.subtitle);
  const boxes = new Map();
  const sumLine = h('span', { class: 'muted' });
  const dlBtn = h('button', { class: 'primary' }, 'Download');
  const updateSum = () => {
    const sel = it.files.filter((f) => boxes.get(f).checked);
    sumLine.textContent = sel.length ? `${sel.length} file${sel.length > 1 ? 's' : ''}, ${fmtBytes(sel.reduce((s, f) => s + (f.size || 0), 0))}` : 'Nothing selected';
    dlBtn.disabled = !sel.length;
  };
  const row = (f) => {
    const cb = h('input', { type: 'checkbox', checked: !!f.recommended && !f.have && !f.queued, onchange: updateSum });
    boxes.set(f, cb);
    return h(
      'tr',
      { class: f.recommended ? 'best' : '' },
      h('td', null, cb),
      h('td', { class: 'name' }, f.name, h('div', null,
        h('span', { class: 'badge ' + (f.original ? 'orig' : 'deriv') }, f.original ? 'original' : 'archive copy'), ' ',
        f.recommended ? h('span', { class: 'badge orig' }, 'recommended') : null, ' ',
        f.needsConversion ? h('span', { class: 'badge conv', title: 'Needs FFmpeg conversion before the TV can play it' }, "won't play as-is") : null, ' ',
        f.have ? h('span', { class: 'badge have', title: f.have }, 'in library') : f.queued ? h('span', { class: 'badge have' }, 'queued') : null)),
      h('td', null, f.format),
      h('td', { class: 'num' }, f.height ? `${f.width}×${f.height}` : ''),
      h('td', { class: 'num' }, fmtDur(f.length)),
      h('td', { class: 'num' }, fmtBytes(f.size)),
      h('td', { class: 'num' }, fmtKbps(f.bitrate))
    );
  };

  dlBtn.addEventListener('click', async () => {
    const meta = { source: 'archive', sourceItem: it.id, sourcePage: it.url, broadcast: broadcast.checked };
    if (network.value.trim()) meta.network = network.value.trim();
    if (year.value) meta.year = Number(year.value);
    if (rating.value) meta.rating = rating.value;
    if (broadcast.checked) meta.embeddedAds = true;
    const specs = it.files.filter((f) => boxes.get(f).checked).map((f) => ({ url: f.url, name: f.name, size: f.size, md5: f.md5, destDir: dest.destDir(), meta }));
    const res = await attempt(() => L.enqueue(specs));
    if (!res) return;
    const ok = res.filter((r) => r.ok && !r.duplicate).length;
    const dup = res.filter((r) => r.duplicate).length;
    const bad = res.filter((r) => !r.ok);
    toast([ok && `${ok} queued`, dup && `${dup} already downloaded or queued`, bad.length && `${bad.length} failed: ${bad[0].error}`].filter(Boolean).join(' · '), !!bad.length);
    openItem(it.id);
  });

  pane.replaceChildren(
    h('h2', null, it.title),
    h('div', { class: 'muted' }, [it.date, it.collections.slice(0, 3).join(', '), it.license ? 'License: ' + it.license : null].filter(Boolean).join(' · ')),
    h('div', { class: 'row' },
      h('button', { onclick: () => attempt(() => L.openSource(it.url)) }, 'Open on archive.org'),
      it.broadcastHint ? h('span', { class: 'badge broadcast' }, 'Looks like a complete broadcast') : null),
    it.description ? h('div', { class: 'desc' }, it.description) : null,
    dest.el,
    h('div', { class: 'row' }, h('label', null, 'Network', network), h('label', null, 'Year', year), h('label', null, 'Rating', rating),
      h('label', { class: 'check', title: 'Recordings that already contain their commercials. The TV won\'t add more.' }, broadcast, 'Complete broadcast (has its own ads)')),
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: () => (videos.forEach((f) => (boxes.get(f).checked = !!f.recommended && !f.have)), updateSum()) }, 'Select recommended'),
      h('button', { class: 'small', onclick: () => (it.files.forEach((f) => (boxes.get(f).checked = false)), updateSum()) }, 'Select none'),
      sumLine, dlBtn),
    videos.length
      ? h('table', { class: 'files' },
          h('thead', null, h('tr', null, h('th'), h('th', null, 'File'), h('th', null, 'Format'), h('th', null, 'Resolution'), h('th', null, 'Length'), h('th', null, 'Size'), h('th', null, 'Bitrate'))),
          h('tbody', null, videos.map(row)))
      : h('div', { class: 'muted' }, 'This item has no video files.'),
    subs.length ? h('table', { class: 'files' }, h('thead', null, h('tr', null, h('th'), h('th', null, 'Subtitles'))), h('tbody', null, subs.map((f) => {
      const cb = h('input', { type: 'checkbox', onchange: updateSum });
      boxes.set(f, cb);
      return h('tr', null, h('td', null, cb), h('td', { class: 'name' }, f.name));
    }))) : null
  );
  updateSum();
}

// ---------- Downloads ----------

let jobsFrame = 0;
function renderJobs() {
  cancelAnimationFrame(jobsFrame);
  jobsFrame = requestAnimationFrame(() => {
    const jobs = [...state.jobs.values()];
    const order = { downloading: 0, verifying: 1, queued: 2, paused: 3, error: 4, duplicate: 5, done: 6 };
    jobs.sort((a, b) => order[a.status] - order[b.status] || (b.added || '').localeCompare(a.added || ''));
    const active = jobs.filter((j) => ['downloading', 'verifying', 'queued'].includes(j.status)).length;
    $('#dl-badge').hidden = !active;
    $('#dl-badge').textContent = active;
    if (!jobs.length) return $('#jobs').replaceChildren(h('div', { class: 'muted' }, 'No downloads yet. Find something in the Find tab.'));
    $('#jobs').replaceChildren(
      ...jobs.map((j) => {
        const pct = j.size ? Math.min(100, (j.received / j.size) * 100) : 0;
        let status = j.status;
        if (j.status === 'downloading') {
          const eta = j.speed && j.size ? (j.size - j.received) / j.speed : 0;
          status = `${pct.toFixed(1)}% · ${fmtBytes(j.received)} of ${fmtBytes(j.size)} · ${fmtBytes(j.speed)}/s${eta ? ' · ' + fmtDur(eta) + ' left' : ''}`;
        } else if (j.status === 'paused') status = `Paused at ${pct.toFixed(1)}%`;
        else if (j.status === 'queued') status = 'Waiting';
        else if (j.status === 'verifying') status = 'Checking the file...';
        else if (j.status === 'done') status = 'Done → ' + j.path + (j.md5 ? ' (checksum verified)' : '');
        else if (j.status === 'duplicate') status = 'Done, but ' + j.error;
        else if (j.status === 'error') status = j.error;
        return h('div', { class: 'job' },
          h('div', null, h('div', { class: 'n' }, j.name), h('div', { class: 's' }, 'to media/' + j.destDir), h('div', { class: 's ' + (j.status === 'error' ? 'error' : j.status === 'done' ? 'done' : '') }, status)),
          h('div', { class: 'acts' },
            ['downloading', 'queued'].includes(j.status) ? h('button', { class: 'small', onclick: () => attempt(() => L.job(j.id, 'pause')) }, 'Pause') : null,
            ['paused', 'error'].includes(j.status) ? h('button', { class: 'small', onclick: () => attempt(() => L.job(j.id, 'resume')) }, j.status === 'error' ? 'Retry' : 'Resume') : null,
            j.status === 'done' && j.path ? h('button', { class: 'small', onclick: () => attempt(() => L.reveal(j.path)) }, 'Show file') : null,
            h('button', { class: 'small', title: j.status === 'done' ? 'Remove from this list (the file stays)' : 'Cancel and delete the partial download', onclick: () => attempt(() => L.job(j.id, 'remove')) }, j.status === 'done' ? 'Dismiss' : 'Cancel')),
          ['downloading', 'paused', 'verifying'].includes(j.status) ? h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })) : null
        );
      })
    );
  });
}

$('#clear-done').addEventListener('click', () => attempt(() => L.job(null, 'clear')));

// ---------- Conversions ----------

const MODE_LABEL = {
  remux: 'Rewrap into MP4 (no quality loss, quick)',
  audio: 'Convert the audio only (video untouched)',
  transcode: 'Re-encode to H.264 (takes a while)',
};

let convFrame = 0;
function renderConversions() {
  cancelAnimationFrame(convFrame);
  convFrame = requestAnimationFrame(() => {
    const list = [...state.conversions.values()].reverse();
    $('#conv-bar').hidden = !list.length;
    $('#conversions').replaceChildren(
      ...list.map((c) => {
        const pct = (c.progress || 0) * 100;
        const doing = { remux: 'Rewrapping', audio: 'Converting audio', transcode: 'Re-encoding' }[c.mode] || 'Starting';
        const label =
          c.status === 'running' ? `${doing} · ${pct.toFixed(1)}%`
          : c.status === 'queued' ? 'Waiting'
          : c.status === 'done' ? 'Done → ' + c.out + ' (original kept)'
          : c.status === 'cancelled' ? 'Cancelled'
          : c.error;
        const parts = c.rel.split('/');
        return h('div', { class: 'job' },
          h('div', null,
            h('div', { class: 'n' }, parts[parts.length - 1]),
            h('div', { class: 's' }, 'in media/' + parts.slice(0, -1).join('/')),
            h('div', { class: 's ' + (c.status === 'error' ? 'error' : c.status === 'done' ? 'done' : '') }, label)),
          h('div', { class: 'acts' },
            ['queued', 'running'].includes(c.status) ? h('button', { class: 'small', onclick: () => attempt(() => L.conversionJob(c.id, 'cancel')) }, 'Cancel') : null,
            c.status === 'done' ? h('button', { class: 'small', onclick: () => attempt(() => L.reveal(c.out)) }, 'Show file') : null),
          c.status === 'running' ? h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })) : null);
      })
    );
  });
}

$('#clear-conv').addEventListener('click', async () => {
  const list = await attempt(() => L.conversionJob(null, 'clear'));
  if (!list) return;
  state.conversions = new Map(list.map((c) => [c.id, c]));
  renderConversions();
});

// The "Make it play on the TV" box in a file's details.
function convertSection(e) {
  const box = h('div', { class: 'convert' }, h('b', null, 'Make it play on the TV'), h('div', { class: 'muted' }, 'Inspecting the file...'));
  const deint = h('input', { type: 'checkbox', checked: !!(e.probe && e.probe.interlaced) });
  const norm = h('input', { type: 'checkbox' });
  const opts = () => ({ deinterlace: deint.checked, normalize: norm.checked });
  const show = async () => {
    let d;
    try {
      d = await L.describeConversion(e.path, opts());
    } catch (err) {
      return box.replaceChildren(h('b', null, 'Make it play on the TV'), h('div', { class: 's error' }, String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
    }
    box.replaceChildren(
      h('b', null, MODE_LABEL[d.mode]),
      h('ul', null,
        d.reasons.map((r) => h('li', null, r)),
        d.segments.length > 1 ? h('li', null, `Joins ${d.segments.length} DVD segments into one file`) : null,
        h('li', null, `Saves "${d.outName}" next to the original, which is kept`)),
      h('div', { class: 'row' },
        h('label', { class: 'check' }, deint, 'Deinterlace'),
        h('label', { class: 'check', title: 'EBU R128 loudness normalization; re-encodes the audio' }, norm, 'Even out loudness'),
        h('button', { class: 'primary', onclick: async () => {
          const r = await attempt(() => L.convert([e.path], opts()));
          if (r && r[0].ok) toast('Converting. Progress is in the Downloads tab.');
          else if (r) toast(r[0].error, true);
        } }, 'Convert'))
    );
  };
  deint.addEventListener('change', show);
  norm.addEventListener('change', show);
  show();
  return box;
}

// Files "Convert all" should pick up: unplayable, not yet converted, and for DVD titles only the
// first segment (it pulls in the rest) and never the menu.
const convertible = (e) =>
  !e.missing && !(e.meta || {}).convertedTo && entryProblems(e) &&
  !/\.(srt|vtt)$/i.test(e.path) && !/VTS_\d\d_0\.VOB$/i.test(e.path) && !/VTS_\d\d_[2-9]\.VOB$/i.test(e.path);

$('#convert-all').addEventListener('click', async () => {
  const rels = state.entries.filter(convertible).map((e) => e.path);
  if (!rels.length) return toast('Everything already plays on the TV');
  const r = await attempt(() => L.convert(rels, {}));
  if (!r) return;
  const bad = r.filter((x) => !x.ok);
  toast(`${r.length - bad.length} queued for conversion` + (bad.length ? ` · ${bad.length} skipped: ${bad[0].error}` : ''), !!bad.length);
});

// ---------- Library ----------

function entryProblems(e) {
  return e.missing || (e.probe && (e.probe.error || e.probe.playable === false)) || /\.(vob|mpg|mpeg|avi|wmv|flv|ts)$/i.test(e.path);
}

function renderLibrary() {
  const q = $('#lib-filter').value.trim().toLowerCase();
  const role = $('#lib-role').value;
  const rows = state.entries.filter((e) => {
    const m = e.meta || {};
    if (role === 'problems' ? !entryProblems(e) : role && m.role !== role) return false;
    if (!q) return true;
    return [e.path, m.title, m.show, m.network, m.year].filter(Boolean).join(' ').toLowerCase().includes(q);
  });
  const table = $('#lib-table');
  table.replaceChildren(
    h('thead', null, h('tr', null, h('th'), h('th', null, `File (${rows.length})`), h('th', null, 'Show'), h('th', null, 'Network'), h('th', null, 'Year'), h('th', null, 'Length'), h('th', null, 'Video'), h('th', null, 'Notes'))),
    h('tbody', null,
      rows.map((e) => {
        const m = e.meta || {};
        const p = e.probe || {};
        const cb = h('input', { type: 'checkbox', checked: state.picked.has(e.path), onclick: (ev) => ev.stopPropagation(), onchange: (ev) => {
          ev.target.checked ? state.picked.add(e.path) : state.picked.delete(e.path);
          $('#compare').disabled = state.picked.size < 2;
        } });
        return h('tr', { class: state.entry === e.path ? 'sel' : '', onclick: () => openEntry(e.path) },
          h('td', null, cb),
          h('td', { class: 'name' }, m.title || e.path, h('div', { class: 'muted' }, e.path)),
          h('td', null, m.show || ''),
          h('td', null, m.network || ''),
          h('td', null, m.year || ''),
          h('td', { class: 'num' }, fmtDur(p.duration)),
          h('td', null, p.height ? `${p.width}×${p.height} ${p.vcodec || ''} ${p.aspect || ''}` : fmtBytes(e.size)),
          h('td', null,
            e.missing ? h('span', { class: 'badge conv' }, 'missing') : null, ' ',
            m.broadcast ? h('span', { class: 'badge broadcast' }, 'broadcast') : null, ' ',
            p.interlaced ? h('span', { class: 'badge deriv' }, 'interlaced') : null, ' ',
            entryProblems(e) && !e.missing ? h('span', { class: 'badge conv' }, "won't play") : null, ' ',
            m.rating ? h('span', { class: 'badge deriv' }, m.rating) : null)
        );
      }))
  );
  $('#compare').disabled = state.picked.size < 2;
}

$('#lib-filter').addEventListener('input', renderLibrary);
$('#lib-role').addEventListener('change', renderLibrary);

function openEntry(rel) {
  state.entry = rel;
  const e = state.entries.find((x) => x.path === rel);
  const pane = $('#entry');
  if (!e) return (pane.hidden = true);
  pane.hidden = false;
  renderLibrary();
  const m = e.meta || {};
  const p = e.probe;
  const field = (name, label, type = 'text') => h('label', null, label, h('input', { name, type, value: m[name] ?? '' }));
  const form = h('form', { class: 'form' },
    h('label', { class: 'wide' }, 'Title', h('input', { name: 'title', value: m.title || '' })),
    field('show', 'Show'), field('network', 'Network'), field('year', 'Year', 'number'), field('airDate', 'Air date', 'date'),
    field('season', 'Season', 'number'), field('episode', 'Episode', 'number'), field('category', 'Category (genre)'),
    h('label', null, 'Rating', ratingSelect(m.rating)),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'broadcast', checked: !!m.broadcast }), 'Complete broadcast'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'embeddedAds', checked: !!m.embeddedAds }), 'Has its own ads'),
    h('label', { class: 'wide' }, 'Notes', h('textarea', { name: 'notes', rows: 2 }, m.notes || '')),
    h('div', { class: 'wide row' }, h('button', { type: 'submit', class: 'primary' }, 'Save details'))
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const patch = {};
    for (const k of ['title', 'show', 'network', 'airDate', 'category', 'rating', 'notes']) patch[k] = String(fd.get(k) || '').trim();
    for (const k of ['year', 'season', 'episode']) patch[k] = fd.get(k) ? Number(fd.get(k)) : null;
    patch.broadcast = form.broadcast.checked;
    patch.embeddedAds = form.embeddedAds.checked;
    if (await attempt(() => L.update(rel, patch))) {
      toast('Saved');
      await refresh();
      openEntry(rel);
    }
  });

  const parts = rel.split('/');
  const dest = destinationPicker({ where: parts[0] === 'channels' ? 'ch:' + parts[1] : '', show: m.show, role: m.role });
  const moveBtn = h('button', { class: 'primary', onclick: async () => {
    const moved = await attempt(() => L.assign([rel], dest.target()));
    if (moved) {
      toast('Moved to ' + moved[0].path);
      await refresh();
      openEntry(moved[0].path);
    }
  } }, 'Move');

  pane.replaceChildren(
    h('h2', null, m.title || rel),
    h('div', { class: 'muted' }, rel, ' · ', fmtBytes(e.size), e.md5 ? ' · md5 ' + e.md5 : ''),
    h('div', { class: 'row' },
      h('button', { onclick: () => attempt(() => L.reveal(rel)) }, 'Show in folder'),
      h('button', { disabled: !state.overview.tools.ffprobe, onclick: async () => {
        if (await attempt(() => L.probe([rel]))) {
          await refresh();
          openEntry(rel);
        }
      } }, 'Inspect quality'),
      h('button', { onclick: async () => {
        toast('Computing checksum...');
        if (await attempt(() => L.hash(rel))) {
          await refresh();
          openEntry(rel);
        }
      } }, 'Checksum'),
      m.sourcePage ? h('button', { onclick: () => attempt(() => L.openSource(m.sourcePage)) }, 'Source page') : null),
    p ? qualityTable([e]) : h('div', { class: 'muted' }, state.overview.tools.ffprobe ? 'Not inspected yet.' : 'Install FFmpeg to see codec, bitrate and interlacing details.'),
    m.convertedTo
      ? h('div', { class: 'row' }, h('span', { class: 'badge have' }, 'converted'), h('span', { class: 'muted' }, m.convertedTo),
          h('button', { class: 'small', onclick: () => openEntry(m.convertedTo) }, 'Open'))
      : m.convertedFrom
        ? h('div', { class: 'muted' }, `Converted (${m.conversion}) from ${m.convertedFrom}`)
        : state.overview.tools.ffmpeg && !e.missing && !/\.(srt|vtt)$/i.test(rel) && (entryProblems(e) || (p && p.interlaced))
          ? convertSection(e)
          : null,
    h('h3', null, 'Put it on a channel'),
    dest.el,
    h('div', { class: 'row' }, moveBtn),
    h('h3', null, 'Details'),
    form
  );
}

// Side-by-side quality comparison; the best value in each row is highlighted.
function qualityTable(entries) {
  const rows = [
    ['Resolution', (p) => (p.height ? `${p.width}×${p.height}` : ''), (p) => p.height || 0],
    ['Aspect', (p) => p.aspect || ''],
    ['Video', (p) => [p.vcodec, fmtKbps(p.vbitrate)].filter(Boolean).join(' · '), (p) => p.vbitrate || 0],
    ['Audio', (p) => [p.acodec, fmtKbps(p.abitrate), p.channels ? p.channels + ' ch' : ''].filter(Boolean).join(' · '), (p) => p.abitrate || 0],
    ['Overall bitrate', (p) => fmtKbps(p.bitrate), (p) => p.bitrate || 0],
    ['Frame rate', (p) => (p.fps ? p.fps + ' fps' : '')],
    ['Scan', (p) => (p.interlaced ? `interlaced (${p.fieldOrder})` : p.fieldOrder === 'progressive' ? 'progressive' : p.fieldOrder || '')],
    ['Length', (p) => fmtDur(p.duration)],
    ['Plays on the TV', (p) => (p.playable ? 'yes' : p.vcodec ? 'needs conversion' : '')],
    ['Problems', (p) => [p.error, p.warnings].filter(Boolean).join(' ')],
  ];
  return h('table', null,
    entries.length > 1 ? h('thead', null, h('tr', null, h('th'), entries.map((e) => h('th', null, (e.meta && e.meta.title) || e.path)))) : null,
    h('tbody', null, rows.map(([label, show, score]) => {
      const vals = entries.map((e) => (score ? score(e.probe || {}) : 0));
      const best = Math.max(...vals);
      return h('tr', null, h('th', null, label), entries.map((e, i) =>
        h('td', { style: score && entries.length > 1 && vals[i] === best && best > 0 ? 'color: var(--good); font-weight: 600' : null }, show(e.probe || {}))));
    }))
  );
}

$('#compare').addEventListener('click', () => {
  const entries = state.entries.filter((e) => state.picked.has(e.path));
  const box = $('#modal .modal-box');
  box.replaceChildren(
    h('h2', null, 'Compare versions'),
    entries.some((e) => !e.probe) ? h('p', { class: 'muted' }, 'Some files are not inspected yet; inspect them for a full comparison.') : null,
    qualityTable(entries),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { onclick: () => ($('#modal').hidden = true) }, 'Close'))
  );
  $('#modal').hidden = false;
});
$('#modal').addEventListener('click', (e) => e.target.id === 'modal' && ($('#modal').hidden = true));

$('#import').addEventListener('click', async () => {
  const res = await attempt(() => L.importFiles('inbox'));
  if (!res || !res.length) return;
  const bad = res.filter((r) => !r.ok);
  toast(`${res.length - bad.length} imported into the inbox` + (bad.length ? ` · ${bad.length} skipped: ${bad[0].error}` : ''), !!bad.length);
  $('#lib-role').value = 'unassigned';
  refresh();
});

$('#probe-all').addEventListener('click', async () => {
  toast('Inspecting files...');
  const n = await attempt(() => L.probe([]));
  if (n != null) toast(`Inspected ${n} file${n === 1 ? '' : 's'}`);
  refresh();
});

// ---------- Channels ----------

function renderChannels() {
  const counts = {};
  for (const e of state.entries) {
    const parts = e.path.split('/');
    if (parts[0] === 'channels' && !e.missing) counts[parts[1]] = (counts[parts[1]] || 0) + 1;
  }
  $('#channels').replaceChildren(
    ...state.overview.channels.map((c) => {
      const s = c.settings || {};
      const form = h('form', { class: 'form' },
        h('label', null, 'Plays', h('select', { name: 'mode' },
          h('option', { value: 'episodes', selected: s.mode !== 'broadcast' }, 'Episodes + inserted ads'),
          h('option', { value: 'broadcast', selected: s.mode === 'broadcast' }, 'Complete broadcasts (no inserted ads)'))),
        h('label', null, 'Order', h('select', { name: 'order' },
          h('option', { value: '', selected: !s.order }, 'Default'),
          h('option', { value: 'shuffle', selected: s.order === 'shuffle' }, 'Shuffle'),
          h('option', { value: 'sequential', selected: s.order === 'sequential' }, 'In order'))),
        h('label', null, 'Bumpers per break', h('input', { name: 'bumpers', type: 'number', min: 0, max: 5, value: s.breaks ? s.breaks.bumpers : '' })),
        h('label', null, 'Ads per break', h('input', { name: 'commercials', type: 'number', min: 0, max: 12, value: s.breaks ? s.breaks.commercials : '' })),
        h('label', null, 'Rating', ratingSelect(s.rating)),
        h('label', { class: 'wide' }, 'Description', h('input', { name: 'description', value: s.description || '' })),
        h('label', { class: 'wide' }, 'Time blocks (JSON, see README)', h('textarea', { name: 'blocks', spellcheck: 'false' }, s.blocks ? JSON.stringify(s.blocks, null, 2) : '')),
        h('div', { class: 'wide row' }, h('button', { type: 'submit', class: 'primary' }, 'Save'), s.note ? h('span', { class: 'muted' }, s.note) : null)
      );
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        let blocks = null;
        const raw = form.blocks.value.trim();
        if (raw) {
          try {
            blocks = JSON.parse(raw);
            if (!Array.isArray(blocks)) throw new Error('Blocks must be a JSON list [ ... ]');
          } catch (e) {
            return toast('Time blocks: ' + e.message, true);
          }
        }
        const b = form.bumpers.value;
        const a = form.commercials.value;
        const patch = {
          mode: form.mode.value,
          order: form.order.value || null,
          breaks: b === '' && a === '' ? null : { bumpers: Number(b || 0), commercials: Number(a || 0) },
          rating: form.rating.value || null,
          description: form.description.value.trim() || null,
          blocks,
        };
        if (await attempt(() => L.channelSettings(c.folder, patch))) {
          toast(`Saved ${c.folder}`);
          refresh();
        }
      });
      return h('div', { class: 'chan' },
        h('h3', null, h('b', null, c.number), c.name),
        h('div', { class: 'muted' }, `${counts[c.folder] || 0} files · ${c.shows.length ? 'Shows: ' + c.shows.join(', ') : 'No show folders yet'}`),
        form);
    })
  );
}

$('#export-phone').addEventListener('click', async () => {
  const r = await attempt(() => L.exportPhone());
  if (r) toast(`Saved ${r.channels} channels and ${r.entries} videos' details. Put the file on your phone and import it in Settings.`);
});

$('#new-channel').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (await attempt(() => L.createChannel(f.number.value, f.name.value))) {
    toast(`Added channel ${f.number.value}`);
    f.reset();
    refresh();
  }
});

// ---------- Channel health ----------

let healthData = null;
let healthProblemsOnly = false;

async function loadHealth(action, arg) {
  const r = await attempt(() => L.health(action || 'get', arg));
  if (!r) return null;
  healthData = r;
  renderHealth();
  return r;
}

const ago = (t) => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
const pill = (status) => h('span', { class: 'pill ' + (status || 'unverified') }, status || 'unverified');

function renderHealth() {
  const d = healthData;
  if (!d) return;
  // Worst of the two views decides whether it counts as a problem.
  const bad = (c) => [c.check && c.check.status, c.playback && c.playback.status].some((s) => s === 'unavailable' || s === 'degraded');
  const rows = d.channels.filter((c) => !healthProblemsOnly || bad(c));
  const counts = {};
  for (const c of d.channels) {
    const s = (c.check && c.check.status) || 'unchecked';
    counts[s] = (counts[s] || 0) + 1;
  }
  $('#health').replaceChildren(
    h('div', { class: 'bar' },
      h('button', { class: 'primary', disabled: d.checking, onclick: () => { toast('Checking every channel. This takes a minute.'); loadHealth('check').then((r) => r && toast('Checked.')); } }, d.checking ? 'Checking...' : 'Check all channels'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: healthProblemsOnly, onchange: (e) => { healthProblemsOnly = e.target.checked; renderHealth(); } }), 'Only problems'),
      h('span', { class: 'muted' }, d.checkedAt ? `Checked ${ago(d.checkedAt)}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}` : 'Not checked yet.'),
      h('span', { class: 'muted' }, d.reportedAt ? `TV reported ${ago(d.reportedAt)}` : 'The TV reports here while it runs.')),
    h('p', { class: 'muted' }, '"Right now" asks each service whether the channel is on the air. "On the TV" is how it has actually played. Unverified means it can\'t be checked from here (some players only show it by watching). When a video fails, the TV tries it again, then puts a stand-in in its time slot; the schedule itself never changes.'),
    h('table', null,
      h('thead', null, h('tr', null, ['Ch', 'Channel', 'Source', 'Right now', 'On the TV', 'If it fails', ''].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((c) => {
        const k = c.check;
        const p = c.playback;
        return h('tr', null,
          h('td', { class: 'num' }, c.number),
          h('td', null, c.name),
          h('td', { class: 'muted' }, c.provider),
          h('td', null, k ? [pill(k.status), ' ', k.note || '', k.temporary ? h('div', { class: 'temp' }, 'Should come back by itself') : null] : h('span', { class: 'muted' }, 'not checked')),
          h('td', null, p ? [pill(p.status), p.lastOk ? h('div', { class: 'temp' }, `Last played ${ago(p.lastOk)}`) : null,
            p.failing ? h('div', { class: 'err' }, `${p.failing} of ${p.sources.toLocaleString()} failing${p.lastError ? `: ${p.lastError}` : ''} (${ago(p.lastFail)})`) : null] : h('span', { class: 'muted' }, 'not watched yet')),
          h('td', { class: 'muted' }, c.fallback),
          h('td', null, h('button', { class: 'small', onclick: () => loadHealth('check-one', c.number).then((r) => r && toast(`Checked ${c.number} ${c.name}`)) }, 'Check again')));
      }))),
    d.aired.some((a) => a.standIn)
      ? h('div', { class: 'panel' },
          h('h3', null, 'Recent stand-ins'),
          h('ul', null, d.aired.filter((a) => a.standIn).slice(-12).reverse().map((a) => h('li', null,
            `${new Date(a.at).toLocaleString()} · ch ${a.ch}: "${a.aired}" stood in for "${a.scheduled}"${a.reason ? ` (${a.reason})` : ''}`))))
      : null
  );
}

// ---------- Your drives (folders used where they are) ----------

let drives = null; // { linked, measuring, ffprobe }
let picked = null; // a folder being set up: { folder, channels, free, mode, rows }

async function loadDrives(action, arg) {
  const r = await attempt(() => L.linked(action || 'list', arg));
  if (!r) return null;
  if (action === 'pick') {
    const f = r.folder;
    const byName = (name) => r.channels.find((c) => c.name.toLowerCase() === name.toLowerCase());
    picked = {
      ...r,
      mode: f.subfolders.length ? 'each' : 'one',
      rows: f.subfolders.map((s) => {
        const ch = byName(s.name);
        return { ...s, choice: ch ? 'n:' + ch.number : 'new', name: s.name };
      }),
      one: { choice: 'new', name: f.name },
      kids: false,
      family: true,
    };
    return loadDrives();
  }
  drives = r;
  renderDrives();
  return r;
}

function channelSelect(value, channels, onchange) {
  return h('select', { onchange: (e) => onchange(e.target.value) },
    h('option', { value: 'skip', selected: value === 'skip' }, "Don't use"),
    h('option', { value: 'new', selected: value === 'new' }, 'New channel'),
    channels.map((c) => h('option', { value: 'n:' + c.number, selected: value === 'n:' + c.number }, `${c.number} ${c.name}`)));
}

function pickerPanel() {
  const p = picked;
  const f = p.folder;
  const rows = p.mode === 'each' ? p.rows : [{ ...f, ...p.one, name: p.one.name }];
  const setRow = (i, patch) => {
    if (p.mode === 'each') Object.assign(p.rows[i], patch);
    else Object.assign(p.one, patch);
    renderDrives();
  };
  const save = async () => {
    const free = p.free.slice();
    const items = [];
    for (const r of rows) {
      if (r.choice === 'skip') continue;
      if (r.choice === 'new') items.push({ path: r.path, newChannel: { number: free.shift(), name: r.name, kids: p.kids, family: p.family } });
      else items.push({ path: r.path, channel: Number(r.choice.slice(2)) });
    }
    if (!items.length) return toast('Pick at least one folder to use', true);
    if (await loadDrives('save', items)) {
      picked = null;
      renderDrives();
      toast(`Linked ${items.length} folder${items.length > 1 ? 's' : ''}. The TV picks them up now; lengths are measured in the background.`);
    }
  };
  let next = p.free.slice();
  return h('div', { class: 'panel' },
    h('h3', null, f.path),
    h('div', { class: 'muted' }, `${f.videos.toLocaleString()} videos (${fmtBytes(f.bytes)})${f.convert ? `, plus ${f.convert} in formats that need converting first` : ''}`),
    f.subfolders.length
      ? h('div', { class: 'row' },
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', checked: p.mode === 'each', onchange: () => { p.mode = 'each'; renderDrives(); } }), 'Each folder below is its own channel'),
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', checked: p.mode === 'one', onchange: () => { p.mode = 'one'; renderDrives(); } }), 'Put everything on one channel (folders become show names)'))
      : null,
    h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Folder'), h('th', null, 'Videos'), h('th', null, 'Channel'), h('th', null, 'New channel name'))),
      h('tbody', null, rows.map((r, i) => {
        const num = r.choice === 'new' ? next.shift() : null;
        return h('tr', null,
          h('td', { class: 'name' }, r.name),
          h('td', { class: 'num' }, `${r.videos}${r.convert ? ` (+${r.convert} to convert)` : ''}`),
          h('td', null, channelSelect(r.choice, p.channels, (v) => setRow(i, { choice: v }))),
          h('td', null, r.choice === 'new'
            ? h('div', { class: 'row' }, h('b', null, num), h('input', { value: r.name, oninput: (e) => (p.mode === 'each' ? (p.rows[i].name = e.target.value) : (p.one.name = e.target.value)) }))
            : null));
      }))),
    p.mode === 'each' && f.direct ? h('p', { class: 'muted' }, `${f.direct} videos sit directly in ${f.name} (not in a subfolder) and aren't included. Choose "one channel" to include them.`) : null,
    h('div', { class: 'row' },
      h('span', { class: 'muted' }, 'New channels show for:'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.kids, onchange: (e) => (p.kids = e.target.checked) }), 'Kids'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.family, onchange: (e) => (p.family = e.target.checked) }), 'Family'),
      h('span', { class: 'muted' }, '(Late Night shows everything)')),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: save }, 'Use these folders'),
      h('button', { onclick: () => { picked = null; renderDrives(); } }, 'Cancel')));
}

function renderDrives() {
  if (!drives) return;
  const m = drives.measuring;
  $('#drives').replaceChildren(
    h('div', { class: 'panel' },
      h('h3', null, 'Use videos from your drives'),
      h('p', { class: 'muted' }, "Pick a folder or a whole drive. Its videos are used right where they are: nothing is copied, so a 3 TB drive doesn't need 3 TB more space. Subfolders become show names. If a drive is unplugged, its shows leave the TV until you plug it back in."),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => loadDrives('pick') }, 'Add a folder or drive...'),
        drives.linked.length ? h('button', { onclick: () => loadDrives('rescan').then((r) => r && toast('Looked again for new videos')) }, 'Look for new videos') : null),
      h('p', { class: 'muted' }, 'Videos on another computer: plugging its drive into this PC is fastest. Or share the folder on that computer (right-click, Properties, Sharing) and pick it here under Network; that computer then has to stay on.')),
    picked ? pickerPanel() : null,
    h('div', { class: 'panel' },
      h('h3', null, 'Linked folders'),
      !drives.ffprobe ? h('p', { class: 'off' }, "FFmpeg isn't installed, so lengths are measured when you first tune to each channel instead.") : null,
      m && m.measuring ? h('p', null, `Measuring video lengths in the background: ${m.done.toLocaleString()} of ${m.total.toLocaleString()}`) : null,
      drives.linked.length
        ? h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Folder'), h('th', null, 'Channel'), h('th', null, 'Videos'), h('th', null, 'Ready'), h('th', null, ''))),
            h('tbody', null, drives.linked.map((l) => h('tr', null,
              h('td', { class: 'name' }, l.path, l.connected ? null : h('div', { class: 'off' }, 'Not connected')),
              h('td', null, `${l.channel} ${l.channelName}`),
              h('td', { class: 'num' }, l.connected ? l.videos.toLocaleString() : ''),
              h('td', { class: 'num' }, l.connected ? `${l.measured.toLocaleString()}` : ''),
              h('td', null, h('button', { class: 'small', onclick: () => loadDrives('remove', l.path).then((r) => r && toast('Unlinked. The files are untouched.')) }, 'Unlink'))))))
        : h('p', { class: 'muted' }, 'Nothing linked yet.'))
  );
}

// ---------- Phone at home ----------

let home = null;
let homeBusy = false;
let share = null; // Tailscale Funnel: { installed, signedIn, url, on, needsApproval }

async function loadHome(action, arg) {
  const r = await attempt(() => L.home(action || 'status', arg));
  if (!r) return null;
  home = r.status;
  homeBusy = !!r.building;
  if (r.share) share = r.share;
  renderHome();
  return r;
}

// Share over the internet: Tailscale Funnel gives this computer a free public https address.
function sharePanel() {
  const t = share;
  const box = h('div', { class: 'panel' }, h('h3', null, 'Share over the internet'));
  if (!t) return box.appendChild(h('p', { class: 'muted' }, 'Checking for Tailscale...')) && box;
  if (!t.installed || !t.signedIn) {
    box.append(
      h('p', null, t.installed ? 'Open Tailscale and sign in (a free account is fine).' : 'Install Tailscale, free from tailscale.com/download, and sign in.'),
      h('p', { class: 'muted' }, "Tailscale gives this computer a permanent https address that works from anywhere, with nothing to change on your router. Viewers don't need Tailscale."),
      h('div', { class: 'row' }, h('button', { onclick: () => loadHome() }, 'Check again')));
    return box;
  }
  const flip = async (on) => {
    toast(on ? 'Turning sharing on...' : 'Turning sharing off...');
    const r = await loadHome('share', on);
    if (r && r.share && r.share.needsApproval) toast('Tailscale needs you to allow this once. Press the button below.', true);
    else if (r) toast(on ? 'Shared. The address is below.' : 'Sharing is off.');
  };
  box.append(
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: t.on, onchange: (e) => flip(e.target.checked) }),
      'Share my shows over the internet'),
    t.needsApproval && !t.on
      ? h('div', { class: 'row' },
          h('span', null, 'Tailscale asks you to allow sharing once, in your Tailscale account.'),
          h('button', { class: 'primary', onclick: () => L.home('approve') }, 'Allow it in Tailscale'),
          h('button', { onclick: () => flip(true) }, 'Done, try again'))
      : null,
    t.on
      ? h('div', null,
          h('div', { class: 'addr' }, t.url),
          h('p', { class: 'muted' }, 'On any phone, iPad or computer: open the Retro TV website, then Settings, "Shows on your PC", and enter this address. To show these for everyone on the website without typing it, it goes in the website\'s settings (see the setup guide). This computer has to stay on and awake.'))
      : h('p', { class: 'muted' }, `Your address will be ${t.url}. Turning this on also turns on the home server.`));
  return box;
}

// The Retro TV website (the phone app everyone opens): publish this PC's lineup to it.
function publishPanel() {
  const title = h('input', { placeholder: "What's new, in a few words (optional)" });
  const changes = h('textarea', { rows: 2, placeholder: 'One change per line (optional)' });
  const go = async () => {
    homeBusy = true;
    renderHome();
    toast('Publishing the website. This takes a minute or two.');
    const notes = title.value.trim() ? [title.value.trim(), ...changes.value.split('\n')] : [];
    const r = await loadHome('publish', notes);
    homeBusy = false;
    renderHome();
    if (r) toast(r.built || 'Published');
  };
  return h('div', { class: 'panel' },
    h('h3', null, 'The Retro TV website'),
    h('p', { class: 'muted' }, 'Channel changes on this PC reach phones and iPads when the website is published. Phones pick up the new version the next time Retro TV is opened. A note here shows up in their What\'s New.'),
    title,
    changes,
    h('div', { class: 'row' }, h('button', { class: 'primary', disabled: homeBusy, onclick: go }, homeBusy ? 'Working...' : 'Publish the website')));
}

function renderHome() {
  if (!home) return;
  const s = home;
  const when = (t) => (t ? new Date(t).toLocaleString() : '');
  const kind = { home: 'home Wi-Fi', tailscale: 'Tailscale, works away from home', name: "this PC's name, works on many home networks" };
  const c = s.counts;
  const port = h('input', { type: 'number', min: 1024, max: 65535, value: s.port });
  const state = !s.enabled
    ? h('span', { class: 'state' }, 'Off')
    : s.running
      ? h('span', { class: 'state on' }, `On, port ${s.port}`)
      : h('span', { class: 'state bad' }, s.error || 'Starting...');

  const build = async () => {
    homeBusy = true;
    renderHome();
    toast('Updating the phone app files. This takes a minute.');
    const r = await loadHome('build');
    homeBusy = false;
    renderHome();
    if (r) toast(r.built || 'Phone app files updated');
  };

  $('#home').replaceChildren(
    h('div', { class: 'panel' },
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => loadHome('enable', e.target.checked) }),
        'Let my phone and iPad play shows from this PC'),
      h('div', null, 'Status: ', state),
      h('p', { class: 'muted' }, "Only devices on your own network (or your Tailscale) can connect, and only after entering the passcode below. The first time it's turned on, Windows asks whether to allow it: tick Private networks."),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Port'), port,
        h('button', { onclick: () => loadHome('port', port.value).then((r) => r && toast('Port saved')) }, 'Change port'))),

    sharePanel(),

    h('div', { class: 'panel' },
      h('h3', null, 'Passcode'),
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: !s.open, onchange: (e) => loadHome('open', !e.target.checked) }),
        'Ask for a passcode'),
      s.open
        ? h('p', { class: 'muted' }, "Off: anyone who has the address can watch every linked show, without asking. They can't change or delete anything. Only link folders you're happy for anyone to see.")
        : h('div', null,
            h('div', { class: 'code' }, s.code),
            h('div', { class: 'row' },
              h('button', { onclick: () => loadHome('code') }, 'New passcode'),
              h('span', { class: 'muted' }, 'A new passcode only affects phones that connect from now on.')))),

    h('div', { class: 'panel' },
      h('h3', null, 'Set up a phone or iPad'),
      h('ol', null,
        h('li', null, 'Connect it to the same Wi-Fi as this PC.'),
        h('li', null, 'In Safari, go to one of these addresses (try them in order):',
          s.running
            ? h('ul', null, s.addresses.map((a) => h('li', null, h('span', { class: 'addr' }, a.url), h('span', { class: 'muted' }, `  ${kind[a.kind]}${a.adapter ? ` (${a.adapter})` : ''}`))))
            : h('div', { class: 'muted' }, 'Turn the home server on to see the addresses.')),
        h('li', null, 'Enter the passcode when Retro TV asks for it.'),
        h('li', null, 'Tap Share, then "Add to Home Screen". It becomes a second Retro TV icon, with your PC\'s shows added to their channels.')),
      h('p', { class: 'muted' }, 'Away from home: install Tailscale (free) on this PC and on the phone, sign in to the same account on both, and use the Tailscale address. Use that address at home too, so you only need one icon.')),

    h('div', { class: 'panel' },
      h('h3', null, 'What the phone gets'),
      c
        ? h('ul', null,
            h('li', null, `${c.ready} episodes ready to play`),
            c.needsConvert ? h('li', null, `${c.needsConvert} need converting to MP4 first (iPhones can't play them). Use Convert in My Library.`) : null,
            c.unmeasured ? h('li', null, `${c.unmeasured} haven't been measured yet. Tune to their channel on the TV once, or use Inspect in My Library.`) : null)
        : h('p', { class: 'muted' }, 'Nothing counted yet.'),
      h('div', { class: 'row' },
        h('button', { onclick: () => loadHome('refresh').then((r) => r && toast('Counted again')) }, 'Count again'),
        h('button', { disabled: homeBusy, onclick: build }, homeBusy ? 'Updating...' : 'Update phone app files')),
      h('p', { class: 'muted' }, s.appBuilt ? 'Update the phone app files after changing channels, so the phone gets the new lineup.' : "The phone app files haven't been built yet: press Update phone app files first.")),

    publishPanel(),

    h('div', { class: 'panel' },
      h('h3', null, 'Connected phones'),
      s.devices.length
        ? h('ul', null, s.devices.map((d) => h('li', null, `${d.name} · connected ${when(d.paired)}${d.seen ? ` · last seen ${when(d.seen)}` : ''}  `,
            h('button', { class: 'small', onclick: () => loadHome('forget', d.id) }, 'Forget'))))
        : h('p', { class: 'muted' }, 'None yet.'),
      s.devices.length > 1 ? h('div', { class: 'row' }, h('button', { onclick: () => loadHome('forget') }, 'Forget all')) : null)
  );
}

// ---------- Live updates ----------

L.onEvent(({ type, data }) => {
  if (type === 'job') {
    state.jobs.set(data.id, data);
    renderJobs();
    if (data.status === 'done' || data.status === 'duplicate') refresh();
  } else if (type === 'job-removed') {
    state.jobs.delete(data);
    renderJobs();
  } else if (type === 'jobs-cleared') {
    for (const [id, j] of state.jobs) if (j.status === 'done' || j.status === 'duplicate') state.jobs.delete(id);
    renderJobs();
  } else if (type === 'convert') {
    state.conversions.set(data.id, data);
    renderConversions();
    if (data.status === 'done') refresh();
  } else if (type === 'health') {
    healthData = data;
    if ($('#tab-health').classList.contains('on')) renderHealth();
  } else if (type === 'linked') {
    if (drives) drives.measuring = data;
    if ($('#tab-drives').classList.contains('on') && !picked) {
      if (!data.measuring) loadDrives();
      else renderDrives();
    }
  } else if (type === 'home') {
    home = data;
    if ($('#tab-home').classList.contains('on')) renderHome();
  } else if (type === 'probe') {
    const i = state.entries.findIndex((e) => e.path === data.rel);
    if (i >= 0 && data.entry) state.entries[i] = data.entry;
    if (data.done % 10 === 0 || data.done === data.total) toast(`Inspected ${data.done} of ${data.total}`);
  }
});

(async function init() {
  await refresh();
  const scope = searchForm.scope;
  scope.replaceChildren(...state.overview.sources[0].scopes.map((s) => h('option', { value: s.id }, s.label)));
})();
