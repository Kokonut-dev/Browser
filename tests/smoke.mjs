// Boot smoke test: loads the assembled chrome in jsdom and drives it.
// Run: node tests/smoke.mjs   (requires jsdom: npm i --no-save jsdom)
import { JSDOM } from 'jsdom';

const res = await fetch('http://127.0.0.1:4173/');
const html = await res.text();

const errors = [];
const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:4173/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
});
dom.window.addEventListener('error', (e) => errors.push(e.message));
// jsdom lacks these layout APIs the chrome touches.
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: true, addEventListener() {} }));

await new Promise((r) => setTimeout(r, 600));
const { document } = dom.window;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) process.exitCode = 1;
};

check('no script errors during boot', errors.length === 0);
if (errors.length) console.log('  errors:', errors.slice(0, 5));
check('first-run DNS dialog shown', !document.querySelector('#firstrun-overlay').hidden);
check('spaces rendered', document.querySelectorAll('.space-chip[data-space]').length === 3);
check('favorites rendered', document.querySelectorAll('.fav-tile').length === 2);
check('today tabs rendered', document.querySelectorAll('#today-list .tab-row').length === 2);
check('new tab page in pane', document.querySelector('#panes .internal')?.textContent.includes('Press'));
check('filter engine armed (rules chip)', /Filter rules/.test(document.querySelector('#panes .internal').textContent));

// Choose system DNS → dialog closes.
document.querySelector('.doh-option[data-doh=""]').click();
await new Promise((r) => setTimeout(r, 50));
check('DNS dialog closes after choice', document.querySelector('#firstrun-overlay').hidden);

// Command bar via keyboard (Ctrl+T), fuzzy search, Enter opens.
const key = (k, opts = {}) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
key('t', { ctrlKey: true });
await new Promise((r) => setTimeout(r, 80));
check('command bar opens with Ctrl+T', !document.querySelector('#command-overlay').hidden);
const input = document.querySelector('#cb-input');
input.value = 'wiki';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
check('fuzzy results include Wikipedia', document.querySelector('#cb-results').textContent.includes('Wikipedia'));
key('Enter');
await new Promise((r) => setTimeout(r, 80));
check('command bar closes after Enter', document.querySelector('#command-overlay').hidden);
check('shields badge present', document.querySelector('#shields-count') !== null);

// Settings via keyboard shortcut Ctrl+,
key(',', { ctrlKey: true });
await new Promise((r) => setTimeout(r, 80));
check('settings page opens', document.querySelector('#panes .internal')?.textContent.includes('Phantom Shields'));

// Toggle theme through settings control.
const themeSel = document.querySelector('[data-setting="httpsMode"]');
check('privacy controls rendered', !!themeSel);

console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
process.exit(process.exitCode || 0);
