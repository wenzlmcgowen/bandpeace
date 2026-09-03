/* engine.test.js — exercises board-backend/Code.gs offline.
 * Run: node tests/engine.test.js
 */
'use strict';

const { loadEngine } = require('./gas-harness');

const BOARD = 'pp' + 'B'.repeat(44);
const SHOWS = 'sh' + 'S'.repeat(44);
const WRONG = 'sh' + 'X'.repeat(44);

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

function fresh() { return loadEngine({ board: BOARD, shows: SHOWS }); }

/* ── the gate ──────────────────────────────────────────────────── */

check('no token gets the shrug', () => {
  const { call } = fresh();
  eq(call.get({ action: 'shows' }), { ok: false, error: 'nope' });
  eq(call.post({ action: 'show-add', title: 'x' }), { ok: false, error: 'nope' });
});

check('a wrong shows token gets the shrug, and says nothing else', () => {
  const { call } = fresh();
  eq(call.get({ token: WRONG, action: 'shows' }), { ok: false, error: 'nope' });
});

check('a board token cannot reach the shows API', () => {
  const { call } = fresh();
  const res = call.get({ token: BOARD, action: 'shows' });
  /* It falls through to the board, which has no 'shows' action. */
  eq(res.ok, false, 'ok');
  ok(!res.shows, 'no shows leaked to the board token');
});

check('a shows token cannot reach the board API', () => {
  const { call } = fresh();
  const res = call.get({ token: SHOWS, action: 'list' });
  ok(!res.tasks, 'no tasks leaked to the shows token');
  ok(Array.isArray(res.shows), 'shows token gets shows, not tasks');
});

check('the file as committed is inert — the placeholders can never validate', () => {
  /* Loading with the placeholders as the "tokens" reproduces the committed
     file byte for byte. Presenting those placeholders must still get nowhere,
     which is what makes it safe for this code to sit in a public repo. */
  const { call } = loadEngine({ board: '__PANDA_TOKEN__', shows: '__SHOWS_TOKEN__' });
  eq(call.get({ token: '__SHOWS_TOKEN__', action: 'shows' }), { ok: false, error: 'nope' }, 'shows');
  eq(call.get({ token: '__PANDA_TOKEN__', action: 'list' }), { ok: false, error: 'nope' }, 'board');
  eq(call.post({ token: '__SHOWS_TOKEN__', action: 'show-add', title: 'x' }),
     { ok: false, error: 'nope' }, 'no writes either');
});

check('the board still works exactly as before', () => {
  const { call } = fresh();
  const list = call.get({ token: BOARD, action: 'list' });
  eq(list.ok, true, 'board list ok');
  eq(list.team.map((m) => m.name), ['Wenzl', 'Jess'], 'seeded team');
  const add = call.post({ token: BOARD, action: 'add', title: 'Book the fog machine', owner: 'Jess' });
  eq(add.ok, true, 'board add ok');
  eq(add.task.id, 'PP-1', 'board id');
  eq(call.post({ token: BOARD, action: 'done', id: 'PP-1' }).task.status, 'done', 'board done');
});

check('board and shows live in different spreadsheets', () => {
  const { call, env } = fresh();
  call.post({ token: BOARD, action: 'add', title: 'a board task' });
  call.post({ token: SHOWS, action: 'show-add', title: 'a show', date: '2026-10-09' });
  const names = [...env._books.values()].map((b) => b.getName()).sort();
  eq(names, ['Psycho Panda Board (private)', 'Shows & Logistics (private)'], 'two books');
});

check('malformed json is refused before any token check', () => {
  const { call } = fresh();
  eq(call.postRaw('{nope'), { ok: false, error: 'bad json' });
});

/* ── shows ─────────────────────────────────────────────────────── */

