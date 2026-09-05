/* shows-ui.test.js — the pure helpers behind site/shows/shows.js.
 * Run: node tests/shows-ui.test.js
 */
'use strict';

const S = require('../site/shows/shows.js');

const KEY = 'sh' + 'k'.repeat(44);
const NOW = new Date('2026-10-01T12:00:00-07:00');   // a Thursday in LA

/* A throwaway password's key, computed once with Python. Never the real one. */
const KNOWN_VECTOR =
  'shd2c4f90d65d851fd84e458243175153224b6688a3137c0aaca8be474c398dde1';

let passed = 0;
const failures = [];
const pending = [];

/* A check may return a promise (the key stretching is async in both worlds);
   those are gathered and waited for before anything is reported. */
function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(
        () => { passed++; },
        (err) => { failures.push(name + ' — ' + (err && err.message)); }
      ));
    } else {
      passed++;
    }
  } catch (err) { failures.push(name + ' — ' + err.message); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((what || 'value') + ': got ' + a + ', wanted ' + b);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected true'); }

/* ── the link ──────────────────────────────────────────────────── */

check('a bare key opens the list', () => {
  eq(S.parseFragment('#' + KEY), { demo: false, token: KEY, showId: null, tab: null });
});

check('a key plus a show opens that show', () => {
  eq(S.parseFragment('#' + KEY + '/SH-2'),
     { demo: false, token: KEY, showId: 'SH-2', tab: null });
});

check('a key plus a show plus a tab opens that tab', () => {
  eq(S.parseFragment('#' + KEY + '/SH-2/hotel'),
     { demo: false, token: KEY, showId: 'SH-2', tab: 'hotel' });
});

check('show ids and tabs are case-forgiving', () => {
  eq(S.parseFragment('#' + KEY + '/sh-2/HOTEL').showId, 'SH-2', 'id');
  eq(S.parseFragment('#' + KEY + '/sh-2/HOTEL').tab, 'hotel', 'tab');
});

check('demo needs no key', () => {
  eq(S.parseFragment('#demo'), { demo: true, token: null, showId: null, tab: null });
  eq(S.parseFragment('#demo/SH-1/backstage').showId, 'SH-1');
});

check('an empty hash asks for nothing in particular', () => {
  /* Not "locked" — just no instructions. Whether anything shows depends on
     whether this device already knows the key. */
  ['', '#'].forEach((h) => {
    eq(S.parseFragment(h), { demo: false, token: null, showId: null, tab: null },
       'for ' + JSON.stringify(h));
  });
});

check('rubbish and short keys get nothing', () => {
  ['#hello', '#pp' + 'x'.repeat(44), '#sh' + 'x'.repeat(10),
   '#' + KEY + '/SH-2/hotel/extra', '#' + KEY + '/nope', '#' + KEY + '/SH-2/kitchen',
   '#' + KEY + '/SH-x', '#SH-2/kitchen', '#/', '#//'].forEach((h) => {
    eq(S.parseFragment(h), null, 'for ' + JSON.stringify(h));
  });
});

check('a signed-in link carries no key at all', () => {
  /* Once the password is typed, the device remembers the key and the address
     bar stops carrying it — this is what those links look like. */
  eq(S.parseFragment('#SH-2'), { demo: false, token: null, showId: 'SH-2', tab: null });
  eq(S.parseFragment('#SH-2/hotel'), { demo: false, token: null, showId: 'SH-2', tab: 'hotel' });
  eq(S.parseFragment('#sh-2/HOTEL').showId, 'SH-2', 'still case-forgiving');
});

check('a tab without a show is meaningless', () => {
  eq(S.parseFragment('#' + KEY + '//hotel'), null);
});

check('a board key cannot open the shows page', () => {
  eq(S.parseFragment('#pp' + 'B'.repeat(44)), null);
});

/* ── counting the days ─────────────────────────────────────────── */

check('the countdown speaks like a person', () => {
  const cases = [
    ['2026-10-01', 'today'], ['2026-10-02', 'tomorrow'], ['2026-10-04', 'in 3 days'],
    ['2026-10-13', 'in 12 days'], ['2026-10-16', 'in 2 weeks'], ['2026-12-01', 'in 2 months'],
    ['2026-09-30', 'yesterday'], ['2026-09-25', '6 days ago'], ['2026-08-01', '2 months ago']
  ];
  cases.forEach(([date, label]) => eq(S.dayInfo(date, NOW).label, label, date));
});

check('a show today is "soon" and not "past"', () => {
  const info = S.dayInfo('2026-10-01', NOW);
  eq(info.days, 0, 'days');
  eq(info.soon, true, 'soon');
  eq(info.past, false, 'past');
});

check('yesterday is past', () => {
  eq(S.dayInfo('2026-09-30', NOW).past, true);
});

check('no date at all is not a countdown', () => {
  eq(S.dayInfo('', NOW), null);
  eq(S.dayInfo('sometime', NOW), null);
});

/* ── ordering the shows ────────────────────────────────────────── */

const SHOWS = [
  { id: 'SH-1', date: '2026-12-01', title: 'December' },
  { id: 'SH-2', date: '2026-09-01', title: 'September (past)' },
  { id: 'SH-3', date: '2026-10-09', title: 'Next one' },
  { id: 'SH-4', date: '', title: 'No date yet' },
  { id: 'SH-5', date: '2026-08-01', title: 'August (past)' }
];

check('upcoming comes soonest-first, past comes newest-first', () => {
  const split = S.splitShows(SHOWS, NOW);
  eq(split.upcoming.map((s) => s.id), ['SH-3', 'SH-1', 'SH-4'], 'upcoming');
  eq(split.past.map((s) => s.id), ['SH-2', 'SH-5'], 'past');
});

check('a show still running today has not been played yet', () => {
  /* Started yesterday, ends tomorrow — it is very much still on. */
  const run = [{ id: 'SH-9', date: '2026-09-30', end_date: '2026-10-02' }];
  eq(S.splitShows(run, NOW).upcoming.map((s) => s.id), ['SH-9'], 'upcoming');
  eq(S.splitShows(run, NOW).past.length, 0, 'not past');
});

check('a show is past the day after it ends, not before', () => {
  eq(S.splitShows([{ id: 'A', date: '2026-10-01' }], NOW).upcoming.length, 1, 'today');
  eq(S.splitShows([{ id: 'A', date: '2026-09-30' }], NOW).past.length, 1, 'yesterday');
});

check('nothing at all does not explode', () => {
  eq(S.splitShows(null, NOW), { upcoming: [], past: [] });
  eq(S.tabCounts(null, 'SH-1'), { travel: 0, hotel: 0, backstage: 0 });
  eq(S.itemsFor(null, 'SH-1', 'travel'), []);
});

/* ── ordering the logistics ────────────────────────────────────── */

const ITEMS = [
  { id: 'IT-1', show_id: 'SH-1', tab: 'backstage', kind: 'time', title: 'Doors', start: '2026-10-09T20:00', sort: '' },
  { id: 'IT-2', show_id: 'SH-1', tab: 'backstage', kind: 'time', title: 'Load-in', start: '2026-10-09T16:00', sort: '' },
  { id: 'IT-3', show_id: 'SH-1', tab: 'travel', kind: 'flight', title: 'Out', start: '2026-10-08T09:21', sort: '' },
  { id: 'IT-4', show_id: 'SH-2', tab: 'travel', kind: 'flight', title: 'Other show', start: '2026-10-08T09:21', sort: '' },
  { id: 'IT-5', show_id: 'SH-1', tab: 'backstage', kind: 'note', title: 'Undated note', start: '', sort: '' }
];

check('a tab shows only its own show, in the order things happen', () => {
  eq(S.itemsFor(ITEMS, 'SH-1', 'backstage').map((i) => i.title),
     ['Load-in', 'Doors', 'Undated note']);
});

check('undated entries sink to the bottom, they do not vanish', () => {
  const items = S.itemsFor(ITEMS, 'SH-1', 'backstage');
  eq(items[items.length - 1].title, 'Undated note');
});

check('a hand-set sort wins over the clock', () => {
  const pinned = ITEMS.map((i) => (i.id === 'IT-1' ? Object.assign({}, i, { sort: 1 }) : i));
  eq(S.itemsFor(pinned, 'SH-1', 'backstage').map((i) => i.title),
     ['Doors', 'Load-in', 'Undated note']);
});

check('the chips count what each tab holds', () => {
  eq(S.tabCounts(ITEMS, 'SH-1'), { travel: 1, hotel: 0, backstage: 3 });
});

/* ── reading the details ───────────────────────────────────────── */

check('"Label: value" lines become rows, sentences stay sentences', () => {
  eq(S.parseDetails('Seat: 14C\nBring the sax stand, the venue has none'),
     [{ label: 'Seat', value: '14C' },
      { text: 'Bring the sax stand, the venue has none' }]);
});

check('a clock is not mistaken for a label', () => {
  /* Straight from real data: this rendered as the row "LAND 12 → 25 PM …". */
  eq(S.parseDetails('Land 12:25 PM on check-in day, fly out 1:55 PM on check-out day'),
     [{ text: 'Land 12:25 PM on check-in day, fly out 1:55 PM on check-out day' }]);
  eq(S.parseDetails('Doors 8:00 PM'), [{ text: 'Doors 8:00 PM' }], 'no colon at all');
  /* But a real label whose value starts with a time still works. */
  eq(S.parseDetails('Soundcheck: 5:30 PM'),
     [{ label: 'Soundcheck', value: '5:30 PM' }]);
});

check('a colon inside a sentence does not fake a label', () => {
  const rows = S.parseDetails('Remember this one thing about the gig: park behind the venue');
  eq(rows, [{ text: 'Remember this one thing about the gig: park behind the venue' }]);
});

check('a url is left whole', () => {
  eq(S.parseDetails('https://example.com/advance.pdf'),
     [{ text: 'https://example.com/advance.pdf' }]);
});

check('blank lines and empty details are ignored', () => {
  eq(S.parseDetails('A: 1\n\n\nB: 2'), [{ label: 'A', value: '1' }, { label: 'B', value: '2' }]);
  eq(S.parseDetails(''), []);
  eq(S.parseDetails(null), []);
});

/* ── saying when ───────────────────────────────────────────────── */

check('a same-day flight reads as one line', () => {
  eq(S.whenLine({ start: '2026-10-08T09:21', end: '2026-10-08T12:25' }),
     'Thu Oct 8 · 9:21 AM → 12:25 PM');
});

check('a flight over midnight names both days', () => {
  eq(S.whenLine({ start: '2026-10-08T21:40', end: '2026-10-09T06:05' }),
     'Thu Oct 8 9:40 PM → Fri Oct 9 6:05 AM');
});

check('a hotel counts its nights', () => {
  eq(S.whenLine({ start: '2026-10-08', end: '2026-10-10' }), 'Thu Oct 8 → Sat Oct 10 · 2 nights');
  eq(S.whenLine({ start: '2026-10-08', end: '2026-10-09' }), 'Thu Oct 8 → Fri Oct 9 · 1 night');
});

check('one moment in time is just that moment', () => {
  eq(S.whenLine({ start: '2026-10-09T20:00' }), 'Fri Oct 9 · 8:00 PM');
  eq(S.whenLine({ start: '2026-10-09' }), 'Fri Oct 9');
  eq(S.whenLine({}), '');
});

check('midnight and noon are not mixed up', () => {
  eq(S.fmtTime('2026-10-09T00:05'), '12:05 AM', 'midnight');
  eq(S.fmtTime('2026-10-09T12:00'), '12:00 PM', 'noon');
  eq(S.fmtTime('2026-10-09T23:59'), '11:59 PM', 'last minute');
});

check('a date is read off the string, never off the reader\'s clock', () => {
  /* Same call from Berlin or Honolulu must print the same day. */
  eq(S.fmtDay('2026-10-08'), 'Thu Oct 8');
  eq(S.fmtDay('2026-01-01'), 'Thu Jan 1');
  eq(S.fmtDay(''), '');
});

check('the same show reads the same day from anywhere on earth', () => {
  /* He plays in Kauai and lands in Berlin. A page that renders "Thu Oct 8"
     in LA and "Fri Oct 9" in Berlin is how people miss flights, so this is
     checked for real: the formatting is re-run inside fresh Node processes
     pinned to far-apart timezones. */
  const { execFileSync } = require('child_process');
  const probe =
    "const S=require('" + require('path').join(__dirname, '..', 'site/shows/shows.js') + "');" +
    "process.stdout.write(JSON.stringify([" +
    "S.fmtDay('2026-10-08')," +
    "S.fmtTime('2026-10-08T23:40')," +
    "S.whenLine({start:'2026-10-08T21:40',end:'2026-10-09T06:05'})," +
    "S.showDateLine({date:'2026-10-08',end_date:'2026-10-10'})]))";
  const want = JSON.stringify(['Thu Oct 8', '11:40 PM',
    'Thu Oct 8 9:40 PM → Fri Oct 9 6:05 AM', 'Thu Oct 8 → Sat Oct 10']);
  ['America/Los_Angeles', 'Pacific/Honolulu', 'Europe/Berlin', 'Pacific/Kiritimati', 'UTC']
    .forEach((tz) => {
      const out = execFileSync(process.execPath, ['-e', probe],
        { env: Object.assign({}, process.env, { TZ: tz }) }).toString();
      eq(out, want, 'read from ' + tz);
    });
});

check('a show over several days shows the range', () => {
  eq(S.showDateLine({ date: '2026-10-08', end_date: '2026-10-10' }), 'Thu Oct 8 → Sat Oct 10');
  eq(S.showDateLine({ date: '2026-10-08', end_date: '2026-10-08' }), 'Thu Oct 8');
  eq(S.showDateLine({ date: '' }), 'date to come');
});

/* ── the password ───────────────────────────────────────────────── */

check('the password stretches to exactly the key the CLI writes', () => {
  /* THE pinning test. The page derives the engine's key from the password in
     the browser; founder-os/.claude/scripts/shows.py derives it from the same
     password in Python and writes it into secrets/shows.env. If those two ever
     stop agreeing — a changed salt, a changed round count, a changed encoding —
     the page silently stops opening. The vector below is a throwaway password,
     never the real one, computed once with Python's hashlib and hard-coded so
     BOTH sides are anchored to it.

     python3 -c "import hashlib;print('sh'+hashlib.pbkdf2_hmac('sha256',
       b'correct horse battery staple', b'bandpeace-shows-v1', 4000000, 32).hex())"
  */
  eq(S.KDF, { salt: 'bandpeace-shows-v1', iterations: 4000000, bits: 256 }, 'parameters');

  const { webcrypto } = require('crypto');
  return S.deriveToken('correct horse battery staple', webcrypto.subtle).then((token) => {
    eq(token, KNOWN_VECTOR, 'derived key');
    ok(/^sh[A-Za-z0-9]{40,}$/.test(token), 'and it is shaped like an engine key');
  });
});

check('a different password gives a different key', () => {
  const { webcrypto } = require('crypto');
  return Promise.all([
    S.deriveToken('correct horse battery staple', webcrypto.subtle),
    S.deriveToken('correct horse battery stapl', webcrypto.subtle)
  ]).then(([a, b]) => ok(a !== b, 'one character changes everything'));
});

/* ── where you are in the day ───────────────────────────────────── */

check('the wall clock is read as a plain stamp, no timezone maths', () => {
  eq(S.nowStamp(new Date(2026, 9, 8, 9, 5)), '2026-10-08T09:05');
  eq(S.nowStamp(new Date(2026, 0, 1, 0, 0)), '2026-01-01T00:00');
});

check('an entry is past once it has finished, not before', () => {
  const flight = { start: '2026-10-08T09:21', end: '2026-10-08T12:25' };
  eq(S.itemState(flight, '2026-10-08T08:00'), 'future', 'before boarding');
  eq(S.itemState(flight, '2026-10-08T10:00'), 'now', 'in the air');
  eq(S.itemState(flight, '2026-10-08T12:25'), 'now', 'the minute it lands');
  eq(S.itemState(flight, '2026-10-08T12:26'), 'past', 'after landing');
});

check('a one-moment entry passes the minute after it', () => {
  const doors = { start: '2026-10-09T20:00' };
  eq(S.itemState(doors, '2026-10-09T19:59'), 'future');
  eq(S.itemState(doors, '2026-10-09T20:00'), 'now');
  eq(S.itemState(doors, '2026-10-09T20:01'), 'past');
});

check('a hotel is not "past" on the morning you check out', () => {
  /* The bug this guards: '2026-10-10' < '2026-10-10T08:00' as plain text,
     which would grey out the hotel while he is still asleep in it. */
  const stay = { start: '2026-10-08', end: '2026-10-10' };
  eq(S.itemState(stay, '2026-10-10T08:00'), 'now', 'checkout morning');
  eq(S.itemState(stay, '2026-10-08T00:00'), 'now', 'check-in day');
  eq(S.itemState(stay, '2026-10-07T23:59'), 'future', 'the night before');
  eq(S.itemState(stay, '2026-10-11T00:00'), 'past', 'the day after');
});

check('an entry with no time on it is never behind you', () => {
  eq(S.itemState({ title: 'Bring the adapter' }, '2030-01-01T00:00'), 'future');
});

/* ── links can't become attacks ────────────────────────────────── */

check('only https, mailto and tel ever become clickable', () => {
  eq(S.safeLink('https://example.com/x'), 'https://example.com/x', 'https');
  eq(S.safeLink('mailto:a@b.com'), 'mailto:a@b.com', 'mailto');
  eq(S.safeLink('tel:+13105551234'), 'tel:+13105551234', 'tel');
  ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>', 'http://plain.com',
   'file:///etc/passwd', ' javascript:alert(1)', 'https://ok.com" onclick="x'].forEach((bad) => {
    eq(S.safeLink(bad), '', 'refused ' + bad);
  });
});

