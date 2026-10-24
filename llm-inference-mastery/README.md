# LLM Inference Mastery

An interactive, visualization-first course for the Inference AI Engineer curriculum: 25 interview-grade questions across the LLM serving stack. Every topic is a live lab with sliders, simulations and charts first, then a **worked example**, then short key ideas and a graded checkpoint.

The worked example follows one mocked request, *“What is the capital of France?”* → *“The capital of France is Paris.”* (Llama-3-70B, 28 prompt tokens, 8 output tokens), through that topic's mechanism one step at a time. Each step shows the data going in, the operation, and the data coming out: JSON → chat template → token IDs → embeddings → Q/K/V → attention → logits → sampled token → SSE frame in Q1, and the same request's KV blocks, SSE frames, batch slot, draft tokens, quantized weights, kernel timeline, cost and so on in the other topics. Attention numbers come from a tiny deterministic toy model (`LIA.toy`, d_model 8, GQA 2:1) so every value shown is actually computed; values that are invented are labelled as mocked.

### Terms explained in place

Jargon is tappable. Terms like *TTFT*, *HBM*, *GQA*, *continuous batching* or *all-reduce* are underlined wherever they appear in ledes, key ideas, worked-example notes and quiz explanations. Tapping one opens a card with a plain one-line definition, a mini picture, how it works and why it matters, an everyday analogy, the formula, what it means for the mocked request, related terms, and a link to its lab. Each topic starts with a **Key terms** strip, and the **Glossary** page (`#glossary`) lists all 184 terms with search and category filters.

## Run it

No build step and no dependencies. Open `index.html` in a browser, or serve the folder:

```bash
cd llm-inference-mastery
python3 -m http.server 8000   # then open http://localhost:8000
```

Deep links work by hash, e.g. `index.html#q3` opens the KV cache lab. Progress and free-form answers are stored in your browser's `localStorage`.

To produce a single self-contained HTML file (CSS and JS inlined):

```bash
python3 bundle.py            # -> dist/llm-inference-mastery.html
```

## Curriculum

| Module | Labs |
| --- | --- |
| **1 · Architecture & Memory** | Q1 Request lifecycle + roofline · Q3 KV cache sizing · Q4 PagedAttention allocator sim · Q5 FlashAttention tiling + online softmax · Module 1 checkpoint (rubric-graded) |
| **2 · Serving & Batching** | Q2 SSE streaming & cancellation · Q6 Continuous batching · Q7 Chunked prefill · Q8 Prefix caching & cache-aware routing · Q9 TTFT vs TPOT · Q10 Speculative decoding |
| **3 · Hardware, Kernels & Quantization** | Q11 Quantization formats (FP8/INT4/NVFP4 bit layouts) · Q12 GPU selection · Q13·Q14 Profiling & low GPU utilization · Q15 Fused RMSNorm in Triton |
| **4 · Distributed Inference** | Q22 Disaggregated prefill/decode · Q23 MoE & TP/PP/EP parallelism |
| **5 · Production Infrastructure** | Q16 Observability · Q17 Tail latency · Q18 Benchmarking · Q19 Safe rollouts · Q20 Autoscaling & cold starts · Q21 Multi-tenancy · Q24 Cost reduction · Q25 System design at scale |

## Visual language

Colors mean the same thing in every lab:

- **Amber**: HBM / slow memory / bandwidth
- **Teal**: SRAM / on-chip / cache hits
- **Violet**: compute (FLOPs, tensor cores)
- **Cobalt**: highlights and UI

Hardware numbers are approximate spec-sheet values (dense BF16, decimal GB). Simulations are simplified models meant to show the shape of each trade-off, not to predict production numbers.

## Structure

```
index.html        shell, loads everything below
css/style.css     design tokens (light + dark) and components
js/core.js        router, progress store, quiz engine, UI + SVG chart helpers (LIA.*)
js/m0.js          roadmap
js/m1.js … m5b.js one file per module; each topic calls LIA.register({...})
js/m1-trace.js    Module 1 worked examples (other modules keep theirs in the module file)
js/glossary.js    term registry, auto-linking, explanation cards, Key terms strip, Glossary page
js/terms-*.js     glossary entries (core, model, hardware, quant, serving, production)
bundle.py         inline everything into one HTML file
```

To add a topic, call `LIA.register` with `id`, `module`, `title`, a `render(stage)` function, `insights` and `quiz`, then add its id to `LIA.ORDER` in `core.js`. Add an optional `trace(MOCK)` returning steps to get a worked example. The API is documented at the top of `core.js`.
