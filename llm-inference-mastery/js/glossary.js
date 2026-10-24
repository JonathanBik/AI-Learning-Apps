/* Glossary engine: term registry, auto-linking, explanation cards, per-topic "Key terms", Glossary page.
 *
 * Term files call LIA.defineTerms([...]) with entries:
 *   id       'kv-cache'                     unique, kebab-case
 *   term     'KV cache'                     display name
 *   aka      ['KV cache', 'KV-cache']       phrases auto-linked in text. ALL-CAPS / digit aliases match case-sensitively.
 *                                           A trailing s/es plural is matched automatically.
 *   cat      model | memory | compute | serving | metrics | parallel | quant | ops
 *   short    one plain sentence (≤ 25 words), no jargon that isn't itself a term
 *   long     html, 2–4 sentences: how it works and why an inference engineer cares
 *   analogy  one everyday comparison (optional)
 *   formula  plain-text formula or rule of thumb (optional)
 *   example  (M) => html: what this term means for the mocked request LIA.MOCK (optional)
 *   viz      (G) => SVG node, built with the LIA.gv primitives below (optional, strongly preferred)
 *   related  ['prefill', 'paged-attention']  ids of other terms
 *   topic    'q3'                           lab where it is explored
 *   auto     false to keep it out of auto-linking (still in the glossary)
 */
