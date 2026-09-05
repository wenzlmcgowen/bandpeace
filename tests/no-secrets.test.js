/* no-secrets.test.js — this repo is PUBLIC. Nothing that unlocks a private
 * page may ever be committed to it.
 *
 * The keys have a shape (pp… / sh…, 40+ letters and digits), so a real one can
 * be recognised without this file knowing what any of them are. The known-fake
 * ones — the placeholders in Code.gs and the one-letter tokens the tests build
 * — are allowed through by name.
 *
 * Run: node tests/no-secrets.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
const TEXT = /\.(js|gs|json|html|css|md|txt|command|csv|yml|yaml)$/i;

const KEY_SHAPE = /\b(pp|sh)[A-Za-z0-9]{40,}\b/g;
/* A token made of one repeated character is a test fixture, not a secret. */
const OBVIOUSLY_FAKE = /^(pp|sh)(.)\2{39,}$/;
const PLACEHOLDERS = new Set(['__PANDA_TOKEN__', '__SHOWS_TOKEN__']);

/* One real-shaped key is allowed here, by exact value and nothing else: the
   key of the throwaway password "correct horse battery staple", which pins the
   page's stretching maths to Python's in tests/shows-ui.test.js. It opens
   nothing. Widening this list is how a real key would eventually slip past —
   so it takes exact strings, never patterns. */
const ALLOWED = new Set([
  'shd2c4f90d65d851fd84e458243175153224b6688a3137c0aaca8be474c398dde1'
]);

const findings = [];
let scanned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!TEXT.test(entry.name)) continue;
    scanned++;
    const text = fs.readFileSync(full, 'utf8');
    const rel = path.relative(ROOT, full);

    let m;
    KEY_SHAPE.lastIndex = 0;
    while ((m = KEY_SHAPE.exec(text)) !== null) {
      const hit = m[0];
      if (OBVIOUSLY_FAKE.test(hit) || PLACEHOLDERS.has(hit) || ALLOWED.has(hit)) continue;
      findings.push(rel + ' holds something shaped like a real key (' +
        hit.slice(0, 4) + '…, ' + hit.length + ' chars)');
    }
    if (/PANDA_BOARD_TOKEN\s*=\s*pp[A-Za-z0-9]/.test(text) ||
        /SHOWS_TOKEN\s*=\s*sh[A-Za-z0-9]/.test(text)) {
      findings.push(rel + ' assigns a key inline — keys live in founder-os/secrets/ only');
    }
  }
}

walk(ROOT);

console.log('\nno secrets: scanned ' + scanned + ' files, ' + findings.length + ' problem(s)');
findings.forEach((f) => console.log('  ✗ ' + f));
process.exit(findings.length ? 1 : 0);
