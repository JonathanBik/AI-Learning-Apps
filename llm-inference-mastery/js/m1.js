/* Module 1 — Architecture & Memory: Q1 lifecycle, Q3 KV cache, Q4 PagedAttention, Q5 FlashAttention, checkpoint. */
(function () {
  const { h, s, fmt } = LIA;

  /* 8×H100 SXM node (dense BF16): the reference box for Module 1 math */
  const NODE = { gpus: 8, tflops: 989e12 * 8, bw: 3.35e12 * 8, hbm: 80e9 * 8 };

  /* =====================================================================
   * Q1 — Request lifecycle
   * ===================================================================== */
  LIA.register({
    id: "q1",
    module: 1,
    q: "Q1",
    title: "Request Lifecycle",
    lede: "Follow one request from HTTP bytes to the first streamed token, then see why prefill saturates the tensor cores while decode waits on memory.",
    tags: [{ label: "prefill = compute-bound", kind: "compute" }, { label: "decode = bandwidth-bound", kind: "hbm" }],
    render(stage) {
      /* ---------- Part A: animated lifecycle ---------- */
      const PROMPT = 2000;
      const prefillMs = (2 * 70e9 * PROMPT) / (NODE.tflops * 0.55) * 1000; // 55% MFU
      const decodeMs = (140e9 / (NODE.bw * 0.8)) * 1000; // 80% of peak BW
      const stages = [
        { k: "HTTP / parse", ms: 1.5, c: "var(--muted)", d: "API server receives POST /v1/chat/completions, validates JSON, applies the chat template, checks auth and rate limits." },
        { k: "Tokenize", ms: 3, c: "var(--muted)", d: `CPU tokenizer (BPE) turns text into ${PROMPT} token IDs. Runs on the host; slow tokenizers show up as GPU idle gaps.` },
        { k: "Queue + schedule", ms: 12, c: "var(--warn)", d: "Scheduler admits the request when KV-cache blocks are free and the step's token budget allows it. Waiting here adds directly to TTFT." },
        { k: "Prefill", ms: prefillMs, c: "var(--compute)", d: `All ${PROMPT} prompt tokens go through all 80 layers in one forward pass: [${PROMPT}×8192] × [8192×8192] GEMMs. K and V for every prompt token are written into the KV cache.` },
        { k: "Sample token 1", ms: 0.4, c: "var(--accent)", d: "Logits of the last position → temperature / top-p → token #1. Detokenize and flush the first SSE event. TTFT ends here." },
        { k: "Decode loop", ms: decodeMs * 6, c: "var(--hbm)", d: `One token per step: [1×8192] × [8192×8192] GEMVs. Every step re-reads all 140 GB of weights plus this request's KV cache. ≈${fmt.num(decodeMs, 1)} ms per step (TPOT).` },
      ];
      const total = stages.reduce((a, b) => a + b.ms, 0);
      const ttft = stages.slice(0, 5).reduce((a, b) => a + b.ms, 0);
      const W = 960, Hh = 150, x0 = 10, x1 = W - 10;
      const X = (ms) => x0 + (ms / total) * (x1 - x0);
      const svg = LIA.svg(W, Hh, { "aria-label": "Request timeline" });
      let acc = 0;
      const segEls = stages.map((st) => {
        const x = X(acc), w = X(acc + st.ms) - x;
        acc += st.ms;
        const r = s("rect", { x, y: 40, width: Math.max(w, 3), height: 34, rx: 4, fill: st.c, opacity: 0.35 });
        svg.appendChild(r);
        return r;
      });
      // labels under segments (staggered so narrow ones do not collide)
      // the three CPU/queue stages are too narrow to label one by one: group them
      const cpuMs = stages[0].ms + stages[1].ms + stages[2].ms;
      const labels = [
        { mid: X(cpuMs / 2), x: x0, anchor: "start", y: 96, t: `parse + tokenize + queue · ${fmt.num(cpuMs, 1)}ms` },
        { mid: X(cpuMs + stages[3].ms / 2), x: X(cpuMs + stages[3].ms / 2), anchor: "middle", y: 96, t: `Prefill · ${fmt.num(stages[3].ms, 0)}ms` },
        { mid: X(ttft - 0.2), x: X(ttft) - 4, anchor: "end", y: 114, t: `sample token 1 · ${stages[4].ms}ms` },
        { mid: X(ttft + stages[5].ms / 2), x: X(ttft + stages[5].ms / 2), anchor: "middle", y: 96, t: `Decode (6 steps) · ${fmt.num(stages[5].ms, 0)}ms` },
      ];
      labels.forEach((l) => {
        svg.appendChild(s("line", { x1: l.mid, x2: l.mid, y1: 76, y2: l.y - 12, stroke: "var(--line)" }));
        svg.appendChild(s("text", { x: l.x, y: l.y, "text-anchor": l.anchor, "font-size": 11, fill: "var(--ink)" }, l.t));
      });
      svg.appendChild(s("line", { x1: X(ttft), x2: X(ttft), y1: 20, y2: 80, stroke: "var(--accent)", "stroke-width": 2 }));
      svg.appendChild(s("path", { d: `M${x0},28 H${X(ttft)}`, stroke: "var(--accent)", "stroke-width": 2, "marker-end": "none" }));
      svg.appendChild(s("text", { x: X(ttft) - 6, y: 22, "text-anchor": "end", "font-size": 12, "font-weight": 600, fill: "var(--accent)" }, `TTFT ≈ ${fmt.num(ttft, 0)} ms`));
      svg.appendChild(s("text", { x: X(ttft) + 6, y: 22, "font-size": 12, fill: "var(--hbm)" }, "TPOT = gap between later tokens →"));
      const head = s("rect", { x: x0, y: 34, width: 2.5, height: 46, fill: "var(--ink)" });
      svg.appendChild(head);
      svg.appendChild(s("text", { x: x0, y: 140, "font-size": 11, fill: "var(--muted)" }, `Llama-3-70B · ${PROMPT}-token prompt · 8×H100 · times modeled from FLOPs and bytes`));

      // token strip
      const NT = 40, NO = 14;
      const strip = LIA.svg(W, 92, { "aria-label": "Token strip" });
      const tokW = (W - 20) / (NT + NO + 2);
      const promptToks = [], outToks = [];
      for (let i = 0; i < NT; i++) {
        const r = s("rect", { x: 10 + i * tokW, y: 14, width: tokW - 2, height: 22, rx: 3, fill: "var(--surface-2)", stroke: "var(--line)" });
        strip.appendChild(r); promptToks.push(r);
      }
      for (let i = 0; i < NO; i++) {
        const r = s("rect", { x: 10 + (NT + 2 + i) * tokW, y: 14, width: tokW - 2, height: 22, rx: 3, fill: "var(--surface-2)", stroke: "var(--line)", "stroke-dasharray": "3 2" });
        strip.appendChild(r); outToks.push(r);
      }
      strip.appendChild(s("text", { x: 10, y: 52, "font-size": 11, fill: "var(--muted)" }, "prompt tokens (processed together in one step)"));
      strip.appendChild(s("text", { x: 10 + (NT + 2) * tokW, y: 52, "font-size": 11, fill: "var(--muted)" }, "output tokens (one per step)"));
      strip.appendChild(s("text", { x: 10, y: 76, "font-size": 11, fill: "var(--hbm)" }, "KV cache"));
      const kvBar = s("rect", { x: 80, y: 66, width: 0, height: 12, rx: 3, fill: "var(--hbm)" });
      strip.appendChild(s("rect", { x: 80, y: 66, width: W - 100, height: 12, rx: 3, fill: "var(--surface-2)" }));
      strip.appendChild(kvBar);

      const card = h("div", { class: "insight", style: { minHeight: "64px" } });
      const st = LIA.stats([
        { key: "t", label: "Elapsed (model time)" },
        { key: "stage", label: "Stage" },
        { key: "kv", label: "KV cache for this request", cls: "warn" },
      ]);
      const KV_PER_TOKEN = 327680;
      let t = 0, playing = true;
      const speed = total / 9; // full timeline in ~9 s
      const draw = () => {
        let a = 0, idx = stages.length - 1;
        for (let i = 0; i < stages.length; i++) { if (t < a + stages[i].ms) { idx = i; break; } a += stages[i].ms; }
        segEls.forEach((r, i) => r.setAttribute("opacity", i < idx ? 0.85 : i === idx ? 1 : 0.25));
        head.setAttribute("x", X(Math.min(t, total)));
        const sg = stages[idx];
        LIA.clear(card).append(h("div", null, h("b", null, sg.k + " — "), sg.d));
        const tPrefill0 = stages.slice(0, 3).reduce((p, q) => p + q.ms, 0);
        const inPrefill = idx === 3 ? (t - tPrefill0) / stages[3].ms : idx > 3 ? 1 : 0;
        promptToks.forEach((r) => {
          r.style.fill = idx < 1 ? "var(--surface-2)" : idx < 3 ? "var(--accent-soft)" : idx === 3 ? "var(--compute)" : "var(--compute-soft)";
          r.setAttribute("opacity", idx === 3 ? 0.55 + 0.45 * Math.sin(t / 8) ** 2 : 1);
        });
        const decT0 = tPrefill0 + stages[3].ms + stages[4].ms;
        const nOut = idx < 4 ? 0 : idx === 4 ? 1 : Math.min(NO, 1 + Math.floor(((t - decT0) / decodeMs) * (NO / 6) * 1));
        outToks.forEach((r, i) => { r.style.fill = i < nOut ? "var(--hbm)" : "var(--surface-2)"; });
        const kvTokens = (inPrefill * PROMPT) + Math.max(0, nOut - 0) * 1;
        kvBar.setAttribute("width", ((W - 100) * Math.min(1, kvTokens / (PROMPT + 200))).toFixed(1));
        st.set("t", fmt.num(Math.min(t, total), 1) + " ms");
        st.set("stage", sg.k);
        st.set("kv", fmt.bytes(kvTokens * KV_PER_TOKEN));
      };
      const loop = LIA.loop((dt) => {
        if (!playing) return;
        t += dt * speed;
        if (t > total * 1.08) t = 0;
        draw();
      });
      const playBtn = LIA.button("Pause", () => { playing = !playing; playBtn.textContent = playing ? "Pause" : "Play"; });
      const stepBtn = LIA.button("Next stage ▸", () => {
        playing = false; playBtn.textContent = "Play";
        let a = 0;
        for (const sg of stages) { a += sg.ms; if (t < a - 1e-6) { t = a - (sg === stages[5] ? 0 : 0.01); break; } }
        if (t >= total - 0.02) t = 0;
        draw();
      });
      if (LIA.reducedMotion) { playing = false; playBtn.textContent = "Play"; t = ttft - 0.1; }
      draw();
      stage.append(
        h("div", { class: "row" }, playBtn, stepBtn, h("span", { class: "caption" }, "Timeline is drawn to scale. Notice how short the CPU stages are next to prefill.")),
        LIA.viz(svg), LIA.viz(strip), card, st.el
      );

      /* ---------- Part B: why prefill is compute-bound (roofline) ---------- */
      stage.appendChild(h("h3", { style: { fontSize: "18px", marginTop: "10px" } }, "Same weights, different shapes: the roofline"));
      const d = 8192;
      const ai = (T) => (2 * T * d * d) / (2 * d * d + 4 * T * d); // FLOPs / byte for [T×d]·[d×d] FP16
      const ridge = NODE.tflops / NODE.bw;
      const phase = LIA.seg({ label: "Phase", options: [{ value: "decode", label: "Decode (batch of B × 1 token)" }, { value: "prefill", label: "Prefill (N prompt tokens)" }], value: "prefill", onChange: () => { sl.set(phase.value === "prefill" ? 2000 : 8, true); upd(); } });
      const sl = LIA.slider({ label: "Tokens in this forward pass", min: 1, max: 4096, value: 2000, fmt: (v) => fmt.num(v), onInput: () => upd() });
      const chartBox = LIA.viz();
      const shapeBox = LIA.viz();
      const rst = LIA.stats([
        { key: "ai", label: "Arithmetic intensity" },
        { key: "regime", label: "Bound by" },
        { key: "tc", label: "Compute time / step", cls: "" },
        { key: "tm", label: "Weight-read time / step", cls: "" },
        { key: "tps", label: "Tokens / s (ideal)", cls: "accent" },
      ]);
      const timeBox = LIA.viz();
      stage.append(LIA.controls(phase, sl), h("div", { class: "cols-2" }, h("div", null, chartBox), h("div", null, shapeBox, timeBox)), rst.el,
        LIA.formula(`intensity = FLOPs / bytes = <span class="cmp">2·T·d²</span> / <span class="hbm">(2·d² + 4·T·d)</span>  ≈ T   (for T ≪ d)\nridge point (8×H100) = <span class="cmp">7.9 PFLOP/s</span> / <span class="hbm">26.8 TB/s</span> ≈ ${fmt.num(ridge)} FLOP/byte`));
      function upd() {
        const T = sl.value;
        const a = ai(T);
        const pts = [];
        for (let x = 0.5; x <= 4000; x *= 1.15) pts.push([x, Math.min(NODE.tflops, x * NODE.bw) / 1e12]);
        const mem = a < ridge;
        const att = Math.min(NODE.tflops, a * NODE.bw) / 1e12;
        LIA.clear(chartBox).appendChild(LIA.lineChart({
          width: 520, height: 300,
          x: { min: 0.5, max: 4000, log: true, label: "arithmetic intensity (FLOP / byte, log)", fmt: (v) => fmt.si(v, 0) },
          y: { min: 1, max: 100000, log: true, label: "attainable TFLOP/s (log)", fmt: (v) => fmt.si(v, 0) },
          series: [{ points: pts, color: "var(--ink)", label: "8×H100 roofline" }],
          bands: [{ x0: 0.5, x1: ridge, color: "var(--hbm-soft)", label: "memory-bound" }, { x0: ridge, x1: 4000, color: "var(--compute-soft)", label: "compute-bound" }],
          vlines: [{ x: ridge, label: `ridge ${fmt.num(ridge)}`, color: "var(--muted)" }],
          markers: [{ x: a, y: att, color: mem ? "var(--hbm)" : "var(--compute)", label: `${phase.value} · T=${fmt.num(T)}`, r: 7 }],
          legend: false,
        }));
        // shape diagram: activations [T×d] times weight [d×d]
        const sv = LIA.svg(420, 150, { "aria-label": "Matrix shapes" });
        const th = LIA.clamp(Math.log2(T + 1) * 9, 3, 110);
        sv.appendChild(s("rect", { x: 10, y: 20, width: 110, height: th, fill: mem ? "var(--hbm)" : "var(--compute)", opacity: 0.8, rx: 2 }));
        sv.appendChild(s("text", { x: 65, y: 14, "text-anchor": "middle", "font-size": 11, fill: "var(--ink)" }, `X [${fmt.num(T)} × 8192]`));
        sv.appendChild(s("text", { x: 140, y: 75, "text-anchor": "middle", "font-size": 20, fill: "var(--muted)" }, "×"));
        sv.appendChild(s("rect", { x: 160, y: 20, width: 110, height: 110, fill: "var(--hbm-soft)", stroke: "var(--hbm)", rx: 2 }));
        sv.appendChild(s("text", { x: 215, y: 14, "text-anchor": "middle", "font-size": 11, fill: "var(--ink)" }, "W [8192 × 8192]"));
        sv.appendChild(s("text", { x: 215, y: 80, "text-anchor": "middle", "font-size": 11, fill: "var(--hbm)" }, "128 MB, read once"));
        sv.appendChild(s("text", { x: 290, y: 75, "font-size": 20, fill: "var(--muted)" }, "="));
        sv.appendChild(s("rect", { x: 310, y: 20, width: 100, height: th, fill: "var(--accent)", opacity: 0.5, rx: 2 }));
        sv.appendChild(s("text", { x: 360, y: 14, "text-anchor": "middle", "font-size": 11, fill: "var(--ink)" }, `Y [${fmt.num(T)} × 8192]`));
        sv.appendChild(s("text", { x: 10, y: 146, "font-size": 11, fill: "var(--muted)" }, T === 1 ? "matrix-VECTOR: each weight byte does 1 multiply-add" : `matrix-MATRIX: each weight byte is reused by ${fmt.num(T)} tokens`));
        LIA.clear(shapeBox).appendChild(sv);
        // whole-model step: 70B params FP16
        const tc = (2 * 70e9 * T) / NODE.tflops * 1000, tm = (140e9 / NODE.bw) * 1000;
        LIA.clear(timeBox).appendChild(LIA.hbar({
          width: 420, labelW: 150, valW: 80, rowH: 28,
          rows: [{ label: "compute (FLOPs)", value: tc, color: "var(--compute)" }, { label: "read 140 GB weights", value: tm, color: "var(--hbm)" }],
          fmt: (v) => fmt.num(v, v < 10 ? 2 : 0) + " ms",
        }));
        rst.set("ai", fmt.num(a, a < 10 ? 1 : 0) + " FLOP/B");
        rst.set("regime", mem ? "HBM bandwidth" : "Tensor cores", mem ? "warn" : "accent");
        rst.set("tc", fmt.num(tc, 2) + " ms");
        rst.set("tm", fmt.num(tm, 2) + " ms");
        rst.set("tps", fmt.si(T / (Math.max(tc, tm) / 1000), 1));
      }
      upd();
    },
    insights: [
      { t: "Prefill is one big GEMM.", d: "All N prompt tokens share one read of each weight matrix, so intensity ≈ N FLOP/byte. Past ~300 tokens an H100 runs out of FLOPs before bandwidth." },
      { t: "Decode is a GEMV.", d: "One new token per request per step. Every step streams all weights (and the KV cache) from HBM to do very little math. Batching more requests is the only way to raise intensity." },
      { t: "TTFT ≈ queue + prefill.", d: "CPU work (parsing, tokenizing) is usually a few ms. Queueing and prefill dominate, so chunked prefill and prefix caching are TTFT levers." },
      { t: "TPOT ≈ bytes / bandwidth.", d: "For 70B FP16 on 8×H100, 140 GB ÷ 26.8 TB/s ≈ 5.2 ms is the floor per step, before KV reads and overheads." },
    ],
    quiz: [
      { type: "mcq", prompt: "Why is the prefill phase compute-bound?", options: ["The KV cache is empty, so no memory is read", "N prompt tokens are multiplied by each weight matrix at once, so each weight byte is reused N times (matrix-matrix)", "Prefill runs on the CPU", "Sampling is expensive"], answer: 1, explain: "Arithmetic intensity scales with the number of tokens in the GEMM. A 2,000-token prompt sits far right of the ~295 FLOP/byte ridge point." },
      { type: "num", prompt: "Llama-3-70B in FP16 on an 8×H100 node (26.8 TB/s aggregate). What is the minimum decode step time in ms, from weight reads alone? (140 GB weights)", answer: 5.22, tol: 0.05, unit: "ms", explain: "140e9 B ÷ 26.8e12 B/s = 5.2 ms. Real TPOT is higher because of KV reads, all-reduce and kernel overheads." },
      { type: "mcq", prompt: "Which change moves a decode step closer to the compute-bound region?", options: ["Longer prompts", "Larger decode batch size", "Higher temperature", "Using more CPU threads for tokenization"], answer: 1, explain: "More concurrent sequences per step means more tokens share each weight read (the T in the roofline). Note attention over the KV cache stays bandwidth-bound per sequence." },
    ],
  });

  /* =====================================================================
   * Q3 — KV cache sizing
   * ===================================================================== */
  const PRESETS = {
    "llama3-70b": { label: "Llama-3 70B", L: 80, Hq: 64, Hkv: 8, d: 128, params: 70.6e9 },
    "llama3-8b": { label: "Llama-3 8B", L: 32, Hq: 32, Hkv: 8, d: 128, params: 8.0e9 },
    "llama3-405b": { label: "Llama-3.1 405B", L: 126, Hq: 128, Hkv: 8, d: 128, params: 405e9 },
  };
  LIA.register({
    id: "q3",
    module: 1,
    q: "Q3",
    title: "KV Cache Sizing",
    lede: "Every generated or prompt token leaves a Key and a Value vector in every layer. Size it, then see how many users actually fit on real hardware.",
    tags: [{ label: "memory math", kind: "hbm" }, { label: "GQA", kind: "accent" }],
    render(stage) {
      const st = { model: "llama3-70b", L: 80, Hkv: 8, d: 128, ctx: 32768, U: 100, bytes: 2 };
      const model = LIA.seg({ label: "Model", options: Object.entries(PRESETS).map(([k, v]) => ({ value: k, label: v.label })), value: st.model, onChange: (v) => { st.model = v; const p = PRESETS[v]; sL.set(p.L, true); sKv.set(p.Hkv, true); sD.set(p.d, true); upd(); } });
      const attn = LIA.seg({ label: "Attention type (KV heads)", options: [{ value: "mha", label: "MHA" }, { value: "gqa", label: "GQA" }, { value: "mqa", label: "MQA" }], value: "gqa", onChange: (v) => { const p = PRESETS[st.model]; sKv.set(v === "mha" ? p.Hq : v === "mqa" ? 1 : 8, true); upd(); } });
      const prec = LIA.seg({ label: "KV precision", options: [{ value: 2, label: "FP16/BF16" }, { value: 1, label: "FP8" }, { value: 0.5, label: "INT4" }], value: 2, onChange: () => upd() });
      const sL = LIA.slider({ label: "Layers L", min: 16, max: 128, value: 80, onInput: upd });
      const sKv = LIA.slider({ label: "KV heads H_kv", min: 1, max: 128, value: 8, onInput: upd });
      const sD = LIA.slider({ label: "Head dim d_head", min: 64, max: 256, step: 32, value: 128, onInput: upd });
      const ctxVals = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
      const sCtx = LIA.slider({ label: "Context per request", min: 0, max: ctxVals.length - 1, value: 5, fmt: (i) => fmt.num(ctxVals[i]) + " tok", onInput: upd });
      const sU = LIA.slider({ label: "Concurrent users U", min: 1, max: 256, value: 100, onInput: upd });
      const f = LIA.formula("");
      const ladder = LIA.viz();
      const fitBox = LIA.viz();
      const waffle = LIA.viz();
      const stats = LIA.stats([
        { key: "tok", label: "KV per token" },
        { key: "req", label: "KV per request" },
        { key: "tot", label: "Total KV (all users)", cls: "warn" },
        { key: "fit", label: "Users that fit on 8×H100", cls: "accent" },
      ]);
      stage.append(LIA.controls(model, attn, prec), LIA.controls(sL, sKv, sD, sCtx, sU), stats.el, f, ladder,
        h("div", { class: "cols-2" }, h("div", null, h("div", { class: "panel-title" }, "Does it fit? (weights + KV, decimal GB)"), fitBox), h("div", null, h("div", { class: "panel-title" }, "8×H100 · one square per user"), waffle)));
      function upd() {
        const L = sL.value, Hkv = sKv.value, d = sD.value, ctx = ctxVals[sCtx.value], U = sU.value, b = Number(prec.value);
        const p = PRESETS[model.value];
        const perTok = 2 * L * Hkv * d * b;
        const perReq = perTok * ctx;
        const tot = perReq * U;
        const weights = p.params * 2; // FP16 weights
        f.innerHTML =
          `<span class="dim">bytes/token</span> = <span class="hl">2</span> (K and V) × <span class="hl">${L}</span> layers × <span class="hl">${Hkv}</span> kv-heads × <span class="hl">${d}</span> d_head × <span class="hl">${b}</span> B\n` +
          `            = <b>${fmt.num(perTok)} B</b>  (${fmt.num(perTok / 1024, 0)} KiB)\n` +
          `<span class="dim">per request</span> = ${fmt.num(perTok)} × ${fmt.num(ctx)} tokens = <b>${fmt.bytes(perReq, 2)}</b>  (${fmt.num(perReq / 2 ** 30, 2)} GiB)\n` +
          `<span class="dim">all users  </span> = ${fmt.bytes(perReq, 2)} × ${U} = <span class="hbm">${fmt.bytes(tot, 1)}</span>  (${fmt.num(tot / 2 ** 30, 0)} GiB)`;
        // ladder: show each multiplication as a growing bar on log scale
        const steps = [
          { k: "1 value", v: b },
          { k: `× d_head ${d}`, v: b * d },
          { k: `× H_kv ${Hkv}`, v: b * d * Hkv },
          { k: `× L ${L}`, v: b * d * Hkv * L },
          { k: "× 2 (K,V)", v: perTok },
          { k: `× ctx ${fmt.si(ctx, 0)}`, v: perReq },
          { k: `× users ${U}`, v: tot },
        ];
        const W = 960, Hh = 120, sv = LIA.svg(W, Hh, { "aria-label": "Multiplication ladder" });
        const lmax = Math.log10(Math.max(tot, 1e12));
        const colW = W / steps.length;
        steps.forEach((sp, i) => {
          const hh = 10 + (Math.log10(sp.v) / lmax) * 70;
          const x = i * colW + 8;
          sv.appendChild(s("rect", { x, y: 86 - hh, width: colW - 16, height: hh, rx: 4, fill: i >= 5 ? "var(--hbm)" : "var(--accent)", opacity: 0.35 + 0.65 * (i / (steps.length - 1)) }));
          sv.appendChild(s("text", { x: x + (colW - 16) / 2, y: 82 - hh, "text-anchor": "middle", "font-size": 11, "font-weight": 600, fill: "var(--ink)" }, fmt.bytes(sp.v, sp.v > 1e9 ? 1 : 0)));
          sv.appendChild(s("text", { x: x + (colW - 16) / 2, y: 104, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, sp.k));
        });
        sv.appendChild(s("text", { x: 4, y: 118, "font-size": 10, fill: "var(--muted)" }, "bar height on a log scale: each step multiplies the one before"));
        LIA.clear(ladder).appendChild(sv);
        const nodes = [
          { label: "1×H100 80GB", cap: 80e9 },
          { label: "8×H100 640GB", cap: 640e9 },
          { label: "8×H200 1128GB", cap: 1128e9 },
          { label: "8×B200 1440GB", cap: 1440e9 },
        ];
        LIA.clear(fitBox).appendChild(LIA.hbar({
          width: 470, labelW: 112, valW: 70, rowH: 30,
          max: Math.max(1600e9, (weights + tot) * 1.02),
          rows: nodes.map((n) => ({ label: n.label, segs: [{ value: weights, color: "var(--compute)", label: "weights" }, { value: tot, color: "var(--hbm)", label: "KV cache" }], note: (weights + tot) <= n.cap * 0.9 ? "fits ✓" : "✗ " + fmt.num((weights + tot) / (n.cap * 0.9), 1) + "× over" })),
          refs: [],
        }));
        // capacity tick marks drawn as a caption
        fitBox.appendChild(LIA.caption(`<span style="color:var(--compute)">■</span> weights ${fmt.bytes(weights, 0)} (FP16) &nbsp; <span style="color:var(--hbm)">■</span> KV ${fmt.bytes(tot, 0)} &nbsp; · fits = within 90% of HBM (leave room for activations)`));
        // waffle on 8×H100
        const free = NODE.hbm * 0.9 - weights;
        const fitN = Math.max(0, Math.floor(free / perReq));
        const cols = 16, cell = 26, rows = Math.ceil(Math.max(U, 1) / cols);
        const wv = LIA.svg(cols * cell + 4, rows * cell + 4, { "aria-label": "Users that fit" });
        for (let i = 0; i < U; i++) {
          const ok = i < fitN;
          wv.appendChild(s("rect", { x: 2 + (i % cols) * cell, y: 2 + Math.floor(i / cols) * cell, width: cell - 4, height: cell - 4, rx: 4, fill: ok ? "var(--good)" : "var(--bad)", opacity: ok ? 0.85 : 0.35 }));
        }
        LIA.clear(waffle).append(wv, LIA.caption(`<b style="color:var(--good)">${Math.min(fitN, U)}</b> of ${U} users fit at ${fmt.num(ctx)} tokens each after ${fmt.bytes(weights, 0)} of weights. Try FP8 KV, GQA→MQA, or shorter context.`));
        stats.set("tok", fmt.num(perTok / 1024, perTok < 10240 ? 1 : 0) + " KiB");
        stats.set("req", fmt.bytes(perReq, 2));
        stats.set("tot", fmt.bytes(tot, 1));
        stats.set("fit", fmt.num(fitN), fitN >= U ? "good" : "bad");
      }
      upd();
    },
    insights: [
      { t: "Formula.", d: "<code>2 × L × H_kv × d_head × bytes × tokens × users</code>. The 2 is one K and one V vector per head." },
      { t: "GQA is the biggest lever.", d: "Llama-3-70B has 64 query heads but only 8 KV heads. MHA would need 8× the memory: 8.6 TB for the same workload." },
      { t: "Long context × concurrency is brutal.", d: "100 users × 32K tokens of 70B needs ~1.07 TB of KV alone, more than an entire 8×H100 node. This is why KV quantization, paging and offload exist." },
      { t: "GB vs GiB.", d: "Spec sheets use GB (10⁹). PyTorch reports GiB (2³⁰). The same 1,073.7 GB is exactly 1,000 GiB here." },
    ],
    quiz: [
      { type: "num", prompt: "Llama-3-70B (L=80, H_kv=8, d_head=128, FP16): KV cache bytes per token? (in KiB)", answer: 320, tol: 0.01, unit: "KiB", explain: "2 × 80 × 8 × 128 × 2 B = 327,680 B = 320 KiB per token." },
      { type: "num", prompt: "Same model, 32,768-token context, 100 concurrent users. Total KV cache in GB (10⁹ bytes)?", answer: 1073.7, tol: 0.075, unit: "GB", explain: "327,680 B × 32,768 = 10.74 GB per request. × 100 = 1,073.7 GB (= 1,000 GiB). Both 1,074 GB and 1,000 GiB are accepted." },
      { type: "mcq", prompt: "Switching KV cache from FP16 to FP8 for that workload…", options: ["halves KV memory to ~537 GB, still more than an 8×H100 node can hold next to 141 GB of weights", "makes everything fit on one H100", "does not change memory, only speed", "reduces weight memory too"], answer: 0, explain: "KV precision only scales the KV term. 537 GB + 141 GB of FP16 weights > 576 GB usable on 8×H100. You would also need FP8 weights, fewer users or a bigger node (H200/B200)." },
    ],
  });

  /* =====================================================================
   * Q4 — PagedAttention
   * ===================================================================== */
  LIA.register({
    id: "q4",
    module: 1,
    q: "Q4",
    title: "PagedAttention",
    lede: "Run the same request stream through a contiguous allocator and a paged allocator, side by side, and watch where the memory goes.",
    tags: [{ label: "virtual memory for KV", kind: "hbm" }, { label: "vLLM", kind: "accent" }],
    render(stage) {
      const BLOCKS = 160, COLS = 20, BS = 4, MAXLEN = 64; // block = 4 tokens, reservation = 16 blocks
      const seed = { v: 7 };
      let sims, trace, tick = 0, playing = !LIA.reducedMotion;
      function mkTrace() {
        const r = LIA.rng(seed.v);
        const out = [];
        for (let i = 0; i < 400; i++) out.push({ id: i, prompt: 4 + Math.floor(r() * 16), len: 8 + Math.floor(r() * (MAXLEN - 8)), hue: Math.floor(r() * 360) });
        return out;
      }
      function mkSim(kind) {
        return { kind, mem: new Array(BLOCKS).fill(null), running: [], next: 0, done: 0, preempt: 0, tokens: 0, queue: [] };
      }
      function reset() { trace = mkTrace(); sims = [mkSim("contig"), mkSim("paged")]; tick = 0; selected = null; }
      let selected = null;
      function admit(sim) {
        const mem = sim.mem;
        for (;;) {
          const req = sim.queue.length ? sim.queue[0] : trace[sim.next];
          if (!req) return;
          if (sim.kind === "contig") {
            const need = MAXLEN / BS;
            let start = -1;
            for (let i = 0; i + need <= BLOCKS; i++) { let ok = true; for (let j = 0; j < need; j++) if (mem[i + j]) { ok = false; i += j; break; } if (ok) { start = i; break; } }
            if (start < 0) return;
            const r = { ...req, gen: 0, blocks: [] };
            for (let j = 0; j < need; j++) { mem[start + j] = r; r.blocks.push(start + j); }
            sim.running.push(r);
          } else {
            const need = Math.ceil((req.prompt + 1) / BS);
            const free = mem.filter((m) => !m).length;
            if (free < need + 4 + Math.ceil(sim.running.length / 2)) return; // watermark leaves room to grow
            const r = { ...req, gen: 0, blocks: [] };
            for (let j = 0; j < need; j++) { const i = freeBlock(mem); mem[i] = r; r.blocks.push(i); }
            sim.running.push(r);
          }
          if (sim.queue.length) sim.queue.shift(); else sim.next++;
        }
      }
      function freeBlock(mem) {
        // pseudo-random free block, like a real free list after churn
        const free = []; mem.forEach((m, i) => { if (!m) free.push(i); });
        if (!free.length) return -1;
        return free[(tick * 7 + free.length * 13) % free.length];
      }
      function stepSim(sim) {
        const mem = sim.mem;
        for (const r of [...sim.running]) {
          if (!sim.running.includes(r)) continue;
          r.gen++;
          sim.tokens++;
          const used = r.prompt + r.gen;
          if (sim.kind === "paged" && used > r.blocks.length * BS) {
            const i = freeBlock(mem);
            if (i < 0) {
              // preempt the newest request (recompute later)
              const victim = sim.running[sim.running.length - 1];
              victim.blocks.forEach((b) => (mem[b] = null));
              sim.running.splice(sim.running.indexOf(victim), 1);
              sim.queue.unshift(trace[victim.id]);
              sim.preempt++;
              if (victim === r) continue;
              const j = freeBlock(mem); mem[j] = r; r.blocks.push(j);
            } else { mem[i] = r; r.blocks.push(i); }
          }
          if (r.prompt + r.gen >= r.prompt + r.len || used >= MAXLEN) {
            r.blocks.forEach((b) => (mem[b] = null));
            sim.running.splice(sim.running.indexOf(r), 1);
            sim.done++;
          }
        }
        admit(sim);
      }
      const panes = [0, 1].map((i) => {
        const cell = 23;
        const sv = LIA.svg(COLS * cell + 4, (BLOCKS / COLS) * cell + 4, { "aria-label": i ? "Paged KV memory" : "Contiguous KV memory" });
        const rects = [];
        for (let b = 0; b < BLOCKS; b++) {
          const x = 2 + (b % COLS) * cell, y = 2 + Math.floor(b / COLS) * cell;
          const g = s("g", { style: "cursor:pointer" });
          const r = s("rect", { x, y, width: cell - 3, height: cell - 3, rx: 3, fill: "var(--surface-2)", stroke: "var(--line)" });
          const fillR = s("rect", { x, y: y + cell - 3, width: cell - 3, height: 0, rx: 3, fill: "var(--accent)" });
          g.append(r, fillR);
          g.addEventListener("click", () => { const req = sims[i].mem[b]; selected = req ? req.id : null; draw(); });
          sv.appendChild(g);
          rects.push({ r, fillR, y, cell });
        }
        const st = LIA.stats([
          { key: "run", label: "Running requests", cls: "accent" },
          { key: "util", label: "Blocks holding real tokens" },
          { key: "waste", label: "Reserved but empty" },
          { key: "done", label: "Completed" },
        ]);
        const table = h("div", { class: "caption mono", style: { minHeight: "38px" } });
        const title = i ? "Paged: 4-token blocks allocated on demand, anywhere" : `Contiguous: reserve max_len (${MAXLEN} tokens) up front`;
        const box = h("div", { class: "stage", style: { gap: "8px" } }, h("div", { class: "panel-title" }, title, i ? LIA.pill("vLLM", "accent") : LIA.pill("naive", "bad")), LIA.viz(sv), st.el, table);
        return { sv, rects, st, table, box };
      });
      function hueFill(req) { return `hsl(${req.hue} 62% 55%)`; }
      function draw() {
        sims.forEach((sim, i) => {
          const pane = panes[i];
          let real = 0, reserved = 0;
          const tokInBlock = new Map();
          sim.running.forEach((r) => {
            const used = r.prompt + r.gen;
            r.blocks.forEach((b, j) => { const t = LIA.clamp(used - j * BS, 0, BS); tokInBlock.set(b, t); });
          });
          sim.mem.forEach((req, b) => {
            const { r, fillR, y, cell } = pane.rects[b];
            if (!req) { r.style.fill = "var(--surface-2)"; r.setAttribute("opacity", 1); fillR.setAttribute("height", 0); return; }
            const t = tokInBlock.get(b) || 0;
            const sel = selected === req.id;
            r.style.fill = hueFill(req);
            r.setAttribute("opacity", t ? 0.28 : 0.12);
            r.setAttribute("stroke-width", sel ? 2.5 : 1);
            r.style.stroke = sel ? "var(--ink)" : "var(--line)";
            const hh = ((cell - 3) * t) / BS;
            fillR.setAttribute("y", y + cell - 3 - hh);
            fillR.setAttribute("height", hh);
            fillR.style.fill = hueFill(req);
            if (t) real += t; reserved += BS;
          });
          pane.st.set("run", String(sim.running.length));
          pane.st.set("util", fmt.pct(real / (BLOCKS * BS)));
          pane.st.set("waste", fmt.pct((reserved - real) / (BLOCKS * BS)), (reserved - real) / (BLOCKS * BS) > 0.2 ? "bad" : "good");
          pane.st.set("done", sim.done + (sim.preempt ? ` · ${sim.preempt} preempted` : ""));
          const req = sim.running.find((r) => r.id === selected);
          pane.table.innerHTML = req
            ? `<b>Block table · request #${req.id}</b> (${req.prompt + req.gen} tokens)<br>logical → physical: ${req.blocks.map((b, j) => `${j}→${b}`).join("  ")}`
            : "Click any colored block to see that request's block table.";
        });
      }
      function step() { tick++; sims.forEach(stepSim); draw(); }
      reset();
      sims.forEach(admit);
      draw();
      let accT = 0;
      const speed = LIA.slider({ label: "Speed (steps / s)", min: 1, max: 30, value: 8 });
      LIA.loop((dt) => { if (!playing) return; accT += dt; const per = 1 / speed.value; while (accT > per) { accT -= per; step(); } });
      const play = LIA.button(playing ? "Pause" : "Play", () => { playing = !playing; play.textContent = playing ? "Pause" : "Play"; });
      const one = LIA.button("Step", () => { playing = false; play.textContent = "Play"; step(); });
      const re = LIA.button("New request mix", () => { seed.v++; reset(); sims.forEach(admit); draw(); });
      stage.append(
        h("div", { class: "row" }, play, one, re, h("div", { style: { minWidth: "220px" } }, speed.el)),
        h("div", { class: "cols-2" }, panes[0].box, panes[1].box),
        LIA.caption("Each square is one KV block of 4 tokens. Solid fill = tokens actually stored; faint tint = memory reserved for that request but still empty. Same arrival trace in both panes."),
        LIA.formula(`contiguous waste ≈ <span class="hbm">max_len − actual_len</span> per request  (internal)  +  holes between requests  (external)\npaged waste     ≤ <span class="sram">block_size − 1</span> tokens per request  → vLLM reports &lt;4% waste vs 60–80% in naive systems`)
      );
    },
    insights: [
      { t: "The problem.", d: "Output length is unknown up front. Contiguous allocators reserve max_len per request, so most of the reservation sits empty while it blocks new admissions." },
      { t: "The fix is an OS idea.", d: "Split KV into fixed blocks (16 tokens in vLLM). A per-request block table maps logical blocks to any free physical block, like a page table." },
      { t: "Sharing for free.", d: "Two requests with the same prefix can point at the same physical blocks (reference counted, copy-on-write). This is the basis of parallel sampling and prefix caching." },
      { t: "Cost.", d: "The attention kernel must gather K/V through the block table (an extra indirection). It is cheap next to the 2–4× bigger batches it enables." },
    ],
    quiz: [
      { type: "mcq", prompt: "What kind of fragmentation does PagedAttention mostly eliminate?", options: ["Only external fragmentation", "Internal fragmentation from max_len reservation and external fragmentation between allocations", "Fragmentation of model weights", "CPU memory fragmentation"], answer: 1, explain: "Blocks are allocated on demand (no over-reservation) and any free block can be used (no need for a contiguous hole). Only the last, partially filled block wastes space." },
      { type: "num", prompt: "Block size 16 tokens. A request currently holds 1,000 tokens. How many tokens of capacity are wasted in its last block?", answer: 8, tol: 0.001, unit: "tokens", explain: "1,000 tokens need ⌈1000/16⌉ = 63 blocks = 1,008 slots. 1,008 − 1,000 = 8 empty slots." },
      { type: "mcq", prompt: "When the paged allocator runs out of free blocks mid-decode, vLLM…", options: ["crashes with OOM", "preempts a request: swaps its blocks to CPU or frees them to recompute later", "silently truncates the output", "allocates more HBM from the driver"], answer: 1, explain: "Preemption (swap or recompute) keeps the engine alive. Frequent preemption shows up as latency spikes: a key tail-latency signal (Q17)." },
    ],
  });

  /* =====================================================================
   * Q5 — FlashAttention
   * ===================================================================== */
  LIA.register({
    id: "q5",
    module: 1,
    q: "Q5",
    title: "FlashAttention",
    lede: "Same FLOPs, far fewer bytes. Watch standard attention write the N×N score matrix to HBM while FlashAttention keeps each tile in SRAM.",
    tags: [{ label: "IO-aware", kind: "sram" }, { label: "online softmax", kind: "compute" }, { label: "tiling", kind: "accent" }],
    render(stage) {
      /* ---------- memory hierarchy ---------- */
      const hier = LIA.svg(960, 150, { "aria-label": "GPU memory hierarchy" });
      const tiers = [
        { k: "Registers + SRAM (shared mem / L1)", cap: "≈ 228 KB per SM · ~33 MB total", bw: "~ 30+ TB/s aggregate", w: 260, c: "var(--sram)" },
        { k: "L2 cache", cap: "50 MB", bw: "~ 10 TB/s", w: 420, c: "var(--accent)" },
        { k: "HBM3", cap: "80 GB", bw: "3.35 TB/s", w: 600, c: "var(--hbm)" },
      ];
      tiers.forEach((t, i) => {
        const y = 8 + i * 46, x = (960 - t.w) / 2 - 140;
        hier.appendChild(s("rect", { x, y, width: t.w, height: 38, rx: 6, fill: t.c, opacity: 0.18, stroke: t.c }));
        hier.appendChild(s("text", { x: x + t.w / 2, y: y + 24, "text-anchor": "middle", "font-size": 12.5, "font-weight": 600, fill: "var(--ink)" }, t.k));
        hier.appendChild(s("text", { x: 700, y: y + 17, "font-size": 12, fill: t.c, "font-weight": 600 }, t.bw));
        hier.appendChild(s("text", { x: 700, y: y + 32, "font-size": 11, fill: "var(--muted)" }, t.cap));
      });
      hier.appendChild(s("text", { x: 700, y: 146, "font-size": 10.5, fill: "var(--muted)" }, "H100 SXM, approximate"));
      stage.appendChild(LIA.viz(hier));

      /* ---------- tiling animation ---------- */
      const T = 8; // tiles per side
      const mkGrid = (label) => {
        const cell = 30, pad = 34;
        const sv = LIA.svg(T * cell + pad + 70, T * cell + pad + 26, { "aria-label": label });
        sv.appendChild(s("text", { x: pad + (T * cell) / 2, y: 12, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, "K / V tiles →"));
        sv.appendChild(s("text", { x: 10, y: pad + (T * cell) / 2, "font-size": 11, fill: "var(--muted)", transform: `rotate(-90 10 ${pad + (T * cell) / 2})`, "text-anchor": "middle" }, "Q tiles →"));
        const cells = [];
        for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) {
          const r = s("rect", { x: pad + j * cell, y: pad - 14 + i * cell, width: cell - 3, height: cell - 3, rx: 3, fill: "var(--surface-2)", stroke: "var(--line)" });
          sv.appendChild(r); cells.push(r);
        }
        const outs = [];
        for (let i = 0; i < T; i++) {
          const r = s("rect", { x: pad + T * cell + 14, y: pad - 14 + i * cell, width: 24, height: cell - 3, rx: 3, fill: "var(--surface-2)", stroke: "var(--line)" });
          sv.appendChild(r); outs.push(r);
        }
        sv.appendChild(s("text", { x: pad + T * cell + 26, y: pad - 20, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, "O"));
        const note = s("text", { x: pad, y: T * cell + pad + 20, "font-size": 11.5, fill: "var(--ink)" }, "");
        sv.appendChild(note);
        return { sv, cells, outs, note };
      };
      const A = mkGrid("Standard attention"), B = mkGrid("FlashAttention");
      const stdStats = LIA.stats([{ key: "io", label: "N×N tile reads+writes to HBM", cls: "bad" }, { key: "mem", label: "Extra HBM held", cls: "bad" }]);
      const flStats = LIA.stats([{ key: "io", label: "N×N tile reads+writes to HBM", cls: "good" }, { key: "mem", label: "Extra HBM held", cls: "good" }]);
      // phases for standard: 0..T² write S, T²..2T² softmax read+write P, 2T²..3T² read P for PV, then write O
      const STD_STEPS = 3 * T * T + 1, FL_STEPS = T * T + T;
      let k = 0, playing = !LIA.reducedMotion;
      const unit = 1; // tile units
      function drawAnim() {
        // standard
        const ks = Math.min(k, STD_STEPS);
        let io = 0;
        A.cells.forEach((r, idx) => {
          let fill = "var(--surface-2)", op = 1;
          if (ks > idx) { fill = "var(--hbm)"; op = 0.55; }
          if (ks > T * T + idx) { fill = "var(--hbm)"; op = 0.85; }
          if (ks > 2 * T * T + idx) { fill = "var(--hbm)"; op = 0.35; }
          const cur = ks % (T * T) === idx && ks < 3 * T * T;
          r.style.fill = fill; r.setAttribute("opacity", op);
          r.style.stroke = cur ? "var(--ink)" : "var(--line)";
        });
        io = Math.min(ks, T * T) * 1 + Math.max(0, Math.min(ks - T * T, T * T)) * 2 + Math.max(0, Math.min(ks - 2 * T * T, T * T)) * 1;
        A.outs.forEach((r) => { r.style.fill = ks >= STD_STEPS ? "var(--accent)" : "var(--surface-2)"; });
        A.note.textContent = ks < T * T ? "pass 1: S = QKᵀ → write N×N to HBM" : ks < 2 * T * T ? "pass 2: read S, softmax, write P (N×N)" : ks < 3 * T * T ? "pass 3: read P, compute P·V" : "done: N×N matrix touched 4 times";
        // flash: row-major over Q tiles, inner over K/V tiles, O written at end of each row
        const kf = Math.min(k, FL_STEPS);
        const row = Math.floor(kf / (T + 1)), col = kf % (T + 1);
        B.cells.forEach((r, idx) => {
          const i = Math.floor(idx / T), j = idx % T;
          const done = i < row || (i === row && j < col);
          const cur = i === row && j === col && kf < FL_STEPS;
          r.style.fill = cur ? "var(--sram)" : done ? "var(--sram-soft)" : "var(--surface-2)";
          r.setAttribute("opacity", 1);
          r.style.stroke = cur ? "var(--ink)" : "var(--line)";
        });
        B.outs.forEach((r, i) => { r.style.fill = i < row || (i === row && col === T) ? "var(--accent)" : i === row ? "var(--sram)" : "var(--surface-2)"; });
        B.note.textContent = kf >= FL_STEPS ? "done: N×N never left SRAM" : `Q-tile ${row + 1}: stream K/V tile ${Math.min(col, T - 1) + 1}, update m, ℓ, O in SRAM`;
        stdStats.set("io", fmt.num(io * unit, 0) + " of " + 4 * T * T);
        stdStats.set("mem", "N² per head");
        flStats.set("io", "0 (S, P stay on-chip)");
        flStats.set("mem", "O(N): m and ℓ only");
      }
      let acc = 0;
      LIA.loop((dt) => { if (!playing) return; acc += dt; if (acc > 0.07) { acc = 0; k++; if (k > STD_STEPS + 20) k = 0; drawAnim(); } });
      const pb = LIA.button(playing ? "Pause" : "Play", () => { playing = !playing; pb.textContent = playing ? "Pause" : "Play"; });
      const rb = LIA.button("Restart", () => { k = 0; drawAnim(); });
      if (!playing) k = 30;
      drawAnim();
      stage.append(
        h("div", { class: "row" }, pb, rb, h("span", { class: "caption" }, "Amber = tile written to or read from HBM. Teal = tile lives only in on-chip SRAM. Counters show how many score-matrix tiles cross the HBM bus.")),
        h("div", { class: "cols-2" },
          h("div", { class: "stage", style: { gap: "8px" } }, h("div", { class: "panel-title" }, "Standard (3 kernels)", LIA.pill("materializes N×N", "hbm")), LIA.viz(A.sv), stdStats.el),
          h("div", { class: "stage", style: { gap: "8px" } }, h("div", { class: "panel-title" }, "FlashAttention (1 fused kernel)", LIA.pill("tiles in SRAM", "sram")), LIA.viz(B.sv), flStats.el)
        )
      );

      /* ---------- scaling with N ---------- */
      stage.appendChild(h("h3", { style: { fontSize: "18px", marginTop: "10px" } }, "Bytes vs FLOPs as the sequence grows"));
      const dSel = LIA.seg({ label: "Head dim d", options: [64, 128, 256], value: 128, onChange: () => updN() });
      const brSel = LIA.seg({ label: "Q-tile rows B_r (set by SRAM size)", options: [64, 128, 256], value: 128, onChange: () => updN() });
      const kvSel = LIA.seg({ label: "Flash K/V re-reads served by", options: [{ value: "l2", label: "L2 cache (typical)" }, { value: "hbm", label: "HBM (worst case)" }], value: "l2", onChange: () => updN() });
      const sN = LIA.slider({ label: "Sequence length N", min: 9, max: 17, value: 15, fmt: (v) => fmt.num(2 ** v), onInput: () => updN() });
      const nChart = LIA.viz(), nStats = LIA.stats([
        { key: "flops", label: "FLOPs (both)" },
        { key: "std", label: "HBM bytes, standard", cls: "bad" },
        { key: "fl", label: "HBM bytes, flash", cls: "good" },
        { key: "ratio", label: "Traffic reduction", cls: "accent" },
        { key: "smem", label: "S matrix for 64 heads (standard)", cls: "warn" },
        { key: "tstd", label: "Standard: time / head", cls: "bad" },
        { key: "tfl", label: "Flash: time / head", cls: "good" },
      ]);
      stage.append(LIA.controls(dSel, brSel, kvSel, sN), nStats.el, nChart,
        LIA.formula(`standard HBM ≈ 2B·(<span class="hbm">4·N·d</span> + <span class="hbm">4·N²</span>)       write S, read S, write P, read P\nflash    HBM ≈ 2B·(<span class="sram">2·N·d</span> + <span class="sram">2·N·d·⌈N/B_r⌉</span>)  Q,O once; K,V once per Q-tile (≈ 2B·4·N·d when L2 absorbs re-reads)\nFLOPs (both) = 4·N²·d                         QKᵀ and P·V\ntime ≈ max(<span class="hbm">bytes / 3.35 TB/s</span>, <span class="cmp">FLOPs / 989 TFLOP/s</span>)   (H100, ideal)`));
      function io(N, d, Br) {
        const l2 = kvSel.value === "l2";
        return { std: 2 * (4 * N * d + 4 * N * N), fl: 2 * (2 * N * d + 2 * N * d * (l2 ? 1 : Math.ceil(N / Br))), flops: 4 * N * N * d };
      }
      function updN() {
        const d = Number(dSel.value), Br = Number(brSel.value), N = 2 ** sN.value;
        const r = io(N, d, Br);
        const ps = [], pf = [];
        for (let e = 9; e <= 17; e += 0.25) { const n = 2 ** e; const v = io(n, d, Br); ps.push([n, v.std]); pf.push([n, v.fl]); }
        LIA.clear(nChart).appendChild(LIA.lineChart({
          width: 900, height: 280,
          x: { min: 512, max: 131072, log: true, label: "sequence length N (log)", ticks: [512, 2048, 8192, 32768, 131072], fmt: (v) => fmt.si(v, 0) },
          y: { min: 1e5, max: 1e11, log: true, label: "HBM bytes / head (log)", fmt: (v) => fmt.bytes(v, 0) },
          series: [{ points: ps, color: "var(--hbm)", label: "standard" }, { points: pf, color: "var(--sram)", label: "FlashAttention" }],
          vlines: [{ x: N, label: `N = ${fmt.si(N, 0)}` }],
          markers: [{ x: N, y: r.std, color: "var(--hbm)" }, { x: N, y: r.fl, color: "var(--sram)" }],
        }));
        nStats.set("flops", fmt.si(r.flops, 1));
        nStats.set("std", fmt.bytes(r.std));
        nStats.set("fl", fmt.bytes(r.fl));
        nStats.set("ratio", fmt.num(r.std / r.fl, 1) + "×");
        nStats.set("smem", fmt.bytes(2 * N * N * 64));
        const tm = (b) => Math.max(b / 3.35e12, r.flops / 989e12) * 1000;
        const ts = tm(r.std), tf = tm(r.fl);
        nStats.set("tstd", fmt.num(ts, 3) + " ms · " + (r.std / 3.35e12 > r.flops / 989e12 ? "HBM-bound" : "compute-bound"));
        nStats.set("tfl", fmt.num(tf, 3) + " ms · " + (r.fl / 3.35e12 > r.flops / 989e12 ? "HBM-bound" : "compute-bound"));
      }
      updN();

      /* ---------- online softmax walk-through ---------- */
      stage.appendChild(h("h3", { style: { fontSize: "18px", marginTop: "10px" } }, "The online-softmax trick, with numbers"));
      const rnd = LIA.rng(3);
      const scores = Array.from({ length: 8 }, () => +(rnd() * 6 - 1).toFixed(2));
      const osBox = LIA.viz();
      let osStep = 0;
      const osBtn = LIA.button("Process next tile ▸", () => { osStep = (osStep + 1) % 3; drawOS(); });
      stage.append(h("div", { class: "row" }, osBtn, h("span", { class: "caption" }, "One query row, 8 scores, split into 2 tiles of 4. Exact softmax without ever holding all 8 at once.")), osBox);
      function drawOS() {
        const t1 = scores.slice(0, 4), t2 = scores.slice(4);
        const m1 = Math.max(...t1), l1 = t1.reduce((a, x) => a + Math.exp(x - m1), 0);
        const m2 = Math.max(m1, ...t2);
        const l2 = l1 * Math.exp(m1 - m2) + t2.reduce((a, x) => a + Math.exp(x - m2), 0);
        const W = 900, sv = LIA.svg(W, 120, { "aria-label": "Online softmax" });
        scores.forEach((v, i) => {
          const inT1 = i < 4, seen = osStep >= (inT1 ? 1 : 2);
          const x = 10 + i * 64;
          sv.appendChild(s("rect", { x, y: 10, width: 58, height: 34, rx: 5, fill: seen ? (osStep === (inT1 ? 1 : 2) ? "var(--sram)" : "var(--sram-soft)") : "var(--surface-2)", stroke: "var(--line)" }));
          sv.appendChild(s("text", { x: x + 29, y: 32, "text-anchor": "middle", "font-size": 13, fill: osStep === (inT1 ? 1 : 2) ? "var(--surface)" : "var(--ink)" }, v.toFixed(2)));
          if (osStep === 2) {
            const p = Math.exp(v - m2) / l2;
            sv.appendChild(s("rect", { x, y: 108 - p * 120, width: 58, height: p * 120, fill: "var(--accent)", opacity: 0.6 }));
            sv.appendChild(s("text", { x: x + 29, y: 104 - p * 120, "text-anchor": "middle", "font-size": 10.5, fill: "var(--accent)" }, p.toFixed(3)));
          }
        });
        const lines = osStep === 0 ? ["m = −∞, ℓ = 0", "Nothing loaded yet."]
          : osStep === 1 ? [`tile 1: m₁ = max = ${m1.toFixed(2)}`, `ℓ₁ = Σ e^(x − m₁) = ${l1.toFixed(3)}`]
          : [`tile 2: m = max(m₁, max tile2) = ${m2.toFixed(2)}`, `ℓ = ℓ₁·e^(m₁−m) + Σ e^(x−m) = ${l2.toFixed(3)}`, `rescale O the same way → exact softmax`];
        lines.forEach((ln, i) => sv.appendChild(s("text", { x: 540, y: 22 + i * 20, "font-size": 12.5, fill: i === 2 ? "var(--good)" : "var(--ink)" }, ln)));
        const direct = scores.reduce((a, x) => a + Math.exp(x - Math.max(...scores)), 0);
        if (osStep === 2) sv.appendChild(s("text", { x: 540, y: 86, "font-size": 11.5, fill: "var(--muted)" }, `check: one-pass ℓ = ${direct.toFixed(3)} ✓`));
        LIA.clear(osBox).appendChild(sv);
      }
      drawOS();
    },
    insights: [
      { t: "Attention is memory-bound, not FLOP-bound.", d: "Softmax, masking and dropout do ~1 FLOP per byte. Standard attention spends its time moving the N×N matrix through HBM, not multiplying." },
      { t: "Tiling.", d: "Load a Q tile and stream K/V tiles through SRAM. S and P exist only one tile at a time, on-chip. HBM sees Q, K, V and O, never S or P." },
      { t: "Online softmax.", d: "Keep a running max m and running sum ℓ per row. When a new tile raises the max, rescale the old partial sums by e^(m_old − m_new). The result is exact, not an approximation." },
      { t: "It flips the bottleneck.", d: "Standard attention is HBM-bound. With S and P on-chip, FlashAttention becomes compute-bound: the remaining time is the unavoidable 4·N²·d FLOPs." },
      { t: "Memory goes from O(N²) to O(N).", d: "That is what made 128K-token contexts practical. FA-2 improves work partitioning; FA-3 adds Hopper async (TMA, warp specialization) and FP8." },
    ],
    quiz: [
      { type: "mcq", prompt: "FlashAttention performs roughly the same FLOPs as standard attention. Why is it much faster?", options: ["It approximates softmax", "It avoids reading and writing the N×N score/probability matrices to HBM by keeping tiles in SRAM", "It uses fewer attention heads", "It skips the P·V multiplication"], answer: 1, explain: "Fewer HBM bytes in a memory-bound op means less time. The math is exact, and the backward pass even recomputes S on the fly rather than storing it." },
      { type: "num", prompt: "Standard attention with N = 32,768 in FP16: how many GB does ONE head's N×N score matrix S occupy?", answer: 2.147, tol: 0.03, unit: "GB", explain: "32,768² × 2 B = 2.147 GB per head, per sequence, per layer pass. With 64 heads that is ~137 GB. FlashAttention never materializes it." },
      { type: "mcq", prompt: "In online softmax, a new tile has a larger max than the running max m. What do you do with the running sum ℓ?", options: ["Discard it and restart", "Multiply it by e^(m_old − m_new) before adding the new tile's terms", "Divide it by the new max", "Nothing; sums are independent of the max"], answer: 1, explain: "All earlier exponentials were computed relative to m_old. Multiplying by e^(m_old − m_new) re-bases them to the new max. The partial output O gets the same rescaling." },
    ],
  });

  /* =====================================================================
   * Module 1 checkpoint (the kickoff questions)
   * ===================================================================== */
  LIA.register({
    id: "m1check",
    module: 1,
    q: "✓ M1",
    title: "Module 1 Checkpoint",
    labTitle: "Before you answer · one-glance recap",
    lede: "The three kickoff questions. Write your answer first, then reveal the model answer and score yourself against the rubric.",
    tags: [{ label: "Q1 · Q3 · Q5", kind: "accent" }, { label: "self-graded", kind: "good" }],
    render(stage) {
      const W = 960, sv = LIA.svg(W, 190, { "aria-label": "Module 1 recap" });
      const cols = [
        { x: 10, t: "Q1 · lifecycle", c: "var(--compute)", lines: ["parse → tokenize → queue", "PREFILL: [N×d]·[d×d] GEMM", "write K,V for N tokens", "sample token 1 → TTFT", "DECODE: [1×d]·[d×d] GEMV"], href: "q1" },
        { x: 330, t: "Q3 · KV cache", c: "var(--hbm)", lines: ["2 × L × H_kv × d × bytes", "= 327,680 B/token (70B)", "× 32,768 = 10.74 GB/req", "× 100 users", "= 1,073.7 GB (1,000 GiB)"], href: "q3" },
        { x: 650, t: "Q5 · FlashAttention", c: "var(--sram)", lines: ["same 4·N²·d FLOPs", "standard: N×N via HBM", "flash: tiles stay in SRAM", "online softmax (m, ℓ)", "O(N²) → O(N) memory"], href: "q5" },
      ];
      cols.forEach((c) => {
        const g = s("g", { style: "cursor:pointer", tabindex: 0, role: "link" });
        g.appendChild(s("rect", { x: c.x, y: 6, width: 300, height: 176, rx: 10, fill: "var(--surface-2)", stroke: c.c, "stroke-width": 1.5 }));
        g.appendChild(s("text", { x: c.x + 14, y: 30, "font-size": 13, "font-weight": 600, fill: c.c }, c.t));
        c.lines.forEach((ln, i) => g.appendChild(s("text", { x: c.x + 14, y: 58 + i * 24, "font-size": 12, fill: "var(--ink)" }, ln)));
        g.appendChild(s("text", { x: c.x + 286, y: 30, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, "open lab ↗"));
        g.addEventListener("click", () => LIA.go(c.href));
        g.addEventListener("keydown", (e) => { if (e.key === "Enter") LIA.go(c.href); });
        sv.appendChild(g);
      });
      stage.append(LIA.viz(sv), LIA.caption("The recap gives away the skeleton on purpose. The rubric rewards the <i>why</i>: bytes vs FLOPs, reuse, and the memory hierarchy. Prefer to be graded by a person? Paste your answers into your chat with Claude for a line-by-line critique."));
    },
    insights: [],
    quiz: [
      {
        type: "free",
        prompt: "[Q1] Walk through the lifecycle of a request entering an inference server (e.g. vLLM) up to the first token. What happens in prefill, and why is it compute-bound?",
        model: "HTTP request → API server validates and applies the chat template → tokenizer produces N token IDs → scheduler queues the request and admits it once KV blocks and the step's token budget allow → <b>prefill</b>: one forward pass over all N tokens through every layer (QKV projections, attention with causal mask, MLP), writing K and V for all N positions into the paged KV cache → logits of the last position are sampled → token 1 is detokenized and streamed (SSE). TTFT = queue + prefill + small CPU overheads. Prefill is compute-bound because the N tokens form an [N×d] matrix multiplied by each [d×d] weight: every weight byte loaded from HBM is reused N times, so arithmetic intensity ≈ N FLOP/byte, far above the GPU's ridge point (~295 FLOP/B on H100). Decode afterwards is a GEMV with intensity ≈ batch size, so it is bandwidth-bound.",
        rubric: [
          "Named the CPU-side steps: parsing / chat template, tokenization",
          "Mentioned scheduling / queueing and KV cache allocation before prefill",
          "Prefill processes all prompt tokens in parallel in one forward pass and fills the KV cache",
          "First token = sample from the last position's logits; TTFT ends when it is streamed",
          "Compute-bound because of matrix-matrix multiplication: weights reused across N tokens (high arithmetic intensity)",
          "Contrasted with decode: one token per step, matrix-vector, memory-bandwidth-bound",
        ],
      },
      { type: "num", prompt: "[Q3] Llama-3 70B · 32,768-token context · 100 users · L=80, H_kv=8, d_head=128, FP16. Total KV cache in GB?", answer: 1073.7, tol: 0.075, unit: "GB", explain: "2 × 80 × 8 × 128 × 2 B = 327,680 B per token → × 32,768 = 10,737,418,240 B ≈ 10.74 GB per user → × 100 = 1,073.7 GB = exactly 1,000 GiB. That exceeds an 8×H100 node (640 GB) even before 141 GB of FP16 weights." },
      {
        type: "free",
        prompt: "[Q3] Show your step-by-step working for the KV cache number, and say what it implies for deployment.",
        model: "Per token: 2 (K and V) × 80 layers × 8 KV heads × 128 dims × 2 B = 327,680 B (320 KiB). Per request: × 32,768 tokens = 10.74 GB (10 GiB). All users: × 100 = 1,073.7 GB (1,000 GiB). Implication: one 8×H100 node (640 GB) cannot even hold the KV cache, let alone 141 GB of weights. Options: FP8 KV (halves it), fewer concurrent long-context users per replica, H200/B200 nodes, KV offload to CPU/NVMe, prefix sharing, or sharding across more GPUs. Note GQA already saved 8× versus MHA (64 KV heads → 8.6 TB).",
        rubric: [
          "Included the factor of 2 for K and V",
          "Used H_kv = 8 (not 64 query heads)",
          "Got ≈ 327,680 B (320 KiB) per token",
          "Got ≈ 10.7 GB per request and ≈ 1,074 GB (1,000 GiB) total",
          "Drew a deployment conclusion (doesn't fit 8×H100; FP8 KV / bigger GPUs / fewer users / offload)",
        ],
      },
      {
        type: "free",
        prompt: "[Q5] Standard attention and FlashAttention compute the same softmax(QKᵀ/√d)·V with ~O(N²d) FLOPs. Why is FlashAttention dramatically faster? Mention HBM vs SRAM.",
        model: "Attention's elementwise parts (scaling, masking, softmax) are memory-bound: GPUs have far more FLOPs than HBM bandwidth (H100: ~989 TFLOPS vs 3.35 TB/s). Standard attention runs separate kernels that write the N×N score matrix S to HBM, read it back for softmax, write P, then read P again for P·V: O(N²) HBM traffic and O(N²) memory. FlashAttention fuses everything into one kernel and tiles Q, K, V into blocks sized for on-chip SRAM (~228 KB per SM, an order of magnitude faster than HBM). For each Q tile it streams K/V tiles, computes the scores in SRAM, and uses online softmax (running max m and sum ℓ, rescaling earlier partial results by e^(m_old − m_new)) to produce exact outputs without ever materializing S or P in HBM. HBM traffic drops several-fold, memory falls from O(N²) to O(N), and the saved bytes are what make it faster. The backward pass recomputes S from Q and K instead of storing it, trading cheap FLOPs for expensive bytes.",
        rubric: [
          "Stated attention (softmax part) is memory-bandwidth bound, not FLOP bound",
          "Standard attention materializes the N×N matrix in HBM (multiple reads/writes)",
          "Explained tiling: blocks of Q, K, V loaded into fast on-chip SRAM",
          "Explained online softmax (running max and sum with rescaling) keeps the result exact",
          "Kernel fusion: one kernel instead of several",
          "Memory O(N²) → O(N), and/or recomputation in the backward pass",
        ],
      },
    ],
  });
})();