(function () {
  const { h, s, fmt } = LIA;
  const TERMS = (LIA.TERMS = {});
  const CATS = {
    model: { label: "Model", c: "var(--accent)" },
    memory: { label: "Memory", c: "var(--hbm)" },
    compute: { label: "Compute & kernels", c: "var(--compute)" },
    serving: { label: "Serving", c: "var(--sram)" },
    metrics: { label: "Metrics", c: "var(--good)" },
    parallel: { label: "Parallelism", c: "var(--compute)" },
    quant: { label: "Quantization", c: "var(--warn)" },
    ops: { label: "Production", c: "var(--bad)" },
  };
  LIA.TERM_CATS = CATS;
  let matcher = null;
  LIA.defineTerms = (list) => { list.forEach((t) => { TERMS[t.id] = t; }); matcher = null; };

  /* ================= mini-visual primitives (≈ 280 × 70–130) ================= */
  const G = (LIA.gv = {});
  const W = 280;
  const txt = (x, y, str, o = {}) => s("text", Object.assign({ x, y, "font-size": 10.5, fill: "var(--ink)" }, o), str);

  /** flow([{t, c?, sub?}], {title?}) — boxes joined by arrows */
  G.flow = function (steps, o = {}) {
    const n = steps.length, gap = 14, bw = (W - gap * (n - 1)) / n, hh = o.sub || steps.some((x) => x.sub) ? 52 : 38;
    const sv = LIA.svg(W, hh + 8);
    steps.forEach((st, i) => {
      const x = i * (bw + gap);
      sv.appendChild(s("rect", { x, y: 4, width: bw, height: hh, rx: 6, fill: st.c || "var(--accent)", opacity: 0.16, stroke: st.c || "var(--accent)" }));
      sv.appendChild(txt(x + bw / 2, st.sub ? 24 : 27, st.t, { "text-anchor": "middle", "font-weight": 600, "font-size": bw < 60 ? 9.5 : 10.5 }));
      if (st.sub) sv.appendChild(txt(x + bw / 2, 42, st.sub, { "text-anchor": "middle", "font-size": 9.5, fill: "var(--muted)" }));
      if (i < n - 1) sv.appendChild(s("path", { d: `M${x + bw + 2},${4 + hh / 2} l${gap - 6},0 m-4,-4 l4,4 l-4,4`, fill: "none", stroke: "var(--muted)", "stroke-width": 1.5 }));
    });
    return sv;
  };

  /** matmul({a:[rows, cols], b:[rows, cols], ca, cb, cc, la, lb, lc}) — A × B = C, rectangles to scale */
  G.matmul = function (o) {
    const [ar, ac] = o.a, [br, bc] = o.b;
    const max = Math.max(ar, ac, br, bc), u = 78 / max;
    const sv = LIA.svg(W, 110);
    let x = 6;
    const box = (r, c, col, label) => {
      const w = Math.max(3, c * u), hh = Math.max(3, r * u);
      sv.appendChild(s("rect", { x, y: 16, width: w, height: hh, rx: 2, fill: col, opacity: 0.75 }));
      sv.appendChild(txt(x + w / 2, 11, label, { "text-anchor": "middle", "font-size": 9.5 }));
      x += w;
    };
    box(ar, ac, o.ca || "var(--compute)", o.la || `[${ar}×${ac}]`);
    sv.appendChild(txt(x + 8, 60, "×", { "font-size": 16, fill: "var(--muted)" })); x += 24;
    box(br, bc, o.cb || "var(--hbm)", o.lb || `[${br}×${bc}]`);
    sv.appendChild(txt(x + 8, 60, "=", { "font-size": 16, fill: "var(--muted)" })); x += 24;
    box(ar, bc, o.cc || "var(--accent)", o.lc || `[${ar}×${bc}]`);
    if (o.caption) sv.appendChild(txt(6, 106, o.caption, { "font-size": 9.5, fill: "var(--muted)" }));
    return sv;
  };

  /** bars([{label, value, color?}], {fmt, max}) — small horizontal bars */
  G.bars = function (rows, o = {}) {
    const rh = 20, lw = o.labelW || 84, sv = LIA.svg(W, rows.length * rh + 6);
    const max = o.max || Math.max(...rows.map((r) => r.value));
    rows.forEach((r, i) => {
      const y = 3 + i * rh, w = Math.max(1.5, (r.value / max) * (W - lw - (o.valW || 78)));
      sv.appendChild(txt(lw - 6, y + 13, r.label, { "text-anchor": "end", "font-size": 10 }));
      sv.appendChild(s("rect", { x: lw, y: y + 3, width: w, height: rh - 8, rx: 3, fill: r.color || "var(--accent)", opacity: 0.85 }));
      sv.appendChild(txt(lw + w + 5, y + 13, o.fmt ? o.fmt(r.value) : String(r.value), { "font-size": 10, "font-weight": 600 }));
    });
    return sv;
  };

  /** timeline([{w, c, t?}], {marks:[{at, label, c}], total}) — proportional segments on one track */
  G.timeline = function (segs, o = {}) {
    const total = o.total || segs.reduce((a, b) => a + b.w, 0), sv = LIA.svg(W, 74);
    let x = 4;
    const X = (v) => 4 + (v / total) * (W - 8);
    segs.forEach((sg) => {
      const w = (sg.w / total) * (W - 8);
      sv.appendChild(s("rect", { x, y: 22, width: Math.max(1, w - 1.5), height: 22, rx: 3, fill: sg.c || "var(--accent)", opacity: sg.o ?? 0.8 }));
      if (sg.t && w > 26) sv.appendChild(txt(x + w / 2, 37, sg.t, { "text-anchor": "middle", "font-size": 9.5, fill: "var(--surface)", "font-weight": 600 }));
      x += w;
    });
    (o.marks || []).forEach((m, i) => {
      sv.appendChild(s("line", { x1: X(m.at), x2: X(m.at), y1: 14, y2: 52, stroke: m.c || "var(--ink)", "stroke-width": 1.5 }));
      sv.appendChild(txt(LIA.clamp(X(m.at), 30, W - 30), i % 2 ? 66 : 10, m.label, { "text-anchor": "middle", "font-size": 9.5, fill: m.c || "var(--ink)", "font-weight": 600 }));
    });
    return sv;
  };

  /** grid(n, {cols, color(i) → css color | null, size}) — squares, e.g. blocks, slots, users */
  G.grid = function (n, o = {}) {
    const cols = o.cols || 16, sz = o.size || Math.min(16, (W - 4) / cols), rows = Math.ceil(n / cols);
    const sv = LIA.svg(cols * sz + 4, rows * sz + 4);
    for (let i = 0; i < n; i++) {
      const c = o.color ? o.color(i) : "var(--accent)";
      sv.appendChild(s("rect", { x: 2 + (i % cols) * sz, y: 2 + Math.floor(i / cols) * sz, width: sz - 2.5, height: sz - 2.5, rx: 2, fill: c || "var(--surface-2)", stroke: "var(--line)", "stroke-width": 0.6 }));
    }
    return sv;
  };

  /** stack([{t, sub, w (0..1), c}]) — centered tiers, top = smallest (memory hierarchy, pyramids) */
  G.stack = function (tiers) {
    const th = 26, sv = LIA.svg(W, tiers.length * (th + 4) + 4);
    tiers.forEach((tr, i) => {
      const w = (W - 4) * tr.w, x = (W - w) / 2, y = 2 + i * (th + 4);
      sv.appendChild(s("rect", { x, y, width: w, height: th, rx: 5, fill: tr.c, opacity: 0.2, stroke: tr.c }));
      sv.appendChild(txt(W / 2, y + 12, tr.t, { "text-anchor": "middle", "font-weight": 600, "font-size": 10 }));
      if (tr.sub) sv.appendChild(txt(W / 2, y + 23, tr.sub, { "text-anchor": "middle", "font-size": 9, fill: "var(--muted)" }));
    });
    return sv;
  };

  /** curve(fn, {x:[a,b], y:[a,b], color, xl, yl, marks:[{x, label}], logx, logy, fill}) — tiny line chart */
  G.curve = function (fn, o) {
    const sv = LIA.svg(W, 112), l = 30, r = W - 8, t = 8, b = 92;
    const [x0, x1] = o.x, [y0, y1] = o.y;
    const tx = (v) => (o.logx ? Math.log10(v) : v), ty = (v) => (o.logy ? Math.log10(Math.max(v, 1e-12)) : v);
    const X = (v) => l + ((tx(v) - tx(x0)) / (tx(x1) - tx(x0))) * (r - l);
    const Y = (v) => b - ((ty(LIA.clamp(v, y0, y1)) - ty(y0)) / (ty(y1) - ty(y0))) * (b - t);
    sv.appendChild(s("line", { x1: l, x2: r, y1: b, y2: b, stroke: "var(--line)" }));
    sv.appendChild(s("line", { x1: l, x2: l, y1: t, y2: b, stroke: "var(--line)" }));
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const v = o.logx ? Math.pow(10, tx(x0) + ((tx(x1) - tx(x0)) * i) / 60) : x0 + ((x1 - x0) * i) / 60;
      pts.push([X(v), Y(fn(v))]);
    }
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
    if (o.fill) sv.appendChild(s("path", { d: d + `L${r},${b}L${l},${b}Z`, fill: o.color || "var(--accent)", opacity: 0.12 }));
    sv.appendChild(s("path", { d, fill: "none", stroke: o.color || "var(--accent)", "stroke-width": 2 }));
    (o.series || []).forEach((sr) => {
      const p2 = []; for (let i = 0; i <= 60; i++) { const v = o.logx ? Math.pow(10, tx(x0) + ((tx(x1) - tx(x0)) * i) / 60) : x0 + ((x1 - x0) * i) / 60; p2.push([X(v), Y(sr.fn(v))]); }
      sv.appendChild(s("path", { d: p2.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(""), fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-dasharray": sr.dash || null }));
    });
    (o.marks || []).forEach((m) => {
      sv.appendChild(s("line", { x1: X(m.x), x2: X(m.x), y1: t, y2: b, stroke: m.c || "var(--muted)", "stroke-dasharray": "3 3" }));
      sv.appendChild(txt(LIA.clamp(X(m.x) + 3, l, r - 40), t + 9, m.label, { "font-size": 9.5, fill: m.c || "var(--muted)" }));
    });
    if (o.xl) sv.appendChild(txt((l + r) / 2, 108, o.xl, { "text-anchor": "middle", "font-size": 9.5, fill: "var(--muted)" }));
    if (o.yl) sv.appendChild(txt(4, t + 6, o.yl, { "font-size": 9.5, fill: "var(--muted)" }));
    return sv;
  };

  /** ring(n, {mode:'ring'|'all'|'star'|'pairs', labels, c, center}) — GPUs and their links (collectives, topologies) */
  G.ring = function (n, o = {}) {
    const sv = LIA.svg(W, 120), cx = W / 2, cy = 60, R = 44;
    const pos = Array.from({ length: n }, (_, i) => [cx + R * Math.cos((i / n) * 2 * Math.PI - Math.PI / 2), cy + R * Math.sin((i / n) * 2 * Math.PI - Math.PI / 2)]);
    const edge = (a, b, c) => sv.appendChild(s("line", { x1: pos[a][0], y1: pos[a][1], x2: pos[b][0], y2: pos[b][1], stroke: c || o.c || "var(--accent)", "stroke-width": 1.5, opacity: 0.7 }));
    if (o.mode === "all") for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edge(i, j);
    else if (o.mode === "star") { pos.forEach((p) => sv.appendChild(s("line", { x1: cx, y1: cy, x2: p[0], y2: p[1], stroke: o.c || "var(--accent)", "stroke-width": 1.5 }))); sv.appendChild(s("circle", { cx, cy, r: 13, fill: "var(--surface)", stroke: o.c || "var(--accent)" })); sv.appendChild(txt(cx, cy + 4, o.center || "hub", { "text-anchor": "middle", "font-size": 9 })); }
    else if (o.mode === "pairs") for (let i = 0; i + 1 < n; i += 2) edge(i, i + 1);
    else for (let i = 0; i < n; i++) edge(i, (i + 1) % n);
    pos.forEach((p, i) => {
      sv.appendChild(s("circle", { cx: p[0], cy: p[1], r: 11, fill: "var(--surface)", stroke: o.nodeC || "var(--compute)", "stroke-width": 1.8 }));
      sv.appendChild(txt(p[0], p[1] + 3.5, o.labels ? o.labels[i] : `G${i}`, { "text-anchor": "middle", "font-size": 9 }));
    });
    if (o.caption) sv.appendChild(txt(W / 2, 117, o.caption, { "text-anchor": "middle", "font-size": 9.5, fill: "var(--muted)" }));
    return sv;
  };

  /** bits([{n, label, c}]) — bit-field layout, e.g. sign | exponent | mantissa */
  G.bits = function (fields, o = {}) {
    const total = fields.reduce((a, f) => a + f.n, 0), bw = Math.min(16, (W - 4) / total), sv = LIA.svg(W, 52);
    let x = 2;
    fields.forEach((f) => {
      for (let i = 0; i < f.n; i++) sv.appendChild(s("rect", { x: x + i * bw, y: 6, width: bw - 1.5, height: 20, rx: 2, fill: f.c, opacity: 0.75 }));
      sv.appendChild(txt(x + (f.n * bw) / 2, 40, `${f.label} ${f.n}`, { "text-anchor": "middle", "font-size": 9.5 }));
      x += f.n * bw;
    });
    if (o.caption) sv.appendChild(txt(2, 50, "", {}));
    return sv;
  };

  /** hist(fn density or values, {marks:[{x, label, c}], x:[a,b], color, logx}) — latency distributions */
  G.hist = function (density, o) {
    const sv = LIA.svg(W, 96), nb = 36, l = 6, r = W - 6, b = 78;
    const [x0, x1] = o.x;
    const xs = Array.from({ length: nb }, (_, i) => (o.logx ? Math.pow(10, Math.log10(x0) + ((Math.log10(x1) - Math.log10(x0)) * (i + 0.5)) / nb) : x0 + ((x1 - x0) * (i + 0.5)) / nb));
    const ys = xs.map(density), mx = Math.max(...ys);
    const X = (v) => l + ((o.logx ? Math.log10(v) - Math.log10(x0) : v - x0) / (o.logx ? Math.log10(x1) - Math.log10(x0) : x1 - x0)) * (r - l);
    ys.forEach((y, i) => { const bw = (r - l) / nb; sv.appendChild(s("rect", { x: l + i * bw, y: b - (y / mx) * 62, width: bw - 1, height: (y / mx) * 62, fill: o.color || "var(--accent)", opacity: 0.7 })); });
    (o.marks || []).forEach((m) => {
      sv.appendChild(s("line", { x1: X(m.x), x2: X(m.x), y1: 8, y2: b, stroke: m.c || "var(--ink)", "stroke-width": 1.5, "stroke-dasharray": "3 2" }));
      sv.appendChild(txt(LIA.clamp(X(m.x), 14, W - 20), 92, m.label, { "text-anchor": "middle", "font-size": 9.5, fill: m.c || "var(--ink)", "font-weight": 600 }));
    });
    return sv;
  };

  /** chips(['a','b'], {cls(i)}) — token-like chips (html) */
  G.chips = (list, o = {}) => h("div", { class: "toks" }, list.map((t, i) => h("span", { class: "tok " + (o.cls ? o.cls(i) || "" : "") }, LIA.showTok(t))));

  /* ================= auto-linking ================= */
  function buildMatcher() {
    const map = new Map();
    Object.values(TERMS).forEach((t) => {
      if (t.auto === false) return;
      [t.term].concat(t.aka || []).forEach((a) => {
        const key = a.toLowerCase();
        // two or more capitals (TTFT, KV cache, PagedAttention) → match case-sensitively
        if (!map.has(key)) map.set(key, { id: t.id, alias: a, cs: /[A-Z].*[A-Z]/.test(a) });
      });
    });
    const keys = [...map.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!keys.length) return null;
    return { map, re: new RegExp(`(?<![\\w\\-])(${keys.join("|")})(?:es|s)?(?![\\w])`, "gi") };
  }
  const SKIP = "svg, input, textarea, select, button, a, code, pre, .formula, .blob, .code, .tok, .mat, .pill, .stat, label";
  const BLOCKS = ".lede, .insight, .trace-note, .explain, .caption, .q .prompt, .gl-long, .gl-ex, .gl-an";
  /** Wrap the first occurrence of each known term inside every text block under `root`. Returns the set of ids found. */
  LIA.linkTerms = function (root, opts = {}) {
    if (!matcher) matcher = buildMatcher();
    const found = new Set();
    if (!matcher || !root) return found;
    const blocks = root.matches && root.matches(BLOCKS) ? [root] : [...root.querySelectorAll(BLOCKS)];
    blocks.forEach((blk) => {
      if (blk.closest(".kt-panel, button, a, svg")) return;
      const seen = new Set(opts.exclude || []);
      const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => { const sk = n.parentElement && n.parentElement.closest(SKIP); return sk && blk.contains(sk) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((node) => {
        const text = node.nodeValue;
        if (!text || text.length < 2) return;
        matcher.re.lastIndex = 0;
        let m, last = 0;
        const frag = document.createDocumentFragment();
        let changed = false;
        while ((m = matcher.re.exec(text))) {
          const hit = matcher.map.get(m[1].toLowerCase());
          if (!hit || seen.has(hit.id) || (hit.cs && m[1] !== hit.alias)) continue;
          seen.add(hit.id);
          found.add(hit.id);
          frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          frag.appendChild(h("button", { type: "button", class: "term", "data-term": hit.id, title: TERMS[hit.id].short }, m[0]));
          last = m.index + m[0].length;
          changed = true;
        }
        if (!changed) return;
        frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      });
    });
    return found;
  };
  /** ids of terms mentioned in a plain string (used for worked-example steps not on screen yet) */
  LIA.termsIn = function (str) {
    if (!matcher) matcher = buildMatcher();
    const out = [];
    if (!matcher || !str) return out;
    const text = String(str).replace(/<[^>]+>/g, " ");
    matcher.re.lastIndex = 0;
    let m;
    while ((m = matcher.re.exec(text))) { const hit = matcher.map.get(m[1].toLowerCase()); if (hit && !(hit.cs && m[1] !== hit.alias) && !out.includes(hit.id)) out.push(hit.id); }
    return out;
  };

  /* ================= explanation card ================= */
  let pop = null, popFor = null;
  function closePop() { if (pop) pop.remove(); pop = null; popFor = null; }
  LIA.closeTerm = closePop;
  function cardBody(t, full) {
    const cat = CATS[t.cat] || CATS.model;
    const kids = [
      h("div", { class: "gl-head" }, h("b", { class: "gl-term" }, t.term), h("span", { class: "pill", style: { color: cat.c, borderColor: cat.c } }, cat.label)),
      h("div", { class: "gl-short" }, t.short),
    ];
    if (t.viz) { try { kids.push(h("div", { class: "gl-viz" }, t.viz(G))); } catch (e) { console.error(t.id, e); } }
    if (full) {
      if (t.long) kids.push(h("div", { class: "gl-long", html: t.long }));
      if (t.analogy) kids.push(h("div", { class: "gl-an" }, h("b", null, "Think of it as "), h("span", { html: t.analogy })));
      if (t.formula) kids.push(h("div", { class: "formula gl-f" }, t.formula));
      if (t.example) { try { kids.push(h("div", { class: "gl-ex" }, h("b", null, "In our example · "), h("span", { html: t.example(LIA.MOCK) }))); } catch (e) { console.error(t.id, e); } }
      const rel = (t.related || []).filter((r) => TERMS[r]);
      if (rel.length) kids.push(h("div", { class: "gl-rel" }, h("span", { class: "caption" }, "Related:"), rel.map((r) => h("button", { type: "button", class: "pill accent gl-chip", onClick: (e) => { e.stopPropagation(); openTerm(r, popFor); } }, TERMS[r].term))));
      const tp = t.topic && LIA.topics[t.topic];
      if (tp) kids.push(h("a", { class: "btn small primary", href: "#" + t.topic, onClick: closePop }, `Open ${tp.q ? tp.q + " · " : ""}${tp.title} lab →`));
    }
    return kids;
  }
  function openTerm(id, anchor) {
    const t = TERMS[id];
    if (!t) return;
    if (pop) pop.remove();
    popFor = anchor || null;
    pop = h("div", { class: "gpop", role: "dialog", "aria-label": t.term },
      h("button", { type: "button", class: "gpop-x", "aria-label": "Close", onClick: closePop }, "×"),
      cardBody(t, true));
    document.body.appendChild(pop);
    LIA.linkTerms(pop, { exclude: [id] });
    place();
    pop.querySelector(".gpop-x").focus({ preventScroll: true });
  }
  LIA.openTerm = openTerm;
  function place() {
    if (!pop) return;
    const narrow = window.innerWidth < 640;
    pop.classList.toggle("sheet", narrow);
    pop.classList.toggle("center", !narrow && !popFor);
    if (narrow || !popFor) { pop.style.left = pop.style.top = ""; return; }
    const r = popFor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = LIA.clamp(r.left + r.width / 2 - pw / 2, 12, window.innerWidth - pw - 12);
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 12 && r.top - ph - 8 > 12) top = r.top - ph - 8;
    top = LIA.clamp(top, 12, Math.max(12, window.innerHeight - ph - 12));
    pop.style.left = left + window.scrollX + "px";
    pop.style.top = top + window.scrollY + "px";
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-term]");
    if (b) { e.preventDefault(); openTerm(b.dataset.term, b); return; }
    if (pop && !e.target.closest(".gpop")) closePop();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
  window.addEventListener("resize", () => place());
  window.addEventListener("hashchange", closePop);

  /* ================= per-topic Key terms + link after render ================= */
  LIA.hooks.afterShow.push((topic, article) => {
    if (topic.id === "glossary" || topic.id === "map") return;
    const ids = new Set(topic.terms || []);
    LIA.linkTerms(article).forEach((id) => ids.add(id));
    // terms used anywhere in the worked example, not only the step on screen
    if (topic.trace) { try { topic.trace(LIA.MOCK).forEach((st) => [st.k, st.op, st.note].forEach((x) => typeof x === "string" && LIA.termsIn(x).forEach((id) => ids.add(id)))); } catch (e) { /* trace errors surface elsewhere */ } }
    const list = [...ids].filter((id) => TERMS[id]);
    if (!list.length) return;
    const cards = h("div", { class: "kt-cards", hidden: true }, list.map((id) => {
      const t = TERMS[id];
      return h("button", { type: "button", class: "kt-card", "data-term": id }, cardBody(t, false));
    }));
    const toggle = LIA.button(`Explain all ${list.length} with pictures ▾`, () => {
      cards.hidden = !cards.hidden;
      toggle.textContent = cards.hidden ? `Explain all ${list.length} with pictures ▾` : "Hide explanations ▴";
    }, "small");
    const panel = h("section", { class: "panel kt-panel" },
      h("div", { class: "panel-title" }, h("span", null, "Key terms · tap any word with a dotted underline"), toggle),
      h("div", { class: "kt-chips" }, list.map((id) => h("button", { type: "button", class: "kt-chip", "data-term": id, style: { borderColor: (CATS[TERMS[id].cat] || CATS.model).c } }, TERMS[id].term))),
      cards);
    const head = article.querySelector(".topic-head");
    head.after(panel);
  });
  LIA.hooks.afterTrace.push((el) => { const n = el.querySelector(".trace-note"); if (n) LIA.linkTerms(n); });

  /* ================= Glossary page ================= */
  LIA.register({
    id: "glossary",
    module: 0,
    q: "A–Z",
    title: "Glossary",
    labTitle: "Every term, with a picture",
    lede: "Every term used in the course: a plain definition, a mini picture, and what it means for our mocked request. Search or filter, then tap a card for the full explanation.",
    tags: [{ label: "searchable", kind: "accent" }],
    render(stage) {
      let cat = "all", q = "";
      const search = h("input", { type: "text", id: "gl-search", placeholder: "Search terms: e.g. TTFT, paged, all-reduce", style: { width: "100%" } });
      const catSeg = LIA.seg({ options: [{ value: "all", label: "All" }].concat(Object.entries(CATS).map(([k, v]) => ({ value: k, label: v.label }))), value: "all", onChange: (v) => { cat = v; draw(); } });
      const count = h("span", { class: "caption" });
      const grid = h("div", { class: "kt-cards" });
      search.addEventListener("input", () => { q = search.value.trim().toLowerCase(); draw(); });
      stage.append(h("div", { class: "ctl" }, h("label", { for: "gl-search" }, h("span", null, "Search")), search), catSeg.el, count, grid);
      function draw() {
        const list = Object.values(TERMS)
          .filter((t) => cat === "all" || t.cat === cat)
          .filter((t) => !q || [t.term].concat(t.aka || []).some((a) => a.toLowerCase().includes(q)) || (t.short || "").toLowerCase().includes(q))
          .sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" }));
        count.textContent = `${list.length} term${list.length === 1 ? "" : "s"}`;
        LIA.clear(grid).append(...list.map((t) => h("button", { type: "button", class: "kt-card", "data-term": t.id }, cardBody(t, false))));
      }
      draw();
    },
    insights: [],
    quiz: [],
  });
})();
