let STATE = null;

const el = (id) => document.getElementById(id);

let selectedCardId = null;
let plannedOps = [];

function badge(control) {
  if (control === "BLUE") return `<span class="badge blue">BLUE</span>`;
  if (control === "RED") return `<span class="badge red">RED</span>`;
  if (control === "CONTESTED") return `<span class="badge contested">CONTESTED</span>`;
  return `<span class="badge neutral">NEUTRAL</span>`;
}

function cardsById() {
  const m = new Map();
  for (const c of STATE?.cards || []) m.set(c.id, c);
  return m;
}

function cpRemaining() {
  const cp = STATE?.resources?.cp ?? 0;
  const m = cardsById();
  const spent = plannedOps.reduce((a, o) => a + (m.get(o.card_id)?.cp ?? 0), 0);
  return cp - spent;
}

function setHint(msg) {
  el("targetHint").textContent = msg;
}

function renderGameOverBanner() {
  const b = el("gameOverBanner");
  const go = STATE?.gameOver;

  if (!go || !go.over) {
    b.classList.add("hidden");
    b.innerHTML = "";
    el("commitBtn").disabled = false;
    return;
  }

  b.classList.remove("hidden");
  b.innerHTML = `
    <div><b>GAME OVER:</b> ${go.winner} — ${go.reason}</div>
    <div class="sub">Score: Blue ${go.points.blue} vs Red ${go.points.red} • Turn ${go.endedOnTurn}</div>
  `;
  el("commitBtn").disabled = true;
}

function renderCardDetails() {
  const m = cardsById();
  const card = selectedCardId ? m.get(selectedCardId) : null;

  if (!card) {
    el("cardDetails").innerHTML = `<div class="small">Select a card to see what it does.</div>`;
    return;
  }

  const legalCount = (STATE.legalTargetsByCard?.[card.id] || []).length;

  el("cardDetails").innerHTML = `
    <div class="titleLine">${card.name} <span class="small">(${card.id})</span></div>
    <div class="kv">
      <div>Domain</div><div>${card.domain}</div>
      <div>Cost</div><div>CP ${card.cp}</div>
      <div>Target</div><div>${card.target}</div>
      <div>Legal targets</div><div>${legalCount}</div>
    </div>
    <div><b>Why use it:</b> ${card.why}</div>
    <div><b>Effect:</b> ${card.effect}</div>
  `;
}

