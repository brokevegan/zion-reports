/* Zion Reports: the clinic's reports, worked out from the data sent by the laptop.
   Each builder follows the laptop program's build_report (zion_core, zion_dx, zion_imm, zion_eye,
   zion_hiv) step by step, so the iPad gives the same numbers. A report is
   {title, period, start, end, columns, widths, money_cols, rows, total_rows, note, chart, ...}. */
(function (global) {
  "use strict";

  const CLINIC = "Zion Clinic";
  const UNCODED = "";
  const UNCODED_LABEL = "(no code yet)";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const BY_PERSON = "By person (to / from)";
  const TOTAL_LABEL = { Revenue: "Total revenue", Expense: "Total expenses" };
  const NONE_LABEL = "No condition recorded";
  const EYE_AGE_GROUPS = [[0, "Under 1 yr"], [1, "1-4 yrs"], [5, "5-14 yrs"], [15, "15-24 yrs"], [25, "25-44 yrs"],
    [45, "45-59 yrs"], [60, "60+ yrs"]];
  const HIV_AGE_GROUPS = ["<15", "15-24", "25-49", "50+"];
  const HIV_AGE_LABEL = { "<15": "Under 15", "15-24": "15-24", "25-49": "25-49", "50+": "50 and over" };
  const HIV_RESULTS = ["Negative", "Positive"];
  const NOT_MAPPED = "Other (not in the map)";
  const NOT_RECORDED = "Not recorded";

  const KINDS = {
    money: ["Summary by cost code", "Monthly by cost code", "All transactions", BY_PERSON],
    visits: ["Visits by diagnosis", "Visit list by diagnosis"],
    imm: ["Immunisations by month", "Immunisations by vaccine", "Immunisations by location", "Immunisation entries (all)"],
    eye: ["Eye camp summary", "Eye camp by age group", "Eye camp by district", "Eye camp patient list"],
    hiv: ["HIV tests by month", "HIV tests by age group", "HIV tests by location", "HIV test entries (all)"],
  };

  function modeOf(kind) {
    for (const m in KINDS) if (KINDS[m].indexOf(kind) >= 0) return m;
    throw new Error("Unknown report: " + kind);
  }

  // ------------------------------------------------------------ formatting (as Python prints it)

  function fmtNum(v) {
    const n = Math.round(v);
    return (n < 0 ? "-" : "") + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // Python rounds exact halves to even ("%.0f" % 12.5 == "12"); JavaScript rounds them up.
  function pyFixed(x, d) {
    const p = Math.pow(10, d), y = x * p;
    if (Math.abs(y % 1) === 0.5) {
      const lo = Math.floor(y), n = lo % 2 === 0 ? lo : lo + 1;
      return (n / p).toFixed(d);
    }
    return x.toFixed(d);
  }

  function pyRound(x) {
    return Number(pyFixed(x, 0));
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const y = iso.slice(0, 4), m = Number(iso.slice(5, 7)), d = iso.slice(8, 10);
    if (!(m >= 1 && m <= 12) || d.length !== 2) return iso;
    return d + "-" + MONTHS[m - 1] + "-" + y;
  }

  function monthLong(ym) { return MONTHS[Number(ym.slice(5, 7)) - 1] + "-" + ym.slice(0, 4); }   // Oct-2026
  function monthShort(ym) { return MONTHS[Number(ym.slice(5, 7)) - 1] + "-" + ym.slice(2, 4); }  // Oct-26

  function monthList(start, end) {   // ["2026-01", ...]
    let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
    const ey = Number(end.slice(0, 4)), em = Number(end.slice(5, 7));
    const out = [];
    while (y < ey || (y === ey && m <= em)) {
      out.push(y + "-" + String(m).padStart(2, "0"));
      if (m === 12) { y++; m = 1; } else m++;
    }
    return out;
  }

  function isoToday() {
    const t = new Date();
    return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
  }

  function like(hay, s) {   // SQL LIKE '%s%' on one text field (NULL never matches)
    return hay !== null && hay !== undefined && String(hay).toLowerCase().indexOf(s) >= 0;
  }

  function groupBy(list, keyFn) {   // Map keeps first-seen order, like a Python dict
    const m = new Map();
    for (const x of list) {
      const k = keyFn(x);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  }

  function counter() {
    const m = new Map();
    m.add = (k, v) => { m.set(k, (m.get(k) || 0) + v); };
    return m;
  }

  function sortBy(list, keyFn) {   // stable sort on a key (array keys compare item by item)
    const cmp = (a, b) => {
      if (Array.isArray(a)) {
        for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; }
        return 0;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    };
    return list.map((x, i) => [keyFn(x), i, x]).sort((p, q) => cmp(p[0], q[0]) || p[1] - q[1]).map(p => p[2]);
  }

  function topSlices(pairs, keep) {
    keep = keep || 7;
    let out = sortBy(pairs.filter(p => p[1] > 0), p => -p[1]);
    if (out.length > keep + 1) {
      const rest = out.slice(keep).reduce((s, p) => s + p[1], 0);
      out = out.slice(0, keep).concat([["Other", rest]]);
    }
    return out;
  }

  function sum(list, fn) { let s = 0; for (const x of list) s += fn(x); return s; }

  function period(start, end) { return fmtDate(start) + " to " + fmtDate(end); }

  function newRep(kind, start, end, extra) {
    return Object.assign({ title: kind, period: period(start, end), start: start, end: end, codes: [], rows: [],
      total_rows: [], columns: [], money_cols: [], widths: [], person: "" }, extra);
  }

  function addTotal(rep, cells) {
    rep.total_rows.push(rep.rows.length);
    rep.rows.push(cells);
  }

  // ------------------------------------------------------------ the data from the laptop

  function prepare(snap) {
    const D = { snap: snap };
    D.codeName = {}; D.codeKind = {}; D.allCodes = [];
    for (const c of snap.cost_codes) { D.codeName[c[0]] = c[1]; D.codeKind[c[0]] = c[2]; D.allCodes.push(c[0]); }
    D.revenueCodes = D.allCodes.filter(c => D.codeKind[c] === "Revenue");
    D.expenseCodes = D.allCodes.filter(c => D.codeKind[c] === "Expense");
    D.reportCodes = D.allCodes.concat([UNCODED]);
    D.entries = snap.entries.map(r => ({ id: r[0], auto: !!r[1], date: r[2], description: r[3], amount_in: r[4],
      amount_out: r[5], from_party: r[6], to_party: r[7], code: r[8], billed: r[9], visits: r[10], notes: r[11] }));
    D.visits = snap.visits.map(r => ({ id: r[0], visit_date: r[1], patient: r[2], age_years: r[3], diagnosis: r[4],
      billed: r[5], paid: r[6], contact: r[7], notes: r[8], status: r[9], std: r[10], cat: r[11] }));
    D.imm = snap.imm.map(r => ({ id: r[0], imm_date: r[1], vaccine: r[2], dose: r[3], age_group: r[4], programme: r[5],
      male: r[6], female: r[7], total: r[8], location: r[9], post: r[10], notes: r[11] }));
    D.flagCols = snap.eye_flags.map(f => f[0]);
    D.condLabel = {};
    for (const f of snap.eye_flags) D.condLabel[f[0]] = f[1];
    D.eye = snap.eye.map(r => {
      const o = { id: r[0], camp_date: r[1], patient: r[2], age: r[3], age_years: r[4], sex: r[5], district: r[6],
        address: r[7], nin: r[8], contact: r[9], visual_acuity: r[10], findings: r[11], glasses: r[12], notes: r[13] };
      D.flagCols.forEach((c, i) => { o[c] = r[14][i]; });
      return o;
    });
    D.hiv = snap.hiv.map(r => ({ id: r[0], test_date: r[1], location: r[2], age_group: r[3], result: r[4], male: r[5],
      female: r[6], total: r[7], notes: r[8] }));
    return D;
  }

  function codeLabel(D, code) {
    return code === UNCODED ? UNCODED_LABEL : code + " - " + (D.codeName[code] || "?");
  }

  function codesCaption(D, codes) {
    const s = new Set(codes.filter(c => c !== UNCODED));
    const same = list => list.length === s.size && list.every(c => s.has(c));
    if (same(D.allCodes)) return "All categories";
    if (same(D.revenueCodes)) return "All revenue";
    if (same(D.expenseCodes)) return "All expenses";
    return codes.map(c => c ? c : UNCODED_LABEL).join(", ");
  }

  function caption(D, rep, search, sep) {
    sep = sep || "  ·  ";
    const parts = [rep.period, rep.filter_caption || codesCaption(D, rep.codes)];
    if (rep.person) parts.push("name: '" + rep.person + "'");
    if (search) parts.push("search: '" + search + "'");
    parts.push(rep.unit || "amounts in UGX");
    return parts.join(sep);
  }

  function minMax(list, field) {
    let lo = null, hi = null;
    for (const r of list) {
      const v = r[field];
      if (!v) continue;
      if (lo === null || v < lo) lo = v;
      if (hi === null || v > hi) hi = v;
    }
    return [lo, hi];
  }

  function defaultDates(start, end, lohi) {
    const t = isoToday();
    return [start || (lohi[0] ? lohi[0].slice(0, 10) : t), end || (lohi[1] ? lohi[1].slice(0, 10) : t)];
  }

  // ------------------------------------------------------------ revenue and expenses (zion_core)

  function entryKind(D, e) {
    return D.codeKind[e.code] || (e.amount_in ? "Revenue" : "Expense");
  }

  function filterEntries(D, entries, start, end, codes, search) {
    const s = (search || "").trim().toLowerCase();
    const set = codes ? new Set(codes) : null;
    return entries.filter(e => {
      if (start && (!e.date || e.date < start)) return false;
      if (end && (!e.date || e.date > end)) return false;
      if (set && !set.has(e.code)) return false;
      if (s) {
        const hay = [e.description, e.from_party, e.to_party, e.code, codeLabel(D, e.code), e.notes,
          String(e.amount_in), String(e.amount_out), fmtMoney(e.amount_in), fmtMoney(e.amount_out),
          fmtDate(e.date || "")].join(" ").toLowerCase();
        if (hay.indexOf(s) < 0) return false;
      }
      return true;
    });
  }

  function fmtMoney(v) { return v === null || v === undefined || v === "" ? "" : fmtNum(v); }

  function reportKeys(D, kindName, codes, has) {
    const keys = D.allCodes.filter(c => D.codeKind[c] === kindName && codes.indexOf(c) >= 0);
    if (codes.indexOf(UNCODED) >= 0 && has(UNCODED, kindName)) keys.push(UNCODED);
    return keys;
  }

  function moneyReport(D, kind, start, end, codes, search, person) {
    const entries = D.entries;
    if (!start || !end) {
      const dates = entries.filter(e => e.date).map(e => e.date).sort();
      const t = isoToday();
      start = start || (dates.length ? dates[0] : t);
      end = end || (dates.length ? dates[dates.length - 1] : t);
    }
    let sel = filterEntries(D, entries, start, end, codes, search);
    const who = kind === BY_PERSON ? (person || "").trim().toLowerCase() : "";
    if (who) sel = sel.filter(e => e.from_party.toLowerCase().indexOf(who) >= 0 || e.to_party.toLowerCase().indexOf(who) >= 0);
    const rep = newRep(kind, start, end, { codes: codes.slice(), person: who ? (person || "").trim() : "" });
    const totalRow = (label, values, labelCol) => addTotal(rep, new Array(labelCol || 0).fill("").concat([label], values));
    const name = c => (c in D.codeName ? D.codeName[c] : UNCODED_LABEL);

    if (kind === "Summary by cost code") {
      rep.columns = ["Code", "Category", "Type", "Entries", "Money In", "Money Out", "Net"];
      rep.money_cols = [4, 5, 6];
      rep.widths = [70, 300, 80, 70, 110, 110, 110];
      const agg = new Map();
      for (const e of sel) {
        const k = e.code + "\u0000" + entryKind(D, e);
        if (!agg.has(k)) agg.set(k, [0, 0, 0]);
        const a = agg.get(k);
        a[0] += e.auto ? e.visits : 1;
        a[1] += e.amount_in;
        a[2] += e.amount_out;
      }
      let tin = 0, tout = 0;
      for (const kn of ["Revenue", "Expense"]) {
        let si = 0, so = 0;
        const keys = reportKeys(D, kn, codes, (c, k) => agg.has(c + "\u0000" + k));
        for (const c of keys) {
          const a = agg.get(c + "\u0000" + kn) || [0, 0, 0];
          rep.rows.push([c || "-", name(c), kn, a[0], a[1], a[2], a[1] - a[2]]);
          si += a[1]; so += a[2];
        }
        if (keys.length) totalRow(TOTAL_LABEL[kn], ["", "", si, so, si - so], 1);
        tin += si; tout += so;
      }
      totalRow("NET (money in - money out)", ["", "", tin, tout, tin - tout], 1);
      if (codes.indexOf("101") >= 0) {
        const billed = sum(sel.filter(e => e.auto), e => e.billed);
        const recv = sum(sel.filter(e => e.auto), e => e.amount_in);
        const extra = sel.filter(e => e.code === "101" && !e.auto);
        rep.note = "101 Patient Services counts each visit as an entry. From Patient Billing: billed " + fmtNum(billed) +
          ", received " + fmtNum(recv) + ", still owed " + fmtNum(billed - recv) + " UGX in this period.";
        if (extra.length) rep.note += " It also includes " + extra.length + " other 101 entries in the ledger (" +
          fmtNum(sum(extra, e => e.amount_in)) + " UGX, e.g. Dr Henry's clinic income).";
      }
    } else if (kind === "Monthly by cost code") {
      const months = monthList(start, end);
      rep.columns = ["Code", "Category"].concat(months.map(monthShort), ["Total"]);
      rep.money_cols = [];
      for (let i = 2; i < rep.columns.length; i++) rep.money_cols.push(i);
      rep.widths = [70, 240].concat(months.map(() => 85), [115]);
      const grid = new Map();
      for (const e of sel) {
        const k = entryKind(D, e);
        const amt = k === "Revenue" ? e.amount_in - e.amount_out : e.amount_out - e.amount_in;
        const gk = e.code + "\u0000" + k;
        if (!grid.has(gk)) grid.set(gk, {});
        const cell = grid.get(gk), ym = e.date.slice(0, 7);
        cell[ym] = (cell[ym] || 0) + amt;
      }
      const totals = {};
      for (const kn of ["Revenue", "Expense"]) {
        const ks = reportKeys(D, kn, codes, (c, k) => grid.has(c + "\u0000" + k));
        if (!ks.length) continue;
        let colTot = months.map(() => 0);
        for (const c of ks) {
          const cell = grid.get(c + "\u0000" + kn) || {};
          const vals = months.map(m => cell[m] || 0);
          colTot = colTot.map((a, i) => a + vals[i]);
          rep.rows.push([c || "-", name(c)].concat(vals, [vals.reduce((a, b) => a + b, 0)]));
        }
        totals[kn] = colTot;
        totalRow(TOTAL_LABEL[kn], colTot.concat([colTot.reduce((a, b) => a + b, 0)]), 1);
      }
      const rev = totals.Revenue || months.map(() => 0), exp = totals.Expense || months.map(() => 0);
      const net = rev.map((a, i) => a - exp[i]);
      totalRow("NET (revenue - expenses)", net.concat([net.reduce((a, b) => a + b, 0)]), 1);
    } else if (kind === "All transactions") {
      rep.columns = ["Date", "Code", "Description", "Money In", "Money Out", "From", "To", "Notes"];
      rep.money_cols = [3, 4];
      rep.widths = [95, 60, 340, 100, 100, 140, 140, 300];
      let tin = 0, tout = 0;
      for (const e of sel) {
        rep.rows.push([fmtDate(e.date), e.code || "-", e.description, e.amount_in, e.amount_out, e.from_party, e.to_party,
          e.notes]);
        tin += e.amount_in; tout += e.amount_out;
      }
      totalRow("TOTAL (" + sel.length + " entries)", ["", "Net: " + fmtNum(tin - tout), tin, tout, "", "", ""]);
    } else if (kind === BY_PERSON) {
      rep.columns = ["Name", "Date", "Code", "Description", "Received from them", "Paid to them"];
      rep.money_cols = [4, 5];
      rep.widths = [150, 100, 55, 320, 125, 125];
      const people = new Map();
      for (const e of sel) {
        if (e.auto) continue;
        for (const [nm, i, o] of [[e.from_party, e.amount_in, 0], [e.to_party, 0, e.amount_out]]) {
          if (!nm || nm.toLowerCase() === CLINIC.toLowerCase() || (who && nm.toLowerCase().indexOf(who) < 0) || !(i || o)) continue;
          const k = nm.toLowerCase();
          if (!people.has(k)) people.set(k, [nm, []]);
          people.get(k)[1].push([e, i, o]);
        }
      }
      const entr = n => n + " entr" + (n === 1 ? "y" : "ies");
      let tin = 0, tout = 0, nAll = 0;
      for (const [nm, items] of sortBy(Array.from(people.values()), p => -sum(p[1], x => x[1] + x[2]))) {
        for (const [e, i, o] of sortBy(items, x => [x[0].date, x[0].id || 0])) {
          rep.rows.push([nm, fmtDate(e.date), e.code || "-", e.description, i || "", o || ""]);
        }
        const pin = sum(items, x => x[1]), pout = sum(items, x => x[2]);
        totalRow("Total for " + nm, ["", "", entr(items.length), pin, pout]);
        tin += pin; tout += pout; nAll += items.length;
      }
      totalRow("TOTAL (" + people.size + " " + (people.size === 1 ? "person" : "people") + ")",
        ["", "", entr(nAll), tin, tout]);
    } else {
      throw new Error(kind);
    }
    rep.chart = moneyChart(D, kind, sel, entries, start, end, codes, search || who);
    return rep;
  }

  function moneyChart(D, kind, sel, entries, start, end, codes, search) {
    const months = monthList(start, end), labels = months.map(monthShort);
    const ch = { pies: [], bars: null, line: null };
    if (kind === BY_PERSON) {
      const who = (search || "").toLowerCase();
      const frm = counter(), to = counter();
      for (const e of sel) {
        if (e.auto) continue;
        if (e.amount_in && e.from_party && e.from_party.toLowerCase() !== CLINIC.toLowerCase() &&
          e.from_party.toLowerCase().indexOf(who) >= 0) frm.add(e.from_party, e.amount_in);
        if (e.amount_out && e.to_party && e.to_party.toLowerCase() !== CLINIC.toLowerCase() &&
          e.to_party.toLowerCase().indexOf(who) >= 0) to.add(e.to_party, e.amount_out);
      }
      ch.pies = [["Money received, by person", topSlices(Array.from(frm.entries()))],
        ["Money paid out, by person", topSlices(Array.from(to.entries()))]];
    } else {
      const rin = counter(), rout = counter();
      for (const e of sel) {
        if (e.amount_in) rin.add(e.code, e.amount_in);
        if (e.amount_out) rout.add(e.code, e.amount_out);
      }
      const nm = c => (c in D.codeName ? c + " " + D.codeName[c] : UNCODED_LABEL);
      ch.pies = [["Money in, by category", topSlices(Array.from(rin.entries()).map(p => [nm(p[0]), p[1]]))],
        ["Money out, by category", topSlices(Array.from(rout.entries()).map(p => [nm(p[0]), p[1]]))]];
    }
    const mIn = {}, mOut = {};
    for (const m of months) { mIn[m] = 0; mOut[m] = 0; }
    for (const e of sel) {
      const k = e.date.slice(0, 7);
      if (k in mIn) { mIn[k] += e.amount_in; mOut[k] += e.amount_out; }
    }
    ch.bars = { title: "Money in and out by month (UGX)", labels: labels,
      series: [["Money in", months.map(k => mIn[k])], ["Money out", months.map(k => mOut[k])]] };
    const everything = D.allCodes.every(c => codes.indexOf(c) >= 0) && !search;
    let bal = everything ? sum(entries.filter(e => e.date && e.date < start), e => e.amount_in - e.amount_out) : 0;
    const now = isoToday().slice(0, 7), values = [];
    for (const k of months) {
      bal += mIn[k] - mOut[k];
      values.push(k <= now ? bal : null);
    }
    ch.line = { title: everything ? "Cash balance at the end of each month (UGX)" :
      "Running total of the chosen categories, money in minus out (UGX)", labels: labels, values: values, money: true };
    return ch;
  }

  // ------------------------------------------------------------ visits by diagnosis (zion_dx)

  function visitsReport(D, kind, start, end, cats, dxQuery, search) {
    [start, end] = defaultDates(start, end, minMax(D.visits, "visit_date"));
    const q = (dxQuery || "").trim().toLowerCase(), s = (search || "").trim().toLowerCase();
    const catSet = new Set(cats);
    let rows = D.visits.filter(v => v.visit_date && v.visit_date >= start && v.visit_date <= end &&
      (!s || like(v.patient, s) || like(v.diagnosis, s) || like(v.contact, s) || like(v.notes, s) || like(v.status, s)) &&
      catSet.has(v.cat) &&
      (!q || v.diagnosis.toLowerCase().indexOf(q) >= 0 || v.std.toLowerCase().indexOf(q) >= 0));
    rows = sortBy(rows, v => [v.visit_date || "", v.id]);
    const all = D.snap.dx_categories;
    let cap = all.every(c => catSet.has(c)) ? "All diagnosis groups" : cats.join(", ");
    if (q) cap += "  ·  diagnosis: '" + dxQuery.trim() + "'";
    const rep = newRep(kind, start, end, { filter_caption: cap, unit: "counts are visits; money in UGX", visits: true });
    const money = g => {
      const b = sum(g, v => v.billed || 0), p = sum(g, v => v.paid || 0);
      return [b, p, b - p];
    };
    const under5 = g => g.filter(v => v.age_years !== null && v.age_years < 5).length;
    if (kind === "Visits by diagnosis") {
      rep.columns = ["Diagnosis", "Group", "Visits", "Under 5", "Billed", "Paid", "Still owed"];
      rep.widths = [230, 170, 70, 70, 100, 100, 100];
      rep.money_cols = [2, 3, 4, 5, 6];
      const by = groupBy(rows, v => v.std + "\u0000" + v.cat);
      for (const [k, g] of sortBy(Array.from(by.entries()), kv => [-kv[1].length, kv[0].split("\u0000")[0]])) {
        const [std, cat] = k.split("\u0000");
        rep.rows.push([std, cat, g.length, under5(g)].concat(money(g)));
      }
      addTotal(rep, ["TOTAL", by.size + " diagnoses", rows.length, under5(rows)].concat(money(rows)));
    } else if (kind === "Visit list by diagnosis") {
      rep.columns = ["Date", "Patient", "Age", "Diagnosis (as written)", "Diagnosis", "Billed", "Paid", "Balance"];
      rep.widths = [90, 170, 55, 210, 170, 80, 80, 80];
      rep.money_cols = [5, 6, 7];
      for (const v of rows) {
        const b = v.billed, p = v.paid || 0, a = v.age_years;
        const age = a === null ? "" : a >= 1 ? Math.trunc(a) + " y" : Math.max(1, pyRound(a * 12)) + " m";
        rep.rows.push([fmtDate(v.visit_date), v.patient, age, v.diagnosis || "", v.std, b, p,
          b !== null ? (b || 0) - p : null]);
      }
      addTotal(rep, ["TOTAL (" + rows.length + " visits)", "", "", "", ""].concat(money(rows)));
    } else {
      throw new Error(kind);
    }
    rep.note = "Diagnoses are grouped using the clinic's Diagnosis Map, so different spellings count together. " +
      "Under 5 counts visits where the age is known and below 5 years.";
    const ms = monthList(start, end), labels = ms.map(monthShort);
    const young = {}, older = {}, unknown = {};
    for (const k of ms) { young[k] = 0; older[k] = 0; unknown[k] = 0; }
    const byDx = counter(), byCat = counter();
    for (const v of rows) {
      const k = (v.visit_date || "").slice(0, 7);
      if (k in young) {
        const a = v.age_years;
        (a === null ? unknown : a < 5 ? young : older)[k] += 1;
      }
      byDx.add(v.std, 1);
      byCat.add(v.cat, 1);
    }
    const series = [["Under 5", ms.map(k => young[k])], ["5 and over", ms.map(k => older[k])]];
    if (ms.some(k => unknown[k])) series.push(["Age not recorded", ms.map(k => unknown[k])]);
    const now = isoToday().slice(0, 7);
    rep.chart = { pies: [["Visits by diagnosis", topSlices(Array.from(byDx.entries()))],
      ["Visits by diagnosis group", topSlices(Array.from(byCat.entries()))]],
      bars: { title: "Visits by month", labels: labels, series: series, money: false },
      line: { title: "Total visits per month", labels: labels,
        values: ms.map(k => k <= now ? young[k] + older[k] + unknown[k] : null), money: false },
      unit: "visits" };
    return rep;
  }

  // ------------------------------------------------------------ immunisations (zion_imm)

  function immTotals(rows) {
    const m = sum(rows, r => r.male || 0), f = sum(rows, r => r.female || 0), t = sum(rows, r => r.total || 0);
    return [m, f, t - m - f, t];
  }

  function immReport(D, kind, start, end, vaccineList, search, location, programme) {
    [start, end] = defaultDates(start, end, minMax(D.imm, "imm_date"));
    const vs = new Set(vaccineList), s = (search || "").trim().toLowerCase();
    let rows = D.imm.filter(r => r.imm_date >= start && r.imm_date <= end && vs.has(r.vaccine) &&
      (!programme || r.programme === programme) &&
      (!location || r.location.toLowerCase() === location.toLowerCase()) &&
      (!s || [r.vaccine, r.age_group, r.programme, r.location, r.post, r.notes, r.dose].some(x => like(x, s))));
    rows = sortBy(rows, r => [r.imm_date, r.id]).reverse();   // newest first, as the laptop reads them
    let cap = D.snap.imm_vaccines.every(v => vs.has(v)) ? "All vaccines" : vaccineList.join(", ");
    if (location) cap += "  ·  location: " + location;
    if (programme) cap += "  ·  " + programme;
    const rep = newRep(kind, start, end, { filter_caption: cap, unit: "numbers are doses given", imm: true });
    if (kind === "Immunisations by month") {
      rep.columns = ["Month", "Entries", "Male", "Female", "Sex not recorded", "Total"];
      rep.widths = [120, 80, 100, 100, 130, 110];
      rep.money_cols = [1, 2, 3, 4, 5];
      const by = groupBy(rows, r => r.imm_date.slice(0, 7));
      for (const ym of Array.from(by.keys()).sort()) rep.rows.push([monthLong(ym), by.get(ym).length].concat(immTotals(by.get(ym))));
      addTotal(rep, ["TOTAL", rows.length].concat(immTotals(rows)));
    } else if (kind === "Immunisations by vaccine") {
      rep.columns = ["Vaccine", "Dose", "Age group", "Male", "Female", "Sex not recorded", "Total"];
      rep.widths = [160, 80, 120, 90, 90, 120, 100];
      rep.money_cols = [3, 4, 5, 6];
      const order = new Map();
      D.snap.imm_options.forEach((o, i) => { const k = o.join("\u0000"); if (!order.has(k)) order.set(k, i); });
      const by = groupBy(rows, r => [r.vaccine, r.dose || "", r.age_group || ""].join("\u0000"));
      for (const k of sortBy(Array.from(by.keys()), k => (order.has(k) ? order.get(k) : 9999))) {
        rep.rows.push(k.split("\u0000").concat(immTotals(by.get(k))));
      }
      addTotal(rep, ["TOTAL", "", ""].concat(immTotals(rows)));
    } else if (kind === "Immunisations by location") {
      rep.columns = ["Location", "Entries", "Male", "Female", "Sex not recorded", "Total"];
      rep.widths = [180, 80, 100, 100, 130, 110];
      rep.money_cols = [1, 2, 3, 4, 5];
      const by = groupBy(rows, r => r.location || "Not recorded");
      for (const loc of sortBy(Array.from(by.keys()), l => -sum(by.get(l), x => x.total))) {
        rep.rows.push([loc, by.get(loc).length].concat(immTotals(by.get(loc))));
      }
      addTotal(rep, ["TOTAL", rows.length].concat(immTotals(rows)));
    } else if (kind === "Immunisation entries (all)") {
      rep.columns = ["Date", "Vaccine", "Dose", "Age group", "Programme", "Location", "Male", "Female", "Total",
        "Post / notes"];
      rep.widths = [90, 120, 60, 95, 110, 100, 60, 60, 60, 220];
      rep.money_cols = [6, 7, 8];
      for (const r of sortBy(rows, r => [r.imm_date, r.id])) {
        const note = [r.post, r.notes].filter(x => x).join("; ");
        rep.rows.push([fmtDate(r.imm_date), r.vaccine, r.dose || "", r.age_group || "", r.programme || "", r.location || "",
          r.male, r.female, r.total, note]);
      }
      const [m, f, nr, t] = immTotals(rows);
      addTotal(rep, ["TOTAL (" + rows.length + " entries)", "", "", "", "", "", m, f, t,
        nr ? fmtNum(nr) + " sex not recorded" : ""]);
    } else {
      throw new Error(kind);
    }
    const ms = monthList(start, end), labels = ms.map(monthShort);
    const per = {};
    for (const k of ms) per[k] = [0, 0, 0, 0];
    const byV = counter(), byP = counter();
    for (const r of rows) {
      const k = r.imm_date.slice(0, 7);
      if (per[k]) { per[k][0] += r.male || 0; per[k][1] += r.female || 0; per[k][3] += r.total || 0; }
      byV.add(r.vaccine, r.total || 0);
      byP.add(r.programme || "Not recorded", r.total || 0);
    }
    for (const k of ms) per[k][2] = per[k][3] - per[k][0] - per[k][1];
    const series = [["Male", ms.map(k => per[k][0])], ["Female", ms.map(k => per[k][1])]];
    if (ms.some(k => per[k][2])) series.push(["Sex not recorded", ms.map(k => per[k][2])]);
    const now = isoToday().slice(0, 7);
    rep.chart = { pies: [["Doses by vaccine", topSlices(Array.from(byV.entries()))],
      ["Doses by programme", topSlices(Array.from(byP.entries()))]],
      bars: { title: "Doses by month", labels: labels, series: series, money: false },
      line: { title: "Total doses per month", labels: labels, values: ms.map(k => k <= now ? per[k][3] : null), money: false },
      unit: "doses" };
    return rep;
  }

  // ------------------------------------------------------------ eye camps (zion_eye)

  function eyeAgeGroup(years) {
    if (years === null || years === undefined) return "Age not recorded";
    let label = EYE_AGE_GROUPS[0][1];
    for (const [start, name] of EYE_AGE_GROUPS) if (years >= start) label = name;
    return label;
  }

  function eyeReport(D, kind, start, end, conditions, search, district) {
    [start, end] = defaultDates(start, end, minMax(D.eye, "camp_date"));
    const s = (search || "").trim().toLowerCase(), want = new Set(conditions), F = D.flagCols;
    let rows = D.eye.filter(r => r.camp_date >= start && r.camp_date <= end &&
      (!district || r.district.toLowerCase() === district.toLowerCase()) &&
      (!s || [r.patient, r.address, r.findings, r.visual_acuity, r.nin, r.contact, r.notes].some(x => like(x, s))));
    rows = rows.slice().sort((a, b) => (a.camp_date < b.camp_date ? 1 : a.camp_date > b.camp_date ? -1 :
      a.patient.toLowerCase() < b.patient.toLowerCase() ? -1 : a.patient.toLowerCase() > b.patient.toLowerCase() ? 1 :
      b.id - a.id));   // newest camp first, then by name (same name: last entered first), as the laptop reads them
    rows = rows.filter(r => F.some(c => want.has(c) && r[c]) || (want.has(NONE_LABEL) && !F.some(c => r[c])));
    const allC = F.concat([NONE_LABEL]);
    let cap = allC.every(c => want.has(c)) ? "All conditions" : conditions.map(c => D.condLabel[c] || c).join(", ");
    if (district) cap += "  ·  district: " + district;
    const nCamps = new Set(rows.map(r => r.camp_date)).size;
    const rep = newRep(kind, start, end, { filter_caption: cap,
      unit: "counts are patients (" + nCamps + " camp" + (nCamps !== 1 ? "s" : "") + ")", eye: true });
    const sexes = g => {
      const m = g.filter(r => r.sex === "M").length, f = g.filter(r => r.sex === "F").length;
      return [m, f, g.length - m - f];
    };
    const keyCounts = g => [g.filter(r => r.cataract).length, g.filter(r => r.presbyopia).length,
      g.filter(r => r.referred).length];
    const old = g => g.filter(r => (r.age_years || 0) >= 60).length;
    const total = rows.length;
    const pct = n => (total ? pyFixed(100 * n / total, 0) + "%" : "-");
    if (kind === "Eye camp summary") {
      rep.columns = ["Condition", "Patients", "% of patients", "Male", "Female", "Sex not recorded", "Aged 60+"];
      rep.widths = [230, 80, 100, 80, 80, 120, 90];
      rep.money_cols = [1, 3, 4, 5, 6];
      for (const c of F) {
        const g = rows.filter(r => r[c]);
        rep.rows.push([D.condLabel[c], g.length, pct(g.length)].concat(sexes(g), [old(g)]));
      }
      const g = rows.filter(r => !F.some(c => r[c]));
      rep.rows.push([NONE_LABEL, g.length, pct(g.length)].concat(sexes(g), [old(g)]));
      addTotal(rep, ["PATIENTS SEEN", total, total ? "100%" : "-"].concat(sexes(rows), [old(rows)]));
      rep.note = "A patient with more than one condition is counted under each of them.";
    } else if (kind === "Eye camp by age group" || kind === "Eye camp by district") {
      const byAge = kind === "Eye camp by age group";
      rep.columns = [byAge ? "Age group" : "District", "Patients", "Male", "Female", "Sex not recorded", "Cataract",
        "Reading glasses", "Referred"];
      rep.widths = [140, 80, 80, 80, 120, 90, 120, 90];
      rep.money_cols = [1, 2, 3, 4, 5, 6, 7];
      if (byAge) {
        const by = groupBy(rows, r => eyeAgeGroup(r.age_years));
        for (const label of EYE_AGE_GROUPS.map(g => g[1]).concat(["Age not recorded"])) {
          const g = by.get(label);
          if (g && g.length) rep.rows.push([label, g.length].concat(sexes(g), keyCounts(g)));
        }
      } else {
        const by = groupBy(rows, r => r.district || "Not recorded");
        for (const d of sortBy(Array.from(by.keys()), d => [d === "Not recorded" ? 1 : 0, -by.get(d).length])) {
          rep.rows.push([d, by.get(d).length].concat(sexes(by.get(d)), keyCounts(by.get(d))));
        }
      }
      addTotal(rep, ["TOTAL", total].concat(sexes(rows), keyCounts(rows)));
    } else if (kind === "Eye camp patient list") {
      rep.columns = ["Camp", "Patient", "Age", "Sex", "District", "Visual acuity", "Findings / treatment", "Conditions",
        "Glasses"];
      rep.widths = [85, 150, 50, 40, 90, 120, 220, 200, 60];
      for (const r of sortBy(rows, r => [r.camp_date, r.patient.toLowerCase()])) {
        rep.rows.push([fmtDate(r.camp_date), r.patient, r.age || "", r.sex || "", r.district || "",
          (r.visual_acuity || "").split(/\s+/).filter(x => x).join(" "), r.findings || "",
          F.filter(c => r[c]).map(c => D.condLabel[c]).join(", "), r.glasses || ""]);
      }
      addTotal(rep, ["TOTAL (" + total + " patients)", "", "", "", "", "", "", "", ""]);
    } else {
      throw new Error(kind);
    }
    const byCond = counter();
    for (const r of rows) {
      const hits = F.filter(c => r[c]).map(c => D.condLabel[c]);
      for (const h of hits) byCond.add(h, 1);
      if (!hits.length) byCond.add(NONE_LABEL, 1);
    }
    const labels = EYE_AGE_GROUPS.map(g => g[1]);
    const per = {};
    for (const g of labels.concat(["Age not recorded"])) per[g] = [0, 0, 0];
    for (const r of rows) per[eyeAgeGroup(r.age_years)][r.sex === "M" ? 0 : r.sex === "F" ? 1 : 2] += 1;
    const tot = g => per[g][0] + per[g][1] + per[g][2];
    if (tot("Age not recorded")) labels.push("Age not recorded");
    const series = [["Male", labels.map(g => per[g][0])], ["Female", labels.map(g => per[g][1])]];
    if (labels.some(g => per[g][2])) series.push(["Sex not recorded", labels.map(g => per[g][2])]);
    rep.chart = { pies: [["Patients by condition", topSlices(Array.from(byCond.entries()))],
      ["Patients by age group", labels.filter(g => tot(g)).map(g => [g, tot(g)])]],
      bars: { title: "Patients by age group", labels: labels, series: series, money: false },
      line: null, unit: "patients" };
    return rep;
  }

  // ------------------------------------------------------------ HIV tests (zion_hiv)

  function hivTotals(rows) {   // tested, male, female, negative, positive
    const m = sum(rows, r => r.male || 0), f = sum(rows, r => r.female || 0);
    const pos = sum(rows.filter(r => r.result === "Positive"), r => r.total || 0), t = sum(rows, r => r.total || 0);
    return [m, f, t - pos, pos, t];
  }

  function ageOrder(a) {
    const i = HIV_AGE_GROUPS.indexOf(a);
    return i >= 0 ? i : HIV_AGE_GROUPS.length;
  }

  function hivReport(D, kind, start, end, ageGroups, search, location) {
    [start, end] = defaultDates(start, end, minMax(D.hiv, "test_date"));
    const ag = new Set(ageGroups), s = (search || "").trim().toLowerCase();
    let rows = D.hiv.filter(r => r.test_date >= start && r.test_date <= end && ag.has(r.age_group || "") &&
      (!location || r.location.toLowerCase() === location.toLowerCase()) &&
      (!s || [r.location, r.age_group, r.result, r.notes].some(x => like(x, s))));
    rows = sortBy(rows, r => [r.test_date, r.id]).reverse();
    let cap = HIV_AGE_GROUPS.every(a => ag.has(a)) ? "All age groups" :
      "Ages " + ageGroups.map(a => HIV_AGE_LABEL[a] || a).join(", ");
    if (location) cap += "  ·  location: " + location;
    const rep = newRep(kind, start, end, { filter_caption: cap, unit: "numbers are people tested", hiv: true });
    const pct = (pos, t) => (t ? pyFixed(100 * pos / t, 1) + "%" : "");
    const nums = g => { const [m, f, neg, pos, t] = hivTotals(g); return [t, m, f, neg, pos, pct(pos, t)]; };
    const grouped = (first, width, key, order) => {
      rep.columns = [first, "Tested", "Male", "Female", "Negative", "Positive", "% positive"];
      rep.widths = [width, 90, 80, 80, 90, 90, 90];
      rep.money_cols = [1, 2, 3, 4, 5];
      const by = groupBy(rows, key);
      for (const k of sortBy(Array.from(by.keys()), order)) rep.rows.push([k].concat(nums(by.get(k))));
      addTotal(rep, ["TOTAL"].concat(nums(rows)));
    };
    if (kind === "HIV tests by month") {
      grouped("Month", 120, r => r.test_date.slice(0, 7), k => k);
      rep.rows.slice(0, -1).forEach(row => { row[0] = monthLong(row[0]); });
    } else if (kind === "HIV tests by age group") {
      grouped("Age group", 130, r => r.age_group || "Not recorded", ageOrder);
      rep.rows.slice(0, -1).forEach(row => { row[0] = HIV_AGE_LABEL[row[0]] || row[0]; });
    } else if (kind === "HIV tests by location") {
      grouped("Location", 160, r => r.location || "Not recorded", k => k.toLowerCase());
    } else if (kind === "HIV test entries (all)") {
      rep.columns = ["Date", "Location", "Age group", "Result", "Male", "Female", "Total", "Notes"];
      rep.widths = [90, 110, 90, 80, 60, 60, 60, 220];
      rep.money_cols = [4, 5, 6];
      for (const r of sortBy(rows, r => [r.test_date, ageOrder(r.age_group), r.result, r.id])) {
        rep.rows.push([fmtDate(r.test_date), r.location || "", HIV_AGE_LABEL[r.age_group] || r.age_group || "", r.result,
          r.male, r.female, r.total, r.notes || ""]);
      }
      const [m, f, , pos, t] = hivTotals(rows);
      addTotal(rep, ["TOTAL (" + rows.length + " entries)", "", "", fmtNum(pos) + " positive", m, f, t, ""]);
    } else {
      throw new Error(kind);
    }
    const ms = monthList(start, end), labels = ms.map(monthShort);
    const per = {};
    for (const k of ms) per[k] = [0, 0];
    const byAge = counter(), byRes = counter();
    for (const r of rows) {
      const k = r.test_date.slice(0, 7);
      if (per[k]) per[k][r.result === "Positive" ? 1 : 0] += r.total || 0;
      byAge.add(HIV_AGE_LABEL[r.age_group] || r.age_group || "Not recorded", r.total || 0);
      byRes.add(r.result, r.total || 0);
    }
    const now = isoToday().slice(0, 7);
    const agePie = HIV_AGE_GROUPS.filter(a => byAge.get(HIV_AGE_LABEL[a])).map(a => [HIV_AGE_LABEL[a], byAge.get(HIV_AGE_LABEL[a])]);
    if (byAge.get("Not recorded")) agePie.push(["Not recorded", byAge.get("Not recorded")]);
    rep.chart = { pies: [["Results", HIV_RESULTS.filter(k => byRes.get(k)).map(k => [k, byRes.get(k)])],
      ["People tested by age group", agePie]],
      bars: { title: "People tested by month", labels: labels,
        series: [["Negative", ms.map(k => per[k][0])], ["Positive", ms.map(k => per[k][1])]], money: false },
      line: { title: "People tested per month", labels: labels,
        values: ms.map(k => k <= now ? per[k][0] + per[k][1] : null), money: false },
      unit: "people" };
    return rep;
  }

  // ------------------------------------------------------------ one entry point

  /* p: {kind, start, end (ISO dates or null for all), ticks (codes / vaccines / groups / conditions / ages),
         search, person, location, programme, district, dx} */
  function build(D, p) {
    const mode = modeOf(p.kind), search = (p.search || "").trim();
    if (mode === "money") return moneyReport(D, p.kind, p.start, p.end, p.ticks, search, p.person || "");
    if (mode === "visits") return visitsReport(D, p.kind, p.start, p.end, p.ticks, p.dx || "", search);
    if (mode === "imm") return immReport(D, p.kind, p.start, p.end, p.ticks, search, p.location || "", p.programme || "");
    if (mode === "eye") return eyeReport(D, p.kind, p.start, p.end, p.ticks, search, p.district || "");
    return hivReport(D, p.kind, p.start, p.end, p.ticks, search, p.location || "");
  }

  global.ZR = {
    CLINIC, UNCODED, UNCODED_LABEL, BY_PERSON, KINDS, NONE_LABEL, HIV_AGE_GROUPS, HIV_AGE_LABEL, NOT_MAPPED, NOT_RECORDED,
    MONTHS, modeOf, prepare, build, caption, codeLabel, fmtNum, fmtDate, pyFixed, pyRound, isoToday, monthList,
  };
})(typeof window !== "undefined" ? window : globalThis);
