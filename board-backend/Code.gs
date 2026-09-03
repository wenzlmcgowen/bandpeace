/**
 * Psycho Panda Board Engine — Google Apps Script (V8)
 *
 * A tiny private web service that stores the Psycho Panda team board in a
 * private Google Sheet ("Psycho Panda Board (private)") in the deploying
 * user's account, and answers JSON to the hidden /hq/ page and the CLI.
 *
 * SECURITY NOTES
 * - The committed version of this file holds a PLACEHOLDER token
 *   ('__PANDA_TOKEN__'). The real token is injected into a TEMP COPY by
 *   setup-board.command at push time. The placeholder can never validate
 *   (it fails the token format check), so the committed code is inert.
 * - Every call must present the exact token. Anything else gets
 *   {"ok":false,"error":"nope"} — HTTP 200, no details, ever.
 * - The token is NEVER logged, NEVER echoed back, and NEVER included in
 *   error messages. There are deliberately no Logger/console calls here.
 *
 * API (all responses are JSON with HTTP 200, even errors):
 *   GET  <exec>?token=T&action=list
 *   POST <exec>  body = JSON sent as text/plain (read from e.postData.contents)
 *        {"token":T,"action":"add","title":"…","owner":"…","deadline":"…","priority":N,"details":"…","source":"…"}
 *        {"token":T,"action":"done","id":"PP-3"}
 *        {"token":T,"action":"reopen","id":"PP-3"}
 *        {"token":T,"action":"edit","id":"PP-3","fields":{...}}
 *
 * TWO REALMS, ONE ENGINE
 * - The board (token 'pp…')   → the Psycho Panda team board  → sheet "Psycho Panda Board (private)"
 * - Shows  (token 'sh…')      → the /shows/ logistics page    → sheet "Shows & Logistics (private)"
 *   The two tokens are different secrets and open different spreadsheets, so a
 *   leaked shows link can never reach the board (and vice versa). The shows API
 *   lives at the bottom of this file under "SHOWS REALM"; everything above it is
 *   the board and is untouched by it.
 */

const TOKEN = '__PANDA_TOKEN__';
const TOKEN_FORMAT = /^pp[A-Za-z0-9]{40,}$/;
const TZ = 'America/Los_Angeles';
const SPREADSHEET_NAME = 'Psycho Panda Board (private)';
const LOCK_WAIT_MS = 20000;

const TASK_HEADERS = ['id', 'title', 'details', 'owner', 'deadline', 'priority', 'status', 'created', 'updated', 'done_at', 'source', 'notes'];
const TEAM_HEADERS = ['name', 'emoji', 'active', 'photo'];
// The real roster is injected by setup-board.command from the private secrets
// file ('__PANDA_TEAM__' → a JSON array of [name, emoji, active] rows), so no
// real names live in this public repo. With the placeholder still in place we
// seed obviously-fake names.
var TEAM_SEED_RAW = '__PANDA_TEAM__';
var TEAM_SEED = (TEAM_SEED_RAW.indexOf('__') === 0)
  ? [['Alex', '🐼', 'yes'], ['Sam', '✨', 'yes']]
  : JSON.parse(TEAM_SEED_RAW);
const EDITABLE_FIELDS = ['deadline', 'priority', 'owner', 'title', 'details', 'notes'];
const DEADLINE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- entrypoints

function doGet(e) {
  return respond_(function () {
    var p = (e && e.parameter) || {};
    if (showsTokenOk_(p.token)) return showsGet_(p);
    if (!tokenOk_(p.token)) return nope_();
    var action = p.action || 'list';
    if (action === 'list') return listPayload_(getBoard_());
    return fail_('unknown action');
  });
}

function doPost(e) {
  return respond_(function () {
    var raw = (e && e.postData && e.postData.contents) || '';
    var body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (err) {
      return fail_('bad json');
    }
    if (!body || typeof body !== 'object') return fail_('bad json');
    if (showsTokenOk_(body.token)) return showsPost_(body);
    if (!tokenOk_(body.token)) return nope_();

    switch (body.action) {
      case 'add': return addTask_(body);
      case 'done': return setStatus_(body.id, 'done');
      case 'reopen': return setStatus_(body.id, 'open');
      case 'edit': return editTask_(body.id, body.fields);
      case 'team-set': return teamSet_(body);
      default: return fail_('unknown action');
    }
  });
}

// -------------------------------------------------------------- core plumbing

