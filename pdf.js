/* Zion Reports: turns a report into a PDF that looks like the laptop's (zion_pdf.py):
   logo and title, optional pie charts, bar graph and line graph, then the table. Uses jsPDF. */
(function (global) {
  "use strict";

  const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const OTHER = "#b5b3ab";
  const INK = "#0b0b0b", INK_2 = "#52514e", MUTED = "#898781", GRID = "#e1e0d9", AXIS = "#c3c2b7";
  const ACCENT = "#3D7A33", ACCENT_LIGHT = "#E8F2DC", RULE = "#D5DDD9";
  const MM = 72 / 25.4;
  const DARK_TEXT = ["#eda100", "#e87ba4", "#1baf7a"];   // slices light enough to need dark labels

  // The PDF's built-in font only has Western European letters; anything else would print as junk.
  const EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”" +
    "•–—˜™š›œžŸ";
  function clean(s) {
    s = s === null || s === undefined ? "" : String(s);
    let out = "";
    for (const ch of s) {
      const c = ch.codePointAt(0);
      out += (c >= 32 && c < 127) || (c >= 160 && c < 256) || EXTRA.indexOf(ch) >= 0 ? ch : c === 10 ? " " : "?";
    }
    return out;
  }

  function k(v) {   // axis labels: 1,250,000 -> 1.25M, 45,000 -> 45k
    const a = Math.abs(v);
    if (a >= 1e6) return ZR.pyFixed(v / 1e6, 2).replace(/0+$/, "").replace(/\.$/, "") + "M";
    if (a >= 1000) return ZR.pyFixed(v / 1000, 0) + "k";
    return ZR.pyFixed(v, 0);
  }

  function niceTicks(lo, hi) {
    if (hi <= lo) hi = lo + 1;
    const raw = (hi - lo) / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step, out = [];
    for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  function make(D, rep, opts, logo) {
    const { jsPDF } = global.jspdf;
    const wide = rep.columns.length > 8;
    const landscape = opts.orientation === "landscape" || (opts.orientation === "auto" && wide);
    const doc = new jsPDF({ unit: "pt", format: "a4", orientation: landscape ? "landscape" : "portrait", compress: true });
    const pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
    const margin = 14 * MM, bottom = pageH - 16 * MM, width = pageW - 2 * margin;
    const now = new Date();
    const generated = ZR.fmtDate(ZR.isoToday()) + " " + String(now.getHours()).padStart(2, "0") + ":" +
      String(now.getMinutes()).padStart(2, "0");
    doc.setProperties({ title: ZR.CLINIC + " - " + rep.title, author: ZR.CLINIC, creator: "Zion Reports" });
    let y = margin;

    const font = (size, bold, color) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(size);
      doc.setTextColor(color || INK);
    };
    const text = (s, x, yy, o) => doc.text(Array.isArray(s) ? s.map(clean) : clean(s), x, yy,
      Object.assign({ baseline: "top" }, o || {}));
    const room = h => { if (y + h > bottom) { doc.addPage(); y = margin; } };
    const para = (s, size, color, bold) => {
      font(size, bold, color);
      const lines = doc.splitTextToSize(clean(s), width);
      room(lines.length * size * 1.35);
      text(lines, margin, y, { lineHeightFactor: 1.35 });
      y += lines.length * size * 1.35;
    };

    // ---------------------------------------------------------------- title block
    const cap = ZR.caption(D, rep, opts.search || "");
    let tx = margin;
    const lh = 17 * MM;
    if (logo) {
      const lw = lh * logo.width / logo.height;
      doc.addImage(logo.data, "JPEG", margin, y, lw, lh, "logo");
      tx = margin + lw + 6 * MM;
    }
    font(9.5, false, INK_2);
    const capLines = doc.splitTextToSize(clean(cap), pageW - margin - tx);
    const blockH = 21 + capLines.length * 13;
    const ty = y + Math.max(0, (lh - blockH) / 2);
    font(17, true, ACCENT);
    text(rep.title, tx, ty);
    font(9.5, false, INK_2);
    text(capLines, tx, ty + 23, { lineHeightFactor: 13 / 9.5 });
    y += Math.max(logo ? lh : 0, blockH) + 6 * MM;

    // ---------------------------------------------------------------- charts
    const ch = rep.chart || {};
    const unit = ch.unit || "UGX";
    if (opts.pies) {
      for (const [title, slices] of ch.pies || []) {
        if (slices.length >= 2) {
          const h = Math.max(190, 34 + 16 * slices.length);
          room(h);
          pie(doc, title, slices, margin, y, h, unit, font, text);
          y += h + 5 * MM;
        } else if (slices.length) {
          para(title + ": all of it is " + slices[0][0] + " (" + ZR.fmtNum(slices[0][1]) + " " + unit + "), so no pie chart.",
            9.5, INK_2);
          y += 4 * MM;
        }
      }
    }
    if (opts.bars && ch.bars) {
      room(230);
      bars(doc, ch.bars, margin, y, width, 230, font, text);
      y += 230 + 5 * MM;
    }
    if (opts.line && ch.line && ch.line.values.filter(v => v !== null).length >= 2) {
      room(210);
      line(doc, ch.line, margin, y, width, 210, font, text);
      y += 210 + 5 * MM;
    }

    // ---------------------------------------------------------------- table
    if (opts.table) {
      if (y + 60 * MM > bottom) { doc.addPage(); y = margin; }
      const money = new Set(rep.money_cols);
      const right = new Set(rep.money_cols);
      rep.columns.forEach((c, i) => { if (c === "Entries" || c === "Visits") right.add(i); });
      const totals = new Set(rep.total_rows);
      const body = rep.rows.map(row => row.map((v, i) =>
        clean(typeof v === "number" && money.has(i) ? ZR.fmtNum(v) : v === null || v === undefined ? "" : String(v))));
      const fit = fitColumns(doc, rep, body, right, width, wide ? 7.5 : 8);
      const columnStyles = {};
      fit.widths.forEach((w, i) => { columnStyles[i] = { cellWidth: w, halign: right.has(i) ? "right" : "left" }; });
      doc.autoTable({
        head: [rep.columns.map(clean)], body: body, startY: y, theme: "plain",
        margin: { left: margin, right: margin, top: margin, bottom: 16 * MM },
        styles: { font: "helvetica", fontSize: fit.size, textColor: INK, valign: "top", overflow: "linebreak",
          cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 }, lineColor: RULE,
          lineWidth: { top: 0, right: 0, bottom: 0.3, left: 0 } },
        headStyles: { fillColor: ACCENT, textColor: "#ffffff", fontStyle: "bold", lineWidth: 0 },
        columnStyles: columnStyles,
        didParseCell: d => {
          if (d.section === "head") d.cell.styles.halign = right.has(d.column.index) ? "right" : "left";
          if (d.section === "body" && totals.has(d.row.index)) {
            d.cell.styles.fillColor = ACCENT_LIGHT;
            d.cell.styles.fontStyle = "bold";
          }
        },
      });
      y = doc.lastAutoTable.finalY;
    }
    if (rep.note) { y += 4 * MM; para(rep.note, 9.5, INK_2); }
    if (!(opts.table || opts.pies || opts.bars || opts.line)) para("Nothing was chosen to include.", 9.5, INK_2);

    // ---------------------------------------------------------------- footer on every page
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) {
      doc.setPage(p);
      font(7.5, false, MUTED);
      doc.text(clean(ZR.CLINIC + " · " + rep.title + " · " + rep.period), margin, pageH - 9 * MM);
      doc.text(clean("Page " + p + "   ·   generated " + generated), pageW - margin, pageH - 9 * MM, { align: "right" });
    }
    return doc;
  }

  /* Column widths from the report's proportions, except that numbers and single words never break:
     number columns get at least their widest figure, and the text shrinks (down to 5 pt) until they fit. */
  function fitColumns(doc, rep, body, right, width, size) {
    const ws = rep.widths && rep.widths.length ? rep.widths : rep.columns.map(() => 1);
    const total = ws.reduce((a, b) => a + b, 0), pad = 6.5;
    const longestWord = s => s.split(/\s+/).reduce((m, w) => Math.max(m, doc.getTextWidth(w)), 0);
    let widths = ws.map(w => w * width / total);
    for (let fs = size; fs >= 5; fs -= 0.5) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(fs);
      const need = rep.columns.map((c, i) => {
        let w = longestWord(c);
        if (right.has(i)) for (const row of body) w = Math.max(w, doc.getTextWidth(row[i]));
        return w + pad;
      });
      const fixed = ws.map((w, i) => Math.max(w * width / total, need[i]));
      const over = fixed.reduce((a, b) => a + b, 0) - width;
      if (over <= 0.5) return { size: fs, widths: fixed.map(w => w - Math.max(0, over) / fixed.length) };
      // take the extra room from text columns wider than they need
      const spare = fixed.map((w, i) => (right.has(i) ? 0 : Math.max(0, w - need[i])));
      const spareSum = spare.reduce((a, b) => a + b, 0);
      if (spareSum >= over) {
        return { size: fs, widths: fixed.map((w, i) => w - spare[i] * over / spareSum) };
      }
      widths = fixed.map(w => w * width / (width + over));
    }
    return { size: 5, widths: widths };
  }

  function sector(doc, cx, cy, r, a0, a1) {   // angles in degrees, counter-clockwise from 3 o'clock
    const pts = [[cx, cy]];
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 3));
    for (let i = 0; i <= steps; i++) {
      const a = (a0 + (a1 - a0) * i / steps) * Math.PI / 180;
      pts.push([cx + r * Math.cos(a), cy - r * Math.sin(a)]);
    }
    const deltas = [];
    for (let i = 1; i < pts.length; i++) deltas.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], "FD", true);
  }

  function pie(doc, title, slices, x, y, h, unit, font, text) {
    const total = slices.reduce((s, p) => s + p[1], 0) || 1, size = 140, r = size / 2;
    font(11, true, INK);
    text(title, x, y);
    const cx = x + 10 + r, cy = y + (h + 24) / 2;
    const colours = slices.map((p, i) => (p[0] === "Other" ? OTHER : SERIES[i % SERIES.length]));
    doc.setDrawColor("#ffffff");
    doc.setLineWidth(1.5);
    let a = 90;
    const mids = [];
    slices.forEach((p, i) => {
      const sweep = 360 * p[1] / total;
      doc.setFillColor(colours[i]);
      if (slices.length === 1 || sweep >= 359.99) {
        doc.circle(cx, cy, r, "FD");
      } else {
        sector(doc, cx, cy, r, a, a - sweep);
      }
      mids.push(a - sweep / 2);
      a -= sweep;
    });
    font(8, true, "#ffffff");
    slices.forEach((p, i) => {
      if (p[1] / total < 0.06) return;
      const m = mids[i] * Math.PI / 180;
      doc.setTextColor(p[0] !== "Other" && DARK_TEXT.indexOf(colours[i]) >= 0 ? INK : "#ffffff");
      doc.text(ZR.pyRound(100 * p[1] / total) + "%", cx + 0.68 * r * Math.cos(m), cy - 0.68 * r * Math.sin(m),
        { align: "center", baseline: "middle" });
    });
    font(8.5, false, INK);
    const lx = x + size + 40;
    slices.forEach((p, i) => {
      const ly = y + 30 + 15 * i;
      doc.setFillColor(colours[i]);
      doc.rect(lx, ly, 8, 8, "F");
      text(p[0].slice(0, 46) + "   " + ZR.fmtNum(p[1]) + " " + unit + "  (" + ZR.pyFixed(100 * p[1] / total, 0) + "%)",
        lx + 14, ly - 0.5);
    });
  }

  function axisLabels(doc, labels, x0, pw, base, font) {
    const n = labels.length, slot = pw / Math.max(1, n);
    font(7, false, INK_2);
    labels.forEach((lab, i) => {
      const cx = x0 + slot * (i + 0.5);
      if (n > 12) {
        const w = doc.getTextWidth(lab), c = Math.SQRT1_2;
        doc.text(lab, cx - w * c + 2, base + 6 + w * c, { angle: 45 });
      } else {
        doc.text(lab, cx, base + 10, { align: "center" });
      }
    });
  }

  function valueAxis(doc, ticks, x0, pw, base, ph, fmt, font) {
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const yOf = v => base - (v - lo) / (hi - lo) * ph;
    font(7, false, MUTED);
    doc.setDrawColor(GRID);
    doc.setLineWidth(0.5);
    for (const t of ticks) {
      const yy = yOf(t);
      doc.line(x0, yy, x0 + pw, yy);
      doc.text(fmt(t), x0 - 4, yy, { align: "right", baseline: "middle" });
    }
    return yOf;
  }

  function bars(doc, spec, x, y, width, h, font, text) {
    font(11, true, INK);
    text(spec.title, x, y);
    font(8.5, false, INK);
    let lx = x + width - 10;
    for (let i = spec.series.length - 1; i >= 0; i--) {
      lx -= doc.getTextWidth(spec.series[i][0]) + 26;
    }
    spec.series.forEach((s, i) => {
      doc.setFillColor(SERIES[i]);
      doc.rect(lx, y + 2, 8, 8, "F");
      text(s[0], lx + 12, y + 1.5);
      lx += doc.getTextWidth(s[0]) + 26;
    });
    const n = spec.labels.length, x0 = x + 44, pw = width - 54;
    const base = y + h - (n > 12 ? 42 : 30), ph = h - (n > 12 ? 100 : 88);
    let hi = 0;
    for (const s of spec.series) for (const v of s[1]) hi = Math.max(hi, v);
    const ticks = niceTicks(0, hi || 1);
    const yOf = valueAxis(doc, ticks, x0, pw, base, ph, spec.money === false ? (v => ZR.pyFixed(v, 0)) : k, font);
    const slot = pw / Math.max(1, n), gap = Math.max(2, 10 - Math.floor(n / 3)), s = spec.series.length;
    const bw = Math.max(0.5, (slot - gap - (s - 1)) / s);
    doc.setDrawColor("#ffffff");
    doc.setLineWidth(0.6);
    for (let i = 0; i < n; i++) {
      spec.series.forEach((ser, j) => {
        const v = ser[1][i];
        if (!v) return;
        const top = yOf(v);
        doc.setFillColor(SERIES[j]);
        doc.rect(x0 + slot * i + gap / 2 + j * (bw + 1), top, bw, base - top, bw > 3 ? "FD" : "F");
      });
    }
    doc.setDrawColor(AXIS);
    doc.line(x0, base, x0 + pw, base);
    axisLabels(doc, spec.labels, x0, pw, base, font);
  }

  function line(doc, spec, x, y, width, h, font, text) {
    const money = spec.money !== false;
    font(11, true, INK);
    text(spec.title, x, y);
    const known = spec.values.filter(v => v !== null);
    font(9, false, INK_2);
    doc.text(clean("Latest: " + ZR.fmtNum(known.length ? known[known.length - 1] : 0) + (money ? " UGX" : "")),
      x + width, y, { align: "right", baseline: "top" });
    const n = spec.labels.length, x0 = x + 44, pw = width - 54;
    const base = y + h - (n > 12 ? 42 : 30), ph = h - (n > 12 ? 84 : 72);
    const lo = Math.min(0, ...known), hi = Math.max(0, ...known);
    const ticks = niceTicks(lo, hi > lo ? hi : lo + 1);
    const yOf = valueAxis(doc, ticks, x0, pw, base, ph, money ? k : (v => ZR.pyFixed(v, 0)), font);
    doc.setDrawColor(AXIS);
    doc.setLineWidth(0.5);
    doc.line(x0, base, x0 + pw, base);
    const slot = pw / Math.max(1, n), pts = spec.values.map((v, i) => (v === null ? null : [x0 + slot * (i + 0.5), yOf(v)]));
    doc.setDrawColor(SERIES[0]);
    doc.setLineWidth(2);
    for (let i = 1; i < pts.length; i++) if (pts[i - 1] && pts[i]) doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (n <= 24) {
      doc.setDrawColor("#ffffff");
      doc.setLineWidth(1);
      doc.setFillColor(SERIES[0]);
      for (const p of pts) if (p) doc.circle(p[0], p[1], 2.6, "FD");
    }
    axisLabels(doc, spec.labels, x0, pw, base, font);
  }

  function fileName(rep, dxQuery) {
    let name = rep.title + " " + ZR.fmtDate(rep.start) + " to " + ZR.fmtDate(rep.end);
    if (rep.person) name += " - " + rep.person;
    if (rep.visits && dxQuery) name += " - " + dxQuery;
    return name.replace(/[\\/:*?"<>|]+/g, "-") + ".pdf";
  }

  global.ZPDF = { make: make, fileName: fileName };
})(window);
