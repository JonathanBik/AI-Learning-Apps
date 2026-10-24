/* Module 5 (part A) — Observability (Q16), Tail latency (Q17), Benchmarking (Q18). */
(function () {
  "use strict";
  const { h, s, fmt } = LIA;

  function toggle(label, on, onChange, title) {
    const b = h("button", { type: "button", class: "btn small", "aria-pressed": String(on), title: title || null });
    const paint = () => { b.className = "btn small" + (on ? " primary" : ""); b.textContent = (on ? "● " : "○ ") + label; b.setAttribute("aria-pressed", String(on)); };
    b.addEventListener("click", () => { on = !on; paint(); onChange(on); });
    paint();
    return { el: b, get on() { return on; } };
  }
  function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
  const pctl = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;

  /* =====================================================================
   * Q16 — Observability: live serving dashboard
   * ===================================================================== */
  function q16Lab(stage) {
    const cv = LIA.canvas(720, 300);
    const st = LIA.stats([
      { key: "ttft", label: "TTFT (avg, last 5 s)" }, { key: "tpot", label: "TPOT (avg step)" }, { key: "queue", label: "Queue depth" },
      { key: "kv", label: "KV cache used" }, { key: "hit", label: "Prefix hit rate" }, { key: "batch", label: "Running batch" },
      { key: "pre", label: "Preemptions (total)" }, { key: "little", label: "Little's law L = λ·W" },
    ]);
    const rate = LIA.slider({ label: "Arrival rate λ (req/s, Poisson)", min: 0.5, max: 14, step: 0.5, value: 4, fmt: (v) => v.toFixed(1) });
    const maxB = LIA.slider({ label: "Max running batch", min: 16, max: 192, step: 16, value: 64 });
    const shared = LIA.slider({ label: "Shared system-prompt share", min: 0, max: 0.9, step: 0.05, value: 0.4, fmt: (v) => fmt.pct(v) });
    let speed = 5;
    const sp = LIA.seg({ label: "Sim speed", options: [{ value: 1, label: "1×" }, { value: 5, label: "5×" }, { value: 20, label: "20×" }], value: 5, onChange: (v) => (speed = v) });
    const pause = LIA.button("Pause", () => { if (lp.running) { lp.stop(); pause.textContent = "Resume"; } else { lp.start(); pause.textContent = "Pause"; } });
    const resetBtn = LIA.button("Reset", () => reset());

    const KV_CAP = 120000;
    let S;
    function reset() {
      S = { t: 0, r: LIA.rng(11), nextArr: 0, queue: [], run: [], kv: 0, pre: 0, hist: [], win: { ttft: [], step: [], hitTok: 0, promptTok: 0 }, nextSample: 0, done: [] };
      S.nextArr = LIA.expSample(rate.value, S.r);
    }
    reset();

    function engineStep() {
      const r = S.r;
      while (S.nextArr <= S.t) {
        S.queue.push({ arr: S.nextArr, prompt: 200 + Math.floor(r() * 1600), out: 50 + Math.floor(r() * 300), gen: 0, first: null });
        S.nextArr += LIA.expSample(rate.value, r);
      }
      // admission: batch slot + KV watermark (95%)
      let prefillTok = 0;
      const admitted = [];
      const pressure = S.kv / KV_CAP;
      while (S.queue.length && S.run.length < maxB.value && S.kv + S.queue[0].prompt <= KV_CAP * 0.95) {
        const q = S.queue.shift();
        const prefixKept = pressure < 0.85 ? 1 : Math.max(0, 1 - (pressure - 0.85) * 8); // evictions under pressure
        const hit = Math.floor(q.prompt * shared.value * prefixKept);
        S.win.hitTok += hit; S.win.promptTok += q.prompt;
        prefillTok += q.prompt - hit;
        S.kv += q.prompt + q.gen;
        S.run.push(q); admitted.push(q);
      }
      const B = S.run.length;
      if (!B) { S.t = Math.max(S.t + 0.005, Math.min(S.nextArr, S.t + 0.05)); return; }
      const stepMs = 12 + 0.3 * B + S.kv * 0.00004 + prefillTok / 40;
      S.t += stepMs / 1000;
      S.win.step.push(stepMs);
      admitted.forEach((q) => { if (q.first === null) { q.first = S.t; S.win.ttft.push((S.t - q.arr) * 1000); } });
      S.run.forEach((q) => { q.gen++; S.kv++; });
      // preempt newest when KV overflows (recompute later)
      while (S.kv > KV_CAP && S.run.length) {
        const v = S.run.pop(); S.kv -= v.prompt + v.gen; v.gen = 0; S.queue.unshift(v); S.pre++;
      }
      S.run = S.run.filter((q) => {
        if (q.gen >= q.out) { S.kv -= q.prompt + q.gen; S.done.push({ t: S.t, lat: S.t - q.arr }); return false; }
        return true;
      });
    }
    function sample() {
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
      const last = S.hist[S.hist.length - 1];
      S.hist.push({
        ttft: avg(S.win.ttft) ?? (last ? last.ttft : 0),
        tpot: avg(S.win.step) ?? 0,
        queue: S.queue.length,
        kv: S.kv / KV_CAP,
        hit: S.win.promptTok ? S.win.hitTok / S.win.promptTok : (last ? last.hit : 0),
        batch: S.run.length,
      });
      if (S.hist.length > 120) S.hist.shift();
      S.win = { ttft: [], step: [], hitTok: 0, promptTok: 0 };
    }

    const PANELS = [
      { k: "ttft", title: "TTFT", unit: "ms", f: (v) => fmt.ms(v), warn: 800, bad: 2000, color: "accent" },
      { k: "tpot", title: "TPOT / step time", unit: "ms", f: (v) => fmt.num(v) + " ms", warn: 50, bad: 80, color: "compute" },
      { k: "queue", title: "Queue depth", f: (v) => fmt.num(v), warn: 5, bad: 25, color: "warn" },
      { k: "kv", title: "KV cache usage", f: (v) => fmt.pct(v), warn: 0.85, bad: 0.95, color: "hbm", max: 1 },
      { k: "hit", title: "Prefix hit rate", f: (v) => fmt.pct(v), color: "sram", max: 1, inverse: true },
      { k: "batch", title: "Running batch", f: (v) => fmt.num(v), color: "good" },
    ];
    const level = (p, v) => (p.inverse || p.warn == null ? "good" : v >= p.bad ? "bad" : v >= p.warn ? "warn" : "good");

    function draw() {
      const c = LIA.colors(), ctx = cv.ctx;
      cv.clear();
      const pw = 240, ph = 150;
      PANELS.forEach((p, i) => {
        const x0 = (i % 3) * pw + 6, y0 = Math.floor(i / 3) * ph + 6, w = pw - 12, hh = ph - 12;
        LIA.rrect(ctx, x0, y0, w, hh, 8); ctx.fillStyle = c.surface_2; ctx.fill(); ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.stroke();
        const vals = S.hist.map((d) => d[p.k]);
        const cur = vals.length ? vals[vals.length - 1] : 0;
        const lv = level(p, cur);
        ctx.font = "11px JetBrains Mono, monospace"; ctx.textAlign = "left"; ctx.fillStyle = c.muted; ctx.fillText(p.title, x0 + 10, y0 + 18);
        ctx.font = "600 17px JetBrains Mono, monospace"; ctx.fillStyle = c.ink; ctx.fillText(p.f(cur), x0 + 10, y0 + 40);
        if (!p.inverse && p.warn != null) { ctx.beginPath(); ctx.arc(x0 + w - 14, y0 + 15, 6, 0, 7); ctx.fillStyle = c[lv]; ctx.fill(); }
        const max = p.max || Math.max(1e-9, ...vals, p.bad || 0) * 1.1;
        const gx = x0 + 10, gy = y0 + 52, gw = w - 20, gh = hh - 62;
        if (p.bad && p.bad <= max) { const yb = gy + gh - (p.bad / max) * gh; ctx.strokeStyle = c.bad; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(gx, yb); ctx.lineTo(gx + gw, yb); ctx.stroke(); ctx.setLineDash([]); }
        if (vals.length > 1) {
          ctx.beginPath();
          vals.forEach((v, j) => { const x = gx + (j / 119) * gw, y = gy + gh - (Math.min(v, max) / max) * gh; j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          ctx.strokeStyle = c[p.color]; ctx.lineWidth = 2; ctx.stroke();
          ctx.lineTo(gx + ((vals.length - 1) / 119) * gw, gy + gh); ctx.lineTo(gx, gy + gh); ctx.closePath();
          ctx.globalAlpha = 0.12; ctx.fillStyle = c[p.color]; ctx.fill(); ctx.globalAlpha = 1;
        }
      });
    }
    let statT = 0;
    const lp = LIA.loop((dt) => {
      const target = S.t + dt * speed;
      let guard = 0;
      while (S.t < target && guard++ < 4000) {
        engineStep();
        if (S.t >= S.nextSample) { sample(); S.nextSample += 0.5; }
      }
      draw();
      statT += dt;
      if (statT > 0.25) {
        statT = 0;
        const recent = S.hist.slice(-10);
        const a = (k) => recent.reduce((x, d) => x + d[k], 0) / Math.max(1, recent.length);
        const lv = (k, v) => level(PANELS.find((p) => p.k === k), v);
        st.set("ttft", fmt.ms(a("ttft")), lv("ttft", a("ttft")));
        st.set("tpot", fmt.num(a("tpot")) + " ms", lv("tpot", a("tpot")));
        st.set("queue", fmt.num(S.queue.length), lv("queue", S.queue.length));
        st.set("kv", fmt.pct(S.kv / KV_CAP), lv("kv", S.kv / KV_CAP));
        st.set("hit", fmt.pct(a("hit")));
        st.set("batch", `${S.run.length} / ${maxB.value}`);
        st.set("pre", fmt.num(S.pre), S.pre ? "warn" : "good");
        const dn = S.done.filter((d) => d.t > S.t - 20);
        S.done = dn;
        const W = dn.length ? dn.reduce((x, d) => x + d.lat, 0) / dn.length : 0;
        st.set("little", `${rate.value.toFixed(1)} × ${W.toFixed(1)} s ≈ ${fmt.num(rate.value * W)} in system`);
      }
    });
    stage.append(LIA.controls(rate, maxB, shared, sp), h("div", { class: "row" }, pause, resetBtn), LIA.viz(cv.el), st.el,
      LIA.caption("Engine model: step = 12 ms + 0.3 ms × batch + KV read cost + new prefill tokens ÷ 40K tok/s. KV budget 120K tokens; prompts 200–1,800 tokens, outputs 50–350. Push λ past ~7 req/s and watch the queue and TTFT run away while TPOT flattens at the max-batch step time."));
  }

  LIA.register({
    id: "q16", module: 5, q: "Q16", title: "Observability",
    lede: "Watch the six signals that tell you whether an inference fleet is healthy, saturated, or about to fall over.",
    tags: [{ label: "TTFT · TPOT", kind: "accent" }, { label: "KV cache %", kind: "hbm" }, { label: "Prefix hit rate", kind: "sram" }],
    render: q16Lab,
    insights: [
      { t: "Saturation shows up in the queue first.", d: "Once the running batch hits its cap, extra load waits in the queue. TTFT climbs without bound while TPOT stays flat at the max-batch step time." },
      { t: "TPOT is a batch-size gauge.", d: "Step time grows with batch and KV size. A rising TPOT with an empty queue usually means longer contexts, not more users." },
      { t: "KV usage near 100% predicts preemption.", d: "When KV blocks run out, the engine evicts a sequence and recomputes it later. That shows up as tail latency, not as errors." },
      { t: "Use Little's law to sanity-check.", d: "Requests in flight = arrival rate × time in system. If the dashboard disagrees, a metric is wrong." },
    ],
    quiz: [
      { type: "mcq", prompt: "Offered load rises past what the engine can serve. Which pattern do you expect?", options: [
        "TPOT explodes while TTFT stays flat",
        "Queue depth and TTFT grow without bound, while TPOT plateaus near the max-batch step time",
        "All metrics stay flat; only GPU utilization rises",
        "KV cache usage drops to zero"], answer: 1,
        explain: "The batch is capped, so per-step time stops growing. Extra requests wait in the queue, and their wait is part of TTFT." },
      { type: "num", prompt: "A service receives 5 req/s and each request spends 6 s in the system on average. How many requests are in flight on average?", answer: 30, tol: 0.01, unit: "requests",
        explain: "Little's law: L = λ × W = 5 × 6 = <b>30</b>." },
      { type: "mcq", prompt: "KV cache usage sits at 98% and preemption counters are climbing. Best first action?", options: [
        "Raise max batch size",
        "Lower max running sequences or raise the KV memory fraction / add replicas so admission keeps headroom",
        "Disable prefix caching",
        "Turn off streaming"], answer: 1,
        explain: "Preemption means you admit more work than the KV pool holds. Reduce concurrency or add KV capacity (more GPU memory, FP8 KV, more replicas)." },
    ],
  });

  /* =====================================================================
   * Q17 — Tail latency
   * ===================================================================== */
  function q17Lab(stage) {
    const box = h("div");
    let seed = 5;
    const st = LIA.stats([{ key: "p50", label: "p50 TTFT" }, { key: "p90", label: "p90 TTFT" }, { key: "p99", label: "p99 TTFT" }, { key: "ratio", label: "p99 / p50" }, { key: "rej", label: "Rejected (429)" }]);
    const load = LIA.slider({ label: "Utilization ρ", min: 0.3, max: 0.95, step: 0.01, value: 0.75, fmt: (v) => fmt.pct(v), onInput: draw });
    const C = {
      hol: toggle("Long-prompt head-of-line", true, draw, "A 32K-token prefill lands in your batch"),
      pre: toggle("KV preemption / recompute", true, draw),
      gc: toggle("GC / lock pauses", true, draw),
      cold: toggle("Cold replica in rotation", false, draw),
    };
    const M = {
      chunk: toggle("Chunked prefill", false, draw),
      head: toggle("KV headroom", false, draw),
      adm: toggle("Admission control", false, draw),
      gct: toggle("GC tuning (gc.freeze)", false, draw),
      warm: toggle("Pre-warm before traffic", false, draw),
    };
    const reroll = LIA.button("Resample", () => { seed++; draw(); });
    function draw() {
      const r = LIA.rng(seed), N = 5000, rho = load.value;
      const lat = []; let rej = 0;
      for (let i = 0; i < N; i++) {
        let v = 180 * Math.exp(0.35 * gauss(r));
        let wait = LIA.expSample(1 / (150 * rho / (1 - rho)), r);
        if (M.adm.on && wait > 600) { rej++; continue; }
        v += wait;
        if (C.hol.on && r() < 0.08) v += M.chunk.on ? 40 + r() * 110 : 800 + r() * 1700;
        if (C.pre.on && r() < (0.03 + 0.15 * Math.max(0, rho - 0.7)) * (M.head.on ? 0.1 : 1)) v += 1000 + r() * 3000;
        if (C.gc.on && r() < (M.gct.on ? 0.002 : 0.02)) v += 200 + r() * 700;
        if (C.cold.on && !M.warm.on && r() < 0.01) v += 5000 + r() * 15000;
        lat.push(v);
      }
      lat.sort((a, b) => a - b);
      const p50 = pctl(lat, 0.5), p90 = pctl(lat, 0.9), p99 = pctl(lat, 0.99);
      const W = 720, H = 260, l = 46, rr = 16, t = 30, b = 40, lo = 50, hi = 30000, NB = 48;
      const X = (v) => l + (Math.log(v / lo) / Math.log(hi / lo)) * (W - l - rr);
      const bins = new Array(NB).fill(0);
      lat.forEach((v) => { const k = Math.floor((Math.log(Math.max(lo, Math.min(hi * 0.999, v)) / lo) / Math.log(hi / lo)) * NB); bins[k]++; });
      const ymax = Math.sqrt(Math.max(...bins));
      const svg = LIA.svg(W, H);
      [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach((v) => svg.append(s("line", { x1: X(v), x2: X(v), y1: t, y2: H - b, stroke: "var(--grid)" }), s("text", { x: X(v), y: H - b + 15, "text-anchor": "middle", "font-size": 10, fill: "var(--muted)" }, fmt.ms(v))));
      bins.forEach((n, k) => {
        if (!n) return;
        const v0 = lo * Math.pow(hi / lo, k / NB), v1 = lo * Math.pow(hi / lo, (k + 1) / NB);
        const hh = Math.max(2, (Math.sqrt(n) / ymax) * (H - t - b));
        const col = v0 >= p99 ? "var(--bad)" : v0 >= p90 ? "var(--warn)" : "var(--accent)";
        svg.append(s("rect", { x: X(v0) + 0.5, y: H - b - hh, width: Math.max(1, X(v1) - X(v0) - 1), height: hh, fill: col, opacity: 0.85 }));
      });
      [[p50, "p50", "var(--good)"], [p90, "p90", "var(--warn)"], [p99, "p99", "var(--bad)"]].forEach(([v, lab, col], i) => {
        svg.append(s("line", { x1: X(v), x2: X(v), y1: t - 4, y2: H - b, stroke: col, "stroke-width": 2, "stroke-dasharray": "5 3" }),
          s("text", { x: X(v) + 4, y: t + 6 + i * 13, "font-size": 11, "font-weight": 600, fill: col }, `${lab} ${fmt.ms(v)}`));
      });
      svg.append(s("text", { x: (l + W - rr) / 2, y: H - 8, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, "TTFT (log scale) · bar height ∝ √count so the tail stays visible"));
      LIA.clear(box).appendChild(svg);
      st.set("p50", fmt.ms(p50)); st.set("p90", fmt.ms(p90)); st.set("p99", fmt.ms(p99), p99 > 3000 ? "bad" : p99 > 1200 ? "warn" : "good");
      st.set("ratio", (p99 / p50).toFixed(1) + "×", p99 / p50 > 8 ? "bad" : p99 / p50 > 4 ? "warn" : "good");
      st.set("rej", fmt.pct(rej / N, 1), rej ? "warn" : "");
    }
    draw();
    stage.append(LIA.controls(load, reroll),
      h("div", { class: "row" }, h("span", { class: "pill bad" }, "Causes"), Object.values(C).map((x) => x.el)),
      h("div", { class: "row" }, h("span", { class: "pill good" }, "Mitigations"), Object.values(M).map((x) => x.el)),
      LIA.viz(box), st.el,
      LIA.caption("5,000 simulated requests. Base TTFT is lognormal around 180 ms plus M/M/1-style queueing at utilization ρ. Each cause adds a rare, large delay, which barely moves p50 and dominates p99."));
  }

  LIA.register({
    id: "q17", module: 5, q: "Q17", title: "Tail Latency",
    lede: "p99 is made of rare events: a giant prefill, a preempted sequence, a GC pause, a cold replica.",
    tags: [{ label: "p99 ≫ p50", kind: "bad" }, { label: "Head-of-line blocking", kind: "compute" }],
    render: q17Lab,
    insights: [
      { t: "Rare causes own the tail.", d: "An event hitting 2% of requests is invisible at p50 and sets p99. Find it with per-request traces, not averages." },
      { t: "Long prompts block short ones.", d: "An unchunked 32K prefill holds a whole iteration. Chunked prefill caps any single step's prefill budget." },
      { t: "Preemption is a silent tail.", d: "KV exhaustion evicts a sequence and recomputes it later. Keep headroom and cap concurrent sequences." },
      { t: "Queueing grows as ρ/(1−ρ).", d: "Going from 75% to 95% utilization multiplies average wait by about 6×. Admission control trades tail latency for fast 429s." },
    ],
    quiz: [
      { type: "mcq", prompt: "p50 TTFT is steady at 200 ms but p99 spikes to 3 s whenever a few RAG requests with 30K-token prompts arrive. First fix?", options: [
        "Add more GPUs to the cluster",
        "Enable chunked prefill (or route long prompts to a separate pool)",
        "Lower the temperature", "Switch to INT4 weights"], answer: 1,
        explain: "This is head-of-line blocking by a huge prefill. Chunking bounds each step's prefill work so other requests keep moving." },
      { type: "num", prompt: "A page fans out to 10 independent model calls. Each call exceeds its own p99 with probability 1%. What percentage of page loads hit at least one slow call?", answer: 9.56, tol: 0.03, unit: "%",
        explain: "1 − 0.99¹⁰ = 1 − 0.904 = <b>9.56%</b>. Fan-out turns a 1-in-100 tail into roughly a 1-in-10 experience." },
      { type: "mcq", prompt: "Which metric best confirms KV preemption as the tail cause?", options: [
        "GPU temperature", "Preemption / recompute counter correlated with KV usage near 100%",
        "Tokenizer latency", "Average TPOT"], answer: 1,
        explain: "vLLM and similar engines export preemption counts. Spikes that line up with KV saturation point straight at it." },
    ],
  });

  /* =====================================================================
   * Q18 — Benchmarking
   * ===================================================================== */
  function arrivals(pattern, lam, T, r) {
    const out = [];
    if (pattern === "uniform") { for (let t = 1 / lam / 2; t < T; t += 1 / lam) out.push(t); return out; }
    if (pattern === "poisson") { let t = LIA.expSample(lam, r); while (t < T) { out.push(t); t += LIA.expSample(lam, r); } return out; }
    // bursty: on/off modulated Poisson, 20% of time at 3.5λ, rest at 0.375λ (mean = λ)
    let t = 0, burst = false, sw = LIA.expSample(1 / 8, r);
    while (t < T) {
      const rate = lam * (burst ? 3.5 : 0.375);
      const nx = t + LIA.expSample(rate, r);
      if (nx < sw) { t = nx; if (t < T) out.push(t); }
      else { t = sw; burst = !burst; sw = t + LIA.expSample(burst ? 1 / 2 : 1 / 8, r); }
    }
    return out;
  }
  function cv2(arr) {
    if (arr.length < 3) return 0;
    const d = arr.slice(1).map((v, i) => v - arr[i]);
    const m = d.reduce((a, b) => a + b, 0) / d.length;
    const v = d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length;
    return v / (m * m);
  }

  function q18Lab(stage) {
    let pattern = "poisson", seed = 2, ca2 = 1;
    const arrBox = h("div"), curveBox = h("div"), gpBox = h("div");
    const ast = LIA.stats([{ key: "n", label: "Arrivals in 30 s" }, { key: "cv", label: "CV² of inter-arrival" }, { key: "peak", label: "Busiest 1 s window" }]);
    const pat = LIA.seg({ label: "Arrival process", options: [{ value: "uniform", label: "Uniform" }, { value: "poisson", label: "Poisson" }, { value: "bursty", label: "Bursty" }], value: pattern, onChange: (v) => { pattern = v; drawArr(); drawCurves(); } });
    const lam = LIA.slider({ label: "Mean rate λ (req/s)", min: 1, max: 20, value: 6, onInput: () => { drawArr(); drawCurves(); } });
    const reseed = LIA.button("New sample", () => { seed++; drawArr(); drawCurves(); });
    function drawArr() {
      const T = 30, a = arrivals(pattern, lam.value, T, LIA.rng(seed));
      const counts = new Array(T).fill(0); a.forEach((t) => counts[Math.floor(t)]++);
      ca2 = pattern === "uniform" ? 0 : cv2(a);
      const W = 720, H = 170, l = 34, rr = 10, X = (t) => l + (t / T) * (W - l - rr);
      const cmax = Math.max(...counts, lam.value * 2);
      const svg = LIA.svg(W, H);
      svg.append(s("text", { x: l, y: 12, "font-size": 11, fill: "var(--muted)" }, "each tick = one request arriving"));
      a.forEach((t) => svg.append(s("line", { x1: X(t), x2: X(t), y1: 20, y2: 44, stroke: "var(--accent)", "stroke-width": 1.2 })));
      counts.forEach((n, i) => {
        const hh = (n / cmax) * 90;
        svg.append(s("rect", { x: X(i) + 1, y: 150 - hh, width: (W - l - rr) / T - 2, height: hh, rx: 2, fill: n > lam.value * 2 ? "var(--bad)" : "var(--compute)", opacity: 0.8 }));
      });
      svg.append(s("line", { x1: l, x2: W - rr, y1: 150 - (lam.value / cmax) * 90, y2: 150 - (lam.value / cmax) * 90, stroke: "var(--good)", "stroke-dasharray": "4 3" }),
        s("text", { x: W - rr, y: 146 - (lam.value / cmax) * 90, "text-anchor": "end", "font-size": 10, fill: "var(--good)" }, "mean λ"),
        s("text", { x: l, y: 166, "font-size": 10, fill: "var(--muted)" }, "requests per 1 s window (red > 2λ)"));
      LIA.clear(arrBox).appendChild(svg);
      ast.set("n", String(a.length)); ast.set("cv", ca2.toFixed(2), ca2 > 1.5 ? "bad" : ca2 > 0.5 ? "warn" : "good"); ast.set("peak", Math.max(...counts) + " req");
    }

    const ENGINES = [
      { name: "Engine A", mu: 10, base: 1.6, color: "var(--accent)" },
      { name: "Engine B", mu: 13, base: 2.3, color: "var(--compute)" },
      { name: "Engine C", mu: 11, base: 1.3, color: "var(--sram)" },
    ];
    const slo = LIA.slider({ label: "p99 latency SLO", min: 2, max: 20, step: 0.5, value: 5, fmt: (v) => v + " s", onInput: drawCurves });
    const p99 = (e, l) => {
      const rho = l / e.mu; if (rho >= 0.999) return Infinity;
      const wq = Math.max(0, Math.log(100 * rho)) / (e.mu * (1 - rho)) * 3; // queue tail, scaled for batch service granularity
      return e.base + wq * (ca2 + 1) / 2; // Kingman burstiness factor
    };
    function drawCurves() {
      const series = [], markers = [], rows = [];
      ENGINES.forEach((e) => {
        const pts = [];
        for (let l = 0.25; l < e.mu; l += 0.05) pts.push([l, p99(e, l)]);
        series.push({ points: pts.filter((p) => p[1] < 80), color: e.color, label: e.name });
        let gp = 0; for (let l = 0.05; l < e.mu; l += 0.01) { if (p99(e, l) <= slo.value) gp = l; else break; }
        markers.push({ x: gp, y: slo.value, color: e.color, r: 5 });
        rows.push({ label: e.name, value: gp, color: e.color, note: gp.toFixed(1) + " req/s" });
      });
      LIA.clear(curveBox).appendChild(LIA.lineChart({ width: 720, height: 300, x: { min: 0, max: 14, label: "offered load (req/s)" }, y: { min: 0.5, max: 60, log: true, label: "p99 latency (s)", fmt: (v) => v + " s" },
        series, markers, hlines: [{ y: slo.value, label: `SLO ${slo.value} s`, color: "var(--bad)" }] }));
      LIA.clear(gpBox).appendChild(LIA.hbar({ rows, max: 14, fmt: (v) => v.toFixed(1), width: 720, labelW: 90 }));
    }

    // pitfalls
    const pitBox = h("div");
    const PITS = [
      { k: "warm", label: "No warm-up run", tp: 0.9, p99: 2.5, why: "CUDA-graph capture, JIT and cold caches land inside the measurement." },
      { k: "prefix", label: "Repeated prompts", tp: 1.6, p99: 0.6, why: "Prefix cache serves most prefill for free; production traffic will not." },
      { k: "len", label: "Output length not pinned", tp: 1.25, p99: 0.6, why: "One engine stops at EOS early, another runs to max_tokens. Fix with ignore_eos or a fixed length." },
      { k: "closed", label: "Closed-loop clients", tp: 1.0, p99: 0.4, why: "Fixed concurrency waits for responses, so the server never sees a queue (coordinated omission)." },
      { k: "tok", label: "Different tokenizers", tp: 1.15, p99: 1.0, why: "tok/s compares different token counts for the same text. Count with one tokenizer." },
      { k: "client", label: "Load generator CPU-bound", tp: 0.8, p99: 1.3, why: "Client-side tokenization or JSON parsing becomes the bottleneck." },
    ];
    const on = { warm: true, prefix: true, closed: true };
    const why = h("div", { class: "insights" });
    const pitBtns = PITS.map((p) => toggle(p.label, !!on[p.k], (v) => { on[p.k] = v; drawPits(); }));
    function drawPits() {
      let tp = 2400, lat = 4.0;
      PITS.forEach((p) => { if (on[p.k]) { tp *= p.tp; lat *= p.p99; } });
      const svgA = LIA.hbar({ rows: [{ label: "True", value: 2400, color: "var(--good)", note: "2,400 tok/s" }, { label: "Reported", value: tp, color: Math.abs(tp / 2400 - 1) > 0.1 ? "var(--bad)" : "var(--accent)", note: fmt.num(tp) + " tok/s (" + (tp >= 2400 ? "+" : "") + fmt.pct(tp / 2400 - 1) + ")" }], width: 720, labelW: 90, valW: 190, max: 6500 });
      const svgB = LIA.hbar({ rows: [{ label: "True", value: 4, color: "var(--good)", note: "4.0 s" }, { label: "Reported", value: lat, color: Math.abs(lat / 4 - 1) > 0.1 ? "var(--bad)" : "var(--accent)", note: lat.toFixed(1) + " s (" + (lat >= 4 ? "+" : "") + fmt.pct(lat / 4 - 1) + ")" }], width: 720, labelW: 90, valW: 190, max: 12 });
      LIA.clear(pitBox).append(h("div", { class: "caption" }, "Throughput"), svgA, h("div", { class: "caption" }, "p99 latency"), svgB);
      LIA.clear(why).append(PITS.filter((p) => on[p.k]).map((p) => h("div", { class: "insight" }, h("div", null, h("b", null, p.label + "."), " " + p.why))));
    }

    drawArr(); drawCurves(); drawPits();
    stage.append(
      h("h3", { style: { fontSize: "17px" } }, "1 · Generate realistic load"), LIA.controls(pat, lam, reseed), LIA.viz(arrBox), ast.el,
      h("h3", { style: { fontSize: "17px" } }, "2 · Sweep the rate, read goodput at your SLO"), LIA.controls(slo), LIA.viz(curveBox),
      LIA.caption("Goodput = the highest request rate each engine sustains while p99 stays under the SLO. Engines A/B/C are illustrative models, not measured vLLM, TensorRT-LLM or SGLang numbers. Switch the arrival process above to bursty and watch every curve bend earlier."),
      LIA.viz(gpBox),
      h("h3", { style: { fontSize: "17px" } }, "3 · Pitfalls that corrupt the numbers"), h("div", { class: "row" }, pitBtns.map((b) => b.el)), LIA.viz(pitBox), why);
  }

  LIA.register({
    id: "q18", module: 5, q: "Q18", title: "Engine Benchmarking",
    lede: "Compare engines by goodput under your SLO with open-loop, Poisson-distributed load, not by peak tokens per second.",
    tags: [{ label: "Poisson arrivals", kind: "accent" }, { label: "Goodput", kind: "good" }, { label: "SLO", kind: "bad" }],
    render: q18Lab,
    insights: [
      { t: "Peak throughput can mislead.", d: "The engine with the highest saturation throughput (B here) can have the lowest goodput at a tight SLO." },
      { t: "Open-loop, Poisson load.", d: "Real users don't wait for each other. Closed-loop clients hide queueing and understate p99." },
      { t: "Burstiness moves the knee.", d: "Queue wait scales roughly with (1 + CV²)/2 (Kingman). Benchmark with the arrival shape you expect in production." },
      { t: "Control the workload.", d: "Same tokenizer, pinned output lengths, realistic prompt mix with controlled prefix reuse, warm-up excluded." },
    ],
    quiz: [
      { type: "mcq", prompt: "Why use open-loop Poisson arrivals instead of N clients that each send the next request after the previous returns?", options: [
        "Poisson is easier to code",
        "Closed-loop clients slow down when the server slows down, so queueing never builds and p99 is understated (coordinated omission)",
        "Closed-loop load always overloads the server",
        "Poisson gives higher throughput numbers"], answer: 1,
        explain: "In production, arrivals don't wait for your server. Closed-loop testing hides the queue that real users experience." },
      { type: "num", prompt: "A Poisson process has a rate of 4 req/s. What is the mean time between arrivals in milliseconds?", answer: 250, tol: 0.01, unit: "ms",
        explain: "Inter-arrival times are exponential with mean 1/λ = 0.25 s = <b>250 ms</b>." },
      { type: "mcq", prompt: "What does goodput measure?", options: [
        "Total tokens per second at saturation",
        "Throughput counting only requests that meet the latency SLOs (TTFT/TPOT/p99)",
        "GPU utilization percentage",
        "Number of successful HTTP 200s"], answer: 1,
        explain: "Goodput is the useful throughput under SLO. It is the number to size and compare fleets with." },
    ],
  });
})();
