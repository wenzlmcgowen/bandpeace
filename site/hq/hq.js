/* Psycho Panda HQ — board logic.
   Plain vanilla JS, no build step, no frameworks, no CDNs.

   The pure helpers up top (parseFragment, deadlineInfo, sortTasks, buildViews)
   are exported for Node unit tests; everything that touches the DOM lives
   behind init(), which only runs in a browser.

   Security shape: the path is boring, the key rides in the URL fragment
   (#pp…) and never reaches a server log. The real gate is the Apps Script
   engine checking the token on every call — this page just behaves politely
   when the key is missing or wrong (it shows nothing). */

(function () {
  'use strict';

  /* ── constants ─────────────────────────────────────────────────── */

  var TOKEN_RE = /^pp[A-Za-z0-9]{40,}$/;
  var LA_TZ = 'America/Los_Angeles';
  var DAY_MS = 86400000;
  var OLD_DONE_DAYS = 14;
  var POLL_MS = 60000;
  var FLIP_HOLD_MS = 420;

  /* ── pure helpers (unit-tested in Node) ────────────────────────── */

  /* parseFragment("#pp…"), ("#pp…/wenzl"), ("#demo"), ("#demo/alex")
     → { demo, token, view } — view is a lowercased slug or null (landing).
     Anything malformed → null. */
  function parseFragment(hash) {
    var h = String(hash == null ? '' : hash);
    if (h.charAt(0) === '#') h = h.slice(1);
    try { h = decodeURIComponent(h); } catch (e) { /* keep raw */ }
    if (!h) return null;
    var parts = h.split('/');
    if (parts.length > 2) return null;
    var head = parts[0];
    var view = (parts.length === 2 && parts[1]) ? parts[1].toLowerCase() : null;
    if (head === 'demo') return { demo: true, token: null, view: view };
    if (TOKEN_RE.test(head)) return { demo: false, token: head, view: view };
    return null;
  }

  /* LA calendar date of a Date, as UTC-midnight millis (DST-safe day math). */
  function laDayMillis(date) {
    var s = new Intl.DateTimeFormat('en-CA', {
      timeZone: LA_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }

  /* deadlineInfo("2026-08-24", now) → { label, overdue, days } or null.
     Day-granular in America/Los_Angeles: "Today" means the LA calendar
     date matches. days = deadline minus LA-today, in whole days. */
  function deadlineInfo(deadline, now) {
    if (!deadline) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(deadline));
    if (!m) return null;
    var target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var nowDate = now instanceof Date ? now : (now ? new Date(now) : new Date());
    if (isNaN(nowDate.getTime())) nowDate = new Date();
    var today = laDayMillis(nowDate);
    var days = Math.round((target - today) / DAY_MS);
    var overdue = days < 0;
    var label;
    if (days === 0) {
      label = 'Today';
    } else if (days === 1) {
      label = 'Tomorrow';
    } else if (overdue) {
      label = (-days) + (days === -1 ? ' day overdue' : ' days overdue');
    } else {
      var d = new Date(target);
      var wk = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(d);
      var mo = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(d);
      label = wk + ' ' + mo + ' ' + (+m[3]);
    }
    return { label: label, overdue: overdue, days: days };
  }

  function priorityOf(task) {
    var n = parseInt(task && task.priority, 10);
    return isNaN(n) ? 99 : n;
  }

  function hasDeadline(task) {
    return !!(task && task.deadline && /^\d{4}-\d{2}-\d{2}/.test(String(task.deadline)));
  }

  function cmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  /* Canonical open-card order (same words live in board.md for Panda):
     1. 🔥 pinned (priority 0) — among them deadline asc (empty last), then created asc
     2. dated — deadline asc, tie: priority asc, then created asc
     3. undated — priority asc (empty = 99), tie: created asc */
  function openCompare(a, b) {
    var groupA = priorityOf(a) === 0 ? 0 : (hasDeadline(a) ? 1 : 2);
    var groupB = priorityOf(b) === 0 ? 0 : (hasDeadline(b) ? 1 : 2);
    if (groupA !== groupB) return groupA - groupB;
    var dlA = hasDeadline(a) ? String(a.deadline).slice(0, 10) : '9999-99-99';
    var dlB = hasDeadline(b) ? String(b.deadline).slice(0, 10) : '9999-99-99';
    if (groupA === 0) {
      return cmp(dlA, dlB) || cmp(String(a.created || ''), String(b.created || ''));
    }
    if (groupA === 1) {
      return cmp(dlA, dlB) || (priorityOf(a) - priorityOf(b)) ||
             cmp(String(a.created || ''), String(b.created || ''));
    }
    return (priorityOf(a) - priorityOf(b)) ||
           cmp(String(a.created || ''), String(b.created || ''));
  }

  /* Done cards: freshest first. */
  function doneCompare(a, b) {
    return cmp(String(b.done_at || ''), String(a.done_at || '')) ||
           cmp(String(b.created || ''), String(a.created || ''));
  }

  /* sortTasks(tasks, view) → one flat array, exactly the card stack top to
     bottom: open cards in canonical order, then done cards (done_at desc).
     view filters owner by lowercased name; 'master' (or empty) = everyone. */
  function sortTasks(tasks, view) {
    var v = String(view || 'master').toLowerCase();
    var pool = (Array.isArray(tasks) ? tasks : []).filter(function (t) {
      if (!t) return false;
      if (v === 'master') return true;
      return String(t.owner || '').toLowerCase() === v;
    });
    var open = pool.filter(function (t) { return t.status !== 'done'; }).sort(openCompare);
    var done = pool.filter(function (t) { return t.status === 'done'; }).sort(doneCompare);
    return open.concat(done);
  }

  /* buildViews(team, tasks, now) → the landing tiles, Master first:
     [{ slug, name, emoji, open, overdue }]. `open` counts open cards on that
     view; `overdue` is true when any of them is past its deadline. */
  function buildViews(team, tasks, now) {
    var views = [{ slug: 'master', name: 'Master', emoji: '🐼' }];
    (Array.isArray(team) ? team : []).forEach(function (member) {
      if (!member || !member.name) return;
      views.push({
        slug: String(member.name).toLowerCase(),
        name: String(member.name),
        emoji: member.emoji ? String(member.emoji) : '•'
      });
    });
    views.forEach(function (view) {
      var open = sortTasks(tasks, view.slug).filter(function (t) { return t.status !== 'done'; });
      view.open = open.length;
      view.overdue = open.some(function (t) {
        var info = deadlineInfo(t.deadline, now);
        return !!(info && info.overdue);
      });
    });
    return views;
  }

  /* ── demo data (obviously fake — Alex & Sam, everything "(demo)") ── */

  function makeDemoData(now) {
    var base = now instanceof Date ? now : new Date();
    var todayUtc = laDayMillis(base);
    function ymd(offsetDays) {
      var d = new Date(todayUtc + offsetDays * DAY_MS);
      var mm = String(d.getUTCMonth() + 1); if (mm.length < 2) mm = '0' + mm;
      var dd = String(d.getUTCDate()); if (dd.length < 2) dd = '0' + dd;
      return d.getUTCFullYear() + '-' + mm + '-' + dd;
    }
    function iso(offsetDays) {
      return new Date(base.getTime() + offsetDays * DAY_MS).toISOString();
    }
    function task(id, title, owner, opts) {
      return Object.assign({
        id: id, title: title, details: '', owner: owner, deadline: '',
        priority: '', status: 'open', created: iso(-9), updated: iso(-9),
        done_at: '', source: 'seed', notes: ''
      }, opts || {});
    }
    return {
      team: [
        { name: 'Alex', emoji: '🎸' },
        { name: 'Sam', emoji: '🥁' }
      ],
      tasks: [
        task('PP-1', 'Book the fog machine (demo)', 'Alex', {
          deadline: ymd(0), priority: 0, created: iso(-8),
          details: 'The party needs fog. Thick, dramatic, panda-grade fog.\nDemo data — nothing here is real.'
        }),
        task('PP-2', 'Send the flyer to print (demo)', 'Sam', {
          deadline: ymd(-3), priority: 1, created: iso(-7),
          notes: 'Print shop closes at 6pm. (Fake note for the demo.)'
        }),
        task('PP-3', 'Confirm DJ set times (demo)', 'Alex', {
          deadline: ymd(0), priority: 2, created: iso(-6)
        }),
        task('PP-4', 'Pick up the wristbands (demo)', 'Team', {
          deadline: ymd(1), created: iso(-5),
          details: 'Two boxes, front desk. Ask for “the panda order”. (Demo.)'
        }),
        task('PP-5', 'Post the ticket link (demo)', 'Sam', {
          deadline: ymd(7), priority: 1, created: iso(-4)
        }),
        task('PP-6', 'Find a photographer (demo)', 'Alex', {
          priority: 1, created: iso(-6)
        }),
        task('PP-7', 'Dream up the next theme (demo)', 'Team', {
          created: iso(-3)
        }),
        task('PP-8', 'Reserve the venue (demo)', 'Alex', {
          status: 'done', done_at: iso(-1), created: iso(-9)
        }),
        task('PP-9', 'Make the group chat (demo)', 'Sam', {
          status: 'done', done_at: iso(-2), created: iso(-9)
        }),
        task('PP-10', 'Choose the brand colors (demo)', 'Alex', {
          status: 'done', done_at: iso(-20), created: iso(-24)
        })
      ]
    };
  }

  /* ═══════════════════════════ browser app ═══════════════════════════
     Everything below only runs inside init(), i.e. in a real browser. */

  var app = {
    route: null,      // parsed fragment (or null)
    token: null,      // effective token (fragment or stored)
    demo: false,
    data: null,       // { team, tasks }
    rejected: false,  // engine said ok:false → behave like "nothing here"
    fetching: false,
    loadError: false,
    showOlder: false,
    openDrawers: {},  // task id → true
    busy: {},         // task id → write in flight
    tempSeq: 0,
    pollTimer: null
  };

  var els = {};

  function el(id) { return document.getElementById(id); }

  function apiUrl() {
    var cfg = (typeof window !== 'undefined' && window.PP_CONFIG) || {};
    return typeof cfg.apiUrl === 'string' ? cfg.apiUrl.trim() : '';
  }

  function prefersReduced() {
    return !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function readStoredToken() {
    try {
      var t = window.localStorage.getItem('ppToken');
      return (t && TOKEN_RE.test(t)) ? t : null;
    } catch (e) { return null; }
  }

  function storeToken(token) {
    try { window.localStorage.setItem('ppToken', token); } catch (e) { /* fine */ }
  }

  /* ── engine (live ⇄ demo) ──────────────────────────────────────── */
  /* Live POSTs go out as text/plain (no custom headers → no CORS
     preflight; Apps Script reads e.postData.contents) and follow the
     302 to script.googleusercontent.com. */

  function liveList() {
    return fetch(apiUrl() + '?token=' + encodeURIComponent(app.token) + '&action=list', {
      method: 'GET', redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }

  function livePost(payload) {
    payload.token = app.token;
    return fetch(apiUrl(), {
      method: 'POST', body: JSON.stringify(payload), redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }

  function demoReply(make) {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(make()); }, 120);
    });
  }

  function demoFind(id) {
    return app.data.tasks.filter(function (t) { return t.id === id; })[0] || null;
  }

  var engine = {
    list: function () {
      if (app.demo) {
        return demoReply(function () {
          return { ok: true, team: app.data.team, tasks: app.data.tasks };
        });
      }
      return liveList();
    },
    done: function (id) {
      if (app.demo) {
        return demoReply(function () {
          var t = demoFind(id);
          if (!t) return { ok: false, error: 'no such task' };
          t.status = 'done';
          t.done_at = t.done_at || new Date().toISOString();
          return { ok: true, task: Object.assign({}, t) };
        });
      }
      return livePost({ action: 'done', id: id });
    },
    reopen: function (id) {
      if (app.demo) {
        return demoReply(function () {
          var t = demoFind(id);
          if (!t) return { ok: false, error: 'no such task' };
          t.status = 'open';
          t.done_at = '';
          return { ok: true, task: Object.assign({}, t) };
        });
      }
      return livePost({ action: 'reopen', id: id });
    },
    add: function (fields) {
      if (app.demo) {
        return demoReply(function () {
          var maxN = 0;
          app.data.tasks.forEach(function (t) {
            var m = /^PP-(\d+)$/.exec(t.id);
            if (m && +m[1] > maxN) maxN = +m[1];
          });
          var t = {
            id: 'PP-' + (maxN + 1),
            title: fields.title, details: fields.details || '',
            owner: fields.owner || 'Team', deadline: fields.deadline || '',
            priority: '', status: 'open',
            created: new Date().toISOString(), updated: new Date().toISOString(),
            done_at: '', source: fields.source || 'board', notes: ''
          };
          return { ok: true, task: t };
        });
      }
      return livePost(Object.assign({ action: 'add' }, fields));
    }
  };

  function mergeTask(serverTask) {
    if (!serverTask || !app.data) return;
    var tasks = app.data.tasks;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === serverTask.id) { tasks[i] = serverTask; return; }
    }
    tasks.push(serverTask);
  }

  /* ── fetching / polling ────────────────────────────────────────── */

  function refresh() {
    if (app.demo || !app.token || !apiUrl() || app.rejected) return;
    if (app.fetching) return;
    app.fetching = true;
    setSpinning(true);
    engine.list().then(function (res) {
      app.fetching = false;
      setSpinning(false);
      if (res && res.ok) {
        app.data = {
          team: Array.isArray(res.team) ? res.team : [],
          tasks: Array.isArray(res.tasks) ? res.tasks : []
        };
        app.loadError = false;
        render();
      } else {
        /* Wrong key → the same nothing a stranger sees. */
        app.rejected = true;
        render();
      }
    }).catch(function () {
      app.fetching = false;
      setSpinning(false);
      if (app.data) {
        toast("can't reach the board");
      } else {
        app.loadError = true;
        render();
      }
    });
  }

  function ensurePoll() {
    var want = !app.demo && !!app.token && !!apiUrl() && !app.rejected;
    if (want && !app.pollTimer) {
      app.pollTimer = setInterval(function () {
        if (!document.hidden) refresh();
      }, POLL_MS);
    } else if (!want && app.pollTimer) {
      clearInterval(app.pollTimer);
      app.pollTimer = null;
    }
  }

  function setSpinning(on) {
    if (els.refreshBtn) els.refreshBtn.classList.toggle('spinning', !!on);
  }

  /* ── routing ───────────────────────────────────────────────────── */

  function onRoute() {
    var parsed = parseFragment(window.location.hash);
    var rawEmpty = !String(window.location.hash).replace(/^#/, '');

    if (!parsed && rawEmpty) {
      /* Some apps strip fragments — fall back to the remembered key. */
      var stored = readStoredToken();
      if (stored) parsed = { demo: false, token: stored, view: null };
    }

    var prevToken = app.token;
    var prevDemo = app.demo;

    app.route = parsed;
    app.demo = !!(parsed && parsed.demo);
    app.token = (parsed && parsed.token) || null;

    if (app.token) storeToken(app.token);
    if (app.token !== prevToken) { app.rejected = false; app.loadError = false; }

    if (app.demo) {
      if (!prevDemo || !app.data) app.data = makeDemoData();
    } else if (prevDemo) {
      app.data = null; /* leaving demo: fake data never bleeds into live */
    }

    if (!app.demo && app.token && apiUrl() && !app.data && !app.loadError) refresh();
    ensurePoll();
    render();
  }

  function baseFragment() {
    return app.demo ? 'demo' : (app.token || '');
  }

  function go(viewSlug) {
    var frag = baseFragment();
    if (!frag) return;
    if (viewSlug) frag += '/' + encodeURIComponent(viewSlug);
    if ('#' + frag === window.location.hash) return;
    window.location.hash = frag;
  }

  /* ── rendering ─────────────────────────────────────────────────── */

  var SECTIONS = ['state-tease', 'state-noengine', 'state-loading',
                  'state-retry', 'view-landing', 'view-board'];

  function show(id) {
    SECTIONS.forEach(function (s) { el(s).hidden = (s !== id); });
  }

  function render() {
    document.body.classList.toggle('demo', app.demo);
    els.demoBanner.hidden = !app.demo;

    if (!app.demo && (!app.token || app.rejected)) { show('state-tease'); return; }
    if (!app.demo && !apiUrl()) { show('state-noengine'); return; }
    if (!app.data) { show(app.loadError ? 'state-retry' : 'state-loading'); return; }

    var views = buildViews(app.data.team, app.data.tasks);
    var slug = app.route && app.route.view;
    var view = null;
    if (slug) {
      view = views.filter(function (v) { return v.slug === slug; })[0] || null;
    }
    if (view) renderBoard(view);
    else renderLanding(views);
  }

  function renderLanding(views) {
    show('view-landing');
    var grid = els.tileGrid;
    grid.textContent = '';
    views.forEach(function (view) {
      var node = els.tplTile.content.firstElementChild.cloneNode(true);
      node.querySelector('.tile-emoji').textContent = view.emoji;
      node.querySelector('.tile-name').textContent = view.name;
      var badge = node.querySelector('.tile-badge');
      if (view.open > 0) {
        badge.hidden = false;
        badge.textContent = view.open;
        badge.classList.toggle('pulse', !!view.overdue);
      }
      node.addEventListener('click', function () { go(view.slug); });
      grid.appendChild(node);
    });
  }

  function renderBoard(view) {
    show('view-board');
    els.boardTitle.textContent = view.emoji + ' ' + view.name;
    els.boardTitle.dataset.slug = view.slug;

    var stack = els.cardStack;
    stack.textContent = '';

    var sorted = sortTasks(app.data.tasks, view.slug);
    var open = sorted.filter(function (t) { return t.status !== 'done'; });
    var done = sorted.filter(function (t) { return t.status === 'done'; });

    /* "Older than two weeks" is measured in LA calendar days, matching every
       other piece of day-math on the board (and Panda's tool). */
    var todayLA = laDayMillis(new Date());
    var recent = [], older = [];
    done.forEach(function (t) {
      var ts = Date.parse(t.done_at || '');
      var days = isNaN(ts) ? 0 : Math.round((todayLA - laDayMillis(new Date(ts))) / DAY_MS);
      if (!isNaN(ts) && days > OLD_DONE_DAYS) older.push(t); else recent.push(t);
    });

    if (!open.length && !done.length) {
      var empty = document.createElement('div');
      empty.className = 'stack-empty';
      empty.innerHTML = '<span class="big">🐼</span>';
      empty.appendChild(document.createTextNode('nothing on the board yet — tap + to add the first task.'));
      stack.appendChild(empty);
      return;
    }

    open.forEach(function (t) { stack.appendChild(renderCard(t, view)); });

    if (!open.length) {
      var clear = document.createElement('div');
      clear.className = 'stack-empty';
      clear.innerHTML = '<span class="big">✨</span>';
      clear.appendChild(document.createTextNode('all clear — nothing open.'));
      stack.appendChild(clear);
    }

    if (done.length) {
      stack.appendChild(els.tplDivider.content.firstElementChild.cloneNode(true));
      recent.forEach(function (t) { stack.appendChild(renderCard(t, view)); });
      if (app.showOlder) older.forEach(function (t) { stack.appendChild(renderCard(t, view)); });
      if (older.length) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'older-toggle';
        btn.textContent = app.showOlder
          ? 'hide older ✓'
          : 'show older ✓ (' + older.length + ')';
        btn.addEventListener('click', function () {
          app.showOlder = !app.showOlder;
          render();
        });
        stack.appendChild(btn);
      }
    }
  }

  function renderCard(task, view) {
    var node = els.tplCard.content.firstElementChild.cloneNode(true);
    var isDone = task.status === 'done';
    node.classList.add(isDone ? 'done' : 'open');
    node.dataset.id = task.id;

    node.querySelector('.card-title').textContent = task.title || '(untitled)';

    var chips = node.querySelector('.card-chips');
    function chip(text, cls) {
      var c = document.createElement('span');
      c.className = 'chip' + (cls ? ' ' + cls : '');
      c.textContent = text;
      chips.appendChild(c);
    }
    if (!isDone) {
      if (priorityOf(task) === 0) chip('🔥', 'fire');
      var info = deadlineInfo(task.deadline);
      if (info) chip(info.label, info.overdue ? 'overdue' : '');
    }
    if (view.slug === 'master' && task.owner) chip(task.owner, 'owner');

    var stamp = node.querySelector('.card-stamp');
    if (isDone) {
      stamp.hidden = false;
      stamp.textContent = doneStamp(task.done_at);
    }

    /* details drawer — only when there's something to show */
    var body = node.querySelector('.card-body');
    var drawer = node.querySelector('.card-drawer');
    var hasExtra = !!(task.details || task.notes);
    if (hasExtra) {
      if (task.details) {
        var dEl = drawer.querySelector('.drawer-details');
        dEl.hidden = false;
        dEl.textContent = String(task.details);
      }
      if (task.notes) {
        var nEl = drawer.querySelector('.drawer-notes');
        nEl.hidden = false;
        nEl.textContent = String(task.notes);
      }
      drawer.querySelector('.drawer-meta').textContent =
        (task.id || '') + (task.source ? ' · ' + task.source : '');
      drawer.hidden = !app.openDrawers[task.id];
      var toggleDrawer = function () {
        app.openDrawers[task.id] = !app.openDrawers[task.id];
        drawer.hidden = !app.openDrawers[task.id];
      };
      body.addEventListener('click', toggleDrawer);
      body.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleDrawer(); }
      });
    } else {
      body.setAttribute('data-static', '');
      body.removeAttribute('role');
      body.removeAttribute('tabindex');
    }

    var circle = node.querySelector('.done-circle');
    circle.setAttribute('aria-label', isDone
      ? 'Reopen: ' + (task.title || task.id)
      : 'Mark done: ' + (task.title || task.id));
    circle.addEventListener('click', function () {
      if (isDone) doReopen(task); else doDone(task, node);
    });

    return node;
  }

  function doneStamp(doneAt) {
    var ts = Date.parse(doneAt || '');
    if (isNaN(ts)) return 'done';
    var s = new Intl.DateTimeFormat('en-US', {
      timeZone: LA_TZ, weekday: 'short', hour: 'numeric',
      minute: '2-digit', hour12: true
    }).format(new Date(ts));
    /* "Mon, 2:14 PM" → "done Mon 2:14pm" */
    return 'done ' + s.replace(',', '').replace(/\s?(AM|PM)$/, function (m0) {
      return m0.trim().toLowerCase();
    });
  }

  /* ── writes (optimistic, revert on failure) ────────────────────── */

  function doDone(task, cardEl) {
    if (app.busy[task.id]) return;
    app.busy[task.id] = true;
    var prev = { status: task.status, done_at: task.done_at || '' };

    var commit = function () {
      task.status = 'done';
      task.done_at = new Date().toISOString();
      delete app.openDrawers[task.id];
      rerenderWithFlip();
      engine.done(task.id).then(function (res) {
        delete app.busy[task.id];
        if (res && res.ok) {
          if (res.task) mergeTask(res.task);
          render();
        } else {
          task.status = prev.status; task.done_at = prev.done_at;
          render();
          toast("that didn't save — try again");
        }
      }).catch(function () {
        delete app.busy[task.id];
        task.status = prev.status; task.done_at = prev.done_at;
        render();
        toast("can't reach the board");
      });
    };

    if (cardEl && !prefersReduced()) {
      cardEl.classList.add('flipping');
      setTimeout(commit, FLIP_HOLD_MS);
    } else {
      commit();
    }
  }

  function doReopen(task) {
    if (app.busy[task.id]) return;
    app.busy[task.id] = true;
    var prev = { status: task.status, done_at: task.done_at || '' };
    task.status = 'open';
    task.done_at = '';
    rerenderWithFlip();
    engine.reopen(task.id).then(function (res) {
      delete app.busy[task.id];
      if (res && res.ok) {
        if (res.task) mergeTask(res.task);
        render();
      } else {
        task.status = prev.status; task.done_at = prev.done_at;
        render();
        toast("that didn't save — try again");
      }
    }).catch(function () {
      delete app.busy[task.id];
      task.status = prev.status; task.done_at = prev.done_at;
      render();
      toast("can't reach the board");
    });
  }

  function submitAdd() {
    var title = els.addTitle.value.trim();
    if (!title) { els.addTitle.focus(); return; }
    var fields = {
      title: title,
      owner: els.addOwner.value || 'Team',
      deadline: els.addDeadline.value || '',
      source: 'board'
    };
    closeSheet();

    /* optimistic insert with a temp id, swapped for the real PP-n on reply */
    var temp = {
      id: 'tmp-' + (++app.tempSeq),
      title: fields.title, details: '', owner: fields.owner,
      deadline: fields.deadline, priority: '', status: 'open',
      created: new Date().toISOString(), updated: new Date().toISOString(),
      done_at: '', source: 'board', notes: ''
    };
    app.data.tasks.push(temp);
    render();

    engine.add(fields).then(function (res) {
      var idx = app.data.tasks.indexOf(temp);
      if (res && res.ok && res.task) {
        if (idx >= 0) app.data.tasks[idx] = res.task; else mergeTask(res.task);
        render();
      } else {
        if (idx >= 0) app.data.tasks.splice(idx, 1);
        render();
        toast("that didn't save — try again");
      }
    }).catch(function () {
      var idx = app.data.tasks.indexOf(temp);
      if (idx >= 0) app.data.tasks.splice(idx, 1);
      render();
      toast("can't reach the board");
    });
  }

  /* ── FLIP: cards glide to their new spot instead of teleporting ── */

  function rerenderWithFlip() {
    if (prefersReduced() || els.viewBoard.hidden) { render(); return; }
    var before = {};
    els.cardStack.querySelectorAll('.card').forEach(function (c) {
      before[c.dataset.id] = c.getBoundingClientRect().top;
    });
    render();
    els.cardStack.querySelectorAll('.card').forEach(function (c) {
      var prevTop = before[c.dataset.id];
      if (prevTop == null) return;
      var delta = prevTop - c.getBoundingClientRect().top;
      if (Math.abs(delta) < 2) return;
      c.style.transition = 'none';
      c.style.transform = 'translateY(' + delta + 'px)';
      requestAnimationFrame(function () {
        c.style.transition = 'transform 0.32s cubic-bezier(0.2, 0.8, 0.3, 1)';
        c.style.transform = '';
        setTimeout(function () { c.style.transition = ''; }, 360);
      });
    });
  }

  /* ── add sheet ─────────────────────────────────────────────────── */

  function openSheet() {
    var slug = els.boardTitle.dataset.slug || 'master';
    var select = els.addOwner;
    select.textContent = '';
    var names = ['Team'];
    (app.data.team || []).forEach(function (m) {
      if (m && m.name && names.indexOf(m.name) < 0) names.push(m.name);
    });
    var preselect = 'Team';
    names.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
      if (name.toLowerCase() === slug) preselect = name;
    });
    select.value = preselect;
    els.addTitle.value = '';
    els.addDeadline.value = '';
    els.sheetBackdrop.hidden = false;
    els.addTitle.focus();
  }

  function closeSheet() {
    els.sheetBackdrop.hidden = true;
  }

  /* ── toast ─────────────────────────────────────────────────────── */

  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 2800);
  }

  /* ── boot ──────────────────────────────────────────────────────── */

  function init() {
    els = {
      demoBanner: el('demo-banner'),
      tileGrid: el('tile-grid'),
      boardTitle: el('board-title'),
      cardStack: el('card-stack'),
      refreshBtn: el('refresh-btn'),
      viewBoard: el('view-board'),
      sheetBackdrop: el('sheet-backdrop'),
      addSheet: el('add-sheet'),
      addTitle: el('add-title'),
      addDeadline: el('add-deadline'),
      addOwner: el('add-owner'),
      toast: el('toast'),
      tplTile: el('tpl-tile'),
      tplCard: el('tpl-card'),
      tplDivider: el('tpl-divider')
    };

    el('back-btn').addEventListener('click', function () { go(null); });
    el('refresh-btn').addEventListener('click', function () {
      if (app.demo) {
        setSpinning(true);
        setTimeout(function () { setSpinning(false); render(); }, 400);
      } else {
        refresh();
      }
    });
    el('retry-btn').addEventListener('click', function () {
      app.loadError = false;
      render();
      refresh();
    });
    el('add-btn').addEventListener('click', openSheet);
    el('sheet-cancel').addEventListener('click', closeSheet);
    els.sheetBackdrop.addEventListener('click', function (ev) {
      if (ev.target === els.sheetBackdrop) closeSheet();
    });
    els.addSheet.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitAdd();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !els.sheetBackdrop.hidden) closeSheet();
    });

    window.addEventListener('hashchange', onRoute);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
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
      sortTasks: sortTasks,
      deadlineInfo: deadlineInfo,
      parseFragment: parseFragment,
      buildViews: buildViews
    };
  }
})();