function seeded() {
  const h = fresh();
  const show = h.call.post({
    token: SHOWS, action: 'show-add',
    title: 'Seaside wedding', venue: 'Bay Hotel', city: 'Port Town, CA',
    date: '2026-10-09', end_date: '', headline: 'DJ + sax'
  });
  return { ...h, showId: show.show.id };
}

check('adding a show returns it with an id and timestamps', () => {
  const { call } = fresh();
  const res = call.post({ token: SHOWS, action: 'show-add', title: 'First one', date: '2026-10-09' });
  eq(res.ok, true, 'ok');
  eq(res.show.id, 'SH-1', 'id');
  eq(res.show.status, 'confirmed', 'default status');
  eq(res.show.title, 'First one', 'title');
  ok(res.show.created && res.show.updated, 'stamped');
});

check('ids keep counting up', () => {
  const { call } = fresh();
  ['a', 'b', 'c'].forEach((t) => call.post({ token: SHOWS, action: 'show-add', title: t, date: '2026-01-01' }));
  eq(call.get({ token: SHOWS, action: 'shows' }).shows.map((s) => s.id), ['SH-1', 'SH-2', 'SH-3'], 'ids');
});

check('a show needs a title', () => {
  const { call } = fresh();
  eq(call.post({ token: SHOWS, action: 'show-add', title: '   ', date: '2026-10-09' }).error, 'title required');
});

check('sloppy dates are refused, empty ones allowed', () => {
  const { call } = fresh();
  eq(call.post({ token: SHOWS, action: 'show-add', title: 'x', date: '10/9/2026' }).error,
     'bad date (use YYYY-MM-DD)', 'us format');
  eq(call.post({ token: SHOWS, action: 'show-add', title: 'x', date: 'Oct 9' }).error,
     'bad date (use YYYY-MM-DD)', 'words');
  eq(call.post({ token: SHOWS, action: 'show-add', title: 'x', date: '2026-13-40' }).error,
     'bad date (use YYYY-MM-DD)', 'a date that is not on any calendar');
  eq(call.post({ token: SHOWS, action: 'show-add', title: 'x', date: '2026-02-30' }).error,
     'bad date (use YYYY-MM-DD)', 'february 30th');
  eq(call.post({ token: SHOWS, action: 'show-add', title: 'x', date: '2028-02-29' }).ok,
     true, 'but a real leap day is fine');
  eq(call.post({ token: SHOWS, action: 'show-add', title: 'x' }).ok, true, 'a show with no date yet is fine');
});

check('a bad status is refused', () => {
  const { call } = fresh();
  eq(call.post({ token: SHOWS, action: 'show-add', title: 'x', date: '2026-10-09', status: 'maybe' }).error,
     'bad status (confirmed, hold or cancelled)');
});

check('editing changes only what was sent', () => {
  const { call, showId } = seeded();
  const res = call.post({ token: SHOWS, action: 'show-edit', id: showId, fields: { status: 'hold' } });
  eq(res.ok, true, 'ok');
  eq(res.show.status, 'hold', 'status changed');
  eq(res.show.title, 'Seaside wedding', 'title untouched');
  eq(res.show.venue, 'Bay Hotel', 'venue untouched');
});

check('a rejected edit leaves the row exactly as it was', () => {
  const { call, showId } = seeded();
  const res = call.post({
    token: SHOWS, action: 'show-edit', id: showId,
    fields: { venue: 'Somewhere else', date: 'tomorrow' }
  });
  eq(res.ok, false, 'refused');
  const show = call.get({ token: SHOWS, action: 'shows' }).shows[0];
  eq(show.venue, 'Bay Hotel', 'the good field was NOT half-applied');
});

check('editing an unknown show says so', () => {
  const { call } = fresh();
  eq(call.post({ token: SHOWS, action: 'show-edit', id: 'SH-99', fields: { title: 'x' } }).error,
     'no show with id SH-99');
});

/* ── items ─────────────────────────────────────────────────────── */

