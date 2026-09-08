/* WENZL — the real books, behind a password. Vanilla JS, no libraries.
   The renderer is the fly-asshole dashboard adapted for live data: the
   profile JSON comes from the private engine (board-backend/Code.gs,
   BOOKS realm), never from a file in this public repo. #demo loads the
   committed demo-data.json (practice-company numbers, clearly labeled).
   The password gate is the /shows/ pattern: PBKDF2 in the browser turns
   the password into the engine's key, so no secret lives here. */

(function () {
  "use strict";

  // Real books = category names we don't control, so colors are assigned
  // by position at boot (same validated palette as the demo profile).
  var PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500",
                 "#d55181", "#008300", "#9085e9", "#e66767",
                 "#5aa9a0", "#b06fce", "#8a8f3c", "#c46a5a"];
  var COLORS = {};   // filled by assignColors() once data arrives
  function assignColors(cats) {
    cats.forEach(function (c, i) { COLORS[c] = PALETTE[i % PALETTE.length]; });
  }

  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var state = {
    view: "monthly",          // "monthly" | "yearly"
    year: null,               // set from meta.years at boot
    // Wenzl's toggle model (2026-08-04): "Total" and individual lanes are a
    // real toggle. mode "total" = the Total chip is pressed, every lane shows,
    // curve = total income. mode "lanes" = only the picked lanes show, curve =
    // their summed income; picking a lane from Total unpresses Total; an empty
    // pick in lanes mode legitimately shows a zero curve (nothing highlighted).
    mode: "total",            // "total" | "lanes"
    selected: new Set(),
    data: null
  };

  // zero-lanes kept on purpose (honest zeros beat decorative data)
  var ZERO_LANE_NOTES = {};  // real books: no scripted zero-lane notes

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

  // effective selection: every lane in Total mode; the picked lanes (possibly
  // none — a legitimate empty state) in lanes mode
  function selectedCats() {
    if (state.mode === "total") return state.data.categories.slice();
    return state.data.categories.filter(function (c) { return state.selected.has(c); });
  }

  // the curve follows the selection: income of what's highlighted, $0 when nothing is
  function selIncome(p, cats) {
    var s = 0;
    cats.forEach(function (c) { s += p.byCat[c]; });
    return s;
  }

  // ── chips (filter + legend in one) ─────────────────────────────────
  function buildChips() {
    var host = document.getElementById("chips");
    host.textContent = "";

    var all = document.createElement("button");
    all.type = "button";
    all.className = "chip chip-all";
    all.textContent = "Total";
    all.title = "Show total income — unpresses the individual lanes";
    all.addEventListener("click", function () {
      state.mode = "total";       // Total pressed → all lanes unpressed
      state.selected.clear();
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
        // toggle model: picking a lane leaves Total mode and isolates it;
        // further clicks add/remove lanes. Removing every lane is allowed —
        // the curve drops to zero until Total (or a lane) is pressed again.
        if (state.mode === "total") {
          state.mode = "lanes";
          state.selected = new Set([cat]);
        } else if (state.selected.has(cat)) {
          state.selected.delete(cat);
        } else {
          state.selected.add(cat);
        }
        render();
      });
      host.appendChild(b);
    });
    syncChips();
  }

  function syncChips() {
    var host = document.getElementById("chips");
    host.querySelector(".chip-all").setAttribute("aria-pressed", String(state.mode === "total"));
    host.querySelectorAll(".chip[data-cat]").forEach(function (b) {
      b.setAttribute("aria-pressed",
        String(state.mode === "lanes" && state.selected.has(b.dataset.cat)));
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

    var maxStack = 0;
    ps.forEach(function (p) {
      var s = selIncome(p, cats);
      if (s > maxStack) maxStack = s;
    });
    var yMax = Math.max(maxStack, 100);
    var yMin = 0;
    var step = niceStep(yMax - yMin);
    yMax = Math.ceil(yMax / step) * step;
    yMin = Math.floor(yMin / step) * step;

    function y(v) { return M.t + plotH * (1 - (v - yMin) / (yMax - yMin)); }

    var svg = el("svg", {
      viewBox: "0 0 " + W + " " + H,
      role: "img",
      "aria-label": "Stacked bar chart of income by category. The dotted line traces the income of the selected lanes — total income when the Total chip is pressed, zero when nothing is selected. The table below holds the same numbers."
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

    // the selection curve (Wenzl's toggle model): dotted line tracing the
    // income of whatever is highlighted — total income in Total mode, the
    // summed picked lanes otherwise, and a flat zero when nothing is selected
    var pts = ps.map(function (p, i) {
      return [M.l + slot * (i + 0.5), y(selIncome(p, cats))];
    });
    el("polyline", {
      points: pts.map(function (pt) { return pt.join(","); }).join(" "),
      fill: "none", stroke: "#f3f2f8", "stroke-width": 2,
      "stroke-dasharray": "7 6",
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
    var lastIncome = selIncome(lastP, cats);
    var netLbl = el("text", {
      x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] - 12,
      "text-anchor": "end", fill: "#f3f2f8", "font-size": 12,
      "font-weight": 700, "font-family": "system-ui, sans-serif"
    }, svg);
    // month/year-aware so it reads as the last data point, not a period total
    netLbl.textContent = cats.length === 0
      ? "nothing selected — $0"
      : lastP.label + " income " + fmt(lastIncome);

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
      "Income stacked by lane (" + scope + "). Dotted line = income of what's selected: press Total for everything, press lanes to compare sources (nothing selected = zero). Net profit lives in the table below. Simulated data.";
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
    row(state.mode === "total" ? "Total income (all lanes)" : "Total income (selected lanes)",
        ps.map(function (p) { return selIncome(p, cats); }), { total: true });
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

    function row(label, values, opts) {
      opts = opts || {};
      var tr = document.createElement("tr");
      if (opts.total) tr.className = "total-row";
      else if (opts.subtotal) tr.className = "subtotal-row";
      else if (opts.sub) tr.className = "sub-row";
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

    // advertising spend is split across two source categories — show them
    // grouped under one subtotal so "what did we spend on ads" is one row
    var AD_CATS = ["Meta Ads", "Advertising & Marketing"].filter(function (c) {
      return cats.indexOf(c) > -1;
    });
    var entities = cats.filter(function (c) { return AD_CATS.indexOf(c) === -1; })
      .map(function (c) { return { cat: c, total: scopeTotal[c] }; });
    if (AD_CATS.length) {
      entities.push({
        ads: true,
        total: AD_CATS.reduce(function (s, c) { return s + scopeTotal[c]; }, 0)
      });
    }
    entities.sort(function (a, b) { return b.total - a.total; });

    entities.forEach(function (e) {
      if (e.ads) {
        // subtotal = per-period sum of the two source rows, to the penny
        row("Advertising (combined)", ps.map(function (p) {
          return AD_CATS.reduce(function (s, c) { return s + p.byCat[c]; }, 0);
        }), { subtotal: true });
        AD_CATS.forEach(function (c) {
          row(c, ps.map(function (p) { return p.byCat[c]; }), { sub: true });
        });
      } else {
        row(e.cat, ps.map(function (p) { return p.byCat[e.cat]; }));
      }
    });
    row("Total expenses", ps.map(function (p) { return p.total; }), { total: true });

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
      sub.textContent = state.data.meta.simulated
        ? "PRACTICE DATA · QuickBooks sandbox company · not real money"
        : "ESTIMATE from the live books · not tax advice · the accountant has the last word";
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
        strip.textContent = "Suggested tax set-aside: ~" +
          fmt(Math.round(s.quarterly_set_aside)) +
          "/quarter (net × 25% ÷ 4, covering self-employment + a cushion toward income tax — an estimate, not advice).";
        card.appendChild(strip);
      }

      var note = document.createElement("p");
      note.className = "tax-note";
      note.textContent = state.data.meta.simulated
        ? "NOT A REAL FILING — practice-company numbers from a QuickBooks sandbox."
        : "NOT A FILING — a live estimate from category totals; the reconciled books are the record.";
      card.appendChild(note);

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
        if (state.view !== "monthly") return; // belt-and-braces with disabled
        state.year = parseInt(b.dataset.year, 10);
        render();
      });
    });
  }

  function syncControls() {
    document.getElementById("btn-monthly").setAttribute("aria-pressed", String(state.view === "monthly"));
    document.getElementById("btn-yearly").setAttribute("aria-pressed", String(state.view === "yearly"));
    var yp = document.getElementById("year-picker");
    var yearsOff = state.view !== "monthly";
    yp.classList.toggle("disabled", yearsOff);
    yp.setAttribute("aria-disabled", String(yearsOff));
    document.querySelectorAll(".year-btn").forEach(function (b) {
      // real disabled attribute: keyboard focus/Enter must do nothing in
      // Yearly mode, not just look off
      b.disabled = yearsOff;
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

  // ── data boot (shared by live + demo) ──────────────────────────
  function boot(d) {
    state.data = d;
    state.selected = new Set();   // empty = All lanes
    assignColors(d.categories);

    var years = d.meta.years || [];
    state.year = years.length ? years[years.length - 1] : null;

    // build the year picker to match the data (the demo page hardcodes 3)
    var yp = document.getElementById("year-picker");
    yp.textContent = "";
    years.forEach(function (y) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "seg-btn year-btn";
      b.dataset.year = String(y);
      b.setAttribute("aria-pressed", String(y === state.year));
      b.textContent = String(y);
      yp.appendChild(b);
    });

    var gross = 0;
    years.forEach(function (y) {
      var sc = d.schedule_c[String(y)];
      if (sc) gross += sc.gross_receipts;
    });
    var g = document.getElementById("stat-gross");
    if (g) g.textContent = "$" + Math.round(gross / 1000) + "K";
    var yr = document.getElementById("stat-years");
    if (yr) yr.textContent = years.length ? years.join(" · ") : "—";
    var mo = document.getElementById("stat-months");
    if (mo) mo.textContent = String(d.meta.months || "—");
    var fy = document.getElementById("footer-year");
    if (fy) fy.textContent = d.meta.generated ? d.meta.generated.slice(0, 4) : "";

    // honesty banner: practice numbers must never dress up as real ones
    var badge = document.getElementById("books-badge");
    if (badge) {
      if (d.meta.simulated) {
        badge.textContent = "PRACTICE DATA — QuickBooks sandbox, not real money";
        badge.classList.add("badge-practice");
      } else {
        badge.textContent = "REAL BOOKS · private — " +
          (d.meta.generated ? "updated " + d.meta.generated : "live");
        badge.classList.add("badge-real");
      }
    }
    var note = document.getElementById("books-note");
    if (note) note.textContent = d.meta.note || "";

    // the raw-JSON download is the fetched profile itself
    var dl = document.getElementById("dl-json");
    if (dl) {
      dl.href = URL.createObjectURL(
        new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
    }

    buildChips();
    wireControls();
    renderTaxes();
    render();

    document.getElementById("gate").hidden = true;
    document.getElementById("books").hidden = false;
  }

  // ── the gate (the /shows/ pattern: password → PBKDF2 → engine key) ──
  var TOKEN_RE = /^bk[A-Za-z0-9]{40,}$/;
  var KDF = { salt: "bandpeace-books-v1", iterations: 4000000, bits: 256 };

  function apiUrl() {
    return (window.BOOKS_CONFIG && window.BOOKS_CONFIG.apiUrl) || "";
  }

  function deriveToken(password, subtle) {
    var crypt = subtle || (typeof crypto !== "undefined" && crypto.subtle);
    if (!crypt) return Promise.reject(new Error("no webcrypto"));
    var bytes = new TextEncoder().encode(String(password));
    var salt = new TextEncoder().encode(KDF.salt);
    return crypt.importKey("raw", bytes, "PBKDF2", false, ["deriveBits"])
      .then(function (key) {
        return crypt.deriveBits(
          { name: "PBKDF2", salt: salt, iterations: KDF.iterations, hash: "SHA-256" },
          key, KDF.bits);
      })
      .then(function (bits) {
        var hex = "";
        new Uint8Array(bits).forEach(function (b) {
          hex += (b < 16 ? "0" : "") + b.toString(16);
        });
        return "bk" + hex;
      });
  }

  function storedToken() {
    try { return window.localStorage.getItem("booksToken"); } catch (e) { return null; }
  }
  function storeToken(t) {
    try { window.localStorage.setItem("booksToken", t); } catch (e) { /* fine */ }
  }
  function dropToken() {
    try { window.localStorage.removeItem("booksToken"); } catch (e) { /* fine */ }
  }

  function gateMsg(text) {
    var m = document.getElementById("gate-msg");
    if (m) m.textContent = text || "";
  }

  function fetchBooks(token) {
    return fetch(apiUrl() + "?token=" + encodeURIComponent(token) + "&action=books",
                 { method: "GET" })
      .then(function (r) { return r.json(); });
  }

  function tryToken(token, remember) {
    gateMsg("Opening the books…");
    fetchBooks(token).then(function (res) {
      if (!res || res.ok !== true) {
        dropToken();
        gateMsg("That password doesn't open these books.");
        return;
      }
      if (!res.profile) {
        gateMsg("The engine answered, but no books have been published yet. " +
                "Run the publish step on the Mac mini, then reload.");
        return;
      }
      if (remember) storeToken(token);
      if (window.location.hash && window.location.hash.indexOf("#demo") !== 0) {
        // stop carrying the key in the address bar once it's remembered
        try { history.replaceState(null, "", window.location.pathname); } catch (e) { /* fine */ }
      }
      boot(res.profile);
    }).catch(function () {
      gateMsg("Couldn't reach the engine — check the connection and try again.");
    });
  }

  function loadDemo() {
    fetch("demo-data.json")
      .then(function (r) {
        if (!r.ok) throw new Error("demo-data.json failed: " + r.status);
        return r.json();
      })
      .then(boot)
      .catch(function (err) {
        gateMsg("Could not load demo data — serve this folder over HTTP. " + err.message);
      });
  }

  function wireGate() {
    var form = document.getElementById("gate-form");
    if (!form) return;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var pw = document.getElementById("gate-password").value;
      if (!pw) return;
      if (!apiUrl()) { gateMsg("No engine is wired in yet (config.js is empty)."); return; }
      gateMsg("Checking… this takes a second or two on purpose.");
      var btn = document.getElementById("gate-go");
      if (btn) btn.disabled = true;
      deriveToken(pw).then(function (token) {
        if (btn) btn.disabled = false;
        tryToken(token, true);
      }).catch(function () {
        if (btn) btn.disabled = false;
        gateMsg("This browser can't do the required crypto — try a current one.");
      });
    });
  }

  // ── boot ───────────────────────────────────────────────────────────
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    var start = function () {
      wireGate();
      var h = (window.location.hash || "").replace(/^#/, "");
      var remembered = storedToken();
      if (h === "demo") {
        loadDemo();
      } else if (TOKEN_RE.test(h)) {
        tryToken(h, true);
      } else if (remembered && TOKEN_RE.test(remembered)) {
        tryToken(remembered, false);
      }
      // otherwise: the gate just sits there, holding nothing.
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }

  /* Node test hook — pure helpers only. */
  if (typeof module !== "undefined") {
    module.exports = {
      deriveToken: deriveToken,
      KDF: KDF,
      TOKEN_RE: TOKEN_RE,
      assignColors: assignColors,
      COLORS: COLORS,
      PALETTE: PALETTE
    };
  }
})();