function render() {
  if (!STATE) return;

  el("seed").textContent = `Seed: ${STATE.seed}`;
  el("turn").textContent = `Turn: ${STATE.turn}`;
  el("constraint").textContent = `Constraint: ${STATE.constraint}`;

  el("cp").textContent = `${STATE.resources.cp} (remaining ${cpRemaining()})`;
  el("isr").textContent = `${STATE.resources.isr}`;
  el("pol").textContent = `${STATE.resources.political}`;

  // Objectives
  const completedBlue = new Set(STATE.completedObjectives?.blue || []);
  const completedRed = new Set(STATE.completedObjectives?.red || []);

  const fmtObj = (o, done) => `${done ? "✅ " : ""}${o.text} (+${o.points})`;
  el("objBlue").innerHTML = (STATE.objectives.public.blue || []).map((o) => `<li>${fmtObj(o, completedBlue.has(o.id))}</li>`).join("");
  el("objRed").innerHTML = (STATE.objectives.public.red || []).map((o) => `<li>${fmtObj(o, completedRed.has(o.id))}</li>`).join("");
  el("objBlueSecret").innerHTML = (STATE.objectives.secret.blue || []).map((o) => `<li>${fmtObj(o, completedBlue.has(o.id))}</li>`).join("");

  // Cards: show ALL, fixed order, grey out if not in hand
  const m = cardsById();
  const inHand = new Set(STATE.hand || []);
  el("hand").innerHTML = (STATE.cards || [])
    .map((c) => {
      const sel = c.id === selectedCardId ? "selected" : "";
      const disabled = !inHand.has(c.id) ? "disabled" : "";
      const dealt = inHand.has(c.id) ? "" : `<div class="small">Not dealt</div>`;
      return `
        <div class="card ${sel} ${disabled}" data-card="${c.id}">
          ${c.name}
          <div class="small">CP ${c.cp} • ${c.target} • ${c.domain}</div>
          ${dealt}
        </div>`;
    })
    .join("");

  // Planned
  el("planned").innerHTML = plannedOps
    .map((o, i) => {
      const tgt = o.targets?.[0];
      return `<li>${o.card_id} → ${tgt.target_type}:${tgt.target_id} <span class="small">(CP ${m.get(o.card_id)?.cp ?? "?"})</span> <button data-rm="${i}">x</button></li>`;
    })
    .join("");

  // AAR
  el("aar").innerHTML = (STATE._lastAar || []).map((l) => `<div class="small">• ${l}</div>`).join("");

  // Regions list
  el("regions").innerHTML = (STATE.regions || [])
    .map((r) => {
      const enemy = r.enemy?.confidence === "UNKNOWN" ? "—" : `${r.enemy.confidence} ~${r.enemy.estimate}`;
      return `
        <div class="regionRow">
          <div class="name">${r.id} • ${r.name} <span class="small">(${r.type})</span></div>
          <div>${badge(r.control)}</div>
          <div>Supply: ${r.supply}</div>
          <div>Enemy: ${enemy}</div>
        </div>`;
    })
    .join("");

  renderCardDetails();
  renderMap();
  renderGameOverBanner();
  wireUi();
}

