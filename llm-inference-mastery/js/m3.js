/* Module 3 — Hardware, Kernels & Quantization (Q11, Q12, Q13·Q14, Q15) */
(function () {
  "use strict";
  const { h, s, fmt } = LIA;

  // Small scoped styles for tables used in this module (tokens only, so both themes work).
  if (!document.getElementById("m3-style")) {
    document.head.appendChild(h("style", { id: "m3-style", text: `
      .m3-table-wrap { overflow-x: auto; }
      .m3-table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
      .m3-table th, .m3-table td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; white-space: nowrap; }
      .m3-table th { font: 600 11px var(--f-mono); color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
      .m3-table td.num { font-family: var(--f-mono); text-align: right; }
      .m3-dot { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:-1px; }
      .m3-game { display:flex; flex-direction:column; gap:10px; }
      .m3-game .opts { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
    ` }));
  }

  /* =====================================================================
   * Number-format helpers
   * ===================================================================== */
  const FORMATS = {
    fp16: { name: "FP16", kind: "fp", E: 5, M: 10, bias: 15, ieee: true, note: "IEEE half. Inf/NaN reserved." },
    bf16: { name: "BF16", kind: "fp", E: 8, M: 7, bias: 127, ieee: true, note: "FP32's exponent range, 3 sig. digits." },
    e4m3: { name: "FP8 E4M3", kind: "fp", E: 4, M: 3, bias: 7, fn: true, note: "No Inf; only S.1111.111 is NaN → max 448." },
    e5m2: { name: "FP8 E5M2", kind: "fp", E: 5, M: 2, bias: 15, ieee: true, note: "IEEE-like. Wide range, coarse steps (gradients)." },
    e2m1: { name: "FP4 E2M1", kind: "fp", E: 2, M: 1, bias: 1, note: "Only 8 magnitudes: 0, .5, 1, 1.5, 2, 3, 4, 6." },
    int8: { name: "INT8", kind: "int", bits: 8, qmin: -128, qmax: 127, note: "Uniform grid; needs a scale s = absmax/127." },
    int4: { name: "INT4", kind: "int", bits: 4, qmin: -8, qmax: 7, note: "16 levels; needs a scale s = absmax/7 (per group)." },
  };
  const cache = {};
  /** Sorted non-negative representable values: [{v, e, m}] */
  function fpTable(f) {
    const key = f.name;
    if (cache[key]) return cache[key];
    const out = [];
    const emax = (1 << f.E) - 1;
    for (let e = 0; e <= emax; e++) {
      if (f.ieee && e === emax) continue;
      for (let m = 0; m < 1 << f.M; m++) {
        if (f.fn && e === emax && m === (1 << f.M) - 1) continue;
        const v = e === 0 ? (m / (1 << f.M)) * Math.pow(2, 1 - f.bias) : (1 + m / (1 << f.M)) * Math.pow(2, e - f.bias);
        out.push({ v, e, m });
      }
    }
    out.sort((a, b) => a.v - b.v);
    cache[key] = out;
    return out;
  }
  function fpNearest(f, x) {
    const t = fpTable(f);
    const ax = Math.abs(x);
    if (ax >= t[t.length - 1].v) return Object.assign({ sat: ax > t[t.length - 1].v }, t[t.length - 1]);
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid].v <= ax) lo = mid; else hi = mid; }
    const a = t[lo], b = t[hi];
    if (ax - a.v < b.v - ax) return a;
    if (b.v - ax < ax - a.v) return b;
    return a.m % 2 === 0 ? a : b; // ties-to-even
  }
  function fpQ(f, x) { const n = fpNearest(f, x); return Math.sign(x) * n.v; }
  const E2M1 = FORMATS.e2m1, E4M3 = FORMATS.e4m3;

  /* =====================================================================
   * Q11 — Quantization formats
   * ===================================================================== */
  function renderQ11(stage) {
    let fmtKey = "e4m3";
    let x = 3.3;
    let absmax = 8;
    let scaleMode = "lin";

    const fmtSeg = LIA.seg({ label: "Format", options: Object.keys(FORMATS).map((k) => ({ value: k, label: FORMATS[k].name })), value: fmtKey, onChange: (v) => { fmtKey = v; draw(); } });
    const valInput = h("input", { type: "number", id: "q11-val", step: "any", value: x, style: { width: "130px" } });
    valInput.addEventListener("input", () => { const v = parseFloat(valInput.value); if (isFinite(v)) { x = v; draw(); } });
    const quick = h("div", { class: "seg" }, [0.1, 1 / 3, 3.3, 100, 300, 1000, 70000].map((v) =>
      h("button", { type: "button", onClick: () => { x = v; valInput.value = +v.toPrecision(6); draw(); } }, String(+v.toPrecision(3)))));
    const absSl = LIA.slider({ label: "INT calibration absmax", min: 1, max: 64, step: 1, value: absmax, fmt: (v) => "±" + v, onInput: (v) => { absmax = v; draw(); } });
    const lineSeg = LIA.seg({ label: "Number line", options: [{ value: "lin", label: "linear" }, { value: "log", label: "log₂" }], value: scaleMode, onChange: (v) => { scaleMode = v; draw(); } });

    const bitsViz = LIA.viz();
    const lineViz = LIA.viz();
    const st = LIA.stats([
      { key: "in", label: "Input value" },
      { key: "q", label: "Stored value", cls: "accent" },
      { key: "err", label: "Relative error" },
      { key: "max", label: "Max finite / range" },
      { key: "step", label: "Step size near x" },
      { key: "codes", label: "Distinct codes" },
    ]);
    const note = LIA.caption("");

    stage.append(
      fmtSeg.el,
      h("div", { class: "controls" },
        h("div", { class: "ctl" }, h("label", { for: "q11-val" }, h("span", null, "Real value x")), h("div", { class: "num-row" }, valInput)),
        h("div", { class: "ctl" }, h("label", null, h("span", null, "Quick picks")), quick),
        absSl.el, lineSeg.el),
      bitsViz, st.el, note, lineViz
    );

    function draw() {
      const f = FORMATS[fmtKey];
      absSl.el.style.opacity = f.kind === "int" ? 1 : 0.4;
      let q, bits = [], groups, maxv, stepNear, codes;
      if (f.kind === "fp") {
        const n = fpNearest(f, x);
        q = Math.sign(x) * n.v;
        const t = fpTable(f);
        maxv = t[t.length - 1].v;
        const i = t.findIndex((o) => o.v === n.v);
        stepNear = (t[Math.min(i + 1, t.length - 1)].v - t[Math.max(i - 1, 0)].v) / 2;
        codes = Math.pow(2, 1 + f.E + f.M);
        bits.push({ b: x < 0 ? 1 : 0, g: "s" });
        for (let k = f.E - 1; k >= 0; k--) bits.push({ b: (n.e >> k) & 1, g: "e" });
        for (let k = f.M - 1; k >= 0; k--) bits.push({ b: (n.m >> k) & 1, g: "m" });
        groups = [{ g: "s", label: "sign" }, { g: "e", label: `exponent · ${f.E}b · bias ${f.bias}` }, { g: "m", label: `mantissa · ${f.M}b` }];
        const sub = n.e === 0 && n.v > 0;
        const expr = n.v === 0 ? "0" : sub ? `0.${n.m.toString(2).padStart(f.M, "0")}₂ × 2^${1 - f.bias}` : `1.${n.m.toString(2).padStart(f.M, "0")}₂ × 2^(${n.e}−${f.bias})`;
        note.innerHTML = `<b>${f.name}</b>: ${f.note} Decoded: (−1)^s × ${expr}${sub ? " <span class='pill warn'>subnormal</span>" : ""}${n.sat ? " <span class='pill bad'>saturated at max</span>" : ""}`;
        st.set("max", "±" + fmtNum(maxv));
      } else {
        const sc = absmax / f.qmax;
        const qi = Math.max(f.qmin, Math.min(f.qmax, Math.round(x / sc)));
        q = qi * sc;
        stepNear = sc;
        codes = Math.pow(2, f.bits);
        const tc = (qi + (1 << f.bits)) % (1 << f.bits);
        for (let k = f.bits - 1; k >= 0; k--) bits.push({ b: (tc >> k) & 1, g: k === f.bits - 1 ? "s" : "i" });
        groups = [{ g: "s", label: "sign (2's compl.)" }, { g: "i", label: `integer q = ${qi}` }];
        maxv = f.qmax * sc;
        const sat = Math.abs(x / sc) > f.qmax + 0.5;
        note.innerHTML = `<b>${f.name}</b>: ${f.note} Stored q = round(x / s) = round(${fmtNum(x)} / ${fmtNum(sc)}) = ${qi} → x̂ = q·s${sat ? " <span class='pill bad'>clipped: x is outside the calibrated range</span>" : ""}`;
        st.set("max", `±${fmtNum(maxv)} (s=${fmtNum(sc)})`);
      }
      const rel = x === 0 ? 0 : Math.abs(q - x) / Math.abs(x);
      st.set("in", fmtNum(x));
      st.set("q", fmtNum(q));
      st.set("err", fmt.pct(rel, rel < 0.01 ? 3 : 1), rel < 0.01 ? "good" : rel < 0.1 ? "warn" : "bad");
      st.set("step", fmtNum(stepNear));
      st.set("codes", fmt.num(codes));
      drawBits(bits, groups);
      drawLine(f, q);
    }

    function drawBits(bits, groups) {
      const W = 640, n = bits.length, bw = Math.min(36, (W - 20) / n), x0 = (W - bw * n) / 2;
      const svg = LIA.svg(W, 92);
      const col = { s: "var(--bad)", e: "var(--compute)", m: "var(--accent)", i: "var(--sram)" };
      bits.forEach((b, i) => {
        svg.appendChild(s("rect", { x: x0 + i * bw + 1, y: 8, width: bw - 2, height: 40, rx: 4, fill: col[b.g], opacity: b.b ? 0.95 : 0.25 }));
        svg.appendChild(s("text", { x: x0 + i * bw + bw / 2, y: 34, "text-anchor": "middle", "font-size": 15, "font-weight": 600, fill: b.b ? "var(--surface)" : "var(--ink)" }, String(b.b)));
      });
      let i = 0;
      groups.forEach((g) => {
        const cnt = bits.filter((b) => b.g === g.g).length;
        if (!cnt) return;
        const a = x0 + i * bw, z = x0 + (i + cnt) * bw;
        svg.appendChild(s("path", { d: `M${a + 2},56 v6 H${z - 2} v-6`, fill: "none", stroke: col[g.g], "stroke-width": 1.5 }));
        svg.appendChild(s("text", { x: (a + z) / 2, y: 80, "text-anchor": "middle", "font-size": cnt < 3 ? 10 : 11.5, fill: col[g.g] }, cnt < 2 && g.label.length > 6 ? g.label.split(" ")[0] : g.label));
        i += cnt;
      });
      LIA.clear(bitsViz).appendChild(svg);
    }

    function drawLine(f, q) {
      LIA.clear(lineViz);
      let vals;
      if (f.kind === "fp") {
        const t = fpTable(f);
        if (t.length > 400) {
          lineViz.appendChild(LIA.caption(`${f.name} has ${fmt.num(t.length)} non-negative codes, too dense to draw. Pick FP8, FP4 or INT to see the grid.`));
          return;
        }
        vals = t.map((o) => o.v);
      } else {
        const sc = absmax / f.qmax;
        vals = [];
        for (let k = f.qmin; k <= f.qmax; k++) vals.push(k * sc);
      }
      const W = 640, H = 96, L = 24, R = 24;
      const svg = LIA.svg(W, H);
      const pos = vals.filter((v) => v > 0);
      const isLog = scaleMode === "log" && f.kind === "fp";
      const lo = f.kind === "int" ? vals[0] : isLog ? pos[0] : 0;
      const hi = vals[vals.length - 1];
      const X = isLog ? (v) => L + ((Math.log2(v) - Math.log2(lo)) / (Math.log2(hi) - Math.log2(lo))) * (W - L - R) : (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
      svg.appendChild(s("line", { x1: L, x2: W - R, y1: 50, y2: 50, stroke: "var(--line)", "stroke-width": 2 }));
      (isLog ? pos : vals).forEach((v) => svg.appendChild(s("line", { x1: X(v), x2: X(v), y1: 40, y2: 60, stroke: "var(--compute)", "stroke-width": 1.2, opacity: 0.8 })));
      const lab = (v) => svg.appendChild(s("text", { x: X(v), y: 80, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, fmtNum(v)));
      lab(lo); lab(hi);
      if (!isLog && f.kind === "fp") lab(hi / 2);
      const showX = f.kind === "fp" ? Math.abs(x) : x;
      const showQ = f.kind === "fp" ? Math.abs(q) : q;
      if (showX >= lo && showX <= hi && (!isLog || showX > 0)) {
        svg.appendChild(s("line", { x1: X(showX), x2: X(showX), y1: 22, y2: 64, stroke: "var(--ink)", "stroke-width": 1.5, "stroke-dasharray": "3 2" }));
        svg.appendChild(s("text", { x: X(showX), y: 16, "text-anchor": "middle", "font-size": 11, fill: "var(--ink)" }, (f.kind === "fp" ? "|x|=" : "x=") + fmtNum(showX)));
      }
      if (!isLog || showQ > 0) svg.appendChild(s("circle", { cx: X(showQ), cy: 50, r: 6, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }));
      lineViz.append(h("div", { class: "caption" }, isLog ? "Representable magnitudes on a log₂ axis: floats are uniform per octave." : "Representable values on a linear axis: floats bunch near zero; INT is uniform."), svg);
    }
    draw();

    /* --- NVFP4 vs MXFP4 vs INT4 block-scaling lab --- */
    let seed = 7, outlier = false, method = "nvfp4";
    const blockViz = LIA.viz();
    const errViz = LIA.viz();
    const bst = LIA.stats([
      { key: "bits", label: "Bits / element (incl. scales)" },
      { key: "scale", label: "Scale format" },
      { key: "blk", label: "Block size" },
    ]);
    const mSeg = LIA.seg({ options: [{ value: "nvfp4", label: "NVFP4" }, { value: "mxfp4", label: "MXFP4" }, { value: "int4", label: "INT4 g16" }], value: method, onChange: (v) => { method = v; drawBlock(); } });
    const outBtn = LIA.button("Inject outlier", () => { outlier = !outlier; outBtn.textContent = outlier ? "Remove outlier" : "Inject outlier"; drawBlock(); });
    stage.append(
      h("div", { class: "panel-title", style: { marginTop: "8px" } }, "Block scaling: NVFP4 (Blackwell) vs MXFP4 vs INT4"),
      LIA.formula(
        `<span class="dim">NVFP4:</span>  x̂ = <span class="cmp">e2m1</span>(x / (s_blk·s_T)) · s_blk · s_T
        s_blk = <span class="hl">E4M3</span>(amax_blk / 6 / s_T)   <span class="dim">one FP8 scale per 16 elements</span>
        s_T   = amax_tensor / (6 · 448)       <span class="dim">one FP32 scale per tensor</span>
<span class="dim">MXFP4:</span>  one <span class="hl">E8M0</span> (power-of-two) scale per 32 elements`),
      h("div", { class: "row" }, mSeg.el, outBtn, LIA.button("New random weights", () => { seed++; drawBlock(); })),
      blockViz, bst.el, errViz
    );

    function makeData() {
      const r = LIA.rng(seed);
      const d = [];
      for (let i = 0; i < 32; i++) {
        const u = Math.max(1e-9, r()), v = r();
        d.push(0.04 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
      }
      if (outlier) d[5] = 0.55;
      return d;
    }
    function quant(data, m) {
      const out = [], scales = [];
      if (m === "nvfp4") {
        const amaxT = Math.max(...data.map(Math.abs));
        const sT = amaxT / (6 * 448);
        for (let b = 0; b < data.length; b += 16) {
          const blk = data.slice(b, b + 16);
          const amax = Math.max(...blk.map(Math.abs));
          const sb = fpQ(E4M3, amax / 6 / sT);
          const eff = sb * sT;
          scales.push({ from: b, to: b + 16, label: `s_blk=${fmtNum(sb)} (E4M3)` });
          blk.forEach((v) => out.push(eff ? fpQ(E2M1, v / eff) * eff : 0));
        }
      } else if (m === "mxfp4") {
        const amax = Math.max(...data.map(Math.abs));
        const ex = Math.floor(Math.log2(amax)) - 2; // emax of E2M1 is 2
        const sc = Math.pow(2, ex);
        scales.push({ from: 0, to: 32, label: `scale=2^${ex} (E8M0)` });
        data.forEach((v) => out.push(fpQ(E2M1, v / sc) * sc));
      } else {
        for (let b = 0; b < data.length; b += 16) {
          const blk = data.slice(b, b + 16);
          const sc = Math.max(...blk.map(Math.abs)) / 7;
          scales.push({ from: b, to: b + 16, label: `s=${fmtNum(sc)} (FP16)` });
          blk.forEach((v) => out.push(sc ? Math.max(-8, Math.min(7, Math.round(v / sc))) * sc : 0));
        }
      }
      return { out, scales };
    }
    function nrmse(a, b) {
      let e = 0, p = 0;
      a.forEach((v, i) => { e += (v - b[i]) ** 2; p += v * v; });
      return Math.sqrt(e / p);
    }
    function drawBlock() {
      const data = makeData();
      const { out, scales } = quant(data, method);
      const W = 640, H = 220, L = 34, R = 10, T = 26, B = 22;
      const amax = Math.max(...data.map(Math.abs)) * 1.05;
      const cw = (W - L - R) / 32;
      const Y = (v) => T + (H - T - B) / 2 - (v / amax) * ((H - T - B) / 2);
      const svg = LIA.svg(W, H);
      scales.forEach((sc, k) => {
        svg.appendChild(s("rect", { x: L + sc.from * cw, y: T, width: (sc.to - sc.from) * cw, height: H - T - B, fill: k % 2 ? "var(--surface-2)" : "var(--accent-soft)", opacity: 0.7 }));
        svg.appendChild(s("text", { x: L + ((sc.from + sc.to) / 2) * cw, y: 16, "text-anchor": "middle", "font-size": 11, fill: "var(--accent)" }, sc.label));
      });
      svg.appendChild(s("line", { x1: L, x2: W - R, y1: Y(0), y2: Y(0), stroke: "var(--line)" }));
      data.forEach((v, i) => {
        const cx = L + i * cw + cw / 2;
        svg.appendChild(s("rect", { x: cx - cw * 0.3, y: Math.min(Y(v), Y(0)), width: cw * 0.6, height: Math.abs(Y(v) - Y(0)), fill: "var(--muted)", opacity: 0.35 }));
        const bad = Math.abs(out[i] - v) > 0.25 * Math.abs(v) + 0.004;
        svg.appendChild(s("circle", { cx, cy: Y(out[i]), r: 3.6, fill: bad ? "var(--bad)" : "var(--compute)" }));
      });
      svg.appendChild(s("text", { x: L, y: H - 6, "font-size": 11, fill: "var(--muted)" }, "grey bar = original weight · dot = dequantized (red = >25% off)"));
      LIA.clear(blockViz).appendChild(svg);
      const meta = { nvfp4: ["4.5", "FP8 E4M3 + FP32", "16"], mxfp4: ["4.25", "E8M0 (2^k)", "32"], int4: ["5.0", "FP16", "16"] }[method];
      bst.set("bits", meta[0]); bst.set("scale", meta[1]); bst.set("blk", meta[2]);
      const errs = ["nvfp4", "mxfp4", "int4"].map((m) => ({ m, e: nrmse(data, quant(data, m).out) }));
      LIA.clear(errViz).append(
        h("div", { class: "caption" }, "Normalized RMS error, same 32 weights (lower is better)"),
        LIA.hbar({ rows: errs.map((r) => ({ label: { nvfp4: "NVFP4", mxfp4: "MXFP4", int4: "INT4 g16" }[r.m], value: r.e, color: r.m === method ? "var(--accent)" : "var(--muted)" })), fmt: (v) => fmt.pct(v, 1), labelW: 90 })
      );
    }
    drawBlock();

    /* --- memory per parameter + method map --- */
    const P = 70e9;
    const rows = [
      ["FP32", 32], ["BF16 / FP16", 16], ["FP8 (E4M3)", 8], ["INT8 W8A8", 8], ["NVFP4", 4.5], ["INT4 g128 (AWQ/GPTQ)", 4.125],
    ];
    stage.append(
      h("div", { class: "panel-title", style: { marginTop: "8px" } }, "Weights of a 70B model by format"),
      LIA.viz(LIA.hbar({ rows: rows.map(([l, b]) => ({ label: l, value: (P * b) / 8, color: b >= 16 ? "var(--hbm)" : b >= 8 ? "var(--warn)" : "var(--good)" })), fmt: (v) => fmt.bytes(v, 0), labelW: 150, refs: [{ value: 80e9, label: "H100 80GB" }, { value: 141e9, label: "H200 141GB", color: "var(--accent)" }] })),
      h("div", { class: "m3-table-wrap" }, h("table", { class: "m3-table" },
        h("thead", null, h("tr", null, ["Method", "W / A bits", "How", "Retrain?", "Speeds up"].map((c) => h("th", null, c)))),
        h("tbody", null, [
          ["FP8 W8A8", "8 / 8", "per-tensor/channel scale, cast", "PTQ", "prefill + decode (FP8 tensor cores)"],
          ["SmoothQuant W8A8", "8 / 8 INT", "migrate act. outliers into weights", "PTQ", "prefill + decode"],
          ["AWQ W4A16", "4 / 16", "scale salient channels by act. magnitude", "PTQ", "decode (memory-bound)"],
          ["GPTQ W4A16", "4 / 16", "layer-wise, Hessian error compensation", "PTQ", "decode (memory-bound)"],
          ["NVFP4 W4A4", "4 / 4", "16-elem blocks, E4M3 scales", "PTQ or QAT", "both (FP4 tensor cores)"],
          ["QAT", "any", "fake-quant in forward, STE backward", "Yes", "best accuracy at low bits"],
        ].map((r) => h("tr", null, r.map((c, i) => h("td", null, i === 3 ? LIA.pill(c, c === "Yes" ? "warn" : c === "PTQ" ? "good" : "accent") : c)))))
      ))
    );
  }
  function fmtNum(v) {
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return v.toExponential(3);
    return String(+v.toPrecision(5));
  }

  LIA.register({
    id: "q11",
    module: 3,
    q: "Q11",
    title: "Quantization Formats",
    lede: "Every format trades bits between range (exponent) and precision (mantissa); block scaling recovers what 4 bits alone cannot.",
    tags: [{ label: "FP8 · INT4 · NVFP4", kind: "compute" }, { label: "PTQ vs QAT", kind: "accent" }],
    render: renderQ11,
    trace: traceQ11,
    insights: [
      { t: "Exponent buys range, mantissa buys precision.", d: "E4M3 tops out at 448 with 3 mantissa bits; E5M2 reaches 57,344 with only 2. Inference uses E4M3; E5M2 suits gradients." },
      { t: "Integers need a scale.", d: "INT8/INT4 grids are uniform, so one outlier stretches the scale and crushes every other value to a few levels. Smaller groups contain the damage." },
      { t: "NVFP4 = two-level scaling.", d: "An FP8 E4M3 scale per 16 elements plus an FP32 per-tensor scale: 4.5 bits/element, finer than MXFP4's power-of-two scale per 32." },
      { t: "W4A16 speeds decode, not prefill.", d: "AWQ/GPTQ shrink the bytes read per token; math still runs in 16-bit. W8A8/FP8/NVFP4 also use faster tensor cores." },
    ],
    quiz: [
      { type: "mcq", prompt: "Why is FP8 <b>E4M3</b> usually used for weights and activations at inference, rather than E5M2?", options: ["It has a wider dynamic range", "It has one more mantissa bit, so finer steps; the scale factor covers range", "It supports Inf, which E5M2 lacks", "Tensor cores only accept E4M3"], answer: 1, explain: "E4M3 has 3 mantissa bits vs 2. Range (max 448) is handled by per-tensor/per-channel scales. E5M2 keeps range for gradients in training." },
      { type: "num", prompt: "NVFP4 stores 4-bit E2M1 elements with one FP8 scale per 16 elements. Ignoring the single per-tensor FP32 scale, how many <b>bits per element</b> is that?", answer: 4.5, tol: 0.001, unit: "bits", explain: "4 + 8/16 = 4.5 bits per element. MXFP4 (E8M0 scale per 32) is 4 + 8/32 = 4.25." },
      { type: "mcq", prompt: "Which method uses approximate second-order (Hessian) information to adjust not-yet-quantized weights and compensate for quantization error?", options: ["AWQ", "SmoothQuant", "GPTQ", "QAT with straight-through estimator"], answer: 2, explain: "GPTQ quantizes columns one at a time and updates the remaining weights using the inverse Hessian from calibration data. AWQ instead rescales salient channels based on activation magnitudes." },
    ],
  });

  /* =====================================================================
   * Q12 — GPU selection
   * ===================================================================== */
  const GPUS = [
    { id: "H100", mem: 80, bw: 3.35, bf16: 989, fp8: 1979, color: "var(--accent)", note: "SXM, NVLink 900 GB/s" },
    { id: "H200", mem: 141, bw: 4.8, bf16: 989, fp8: 1979, color: "var(--sram)", note: "Same Hopper die, HBM3e" },
    { id: "B200", mem: 180, bw: 8.0, bf16: 2250, fp8: 4500, color: "var(--compute)", note: "Blackwell, NVLink 1.8 TB/s, FP4" },
    { id: "L40S", mem: 48, bw: 0.864, bf16: 362, fp8: 733, color: "var(--hbm)", note: "Ada, GDDR6, PCIe only" },
  ];
  const MODELS = {
    "8b": { name: "Llama-3.1 8B", P: 8e9, L: 32, kv: 8, d: 128 },
    "32b": { name: "Qwen2.5 32B", P: 32.5e9, L: 64, kv: 8, d: 128 },
    "70b": { name: "Llama-3.1 70B", P: 70.6e9, L: 80, kv: 8, d: 128 },
    "405b": { name: "Llama-3.1 405B", P: 405e9, L: 126, kv: 8, d: 128 },
  };

  function renderQ12(stage) {
    let model = "70b", prec = "fp8", kvp = 2;
    const mSel = LIA.select({ label: "Model", options: Object.entries(MODELS).map(([k, v]) => ({ value: k, label: v.name })), value: model, onChange: (v) => { model = v; draw(); } });
    const pSeg = LIA.seg({ label: "Weights", options: [{ value: "bf16", label: "BF16" }, { value: "fp8", label: "FP8" }, { value: "int4", label: "INT4 W4A16" }], value: prec, onChange: (v) => { prec = v; draw(); } });
    const kSeg = LIA.seg({ label: "KV cache", options: [{ value: 2, label: "BF16" }, { value: 1, label: "FP8" }], value: kvp, onChange: (v) => { kvp = v; draw(); } });
    const ctxSl = LIA.slider({ label: "Context per request", min: 10, max: 17, step: 1, value: 13, fmt: (v) => fmt.si(2 ** v) + " tok", onInput: draw });
    const uSl = LIA.slider({ label: "Concurrent requests", min: 1, max: 256, step: 1, value: 32, onInput: draw });

    const fleet = LIA.viz();
    const tableWrap = h("div", { class: "m3-table-wrap" });
    const roof = LIA.viz();
    stage.append(
      h("div", { class: "controls" }, mSel.el, pSeg.el, kSeg.el, ctxSl.el, uSl.el),
      fleet,
      tableWrap,
      LIA.caption("Approximate spec-sheet values, dense (no sparsity). Bounds assume 90% of HBM usable, perfect TP scaling, linear-layer FLOPs only."),
      h("div", { class: "panel-title", style: { marginTop: "8px" } }, "Roofline: where decode and prefill land"),
      roof
    );

    function draw() {
      const M = MODELS[model];
      const bpp = { bf16: 2, fp8: 1, int4: 0.5 }[prec];
      const ctx = 2 ** ctxSl.value, U = uSl.value;
      const W = M.P * bpp;
      const kvTok = 2 * M.L * M.kv * M.d * kvp;
      const KV = kvTok * ctx * U;
      const total = W + KV;
      const res = GPUS.map((g) => {
        const peak = (prec === "fp8" ? g.fp8 : g.bf16) * 1e12;
        const n = Math.ceil(total / (g.mem * 1e9 * 0.9));
        const tp = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 8 ? 8 : Math.ceil(n / 8) * 8;
        const tMem = total / (tp * g.bw * 1e12);
        const tCmp = (2 * M.P * U) / (tp * peak);
        const step = Math.max(tMem, tCmp);
        const ttft = (2 * M.P * ctx) / (tp * peak);
        return { g, n, tp, step, perUser: 1 / step, agg: U / step, ttft, bound: tMem >= tCmp ? "memory" : "compute", peak };
      });

      // fleet
      const Wd = 640, rowH = 54, L = 70;
      const svg = LIA.svg(Wd, 22 + res.length * rowH);
      svg.appendChild(s("rect", { x: L, y: 4, width: 10, height: 10, fill: "var(--accent)" }));
      svg.appendChild(s("text", { x: L + 14, y: 13, "font-size": 11, fill: "var(--muted)" }, `weights ${fmt.bytes(W, 0)}`));
      svg.appendChild(s("rect", { x: L + 140, y: 4, width: 10, height: 10, fill: "var(--hbm)" }));
      svg.appendChild(s("text", { x: L + 154, y: 13, "font-size": 11, fill: "var(--muted)" }, `KV cache ${fmt.bytes(KV, 0)} (${fmt.bytes(kvTok, 0)}/token)`));
      res.forEach((r, i) => {
        const y = 22 + i * rowH;
        svg.appendChild(s("text", { x: L - 8, y: y + 22, "text-anchor": "end", "font-size": 13, "font-weight": 600, fill: r.g.color }, r.g.id));
        svg.appendChild(s("text", { x: L - 8, y: y + 37, "text-anchor": "end", "font-size": 10, fill: "var(--muted)" }, r.g.mem + " GB"));
        const show = Math.min(r.tp, 12), bw = 30, gap = 4;
        const perGpu = total / r.tp / (r.g.mem * 1e9);
        const wFrac = W / total;
        for (let k = 0; k < show; k++) {
          const x = L + k * (bw + gap), hh = 40;
          svg.appendChild(s("rect", { x, y: y + 4, width: bw, height: hh, rx: 3, fill: "var(--surface-2)", stroke: "var(--line)" }));
          const fill = Math.min(1, perGpu) * hh;
          svg.appendChild(s("rect", { x: x + 1, y: y + 4 + hh - fill * wFrac, width: bw - 2, height: fill * wFrac, fill: "var(--accent)" }));
          svg.appendChild(s("rect", { x: x + 1, y: y + 4 + hh - fill, width: bw - 2, height: fill * (1 - wFrac), fill: "var(--hbm)" }));
        }
        svg.appendChild(s("text", { x: L + show * (bw + gap) + 6, y: y + 24, "font-size": 12, "font-weight": 600, fill: "var(--ink)" }, `${r.tp > 12 ? "… " : ""}×${r.tp} GPU${r.tp > 1 ? "s" : ""}`));
        svg.appendChild(s("text", { x: L + show * (bw + gap) + 6, y: y + 39, "font-size": 10.5, fill: "var(--muted)" }, `${fmt.pct(Math.min(1, perGpu), 0)} full · ${r.tp > 8 ? Math.ceil(r.tp / 8) + " nodes" : "1 node"}`));
      });
      LIA.clear(fleet).appendChild(svg);

      LIA.clear(tableWrap).appendChild(h("table", { class: "m3-table" },
        h("thead", null, h("tr", null, ["GPU", "TP", "Decode step", "tok/s per user", "tok/s total", "Bound", "TTFT ≥ (prefill)"].map((c) => h("th", null, c)))),
        h("tbody", null, res.map((r) => h("tr", null,
          h("td", null, h("span", { class: "m3-dot", style: { background: r.g.color } }), r.g.id),
          h("td", { class: "num" }, r.tp),
          h("td", { class: "num" }, fmt.ms(r.step * 1000, 1)),
          h("td", { class: "num" }, fmt.num(r.perUser, 1)),
          h("td", { class: "num" }, fmt.si(r.agg, 1)),
          h("td", null, LIA.pill(r.bound, r.bound === "memory" ? "hbm" : "compute")),
          h("td", { class: "num" }, fmt.ms(r.ttft * 1000, 0))
        )))
      ));

      // roofline
      const xs = [];
      for (let e = 0; e <= 4; e += 0.05) xs.push(10 ** e);
      const series = GPUS.map((g) => {
        const pk = prec === "fp8" ? g.fp8 : g.bf16;
        return { label: g.id, color: g.color, points: xs.map((ai) => [ai, Math.min(pk, ai * g.bw)]) };
      });
      const aiDecode = (2 * M.P * U) / total;
      const aiPrefill = (2 * M.P * ctx) / W;
      const markers = GPUS.map((g) => { const pk = prec === "fp8" ? g.fp8 : g.bf16; return { x: pk / g.bw, y: pk, color: g.color, r: 4 }; });
      LIA.clear(roof).append(
        LIA.lineChart({
          width: 640, height: 300,
          x: { min: 1, max: 10000, log: true, label: "Arithmetic intensity (FLOP / byte of HBM traffic)", fmt: (v) => fmt.si(v) },
          y: { min: 10, max: 10000, log: true, label: "Attainable TFLOPS", fmt: (v) => fmt.si(v) },
          series, markers,
          vlines: [
            { x: Math.max(1, aiDecode), label: `decode ≈ ${fmt.num(aiDecode, 0)}`, color: "var(--hbm)" },
          ].concat(aiPrefill < 4000 ? [{ x: aiPrefill, label: `prefill ≈ ${fmt.si(aiPrefill, 0)}`, color: "var(--compute)" }] : []),
        }),
        LIA.caption(`Dots mark each GPU's ridge point (peak FLOPS ÷ bandwidth). Left of a ridge you are bandwidth-bound. Decode at ${U} concurrent requests sits at ~${fmt.num(aiDecode, 0)} FLOP/B; raise concurrency to push it right, but KV reads grow too. Prefill of a ${fmt.si(ctx)}-token prompt sits at ~${fmt.si(aiPrefill, 0)} FLOP/B, far right of every ridge (compute-bound).`)
      );
    }
    draw();
  }

  LIA.register({
    id: "q12",
    module: 3,
    q: "Q12",
    title: "GPU Selection",
    lede: "Pick silicon by the binding constraint: HBM capacity decides how many GPUs, bandwidth caps decode speed, FLOPS caps prefill.",
    tags: [{ label: "H100 · H200 · B200 · L40S", kind: "accent" }, { label: "Roofline", kind: "hbm" }],
    render: renderQ12,
    trace: traceQ12,
    insights: [
      { t: "Decode ceiling = bandwidth ÷ bytes per step.", d: "Every step reads all weights plus every active KV byte. tok/s per user ≤ BW / (weights + KV)." },
      { t: "Capacity sets the TP degree.", d: "Weights plus KV for all concurrent requests must fit in about 90% of HBM. H200/B200 let a 70B model run with fewer GPUs and more KV headroom." },
      { t: "H200 vs H100: same FLOPS, 1.43× bandwidth.", d: "For memory-bound decode, that ratio shows up almost directly as tokens/s." },
      { t: "L40S is for small models.", d: "48 GB GDDR6 at 864 GB/s and PCIe only, with no NVLink. It is cost-effective for ≤ ~13B, but tensor parallelism across it is slow." },
    ],
    quiz: [
      { type: "num", prompt: "Llama-70B in BF16 (≈140 GB of weights) on one H200 (4.8 TB/s), batch 1, KV ignored. Upper bound on decode <b>tokens/s</b>?", answer: 34.3, tol: 0.05, unit: "tok/s", explain: "Each token needs all weights read once: 4.8e12 / 140e9 ≈ 34 tok/s. Real systems reach about 70–85% of this." },
      { type: "mcq", prompt: "H100 and H200 share the same Hopper compute. For decode of a model that fits on both, H200 is faster mainly because…", options: ["It has more tensor cores", "It has ~1.43× HBM bandwidth (4.8 vs 3.35 TB/s) and more capacity for KV/batch", "It has a higher clock", "It supports FP4"], answer: 1, explain: "Decode is bandwidth-bound. Extra HBM3e bandwidth and 141 GB capacity, which allows larger batches, drive the gain." },
      { type: "mcq", prompt: "Why is L40S a poor fit for serving Llama-3.1 405B?", options: ["It lacks FP8 support", "48 GB GDDR6 at 864 GB/s and no NVLink means many GPUs, slow decode and costly all-reduces over PCIe", "It cannot run Transformer models", "Its FLOPS are higher than B200"], answer: 1, explain: "405B even at FP8 needs about 405 GB, which is 10+ L40S cards over PCIe. Each step's all-reduce over PCIe and the low bandwidth make it slow and inefficient." },
    ],
  });

  /* =====================================================================
   * Q13·Q14 — Profiling timeline
   * ===================================================================== */
  const SCEN = {
    launch: { label: "Launch-bound (small batch)", cpu: 0.25, nK: 60, kUs: 4, launchUs: 8, copy: 0.05, extraSync: false },
    cpu: { label: "CPU scheduler / tokenizer", cpu: 2.6, nK: 40, kUs: 30, launchUs: 6, copy: 0.05, extraSync: false },
    h2d: { label: "Pageable H2D copies", cpu: 0.3, nK: 40, kUs: 30, launchUs: 6, copy: 1.8, extraSync: false },
    sync: { label: "Hidden sync points (.item())", cpu: 0.6, nK: 40, kUs: 30, launchUs: 6, copy: 0.05, extraSync: true },
  };
  const BOTTLENECK_TEXT = {
    launch: "Kernel-launch overhead",
    cpu: "CPU-side scheduling / tokenization",
    h2d: "Synchronous host→device copies",
    sync: "Device→host sync inside the step",
  };

  /** Simulate 3 decode steps. Returns blocks per row and stats. Times in ms. */
  function simulate(p, fx) {
    const rows = { cpu: [], api: [], gpu: [], copy: [] };
    let tc = 0, tg = 0;
    const batch = fx.batch ? 8 : 1;
    const kDur = (p.kUs * (fx.batch ? 1.35 : 1)) / 1000; // memory-bound kernels barely slow down with batch
    const launch = p.launchUs / 1000;
    const pinned = fx.pinned;
    const steps = 3;
    let gpuBusy = 0;
    for (let st = 0; st < steps; st++) {
      rows.cpu.push({ a: tc, b: tc + p.cpu, kind: "cpu", label: "schedule" });
      tc += p.cpu;
      let copyEnd;
      if (pinned) {
        rows.api.push({ a: tc, b: tc + 0.005, kind: "api" });
        rows.copy.push({ a: tc, b: tc + p.copy * 0.45, kind: "copy" });
        copyEnd = tc + p.copy * 0.45;
        tc += 0.005;
      } else {
        rows.cpu.push({ a: tc, b: tc + p.copy, kind: "wait", label: "memcpy" });
        rows.api.push({ a: tc, b: tc + p.copy, kind: "api" });
        rows.copy.push({ a: tc, b: tc + p.copy, kind: "copy" });
        tc += p.copy;
        copyEnd = tc;
      }
      if (fx.graphs) {
        rows.api.push({ a: tc, b: tc + 0.012, kind: "api" });
        tc += 0.012;
        let t = Math.max(tg, tc, copyEnd);
        // a captured graph cannot contain host syncs, so any mid-step sync moves to the step end
        for (let k = 0; k < p.nK; k++) {
          rows.gpu.push({ a: t, b: t + kDur, kind: "k" });
          t += kDur; gpuBusy += kDur;
        }
        tg = t;
      } else {
        for (let k = 0; k < p.nK; k++) {
          rows.api.push({ a: tc, b: tc + launch, kind: "api" });
          tc += launch;
          const a = Math.max(tg, tc, copyEnd);
          rows.gpu.push({ a, b: a + kDur, kind: "k" });
          tg = a + kDur; gpuBusy += kDur;
          if (p.extraSync && k === p.nK / 2 - 1 && tg > tc) {
            rows.cpu.push({ a: tc, b: tg, kind: "wait", label: "sync" });
            tc = tg;
          }
        }
      }
      if (!fx.overlap && tg > tc) {
        rows.cpu.push({ a: tc, b: tg, kind: "wait", label: "sync" });
        tc = tg;
      }
    }
    const span = Math.max(tc, tg);
    return { rows, span, util: gpuBusy / span, step: span / steps, tokPerS: (batch * 1000) / (span / steps), batch };
  }

  function drawTimeline(sim, opts = {}) {
    const W = 640, L = 92, rowH = 30, T = 18;
    const names = [["cpu", "CPU thread"], ["api", "CUDA API"], ["gpu", "GPU stream"], ["copy", "Memcpy H2D"]];
    const H = T + names.length * rowH + 24;
    const svg = LIA.svg(W, H);
    const X = (t) => L + (t / sim.span) * (W - L - 8);
    const col = { cpu: "var(--accent)", wait: "var(--bad)", api: "var(--muted)", k: "var(--compute)", copy: "var(--hbm)" };
    names.forEach(([key, label], i) => {
      const y = T + i * rowH;
      svg.appendChild(s("rect", { x: L, y: y + 3, width: W - L - 8, height: rowH - 6, fill: "var(--surface-2)" }));
      svg.appendChild(s("text", { x: L - 8, y: y + rowH / 2 + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, label));
      sim.rows[key].forEach((b) => {
        const x0 = X(b.a), w = Math.max(0.8, X(b.b) - x0);
        svg.appendChild(s("rect", { x: x0, y: y + 5, width: w, height: rowH - 10, fill: col[b.kind], opacity: b.kind === "wait" ? 0.55 : 0.9 }));
        if (b.label && w > 44) svg.appendChild(s("text", { x: x0 + w / 2, y: y + rowH / 2 + 4, "text-anchor": "middle", "font-size": 10, fill: "var(--surface)" }, b.label));
      });
    });
    // gpu idle shading hint + axis
    const ticks = LIA.niceTicks(0, sim.span, 5);
    ticks.forEach((t) => {
      svg.appendChild(s("line", { x1: X(t), x2: X(t), y1: T, y2: H - 22, stroke: "var(--grid)" }));
      svg.appendChild(s("text", { x: X(t), y: H - 8, "text-anchor": "middle", "font-size": 10, fill: "var(--muted)" }, fmt.num(t, t < 1 && t > 0 ? 2 : 1) + " ms"));
    });
    if (!opts.noLegend) {
      const items = [["CPU work", "cpu"], ["CPU waiting", "wait"], ["launch", "api"], ["kernel", "k"], ["copy", "copy"]];
      let x = L;
      items.forEach(([l, k]) => {
        svg.appendChild(s("rect", { x, y: 4, width: 9, height: 9, fill: col[k] }));
        svg.appendChild(s("text", { x: x + 12, y: 12, "font-size": 10, fill: "var(--muted)" }, l));
        x += 20 + l.length * 6;
      });
    }
    return svg;
  }

  function renderQ13(stage) {
    let scen = "launch";
    const fx = { graphs: false, batch: false, pinned: false, overlap: false };
    const sSeg = LIA.seg({ label: "Scenario", options: Object.entries(SCEN).map(([k, v]) => ({ value: k, label: v.label })), value: scen, onChange: (v) => { scen = v; draw(); } });
    const fixBtns = {};
    const fixDefs = [
      ["graphs", "CUDA Graphs"],
      ["batch", "Batch ×8"],
      ["pinned", "Pinned + async copy"],
      ["overlap", "Overlap CPU scheduling"],
    ];
    const fixRow = h("div", { class: "seg" }, fixDefs.map(([k, l]) => (fixBtns[k] = h("button", { type: "button", "aria-pressed": "false", onClick: () => { fx[k] = !fx[k]; fixBtns[k].setAttribute("aria-pressed", String(fx[k])); draw(); } }, l))));
    const tl = LIA.viz();
    const st = LIA.stats([
      { key: "util", label: "GPU busy (kernel time / wall)" },
      { key: "step", label: "Decode step time" },
      { key: "tok", label: "Throughput (tokens/s)" },
      { key: "diag", label: "Dominant gap" },
    ]);
    stage.append(sSeg.el, h("div", { class: "ctl" }, h("label", null, h("span", null, "Apply fixes (toggle)")), fixRow), tl, st.el);

    function draw() {
      const sim = simulate(SCEN[scen], fx);
      LIA.clear(tl).appendChild(drawTimeline(sim));
      st.set("util", fmt.pct(sim.util), sim.util > 0.8 ? "good" : sim.util > 0.5 ? "warn" : "bad");
      st.set("step", fmt.ms(sim.step, 2));
      st.set("tok", fmt.num(sim.tokPerS, 0));
      const launchT = sim.rows.api.reduce((a, b) => a + b.b - b.a, 0);
      const cpuT = sim.rows.cpu.filter((b) => b.kind === "cpu").reduce((a, b) => a + b.b - b.a, 0);
      const copyT = fx.pinned ? 0 : sim.rows.copy.reduce((a, b) => a + b.b - b.a, 0);
      const parts = [["launches", launchT - copyT], ["CPU work", cpuT], ["blocking copies", copyT]];
      if (sim.util > 0.85) st.set("diag", "GPU-bound ✓", "good");
      else st.set("diag", parts.sort((a, b) => b[1] - a[1])[0][0], "bad");
    }
    draw();

    /* --- diagnosis game --- */
    let score = 0, rounds = 0, answer = null, locked = false;
    const gameViz = LIA.viz();
    const fb = h("div", { class: "explain" });
    const scoreEl = LIA.pill("Score 0/0", "accent");
    const optBox = h("div", { class: "opts" });
    const keys = Object.keys(SCEN);
    function newRound() {
      locked = false;
      const r = Math.random;
      answer = keys[Math.floor(r() * keys.length)];
      const base = SCEN[answer];
      const p = Object.assign({}, base, { cpu: base.cpu * (0.8 + 0.4 * r()), kUs: base.kUs * (0.8 + 0.4 * r()), copy: base.copy * (0.8 + 0.4 * r()) });
      LIA.clear(gameViz).appendChild(drawTimeline(simulate(p, { graphs: false, batch: false, pinned: false, overlap: false }), { noLegend: false }));
      fb.textContent = "Which bottleneck does this profile show?";
      LIA.clear(optBox).append(...keys.map((k) => h("button", { type: "button", class: "opt", onClick: (e) => pick(k, e.currentTarget) }, BOTTLENECK_TEXT[k])));
    }
    const FIX = {
      launch: "Many tiny kernels separated by gaps while the CUDA API row is solid. Fix: CUDA Graphs, kernel fusion, larger batch.",
      cpu: "A long blue CPU block before each burst of kernels while the GPU sits idle. Fix: overlap scheduling with the GPU (async scheduler), move tokenization off the hot loop, or use a faster scheduler.",
      h2d: "An orange memcpy stalls the CPU and the GPU waits on it. Fix: pinned (page-locked) buffers with cudaMemcpyAsync on a side stream, or keep inputs on the GPU.",
      sync: "A red wait in the middle of the step: something like .item(), .cpu() or a print of a tensor forces the CPU to wait for the GPU. Fix: remove host reads from the forward pass.",
    };
    function pick(k, btn) {
      if (locked) return;
      locked = true; rounds++;
      const ok = k === answer;
      if (ok) score++;
      btn.classList.add(ok ? "sel-right" : "sel-wrong");
      if (!ok) [...optBox.children][keys.indexOf(answer)].classList.add("reveal");
      fb.innerHTML = (ok ? "<b>Correct.</b> " : `<b>Not quite: it is ${BOTTLENECK_TEXT[answer].toLowerCase()}.</b> `) + FIX[answer];
      scoreEl.textContent = `Score ${score}/${rounds}`;
    }
    stage.append(
      h("div", { class: "panel-title", style: { marginTop: "8px" } }, h("span", null, "Diagnose the profile"), h("span", { class: "row", style: { gap: "8px" } }, scoreEl, LIA.button("Next profile →", newRound, "small"))),
      h("div", { class: "m3-game" }, gameViz, optBox, fb)
    );
    newRound();
  }

  LIA.register({
    id: "q13",
    module: 3,
    q: "Q13·Q14",
    title: "Profiling & Low GPU Utilization",
    lede: "Read an Nsight Systems timeline the way you'd read an ECG: gaps on the GPU row tell you who is starving it.",
    tags: [{ label: "Nsight Systems", kind: "accent" }, { label: "CUDA Graphs", kind: "compute" }, { label: "Debugging", kind: "warn" }],
    render: renderQ13,
    trace: traceQ13,
    insights: [
      { t: "Start with Nsight Systems, then Nsight Compute.", d: "nsys shows <i>when</i> things run (CPU, API, kernels, copies). ncu explains <i>why</i> one kernel is slow (occupancy, memory throughput, stalls)." },
      { t: "Gaps between kernels = the CPU is the bottleneck.", d: "At decode batch 1, kernels last a few µs, about as long as launching them. CUDA Graphs replay the whole step with one launch." },
      { t: "Pageable memory forces synchronous copies.", d: "The driver stages pageable memory through a pinned bounce buffer. Use pinned buffers and cudaMemcpyAsync on a side stream." },
      { t: "nvidia-smi 'GPU-Util' is misleading.", d: "It is the fraction of time any kernel ran, not SM occupancy. Use DCGM SM-active/occupancy or ncu for real utilization." },
    ],
    quiz: [
      { type: "mcq", prompt: "nsys shows ~80 kernels of 3–5 µs per decode step with gaps between them, and the CUDA API row is solidly busy with <code>cudaLaunchKernel</code>. Best first fix?", options: ["Buy a GPU with more HBM bandwidth", "Capture the decode step in a CUDA Graph (and fuse small kernels)", "Increase tensor-parallel degree", "Switch from FP16 to FP8"], answer: 1, explain: "This is launch-bound. CUDA Graphs replace about 80 launches with one graph launch, which removes the gaps. A faster GPU would just idle more." },
      { type: "num", prompt: "Each decode step launches 80 kernels. Launch overhead is 6 µs per kernel, each kernel runs 3 µs, launches are serialized and the GPU is idle while waiting. Approximate GPU busy %?", answer: 50, tol: 0.04, unit: "%", explain: "The CPU issues one kernel every 6 µs, and each kernel finishes in 3 µs. Busy fraction = 3/6 = 50%. Step time ≈ 80 × 6 µs = 480 µs, of which 240 µs is compute." },
      { type: "mcq", prompt: "nvidia-smi reports 100% GPU-Util but throughput is poor. What does that 100% actually guarantee?", options: ["All SMs are fully occupied", "Tensor cores are saturated", "At least one kernel was running during each sample period", "HBM bandwidth is saturated"], answer: 2, explain: "GPU-Util is only the fraction of time a kernel was executing. A single tiny kernel on 1 SM counts as 100%. Check SM-active, occupancy and DRAM throughput in DCGM or Nsight Compute." },
    ],
  });

  /* =====================================================================
   * Q15 — Fused RMSNorm
   * ===================================================================== */
  const UNFUSED = [
    { name: "x.pow(2)", r: 1, w: 1 },
    { name: ".mean(-1)", r: 1, w: 0 },
    { name: "+ eps", r: 0, w: 0 },
    { name: "rsqrt", r: 0, w: 0 },
    { name: "x * r", r: 1, w: 1 },
    { name: "* weight", r: 1, w: 1 },
  ];
  const FUSED = [{ name: "rmsnorm_kernel", r: 1, w: 1 }];

  function renderQ15(stage) {
    let mode = "unfused", residual = false;
    const modeSeg = LIA.seg({ options: [{ value: "unfused", label: "Unfused PyTorch (6 kernels)" }, { value: "fused", label: "Fused Triton (1 kernel)" }], value: mode, onChange: (v) => { mode = v; restart(); } });
    const cv = LIA.canvas(640, 250);
    stage.append(
      LIA.code("# eager PyTorch: each op is its own kernel and HBM round trip\ny = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + eps) * weight").el,
      modeSeg.el, LIA.viz(cv.el)
    );

    let t = 0;
    function restart() { t = 0; }
    const particles = [];
    const r = LIA.rng(3);
    for (let i = 0; i < 14; i++) particles.push(r());
    LIA.loop((dt) => {
      t += dt * (LIA.reducedMotion ? 0 : 1);
      drawAnim(LIA.reducedMotion ? 1e9 : t);
    });
    function drawAnim(time) {
      const c = LIA.colors(), ctx = cv.ctx, W = 640, H = 250;
      cv.clear();
      const ks = mode === "unfused" ? UNFUSED : FUSED;
      const per = 1.3;
      const total = ks.length * per + 1.2;
      const tt = time % total;
      const cur = Math.floor(tt / per);
      const ph = (tt % per) / per;
      // bands
      ctx.fillStyle = c.sram_soft; LIA.rrect(ctx, 10, 10, W - 20, 50, 8); ctx.fill();
      ctx.fillStyle = c.sram; ctx.font = "600 12px " + getComputedStyle(document.body).fontFamily;
      ctx.fillText("SRAM / registers (on-chip, ~20+ TB/s)", 22, 30);
      ctx.fillStyle = c.hbm_soft; LIA.rrect(ctx, 10, H - 60, W - 20, 50, 8); ctx.fill();
      ctx.fillStyle = c.hbm; ctx.fillText("HBM (off-chip, ~3.35 TB/s on H100)", 22, H - 38);
      // kernels
      const kw = Math.min(92, (W - 40) / ks.length - 8);
      const x0 = (W - ks.length * (kw + 8) + 8) / 2;
      let traffic = 0;
      ks.forEach((k, i) => {
        const x = x0 + i * (kw + 8), y = 102;
        const active = i === cur;
        const done = i < cur || cur >= ks.length;
        if (done || active) traffic += active ? (ph > 0.15 ? k.r : 0) + (ph > 0.85 ? k.w : 0) : k.r + k.w;
        ctx.fillStyle = active ? c.compute : done ? c.compute_soft : c.surface_2;
        LIA.rrect(ctx, x, y, kw, 40, 6); ctx.fill();
        ctx.strokeStyle = active ? c.compute : c.line; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = active ? c.surface : c.ink;
        ctx.font = "11px " + "JetBrains Mono, monospace";
        ctx.textAlign = "center";
        ctx.fillText(k.name, x + kw / 2, y + 24);
        if (active) {
          const cx = x + kw / 2;
          if (k.r && ph < 0.45) {
            particles.forEach((p) => { const yy = H - 60 - (ph / 0.45) * (H - 60 - 60) + p * 8; ctx.fillStyle = c.hbm; ctx.fillRect(cx - kw / 2 + 4 + p * (kw - 10), yy, 5, 5); });
          }
          if (k.w && ph > 0.55) {
            particles.forEach((p) => { const yy = 142 + ((ph - 0.55) / 0.45) * (H - 60 - 142) - p * 8; ctx.fillStyle = c.hbm; ctx.fillRect(cx - kw / 2 + 4 + p * (kw - 10), yy, 5, 5); });
          }
          if (!k.r && !k.w) { ctx.fillStyle = c.muted; ctx.fillText("tiny (N values)", cx, y - 8); }
        }
      });
      ctx.textAlign = "left";
      const totalT = ks.reduce((a, k) => a + k.r + k.w, 0);
      ctx.fillStyle = c.ink; ctx.font = "600 13px JetBrains Mono, monospace";
      ctx.fillText(`HBM traffic: ${traffic}·N·H elements  (total ${totalT}·N·H, ${ks.length} launch${ks.length > 1 ? "es" : ""})`, 22, 84);
    }

    /* bytes calculator */
    const tokSl = LIA.slider({ label: "Tokens in batch (N)", min: 0, max: 14, step: 1, value: 12, fmt: (v) => fmt.num(2 ** v), onInput: calc });
    const hSl = LIA.slider({ label: "Hidden size (H)", min: 1024, max: 16384, step: 1024, value: 8192, fmt: (v) => fmt.num(v), onInput: calc });
    const resSeg = LIA.seg({ label: "Op", options: [{ value: false, label: "RMSNorm" }, { value: true, label: "Residual add + RMSNorm" }], value: residual, onChange: (v) => { residual = v; calc(); } });
    const barViz = LIA.viz();
    const st = LIA.stats([
      { key: "u", label: "Unfused time (H100 BW)" },
      { key: "f", label: "Fused time" },
      { key: "x", label: "Speedup", cls: "good" },
    ]);
    stage.append(h("div", { class: "panel-title", style: { marginTop: "8px" } }, "HBM bytes moved (FP16)"), h("div", { class: "controls" }, tokSl.el, hSl.el, resSeg.el), barViz, st.el);
    function calc() {
      const N = 2 ** tokSl.value, Hh = hSl.value, B = 2, bw = 3.35e12, launch = 4e-6;
      const uE = residual ? 10 : 7, fE = residual ? 4 : 2;
      const uK = residual ? 7 : 6;
      const ub = uE * N * Hh * B, fb = fE * N * Hh * B + Hh * B;
      const ut = ub / bw + uK * launch, ft = fb / bw + launch;
      LIA.clear(barViz).appendChild(LIA.hbar({ rows: [{ label: `Unfused (${uE}·NH)`, value: ub, color: "var(--hbm)" }, { label: `Fused (${fE}·NH)`, value: fb, color: "var(--sram)" }], fmt: (v) => fmt.bytes(v, 1), labelW: 130 }));
      st.set("u", fmt.num(ut * 1e6, 1) + " µs");
      st.set("f", fmt.num(ft * 1e6, 1) + " µs");
      st.set("x", fmt.num(ut / ft, 2) + "×");
    }
    calc();

    /* step-through kernel */
    const X = [0.5, -1.2, 0.8, 2.0, -0.3, 1.1, -0.7, 0.4];
    const Wt = [1.0, 0.9, 1.1, 1.0, 0.95, 1.05, 1.0, 0.9];
    const Hn = X.length;
    const ms = X.reduce((a, v) => a + v * v, 0) / Hn;
    const rstd = 1 / Math.sqrt(ms + 1e-6);
    const Y = X.map((v, i) => v * rstd * Wt[i]);
    const code = LIA.code(`
@triton.jit
def rmsnorm_kernel(X, W, Y, stride, N, eps, BLOCK: tl.constexpr):
    row = tl.program_id(0)                 # one program per token row
    cols = tl.arange(0, BLOCK)             # BLOCK = next_pow2(N)
    mask = cols < N
    x = tl.load(X + row * stride + cols, mask=mask, other=0.).to(tl.float32)
    ms = tl.sum(x * x, axis=0) / N         # reduction stays on-chip
    rstd = tl.rsqrt(ms + eps)
    w = tl.load(W + cols, mask=mask).to(tl.float32)
    y = x * rstd * w
    tl.store(Y + row * stride + cols, y.to(tl.float16), mask=mask)
# launch: rmsnorm_kernel[(n_rows,)](x, w, y, x.stride(0), H, 1e-6, BLOCK=triton.next_power_of_2(H))`);
    const STEPS = [
      { lines: [2], cap: "Grid = one program per row: each token's hidden vector is normalized independently." },
      { lines: [3, 4], cap: "Vector of column offsets; the mask guards the tail when H is not a power of two." },
      { lines: [5], cap: "One coalesced read of the row from HBM into registers (upcast to fp32)." },
      { lines: [6], cap: `Square and reduce on-chip: mean(x²) = ${ms.toFixed(4)}. No intermediate tensor touches HBM.` },
      { lines: [7], cap: `rstd = 1/√(ms+ε) = ${rstd.toFixed(4)}, a single scalar per row.` },
      { lines: [8], cap: "Load γ (weight). Every row shares it, so it stays hot in L2." },
      { lines: [9], cap: "Scale elementwise in registers." },
      { lines: [10], cap: "One write back to HBM. Total traffic: read x + write y (+ γ once)." },
    ];
    let step = 0;
    const diag = LIA.viz();
    const capEl = LIA.caption("");
    const prevB = LIA.button("← Prev", () => go(step - 1), "small");
    const nextB = LIA.button("Next step →", () => go(step + 1), "primary small");
    let auto = null;
    const playB = LIA.button("Auto-play", () => {
      if (auto) { auto(); auto = null; playB.textContent = "Auto-play"; return; }
      playB.textContent = "Pause";
      auto = LIA.every(1600, () => go((step + 1) % STEPS.length));
    }, "small");
    stage.append(
      h("div", { class: "panel-title", style: { marginTop: "8px" } }, "Step through the Triton kernel (H = 8 for illustration)"),
      h("div", { class: "row" }, prevB, nextB, playB),
      h("div", { class: "cols-2" }, h("div", { style: { minWidth: 0 } }, code.el), h("div", { style: { minWidth: 0 } }, diag, capEl))
    );
    function go(i) {
      step = Math.max(0, Math.min(STEPS.length - 1, i));
      code.highlight(STEPS[step].lines);
      capEl.textContent = `Step ${step + 1}/${STEPS.length}: ${STEPS[step].cap}`;
      drawDiag();
    }
    function cellRow(svg, y, vals, color, label, show, textCol) {
      const L = 70, cw = 33;
      svg.appendChild(s("text", { x: L - 6, y: y + 18, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, label));
      vals.forEach((v, i) => {
        svg.appendChild(s("rect", { x: L + i * cw, y, width: cw - 3, height: 26, rx: 3, fill: show ? color : "var(--surface-2)", stroke: "var(--line)" }));
        if (show) svg.appendChild(s("text", { x: L + i * cw + (cw - 3) / 2, y: y + 17, "text-anchor": "middle", "font-size": 9.5, fill: textCol || "var(--surface)" }, v.toFixed(2)));
      });
    }
    function drawDiag() {
      const svg = LIA.svg(360, 270);
      svg.appendChild(s("rect", { x: 2, y: 2, width: 356, height: 118, rx: 8, fill: "var(--sram-soft)" }));
      svg.appendChild(s("text", { x: 10, y: 16, "font-size": 10.5, fill: "var(--sram)", "font-weight": 600 }, "SRAM / registers"));
      svg.appendChild(s("rect", { x: 2, y: 160, width: 356, height: 106, rx: 8, fill: "var(--hbm-soft)" }));
      svg.appendChild(s("text", { x: 10, y: 174, "font-size": 10.5, fill: "var(--hbm)", "font-weight": 600 }, "HBM"));
      const sq = X.map((v) => v * v);
      const regVals = step >= 6 ? Y : step >= 3 ? (step === 3 ? sq : X) : X;
      const regCol = step >= 6 ? "var(--accent)" : step === 3 ? "var(--compute)" : "var(--sram)";
      cellRow(svg, 24, regVals, regCol, step >= 6 ? "y" : step === 3 ? "x²" : "x", step >= 2);
      cellRow(svg, 56, Wt, "var(--sram)", "γ", step >= 5);
      if (step >= 3) {
        svg.appendChild(s("text", { x: 70, y: 106, "font-size": 11, fill: "var(--compute)", "font-weight": 600 }, `ms = ${ms.toFixed(3)}`));
      }
      if (step >= 4) svg.appendChild(s("text", { x: 190, y: 106, "font-size": 11, fill: "var(--compute)", "font-weight": 600 }, `rstd = ${rstd.toFixed(3)}`));
      cellRow(svg, 184, X, "var(--hbm)", "X[row]", true);
      cellRow(svg, 226, Y, "var(--accent)", "Y[row]", step >= 7);
      if (step === 0 || step === 1) svg.appendChild(s("rect", { x: 68, y: 182, width: 8 * 33 + 1, height: 30, rx: 4, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-dasharray": "4 3" }));
      if (step === 2) svg.appendChild(s("path", { d: "M200,180 L200,124", stroke: "var(--hbm)", "stroke-width": 3, "marker-end": "", fill: "none" }));
      if (step === 2) svg.appendChild(s("text", { x: 208, y: 150, "font-size": 11, fill: "var(--hbm)" }, "load ↑"));
      if (step === 7) {
        svg.appendChild(s("path", { d: "M200,124 L200,222", stroke: "var(--hbm)", "stroke-width": 3, fill: "none" }));
        svg.appendChild(s("text", { x: 208, y: 150, "font-size": 11, fill: "var(--hbm)" }, "store ↓"));
      }
      LIA.clear(diag).appendChild(svg);
    }
    go(0);
  }

  LIA.register({
    id: "q15",
    module: 3,
    q: "Q15",
    title: "Fused RMSNorm in Triton",
    lede: "RMSNorm does almost no math, so its cost is bytes moved. Fusion turns seven passes over HBM into two.",
    tags: [{ label: "Triton", kind: "compute" }, { label: "Kernel fusion", kind: "sram" }, { label: "Memory-bound", kind: "hbm" }],
    render: renderQ15,
    trace: traceQ15,
    insights: [
      { t: "Arithmetic intensity ≈ 1 FLOP/byte.", d: "Far left of every roofline ridge. The only lever is moving fewer bytes and launching fewer kernels." },
      { t: "Fusion keeps intermediates in registers.", d: "x², the mean and the scaled tensor never hit HBM. Traffic drops from ~7·N·H to ~2·N·H elements, about 3.5× less." },
      { t: "Accumulate in fp32.", d: "Squares of fp16 activations overflow 65,504 or lose precision. Upcast on load, downcast on store." },
      { t: "Fuse the residual add too.", d: "Production kernels (vLLM's fused_add_rms_norm) read x and the residual once and write both outputs: 10·NH → 4·NH." },
    ],
    quiz: [
      { type: "num", prompt: "Unfused RMSNorm moves ~7·N·H elements through HBM; the fused kernel moves ~2·N·H. For a memory-bound op, what speedup do you expect (ignore launch overhead)?", answer: 3.5, tol: 0.03, unit: "×", explain: "Time ∝ bytes when memory-bound: 7/2 = 3.5×. Fewer launches (6 → 1) widen the gap further at small N." },
      { type: "mcq", prompt: "Why does the kernel compute <code>tl.sum(x * x)</code> in float32 even though inputs are fp16?", options: ["Triton cannot multiply fp16 values", "The sum of squares over thousands of elements can overflow fp16's 65,504 max and loses precision", "fp32 is faster on tensor cores", "To match the weight dtype"], answer: 1, explain: "An 8192-wide row of activations around 3 already sums to about 74k, which overflows fp16. fp32 accumulation is standard for norms and softmax." },
      { type: "mcq", prompt: "Why is BLOCK set to <code>next_power_of_2(H)</code> with a mask?", options: ["tl.arange requires a power-of-two length; the mask disables the out-of-range tail lanes", "To use more shared memory", "Powers of two avoid bank conflicts in HBM", "It is required for tl.rsqrt"], answer: 0, explain: "Triton block shapes must be powers of two. With BLOCK ≥ H, a whole row fits in one program for a single-pass reduction, and the mask makes loads and stores for cols ≥ H no-ops." },
    ],
  });
  /* =====================================================================
   * Worked examples: the shared mocked request (LIA.MOCK) through Module 3
   * ===================================================================== */
  const r3 = (v) => (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : (+v.toFixed(4)).toString());
  const colsN = (n, p = "w") => Array.from({ length: n }, (_, i) => p + i);
  const chunk2 = (arr) => [arr.slice(0, 8), arr.slice(8, 16)];
  function e4m3Bits(x) { const n = fpNearest(E4M3, x); return (x < 0 ? "1" : "0") + " " + n.e.toString(2).padStart(4, "0") + " " + n.m.toString(2).padStart(3, "0"); }
  function e2m1Bits(x) { const n = fpNearest(E2M1, x); return (x < 0 ? "1" : "0") + " " + n.e.toString(2).padStart(2, "0") + " " + n.m.toString(2); }
  function int4Bits(q) { return (q & 0xf).toString(2).padStart(4, "0"); }
  function bitsBlob(rows) {
    return LIA.blob(rows.map((r) => `<span class="dim">${LIA.esc(r[0])}</span>  ${LIA.esc(r[1])}  <span class="hl">${LIA.esc(r[2])}</span>`).join("\n"));
  }

  /* ---------- Q11: quantize one 16-weight block three ways ---------- */
  function traceQ11(M) {
    const paris = M.output[5];
    const W = LIA.toy.weights.Wq;
    const w = [...W[0], ...W[1]]; // 16 consecutive weights (rows 0–1 of toy Wq), a single quantization block
    const amax = Math.max(...w.map(Math.abs));
    // FP8 E4M3, per-tensor scale
    const s8 = amax / 448;
    const q8 = w.map((v) => fpQ(E4M3, v / s8));
    const d8 = q8.map((q) => q * s8);
    // INT4 symmetric, group of 16
    const s4 = amax / 7;
    const q4 = w.map((v) => LIA.clamp(Math.round(v / s4), -8, 7));
    const d4 = q4.map((q) => q * s4);
    // NVFP4: FP32 per-tensor scale + E4M3 per-16 block scale + E2M1 elements
    const sT = amax / (448 * 6);
    const sB = fpQ(E4M3, amax / 6 / sT);
    const eff = sB * sT;
    const qN = w.map((v) => fpQ(E2M1, v / eff));
    const dN = qN.map((q) => q * eff);
    const err = (d) => d.map((v, i) => v - w[i]);
    const mse = (d) => err(d).reduce((a, e) => a + e * e, 0) / d.length;
    const x = LIA.toy.embed([paris])[0];
    const dot = (wr) => x.reduce((a, v, i) => a + v * wr[i], 0);
    const yRef = dot(w.slice(0, 8)), y8 = dot(d8.slice(0, 8)), y4 = dot(d4.slice(0, 8)), yN = dot(dN.slice(0, 8));
    const m2 = (arr, o = {}) => LIA.matrix(chunk2(arr), Object.assign({ rows: ["w0–7", "w8–15"], d: 3, diverge: true, color: "var(--compute)", neg: "var(--hbm)" }, o));

    function errChart() {
      const Wd = 620, Hd = 170, padL = 34, bw = (Wd - padL - 6) / 16;
      const sets = [{ d: d8, c: "var(--sram)", k: "FP8 E4M3" }, { d: d4, c: "var(--hbm)", k: "INT4 g16" }, { d: dN, c: "var(--compute)", k: "NVFP4" }];
      const emax = Math.max(...sets.flatMap((st) => err(st.d).map(Math.abs)), 1e-6);
      const svg = LIA.svg(Wd, Hd, { "aria-label": "Per-element quantization error" });
      const base = Hd - 22;
      svg.appendChild(s("line", { x1: padL, x2: Wd - 4, y1: base, y2: base, stroke: "var(--line)" }));
      svg.appendChild(s("text", { x: padL - 4, y: 26, "text-anchor": "end", "font-size": 10, fill: "var(--muted)" }, emax.toFixed(3)));
      svg.appendChild(s("text", { x: padL - 4, y: base, "text-anchor": "end", "font-size": 10, fill: "var(--muted)" }, "0"));
      for (let i = 0; i < 16; i++) {
        sets.forEach((st, k) => {
          const e = Math.abs(st.d[i] - w[i]);
          const hh = (e / emax) * (base - 22);
          svg.appendChild(s("rect", { x: padL + i * bw + 2 + k * ((bw - 4) / 3), y: base - hh, width: (bw - 4) / 3 - 1, height: Math.max(hh, 0.5), fill: st.c }));
        });
        svg.appendChild(s("text", { x: padL + i * bw + bw / 2, y: Hd - 8, "text-anchor": "middle", "font-size": 9.5, fill: "var(--muted)" }, i));
      }
      sets.forEach((st, k) => {
        svg.appendChild(s("rect", { x: padL + k * 150, y: 4, width: 10, height: 10, fill: st.c }));
        svg.appendChild(s("text", { x: padL + 14 + k * 150, y: 13, "font-size": 11, fill: "var(--ink)" }, `${st.k} · MSE ${mse(st.d).toExponential(1)}`));
      });
      return LIA.viz(svg);
    }

    return [
      {
        k: "Pick a block",
        op: "slice 16 weights",
        where: "offline · quantizer",
        inLabel: "Toy Wq (8×8, mocked weights)",
        input: () => LIA.matrix(W, { d: 2, diverge: true, highlight: (i) => i < 2, caption: "seeded random toy weights; rows 0–1 highlighted" }),
        outLabel: "One 16-element block (BF16)",
        output: () => h("div", { class: "stage", style: { gap: "8px" } }, m2(w), LIA.kv([["absmax", r3(amax)], ["bytes in BF16", "16 × 2 B = 32 B"]])),
        note: "Quantization works on blocks: one scale is shared by a group of neighbouring weights. Everything below uses these exact 16 numbers.",
      },
      {
        k: "FP8 E4M3",
        op: "x / s → E4M3",
        where: "per-tensor scale",
        inLabel: "Scale",
        input: () => LIA.formula(`s = absmax / 448\n  = ${r3(amax)} / 448\n  = <span class="hl">${s8.toExponential(3)}</span>\n\nw0 / s = ${r3(w[0] / s8)}`),
        outLabel: "Codes (S EEEE MMM) → value",
        output: () => h("div", { class: "stage", style: { gap: "8px" } },
          bitsBlob(w.slice(0, 5).map((v, i) => [`w${i} ${v >= 0 ? " " : ""}${v.toFixed(2)}`, e4m3Bits(v / s8), `→ ${r3(q8[i])} × s = ${r3(d8[i])}`])),
          LIA.caption("first 5 of 16 shown · 8 bits each = 16 B total")),
        note: "E4M3 has 3 mantissa bits, so values near the top of the range land on a grid about 6% apart. The scale maps absmax onto 448, the largest E4M3 value.",
      },
      {
        k: "INT4 per group",
        op: "round(x / s), clamp [−8, 7]",
        where: "group of 16 · FP16 scale",
        inLabel: "Scale",
        input: () => LIA.formula(`s = absmax / 7\n  = ${r3(amax)} / 7\n  = <span class="hl">${r3(s4)}</span>`),
        outLabel: "Integer codes (two's complement)",
        output: () => h("div", { class: "stage", style: { gap: "8px" } },
          LIA.matrix(chunk2(q4), { rows: ["q0–7", "q8–15"], d: 0, diverge: true, max: 8 }),
          bitsBlob(q4.slice(0, 4).map((q, i) => [`q${i} ${q >= 0 ? " " : ""}${q}`, int4Bits(q), `→ ${r3(q * s4)}`]))),
        note: "Only 16 evenly spaced levels. Small weights collapse to 0 or ±1 step, which is where most INT4 error comes from.",
      },
      {
        k: "NVFP4 two-level",
        op: "E4M3 block scale + E2M1",
        where: "Blackwell FP4 tensor cores",
        inLabel: "Scales",
        input: () => LIA.formula(`s_T   = amax / (448·6)        = ${sT.toExponential(3)}  <span class="dim">FP32, per tensor</span>\ns_blk = E4M3(amax / 6 / s_T)  = <span class="hl">${r3(sB)}</span>  <span class="dim">FP8, per 16</span>\nstep  = s_blk · s_T           = ${r3(eff)}`),
        outLabel: "E2M1 codes (S EE M) → value",
        output: () => h("div", { class: "stage", style: { gap: "8px" } },
          LIA.matrix(chunk2(qN), { rows: ["c0–7", "c8–15"], d: 1, diverge: true, max: 6 }),
          bitsBlob(w.slice(0, 4).map((v, i) => [`w${i} ${v >= 0 ? " " : ""}${v.toFixed(2)}`, e2m1Bits(v / eff), `→ ${qN[i]} → ${r3(dN[i])}`]))),
        note: "E2M1 can only say 0, 0.5, 1, 1.5, 2, 3, 4 or 6. The FP8 block scale stretches that grid to fit each block of 16.",
      },
      {
        k: "Dequantize & compare",
        op: "x̂ = code · scale",
        where: "inside the GEMM",
        inLabel: "Original block",
        input: () => m2(w),
        outLabel: "|error| per weight",
        output: errChart,
        note: "Same 16 weights, three formats. Watch INT4 and NVFP4 diverge on the small weights, where the coarse grid rounds hardest.",
      },
      {
        k: "Effect on one output",
        op: "y = x_Paris · w",
        where: "8-wide dot product",
        inLabel: `Toy hidden state of “${LIA.showTok(paris.t)}”`,
        input: () => h("div", { class: "stage", style: { gap: "8px" } }, LIA.tokens([paris], { cls: () => "out" }), LIA.matrix([x], { cols: colsN(8, "x"), d: 2, diverge: true })),
        outLabel: "y and its error per format",
        output: () => h("div", { class: "stage", style: { gap: "8px" } },
          LIA.kv([["BF16 (reference)", r3(yRef)], ["FP8 E4M3", r3(y8)], ["INT4 g16", r3(y4)], ["NVFP4", r3(yN)]]),
          LIA.hbar({ width: 380, labelW: 90, valW: 90, rowH: 24, fmt: (v) => "Δ " + r3(v),
            rows: [["FP8 E4M3", y8, "var(--sram)"], ["INT4 g16", y4, "var(--hbm)"], ["NVFP4", yN, "var(--compute)"]].map(([l, v, c]) => ({ label: l, value: Math.abs(v - yRef), color: c })) })),
        note: "This toy y sums only 8 terms and sits near zero, so 4-bit errors look large. Real layers sum 8,192 terms where errors partly cancel; outliers that don't cancel are what hurt, which is why AWQ and GPTQ protect them.",
      },
      {
        k: "Bytes for the whole model",
        op: "bits / param × 70.6B",
        where: "HBM footprint",
        inLabel: "This block",
        input: () => LIA.kv([["BF16", "32 B"], ["FP8", "16 B (+ 1 shared scale)"], ["INT4 g16", "8 B + 2 B scale = 5 bits/w"], ["NVFP4", "8 B + 1 B scale = 4.5 bits/w"]]),
        outLabel: `${M.model.name} weights`,
        output: () => LIA.hbar({ width: 380, labelW: 90, valW: 70, rowH: 26, fmt: (v) => fmt.num(v, 0) + " GB",
          rows: [["BF16", 16, "var(--ink)"], ["FP8", 8, "var(--sram)"], ["INT4 g16", 5, "var(--hbm)"], ["NVFP4", 4.5, "var(--compute)"]].map(([l, b, c]) => ({ label: l, value: (M.model.params * b) / 8 / 1e9, color: c })) }),
        note: "Fewer weight bytes means fewer bytes to stream every decode step, so 4-bit weights speed up memory-bound decode as well as saving HBM.",
      },
    ];
  }

  /* ---------- Q12: this request on each GPU ---------- */
  function traceQ12(M) {
    const P = M.model.params, Wb = P * 2;
    const nP = M.prompt.length, nO = M.output.length, nT = nP + nO;
    const kvTok = M.model.kvBytesPerToken, kvReq = kvTok * nT;
    const rows = GPUS.map((g) => {
      const n = Math.ceil(Wb / (g.mem * 1e9 * 0.9));
      const bw = g.bw * 1e12 * n, fl = g.bf16 * 1e12 * n;
      const preC = (2 * P * nP) / fl, preM = Wb / bw;
      const pre = Math.max(preC, preM);
      const dec = (Wb + kvReq) / bw;
      return { g, n, bw, fl, preC, preM, pre, dec, total: pre + (nO - 1) * dec };
    });
    const ms = (v) => fmt.num(v * 1000, v < 0.01 ? 2 : 1) + " ms";
    const bar = (key, f, o = {}) => LIA.hbar(Object.assign({ width: 380, labelW: 70, valW: 110, rowH: 26, rows: rows.map((r) => ({ label: `${r.n}× ${r.g.id}`, value: r[key], color: r.g.color, note: f(r) })) }, o));
    return [
      {
        k: "The request",
        op: "count tokens",
        where: "API server",
        inLabel: "Prompt + generated answer",
        input: () => h("div", { class: "stage", style: { gap: "6px" } }, LIA.tokens(M.prompt, { ids: false }), LIA.tokens(M.output, { ids: false, cls: () => "out" })),
        outLabel: "Sizing inputs",
        output: () => LIA.kv([["model", `${M.model.name} · BF16`], ["prompt tokens", nP], ["output tokens", nO], ["total context", nT], ["weights", fmt.bytes(Wb)]]),
        note: "A short chat turn: 28 prompt tokens in, 8 tokens out. Small requests like this are typical, and they behave very differently from the 32K-token stress case.",
      },
      {
        k: "Its KV cache",
        op: "tokens × 327,680 B",
        where: "2·L·H_kv·d·2 B",
        inLabel: "Per token",
        input: () => LIA.formula(`2 × ${M.model.L} × ${M.model.Hkv} × ${M.model.dHead} × 2 B\n= <span class="hbm">${fmt.num(kvTok)} B</span> per token`),
        outLabel: "This request",
        output: () => h("div", { class: "stage", style: { gap: "8px" } }, LIA.formula(`${nT} tokens × ${fmt.num(kvTok)} B\n= <span class="hbm">${fmt.num(kvReq)} B ≈ ${fmt.bytes(kvReq)}</span>`), LIA.caption(`That is ${(kvReq / Wb * 100).toFixed(4)}% of the weights. For a single short request, weights dominate everything.`)),
        note: "KV memory only becomes the constraint when you multiply by long contexts and many users (see Q3).",
      },
      {
        k: "GPUs for the weights",
        op: "⌈weights / (0.9 · HBM)⌉",
        where: "capacity check",
        inLabel: "HBM per GPU",
        input: () => LIA.kv(GPUS.map((g) => [g.id, `${g.mem} GB · ${g.bw} TB/s`])),
        outLabel: "Minimum GPUs (BF16)",
        output: () => bar("n", (r) => `${r.n} GPU${r.n > 1 ? "s" : ""} · ${fmt.num(r.n * r.g.mem)} GB`, { fmt: (v) => v }),
        note: "Capacity decides the GPU count before speed is even considered. 141 GB of BF16 weights fit on one B200, but need 4 L40S cards.",
      },
      {
        k: "Prefill 28 tokens",
        op: "max(FLOPs/peak, bytes/BW)",
        where: "roofline",
        inLabel: "Work",
        input: () => LIA.formula(`FLOPs = 2 · P · ${nP} = <span class="cmp">${fmt.si(2 * P * nP, 2)}</span>\nbytes ≈ weights   = <span class="hbm">${fmt.bytes(Wb)}</span>\nintensity ≈ ${nP} FLOP/B  <span class="dim">(ridge ≈ 295)</span>`),
        outLabel: "Prefill time = TTFT floor",
        output: () => h("div", { class: "stage", style: { gap: "8px" } }, bar("pre", (r) => `${ms(r.pre)} · ${r.preM > r.preC ? "BW" : "FLOPs"}`), LIA.caption(`compute alone would take only ${rows.map((r) => r.g.id + " " + ms(r.preC)).join(" · ")}`)),
        note: "A 28-token prompt is far below the ridge point, so even prefill is bandwidth-bound here. Prefill only becomes compute-bound past a few hundred tokens.",
      },
      {
        k: "Decode “Paris”",
        op: "(weights + KV) / BW",
        where: "one step",
        inLabel: "Bytes per decode step",
        input: () => h("div", { class: "stage", style: { gap: "8px" } }, LIA.tokens(M.output.slice(0, 6), { cls: (t, i) => (i === 5 ? "out" : "") }), LIA.formula(`${fmt.bytes(Wb)} + ${fmt.bytes(kvReq)} KV\n≈ <span class="hbm">${fmt.bytes(Wb + kvReq)}</span> per token`)),
        outLabel: "TPOT bound",
        output: () => bar("dec", (r) => `${ms(r.dec)} · ${fmt.num(1 / r.dec, 0)} tok/s`),
        note: "Every new token streams all 141 GB again, so aggregate HBM bandwidth sets TPOT directly.",
      },
      {
        k: "Whole request",
        op: "TTFT + 7 × TPOT",
        where: "end-to-end",
        inLabel: "Timeline",
        input: () => LIA.formula(`token 1 ← prefill\ntokens 2–8 ← 7 decode steps`),
        outLabel: "Latency to “.<|eot_id|>”",
        output: () => bar("total", (r) => ms(r.total)),
        note: "B200 wins on latency through bandwidth alone. The L40S needs 4 cards and is still slowest, because GDDR6 is about 4× slower than HBM3.",
      },
      {
        k: "Batch 64 of them",
        op: "share each weight read",
        where: "continuous batching",
        inLabel: "Step bytes, batch 64",
        input: () => LIA.formula(`weights ${fmt.bytes(Wb)} (once)\n+ KV 64 × ${fmt.bytes(kvReq)} = ${fmt.bytes(64 * kvReq)}`),
        outLabel: "Throughput per node",
        output: () => LIA.hbar({ width: 380, labelW: 70, valW: 110, rowH: 26, rows: rows.map((r) => { const st = (Wb + 64 * kvReq) / r.bw; return { label: `${r.n}× ${r.g.id}`, value: 64 / st, color: r.g.color, note: `${fmt.num(64 / st, 0)} tok/s` }; }) }),
        note: "64 requests cost barely more per step than one, so throughput rises about 60×. This is why cost per token depends so heavily on batch size.",
      },
    ];
  }

  /* ---------- Q13: one decode step as kernel launches (mocked µs) ---------- */
  function traceQ13(M) {
    const LAYER = [
      ["rmsnorm", 3], ["qkv_gemm", 9], ["rope", 2], ["paged_attn", 6], ["o_proj", 5], ["all_reduce", 8],
      ["rmsnorm", 3], ["gate_up_gemm", 18], ["silu_mul", 2], ["down_gemm", 10], ["all_reduce", 8],
    ];
    const LAUNCH = 12; // µs of eager PyTorch + cudaLaunchKernel per op (mocked)
    const gpuLayer = LAYER.reduce((a, k) => a + k[1], 0);
    const L = M.model.L;
    // eager: each kernel starts when both its launch finished and the previous kernel finished
    function sched(eager) {
      let cpu = 0, gpu = 0;
      const out = [];
      LAYER.forEach(([name, d]) => {
        let ready;
        if (eager) { cpu += LAUNCH; ready = cpu; } else ready = 0;
        const st = Math.max(ready, gpu);
        gpu = st + d;
        out.push({ name, d, cpuEnd: eager ? cpu : 0, st, en: gpu });
      });
      return { out, end: gpu, cpu };
    }
    const eg = sched(true), gr = sched(false);
    const eagerStep = L * Math.max(eg.end, eg.cpu) + 40, graphStep = 20 + L * gpuLayer + 40;
    function timeline(sc, eager) {
      const Wd = 480, Hd = 112, x0 = 62;
      const total = Math.max(eg.end, eg.cpu, 140);
      const X = (u) => x0 + (u / total) * (Wd - x0 - 8);
      const svg = LIA.svg(Wd, Hd, { "aria-label": "Kernel timeline for one layer" });
      svg.appendChild(s("text", { x: 4, y: 30, "font-size": 12, fill: "var(--muted)" }, eager ? "CPU" : "CPU"));
      svg.appendChild(s("text", { x: 4, y: 64, "font-size": 12, fill: "var(--muted)" }, "GPU"));
      if (eager) sc.out.forEach((k) => svg.appendChild(s("rect", { x: X(k.cpuEnd - LAUNCH) + 0.5, y: 18, width: X(LAUNCH) - x0 - 1, height: 18, rx: 2, fill: "var(--muted)", opacity: 0.55 })));
      else svg.appendChild(s("rect", { x: X(0), y: 18, width: 6, height: 18, rx: 2, fill: "var(--accent)" }));
      sc.out.forEach((k, i) => {
        svg.appendChild(s("rect", { x: X(k.st) + 0.5, y: 52, width: Math.max(X(k.en) - X(k.st) - 1, 1), height: 18, rx: 2, fill: k.name === "all_reduce" ? "var(--sram)" : "var(--compute)" }));
        if (i > 0 && k.st > sc.out[i - 1].en + 0.01) svg.appendChild(s("rect", { x: X(sc.out[i - 1].en), y: 52, width: X(k.st) - X(sc.out[i - 1].en), height: 18, fill: "var(--bad)", opacity: 0.25 }));
      });
      [0, 50, 100].forEach((u) => { if (u <= total) { svg.appendChild(s("line", { x1: X(u), x2: X(u), y1: 76, y2: 82, stroke: "var(--line)" })); svg.appendChild(s("text", { x: X(u), y: 94, "text-anchor": "middle", "font-size": 11.5, fill: "var(--muted)" }, u + " µs")); } });
      svg.appendChild(s("text", { x: Wd - 8, y: 108, "text-anchor": "end", "font-size": 12, fill: "var(--ink)" }, `layer = ${Math.round(Math.max(sc.end, sc.cpu))} µs · GPU busy ${Math.round((gpuLayer / Math.max(sc.end, sc.cpu)) * 100)}%`));
      return LIA.viz(svg);
    }
    const prev = M.output[4], next = M.output[5];
    return [
      {
        k: "Schedule the step",
        op: "build batch metadata",
        where: "CPU · scheduler",
        inLabel: "State before step 6",
        input: () => h("div", { class: "stage", style: { gap: "6px" } }, LIA.tokens(M.output.slice(0, 5), { cls: (t, i) => (i === 4 ? "hl" : "out") }), LIA.caption(`last token “${LIA.showTok(prev.t)}” · KV holds ${M.prompt.length + 4} tokens`)),
        outLabel: "Tensors for the GPU",
        output: () => LIA.blob(`input_ids     = [<span class="hl">${prev.id}</span>]\npositions     = [${M.prompt.length + 4}]\nblock_table   = [[17, 4, 92]]   <span class="dim"># 16-token blocks</span>\nslot_mapping  = [${92 * 16 + ((M.prompt.length + 4) % 16)}]\nseq_lens      = [${M.prompt.length + 5}]`),
        note: "The scheduler only decides which tokens to run; the GPU needs these few small tensors to run the step. Block numbers here are mocked.",
      },
      {
        k: "Copy to GPU",
        op: "H2D memcpy",
        where: "PCIe",
        inLabel: "Host buffers · mocked timings",
        input: () => LIA.kv([["pageable", "staged through a bounce buffer, synchronous ≈ 10 µs each"], ["pinned + async", "DMA straight from host memory, overlaps ≈ 2 µs"]]),
        outLabel: "Cost for 5 tiny tensors",
        output: () => LIA.hbar({ width: 380, labelW: 110, valW: 70, rowH: 26, fmt: (v) => v + " µs", rows: [{ label: "pageable", value: 50, color: "var(--bad)" }, { label: "pinned async", value: 10, color: "var(--good)" }] }),
        note: "A few dozen bytes still pay fixed latency per copy. Pinned memory plus one batched async copy removes the stall.",
      },
      {
        k: "One layer, eager",
        op: `${LAYER.length} kernel launches`,
        where: "PyTorch eager · TP=8",
        inLabel: "Kernels in layer 0 · mocked timings",
        input: () => LIA.kv(LAYER.map(([n, d]) => [n, d + " µs"])),
        outLabel: "Nsight-style timeline",
        output: () => timeline(eg, true),
        note: `Each launch costs ~${LAUNCH} µs on the CPU, but most kernels finish faster than that. The red gaps are the GPU waiting for the CPU.`,
      },
      {
        k: "× 80 layers",
        op: "repeat per layer",
        where: "full forward pass",
        inLabel: "Per layer",
        input: () => LIA.kv([["CPU launch time", `${LAYER.length} × ${LAUNCH} = ${LAYER.length * LAUNCH} µs`], ["GPU kernel time", `${gpuLayer} µs`]]),
        outLabel: "Per decode step",
        output: () => LIA.hbar({ width: 380, labelW: 110, valW: 90, rowH: 26, fmt: (v) => fmt.num(v / 1000, 2) + " ms", rows: [{ label: "CPU launches", value: L * LAYER.length * LAUNCH, color: "var(--muted)" }, { label: "GPU kernels", value: L * gpuLayer, color: "var(--compute)" }] }),
        note: `${L * LAYER.length} launches per token. The CPU side takes longer than the GPU work, so the step is CPU-bound.`,
      },
      {
        k: "CUDA Graph replay",
        op: "cudaGraphLaunch × 1",
        where: "captured once at startup",
        inLabel: "Same kernels, recorded",
        input: () => LIA.caption(`All ${L * LAYER.length} kernels and their arguments are captured into one graph per batch size. Replay is a single launch.`),
        outLabel: "Timeline after the fix",
        output: () => timeline(gr, false),
        note: "With launch overhead gone, kernels run back to back. The step is now limited by GPU time, which is mostly weight reads.",
      },
      {
        k: "Sample & sync",
        op: "top-p → .item()",
        where: "GPU → CPU",
        inLabel: "Logits [1 × 128,256]",
        input: () => LIA.tokens([next, ...M.candidates.slice(1, 4)], { cls: (t, i) => (i === 0 ? "out" : "dim") }),
        outLabel: "Next token",
        output: () => h("div", { class: "stage", style: { gap: "6px" } }, LIA.tokens([next], { cls: () => "out" }), LIA.caption("4-byte D2H copy forces a sync: the CPU can't schedule step 7 until it knows this token (unless it overlaps scheduling)")),
        note: "The token ID must reach the CPU for detokenizing and stop checks. Overlapped schedulers prepare step 7 while step 6 is still running.",
      },
      {
        k: "Result",
        op: "compare TPOT",
        where: "per output token",
        inLabel: "Step time (mocked)",
        input: () => LIA.kv([["eager", fmt.num(eagerStep / 1000, 2) + " ms"], ["CUDA Graph", fmt.num(graphStep / 1000, 2) + " ms"]]),
        outLabel: "Tokens / s for this request",
        output: () => LIA.hbar({ width: 380, labelW: 100, valW: 90, rowH: 26, fmt: (v) => fmt.num(v, 0) + " tok/s", rows: [{ label: "eager", value: 1e6 / eagerStep, color: "var(--bad)" }, { label: "CUDA Graph", value: 1e6 / graphStep, color: "var(--good)" }] }),
        note: `Same math, ${(eagerStep / graphStep).toFixed(1)}× faster. At batch 1, launch overhead is often the biggest single fix.`,
      },
    ];
  }

  /* ---------- Q15: RMSNorm on the toy hidden state of " Paris" ---------- */
  function traceQ15(M) {
    const paris = M.output[5];
    const x = LIA.toy.embed([paris])[0];
    const g = LIA.rng(77);
    const gamma = x.map(() => +(0.8 + g() * 0.4).toFixed(2));
    const eps = 1e-5;
    const sq = x.map((v) => v * v);
    const ms = sq.reduce((a, b) => a + b, 0) / x.length;
    const rstd = 1 / Math.sqrt(ms + eps);
    const xn = x.map((v) => v * rstd);
    const y = xn.map((v, i) => v * gamma[i]);
    const cols = colsN(8, "");
    const row = (arr, o = {}) => LIA.matrix([arr], Object.assign({ cols, d: 3, diverge: true }, o));
    const loc = (sram) => h("div", { class: "row", style: { gap: "6px" } }, LIA.pill(sram ? "in SRAM / registers" : "in HBM", sram ? "sram" : "hbm"));
    const H = M.model.dModel;
    const unfusedB = 7 * H * 2, fusedB = 2 * H * 2;
    return [
      {
        k: "Load the row",
        op: "tl.load(x_ptr + cols)",
        where: "HBM → SRAM · 1 read",
        inLabel: `Hidden state of “${LIA.showTok(paris.t)}” (toy, d=8)`,
        input: () => h("div", { class: "stage", style: { gap: "8px" } }, LIA.tokens([paris], { cls: () => "out" }), row(x), loc(false)),
        outLabel: "x (upcast to fp32)",
        output: () => h("div", { class: "stage", style: { gap: "8px" } }, row(x), loc(true)),
        note: "One program handles one token's row. This is the only time x is read from HBM.",
      },
      {
        k: "Square",
        op: "x * x",
        where: "registers",
        inLabel: "x",
        input: () => row(x),
        outLabel: "x²",
        output: () => h("div", { class: "stage", style: { gap: "8px" } }, row(sq, { color: "var(--sram)" }), loc(true)),
        note: "Elementwise and free: the values never leave the chip.",
      },
      {
        k: "Mean",
        op: "tl.sum(x²) / H",
        where: "fp32 reduction",
        inLabel: "x²",
        input: () => row(sq, { color: "var(--sram)" }),
        outLabel: "mean square",
        output: () => LIA.formula(`(${sq.map((v) => v.toFixed(3)).join(" + ")}) / 8\n= <span class="hl">${ms.toFixed(5)}</span>`),
        note: "The sum is accumulated in fp32. At real width (8,192) an fp16 sum could overflow.",
      },
      {
        k: "+ eps, rsqrt",
        op: "1 / √(ms + ε)",
        where: "one scalar",
        inLabel: "mean square",
        input: () => LIA.formula(`ms = ${ms.toFixed(5)}\nε  = 1e-5`),
        outLabel: "rstd",
        output: () => LIA.formula(`rstd = 1 / √(${(ms + eps).toFixed(5)})\n     = <span class="hl">${rstd.toFixed(5)}</span>`),
        note: "ε guards against dividing by zero for an all-zero row. The unfused version launches a whole kernel just for this scalar.",
      },
      {
        k: "Normalize",
        op: "x · rstd",
        where: "registers",
        inLabel: "x",
        input: () => row(x),
        outLabel: "x̂ (RMS = 1)",
        output: () => h("div", { class: "stage", style: { gap: "8px" } }, row(xn), LIA.caption(`check: √(mean(x̂²)) = ${Math.sqrt(xn.reduce((a, v) => a + v * v, 0) / 8).toFixed(4)}`)),
        note: "Every element is divided by the row's root-mean-square. Unlike LayerNorm, the mean is not subtracted.",
      },
      {
        k: "Scale by γ",
        op: "x̂ · weight",
        where: "γ loaded once, reused by every row",
        inLabel: "γ (mocked learned weight)",
        input: () => row(gamma, { color: "var(--accent)", diverge: false }),
        outLabel: "y",
        output: () => h("div", { class: "stage", style: { gap: "8px" } }, row(y), loc(true)),
        note: "γ is only 8 values here (8,192 in the real model). It stays in cache across rows, so it adds almost no traffic.",
      },
      {
        k: "Store & tally bytes",
        op: "tl.store(y_ptr + cols)",
        where: "SRAM → HBM · 1 write",
        inLabel: "y",
        input: () => h("div", { class: "stage", style: { gap: "8px" } }, row(y), loc(false)),
        outLabel: `Bytes per row at real H = ${fmt.num(H)} (fp16)`,
        output: () => LIA.hbar({ width: 380, labelW: 110, valW: 80, rowH: 26, fmt: (v) => fmt.bytes(v), rows: [{ label: "unfused (7 passes)", value: unfusedB, color: "var(--hbm)" }, { label: "fused (2 passes)", value: fusedB, color: "var(--sram)" }] }),
        note: `Unfused PyTorch writes x², ms, rstd and x̂ back to HBM between kernels. Fused, this token's row costs ${fmt.bytes(fusedB)} instead of ${fmt.bytes(unfusedB)}: 3.5× less traffic.`,
      },
    ];
  }
})();
