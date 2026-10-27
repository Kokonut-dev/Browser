// Zero-dependency dev server for the Phantom chrome.
// Serves ui/index.html with CSS/JS/filter-list inlined exactly like the
// desktop shell does (crates/phantom-app chrome_source), so what you see
// here is byte-identical to what runs inside the native app.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const Path = require('node:path');

const ROOT = Path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4173);

function buildIndex() {
  const read = (p) => fs.readFileSync(Path.join(ROOT, p), 'utf8');
  const html = read('ui/index.html');
  const css = read('ui/css/phantom.css');
  const filters = read('assets/filters/base.txt');
  const js = `window.__PHANTOM_FILTERS__ = ${JSON.stringify(filters)};\n`
    + ['ui/js/fuzzy.js', 'ui/js/filters.js', 'ui/js/state.js', 'ui/js/app.js'].map(read).join('\n');
  // Replacer functions, not strings: the inlined JS contains $ sequences
  // (e.g. lastIndexOf('$')) that String.replace would interpret as patterns.
  return html
    .replace('/* __PHANTOM_CSS__ */', () => css)
    .replace('// __PHANTOM_JS__', () => js);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buildIndex());
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Phantom dev server error: ' + e.message);
    }
    return;
  }
  if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found. Phantom serves only its chrome at /.');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Phantom chrome dev server → http://0.0.0.0:${PORT}`);
});