/** Run fn, always answer JSON with HTTP 200 — even when something throws. */
function respond_(fn) {
  var out;
  try {
    out = fn();
  } catch (err) {
    // err comes from Google internals (lock timeout, quota, etc.) —
    // it never contains the token, because we never put it anywhere.
    out = fail_('engine error: ' + ((err && err.message) ? err.message : 'unknown'));
  }
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function tokenOk_(t) {
  return typeof t === 'string' && TOKEN_FORMAT.test(t) && t === TOKEN;
}

function nope_() {
  return { ok: false, error: 'nope' };
}

function fail_(msg) {
  return { ok: false, error: msg };
}

function nowIso_() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** Acquire the one script lock (used for ALL writes and for bootstrap). */
function lock_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  return lock;
}

// ------------------------------------------------------------------ bootstrap

/**
 * Get the board spreadsheet, creating it on the first-ever valid call.
 * Creation happens under the script lock; the SHEET_ID is re-checked inside
 * the lock so two racing first calls can't create two spreadsheets.
 */
function getBoard_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var lock = lock_();
  try {
    return createBoardIfMissing_();
  } finally {
    lock.releaseLock();
  }
}

/** Caller MUST hold the script lock. Idempotent. */
function createBoardIfMissing_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  var ss = SpreadsheetApp.create(SPREADSHEET_NAME);

  var tasks = ss.getSheets()[0];
  tasks.setName('Tasks');
  // Plain-text format everywhere so ids, dates, and timestamps stay exactly
  // the strings we write (no silent date auto-conversion).
  tasks.getRange(1, 1, tasks.getMaxRows(), TASK_HEADERS.length).setNumberFormat('@');
  tasks.getRange(1, 1, 1, TASK_HEADERS.length).setValues([TASK_HEADERS]).setFontWeight('bold');
  tasks.setFrozenRows(1);

  var team = ss.insertSheet('Team');
  team.getRange(1, 1, team.getMaxRows(), TEAM_HEADERS.length).setNumberFormat('@');
  team.getRange(1, 1, 1, TEAM_HEADERS.length).setValues([TEAM_HEADERS]).setFontWeight('bold');
  team.setFrozenRows(1);
  var seed = TEAM_SEED.map(function (r) {
    return [r[0], r[1], r[2], r[3] || ''];   // pad to the photo column
  });
  team.getRange(2, 1, seed.length, TEAM_HEADERS.length).setValues(seed);

  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

/**
 * Next PP-N number — monotonically increasing, caller MUST hold the lock.
 * A LAST_ID counter in ScriptProperties keeps ids monotonic even if rows
 * are deleted from the sheet; if the counter is ever missing we recover it
 * from the highest id currently in the sheet.
 */
function nextId_(ss) {
  var props = PropertiesService.getScriptProperties();
  var last = parseInt(props.getProperty('LAST_ID') || '', 10);
  if (isNaN(last) || last < 0) {
    last = 0;
    var sheet = ss.getSheetByName('Tasks');
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        var m = String(ids[i][0]).match(/^PP-(\d+)$/);
        if (m) last = Math.max(last, parseInt(m[1], 10));
      }
    }
  }
  var next = last + 1;
  props.setProperty('LAST_ID', String(next));
  return next;
}

// ---------------------------------------------------------------- sheet <-> task

/** Convert one sheet row (array) into the task object the API returns. */
function rowToTask_(row) {
  var t = {};
  for (var i = 0; i < TASK_HEADERS.length; i++) {
    var key = TASK_HEADERS[i];
    var v = (i < row.length) ? row[i] : '';
    if (v === null || v === undefined || v === '') {
      t[key] = '';
    } else if (v instanceof Date) {
      // Defensive: someone typed straight into the sheet.
      t[key] = (key === 'deadline')
        ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd')
        : Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
    } else if (key === 'priority') {
      var n = Number(v);
      t[key] = isFinite(n) ? n : '';
    } else {
      t[key] = String(v);
    }
  }
  return t;
}

function taskToRow_(t) {
  return TASK_HEADERS.map(function (h) {
    return (t[h] === null || t[h] === undefined) ? '' : t[h];
  });
}

/** Write one task row at sheet row r (1-indexed), keeping plain-text format. */
function writeRow_(sheet, r, t) {
  var range = sheet.getRange(r, 1, 1, TASK_HEADERS.length);
  range.setNumberFormat('@');
  range.setValues([taskToRow_(t)]);
}

/** Find a task by id → { row: sheetRowNumber, task: {...} } or null. */
function findTask_(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var vals = sheet.getRange(2, 1, lastRow - 1, TASK_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === id) return { row: i + 2, task: rowToTask_(vals[i]) };
  }
  return null;
}

// -------------------------------------------------------------------- actions

