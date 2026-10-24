/* Module 1 worked examples: the mocked request (LIA.MOCK) traced through Q1, Q3, Q4, Q5.
   Attention numbers come from LIA.toy (d_model 8, d_head 4) so every value shown is actually computed. */
(function () {
  const { h, s, fmt } = LIA;
  const tk = (x) => LIA.showTok(x.t);
  const qLabels = (toks) => toks.map(tk);

  /* ---------------- Q1 · request lifecycle ---------------- */
  LIA.topics.q1.trace = (M) => {
    const Q = M.question; // "What is the capital of France?" — 7 tokens
    const att = LIA.toy.attention(Q, 0);
    const rows = qLabels(Q);
    const dcols = (n, p = "d") => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const temp = M.request.temperature, topP = M.request.top_p;
    const probs = LIA.toy.softmax(M.candidates.map((c) => c.logit), temp);
    let cum = 0;
    const kept = probs.map((p) => { const keep = cum < topP; cum += p; return keep; });
    const keptMass = probs.reduce((a, p, i) => a + (kept[i] ? p : 0), 0);
    const u = 0.31; // mocked uniform draw
    let acc = 0, pick = 0;
    for (let i = 0; i < probs.length; i++) { if (!kept[i]) continue; acc += probs[i] / keptMass; if (u <= acc) { pick = i; break; } }
    const kvBytes = (n) => fmt.bytes(n * M.model.kvBytesPerToken, 2);

    const probBars = (vals, opts = {}) => {
      const W = 330, rowH = 22, sv = LIA.svg(W, vals.length * rowH + 4, { "aria-label": "Candidate tokens" });
      const max = Math.max(...vals.map((v) => v.v));
      vals.forEach((v, i) => {
        const y = 2 + i * rowH;
        sv.appendChild(s("text", { x: 62, y: y + 15, "text-anchor": "end", "font-size": 11.5, fill: v.dim ? "var(--muted)" : "var(--ink)" }, v.label));
        sv.appendChild(s("rect", { x: 68, y: y + 3, width: Math.max(1, (v.v / max) * 190), height: rowH - 7, rx: 3, fill: v.color || "var(--accent)", opacity: v.dim ? 0.25 : 0.85 }));
        sv.appendChild(s("text", { x: 72 + (v.v / max) * 190, y: y + 15, "font-size": 11, fill: "var(--ink)" }, opts.fmt ? opts.fmt(v.v) : v.v.toFixed(2)));
      });
      return sv;
    };

    return [
      {
        k: "HTTP request",
        op: "parse + validate",
        where: "API server · CPU",
        inLabel: "Raw POST body",
        input: () => LIA.blob(LIA.esc(JSON.stringify(M.request, null, 2))),
        outLabel: "Validated request object",
        output: () => LIA.kv([["request_id", M.id], ["model", M.request.model], ["messages", "2 (system, user)"], ["stream", "true → reply as SSE"], ["sampling", `temperature ${temp}, top_p ${topP}`], ["max_tokens", M.request.max_tokens]]),
        note: "Nothing touches the GPU yet. Bad JSON, unknown model or a rate-limit hit is rejected here in about a millisecond.",
      },
      {
        k: "Chat template",
        op: "apply_chat_template",
        where: "API server · CPU",
        inLabel: "messages[]",
        input: () => LIA.blob(M.request.messages.map((m) => `<span class="dim">${m.role}:</span> ${LIA.esc(m.content)}`).join("\n")),
        outLabel: "One flat string",
        output: () => LIA.blob(LIA.esc(M.templated).replace(/(&lt;\|[a-z_]+\|&gt;)/g, '<span class="sp">$1</span>').replace(/\n/g, '<span class="dim">⏎</span>\n')),
        note: "The model only ever sees text. Roles become special header tokens, and the string ends with an open <code>assistant</code> header so the model's next words are the answer.",
      },
      {
        k: "Tokenize",
        op: "BPE encode",
        where: "tokenizer · CPU",
        inLabel: `String (${M.templated.length} characters)`,
        input: () => LIA.blob(LIA.esc(M.templated).replace(/\n/g, "⏎")),
        outLabel: `${M.prompt.length} token IDs`,
        output: () => LIA.tokens(M.prompt),
        note: `${M.prompt.length} tokens. Violet chips are special tokens; ␣ marks a leading space and ⏎ a newline. Words map to one ID each here; rarer words would split into several pieces.`,
      },
      {
        k: "Embed",
        op: "table lookup E[id]",
        where: "GPU · layer 0",
        inLabel: "Token IDs (question span)",
        input: () => LIA.tokens(Q),
        outLabel: "X: one vector per token",
        output: () => h("div", null, LIA.matrix(att.X, { rows, cols: dcols(8), diverge: true, color: "var(--accent)", caption: "toy d_model = 8 (Llama-3-70B uses 8,192)" })),
        note: "Each ID selects one row of the 128,256 × 8,192 embedding table. From here on the request is a matrix. We follow just the 7 question tokens so the numbers stay readable; the real prefill carries all 28.",
      },
      {
        k: "Q, K, V projections",
        op: "X·W_q, X·W_k, X·W_v",
        where: "GPU · GEMM",
        inLabel: "X [7 × 8]",
        input: () => LIA.matrix(att.X, { rows, d: 1, diverge: true, color: "var(--accent)" }),
        outLabel: "Q (head 0), K, V  [7 × 4] each",
        output: () => h("div", { class: "stage", style: { gap: "6px" } },
          LIA.matrix(att.Q, { rows, cols: dcols(4, "q"), d: 2, diverge: true, color: "var(--compute)", caption: "Q · head 0" }),
          LIA.matrix(att.K, { rows, cols: dcols(4, "k"), d: 2, diverge: true, color: "var(--hbm)", caption: "K · the KV head shared by query heads 0 and 1 (GQA)" }),
          LIA.matrix(att.V, { rows, cols: dcols(4, "v"), d: 2, diverge: true, color: "var(--hbm)", caption: "V" })),
        note: "This is the matrix-matrix work that makes prefill compute-bound: all tokens hit each weight at once. K and V (amber) are what the KV cache will keep.",
      },
      {
        k: "Scores QKᵀ/√d",
        op: "Q·Kᵀ / √4 + causal mask",
        where: "GPU · attention kernel",
        inLabel: "Q [7×4] and K [7×4]",
        input: () => h("div", { class: "stage", style: { gap: "6px" } }, LIA.matrix(att.Q, { rows, d: 2, diverge: true, color: "var(--compute)", caption: "Q" }), LIA.matrix(att.K, { rows, d: 2, diverge: true, color: "var(--hbm)", caption: "K" })),
        outLabel: "S [7 × 7]",
        output: () => LIA.matrix(att.S, { rows, cols: rows, d: 2, diverge: true, color: "var(--compute)", caption: "row = query token, column = key token. −∞ = future token (masked)" }),
        note: "Each token scores every earlier token. The upper triangle is masked so <code>What</code> cannot see <code>France</code>; that is what makes generation causal.",
      },
      {
        k: "Softmax",
        op: "row-wise softmax",
        where: "GPU · attention kernel",
        inLabel: "S [7 × 7]",
        input: () => LIA.matrix(att.S, { rows, d: 1, diverge: true, color: "var(--compute)" }),
        outLabel: "P: attention weights (rows sum to 1)",
        output: () => LIA.matrix(att.P, { rows, cols: rows, d: 2, color: "var(--sram)", strength: 80, highlight: (i) => i === 6, caption: "outlined row: where “?” looks" }),
        note: "Masked entries become exactly 0. With FlashAttention this matrix never exists in HBM; it is produced tile by tile in SRAM (see Q5).",
      },
      {
        k: "Weighted sum P·V",
        op: "P · V",
        where: "GPU · attention kernel",
        inLabel: "P [7×7] and V [7×4]",
        input: () => h("div", { class: "stage", style: { gap: "6px" } }, LIA.matrix(att.P, { rows, d: 2, color: "var(--sram)", strength: 80 }), LIA.matrix(att.V, { rows, d: 2, diverge: true, color: "var(--hbm)", caption: "V" })),
        outLabel: "O [7 × 4] → output projection, MLP, next layer",
        output: () => h("div", null, LIA.matrix(att.O, { rows, cols: dcols(4, "o"), d: 2, diverge: true, color: "var(--accent)" }), LIA.caption("Repeated for 64 query heads, then the MLP, then 79 more layers.")),
        note: "Every token now carries context from the tokens before it. After the last layer, only the final position's vector is needed to predict the next token.",
      },
      {
        k: "Write KV cache",
        op: "store K, V · 80 layers",
        where: "GPU · HBM (paged)",
        inLabel: "K and V for every prompt token",
        input: () => h("div", null, LIA.tokens(M.prompt, { ids: false, cls: () => "out" }), LIA.caption("28 tokens × 80 layers × 8 KV heads × 128 dims × (K+V) × 2 B")),
        outLabel: "KV cache for this request",
        output: () => LIA.kv([["per token", "327,680 B (320 KiB)"], ["28 prompt tokens", kvBytes(28)], ["vLLM blocks (16 tok)", "2 blocks · 32 slots · 4 free"], ["reserved", kvBytes(32)]]),
        note: "This is why decode is cheap in FLOPs: the prompt's K and V never get recomputed. Each new token only computes its own K, V and reads the rest from here.",
      },
      {
        k: "Logits",
        op: "LM head · h_last · Wᵀ",
        where: "GPU · GEMV",
        inLabel: "Final hidden vector of the last token",
        input: () => h("div", null, LIA.tokens([M.prompt[M.prompt.length - 1]], { cls: () => "hl" }), LIA.caption("the ⏎⏎ after the assistant header: an [1 × 8192] vector")),
        outLabel: "Logits over 128,256 tokens (top 7, mocked)",
        output: () => probBars(M.candidates.map((c) => ({ label: LIA.showTok(c.t), v: c.logit, color: "var(--compute)" })), { fmt: (v) => v.toFixed(1) }),
        note: "One score per vocabulary entry. Only the highest few matter; the long tail has almost no probability.",
      },
      {
        k: "Sample",
        op: `softmax(T=${temp}) → top-p ${topP}`,
        where: "GPU · sampler",
        inLabel: "Logits",
        input: () => probBars(M.candidates.map((c) => ({ label: LIA.showTok(c.t), v: c.logit, color: "var(--compute)" })), { fmt: (v) => v.toFixed(1) }),
        outLabel: `Probabilities → nucleus → draw u = ${u}`,
        output: () => h("div", null,
          probBars(M.candidates.map((c, i) => ({ label: LIA.showTok(c.t), v: probs[i], dim: !kept[i], color: i === pick ? "var(--good)" : "var(--accent)" })), { fmt: (v) => fmt.pct(v, 1) }),
          LIA.caption(`Top-p keeps the smallest set reaching ${fmt.pct(topP)} (${kept.filter(Boolean).length} tokens, ${fmt.pct(keptMass, 1)}), renormalizes, then draws. Picked: <b>${LIA.esc(LIA.showTok(M.candidates[pick].t))}</b>`)),
        note: "Dividing logits by T = 0.7 sharpens the distribution. The faded tokens fell outside the nucleus and cannot be picked.",
      },
      {
        k: "First token out",
        op: "detokenize + SSE flush",
        where: "API server · network",
        inLabel: `Token ID ${M.output[0].id}`,
        input: () => LIA.tokens([M.output[0]], { cls: () => "good" }),
        outLabel: "Bytes on the wire",
        output: () => LIA.blob(LIA.esc(`data: {"id":"${M.id}","choices":[{"index":0,"delta":{"role":"assistant","content":"The"}}]}\n\n`)),
        note: "The client sees its first text here. <b>TTFT</b> = parse + tokenize + queue + prefill + sample + this flush.",
      },
      {
        k: "Decode loop",
        op: "1 token / step · GEMV",
        where: "GPU · repeated",
        inLabel: "Previous token + KV cache",
        input: () => h("div", null, LIA.tokens([M.output[0]], { cls: () => "hl" }), LIA.caption(`reads all 140 GB of weights + ${kvBytes(29)} of KV, to compute [1 × 8192] vectors`)),
        outLabel: "Seven more steps until <|eot_id|>",
        output: () => h("div", { class: "stage", style: { gap: "4px" } },
          M.output.map((_, n) => h("div", { class: "row", style: { gap: "6px", alignItems: "center" } },
            h("span", { class: "pill" }, `step ${n + 1}`),
            LIA.tokens(M.output.slice(0, n + 1), { ids: false, cls: (x, i) => (i === n ? "out" : "") }),
            h("span", { class: "caption" }, `KV ${kvBytes(28 + n + 1)}`)))),
        note: "Each step adds one token and 320 KiB of KV. Generation stops at <code>&lt;|eot_id|&gt;</code> (or max_tokens). TPOT is the time per one of these rows.",
      },
    ];
  };

  /* ---------------- Q3 · KV cache sizing ---------------- */
  LIA.topics.q3.trace = (M) => {
    const m = M.model, B = M.model.kvBytesPerToken;
    const all = M.prompt.concat(M.output);
    const tensorBox = (label, dims, color) => h("div", { class: "row", style: { gap: "8px", alignItems: "center" } }, h("span", { class: "pill", style: { borderColor: color, color } }, label), h("span", { class: "mono" }, dims));
    return [
      {
        k: "Count tokens",
        op: "prompt + generated",
        where: "scheduler",
        input: () => h("div", { class: "stage", style: { gap: "6px" } }, LIA.tokens(M.prompt, { ids: false }), LIA.tokens(M.output, { ids: false, cls: () => "out" })),
        output: () => LIA.kv([["prompt tokens", M.prompt.length], ["generated tokens", M.output.length], ["total cached", all.length]]),
        note: "Every token in the context, prompt and output alike, keeps one K and one V vector per layer per KV head.",
      },
      {
        k: "One token, one layer",
        op: "K and V heads",
        where: "1 layer",
        inLabel: "Token “ Paris” at layer 0",
        input: () => LIA.tokens([M.output[5]], { cls: () => "out" }),
        output: () => h("div", { class: "stage", style: { gap: "6px" } },
          tensorBox("K", `[${m.Hkv} heads × ${m.dHead}] × 2 B = ${fmt.num(m.Hkv * m.dHead * 2)} B`, "var(--hbm)"),
          tensorBox("V", `[${m.Hkv} heads × ${m.dHead}] × 2 B = ${fmt.num(m.Hkv * m.dHead * 2)} B`, "var(--hbm)"),
          LIA.caption(`= ${fmt.num(2 * m.Hkv * m.dHead * 2)} B per layer. Only 8 KV heads, not 64 (GQA).`)),
        note: "With multi-head attention it would be 64 heads: 8× more for exactly the same token.",
      },
      {
        k: "× 80 layers",
        op: `× L = ${m.L}`,
        where: "whole model",
        input: () => h("span", { class: "mono" }, "4,096 B per layer"),
        output: () => h("div", null, h("div", { class: "stat" }, h("span", { class: "k" }, "per token"), h("span", { class: "v" }, `${fmt.num(B)} B`)), LIA.caption("= 320 KiB for every single token")),
        note: "This 327,680 B is the number to memorize for Llama-3-70B in FP16.",
      },
      {
        k: "This request",
        op: `× ${all.length} tokens`,
        where: "one sequence",
        input: () => LIA.tokens(all, { ids: false, sub: () => "320K", cls: (x, i) => (i >= M.prompt.length ? "out" : "") }),
        output: () => LIA.kv([["exact", `${fmt.num(all.length * B)} B`], ["≈", fmt.bytes(all.length * B, 2)], ["in 16-token blocks", `${Math.ceil(all.length / 16)} blocks = ${fmt.bytes(Math.ceil(all.length / 16) * 16 * B, 2)}`]]),
        note: "A short chat costs about 12 MB. Tiny next to 141 GB of weights, which is why short-context serving batches so well.",
      },
      {
        k: "Grow to 32K context",
        op: "× 32,768 tokens",
        where: "long-context user",
        input: () => h("span", { class: "mono" }, `${fmt.bytes(all.length * B, 2)} at ${all.length} tokens`),
        output: () => LIA.kv([["per request", fmt.bytes(32768 * B, 2)], ["vs. this chat", `${fmt.num(32768 / all.length, 0)}× more`]]),
        note: "Same user, a long document pasted in: KV grows linearly with context.",
      },
      {
        k: "× 100 users",
        op: "× U = 100",
        where: "the whole replica",
        input: () => h("span", { class: "mono" }, `${fmt.bytes(32768 * B, 2)} per user`),
        output: () => h("div", null, LIA.hbar({ width: 340, labelW: 96, valW: 70, rowH: 26, max: 1300e9, rows: [{ label: "KV, 100 users", value: 100 * 32768 * B, color: "var(--hbm)" }, { label: "8×H100 HBM", value: 640e9, color: "var(--line)" }], fmt: (v) => fmt.bytes(v, 0) }), LIA.caption("1,073.7 GB = 1,000 GiB: more than the entire node.")),
        note: "This is the kickoff answer to Q3. Open the lab above to see which knobs (FP8 KV, fewer users, bigger GPUs) make it fit.",
      },
    ];
  };

  /* ---------------- Q4 · PagedAttention ---------------- */
  LIA.topics.q4.trace = (M) => {
    const BS = 16, NPHYS = 16;
    // mocked allocator state: physical blocks already used by other requests
    const busy = new Set([0, 1, 2, 4, 6, 7, 8, 10, 11, 13]);
    const freeList = [12, 3, 9, 5, 14, 15];
    const memStrip = (mine, fill, opts = {}) => {
      const cell = 21, sv = LIA.svg(NPHYS * cell + 4, 58, { "aria-label": "Physical KV blocks" });
      for (let b = 0; b < NPHYS; b++) {
        const x = 2 + b * cell;
        const idx = mine.indexOf(b);
        const own = idx >= 0;
        const shared = opts.shared && opts.shared.includes(b);
        sv.appendChild(s("rect", { x, y: 4, width: cell - 3, height: 30, rx: 3, fill: own ? "var(--accent-soft)" : busy.has(b) && !(opts.freed || []).includes(b) ? "var(--line)" : "var(--surface)", stroke: own ? "var(--accent)" : "var(--line)" }));
        if (own) {
          const hgt = (30 * (fill[idx] || 0)) / BS;
          sv.appendChild(s("rect", { x, y: 34 - hgt, width: cell - 3, height: hgt, rx: 3, fill: shared ? "var(--sram)" : "var(--accent)", opacity: 0.8 }));
        }
        sv.appendChild(s("text", { x: x + (cell - 3) / 2, y: 50, "text-anchor": "middle", "font-size": 9.5, fill: own ? "var(--accent)" : "var(--muted)" }, b));
      }
      return sv;
    };
    const table = (rows) => LIA.matrix(rows.map((r) => [r[1], r[2]]), { rows: rows.map((r) => `logical ${r[0]}`), cols: ["physical", "filled"], d: 0, color: "var(--accent)", strength: 25 });
    return [
      {
        k: "Admit prompt",
        op: `⌈28 / ${BS}⌉ = 2 blocks`,
        where: "scheduler",
        inLabel: "28 prompt tokens",
        input: () => LIA.tokens(M.prompt, { ids: false, cls: (x, i) => (i < 16 ? "hl" : "") }),
        outLabel: "Pop 2 blocks from the free list",
        output: () => h("div", null, LIA.kv([["free list", `[${freeList.join(", ")}]`], ["taken", "12, 3"]]), memStrip([12, 3], [16, 12])),
        note: "The blocks don't need to be adjacent: 12 and 3 are far apart. Grey blocks belong to other requests.",
      },
      {
        k: "Block table",
        op: "logical → physical",
        where: "per request",
        input: () => LIA.tokens(M.prompt, { ids: false, sub: (x, i) => `b${Math.floor(i / BS)}`, cls: (x, i) => (i < 16 ? "hl" : "") }),
        output: () => table([[0, 12, "16/16"], [1, 3, "12/16"]]),
        note: "Tokens 0–15 live in physical block 12, tokens 16–27 in block 3. The attention kernel follows this table to find K and V.",
      },
      {
        k: "Decode fills block",
        op: "4 tokens → slots 12–15",
        where: "decode steps 1–4",
        inLabel: "New tokens",
        input: () => LIA.tokens(M.output.slice(0, 4), { cls: () => "out" }),
        output: () => h("div", null, table([[0, 12, "16/16"], [1, 3, "16/16"]]), memStrip([12, 3], [16, 16])),
        note: "No allocation needed: the last block had 4 free slots.",
      },
      {
        k: "Block full → allocate",
        op: "pop free list → 9",
        where: "decode step 5",
        inLabel: "Token 33: “ is”",
        input: () => LIA.tokens([M.output[4]], { cls: () => "out" }),
        output: () => h("div", null, table([[0, 12, "16/16"], [1, 3, "16/16"], [2, 9, "1/16"]]), memStrip([12, 3, 9], [16, 16, 1])),
        note: "Memory grows one block at a time, only when needed. A contiguous allocator would have reserved max_tokens up front.",
      },
      {
        k: "Finish",
        op: "<|eot_id|> → free",
        where: "decode step 8",
        inLabel: "36 tokens in 3 blocks",
        input: () => h("div", null, LIA.tokens(M.output.slice(4), { cls: () => "out" }), LIA.caption("block 9: 4 of 16 slots used → 12 slots of waste")),
        outLabel: "Blocks back on the free list",
        output: () => h("div", null, LIA.kv([["returned", "12, 3, 9"], ["waste while running", `12 slots = ${fmt.bytes(12 * M.model.kvBytesPerToken, 1)} (< 1 block)`]]), memStrip([], [], { freed: [] })),
        note: "Worst-case waste is under one block per request. Compare the contiguous pane in the lab above.",
      },
      {
        k: "Prefix sharing",
        op: "hash match → refcount 2",
        where: "second request",
        inLabel: "Another user, same system prompt",
        input: () => h("div", null, LIA.tokens(M.prompt.slice(0, 16), { ids: false, cls: () => "hit" }), LIA.caption("tokens 0–15 are identical: system prompt + user header")),
        output: () => h("div", null, table([[0, 12, "shared ×2"], [1, 5, "own"]]), memStrip([12, 5], [16, 12], { shared: [12] })),
        note: "Block 12 is reused, not copied. Its KV is never recomputed, which is the basis of prefix caching (Q8).",
      },
    ];
  };

  /* ---------------- Q5 · FlashAttention (online softmax over tiles) ---------------- */
  LIA.topics.q5.trace = (M) => {
    const Q = M.question, att = LIA.toy.attention(Q, 0);
    const rows = [4, 5, 6]; // " of", " France", "?" — one Q tile
    const tiles = [[0, 1, 2, 3], [4, 5, 6]];
    const rl = rows.map((r) => LIA.showTok(Q[r].t));
    const colsOf = (t) => t.map((j) => LIA.showTok(Q[j].t));
    // run online softmax, keeping every intermediate
    let m = rows.map(() => -Infinity), l = rows.map(() => 0), O = rows.map(() => [0, 0, 0, 0]);
    const snaps = [];
    tiles.forEach((cols) => {
      const S = rows.map((r) => cols.map((j) => att.S[r][j]));
      const mNew = rows.map((_, i) => Math.max(m[i], ...S[i].filter(isFinite)));
      const scale = rows.map((_, i) => (m[i] === -Infinity ? 0 : Math.exp(m[i] - mNew[i])));
      const Pt = S.map((row, i) => row.map((v) => (isFinite(v) ? Math.exp(v - mNew[i]) : 0)));
      const lNew = rows.map((_, i) => l[i] * scale[i] + Pt[i].reduce((a, b) => a + b, 0));
      const ONew = rows.map((_, i) => [0, 1, 2, 3].map((d) => O[i][d] * scale[i] + Pt[i].reduce((a, p, k) => a + p * att.V[cols[k]][d], 0)));
      snaps.push({ cols, S, mOld: m, mNew, scale, Pt, lNew, ONew });
      m = mNew; l = lNew; O = ONew;
    });
    const final = O.map((row, i) => row.map((v) => v / l[i]));
    const ref = rows.map((r) => att.O[r]);
    const stats = (sn) => LIA.matrix(rows.map((_, i) => [sn.mOld[i], sn.mNew[i], sn.scale[i], sn.lNew[i]]), { rows: rl, cols: ["m old", "m new", "e^(Δm)", "ℓ"], d: 3, color: "var(--sram)", strength: 30 });
    return [
      {
        k: "Load Q tile",
        op: "HBM → SRAM",
        where: "one thread block",
        inLabel: "Q rows for “ of”, “ France”, “?”",
        input: () => LIA.matrix(rows.map((r) => att.Q[r]), { rows: rl, d: 2, diverge: true, color: "var(--hbm)", caption: "read from HBM once" }),
        outLabel: "Running state in SRAM",
        output: () => LIA.matrix(rows.map(() => ["−∞", 0, "0, 0, 0, 0"]), { rows: rl, cols: ["m", "ℓ", "O (unnormalized)"], fmt: (v) => String(v), color: "var(--sram)", strength: 0 }),
        note: "Each query row keeps three things on-chip: running max m, running sum ℓ, and a partial output O.",
      },
      {
        k: "Tile 1 scores",
        op: "Q·K₁ᵀ/√d in SRAM",
        where: "K/V tile 1 streamed in",
        inLabel: "K tile 1: “What … capital”",
        input: () => LIA.matrix(tiles[0].map((j) => att.K[j]), { rows: colsOf(tiles[0]), d: 2, diverge: true, color: "var(--hbm)" }),
        outLabel: "S tile [3 × 4] (never written to HBM)",
        output: () => LIA.matrix(snaps[0].S, { rows: rl, cols: colsOf(tiles[0]), d: 2, diverge: true, color: "var(--sram)" }),
        note: "A 3×4 piece of the score matrix exists only in SRAM, for a few microseconds.",
      },
      {
        k: "Tile 1 softmax state",
        op: "m = max, ℓ = Σe^(s−m)",
        where: "registers",
        input: () => LIA.matrix(snaps[0].S, { rows: rl, d: 2, diverge: true, color: "var(--sram)" }),
        output: () => h("div", { class: "stage", style: { gap: "6px" } }, stats(snaps[0]), LIA.matrix(snaps[0].ONew, { rows: rl, cols: ["o0", "o1", "o2", "o3"], d: 3, diverge: true, color: "var(--accent)", caption: "O += e^(s−m) · V₁ (still unnormalized)" })),
        note: "No division yet: we don't know the full row sum until every tile has been seen.",
      },
      {
        k: "Tile 2 scores",
        op: "Q·K₂ᵀ/√d + causal mask",
        where: "K/V tile 2 streamed in",
        inLabel: "K tile 2: “ of”, “ France”, “?”",
        input: () => LIA.matrix(tiles[1].map((j) => att.K[j]), { rows: colsOf(tiles[1]), d: 2, diverge: true, color: "var(--hbm)" }),
        output: () => LIA.matrix(snaps[1].S, { rows: rl, cols: colsOf(tiles[1]), d: 2, diverge: true, color: "var(--sram)", caption: "−∞: “ of” cannot see “ France” or “?”" }),
        note: "The previous S tile is already gone. SRAM holds only the current tile plus the running state.",
      },
      {
        k: "Rescale + merge",
        op: "ℓ·e^(m_old−m_new) + Σ",
        where: "registers",
        input: () => stats(snaps[0]),
        output: () => h("div", { class: "stage", style: { gap: "6px" } }, stats(snaps[1]), LIA.matrix(snaps[1].ONew, { rows: rl, cols: ["o0", "o1", "o2", "o3"], d: 3, diverge: true, color: "var(--accent)" })),
        note: "Where the new tile raised the max, e^(Δm) < 1 shrinks the old sum and old O so everything shares one reference max. This is the online-softmax trick.",
      },
      {
        k: "Normalize + write",
        op: "O / ℓ → HBM",
        where: "end of kernel",
        inLabel: "Flash result",
        input: () => LIA.matrix(final, { rows: rl, cols: ["o0", "o1", "o2", "o3"], d: 4, diverge: true, color: "var(--accent)" }),
        outLabel: "Standard attention (full P·V), for comparison",
        output: () => h("div", null, LIA.matrix(ref, { rows: rl, cols: ["o0", "o1", "o2", "o3"], d: 4, diverge: true, color: "var(--accent)" }),
          LIA.caption(`max difference: ${Math.max(...final.flatMap((r, i) => r.map((v, d) => Math.abs(v - ref[i][d])))).toExponential(1)} → identical up to float rounding ✓`)),
        note: "Only 3 × 4 output values were written to HBM. Standard attention would have written and re-read the 3 × 7 slice of S and of P as well.",
      },
    ];
  };
})();
