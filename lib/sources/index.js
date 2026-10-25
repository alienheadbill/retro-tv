// Source adapter registry. An adapter provides: id, name, search(opts), item(id), allows(url).
// Add new archives by writing an adapter with the same shape and listing it here.
const archive = require('./archive-org');

const adapters = { [archive.id]: archive };

function get(id) {
  const a = adapters[id];
  if (!a) throw new Error('Unknown source: ' + id);
  return a;
}

const allowsDownload = (url) => Object.values(adapters).some((a) => a.allows(url));

const describe = () =>
  Object.values(adapters).map((a) => ({
    id: a.id,
    name: a.name,
    scopes: Object.entries(a.SCOPES || {}).map(([id, s]) => ({ id, label: s.label })),
    categories: Object.keys(a.CATEGORIES || {}),
  }));

module.exports = { get, allowsDownload, describe };