check('a phone number becomes a tap-to-call only when it is one', () => {
  eq(S.telLink('+1 (555) 010-0000'), 'tel:+15550100000', 'formatted');
  eq(S.telLink('ask the promoter'), '', 'not a number');
  eq(S.telLink(''), '', 'empty');
});

check('an address becomes a map link, safely escaped', () => {
  eq(S.mapsUrl('9 Harbor Rd, Port Town, CA'),
     'https://maps.apple.com/?q=9%20Harbor%20Rd%2C%20Port%20Town%2C%20CA');
  eq(S.mapsUrl(''), '');
});

/* ── the demo ──────────────────────────────────────────────────── */

check('the demo is obviously invented and internally consistent', () => {
  const d = S.makeDemoData(NOW);
  ok(d.shows.length >= 3, 'has shows');
  d.shows.forEach((s) => ok(/demo/i.test(s.title), 'every demo show says demo: ' + s.title));
  const ids = d.shows.map((s) => s.id);
  d.items.forEach((it) => {
    ok(ids.indexOf(it.show_id) >= 0, 'item ' + it.id + ' points at a real show');
    ok(['travel', 'hotel', 'backstage'].indexOf(it.tab) >= 0, 'item ' + it.id + ' has a real tab');
  });
  const split = S.splitShows(d.shows, NOW);
  ok(split.upcoming.length >= 2 && split.past.length >= 1, 'demo covers upcoming AND past');
});

check('nothing real can hide in the demo data', () => {
  /* This runs in a PUBLIC repo. Rather than list the private things it must
     not contain — which would put them in the repo — the demo data has to
     prove it is invented: every show says so, every confirmation number is
     visibly fake, and every phone number sits in the 555-01xx block that is
     reserved for fiction precisely so it can never reach a real person. */
  const d = S.makeDemoData(NOW);
  d.shows.forEach((s) => ok(/\(demo\)/i.test(s.title), 'show not marked demo: ' + s.title));
  d.items.forEach((it) => {
    if (it.confirmation) {
      ok(/DEMO/i.test(it.confirmation), 'confirmation not visibly fake: ' + it.confirmation);
    }
    if (it.phone) {
      ok(/^\+1 555 01[0-9] [0-9]{4}$/.test(it.phone),
         'phone outside the reserved fiction block: ' + it.phone);
    }
  });
});

/* ── report ────────────────────────────────────────────────────── */

Promise.all(pending).then(() => {
  console.log('\nshows page: ' + passed + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(failures.length ? 1 : 0);
});
