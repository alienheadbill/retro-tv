// Internet Archive adapter for the desktop app: the shared parsing in archive-core.js plus
// network access from the main process.
const core = require('./archive-core');

const UA = 'RetroTV/1.0 (personal household media manager)';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Internet Archive answered ${res.status}`);
  return res.json();
}

module.exports = {
  id: 'archive',
  name: 'Internet Archive',
  SCOPES: core.SCOPES,
  CATEGORIES: core.CATEGORIES,
  buildQuery: core.buildQuery,
  parseSearch: core.parseSearch,
  parseItem: core.parseItem,
  downloadUrl: core.downloadUrl,
  search: (opts = {}) => core.search(opts, getJson),
  item: (id) => core.item(id, getJson),
  allows: core.allows,
};
