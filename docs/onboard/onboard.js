/* BandPeace onboarding preview — vanilla JS, no libraries.

   SECURITY BY DESIGN: there are NO username/password/API-key fields for any
   provider, anywhere, on purpose. "Connecting" opens a modal that explains
   the real OAuth-style flow (login happens at the provider; BandPeace only
   ever receives a revocable read-only token) and then SIMULATES the
   handshake. Step-1 band basics are stored in localStorage only — nothing
   leaves the device; nothing is submitted anywhere. */

(function () {
  "use strict";

  var STORE_KEY = "bandpeaceOnboardPreview";
  var TOTAL_STEPS = 6;

  // ── providers ──────────────────────────────────────────────────────
  var PROVIDERS = {
    distribution: [
      { id: "distrokid", name: "DistroKid", grabs: "monthly royalty statements, per-store streams" },
      { id: "symphonic", name: "Symphonic", grabs: "monthly royalty statements, per-store streams" },
      { id: "tunecore", name: "TuneCore", grabs: "monthly royalty statements, per-store streams" },
      { id: "cdbaby", name: "CD Baby", grabs: "monthly royalty statements, per-store streams" }
    ],
    publishing: [
      { id: "songtrust", name: "Songtrust", grabs: "performance + mechanical statements, admin fees" },
      { id: "ascap", name: "ASCAP", grabs: "performance + mechanical statements, admin fees" },
      { id: "bmi", name: "BMI", grabs: "performance + mechanical statements, admin fees" },
      { id: "soundexchange", name: "SoundExchange", grabs: "performance + mechanical statements, admin fees" }
    ],
    money: [
      { id: "bank", name: "Your bank", grabs: "read-only transactions for gig income + expenses" },
      { id: "venmo", name: "Venmo", grabs: "read-only transactions for gig income + expenses" },
      { id: "paypal", name: "PayPal", grabs: "read-only transactions for gig income + expenses" },
      { id: "zelle", name: "Zelle", grabs: "read-only transactions for gig income + expenses" },
      { id: "stripe", name: "Stripe", grabs: "read-only transactions for gig income + expenses" }
    ],
    stats: [
      { id: "quickbooks", name: "QuickBooks", grabs: "your chart of accounts (your expense categories) + categorized expenses" },
      { id: "spotify", name: "Spotify for Artists", grabs: "listener + stream stats" },
      { id: "youtube", name: "YouTube Studio", grabs: "channel + revenue stats" }
    ]
  };

  var PROVIDER_BY_ID = {};
  Object.keys(PROVIDERS).forEach(function (g) {
    PROVIDERS[g].forEach(function (p) { p.group = g; PROVIDER_BY_ID[p.id] = p; });
  });

  var GROUP_LABELS = {
    distribution: "Distribution",
    publishing: "Publishing & PROs",
    money: "Money accounts",
    stats: "Books & streams"
  };

  // ── state (localStorage only — preview stays on the device) ────────
  var state = { step: 1, basics: {}, connected: {} };

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        state.basics = saved.basics || {};
        state.connected = saved.connected || {};
      }
    } catch (e) { /* private mode etc. — preview works without persistence */ }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        basics: state.basics, connected: state.connected
      }));
    } catch (e) { /* ignore */ }
  }

  // ── provider cards ─────────────────────────────────────────────────
  function buildProviderGrids() {
    document.querySelectorAll(".provider-grid").forEach(function (grid) {
      var group = grid.dataset.group;
      PROVIDERS[group].forEach(function (p) {
        var card = document.createElement("article");
        card.className = "provider-card";
        card.dataset.provider = p.id;

        var h = document.createElement("h3");
        h.textContent = p.name;
        card.appendChild(h);
        if (p.sub) {
          var sub = document.createElement("p");
          sub.className = "provider-grabs";
          sub.style.minHeight = "0";
          sub.textContent = p.sub;
          card.appendChild(sub);
        }

        var grabs = document.createElement("p");
        grabs.className = "provider-grabs";
        grabs.textContent = "grabs: " + p.grabs;
        card.appendChild(grabs);

        var actions = document.createElement("div");
        actions.className = "provider-actions";

        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "provider-connect";
        btn.textContent = "Connect";
        btn.setAttribute("aria-label", "Connect " + p.name + " (simulated)");
        btn.addEventListener("click", function () { openModal(p); });
        actions.appendChild(btn);

        var status = document.createElement("span");
        status.className = "provider-status";
        actions.appendChild(status);

        var disc = document.createElement("button");
        disc.type = "button";
        disc.className = "provider-disconnect";
        disc.textContent = "Disconnect";
        disc.hidden = true;
        disc.addEventListener("click", function () {
          delete state.connected[p.id];
          save();
          syncCard(card, p);
          if (state.step === 6) renderPreview();
        });
        actions.appendChild(disc);

        card.appendChild(actions);
        grid.appendChild(card);
        syncCard(card, p);
      });
    });
  }

  function syncCard(card, p) {
    var ts = state.connected[p.id];
    var status = card.querySelector(".provider-status");
    var disc = card.querySelector(".provider-disconnect");
    if (ts) {
      card.classList.add("connected");
      status.textContent = "Connected · synced " + timeAgo(ts);
      disc.hidden = false;
    } else {
      card.classList.remove("connected");
      status.textContent = "";
      disc.hidden = true;
    }
  }

  function timeAgo(iso) {
    var mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    return Math.round(mins / 60) + " h ago";
  }

  // ── connect modal (the real-flow explanation) ──────────────────────
  var modal = document.getElementById("connect-modal");
  var modalProvider = null;

  function openModal(p) {
    modalProvider = p;
    document.getElementById("modal-provider").textContent = p.name;
    var body;
    if (p.id === "bank") {
      // the peak-anxiety step gets bespoke plain-English-first copy
      body = "This connection can READ statements and balances. It can never " +
        "move money — read-only by design, through a dedicated " +
        "bank-connection service (like Plaid).";
    } else {
      body = "In the live product this opens " + p.name + "'s own secure login page. " +
        "BandPeace never sees your password — " + p.name + " hands us a " +
        "read-only token that can only READ statements, and you can revoke it " +
        "there anytime.";
    }
    document.getElementById("modal-body").textContent = body;
    modal.showModal();
  }

  document.getElementById("modal-simulate").addEventListener("click", function () {
    if (modalProvider) {
      state.connected[modalProvider.id] = new Date().toISOString();
      save();
      var card = document.querySelector('.provider-card[data-provider="' + modalProvider.id + '"]');
      if (card) syncCard(card, modalProvider);
    }
    modal.close();
  });

  document.getElementById("modal-cancel").addEventListener("click", function () {
    modal.close();
  });

  modal.addEventListener("click", function (ev) {
    // click on the backdrop closes
    if (ev.target === modal) modal.close();
  });

  // ── step 1 form ────────────────────────────────────────────────────
  var FIELDS = ["name", "city", "genre", "members"];

  function wireBasics() {
    FIELDS.forEach(function (f) {
      var input = document.getElementById("f-" + f);
      input.value = state.basics[f] || "";
      input.addEventListener("input", function () {
        state.basics[f] = input.value;
        save();
      });
    });
  }

  // ── step 6 preview skeleton ────────────────────────────────────────
  function renderPreview() {
    var host = document.getElementById("preview-skeleton");
    host.textContent = "";

    var name = document.createElement("p");
    name.className = "pv-name";
    name.textContent = (state.basics.name || "Your Band").trim() || "Your Band";
    host.appendChild(name);

    var metaParts = [];
    if (state.basics.genre) metaParts.push(state.basics.genre.trim());
    if (state.basics.city) metaParts.push(state.basics.city.trim());
    var meta = document.createElement("p");
    meta.className = "pv-meta";
    meta.textContent = metaParts.length ? metaParts.join(" · ")
                                        : "genre · city (from step 1)";
    host.appendChild(meta);

    var members = (state.basics.members || "").split(",")
      .map(function (m) { return m.trim(); }).filter(Boolean);
    if (members.length) {
      var mrow = document.createElement("div");
      mrow.className = "pv-members";
      members.forEach(function (m) {
        var chip = document.createElement("span");
        chip.className = "pv-member";
        chip.textContent = m;
        mrow.appendChild(chip);
      });
      host.appendChild(mrow);
    }

    var srcWrap = document.createElement("div");
    srcWrap.className = "pv-sources";
    var sh = document.createElement("h4");
    sh.textContent = "Connected sources";
    srcWrap.appendChild(sh);
    var list = document.createElement("ul");
    list.className = "pv-source-list";
    var ids = Object.keys(state.connected);
    if (ids.length) {
      ids.forEach(function (id) {
        var p = PROVIDER_BY_ID[id];
        if (!p) return;
        var li = document.createElement("li");
        li.textContent = p.name + " · " + GROUP_LABELS[p.group];
        list.appendChild(li);
      });
    } else {
      var none = document.createElement("li");
      none.className = "pv-none";
      none.textContent = "no sources connected yet — go back and simulate a few";
      list.appendChild(none);
    }
    srcWrap.appendChild(list);
    host.appendChild(srcWrap);

    var blocks = document.createElement("div");
    blocks.className = "pv-blocks";
    [
      "P&L dashboard builds here — lanes, filters, net-profit curve",
      "Royalty Map builds here — collectors, cuts, delays",
      "Tax cards build here — bridges + quarterly set-aside",
      "Open-books downloads build here — xlsx, csv, json"
    ].forEach(function (t) {
      var b = document.createElement("div");
      b.className = "pv-block";
      b.textContent = t;
      blocks.appendChild(b);
    });
    host.appendChild(blocks);
  }

  // ── wizard navigation ──────────────────────────────────────────────
  function goTo(step, focusHeading) {
    state.step = Math.min(TOTAL_STEPS, Math.max(1, step));
    document.querySelectorAll(".step-panel").forEach(function (panel) {
      panel.hidden = parseInt(panel.dataset.step, 10) !== state.step;
    });
    document.querySelectorAll("#progress-steps button").forEach(function (b) {
      if (parseInt(b.dataset.step, 10) === state.step) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    document.getElementById("progress-fill").style.width =
      (state.step / TOTAL_STEPS * 100) + "%";
    document.getElementById("wizard-pos").textContent =
      "Step " + state.step + " of " + TOTAL_STEPS;
    document.getElementById("btn-back").disabled = state.step === 1;
    document.getElementById("btn-next").textContent =
      state.step === TOTAL_STEPS ? "Start over" : "Next →";
    if (state.step === TOTAL_STEPS) renderPreview();
    if (focusHeading) {
      var h = document.querySelector('.step-panel[data-step="' + state.step + '"] .step-h');
      if (h) h.focus();
    }
  }

  document.getElementById("btn-back").addEventListener("click", function () {
    goTo(state.step - 1, true);
  });

  document.getElementById("btn-next").addEventListener("click", function () {
    if (state.step === TOTAL_STEPS) goTo(1, true);
    else goTo(state.step + 1, true);
  });

  document.querySelectorAll("#progress-steps button").forEach(function (b) {
    b.addEventListener("click", function () {
      goTo(parseInt(b.dataset.step, 10), true);
    });
  });

  // arrow keys move between steps (unless typing in a field or in the modal)
  document.addEventListener("keydown", function (ev) {
    if (modal.open) return;
    var t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (ev.key === "ArrowRight") { goTo(state.step + 1, true); }
    else if (ev.key === "ArrowLeft") { goTo(state.step - 1, true); }
  });

  // ── boot ───────────────────────────────────────────────────────────
  load();
  buildProviderGrids();
  wireBasics();
  goTo(1, false);
})();
