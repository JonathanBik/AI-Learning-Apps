/* Module 5 (part b): rollouts, autoscaling, multi-tenancy, cost, system design. */
(function () {
  "use strict";
  const { h, s, fmt } = LIA;

  /* =====================================================================
   * Worked-example traces: the shared mocked request (LIA.MOCK) through each mechanism.
   * Values marked "mocked" are invented for illustration; everything else is computed.
   * ===================================================================== */
  const fnv1a = (str) => { let x = 0x811c9dc5; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; } return x >>> 0; };
  /** murmur3 finalizer: spreads FNV output so similar names land far apart on the ring */
  const fmix = (x) => { x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return x >>> 0; };
  const hex = (n) => n.toString(16).padStart(8, "0");
  /** stacked horizontal bar: segs [{v, c, l}] → small svg */
  function splitBar(segs, o = {}) {
    const W = o.width || 380, H = o.height || 46;
    const tot = o.total || segs.reduce((a, b) => a + b.v, 0);
    const sv = LIA.svg(W, H);
    let x = 0;
    segs.forEach((sg) => {
      const w = (sg.v / tot) * W;
      sv.appendChild(s("rect", { x, y: 4, width: Math.max(0, w - 1), height: 20, rx: 3, fill: sg.c, opacity: sg.o ?? 0.85 }));
      if (sg.l && w > 34) sv.appendChild(s("text", { x: x + w / 2, y: 18, "text-anchor": "middle", "font-size": 10.5, fill: "var(--surface)", "font-weight": 600 }, sg.l));
      x += w;
    });
    if (o.marker != null) {
      const mx = (o.marker / tot) * W;
      sv.appendChild(s("path", { d: `M${mx},2 l-5,-0 l5,8 l5,-8 z`, fill: "var(--ink)" }));
      sv.appendChild(s("line", { x1: mx, x2: mx, y1: 4, y2: 26, stroke: "var(--ink)", "stroke-width": 2 }));
      if (o.markerLabel) sv.appendChild(s("text", { x: LIA.clamp(mx, 40, W - 40), y: 40, "text-anchor": "middle", "font-size": 11, fill: "var(--ink)" }, o.markerLabel));
    } else if (o.caption) sv.appendChild(s("text", { x: 0, y: 40, "font-size": 11, fill: "var(--muted)" }, o.caption));
    return sv;
  }
  /** label/value bar rows with an optional limit tick: rows [{l, v, c, limit}] */
  function barRows(rows, o = {}) {
    const W = 380, rh = 26, lw = o.labelW || 110, vw = 70;
    const max = o.max || Math.max(...rows.map((r) => Math.max(r.v, r.limit || 0))) * 1.08;
    const sv = LIA.svg(W, rows.length * rh + 6);
    rows.forEach((r, i) => {
      const y = 3 + i * rh, X = (v) => lw + (v / max) * (W - lw - vw);
      sv.appendChild(s("text", { x: lw - 6, y: y + 15, "text-anchor": "end", "font-size": 11, fill: "var(--ink)" }, r.l));
      sv.appendChild(s("rect", { x: lw, y: y + 4, width: Math.max(1, X(r.v) - lw), height: 15, rx: 3, fill: r.c || "var(--accent)" }));
      sv.appendChild(s("text", { x: X(r.v) + 5, y: y + 15, "font-size": 11, "font-weight": 600, fill: "var(--ink)" }, r.t || fmt.num(r.v)));
      if (r.limit != null) sv.appendChild(s("line", { x1: X(r.limit), x2: X(r.limit), y1: y + 1, y2: y + 22, stroke: "var(--bad)", "stroke-width": 2, "stroke-dasharray": "3 2" }));
    });
    return sv;
  }
  const div = (...kids) => h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 } }, kids);
  const mocked = () => LIA.pill("mocked", "warn");
  const PROMPT_N = () => LIA.MOCK.prompt.length;
  const OUT_N = () => LIA.MOCK.output.length;

  const TRACES = {};

  /* ---------- Q19: the request during a 5% canary ---------- */
  TRACES.q19 = (M) => {
    let uid = 48213, bucket;
    for (;; uid++) { bucket = fnv1a("u_" + uid) % 100; if (bucket < 5) break; }
    const user = "u_" + uid, hsh = fnv1a(user);
    const gates = [
      { l: "TTFT p99", base: 800, can: 1350, limit: 960, unit: "ms", bad: true },
      { l: "Error rate", base: 0.3, can: 0.4, limit: 1.0, unit: "%", bad: true },
      { l: "Eval score", base: 0.86, can: 0.86, limit: 0.84, unit: "", bad: false },
    ];
    const pass = (g) => (g.bad ? g.can <= g.limit : g.can >= g.limit);
    const sent = 5;
    return [
      {
        k: "Arrive", op: "POST /v1/chat/completions", where: "edge gateway",
        input: () => LIA.blob(LIA.esc(JSON.stringify(M.request, null, 1))),
        output: () => div(LIA.kv([["x-request-id", M.id], ["x-user-id", user], ["rollout", "llama-70b v2 canary at 5%"]]), mocked()),
        note: "A rollout is running: v2 of the engine build gets 5% of traffic, v1 (stable) the rest.",
      },
      {
        k: "Assign cohort", op: "fnv1a(user_id) mod 100", where: "router",
        input: () => LIA.kv([["user_id", user], ["fnv1a", "0x" + hex(hsh)], ["mod 100", String(bucket)]]),
        output: () => div(splitBar([{ v: 5, c: "var(--compute)", l: "" }, { v: 95, c: "var(--accent)", o: 0.35, l: "stable v1 · 95%" }], { total: 100, marker: bucket + 0.5, markerLabel: `bucket ${bucket} < 5 → canary v2` })),
        note: "Hashing the user, not the request, keeps one user on one version for the whole conversation. Same user, same bucket, every time.",
      },
      {
        k: "Serve on canary", op: "generate on v2 pod", where: "canary-pod-0",
        input: () => LIA.tokens(M.prompt, { max: 14, ids: false }),
        output: () => div(LIA.tokens(M.output, { cls: () => "out" }), LIA.kv([["TTFT", "1,410 ms"], ["TPOT", "26 ms"], ["eval sample score", "0.87"]]), mocked()),
        note: "The answer is correct, but first-token latency is high. One request proves nothing; the gate looks at the whole canary window.",
      },
      {
        k: "Gate check", op: "compare window vs baseline", where: "rollout controller",
        inLabel: "Canary window (5% of traffic, 10 min)",
        input: () => div(barRows(gates.map((g) => ({ l: g.l, v: g.can / (g.unit === "ms" ? 1000 : 1), t: g.unit === "ms" ? fmt.num(g.can) + " ms" : g.can + g.unit, c: pass(g) ? "var(--good)" : "var(--bad)", limit: g.limit / (g.unit === "ms" ? 1000 : 1) })), { max: 1.6 }), LIA.caption("dashed red = gate limit (TTFT: baseline 800 ms × 1.2 = 960 ms)")),
        output: () => div(...gates.map((g) => LIA.pill(`${g.l}: ${pass(g) ? "pass" : "FAIL"}`, pass(g) ? "good" : "bad"))),
        note: "TTFT p99 is 1,350 ms against a 960 ms limit. One failed gate is enough to stop the rollout.",
      },
      {
        k: "Roll back", op: "set canary weight 5% → 0%", where: "router config",
        input: () => splitBar([{ v: 5, c: "var(--compute)" }, { v: 95, c: "var(--accent)", l: "v1 95%" }], { total: 100, caption: "before: 5% canary" }),
        output: () => splitBar([{ v: 100, c: "var(--accent)", l: "v1 100%" }], { total: 100, caption: "after: 0% canary, no new requests reach v2" }),
        note: "Rollback is a config change in the router, so it takes effect in seconds without redeploying anything.",
      },
      {
        k: "Drain in-flight", op: "SIGTERM + grace period", where: "canary-pod-0",
        inLabel: `Our stream when rollback fires (${sent}/${OUT_N()} sent)`,
        input: () => LIA.tokens(M.output, { cls: (t, i) => (i < sent ? "out" : "dim") }),
        output: () => div(LIA.tokens(M.output, { cls: () => "out" }), LIA.kv([["pod state", "draining → terminated"], ["new requests", "rejected (removed from LB)"], ["grace period", "120 s"]])),
        note: "The pod stops accepting work but finishes open SSE streams. Killing it outright would cut this answer off after “France”.",
      },
      {
        k: "Next turn", op: "same hash, weight 0", where: "router",
        input: () => LIA.kv([["user_id", user], ["bucket", String(bucket)], ["canary weight", "0%"]]),
        output: () => div(LIA.pill("routed to stable v1", "accent")),
        note: "The bucket is unchanged, but the canary range is now empty, so the user's next message lands on v1.",
      },
    ];
  };

  /* ---------- Q20: the request during a traffic spike ---------- */
  TRACES.q20 = (M) => {
    const R = 4, per = 4, arr = 18, ahead = 37; // replicas, req/s per replica, arrivals/s, queue ahead (mocked)
    const cap = R * per, wait = ahead / cap;
    const perRep = (ahead + 1) / R, target = 4;
    const raw = Math.ceil((R * perRep) / target), desired = Math.min(raw, R * 2);
    const cold = [
      { l: "provision node", v: 60, c: "var(--muted)" },
      { l: "pull image", v: 45, c: "var(--accent)" },
      { l: "download 140 GB", v: 70, c: "var(--hbm)" },
      { l: "load to GPUs", v: 12, c: "var(--compute)" },
      { l: "warmup + graphs", v: 20, c: "var(--sram)" },
    ];
    const coldT = cold.reduce((a, b) => a + b.v, 0);
    const warm = [{ l: "pre-warmed pool", v: 0 }, { l: "pull (cached)", v: 0 }, { l: "load from NVMe", v: 20 }, { l: "load to GPUs", v: 12 }, { l: "warmup + graphs", v: 20 }];
    const warmT = warm.reduce((a, b) => a + b.v, 0);
    const backlog = ahead + (arr - cap) * coldT, drainRate = desired * per - arr, drainT = backlog / drainRate;
    const prefill = 0.06, ttft = wait + prefill;
    return [
      {
        k: "Arrive in a spike", op: "enqueue", where: "10:02 · spike",
        input: () => div(LIA.tokens(M.prompt, { max: 10, ids: false }), LIA.kv([["arrivals", arr + " req/s"], ["capacity", `${R} replicas × ${per} req/s = ${cap} req/s`]]), mocked()),
        output: () => div(barRows([{ l: "arrivals", v: arr, c: "var(--bad)", t: arr + " req/s" }, { l: "capacity", v: cap, c: "var(--good)", t: cap + " req/s" }]), LIA.kv([["queue position", "#" + (ahead + 1)], ["queue grows", `${arr - cap} req/s`]])),
        note: "Arrivals exceed capacity, so the queue grows by 2 requests every second until something changes.",
      },
      {
        k: "Scaling signal", op: "desired = ⌈R · metric / target⌉", where: "autoscaler (every 15 s)",
        input: () => LIA.kv([["metric", "queue depth per replica"], ["value", `${ahead + 1} / ${R} = ${fmt.num(perRep, 2)}`], ["target", String(target)], ["replicas R", String(R)]]),
        output: () => div(LIA.kv([["raw desired", `⌈${R} × ${fmt.num(perRep, 2)} / ${target}⌉ = ${raw}`], ["policy: max +100% per step", `→ ${desired} replicas`]]), LIA.pill(`+${desired - R} replicas requested`, "accent")),
        note: "Queue depth reacts immediately. GPU utilization would already read ~100% and could not show how far behind the system is.",
      },
      {
        k: "Cold start", op: "boot a new replica", where: "new node",
        inLabel: "From scratch",
        input: () => div(splitBar(cold.map((c) => ({ v: c.v, c: c.c, l: c.v + "s" })), { caption: `total ${coldT} s ≈ ${fmt.num(coldT / 60, 1)} min` }), LIA.kv(cold.map((c) => [c.l, c.v + " s"])), mocked()),
        outLabel: "With pre-warmed pool + NVMe weights",
        output: () => div(splitBar(warm.filter((c) => c.v).map((c, i) => ({ v: c.v, c: ["var(--hbm)", "var(--compute)", "var(--sram)"][i], l: c.v + "s" })), { total: coldT, caption: `total ${warmT} s` }), LIA.kv(warm.map((c) => [c.l, c.v + " s"]))),
        note: `Downloading 140 GB of weights at 2 GB/s is 70 s on its own. Keeping nodes warm and weights on local disk cuts ${coldT} s to ${warmT} s.`,
      },
      {
        k: "Our request waits", op: "FIFO on existing replicas", where: "replica-2",
        input: () => LIA.kv([["requests ahead", String(ahead)], ["drain rate", cap + " req/s"]]),
        output: () => div(barRows([{ l: "queue wait", v: wait, c: "var(--warn)", t: fmt.num(wait, 2) + " s" }, { l: "TTFT", v: ttft, c: ttft > 2 ? "var(--bad)" : "var(--good)", t: fmt.num(ttft, 2) + " s", limit: 2 }], { max: 3 }), LIA.caption("dashed red = 2 s TTFT SLO")),
        note: `Our request is served by an old replica after ${fmt.num(wait, 2)} s, long before the new one is ready. Scaling helps the requests that arrive later, not this one.`,
      },
      {
        k: "Backlog builds", op: "arrivals − capacity during cold start", where: `${coldT} s`,
        input: () => LIA.kv([["start queue", String(ahead)], ["growth", `${arr - cap} req/s × ${coldT} s`]]),
        output: () => div(LIA.kv([["queue when replicas arrive", fmt.num(backlog)], ["worst wait", fmt.num(backlog / cap, 1) + " s"]]), LIA.pill("SLO violated for minutes", "bad")),
        note: "This is why cold start time, not the scaling formula, decides how bad a spike gets.",
      },
      {
        k: "Recover", op: `${desired} replicas serving`, where: "after scale-up",
        input: () => barRows([{ l: "capacity", v: desired * per, c: "var(--good)", t: desired * per + " req/s" }, { l: "arrivals", v: arr, c: "var(--bad)", t: arr + " req/s" }]),
        output: () => LIA.kv([["drain rate", `${desired * per} − ${arr} = ${drainRate} req/s`], ["backlog cleared in", fmt.num(drainT, 0) + " s"]]),
        note: "Extra capacity first eats the backlog, then the autoscaler scales back down slowly to avoid flapping.",
      },
    ];
  };

  /* ---------- Q21: the request in a weighted fair queue ---------- */
  TRACES.q21 = (M) => {
    const est = PROMPT_N() + M.request.max_tokens; // reserved tokens
    const actual = PROMPT_N() + OUT_N();
    const bucket = 1240, V = 1000;
    const tenants = { "acme-pro": 4, internal: 2, "free-burst": 1 };
    const lastF = { "acme-pro": 1010, internal: 1020, "free-burst": 1000 };
    const queue = [];
    // noisy tenant already queued 12 requests of 200 tokens each (arrived first)
    let f = lastF["free-burst"];
    for (let i = 0; i < 12; i++) { f = Math.max(V, f) + 200 / tenants["free-burst"]; queue.push({ who: "free-burst", n: i + 1, cost: 200, F: f, arr: i }); }
    const intF = Math.max(V, lastF.internal) + 60 / tenants.internal;
    queue.push({ who: "internal", n: 1, cost: 60, F: intF, arr: 12 });
    const ourF = Math.max(V, lastF["acme-pro"]) + est / tenants["acme-pro"];
    queue.push({ who: "acme-pro", n: 1, cost: est, F: ourF, arr: 13, ours: true });
    const sorted = [...queue].sort((a, b) => a.F - b.F);
    const pos = sorted.findIndex((q) => q.ours) + 1;
    const fifoPos = queue.findIndex((q) => q.ours) + 1;
    const color = { "acme-pro": "var(--accent)", internal: "var(--sram)", "free-burst": "var(--hbm)" };
    const qViz = (list) => {
      const W = 380, sv = LIA.svg(W, 64);
      const w = W / list.length;
      list.forEach((q, i) => {
        sv.appendChild(s("rect", { x: i * w + 1, y: 6, width: w - 2, height: 26, rx: 3, fill: color[q.who], opacity: q.ours ? 1 : 0.5, stroke: q.ours ? "var(--ink)" : "none", "stroke-width": 2 }));
        sv.appendChild(s("text", { x: i * w + w / 2, y: 46, "text-anchor": "middle", "font-size": 9.5, fill: "var(--muted)" }, String(i + 1)));
      });
      sv.appendChild(s("text", { x: 0, y: 61, "font-size": 10.5, fill: "var(--muted)" }, "■ acme-pro  ■ internal  ■ free-burst   (front of queue on the left)"));
      return sv;
    };
    return [
      {
        k: "Tag tenant", op: "API key → tenant", where: "auth",
        input: () => LIA.kv([["Authorization", "Bearer sk-…9f2c"], ["request", M.id]]),
        output: () => div(LIA.kv([["tenant", "acme-pro"], ["weight", "4"], ["rate limit", "50,000 tokens / min"]]), mocked()),
        note: "Every scheduling decision below depends on knowing whose request this is.",
      },
      {
        k: "Token bucket", op: "reserve prompt + max_tokens", where: "rate limiter",
        input: () => div(LIA.kv([["prompt tokens", String(PROMPT_N())], ["max_tokens", String(M.request.max_tokens)], ["reserve", `${PROMPT_N()} + ${M.request.max_tokens} = ${est}`]])),
        output: () => div(barRows([{ l: "bucket before", v: bucket, c: "var(--good)", t: fmt.num(bucket) }, { l: "bucket after", v: bucket - est, c: "var(--good)", t: fmt.num(bucket - est) }], { max: 1400 }), LIA.pill("allowed (no 429)", "good")),
        note: "The limiter cannot know the output length yet, so it reserves the worst case and refunds the difference later.",
      },
      {
        k: "Virtual finish time", op: "F = max(V, F_last) + cost / weight", where: "WFQ scheduler",
        input: () => LIA.kv([["system virtual time V", String(V)], ["acme-pro last F", String(lastF["acme-pro"])], ["cost / weight", `${est} / 4 = ${est / 4}`]]),
        output: () => div(LIA.kv([["F (ours)", `max(${V}, ${lastF["acme-pro"]}) + ${est / 4} = ${ourF}`], ["F (internal, 60 tok, w=2)", String(intF)], ["F (free-burst #1…#12, 200 tok, w=1)", `${queue[0].F} … ${queue[11].F}`]])),
        note: "Weight 4 means each acme-pro token advances virtual time 4× slower than a free-tier token.",
      },
      {
        k: "Order the queue", op: "sort by F", where: "WFQ scheduler",
        inLabel: "Arrival order (FIFO)",
        input: () => div(qViz(queue), LIA.caption(`ours is #${fifoPos} in arrival order`)),
        outLabel: "Fair-queue order",
        output: () => div(qViz(sorted), LIA.caption(`ours is #${pos} by virtual finish time`)),
        note: "The noisy tenant arrived first with 12 big requests, but it cannot push acme-pro to the back of the line.",
      },
      {
        k: "Dequeue", op: "admit to next engine step", where: "engine",
        input: () => LIA.matrix(sorted.slice(0, 4).map((q) => [q.F, q.cost]), { rows: sorted.slice(0, 4).map((q) => q.who + (q.ours ? " ★" : "")), cols: ["F", "tokens"], d: 0, color: "var(--accent)" }),
        output: () => div(barRows([{ l: "FIFO wait", v: (fifoPos - 1) * 0.25, c: "var(--bad)", t: fmt.num((fifoPos - 1) * 0.25, 2) + " s" }, { l: "WFQ wait", v: (pos - 1) * 0.25, c: "var(--good)", t: fmt.num((pos - 1) * 0.25, 2) + " s" }]), LIA.caption("assuming 0.25 s per request ahead (mocked)")),
        note: `Fair queueing moves our request from position ${fifoPos} to ${pos}.`,
      },
      {
        k: "Settle", op: "charge actual, refund rest", where: "rate limiter",
        input: () => div(LIA.tokens(M.output, { cls: () => "out" }), LIA.kv([["actual tokens", `${PROMPT_N()} + ${OUT_N()} = ${actual}`]])),
        output: () => LIA.kv([["reserved", String(est)], ["refund", `${est} − ${actual} = ${est - actual}`], ["bucket now", fmt.num(bucket - actual)]]),
        note: "Refunding unused reservation keeps short answers from eating a tenant's quota.",
      },
    ];
  };

  /* ---------- Q24: what this request costs, lever by lever ---------- */
  TRACES.q24 = (M) => {
    const n = PROMPT_N() + OUT_N();
    const base = 2.0; // $ per 1M tokens, same baseline as the lab
    const sys = 12; // tokens 0..11 are the shared system prompt
    const levers = [
      { k: "Continuous batching", m: 0.5, why: "more sequences share each weight read" },
      { k: "FP8 weights + KV", m: 0.6, why: "half the bytes per step" },
      { k: "Prefix cache hit", m: (n - sys) / n, why: `${sys} system-prompt tokens skip prefill` },
      { k: "Route to 8B model", m: 0.15, why: "classifier: short factual question (mocked)" },
      { k: "Spot capacity", m: 0.65, why: "cheaper GPU-hours with on-demand fallback" },
    ];
    const per1M = (c) => c * 1e6; // $ for 1M requests like this one
    let cost = (n * base) / 1e6;
    const costs = [cost];
    levers.forEach((l) => { cost *= l.m; costs.push(cost); });
    const waterfall = (upto) => {
      const W = 380, H = 142, bw = W / (levers.length + 1);
      const sv = LIA.svg(W, H);
      const Y = (v) => 110 - (v / costs[0]) * 96;
      costs.forEach((c, i) => {
        const prev = i ? costs[i - 1] : 0;
        const on = i <= upto;
        if (i === 0) sv.appendChild(s("rect", { x: 2, y: Y(c), width: bw - 6, height: 110 - Y(c), rx: 2, fill: "var(--hbm)", opacity: on ? 1 : 0.25 }));
        else sv.appendChild(s("rect", { x: i * bw + 2, y: Y(prev), width: bw - 6, height: Y(c) - Y(prev), rx: 2, fill: "var(--good)", opacity: on ? 0.9 : 0.15 }));
        if (on) sv.appendChild(s("text", { x: i * bw + bw / 2 - 2, y: i ? Y(c) + 12 : Y(c) - 3, "text-anchor": "middle", "font-size": 10, fill: "var(--ink)" }, "$" + fmt.num(per1M(c), 2)));
        sv.appendChild(s("text", { x: i * bw + bw / 2 - 2, y: 136, "text-anchor": "middle", "font-size": 9.5, fill: "var(--muted)" }, i ? "×" + fmt.num(levers[i - 1].m, 2) : "base"));
      });
      return sv;
    };
    const steps = [
      {
        k: "Baseline", op: `${n} tokens × $${base.toFixed(2)} / 1M`, where: "70B · FP16 · static batching",
        input: () => div(LIA.tokens(M.prompt.concat(M.output), { ids: false, cls: (t, i) => (i >= PROMPT_N() ? "out" : "") }), LIA.caption(`${PROMPT_N()} prompt + ${OUT_N()} output = ${n} tokens`)),
        output: () => div(waterfall(0), LIA.kv([["this request", "$" + costs[0].toFixed(7)], ["per 1M such requests", "$" + fmt.num(per1M(costs[0]), 2)]])),
        note: "Per-request cost is tiny, so the stepper shows dollars per million requests like this one. Every token is priced the same here for simplicity.",
      },
    ];
    levers.forEach((l, i) => {
      steps.push({
        k: l.k, op: `× ${fmt.num(l.m, 3)}`, where: l.why,
        input: () => (l.k === "Prefix cache hit"
          ? div(LIA.tokens(M.prompt, { ids: false, cls: (t, j) => (j < sys ? "hit" : "") }), LIA.caption(`teal = served from prefix cache · (${n} − ${sys}) / ${n} = ${fmt.num(l.m, 3)}`))
          : LIA.kv([["before", "$" + fmt.num(per1M(costs[i]), 2) + " / 1M req"], ["multiplier", "× " + fmt.num(l.m, 3)]])),
        output: () => div(waterfall(i + 1), LIA.kv([["after", "$" + fmt.num(per1M(costs[i + 1]), 2) + " / 1M req"], ["cumulative cut", fmt.pct(1 - costs[i + 1] / costs[0], 1)]])),
        note: i === 2
          ? "Treating prompt tokens like output tokens overstates this saving: prefill tokens are cheaper than decode tokens in practice."
          : i === 3 ? "Routing has the biggest multiplier, but only for requests a small model answers correctly. “Paris” qualifies; a code review would not." : "",
      });
    });
    return steps;
  };

  /* ---------- Q25: the request through the whole system ---------- */
  TRACES.q25 = (M) => {
    const sys = 12;
    const prefixKey = M.prompt.slice(0, sys).map((t) => t.id).join(",");
    const ph = fnv1a(prefixKey);
    const replicas = ["replica-0", "replica-1", "replica-2", "replica-3"];
    const repAngles = replicas.map((r) => fmix(fnv1a(r)) % 360);
    const keyAngle = fmix(ph) % 360;
    const pick = (() => { const sorted = replicas.map((r, i) => ({ r, a: repAngles[i] })).sort((a, b) => a.a - b.a); return (sorted.find((x) => x.a >= keyAngle) || sorted[0]); })();
    const kvBytes = PROMPT_N() * M.model.kvBytesPerToken;
    const hops = [
      { l: "gateway", ms: 4 }, { l: "auth", ms: 2 }, { l: "model router", ms: 3 }, { l: "cache router", ms: 1 }, { l: "queue", ms: 40 }, { l: "prefill", ms: 25 }, { l: "KV xfer", ms: kvBytes / 50e9 * 1000 }, { l: "decode ×8", ms: 8 * 25 },
    ];
    const budget = (upto) => {
      const spent = hops.slice(0, upto + 1).reduce((a, b) => a + b.ms, 0);
      const cols = ["var(--muted)", "var(--accent)", "var(--compute)", "var(--sram)", "var(--warn)", "var(--compute)", "var(--hbm)", "var(--hbm)"];
      return div(splitBar(hops.map((hp, i) => ({ v: hp.ms, c: cols[i], o: i <= upto ? 0.9 : 0.12 })), { total: hops.reduce((a, b) => a + b.ms, 0), caption: `elapsed ${fmt.num(spent, 1)} ms` }));
    };
    const ring = () => {
      const sv = LIA.svg(200, 190), cx = 100, cy = 92, r = 64;
      sv.appendChild(s("circle", { cx, cy, r, fill: "none", stroke: "var(--line)", "stroke-width": 6 }));
      const pt = (a, rr = r) => [cx + rr * Math.cos((a - 90) * Math.PI / 180), cy + rr * Math.sin((a - 90) * Math.PI / 180)];
      replicas.forEach((rp, i) => { const [x, y] = pt(repAngles[i]); const [tx, ty] = pt(repAngles[i], r + 20); sv.appendChild(s("circle", { cx: x, cy: y, r: 7, fill: rp === pick.r ? "var(--sram)" : "var(--surface-2)", stroke: "var(--sram)", "stroke-width": 2 })); sv.appendChild(s("text", { x: tx, y: ty + 4, "text-anchor": "middle", "font-size": 10, fill: "var(--ink)" }, "r" + i)); });
      const [kx, ky] = pt(keyAngle);
      sv.appendChild(s("circle", { cx: kx, cy: ky, r: 5, fill: "var(--accent)" }));
      sv.appendChild(s("text", { x: cx, y: cy + 4, "text-anchor": "middle", "font-size": 10, fill: "var(--muted)" }, `key @ ${keyAngle}°`));
      sv.appendChild(s("text", { x: cx, y: 186, "text-anchor": "middle", "font-size": 10, fill: "var(--muted)" }, "clockwise to next replica"));
      return sv;
    };
    return [
      {
        k: "Edge gateway", op: "TLS · HTTP/2 · request id", where: hops[0].ms + " ms",
        input: () => LIA.blob(LIA.esc(JSON.stringify(M.request, null, 1))),
        output: () => div(LIA.kv([["x-request-id", M.id], ["x-region", "us-east"], ["deadline", "TTFT ≤ 800 ms"]]), budget(0), mocked()),
        note: "The gateway terminates TLS, assigns an id that every later hop logs, and attaches a latency budget.",
      },
      {
        k: "Auth + rate limit", op: "key → tenant · token bucket", where: hops[1].ms + " ms",
        input: () => LIA.kv([["Authorization", "Bearer sk-…9f2c"]]),
        output: () => div(LIA.kv([["x-tenant", "acme-pro"], ["tier", "pro · weight 4"], ["bucket", "1,240 → 1,148 tokens"]]), budget(1)),
        note: "Rejecting over-quota traffic here costs microseconds; rejecting it on a GPU would waste a prefill.",
      },
      {
        k: "Model router", op: "pick model pool", where: hops[2].ms + " ms",
        input: () => div(LIA.tokens(M.question, { ids: false }), LIA.kv([["prompt tokens", String(PROMPT_N())], ["requested", M.request.model]])),
        output: () => div(LIA.kv([["classifier", "short factual (mocked)"], ["decision", "honor explicit model → llama-70b pool"]]), budget(2)),
        note: "With no explicit model, a router could send this question to an 8B model and cut its cost by ~85% (see Q24).",
      },
      {
        k: "Cache-aware router", op: "hash(prefix) → ring", where: hops[3].ms + " ms",
        input: () => div(LIA.tokens(M.prompt, { max: 16, cls: (t, i) => (i < sys ? "hit" : "dim") }), LIA.kv([["prefix", `first ${sys} token ids`], ["hash", "fmix(fnv1a) = 0x" + hex(fmix(ph))]])),
        output: () => div(ring(), LIA.kv([["chosen", pick.r]]), budget(3)),
        note: "Every request with this system prompt hashes to the same replica, so its KV blocks are already cached there.",
      },
      {
        k: "Prefill pool", op: `queue + prefill on ${pick.r}`, where: `${hops[4].ms + hops[5].ms} ms`,
        input: () => LIA.tokens(M.prompt, { ids: false, cls: (t, i) => (i < sys ? "hit" : "hl") }),
        output: () => div(LIA.kv([["cached (teal)", sys + " tokens"], ["computed", `${PROMPT_N() - sys} tokens`], ["KV written", `${PROMPT_N()} × 320 KiB = ${fmt.num(kvBytes / 2 ** 20, 2)} MiB`], ["first token", "“The”"]]), budget(5)),
        note: `TTFT so far is ${fmt.num(hops.slice(0, 6).reduce((a, b) => a + b.ms, 0), 0)} ms, well inside the 800 ms budget.`,
      },
      {
        k: "KV transfer", op: "RDMA to decode pool", where: fmt.num(hops[6].ms, 2) + " ms",
        input: () => LIA.kv([["KV size", fmt.num(kvBytes / 2 ** 20, 2) + " MiB"], ["link", "400 Gb/s ≈ 50 GB/s"]]),
        output: () => div(LIA.kv([["time", `${fmt.num(kvBytes / 1e6, 2)} MB ÷ 50 GB/s = ${fmt.num(hops[6].ms, 3)} ms`]]), budget(6)),
        note: "For a 28-token prompt the hand-off is negligible. It only matters for long prompts (Q22).",
      },
      {
        k: "Decode + stream", op: "8 steps × 25 ms TPOT", where: hops[7].ms + " ms",
        input: () => LIA.tokens(M.output, { cls: () => "out" }),
        output: () => div(LIA.blob(M.output.filter((t) => !t.sp).map((t) => `data: {"delta":"${LIA.esc(t.t)}"}`).join("\n") + "\ndata: [DONE]"), budget(7)),
        note: "Each token goes back through the gateway as one SSE event on the same HTTP/2 stream.",
      },
      {
        k: "Observe", op: "emit span + usage", where: "telemetry",
        input: () => LIA.kv([["request", M.id], ["replica", pick.r]]),
        output: () => LIA.kv([["TTFT", fmt.num(hops.slice(0, 6).reduce((a, b) => a + b.ms, 0), 0) + " ms"], ["TPOT", "25 ms"], ["tokens", `${PROMPT_N()} in / ${OUT_N()} out`], ["prefix hit", `${sys} / ${PROMPT_N()} tokens`], ["total", fmt.num(hops.reduce((a, b) => a + b.ms, 0), 0) + " ms"]]),
        note: "One structured record per request feeds the dashboards, billing and the canary gates from Q19.",
      },
    ];
  };

  /* =====================================================================
   * Q19 — Safe rollouts
   * ===================================================================== */
  LIA.register({
    id: "q19",
    module: 5,
    q: "Q19",
    title: "Safe Rollouts",
    lede: "Move live traffic onto a new model or engine build in gated steps, and roll back on its own when a gate trips.",
    tags: [{ label: "Canary", kind: "accent" }, { label: "Zero-downtime", kind: "good" }, { label: "Auto-rollback", kind: "bad" }],
    render(stage) {
      const BASE = { ttft: 800, err: 0.3, qual: 0.86 };
      const GATES = [
        { key: "ttft", label: "TTFT p99", unit: "ms", min: 0, max: 2000, limit: BASE.ttft * 1.2, higherBad: true, noise: 400, f: (v) => fmt.num(v) + " ms" },
        { key: "err", label: "Error rate", unit: "%", min: 0, max: 8, limit: 1.0, higherBad: true, noise: 2, f: (v) => fmt.num(v, 1) + "%" },
        { key: "qual", label: "Eval score", unit: "", min: 0.6, max: 1, limit: 0.84, higherBad: false, noise: 0.12, f: (v) => fmt.num(v, 2) },
      ];
      const BUILDS = {
        healthy: { ttft: 820, err: 0.3, qual: 0.86 },
        latency: { ttft: 1350, err: 0.4, qual: 0.86 },
        quality: { ttft: 790, err: 0.3, qual: 0.74 },
        crash: { ttft: 900, err: 6.5, qual: 0.85 },
      };
      const STRATS = {
        canary: { steps: [1, 5, 25, 50, 100], gated: ["ttft", "err", "qual"] },
        bluegreen: { steps: [100], gated: ["ttft", "err", "qual"] },
        rolling: { steps: [12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100], gated: ["err"] },
      };
      let strat = "canary", build = "quality";
      let sim = null;

      const stats = LIA.stats([
        { key: "phase", label: "Phase" },
        { key: "peak", label: "Peak traffic on new build" },
        { key: "mins", label: "Simulated time" },
        { key: "pods", label: "Pods running (cost)" },
      ]);
      const vizBox = LIA.viz();
      const log = h("div", { class: "caption", style: { minHeight: "1.5em" } });

      const stratSeg = LIA.seg({
        label: "Strategy",
        options: [{ value: "canary", label: "Canary" }, { value: "bluegreen", label: "Blue-green" }, { value: "rolling", label: "Rolling" }],
        value: strat,
        onChange: (v) => { strat = v; reset(); },
      });
      const buildSeg = LIA.seg({
        label: "New build is…",
        options: [{ value: "healthy", label: "Healthy" }, { value: "latency", label: "Slow" }, { value: "quality", label: "Quality bug" }, { value: "crash", label: "Crashing" }],
        value: build,
        onChange: (v) => { build = v; reset(); },
      });
      const runBtn = LIA.button("▶ Start rollout", () => start(), "primary");
      stage.append(LIA.controls(stratSeg, buildSeg, h("div", { class: "ctl" }, runBtn)), vizBox, log, stats.el,
        LIA.formula('gate fails when <span class="hl">|measured − limit|</span> exceeds the noise band  <span class="dim">≈ k / √(traffic %)</span>\n<span class="dim">→ 1% traffic only catches loud failures (crashes); p99 latency and eval scores need ≥5%</span>'));

      function whisker(g, pct) { return pct > 0 ? g.noise / Math.sqrt(pct) : Infinity; }
      function gateState(g, pct) {
        const v = BUILDS[build][g.key];
        const over = g.higherBad ? v - g.limit : g.limit - v;
        if (pct <= 0) return "idle";
        if (over > whisker(g, pct)) return "fail";
        if (over > 0) return "unsure";
        return "pass";
      }

      function reset() {
        if (typeof anim !== "undefined") anim.stop();
        sim = { phase: "idle", step: -1, pct: 0, from: 0, to: 0, t: 0, peak: 0, mins: 0, inflight: 0, failed: null, done: false };
        runBtn.textContent = "▶ Start rollout";
        log.textContent = "Press start. Each bake step represents ~10 minutes of production traffic.";
        draw();
      }
      function start() {
        reset();
        sim.phase = strat === "bluegreen" ? "warm" : "shift";
        sim.step = strat === "bluegreen" ? -1 : 0;
        sim.from = 0;
        sim.to = strat === "bluegreen" ? 0 : STRATS[strat].steps[0];
        runBtn.textContent = "↺ Restart";
        anim.start();
      }

      const anim = LIA.loop((dt) => {
        if (!sim || sim.done) return;
        const speed = LIA.reducedMotion ? 4 : 1;
        sim.t += dt * speed;
        const st = STRATS[strat];
        if (sim.phase === "warm") {
          log.textContent = "Green environment boots with the new build and passes smoke tests on zero user traffic.";
          if (sim.t > 1.4) { sim.phase = "shift"; sim.t = 0; sim.step = 0; sim.from = 0; sim.to = 100; sim.mins += 10; }
        } else if (sim.phase === "shift") {
          const dur = strat === "bluegreen" ? 0.25 : 0.8;
          sim.pct = LIA.lerp(sim.from, sim.to, Math.min(1, sim.t / dur));
          log.textContent = `Shifting traffic to ${fmt.num(sim.to, sim.to % 1 ? 1 : 0)}% on the new build…`;
          if (sim.t >= dur) { sim.phase = "bake"; sim.t = 0; }
        } else if (sim.phase === "bake") {
          sim.pct = sim.to;
          log.textContent = `Baking at ${fmt.num(sim.pct, sim.pct % 1 ? 1 : 0)}%: comparing new build against the baseline.`;
          if (sim.t >= 1.5) {
            sim.mins += 10;
            const failing = GATES.filter((g) => st.gated.includes(g.key) && gateState(g, sim.pct) === "fail");
            if (failing.length) {
              sim.failed = failing.map((g) => g.label).join(", ");
              sim.phase = "rollback"; sim.t = 0; sim.from = sim.pct;
              sim.inflight = Math.round(20 + sim.pct * 0.6);
            } else if (sim.step >= st.steps.length - 1) {
              sim.phase = "drain"; sim.t = 0; sim.inflight = 64;
            } else {
              sim.step++; sim.phase = "shift"; sim.t = 0; sim.from = sim.pct; sim.to = st.steps[sim.step];
            }
          }
        } else if (sim.phase === "rollback") {
          const dur = strat === "bluegreen" ? 0.15 : 0.6;
          sim.pct = LIA.lerp(sim.from, 0, Math.min(1, sim.t / dur));
          log.textContent = `Gate tripped (${sim.failed}). Router sends new requests back to the stable build.`;
          if (sim.t >= dur) { sim.phase = "drain"; sim.t = 0; }
        } else if (sim.phase === "drain") {
          const total = 1.8;
          const left = Math.max(0, Math.round(sim.inflight * (1 - sim.t / total)));
          log.textContent = `Draining: ${left} in-flight SSE streams finish on the ${sim.failed ? "bad" : "old"} pods before they get SIGTERM.`;
          if (sim.t >= total) {
            sim.done = true; sim.phase = sim.failed ? "rolled back" : "complete"; sim.mins += 5;
            log.textContent = sim.failed
              ? `Rolled back automatically. ${fmt.num(sim.peak, sim.peak % 1 ? 1 : 0)}% of traffic saw the bad build at peak.`
              : build === "healthy"
                ? "Rollout complete. Old pods drained with zero dropped streams."
                : "Rollout complete, but the new build is broken and now serves 100% of traffic. No gate watched the failing signal.";
            anim.stop();
          }
        }
        sim.peak = Math.max(sim.peak, sim.pct);
        draw();
      }, false);

      function podsFor() {
        const p = sim.pct;
        if (strat === "bluegreen") return { old: 8, neu: sim.phase === "idle" ? 0 : 8, total: sim.phase === "idle" || (sim.done && !sim.failed && false) ? 8 : 16 };
        if (strat === "rolling") { const n = Math.round((p / 100) * 8); return { old: 8 - n, neu: n, total: 8 }; }
        const n = p > 0 ? Math.max(1, Math.ceil((p / 100) * 8)) : 0;
        return { old: p >= 100 && sim.phase === "drain" ? 8 : p >= 100 ? 0 : 8, neu: n, total: (p >= 100 && sim.done ? 0 : 8) + n };
      }

      function draw() {
        const W = 720, H = 330;
        const svg = LIA.svg(W, H);
        svg.style.minWidth = "560px";
        const bad = build !== "healthy";
        const newColor = sim.failed ? "var(--bad)" : "var(--compute)";
        // traffic bar
        const bx = 20, bw = W - 40, by = 26, bh = 34;
        svg.append(s("text", { x: bx, y: 16, "font-size": 12, fill: "var(--muted)" }, "Live traffic split"));
        svg.append(s("rect", { x: bx, y: by, width: bw, height: bh, rx: 6, fill: "var(--accent)" }));
        const nw = (sim.pct / 100) * bw;
        if (nw > 0) svg.append(s("rect", { x: bx + bw - nw, y: by, width: nw, height: bh, rx: 6, fill: newColor }));
        svg.append(s("text", { x: bx + 10, y: by + 22, "font-size": 12, "font-weight": 600, fill: "#fff" }, `stable v1 · ${fmt.num(100 - sim.pct, 0)}%`));
        if (nw > 70) svg.append(s("text", { x: bx + bw - 10, y: by + 22, "text-anchor": "end", "font-size": 12, "font-weight": 600, fill: "#fff" }, `v2 · ${fmt.num(sim.pct, sim.pct % 1 ? 1 : 0)}%`));
        // step ticks
        STRATS[strat].steps.forEach((p, i) => {
          const x = bx + bw - (p / 100) * bw;
          const on = i === sim.step;
          svg.append(s("line", { x1: x, x2: x, y1: by + bh, y2: by + bh + 8, stroke: on ? "var(--ink)" : "var(--muted)" }));
          if (strat !== "rolling" || i % 2 === 1) svg.append(s("text", { x: Math.max(bx + 8, x), y: by + bh + 20, "text-anchor": "middle", "font-size": 10.5, "font-weight": on ? 700 : 400, fill: on ? "var(--ink)" : "var(--muted)" }, p + "%"));
        });
        // pods
        const pods = podsFor();
        const py = 104;
        svg.append(s("text", { x: bx, y: py - 8, "font-size": 12, fill: "var(--muted)" }, strat === "bluegreen" ? "Pods: blue (v1) + green (v2) run side by side — 2× capacity during the switch" : strat === "rolling" ? "Pods: replaced in place, one at a time" : "Pods: v1 fleet + a small v2 canary"));
        const drawPod = (x, y, color, label, dashed, draining) => {
          svg.append(s("rect", { x, y, width: 34, height: 26, rx: 4, fill: color, opacity: dashed ? 0.25 : 1, stroke: draining ? "var(--warn)" : "none", "stroke-width": 2, "stroke-dasharray": draining ? "3 2" : null }));
          svg.append(s("text", { x: x + 17, y: y + 17, "text-anchor": "middle", "font-size": 9.5, fill: dashed ? "var(--ink)" : "#fff" }, label));
        };
        const draining = sim.phase === "drain";
        if (strat === "bluegreen") {
          for (let i = 0; i < 8; i++) drawPod(bx + i * 40, py, "var(--accent)", "v1", false, draining && !sim.failed);
          const live = sim.phase !== "idle";
          for (let i = 0; i < 8; i++) drawPod(bx + 360 + i * 40, py, newColor, "v2", !live || sim.pct === 0 && !sim.failed, draining && !!sim.failed);
        } else if (strat === "rolling") {
          for (let i = 0; i < 8; i++) drawPod(bx + i * 40, py, i < pods.neu ? newColor : "var(--accent)", i < pods.neu ? "v2" : "v1", false, false);
        } else {
          for (let i = 0; i < 8; i++) drawPod(bx + i * 40, py, "var(--accent)", "v1", sim.done && !sim.failed, draining && !sim.failed);
          for (let i = 0; i < pods.neu; i++) drawPod(bx + 360 + i * 40, py, newColor, "v2", false, draining && !!sim.failed);
        }
        // gates
        const gy = 160, tx = 150, tw = W - tx - 120;
        svg.append(s("text", { x: bx, y: gy - 8, "font-size": 12, fill: "var(--muted)" }, `Metric gates (v2 vs baseline) — ${STRATS[strat].gated.length === 3 ? "all three watched" : "readiness/error only"}`));
        GATES.forEach((g, i) => {
          const y = gy + i * 52;
          const X = (v) => tx + ((LIA.clamp(v, g.min, g.max) - g.min) / (g.max - g.min)) * tw;
          const watched = STRATS[strat].gated.includes(g.key);
          const st = gateState(g, sim.pct);
          svg.append(s("text", { x: bx, y: y + 18, "font-size": 12, "font-weight": 600, fill: watched ? "var(--ink)" : "var(--muted)" }, g.label));
          svg.append(s("text", { x: bx, y: y + 32, "font-size": 10, fill: "var(--muted)" }, watched ? `limit ${g.f(g.limit)}` : "not gated"));
          svg.append(s("rect", { x: tx, y: y + 10, width: tw, height: 16, rx: 3, fill: "var(--surface-2)", stroke: "var(--line)" }));
          // bad zone
          const zx = g.higherBad ? X(g.limit) : tx, zw = g.higherBad ? tx + tw - X(g.limit) : X(g.limit) - tx;
          svg.append(s("rect", { x: zx, y: y + 10, width: zw, height: 16, rx: 3, fill: "var(--bad)", opacity: 0.13 }));
          svg.append(s("line", { x1: X(g.limit), x2: X(g.limit), y1: y + 4, y2: y + 32, stroke: "var(--bad)", "stroke-dasharray": "3 2" }));
          // baseline
          svg.append(s("line", { x1: X(BASE[g.key]), x2: X(BASE[g.key]), y1: y + 10, y2: y + 26, stroke: "var(--accent)", "stroke-width": 3 }));
          if (sim.pct > 0 || sim.failed) {
            const pct = Math.max(sim.pct, sim.failed ? sim.peak : 0);
            const v = BUILDS[build][g.key], wk = whisker(g, pct);
            svg.append(s("rect", { x: X(v - wk), y: y + 14, width: Math.max(2, X(v + wk) - X(v - wk)), height: 8, rx: 4, fill: newColor, opacity: 0.25 }));
            svg.append(s("circle", { cx: X(v), cy: y + 18, r: 6, fill: newColor, stroke: "var(--surface)", "stroke-width": 2 }));
          }
          const label = !watched ? "—" : st === "idle" ? "waiting" : st === "fail" ? "FAIL" : st === "unsure" ? "too noisy" : "PASS";
          const col = !watched ? "var(--muted)" : st === "fail" ? "var(--bad)" : st === "unsure" ? "var(--warn)" : st === "pass" ? "var(--good)" : "var(--muted)";
          svg.append(s("text", { x: W - 20, y: y + 23, "text-anchor": "end", "font-size": 12, "font-weight": 700, fill: col }, label));
        });
        svg.append(s("text", { x: tx, y: H - 4, "font-size": 10.5, fill: "var(--muted)" }, "▮ baseline v1   ● v2 measured (band = sampling noise at current traffic %)"));
        LIA.clear(vizBox).append(svg);
        stats.set("phase", sim.phase, sim.phase === "rolled back" ? "bad" : sim.phase === "complete" ? (bad ? "bad" : "good") : "");
        stats.set("peak", fmt.num(sim.peak, sim.peak % 1 ? 1 : 0) + "%", bad && sim.peak > 0 ? (sim.peak >= 50 ? "bad" : "warn") : "");
        stats.set("mins", sim.mins + " min");
        stats.set("pods", `${pods.total} pods`, pods.total > 8 ? "warn" : "");
      }
      reset();
    },
    trace: TRACES.q19,
    insights: [
      { t: "Gate on quality, not just health.", d: "A bad quantization or chat-template change returns fast HTTP 200s full of garbage. Only an eval-score or user-feedback gate catches it." },
      { t: "Small canaries are statistically blind.", d: "At 1% traffic, p99 latency and eval scores are too noisy to judge. Use 1% to catch crashes, then decide at 5–25%." },
      { t: "Blue-green buys instant rollback with 2× GPUs.", d: "The switch is atomic, but 100% of users hit a bad build until the flip back, and you pay for two full fleets during the cut-over." },
      { t: "Drain before you kill.", d: "Stop routing new requests, let in-flight SSE streams finish, then SIGTERM. Set the grace period above your longest generation time." },
    ],
    quiz: [
      {
        type: "mcq",
        prompt: "A new FP8 build passes latency and error-rate gates but users report worse answers. Which gate would have caught it?",
        options: ["A tighter TTFT p50 limit", "An offline/online eval-score comparison against the baseline", "A Kubernetes readiness probe", "A lower CPU utilization threshold"],
        answer: 1,
        explain: "Quality regressions are invisible to health and latency signals. Compare eval scores (golden prompts, LLM-as-judge, thumbs-down rate) between v2 and v1 during the canary.",
      },
      {
        type: "num",
        prompt: "The fleet serves 2,000 req/s. During a 5% canary step, how many requests per minute reach the canary?",
        answer: 6000,
        tol: 0.01,
        unit: "req/min",
        explain: "2,000 × 0.05 = 100 req/s → × 60 = <b>6,000 req/min</b>. That is enough samples for a meaningful p99 and eval comparison within a few minutes.",
      },
      {
        type: "mcq",
        prompt: "Your longest generations take up to 4 minutes. What should pod shutdown look like during a rollout?",
        options: ["SIGKILL immediately; clients will retry", "Mark the pod unready, stop new requests, and allow a grace period above 4 minutes for in-flight streams", "Restart the engine process in place", "Scale to zero first, then deploy"],
        answer: 1,
        explain: "Removing the pod from the load balancer, then draining open streams with a grace period longer than the maximum generation time, avoids cutting responses mid-stream.",
      },
    ],
  });

  /* =====================================================================
   * Q20 — Autoscaling & cold starts
   * ===================================================================== */
  LIA.register({
    id: "q20",
    module: 5,
    q: "Q20",
    title: "Autoscaling & Cold Starts",
    lede: "A GPU replica takes minutes to become useful, so the scaling signal and the cold-start time decide whether a traffic spike breaks your SLO.",
    tags: [{ label: "Capacity", kind: "accent" }, { label: "Cold start", kind: "hbm" }, { label: "SRE", kind: "" }],
    render(stage) {
      const st = { signal: "queue", model: "70B", prewarm: false, nvme: false, slim: false, stream: false, spike: 0.6, minRep: 3 };
      const MODELS = { "8B": { gb: 16, gpus: 1, warm: 20 }, "70B": { gb: 140, gpus: 8, warm: 45 } };
      const PRICE = 2.5; // $/GPU-hr, illustrative on-demand H100-class

      function coldStart() {
        const m = MODELS[st.model];
        const provision = st.prewarm ? 0 : 180;
        const image = st.prewarm ? 0 : st.slim ? 25 : 120;
        const bw = st.nvme ? 6 : 1; // GB/s from local NVMe vs object storage
        const weights = m.gb / bw;
        const load = st.stream ? 5 : 10 + m.gb / 10;
        return [
          { label: "Node provision", v: provision, color: "var(--muted)" },
          { label: "Image pull", v: image, color: "var(--accent)" },
          { label: "Weight download", v: weights, color: "var(--hbm)" },
          { label: "Load to GPU", v: load, color: "var(--sram)" },
          { label: "Warmup / CUDA graphs", v: m.warm, color: "var(--compute)" },
        ];
      }
      function demand(m) {
        const hr = m / 60;
        let d = 0.22 + 0.78 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (hr - 4)) / 24));
        // product-launch spike at 10:00 with a 5-minute ramp, decaying over 50 min
        if (hr >= 10 && hr < 11) {
          const k = m - 600;
          d += st.spike * Math.min(1, k / 5) * Math.exp(-Math.max(0, k - 10) / 25);
        }
        return d * 16; // replicas' worth of demand at the daily peak
      }
      function simulate(coldMin) {
        let ready = Math.max(st.minRep, Math.ceil(demand(0) / 0.8));
        const pending = [];
        let down = 0;
        const dem = [], cap = [], viol = [];
        let violMin = 0, gpuMin = 0;
        let lastLoad = demand(0) / ready;
        for (let m = 0; m < 1440; m++) {
          while (pending.length && pending[0] <= m) { pending.shift(); ready++; }
          const d = demand(m);
          const load = lastLoad; // signal lags one evaluation (1 min)
          let desired;
          if (st.signal === "util") {
            const util = Math.min(1, 0.55 + 0.45 * load); // GPU busy-time reads high even at moderate load
            desired = Math.ceil((ready * util) / 0.85);
          } else if (st.signal === "kv") {
            const kv = Math.min(1, load * 0.9);
            desired = Math.ceil((ready * kv) / 0.7);
          } else {
            desired = Math.ceil((ready * load) / 0.8); // queue depth + arrival rate ≈ true demand
          }
          desired = Math.max(st.minRep, Math.min(60, desired));
          const total = ready + pending.length;
          if (desired > total) { for (let i = total; i < desired; i++) pending.push(m + coldMin); down = 0; }
          else if (desired < ready) { down++; if (down >= 10) { ready = Math.max(desired, st.minRep); down = 0; } }
          else down = 0;
          lastLoad = d / ready;
          dem.push([m / 60, d]);
          cap.push([m / 60, ready]);
          const v = d > ready;
          viol.push(v);
          if (v) violMin++;
          gpuMin += (ready + pending.length) * MODELS[st.model].gpus;
        }
        return { dem, cap, viol, violMin, gpuHrs: gpuMin / 60 };
      }

      const chartBox = LIA.viz();
      const coldBox = LIA.viz();
      const stats = LIA.stats([
        { key: "cold", label: "Cold start (per replica)" },
        { key: "viol", label: "SLO-violation minutes / day" },
        { key: "gpuh", label: "GPU-hours / day" },
        { key: "cost", label: `Daily cost @ $${PRICE}/GPU-hr` },
      ]);
      const toggle = (key, label) => {
        const id = "q20-" + key;
        const cb = h("input", { type: "checkbox", id });
        cb.addEventListener("change", () => { st[key] = cb.checked; update(); });
        return h("label", { for: id, class: "pill", style: { cursor: "pointer", padding: "5px 10px", fontSize: "12.5px" } }, cb, " " + label);
      };
      const sig = LIA.seg({
        label: "Scaling signal",
        options: [{ value: "util", label: "GPU util" }, { value: "kv", label: "KV cache %" }, { value: "queue", label: "Queue depth" }],
        value: st.signal,
        onChange: (v) => { st.signal = v; update(); },
      });
      const model = LIA.seg({ label: "Model", options: ["8B", "70B"], value: st.model, onChange: (v) => { st.model = v; update(); } });
      const spike = LIA.slider({ label: "10:00 launch spike", min: 0, max: 1.2, step: 0.1, value: st.spike, fmt: (v) => "+" + fmt.num(v * 16, 0) + " replicas' worth", onInput: (v) => { st.spike = v; update(); } });
      const minRep = LIA.slider({ label: "Min replicas", min: 1, max: 12, value: st.minRep, onInput: (v) => { st.minRep = v; update(); } });

      stage.append(
        LIA.controls(sig, model, spike, minRep),
        h("div", { class: "row" }, toggle("prewarm", "Pre-warmed node pool"), toggle("slim", "Slim image / cached layers"), toggle("nvme", "Weights on local NVMe"), toggle("stream", "Stream weights into GPU")),
        chartBox,
        stats.el,
        h("div", { class: "panel-title", style: { margin: "6px 0 0" } }, "Cold-start breakdown (seconds)"),
        coldBox
      );

      function update() {
        const parts = coldStart();
        const total = parts.reduce((a, b) => a + b.v, 0);
        const coldMin = Math.max(1, Math.ceil(total / 60));
        const r = simulate(coldMin);
        const bands = [];
        let start = null;
        r.viol.forEach((v, i) => {
          if (v && start === null) start = i;
          if ((!v || i === r.viol.length - 1) && start !== null) { bands.push({ x0: start / 60, x1: i / 60, color: "var(--bad)", opacity: 0.22 }); start = null; }
        });
        const ymax = Math.max(...r.dem.map((p) => p[1]), ...r.cap.map((p) => p[1])) * 1.1;
        // staircase points
        const stairs = [];
        r.cap.forEach((p, i) => { if (i) stairs.push([p[0], r.cap[i - 1][1]]); stairs.push(p); });
        LIA.clear(chartBox).append(
          LIA.lineChart({
            width: 720, height: 280,
            x: { min: 0, max: 24, label: "hour of day", ticks: [0, 4, 8, 10, 12, 16, 20, 24], fmt: (v) => v + "h" },
            y: { min: 0, max: Math.ceil(ymax), label: "replicas" },
            bands,
            series: [
              { points: stairs, color: "var(--accent)", label: "ready replicas", area: true },
              { points: r.dem, color: "var(--compute)", label: "demand (replicas needed)" },
            ],
          })
        );
        LIA.clear(coldBox).append(
          LIA.hbar({
            width: 720,
            labelW: 160,
            rows: [
              { label: "This config", segs: parts.map((p) => ({ value: p.v, color: p.color, label: `${p.label}: ${fmt.num(p.v)} s` })), note: `${fmt.num(total)} s` },
              ...parts.map((p) => ({ label: p.label, value: p.v, color: p.color, note: fmt.num(p.v) + " s" })),
            ],
            max: 520,
          })
        );
        stats.set("cold", `${fmt.num(total)} s (~${coldMin} min)`, total > 240 ? "bad" : total > 90 ? "warn" : "good");
        stats.set("viol", `${r.violMin} min`, r.violMin > 30 ? "bad" : r.violMin > 5 ? "warn" : "good");
        stats.set("gpuh", fmt.num(r.gpuHrs, 0));
        stats.set("cost", fmt.usd(r.gpuHrs * PRICE, 0));
      }
      update();
    },
    trace: TRACES.q20,
    insights: [
      { t: "GPU util is a poor scaling signal.", d: "LLM engines keep the GPU busy at moderate load, so util sits near 100% and cannot say how far over capacity you are. Watch scale-up crawl when you pick it." },
      { t: "Queue depth and KV usage lead the SLO.", d: "Waiting requests and KV-cache pressure rise before TTFT does. Queue depth also measures how much demand exceeds capacity." },
      { t: "Cold start is mostly bytes.", d: "A 70B FP16 checkpoint is ~140 GB. At 1 GB/s from object storage that alone is over 2 minutes; local NVMe or streaming loaders cut it to seconds." },
      { t: "Pre-warm for spikes you can see coming.", d: "No autoscaler can react faster than the cold start. Keep a warm pool or schedule scale-ups before known events." },
    ],
    quiz: [
      {
        type: "mcq",
        prompt: "Why is average GPU utilization a weak autoscaling signal for an LLM server?",
        options: ["It is too expensive to collect", "It saturates near 100% well before throughput limits and hides how deep the queue is", "It only measures memory, not compute", "It cannot be exported to Prometheus"],
        answer: 1,
        explain: "Continuous batching keeps kernels running even at moderate load. Utilization cannot exceed 100%, so it says nothing about how much demand is waiting. Queue depth, KV-cache usage or TTFT track the user experience directly.",
      },
      {
        type: "num",
        prompt: "A new replica must download 140 GB of weights at 2 GB/s. How many seconds does the download take?",
        answer: 70,
        tol: 0.01,
        unit: "s",
        explain: "140 GB ÷ 2 GB/s = <b>70 s</b>, before the weights are even loaded into HBM and CUDA graphs are captured.",
      },
      {
        type: "mcq",
        prompt: "Traffic doubles within 2 minutes at a scheduled product launch; cold start is 6 minutes. What protects the SLO?",
        options: ["Lower the scale-up threshold", "Scale up on a schedule before the launch and keep a pre-warmed pool", "Switch the signal to GPU utilization", "Increase max_num_seqs"],
        answer: 1,
        explain: "A reactive scaler cannot beat a 6-minute cold start. Pre-scale on a schedule and keep warm capacity (weights already in memory) for the burst.",
      },
    ],
  });

  /* =====================================================================
   * Q21 — Multi-tenancy & priority scheduling
   * ===================================================================== */
  LIA.register({
    id: "q21",
    module: 5,
    q: "Q21",
    title: "Multi-tenancy & Priority",
    lede: "Several customers share one GPU pool; the scheduler decides who waits when demand exceeds capacity.",
    tags: [{ label: "Fair sharing", kind: "accent" }, { label: "Noisy neighbor", kind: "bad" }, { label: "Scheduling", kind: "compute" }],
    render(stage) {
      const T = 120, CAP = 100;
      const TEN = [
        { name: "Enterprise", w: 3, color: "var(--accent)", base: 30, rate: 55 },
        { name: "Pro", w: 2, color: "var(--compute)", base: 35, rate: 45 },
        { name: "Free", w: 1, color: "var(--hbm)", base: 20, rate: 30 },
      ];
      const st = { policy: "fifo", noisy: true, surge: false };

      function simulate() {
        const rand = LIA.rng(7);
        const q = TEN.map(() => []);
        const bucket = TEN.map((t) => t.rate * 3);
        const served = TEN.map(() => []), depth = TEN.map(() => []), delays = TEN.map(() => []);
        const rejected = TEN.map(() => 0);
        for (let t = 0; t < T; t++) {
          TEN.forEach((tn, i) => {
            let n = tn.base;
            if (i === 2 && st.noisy && t >= 30 && t < 70) n += 150;
            if (i === 0 && st.surge && t >= 60 && t < 100) n = 90;
            n = Math.max(0, Math.round(n * (0.8 + 0.4 * rand())));
            if (st.policy === "bucket") {
              bucket[i] = Math.min(tn.rate * 3, bucket[i] + tn.rate);
              const ok = Math.min(n, Math.floor(bucket[i]));
              bucket[i] -= ok;
              rejected[i] += n - ok;
              n = ok;
            }
            for (let k = 0; k < n; k++) q[i].push(t);
          });
          const give = [0, 0, 0];
          let cap = CAP;
          if (st.policy === "fifo") {
            while (cap > 0) {
              let best = -1;
              for (let i = 0; i < 3; i++) if (q[i].length && (best < 0 || q[i][give[i]] < q[best][give[best]])) best = i;
              if (best < 0 || give[best] >= q[best].length) break;
              give[best]++; cap--;
            }
          } else if (st.policy === "priority") {
            for (let i = 0; i < 3 && cap > 0; i++) { const g = Math.min(cap, q[i].length); give[i] = g; cap -= g; }
          } else {
            // weighted fair share with water-filling (work-conserving)
            let active = [0, 1, 2].filter((i) => q[i].length > give[i]);
            while (cap > 0.5 && active.length) {
              const wsum = active.reduce((a, i) => a + TEN[i].w, 0);
              let used = 0;
              active.forEach((i) => {
                const share = Math.floor((cap * TEN[i].w) / wsum) || 1;
                const g = Math.min(share, q[i].length - give[i], cap - used);
                give[i] += g; used += g;
              });
              cap -= used;
              if (!used) break;
              active = active.filter((i) => q[i].length > give[i]);
            }
          }
          TEN.forEach((tn, i) => {
            const out = q[i].splice(0, give[i]);
            out.forEach((a) => delays[i].push(t - a));
            served[i].push(give[i]);
            depth[i].push(q[i].length);
          });
        }
        // anything still queued counts with its wait so far
        q.forEach((qq, i) => qq.forEach((a) => delays[i].push(T - a)));
        const p95 = delays.map((d) => { const s2 = d.slice().sort((a, b) => a - b); return s2.length ? s2[Math.floor(0.95 * (s2.length - 1))] : 0; });
        return { served, depth, p95, rejected };
      }

      const pol = LIA.seg({
        label: "Scheduler",
        options: [{ value: "fifo", label: "FIFO" }, { value: "priority", label: "Strict priority" }, { value: "wfq", label: "Weighted fair" }, { value: "bucket", label: "WFQ + token bucket" }],
        value: st.policy,
        onChange: (v) => { st.policy = v; run(); },
      });
      const chk = (key, label) => {
        const id = "q21-" + key;
        const cb = h("input", { type: "checkbox", id, checked: st[key] ? true : null });
        cb.addEventListener("change", () => { st[key] = cb.checked; run(); });
        return h("label", { for: id, class: "pill", style: { cursor: "pointer", padding: "5px 10px", fontSize: "12.5px" } }, cb, " " + label);
      };
      const legend = h("div", { class: "legend" }, TEN.map((t) => h("span", null, h("i", { style: { background: t.color } }), `${t.name} (weight ${t.w}, priority ${TEN.indexOf(t) + 1})`)));
      const servedBox = LIA.viz(), depthBox = LIA.viz(), latBox = LIA.viz();
      const stats = LIA.stats(TEN.map((t, i) => ({ key: "r" + i, label: `${t.name} rejected (429)` })));
      stage.append(
        LIA.controls(pol),
        h("div", { class: "row" }, chk("noisy", "Free tier burst t=30–70 s (noisy neighbor)"), chk("surge", "Enterprise surge t=60–100 s")),
        legend,
        h("div", { class: "cols-2" },
          h("div", null, h("div", { class: "caption" }, "GPU capacity served per second, by tenant (cap = 100 req/s)"), servedBox),
          h("div", null, h("div", { class: "caption" }, "Queue depth (requests waiting)"), depthBox)
        ),
        h("div", { class: "caption" }, "p95 wait per tenant"),
        latBox,
        stats.el
      );

      let res = null;
      const anim = LIA.loop((dt, t) => {
        const upto = LIA.reducedMotion ? T : Math.min(T, Math.floor(t * 30));
        draw(upto);
        if (upto >= T) anim.stop();
      }, false);

      function run() { res = simulate(); anim.stop(); if (LIA.reducedMotion) draw(T); else { anim.start(); } }

      function draw(upto) {
        const svg = LIA.lineChart({ width: 460, height: 240, legend: false, x: { min: 0, max: T, label: "time (s)" }, y: { min: 0, max: 110, label: "req/s served" }, hlines: [{ y: CAP, label: "GPU capacity", color: "var(--muted)" }] });
        const X = svg.scaleX, Y = svg.scaleY;
        const acc = new Array(upto).fill(0);
        res.served.forEach((sv, i) => {
          if (!upto) return;
          let top = "", bot = "";
          for (let t = 0; t < upto; t++) { top += `${t ? "L" : "M"}${X(t).toFixed(1)},${Y(acc[t] + sv[t]).toFixed(1)}`; }
          for (let t = upto - 1; t >= 0; t--) { bot += `L${X(t).toFixed(1)},${Y(acc[t]).toFixed(1)}`; }
          svg.append(s("path", { d: top + bot + "Z", fill: TEN[i].color, opacity: 0.85 }));
          for (let t = 0; t < upto; t++) acc[t] += sv[t];
        });
        LIA.clear(servedBox).append(svg);
        const dmax = Math.max(50, ...res.depth.flat());
        LIA.clear(depthBox).append(LIA.lineChart({
          width: 460, height: 240, legend: false,
          x: { min: 0, max: T, label: "time (s)" }, y: { min: 0, max: dmax * 1.05, label: "queued" },
          series: res.depth.map((d, i) => ({ points: d.slice(0, upto).map((v, t) => [t, v]), color: TEN[i].color })),
        }));
        const done = upto >= T;
        LIA.clear(latBox).append(LIA.hbar({
          width: 720,
          rows: TEN.map((t, i) => ({ label: t.name, value: done ? res.p95[i] : 0, color: t.color, note: done ? (res.p95[i] >= 60 ? `${res.p95[i]} s — starved` : `${res.p95[i]} s`) : "…" })),
          max: T,
          refs: [{ value: 5, label: "SLO 5 s", color: "var(--bad)" }],
        }));
        TEN.forEach((t, i) => stats.set("r" + i, st.policy === "bucket" ? fmt.num(res.rejected[i]) : "n/a", st.policy === "bucket" && res.rejected[i] > 0 ? "warn" : ""));
      }
      run();
    },
    trace: TRACES.q21,
    insights: [
      { t: "FIFO lets one tenant hurt everyone.", d: "A burst from the free tier fills the shared queue and every customer behind it waits." },
      { t: "Strict priority starves the bottom tier.", d: "Turn on the enterprise surge: as long as higher tiers have work, Pro and Free get nothing." },
      { t: "Weighted fair queueing isolates tenants.", d: "Each backlogged tenant gets capacity in proportion to its weight, and unused share flows to others, so no GPU time is wasted." },
      { t: "Rate limits stop abuse at the door.", d: "Token buckets (tokens/s plus a burst size) reject excess with 429 before it consumes queue space or KV cache." },
    ],
    quiz: [
      {
        type: "mcq",
        prompt: "Under strict priority scheduling, what happens to the lowest tier during a sustained high-priority surge?",
        options: ["It gets its weighted share", "It is starved until higher tiers drain", "It is automatically rate-limited to 429", "It preempts the higher tier"],
        answer: 1,
        explain: "Strict priority always serves the higher queue first. With enough high-priority demand, lower tiers wait indefinitely. Aging or weighted fairness fixes this.",
      },
      {
        type: "num",
        prompt: "Three tenants with weights 3:2:1 are all backlogged on a pool doing 12,000 tok/s. How many tok/s does the weight-2 tenant get under WFQ?",
        answer: 4000,
        tol: 0.01,
        unit: "tok/s",
        explain: "Share = 2 / (3+2+1) = 1/3 → 12,000 × 1/3 = <b>4,000 tok/s</b>.",
      },
      {
        type: "mcq",
        prompt: "A tenant's token bucket refills at 50 req/s with a bucket size of 500. What does the 500 control?",
        options: ["The steady-state rate", "How large a short burst is admitted above the steady rate", "The number of concurrent streams", "The max output tokens per request"],
        answer: 1,
        explain: "The refill rate sets the long-run average; the bucket size sets how much accumulated credit a burst can spend at once.",
      },
    ],
  });

  /* =====================================================================
   * Q24 — Cost reduction waterfall
   * ===================================================================== */
  LIA.register({
    id: "q24",
    module: 5,
    q: "Q24",
    title: "Cutting Cost per Token",
    lede: "Stack optimization levers and watch $/1M tokens fall. Each lever multiplies the cost that is left, so savings compound.",
    tags: [{ label: "FinOps", kind: "good" }, { label: "Target −70%", kind: "accent" }],
    render(stage) {
      const LEVERS = [
        { id: "batch", name: "Continuous batching, bigger batches", keep: 0.5, on: true, why: "More sequences share each weight read from HBM" },
        { id: "quant", name: "FP8 weights + KV cache", keep: 0.6, on: true, why: "Half the bytes per token; 2× FP8 tensor-core rate" },
        { id: "prefix", name: "Prefix caching", keep: 0.85, on: true, why: "Skip prefill for shared system prompts" },
        { id: "spec", name: "Speculative decoding", keep: 0.8, on: false, why: "Several tokens per weight pass at low batch" },
        { id: "route", name: "Small/large model routing", keep: 0.55, on: false, why: "Easy queries go to a cheap model" },
        { id: "compress", name: "Prompt compression", keep: 0.9, on: false, why: "Fewer input tokens to prefill" },
        { id: "spot", name: "Spot instances + on-demand fallback", keep: 0.65, on: true, why: "Lower $/GPU-hr, with preemption risk" },
        { id: "gpu", name: "Right-sized GPU", keep: 0.85, on: false, why: "Match HBM size/bandwidth to the model" },
      ];
      let baseline = 2.0;
      const chart = LIA.viz();
      const stats = LIA.stats([
        { key: "final", label: "Final $/1M tokens" },
        { key: "red", label: "Total reduction" },
        { key: "goal", label: "−70% target" },
      ]);
      const base = LIA.slider({ label: "Baseline $/1M tokens (70B, FP16, static batching)", min: 0.5, max: 5, step: 0.1, value: baseline, fmt: (v) => fmt.usd(v), onInput: (v) => { baseline = v; draw(); } });
      const rows = LEVERS.map((L) => {
        const id = "q24-" + L.id;
        const cb = h("input", { type: "checkbox", id, checked: L.on ? true : null });
        cb.addEventListener("change", () => { L.on = cb.checked; draw(); });
        const sl = LIA.slider({ label: "cost kept", min: 0.3, max: 1, step: 0.05, value: L.keep, fmt: (v) => "×" + v.toFixed(2), onInput: (v) => { L.keep = v; draw(); } });
        return h("div", { class: "stat", style: { gap: "6px" } },
          h("label", { for: id, style: { display: "flex", gap: "8px", alignItems: "flex-start", cursor: "pointer", fontWeight: 600, fontSize: "13.5px" } }, cb, h("span", null, L.name)),
          h("span", { class: "k" }, L.why),
          sl.el);
      });
      stage.append(LIA.controls(base), chart, stats.el, h("div", { class: "cols-3" }, rows),
        LIA.caption("Multipliers are illustrative starting points; real values depend on workload, model and hardware. Adjust them to your own measurements."));

      function draw() {
        const on = LEVERS.filter((L) => L.on);
        const W = 720, H = 300, m = { l: 48, r: 12, t: 22, b: 70 };
        const n = on.length + 2;
        const bw = (W - m.l - m.r) / n;
        const Y = (v) => H - m.b - (v / (baseline * 1.08)) * (H - m.t - m.b);
        const svg = LIA.svg(W, H);
        LIA.niceTicks(0, baseline * 1.08, 5).forEach((v) => {
          svg.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: "var(--grid)" }));
          svg.append(s("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, "$" + fmt.num(v, v < 1 ? 2 : 1)));
        });
        const target = baseline * 0.3;
        let cur = baseline;
        const bar = (i, top, bottom, color, label, val) => {
          const x = m.l + i * bw + bw * 0.14, w = bw * 0.72;
          svg.append(s("rect", { x, y: Y(top), width: w, height: Math.max(1, Y(bottom) - Y(top)), rx: 3, fill: color }));
          svg.append(s("text", { x: x + w / 2, y: Y(top) - 5, "text-anchor": "middle", "font-size": 10.5, "font-weight": 600, fill: "var(--ink)" }, val));
          const words = label.split(" ");
          const lines = [];
          words.forEach((wd) => { if (lines.length && (lines[lines.length - 1] + " " + wd).length <= Math.max(8, Math.floor(bw / 6.5))) lines[lines.length - 1] += " " + wd; else lines.push(wd); });
          lines.slice(0, 4).forEach((ln, k) => svg.append(s("text", { x: x + w / 2, y: H - m.b + 14 + k * 12, "text-anchor": "middle", "font-size": 10, fill: "var(--muted)" }, ln)));
          return x + w;
        };
        let prevRight = bar(0, baseline, 0, "var(--hbm)", "Baseline", fmt.usd(baseline));
        on.forEach((L, i) => {
          const next = cur * L.keep;
          svg.append(s("line", { x1: prevRight, x2: m.l + (i + 1) * bw + bw * 0.14, y1: Y(cur), y2: Y(cur), stroke: "var(--muted)", "stroke-dasharray": "2 2" }));
          prevRight = bar(i + 1, cur, next, "var(--good)", L.name, "−" + fmt.usd(cur - next));
          cur = next;
        });
        svg.append(s("line", { x1: prevRight, x2: m.l + (n - 1) * bw + bw * 0.14, y1: Y(cur), y2: Y(cur), stroke: "var(--muted)", "stroke-dasharray": "2 2" }));
        bar(n - 1, cur, 0, cur <= target ? "var(--good)" : "var(--accent)", "Optimized", fmt.usd(cur));
        svg.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(target), y2: Y(target), stroke: "var(--bad)", "stroke-dasharray": "6 4", "stroke-width": 1.5 }));
        svg.append(s("text", { x: W - m.r, y: Y(target) - 5, "text-anchor": "end", "font-size": 11, fill: "var(--bad)" }, "−70% target " + fmt.usd(target)));
        LIA.clear(chart).append(svg);
        const red = 1 - cur / baseline;
        stats.set("final", fmt.usd(cur, 3), cur <= target ? "good" : "");
        stats.set("red", fmt.pct(red, 1), red >= 0.7 ? "good" : "warn");
        stats.set("goal", red >= 0.7 ? "✓ reached" : `needs ×${(target / cur).toFixed(2)} more`, red >= 0.7 ? "good" : "bad");
      }
      draw();
    },
    trace: TRACES.q24,
    insights: [
      { t: "Savings multiply.", d: "Three levers keeping 50%, 60% and 80% leave 0.5 × 0.6 × 0.8 = 24% of the cost, a 76% cut. Adding their percentages would claim 110%." },
      { t: "Batching and precision come first.", d: "Decode is bandwidth-bound; more sequences per weight read and fewer bytes per weight are the biggest multipliers." },
      { t: "Routing is the quiet giant.", d: "If 60% of queries can go to an 8B model at a tenth of the cost, the blended price nearly halves." },
      { t: "Spot needs a plan for preemption.", d: "Keep an on-demand floor, checkpoint or retry in-flight requests, and use spot for elastic or batch traffic." },
    ],
    quiz: [
      {
        type: "num",
        prompt: "Three levers keep 50%, 60% and 80% of the cost. What is the total reduction, in percent?",
        answer: 76,
        tol: 0.01,
        unit: "%",
        explain: "Remaining = 0.5 × 0.6 × 0.8 = 0.24 → reduction = <b>76%</b>.",
      },
      {
        type: "mcq",
        prompt: "Why can't you add lever savings together (50% + 40% + 20% = 110%)?",
        options: ["Because levers are mutually exclusive", "Each lever acts on the cost that remains after the previous ones", "Because GPU prices change", "Savings must be averaged"],
        answer: 1,
        explain: "Each optimization scales the remaining cost, so the result is a product of multipliers, which can never go below zero.",
      },
      {
        type: "mcq",
        prompt: "What is the main operational risk when moving decode replicas to spot instances?",
        options: ["Lower FP8 accuracy", "Preemption with short notice interrupts in-flight generations", "Spot GPUs have less HBM", "Higher network egress cost"],
        answer: 1,
        explain: "Spot capacity can be reclaimed with little warning. Keep an on-demand floor and make clients or the gateway retry interrupted requests.",
      },
    ],
  });

  /* =====================================================================
   * Q25 — System design at scale
   * ===================================================================== */
  LIA.register({
    id: "q25",
    module: 5,
    q: "Q25",
    title: "System Design at Scale",
    lede: "Design a ChatGPT-style service: click each component to see its job, then size the GPU fleet from user numbers.",
    tags: [{ label: "Architecture", kind: "accent" }, { label: "Capacity planning", kind: "compute" }, { label: "Capstone", kind: "good" }],
    render(stage) {
      const NODES = [
        { id: "client", x: 10, y: 150, label: "Clients", sub: "web · mobile · API", role: "Send chat requests and hold a streaming (SSE/HTTP2) connection open for the response.", metric: "Client-side TTFT, disconnect rate", fail: "Disconnects must cancel generation server-side, or GPUs keep decoding for nobody." },
        { id: "edge", x: 120, y: 150, label: "Edge / LB", sub: "TLS · anycast", role: "Terminate TLS close to the user, absorb connection storms and route to the nearest healthy region.", metric: "Open connections, regional health", fail: "Idle timeouts shorter than generation time cut long streams." },
        { id: "gw", x: 235, y: 150, label: "API gateway", sub: "auth · quotas", role: "Authenticate, apply per-tenant token-bucket limits (in tokens, not requests), count usage for billing.", metric: "429 rate per tenant, tokens/s per key", fail: "Request-count limits let one tenant send huge prompts and starve others." },
        { id: "safety", x: 235, y: 40, label: "Safety filters", sub: "input · output", role: "Classify prompts and streamed outputs for policy violations using small, fast models.", metric: "Added latency p99, block rate", fail: "Running a large classifier inline adds hundreds of ms to TTFT." },
        { id: "router", x: 350, y: 150, label: "Model router", sub: "cascade · cache-aware", role: "Pick the model (small vs large) per request, then pick the replica that already holds this conversation's prefix in KV cache.", metric: "Prefix-cache hit rate, % routed to small model", fail: "Pure round-robin destroys prefix locality; pure affinity creates hot spots. Use bounded-load consistent hashing." },
        { id: "sched", x: 470, y: 150, label: "Scheduler", sub: "priority · WFQ", role: "Queue requests per tenant and priority, admit them when KV-cache space allows, preempt low priority under pressure.", metric: "Queue depth, wait time by tier", fail: "FIFO lets one tenant's burst raise everyone's TTFT." },
        { id: "small", x: 610, y: 40, label: "Small-model pool", sub: "8B · FP8", role: "Serves easy queries cheaply at high batch size on smaller or fewer GPUs.", metric: "Tokens/s per GPU, escalation rate", fail: "A router that under-escalates hurts answer quality; track evals per route." },
        { id: "prefill", x: 610, y: 150, label: "Prefill pool", sub: "compute-bound", role: "Processes prompts (matrix-matrix, compute-bound) and produces the KV cache. Sized by input tokens/s.", metric: "TTFT, prefill tokens/s, MFU", fail: "Long prompts monopolize the GPU without chunked prefill or disaggregation." },
        { id: "decode", x: 770, y: 150, label: "Decode pool", sub: "bandwidth-bound", role: "Generates tokens one step at a time (matrix-vector, HBM-bandwidth bound) for large batches of sequences.", metric: "TPOT/ITL, batch size, KV usage %", fail: "Running out of KV cache forces preemption and recomputation, spiking tail latency." },
        { id: "kv", x: 770, y: 255, label: "KV / prefix cache", sub: "HBM → DRAM → NVMe", role: "Tiered store for KV blocks: hot in HBM, warm in CPU DRAM, cold on NVMe, shared across turns of a conversation.", metric: "Hit rate per tier, eviction rate", fail: "Evicting system-prompt prefixes forces full recomputation of shared tokens." },
        { id: "auto", x: 470, y: 255, label: "Autoscaler", sub: "queue · KV signal", role: "Adds or removes replicas per pool based on queue depth and KV usage, with warm pools to hide cold starts.", metric: "Cold-start time, SLO-violation minutes", fail: "Scaling on GPU utilization reacts too late." },
        { id: "obs", x: 120, y: 255, label: "Observability", sub: "metrics · traces", role: "Collects TTFT, TPOT, queue depth, KV %, prefix hit rate, cost per token, per tenant and per model version.", metric: "SLO burn rate", fail: "Averages hide p99; always record histograms." },
      ];
      const EDGES = [
        ["client", "edge"], ["edge", "gw"], ["gw", "safety", true], ["gw", "router"], ["router", "sched"], ["sched", "small"], ["sched", "prefill"],
        ["prefill", "decode", false, "KV via RDMA"], ["decode", "kv", true], ["router", "kv", true, "prefix index"], ["auto", "sched", true], ["obs", "auto", true],
      ];
      const BW = 104, BH = 50;
      const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
      let sel = "router";
      const diag = LIA.viz();
      const detail = h("div", { class: "stat", style: { gap: "6px" } });
      const diagW = 890, diagH = 320;

      function center(n) { return [n.x + BW / 2, n.y + BH / 2]; }
      function edgePt(a, b) {
        // point where segment from center(a) to center(b) leaves box a
        const [ax, ay] = center(a), [bx, by] = center(b);
        const dx = bx - ax, dy = by - ay;
        const t = Math.min(BW / 2 / Math.abs(dx || 1e-9), BH / 2 / Math.abs(dy || 1e-9));
        return [ax + dx * t, ay + dy * t];
      }
      const paths = [];
      function drawDiagram() {
        const svg = LIA.svg(diagW, diagH);
        svg.append(s("defs", null, s("marker", { id: "q25-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: "M0,0L10,5L0,10Z", fill: "var(--muted)" }))));
        paths.length = 0;
        EDGES.forEach(([a, b, dashed, label]) => {
          const A = byId[a], B = byId[b];
          const [x1, y1] = edgePt(A, B), [x2, y2] = edgePt(B, A);
          svg.append(s("line", { x1, y1, x2, y2, stroke: "var(--muted)", "stroke-width": 1.5, "stroke-dasharray": dashed ? "4 3" : null, "marker-end": "url(#q25-arrow)" }));
          if (label) svg.append(s("text", { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, "text-anchor": "middle", "font-size": 10, fill: "var(--muted)" }, label));
          if (!dashed) paths.push([x1, y1, x2, y2]);
        });
        const dots = s("g");
        svg.append(dots);
        NODES.forEach((n) => {
          const on = n.id === sel;
          const tint = n.id === "decode" || n.id === "kv" ? "var(--hbm)" : n.id === "prefill" || n.id === "small" ? "var(--compute)" : n.id === "router" ? "var(--sram)" : "var(--accent)";
          const g = s("g", { tabindex: 0, role: "button", "aria-label": n.label, style: "cursor:pointer" });
          g.append(s("rect", { x: n.x, y: n.y, width: BW, height: BH, rx: 8, fill: on ? tint : "var(--surface)", stroke: tint, "stroke-width": on ? 2.5 : 1.5 }));
          g.append(s("text", { x: n.x + BW / 2, y: n.y + 21, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: on ? "#fff" : "var(--ink)" }, n.label));
          g.append(s("text", { x: n.x + BW / 2, y: n.y + 37, "text-anchor": "middle", "font-size": 9.5, fill: on ? "#fff" : "var(--muted)" }, n.sub));
          const pick = () => { sel = n.id; drawDiagram(); showDetail(); };
          g.addEventListener("click", pick);
          g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
          svg.append(g);
        });
        LIA.clear(diag).append(svg);
        diag.dots = dots;
      }
      function showDetail() {
        const n = byId[sel];
        LIA.clear(detail).append(
          h("div", { style: { fontFamily: "var(--f-display)", fontWeight: 700, fontSize: "17px" } }, n.label),
          h("div", null, n.role),
          h("div", null, LIA.pill("Key metric", "accent"), " ", n.metric),
          h("div", null, LIA.pill("Failure mode", "bad"), " ", n.fail)
        );
      }
      // request particles along solid edges
      const parts = Array.from({ length: 10 }, (_, i) => ({ e: i % 8, t: i / 10 }));
      LIA.loop((dt) => {
        const g = diag.dots;
        if (!g || !paths.length || LIA.reducedMotion) return;
        LIA.clear(g);
        parts.forEach((p) => {
          p.t += dt * 0.7;
          if (p.t > 1) { p.t = 0; p.e = (p.e + 1) % paths.length; }
          const [x1, y1, x2, y2] = paths[p.e % paths.length];
          g.append(s("circle", { cx: x1 + (x2 - x1) * p.t, cy: y1 + (y2 - y1) * p.t, r: 3.5, fill: "var(--accent)" }));
        });
      });

      // ---------- capacity calculator ----------
      const c = { dau: 7, rpu: 15, inTok: 1500, outTok: 400, peak: 2.5, dec: 1500, pre: 15000, hit: 40, util: 70, price: 2.5 };
      const sl = (key, label, min, max, step, f) => LIA.slider({ label, min, max, step, value: c[key], fmt: f, onInput: (v) => { c[key] = v; calc(); } });
      const controls = LIA.controls(
        sl("dau", "Daily active users", 5, 8, 0.1, (v) => fmt.si(Math.pow(10, v))),
        sl("rpu", "Requests / user / day", 1, 50, 1, (v) => v),
        sl("inTok", "Avg input tokens", 100, 8000, 100, (v) => fmt.num(v)),
        sl("outTok", "Avg output tokens", 50, 2000, 50, (v) => fmt.num(v)),
        sl("peak", "Peak ÷ average traffic", 1, 5, 0.1, (v) => v.toFixed(1) + "×"),
        sl("hit", "Prefix-cache hit rate", 0, 90, 5, (v) => v + "%"),
        sl("pre", "Prefill tok/s per GPU", 2000, 40000, 1000, (v) => fmt.si(v)),
        sl("dec", "Decode tok/s per GPU", 300, 5000, 100, (v) => fmt.si(v)),
        sl("util", "Target utilization", 50, 90, 5, (v) => v + "%"),
        sl("price", "$ per GPU-hour", 1, 6, 0.1, (v) => fmt.usd(v))
      );
      const cstats = LIA.stats([
        { key: "avg", label: "Average QPS" },
        { key: "peak", label: "Peak QPS" },
        { key: "otps", label: "Peak output tok/s" },
        { key: "gpus", label: "GPUs at peak", cls: "accent" },
        { key: "nodes", label: "8-GPU nodes" },
        { key: "cost", label: "Monthly cost (peak-provisioned)" },
        { key: "ppm", label: "$ per 1M tokens (in+out)" },
      ]);
      const gpuBox = LIA.viz();
      const fml = h("div");
      function calc() {
        const dau = Math.pow(10, c.dau);
        const avg = (dau * c.rpu) / 86400;
        const peak = avg * c.peak;
        const preTok = peak * c.inTok * (1 - c.hit / 100);
        const outTok = peak * c.outTok;
        const u = c.util / 100;
        const gPre = Math.ceil(preTok / (c.pre * u));
        const gDec = Math.ceil(outTok / (c.dec * u));
        const gpus = gPre + gDec;
        const monthly = gpus * 730 * c.price;
        const monthTokens = avg * (c.inTok + c.outTok) * 86400 * 30;
        cstats.set("avg", fmt.num(avg, 0));
        cstats.set("peak", fmt.num(peak, 0));
        cstats.set("otps", fmt.si(outTok));
        cstats.set("gpus", fmt.num(gpus));
        cstats.set("nodes", fmt.num(Math.ceil(gpus / 8)));
        cstats.set("cost", "$" + fmt.si(monthly, 2));
        cstats.set("ppm", fmt.usd((monthly / monthTokens) * 1e6, 3));
        LIA.clear(gpuBox).append(LIA.hbar({
          width: 720, labelW: 110,
          rows: [
            { label: "Fleet", segs: [{ value: gPre, color: "var(--compute)", label: "prefill GPUs" }, { value: gDec, color: "var(--hbm)", label: "decode GPUs" }], note: `${fmt.num(gpus)} GPUs` },
            { label: "Prefill GPUs", value: gPre, color: "var(--compute)", note: fmt.num(gPre) },
            { label: "Decode GPUs", value: gDec, color: "var(--hbm)", note: fmt.num(gDec) },
          ],
        }));
        fml.innerHTML = "";
        fml.append(LIA.formula(
          `avg QPS  = DAU × req/user ÷ 86,400 = <span class="hl">${fmt.num(avg, 0)}</span>\n` +
          `peak QPS = avg × ${c.peak.toFixed(1)} = <span class="hl">${fmt.num(peak, 0)}</span>\n` +
          `<span class="cmp">prefill GPUs</span> = peak × ${c.inTok} in × (1 − ${c.hit}% hit) ÷ (${fmt.si(c.pre)} × ${c.util}%) = <span class="cmp">${fmt.num(gPre)}</span>\n` +
          `<span class="hbm">decode GPUs</span>  = peak × ${c.outTok} out ÷ (${fmt.si(c.dec)} × ${c.util}%) = <span class="hbm">${fmt.num(gDec)}</span>`
        ));
      }
      stage.append(
        diag,
        h("div", { class: "caption" }, "Click a component (or Tab + Enter). Dots trace the request path; dashed lines are control or cache lookups."),
        detail,
        h("div", { class: "panel-title", style: { margin: "10px 0 0" } }, "Capacity calculator"),
        controls,
        cstats.el,
        gpuBox,
        fml
      );
      drawDiagram();
      showDetail();
      calc();
      LIA.onTheme(() => drawDiagram());
    },
    trace: TRACES.q25,
    insights: [
      { t: "Size prefill and decode separately.", d: "Prefill scales with input tokens and compute; decode scales with output tokens and HBM bandwidth. They need different GPU counts." },
      { t: "Provision for the peak, pay for the average.", d: "Peak-to-average ratio drives fleet size. Autoscaling, spot capacity and batch workloads fill the troughs." },
      { t: "Cache-aware routing multiplies prefix hits.", d: "Sending a conversation's next turn to the replica that holds its KV cache skips most of the prefill." },
      { t: "Measure everything per tenant and version.", d: "TTFT, TPOT, queue depth, KV %, hit rate and cost per token are the dashboard for every decision in this course." },
    ],
    quiz: [
      {
        type: "num",
        prompt: "10M daily active users each send 15 requests per day. What is the average QPS?",
        answer: 1736,
        tol: 0.01,
        unit: "req/s",
        explain: "10,000,000 × 15 ÷ 86,400 ≈ <b>1,736 req/s</b>. At a 3× peak factor you must serve ~5,200 req/s.",
      },
      {
        type: "mcq",
        prompt: "What does cache-aware routing optimize?",
        options: ["GPU temperature", "Sending requests with a shared prefix to the replica that already holds its KV cache, cutting prefill work and TTFT", "Choosing the cheapest cloud region", "Retrying failed requests on a new replica"],
        answer: 1,
        explain: "Prefix-locality routing raises the prefix-cache hit rate. Bound the load per replica so popular prefixes do not create hot spots.",
      },
      {
        type: "mcq",
        prompt: "Where should per-tenant rate limits be enforced, and in what unit?",
        options: ["In the decode kernel, in FLOPs", "At the API gateway, in tokens per second/minute", "At the client, in requests", "In the autoscaler, in replicas"],
        answer: 1,
        explain: "Reject excess at the gateway before it uses queue or KV space, and count tokens: one 100K-token prompt costs as much as hundreds of short requests.",
      },
    ],
  });
})();