check('an item has to belong to a real show', () => {
  const { call } = fresh();
  eq(call.post({ token: SHOWS, action: 'item-add', show_id: 'SH-9', tab: 'travel', title: 'AA 119' }).error,
     'no show with id SH-9');
});

check('a flight lands on the travel tab with its times as written', () => {
  const { call, showId } = seeded();
  const res = call.post({
    token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', kind: 'flight',
    title: 'AA 119', subtitle: 'LAX → LIH',
    start: '2026-10-08T09:21', end: '2026-10-08T12:25', confirmation: 'ABCDEF'
  });
  eq(res.ok, true, 'ok');
  eq(res.item.id, 'IT-1', 'id');
  eq(res.item.start, '2026-10-08T09:21', 'no timezone maths were done to it');
  eq(res.item.tab, 'travel', 'tab');
});

check('a space instead of a T is accepted (people type that)', () => {
  const { call, showId } = seeded();
  const res = call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'backstage',
                          kind: 'time', title: 'Doors', start: '2026-10-09 20:00' });
  eq(res.item.start, '2026-10-09T20:00');
});

check('a sloppy time is refused', () => {
  const { call, showId } = seeded();
  const bad = ['9:21 AM', '2026-10-08 9:21', '2026-10-08T09:21:00', 'Oct 8 9:21am',
               '2026-13-40', '2026-10-08T25:00', '2026-10-08T09:75'];
  bad.forEach((v) => {
    const res = call.post({ token: SHOWS, action: 'item-add', show_id: showId,
                            tab: 'travel', kind: 'flight', title: 'AA 119', start: v });
    eq(res.ok, false, 'refused "' + v + '"');
    eq(res.error, 'bad start (YYYY-MM-DD or YYYY-MM-DDTHH:MM)', 'error for "' + v + '"');
  });
  eq(call.post({ token: SHOWS, action: 'item-edit', id: 'IT-1', fields: { end: 'later' } }).ok, false,
     'and on edit too');
});

check('a lost id counter is rebuilt from the sheet, never reusing an id', () => {
  const { call, env, showId } = seeded();
  call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: 'one' });
  call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: 'two' });
  /* Google loses the script properties (or someone clears them) — the sheet
     is still the truth, so the next id must come after the highest one in it. */
  env._props.delete('ITEMS_LAST_ID');
  env._props.delete('SHOWS_LAST_ID');
  eq(call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'hotel', title: 'three' }).item.id,
     'IT-3', 'item id');
  eq(call.post({ token: SHOWS, action: 'show-add', title: 'next show', date: '2026-12-01' }).show.id,
     'SH-2', 'show id');
});

check('a made-up tab or kind is refused', () => {
  const { call, showId } = seeded();
  eq(call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'greenroom', title: 'x' }).error,
     'bad tab (travel, hotel or backstage)', 'tab');
  eq(call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', kind: 'teleport', title: 'x' }).error,
     'bad kind (flight, stay, ground, time, contact or note)', 'kind');
});

check('tab and kind are case-insensitive', () => {
  const { call, showId } = seeded();
  const res = call.post({ token: SHOWS, action: 'item-add', show_id: showId,
                          tab: 'Hotel', kind: 'Stay', title: 'The hotel' });
  eq(res.item.tab, 'hotel', 'tab');
  eq(res.item.kind, 'stay', 'kind');
});

check('kind defaults to a plain note', () => {
  const { call, showId } = seeded();
  eq(call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'backstage',
                 title: 'Parking is behind the venue' }).item.kind, 'note');
});

check('one payload carries every show and every item', () => {
  const { call, showId } = seeded();
  call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: 'AA 119' });
  call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'hotel', title: 'The hotel' });
  const payload = call.get({ token: SHOWS, action: 'shows' });
  eq(payload.shows.length, 1, 'shows');
  eq(payload.items.length, 2, 'items');
  ok(payload.generated, 'stamped');
});

