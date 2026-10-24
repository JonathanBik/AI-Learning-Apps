/* Module 2 — Serving & Batching Engines: Q2, Q6, Q7, Q8, Q9, Q10 */
(function () {
  "use strict";
  const { h, s, fmt } = LIA;

  /* ======================================================================
   * Q2 — Streaming (SSE) & cancellation propagation
   * ==================================================================== */
  LIA.register({
    id: "q2",
    module: 2,
    q: "Q2",
    title: "Streaming & Cancellation",
    lede: "Tokens leave the engine as Server-Sent Events. When the client hangs up, the abort has to travel all the way back to the scheduler, or the GPU keeps generating for nobody.",
    tags: [{ label: "SSE / HTTP/2", kind: "accent" }, { label: "KV leak", kind: "hbm" }],
    render(stage) {
      const MAX = 48, TPOT = 140, PROMPT = 512, BLOCK = 16;
      const words = "The KV cache grows by one entry per layer for every token we decode , so a stream that nobody reads still costs memory and compute until the scheduler hears about the disconnect and frees its blocks . Cancellation must propagate end to end".split(" ");
      let st;
      const reset = () => { st = { step: 0, disc: null, engineStop: null, done: false }; };
      reset();

      const mode = LIA.seg({ label: "Server behaviour", options: [{ value: "prop", label: "Propagate cancel" }, { value: "none", label: "Ignore disconnect" }], value: "prop", onChange: () => { reset(); draw(); } });
      const btnDisc = LIA.button("✂ Client disconnects", () => { if (st.disc == null && !st.done) { st.disc = st.step; draw(); } }, "danger");
      const btnRestart = LIA.button("↻ Restart stream", () => { reset(); draw(); });
      const stats = LIA.stats([
        { key: "deliv", label: "Tokens delivered", cls: "good" },
        { key: "waste", label: "Tokens generated for nobody", cls: "bad" },
        { key: "kv", label: "KV blocks held (16 tok/block)" },
        { key: "state", label: "Engine state" },
      ]);
      const vizBox = LIA.viz();
      const textBox = h("div", { class: "formula", style: { whiteSpace: "pre-wrap", minHeight: "3.4em" } });
      const wire = h("div", { class: "formula" });

      stage.append(
        LIA.controls(mode, h("div", { class: "ctl" }, h("label", null, h("span", null, "Actions")), h("div", { class: "row", style: { gap: "8px" } }, btnRestart, btnDisc))),
        vizBox,
        stats.el,
        h("div", { class: "cols-2" },
          h("div", null, h("div", { class: "caption" }, "What the browser has rendered"), textBox),
          h("div", null, h("div", { class: "caption" }, "Last frame on the wire (text/event-stream)"), wire))
      );

      const engineRunning = () => !st.done && (st.engineStop == null || st.step < st.engineStop);
      LIA.every(TPOT, () => {
        if (st.done) return;
        if (!engineRunning()) { st.done = true; draw(); return; }
        st.step++;
        if (st.disc != null && mode.value === "prop" && st.engineStop == null) {
          // server notices on its next write (1 step), abort reaches the scheduler at the next iteration (1 step)
          st.engineStop = st.disc + 2;
        }
        if (st.step >= MAX) st.done = true;
        draw();
      });

      function draw() {
        const W = 900, H = 250, x0 = 92, cw = (W - x0 - 12) / MAX;
        const svg = LIA.svg(W, H);
        const lanes = [["Client", 34, "browser"], ["API server", 104, "SSE writer"], ["Engine", 174, "GPU decode"]];
        lanes.forEach(([n, y, sub]) => {
          svg.appendChild(s("rect", { x: x0, y: y - 4, width: W - x0 - 12, height: 40, rx: 6, fill: "var(--surface-2)", stroke: "var(--line)" }));
          svg.appendChild(s("text", { x: 8, y: y + 14, "font-size": 13, "font-weight": 600, fill: "var(--ink)" }, n));
          svg.appendChild(s("text", { x: 8, y: y + 29, "font-size": 10.5, fill: "var(--muted)" }, sub));
        });
        let delivered = 0, wasted = 0;
        for (let i = 0; i < st.step; i++) {
          const x = x0 + i * cw + 1;
          const lost = st.disc != null && i >= st.disc;
          svg.appendChild(s("rect", { x, y: 174, width: cw - 2, height: 32, rx: 3, fill: lost ? "var(--bad)" : "var(--compute)", opacity: lost ? 0.85 : 0.9 }));
          if (!lost) {
            delivered++;
            svg.appendChild(s("rect", { x, y: 104, width: cw - 2, height: 32, rx: 3, fill: "var(--accent)", opacity: 0.8 }));
            svg.appendChild(s("rect", { x, y: 34, width: cw - 2, height: 32, rx: 3, fill: "var(--good)", opacity: 0.85 }));
            if (i === st.step - 1) {
              svg.appendChild(s("line", { x1: x + cw / 2, x2: x + cw / 2, y1: 172, y2: 68, stroke: "var(--accent)", "stroke-width": 2, "stroke-dasharray": "3 3" }));
            }
          } else {
            wasted++;
            if (i === st.disc) svg.appendChild(s("text", { x: x + cw / 2, y: 126, "text-anchor": "middle", "font-size": 14, "font-weight": 700, fill: "var(--bad)" }, "✗"));
          }
        }
        if (st.disc != null) {
          const xd = x0 + st.disc * cw;
          svg.appendChild(s("line", { x1: xd, x2: xd, y1: 22, y2: 212, stroke: "var(--bad)", "stroke-width": 2 }));
          svg.appendChild(s("text", { x: Math.min(xd + 4, W - 150), y: 18, "font-size": 11.5, fill: "var(--bad)", "font-weight": 600 }, "socket closed (FIN / RST_STREAM)"));
          if (st.engineStop != null) {
            const xs = x0 + st.engineStop * cw;
            svg.appendChild(s("path", { d: `M${xd + 4},120 C${xd + 20},150 ${xs - 20},150 ${xs},176`, fill: "none", stroke: "var(--good)", "stroke-width": 2, "marker-end": "" }));
            svg.appendChild(s("text", { x: Math.min(xs + 4, W - 170), y: 230, "font-size": 11.5, fill: "var(--good)", "font-weight": 600 }, "abort(request_id) → free KV"));
          } else if (mode.value === "none") {
            svg.appendChild(s("text", { x: W - 14, y: 230, "text-anchor": "end", "font-size": 11.5, fill: "var(--bad)", "font-weight": 600 }, "engine never told — decodes to max_tokens"));
          }
        }
        svg.appendChild(s("text", { x: x0, y: 244, "font-size": 10.5, fill: "var(--muted)" }, `one column = one decode step (TPOT ≈ ${TPOT} ms here, slowed for visibility) · max_tokens = ${MAX}`));
        LIA.clear(vizBox).appendChild(svg);

        const running = engineRunning() && !st.done;
        const kvBlocks = running || (!st.done && st.step < MAX) ? Math.ceil((PROMPT + st.step) / BLOCK) : 0;
        stats.set("deliv", String(delivered));
        stats.set("waste", String(wasted), wasted ? "bad" : "good");
        stats.set("kv", st.done ? "0 (freed)" : String(kvBlocks), st.disc != null && !st.done ? "warn" : "");
        stats.set("state", st.done ? (st.step >= MAX ? "finished" : "aborted ✓") : st.disc != null ? (mode.value === "prop" ? "aborting…" : "decoding for nobody") : "streaming", st.done && st.step < MAX ? "good" : st.disc != null ? "bad" : "accent");
        textBox.textContent = Array.from({ length: delivered }, (_, i) => words[i % words.length]).join(" ") + (st.disc == null && !st.done ? " ▍" : "");
        const last = Math.max(0, delivered - 1);
        wire.innerHTML = delivered
          ? `<span class="dim">id: ${last}</span>\n<span class="hl">data:</span> {"choices":[{"delta":{"content":" ${words[last % words.length]}"}}]}\n\n` + (st.done && st.step >= MAX && st.disc == null ? `<span class="hl">data:</span> [DONE]` : "")
          : `<span class="dim">HTTP/1.1 200 OK\ncontent-type: text/event-stream\ncache-control: no-cache</span>`;
      }
      draw();
    },
    insights: [
      { t: "SSE is just a long HTTP response.", d: "One <code>data: …\\n\\n</code> frame per token (or per few tokens). HTTP/2 multiplexes many streams on one TCP connection, so a closed tab shows up as <code>RST_STREAM</code>, not a closed socket." },
      { t: "Detection happens on write or poll.", d: "The ASGI layer raises on a failed send or delivers <code>http.disconnect</code>; servers also poll <code>await request.is_disconnected()</code> between tokens." },
      { t: "The abort must reach the scheduler.", d: "Call <code>engine.abort(request_id)</code> so the request leaves the running batch and its KV blocks return to the free pool at the next iteration." },
      { t: "Ignoring it is a capacity leak.", d: "Every orphaned stream keeps a batch slot and KV memory until EOS or <code>max_tokens</code>, which raises queueing delay for live users." },
    ],
    quiz: [
      { type: "mcq", prompt: "A user closes the tab mid-answer and the API server never forwards the cancellation. What does the engine do?", options: ["Stops immediately because TCP closed", "Keeps decoding the request to EOS or max_tokens, holding its batch slot and KV blocks", "Pauses the request and swaps its KV cache to CPU", "Returns an error to the other requests in the batch"], answer: 1, explain: "The engine only knows about request IDs in its scheduler. Without an explicit abort, it treats the request as live and keeps paying for it." },
      { type: "mcq", prompt: "Where does a Python ASGI SSE handler typically learn the client is gone?", options: ["From the GPU driver", "A failed send / an <code>http.disconnect</code> message, or polling <code>request.is_disconnected()</code>", "From the tokenizer", "Only after the response finishes"], answer: 1, explain: "The disconnect surfaces in the HTTP layer. The handler must then translate it into an engine-level abort." },
      { type: "num", prompt: "TPOT = 20 ms, max_tokens = 1000. A client disconnects after 100 tokens and cancellation is not propagated. How many seconds of decode does that request keep occupying?", answer: 18, tol: 0.02, unit: "s", explain: "900 orphaned tokens × 20 ms = 18 s of a batch slot plus its growing KV cache." },
    ],
  });

  /* ======================================================================
   * Q6 — Continuous (in-flight) batching
   * ==================================================================== */
  LIA.register({
    id: "q6",
    module: 2,
    q: "Q6",
    title: "Continuous Batching",
    lede: "Static batching waits for the longest answer in the batch. Continuous batching refills a slot the moment its request finishes, at every decode step.",
    tags: [{ label: "Scheduler", kind: "accent" }, { label: "Utilization", kind: "compute" }],
    render(stage) {
      let seed = 7;
      const slots = LIA.slider({ label: "Batch slots", min: 2, max: 8, value: 4, onInput: () => rebuild() });
      const nreq = LIA.slider({ label: "Requests in queue", min: 8, max: 32, value: 16, onInput: () => rebuild() });
      const spread = LIA.slider({ label: "Max output length (tokens)", min: 10, max: 80, value: 48, onInput: () => rebuild() });
      const regen = LIA.button("🎲 New lengths", () => { seed++; rebuild(); });
      const play = LIA.button("▶ Replay", () => { head = 0; });
      const stats = LIA.stats([
        { key: "ss", label: "Static: steps" },
        { key: "cs", label: "Continuous: steps" },
        { key: "su", label: "Static utilization", cls: "bad" },
        { key: "cu", label: "Continuous utilization", cls: "good" },
        { key: "sp", label: "Throughput gain", cls: "accent" },
      ]);
      const vizBox = LIA.viz();
      stage.append(LIA.controls(slots, nreq, spread, h("div", { class: "ctl" }, h("label", null, h("span", null, " ")), h("div", { class: "row", style: { gap: "8px" } }, regen, play))), vizBox, stats.el,
        LIA.caption('<span style="color:var(--compute)">■</span> useful token &nbsp; <span style="color:var(--accent)">■</span> prefill (request joins) &nbsp; <span style="color:var(--bad)">■</span> padding / idle slot = compute wasted'));

      let head = 0, overlays = [], X = null, total = 1;
      LIA.loop((dt) => {
        if (!overlays.length || head >= total) return;
        head = Math.min(total, head + dt * (LIA.reducedMotion ? 1e4 : 40));
        overlays.forEach((o) => { o.setAttribute("x", X(head)); o.setAttribute("width", Math.max(0, X(total) - X(head))); });
      });

      function rebuild() {
        const B = slots.value, N = nreq.value, L = spread.value;
        const r = LIA.rng(seed * 977 + 13);
        const lens = Array.from({ length: N }, () => 2 + Math.floor(r() * (L - 1)));
        // static: groups of B, batch runs max(len)
        const stat = [];
        let t = 0;
        for (let g = 0; g < N; g += B) {
          const grp = lens.slice(g, g + B);
          const bl = Math.max(...grp);
          for (let j = 0; j < B; j++) stat.push({ slot: j, start: t, len: grp[j] || 0, span: bl, id: g + j });
          t += bl;
        }
        const statSteps = t;
        // continuous: refill freed slots at the next step
        const free = new Array(B).fill(0), cont = [];
        lens.forEach((len, id) => {
          let j = 0;
          for (let k = 1; k < B; k++) if (free[k] < free[j]) j = k;
          cont.push({ slot: j, start: free[j], len, id });
          free[j] += len;
        });
        const contSteps = Math.max(...free);
        const useful = lens.reduce((a, b) => a + b, 0);
        total = statSteps;

        const W = 900, rowH = 16, gap = 46, x0 = 86;
        const blockH = B * rowH;
        const H = 30 + blockH * 2 + gap + 30;
        X = (v) => x0 + (v / statSteps) * (W - x0 - 10);
        const svg = LIA.svg(W, H);
        const drawBlock = (y0, items, steps, name, isStatic) => {
          svg.appendChild(s("text", { x: 4, y: y0 + blockH / 2 - 2, "font-size": 12.5, "font-weight": 600, fill: "var(--ink)" }, name));
          svg.appendChild(s("text", { x: 4, y: y0 + blockH / 2 + 13, "font-size": 10.5, fill: "var(--muted)" }, `${steps} steps`));
          svg.appendChild(s("rect", { x: x0, y: y0, width: X(steps) - x0, height: blockH, fill: "var(--bad)", opacity: 0.22 }));
          items.forEach((it) => {
            if (!it.len) return;
            const y = y0 + it.slot * rowH + 1;
            const op = it.id % 2 ? 0.62 : 0.95;
            svg.appendChild(s("rect", { x: X(it.start), y, width: X(it.start + it.len) - X(it.start) - 0.6, height: rowH - 2, fill: "var(--compute)", opacity: op }, s("title", null, `request #${it.id}: ${it.len} tokens`)));
            svg.appendChild(s("rect", { x: X(it.start), y, width: Math.max(1.5, X(it.start + 1) - X(it.start)), height: rowH - 2, fill: "var(--accent)" }));
            if (X(it.start + it.len) - X(it.start) > 22) svg.appendChild(s("text", { x: X(it.start) + 5, y: y + rowH - 5, "font-size": 9.5, fill: "var(--surface)", "font-weight": 600 }, "#" + it.id));
          });
          if (isStatic) {
            let b = 0;
            for (let g = 0; g < N; g += B) { const bl = Math.max(...lens.slice(g, g + B)); b += bl; svg.appendChild(s("line", { x1: X(b), x2: X(b), y1: y0 - 3, y2: y0 + blockH + 3, stroke: "var(--ink)", "stroke-width": 1.2 })); }
          }
          const ov = s("rect", { x: x0, y: y0 - 1, width: 0, height: blockH + 2, fill: "var(--surface)", opacity: 0.82 });
          svg.appendChild(ov);
          return ov;
        };
        const ovA = drawBlock(24, stat, statSteps, "Static", true);
        const ovB = drawBlock(24 + blockH + gap, cont, contSteps, "Continuous", false);
        svg.appendChild(s("text", { x: x0, y: 16, "font-size": 11, fill: "var(--muted)" }, "request-level: a batch is admitted together and retires together (│ = batch boundary)"));
        svg.appendChild(s("text", { x: x0, y: 24 + blockH + gap - 8, "font-size": 11, fill: "var(--muted)" }, "iteration-level: the scheduler re-forms the batch every step"));
        [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
          const v = Math.round(statSteps * f);
          svg.appendChild(s("text", { x: X(v), y: H - 8, "text-anchor": "middle", "font-size": 10.5, fill: "var(--muted)" }, v));
        });
        svg.appendChild(s("text", { x: W - 10, y: H - 20, "text-anchor": "end", "font-size": 10.5, fill: "var(--muted)" }, "decode step →"));
        overlays = [ovA, ovB];
        head = 0;
        LIA.clear(vizBox).appendChild(svg);
        const su = useful / (B * statSteps), cu = useful / (B * contSteps);
        stats.set("ss", String(statSteps));
        stats.set("cs", String(contSteps));
        stats.set("su", fmt.pct(su));
        stats.set("cu", fmt.pct(cu));
        stats.set("sp", fmt.num(statSteps / contSteps, 2) + "×");
      }
      rebuild();
    },
    insights: [
      { t: "Static batching pads to the longest request.", d: "Short answers finish and their slots sit idle (red) until the whole batch retires. Output lengths are long-tailed, so the waste is large." },
      { t: "Continuous batching schedules per iteration.", d: "After every forward pass the scheduler evicts finished sequences and admits waiting ones (Orca, vLLM, TGI, TensorRT-LLM in-flight batching)." },
      { t: "Same tokens, fewer steps.", d: "Both rows produce identical tokens. Continuous batching just packs them tighter, so throughput rises and queueing delay falls." },
      { t: "The new limit is KV memory.", d: "With slots always full, the batch is capped by free KV blocks. That is why it pairs with PagedAttention and preemption." },
    ],
    quiz: [
      { type: "num", prompt: "Static batch of 4 with output lengths 10, 20, 30 and 200 tokens. What fraction of slot-steps does useful work? (percent)", answer: 32.5, tol: 0.02, unit: "%", explain: "Useful = 260 tokens. Slot-steps = 4 × 200 = 800. 260 / 800 = 32.5%." },
      { type: "mcq", prompt: "At what granularity does a continuous-batching scheduler admit new requests?", options: ["Once per batch, after all requests finish", "Every decode iteration (forward pass)", "Every N seconds on a timer", "Only when the GPU is idle"], answer: 1, explain: "Iteration-level scheduling: the batch composition can change after every forward pass." },
      { type: "mcq", prompt: "Continuous batching keeps the slots full. What usually becomes the next limit on batch size?", options: ["Tokenizer speed", "KV cache memory, leading to preemption or swapping", "PCIe bandwidth", "Number of CUDA streams"], answer: 1, explain: "Each live sequence holds KV for its whole context. When free blocks run out, the scheduler must stop admitting, or preempt and recompute/swap." },
    ],
  });

  /* ======================================================================
   * Q7 — Chunked prefill
   * ==================================================================== */
  LIA.register({
    id: "q7",
    module: 2,
    q: "Q7",
    title: "Chunked Prefill",
    lede: "A 16k-token prompt processed in one step stalls every decoding user for hundreds of milliseconds. Splitting it into chunks trades a little TTFT for smooth TPOT.",
    tags: [{ label: "Scheduler", kind: "accent" }, { label: "TPOT spikes", kind: "bad" }, { label: "Prefill = compute", kind: "compute" }],
    render(stage) {
      const BASE = 7, PER = 0.03; // ms per step (weights read) and ms per prefill token (8B on 1×H100, linear model)
      const chunks = [256, 512, 1024, 2048, 4096, 8192];
      const prompt = LIA.slider({ label: "Long prompt length", min: 2048, max: 32768, step: 1024, value: 16384, fmt: (v) => fmt.num(v) + " tok", onInput: () => draw() });
      const chunk = LIA.seg({ label: "Chunk size (prefill tokens per step)", options: chunks.map((c) => ({ value: c, label: c >= 1024 ? c / 1024 + "k" : String(c) })), value: 1024, onChange: () => draw() });
      const dec = LIA.slider({ label: "Requests already decoding", min: 1, max: 64, value: 24, onInput: () => draw() });
      const stats = LIA.stats([
        { key: "a", label: "No chunking: worst TPOT", cls: "bad" },
        { key: "b", label: "Chunked: worst TPOT", cls: "good" },
        { key: "c", label: "No chunking: TTFT" },
        { key: "d", label: "Chunked: TTFT", cls: "warn" },
      ]);
      const vizBox = LIA.viz(), chartBox = LIA.viz();
      stage.append(LIA.controls(prompt, dec, chunk), vizBox, stats.el, LIA.formula(
        `step_time ≈ <span class="hbm">${BASE} ms</span> (read weights + KV, memory-bound) + <span class="cmp">${PER} ms × prefill_tokens</span> (compute-bound)\n<span class="dim">decoders emit exactly one token per step → TPOT = duration of the step they ride in</span>`),
        h("div", { class: "caption" }, "Trade-off across chunk sizes for the current prompt"), chartBox);

      function sim(P, C, D) {
        const steps = [];
        for (let i = 0; i < 4; i++) steps.push({ pre: 0, dur: BASE + PER * D });
        let left = P, ttft = 0, t = 0;
        steps.forEach((s) => (t += s.dur));
        const arrive = t;
        while (left > 0) {
          const c = Math.min(C, left);
          left -= c;
          const d = BASE + PER * (c + D);
          steps.push({ pre: c, dur: d });
          t += d;
        }
        ttft = t - arrive;
        for (let i = 0; i < 4; i++) { steps.push({ pre: 0, dur: BASE + PER * (D + 1) }); t += BASE + PER * (D + 1); }
        return { steps, ttft, total: t, arrive, worst: Math.max(...steps.map((s) => s.dur)) };
      }

      function draw() {
        const P = prompt.value, C = chunk.value, D = dec.value;
        const A = sim(P, P, D), B = sim(P, C, D);
        const W = 900, x0 = 104, rowY = [40, 128], rowH = 46;
        const tmax = Math.max(A.total, B.total);
        const X = (v) => x0 + (v / tmax) * (W - x0 - 12);
        const svg = LIA.svg(W, 214);
        [[A, "No chunking", rowY[0]], [B, `Chunk ${C >= 1024 ? C / 1024 + "k" : C}`, rowY[1]]].forEach(([r, name, y]) => {
          svg.appendChild(s("text", { x: 4, y: y + 20, "font-size": 12.5, "font-weight": 600, fill: "var(--ink)" }, name));
          svg.appendChild(s("text", { x: 4, y: y + 35, "font-size": 10.5, fill: "var(--muted)" }, `${r.steps.length} steps`));
          let t = 0;
          r.steps.forEach((st) => {
            const dw = X(t + BASE + PER * D) - X(t), w = X(t + st.dur) - X(t);
            svg.appendChild(s("rect", { x: X(t), y, width: Math.max(0.8, w - 0.8), height: rowH, rx: 2, fill: "var(--hbm)", opacity: 0.75 }, s("title", null, `step ${fmt.num(st.dur, 1)} ms, prefill ${st.pre} tok`)));
            if (st.pre) svg.appendChild(s("rect", { x: X(t) + dw, y: y + 4, width: Math.max(0, w - dw - 1.2), height: rowH - 8, rx: 2, fill: "var(--compute)" }));
            // decoders' token ticks at the end of each step
            svg.appendChild(s("line", { x1: X(t + st.dur), x2: X(t + st.dur), y1: y - 6, y2: y, stroke: "var(--good)", "stroke-width": 1.4 }));
            t += st.dur;
          });
          const xa = X(r.arrive), xe = X(r.arrive + r.ttft);
          svg.appendChild(s("path", { d: `M${xa},${y + rowH + 6}v6H${xe}v-6`, fill: "none", stroke: "var(--accent)", "stroke-width": 1.5 }));
          svg.appendChild(s("text", { x: (xa + xe) / 2, y: y + rowH + 24, "text-anchor": "middle", "font-size": 11, fill: "var(--accent)", "font-weight": 600 }, `TTFT ${fmt.ms(r.ttft)}`));
          const wi = r.steps.reduce((bi, st, i, arr) => (st.dur > arr[bi].dur ? i : bi), 0);
          let tw = 0; for (let i = 0; i < wi; i++) tw += r.steps[i].dur;
          svg.appendChild(s("text", { x: Math.min(X(tw + r.steps[wi].dur / 2), W - 80), y: y - 9, "text-anchor": "middle", "font-size": 11, fill: r === A ? "var(--bad)" : "var(--good)", "font-weight": 600 }, `gap ${fmt.ms(r.steps[wi].dur)}`));
        });
        svg.appendChild(s("text", { x: x0, y: 12, "font-size": 10.5, fill: "var(--muted)" }, "│ green tick = every decoding user gets a token · width = wall-clock time"));
        LIA.clear(vizBox).appendChild(svg);

        stats.set("a", fmt.ms(A.worst));
        stats.set("b", fmt.ms(B.worst));
        stats.set("c", fmt.ms(A.ttft));
        stats.set("d", fmt.ms(B.ttft) + ` (+${fmt.pct(B.ttft / A.ttft - 1)})`);

        const pts = [], ptsT = [];
        for (let c = 128; c <= 32768; c *= 1.25) { const r = sim(P, Math.min(c, P), D); pts.push([c, r.worst]); ptsT.push([c, r.ttft]); }
        LIA.clear(chartBox).appendChild(LIA.lineChart({
          width: 900, height: 260,
          x: { min: 128, max: 32768, log: true, label: "chunk size (tokens, log)", ticks: [128, 512, 2048, 8192, 32768], fmt: (v) => (v >= 1024 ? v / 1024 + "k" : v) },
          y: { min: 5, max: 2000, log: true, label: "ms (log)", ticks: [10, 100, 1000], fmt: (v) => fmt.si(v) },
          series: [{ points: pts, color: "var(--bad)", label: "worst TPOT of decoders" }, { points: ptsT, color: "var(--accent)", label: "TTFT of long prompt", dash: "6 4" }],
          markers: [{ x: C, y: B.worst, color: "var(--bad)", label: fmt.ms(B.worst) }, { x: C, y: B.ttft, color: "var(--accent)", label: fmt.ms(B.ttft) }],
          vlines: [{ x: C, label: "selected", color: "var(--muted)" }],
        }));
      }
      draw();
    },
    insights: [
      { t: "Prefill is one giant matmul.", d: "Thousands of prompt tokens go through every layer at once. It is compute-bound and its duration scales with prompt length." },
      { t: "Everyone shares the step.", d: "In a continuous batch, decoders only advance when the step ends. One unchunked 16k prefill becomes a half-second TPOT spike for every user." },
      { t: "Chunking caps the step.", d: "Limit prefill tokens per step (vLLM <code>max_num_batched_tokens</code>). Each step mixes a chunk with the decodes, which also uses idle compute during memory-bound decode." },
      { t: "Smaller chunks raise TTFT.", d: "Each chunk re-reads weights and the growing KV, so the long prompt takes more, slightly slower steps. Pick the chunk size from your TPOT SLO." },
    ],
    quiz: [
      { type: "num", prompt: "With the model above (7 ms per step + 0.03 ms per prefill token) and ignoring decode tokens, how long is the step when an 8,192-token prompt is prefilled unchunked? (ms)", answer: 252.76, tol: 0.02, unit: "ms", explain: "7 + 0.03 × 8192 = 7 + 245.76 ≈ 253 ms. Every decoding user waits that long for their next token." },
      { type: "mcq", prompt: "You halve the chunk size. What happens?", options: ["Both TTFT and TPOT improve", "Worst-case TPOT drops; TTFT of the long prompt rises slightly", "TPOT rises; TTFT drops", "Nothing; chunk size only affects memory"], answer: 1, explain: "Smaller steps mean shorter stalls for decoders, but the prompt needs more steps, each paying the fixed weight-read cost." },
      { type: "mcq", prompt: "Besides smoothing TPOT, why does mixing a prefill chunk into decode steps raise GPU efficiency?", options: ["It reduces the KV cache size", "Decode is memory-bound and leaves tensor cores idle; the prefill chunk uses that spare compute while weights are already being read", "It avoids tokenization", "It enables FP8 automatically"], answer: 1, explain: "This is the piggybacking idea from Sarathi-Serve: the same weight read serves both the decodes and the chunk's matmuls." },
    ],
  });

  /* ======================================================================
   * Q8 — Prefix caching (radix tree) & cache-aware routing
   * ==================================================================== */
  const PRESET = [
    "You are Acme support . Be concise . Cite the docs . User : How do I reset my password ?",
    "You are Acme support . Be concise . Cite the docs . User : How do I change my email ?",
    "You are Acme support . Be concise . Cite the docs . User : How do I delete my account ?",
    "You are Acme support . Be concise . Cite the docs . User : Cancel my plan",
    "You are a strict code reviewer . Output JSON . Diff : fix null check in parser",
    "You are a strict code reviewer . Output JSON . Diff : add retry to client",
    "Translate to French : good morning",
  ].join("\n");

  function radixBuild(prompts) {
    const root = { tokens: [], children: new Map(), count: 0 };
    let total = 0, hit = 0;
    const perPrompt = [];
    prompts.forEach((toks) => {
      total += toks.length;
      let node = root, i = 0, matched = 0;
      while (i < toks.length) {
        let child = node.children.get(toks[i]);
        if (!child) { node.children.set(toks[i], { tokens: toks.slice(i), children: new Map(), count: 1 }); break; }
        let j = 0;
        while (j < child.tokens.length && i + j < toks.length && child.tokens[j] === toks[i + j]) j++;
        if (j < child.tokens.length) {
          const mid = { tokens: child.tokens.slice(0, j), children: new Map(), count: child.count };
          child.tokens = child.tokens.slice(j);
          mid.children.set(child.tokens[0], child);
          node.children.set(mid.tokens[0], mid);
          child = mid;
        }
        matched += j; i += j; child.count++; node = child;
      }
      hit += matched;
      perPrompt.push({ len: toks.length, matched });
    });
    return { root, total, hit, perPrompt };
  }

  function strHash(str) {
    let x = 2166136261;
    for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
    // murmur3 finalizer so near-identical keys spread around the ring
    x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
    return x >>> 0;
  }

  LIA.register({
    id: "q8",
    module: 2,
    q: "Q8",
    title: "Prefix Caching & Routing",
    lede: "Requests that share a system prompt can reuse its KV blocks. A radix tree finds the longest cached prefix, and the router decides whether the request lands where that cache lives.",
    tags: [{ label: "RadixAttention", kind: "sram" }, { label: "Routing", kind: "accent" }],
    render(stage) {
      /* ---- part A: radix tree ---- */
      const ta = h("textarea", { id: "q8-prompts", rows: 7, spellcheck: "false" });
      ta.value = PRESET;
      const statsA = LIA.stats([
        { key: "tot", label: "Prompt tokens" },
        { key: "hit", label: "Served from cache", cls: "good" },
        { key: "rate", label: "Prefix hit rate", cls: "accent" },
        { key: "nodes", label: "Tree nodes" },
      ]);
      const treeBox = LIA.viz();
      const barsBox = LIA.viz();
      let tmr = null;
      ta.addEventListener("input", () => { clearTimeout(tmr); tmr = setTimeout(drawTree, 200); });
      LIA.onCleanup(() => clearTimeout(tmr));

      function drawTree() {
        const prompts = ta.value.split("\n").map((l) => l.trim().split(/\s+/).filter(Boolean)).filter((t) => t.length);
        const R = radixBuild(prompts);
        // layout
        const nodes = [];
        let leafY = 0;
        const COLW = 210, ROWH = 40;
        (function lay(n, depth) {
          const kids = [...n.children.values()];
          let y;
          if (!kids.length) y = leafY++;
          else { const ys = kids.map((k) => lay(k, depth + 1)); y = (ys[0] + ys[ys.length - 1]) / 2; }
          nodes.push({ n, depth, y });
          n._y = y; n._d = depth;
          return y;
        })(R.root, 0);
        const maxD = Math.max(...nodes.map((x) => x.depth));
        const W = Math.max(600, 70 + maxD * COLW + 30), H = Math.max(1, leafY) * ROWH + 20;
        const svg = LIA.svg(W, H);
        const P = (n) => [n._d === 0 ? 30 : 70 + (n._d - 1) * COLW, 10 + n._y * ROWH + ROWH / 2];
        nodes.forEach(({ n }) => n.children.forEach((c) => {
          const [x1, y1] = P(n), [x2, y2] = P(c);
          svg.appendChild(s("path", { d: `M${x1 + (n._d === 0 ? 12 : COLW - 22)},${y1} C${x2 - 18},${y1} ${x2 - 18},${y2} ${x2},${y2}`, fill: "none", stroke: "var(--line)", "stroke-width": 1.6 }));
        }));
        nodes.forEach(({ n }) => {
          const [x, y] = P(n);
          if (n._d === 0) {
            svg.appendChild(s("circle", { cx: x, cy: y, r: 11, fill: "var(--ink)" }));
            svg.appendChild(s("text", { x, y: y + 4, "text-anchor": "middle", "font-size": 9, fill: "var(--surface)" }, "root"));
            return;
          }
          const shared = n.count > 1;
          let label = n.tokens.join(" ");
          if (label.length > 24) label = label.slice(0, 23) + "…";
          svg.appendChild(s("rect", { x, y: y - 14, width: COLW - 22, height: 28, rx: 6, fill: shared ? "var(--sram-soft)" : "var(--hbm-soft)", stroke: shared ? "var(--sram)" : "var(--hbm)", "stroke-width": 1.4 }, s("title", null, n.tokens.join(" "))));
          svg.appendChild(s("text", { x: x + 7, y: y + 4, "font-size": 10.5, fill: "var(--ink)" }, label));
          svg.appendChild(s("text", { x: x + COLW - 26, y: y - 17, "text-anchor": "end", "font-size": 9.5, fill: shared ? "var(--sram)" : "var(--hbm)", "font-weight": 600 }, `${n.tokens.length} tok${shared ? " · ×" + n.count : ""}`));
        });
        LIA.clear(treeBox).appendChild(svg);
        statsA.set("tot", String(R.total));
        statsA.set("hit", String(R.hit));
        statsA.set("rate", fmt.pct(R.total ? R.hit / R.total : 0));
        statsA.set("nodes", String(nodes.length - 1));
        LIA.clear(barsBox).appendChild(LIA.hbar({
          width: 900, rowH: 22, labelW: 90, valW: 110,
          max: Math.max(...R.perPrompt.map((p) => p.len), 1),
          rows: R.perPrompt.map((p, i) => ({ label: `prompt ${i + 1}`, segs: [{ value: p.matched, color: "var(--sram)", label: "cached" }, { value: p.len - p.matched, color: "var(--hbm)", label: "prefill" }], note: `${p.matched}/${p.len} cached` })),
        }));
      }

      /* ---- part B: routing ---- */
      const reps = LIA.slider({ label: "Replicas", min: 2, max: 16, value: 8, onInput: () => drawRoute() });
      const groups = LIA.slider({ label: "Distinct system prompts", min: 4, max: 200, value: 60, onInput: () => drawRoute() });
      const cap = LIA.slider({ label: "Prefixes cached per replica (LRU)", min: 2, max: 60, value: 12, onInput: () => drawRoute() });
      const routeBox = LIA.viz(), loadBox = LIA.viz();
      const statsB = LIA.stats([
        { key: "rr", label: "Round-robin hit rate", cls: "bad" },
        { key: "ch", label: "Prefix-hash hit rate", cls: "good" },
        { key: "imb", label: "Hash: busiest replica vs mean", cls: "warn" },
      ]);

      function drawRoute() {
        const Rn = reps.value, G = groups.value, K = cap.value, N = 4000;
        const rand = LIA.rng(99);
        // Zipf(1.0) popularity over groups
        const w = Array.from({ length: G }, (_, i) => 1 / (i + 1));
        const tw = w.reduce((a, b) => a + b, 0);
        const cdf = []; let acc = 0; w.forEach((x) => cdf.push((acc += x / tw)));
        const pick = () => { const u = rand(); let lo = 0, hi = G - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; } return lo; };
        const reqs = Array.from({ length: N }, pick);
        // consistent hash ring with 64 virtual nodes per replica
        const ring = [];
        for (let r = 0; r < Rn; r++) for (let v = 0; v < 64; v++) ring.push([strHash(`replica-${r}#${v}`), r]);
        ring.sort((a, b) => a[0] - b[0]);
        const owner = (g) => { const hv = strHash("sys-prompt-" + g); for (const [k, r] of ring) if (k >= hv) return r; return ring[0][1]; };
        const run = (route) => {
          const caches = Array.from({ length: Rn }, () => new Map()), load = new Array(Rn).fill(0);
          let hits = 0;
          reqs.forEach((g, i) => {
            const r = route(g, i), c = caches[r];
            load[r]++;
            if (c.has(g)) { hits++; c.delete(g); }
            c.set(g, 1);
            if (c.size > K) c.delete(c.keys().next().value);
          });
          return { rate: hits / N, load };
        };
        const rr = run((g, i) => i % Rn), ch = run((g) => owner(g));
        LIA.clear(routeBox).appendChild(LIA.hbar({
          width: 900, labelW: 150, max: 1, fmt: (v) => fmt.pct(v),
          rows: [{ label: "Round-robin", value: rr.rate, color: "var(--hbm)" }, { label: "Prefix-hash ring", value: ch.rate, color: "var(--sram)" }],
        }));
        const mean = N / Rn;
        LIA.clear(loadBox).appendChild(LIA.hbar({
          width: 900, rowH: 18, labelW: 150, max: Math.max(...ch.load, mean) * 1.05, fmt: (v) => fmt.num(v),
          refs: [{ value: mean, label: "mean load", color: "var(--muted)" }],
          rows: ch.load.map((l, i) => ({ label: `replica ${i}`, value: l, color: l > mean * 1.5 ? "var(--bad)" : "var(--accent)" })),
        }));
        statsB.set("rr", fmt.pct(rr.rate));
        statsB.set("ch", fmt.pct(ch.rate));
        statsB.set("imb", fmt.num(Math.max(...ch.load) / mean, 2) + "×");
      }

      stage.append(
        h("div", { class: "caption" }, "Edit the prompts (one per line, tokens split on spaces). They are inserted top to bottom; each one reuses the longest prefix already in the tree."),
        ta, treeBox,
        LIA.caption('<span style="color:var(--sram)">■</span> node shared by ≥2 prompts (KV reused) &nbsp; <span style="color:var(--hbm)">■</span> unique suffix (must be prefilled)'),
        statsA.el, barsBox,
        h("div", { class: "panel-title", style: { marginTop: "10px" } }, "Cache-aware routing across replicas · 4,000 requests, Zipf-popular system prompts"),
        LIA.controls(reps, groups, cap), routeBox, statsB.el,
        h("div", { class: "caption" }, "Load per replica under prefix-hash routing: popular prefixes pile onto their owner"), loadBox
      );
      drawTree();
      drawRoute();
    },
    insights: [
      { t: "KV for a prefix depends only on the prefix.", d: "Causal attention means tokens 0…n produce the same K/V whatever follows. Shared system prompts, few-shot examples and chat history can be computed once." },
      { t: "Radix tree = longest-prefix match.", d: "SGLang's RadixAttention stores KV blocks on tree edges, matches new prompts in O(prefix length), and evicts leaves by LRU. vLLM hashes full blocks along the chain for the same effect." },
      { t: "Round-robin spreads each prefix everywhere.", d: "With R replicas, every replica must warm every hot prefix, so caches thrash. Hashing the prefix to a replica gives each prefix one home." },
      { t: "Pure affinity causes hotspots.", d: "One viral system prompt can overload its owner. Production routers use bounded-load consistent hashing or spill to the least-loaded replica past a queue threshold." },
    ],
    quiz: [
      { type: "num", prompt: "A 2,000-token system prompt is followed by a 200-token user message. Best-case prefix hit rate for the second such request? (percent)", answer: 90.91, tol: 0.01, unit: "%", explain: "2000 / 2200 ≈ 90.9% of the prompt's KV is reused; only 200 tokens need prefill." },
      { type: "mcq", prompt: "Why does round-robin load balancing lower the prefix-cache hit rate as you add replicas?", options: ["Replicas use different tokenizers", "Requests sharing a prefix land on different replicas, so each replica must compute and hold every hot prefix", "Round-robin disables the KV cache", "It increases the block size"], answer: 1, explain: "Cache capacity is per replica. Spreading one prefix across R replicas multiplies misses and memory use by up to R." },
      { type: "mcq", prompt: "What is the main risk of routing purely by prefix hash?", options: ["Lower hit rate than random", "Load imbalance: a hot prefix overloads one replica", "It cannot handle streaming", "It breaks continuous batching"], answer: 1, explain: "Affinity concentrates popular prefixes. Bounded-load hashing or queue-aware spillover fixes it." },
    ],
  });

  /* ======================================================================
   * Q9 — TTFT vs TPOT, batch size and the roofline
   * ==================================================================== */
  const Q9_CFG = {
    "8b": { name: "Llama-3 8B · 1×H100", P: 8e9, kv: 2 * 32 * 8 * 128 * 2, gpus: 1 },
    "70b": { name: "Llama-3 70B · 4×H100 (TP4)", P: 70e9, kv: 2 * 80 * 8 * 128 * 2, gpus: 4 },
  };
  LIA.register({
    id: "q9",
    module: 2,
    q: "Q9",
    title: "TTFT vs TPOT",
    lede: "Batching more users is almost free while decode is memory-bound, then each extra user slows everyone. Find the batch size where throughput is high and TPOT still meets the SLO.",
    tags: [{ label: "Roofline", kind: "compute" }, { label: "Bandwidth", kind: "hbm" }, { label: "SLOs", kind: "accent" }],
    render(stage) {
      const BW = 3.35e12 * 0.8, PEAK = 989e12 * 0.5, OVH = 1.5e-3, HBM = 80e9;
      const model = LIA.seg({ label: "Deployment (FP16 weights)", options: [{ value: "8b", label: "8B · 1×H100" }, { value: "70b", label: "70B · 4×H100" }], value: "8b", onChange: () => draw() });
      const batch = LIA.slider({ label: "Batch size (concurrent decodes)", min: 0, max: 10, step: 0.1, value: 5, fmt: (v) => String(Math.round(Math.pow(2, v))), onInput: () => draw() });
      const ctx = LIA.slider({ label: "Avg context per sequence", min: 512, max: 16384, step: 512, value: 2048, fmt: (v) => fmt.num(v) + " tok", onInput: () => draw() });
      const slo = LIA.slider({ label: "TPOT SLO", min: 10, max: 100, step: 5, value: 40, fmt: (v) => v + " ms", onInput: () => draw() });
      const prompt = LIA.slider({ label: "New prompt length (for TTFT)", min: 256, max: 8192, step: 256, value: 2048, fmt: (v) => fmt.num(v) + " tok", onInput: () => draw() });
      const stats = LIA.stats([
        { key: "tpot", label: "TPOT (step time)" },
        { key: "user", label: "Per-user speed" },
        { key: "thr", label: "Total throughput", cls: "accent" },
        { key: "bound", label: "Bottleneck" },
        { key: "ttft", label: "TTFT (prefill only, no queue)" },
        { key: "mem", label: "KV memory used" },
      ]);
      const c1 = LIA.viz(), c2 = LIA.viz();
      const formula = h("div");
      stage.append(LIA.controls(model, batch, ctx, slo, prompt), stats.el, h("div", { class: "cols-2" }, h("div", null, h("div", { class: "caption" }, "Decode step time vs batch: memory term vs compute term"), c1), h("div", null, h("div", { class: "caption" }, "The serving trade-off curve: each point is a batch size"), c2)), formula);

      function model_(cfg, B, L) {
        const bw = BW * cfg.gpus, pk = PEAK * cfg.gpus;
        const mem = (2 * cfg.P + B * L * cfg.kv) / bw;
        const cmp = (2 * cfg.P * B) / pk;
        return { mem, cmp, t: Math.max(mem, cmp) + OVH };
      }
      function draw() {
        const cfg = Q9_CFG[model.value];
        const B = Math.round(Math.pow(2, batch.value)), L = ctx.value;
        const m = model_(cfg, B, L);
        const kvCap = cfg.gpus * HBM * 0.9 - 2 * cfg.P;
        const maxB = Math.max(1, Math.floor(kvCap / (L * cfg.kv)));
        const ttft = (2 * cfg.P * prompt.value) / (PEAK * cfg.gpus) + OVH;
        const memUsed = B * L * cfg.kv;
        const fits = B <= maxB;
        stats.set("tpot", fmt.ms(m.t * 1000, 1), m.t * 1000 <= slo.value ? "good" : "bad");
        stats.set("user", fmt.num(1 / m.t, 0) + " tok/s");
        stats.set("thr", fmt.num(B / m.t, 0) + " tok/s");
        stats.set("bound", m.mem >= m.cmp ? "memory BW" : "compute", m.mem >= m.cmp ? "" : "warn");
        stats.set("ttft", fmt.ms(ttft * 1000, 0));
        stats.set("mem", fits ? fmt.bytes(memUsed) + ` / ${fmt.bytes(kvCap)}` : "does not fit ✗", fits ? "" : "bad");

        const xs = []; for (let e = 0; e <= 10.001; e += 0.1) xs.push(Math.pow(2, e));
        const pm = xs.map((b) => [b, model_(cfg, b, L).mem * 1000]);
        const pc = xs.map((b) => [b, model_(cfg, b, L).cmp * 1000]);
        const pt = xs.map((b) => [b, model_(cfg, b, L).t * 1000]);
        const ymax = Math.max(...pt.map((p) => p[1]));
        LIA.clear(c1).appendChild(LIA.lineChart({
          width: 460, height: 280, margin: { l: 50 },
          x: { min: 1, max: 1024, log: true, label: "batch size (log)", ticks: [1, 4, 16, 64, 256, 1024], fmt: (v) => String(v) },
          y: { min: 0.1, max: Math.max(100, ymax), log: true, label: "ms", ticks: [0.1, 1, 10, 100, 1000].filter((v) => v <= Math.max(100, ymax)), fmt: (v) => fmt.si(v) },
          series: [{ points: pm, color: "var(--hbm)", label: "bytes/BW" }, { points: pc, color: "var(--compute)", label: "FLOPs/peak" }, { points: pt, color: "var(--ink)", label: "step", dash: "5 3" }],
          hlines: [{ y: slo.value, label: "SLO", color: "var(--bad)" }],
          vlines: maxB < 1024 ? [{ x: maxB, label: "KV full", color: "var(--bad)" }] : [],
          markers: [{ x: B, y: m.t * 1000, color: fits ? "var(--accent)" : "var(--bad)" }],
        }));
        const curve = xs.filter((b) => b <= Math.max(maxB, 1)).map((b) => { const t = model_(cfg, b, L).t; return [b / t, 1 / t]; });
        const xMax = Math.max(...xs.map((b) => b / model_(cfg, b, L).t));
        LIA.clear(c2).appendChild(LIA.lineChart({
          width: 460, height: 280, margin: { l: 50 },
          x: { min: 0, max: xMax * 1.05, label: "total throughput (tok/s)" },
          y: { min: 0, max: (1 / model_(cfg, 1, L).t) * 1.1, label: "per-user tok/s" },
          series: [{ points: curve, color: "var(--accent)", area: true }],
          hlines: [{ y: 1000 / slo.value, label: `SLO ${slo.value} ms`, color: "var(--bad)" }],
          markers: [{ x: B / m.t, y: 1 / m.t, color: fits ? "var(--accent)" : "var(--bad)", label: `B=${B}` }],
          legend: false,
        }));
        formula.innerHTML = "";
        formula.appendChild(LIA.formula(
          `TPOT ≈ max( <span class="hbm">(2·P + B·ctx·kv_bytes) / BW</span> , <span class="cmp">2·P·B / FLOPS</span> ) + overhead\n` +
          `     = max( <span class="hbm">${fmt.ms(m.mem * 1000, 2)}</span> , <span class="cmp">${fmt.ms(m.cmp * 1000, 2)}</span> ) + 1.5 ms   <span class="dim">(${cfg.name}; 80% of HBM BW, 50% of dense BF16 peak)</span>\n` +
          `TTFT ≈ queue + <span class="cmp">2·P·prompt / FLOPS</span> = queue + ${fmt.ms(ttft * 1000, 0)}`));
      }
      draw();
    },
    insights: [
      { t: "Decode reads all weights per step.", d: "At batch 1 an 8B FP16 model moves 16 GB per token: about 5 ms on an H100 whatever you do. Adding users reuses the same read." },
      { t: "The knee is the ridge point.", d: "Past the batch where FLOPs/peak exceeds bytes/BW, decode turns compute-bound and TPOT grows linearly with batch." },
      { t: "Long contexts move the bottleneck to KV.", d: "KV reads grow with batch × context, so TPOT rises even below the compute knee, and the KV-capacity wall arrives sooner." },
      { t: "TTFT is mostly queue + prefill.", d: "Prefill is compute-bound. Under load TTFT is dominated by waiting for a slot and by sharing steps with decodes (see Q7, Q22)." },
    ],
    quiz: [
      { type: "num", prompt: "An 8B model in FP16 runs on one H100 (3.35 TB/s). Ignoring KV, overhead and efficiency, what is the lowest possible TPOT at batch 1? (ms)", answer: 4.78, tol: 0.03, unit: "ms", explain: "16 GB / 3.35 TB/s ≈ 4.78 ms. That is a hard floor for a memory-bound decode." },
      { type: "mcq", prompt: "In the memory-bound regime, you raise the batch from 1 to 32. What happens?", options: ["TPOT rises ~32×, throughput flat", "Throughput rises ~32× while TPOT barely changes", "Both fall", "TTFT drops to zero"], answer: 1, explain: "The weight read is shared by all sequences, so extra users ride almost free until KV reads or compute catch up." },
      { type: "mcq", prompt: "Your p95 TTFT violates its SLO at high load, while TPOT is fine. Which lever targets TTFT most directly?", options: ["Increase max batch size", "Prioritise prefill / add prefill capacity (or disaggregate prefill), and cap queue depth", "Use a larger draft model", "Lower max_tokens"], answer: 1, explain: "TTFT under load is queueing plus prefill. Giving prefill more capacity or priority attacks it; bigger decode batches usually make it worse." },
    ],
  });

  /* ======================================================================
   * Q10 — Speculative decoding
   * ==================================================================== */
  LIA.register({
    id: "q10",
    module: 2,
    q: "Q10",
    title: "Speculative Decoding",
    lede: "A small draft model guesses k tokens; the big model checks all of them in one memory-bound pass. Every accepted guess is a token you didn't pay a full step for.",
    tags: [{ label: "Draft + verify", kind: "compute" }, { label: "Acceptance α", kind: "good" }],
    render(stage) {
      const alpha = LIA.slider({ label: "Acceptance rate α", min: 0.3, max: 0.95, step: 0.01, value: 0.75, fmt: (v) => v.toFixed(2), onInput: () => refresh() });
      const kS = LIA.slider({ label: "Draft length k", min: 1, max: 10, value: 4, onInput: () => refresh() });
      const cS = LIA.slider({ label: "Draft cost c (vs target step)", min: 0.01, max: 0.5, step: 0.01, value: 0.05, fmt: (v) => v.toFixed(2), onInput: () => refresh() });
      const playBtn = LIA.button("⏸ Pause", () => { paused = !paused; playBtn.textContent = paused ? "▶ Play" : "⏸ Pause"; });
      const stats = LIA.stats([
        { key: "E", label: "Expected tokens / target pass", cls: "accent" },
        { key: "emp", label: "Measured (this run)" },
        { key: "sp", label: "Wall-clock speedup" },
        { key: "opt", label: "Best k for this α, c" },
      ]);
      const animBox = LIA.viz(), chartBox = LIA.viz(), formula = h("div");
      stage.append(LIA.controls(alpha, kS, cS, h("div", { class: "ctl" }, h("label", null, h("span", null, "Animation")), playBtn)), animBox,
        LIA.caption('<span style="color:var(--compute)">■</span> drafted &nbsp; <span style="color:var(--good)">■</span> accepted by target &nbsp; <span style="color:var(--bad)">■</span> first rejection (target substitutes its own token) &nbsp; <span style="color:var(--muted)">■</span> discarded &nbsp; <span style="color:var(--accent)">■</span> bonus token when all k pass'),
        stats.el, formula, chartBox);

      let paused = false, rounds = [], gen = 0, passes = 0;
      const rand = LIA.rng(2024);
      const E = (a, k) => (Math.abs(1 - a) < 1e-9 ? k + 1 : (1 - Math.pow(a, k + 1)) / (1 - a));
      const speed = (a, k, c) => E(a, k) / (k * c + 1);

      function oneRound() {
        const k = kS.value, a = alpha.value;
        const res = [];
        let rejected = false;
        for (let i = 0; i < k; i++) {
          if (rejected) res.push("x");
          else if (rand() < a) res.push("ok");
          else { res.push("rej"); rejected = true; }
        }
        if (!rejected) res.push("bonus");
        const produced = res.filter((r) => r === "ok" || r === "rej" || r === "bonus").length;
        gen += produced; passes++;
        rounds.unshift({ res, produced });
        rounds = rounds.slice(0, 6);
      }
      function drawAnim() {
        const W = 900, rowH = 34, x0 = 130, bw = 52;
        const svg = LIA.svg(W, 20 + 6 * rowH);
        svg.appendChild(s("text", { x: 4, y: 13, "font-size": 11, fill: "var(--muted)" }, "newest round on top"));
        rounds.forEach((r, i) => {
          const y = 20 + i * rowH;
          svg.appendChild(s("text", { x: 4, y: y + 20, "font-size": 11.5, fill: "var(--ink)", opacity: 1 - i * 0.12 }, `pass ${passes - i}: +${r.produced} tok`));
          r.res.forEach((c, j) => {
            const col = { ok: "var(--good)", rej: "var(--bad)", x: "var(--line)", bonus: "var(--accent)" }[c];
            svg.appendChild(s("rect", { x: x0 + j * (bw + 6), y: y + 3, width: bw, height: rowH - 8, rx: 5, fill: col, opacity: 1 - i * 0.12 }));
            svg.appendChild(s("text", { x: x0 + j * (bw + 6) + bw / 2, y: y + 21, "text-anchor": "middle", "font-size": 11, "font-weight": 600, fill: c === "x" ? "var(--muted)" : "var(--surface)", opacity: 1 - i * 0.12 }, c === "ok" ? `d${j + 1} ✓` : c === "rej" ? `t${j + 1}` : c === "x" ? `d${j + 1}` : "+1"));
          });
        });
        LIA.clear(animBox).appendChild(svg);
        stats.set("emp", passes ? fmt.num(gen / passes, 2) + ` (${passes} passes)` : "–");
      }
      function refresh() {
        const a = alpha.value, k = kS.value, c = cS.value;
        rounds = []; gen = 0; passes = 0;
        drawAnim();
        const sp = speed(a, k, c);
        let bestK = 1; for (let kk = 1; kk <= 10; kk++) if (speed(a, kk, c) > speed(a, bestK, c)) bestK = kk;
        stats.set("E", fmt.num(E(a, k), 2));
        stats.set("sp", fmt.num(sp, 2) + "×", sp >= 1 ? "good" : "bad");
        stats.set("opt", `k = ${bestK} → ${fmt.num(speed(a, bestK, c), 2)}×`);
        formula.innerHTML = "";
        formula.appendChild(LIA.formula(
          `E[tokens / pass] = (1 − α^(k+1)) / (1 − α) = (1 − ${a.toFixed(2)}^${k + 1}) / ${(1 - a).toFixed(2)} = <span class="hl">${E(a, k).toFixed(2)}</span>\n` +
          `speedup        = E / (k·c + 1)          = ${E(a, k).toFixed(2)} / ${(k * c + 1).toFixed(2)}        = <span class="${sp >= 1 ? "sram" : "hbm"}">${sp.toFixed(2)}×</span>\n` +
          `<span class="dim">assumes verifying k+1 positions costs one target step (true while decode is memory-bound)</span>`));
        const series = [0.5, 0.7, 0.9].map((aa, i) => ({ points: Array.from({ length: 10 }, (_, j) => [j + 1, speed(aa, j + 1, c)]), color: ["var(--hbm)", "var(--compute)", "var(--sram)"][i], label: `α=${aa}`, dash: "4 3", width: 1.5 }));
        series.push({ points: Array.from({ length: 10 }, (_, j) => [j + 1, speed(a, j + 1, c)]), color: "var(--accent)", label: `α=${a.toFixed(2)} (yours)`, width: 3 });
        LIA.clear(chartBox).appendChild(LIA.lineChart({
          width: 900, height: 260,
          x: { min: 1, max: 10, label: "draft length k", ticks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], fmt: (v) => String(v) },
          y: { min: 0, max: Math.max(2, ...series.flatMap((sr) => sr.points.map((p) => p[1]))) * 1.1, label: "speedup ×", fmt: (v) => v.toFixed(1) },
          series,
          hlines: [{ y: 1, label: "break-even", color: "var(--bad)" }],
          markers: [{ x: k, y: sp, color: "var(--accent)", label: sp.toFixed(2) + "×" }],
        }));
      }
      LIA.every(LIA.reducedMotion ? 2500 : 900, () => { if (!paused) { oneRound(); drawAnim(); } });
      refresh();
    },
    insights: [
      { t: "Verification is nearly free.", d: "Decode is memory-bound, so scoring k+1 positions in one target pass costs about the same as generating one token." },
      { t: "Output is unchanged.", d: "Rejection sampling (accept with min(1, p/q), else resample from the residual) keeps the target model's exact distribution." },
      { t: "α decides everything.", d: "Expected tokens per pass saturate at 1/(1−α). Low α or an expensive draft pushes the speedup below 1×." },
      { t: "It fades at large batch.", d: "Big batches are already compute-bound, so the extra k positions are no longer free. Spec decoding helps most for low-latency, low-batch traffic." },
    ],
    quiz: [
      { type: "num", prompt: "α = 0.8 and k = 4. Expected tokens generated per target forward pass?", answer: 3.36, tol: 0.01, unit: "tok", explain: "(1 − 0.8⁵) / (1 − 0.8) = (1 − 0.32768) / 0.2 = 3.36." },
      { type: "mcq", prompt: "Why can the target verify k drafted tokens in roughly the time of one normal decode step?", options: ["It skips attention", "Decode is memory-bandwidth-bound: the weights are read once and the extra k positions use idle compute", "The draft model shares its KV cache", "Verification runs on the CPU"], answer: 1, explain: "At small batch the step time is set by streaming weights from HBM; a few more positions barely change it." },
      { type: "mcq", prompt: "In which situation is speculative decoding most likely to slow you down?", options: ["Batch 1 chat with a well-matched draft", "Very large batches (compute-bound) with low acceptance rate", "Code completion with repetitive text", "Greedy decoding with α = 0.9"], answer: 1, explain: "When the GPU is already compute-bound, verifying k extra positions costs real FLOPs, and low α wastes most of them." },
    ],
  });
})();
