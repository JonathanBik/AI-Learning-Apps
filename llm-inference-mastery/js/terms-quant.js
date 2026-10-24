/* Glossary: quantization formats and parallelism / collectives. */
(function () {
  const { s, fmt } = LIA;
  const P = 70.6e9; // Llama-3-70B parameters
  const KVTOK = 327680; // FP16 KV bytes per token
  const D = 8192; // d_model

  /* ---- numeric helpers (computed, so examples stay honest) ---- */
  // round to the nearest value of a sign/exponent/mantissa float with saturation at `max`
  function roundFP(x, mbits, bias, max) {
    if (x === 0) return 0;
    const sg = Math.sign(x), a = Math.abs(x);
    if (a >= max) return sg * max;
    let e = Math.floor(Math.log2(a));
    e = Math.max(e, 1 - bias);
    const step = Math.pow(2, e - mbits);
    return sg * Math.min(max, Math.round(a / step) * step);
  }
  const e4m3 = (x) => roundFP(x, 3, 7, 448);
  const e2m1 = (x) => roundFP(x, 1, 1, 6);
  const paris = (M) => LIA.toy.embed([M.output[5]])[0];
  const absmax = (v) => Math.max(...v.map(Math.abs));
  const intQ = (v, bits) => { const qmax = 2 ** (bits - 1) - 1, sc = absmax(v) / qmax; return { sc, q: v.map((x) => Math.round(x / sc)), dq: v.map((x) => Math.round(x / sc) * sc), qmax }; };
  const list = (v, d = 2) => v.map((x) => x.toFixed(d)).join(", ");
  const maxErr = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));

  /* ---- small custom visuals ---- */
  const W = 280;
  const t = (x, y, str, o = {}) => s("text", Object.assign({ x, y, "font-size": 10, fill: "var(--ink)" }, o), str);
  /** number line: original values (dots) snapped to a grid of representable values (ticks) */
  function snapLine(grid, vals, snap, o = {}) {
    const sv = LIA.svg(W, 66), lo = o.lo ?? Math.min(...grid), hi = o.hi ?? Math.max(...grid);
    const X = (v) => 10 + ((v - lo) / (hi - lo)) * (W - 20);
    sv.appendChild(s("line", { x1: 10, x2: W - 10, y1: 34, y2: 34, stroke: "var(--line)" }));
    grid.forEach((g) => sv.appendChild(s("line", { x1: X(g), x2: X(g), y1: 28, y2: 40, stroke: o.c || "var(--warn)", "stroke-width": 1.5 })));
    vals.forEach((v) => {
      const q = snap(v);
      sv.appendChild(s("circle", { cx: X(v), cy: 18, r: 3, fill: "var(--accent)" }));
      sv.appendChild(s("line", { x1: X(v), y1: 21, x2: X(q), y2: 31, stroke: "var(--muted)", "stroke-width": 1 }));
    });
    if (o.caption) sv.appendChild(t(10, 60, o.caption, { "font-size": 9.5, fill: "var(--muted)" }));
    return sv;
  }
  /** a row of element cells grouped into blocks, each block with its own scale cell */
  function blocks(n, bs, scaleLabel, caption) {
    const sv = LIA.svg(W, 74), cw = Math.min(8, (W - 10 - (n / bs) * 22) / n);
    let x = 4;
    for (let b = 0; b < n / bs; b++) {
      sv.appendChild(s("rect", { x, y: 14, width: 18, height: 22, rx: 3, fill: "var(--hbm)", opacity: 0.85 }));
      sv.appendChild(t(x + 9, 50, scaleLabel, { "text-anchor": "middle", "font-size": 8.5, fill: "var(--hbm)" }));
      x += 20;
      for (let i = 0; i < bs; i++) sv.appendChild(s("rect", { x: x + i * cw, y: 14, width: cw - 1, height: 22, rx: 1.5, fill: "var(--warn)", opacity: 0.35 + 0.5 * ((i * 7 + b * 3) % 5) / 5 }));
      x += bs * cw + 4;
    }
    sv.appendChild(t(4, 9, "scale", { "font-size": 9, fill: "var(--muted)" }));
    sv.appendChild(t(28, 9, "4-bit elements →", { "font-size": 9, fill: "var(--muted)" }));
    sv.appendChild(t(4, 68, caption, { "font-size": 9.5, fill: "var(--muted)" }));
    return sv;
  }
  /** pipeline Gantt: p stages × m micro-batches, idle cells dashed */
  function gantt(p, m, o = {}) {
    const slots = m + p - 1, cw = Math.min(30, (W - 50) / slots), rh = 15, sv = LIA.svg(W, p * rh + 24);
    for (let st = 0; st < p; st++) {
      sv.appendChild(t(2, 12 + st * rh + 8, `GPU${st}`, { "font-size": 9, fill: "var(--muted)" }));
      for (let k = 0; k < slots; k++) {
        const mb = k - st, busy = mb >= 0 && mb < m;
        sv.appendChild(s("rect", { x: 40 + k * cw, y: 8 + st * rh, width: cw - 2, height: rh - 3, rx: 2, fill: busy ? `hsl(${(mb * 67) % 360} 55% 55%)` : "var(--surface)", stroke: busy ? "none" : "var(--bad)", "stroke-dasharray": busy ? null : "2 2" }));
        if (busy && cw > 16) sv.appendChild(t(40 + k * cw + (cw - 2) / 2, 8 + st * rh + 9.5, `m${mb}`, { "text-anchor": "middle", "font-size": 8, fill: "#fff" }));
      }
    }
    sv.appendChild(t(40, p * rh + 21, o.caption || `bubble = (p−1)/(m+p−1) = ${fmt.pct((p - 1) / (m + p - 1), 0)}`, { "font-size": 9.5, fill: "var(--muted)" }));
    return sv;
  }
  /** expert load bars with a capacity line */
  function loads(vals, cap) {
    const sv = LIA.svg(W, 96), n = vals.length, bw = (W - 20) / n, max = Math.max(cap, ...vals) * 1.1;
    const Y = (v) => 78 - (v / max) * 66;
    vals.forEach((v, i) => {
      const over = cap != null && v > cap;
      sv.appendChild(s("rect", { x: 10 + i * bw + 2, y: Y(Math.min(v, cap ?? v)), width: bw - 4, height: 78 - Y(Math.min(v, cap ?? v)), fill: "var(--compute)", opacity: 0.75 }));
      if (over) sv.appendChild(s("rect", { x: 10 + i * bw + 2, y: Y(v), width: bw - 4, height: Y(cap) - Y(v), fill: "var(--bad)" }));
      sv.appendChild(t(10 + i * bw + bw / 2, 90, `E${i}`, { "text-anchor": "middle", "font-size": 9, fill: "var(--muted)" }));
    });
    if (cap != null) {
      sv.appendChild(s("line", { x1: 8, x2: W - 8, y1: Y(cap), y2: Y(cap), stroke: "var(--bad)", "stroke-dasharray": "4 3" }));
      sv.appendChild(t(W - 10, Y(cap) - 3, "capacity", { "text-anchor": "end", "font-size": 9, fill: "var(--bad)" }));
    }
    return sv;
  }
  /** weight matrix split into column shards across GPUs */
  function shards(n, label) {
    const sv = LIA.svg(W, 92), w = (W - 20) / n;
    for (let i = 0; i < n; i++) {
      sv.appendChild(s("rect", { x: 10 + i * w, y: 8, width: w - 3, height: 56, rx: 3, fill: `hsl(${(i * 47) % 360} 55% 55%)`, opacity: 0.75 }));
      sv.appendChild(t(10 + i * w + (w - 3) / 2, 40, `G${i}`, { "text-anchor": "middle", "font-size": 9.5, fill: "#fff", "font-weight": 600 }));
    }
    sv.appendChild(t(10, 84, label, { "font-size": 9.5, fill: "var(--muted)" }));
    return sv;
  }

  LIA.defineTerms([
    /* ======================= quantization ======================= */
    {
      id: "quantization",
      term: "Quantization",
      aka: ["quantization", "quantized", "quantize", "quantizing"],
      cat: "quant",
      short: "Storing weights (and sometimes activations or KV cache) with fewer bits per number, trading a little accuracy for memory and speed.",
      long: "Each value is mapped to a small set of representable levels with a <b>scale factor</b>, then mapped back (dequantized) when used. Fewer bytes per weight means less HBM to read per decode step, so <b>decode gets faster</b> almost in proportion, and the model fits on fewer GPUs. The engineering question is which tensors to quantize, at what granularity, and how much quality you lose.",
      analogy: "rounding prices to the nearest 10 cents: the receipt is shorter and almost nobody notices.",
      formula: "q = round(x / scale),  x̂ = q × scale",
      example: (M) => `Llama-3-70B weights: FP16 ${fmt.bytes(P * 2, 1)} → FP8 ${fmt.bytes(P, 1)} → INT4 ≈ ${fmt.bytes(P * 0.5, 1)}. Each decode step for our request reads that much less, so TPOT drops roughly 2× and 4×.`,
      viz: (G) => G.curve((x) => Math.round(x * 2) / 2, { x: [-2, 2], y: [-2, 2], color: "var(--warn)", series: [{ fn: (x) => x, color: "var(--muted)", dash: "3 3" }], xl: "real value → nearest level (step 0.5)" }),
      related: ["scale-factor", "fp8", "int4", "ptq", "memory-bound"],
      topic: "q11",
    },
    {
      id: "ptq",
      term: "PTQ",
      aka: ["PTQ", "post-training quantization", "post-training quantisation"],
      cat: "quant",
      short: "Post-training quantization: quantize an already-trained model using a small calibration set, with no retraining.",
      long: "PTQ is what most inference teams use: run a few hundred samples through the model to measure value ranges, pick scales, and write out low-bit weights. It takes minutes to hours instead of a training run. Simple round-to-nearest works well at 8 bits; at 4 bits you need smarter methods such as <b>AWQ</b> or <b>GPTQ</b> to keep quality.",
      analogy: "resizing a finished photo for the web instead of reshooting it at lower resolution.",
      formula: "trained FP16 model + calibration data → scales → low-bit weights",
      example: () => `Taking 70B to FP8 with PTQ shrinks ${fmt.bytes(P * 2, 0)} to ${fmt.bytes(P, 0)} in a single offline pass. No GPU-weeks of training needed.`,
      viz: (G) => G.flow([{ t: "FP16 model", sub: "trained", c: "var(--accent)" }, { t: "calibrate", sub: "~512 samples", c: "var(--warn)" }, { t: "INT4 / FP8", sub: "ship it", c: "var(--good)" }]),
      related: ["qat", "calibration", "awq", "gptq", "quantization"],
      topic: "q11",
    },
    {
      id: "qat",
      term: "QAT",
      aka: ["QAT", "quantization-aware training", "quantisation-aware training"],
      cat: "quant",
      short: "Quantization-aware training: fine-tune the model while simulating low-bit rounding, so it learns to tolerate it.",
      long: "During training, forward passes use “fake-quantized” weights (round, then dequantize), while gradients flow through as if no rounding happened (the straight-through estimator). The model adapts to the rounding noise, so quality at 4 bits or below is usually better than PTQ. The cost is a real training run, its data and its compute.",
      analogy: "practising a speech with the exact time limit you'll have, instead of cutting it down on the day.",
      formula: "forward: ŵ = dequant(quant(w));  backward: ∂L/∂w ≈ ∂L/∂ŵ",
      example: () => "If PTQ to 4 bits costs a few points on your eval suite, a short QAT fine-tune often recovers most of it. The deployed file is the same size either way.",
      viz: (G) => G.flow([{ t: "train", sub: "fake-quant in forward", c: "var(--compute)" }, { t: "adapt", sub: "weights learn noise", c: "var(--warn)" }, { t: "export", sub: "true low-bit", c: "var(--good)" }]),
      related: ["ptq", "quantization", "int4", "nvfp4"],
      topic: "q11",
    },
    {
      id: "fp16",
      term: "FP16",
      aka: ["FP16", "float16", "half precision", "half-precision"],
      cat: "quant",
      short: "16-bit IEEE floating point: 1 sign, 5 exponent and 10 mantissa bits, so 2 bytes per value.",
      long: "FP16 has fine precision (≈ 3 decimal digits) but a narrow range: the largest value is 65,504 and small values underflow below about 6×10⁻⁸. It is the usual baseline for inference weights and KV cache. All the “2 bytes” in this course's memory math (KV cache, weights) assume FP16 or BF16.",
      analogy: "a ruler with fine millimetre marks that is only 65 cm long.",
      formula: "value = (−1)^s × 2^(e−15) × 1.m   ·  max 65,504",
      example: (M) => `Our request's KV cache in FP16: ${M.prompt.length + M.output.length} tokens × 327,680 B = <b>${fmt.bytes((M.prompt.length + M.output.length) * KVTOK, 1)}</b>. The weights take ${fmt.bytes(P * 2, 1)}.`,
      viz: (G) => G.bits([{ n: 1, label: "sign", c: "var(--bad)" }, { n: 5, label: "exponent", c: "var(--accent)" }, { n: 10, label: "mantissa", c: "var(--good)" }]),
      related: ["bf16", "fp8", "exponent-mantissa", "kv-cache"],
      topic: "q11",
    },
    {
      id: "bf16",
      term: "BF16",
      aka: ["BF16", "bfloat16", "brain float"],
      cat: "quant",
      short: "Brain float 16: 1 sign, 8 exponent and 7 mantissa bits. FP32's range at half the size, with less precision.",
      long: "BF16 keeps FP32's exponent, so it covers about ±3.4×10³⁸ and almost never overflows. That is why it became the default for training and serving modern LLMs. It has only ≈ 2–3 significant digits, which is fine for weights and activations. Memory-wise it is the same 2 bytes as FP16.",
      analogy: "a long ruler with coarser marks: you can measure anything, just less finely.",
      formula: "value = (−1)^s × 2^(e−127) × 1.m   ·  max ≈ 3.4×10³⁸",
      example: () => `Llama-3-70B ships in BF16: ${fmt.bytes(P * 2, 1)}, so it needs at least 2 H100s just to hold the weights.`,
      viz: (G) => G.bits([{ n: 1, label: "sign", c: "var(--bad)" }, { n: 8, label: "exponent", c: "var(--accent)" }, { n: 7, label: "mantissa", c: "var(--good)" }]),
      related: ["fp16", "fp8", "exponent-mantissa"],
      topic: "q11",
    },
    {
      id: "fp8",
      term: "FP8",
      aka: ["FP8", "8-bit float", "float8"],
      cat: "quant",
      short: "8-bit floating point (1 byte per value), in two flavours: E4M3 for precision and E5M2 for range.",
      long: "Hopper (H100/H200) and Blackwell tensor cores run FP8 matmuls at about <b>2× the FLOP/s of BF16</b>, and FP8 halves the bytes per weight. Inference usually uses E4M3 for weights and activations, with a per-tensor or per-channel scale. FP8 weights plus FP8 KV cache is the common “nearly free” 2× for decode.",
      analogy: "switching from a 2-page form to a 1-page form that asks the same questions in shorthand.",
      formula: "bytes/param: BF16 2 → FP8 1   ·   tensor-core peak ≈ 2× BF16",
      example: (M) => `70B in FP8: <b>${fmt.bytes(P, 1)}</b>, fits on one H200 (141 GB). Our ${M.prompt.length + M.output.length}-token KV cache drops to ${fmt.bytes((M.prompt.length + M.output.length) * KVTOK / 2, 1)}.`,
      viz: (G) => G.bars([{ label: "BF16", value: P * 2 / 1e9, color: "var(--hbm)" }, { label: "FP8", value: P / 1e9, color: "var(--warn)" }, { label: "INT4", value: P * 0.5 / 1e9, color: "var(--good)" }], { fmt: (v) => fmt.num(v, 0) + " GB", labelW: 48 }),
      related: ["e4m3", "e5m2", "tensor-core", "quantization", "h100"],
      topic: "q11",
    },
    {
      id: "e4m3",
      term: "E4M3",
      aka: ["E4M3"],
      cat: "quant",
      short: "The FP8 variant with 4 exponent and 3 mantissa bits: more precision, maximum ±448.",
      long: "E4M3 has 8 steps per power of two, so relative rounding error is at most about 6%. Its maximum is only 448, so values must be <b>scaled</b> into range first. It is the standard choice for inference weights, activations and KV cache, and it is also the per-block scale format inside NVFP4.",
      analogy: "a short, finely marked ruler: you must zoom (scale) your object to fit, then it measures well.",
      formula: "bias 7 · max 448 · min normal 2⁻⁶ · 3 mantissa bits",
      example: (M) => { const v = paris(M), sc = absmax(v) / 448, dq = v.map((x) => e4m3(x / sc) * sc); return `The toy “ Paris” vector [${list(v)}] in E4M3 (scale ${sc.toExponential(2)}) comes back as [${list(dq, 3)}]. Max error ${maxErr(v, dq).toFixed(3)}.`; },
      viz: (G) => G.bits([{ n: 1, label: "s", c: "var(--bad)" }, { n: 4, label: "exp", c: "var(--accent)" }, { n: 3, label: "man", c: "var(--good)" }]),
      related: ["fp8", "e5m2", "nvfp4", "scale-factor"],
      topic: "q11",
    },
    {
      id: "e5m2",
      term: "E5M2",
      aka: ["E5M2"],
      cat: "quant",
      short: "The FP8 variant with 5 exponent and 2 mantissa bits: huge range (±57,344) but coarse steps.",
      long: "With only 4 steps per power of two, rounding error can reach ~12.5%, but the range rarely overflows. That suits <b>gradients</b> in FP8 training. Inference rarely uses E5M2, because weights and activations have a known range and benefit more from E4M3's extra mantissa bit.",
      analogy: "a very long ruler with only a few marks: nothing is too big for it, but readings are rough.",
      formula: "bias 15 · max 57,344 · 2 mantissa bits",
      example: (M) => { const v = paris(M), dq = v.map((x) => roundFP(x, 2, 15, 57344)); return `Without any scaling, “ Paris” [${list(v)}] in E5M2 becomes [${list(dq, 3)}]: max error ${maxErr(v, dq).toFixed(3)}, coarser than E4M3.`; },
      viz: (G) => G.bits([{ n: 1, label: "s", c: "var(--bad)" }, { n: 5, label: "exp", c: "var(--accent)" }, { n: 2, label: "man", c: "var(--good)" }]),
      related: ["e4m3", "fp8", "exponent-mantissa"],
      topic: "q11",
    },
    {
      id: "int8",
      term: "INT8",
      aka: ["INT8", "int8", "8-bit integer"],
      cat: "quant",
      short: "8-bit integers (−128…127) plus a scale factor: 256 evenly spaced levels.",
      long: "Unlike floats, integer levels are evenly spaced, so one large outlier stretches the scale and wastes resolution for every small value. That makes per-channel or per-group scales important. INT8 weight-only quantization is near-lossless for most LLMs and halves weight memory versus FP16. INT8 tensor cores also run ~2× faster than FP16 on A100/H100.",
      analogy: "a ruler with 256 evenly spaced marks; you choose how long the ruler is.",
      formula: "scale = max|x| / 127,  q = round(x / scale) ∈ [−127, 127]",
      example: (M) => { const v = paris(M), r = intQ(v, 8); return `“ Paris” [${list(v)}] → scale ${r.sc.toFixed(4)} → q = [${r.q.join(", ")}] → back to [${list(r.dq, 3)}], max error ${maxErr(v, r.dq).toFixed(4)}.`; },
      viz: (G) => G.bits([{ n: 1, label: "sign", c: "var(--bad)" }, { n: 7, label: "integer magnitude", c: "var(--warn)" }]),
      related: ["w8a8", "int4", "scale-factor", "calibration"],
      topic: "q11",
    },
    {
      id: "int4",
      term: "INT4",
      aka: ["INT4", "int4", "4-bit integer", "4-bit weights"],
      cat: "quant",
      short: "4-bit integers (16 levels) with a scale per small group of weights: a quarter of FP16's memory.",
      long: "With only 16 levels, one scale per tensor is far too coarse, so INT4 uses a scale per group of 32–128 weights. It is almost always <b>weight-only</b>: weights are unpacked to FP16 inside the matmul kernel. Decode reads ~4× fewer bytes, which is a large TPOT win at small batch. Quality depends heavily on the method (AWQ, GPTQ).",
      analogy: "describing every colour with one of 16 crayons, but choosing a new crayon box for each small patch of the picture.",
      formula: "scale_g = max|x_g| / 7 · bits/weight ≈ 4 + 16/group (FP16 scale)",
      example: (M) => { const v = paris(M), r = intQ(v, 4); return `“ Paris” → q = [${r.q.join(", ")}] (scale ${r.sc.toFixed(3)}) → [${list(r.dq, 2)}], max error <b>${maxErr(v, r.dq).toFixed(3)}</b>, about 20× the INT8 error. 70B at group 128 ≈ ${fmt.bytes(P * (4 + 16 / 128) / 8, 1)}.`; },
      viz: () => snapLine([-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7], [-6.3, -2.6, 0.4, 1.7, 4.45, 6.8], (x) => Math.round(x), { caption: "15 usable levels: every value snaps to the nearest one" }),
      related: ["int8", "awq", "gptq", "block-scaling", "nvfp4"],
      topic: "q11",
    },
    {
      id: "w8a8",
      term: "W8A8",
      aka: ["W8A8", "W4A16", "W8A16", "weight-only quantization"],
      cat: "quant",
      short: "Naming shorthand: W = weight bits, A = activation bits. W8A8 runs the whole matmul in 8-bit.",
      long: "<b>Weight-only</b> schemes (W4A16, W8A16) shrink memory and speed up bandwidth-bound decode, but the math still runs in 16-bit. <b>W8A8</b> (INT8 or FP8) also quantizes activations, so the tensor cores run 8-bit math. That helps compute-bound prefill and large batches. Activations have outliers, so W8A8 needs tricks like SmoothQuant or per-token scales.",
      analogy: "weight-only is shrinking the recipe book; W8A8 also lets the cooks work with smaller pans.",
      formula: "WxAy: x = weight bits, y = activation bits",
      example: (M) => `Prefill of our ${M.prompt.length} tokens is a GEMM. Under W8A8 FP8 it runs on 8-bit tensor cores at ~2× BF16 FLOP/s. Under W4A16 decode reads 4× fewer weight bytes, but prefill math stays BF16.`,
      viz: (G) => G.matmul({ a: [28, 64], b: [64, 64], la: "X (A8)", lb: "W (W8)", lc: "Y", ca: "var(--warn)", cb: "var(--warn)", caption: "both inputs 8-bit → 8-bit tensor cores" }),
      related: ["int8", "fp8", "int4", "prefill", "tensor-core"],
      topic: "q11",
    },
    {
      id: "awq",
      term: "AWQ",
      aka: ["AWQ", "activation-aware weight quantization"],
      cat: "quant",
      short: "Activation-aware weight quantization: protects the ~1% of weight channels that see the largest activations before rounding to 4 bits.",
      long: "AWQ looks at calibration activations to find <b>salient</b> input channels. It multiplies those weight columns by a scale s > 1 (and divides the matching activations by s), so they use more of the INT4 grid and lose less precision. No retraining, no mixed precision: the output file is plain INT4 + scales, and it is fast to produce.",
      analogy: "before shrinking a photo, you enlarge the faces a little so they stay recognisable.",
      formula: "W' = W · diag(s),  X' = X · diag(1/s),  s chosen per channel from activation magnitude",
      example: () => `A 70B AWQ-INT4 checkpoint is ≈ ${fmt.bytes(P * (4 + 16 / 128) / 8, 0)}, so it runs on 1×H100 80 GB, where BF16 needs 2+ GPUs.`,
      viz: (G) => G.bars([0.3, 0.4, 3.2, 0.35, 0.5, 0.45, 2.6, 0.3].map((v, i) => ({ label: `ch${i}`, value: v, color: v > 1 ? "var(--bad)" : "var(--accent)" })), { fmt: (v) => (v > 1 ? "salient" : ""), labelW: 34 }),
      related: ["gptq", "int4", "calibration", "ptq"],
      topic: "q11",
    },
    {
      id: "gptq",
      term: "GPTQ",
      aka: ["GPTQ"],
      cat: "quant",
      short: "A post-training method that quantizes weights one column at a time and adjusts the remaining columns to cancel the rounding error.",
      long: "GPTQ uses second-order information (the Hessian of the layer's output on calibration data) to decide how to compensate. After rounding a column, it nudges the not-yet-quantized columns so the layer's <b>output</b> changes as little as possible. That gives strong 4-bit (even 3-bit) quality in GPU-hours, not days.",
      analogy: "when one tile is cut slightly short, you shift the next tiles so the row still lines up.",
      formula: "for each column j: q_j = round(w_j);  W[:, j+1:] −= (w_j − q_j) · H⁻¹ terms",
      example: () => "Quantizing all ~80 layers of a 70B model with GPTQ typically takes a few GPU-hours on one large GPU. The result loads in vLLM or TensorRT-LLM as INT4 with group scales.",
      viz: (G) => G.flow([{ t: "round col j", c: "var(--warn)" }, { t: "measure error", c: "var(--bad)" }, { t: "fix cols > j", c: "var(--good)" }]),
      related: ["awq", "int4", "ptq", "calibration"],
      topic: "q11",
    },
    {
      id: "nvfp4",
      term: "NVFP4",
      aka: ["NVFP4"],
      cat: "quant",
      short: "NVIDIA's 4-bit float for Blackwell: E2M1 values in blocks of 16, each block with its own FP8 (E4M3) scale.",
      long: "Two-level scaling: a per-tensor FP32 scale puts the tensor in range, then every <b>16 elements</b> share an E4M3 scale. The elements are E2M1 (values 0, 0.5, 1, 1.5, 2, 3, 4, 6). Small blocks plus a fine-grained (non-power-of-two) scale keep error low. Blackwell (B200) tensor cores run it natively, at ~2× FP8 throughput. Storage cost: 4 + 8/16 = <b>4.5 bits per element</b>.",
      analogy: "every group of 16 numbers gets its own magnifying glass, and the glasses come in fine strengths.",
      formula: "x̂ = e2m1 × block_scale(E4M3) × tensor_scale(FP32) · 4.5 bits/elem",
      example: (M) => { const v = paris(M), sc = absmax(v) / 6, dq = v.map((x) => e2m1(x / sc) * sc); return `“ Paris” as one block: scale ${sc.toFixed(3)} → E2M1 codes [${v.map((x) => e2m1(x / sc)).join(", ")}] → [${list(dq, 2)}], max error ${maxErr(v, dq).toFixed(3)}. 70B ≈ ${fmt.bytes(P * 4.5 / 8, 1)}.`; },
      viz: () => blocks(32, 16, "E4M3", "16 × E2M1 per FP8 scale → 4.5 bits / element"),
      related: ["mxfp4", "block-scaling", "e4m3", "b200", "int4"],
      topic: "q11",
    },
    {
      id: "mxfp4",
      term: "MXFP4",
      aka: ["MXFP4", "MX format", "MX formats"],
      cat: "quant",
      short: "The open-standard 4-bit microscaling format: E2M1 values in blocks of 32 sharing a power-of-two (E8M0) scale.",
      long: "Defined by the OCP Microscaling spec. Blocks are twice as large as NVFP4's and the scale can only be a <b>power of two</b>, so it rounds coarser. In exchange it is a bit smaller (4 + 8/32 = 4.25 bits/elem) and vendor-neutral. With outliers in a block, MXFP4 error is typically noticeably higher than NVFP4.",
      analogy: "the same magnifying-glass idea, but each glass covers 32 numbers and only comes in 2×, 4×, 8×… strengths.",
      formula: "x̂ = e2m1 × 2^k (E8M0, shared by 32) · 4.25 bits/elem",
      example: (M) => { const v = paris(M), k = Math.ceil(Math.log2(absmax(v) / 6)), sc = 2 ** k, dq = v.map((x) => e2m1(x / sc) * sc); return `“ Paris” with a power-of-two scale 2^${k} = ${sc}: → [${list(dq, 2)}], max error ${maxErr(v, dq).toFixed(3)}. 70B ≈ ${fmt.bytes(P * 4.25 / 8, 1)}.`; },
      viz: () => blocks(32, 32, "E8M0", "32 × E2M1 per power-of-two scale → 4.25 bits / element"),
      related: ["nvfp4", "block-scaling", "exponent-mantissa"],
      topic: "q11",
    },
    {
      id: "scale-factor",
      term: "Scale factor",
      aka: ["scale factor", "scaling factor", "quantization scale", "absmax"],
      cat: "quant",
      short: "The multiplier that maps real values onto a format's few representable levels, and back again.",
      long: "Pick the scale so the largest magnitude lands at the format's maximum (absmax scaling), or slightly below it to clip rare outliers (percentile scaling). <b>Granularity</b> is the main design choice: one scale per tensor, per channel, per token or per block. Finer granularity means less error but more scale bytes.",
      analogy: "choosing the zoom level on a map so the whole route just fits on the screen.",
      formula: "scale = max|x| / q_max   (INT8: 127, INT4: 7, E4M3: 448, E2M1: 6)",
      example: (M) => { const v = paris(M); return `For “ Paris”, max|x| = ${absmax(v).toFixed(3)}. INT8 scale = ${(absmax(v) / 127).toFixed(4)}, INT4 scale = ${(absmax(v) / 7).toFixed(4)}, E4M3 scale = ${(absmax(v) / 448).toExponential(2)}.`; },
      viz: () => snapLine([-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1], [-0.93, -0.4, 0.12, 0.58, 0.81], (x) => Math.round(x * 4) / 4, { lo: -1.05, hi: 1.05, caption: "scale stretches the grid so max |x| hits the top level" }),
      related: ["quantization", "block-scaling", "calibration", "int8"],
      topic: "q11",
    },
    {
      id: "block-scaling",
      term: "Block scaling",
      aka: ["block scaling", "block-scaled", "microscaling", "per-block scale", "group-wise quantization", "group size"],
      cat: "quant",
      short: "Giving each small block (16–128 values) its own scale, so one outlier only hurts its own block.",
      long: "A single scale per tensor lets one large outlier squash every other value into a few levels. Splitting into blocks localises the damage. The cost is the scale bytes: an 8-bit scale per 16 values adds 0.5 bit per element, and per 128 values only 0.0625. 4-bit formats (INT4 g128, NVFP4, MXFP4) all depend on it.",
      analogy: "adjusting the exposure separately for each part of a photo instead of once for the whole frame.",
      formula: "overhead bits/elem = scale_bits ÷ block_size",
      example: () => `Overhead per weight: NVFP4 8/16 = 0.5 bit, MXFP4 8/32 = 0.25 bit, INT4 g128 with FP16 scales 16/128 = 0.125 bit. On 70B that is ${fmt.bytes(P * 0.5 / 8, 1)}, ${fmt.bytes(P * 0.25 / 8, 1)} and ${fmt.bytes(P * 0.125 / 8, 1)} of scales.`,
      viz: (G) => G.grid(64, { cols: 16, size: 16, color: (i) => (Math.floor(i / 16) % 2 ? "var(--warn)" : "var(--hbm)") }),
      related: ["scale-factor", "nvfp4", "mxfp4", "int4"],
      topic: "q11",
    },
    {
      id: "exponent-mantissa",
      term: "Exponent & mantissa",
      aka: ["mantissa", "exponent bits", "mantissa bits", "significand"],
      cat: "quant",
      short: "The two parts of a float: the exponent sets the scale (power of two), the mantissa sets the precision within it.",
      long: "A float stores sign × 2^(exponent − bias) × 1.mantissa. <b>Exponent bits buy range</b> (how big or small a number can be); <b>mantissa bits buy precision</b> (how many steps between powers of two). Each format splits its bits differently: BF16 trades mantissa for exponent, E4M3 vs E5M2 likewise.",
      analogy: "scientific notation: the exponent is the “× 10ⁿ”, the mantissa is the digits in front.",
      formula: "value = (−1)^s × 2^(E − bias) × (1 + M / 2^mbits)",
      example: () => "E4M3 0 1000 110 = +2^(8−7) × (1 + 6/8) = <b>3.5</b>. E2M1 0 11 1 = 2^(3−1) × 1.5 = <b>6</b> (its maximum).",
      viz: (G) => G.bits([{ n: 1, label: "sign", c: "var(--bad)" }, { n: 4, label: "exponent = range", c: "var(--accent)" }, { n: 3, label: "mantissa = precision", c: "var(--good)" }]),
      related: ["fp16", "bf16", "e4m3", "e5m2"],
      topic: "q11",
    },
    {
      id: "calibration",
      term: "Calibration",
      aka: ["calibration", "calibration set", "calibration data"],
      cat: "quant",
      short: "Running a few hundred representative prompts through the model to measure value ranges before choosing quantization scales.",
      long: "Weights can be scaled from their own values, but <b>activations</b> depend on inputs, so you observe them on sample data. Calibration statistics (absmax, percentiles, per-channel magnitudes) set static scales and also drive AWQ and GPTQ. Unrepresentative data (English-only for a multilingual product, for example) shows up later as quality regressions.",
      analogy: "measuring a room before ordering furniture rather than guessing.",
      formula: "scale = percentile_99.9(|activations on calibration set|) / q_max",
      example: (M) => `Prompts like ours (“${M.user}”) plus code, math and long-context samples, typically 128–512 sequences, are enough to fit scales for every linear layer.`,
      viz: (G) => G.hist((x) => Math.exp(-x * x / 2) + (x > 3.5 ? 0.02 : 0), { x: [0, 5], marks: [{ x: 3.1, label: "p99.9", c: "var(--good)" }, { x: 4.8, label: "absmax", c: "var(--bad)" }], color: "var(--warn)" }),
      related: ["ptq", "scale-factor", "awq", "gptq"],
      topic: "q11",
    },

    /* ======================= parallelism ======================= */
    {
      id: "tensor-parallelism",
      term: "Tensor parallelism",
      aka: ["tensor parallelism", "tensor-parallel", "tensor parallel", "TP"],
      cat: "parallel",
      short: "Splitting every weight matrix across GPUs so they compute each layer together, synchronising with all-reduce.",
      long: "Attention heads and MLP columns are divided across N GPUs (column-split, then row-split). Each GPU holds 1/N of the weights and reads 1/N of the bytes per step, which cuts <b>per-token latency</b>. The price is two all-reduces per layer on the critical path, so TP is kept inside one NVLink domain (usually ≤ 8 GPUs).",
      analogy: "eight people each solving one eighth of every page of a test, comparing notes after each page.",
      formula: "per-GPU weight bytes = total ÷ TP · comm per layer = 2 all-reduces of [tokens × d_model]",
      example: (M) => { const per = 2 * 80 * (2 * 7 / 8) * D * 2; return `70B on TP=8: ${fmt.bytes(P * 2 / 8, 1)} of weights per GPU. Each token triggers 160 all-reduces of 16 KB, ≈ <b>${fmt.bytes(per, 1)}</b> sent per GPU per token, so our ${M.prompt.length}-token prefill moves ${fmt.bytes(per * M.prompt.length, 0)} per GPU.`; },
      viz: () => shards(8, "one weight matrix, column-sharded across 8 GPUs"),
      related: ["all-reduce", "nvlink", "pipeline-parallelism", "expert-parallelism"],
      topic: "q23",
    },
    {
      id: "pipeline-parallelism",
      term: "Pipeline parallelism",
      aka: ["pipeline parallelism", "pipeline-parallel", "pipeline parallel", "PP"],
      cat: "parallel",
      short: "Splitting the model's layers into consecutive stages on different GPUs, passing activations from one stage to the next.",
      long: "Stage 0 holds layers 0–19, stage 1 holds 20–39, and so on. Only one small activation tensor crosses each stage boundary, so PP tolerates slower links and is the usual way to span <b>nodes</b>. A single request still visits stages one after another, so it adds no speed per request. Throughput comes from keeping all stages busy with micro-batches.",
      analogy: "an assembly line: each station does its part and hands the item on.",
      formula: "hand-off per token = d_model × 2 B per boundary",
      example: (M) => `PP=2 across two nodes: after layer 39, each token's ${fmt.bytes(D * 2, 0)} hidden vector crosses InfiniBand. For our ${M.prompt.length}-token prefill that is just ${fmt.bytes(D * 2 * M.prompt.length, 0)}.`,
      viz: (G) => G.flow([{ t: "GPU0", sub: "L0–19", c: "var(--compute)" }, { t: "GPU1", sub: "L20–39", c: "var(--compute)" }, { t: "GPU2", sub: "L40–59", c: "var(--compute)" }, { t: "GPU3", sub: "L60–79", c: "var(--compute)" }]),
      related: ["pipeline-bubble", "micro-batch", "tensor-parallelism", "infiniband"],
      topic: "q23",
    },
    {
      id: "expert-parallelism",
      term: "Expert parallelism",
      aka: ["expert parallelism", "expert-parallel", "EP"],
      cat: "parallel",
      short: "Placing different MoE experts on different GPUs and shipping each token to the GPUs holding its chosen experts.",
      long: "In a mixture-of-experts layer, each token only uses top-k of E experts. EP spreads the experts across GPUs, so the total parameter count can be huge while each GPU stores only its own experts. Every MoE layer needs two <b>all-to-all</b> exchanges (dispatch and combine), and the step runs at the speed of the busiest expert.",
      analogy: "a hospital: patients are routed to the specialists they need, who sit in different rooms.",
      formula: "per token per MoE layer: send k copies of [d_model] out, k back",
      example: () => `A Mixtral-style token (top-2, d_model 4096, BF16) sends 2 × ${fmt.bytes(4096 * 2, 0)} out and gets 2 × ${fmt.bytes(4096 * 2, 0)} back per MoE layer: ${fmt.bytes(4 * 4096 * 2, 0)} of all-to-all traffic.`,
      viz: (G) => G.ring(8, { mode: "star", center: "router", labels: ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"] }),
      related: ["all-to-all", "moe", "expert-load-balance", "capacity-factor"],
      topic: "q23",
    },
    {
      id: "data-parallelism",
      term: "Data parallelism",
      aka: ["data parallelism", "data-parallel", "data parallel", "model replicas", "DP"],
      cat: "parallel",
      short: "Running independent full copies (replicas) of the model, each serving its own share of requests.",
      long: "For inference, DP just means more replicas behind a load balancer. There is no communication between them, so throughput scales linearly, but each replica needs the full weights and its own KV cache. Large MoE deployments also use “attention DP”: attention is replicated per GPU while experts are sharded with EP.",
      analogy: "opening a second checkout lane instead of making one cashier work faster.",
      formula: "throughput ≈ replicas × per-replica throughput · memory = replicas × full model",
      example: (M) => `Two 8×H100 replicas of 70B: the router sends our request to one of them (e.g. by prefix hash), and the other replica never sees “${M.user}”.`,
      viz: (G) => G.grid(16, { cols: 8, size: 26, color: (i) => (i < 8 ? "var(--accent)" : "var(--sram)") }),
      related: ["tensor-parallelism", "expert-parallelism", "cache-aware-routing", "throughput"],
      topic: "q23",
    },
    {
      id: "all-reduce",
      term: "All-reduce",
      aka: ["all-reduce", "allreduce", "all reduce"],
      cat: "parallel",
      short: "A collective where every GPU contributes a tensor and every GPU ends up with the sum of all of them.",
      long: "Tensor parallelism needs it after the row-split matmul in attention and in the MLP: each GPU holds a partial sum of the layer output. The ring algorithm sends 2(N−1)/N of the tensor per GPU, so its bandwidth cost barely grows with N. Latency per hop does grow, which is why small decode all-reduces are latency-bound and often fused or overlapped.",
      analogy: "everyone at a table adds their bill to a running total passed around, then the total is passed around again so all know it.",
      formula: "ring all-reduce bytes per GPU = 2 × (N−1)/N × tensor bytes",
      example: () => `One token's hidden vector (${fmt.bytes(D * 2, 0)} BF16) all-reduced over TP=8: each GPU sends 2 × 7/8 × 16 KB = <b>${fmt.bytes(2 * 7 / 8 * D * 2, 1)}</b>, twice per layer, 80 layers.`,
      viz: (G) => G.ring(8, { mode: "ring", caption: "ring: reduce-scatter, then all-gather" }),
      related: ["tensor-parallelism", "collective", "nvlink", "all-to-all"],
      topic: "q23",
    },
    {
      id: "all-to-all",
      term: "All-to-all",
      aka: ["all-to-all", "all to all", "alltoall"],
      cat: "parallel",
      short: "A collective where every GPU sends a different chunk of data to every other GPU, like a full shuffle.",
      long: "Expert parallelism uses it twice per MoE layer: <b>dispatch</b> sends each token to its experts' GPUs, and <b>combine</b> brings the results back. Traffic is irregular (it depends on the router), crosses nodes, and blocks the layer, so all-to-all is often the main bottleneck of large MoE serving. DeepEP-style kernels and overlapping it with compute are the usual fixes.",
      analogy: "a mail sorting room where every clerk has letters for every other clerk.",
      formula: "bytes sent per GPU ≈ tokens × top_k × d_model × bytes × (N−1)/N",
      example: (M) => `Our ${M.prompt.length}-token prefill on a top-2, 4096-wide MoE: dispatch ≈ ${M.prompt.length} × 2 × ${fmt.bytes(4096 * 2, 0)} = ${fmt.bytes(M.prompt.length * 2 * 4096 * 2, 0)} out, and the same back per MoE layer.`,
      viz: (G) => G.ring(6, { mode: "all", c: "var(--compute)", caption: "every GPU ↔ every GPU" }),
      related: ["expert-parallelism", "moe", "collective", "infiniband"],
      topic: "q23",
    },
    {
      id: "pipeline-bubble",
      term: "Pipeline bubble",
      aka: ["pipeline bubble", "bubble fraction", "pipeline bubbles"],
      cat: "parallel",
      short: "Idle time in pipeline parallelism while stages wait for the first micro-batch to arrive or the last one to drain.",
      long: "With p stages and m micro-batches, each stage is idle for (p−1) of the m+p−1 time slots. More micro-batches shrink the bubble, but in decode the batch is limited by latency and KV memory. That is one reason PP is used mainly to span nodes rather than to speed things up.",
      analogy: "the first workers on an assembly line waiting at the start of the day, the last ones idle at the end.",
      formula: "bubble = (p − 1) / (m + p − 1)",
      example: () => `p = 4 stages, m = 4 micro-batches: bubble = 3/7 = ${fmt.pct(3 / 7, 1)}. With m = 12: 3/15 = ${fmt.pct(3 / 15, 0)}.`,
      viz: () => gantt(4, 4),
      related: ["pipeline-parallelism", "micro-batch", "gpu-utilization"],
      topic: "q23",
    },
    {
      id: "micro-batch",
      term: "Micro-batch",
      aka: ["micro-batch", "microbatch", "micro batch"],
      cat: "parallel",
      short: "A slice of a batch sent through the pipeline separately, so different stages can work on different slices at once.",
      long: "Splitting a batch into m micro-batches lets stage 0 start on slice 2 while stage 1 handles slice 1, filling the pipeline. Smaller slices mean less bubble but smaller (less efficient) matmuls per stage. In serving, engines interleave independent requests' decode steps as micro-batches to keep every stage busy.",
      analogy: "sending dishes out of the kitchen one tray at a time instead of waiting to carry the whole banquet at once.",
      formula: "pipeline time ≈ (m + p − 1) × time per micro-batch per stage",
      example: () => `Same 4 stages with 12 micro-batches: the bubble falls from ${fmt.pct(3 / 7, 0)} to ${fmt.pct(3 / 15, 0)}.`,
      viz: () => gantt(4, 8, { caption: "8 micro-batches → bubble 3/11 = 27%" }),
      related: ["pipeline-bubble", "pipeline-parallelism", "batch-size"],
      topic: "q23",
    },
    {
      id: "capacity-factor",
      term: "Capacity factor",
      aka: ["capacity factor", "expert capacity"],
      cat: "parallel",
      short: "A cap on how many tokens each MoE expert accepts per batch, as a multiple of a perfectly even share.",
      long: "Capacity = CF × tokens × top_k ÷ experts. Tokens routed to a full expert are <b>dropped</b> (passed through the residual only) or rerouted. Training uses CF ≈ 1.0–1.25 to bound memory and time. Inference engines usually avoid dropping tokens (it changes outputs) and absorb the imbalance as extra latency instead.",
      analogy: "each specialist sees at most 1.25× an average day's patients; the overflow is turned away.",
      formula: "capacity = ⌈CF × tokens × k / E⌉",
      example: (M) => `Our ${M.prompt.length} prompt tokens, top-2 of 8 experts, CF 1.25: capacity = ⌈1.25 × ${M.prompt.length} × 2 / 8⌉ = <b>${Math.ceil(1.25 * M.prompt.length * 2 / 8)}</b> tokens per expert.`,
      viz: () => loads([6, 9, 4, 12, 7, 5, 8, 5], 9),
      related: ["expert-load-balance", "expert-parallelism", "moe", "router"],
      topic: "q23",
    },
    {
      id: "expert-load-balance",
      term: "Expert load balance",
      aka: ["load imbalance", "expert imbalance", "load balancing loss", "expert load balance", "hot expert", "hot experts"],
      cat: "parallel",
      short: "How evenly the router spreads tokens across experts. Imbalance makes everyone wait for the busiest expert.",
      long: "Under expert parallelism the MoE layer finishes only when the most-loaded GPU does, so efficiency ≈ mean load ÷ max load. Training adds an auxiliary <b>load-balancing loss</b>, but real traffic is still skewed (code prompts hit “code” experts). Serving systems replicate hot experts and rebalance placement, as in DeepSeek's EPLB.",
      analogy: "a group project that finishes only when the slowest member hands in their part.",
      formula: "EP efficiency ≈ mean(load) / max(load)",
      example: () => `Loads [210, 220, 133, 131, 414, 409, 273, 258] tokens over 8 experts: mean 256, max 414, so efficiency = <b>${fmt.pct(256 / 414, 0)}</b>.`,
      viz: () => loads([210, 220, 133, 131, 414, 409, 273, 258], null),
      related: ["capacity-factor", "expert-parallelism", "router", "moe"],
      topic: "q23",
    },
    {
      id: "collective",
      term: "Collective communication",
      aka: ["collective communication", "collective", "NCCL", "collective op", "collective ops"],
      cat: "parallel",
      short: "Coordinated data exchanges in which a group of GPUs all participate, such as all-reduce, all-gather and all-to-all.",
      long: "Libraries like <b>NCCL</b> pick ring or tree algorithms that use NVLink inside a node and InfiniBand/RoCE across nodes. Collectives are synchronising: every GPU waits until all have arrived. One slow GPU or link therefore stalls the whole group, and collectives are a top suspect in profiles of multi-GPU inference.",
      analogy: "a conference call where nobody can hang up until everyone has spoken.",
      formula: "all-reduce = reduce-scatter + all-gather · all-gather out = N × shard",
      example: () => "One 70B decode step on TP=8 issues 160 all-reduces (2 per layer × 80 layers). At ~10 µs latency each that is ~1.6 ms of a ~10 ms step, which is why custom one-shot all-reduce kernels matter.",
      viz: (G) => G.ring(4, { mode: "all", caption: "everyone participates, everyone waits" }),
      related: ["all-reduce", "all-to-all", "nvlink", "infiniband"],
      topic: "q23",
    },
  ]);
})();