/** Older sheets were born with 3 Team columns; quietly add the 4th. */
function ensureTeamPhotoCol_(teamSheet) {
  var d1 = String(teamSheet.getRange(1, 4).getValue()).trim();
  if (d1 !== 'photo') {
    teamSheet.getRange(1, 4).setNumberFormat('@').setValue('photo').setFontWeight('bold');
    teamSheet.getRange(1, 4, Math.max(teamSheet.getMaxRows(), 2), 1).setNumberFormat('@');
  }
}

function listPayload_(ss) {
  var team = [];
  var teamSheet = ss.getSheetByName('Team');
  ensureTeamPhotoCol_(teamSheet);
  var lastTeam = teamSheet.getLastRow();
  if (lastTeam >= 2) {
    var tv = teamSheet.getRange(2, 1, lastTeam - 1, TEAM_HEADERS.length).getValues();
    for (var i = 0; i < tv.length; i++) {
      var name = String(tv[i][0]).trim();
      var active = String(tv[i][2]).trim().toLowerCase();
      if (name && active === 'yes') {
        var member = { name: name, emoji: String(tv[i][1]).trim() };
        var photo = String(tv[i][3] || '').trim();
        if (photo) member.photo = photo;
        team.push(member);
      }
    }
  }

  var tasks = [];
  var taskSheet = ss.getSheetByName('Tasks');
  var lastTask = taskSheet.getLastRow();
  if (lastTask >= 2) {
    var rows = taskSheet.getRange(2, 1, lastTask - 1, TASK_HEADERS.length).getValues();
    for (var j = 0; j < rows.length; j++) {
      var t = rowToTask_(rows[j]);
      if (t.id) tasks.push(t); // skip blank rows
    }
  }

  return { ok: true, team: team, tasks: tasks, generated: nowIso_() };
}

/**
 * Upsert a Team row by name (case-insensitive): emoji / photo / active are
 * each optional and only touched when present in the body. photo accepts an
 * https URL or a data:image/… URI (≤ 45k chars — sheet cells cap at 50k),
 * or '' to clear.
 */
function teamSet_(body) {
  var name = (typeof body.name === 'string') ? body.name.trim() : '';
  if (!name) return fail_('name required');

  var photo = null;
  if ('photo' in body) {
    photo = (typeof body.photo === 'string') ? body.photo.trim() : '';
    var okPhoto = photo === '' ||
      /^https:\/\/[^\s"]+$/.test(photo) ||
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo);
    if (!okPhoto || photo.length > 45000) return fail_('bad photo (https url or small data uri)');
  }
  var emoji = ('emoji' in body) ? String(body.emoji || '').trim() : null;
  var active = null;
  if ('active' in body) {
    active = String(body.active || '').trim().toLowerCase();
    if (active !== 'yes' && active !== 'no') return fail_("bad active (yes or no)");
  }

  var lock = lock_();
  try {
    var ss = createBoardIfMissing_();
    var sheet = ss.getSheetByName('Team');
    ensureTeamPhotoCol_(sheet);

    var row = 0;
    var last = sheet.getLastRow();
    if (last >= 2) {
      var names = sheet.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < names.length; i++) {
        if (String(names[i][0]).trim().toLowerCase() === name.toLowerCase()) { row = i + 2; break; }
      }
    }
    if (!row) {
      row = last + 1;
      sheet.getRange(row, 1, 1, TEAM_HEADERS.length).setNumberFormat('@');
      sheet.getRange(row, 1).setValue(name);
      if (active === null) active = 'yes';
      if (emoji === null) emoji = '🐼';
    }
    if (emoji !== null) sheet.getRange(row, 2).setValue(emoji);
    if (active !== null) sheet.getRange(row, 3).setValue(active);
    if (photo !== null) sheet.getRange(row, 4).setValue(photo);

    var v = sheet.getRange(row, 1, 1, TEAM_HEADERS.length).getValues()[0];
    return { ok: true, member: { name: String(v[0]).trim(), emoji: String(v[1]).trim(), active: String(v[2]).trim(), photo: String(v[3] || '').trim() } };
  } finally {
    lock.releaseLock();
  }
}

