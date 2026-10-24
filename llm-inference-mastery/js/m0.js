/* Roadmap: the curriculum as a clickable flow, colored by progress. */
(function () {
  const { h, s } = LIA;

  LIA.register({
    id: "map",
    module: 0,
    q: "",
    title: "Roadmap",
    labTitle: "Curriculum map · click any station",
    lede: "25 interview-grade questions across the full serving stack. Each station is a hands-on lab: move the sliders, watch the system react, then pass the checkpoint.",
    tags: [{ label: "5 modules", kind: "accent" }, { label: "visual-first", kind: "sram" }],
    render(stage) {
      const W = 980, laneH = 92, top = 10;
      const mods = [1, 2, 3, 4, 5];
      const byMod = {};
      LIA.ORDER.forEach((id) => { const t = LIA.topics[id]; if (t && t.module) (byMod[t.module] = byMod[t.module] || []).push(t); });
      const H = top + mods.length * laneH + 10;
      const svg = LIA.svg(W, H, { "aria-label": "Curriculum map" });
      const kind = { 1: "var(--hbm)", 2: "var(--accent)", 3: "var(--compute)", 4: "var(--sram)", 5: "var(--good)" };
      mods.forEach((m, mi) => {
        const y = top + mi * laneH;
        svg.appendChild(s("rect", { x: 0, y, width: W, height: laneH - 12, rx: 10, fill: "var(--surface-2)", stroke: "var(--line)" }));
        svg.appendChild(s("rect", { x: 0, y, width: 6, height: laneH - 12, rx: 3, fill: kind[m] }));
        svg.appendChild(s("text", { x: 18, y: y + 22, "font-size": 12, "font-weight": 600, fill: kind[m] }, `MODULE ${m}`));
        svg.appendChild(s("text", { x: 18, y: y + 40, "font-size": 12, fill: "var(--ink)" }, LIA.MODULES[m].replace(" & ", " &")));
        const list = byMod[m] || [];
        const x0 = 250, span = W - x0 - 20;
        const step = list.length > 1 ? span / list.length : span;
        if (list.length > 1) svg.appendChild(s("line", { x1: x0 + step / 2, x2: x0 + step * (list.length - 0.5), y1: y + 40, y2: y + 40, stroke: kind[m], "stroke-width": 3, opacity: 0.35 }));
        list.forEach((t, i) => {
          const cx = x0 + step * (i + 0.5);
          const st = LIA.status(t.id);
          const g = s("g", { tabindex: 0, role: "link", style: "cursor:pointer", "aria-label": `${t.q} ${t.title}` });
          g.appendChild(s("circle", { cx, cy: y + 40, r: 17, fill: st === "done" ? kind[m] : "var(--surface)", stroke: kind[m], "stroke-width": 2.5 }));
          if (st === "part") g.appendChild(s("path", { d: `M${cx},${y + 23} A17,17 0 0,1 ${cx},${y + 57} Z`, fill: kind[m], opacity: 0.5 }));
          g.appendChild(s("text", { x: cx, y: y + 44, "text-anchor": "middle", "font-size": 10.5, "font-weight": 600, fill: st === "done" ? "var(--surface)" : "var(--ink)" }, t.q.replace("·Q14", "+")));
          const label = t.title.length > 18 ? t.title.slice(0, 17) + "…" : t.title;
          g.appendChild(s("text", { x: cx, y: y + 72, "text-anchor": "middle", "font-size": 10.5, fill: "var(--muted)" }, label));
          g.appendChild(s("title", null, `${t.q} · ${t.title}`));
          g.addEventListener("click", () => LIA.go(t.id));
          g.addEventListener("keydown", (e) => { if (e.key === "Enter") LIA.go(t.id); });
          svg.appendChild(g);
        });
        if (mi < mods.length - 1) svg.appendChild(s("path", { d: `M${W / 2 - 6},${y + laneH - 12} l6,10 l6,-10`, fill: "var(--line)" }));
      });
      stage.appendChild(LIA.viz(svg));
      stage.appendChild(h("div", { class: "row" },
        LIA.pill("○ not started"), LIA.pill("◐ attempted", "warn"), LIA.pill("● checkpoint passed", "good"),
        h("span", { class: "caption" }, "Progress is kept in this browser only.")
      ));
      stage.appendChild(h("div", { class: "cols-3" },
        card("1 · Play", "Every lab is a live model of the mechanism. Drag sliders and press play before reading anything."),
        card("2 · Predict", "Before you change a control, guess what the chart will do. Surprises are where learning happens."),
        card("3 · Prove", "Checkpoints mix multiple choice, numeric calculations and free-form answers scored against a rubric.")
      ));
      stage.appendChild(h("div", { class: "row" }, h("a", { class: "btn primary", href: "#q1" }, "Start with Q1 · Request lifecycle →"), h("a", { class: "btn", href: "#m1check" }, "Jump to the Module 1 checkpoint")));
      function card(t, d) { return h("div", { class: "stat" }, h("span", { class: "v", style: { fontSize: "15px", fontFamily: "var(--f-display)" } }, t), h("span", { class: "k", style: { fontSize: "13px" } }, d)); }
    },
  });
})();
