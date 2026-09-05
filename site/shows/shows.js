/* Shows — every show and everything you need to get to it and play it.
   Plain vanilla JS, no build step, no frameworks, no CDNs.

   The pure helpers up top (parseFragment, dayInfo, splitShows, itemsFor,
   parseDetails, whenLine …) are exported for Node unit tests; everything that
   touches the DOM lives behind init(), which only runs in a browser.

   Security shape, same as /hq/: the path is boring, the key rides in the URL
   fragment (#sh…) and never reaches a server log. The real gate is the Apps
   Script engine checking the key on every call — this page just behaves
   politely when the key is missing or wrong (it shows nothing).

   The page never writes. Shows are updated by Edward from a screenshot, over
   the shows CLI in founder-os. This is the read side, built for a phone in an
   airport. */

(function () {
  'use strict';

  /* ── constants ─────────────────────────────────────────────────── */

  var TOKEN_RE = /^sh[A-Za-z0-9]{40,}$/;
  var SHOW_ID_RE = /^SH-\d+$/i;

  /* The password never leaves this browser. It is stretched into the engine's
     key here, and only that key is ever sent — so the page still holds no
     secret and the repo still holds no secret. The salt is public on purpose
     (that's what a salt is for); the cost is what protects a short password.
     4,000,000 rounds is roughly 1½ seconds on a phone — paid once per device,
     and paid again by anybody guessing, on every single guess. */
  var KDF = { salt: 'bandpeace-shows-v1', iterations: 4000000, bits: 256 };
  var LA_TZ = 'America/Los_Angeles';
  var DAY_MS = 86400000;
  var POLL_MS = 120000;
  var TABS = ['travel', 'hotel', 'backstage'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var KIND_ICON = {
    flight: '✈️', stay: '🏨', ground: '🚗',
    time: '🕗', contact: '📇', note: '📝'
  };

  /* ── pure helpers (unit-tested in Node) ────────────────────────── */

  /* parseFragment("#sh…"), ("#sh…/SH-2/hotel"), ("#demo/SH-1"), ("#SH-2"),
     ("#SH-2/hotel"), ("") → { demo, token, showId, tab }. Malformed → null.

     The key is OPTIONAL in the address now. Someone who signed in with the
     password has the key remembered on the device, so their links look like
     "#SH-2/hotel" and the secret never sits in the address bar. A full "#sh…"
     link still works exactly as before — that's the same key, written out. */
  function parseFragment(hash) {
    var h = String(hash == null ? '' : hash);
    if (h.charAt(0) === '#') h = h.slice(1);
    try { h = decodeURIComponent(h); } catch (e) { /* keep raw */ }
    if (!h) return { demo: false, token: null, showId: null, tab: null };

    var parts = h.split('/');
    var demo = false;
    var token = null;

    if (parts[0] === 'demo') {
      demo = true;
      parts = parts.slice(1);
    } else if (TOKEN_RE.test(parts[0])) {
      token = parts[0];
      parts = parts.slice(1);
    }
    if (parts.length > 2) return null;

    var showId = null;
    if (parts.length > 0 && parts[0]) {
      var raw = parts[0].toUpperCase();
      if (!SHOW_ID_RE.test(raw)) return null;
      showId = raw;
    }
    var tab = null;
    if (parts.length > 1 && parts[1]) {
      var t = parts[1].toLowerCase();
      if (TABS.indexOf(t) < 0) return null;
      tab = t;
    }
    /* A tab with no show is meaningless — treat it as malformed. */
    if (tab && !showId) return null;
    /* Nothing recognisable at all in a non-empty hash. */
    if (!demo && !token && !showId) return null;

    return { demo: demo, token: token, showId: showId, tab: tab };
  }

  /* deriveToken("a password") → Promise<"sh…">, the engine's key.
     Node and the browser must land on the same string — the CLI writes the
     key from Python's PBKDF2 and the page has to arrive at the same one, so
     there's a test pinning both to a known value. */
  function deriveToken(password, subtle) {
    var crypt = subtle || (typeof crypto !== 'undefined' && crypto.subtle);
    if (!crypt) return Promise.reject(new Error('no webcrypto'));
    var bytes = new TextEncoder().encode(String(password));
    var salt = new TextEncoder().encode(KDF.salt);
    return crypt.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return crypt.deriveBits(
          { name: 'PBKDF2', salt: salt, iterations: KDF.iterations, hash: 'SHA-256' },
          key, KDF.bits);
      })
      .then(function (bits) {
        var hex = '';
        new Uint8Array(bits).forEach(function (b) {
          hex += (b < 16 ? '0' : '') + b.toString(16);
        });
        return 'sh' + hex;
      });
  }

  /* LA calendar date of a Date, as UTC-midnight millis (DST-safe day math). */
  function laDayMillis(date) {
    var s = new Intl.DateTimeFormat('en-CA', {
      timeZone: LA_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }

  function dayMillis(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }

  /* dayInfo("2026-10-09", now) → { days, label, past, soon } or null.
     Whole days, counted in Los Angeles, so "Today" means today where he is. */
  function dayInfo(ymd, now) {
    var target = dayMillis(ymd);
    if (target === null) return null;
    var nowDate = now instanceof Date ? now : (now ? new Date(now) : new Date());
    if (isNaN(nowDate.getTime())) nowDate = new Date();
    var days = Math.round((target - laDayMillis(nowDate)) / DAY_MS);

    var label;
    if (days === 0) label = 'today';
    else if (days === 1) label = 'tomorrow';
    else if (days === -1) label = 'yesterday';
    else if (days < 0) {
      var ago = -days;
      if (ago < 14) label = ago + ' days ago';
      else if (ago < 60) label = Math.round(ago / 7) + ' weeks ago';
      else label = Math.round(ago / 30) + ' months ago';
    } else if (days < 14) label = 'in ' + days + ' days';
    else if (days < 60) label = 'in ' + Math.round(days / 7) + ' weeks';
    else label = 'in ' + Math.round(days / 30) + ' months';

    return { days: days, label: label, past: days < 0, soon: days >= 0 && days <= 7 };
  }

  /* The day a show is "over": its end_date if it has one, else its date. */
  function lastDayOf(show) {
    return dayMillis(show && show.end_date) !== null ? show.end_date : (show && show.date);
  }

  /* splitShows(shows, now) → { upcoming, past }.
     Upcoming = today or later, soonest first. Past = newest first.
     A show with no date yet is upcoming (it's a plan, not a memory) and sits
     at the end, because an undated show can't be scheduled against. */
  function splitShows(shows, now) {
    var list = (Array.isArray(shows) ? shows : []).filter(function (s) { return s && s.id; });
    var nowDate = now instanceof Date ? now : (now ? new Date(now) : new Date());
    if (isNaN(nowDate.getTime())) nowDate = new Date();
    var today = laDayMillis(nowDate);

    var upcoming = [], past = [];
    list.forEach(function (s) {
      var last = dayMillis(lastDayOf(s));
      if (last === null || last >= today) upcoming.push(s); else past.push(s);
    });

    upcoming.sort(function (a, b) {
      var da = dayMillis(a.date), db = dayMillis(b.date);
      if (da === null && db === null) return cmp(a.id, b.id);
      if (da === null) return 1;          // undated shows sink to the bottom
      if (db === null) return -1;
      return da - db || cmp(a.id, b.id);
    });
    past.sort(function (a, b) {
      return (dayMillis(b.date) || 0) - (dayMillis(a.date) || 0) || cmp(b.id, a.id);
    });
    return { upcoming: upcoming, past: past };
  }

  function cmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  function idNum(id) {
    var m = /-(\d+)$/.exec(String(id || ''));
    return m ? +m[1] : 0;
  }

  /* itemsFor(items, showId, tab) → that tab's entries, in the order they
     happen: a hand-set `sort` first, then time, then the order they arrived. */
  function itemsFor(items, showId, tab) {
    return (Array.isArray(items) ? items : [])
      .filter(function (it) {
        return it && it.show_id === showId && (!tab || it.tab === tab);
      })
      .sort(function (a, b) {
        var sa = a.sort === '' || a.sort === undefined ? Infinity : Number(a.sort);
        var sb = b.sort === '' || b.sort === undefined ? Infinity : Number(b.sort);
        if (isNaN(sa)) sa = Infinity;
        if (isNaN(sb)) sb = Infinity;
        if (sa !== sb) return sa - sb;
        var wa = String(a.start || '~');   // '~' sorts after any digit
        var wb = String(b.start || '~');
        return cmp(wa, wb) || (idNum(a.id) - idNum(b.id));
      });
  }

  /* How many entries each tab holds, for the little chips on a show card. */
  function tabCounts(items, showId) {
    var counts = { travel: 0, hotel: 0, backstage: 0 };
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (it && it.show_id === showId && counts.hasOwnProperty(it.tab)) counts[it.tab]++;
    });
    return counts;
  }

  /* parseDetails("Seat: 14C\nGate opens 40 min before\n\nBring the adapter")
     → [{label:'Seat', value:'14C'}, {text:'Gate opens 40 min before'}, …]
     Free text stays free; "Label: value" lines become rows you can scan. */
  function parseDetails(text) {
    if (!text) return [];
    return String(text).split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean).map(function (line) {
      var m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
      if (m) {
        var label = m[1];
        var afterColon = line.slice(label.length + 1);
        /* A colon with digits on both sides is a clock, not a label —
           "Land 12:25 PM on check-in day" is a sentence, and splitting it
           gave the row "LAND 12 → 25 PM on check-in day". */
        var isClock = /\d$/.test(label) && /^\d/.test(afterColon);
        /* Nor is it a label if it's really a sentence, or a URL scheme. */
        var isScheme = /^https?$|^tel$|^mailto$/i.test(label);
        if (!isClock && !isScheme && label.trim().split(/\s+/).length <= 5) {
          return { label: label.trim(), value: m[2].trim() };
        }
      }
      return { text: line };
    });
  }

  /* "2026-10-08" → "Thu Oct 8"  ·  built from the string, never from a
     Date in the browser's timezone, so a 9 PM flight can't slide to the
     next day for a reader sitting in another country. */
  function fmtDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return WEEKDAYS[d.getUTCDay()] + ' ' + MONTHS[+m[2] - 1] + ' ' + (+m[3]);
  }

  /* "2026-10-08T09:21" → "9:21 AM"  ·  "" when there's no clock time. */
  function fmtTime(s) {
    var m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})$/.exec(String(s || ''));
    if (!m) return '';
    var h = +m[1];
    var suffix = h < 12 ? 'AM' : 'PM';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + m[2] + ' ' + suffix;
  }

  function sameDay(a, b) {
    return String(a).slice(0, 10) === String(b).slice(0, 10);
  }

  function nightsBetween(a, b) {
    var da = dayMillis(a), db = dayMillis(b);
    if (da === null || db === null) return 0;
    return Math.round((db - da) / DAY_MS);
  }

  /* whenLine(item) → the one line that says when this thing happens.
       flight, same day     "Thu Oct 8 · 9:21 AM → 12:25 PM"
       flight, over midnight"Thu Oct 8 9:21 PM → Fri Oct 9 6:05 AM"
       a stay               "Thu Oct 8 → Sat Oct 10 · 2 nights"
       one moment           "Fri Oct 9 · 8:00 PM"  */
  function whenLine(item) {
    var start = String((item && item.start) || '');
    var end = String((item && item.end) || '');
    if (!start && !end) return '';
    if (!start) return fmtDay(end) + (fmtTime(end) ? ' · ' + fmtTime(end) : '');

    var sDay = fmtDay(start), sTime = fmtTime(start);
    if (!end) return sDay + (sTime ? ' · ' + sTime : '');

    var eDay = fmtDay(end), eTime = fmtTime(end);
    if (!sTime && !eTime) {
      var n = nightsBetween(start, end);
      return sDay + ' → ' + eDay + (n > 0 ? ' · ' + n + (n === 1 ? ' night' : ' nights') : '');
    }
    if (sameDay(start, end)) return sDay + ' · ' + sTime + ' → ' + eTime;
    return sDay + ' ' + sTime + ' → ' + eDay + ' ' + eTime;
  }

  /* The date line under a show's title: one day, or a range. */
  function showDateLine(show) {
    if (!show || !show.date) return 'date to come';
    var a = fmtDay(show.date);
    if (!show.end_date || sameDay(show.date, show.end_date)) return a;
    return a + ' → ' + fmtDay(show.end_date);
  }

  /* The reader's own wall clock as 'YYYY-MM-DDTHH:MM'.
     Times on this page carry no timezone on purpose — a flight time is the
     time the airport shows. Comparing them to the reader's wall clock is
     therefore right whenever he is at the place the thing happens, which is
     the only time this matters. */
  function nowStamp(now) {
    var d = now instanceof Date ? now : (now ? new Date(now) : new Date());
    if (isNaN(d.getTime())) d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* A bare date means the whole day: it starts at midnight and isn't over
     until the day is. */
  function asStart(v) {
    var s = String(v || '');
    if (!s) return '';
    return s.length === 10 ? s + 'T00:00' : s;
  }
  function asEnd(v) {
    var s = String(v || '');
    if (!s) return '';
    return s.length === 10 ? s + 'T23:59' : s;
  }

  /* itemState(item, stamp) → 'past' | 'now' | 'future'.
     Undated entries are never "past" — an unscheduled note is still standing. */
  function itemState(item, stamp) {
    var start = asStart(item && item.start);
    var end = asEnd(item && item.end) || asEnd(item && item.start);
    if (!start && !end) return 'future';
    if (end && end < stamp) return 'past';
    if (start && start <= stamp) return 'now';
    return 'future';
  }

  /* Only these can ever become an href. Anything else is shown as text. */
  function safeLink(url) {
    var s = String(url || '').trim();
    if (/^https:\/\/[^\s<>"']+$/i.test(s)) return s;
    if (/^mailto:[^\s<>"']+$/i.test(s)) return s;
    if (/^tel:[+0-9().\- ]+$/i.test(s)) return s;
    return '';
  }

  function telLink(phone) {
    var s = String(phone || '').trim();
    if (!s) return '';
    var digits = s.replace(/[^+0-9]/g, '');
    return digits.length >= 7 ? 'tel:' + digits : '';
  }

  function mapsUrl(place) {
    var s = String(place || '').trim();
    return s ? 'https://maps.apple.com/?q=' + encodeURIComponent(s) : '';
  }

  /* ── demo data (obviously invented — nothing real lives here) ──── */

  function makeDemoData(now) {
    var base = now instanceof Date ? now : new Date();
    var today = laDayMillis(base);
    function ymd(offset) {
      var d = new Date(today + offset * DAY_MS);
      var mm = String(d.getUTCMonth() + 1); if (mm.length < 2) mm = '0' + mm;
      var dd = String(d.getUTCDate()); if (dd.length < 2) dd = '0' + dd;
      return d.getUTCFullYear() + '-' + mm + '-' + dd;
    }
    var stamp = new Date(base.getTime() - 3 * DAY_MS).toISOString();
    var seq = 0;
    function item(showId, tab, kind, fields) {
      seq++;
      return Object.assign({
        id: 'IT-' + seq, show_id: showId, tab: tab, kind: kind,
        title: '', subtitle: '', start: '', end: '', place: '',
        confirmation: '', phone: '', link: '', details: '', sort: '',
        created: stamp, updated: stamp
      }, fields);
    }
    function show(id, fields) {
      return Object.assign({
        id: id, title: '', venue: '', city: '', date: '', end_date: '',
        status: 'confirmed', headline: '', notes: '', created: stamp, updated: stamp
      }, fields);
    }

    return {
      shows: [
        show('SH-1', {
          title: 'Moonfruit Festival (demo)', venue: 'The Sandbar',
          city: 'Made-Up Beach, CA', date: ymd(12), headline: 'Sax + DJ, 90 min'
        }),
        show('SH-2', {
          title: 'Club Pretend (demo)', venue: 'Pretend Club', city: 'Nowhere, NY',
          date: ymd(40), status: 'hold', headline: 'Late set — hold',
          notes: 'Everything on this page is invented for the demo.'
        }),
        show('SH-3', {
          title: 'Imaginary Wedding (demo)', venue: 'Hotel Nonexistent',
          city: 'Island That Is Not Real', date: ymd(-9), headline: 'Ceremony + reception'
        })
      ],
      items: [
        item('SH-1', 'travel', 'flight', {
          title: 'ZZ 100', subtitle: 'LAX → FAKE',
          start: ymd(11) + 'T09:15', end: ymd(11) + 'T12:40',
          confirmation: 'DEMO11', details: 'Seat: 14C\nBag: 1 carry-on'
        }),
        item('SH-1', 'travel', 'flight', {
          title: 'ZZ 101', subtitle: 'FAKE → LAX',
          start: ymd(13) + 'T14:05', end: ymd(13) + 'T22:30', confirmation: 'DEMO11'
        }),
        item('SH-1', 'travel', 'ground', {
          title: 'Rental car', subtitle: 'Pretend Rentals, airport counter',
          start: ymd(11) + 'T13:15', confirmation: 'CAR-DEMO',
          details: 'Drive: 40 min to the venue'
        }),
        item('SH-1', 'hotel', 'stay', {
          title: 'Hotel Nonexistent (demo)', place: '1 Imaginary Road, Made-Up Beach, CA',
          start: ymd(11), end: ymd(13), confirmation: 'DEMO-5826',
          phone: '+1 555 010 0000', details: 'Room: Ocean View King\nPaid by: the promoter'
        }),
        item('SH-1', 'backstage', 'time', { title: 'Load-in', start: ymd(12) + 'T16:00' }),
        item('SH-1', 'backstage', 'time', { title: 'Soundcheck', start: ymd(12) + 'T17:30' }),
        item('SH-1', 'backstage', 'time', { title: 'Doors', start: ymd(12) + 'T20:00' }),
        item('SH-1', 'backstage', 'time', {
          title: 'Set', start: ymd(12) + 'T22:30', end: ymd(12) + 'T23:59', subtitle: '90 minutes'
        }),
        item('SH-1', 'backstage', 'contact', {
          title: 'Pat Imaginary', subtitle: 'Stage manager', phone: '+1 555 010 0001'
        }),
        item('SH-1', 'backstage', 'note', {
          title: 'Backline', details: 'Two DI boxes on stage\nWiFi: guest / demo1234\nPark behind the venue'
        }),
        item('SH-2', 'travel', 'note', {
          title: 'Nothing booked yet', details: 'Waiting on the promoter to confirm the date.'
        }),
        item('SH-3', 'backstage', 'time', { title: 'Set', start: ymd(-9) + 'T19:00' })
      ]
    };
  }

  /* ── everything below needs a browser ──────────────────────────── */

  var app = {
    route: null,
    demo: false,
    token: null,
    data: null,
    fetching: false,
    loadError: false,
    rejected: false,
    pollTimer: null,
    toastTimer: null,
    signingIn: false
  };

  var els = {};

  function el(id) { return document.getElementById(id); }

  function apiUrl() {
    var cfg = (typeof window !== 'undefined' && window.SHOWS_CONFIG) || {};
    return typeof cfg.apiUrl === 'string' ? cfg.apiUrl.trim() : '';
  }

  function readStoredToken() {
    try {
      var t = window.localStorage.getItem('showsToken');
      return (t && TOKEN_RE.test(t)) ? t : null;
    } catch (e) { return null; }
  }

  function storeToken(token) {
    try { window.localStorage.setItem('showsToken', token); } catch (e) { /* fine */ }
  }

  /* ── engine (live ⇄ demo) ──────────────────────────────────────── */

  function liveList() {
    return fetch(apiUrl() + '?token=' + encodeURIComponent(app.token) + '&action=shows', {
      method: 'GET', redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }

  function load() {
    if (app.demo) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          var d = makeDemoData();
          resolve({ ok: true, shows: d.shows, items: d.items, generated: new Date().toISOString() });
        }, 140);
      });
    }
    return liveList();
  }

  function refresh() {
    if (!app.demo && (!app.token || !apiUrl() || app.rejected)) return;
    if (app.fetching) return;
    app.fetching = true;
    setSpinning(true);
    /* Two-argument .then on purpose: a mistake thrown while rendering must
       NOT land in the network handler and report itself as "can't reach the
       shows". A rendering bug should be loud. */
    load().then(function (res) {
      app.fetching = false;
      setSpinning(false);
      if (res && res.ok) {
        app.data = {
          shows: Array.isArray(res.shows) ? res.shows : [],
          items: Array.isArray(res.items) ? res.items : [],
          generated: res.generated || ''
        };
        app.loadError = false;
        render();
      } else {
        app.rejected = true;
        /* Only forget the remembered key when the engine actually REFUSED it
           ("nope"). Any other complaint is the engine having a moment, and
           throwing him back to the password screen for that would be wrong. */
        if (res && res.error === 'nope') forgetToken();
        render();
      }
    }, function () {
      app.fetching = false;
      setSpinning(false);
      if (app.data) {
        toast("can't reach the shows — showing what I had");
      } else {
        app.loadError = true;
        render();
      }
    });
  }

  function ensurePoll() {
    var want = app.demo || (!!app.token && !!apiUrl() && !app.rejected);
    if (want && !app.pollTimer) {
      app.pollTimer = setInterval(function () {
        if (!document.hidden && !app.demo) refresh();
      }, POLL_MS);
    } else if (!want && app.pollTimer) {
      clearInterval(app.pollTimer);
      app.pollTimer = null;
    }
  }

  function setSpinning(on) {
    [els.listRefresh, els.showRefresh].forEach(function (b) {
      if (b) b.classList.toggle('spinning', !!on);
    });
  }

  function toast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(app.toastTimer);
    app.toastTimer = setTimeout(function () { els.toast.hidden = true; }, 2200);
  }

  /* ── routing ───────────────────────────────────────────────────── */

  function onRoute() {
    /* Anything unreadable in the hash is treated as no hash at all, rather
       than as a locked door — it's the same person on the same device. */
    var parsed = parseFragment(window.location.hash) ||
                 { demo: false, token: null, showId: null, tab: null };

    var prevToken = app.token;
    var prevDemo = app.demo;

    app.route = parsed;
    app.demo = !!parsed.demo;
    /* A key written into the link wins; otherwise use the one this device
       remembered when the password was typed. */
    app.token = app.demo ? null : (parsed.token || readStoredToken());

    if (app.token) storeToken(app.token);
    /* A different key is a different world: drop what the old one loaded,
       or a rotated link would keep showing the shows it replaced. */
    if (app.token !== prevToken) {
      app.rejected = false;
      app.loadError = false;
      app.data = null;
    }
    if (app.demo !== prevDemo) app.data = null;   // fake data never bleeds into live

    if ((app.demo || (app.token && apiUrl())) && !app.data && !app.loadError && !app.fetching) {
      refresh();
    }
    ensurePoll();
    render();
  }

  /* Deliberately does NOT put the key back in the address bar: once the
     device remembers it, moving around the page leaves no secret on screen,
     in a screenshot, or in whatever the browser syncs. */
  function go(showId, tab) {
    var parts = [];
    if (app.demo) parts.push('demo');
    if (showId) parts.push(showId);
    if (showId && tab) parts.push(tab);
    var next = '#' + parts.join('/');
    if (window.location.hash !== next) window.location.hash = next;
    else onRoute();
  }

  /* ── rendering ─────────────────────────────────────────────────── */

  function showState(which) {
    ['login', 'nocrypto', 'noengine', 'loading', 'retry'].forEach(function (name) {
      var node = el('state-' + name);
      if (node) node.hidden = which !== name;
    });
    els.viewList.hidden = which !== 'list';
    els.viewShow.hidden = which !== 'show';
    if (which === 'login' && els.loginPw && !prefersTouch()) {
      /* Focus the field on a laptop; never on a phone, where it would throw
         the keyboard up before he's even looked at the screen. */
      try { els.loginPw.focus(); } catch (e) { /* fine */ }
    }
  }

  function prefersTouch() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  function hasCrypto() {
    return !!(typeof crypto !== 'undefined' && crypto.subtle && window.isSecureContext);
  }

  function currentShow() {
    if (!app.data || !app.route || !app.route.showId) return null;
    return app.data.shows.filter(function (s) { return s.id === app.route.showId; })[0] || null;
  }

  function render() {
    document.body.classList.toggle('demo', app.demo);
    els.demoBanner.hidden = !app.demo;

    if (!app.demo && (!app.token || app.rejected)) {
      showState(hasCrypto() ? 'login' : 'nocrypto');
      return;
    }
    if (!app.demo && !apiUrl()) { showState('noengine'); return; }
    if (app.loadError) { showState('retry'); return; }
    if (!app.data) { showState('loading'); return; }

    var show = currentShow();
    if (app.route.showId && !show) {
      /* A link to a show that's been removed — don't dead-end, go to the list. */
      go(null);
      return;
    }
    if (show) { renderShow(show); showState('show'); }
    else { renderList(); showState('list'); }
  }

  function stampText(node) {
    if (!node) return;
    node.textContent = app.demo ? 'demo data — nothing here is real'
                                : (app.data && app.data.generated ? 'updated ' + agoText(app.data.generated) : '');
  }

  function agoText(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return 'just now';
    var mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    return Math.round(hrs / 24) + ' days ago';
  }

  /* ── the list ──────────────────────────────────────────────────── */

  function renderList() {
    var split = splitShows(app.data.shows);
    var frag = document.createDocumentFragment();

    if (split.upcoming.length) {
      frag.appendChild(sectionLabel('Coming up'));
      split.upcoming.forEach(function (s, i) {
        frag.appendChild(showCard(s, i === 0));
      });
    }
    if (split.past.length) {
      frag.appendChild(sectionLabel('Played'));
      split.past.forEach(function (s) { frag.appendChild(showCard(s, false)); });
    }

    els.showList.textContent = '';
    els.showList.appendChild(frag);
    els.listEmpty.hidden = !!(split.upcoming.length || split.past.length);
    stampText(els.listStamp);
  }

  function sectionLabel(text) {
    var h = document.createElement('h2');
    h.className = 'section-label';
    h.textContent = text;
    return h;
  }

  function showCard(show, isNext) {
    var node = els.tplShowCard.content.firstElementChild.cloneNode(true);
    var info = dayInfo(show.date);

    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(show.date || ''));
    node.querySelector('.date-mon').textContent = m ? MONTHS[+m[2] - 1].toUpperCase() : '—';
    node.querySelector('.date-day').textContent = m ? String(+m[3]) : '?';
    node.querySelector('.date-yr').textContent = m ? m[1] : '';

    node.querySelector('.card-title').textContent = show.title || 'Untitled show';

    var where = [show.venue, show.city].filter(Boolean).join(' · ');
    node.querySelector('.card-where').textContent = where || 'venue to come';

    var headline = node.querySelector('.card-headline');
    if (show.headline) { headline.textContent = show.headline; headline.hidden = false; }

    var status = node.querySelector('.card-status');
    if (show.status && show.status !== 'confirmed') {
      status.textContent = show.status;
      status.classList.add('is-' + show.status);
      status.hidden = false;
    }

    var when = node.querySelector('.card-when');
    when.textContent = info ? info.label : '';
    if (info && info.soon) when.classList.add('is-soon');
    if (info && info.past) when.classList.add('is-past');

    var counts = tabCounts(app.data.items, show.id);
    var chips = node.querySelector('.card-tabs');
    TABS.forEach(function (tab) {
      var chip = document.createElement('span');
      chip.className = 'tab-chip' + (counts[tab] ? '' : ' is-empty');
      chip.textContent = tab + (counts[tab] ? ' ' + counts[tab] : '');
      chips.appendChild(chip);
    });

    if (isNext) node.classList.add('is-next');
    if (show.status === 'cancelled') node.classList.add('is-cancelled');
    node.addEventListener('click', function () { go(show.id, null); });
    return node;
  }

  /* ── one show ──────────────────────────────────────────────────── */

  function renderShow(show) {
    els.showTitle.textContent = show.title || 'Untitled show';
    var sub = [showDateLine(show), show.venue, show.city].filter(Boolean).join(' · ');
    els.showSub.textContent = sub;

    var info = dayInfo(show.date);
    var strip = els.showWhen;
    strip.textContent = '';
    strip.hidden = true;
    if (info || (show.status && show.status !== 'confirmed')) {
      strip.hidden = false;
      if (info) {
        var when = document.createElement('span');
        when.className = 'when-pill' + (info.soon ? ' is-soon' : '') + (info.past ? ' is-past' : '');
        when.textContent = info.label;
        strip.appendChild(when);
      }
      if (show.status && show.status !== 'confirmed') {
        var st = document.createElement('span');
        st.className = 'when-pill is-' + show.status;
        st.textContent = show.status;
        strip.appendChild(st);
      }
      if (show.headline) {
        var hl = document.createElement('span');
        hl.className = 'when-note';
        hl.textContent = show.headline;
        strip.appendChild(hl);
      }
    }

    var counts = tabCounts(app.data.items, show.id);
    var tab = app.route.tab || firstUsefulTab(counts);

    els.tabs.forEach(function (btn) {
      var name = btn.dataset.tab;
      var on = name === tab;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.querySelector('.tab-count').textContent = counts[name] ? String(counts[name]) : '';
      btn.classList.toggle('is-empty', !counts[name]);
      /* The visible label is one word in small caps; spell the whole thing
         out for anyone listening to the page instead of looking at it. */
      btn.setAttribute('aria-label', tabAria(name, counts[name]));
    });
    moveTabInk(tab);
    els.panel.setAttribute('aria-labelledby', 'tab-' + tab);

    renderPanel(show, tab);

    if (show.notes) {
      els.showNotes.textContent = show.notes;
      els.showNotes.hidden = false;
    } else {
      els.showNotes.hidden = true;
    }
    stampText(els.showStamp);
  }

  function tabAria(name, count) {
    var word = name.charAt(0).toUpperCase() + name.slice(1);
    if (!count) return word + ' — nothing on here yet';
    return word + ' — ' + count + (count === 1 ? ' entry' : ' entries');
  }

  /* Open on the tab that actually has something in it — travel first,
     because that's the question you have first. */
  function firstUsefulTab(counts) {
    for (var i = 0; i < TABS.length; i++) if (counts[TABS[i]]) return TABS[i];
    return 'travel';
  }

  function moveTabInk(tab) {
    var index = TABS.indexOf(tab);
    if (index < 0) index = 0;
    els.tabInk.style.transform = 'translateX(' + (index * 100) + '%)';
  }

  function renderPanel(show, tab) {
    var items = itemsFor(app.data.items, show.id, tab);
    els.panel.textContent = '';
    els.panel.dataset.tab = tab;

    if (!items.length) {
      els.panel.appendChild(emptyPanel(tab));
      return;
    }

    /* Once the trip is actually underway, the page changes character: what's
       behind you goes quiet and the next thing is called out. Before that —
       a show five weeks away — nothing is marked, because nothing is "next"
       in any useful sense yet. */
    var stamp = nowStamp();
    var states = items.map(function (it) { return itemState(it, stamp); });
    var underway = states.indexOf('past') >= 0 || states.indexOf('now') >= 0;
    var nextIndex = underway ? firstLive(states) : -1;

    /* Backstage times read as one run-of-show, not as five separate cards. */
    var times = [], rest = [];
    items.forEach(function (it, i) {
      (it.kind === 'time' ? times : rest).push({ item: it, state: states[i], next: i === nextIndex });
    });

    if (times.length > 1) {
      els.panel.appendChild(runCard(times));
      rest.forEach(function (entry) { els.panel.appendChild(itemCard(entry)); });
    } else {
      times.concat(rest).sort(function (a, b) {
        return items.indexOf(a.item) - items.indexOf(b.item);
      }).forEach(function (entry) { els.panel.appendChild(itemCard(entry)); });
    }
  }

  function firstLive(states) {
    var now = states.indexOf('now');
    if (now >= 0) return now;
    return states.indexOf('future');
  }

  function emptyPanel(tab) {
    var p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = {
      travel: 'No travel on here yet. Send Edward the flight screenshot and it lands here.',
      hotel: 'No hotel on here yet. Send Edward the booking screenshot and it lands here.',
      backstage: 'No show times yet. Send Edward the advance and they land here.'
    }[tab] || 'Nothing here yet.';
    return p;
  }

  function runCard(entries) {
    var node = els.tplRun.content.firstElementChild.cloneNode(true);
    var list = node.querySelector('.run-list');
    entries.forEach(function (entry) {
      var it = entry.item;
      var li = document.createElement('li');
      li.className = 'run-row' + (entry.state === 'past' ? ' is-past' : '') +
                     (entry.next ? ' is-next' : '');

      var when = document.createElement('span');
      when.className = 'run-time';
      var t = fmtTime(it.start);
      when.textContent = t || fmtDay(it.start) || '—';
      li.appendChild(when);

      var body = document.createElement('span');
      body.className = 'run-body';
      var title = document.createElement('span');
      title.className = 'run-title';
      title.textContent = it.title;
      body.appendChild(title);

      var tail = [];
      if (it.end && fmtTime(it.end)) tail.push('until ' + fmtTime(it.end));
      if (it.subtitle) tail.push(it.subtitle);
      if (it.place) tail.push(it.place);
      if (tail.length) {
        var meta = document.createElement('span');
        meta.className = 'run-meta';
        meta.textContent = tail.join(' · ');
        body.appendChild(meta);
      }
      parseDetails(it.details).forEach(function (line) {
        var d = document.createElement('span');
        d.className = 'run-meta';
        d.textContent = line.label ? line.label + ': ' + line.value : line.text;
        body.appendChild(d);
      });
      li.appendChild(body);
      list.appendChild(li);
    });
    return node;
  }

  /* Named `entry`, not `row` — `row()` is the label/value helper below. */
  function itemCard(entry) {
    var it = entry.item;
    var node = els.tplItem.content.firstElementChild.cloneNode(true);
    node.classList.add('kind-' + (it.kind || 'note'));
    if (entry.state === 'past') node.classList.add('is-past');
    if (entry.next) node.classList.add('is-next');
    node.querySelector('.item-icon').textContent = KIND_ICON[it.kind] || KIND_ICON.note;
    node.querySelector('.item-title').textContent = it.title;

    var sub = node.querySelector('.item-sub');
    if (it.subtitle) { sub.textContent = it.subtitle; sub.hidden = false; }

    if (entry.next) {
      var tag = document.createElement('span');
      tag.className = 'next-tag';
      tag.textContent = 'next';
      node.querySelector('.item-head').appendChild(tag);
    }

    var when = whenLine(it);
    var whenNode = node.querySelector('.item-when');
    if (when) { whenNode.textContent = when; whenNode.hidden = false; }

    var rows = node.querySelector('.item-rows');
    if (it.place) rows.appendChild(row('Where', it.place, mapsUrl(it.place), 'map'));
    parseDetails(it.details).forEach(function (line) {
      rows.appendChild(line.label ? row(line.label, line.value) : freeRow(line.text));
    });
    if (it.link) {
      var href = safeLink(it.link);
      rows.appendChild(href ? row('Link', shortUrl(href), href) : row('Link', it.link));
    }

    var actions = node.querySelector('.item-actions');
    if (it.confirmation) actions.appendChild(copyButton(it.confirmation));
    var tel = telLink(it.phone);
    if (it.phone) {
      if (tel) actions.appendChild(linkButton('📞 ' + it.phone, tel));
      else actions.appendChild(plainChip('📞 ' + it.phone));
    }
    if (!actions.children.length) actions.remove();

    return node;
  }

  function row(label, value, href, hint) {
    var r = document.createElement('div');
    r.className = 'row';
    var l = document.createElement('span');
    l.className = 'row-label';
    l.textContent = label;
    r.appendChild(l);

    if (href) {
      var a = document.createElement('a');
      a.className = 'row-value is-link';
      a.href = href;
      a.rel = 'noopener noreferrer';
      if (/^https:/i.test(href)) a.target = '_blank';
      a.textContent = value;
      if (hint) {
        var tag = document.createElement('span');
        tag.className = 'row-hint';
        tag.textContent = hint;
        a.appendChild(tag);
      }
      r.appendChild(a);
    } else {
      var v = document.createElement('span');
      v.className = 'row-value';
      v.textContent = value;
      r.appendChild(v);
    }
    return r;
  }

  function freeRow(text) {
    var p = document.createElement('p');
    p.className = 'row-free';
    p.textContent = text;
    return p;
  }

  function shortUrl(href) {
    return String(href).replace(/^https:\/\//i, '').replace(/\/$/, '');
  }

  function plainChip(text) {
    var s = document.createElement('span');
    s.className = 'chip';
    s.textContent = text;
    return s;
  }

  function linkButton(text, href) {
    var a = document.createElement('a');
    a.className = 'chip is-action';
    a.href = href;
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    return a;
  }

  /* A confirmation number is only useful if you can get it into another app
     without retyping it at an airport counter. */
  function copyButton(value) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip is-action is-copy';
    b.textContent = '# ' + value;
    b.setAttribute('aria-label', 'Copy confirmation ' + value);
    b.addEventListener('click', function () {
      copyText(value).then(function (won) {
        toast(won ? 'copied ' + value : "couldn't copy — " + value);
        if (won) {
          b.classList.add('copied');
          setTimeout(function () { b.classList.remove('copied'); }, 900);
        }
      });
    });
    return b;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var won = document.execCommand('copy');
      document.body.removeChild(ta);
      return won;
    } catch (e) { return false; }
  }

  /* ── signing in ────────────────────────────────────────────────── */

  function loginMsg(text, bad) {
    if (!els.loginMsg) return;
    els.loginMsg.textContent = text || '';
    els.loginMsg.classList.toggle('is-bad', !!bad);
  }

  function submitLogin() {
    var password = els.loginPw.value;
    if (!password || app.signingIn) return;

    /* The stretching takes a second or two on a phone. Silence reads as
       broken, so the button says what it is doing. */
    app.signingIn = true;
    els.loginGo.disabled = true;
    els.loginGo.textContent = 'checking…';
    loginMsg('');

    /* Let the browser paint the "checking…" before the maths blocks it. */
    setTimeout(function () {
      deriveToken(password).then(function (token) {
        app.token = token;
        app.rejected = false;
        app.loadError = false;
        app.data = null;
        storeToken(token);
        return load().then(function (res) {
          if (res && res.ok) {
            app.data = {
              shows: Array.isArray(res.shows) ? res.shows : [],
              items: Array.isArray(res.items) ? res.items : [],
              generated: res.generated || ''
            };
            endLogin(true);
            ensurePoll();
            render();
          } else {
            forgetToken();
            app.token = null;
            endLogin(false);
            loginMsg('that password doesn\u2019t open this', true);
            render();
          }
        });
      }).catch(function (err) {
        forgetToken();
        app.token = null;
        endLogin(false);
        loginMsg(String(err && err.message) === 'no webcrypto'
          ? 'this browser can\u2019t unlock the page'
          : 'couldn\u2019t check that just now — try again', true);
        render();
      });
    }, 40);
  }

  function endLogin(won) {
    app.signingIn = false;
    els.loginGo.disabled = false;
    els.loginGo.textContent = 'open';
    if (won) {
      els.loginPw.value = '';
      loginMsg('');
    }
  }

  function forgetToken() {
    try { window.localStorage.removeItem('showsToken'); } catch (e) { /* fine */ }
  }

  /* ── init ──────────────────────────────────────────────────────── */

  function init() {
    els = {
      demoBanner: el('demo-banner'),
      viewList: el('view-list'),
      viewShow: el('view-show'),
      showList: el('show-list'),
      listEmpty: el('list-empty'),
      listStamp: el('list-stamp'),
      listRefresh: el('list-refresh'),
      showRefresh: el('show-refresh'),
      showTitle: el('show-title'),
      showSub: el('show-sub'),
      showWhen: el('show-when'),
      showNotes: el('show-notes'),
      showStamp: el('show-stamp'),
      panel: el('panel'),
      tabInk: el('tab-ink'),
      toast: el('toast'),
      loginForm: el('login-form'),
      loginPw: el('login-pw'),
      loginGo: el('login-go'),
      loginMsg: el('login-msg'),
      tplShowCard: el('tpl-show-card'),
      tplItem: el('tpl-item'),
      tplRun: el('tpl-run'),
      tabs: [].slice.call(document.querySelectorAll('.tab'))
    };

    el('back-btn').addEventListener('click', function () { go(null); });
    [els.listRefresh, els.showRefresh].forEach(function (b) {
      b.addEventListener('click', function () {
        if (app.demo) {
          setSpinning(true);
          setTimeout(function () { setSpinning(false); render(); }, 350);
        } else {
          refresh();
        }
      });
    });
    els.loginForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitLogin();
    });

    el('retry-btn').addEventListener('click', function () {
      app.loadError = false;
      render();
      refresh();
    });

    els.tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (app.route && app.route.showId) go(app.route.showId, btn.dataset.tab);
      });
    });

    window.addEventListener('hashchange', onRoute);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !app.demo) refresh();
    });

    onRoute();
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  /* Node test hook — pure helpers only. */
  if (typeof module !== 'undefined') {
    module.exports = {
      parseFragment: parseFragment,
      deriveToken: deriveToken,
      KDF: KDF,
      dayInfo: dayInfo,
      splitShows: splitShows,
      itemsFor: itemsFor,
      tabCounts: tabCounts,
      parseDetails: parseDetails,
      whenLine: whenLine,
      nowStamp: nowStamp,
      itemState: itemState,
      showDateLine: showDateLine,
      fmtDay: fmtDay,
      fmtTime: fmtTime,
      safeLink: safeLink,
      telLink: telLink,
      mapsUrl: mapsUrl,
      makeDemoData: makeDemoData
    };
  }
})();