function addTask_(body) {
  var title = (typeof body.title === 'string') ? body.title.trim() : '';
  if (!title) return fail_('title required');

  var deadline = cleanDeadline_(body.deadline);
  if (deadline === null) return fail_('bad deadline (use YYYY-MM-DD)');
  var priority = cleanPriority_(body.priority);
  if (priority === null) return fail_('bad priority (whole number 0 or more)');

  var owner = (typeof body.owner === 'string' && body.owner.trim()) ? body.owner.trim() : 'Team';
  var details = (typeof body.details === 'string') ? body.details : '';
  var source = (typeof body.source === 'string') ? body.source.trim() : '';
  // Everything else in body is deliberately ignored.

  var lock = lock_();
  try {
    var ss = createBoardIfMissing_();
    var sheet = ss.getSheetByName('Tasks');
    var now = nowIso_();
    var t = {
      id: 'PP-' + nextId_(ss),
      title: title,
      details: details,
      owner: owner,
      deadline: deadline,
      priority: priority,
      status: 'open',
      created: now,
      updated: now,
      done_at: '',
      source: source,
      notes: ''
    };
    writeRow_(sheet, sheet.getLastRow() + 1, t);
    return { ok: true, task: t };
  } finally {
    lock.releaseLock();
  }
}

function setStatus_(id, status) {
  if (typeof id !== 'string' || !id.trim()) return fail_('missing id');
  id = id.trim();
  var lock = lock_();
  try {
    var ss = createBoardIfMissing_();
    var sheet = ss.getSheetByName('Tasks');
    var hit = findTask_(sheet, id);
    if (!hit) return fail_('no task with id ' + id);
    var now = nowIso_();
    hit.task.status = status;
    hit.task.updated = now;
    hit.task.done_at = (status === 'done') ? now : '';
    writeRow_(sheet, hit.row, hit.task);
    return { ok: true, task: hit.task };
  } finally {
    lock.releaseLock();
  }
}

function editTask_(id, fields) {
  if (typeof id !== 'string' || !id.trim()) return fail_('missing id');
  id = id.trim();
  if (!fields || typeof fields !== 'object') return fail_('missing fields');

  // Validate before touching the sheet. Only the 6 editable fields are
  // applied; anything else in `fields` is ignored.
  if (Object.prototype.hasOwnProperty.call(fields, 'deadline')) {
    if (cleanDeadline_(fields.deadline) === null) return fail_('bad deadline (use YYYY-MM-DD)');
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'priority')) {
    if (cleanPriority_(fields.priority) === null) return fail_('bad priority (whole number 0 or more)');
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'title')) {
    if (typeof fields.title !== 'string' || !fields.title.trim()) return fail_('title cannot be empty');
  }

  var lock = lock_();
  try {
    var ss = createBoardIfMissing_();
    var sheet = ss.getSheetByName('Tasks');
    var hit = findTask_(sheet, id);
    if (!hit) return fail_('no task with id ' + id);

    for (var i = 0; i < EDITABLE_FIELDS.length; i++) {
      var key = EDITABLE_FIELDS[i];
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      var v = fields[key];
      if (key === 'deadline') {
        hit.task.deadline = cleanDeadline_(v);
      } else if (key === 'priority') {
        hit.task.priority = cleanPriority_(v);
      } else if (key === 'title') {
        hit.task.title = String(v).trim();
      } else {
        hit.task[key] = (v === null || v === undefined) ? '' : String(v);
      }
    }
    hit.task.updated = nowIso_();
    writeRow_(sheet, hit.row, hit.task);
    return { ok: true, task: hit.task };
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------- validation

/** '' or missing → '' · 'YYYY-MM-DD' → itself · anything else → null (bad). */
function cleanDeadline_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string' && DEADLINE_FORMAT.test(v.trim())) return v.trim();
  return null;
}

/** '' or missing → '' · integer ≥ 0 (number or numeric string) → number · else null. */
function cleanPriority_(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(v);
  if (isFinite(n) && Math.floor(n) === n && n >= 0) return n;
  return null;
}

// =====================================================================
//  SHOWS REALM — the /shows/ page's engine
// =====================================================================
//
//  Everything below this line is a second, independent little service that
//  happens to share this script (so there is only ever ONE thing to deploy
//  and ONE Google "Allow" to click). It shares nothing else with the board:
//
//    · a different secret ('sh…' instead of 'pp…')
//    · a different spreadsheet ("Shows & Logistics (private)")
//    · different actions, ids and validation
//
//  A leaked shows link therefore cannot open the board, and a leaked board
//  link cannot open the shows. The committed token below is a placeholder
//  that can never pass the format check, so this half is inert in the repo
//  exactly like the board half is.
//
//  Shape of the data:
//    Shows  — one row per show     (id SH-n)
//    Items  — one row per logistics entry (id IT-n), each pinned to a show
//             and to one of the three tabs: travel · hotel · backstage
//
//  API (token must be the shows token):
//    GET  <exec>?token=T&action=shows
//    POST {"token":T,"action":"show-add","title":"…","date":"YYYY-MM-DD", …}
//         {"token":T,"action":"show-edit","id":"SH-1","fields":{…}}
//         {"token":T,"action":"show-rm","id":"SH-1"}            (also drops its items)
//         {"token":T,"action":"item-add","show_id":"SH-1","tab":"travel", …}
//         {"token":T,"action":"item-edit","id":"IT-4","fields":{…}}
//         {"token":T,"action":"item-rm","id":"IT-4"}