function renderMap() {
  const w = 900;
  const h = 420;

  const regionById = new Map((STATE.regions || []).map((r) => [r.id, r]));
  const svgLines = (STATE.links || [])
    .map((l) => {
      const a = regionById.get(l.a);
      const b = regionById.get(l.b);
      const cap = l.capacity === null ? "?" : String(l.capacity);
      const jam = l.jammedTurns > 0 ? " (J)" : "";
      const intr = l.interdictedTurns > 0 ? " (I)" : "";
      return `
        <g class="link" data-link="${l.id}">
          <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--line)" stroke-width="2" />
          <text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 6}" fill="#94a3b8" font-size="12">${l.id}</text>
          <text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 + 10}" fill="#94a3b8" font-size="12">cap:${cap}${jam}${intr}</text>
        </g>
      `;
    })
    .join("");

  const svgNodes = (STATE.regions || [])
    .map((r) => {
      const fill =
        r.control === "BLUE" ? "rgba(74,163,255,0.25)" :
        r.control === "RED" ? "rgba(255,90,106,0.25)" :
        r.control === "CONTESTED" ? "rgba(251,191,36,0.18)" :
        "rgba(148,163,184,0.12)";

      const stroke =
        r.control === "BLUE" ? "rgba(74,163,255,0.9)" :
        r.control === "RED" ? "rgba(255,90,106,0.9)" :
        r.control === "CONTESTED" ? "rgba(251,191,36,0.9)" :
        "rgba(148,163,184,0.6)";

      return `
        <g class="node" data-region="${r.id}">
          <circle cx="${r.x}" cy="${r.y}" r="18" fill="${fill}" stroke="${stroke}" stroke-width="2"></circle>
          <text x="${r.x}" y="${r.y + 4}" text-anchor="middle" fill="#e5e7eb" font-size="12">${r.id}</text>
          <text x="${r.x}" y="${r.y + 28}" text-anchor="middle" fill="#94a3b8" font-size="12">${r.type}</text>
        </g>
      `;
    })
    .join("");

  el("mapWrap").innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="420">
      ${svgLines}
      ${svgNodes}
    </svg>
  `;
}

function wireUi() {
  const m = cardsById();
  const inHand = new Set(STATE.hand || []);

  // Card selection (only if dealt)
  for (const c of document.querySelectorAll(".card[data-card]")) {
    c.onclick = () => {
      const id = c.getAttribute("data-card");
      if (!inHand.has(id)) {
        el("errors").textContent = "That card isn’t dealt this turn.";
        return;
      }

      selectedCardId = selectedCardId === id ? null : id;

      if (selectedCardId) {
        const card = m.get(selectedCardId);
        const legalCount = (STATE.legalTargetsByCard?.[selectedCardId] || []).length;
        setHint(`Selected: ${selectedCardId}. Click a ${card.target.toLowerCase()} target. (Legal targets: ${legalCount})`);
      } else {
        setHint("Select a card, then click a target.");
      }

      el("errors").textContent = "";
      render();
    };
  }

  // Remove planned op
  for (const b of document.querySelectorAll("button[data-rm]")) {
    b.onclick = (e) => {
      const i = parseInt(b.getAttribute("data-rm"), 10);
      plannedOps.splice(i, 1);
      el("errors").textContent = "";
      render();
      e.stopPropagation();
    };
  }

  // Click targets on map
  for (const n of document.querySelectorAll(".node[data-region]")) {
    n.onclick = () => {
      if (!selectedCardId) return;
      const card = m.get(selectedCardId);
      if (!card || card.target !== "REGION") return;

      const rid = n.getAttribute("data-region");
      addPlanned(selectedCardId, { target_type: "REGION", target_id: rid });
    };
  }
  for (const g of document.querySelectorAll(".link[data-link]")) {
    g.onclick = () => {
      if (!selectedCardId) return;
      const card = m.get(selectedCardId);
      if (!card || card.target !== "LINK") return;

      const lid = g.getAttribute("data-link");
      addPlanned(selectedCardId, { target_type: "LINK", target_id: lid });
    };
  }

  el("clearBtn").onclick = () => {
    plannedOps = [];
    selectedCardId = null;
    el("errors").textContent = "";
    setHint("Select a card, then click a target.");
    render();
  };

  el("commitBtn").onclick = async () => {
    if (STATE.gameOver?.over) return;

    el("errors").textContent = "";
    const blueOrders = { operations: plannedOps };

    const r = await fetch("/api/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blueOrders })
    });
    const j = await r.json();
    if (!j.ok) {
      el("errors").textContent = j.error || "Commit failed.";
      return;
    }

    STATE = j.blueView;
    STATE._lastAar = j.aar || [];
    plannedOps = [];
    selectedCardId = null;
    setHint("Select a card, then click a target.");
    render();
  };

  el("newGameBtn").onclick = async () => {
    const seed = prompt("Seed (optional):", `VESPERA-${Date.now()}`) || `VESPERA-${Date.now()}`;
    await fetch("/api/new", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed }) });
    await load();
  };
}

function addPlanned(card_id, target) {
  const m = cardsById();
  const card = m.get(card_id);
  if (!card) return;

  if (STATE.gameOver?.over) {
    el("errors").textContent = "Game is over. Start a new game.";
    return;
  }

  // Legality check client-side
  const legal = STATE.legalTargetsByCard?.[card_id] || [];
  const ok = legal.some((t) => t.target_type === target.target_type && t.target_id === target.target_id);
  if (!ok) {
    el("errors").textContent = "That target is not legal for this card right now (see Card Details).";
    return;
  }

  if (cpRemaining() - card.cp < 0) {
    el("errors").textContent = "Not enough CP remaining for that operation.";
    return;
  }

  plannedOps.push({ card_id, targets: [target] });
  el("errors").textContent = "";
  render();
}

async function load() {
  const r = await fetch("/api/state?side=blue");
  STATE = await r.json();
  STATE._lastAar = [];
  plannedOps = [];
  selectedCardId = null;
  setHint("Select a card, then click a target.");
  render();
}

load();