check('deleting a show takes its logistics with it', () => {
  const { call, showId } = seeded();
  const other = call.post({ token: SHOWS, action: 'show-add', title: 'Another', date: '2026-11-01' }).show.id;
  call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: 'AA 119' });
  call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'hotel', title: 'The hotel' });
  call.post({ token: SHOWS, action: 'item-add', show_id: other, tab: 'travel', title: 'Keep me' });

  const res = call.post({ token: SHOWS, action: 'show-rm', id: showId });
  eq(res.items_removed, 2, 'items removed');

  const payload = call.get({ token: SHOWS, action: 'shows' });
  eq(payload.shows.map((s) => s.id), [other], 'the other show survives');
  eq(payload.items.map((i) => i.title), ['Keep me'], 'and so does its item');
});

check('deleting the middle item leaves the rest readable', () => {
  const { call, showId } = seeded();
  ['one', 'two', 'three'].forEach((t) =>
    call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: t }));
  call.post({ token: SHOWS, action: 'item-rm', id: 'IT-2' });
  const items = call.get({ token: SHOWS, action: 'shows' }).items;
  eq(items.map((i) => i.title), ['one', 'three'], 'rows shifted up cleanly');
  eq(items.map((i) => i.id), ['IT-1', 'IT-3'], 'ids kept');
});

check('a new item after a deletion never reuses an id', () => {
  const { call, showId } = seeded();
  call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: 'one' });
  call.post({ token: SHOWS, action: 'item-rm', id: 'IT-1' });
  eq(call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: 'two' }).item.id, 'IT-2');
});

check('editing an item moves it between tabs', () => {
  const { call, showId } = seeded();
  const id = call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: 'Rental car' }).item.id;
  eq(call.post({ token: SHOWS, action: 'item-edit', id, fields: { tab: 'backstage' } }).item.tab, 'backstage');
});

check('an item cannot be moved to a show that does not exist', () => {
  const { call, showId } = seeded();
  const id = call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: 'x' }).item.id;
  eq(call.post({ token: SHOWS, action: 'item-edit', id, fields: { show_id: 'SH-42' } }).error, 'no show with id SH-42');
});

check('long text is capped, not rejected', () => {
  const { call, showId } = seeded();
  const huge = 'x'.repeat(20000);
  const res = call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'backstage',
                          title: 'Notes', details: huge });
  eq(res.ok, true, 'still accepted');
  eq(res.item.details.length, 5000, 'capped well under the 50k cell limit');
});

check('an unknown action is named, not silently ignored', () => {
  const { call } = fresh();
  eq(call.post({ token: SHOWS, action: 'burn-it-down' }).error, 'unknown action');
  eq(call.get({ token: SHOWS, action: 'burn-it-down' }).error, 'unknown action');
});

check('nothing deadlocks (no action takes the lock twice)', () => {
  const { call, env, showId } = seeded();
  call.post({ token: SHOWS, action: 'item-add', show_id: showId, tab: 'travel', title: 'x' });
  call.post({ token: SHOWS, action: 'item-edit', id: 'IT-1', fields: { title: 'y' } });
  call.post({ token: SHOWS, action: 'item-rm', id: 'IT-1' });
  call.post({ token: SHOWS, action: 'show-rm', id: showId });
  eq(env._lockDepth(), 0, 'every lock was released');
});

check('a date typed straight into the sheet still reads back as a date', () => {
  const { call, env, showId } = seeded();
  const book = [...env._books.values()].filter((b) => b.getName().indexOf('Shows') === 0)[0];
  book.getSheetByName('Shows').getRange(2, 5).setValue(new Date(Date.UTC(2026, 9, 9)));
  eq(call.get({ token: SHOWS, action: 'shows' }).shows[0].date, '2026-10-09');
});

/* ── report ────────────────────────────────────────────────────── */

console.log('\nengine: ' + passed + ' passed, ' + failures.length + ' failed');
failures.forEach((f) => console.log('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