const SHOWS_TOKEN = '__SHOWS_TOKEN__';
const SHOWS_TOKEN_FORMAT = /^sh[A-Za-z0-9]{40,}$/;
const SHOWS_SPREADSHEET_NAME = 'Shows & Logistics (private)';

const SHOW_HEADERS = ['id', 'title', 'venue', 'city', 'date', 'end_date',
                      'status', 'headline', 'notes', 'created', 'updated'];
const ITEM_HEADERS = ['id', 'show_id', 'tab', 'kind', 'title', 'subtitle',
                      'start', 'end', 'place', 'confirmation', 'phone', 'link',
                      'details', 'sort', 'created', 'updated'];

const SHOW_EDITABLE = ['title', 'venue', 'city', 'date', 'end_date', 'status', 'headline', 'notes'];
const ITEM_EDITABLE = ['show_id', 'tab', 'kind', 'title', 'subtitle', 'start', 'end',
                       'place', 'confirmation', 'phone', 'link', 'details', 'sort'];

const SHOW_TABS = ['travel', 'hotel', 'backstage'];
const ITEM_KINDS = ['flight', 'stay', 'ground', 'time', 'contact', 'note'];
const SHOW_STATUSES = ['confirmed', 'hold', 'cancelled'];

const DATE_ONLY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const SHOW_DATE_KEYS = { date: 1, end_date: 1 };
const ITEM_DATE_KEYS = { start: 1, end: 1 };

const MAX_SHORT = 300;     // titles, places, confirmations…
const MAX_LONG = 5000;     // notes and details

function showsTokenOk_(t) {
  return typeof t === 'string' && SHOWS_TOKEN_FORMAT.test(t) && t === SHOWS_TOKEN;
}

// ------------------------------------------------------------ entry points

function showsGet_(p) {
  var action = p.action || 'shows';
  if (action === 'shows' || action === 'list') return showsPayload_(getShowsBook_());
  return fail_('unknown action');
}

function showsPost_(body) {
  switch (body.action) {
    case 'shows': return showsPayload_(getShowsBook_());
    case 'show-add': return showAdd_(body);
    case 'show-edit': return showEdit_(body.id, body.fields);
    case 'show-rm': return showRm_(body.id);
    case 'item-add': return itemAdd_(body);
    case 'item-edit': return itemEdit_(body.id, body.fields);
    case 'item-rm': return itemRm_(body.id);
    default: return fail_('unknown action');
  }
}

// ---------------------------------------------------------------- bootstrap

/** The shows spreadsheet, created on the first-ever valid shows call. */
function getShowsBook_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHOWS_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var lock = lock_();
  try {
    return createShowsIfMissing_();
  } finally {
    lock.releaseLock();
  }
}

/** Caller MUST hold the script lock. Idempotent. */
function createShowsIfMissing_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHOWS_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  var ss = SpreadsheetApp.create(SHOWS_SPREADSHEET_NAME);

  var shows = ss.getSheets()[0];
  shows.setName('Shows');
  initTab_(shows, SHOW_HEADERS);

  var items = ss.insertSheet('Items');
  initTab_(items, ITEM_HEADERS);

  props.setProperty('SHOWS_SHEET_ID', ss.getId());
  return ss;
}

/** Plain-text everywhere (so 2026-10-08 stays a string), bold frozen header. */
function initTab_(sheet, headers) {
  sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/**
 * Next id number for a counter, e.g. nextSeq_(ss, 'SHOWS_LAST_ID', 'Shows', 'SH').
 * Caller MUST hold the lock. Recovers from the sheet if the counter is lost,
 * so ids stay unique even after hand-deleting rows.
 */
function nextSeq_(ss, propKey, tabName, prefix) {
  var props = PropertiesService.getScriptProperties();
  var last = parseInt(props.getProperty(propKey) || '', 10);
  if (isNaN(last) || last < 0) {
    last = 0;
    var sheet = ss.getSheetByName(tabName);
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      var re = new RegExp('^' + prefix + '-(\\d+)$');
      for (var i = 0; i < ids.length; i++) {
        var m = String(ids[i][0]).match(re);
        if (m) last = Math.max(last, parseInt(m[1], 10));
      }
    }
  }
  var next = last + 1;
  props.setProperty(propKey, String(next));
  return prefix + '-' + next;
}

