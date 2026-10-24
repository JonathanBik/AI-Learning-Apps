/* Module 4 — Distributed Inference & Parallelism: Q22 (PD disaggregation), Q23 (MoE & parallelism). */
(function () {
  "use strict";
  const { h, s, fmt } = LIA;
  const gpuColor = (i) => `hsl(${(i * 45 + 205) % 360} 62% 56%)`;

  /* =====================================================================
   * Q22 — Disaggregated prefill / decode
   * ===================================================================== */
  function q22Diagram(stage) {
    const W = 760, H = 270;
    const cv = LIA.canvas(W, H);
    const ctx = cv.ctx;
    let mode = "disagg";
    const st = LIA.stats([
      { key: "tpot", label: "Decode step gap p50", cls: "accent" },
      { key: "tmax", label: "Worst decode gap (10 s)" },
      { key: "stall", label: "Decode stalls (10 s)" },
    ]);
    const modeSeg = LIA.seg({
      label: "Deployment",
      options: [{ value: "coloc", label: "Colocated (one pool)" }, { value: "disagg", label: "Disaggregated (P ⟶ D)" }],
      value: mode,
      onChange: (v) => { mode = v; reset(); },
    });

    let gpus, reqs, toks, kvs, spawnT, gaps, stalls, clock;
    const PREFILL = 0.8, STEP = 0.25, MOVE = 0.5;
    function mkGpu(x, y, role) { return { x, y, w: 46, h: 34, role, busyUntil: 0, queue: [], seqs: [], nextStep: 0, lastStep: 0, stalled: false }; }
    function reset() {
      gpus = []; reqs = []; toks = []; kvs = []; spawnT = 0; gaps = []; stalls = []; clock = 0;
      if (mode === "disagg") {
        for (let i = 0; i < 4; i++) gpus.push(mkGpu(190 + (i % 2) * 62, 70 + Math.floor(i / 2) * 60, "P"));
        for (let i = 0; i < 4; i++) gpus.push(mkGpu(490 + (i % 2) * 62, 70 + Math.floor(i / 2) * 60, "D"));
      } else {
        for (let i = 0; i < 8; i++) gpus.push(mkGpu(230 + (i % 4) * 72, 70 + Math.floor(i / 4) * 60, "PD"));
      }
    }
    reset();
    const pick = (role) => gpus.filter((g) => g.role === role || g.role === "PD")
      .sort((a, b) => (a.queue.length + a.seqs.length + (a.busyUntil > clock ? 1 : 0)) - (b.queue.length + b.seqs.length + (b.busyUntil > clock ? 1 : 0)))[0];
    const center = (g) => [g.x + g.w / 2, g.y + g.h / 2];

    LIA.loop((dt) => {
      clock += dt;
      // arrivals
      spawnT -= dt;
      if (spawnT <= 0) {
        spawnT = 0.55 + Math.random() * 0.5;
        const g = pick(mode === "disagg" ? "P" : "PD");
        reqs.push({ x0: 40, y0: 135, g, t: 0 });
      }
      reqs = reqs.filter((r) => { r.t += dt; if (r.t >= MOVE) { r.g.queue.push({}); return false; } return true; });
      gpus.forEach((g) => {
        // start prefill
        if (g.busyUntil <= clock && g.queue.length && (g.role !== "D")) { g.queue.shift(); g.busyUntil = clock + PREFILL; g.prefilling = true; }
        if (g.prefilling && g.busyUntil <= clock) {
          g.prefilling = false;
          if (mode === "disagg") {
            const d = pick("D");
            for (let k = 0; k < 4; k++) kvs.push({ from: center(g), to: center(d), d, t: -k * 0.12, last: k === 3 });
          } else g.seqs.push({ rem: 10 + Math.floor(Math.random() * 8), y: Math.random() });
        }
        // decode step: colocated GPUs cannot step while prefilling (same SMs, same iteration)
        if (g.role !== "P" && g.seqs.length) {
          g.stalled = !!g.prefilling;
          if (!g.prefilling && clock >= g.nextStep) {
            const gap = clock - (g.lastStep || clock);
            if (g.lastStep) { gaps.push({ t: clock, v: gap }); if (gap > STEP * 1.8) stalls.push(clock); }
            g.lastStep = clock; g.nextStep = clock + STEP;
            g.seqs.forEach((q) => { q.rem--; const [cx, cy] = center(g); toks.push({ x: cx + 24, y: cy - 10 + q.y * 20, life: 0 }); });
            g.seqs = g.seqs.filter((q) => q.rem > 0);
            if (!g.seqs.length) g.lastStep = 0;
          }
        } else g.stalled = false;
      });
      kvs = kvs.filter((k) => { k.t += dt; if (k.t >= 0.6) { if (k.last) k.d.seqs.push({ rem: 10 + Math.floor(Math.random() * 8), y: Math.random() }); return false; } return true; });
      toks.forEach((t) => { t.x += 160 * dt; t.life += dt; });
      toks = toks.filter((t) => t.x < W - 30);
      gaps = gaps.filter((g) => g.t > clock - 10);
      stalls = stalls.filter((t) => t > clock - 10);
      draw();
    });

    let statTick = 0;
    function draw() {
      const c = LIA.colors();
      cv.clear();
      ctx.font = "11px JetBrains Mono, monospace";
      ctx.textAlign = "center";
      // client + out
      ctx.fillStyle = c.muted; ctx.fillText("clients", 40, 30); ctx.fillText("tokens out", W - 50, 30);
      LIA.rrect(ctx, 18, 115, 44, 40, 6); ctx.strokeStyle = c.line; ctx.lineWidth = 1.5; ctx.stroke();
      if (mode === "disagg") {
        LIA.rrect(ctx, 175, 48, 140, 140, 10); ctx.fillStyle = c.compute_soft; ctx.fill();
        LIA.rrect(ctx, 475, 48, 140, 140, 10); ctx.fillStyle = c.hbm_soft; ctx.fill();
        ctx.fillStyle = c.compute; ctx.fillText("PREFILL POOL", 245, 40); ctx.fillText("compute-bound · big TP", 245, 205);
        ctx.fillStyle = c.hbm; ctx.fillText("DECODE POOL", 545, 40); ctx.fillText("bandwidth-bound · big batch", 545, 205);
        ctx.strokeStyle = c.accent; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(318, 118); ctx.lineTo(472, 118); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = c.accent; ctx.fillText("KV cache over RDMA", 395, 105); ctx.fillText("InfiniBand / RoCE", 395, 140);
      } else {
        LIA.rrect(ctx, 215, 48, 300, 140, 10); ctx.fillStyle = c.surface_2; ctx.fill(); ctx.strokeStyle = c.line; ctx.stroke();
        ctx.fillStyle = c.ink; ctx.fillText("SHARED POOL — prefill and decode take turns on the same GPUs", 365, 40);
      }
      gpus.forEach((g) => {
        LIA.rrect(ctx, g.x, g.y, g.w, g.h, 5);
        ctx.fillStyle = g.prefilling ? c.compute : g.seqs.length ? c.hbm : c.surface;
        ctx.globalAlpha = g.prefilling ? 0.85 : g.seqs.length ? 0.55 : 1; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = g.stalled ? 3 : 1.2; ctx.strokeStyle = g.stalled ? c.bad : c.line; ctx.stroke();
        ctx.fillStyle = c.ink; ctx.font = "10px JetBrains Mono, monospace";
        ctx.fillText(g.prefilling ? "prefill" : g.seqs.length ? `dec×${g.seqs.length}` : "idle", g.x + g.w / 2, g.y + g.h / 2 + 4);
        if (g.stalled) { ctx.fillStyle = c.bad; ctx.fillText("STALL", g.x + g.w / 2, g.y - 4); }
        if (g.queue.length) { ctx.fillStyle = c.muted; ctx.fillText("+" + g.queue.length, g.x + g.w - 4, g.y + g.h + 11); }
      });
      reqs.forEach((r) => {
        const [tx, ty] = center(r.g); const k = r.t / MOVE;
        ctx.beginPath(); ctx.arc(LIA.lerp(r.x0, tx, k), LIA.lerp(r.y0, ty, k), 5, 0, 7); ctx.fillStyle = c.accent; ctx.fill();
      });
      kvs.forEach((k) => {
        if (k.t < 0) return; const p = k.t / 0.6;
        ctx.fillStyle = c.hbm; ctx.fillRect(LIA.lerp(k.from[0], k.to[0], p) - 5, LIA.lerp(k.from[1], k.to[1], p) - 5, 10, 10);
      });
      toks.forEach((t) => { ctx.fillStyle = c.good; ctx.globalAlpha = Math.max(0.2, 1 - t.life / 2.5); ctx.fillRect(t.x, t.y, 7, 3); ctx.globalAlpha = 1; });
      ctx.textAlign = "left"; ctx.font = "11px JetBrains Mono, monospace"; ctx.fillStyle = c.muted;
      ctx.fillText("● request   ■ KV block   ▬ token   red outline = decode stalled behind a prefill", 18, H - 14);
      if (++statTick % 10 === 0) {
        const v = gaps.map((g) => g.v).sort((a, b) => a - b);
        const scale = 100; // 0.25 sim-s = 25 ms step
        st.set("tpot", v.length ? fmt.num(v[Math.floor(v.length / 2)] * scale) + " ms" : "–");
        const mx = v.length ? v[v.length - 1] * scale : 0;
        st.set("tmax", v.length ? fmt.num(mx) + " ms" : "–", mx > 45 ? "bad" : "good");
        st.set("stall", String(stalls.length), stalls.length ? "bad" : "good");
      }
    }
    stage.append(LIA.controls(modeSeg), LIA.viz(cv.el), st.el,
      LIA.caption("Animation clock: one decode step = 25 ms, one prefill = 80 ms. In colocated mode a prefill occupies the GPU for a whole iteration, so every sequence decoding on it skips a step."));
  }

  function q22Interference(stage) {
    const box = h("div");
    const st = LIA.stats([
      { key: "c50", label: "Colocated TPOT p50" }, { key: "c99", label: "Colocated TPOT p99", cls: "bad" },
      { key: "d50", label: "Disagg TPOT p50" }, { key: "d99", label: "Disagg TPOT p99", cls: "good" },
    ]);
    const prompt = LIA.slider({ label: "Prompt length", min: 1024, max: 32768, step: 1024, value: 8192, fmt: (v) => fmt.si(v) + " tok", onInput: draw });
    const rate = LIA.slider({ label: "New requests / s", min: 0.2, max: 4, step: 0.1, value: 1.2, fmt: (v) => v.toFixed(1), onInput: draw });
    function draw() {
      const r = LIA.rng(7);
      const base = 30, prefillRate = 20000; // tok/s for one 70B prefill instance
      const steps = 240; let t = 0; let nextArr = LIA.expSample(rate.value, r);
      const col = [], dis = [];
      for (let i = 0; i < steps; i++) {
        let step = base + r() * 3;
        const ds = base + r() * 3;
        while (nextArr < t + step / 1000) { step += (prompt.value / prefillRate) * 1000; nextArr += LIA.expSample(rate.value, r); }
        col.push([i, step]); dis.push([i, ds]); t += step / 1000;
      }
      const pct = (a, p) => { const v = a.map((x) => x[1]).sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
      const ymax = Math.max(100, ...col.map((x) => x[1])) * 1.08;
      LIA.clear(box).appendChild(LIA.lineChart({
        width: 720, height: 260, x: { min: 0, max: steps - 1, label: "decode iteration" }, y: { min: 0, max: ymax, label: "step time (ms)", fmt: (v) => fmt.num(v) },
        series: [{ points: col, color: "var(--bad)", label: "Colocated" }, { points: dis, color: "var(--good)", label: "Disaggregated" }],
        hlines: [{ y: 50, label: "TPOT SLO 50 ms", color: "var(--warn)" }],
      }));
      st.set("c50", fmt.num(pct(col, 0.5)) + " ms"); st.set("c99", fmt.num(pct(col, 0.99)) + " ms");
      st.set("d50", fmt.num(pct(dis, 0.5)) + " ms"); st.set("d99", fmt.num(pct(dis, 0.99)) + " ms");
    }
    draw();
    stage.append(h("h3", { style: { fontSize: "17px" } }, "Interference timeline: every spike is a prefill landing in a decode batch"), LIA.controls(prompt, rate), LIA.viz(box), st.el);
  }

  function q22Transfer(stage) {
    const tl = h("div");
    const st = LIA.stats([
      { key: "kv", label: "KV to move", cls: "accent" }, { key: "pf", label: "Prefill compute" },
      { key: "tx", label: "Raw transfer time" }, { key: "exp", label: "Exposed on TTFT" },
    ]);
    const model = LIA.select({ label: "Model / KV precision", value: "327680", onChange: draw, options: [
      { value: "327680", label: "Llama-3-70B FP16 · 320 KiB/token" }, { value: "163840", label: "Llama-3-70B FP8 · 160 KiB/token" },
      { value: "131072", label: "Llama-3-8B FP16 · 128 KiB/token" }] });
    const link = LIA.select({ label: "Link", value: "50", onChange: draw, options: [
      { value: "12.5", label: "100 Gb/s NIC · 12.5 GB/s" }, { value: "25", label: "200 Gb/s NIC · 25 GB/s" },
      { value: "50", label: "400 Gb/s NIC · 50 GB/s" }, { value: "400", label: "8× 400 Gb/s rails · 400 GB/s" },
      { value: "900", label: "NVLink (same node) · 900 GB/s" }] });
    const prompt = LIA.slider({ label: "Prompt tokens", min: 512, max: 131072, step: 512, value: 32768, fmt: (v) => fmt.si(v), onInput: draw });
    const thr = LIA.slider({ label: "Prefill throughput (tok/s)", min: 5000, max: 60000, step: 1000, value: 20000, fmt: (v) => fmt.si(v), onInput: draw });
    const overlap = LIA.seg({ label: "Transfer strategy", options: [{ value: "layer", label: "Layer-wise streaming" }, { value: "after", label: "Send after prefill" }], value: "layer", onChange: draw });
    function draw() {
      const L = 80;
      const bytes = prompt.value * Number(model.value);
      const C = prompt.value / thr.value; // s
      const T = bytes / (Number(link.value) * 1e9);
      let start, finish, exposed;
      if (overlap.value === "layer") { start = C / L; exposed = Math.max(T / L, T - C + C / L); finish = C + exposed; }
      else { start = C; finish = C + T; exposed = T; }
      st.set("kv", fmt.bytes(bytes, 2)); st.set("pf", fmt.ms(C * 1000)); st.set("tx", fmt.ms(T * 1000));
      st.set("exp", fmt.ms(exposed * 1000) + " · " + fmt.pct(exposed / finish, 0) + " of TTFT", exposed / finish > 0.2 ? "bad" : exposed / finish > 0.05 ? "warn" : "good");
      const W = 720, H = 150, l = 120, r = 20, xmax = finish * 1.08;
      const X = (v) => l + (v / xmax) * (W - l - r);
      const svg = LIA.svg(W, H);
      const row = (y, label, x0, x1, color, txt) => {
        svg.append(s("text", { x: l - 8, y: y + 17, "text-anchor": "end", "font-size": 12, fill: "var(--ink)" }, label),
          s("rect", { x: X(x0), y, width: Math.max(2, X(x1) - X(x0)), height: 26, rx: 4, fill: color, opacity: 0.85 }),
          X(x1) + 6 > W - 130
            ? s("text", { x: X(x1) - 6, y: y + 17, "text-anchor": "end", "font-size": 11, "font-weight": 600, fill: "#fff" }, txt)
            : s("text", { x: X(x1) + 6, y: y + 17, "font-size": 11, fill: "var(--muted)" }, txt));
      };
      row(20, "Prefill (GPU)", 0, C, "var(--compute)", fmt.ms(C * 1000));
      row(58, "KV over RDMA", start, finish, "var(--hbm)", fmt.ms(T * 1000) + " on wire");
      svg.append(s("line", { x1: X(finish), x2: X(finish), y1: 10, y2: 100, stroke: "var(--accent)", "stroke-width": 2, "stroke-dasharray": "4 3" }),
        s("text", { x: X(finish), y: 118, "text-anchor": "middle", "font-size": 11, fill: "var(--accent)" }, "first decode step"));
      LIA.niceTicks(0, xmax * 1000, 5).forEach((v) => svg.append(s("text", { x: X(v / 1000), y: 142, "text-anchor": "middle", "font-size": 10, fill: "var(--muted)" }, fmt.ms(v))));
      LIA.clear(tl).appendChild(svg);
    }
    draw();
    stage.append(h("h3", { style: { fontSize: "17px" } }, "KV transfer budget: is the network on the critical path?"),
      LIA.controls(model, link, prompt, thr, overlap), LIA.viz(tl), st.el,
      LIA.formula(`KV bytes  = <span class="hl">prompt_tokens</span> × <span class="hbm">2·L·H_kv·d_head·bytes</span>\ntransfer  = KV bytes / link_BW\nlayer-wise: exposed ≈ max(T/L, T − C + C/L)   <span class="dim">(L = 80 layers, C = prefill time)</span>`));
  }

  function q22Ratio(stage) {
    const grid = h("div");
    const st = LIA.stats([{ key: "p", label: "Prefill instances", cls: "accent" }, { key: "d", label: "Decode instances", cls: "accent" }, { key: "r", label: "P : D ratio" }]);
    const rate = LIA.slider({ label: "Requests / s", min: 1, max: 60, value: 20, onInput: draw });
    const inp = LIA.slider({ label: "Avg input tokens", min: 256, max: 32768, step: 256, value: 4096, fmt: (v) => fmt.si(v), onInput: draw });
    const out = LIA.slider({ label: "Avg output tokens", min: 32, max: 4096, step: 32, value: 512, fmt: (v) => fmt.si(v), onInput: draw });
    const tp = 20000, td = 2500;
    function draw() {
      const P = Math.max(1, Math.ceil((rate.value * inp.value) / (tp * 0.8)));
      const D = Math.max(1, Math.ceil((rate.value * out.value) / (td * 0.8)));
      st.set("p", String(P)); st.set("d", String(D)); st.set("r", `${(P / D).toFixed(2)} : 1`);
      const n = P + D, cols = 16, cell = 30, W = cols * cell + 10, H = Math.ceil(n / cols) * cell + 30;
      const svg = LIA.svg(W, H);
      for (let i = 0; i < n; i++) {
        const isP = i < P;
        svg.append(s("rect", { x: 5 + (i % cols) * cell, y: 5 + Math.floor(i / cols) * cell, width: cell - 6, height: cell - 6, rx: 4, fill: isP ? "var(--compute)" : "var(--hbm)", opacity: 0.85 }));
      }
      svg.append(s("text", { x: 5, y: H - 6, "font-size": 11, fill: "var(--muted)" }, `■ prefill (${P})  ■ decode (${D})  — each square = one 8-GPU instance`));
      LIA.clear(grid).appendChild(svg);
    }
    draw();
    stage.append(h("h3", { style: { fontSize: "17px" } }, "Size the two pools independently"), LIA.controls(rate, inp, out), LIA.viz(grid), st.el,
      LIA.caption("Assumes 20K prompt tok/s per prefill instance and 2.5K generated tok/s per decode instance (Llama-3-70B class on 8 GPUs), 80% target utilization. RAG-style long prompts need more prefill; chatty long answers need more decode."));
  }

  LIA.register({
    id: "q22", module: 4, q: "Q22", title: "Disaggregated Prefill & Decode",
    lede: "Run the compute-bound prefill and the bandwidth-bound decode on separate GPU pools, and ship the KV cache between them over RDMA.",
    tags: [{ label: "PD disaggregation", kind: "accent" }, { label: "RDMA", kind: "hbm" }, { label: "TPOT stability", kind: "good" }],
    render(stage) { q22Diagram(stage); q22Interference(stage); q22Transfer(stage); q22Ratio(stage); },
    insights: [
      { t: "Interference is the problem.", d: "In a shared engine, each prefill adds hundreds of ms to one iteration, and every decoding user feels it as a TPOT spike." },
      { t: "Each pool gets its own config.", d: "Prefill favors high TP and small batches for TTFT. Decode favors large batches, lots of KV memory and bandwidth." },
      { t: "The network is usually hidden.", d: "Stream KV layer by layer while later layers still compute. A 32K prompt on a 70B model moves ~10.7 GB, about 215 ms on a 400 Gb/s NIC, against ~1.6 s of prefill." },
      { t: "The cost is a second hop.", d: "Short prompts gain little and pay transfer and scheduling overhead. Disaggregate when prompts are long or TPOT SLOs are strict." },
    ],
    quiz: [
      { type: "mcq", prompt: "What is the main reason to disaggregate prefill from decode?", options: [
        "Prefill needs less memory, so it can run on CPUs",
        "Prefill bursts stall decode iterations on shared GPUs, and the two phases want different parallelism and batch settings",
        "Decode is compute-bound and needs the faster GPUs",
        "It removes the need for a KV cache"], answer: 1,
        explain: "Prefill is compute-bound and bursty; decode is memory-bandwidth-bound and steady. Separating them removes TPOT spikes and lets you tune TP, batch size and even GPU type per phase." },
      { type: "num", prompt: "An 8,192-token prompt on Llama-3-70B in FP16 (327,680 bytes of KV per token) is sent over a 50 GB/s link. How many milliseconds does the raw transfer take?", answer: 53.7, tol: 0.04, unit: "ms",
        explain: "8,192 × 327,680 = 2.68 GB. 2.68 GB ÷ 50 GB/s = 0.0537 s ≈ <b>53.7 ms</b>. With layer-wise streaming most of this overlaps with prefill compute." },
      { type: "mcq", prompt: "Which technique hides most of the KV transfer latency?", options: [
        "Compressing KV with gzip on the CPU before sending",
        "Sending each layer's KV over GPUDirect RDMA as soon as that layer finishes, while later layers still compute",
        "Waiting for the whole prefill to finish, then sending one big buffer",
        "Recomputing the KV cache on the decode node"], answer: 1,
        explain: "Layer-wise pipelining overlaps network with compute; GPUDirect RDMA moves GPU memory to the NIC without bouncing through host memory, so only the last layer's slice is exposed." },
    ],
  });

  /* =====================================================================
   * Q23 — MoE & parallelism
   * ===================================================================== */
  const PRESETS = {
    tp8: { label: "TP = 8", attn: () => ({ g: [0, 1, 2, 3, 4, 5, 6, 7] }), exp: () => [0, 1, 2, 3, 4, 5, 6, 7], tp: [[0, 1, 2, 3, 4, 5, 6, 7]], pp: [], ep: [],
      mem: 11.7, comm: 917, sync: "64 all-reduce", note: "TP spans both nodes: every layer's all-reduce crosses InfiniBand (~50 GB/s/GPU) instead of NVLink (~900 GB/s).", warn: true },
    pp8: { label: "PP = 8", attn: (r) => ({ g: [r] }), exp: (r) => [r], tp: [], pp: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]], ep: [],
      mem: 11.7, comm: 57, sync: "7 point-to-point", note: "Tiny traffic, but one token walks through 8 GPUs one after another: no latency gain, bubbles unless many micro-batches." },
    ep8: { label: "EP = 8 (attn DP)", attn: () => ({ g: [0, 1, 2, 3, 4, 5, 6, 7], rep: true }), exp: (r, e) => [e], tp: [], pp: [], ep: [[0, 1, 2, 3, 4, 5, 6, 7]],
      mem: 14.5, comm: 917, sync: "64 all-to-all", note: "Each GPU owns one whole expert. Attention weights are replicated. Step time follows the busiest expert." },
    tp4pp2: { label: "TP 4 × PP 2", attn: (r) => ({ g: r < 4 ? [0, 1, 2, 3] : [4, 5, 6, 7] }), exp: (r) => (r < 4 ? [0, 1, 2, 3] : [4, 5, 6, 7]), tp: [[0, 1, 2, 3], [4, 5, 6, 7]], pp: [[0, 4], [1, 5], [2, 6], [3, 7]], ep: [],
      mem: 11.7, comm: 794, sync: "64 all-reduce + 1 p2p", note: "Classic multi-node layout: TP stays inside the NVLink domain, PP crosses the node boundary once." },
    pp2ep4: { label: "PP 2 × EP 4", attn: (r) => ({ g: r < 4 ? [0, 1, 2, 3] : [4, 5, 6, 7] }), exp: (r, e) => [(r < 4 ? 0 : 4) + (e % 4)], tp: [[0, 1, 2, 3], [4, 5, 6, 7]], pp: [[0, 4], [1, 5], [2, 6], [3, 7]], ep: [[0, 1, 2, 3], [4, 5, 6, 7]],
      mem: 11.7, comm: 1188, sync: "32 all-reduce + 64 all-to-all + 1 p2p", note: "Experts spread 2 per GPU inside each node; all-to-all stays on NVLink." },
  };

  function q23Layout(stage) {
    let key = "tp4pp2";
    const mapBox = h("div"), anim = LIA.canvas(560, 200);
    const st = LIA.stats([{ key: "mem", label: "Weights per GPU (BF16)", cls: "accent" }, { key: "comm", label: "Comm per token / GPU" }, { key: "sync", label: "Sync points / forward" }]);
    const note = h("div", { class: "caption" });
    const seg = LIA.seg({ label: "Parallelism layout (2 nodes × 4 GPUs)", options: Object.entries(PRESETS).map(([k, p]) => ({ value: k, label: p.label })), value: key, onChange: (v) => { key = v; draw(); } });
    function draw() {
      const P = PRESETS[key];
      const W = 640, rowH = 26, top = 30, attnW = 120, eW = 50, x0 = 64;
      const svg = LIA.svg(W, top + 8 * rowH + 10);
      svg.append(s("text", { x: x0 + attnW / 2, y: 18, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, "attention"));
      for (let e = 0; e < 8; e++) svg.append(s("text", { x: x0 + attnW + 8 + e * eW + eW / 2, y: 18, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, "E" + e));
      const cell = (x, y, w, gl, rep) => {
        const sw = w / gl.length;
        gl.forEach((g, i) => svg.append(s("rect", { x: x + i * sw, y: y + 2, width: sw, height: rowH - 5, fill: gpuColor(g), opacity: rep ? 0.45 : 0.9 })));
        svg.append(s("rect", { x, y: y + 2, width: w, height: rowH - 5, fill: "none", stroke: "var(--line)" }));
        if (rep) svg.append(s("text", { x: x + w / 2, y: y + rowH / 2 + 4, "text-anchor": "middle", "font-size": 10, fill: "var(--ink)" }, "replicated ×8"));
      };
      for (let r = 0; r < 8; r++) {
        const y = top + r * rowH;
        svg.append(s("text", { x: x0 - 6, y: y + rowH / 2 + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, `L${r * 4}–${r * 4 + 3}`));
        const a = P.attn(r);
        cell(x0, y, attnW, a.g, a.rep);
        for (let e = 0; e < 8; e++) cell(x0 + attnW + 8 + e * eW, y, eW - 4, P.exp(r, e), false);
      }
      LIA.clear(mapBox).appendChild(svg);
      st.set("mem", P.mem + " GB"); st.set("comm", fmt.num(P.comm) + " KB", P.warn ? "bad" : ""); st.set("sync", P.sync);
      note.innerHTML = (P.warn ? "⚠ " : "") + P.note;
      packets = [];
    }
    // GPU legend chips
    const chips = h("div", { class: "legend" }, [0, 1, 2, 3, 4, 5, 6, 7].map((g) => h("span", null, h("i", { style: { background: gpuColor(g) } }), "GPU " + g + (g < 4 ? " · node A" : " · node B"))));

    // communication animation
    let packets = [], spawn = 0;
    const pos = (g) => [70 + (g % 4) * 130, g < 4 ? 50 : 150];
    LIA.loop((dt) => {
      const P = PRESETS[key];
      spawn -= dt;
      if (spawn <= 0) {
        spawn = 0.45;
        P.tp.forEach((grp) => grp.forEach((g, i) => packets.push({ a: g, b: grp[(i + 1) % grp.length], t: 0, c: "compute" })));
        if (P.pp.length) { const pr = P.pp[Math.floor(Math.random() * P.pp.length)]; packets.push({ a: pr[0], b: pr[1], t: 0, c: "accent" }); }
        P.ep.forEach((grp) => grp.forEach((g) => { for (let k = 0; k < 2; k++) { const b = grp[Math.floor(Math.random() * grp.length)]; if (b !== g) packets.push({ a: g, b, t: 0, c: "hbm" }); } }));
      }
      packets.forEach((p) => (p.t += dt / 0.6));
      packets = packets.filter((p) => p.t < 1);
      const c = LIA.colors(), ctx = anim.ctx;
      anim.clear();
      ctx.font = "11px JetBrains Mono, monospace"; ctx.textAlign = "center";
      [["node A · NVLink", 8], ["node B · NVLink", 108]].forEach(([t, y]) => { LIA.rrect(ctx, 10, y + 15, 540, 72, 10); ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.stroke(); ctx.fillStyle = c.muted; ctx.fillText(t, 280, y + 12); });
      ctx.fillStyle = c.bad; ctx.fillText("↕ InfiniBand between nodes", 280, 104);
      for (let g = 0; g < 8; g++) { const [x, y] = pos(g); LIA.rrect(ctx, x - 26, y - 16, 52, 32, 5); ctx.fillStyle = gpuColor(g); ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1; ctx.fillStyle = "#fff"; ctx.fillText("GPU" + g, x, y + 4); }
      packets.forEach((p) => {
        const [ax, ay] = pos(p.a), [bx, by] = pos(p.b);
        const cross = (p.a < 4) !== (p.b < 4);
        ctx.beginPath(); ctx.arc(LIA.lerp(ax, bx, p.t), LIA.lerp(ay, by, p.t) + (ay === by ? -22 * Math.sin(Math.PI * p.t) : 0), 4, 0, 7);
        ctx.fillStyle = cross ? c.bad : c[p.c]; ctx.fill();
      });
    });
    draw();
    stage.append(LIA.controls(seg), chips, LIA.viz(mapBox),
      h("div", { class: "legend" }, h("span", null, h("i", { style: { background: "var(--compute)" } }), "TP all-reduce (ring)"), h("span", null, h("i", { style: { background: "var(--accent)" } }), "PP activation hand-off"), h("span", null, h("i", { style: { background: "var(--hbm)" } }), "EP all-to-all"), h("span", null, h("i", { style: { background: "var(--bad)" } }), "crosses node boundary")),
      LIA.viz(anim.el), st.el, note,
      LIA.caption("Model: Mixtral-8×7B-like MoE, 32 layers, hidden 4096, 8 experts, top-2, 46.7B params (93 GB in BF16). Each row is a group of 4 layers; each colored stripe is the GPU holding that slice. Comm = bytes each GPU sends per decoded token across all layers."));
  }

  function q23Pipeline(stage) {
    const box = h("div");
    const st = LIA.stats([{ key: "b", label: "Bubble fraction", cls: "bad" }, { key: "u", label: "Stage utilization", cls: "good" }, { key: "slots", label: "Time slots" }]);
    const p = LIA.slider({ label: "Pipeline stages p", min: 2, max: 8, value: 4, onInput: draw });
    const m = LIA.slider({ label: "Micro-batches m", min: 1, max: 16, value: 4, onInput: draw });
    function draw() {
      const P = p.value, M = m.value, T = M + P - 1, cw = Math.min(42, 600 / T), rh = 26, l = 70;
      const W = l + T * cw + 10, H = P * rh + 30;
      const svg = LIA.svg(Math.max(W, 300), H);
      for (let sIdx = 0; sIdx < P; sIdx++) {
        svg.append(s("text", { x: l - 8, y: 10 + sIdx * rh + rh / 2 + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, "stage " + sIdx));
        for (let t = 0; t < T; t++) {
          const j = t - sIdx, busy = j >= 0 && j < M;
          svg.append(s("rect", { x: l + t * cw, y: 10 + sIdx * rh, width: cw - 2, height: rh - 3, rx: 3, fill: busy ? gpuColor(j % 8) : "var(--surface-2)", stroke: busy ? "none" : "var(--bad)", "stroke-dasharray": busy ? null : "3 2", opacity: busy ? 0.9 : 0.8 }));
          if (busy && cw > 18) svg.append(s("text", { x: l + t * cw + cw / 2 - 1, y: 10 + sIdx * rh + rh / 2 + 3, "text-anchor": "middle", "font-size": 10, fill: "#fff" }, "m" + j));
        }
      }
      svg.append(s("text", { x: l, y: H - 4, "font-size": 11, fill: "var(--muted)" }, "time →  (dashed red = idle bubble)"));
      LIA.clear(box).appendChild(svg);
      const b = (P - 1) / T;
      st.set("b", fmt.pct(b, 1)); st.set("u", fmt.pct(1 - b, 1)); st.set("slots", `${T} = m + p − 1`);
    }
    draw();
    stage.append(h("h3", { style: { fontSize: "17px" } }, "Pipeline bubbles"), LIA.controls(p, m), LIA.viz(box), st.el,
      LIA.formula(`bubble fraction = <span class="bad hl">(p − 1)</span> / (m + p − 1)      <span class="dim">more micro-batches → smaller bubble</span>`));
  }

  function q23Experts(stage) {
    const box = h("div");
    let seed = 3;
    const st = LIA.stats([{ key: "imb", label: "Max / mean load" }, { key: "drop", label: "Tokens over capacity" }, { key: "eff", label: "EP efficiency (mean/max)" }, { key: "cap", label: "Capacity per expert" }]);
    const T = LIA.slider({ label: "Tokens in batch", min: 64, max: 4096, step: 64, value: 1024, onInput: draw });
    const k = LIA.seg({ label: "Router top-k", options: [1, 2], value: 2, onChange: draw });
    const cf = LIA.slider({ label: "Capacity factor", min: 1, max: 2, step: 0.05, value: 1.25, fmt: (v) => v.toFixed(2), onInput: draw });
    const skew = LIA.slider({ label: "Router skew (hot experts)", min: 0, max: 2, step: 0.05, value: 0.8, fmt: (v) => v.toFixed(2), onInput: draw });
    const resample = LIA.button("Resample routing", () => { seed++; draw(); });
    function draw() {
      const E = 8, K = k.value, r = LIA.rng(seed);
      const z = Array.from({ length: E }, () => (r() + r() + r() - 1.5) * 1.4);
      const w = z.map((v) => Math.exp(skew.value * v));
      const cnt = new Array(E).fill(0);
      for (let t = 0; t < T.value; t++) {
        const ww = w.map((x) => x * (0.6 + 0.8 * r()));
        const chosen = [];
        for (let j = 0; j < K; j++) {
          let tot = 0; ww.forEach((x, i) => { if (!chosen.includes(i)) tot += x; });
          let u = r() * tot, pick = 0;
          for (let i = 0; i < E; i++) { if (chosen.includes(i)) continue; u -= ww[i]; if (u <= 0) { pick = i; break; } pick = i; }
          chosen.push(pick); cnt[pick]++;
        }
      }
      const mean = (T.value * K) / E, cap = Math.ceil(cf.value * mean), max = Math.max(...cnt);
      const over = cnt.reduce((a, c) => a + Math.max(0, c - cap), 0);
      const Wd = 640, Hd = 230, l = 50, bw = (Wd - l - 20) / E, ymax = Math.max(max, cap) * 1.12;
      const Y = (v) => Hd - 30 - (v / ymax) * (Hd - 50);
      const svg = LIA.svg(Wd, Hd);
      LIA.niceTicks(0, ymax, 4).forEach((v) => svg.append(s("line", { x1: l, x2: Wd - 20, y1: Y(v), y2: Y(v), stroke: "var(--grid)" }), s("text", { x: l - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 10, fill: "var(--muted)" }, fmt.num(v))));
      cnt.forEach((c, i) => {
        const x = l + i * bw + 6, ok = Math.min(c, cap);
        svg.append(s("rect", { x, y: Y(ok), width: bw - 12, height: Y(0) - Y(ok), rx: 3, fill: "var(--hbm)", opacity: 0.85 }));
        if (c > cap) svg.append(s("rect", { x, y: Y(c), width: bw - 12, height: Y(cap) - Y(c), rx: 3, fill: "var(--bad)" }));
        svg.append(s("text", { x: x + (bw - 12) / 2, y: Hd - 12, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, "E" + i), s("text", { x: x + (bw - 12) / 2, y: Y(c) - 4, "text-anchor": "middle", "font-size": 10, fill: "var(--ink)" }, c));
      });
      svg.append(s("line", { x1: l, x2: Wd - 20, y1: Y(cap), y2: Y(cap), stroke: "var(--bad)", "stroke-dasharray": "5 4", "stroke-width": 1.5 }), s("text", { x: Wd - 22, y: Y(cap) - 5, "text-anchor": "end", "font-size": 11, fill: "var(--bad)" }, "capacity = CF × T·k/E"),
        s("line", { x1: l, x2: Wd - 20, y1: Y(mean), y2: Y(mean), stroke: "var(--good)", "stroke-dasharray": "2 3" }), s("text", { x: l + 4, y: Y(mean) - 5, "font-size": 11, fill: "var(--good)" }, "perfect balance"));
      LIA.clear(box).appendChild(svg);
      st.set("imb", (max / mean).toFixed(2) + "×", max / mean > 1.5 ? "bad" : max / mean > 1.2 ? "warn" : "good");
      st.set("drop", `${over} (${fmt.pct(over / (T.value * K), 1)})`, over ? "bad" : "good");
      st.set("eff", fmt.pct(mean / max, 0)); st.set("cap", String(cap));
    }
    draw();
    stage.append(h("h3", { style: { fontSize: "17px" } }, "Expert load balance under EP"), LIA.controls(T, k, cf, skew, resample), LIA.viz(box), st.el,
      LIA.caption("Each expert lives on one GPU, so the step waits for the busiest one. Tokens above capacity are dropped or rerouted in training-style MoE; inference engines usually skip the cap and absorb the imbalance as latency instead."));
  }

  LIA.register({
    id: "q23", module: 4, q: "Q23", title: "MoE & Parallelism",
    lede: "Tensor, pipeline and expert parallelism each split the model differently, and each pays a different communication bill.",
    tags: [{ label: "TP · PP · EP", kind: "accent" }, { label: "All-reduce / All-to-all", kind: "hbm" }],
    render(stage) { q23Layout(stage); q23Pipeline(stage); q23Experts(stage); },
    insights: [
      { t: "TP: split every matrix.", d: "Cuts per-token latency, but costs two all-reduces per layer. Keep it inside the NVLink domain (≤ 8 GPUs)." },
      { t: "PP: split the layer stack.", d: "Only one activation hand-off per stage boundary, so it crosses nodes cheaply. A single request gains no speed, and you need m ≫ p micro-batches to shrink bubbles." },
      { t: "EP: split the experts.", d: "Each token visits only top-k experts. Two all-to-alls per MoE layer, and the step runs at the speed of the hottest expert." },
      { t: "Real deployments mix them.", d: "Typical layouts: TP inside a node, PP or EP across nodes, attention as DP with EP for experts (DeepSeek-V3 style)." },
    ],
    quiz: [
      { type: "num", prompt: "A forward-only pipeline has p = 4 stages and m = 12 micro-batches. What percentage of stage-time is bubble?", answer: 20, tol: 0.02, unit: "%",
        explain: "(p − 1) / (m + p − 1) = 3 / 15 = <b>20%</b>." },
      { type: "mcq", prompt: "Why is TP = 16 across two 8-GPU nodes usually a bad idea?", options: [
        "TP cannot split attention heads",
        "Two all-reduces per layer would run over inter-node InfiniBand, roughly 10–20× slower than NVLink, on the critical path of every token",
        "PP is always faster than TP",
        "GPUs in different nodes cannot share weights"], answer: 1,
        explain: "TP puts a synchronizing collective inside every layer. Over NVLink that is cheap; over the network it dominates the step. Use TP within a node and PP/EP across nodes." },
      { type: "mcq", prompt: "With expert parallelism, a router sends 40% of tokens to one expert. What happens to step time?", options: [
        "Nothing; other experts compensate",
        "It drops, because fewer experts are active",
        "It grows: all GPUs wait for the overloaded expert's GPU before the combine all-to-all",
        "Only memory usage changes"], answer: 2,
        explain: "EP is synchronous per layer. Load imbalance turns directly into idle GPUs and longer steps, which is why routers use load-balancing losses and engines use redundant hot experts." },
    ],
  });
})();
