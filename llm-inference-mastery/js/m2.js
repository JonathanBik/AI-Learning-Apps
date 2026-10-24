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
  /* ======================================================================
   * Worked examples: the shared mocked request (LIA.MOCK) through each mechanism.
   * Attached after registration so each topic object stays readable above.
   * ==================================================================== */
  const tk = (t, id, extra) => Object.assign({ t, id }, extra || {});
  const esc = (x) => LIA.esc(x);
  const KVB = () => LIA.MOCK.model.kvBytesPerToken;
  /** plain HTML table using the matrix styling: rows = [[cell,...]], cells may be {v, cls, bg} */
  function table(head, rows, caption) {
    return h("div", { class: "mat-wrap" }, h("table", { class: "mat" },
      caption ? h("caption", null, caption) : null,
      h("thead", null, h("tr", null, head.map((c) => h("th", null, c)))),
      h("tbody", null, rows.map((r) => h("tr", null, r.map((c) => {
        const o = typeof c === "object" && c !== null && !(c instanceof Node) ? c : { v: c };
        return h("td", { style: { background: o.bg || null, color: o.color || null, fontWeight: o.bold ? 600 : null, textAlign: o.left ? "left" : null, whiteSpace: "pre" } }, o.v instanceof Node ? o.v : String(o.v));
      }))))));
  }
  const stack = (...kids) => h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 } }, kids);
  const cap = (html) => LIA.caption(html);

  /* ---------- Q2: streaming + cancellation ---------- */
  LIA.topics.q2.trace = (M) => {
    const frame = (i, extra) => {
      const delta = i === 0 ? { role: "assistant", content: M.output[0].t } : { content: M.output[i].t };
      return `<span class="dim">data:</span> ${esc(JSON.stringify({ id: M.id, choices: [{ index: 0, delta, ...(extra || {}) }] }))}`;
    };
    const kvHeld = M.prompt.length + 3; // prompt + outputs 1..3 already fed back; token 4 not yet processed
    const blocks = Math.ceil(kvHeld / 16);
    const blockSvg = (freed) => {
      const sv = LIA.svg(360, 70, { "aria-label": "KV blocks" });
      for (let b = 0; b < 2; b++) {
        const x = 10 + b * 150;
        sv.appendChild(s("rect", { x, y: 10, width: 140, height: 34, rx: 5, fill: freed ? "var(--surface)" : "var(--hbm-soft)", stroke: freed ? "var(--line)" : "var(--hbm)", "stroke-dasharray": freed ? "4 3" : null }));
        const used = Math.min(16, kvHeld - b * 16);
        for (let i = 0; i < 16; i++) sv.appendChild(s("rect", { x: x + 4 + i * 8.25, y: 18, width: 6.5, height: 18, rx: 1.5, fill: freed ? "var(--surface-2)" : i < used ? "var(--hbm)" : "var(--surface-2)" }));
        sv.appendChild(s("text", { x: x + 70, y: 60, "text-anchor": "middle", "font-size": 11, fill: "var(--muted)" }, freed ? `block #${[42, 17][b]} → free list` : `block #${[42, 17][b]} · ${used}/16 tokens`));
      }
      return sv;
    };
    return [
      { k: "Client request", op: "POST /v1/chat/completions", where: "browser → API gateway", inLabel: "User types", input: h("div", { class: "trace-note" }, M.user), outLabel: "HTTP body (stream: true)", output: LIA.blob(esc(JSON.stringify(M.request, null, 2))), note: "<code>stream: true</code> asks for Server-Sent Events: one HTTP response that stays open and carries one event per token." },
      { k: "Template + tokenize", op: "chat template → BPE", where: "API server (CPU)", input: LIA.blob(esc(JSON.stringify(M.request.messages, null, 1))), output: stack(LIA.tokens(M.prompt), cap(`<b>${M.prompt.length} tokens</b>. Violet = special tokens added by the template.`)), note: "The engine never sees JSON, only these 28 integers, tagged with request id <code>" + M.id + "</code>." },
      { k: "Prefill → token 1", op: "forward(28 tok) + sample", where: "engine (GPU)", input: LIA.tokens(M.prompt, { cls: () => "dim" }), outLabel: "First SSE frame on the wire", output: stack(LIA.tokens(M.output.slice(0, 1), { cls: () => "out" }), LIA.blob(frame(0) + "\n\n")), note: "Headers <code>Content-Type: text/event-stream</code> went out with this first frame; TTFT ends when it reaches the client." },
      { k: "Stream tokens 2–4", op: "decode × 3", where: "engine → API → client", input: LIA.tokens(M.output, { cls: (t, i) => (i < 1 ? "out" : "dim") }), outLabel: "Frames, one per token", output: stack(LIA.tokens(M.output, { cls: (t, i) => (i < 4 ? "out" : "dim") }), LIA.blob([1, 2, 3].map((i) => frame(i)).join("\n\n"))), note: "Each frame is flushed immediately; the client renders <i>“The capital of France”</i>." },
      { k: "Client disconnects", op: "tab closed → TCP FIN", where: "client ✕", input: LIA.kv([["delivered", "4 of 8 tokens"], ["HTTP/1.1", "socket closes, next write fails"], ["HTTP/2", "RST_STREAM (CANCEL) on stream 1"]]), outLabel: "API server notices", output: LIA.blob(`<span class="dim"># FastAPI / Starlette</span>\nif await request.is_disconnected():\n    await engine.abort(<span class="hl">"${M.id}"</span>)`), note: "Detection is the easy half. The hard half is forwarding it to the engine, which only knows request ids." },
      { k: "Abort propagates", op: "engine.abort(id)", where: "scheduler, next iteration", inLabel: "Planned tokens", input: LIA.tokens(M.output, { cls: (t, i) => (i < 4 ? "out" : "hl") }), outLabel: "Actually generated", output: stack(LIA.tokens(M.output, { cls: (t, i) => (i < 4 ? "out" : "bad") }), cap("Struck-through tokens are never computed. Without the abort the engine would decode to <code>&lt;|eot_id|&gt;</code> here, and up to <code>max_tokens</code> = 64 for a longer answer.")), note: "The request leaves the running batch at the next step boundary, so at most one extra token is wasted." },
      { k: "KV blocks freed", op: "free(block_table)", where: "block manager", input: stack(blockSvg(false), LIA.kv([["KV tokens held", `${M.prompt.length} prompt + 3 output = ${kvHeld}`], ["bytes", `${kvHeld} × ${fmt.num(KVB())} B = ${fmt.bytes(kvHeld * KVB())}`]])), output: stack(blockSvg(true), cap(`${blocks} blocks (16 tokens each) return to the free pool and can be admitted to a waiting request immediately.`)), note: "Token 4 was sampled but never fed back, so its K/V were never written. Only 31 positions occupy cache." },
    ];
  };

  /* ---------- Q6: continuous batching ---------- */
  LIA.topics.q6.trace = (M) => {
    const reqs = [
      { n: "A · ours", len: 8, hue: "var(--accent)" },
      { n: "B (mocked)", len: 3, hue: "var(--compute)" },
      { n: "C (mocked)", len: 12, hue: "var(--sram)" },
      { n: "D (mocked)", len: 5, hue: "var(--hbm)" },
    ];
    const E = { n: "E (queued)", len: 4, hue: "var(--good)" };
    const COLS = 16;
    // slot timelines: arrays of {req, from, to}
    const plans = {
      static: [[{ r: reqs[0], s: 1 }, { r: E, s: 13 }], [{ r: reqs[1], s: 1 }], [{ r: reqs[2], s: 1 }], [{ r: reqs[3], s: 1 }]],
      continuous: [[{ r: reqs[0], s: 1 }], [{ r: reqs[1], s: 1 }, { r: E, s: 4 }], [{ r: reqs[2], s: 1 }], [{ r: reqs[3], s: 1 }]],
    };
    function grid(mode, upto) {
      const cell = 24, lx = 92, W = lx + COLS * cell + 10, H = 26 + 4 * cell + 6;
      const sv = LIA.svg(W, H, { "aria-label": mode + " batch grid" });
      for (let c = 0; c < COLS; c++) sv.appendChild(s("text", { x: lx + c * cell + cell / 2 - 1, y: 14, "text-anchor": "middle", "font-size": 9.5, fill: c + 1 === upto ? "var(--accent)" : "var(--muted)" }, c + 1));
      plans[mode].forEach((slot, si) => {
        const y = 22 + si * cell;
        const names = slot.filter((x) => x.s <= Math.max(upto, 1)).map((x) => x.r.n.split(" ")[0]).join(" → ");
        sv.appendChild(s("text", { x: 4, y: y + 15, "font-size": 10.5, fill: "var(--ink)" }, `slot ${si + 1}: ${names}`));
        for (let c = 1; c <= COLS; c++) {
          const x = lx + (c - 1) * cell;
          let fill = "var(--surface-2)", op = 1, label = null;
          const seg = slot.find((x2) => c >= x2.s && c < x2.s + x2.r.len);
          const batchEnd = mode === "static" ? (c <= 12 ? 12 : 16) : null;
          if (c <= upto) {
            if (seg) { fill = seg.r.hue; op = 0.85; if (seg.r === reqs[0]) label = c - seg.s; }
            else if (mode === "static" && c <= batchEnd && !(c > 12 && si > 0)) { fill = "var(--bad)"; op = 0.22; }
          }
          sv.appendChild(s("rect", { x: x + 1, y, width: cell - 3, height: cell - 4, rx: 3, fill, opacity: op }));
          if (label != null) sv.appendChild(s("text", { x: x + cell / 2 - 0.5, y: y + 14, "text-anchor": "middle", "font-size": 8.5, fill: "var(--surface)" }, LIA.showTok(M.output[label].t).replace("␣", "").slice(0, 3)));
        }
      });
      return sv;
    }
    const both = (upto) => stack(h("div", { class: "caption" }, "Static (request-level)"), LIA.viz(grid("static", upto)), h("div", { class: "caption" }, "Continuous (iteration-level)"), LIA.viz(grid("continuous", upto)));
    const ours = (n) => LIA.tokens(M.output, { cls: (t, i) => (i < n ? "out" : "dim") });
    return [
      { k: "The queue", op: "admit 4 slots", where: "scheduler, t = 0", inLabel: "Waiting requests (output lengths mocked)", input: table(["request", "output tokens"], [...reqs, E].map((r) => [{ v: r.n, left: true }, r.len])), outLabel: "Batch of 4 slots", output: both(0), note: "Our request A will emit 8 tokens. E arrives a moment too late for the first batch." },
      { k: "Steps 1–3", op: "decode × 3", where: "every slot emits 1 token/step", input: both(0), output: stack(both(3), ours(3)), note: "All four slots are busy. B emits its 3rd and final token at step 3." },
      { k: "Step 4: B is done", op: "refill or pad?", where: "the key decision", input: both(3), output: both(4), note: "Static batching keeps B's slot as padding (red) until the whole batch ends. Continuous batching admits E into the freed slot at the very next step." },
      { k: "Step 8: A finishes", op: "emit <|eot_id|>", where: "our request completes", input: both(7), output: stack(both(8), ours(8)), note: "Same 8 steps in both modes for A. Its slot now idles (static) or is free for the next arrival (continuous)." },
      { k: "Steps 9–16", op: "drain", where: "C is the long pole", input: both(8), output: both(16), note: "Static must finish C (12 tokens) before E can even start, so E runs alone in steps 13–16 with 3 empty slots." },
      { k: "Scorecard", op: "count slot-steps", where: "same 32 useful tokens", input: table(["", "static", "continuous"], [["steps to drain", 16, 12], ["useful slot-steps", "32 / 64", "32 / 48"], ["utilization", { v: "50%", color: "var(--bad)" }, { v: "67%", color: "var(--good)" }], ["E finishes at step", 16, 7]]), output: stack(h("div", { class: "stat good" }, h("span", { class: "k" }, "E's latency"), h("span", { class: "v" }, "16 → 7 steps")), cap("With a steady stream of arrivals, continuous batching keeps every slot busy, and utilization approaches 100%.")), note: "The scheduler re-decides batch membership every iteration, not every request. That is the whole trick." },
    ];
  };

  /* ---------- Q7: chunked prefill ---------- */
  LIA.topics.q7.trace = (M) => {
    const BASE = 7, PER = 0.03, BUDGET = 2048, X = 8000, P = M.prompt.length; // mocked cost model: 8B on 1×H100
    const ms = (pf) => BASE + PER * pf;
    // chunked schedule: decodes first, then our (short) prefill, then chunk of X
    const steps = [];
    let remX = X, oursDecoding = false, oursTok = 0;
    for (let i = 0; remX > 0; i++) {
      const dec = 3 + (oursDecoding ? 1 : 0);
      let budget = BUDGET - dec, oursPf = 0;
      if (!oursDecoding) { oursPf = P; budget -= P; }
      const xc = Math.min(remX, budget);
      remX -= xc;
      steps.push({ dec, oursPf, xc, t: ms(oursPf + xc), oursTok: oursDecoding || oursPf ? ++oursTok : 0 });
      oursDecoding = true;
    }
    let acc = 0; steps.forEach((st) => { acc += st.t; st.end = acc; });
    const tUn1 = ms(X), tUn2 = ms(P);
    function bar(segs, total = BUDGET) {
      const W = 380, sv = LIA.svg(W, 46, { "aria-label": "Step token budget" });
      let x = 6;
      segs.forEach((sg) => { const w = Math.max(2, (sg.v / total) * (W - 12)); sv.appendChild(s("rect", { x, y: 6, width: w, height: 20, fill: sg.c, rx: 2 })); if (w > 40) sv.appendChild(s("text", { x: x + w / 2, y: 20, "text-anchor": "middle", "font-size": 10, fill: "var(--surface)" }, sg.l)); x += w; });
      sv.appendChild(s("text", { x: 6, y: 42, "font-size": 10, fill: "var(--muted)" }, `${fmt.num(segs.reduce((a, b) => a + b.v, 0))} / ${fmt.num(total)} token budget`));
      return sv;
    }
    function timeline(mode) {
      const W = 380, sv = LIA.svg(W, 74, { "aria-label": mode + " timeline" });
      const sc = (W - 12) / 280;
      const items = mode === "un" ? [{ t: tUn1, c: "var(--compute)", l: `X prefill ${fmt.num(tUn1, 0)} ms` }, { t: tUn2, c: "var(--accent)", l: "" }] : steps.map((st) => ({ t: st.t, c: "var(--compute)", l: `${fmt.num(st.t, 0)} ms` }));
      let x = 6;
      items.forEach((it) => { const w = it.t * sc; sv.appendChild(s("rect", { x, y: 8, width: Math.max(2, w - 2), height: 22, rx: 3, fill: it.c, opacity: 0.8 })); if (w > 50) sv.appendChild(s("text", { x: x + w / 2, y: 23, "text-anchor": "middle", "font-size": 10, fill: "var(--surface)" }, it.l)); x += w; });
      const ttft = mode === "un" ? tUn1 + tUn2 : steps[0].t;
      sv.appendChild(s("line", { x1: 6 + ttft * sc, x2: 6 + ttft * sc, y1: 4, y2: 44, stroke: "var(--accent)", "stroke-width": 2 }));
      sv.appendChild(s("text", { x: Math.min(W - 4, 6 + ttft * sc + 4), y: 56, "text-anchor": ttft * sc > W / 2 ? "end" : "start", "font-size": 10.5, fill: "var(--accent)" }, `our first token “${M.output[0].t}” @ ${fmt.num(ttft, 1)} ms`));
      sv.appendChild(s("text", { x: 6, y: 70, "font-size": 10, fill: "var(--muted)" }, "0 ms … 280 ms"));
      return sv;
    }
    return [
      { k: "Arrivals", op: "enqueue", where: "t = 0", inLabel: "Waiting (FCFS)", input: table(["request", "prompt", "state"], [[{ v: "X (mocked doc)", left: true }, "8,000", "waiting"], [{ v: "ours", left: true, bold: true }, P, "waiting"], [{ v: "D1–D3 (mocked)", left: true }, "–", "decoding"]]), outLabel: "Cost model (mocked, 8B on 1×H100)", output: LIA.formula(`step_ms = ${BASE} + ${PER} × prefill_tokens\nbudget  = ${fmt.num(BUDGET)} tokens / step`), note: "A huge document prompt landed just before our 28-token question, while three other users are mid-answer." },
      { k: "No chunking: X", op: "prefill 8,000 tok", where: "one giant step", input: bar([{ v: X, c: "var(--compute)", l: "X 8,000 (over budget!)" }], X), output: stack(timeline("un"), LIA.kv([["step time", `${BASE} + ${PER} × 8,000 = ${fmt.num(tUn1, 0)} ms`], ["D1–D3", `stalled ${fmt.num(tUn1, 0)} ms (TPOT spike)`]])), note: "Everyone waits for one 247 ms step: the decoders' next token and our tiny prompt." },
      { k: "No chunking: ours", op: "prefill 28 tok", where: "next step", input: LIA.tokens(M.prompt, { ids: false, cls: () => "hl", max: 12 }), output: LIA.kv([["step time", `${BASE} + ${PER} × ${P} = ${fmt.num(tUn2, 2)} ms`], ["our TTFT", `${fmt.num(tUn1, 0)} + ${fmt.num(tUn2, 2)} = ${fmt.num(tUn1 + tUn2, 1)} ms`]]), note: "Head-of-line blocking: 97% of our TTFT is someone else's prefill." },
      { k: "Chunked: pack step 1", op: "fill 2,048-token budget", where: "decodes first, then prefills", input: table(["piece", "tokens"], [["D1–D3 decode", 3], [{ v: "ours (whole prompt)", bold: true }, P], ["X chunk 1", fmt.num(steps[0].xc)]]), output: stack(bar([{ v: 3, c: "var(--hbm)", l: "" }, { v: P, c: "var(--accent)", l: "" }, { v: steps[0].xc, c: "var(--compute)", l: `X ${fmt.num(steps[0].xc)}` }]), LIA.kv([["step time", `${BASE} + ${PER} × ${fmt.num(P + steps[0].xc)} = ${fmt.num(steps[0].t, 1)} ms`], ["our first token", `“${M.output[0].t}” at ${fmt.num(steps[0].t, 1)} ms`]])), note: "Our whole prompt fits beside the decodes, so we get a token in the very first step." },
      { k: "Chunked: steps 2–4", op: "stream X in chunks", where: "ours now decoding", input: table(["step", "decode", "X chunk", "X left", "ms"], steps.map((st, i) => [i + 1, st.dec, fmt.num(st.xc), fmt.num(X - steps.slice(0, i + 1).reduce((a, b) => a + b.xc, 0)), fmt.num(st.t, 1)])), output: stack(timeline("ch"), LIA.tokens(M.output, { cls: (t, i) => (i < steps.length ? "out" : "dim") }), cap(`Ours emits “${M.output.slice(0, steps.length).map((t) => t.t).join("")}” while X is still prefilling.`)), note: "Each chunk attends to the KV of earlier chunks, so the result is identical to one big prefill." },
      { k: "Scorecard", op: "compare", where: "same work, different order", input: table(["metric", "unchunked", "chunked"], [["our TTFT", fmt.num(tUn1 + tUn2, 1) + " ms", { v: fmt.num(steps[0].t, 1) + " ms", color: "var(--good)" }], ["worst decoder TPOT", fmt.num(tUn1, 0) + " ms", { v: fmt.num(Math.max(...steps.map((x) => x.t)), 1) + " ms", color: "var(--good)" }], ["X's TTFT", fmt.num(tUn1, 0) + " ms", { v: fmt.num(steps[steps.length - 1].end, 1) + " ms", color: "var(--warn)" }]]), output: cap("Chunking trades a little of the long prompt's TTFT (extra per-step overhead) for bounded TPOT and fast TTFT for everyone else."), note: "Smaller chunks cap TPOT harder but add more fixed overhead per step." },
    ];
  };

  /* ---------- Q8: prefix caching + cache-aware routing ---------- */
  LIA.topics.q8.trace = (M) => {
    const B = 16;
    const fnv = (parent, ids) => { let x = parent >>> 0 || 0x811c9dc5; for (const id of ids) { x ^= id; x = Math.imul(x, 0x01000193) >>> 0; x ^= id >>> 8; x = Math.imul(x, 0x01000193) >>> 0; } return x >>> 0; };
    const hex = (x) => "0x" + x.toString(16).padStart(8, "0");
    const ids = M.prompt.map((t) => t.id);
    const h0 = fnv(0, ids.slice(0, B));
    const r2 = M.prompt.slice(0, 21).concat([tk(" Japan", 6457), tk("?", 30), ...M.prompt.slice(23)]);
    const same = (i) => r2[i].id === M.prompt[i].id;
    let common = 0; while (common < r2.length && same(common)) common++;
    const replicas = 4;
    const repOf = (x) => x % replicas;
    function tree() {
      const sv = LIA.svg(380, 170, { "aria-label": "Radix tree" });
      const node = (x, y, w, label, sub, fill) => { sv.appendChild(s("rect", { x, y, width: w, height: 34, rx: 6, fill, stroke: "var(--line)" })); sv.appendChild(s("text", { x: x + 6, y: y + 14, "font-size": 10.5, fill: "var(--ink)" }, label)); sv.appendChild(s("text", { x: x + 6, y: y + 28, "font-size": 9.5, fill: "var(--muted)" }, sub)); };
      const edge = (x1, y1, x2, y2) => sv.appendChild(s("path", { d: `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`, fill: "none", stroke: "var(--muted)" }));
      sv.appendChild(s("circle", { cx: 190, cy: 10, r: 5, fill: "var(--muted)" }));
      edge(190, 15, 190, 26);
      node(70, 26, 240, "system prompt + user header", "16 tokens · shared", "var(--sram-soft)");
      edge(190, 60, 190, 72);
      node(110, 72, 160, "“What is the capital of”", "5 tokens · shared", "var(--sram-soft)");
      edge(160, 106, 90, 124); edge(220, 106, 290, 124);
      node(10, 124, 160, "“ France?” + asst hdr", "7 tokens · ours", "var(--accent-soft)");
      node(210, 124, 160, "“ Japan?” + asst hdr", "7 tokens · request 2", "var(--hbm-soft)");
      return sv;
    }
    function route(mode) {
      const sv = LIA.svg(380, 120, { "aria-label": "Routing" });
      for (let r = 0; r < replicas; r++) {
        const x = 12 + r * 92;
        const hot = r === repOf(h0);
        sv.appendChild(s("rect", { x, y: 70, width: 80, height: 36, rx: 6, fill: hot ? "var(--sram-soft)" : "var(--surface-2)", stroke: hot ? "var(--sram)" : "var(--line)" }));
        sv.appendChild(s("text", { x: x + 40, y: 86, "text-anchor": "middle", "font-size": 11, fill: "var(--ink)" }, `replica ${r}`));
        sv.appendChild(s("text", { x: x + 40, y: 100, "text-anchor": "middle", "font-size": 9.5, fill: "var(--muted)" }, hot ? "has prefix" : "cold"));
      }
      const target1 = repOf(h0), target2 = mode === "rr" ? (target1 + 1) % replicas : target1;
      [[target1, "ours", 110], [target2, "req 2", 270]].forEach(([r, l, sx], i) => {
        const tx = 52 + r * 92;
        sv.appendChild(s("text", { x: sx, y: 14, "text-anchor": "middle", "font-size": 11, fill: i ? "var(--hbm)" : "var(--accent)" }, l));
        sv.appendChild(s("line", { x1: sx, y1: 20, x2: tx, y2: 66, stroke: i ? "var(--hbm)" : "var(--accent)", "stroke-width": 2 }));
      });
      sv.appendChild(s("text", { x: 190, y: 50, "text-anchor": "middle", "font-size": 11, "font-weight": 600, fill: mode === "rr" ? "var(--bad)" : "var(--good)" }, mode === "rr" ? "round-robin: req 2 lands cold → full prefill" : `hash(block 0) mod 4 = ${repOf(h0)} → cache hit`));
      return sv;
    }
    return [
      { k: "Split into blocks", op: "chunk by 16 tokens", where: "block manager", input: LIA.tokens(M.prompt), output: stack(LIA.tokens(M.prompt, { cls: (t, i) => (i < B ? "hl" : "out") }), cap(`Block 0 = tokens 0–15 (full). Block 1 = tokens 16–27 (${M.prompt.length - B}/16, partial).`)), note: "Only full blocks get a hash and become shareable. Our block 0 is exactly the system prompt plus the user header." },
      { k: "Hash chain", op: "h = hash(parent, ids)", where: "toy FNV-1a hash", input: LIA.kv([["block 0 ids", ids.slice(0, B).join(", ")]]), output: LIA.kv([["hash(block 0)", hex(h0)], ["hash(block 1)", "— not full yet; hashed once 16 tokens exist"], ["cache table", `${hex(h0)} → physical block #42`]]), note: "Including the parent hash means a block only matches if everything before it matches too." },
      { k: "Request 2 arrives", op: "tokenize + hash", where: "same system prompt (mocked)", inLabel: "Request 2: “…capital of Japan?”", input: LIA.tokens(r2, { cls: (t, i) => (same(i) ? "" : "hl") }), output: LIA.kv([["hash(block 0)", hex(fnv(0, r2.slice(0, B).map((t) => t.id))) + " ✓ same"], ["first differing token", `#${common}: “${LIA.showTok(r2[common].t)}” vs “${LIA.showTok(M.prompt[common].t)}”`]]), note: "Request 2 matches ours token-for-token up to “of”, then diverges." },
      { k: "Block-level hit (vLLM)", op: "lookup hash table", where: "full blocks only", input: LIA.tokens(r2, { ids: false, cls: (t, i) => (i < B ? "hit" : "hl") }), output: LIA.kv([["reused", `${B} tokens (block 0) → ${fmt.bytes(B * KVB(), 2)} of KV`], ["recomputed", `${r2.length - B} tokens`], ["hit rate", fmt.pct(B / r2.length)]]), note: "Tokens 16–20 also match, but they sit in a block that differs later, so block hashing can't reuse them." },
      { k: "Token-level hit (radix tree)", op: "walk the radix tree", where: "SGLang RadixAttention", input: tree(), output: stack(LIA.tokens(r2, { ids: false, cls: (t, i) => (i < common ? "hit" : "hl") }), LIA.kv([["reused", `${common} tokens`], ["recomputed", `${r2.length - common} tokens`], ["hit rate", fmt.pct(common / r2.length)]])), note: "Edges hold token runs; a new request walks down as far as it matches, so the hit can end mid-block." },
      { k: "Cache-aware routing", op: "route by prefix hash", where: "load balancer, 4 replicas", input: route("rr"), output: route("hash"), note: "A cache only helps if the request reaches the replica holding it. Hashing the first block sends every user of this system prompt to the same replica." },
    ];
  };

  /* ---------- Q9: TTFT and TPOT for our request ---------- */
  LIA.topics.q9.trace = (M) => {
    const cfg = { P: 70e9, gpus: 4 }, kv = M.model.kvBytesPerToken;
    const BW = 3.35e12 * 0.8 * cfg.gpus, PEAK = 989e12 * 0.5 * cfg.gpus, OVH = 1.5;
    const P = M.prompt.length, CTX = 2048;
    const pfMem = (2 * cfg.P) / BW * 1000, pfCmp = (2 * cfg.P * P) / PEAK * 1000;
    const ttft = Math.max(pfMem, pfCmp) + OVH;
    const ridge = PEAK / BW;
    const step = (B) => {
      const kvBytes = (B - 1) * CTX * kv + (P + 4) * kv;
      const mem = (2 * cfg.P + kvBytes) / BW * 1000, cmp = (2 * cfg.P * B) / PEAK * 1000;
      return { kvBytes, mem, cmp, t: Math.max(mem, cmp) + OVH };
    };
    const s33 = step(33), s200 = step(200);
    const kvCap = cfg.gpus * 80e9 * 0.9 - 2 * cfg.P;
    const maxB = Math.floor(kvCap / (CTX * kv));
    const times = [ttft]; for (let i = 1; i < M.output.length; i++) times.push(times[i - 1] + s33.t);
    function tl() {
      const W = 380, sv = LIA.svg(W, 70, { "aria-label": "Token timestamps" });
      const sc = (W - 20) / (times[times.length - 1] * 1.05);
      sv.appendChild(s("line", { x1: 8, x2: W - 8, y1: 30, y2: 30, stroke: "var(--line)" }));
      times.forEach((t, i) => {
        const x = 8 + t * sc;
        sv.appendChild(s("circle", { cx: x, cy: 30, r: 5, fill: i ? "var(--hbm)" : "var(--accent)" }));
        sv.appendChild(s("text", { x, y: i % 2 ? 52 : 18, "text-anchor": "middle", "font-size": 9.5, fill: "var(--ink)" }, LIA.showTok(M.output[i].t).replace("<|eot_id|>", "eot")));
      });
      sv.appendChild(s("text", { x: 8, y: 67, "font-size": 10, fill: "var(--muted)" }, `0 → ${fmt.num(times[times.length - 1], 1)} ms`));
      return sv;
    };
    return [
      { k: "Setup", op: "Llama-3 70B · 4×H100", where: "same model as the lab (70B option)", input: LIA.tokens(M.prompt, { ids: false, max: 14 }), outLabel: "Effective hardware", output: LIA.kv([["HBM BW (80%)", fmt.num(BW / 1e12, 2) + " TB/s"], ["peak (50% dense BF16)", fmt.num(PEAK / 1e15, 3) + " PFLOP/s"], ["weights", "140 GB (FP16)"], ["overhead / step", OVH + " ms"]]), note: "Our prompt is 28 tokens. Assume it is admitted immediately (no queue)." },
      { k: "Prefill → TTFT", op: "max(bytes/BW, FLOPs/peak)", where: "28 tokens in one pass", input: LIA.kv([["bytes", "140 GB weights"], ["FLOPs", `2 × 70e9 × ${P} = ${fmt.si(2 * cfg.P * P, 2)}`]]), output: stack(LIA.formula(`mem  = 140e9 / ${fmt.num(BW / 1e12, 2)}e12 = <span class="hbm">${fmt.num(pfMem, 2)} ms</span>\ncomp = ${fmt.si(2 * cfg.P * P, 2)} / ${fmt.num(PEAK / 1e15, 3)}e15 = <span class="cmp">${fmt.num(pfCmp, 2)} ms</span>\nTTFT = ${fmt.num(Math.max(pfMem, pfCmp), 2)} + ${OVH} = <b>${fmt.num(ttft, 2)} ms</b>`)), note: "A 28-token prefill is memory-bound: the GPU must read every weight once no matter how short the prompt is." },
      { k: "Ridge point", op: "where prefill flips", where: "peak / BW", input: LIA.formula(`N* = ${fmt.num(PEAK / 1e15, 3)}e15 / ${fmt.num(BW / 1e12, 2)}e12`), output: LIA.kv([["N*", `≈ ${fmt.num(ridge, 0)} prompt tokens`], ["ours", `${P} tokens → memory-bound`], ["a 2,048-token prompt", `→ compute-bound, ${fmt.num((2 * cfg.P * 2048) / PEAK * 1000 + OVH, 1)} ms`]]), note: "Below about 185 tokens, prefill costs the same as one decode step's weight read." },
      { k: "Join a batch of 33", op: "decode step", where: "32 neighbors at 2,048 ctx (mocked)", input: LIA.kv([["weights", "140 GB"], ["KV of all 33 seqs", `32 × 2,048 + ${P + 4} tokens × 320 KiB = ${fmt.bytes(s33.kvBytes, 2)}`], ["FLOPs", `2 × 70e9 × 33 = ${fmt.si(2 * cfg.P * 33, 2)}`]]), output: LIA.formula(`mem  = (140e9 + ${fmt.num(s33.kvBytes / 1e9, 2)}e9) / BW = <span class="hbm">${fmt.num(s33.mem, 2)} ms</span>\ncomp = <span class="cmp">${fmt.num(s33.cmp, 2)} ms</span>\nTPOT = <b>${fmt.num(s33.t, 2)} ms</b> → ${fmt.num(1000 / s33.t, 0)} tok/s per user`), note: "Our 7 remaining tokens each cost one full step, shared with 32 other users." },
      { k: "Token timestamps", op: "TTFT + 7 × TPOT", where: "what the user sees", input: LIA.tokens(M.output, { cls: () => "out" }), output: stack(tl(), LIA.kv([["last token", `${fmt.num(ttft, 2)} + 7 × ${fmt.num(s33.t, 2)} = ${fmt.num(times[times.length - 1], 1)} ms`]])), note: "Network time is ignored here; add ~20–80 ms of RTT for a real user." },
      { k: "Batch 200 instead", op: "same step, more users", where: "operator's choice", input: table(["", "B = 33", "B = 200"], [["TPOT", fmt.num(s33.t, 1) + " ms", fmt.num(s200.t, 1) + " ms"], ["per user", fmt.num(1000 / s33.t, 0) + " tok/s", fmt.num(1000 / s200.t, 0) + " tok/s"], ["total", fmt.num((33 * 1000) / s33.t, 0) + " tok/s", { v: fmt.num((200 * 1000) / s200.t, 0) + " tok/s", color: "var(--good)" }], ["our answer", fmt.num(ttft + 7 * s33.t, 0) + " ms", fmt.num(ttft + 7 * s200.t, 0) + " ms"]]), output: LIA.kv([["KV capacity", `4 × 80 GB × 90% − 140 GB = ${fmt.bytes(kvCap, 0)}`], ["max batch @ 2,048 ctx", `${maxB} sequences`]]), note: `6× the users costs our request only ${fmt.num((s200.t / s33.t - 1) * 100, 0)}% more per token. Past ~${maxB} sequences the KV cache no longer fits.` },
    ];
  };

  /* ---------- Q10: speculative decoding on our answer ---------- */
  LIA.topics.q10.trace = (M) => {
    const o = M.output;
    // round 1: all 4 accepted + bonus; round 2: 1 accepted, then rejection → resample. Probabilities are mocked.
    const r1 = [{ t: o[1], q: 0.62, p: 0.81, u: 0.44 }, { t: o[2], q: 0.9, p: 0.97, u: 0.12 }, { t: o[3], q: 0.8, p: 0.72, u: 0.31 }, { t: o[4], q: 0.71, p: 0.86, u: 0.58 }];
    const bonus = o[5];
    const r2 = [{ t: o[6], q: 0.88, p: 0.93, u: 0.27 }, { t: tk(" It", 1102), q: 0.41, p: 0.03, u: 0.52 }, { t: tk(" is", 374), q: 0.6, p: 0.5, u: 0 }, { t: tk(" also", 1101), q: 0.5, p: 0.4, u: 0 }];
    const verdict = (row, i, rows) => {
      const firstRej = rows.findIndex((r) => r.u >= Math.min(1, r.p / r.q));
      if (firstRej >= 0 && i > firstRej) return { v: "drop", color: "var(--muted)" };
      const a = Math.min(1, row.p / row.q);
      return row.u < a ? { v: "✓", color: "var(--good)", bold: true } : { v: "✗", color: "var(--bad)", bold: true };
    };
    const rowsOf = (rows) => rows.map((r, i) => [{ v: LIA.showTok(r.t.t), left: true }, r.q.toFixed(2), r.p.toFixed(2), Math.min(1, r.p / r.q).toFixed(2), i > 1 && rows === r2 ? "–" : r.u.toFixed(2), verdict(r, i, rows)]);
    const ctx = (n, extra) => LIA.tokens(M.prompt.slice(-4).concat(o.slice(0, n)), { ids: false, cls: (t, i) => (i < 4 ? "dim" : "out") });
    const resid = [{ t: "<|eot_id|>", p: 0.71, q: 0.02 }, { t: " The", p: 0.09, q: 0.12 }, { t: " It", p: 0.03, q: 0.41 }, { t: "\\n\\n", p: 0.08, q: 0.2 }, { t: " (", p: 0.05, q: 0.04 }];
    function residChart() {
      const W = 360, sv = LIA.svg(W, 150, { "aria-label": "Residual distribution" });
      const r = resid.map((x) => Math.max(0, x.p - x.q)); const z = r.reduce((a, b) => a + b, 0);
      resid.forEach((x, i) => {
        const y = 10 + i * 27, n = r[i] / z;
        sv.appendChild(s("text", { x: 78, y: y + 13, "text-anchor": "end", "font-size": 10.5, fill: "var(--ink)" }, x.t));
        sv.appendChild(s("rect", { x: 84, y: y + 2, width: Math.max(1, n * 200), height: 16, rx: 2, fill: n > 0.5 ? "var(--good)" : "var(--accent)", opacity: 0.8 }));
        sv.appendChild(s("text", { x: 90 + n * 200, y: y + 14, "font-size": 10, fill: "var(--muted)" }, `max(0, ${x.p.toFixed(2)}−${x.q.toFixed(2)}) → ${n.toFixed(2)}`));
      });
      return sv;
    }
    const head = ["draft", "q", "p", "P(acc)", "u", ""];
    return [
      { k: "Context", op: "after prefill", where: "target already emitted “The”", input: LIA.tokens(M.prompt, { ids: false, cls: () => "dim", max: 10 }), output: stack(ctx(1), cap("Target: Llama-3 70B. Draft: a small same-tokenizer model (mocked, cost c = 0.05 of a target step).")), note: "Without speculation, the 7 remaining tokens would need 7 sequential 70B decode steps." },
      { k: "Draft k = 4", op: "draft × 4 (cheap)", where: "small model, sequential", input: ctx(1), output: stack(LIA.tokens(r1.map((r) => r.t), { cls: () => "hl", sub: (t, i) => "q=" + r1[i].q.toFixed(2) })), note: "The draft guesses 4 tokens in a row, recording its own probability q for each pick." },
      { k: "Verify in 1 pass", op: "target forward(4+1 pos)", where: "one memory-bound step", input: LIA.tokens(r1.map((r) => r.t), { cls: () => "hl" }), output: table(head, rowsOf(r1), "q = draft prob, p = target prob, P(acc) = min(1, p/q), u ~ U(0,1); accept if u < P(acc). Probabilities are mocked."), note: "“ France” has p < q but still passes: it is accepted with probability 0.72/0.80 = 0.90, and u = 0.31." },
      { k: "Bonus token", op: "use 5th position", where: "free sample from target", input: LIA.tokens(r1.map((r) => r.t), { cls: () => "good" }), output: stack(LIA.tokens(o.slice(1, 6), { cls: (t, i) => (i < 4 ? "good" : "out"), sub: (t, i) => (i < 4 ? "accepted" : "bonus") }), ctx(6)), note: "All 4 accepted, so the target's distribution at position 5 is already computed. Sampling it gives “ Paris” for free: 5 tokens from one 70B pass." },
      { k: "Round 2", op: "draft 4 → verify", where: "a miss this time", input: LIA.tokens(r2.map((r) => r.t), { cls: () => "hl", sub: (t, i) => "q=" + r2[i].q.toFixed(2) }), output: table(head, rowsOf(r2)), note: "“.” passes, but the draft wants to keep talking (“ It”), which the target finds very unlikely: accept prob 0.03/0.41 = 0.07 < u. Everything after the first rejection is discarded." },
      { k: "Resample", op: "sample norm(max(0, p − q))", where: "keeps the output distribution exact", input: residChart(), output: stack(LIA.tokens(o.slice(0, 8), { cls: (t, i) => (i === 7 ? "good" : "out") }), cap("Result: <code>&lt;|eot_id|&gt;</code>, so the answer is complete.")), note: "Sampling from the clipped difference guarantees the final text is distributed exactly as if the 70B model had decoded alone." },
      { k: "Accounting", op: "count passes", where: "7 decode tokens", input: table(["", "plain decode", "speculative"], [["70B passes", 7, 2], ["draft steps", 0, "8 × 0.05 = 0.4"], ["step-equivalents", 7, 2.4], ["tokens / 70B pass", 1, 3.5]]), output: stack(h("div", { class: "stat good" }, h("span", { class: "k" }, "Speedup on this answer"), h("span", { class: "v" }, "7 / 2.4 ≈ 2.9×")), cap("Matches the lab's formula at α ≈ 0.75, k = 4: E = (1 − α⁵)/(1 − α) ≈ 3.05 tokens per pass.")), note: "Round 1 gave 5 tokens (4 accepted + bonus), round 2 gave 2 (1 accepted + resample)." },
    ];
  };
})();
