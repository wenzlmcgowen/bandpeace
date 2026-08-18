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
