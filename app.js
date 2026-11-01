/* Zion Reports: the screen. Keeps the data from the laptop on this iPad (IndexedDB),
   opens the locked data file with the tablet code, and makes and shares the PDFs. */
(function () {
  "use strict";

  const VERSION = "1.0";
  const MAGIC = "ZIONTAB1";
  const ITERATIONS = 250000;   // same as zion_tablet.py
  const PRESETS = ["This month", "Last month", "This quarter", "This year", "Last year", "Today", "This week", "All time",
    "Custom dates"];
  const GROUPS = { money: "Revenue & expenses", visits: "Patient visits", imm: "Immunisations", eye: "Eye camps",
    hiv: "HIV tests" };
  const PREVIEW_ROWS = 400;

  const $ = id => document.getElementById(id);
  let D = null;               // the prepared data
  let pdf = null;             // {blob, name, url} of the last PDF made
  let pendingFile = null;     // the chosen file, while the code is asked for
  const ticked = {};          // ticks chosen for each kind of report, kept while the app is open

  // ------------------------------------------------------------ small helpers

  function store(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }
  function recall(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("zion-reports", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("kv", mode), req = fn(tx.objectStore("kv"));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const saveData = snap => idb("readwrite", s => s.put(snap, "snapshot"));
  const loadData = () => idb("readonly", s => s.get("snapshot"));
  const clearData = () => idb("readwrite", s => s.delete("snapshot"));

  function iso(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function presetRange(name) {
    const t = new Date(), y = t.getFullYear(), m = t.getMonth();
    const endOf = (yy, mm) => new Date(yy, mm + 1, 0);
    if (name === "Today") return [iso(t), iso(t)];
    if (name === "This week") {
      const s = new Date(y, m, t.getDate() - ((t.getDay() + 6) % 7));
      return [iso(s), iso(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6))];
    }
    if (name === "This month") return [iso(new Date(y, m, 1)), iso(endOf(y, m))];
    if (name === "Last month") return [iso(new Date(y, m - 1, 1)), iso(endOf(y, m - 1))];
    if (name === "This quarter") { const q = 3 * Math.floor(m / 3); return [iso(new Date(y, q, 1)), iso(endOf(y, q + 2))]; }
    if (name === "This year") return [y + "-01-01", y + "-12-31"];
    if (name === "Last year") return [(y - 1) + "-01-01", (y - 1) + "-12-31"];
    return ["", ""];
  }

  function fill(select, values, first) {
    select.innerHTML = "";
    for (const v of (first ? [first] : []).concat(values)) {
      const o = document.createElement("option");
      o.textContent = v;
      o.value = v === first ? "" : v;
      select.appendChild(o);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  // ------------------------------------------------------------ showing the data

  function setData(snap) {
    D = ZR.prepare(snap);
    const kind = $("kind");
    kind.innerHTML = "";
    for (const mode in ZR.KINDS) {
      const g = document.createElement("optgroup");
      g.label = GROUPS[mode];
      for (const k of ZR.KINDS[mode]) {
        const o = document.createElement("option");
        o.textContent = k;
        g.appendChild(o);
      }
      kind.appendChild(g);
    }
    const remembered = recall("zionKind");
    kind.value = remembered && Array.prototype.some.call(kind.options, o => o.value === remembered) ? remembered :
      ZR.KINDS.money[0];
    $("names").innerHTML = snap.names.map(n => "<option value=\"" + esc(n) + "\">").join("");
    $("dxNames").innerHTML = snap.dx_names.map(n => "<option value=\"" + esc(n) + "\">").join("");
    fill($("immLoc"), snap.imm_locations, "All locations");
    fill($("immProg"), snap.imm_programmes, "All programmes");
    fill($("eyeDist"), snap.eye_districts, "All districts");
    fill($("hivLoc"), snap.hiv_locations, "All locations");
    for (const k in ticked) delete ticked[k];
    const made = snap.made || "";
    const days = (Date.now() - new Date(made.replace(" ", "T")).getTime()) / 864e5;
    $("dataInfo").innerHTML = "Data from the laptop:<br><b class=\"" + (days > 7 ? "stale" : "") + "\">" +
      esc(ZR.fmtDate(made.slice(0, 10)) + " " + made.slice(11)) + "</b>";
    $("welcome").classList.add("hidden");
    $("app").classList.remove("hidden");
    kindChanged(true);
  }

  function noData() {
    D = null;
    $("dataInfo").textContent = "No data yet";
    $("app").classList.add("hidden");
    $("welcome").classList.remove("hidden");
  }

  function mode() { return ZR.modeOf($("kind").value); }

  function tickItems() {
    const s = D.snap, m = mode();
    if (m === "money") return D.reportCodes.map(c => [c, ZR.codeLabel(D, c)]);
    if (m === "visits") return s.dx_categories.map(c => [c, c]);
    if (m === "imm") return s.imm_vaccines.map(v => [v, v]);
    if (m === "eye") return s.eye_flags.concat([[ZR.NONE_LABEL, ZR.NONE_LABEL]]);
    return ZR.HIV_AGE_GROUPS.map(a => [a, ZR.HIV_AGE_LABEL[a]]);
  }

  function drawTicks() {
    const m = mode(), items = tickItems();
    const on = new Set(ticked[m] || items.map(i => i[0]));
    $("ticks").innerHTML = items.map(([key, label], i) =>
      "<label><input type=\"checkbox\" data-i=\"" + i + "\"" + (on.has(key) ? " checked" : "") + "> " + esc(label) + "</label>").join("");
    $("ticks").onchange = () => { ticked[m] = currentTicks(); };
  }

  function currentTicks() {
    const items = tickItems();
    return Array.prototype.filter.call($("ticks").querySelectorAll("input"), b => b.checked).map(b => items[+b.dataset.i][0]);
  }

  function setTicks(keys) {
    ticked[mode()] = keys;
    drawTicks();
  }

  function kindChanged(first) {
    const m = mode(), k = $("kind").value;
    store("zionKind", k);
    if (first) {
      $("preset").value = "This year";
      applyPreset();
    }
    if (m === "eye" && ["All time", "Custom dates"].indexOf($("preset").value) < 0) {
      $("preset").value = "All time";   // eye camps are occasional, so start with every camp
      applyPreset();
    }
    $("personRow").classList.toggle("hidden", k !== ZR.BY_PERSON);
    $("dxRow").classList.toggle("hidden", m !== "visits");
    $("immRow").classList.toggle("hidden", m !== "imm");
    $("eyeRow").classList.toggle("hidden", m !== "eye");
    $("hivRow").classList.toggle("hidden", m !== "hiv");
    $("ticksLabel").textContent = { imm: "Vaccines", visits: "Diagnosis groups", eye: "Conditions", hiv: "Age groups" }[m] ?
      { imm: "Vaccines", visits: "Diagnosis groups", eye: "Conditions", hiv: "Age groups" }[m] + " (tick one or more)" :
      "Categories (tick one or more)";
    document.querySelector("[data-q=rev]").disabled = m !== "money";
    document.querySelector("[data-q=exp]").disabled = m !== "money";
    $("lineLabel").textContent = { imm: "Doses line graph", visits: "Visits line graph", hiv: "Tests line graph" }[m] ||
      "Balance line graph";
    $("barsLabel").textContent = m === "eye" ? "Bar graph by age group" : "Bar graph by month";
    $("incLine").disabled = m === "eye";
    drawTicks();
  }

  function applyPreset() {
    const p = $("preset").value;
    if (p === "Custom dates") return;
    const [a, b] = presetRange(p);
    $("from").value = a;
    $("to").value = b;
  }

  function params() {
    const ticks = currentTicks(), m = mode();
    if (!ticks.length) {
      const noun = { imm: "vaccine", visits: "diagnosis group", eye: "condition", hiv: "age group" }[m] || "category";
      throw new Error("Tick at least one " + noun + " (or press All).");
    }
    const a = $("from").value || null, b = $("to").value || null;
    if (a && b && a > b) throw new Error("The From date is after the To date.");
    return { kind: $("kind").value, start: a, end: b, ticks: ticks, search: $("search").value.trim(),
      person: $("person").value.trim(), dx: $("dx").value.trim(),
      location: m === "imm" ? $("immLoc").value : $("hivLoc").value, programme: $("immProg").value,
      district: $("eyeDist").value };
  }

  function build() {
    let p;
    try { p = params(); } catch (e) { alert(e.message); return null; }
    const rep = ZR.build(D, p);
    rep._p = p;
    show(rep);
    return rep;
  }

  function show(rep) {
    $("resultEmpty").classList.add("hidden");
    $("resultBody").classList.remove("hidden");
    $("repTitle").textContent = rep.title;
    $("repCap").textContent = ZR.caption(D, rep, rep._p.search, "   ·   ");
    $("repNote").textContent = rep.note || "";
    const money = new Set(rep.money_cols), right = new Set(rep.money_cols), totals = new Set(rep.total_rows);
    rep.columns.forEach((c, i) => { if (c === "Entries" || c === "Visits") right.add(i); });
    // Long lists show their first rows (and the totals) on screen; the PDF has every row.
    const idx = [];
    rep.rows.forEach((r, i) => { if (i < PREVIEW_ROWS || totals.has(i)) idx.push(i); });
    let html = "<thead><tr>" + rep.columns.map((c, i) => "<th" + (right.has(i) ? " class=r" : "") + ">" + esc(c) + "</th>").join("") +
      "</tr></thead><tbody>";
    for (const i of idx) {
      html += "<tr" + (totals.has(i) ? " class=total" : "") + ">" + rep.rows[i].map((v, j) => "<td" + (right.has(j) ? " class=r" : "") +
        ">" + esc(typeof v === "number" && money.has(j) ? ZR.fmtNum(v) : v === null || v === undefined ? "" : v) + "</td>").join("") + "</tr>";
    }
    $("repTable").innerHTML = html + "</tbody>";
    $("repMore").textContent = idx.length < rep.rows.length ?
      "Showing the first " + PREVIEW_ROWS + " of " + rep.rows.length + " rows here. The PDF has them all." : "";
  }

  // ------------------------------------------------------------ PDF

  let logo = null;
  function loadLogo() {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext("2d");
        g.fillStyle = "#ffffff";   // JPEG has no see-through parts; it keeps the PDF small
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0);
        logo = { data: c.toDataURL("image/jpeg", 0.9), width: img.naturalWidth, height: img.naturalHeight };
        resolve();
      };
      img.onerror = () => resolve();
      img.src = "logo.png";
    });
  }

  function makePdf() {
    const rep = build();
    if (!rep) return;
    const btn = document.querySelector("[data-act=pdf]");
    btn.disabled = true;
    btn.innerHTML = "<span class=spin></span>Making PDF…";
    setTimeout(() => {   // let the button change show before the work starts
      try {
        const doc = ZPDF.make(D, rep, { table: $("incTable").checked, pies: $("incPies").checked, bars: $("incBars").checked,
          line: $("incLine").checked && !$("incLine").disabled, orientation: $("page").value, search: rep._p.search }, logo);
        if (pdf && pdf.url) URL.revokeObjectURL(pdf.url);
        const blob = doc.output("blob");
        pdf = { blob: blob, name: ZPDF.fileName(rep, rep._p.dx), url: URL.createObjectURL(blob) };
        $("readyName").textContent = "PDF ready: " + pdf.name;
        $("ready").classList.add("show");
        $("ready").scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {
        alert("Could not make the PDF:\n" + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Make PDF";
      }
    }, 30);
  }

  async function sharePdf() {
    if (!pdf) return;
    const file = new File([pdf.blob], pdf.name, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: pdf.name.replace(/\.pdf$/, "") });
      } catch (e) {
        if (e.name !== "AbortError") alert("Could not share: " + e.message);
      }
    } else {
      openPdf();
    }
  }

  function openPdf() {
    if (!pdf) return;
    const a = document.createElement("a");
    a.href = pdf.url;
    a.target = "_blank";
    a.download = pdf.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ------------------------------------------------------------ getting the data from the laptop

  function importMsg(text, kind) {
    $("importMsg").innerHTML = text ? "<div class=\"msg " + (kind || "") + "\">" + text + "</div>" : "";
  }

  function openImport() {
    pendingFile = null;
    $("file").value = "";
    $("codeRow").classList.add("hidden");
    $("unlockBtn").classList.add("hidden");
    $("chooseBtn").classList.remove("hidden");
    importMsg("");
    $("importBox").classList.remove("hidden");
  }

  function closeImport() { $("importBox").classList.add("hidden"); }

  function askCode(message) {
    $("codeRow").classList.remove("hidden");
    $("unlockBtn").classList.remove("hidden");
    $("chooseBtn").classList.add("hidden");
    importMsg(message, "bad");
    $("code").focus();
  }

  const normCode = s => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  async function decrypt(buf, code) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: buf.slice(8, 24), iterations: ITERATIONS, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(24, 36) }, key, buf.slice(36));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function tryOpen(code) {
    const buf = new Uint8Array(await pendingFile.arrayBuffer());
    if (String.fromCharCode.apply(null, buf.slice(0, 8)) !== MAGIC) {
      importMsg("That is not a Zion data file. Choose the file named \"Zion data …\" from Downloads.", "bad");
      $("codeRow").classList.add("hidden");
      $("unlockBtn").classList.add("hidden");
      $("chooseBtn").classList.remove("hidden");
      return;
    }
    if (!code) return askCode("Type the tablet code shown in the laptop's Send to tablet window (only needed the first time).");
    importMsg("<span class=spin></span>Opening the data…", "good");
    let snap;
    try {
      snap = await decrypt(buf, code);
    } catch (e) {
      store("zionTabletCode", null);
      return askCode("That code did not open the file. Check the tablet code on the laptop and type it again.");
    }
    if (snap.format !== 1) return importMsg("This file is from a newer laptop program. Please update this app.", "bad");
    await saveData(snap);
    store("zionTabletCode", code);
    setData(snap);
    importMsg("Done: data from " + esc(ZR.fmtDate(snap.made.slice(0, 10)) + " " + snap.made.slice(11)) +
      ". You can delete the downloaded file from Downloads.", "good");
    $("codeRow").classList.add("hidden");
    $("unlockBtn").classList.add("hidden");
    $("chooseBtn").classList.add("hidden");
    setTimeout(closeImport, 1800);
  }

  async function forget() {
    if (!confirm("Remove the clinic data and the tablet code from this iPad? You can get the data again from the laptop.")) return;
    await clearData();
    store("zionTabletCode", null);
    store("zionKind", null);
    noData();
  }

  // ------------------------------------------------------------ wiring

  document.addEventListener("click", e => {
    const t = e.target.closest("[data-act],[data-q]");
    if (!t || t.disabled) return;
    const act = t.dataset.act, q = t.dataset.q;
    if (q) {
      const all = tickItems().map(i => i[0]);
      setTicks(q === "all" ? all : q === "none" ? [] : q === "rev" ? D.revenueCodes : D.expenseCodes);
    }
    if (act === "import") openImport();
    else if (act === "closeImport") closeImport();
    else if (act === "choose") $("file").click();
    else if (act === "unlock") tryOpen(normCode($("code").value)).catch(err => importMsg(esc(err.message), "bad"));
    else if (act === "preview") build();
    else if (act === "pdf") makePdf();
    else if (act === "share") sharePdf();
    else if (act === "open") openPdf();
    else if (act === "forget") forget();
  });

  $("file").addEventListener("change", () => {
    pendingFile = $("file").files[0];
    if (pendingFile) tryOpen(normCode(recall("zionTabletCode"))).catch(err => importMsg(esc(err.message), "bad"));
  });
  $("code").addEventListener("keydown", e => {
    if (e.key === "Enter") tryOpen(normCode($("code").value)).catch(err => importMsg(esc(err.message), "bad"));
  });
  $("kind").addEventListener("change", () => kindChanged(false));
  fill($("preset"), PRESETS);
  $("preset").addEventListener("change", applyPreset);
  for (const id of ["from", "to"]) $(id).addEventListener("change", () => { $("preset").value = "Custom dates"; });
  for (const id of ["search", "person", "dx"]) {
    $(id).addEventListener("keydown", e => { if (e.key === "Enter") { e.target.blur(); build(); } });
  }
  $("version").textContent = "Zion Reports " + VERSION;

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  loadLogo();
  loadData().then(snap => (snap ? setData(snap) : noData())).catch(noData);
})();
