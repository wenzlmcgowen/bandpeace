/* gas-harness.js — run board-backend/Code.gs in plain Node.
 *
 * Apps Script has no local runtime, so the engine could only ever be tested
 * by deploying it to Google and poking the live thing. This file removes that:
 * it fakes just enough of Google's world (a spreadsheet that lives in memory,
 * script properties, the lock, the two Utilities helpers) for the REAL engine
 * source to run untouched, so every action can be exercised offline.
 *
 * The fakes are deliberately strict where Sheets is strict — getLastRow()
 * really is "last row holding anything", deleteRow() really shifts the rows
 * below up — because those are exactly the places a bug would hide.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CODE_PATH = path.join(__dirname, '..', 'board-backend', 'Code.gs');

/* ── a spreadsheet in memory ───────────────────────────────────── */

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setValues(values) {
    if (values.length !== this.numRows) throw new Error('setValues: wrong row count');
    for (let i = 0; i < this.numRows; i++) {
      if (values[i].length !== this.numCols) throw new Error('setValues: wrong column count');
      for (let j = 0; j < this.numCols; j++) {
        this.sheet._set(this.row + i, this.col + j, values[i][j]);
      }
    }
    return this;
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const row = [];
      for (let j = 0; j < this.numCols; j++) row.push(this.sheet._get(this.row + i, this.col + j));
      out.push(row);
    }
    return out;
  }
  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }
  getValue() { return this.sheet._get(this.row, this.col); }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.grid = new Map();   // "r,c" → value
    this.maxRows = 1000;
    this.frozen = 0;
  }
  setName(n) { this.name = n; return this; }
  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  setFrozenRows(n) { this.frozen = n; return this; }
  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows === undefined ? 1 : numRows,
                         numCols === undefined ? 1 : numCols);
  }
  _key(r, c) { return r + ',' + c; }
  _set(r, c, v) {
    if (v === '' || v === null || v === undefined) this.grid.delete(this._key(r, c));
    else this.grid.set(this._key(r, c), v);
  }
  _get(r, c) {
    const v = this.grid.get(this._key(r, c));
    return v === undefined ? '' : v;
  }
  getLastRow() {
    let last = 0;
    for (const key of this.grid.keys()) {
      const r = parseInt(key.split(',')[0], 10);
      if (r > last) last = r;
    }
    return last;
  }
  /* Real Sheets semantics: everything below shifts up by one. */
  deleteRow(row) {
    const next = new Map();
    for (const [key, v] of this.grid.entries()) {
      const [r, c] = key.split(',').map(Number);
      if (r === row) continue;
      next.set((r > row ? r - 1 : r) + ',' + c, v);
    }
    this.grid = next;
  }
}

class FakeSpreadsheet {
  constructor(name, id) {
    this.name = name;
    this.id = id;
    this.sheets = [new FakeSheet('Sheet1')];
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(n) { return this.sheets.filter((s) => s.getName() === n)[0] || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
}

/* ── the environment ───────────────────────────────────────────── */

function makeEnv(opts) {
  opts = opts || {};
  const books = new Map();
  let seq = 0;

  const SpreadsheetApp = {
    create(name) {
      const id = 'ss-' + (++seq);
      const ss = new FakeSpreadsheet(name, id);
      books.set(id, ss);
      return ss;
    },
    openById(id) {
      const ss = books.get(id);
      if (!ss) throw new Error('no such spreadsheet: ' + id);
      return ss;
    }
  };

  const store = new Map();
  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty: (k) => (store.has(k) ? store.get(k) : null),
        setProperty: (k, v) => { store.set(k, String(v)); }
      };
    }
  };

  let held = 0;
  const LockService = {
    getScriptLock() {
      return {
        waitLock() {
          held++;
          if (held > 1) throw new Error('lock is not reentrant — the engine deadlocked itself');
        },
        releaseLock() { held--; }
      };
    }
  };

  const Utilities = {
    /* Only the two patterns the engine actually asks for. */
    formatDate(date, tz, fmt) {
      const p = (n) => String(n).padStart(2, '0');
      const y = date.getUTCFullYear(), mo = p(date.getUTCMonth() + 1), d = p(date.getUTCDate());
      if (fmt === 'yyyy-MM-dd') return `${y}-${mo}-${d}`;
      return `${y}-${mo}-${d}T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}+00:00`;
    }
  };

  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput(text) {
      return { text, setMimeType() { return this; }, getContent() { return this.text; } };
    }
  };

  return { SpreadsheetApp, PropertiesService, LockService, Utilities, ContentService,
           _books: books, _props: store, _lockDepth: () => held };
}

/* ── load the engine ───────────────────────────────────────────── */

function loadEngine(tokens) {
  const raw = fs.readFileSync(CODE_PATH, 'utf8');
  const src = raw
    .replace(/__PANDA_TOKEN__/g, tokens.board)
    .replace(/__SHOWS_TOKEN__/g, tokens.shows)
    /* injected raw, exactly as setup-board.command does it */
    .replace(/__PANDA_TEAM__/g, JSON.stringify([['Wenzl', '🎷', 'yes'], ['Jess', '✨', 'yes']]));

  const env = makeEnv();
  const factory = new Function(
    'SpreadsheetApp', 'PropertiesService', 'LockService', 'Utilities', 'ContentService',
    src + '\n;return { doGet: doGet, doPost: doPost };'
  );
  const api = factory(env.SpreadsheetApp, env.PropertiesService, env.LockService,
                      env.Utilities, env.ContentService);

  const call = {
    get(params) { return JSON.parse(api.doGet({ parameter: params }).getContent()); },
    post(body) {
      return JSON.parse(api.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
    },
    postRaw(raw) {
      return JSON.parse(api.doPost({ postData: { contents: raw } }).getContent());
    }
  };
  return { call, env };
}

module.exports = { loadEngine, makeEnv, FakeSheet, FakeSpreadsheet };
