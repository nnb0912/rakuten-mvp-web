const fs = require('fs');
const path = require('path');
const PROJECT = path.resolve(process.env.RPP_PROJECT_DIR || __dirname);

let cache = null;
function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(path.join(PROJECT, 'rpp_item_display_names.json'), 'utf8')).items || {};
  } catch (e) {
    cache = {};
  }
  return cache;
}

function displayName(itemCode, fallback = '') {
  const m = load()[String(itemCode || '').toLowerCase()];
  return (m && m.name) || String(fallback || itemCode || '').slice(0, 24);
}

module.exports = { displayName };