// ------------------------------------------------------------- sheet <-> obj

/** One sheet row → the object the API returns. Dates are defensive only. */
function rowToObj_(headers, row, dateKeys) {
  var o = {};
  for (var i = 0; i < headers.length; i++) {
    var key = headers[i];
    var v = (i < row.length) ? row[i] : '';
    if (v === null || v === undefined || v === '') {
      o[key] = '';
    } else if (v instanceof Date) {
      // Someone typed straight into the sheet and Sheets ate the string.
      o[key] = dateKeys[key]
        ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd')
        : Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
    } else {
      o[key] = String(v);
    }
  }
  return o;
}

function objToRow_(headers, o) {
  return headers.map(function (h) {
    return (o[h] === null || o[h] === undefined) ? '' : o[h];
  });
}

function writeObjRow_(sheet, headers, r, o) {
  var range = sheet.getRange(r, 1, 1, headers.length);
  range.setNumberFormat('@');
  range.setValues([objToRow_(headers, o)]);
}

/** All rows of a tab as objects (blank-id rows skipped). */
function readAll_(sheet, headers, dateKeys) {
  var out = [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (var i = 0; i < rows.length; i++) {
    var o = rowToObj_(headers, rows[i], dateKeys);
    if (o.id) out.push(o);
  }
  return out;
}

/** Find by id → { row, obj } or null. */
function findById_(sheet, headers, dateKeys, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var vals = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === id) {
      return { row: i + 2, obj: rowToObj_(headers, vals[i], dateKeys) };
    }
  }
  return null;
}

// ----------------------------------------------------------------- payload

function showsPayload_(ss) {
  return {
    ok: true,
    shows: readAll_(ss.getSheetByName('Shows'), SHOW_HEADERS, SHOW_DATE_KEYS),
    items: readAll_(ss.getSheetByName('Items'), ITEM_HEADERS, ITEM_DATE_KEYS),
    generated: nowIso_()
  };
}

// -------------------------------------------------------------- validation

/**
 * True only for a date that exists on a calendar. The shape check alone lets
 * '2026-13-40' through, and a typo like that would quietly render as a show
 * that never happens — so the day is round-tripped through Date and compared.
 */
