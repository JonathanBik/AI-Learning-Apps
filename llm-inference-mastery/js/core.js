/* LLM Inference Mastery — core runtime.
 *
 * Every topic file calls LIA.register({...}) with:
 *   id       'q3'                      (also the URL hash: #q3)
 *   module   1..5 (0 = roadmap)
 *   q        'Q3' | 'Q13·Q14'          (label shown in the rail)
 *   title    short topic name
 *   lede     one-sentence framing under the title
 *   tags     [{label, kind}]           kind: accent|hbm|sram|compute|good|bad|warn
 *   render(stage)                      build the interactive lab into `stage` (a div.stage)
 *   insights [{t: 'Bold lead', d: 'one or two sentences'}]
 *   quiz     [{type:'mcq', prompt, options:[..], answer: idx, explain},
 *             {type:'num', prompt, answer, tol: 0.03 (relative), unit, explain},
 *             {type:'free', prompt, rubric:[..], model: 'html'}]
 *
 * Anything with a lifetime (rAF loops, intervals, listeners) must go through
 * LIA.loop / LIA.every / LIA.onTheme / LIA.onCleanup so it stops on navigation.
 */
(function () {
  "use strict";
  const LIA = (window.LIA = {});
  const SVGNS = "http://www.w3.org/2000/svg";

  LIA.MODULES = {
    0: "Start here",
    1: "Architecture & Memory",
    2: "Serving & Batching Engines",
    3: "Hardware, Kernels & Quantization",
    4: "Distributed Inference & Parallelism",
    5: "Production Infrastructure & Capacity",
  };
  LIA.ORDER = [
    "map",
    "q1", "q3", "q4", "q5", "m1check",
    "q2", "q6", "q7", "q8", "q9", "q10",
    "q11", "q12", "q13", "q15",
    "q22", "q23",
    "q16", "q17", "q18", "q19", "q20", "q21", "q24", "q25",
  ];
  const topics = {};
  LIA.topics = topics;
  LIA.register = (t) => { topics[t.id] = t; };
  LIA.reducedMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- DOM helpers ---------------- */
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  function setAttrs(el, attrs, isSvg) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.setAttribute("class", v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (isSvg && (k === "fill" || k === "stroke") && String(v).startsWith("var(")) el.style[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  /** h('div', {class:'x', onClick: fn}, child, [children], 'text') */
  LIA.h = function (tag, attrs, ...kids) {
    const el = document.createElement(tag);
    setAttrs(el, attrs, false);
    append(el, kids);
    return el;
  };
  /** s('rect', {x, y, fill:'var(--hbm)'}) — SVG element; var() colors go to style so they follow the theme. */
  LIA.s = function (tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    setAttrs(el, attrs, true);
    append(el, kids);
    return el;
  };
  /** Responsive SVG root with a fixed viewBox. */
  LIA.svg = function (w, h, attrs) {
    return LIA.s("svg", Object.assign({ viewBox: `0 0 ${w} ${h}`, width: "100%", style: `max-width:${w}px;height:auto`, role: "img" }, attrs || {}));
  };
  LIA.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  /* ---------------- theme ---------------- */
  LIA.color = (name) => getComputedStyle(document.documentElement).getPropertyValue(name.startsWith("--") ? name : "--" + name).trim();
  LIA.colors = () => {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const n of ["bg", "surface", "surface-2", "ink", "muted", "line", "accent", "accent-soft", "hbm", "hbm-soft", "sram", "sram-soft", "compute", "compute-soft", "good", "warn", "bad", "grid"])
      out[n.replace("-", "_").replace("-", "_")] = cs.getPropertyValue("--" + n).trim();
    return out; // keys: bg, surface, surface_2, ink, muted, line, accent, accent_soft, hbm, hbm_soft, ...
  };
  const themeSubs = new Set();
  function fireTheme() { themeSubs.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }
  if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", fireTheme);
  new MutationObserver(fireTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  /* ---------------- lifetimes ---------------- */
  let cleanups = [];
  LIA.onCleanup = (fn) => cleanups.push(fn);
  LIA.onTheme = (fn) => { themeSubs.add(fn); cleanups.push(() => themeSubs.delete(fn)); };
  /** rAF loop: fn(dtSeconds, tSeconds). Returns {start, stop, running}. Starts immediately unless autostart:false. */
  LIA.loop = function (fn, autostart = true) {
    let id = null, last = 0, t = 0;
    const tick = (now) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now; t += dt;
      fn(dt, t);
      if (id !== null) id = requestAnimationFrame(tick);
    };
    const ctl = {
      start() { if (id === null) { last = 0; id = requestAnimationFrame(tick); } },
      stop() { if (id !== null) cancelAnimationFrame(id); id = null; },
      get running() { return id !== null; },
    };
    cleanups.push(() => ctl.stop());
    if (autostart) ctl.start();
    return ctl;
  };
  LIA.every = function (ms, fn) {
    const id = setInterval(fn, ms);
    cleanups.push(() => clearInterval(id));
    return () => clearInterval(id);
  };
  LIA.after = function (ms, fn) {
    const id = setTimeout(fn, ms);
    cleanups.push(() => clearTimeout(id));
    return () => clearTimeout(id);
  };

  /* ---------------- formatting ---------------- */
  const fmt = (LIA.fmt = {
    num(x, d = 0) {
      if (!isFinite(x)) return "∞";
      return Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    /** decimal units (GB = 1e9), which is what GPU spec sheets use */
    bytes(b, d = 1) {
      const u = ["B", "KB", "MB", "GB", "TB", "PB"];
      let i = 0;
      while (Math.abs(b) >= 1000 && i < u.length - 1) { b /= 1000; i++; }
      return fmt.num(b, i === 0 ? 0 : d) + " " + u[i];
    },
    si(x, d = 1) {
      const u = ["", "K", "M", "B", "T"];
      let i = 0;
      while (Math.abs(x) >= 1000 && i < u.length - 1) { x /= 1000; i++; }
      return fmt.num(x, i === 0 ? Math.min(d, 2) : d) + u[i];
    },
    pct(x, d = 0) { return fmt.num(x * 100, d) + "%"; },
    ms(x, d = 0) { return x >= 1000 ? fmt.num(x / 1000, 2) + " s" : fmt.num(x, d) + " ms"; },
    usd(x, d = 2) { return "$" + fmt.num(x, d); },
  });
  LIA.clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  LIA.lerp = (a, b, t) => a + (b - a) * t;
  /** deterministic PRNG: const r = LIA.rng(42); r() in [0,1) */
  LIA.rng = function (seed = 1) {
    let a = seed >>> 0;
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  };
  /** exponential sample (Poisson inter-arrival) with given rate, using rand() */
  LIA.expSample = (rate, rand = Math.random) => -Math.log(1 - rand()) / rate;

  /* ---------------- UI widgets ---------------- */
  const h = LIA.h;
  let uid = 0;
  const nextId = (p) => `${p}-${++uid}`;

  LIA.panel = (title, ...kids) =>
    h("section", { class: "panel" }, title ? h("div", { class: "panel-title" }, title) : null, kids);

  /** slider({label, min, max, step, value, fmt, onInput}) → {el, value, set(v)} */
  LIA.slider = function (o) {
    const id = o.id || nextId("sl");
    const f = o.fmt || ((v) => String(v));
    const out = h("b", null, f(o.value));
    const input = h("input", { type: "range", id, min: o.min, max: o.max, step: o.step || 1, value: o.value });
    const api = {
      el: h("div", { class: "ctl" }, h("label", { for: id }, h("span", null, o.label), out), input),
      get value() { return Number(input.value); },
      set(v, silent) { input.value = v; out.textContent = f(Number(input.value)); if (!silent && o.onInput) o.onInput(Number(input.value)); },
      input,
    };
    input.addEventListener("input", () => { out.textContent = f(Number(input.value)); o.onInput && o.onInput(Number(input.value)); });
    return api;
  };

  /** seg({label?, options:[{value,label}]|['a','b'], value, onChange}) → {el, value, set(v)} */
  LIA.seg = function (o) {
    const opts = o.options.map((x) => (typeof x === "object" ? x : { value: x, label: String(x) }));
    let value = o.value != null ? o.value : opts[0].value;
    const btns = opts.map((op) =>
      h("button", { type: "button", "aria-pressed": String(op.value === value), title: op.title || null, onClick: () => api.set(op.value) }, op.label)
    );
    const group = h("div", { class: "seg", role: "group" }, btns);
    const api = {
      el: o.label ? h("div", { class: "ctl" }, h("label", null, h("span", null, o.label)), group) : group,
      get value() { return value; },
      set(v, silent) {
        value = v;
        btns.forEach((b, i) => b.setAttribute("aria-pressed", String(opts[i].value === v)));
        if (!silent && o.onChange) o.onChange(v);
      },
    };
    return api;
  };

  LIA.button = (label, onClick, cls = "") => h("button", { type: "button", class: "btn " + cls, onClick }, label);

  /** select({label, options:[{value,label}], value, onChange}) */
  LIA.select = function (o) {
    const id = o.id || nextId("sel");
    const sel = h("select", { id }, o.options.map((x) => {
      const op = typeof x === "object" ? x : { value: x, label: String(x) };
      return h("option", { value: op.value, selected: op.value === o.value ? true : null }, op.label);
    }));
    sel.addEventListener("change", () => o.onChange && o.onChange(sel.value));
    return { el: h("div", { class: "ctl" }, o.label ? h("label", { for: id }, h("span", null, o.label)) : null, sel), get value() { return sel.value; }, set(v) { sel.value = v; }, input: sel };
  };

  LIA.controls = (...kids) => h("div", { class: "controls" }, kids.map((k) => (k && k.el ? k.el : k)));

  /** stats([{key, label, cls?}]) → {el, set(key, text, cls?)} */
  LIA.stats = function (defs) {
    const cells = {};
    const el = h("div", { class: "stats" }, defs.map((d) => {
      const v = h("span", { class: "v" }, d.value || "–");
      const box = h("div", { class: "stat " + (d.cls || "") }, h("span", { class: "k" }, d.label), v);
      cells[d.key] = { v, box, base: d.cls || "" };
      return box;
    }));
    return {
      el,
      set(key, text, cls) {
        const c = cells[key];
        if (!c) return;
        c.v.textContent = text;
        if (cls !== undefined) c.box.className = "stat " + (cls || c.base);
      },
    };
  };

  LIA.formula = (html) => h("div", { class: "formula", html });
  LIA.caption = (text) => h("div", { class: "caption", html: text });
  LIA.pill = (label, kind = "") => h("span", { class: "pill " + kind }, label);
  LIA.viz = (...kids) => h("div", { class: "viz" }, kids);

  /** Hi-DPI canvas in logical units. → {el, ctx, w, h}. Draw in 0..w × 0..h. */
  LIA.canvas = function (w, hgt) {
    const el = h("canvas", { style: `width:100%;max-width:${w}px;aspect-ratio:${w}/${hgt};` });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(w * dpr);
    el.height = Math.round(hgt * dpr);
    const ctx = el.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { el, ctx, w, h: hgt, clear() { ctx.clearRect(0, 0, w, hgt); } };
  };
  /** Rounded-rect path helper for canvas. */
  LIA.rrect = function (ctx, x, y, w, hh, r) {
    r = Math.min(r, w / 2, hh / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hh, r);
    ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  /* ---------------- charts (SVG, theme-aware via CSS vars) ---------------- */
  function niceTicks(min, max, count = 5) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  LIA.niceTicks = niceTicks;
  function logTicks(min, max) {
    const out = [];
    for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
      const v = Math.pow(10, e);
      if (v >= min * 0.999 && v <= max * 1.001) out.push(v);
    }
    return out;
  }
  function makeScale(ax, a, b) {
    if (ax.log) {
      const l0 = Math.log10(ax.min), l1 = Math.log10(ax.max);
      return (v) => a + ((Math.log10(Math.max(v, 1e-12)) - l0) / (l1 - l0)) * (b - a);
    }
    return (v) => a + ((v - ax.min) / (ax.max - ax.min)) * (b - a);
  }

  /**
   * lineChart({width, height, x:{min,max,label,log,ticks,fmt}, y:{...},
   *   series:[{points:[[x,y]], color:'var(--hbm)', label, dash, width, area}],
   *   markers:[{x, y, color, label, r}], vlines:[{x, label, color, dash}], hlines:[{y,label,color,dash}],
   *   bands:[{x0,x1,color,label}] , legend:true})
   * → <svg>. Re-call and replace to update.
   */
  LIA.lineChart = function (o) {
    const s = LIA.s;
    const W = o.width || 640, H = o.height || 300;
    const m = Object.assign({ l: 58, r: 18, t: o.legend === false ? 14 : 30, b: 44 }, o.margin || {});
    const X = makeScale(o.x, m.l, W - m.r), Y = makeScale(o.y, H - m.b, m.t);
    const fx = o.x.fmt || ((v) => fmt.si(v)), fy = o.y.fmt || ((v) => fmt.si(v));
    const svg = LIA.svg(W, H);
    const xt = o.x.ticks || (o.x.log ? logTicks(o.x.min, o.x.max) : niceTicks(o.x.min, o.x.max, 6));
    const yt = o.y.ticks || (o.y.log ? logTicks(o.y.min, o.y.max) : niceTicks(o.y.min, o.y.max, 5));
    (o.bands || []).forEach((b) => {
      svg.appendChild(s("rect", { x: X(b.x0), y: m.t, width: Math.max(0, X(b.x1) - X(b.x0)), height: H - m.t - m.b, fill: b.color || "var(--accent-soft)", opacity: b.opacity ?? 0.6 }));
      if (b.label) svg.appendChild(s("text", { x: (X(b.x0) + X(b.x1)) / 2, y: m.t + 14, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, b.label));
    });
    yt.forEach((v) => {
      svg.appendChild(s("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: "var(--grid)" }));
      svg.appendChild(s("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, fy(v)));
    });
    xt.forEach((v) => {
      svg.appendChild(s("line", { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, stroke: "var(--grid)" }));
      svg.appendChild(s("text", { x: X(v), y: H - m.b + 16, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, fx(v)));
    });
    svg.appendChild(s("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: "var(--line)" }));
    svg.appendChild(s("line", { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, stroke: "var(--line)" }));
    if (o.x.label) svg.appendChild(s("text", { x: (m.l + W - m.r) / 2, y: H - 8, "text-anchor": "middle", "font-size": 12, fill: "var(--muted)" }, o.x.label));
    if (o.y.label) svg.appendChild(s("text", { x: 14, y: (m.t + H - m.b) / 2, "text-anchor": "middle", "font-size": 12, fill: "var(--muted)", transform: `rotate(-90 14 ${(m.t + H - m.b) / 2})` }, o.y.label));
    const clipId = nextId("clip");
    svg.appendChild(s("clipPath", { id: clipId }, s("rect", { x: m.l, y: m.t - 2, width: W - m.l - m.r, height: H - m.t - m.b + 4 })));
    const g = s("g", { "clip-path": `url(#${clipId})` });
    svg.appendChild(g);
    (o.series || []).forEach((sr) => {
      const pts = sr.points.filter((p) => isFinite(p[1]));
      if (!pts.length) return;
      const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
      if (sr.area) g.appendChild(s("path", { d: d + `L${X(pts[pts.length - 1][0])},${H - m.b}L${X(pts[0][0])},${H - m.b}Z`, fill: sr.color, opacity: 0.12 }));
      g.appendChild(s("path", { d, fill: "none", stroke: sr.color || "var(--accent)", "stroke-width": sr.width || 2.2, "stroke-dasharray": sr.dash || null, "stroke-linejoin": "round" }));
    });
    (o.hlines || []).forEach((l) => {
      g.appendChild(s("line", { x1: m.l, x2: W - m.r, y1: Y(l.y), y2: Y(l.y), stroke: l.color || "var(--muted)", "stroke-dasharray": l.dash || "5 4", "stroke-width": 1.5 }));
      if (l.label) g.appendChild(s("text", { x: W - m.r - 4, y: Y(l.y) - 5, "text-anchor": "end", "font-size": 11, fill: l.color || "var(--muted)" }, l.label));
    });
    (o.vlines || []).forEach((l) => {
      g.appendChild(s("line", { x1: X(l.x), x2: X(l.x), y1: m.t, y2: H - m.b, stroke: l.color || "var(--muted)", "stroke-dasharray": l.dash || "5 4", "stroke-width": 1.5 }));
      if (l.label) g.appendChild(s("text", { x: X(l.x) + 5, y: m.t + 12, "font-size": 11, fill: l.color || "var(--muted)" }, l.label));
    });
    (o.markers || []).forEach((p) => {
      g.appendChild(s("circle", { cx: X(p.x), cy: Y(p.y), r: p.r || 5, fill: p.color || "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }));
      if (p.label) {
        const right = X(p.x) < W - 140;
        g.appendChild(s("text", { x: X(p.x) + (right ? 9 : -9), y: Y(p.y) - 8, "text-anchor": right ? "start" : "end", "font-size": 11.5, "font-weight": 600, fill: p.color || "var(--accent)" }, p.label));
      }
    });
    if (o.legend !== false) {
      let lx = m.l;
      (o.series || []).filter((sr) => sr.label).forEach((sr) => {
        svg.appendChild(s("line", { x1: lx, x2: lx + 18, y1: 12, y2: 12, stroke: sr.color, "stroke-width": 3, "stroke-dasharray": sr.dash || null }));
        const t = s("text", { x: lx + 23, y: 16, "font-size": 11.5, fill: "var(--ink)" }, sr.label);
        svg.appendChild(t);
        lx += 32 + sr.label.length * 6.8;
      });
    }
    svg.scaleX = X; svg.scaleY = Y;
    return svg;
  };

  /**
   * hbar({rows:[{label, value, color, note} | {label, segs:[{value,color,label}]}], max, fmt, width, refs:[{value,label,color}]})
   * Horizontal (optionally stacked) bars. → <svg>
   */
  LIA.hbar = function (o) {
    const s = LIA.s;
    const W = o.width || 640, rowH = o.rowH || 30, labelW = o.labelW || 130, valW = o.valW || 90;
    const top = o.refs && o.refs.length ? 22 : 6;
    const H = top + o.rows.length * rowH + 6;
    const tot = (r) => (r.segs ? r.segs.reduce((a, b) => a + b.value, 0) : r.value);
    const max = o.max || Math.max(...o.rows.map(tot), ...(o.refs || []).map((r) => r.value)) * 1.05;
    const f = o.fmt || ((v) => fmt.si(v));
    const X = (v) => labelW + (Math.min(v, max) / max) * (W - labelW - valW);
    const svg = LIA.svg(W, H);
    o.rows.forEach((r, i) => {
      const y = top + i * rowH;
      svg.appendChild(s("text", { x: labelW - 8, y: y + rowH / 2 + 4, "text-anchor": "end", "font-size": 12, fill: "var(--ink)" }, r.label));
      svg.appendChild(s("rect", { x: labelW, y: y + 5, width: W - labelW - valW, height: rowH - 10, rx: 3, fill: "var(--surface-2)" }));
      const segs = r.segs || [{ value: r.value, color: r.color }];
      let acc = 0;
      segs.forEach((sg) => {
        const x0 = X(acc), x1 = X(acc + sg.value);
        svg.appendChild(s("rect", { x: x0, y: y + 5, width: Math.max(0, x1 - x0), height: rowH - 10, rx: 3, fill: sg.color || "var(--accent)" }, sg.label ? s("title", null, sg.label) : null));
        acc += sg.value;
      });
      svg.appendChild(s("text", { x: X(Math.min(acc, max)) + 6, y: y + rowH / 2 + 4, "font-size": 12, "font-weight": 600, fill: "var(--ink)" }, (acc > max ? "▶ " : "") + (r.note || f(acc))));
    });
    (o.refs || []).forEach((rf) => {
      svg.appendChild(s("line", { x1: X(rf.value), x2: X(rf.value), y1: top - 4, y2: H - 4, stroke: rf.color || "var(--bad)", "stroke-dasharray": "4 3", "stroke-width": 1.5 }));
      svg.appendChild(s("text", { x: X(rf.value), y: 13, "text-anchor": "middle", "font-size": 11, fill: rf.color || "var(--bad)" }, rf.label));
    });
    return svg;
  };

  /** Annotated code block: code(lines[], highlightIdx?) → {el, highlight(i|[i])} */
  LIA.code = function (src) {
    const lines = src.replace(/^\n/, "").split("\n").map((l) => h("span", { class: "ln" }, l || " "));
    const el = h("pre", { class: "code" }, lines.map((l) => [l, "\n"]));
    return {
      el,
      highlight(idx) {
        const set = new Set([].concat(idx));
        lines.forEach((l, i) => l.classList.toggle("on", set.has(i)));
      },
    };
  };

  /* ---------------- progress store ---------------- */
  const KEY = "lia.v1";
  let store = { quiz: {}, free: {}, last: null };
  try { const raw = localStorage.getItem(KEY); if (raw) store = Object.assign(store, JSON.parse(raw)); } catch (e) { /* storage unavailable */ }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* ignore */ } }
  LIA.store = store;
  function topicStatus(id) {
    const t = topics[id];
    if (!t || !t.quiz || !t.quiz.length) return store.quiz[id] && store.quiz[id].visited ? "done" : "none";
    const r = store.quiz[id] || {};
    const n = t.quiz.length;
    let ok = 0, tried = 0;
    for (let i = 0; i < n; i++) { if (r[i] != null) tried++; if (r[i] === true) ok++; }
    return ok === n ? "done" : tried ? "part" : "none";
  }
  function mark(id, i, val) {
    store.quiz[id] = store.quiz[id] || {};
    if (store.quiz[id][i] === true) return; // keep the first success
    store.quiz[id][i] = val;
    save();
    refreshRail();
  }

  /* ---------------- quiz renderer ---------------- */
  function renderQuiz(t) {
    const wrap = h("div", { class: "quiz" });
    (t.quiz || []).forEach((q, i) => {
      const box = h("div", { class: "q" });
      const prev = store.quiz[t.id] && store.quiz[t.id][i];
      box.appendChild(h("div", { class: "prompt", html: `<span class="pill accent">${i + 1}/${t.quiz.length}</span> ${q.prompt}` }));
      const explain = h("div", { class: "explain", html: q.explain || "", hidden: true });
      if (q.type === "mcq") {
        const opts = q.options.map((op, j) =>
          h("button", { type: "button", class: "opt", html: op, onClick: () => {
            opts.forEach((b) => b.classList.remove("sel-right", "sel-wrong", "reveal"));
            const right = j === q.answer;
            opts[j].classList.add(right ? "sel-right" : "sel-wrong");
            if (!right) opts[q.answer].classList.add("reveal");
            box.className = "q " + (right ? "correct" : "wrong");
            explain.hidden = false;
            mark(t.id, i, right);
          } })
        );
        box.appendChild(h("div", { class: "opts" }, opts));
        if (prev === true) { opts[q.answer].classList.add("sel-right"); box.className = "q correct"; explain.hidden = false; }
      } else if (q.type === "num") {
        const id = `${t.id}-num-${i}`;
        const inp = h("input", { type: "number", id, step: "any", placeholder: "your answer" });
        const fb = h("span", { class: "pill" }, q.unit || "");
        const check = () => {
          const v = parseFloat(inp.value);
          if (!isFinite(v)) return;
          const right = Math.abs(v - q.answer) <= Math.abs(q.answer) * (q.tol ?? 0.03);
          box.className = "q " + (right ? "correct" : "wrong");
          fb.className = "pill " + (right ? "good" : "bad");
          fb.textContent = right ? `✓ ${q.unit || ""}` : `✗ try again`;
          explain.hidden = !right;
          mark(t.id, i, right);
        };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
        const reveal = LIA.button("Show solution", () => { explain.hidden = false; }, "small");
        box.appendChild(h("div", { class: "num-row" }, inp, LIA.button("Check", check, "primary small"), fb, reveal));
        if (prev === true) { inp.value = q.answer; box.className = "q correct"; explain.hidden = false; }
      } else if (q.type === "free") {
        const key = `${t.id}:${i}`;
        const ta = h("textarea", { id: `${t.id}-free-${i}`, rows: 5, placeholder: "Write your answer in your own words, then reveal the model answer and score yourself against the rubric." });
        ta.value = (store.free && store.free[key]) || "";
        ta.addEventListener("input", () => { store.free[key] = ta.value; save(); });
        const model = h("div", { class: "explain", hidden: true },
          h("div", { html: "<b>Model answer</b><br>" + q.model }),
          h("div", { style: { marginTop: "10px" } }, h("b", null, "Self-check: tick each point your answer covered")),
          h("div", { class: "rubric" }, q.rubric.map((r, j) => {
            const cid = `${t.id}-rub-${i}-${j}`;
            const cb = h("input", { type: "checkbox", id: cid });
            cb.addEventListener("change", () => {
              const all = [...model.querySelectorAll("input[type=checkbox]")];
              const score = all.filter((c) => c.checked).length / all.length;
              scoreEl.textContent = `Rubric coverage: ${Math.round(score * 100)}%`;
              scoreEl.className = "pill " + (score >= 0.75 ? "good" : score >= 0.4 ? "warn" : "bad");
              mark(t.id, i, score >= 0.75 ? true : false);
            });
            return h("label", { for: cid }, cb, h("span", { html: r }));
          }))
        );
        const scoreEl = h("span", { class: "pill" }, "Rubric coverage: –");
        box.appendChild(ta);
        box.appendChild(h("div", { class: "num-row" }, LIA.button("Reveal model answer", () => { model.hidden = false; }, "primary small"), scoreEl));
        box.appendChild(model);
        if (prev === true) { box.className = "q correct"; }
      }
      box.appendChild(explain);
      wrap.appendChild(box);
    });
    return wrap;
  }

  /* ---------------- shell / router ---------------- */
  let railEl, mainEl, progressFill, progressLabel;
  function ordered() { return LIA.ORDER.filter((id) => topics[id]).concat(Object.keys(topics).filter((id) => !LIA.ORDER.includes(id))); }

  function buildRail() {
    railEl = document.getElementById("rail");
    mainEl = document.getElementById("main");
    progressFill = h("i");
    progressLabel = h("div", { class: "progress-label" });
    const toggle = h("button", { type: "button", class: "btn small mobile-bar", onClick: () => {
      railEl.dataset.collapsed = railEl.dataset.collapsed === "true" ? "false" : "true";
      toggle.textContent = railEl.dataset.collapsed === "true" ? "Show curriculum ▾" : "Hide curriculum ▴";
    } }, "Show curriculum ▾");
    railEl.dataset.collapsed = "true";
    const mods = h("nav", { class: "mods", "aria-label": "Curriculum" });
    LIA.clear(railEl);
    railEl.append(
      h("div", { class: "brand" }, h("span", { class: "eyebrow" }, "Inference AI Engineer"), h("h1", null, "LLM Inference Mastery")),
      h("div", { class: "progress-wrap" }, h("div", { class: "progress-bar" }, progressFill), progressLabel),
      h("div", { class: "legend" },
        h("span", null, h("i", { style: { background: "var(--hbm)" } }), "HBM / slow memory"),
        h("span", null, h("i", { style: { background: "var(--sram)" } }), "SRAM / fast"),
        h("span", null, h("i", { style: { background: "var(--compute)" } }), "Compute")
      ),
      toggle,
      mods
    );
    refreshRail();
  }
  function refreshRail() {
    if (!railEl) return;
    const mods = railEl.querySelector(".mods");
    LIA.clear(mods);
    const ids = ordered();
    const byMod = {};
    ids.forEach((id) => (byMod[topics[id].module] = byMod[topics[id].module] || []).push(id));
    Object.keys(byMod).sort().forEach((m) => {
      mods.appendChild(h("div", { class: "mod" },
        h("div", { class: "mod-title" }, (m > 0 ? `M${m} · ` : "") + LIA.MODULES[m]),
        byMod[m].map((id) => {
          const t = topics[id];
          const st = topicStatus(id);
          return h("a", { class: "topic-link" + (id === current ? " active" : ""), href: "#" + id, "aria-current": id === current ? "page" : null },
            h("span", { class: "qid" }, t.q || ""), h("span", null, t.title), h("span", { class: "dot " + st, title: st }));
        })
      ));
    });
    const quizIds = ids.filter((id) => topics[id].quiz && topics[id].quiz.length);
    const done = quizIds.filter((id) => topicStatus(id) === "done").length;
    progressFill.style.width = (quizIds.length ? (done / quizIds.length) * 100 : 0) + "%";
    LIA.clear(progressLabel).append(h("span", null, `${done}/${quizIds.length} checkpoints`), h("span", null, `${Math.round((done / Math.max(1, quizIds.length)) * 100)}%`));
  }
  LIA.status = topicStatus;
  LIA.refreshRail = () => refreshRail();

  let current = null;
  function show(id) {
    if (!topics[id]) id = ordered()[0];
    cleanups.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
    cleanups = [];
    current = id;
    store.last = id;
    if (!topics[id].quiz || !topics[id].quiz.length) { store.quiz[id] = { visited: true }; }
    save();
    const t = topics[id];
    const ids = ordered();
    const idx = ids.indexOf(id);
    const prev = topics[ids[idx - 1]], next = topics[ids[idx + 1]];
    const stage = h("div", { class: "stage" });
    const topic = h("article", { class: "topic" },
      h("header", { class: "topic-head" },
        h("div", { class: "crumbs" },
          t.module ? h("span", null, `MODULE ${t.module} · ${LIA.MODULES[t.module].toUpperCase()}`) : null,
          t.q ? LIA.pill(t.q, "accent") : null,
          (t.tags || []).map((g) => LIA.pill(g.label, g.kind))
        ),
        h("h2", null, t.title),
        t.lede ? h("p", { class: "lede", html: t.lede }) : null
      ),
      LIA.panel(t.labTitle || "Interactive lab", stage),
      t.insights && t.insights.length ? LIA.panel("Key ideas", h("div", { class: "insights" }, t.insights.map((x) => h("div", { class: "insight" }, h("div", null, h("b", null, x.t), " ", h("span", { html: x.d })))))) : null,
      t.quiz && t.quiz.length ? LIA.panel("Checkpoint", renderQuiz(t)) : null,
      h("nav", { class: "pager" },
        prev ? h("a", { class: "btn", href: "#" + prev.id }, "← " + (prev.q ? prev.q + " " : "") + prev.title) : h("span"),
        next ? h("a", { class: "btn primary", href: "#" + next.id }, (next.q ? next.q + " " : "") + next.title + " →") : h("span")
      )
    );
    LIA.clear(mainEl).appendChild(topic);
    try { t.render(stage); } catch (e) { console.error(e); stage.appendChild(h("div", { class: "caption" }, "This lab failed to load: " + e.message)); }
    refreshRail();
    if (railEl && window.innerWidth <= 860) {
      railEl.dataset.collapsed = "true";
      const tg = railEl.querySelector(".mobile-bar");
      if (tg) tg.textContent = "Show curriculum ▾";
    }
    window.scrollTo(0, 0);
  }
  LIA.go = (id) => { if (location.hash !== "#" + id) location.hash = id; else show(id); };

  LIA.start = function () {
    buildRail();
    const fromHash = location.hash.replace("#", "");
    show(topics[fromHash] ? fromHash : store.last && topics[store.last] ? store.last : ordered()[0]);
    window.addEventListener("hashchange", () => { const id = location.hash.replace("#", ""); if (topics[id] && id !== current) show(id); });
  };
})();
