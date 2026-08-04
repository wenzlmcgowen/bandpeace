/* BandPeace demo dashboard — vanilla JS, no libraries.
   Reads site/data.json (simulated bandsim output) and renders a stacked
   bar chart (hand-rolled SVG), a numbers table, and Schedule C cards. */

(function () {
  "use strict";

  // series colors — must match the validated palette in style.css (--s1..--s8)
  var COLORS = {
    "Streaming royalties": "#3987e5",
    "Publishing": "#d95926",
    "Sync licensing": "#199e70",
    "Other royalties": "#c98500",
    "Live shows": "#d55181",
    "Merch — online": "#008300",
    "Merch — in person": "#9085e9",
    "Other income": "#e66767"
  };

  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var state = {
    view: "monthly",          // "monthly" | "yearly"
    year: 2026,
    // Explicitly picked lanes. EMPTY = "All" (every lane shown).
    // Isolate-on-click: picking a lane from "All" shows ONLY that lane;
    // picking more lanes adds them; unpicking the last returns to All.
    selected: new Set(),
    data: null
  };

  // zero-lanes kept on purpose (honest zeros beat decorative data)
  var ZERO_LANE_NOTES = {
    "Merch — in person": "no in-person merch this period",
    "Other income": "no other income this period"
  };

  // ── formatting ─────────────────────────────────────────────────────
  function fmt(n) {
    var sign = n < 0 ? "−" : "";
    return sign + "$" + Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 0, maximumFractionDigits: 0
    });
  }
  function fmtAxis(n) {
    if (Math.abs(n) >= 1000) return (n < 0 ? "−" : "") + "$" + (Math.abs(n) / 1000) + "k";
    return (n < 0 ? "−" : "") + "$" + Math.abs(n);
  }

  // ── data shaping ───────────────────────────────────────────────────
  // returns [{label, key, byCat:{cat:amount}, incomeAll, expenses, net}]
  function periods() {
    var d = state.data;
    var cats = d.categories;
    var out = [];

    function blank(label, key) {
      var byCat = {};
      cats.forEach(function (c) { byCat[c] = 0; });
      return { label: label, key: key, byCat: byCat, incomeAll: 0, expenses: 0, net: 0 };
    }

    if (state.view === "monthly") {
      for (var m = 1; m <= 12; m++) out.push(blank(MONTH_NAMES[m - 1], state.year + "-" + m));
      d.monthly.forEach(function (r) {
        if (r.year !== state.year) return;
        var p = out[r.month - 1];
        p.byCat[r.category] += r.amount;
        p.incomeAll += r.amount;
      });
      d.expenses.forEach(function (r) {
        if (r.year !== state.year) return;
        out[r.month - 1].expenses += r.amount;
      });
    } else {
      var byYear = {};
      d.meta.years.forEach(function (y) {
        var p = blank(String(y), String(y));
        byYear[y] = p;
        out.push(p);
      });
      d.monthly.forEach(function (r) {
        var p = byYear[r.year];
        p.byCat[r.category] += r.amount;
        p.incomeAll += r.amount;
      });
      d.expenses.forEach(function (r) { byYear[r.year].expenses += r.amount; });
    }
    out.forEach(function (p) { p.net = p.incomeAll - p.expenses; });
    return out;
  }

  // effective selection: the picked lanes, or ALL lanes when none is picked
  function selectedCats() {
    if (state.selected.size === 0) return state.data.categories.slice();
    return state.data.categories.filter(function (c) { return state.selected.has(c); });
  }

  // ── chips (filter + legend in one) ─────────────────────────────────
  function buildChips() {
    var host = document.getElementById("chips");
    host.textContent = "";

    var all = document.createElement("button");
    all.type = "button";
    all.className = "chip chip-all";
    all.textContent = "All";
    all.title = "Show every lane";
    all.addEventListener("click", function () {
      state.selected.clear();     // empty selection = All
      render();
    });
    host.appendChild(all);

    state.data.categories.forEach(function (cat) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.cat = cat;
      var sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.setProperty("--sw", COLORS[cat]);
      b.appendChild(sw);
      b.appendChild(document.createTextNode(cat));
      if (ZERO_LANE_NOTES[cat]) {
        b.title = ZERO_LANE_NOTES[cat];
      }
      b.addEventListener("click", function () {
        // isolate-on-click: from "All" this shows ONLY this lane; further
        // clicks add/remove lanes; removing the last lane returns to All
        if (state.selected.has(cat)) state.selected.delete(cat);
        else state.selected.add(cat);
        render();
      });
      host.appendChild(b);
    });
    syncChips();
  }

  function syncChips() {
    var host = document.getElementById("chips");
    var allOn = state.selected.size === 0;
    host.querySelector(".chip-all").setAttribute("aria-pressed", String(allOn));
    host.querySelectorAll(".chip[data-cat]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(state.selected.has(b.dataset.cat)));
    });
  }

  // ── chart ──────────────────────────────────────────────────────────
  var SVGNS = "http://www.w3.org/2000/svg";
  function el(name, attrs, parent) {
    var e = document.createElementNS(SVGNS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function niceStep(range) {
    var raw = range / 5;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var candidates = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] * pow >= raw) return candidates[i] * pow;
    }
    return 10 * pow;
  }

  function renderChart() {
    var host = document.getElementById("chart");
    host.textContent = "";
    var ps = periods();
    var cats = selectedCats();

    var W = 960, H = 400;
    var M = { l: 62, r: 16, t: 18, b: 36 };
    var plotW = W - M.l - M.r, plotH = H - M.t - M.b;

    var maxStack = 0, minNet = 0, maxNet = 0;
    ps.forEach(function (p) {
      var s = 0;
      cats.forEach(function (c) { s += p.byCat[c]; });
      if (s > maxStack) maxStack = s;
      if (p.net < minNet) minNet = p.net;
      if (p.net > maxNet) maxNet = p.net;
    });
    var yMax = Math.max(maxStack, maxNet, 100);
    var yMin = Math.min(0, minNet);
    var step = niceStep(yMax - yMin);
    yMax = Math.ceil(yMax / step) * step;
    yMin = Math.floor(yMin / step) * step;

    function y(v) { return M.t + plotH * (1 - (v - yMin) / (yMax - yMin)); }

    var svg = el("svg", {
      viewBox: "0 0 " + W + " " + H,
      role: "img",
      "aria-label": "Stacked bar chart of income by category with a net profit line. The table below holds the same numbers."
    }, host);

    // gridlines + y labels
    for (var v = yMin; v <= yMax + 0.001; v += step) {
      var yy = y(v);
      el("line", {
        x1: M.l, x2: W - M.r, y1: yy, y2: yy,
        stroke: v === 0 ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.07)",
        "stroke-width": 1
      }, svg);
      var t = el("text", {
        x: M.l - 10, y: yy + 4, "text-anchor": "end",
        fill: "#85839a", "font-size": 12, "font-family": "system-ui, sans-serif"
      }, svg);
      t.textContent = fmtAxis(v);
    }

    var n = ps.length;
    var slot = plotW / n;
    var barW = Math.min(slot * 0.55, 70);

    ps.forEach(function (p, i) {
      var cx = M.l + slot * (i + 0.5);
      var x0 = cx - barW / 2;

      // stacked segments, bottom-up in category display order
      var cum = 0;
      var segs = [];
      cats.forEach(function (c) {
        var a = p.byCat[c];
        if (a <= 0) return;
        segs.push({ cat: c, from: cum, to: cum + a });
        cum += a;
      });
      segs.forEach(function (s, si) {
        var top = y(s.to), bot = y(s.from);
        var h = Math.max(bot - top, 0.8);
        var isTop = si === segs.length - 1;
        if (isTop && h > 5) {
          var r = 4;
          el("path", {
            d: "M" + x0 + " " + bot +
               " V" + (top + r) +
               " Q" + x0 + " " + top + " " + (x0 + r) + " " + top +
               " H" + (x0 + barW - r) +
               " Q" + (x0 + barW) + " " + top + " " + (x0 + barW) + " " + (top + r) +
               " V" + bot + " Z",
            fill: COLORS[s.cat], stroke: "#121218", "stroke-width": 1.5
          }, svg);
        } else {
          el("rect", {
            x: x0, y: top, width: barW, height: h,
            fill: COLORS[s.cat], stroke: "#121218", "stroke-width": 1.5
          }, svg);
        }
      });

      // x label
      var xl = el("text", {
        x: cx, y: H - 12, "text-anchor": "middle",
        fill: "#85839a", "font-size": 12, "font-family": "system-ui, sans-serif"
      }, svg);
      xl.textContent = p.label;
    });

    // net profit line (always visible; all lanes minus expenses)
    var pts = ps.map(function (p, i) {
      return [M.l + slot * (i + 0.5), y(p.net)];
    });
    el("polyline", {
      points: pts.map(function (pt) { return pt.join(","); }).join(" "),
      fill: "none", stroke: "#f3f2f8", "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round"
    }, svg);
    pts.forEach(function (pt) {
      el("circle", {
        cx: pt[0], cy: pt[1], r: 4,
        fill: "#f3f2f8", stroke: "#121218", "stroke-width": 2
      }, svg);
    });
    // direct label on the line's last point
    var lastP = ps[ps.length - 1];
    var netLbl = el("text", {
      x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] - 12,
      "text-anchor": "end", fill: "#f3f2f8", "font-size": 12,
      "font-weight": 700, "font-family": "system-ui, sans-serif"
    }, svg);
    // month/year-aware so it reads as the last data point, not a period total
    netLbl.textContent = lastP.label + " net " + fmt(lastP.net);

    // hover targets: one per period, full plot height
    ps.forEach(function (p, i) {
      var hx = M.l + slot * i;
      var hit = el("rect", {
        x: hx, y: M.t, width: slot, height: plotH,
        fill: "transparent"
      }, svg);
      hit.addEventListener("mousemove", function (ev) { showTip(p, ev); });
      hit.addEventListener("mouseleave", hideTip);
    });

    // caption
    var scope = state.view === "monthly" ? (state.year + ", monthly") : "2026–2028, yearly";
    document.getElementById("chart-caption").textContent =
      "Income stacked by lane (" + scope + "). White line = net profit: all income lanes minus business expenses, regardless of filter. Simulated data.";
  }

  // ── tooltip ────────────────────────────────────────────────────────
  function showTip(p, ev) {
    var tip = document.getElementById("tooltip");
    var card = tip.parentElement;
    tip.textContent = "";
    var h = document.createElement("h4");
    h.textContent = p.label + (state.view === "monthly" ? " " + state.year : "");
    tip.appendChild(h);
    selectedCats().forEach(function (c) {
      var a = p.byCat[c];
      if (a <= 0) return;
      var row = document.createElement("div");
      row.className = "tt-row";
      var lbl = document.createElement("span");
      lbl.className = "lbl";
      var sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = COLORS[c];
      lbl.appendChild(sw);
      lbl.appendChild(document.createTextNode(c));
      var val = document.createElement("span");
      val.className = "val";
      val.textContent = fmt(a);
      row.appendChild(lbl); row.appendChild(val);
      tip.appendChild(row);
    });
    [["Expenses", -p.expenses], ["Net profit", p.net]].forEach(function (pair, i) {
      var row = document.createElement("div");
      row.className = "tt-row" + (i === 1 ? " tt-net" : "");
      var lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = pair[0];
      var val = document.createElement("span");
      val.className = "val";
      val.textContent = fmt(pair[1]);
      row.appendChild(lbl); row.appendChild(val);
      tip.appendChild(row);
    });
    tip.hidden = false;
    var rect = card.getBoundingClientRect();
    var x = ev.clientX - rect.left + 14;
    var yy = ev.clientY - rect.top + 14;
    if (x + tip.offsetWidth > rect.width - 8) x = x - tip.offsetWidth - 28;
    if (yy + tip.offsetHeight > rect.height - 8) yy = rect.height - tip.offsetHeight - 8;
    tip.style.left = x + "px";
    tip.style.top = yy + "px";
  }

  function hideTip() {
    document.getElementById("tooltip").hidden = true;
  }

  // ── table ──────────────────────────────────────────────────────────
  function renderTable() {
    var table = document.getElementById("money-table");
    table.textContent = "";
    var ps = periods();
    var cats = selectedCats();

    var caption = document.createElement("caption");
    caption.className = "visually-hidden";
    caption.textContent = "Income by category, expenses and net profit — simulated data";
    table.appendChild(caption);

    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    var th0 = document.createElement("th");
    th0.scope = "col";
    th0.textContent = state.view === "monthly" ? ("Lane · " + state.year) : "Lane";
    hr.appendChild(th0);
    ps.forEach(function (p) {
      var th = document.createElement("th");
      th.scope = "col";
      th.textContent = p.label;
      hr.appendChild(th);
    });
    var thT = document.createElement("th");
    thT.scope = "col";
    thT.textContent = "Total";
    hr.appendChild(thT);
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");

    function row(label, values, opts) {
      opts = opts || {};
      var tr = document.createElement("tr");
      if (opts.total) tr.className = "total-row";
      var td0 = document.createElement("td");
      if (opts.color) {
        var sw = document.createElement("span");
        sw.className = "row-swatch";
        sw.style.background = opts.color;
        td0.appendChild(sw);
      }
      td0.appendChild(document.createTextNode(label));
      tr.appendChild(td0);
      var sum = 0;
      values.forEach(function (v) {
        sum += v;
        var td = document.createElement("td");
        td.textContent = fmt(v);
        if (v < 0) td.className = "neg";
        tr.appendChild(td);
      });
      var tdT = document.createElement("td");
      tdT.textContent = fmt(sum);
      if (sum < 0) tdT.className = "neg";
      tr.appendChild(tdT);
      tbody.appendChild(tr);
    }

    cats.forEach(function (c) {
      row(c, ps.map(function (p) { return p.byCat[c]; }), { color: COLORS[c] });
    });
    row("Total income (all lanes)", ps.map(function (p) { return p.incomeAll; }), { total: true });
    row("Expenses", ps.map(function (p) { return -p.expenses; }));
    row("Net profit", ps.map(function (p) { return p.net; }), { total: true });

    table.appendChild(tbody);
  }

  // ── expense breakdown (Buzz's "what did we spend on ads") ──────────
  function expensePeriods() {
    // like periods(), but per expense category; respects view/year,
    // ignores the income-lane filter on purpose
    var d = state.data;
    var cats = d.expense_categories || [];
    var out = [];

    function blank(label) {
      var byCat = {};
      cats.forEach(function (c) { byCat[c] = 0; });
      return { label: label, byCat: byCat, total: 0 };
    }

    if (state.view === "monthly") {
      for (var m = 1; m <= 12; m++) out.push(blank(MONTH_NAMES[m - 1]));
      (d.expenses_by_category || []).forEach(function (r) {
        if (r.year !== state.year) return;
        out[r.month - 1].byCat[r.category] += r.amount;
        out[r.month - 1].total += r.amount;
      });
    } else {
      var byYear = {};
      d.meta.years.forEach(function (y) {
        var p = blank(String(y));
        byYear[y] = p;
        out.push(p);
      });
      (d.expenses_by_category || []).forEach(function (r) {
        byYear[r.year].byCat[r.category] += r.amount;
        byYear[r.year].total += r.amount;
      });
    }
    return out;
  }

  function renderExpenses() {
    var table = document.getElementById("expense-table");
    if (!table) return;
    table.textContent = "";
    var ps = expensePeriods();
    var cats = (state.data.expense_categories || []).slice();

    // biggest spend first within the current scope
    var scopeTotal = {};
    cats.forEach(function (c) {
      scopeTotal[c] = ps.reduce(function (s, p) { return s + p.byCat[c]; }, 0);
    });
    cats.sort(function (a, b) { return scopeTotal[b] - scopeTotal[a]; });

    document.getElementById("expense-summary").textContent =
      "Expense breakdown · " + (state.view === "monthly" ? state.year : "2026–2028");

    var caption = document.createElement("caption");
    caption.className = "visually-hidden";
    caption.textContent = "Business expenses by category — simulated data";
    table.appendChild(caption);

    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    var th0 = document.createElement("th");
    th0.scope = "col";
    th0.textContent = state.view === "monthly" ? ("Category · " + state.year) : "Category";
    hr.appendChild(th0);
    ps.forEach(function (p) {
      var th = document.createElement("th");
      th.scope = "col";
      th.textContent = p.label;
      hr.appendChild(th);
    });
    var thT = document.createElement("th");
    thT.scope = "col";
    thT.textContent = "Total";
    hr.appendChild(thT);
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");

    function row(label, values, isTotal) {
      var tr = document.createElement("tr");
      if (isTotal) tr.className = "total-row";
      var td0 = document.createElement("td");
      td0.textContent = label;
      tr.appendChild(td0);
      var sum = 0;
      values.forEach(function (v) {
        sum += v;
        var td = document.createElement("td");
        td.textContent = fmt(v);
        tr.appendChild(td);
      });
      var tdT = document.createElement("td");
      tdT.textContent = fmt(sum);
      tr.appendChild(tdT);
      tbody.appendChild(tr);
    }

    cats.forEach(function (c) {
      row(c, ps.map(function (p) { return p.byCat[c]; }), false);
    });
    row("Total expenses", ps.map(function (p) { return p.total; }), true);

    table.appendChild(tbody);
  }

  // ── taxes ──────────────────────────────────────────────────────────
  function renderTaxes() {
    var host = document.getElementById("tax-grid");
    host.textContent = "";
    state.data.meta.years.forEach(function (y) {
      var s = state.data.schedule_c[String(y)];
      if (!s) return;
      var card = document.createElement("article");
      card.className = "tax-card glass";

      var h = document.createElement("h3");
      h.textContent = "Schedule C · " + y;
      card.appendChild(h);
      var sub = document.createElement("p");
      sub.className = "tax-sub";
      sub.textContent = "SIMULATED · Fly Asshole LLC · EIN 00‑0000000";
      card.appendChild(sub);

      // honest arithmetic order: gross − deductions = net,
      // with SE tax visually separated below (it's computed FROM net,
      // it is not part of the subtraction)
      var lines = document.createElement("div");
      lines.className = "tax-lines";
      [
        ["Gross receipts", fmt(s.gross_receipts), false],
        ["− Deductions", "− " + fmt(s.total_deductions), false],
        ["= Net profit", fmt(s.net_profit), true]
      ].forEach(function (t) {
        var line = document.createElement("div");
        line.className = "tax-line" + (t[2] ? " big" : "");
        var lbl = document.createElement("span");
        lbl.textContent = t[0];
        var amt = document.createElement("span");
        amt.className = "amt";
        amt.textContent = t[1];
        line.appendChild(lbl); line.appendChild(amt);
        lines.appendChild(line);
      });
      card.appendChild(lines);

      // the books↔tax bridge: displayed values are rounded so the visible
      // arithmetic adds up exactly (add-back = rounded taxable − rounded
      // books; the exact cents live in data.json meals_addback)
      if (typeof s.books_net === "number") {
        var addback = Math.round(s.net_profit) - Math.round(s.books_net);
        var bridge = document.createElement("p");
        bridge.className = "tax-bridge";
        bridge.textContent = "Books net " + fmt(Math.round(s.books_net)) +
          " + " + fmt(addback) +
          " meals add-back (only 50% of meals is deductible) = taxable net " +
          fmt(Math.round(s.net_profit));
        card.appendChild(bridge);
      }

      var se = document.createElement("div");
      se.className = "tax-line tax-se";
      var seLbl = document.createElement("span");
      seLbl.textContent = "Self-employment tax";
      var seAmt = document.createElement("span");
      seAmt.className = "amt";
      seAmt.textContent = fmt(s.se_tax);
      se.appendChild(seLbl); se.appendChild(seAmt);
      card.appendChild(se);

      var seWords = document.createElement("p");
      seWords.className = "tax-words";
      seWords.textContent = "Self-employment tax = 15.3% for Social Security + Medicare, computed on 92.35% of net.";
      card.appendChild(seWords);

      // quarterly set-aside strip — third person, always
      if (typeof s.quarterly_set_aside === "number") {
        var strip = document.createElement("p");
        strip.className = "tax-strip";
        strip.textContent = "Fly Asshole sets aside for taxes: ~" +
          fmt(Math.round(s.quarterly_set_aside)) +
          "/quarter (net × 25% ÷ 4, covering self-employment + a cushion toward income tax — SIMULATION, not advice).";
        card.appendChild(strip);
      }

      var note = document.createElement("p");
      note.className = "tax-note";
      note.textContent = "NOT A REAL FILING — simulation output, fictional band, invalid EIN.";
      card.appendChild(note);

      var dl = document.createElement("a");
      dl.className = "tax-dl";
      dl.href = "files/schedule_c_" + y + "_SIMULATED.txt";
      dl.setAttribute("download", "");
      dl.textContent = "Download the .txt";
      card.appendChild(dl);

      host.appendChild(card);
    });
  }

  // ── controls wiring ────────────────────────────────────────────────
  function wireControls() {
    var bm = document.getElementById("btn-monthly");
    var by = document.getElementById("btn-yearly");
    bm.addEventListener("click", function () { state.view = "monthly"; render(); });
    by.addEventListener("click", function () { state.view = "yearly"; render(); });
    document.querySelectorAll(".year-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        state.year = parseInt(b.dataset.year, 10);
        render();
      });
    });
  }

  function syncControls() {
    document.getElementById("btn-monthly").setAttribute("aria-pressed", String(state.view === "monthly"));
    document.getElementById("btn-yearly").setAttribute("aria-pressed", String(state.view === "yearly"));
    var yp = document.getElementById("year-picker");
    yp.classList.toggle("disabled", state.view !== "monthly");
    yp.setAttribute("aria-disabled", String(state.view !== "monthly"));
    document.querySelectorAll(".year-btn").forEach(function (b) {
      b.setAttribute("aria-pressed", String(parseInt(b.dataset.year, 10) === state.year));
    });
  }

  function render() {
    syncControls();
    syncChips();
    hideTip();
    renderChart();
    renderTable();
    renderExpenses();
  }

  // ── boot ───────────────────────────────────────────────────────────
  fetch("data.json")
    .then(function (r) {
      if (!r.ok) throw new Error("data.json failed: " + r.status);
      return r.json();
    })
    .then(function (d) {
      state.data = d;
      state.selected = new Set();   // empty = All lanes

      // 3-year gross stat in the profile
      var gross = 0;
      d.meta.years.forEach(function (y) {
        var s = d.schedule_c[String(y)];
        if (s) gross += s.gross_receipts;
      });
      document.getElementById("stat-gross").textContent =
        "$" + Math.round(gross / 1000) + "K";
      // avg monthly streams — computed by scripts/export_data.py from the
      // sim's distributor statements (198,874 for seed 42 / 36 months)
      if (d.meta.avg_monthly_streams) {
        document.getElementById("stat-streams").textContent =
          Math.round(d.meta.avg_monthly_streams / 1000) + "K";
      }
      document.getElementById("footer-year").textContent =
        d.meta.generated ? d.meta.generated.slice(0, 4) : "2026";

      buildChips();
      wireControls();
      renderTaxes();
      render();
    })
    .catch(function (err) {
      var host = document.getElementById("chart");
      host.textContent = "Could not load data.json — serve this folder over HTTP (see README). " + err.message;
      host.style.color = "#e66767";
      host.style.padding = "24px";
    });
})();