function realDay_(s) {
  var y = +s.slice(0, 4), mo = +s.slice(5, 7), d = +s.slice(8, 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  var probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function realClock_(s) {
  var h = +s.slice(11, 13), mi = +s.slice(14, 16);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

/** '' → '' · a real 'YYYY-MM-DD' → itself · anything else → null (bad). */
function cleanDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  var s = String(v).trim();
  return (DATE_ONLY_FORMAT.test(s) && realDay_(s)) ? s : null;
}

/** '' → '' · a real 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' → itself · else null.
    No timezone conversion, ever: a flight time is written the way the
    ticket says it, in the time of the place it happens. */
function cleanWhen_(v) {
  if (v === null || v === undefined || v === '') return '';
  var s = String(v).trim().replace(' ', 'T');
  if (DATE_ONLY_FORMAT.test(s) && realDay_(s)) return s;
  if (DATE_TIME_FORMAT.test(s) && realDay_(s) && realClock_(s)) return s;
  return null;
}

/** '' → fallback · a listed value (case-insensitive) → it · else null. */
function cleanEnum_(v, allowed, fallback) {
  if (v === null || v === undefined || String(v).trim() === '') return fallback;
  var s = String(v).trim().toLowerCase();
  return allowed.indexOf(s) >= 0 ? s : null;
}

/** Trim + cap a free-text field. Non-strings become ''. */
function cleanText_(v, max) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (s.length > max) s = s.slice(0, max);
  return s;
}

/** '' → '' · a number (or numeric string) → number · else null. */
function cleanSort_(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(v);
  return isFinite(n) ? n : null;
}

// ------------------------------------------------------------- show actions

function showAdd_(body) {
  var title = cleanText_(body.title, MAX_SHORT).trim();
  if (!title) return fail_('title required');

  var date = cleanDate_(body.date);
  if (date === null) return fail_('bad date (use YYYY-MM-DD)');
  var endDate = cleanDate_(body.end_date);
  if (endDate === null) return fail_('bad end_date (use YYYY-MM-DD)');
  var status = cleanEnum_(body.status, SHOW_STATUSES, 'confirmed');
  if (status === null) return fail_('bad status (confirmed, hold or cancelled)');

  var lock = lock_();
  try {
    var ss = createShowsIfMissing_();
    var sheet = ss.getSheetByName('Shows');
    var now = nowIso_();
    var show = {
      id: nextSeq_(ss, 'SHOWS_LAST_ID', 'Shows', 'SH'),
      title: title,
      venue: cleanText_(body.venue, MAX_SHORT).trim(),
      city: cleanText_(body.city, MAX_SHORT).trim(),
      date: date,
      end_date: endDate,
      status: status,
      headline: cleanText_(body.headline, MAX_SHORT).trim(),
      notes: cleanText_(body.notes, MAX_LONG),
      created: now,
      updated: now
    };
    writeObjRow_(sheet, SHOW_HEADERS, sheet.getLastRow() + 1, show);
    return { ok: true, show: show };
  } finally {
    lock.releaseLock();
  }
}

function showEdit_(id, fields) {
  if (typeof id !== 'string' || !id.trim()) return fail_('missing id');
  id = id.trim();
  if (!fields || typeof fields !== 'object') return fail_('missing fields');

  // Validate everything BEFORE touching the sheet — a bad field must not
  // leave a half-written row behind.
  var clean = {};
  for (var i = 0; i < SHOW_EDITABLE.length; i++) {
    var key = SHOW_EDITABLE[i];
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    var v = fields[key];
    if (key === 'date' || key === 'end_date') {
      var d = cleanDate_(v);
      if (d === null) return fail_('bad ' + key + ' (use YYYY-MM-DD)');
      clean[key] = d;
    } else if (key === 'status') {
      var st = cleanEnum_(v, SHOW_STATUSES, 'confirmed');
      if (st === null) return fail_('bad status (confirmed, hold or cancelled)');
      clean[key] = st;
    } else if (key === 'title') {
      var t = cleanText_(v, MAX_SHORT).trim();
      if (!t) return fail_('title cannot be empty');
      clean[key] = t;
    } else if (key === 'notes') {
      clean[key] = cleanText_(v, MAX_LONG);
    } else {
      clean[key] = cleanText_(v, MAX_SHORT).trim();
    }
  }

  var lock = lock_();
  try {
    var ss = createShowsIfMissing_();
    var sheet = ss.getSheetByName('Shows');
    var hit = findById_(sheet, SHOW_HEADERS, SHOW_DATE_KEYS, id);
    if (!hit) return fail_('no show with id ' + id);
    for (var k in clean) {
      if (Object.prototype.hasOwnProperty.call(clean, k)) hit.obj[k] = clean[k];
    }
    hit.obj.updated = nowIso_();
    writeObjRow_(sheet, SHOW_HEADERS, hit.row, hit.obj);
    return { ok: true, show: hit.obj };
  } finally {
    lock.releaseLock();
  }
}

/** Removing a show removes its logistics too — no orphan items, ever. */
function showRm_(id) {
  if (typeof id !== 'string' || !id.trim()) return fail_('missing id');
  id = id.trim();
  var lock = lock_();
  try {
    var ss = createShowsIfMissing_();
    var showSheet = ss.getSheetByName('Shows');
    var hit = findById_(showSheet, SHOW_HEADERS, SHOW_DATE_KEYS, id);
    if (!hit) return fail_('no show with id ' + id);

    var itemSheet = ss.getSheetByName('Items');
    var removed = 0;
    var lastRow = itemSheet.getLastRow();
    if (lastRow >= 2) {
      var vals = itemSheet.getRange(2, 1, lastRow - 1, ITEM_HEADERS.length).getValues();
      // Bottom-up so earlier row numbers stay valid as we delete.
      for (var i = vals.length - 1; i >= 0; i--) {
        if (String(vals[i][1]).trim() === id) {
          itemSheet.deleteRow(i + 2);
          removed++;
        }
      }
    }
    showSheet.deleteRow(hit.row);
    return { ok: true, removed: id, items_removed: removed };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------- item actions

function itemAdd_(body) {
  var showId = (typeof body.show_id === 'string') ? body.show_id.trim() : '';
  if (!showId) return fail_('show_id required');

  var tab = cleanEnum_(body.tab, SHOW_TABS, null);
  if (tab === null) return fail_('bad tab (travel, hotel or backstage)');
  var kind = cleanEnum_(body.kind, ITEM_KINDS, 'note');
  if (kind === null) return fail_('bad kind (flight, stay, ground, time, contact or note)');

  var title = cleanText_(body.title, MAX_SHORT).trim();
  if (!title) return fail_('title required');

  var start = cleanWhen_(body.start);
  if (start === null) return fail_('bad start (YYYY-MM-DD or YYYY-MM-DDTHH:MM)');
  var end = cleanWhen_(body.end);
  if (end === null) return fail_('bad end (YYYY-MM-DD or YYYY-MM-DDTHH:MM)');
  var sort = cleanSort_(body.sort);
  if (sort === null) return fail_('bad sort (a number)');

  var lock = lock_();
  try {
    var ss = createShowsIfMissing_();
    if (!findById_(ss.getSheetByName('Shows'), SHOW_HEADERS, SHOW_DATE_KEYS, showId)) {
      return fail_('no show with id ' + showId);
    }
    var sheet = ss.getSheetByName('Items');
    var now = nowIso_();
    var item = {
      id: nextSeq_(ss, 'ITEMS_LAST_ID', 'Items', 'IT'),
      show_id: showId,
      tab: tab,
      kind: kind,
      title: title,
      subtitle: cleanText_(body.subtitle, MAX_SHORT).trim(),
      start: start,
      end: end,
      place: cleanText_(body.place, MAX_SHORT).trim(),
      confirmation: cleanText_(body.confirmation, MAX_SHORT).trim(),
      phone: cleanText_(body.phone, MAX_SHORT).trim(),
      link: cleanText_(body.link, MAX_SHORT).trim(),
      details: cleanText_(body.details, MAX_LONG),
      sort: sort,
      created: now,
      updated: now
    };
    writeObjRow_(sheet, ITEM_HEADERS, sheet.getLastRow() + 1, item);
    return { ok: true, item: item };
  } finally {
    lock.releaseLock();
  }
}

function itemEdit_(id, fields) {
  if (typeof id !== 'string' || !id.trim()) return fail_('missing id');
  id = id.trim();
  if (!fields || typeof fields !== 'object') return fail_('missing fields');

  var clean = {};
  for (var i = 0; i < ITEM_EDITABLE.length; i++) {
    var key = ITEM_EDITABLE[i];
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    var v = fields[key];
    if (key === 'tab') {
      var tab = cleanEnum_(v, SHOW_TABS, null);
      if (tab === null) return fail_('bad tab (travel, hotel or backstage)');
      clean[key] = tab;
    } else if (key === 'kind') {
      var kind = cleanEnum_(v, ITEM_KINDS, null);
      if (kind === null) return fail_('bad kind (flight, stay, ground, time, contact or note)');
      clean[key] = kind;
    } else if (key === 'start' || key === 'end') {
      var w = cleanWhen_(v);
      if (w === null) return fail_('bad ' + key + ' (YYYY-MM-DD or YYYY-MM-DDTHH:MM)');
      clean[key] = w;
    } else if (key === 'sort') {
      var s = cleanSort_(v);
      if (s === null) return fail_('bad sort (a number)');
      clean[key] = s;
    } else if (key === 'title') {
      var t = cleanText_(v, MAX_SHORT).trim();
      if (!t) return fail_('title cannot be empty');
      clean[key] = t;
    } else if (key === 'details') {
      clean[key] = cleanText_(v, MAX_LONG);
    } else if (key === 'show_id') {
      var sid = cleanText_(v, MAX_SHORT).trim();
      if (!sid) return fail_('show_id cannot be empty');
      clean[key] = sid;
    } else {
      clean[key] = cleanText_(v, MAX_SHORT).trim();
    }
  }

  var lock = lock_();
  try {
    var ss = createShowsIfMissing_();
    if (clean.show_id &&
        !findById_(ss.getSheetByName('Shows'), SHOW_HEADERS, SHOW_DATE_KEYS, clean.show_id)) {
      return fail_('no show with id ' + clean.show_id);
    }
    var sheet = ss.getSheetByName('Items');
    var hit = findById_(sheet, ITEM_HEADERS, ITEM_DATE_KEYS, id);
    if (!hit) return fail_('no item with id ' + id);
    for (var k in clean) {
      if (Object.prototype.hasOwnProperty.call(clean, k)) hit.obj[k] = clean[k];
    }
    hit.obj.updated = nowIso_();
    writeObjRow_(sheet, ITEM_HEADERS, hit.row, hit.obj);
    return { ok: true, item: hit.obj };
  } finally {
    lock.releaseLock();
  }
}

function itemRm_(id) {
  if (typeof id !== 'string' || !id.trim()) return fail_('missing id');
  id = id.trim();
  var lock = lock_();
  try {
    var ss = createShowsIfMissing_();
    var sheet = ss.getSheetByName('Items');
    var hit = findById_(sheet, ITEM_HEADERS, ITEM_DATE_KEYS, id);
    if (!hit) return fail_('no item with id ' + id);
    sheet.deleteRow(hit.row);
    return { ok: true, removed: id };
  } finally {
    lock.releaseLock();
  }
}
