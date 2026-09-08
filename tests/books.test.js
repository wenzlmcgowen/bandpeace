/* books.test.js — the /wenzl/ BOOKS realm of board-backend/Code.gs, offline.
 * Run: node tests/books.test.js
 */
'use strict';

const { loadEngine } = require('./gas-harness');

const BOARD = 'pp' + 'B'.repeat(44);
const SHOWS = 'sh' + 'S'.repeat(44);
const BOOKS = 'bk' + 'K'.repeat(44);
const WRONG = 'bk' + 'X'.repeat(44);

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push(name + ' — ' + err.message); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((what || 'value') + ': got ' + a + ', wanted ' + b);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected true'); }

function fresh() { return loadEngine({ board: BOARD, shows: SHOWS, books: BOOKS }); }

const PROFILE = {
  meta: { generated: '2026-09-08', source: 'quickbooks-production', simulated: false, years: [2026] },
  categories: ['Music Royalties'],
  monthly: [{ year: 2026, month: 1, category: 'Music Royalties', amount: 100.5 }],
  expenses: [{ year: 2026, month: 1, amount: 40 }],
  expense_categories: ['Meta Ads'],
  expenses_by_category: [{ year: 2026, month: 1, category: 'Meta Ads', amount: 40 }],
  schedule_c: { 2026: { year: 2026, gross_receipts: 100.5 } }
};

/* ── the gate ──────────────────────────────────────────────────── */

check('a wrong books token gets the shrug, and says nothing else', () => {
  const { call } = fresh();
  eq(call.get({ token: WRONG, action: 'books' }), { ok: false, error: 'nope' });
});

check('a board token cannot reach the books API', () => {
  const { call } = fresh();
  const res = call.get({ token: BOARD, action: 'books' });
  ok(res.profile === undefined, 'board key must not open the books');
});

check('a shows token cannot reach the books API', () => {
  const { call } = fresh();
  const res = call.get({ token: SHOWS, action: 'books' });
  ok(res.profile === undefined, 'shows key must not open the books');
});

check('a books token cannot reach the board or the shows', () => {
  const { call } = fresh();
  eq(call.get({ token: BOOKS, action: 'list' }).error, 'unknown action', 'board door stays shut');
  eq(call.get({ token: BOOKS, action: 'shows' }).error, 'unknown action', 'shows door stays shut');
});

check('the committed placeholder can never validate', () => {
  const { call } = loadEngine({ board: BOARD, shows: SHOWS, books: '__BOOKS_TOKEN__' });
  eq(call.get({ token: '__BOOKS_TOKEN__', action: 'books' }), { ok: false, error: 'nope' });
});

/* ── the data ──────────────────────────────────────────────────── */

check('empty books answer honestly: nothing published yet', () => {
  const { call } = fresh();
  eq(call.get({ token: BOOKS, action: 'books' }),
     { ok: true, updated: null, source: null, profile: null });
});

check('publish then read back, byte for byte', () => {
  const { call } = fresh();
  const put = call.post({ token: BOOKS, action: 'books-put', source: 'test', profile: PROFILE });
  ok(put.ok === true, 'put should succeed: ' + JSON.stringify(put));
  ok(put.bytes > 0, 'bytes reported');
  const back = call.get({ token: BOOKS, action: 'books' });
  eq(back.profile, PROFILE, 'profile survives the round trip');
  eq(back.source, 'test', 'source recorded');
});

check('a second publish fully replaces the first', () => {
  const { call } = fresh();
  call.post({ token: BOOKS, action: 'books-put', profile: PROFILE });
  const smaller = { meta: { generated: '2026-09-09' }, categories: [] };
  call.post({ token: BOOKS, action: 'books-put', profile: smaller });
  eq(call.get({ token: BOOKS, action: 'books' }).profile, smaller, 'no stale chunks left behind');
});

check('a big profile survives chunking (over one 45k cell)', () => {
  const { call } = fresh();
  const big = { meta: { generated: '2026-09-08' }, blob: 'x'.repeat(120000) };
  const put = call.post({ token: BOOKS, action: 'books-put', profile: big });
  ok(put.ok === true, 'big put ok');
  eq(call.get({ token: BOOKS, action: 'books' }).profile.blob.length, 120000, 'blob intact');
});

check('junk profiles are refused', () => {
  const { call } = fresh();
  eq(call.post({ token: BOOKS, action: 'books-put', profile: 'hi' }).error, 'profile must be an object');
  eq(call.post({ token: BOOKS, action: 'books-put', profile: [1, 2] }).error, 'profile must be an object');
  eq(call.post({ token: BOOKS, action: 'books-put', profile: { no: 'meta' } }).error, 'profile has no meta block');
});

check('books live in their own spreadsheet', () => {
  const { call, env } = fresh();
  call.post({ token: BOOKS, action: 'books-put', profile: PROFILE });
  call.post({ token: SHOWS, action: 'show-add', title: 'a show', date: '2026-10-09' });
  const names = env.SpreadsheetApp._all().map((ss) => ss.getName ? ss.getName() : ss.name);
  ok(names.indexOf('Wenzl Books (private)') !== -1, 'books sheet exists: ' + names.join(', '));
  ok(names.indexOf('Shows & Logistics (private)') !== -1, 'shows sheet exists');
});

/* ── the page's key derivation matches Python ──────────────────── */

check('KDF parameters are pinned', () => {
  const W = require('../site/wenzl/wenzl.js');
  eq(W.KDF, { salt: 'bandpeace-books-v1', iterations: 4000000, bits: 256 }, 'parameters');
});

/* async: same password, same key, in browser-crypto and Python.
   Pinned vector from:
   python3 -c "import hashlib;print('bk'+hashlib.pbkdf2_hmac('sha256',
     b'correct horse battery staple', b'bandpeace-books-v1', 4000000, 32).hex())" */
const { webcrypto } = require('crypto');
const W = require('../site/wenzl/wenzl.js');
const pinned = 'bkdb485c663de816dce7f55d6604cef4c5af2552ce67929af3531601c1319a97aa';

W.deriveToken('correct horse battery staple', webcrypto.subtle).then((token) => {
  if (token !== pinned) failures.push('deriveToken — got ' + token + ', wanted ' + pinned);
  else passed++;
  if (!W.TOKEN_RE.test(token)) failures.push('derived token fails its own format check');
  else passed++;
  report();
}).catch((e) => { failures.push('deriveToken threw — ' + e.message); report(); });

function report() {
  console.log('books.test.js: ' + passed + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(failures.length ? 1 : 0);
}
