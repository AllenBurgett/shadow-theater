// llm.js — prevents redView mutation; repairs advance legality if meta disagrees; adds LLM_BUILD_ID
import { z } from "zod";

export const LLM_BUILD_ID = "llm-redview-immutability-2026-03-01a";

const CanonicalOpSchema = z.object({
  card_id: z.string(),
  targets: z.array(z.object({ target_type: z.enum(["REGION", "LINK"]), target_id: z.string() })).min(1),
  parameters: z.record(z.any()).optional(),
  notes: z.string().optional()
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson({ url, method, headers, body, timeoutMs }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const txt = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt}`);
    try {
      return JSON.parse(txt);
    } catch {
      return txt;
    }
  } finally {
    clearTimeout(t);
  }
}

function authHeaderMaybe(key) {
  return key ? { authorization: `Bearer ${key}` } : {};
}
function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

function getProfile(config, role) {
  const p = config?.llm?.[role] || {};
  const apiKey = p.apiKey || "";
  const adminKey = p.adminKey || apiKey;
  const baseUrl = p.baseUrl || "http://127.0.0.1:5000";

  return {
    enabled: !!p.enabled,
    baseUrl,
    apiKey,
    adminKey,
    model: p.model || "local-model",
    autoLoad: {
      enabled: !!p.autoLoad?.enabled,
      modelName: p.autoLoad?.modelName || "",
      args: p.autoLoad?.args || undefined,
      settings: p.autoLoad?.settings || undefined,
      waitForLoadMs: typeof p.autoLoad?.waitForLoadMs === "number" ? p.autoLoad.waitForLoadMs : 300000
    },
    oobaMode: p.ooba?.mode || "",
    instructionTemplate: p.ooba?.instructionTemplate || "",
    temperature: p.sampling?.temperature ?? 0.2,
    maxTokens: p.sampling?.maxTokens ?? 700,
    topP: p.sampling?.topP,
    topK: p.sampling?.topK,
    stop: Array.isArray(p.sampling?.stop) ? p.sampling.stop : undefined,
    timeoutMs: p.timeoutMs ?? 30000
  };
}

async function getCurrentModelName(profile) {
  const url = `${normalizeBaseUrl(profile.baseUrl)}/v1/internal/model/info`;
  const headers = { "content-type": "application/json", ...authHeaderMaybe(profile.adminKey) };
  const info = await httpJson({ url, method: "GET", headers, timeoutMs: 15000 });
  return info?.model_name || info?.model || info?.name || "";
}

async function loadModel(profile, modelName) {
  const url = `${normalizeBaseUrl(profile.baseUrl)}/v1/internal/model/load`;
  const headers = { "content-type": "application/json", ...authHeaderMaybe(profile.adminKey) };
  const payload = {
    model_name: modelName,
    ...(profile.autoLoad?.args ? { args: profile.autoLoad.args } : {}),
    ...(profile.autoLoad?.settings ? { settings: profile.autoLoad.settings } : {})
  };
  await httpJson({ url, method: "POST", headers, body: payload, timeoutMs: profile.autoLoad.waitForLoadMs });
}

async function ensureModelLoaded(profile) {
  if (!profile.enabled) return;
  if (!profile.autoLoad?.enabled) return;

  const desired = profile.autoLoad.modelName || profile.model;
  if (!desired) return;

  const current = await getCurrentModelName(profile);
  if (current === desired) return;

  await loadModel(profile, desired);

  const deadline = Date.now() + profile.autoLoad.waitForLoadMs;
  while (Date.now() < deadline) {
    try {
      const now = await getCurrentModelName(profile);
      if (now === desired) return;
    } catch {}
    await sleep(750);
  }
  throw new Error(`Timed out waiting for webui to load model "${desired}"`);
}

async function callOpenAICompatibleChat({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  topP,
  topK,
  stop,
  extraBody,
  timeoutMs
}) {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(typeof topP === "number" ? { top_p: topP } : {}),
    ...(typeof topK === "number" ? { top_k: topK } : {}),
    ...(Array.isArray(stop) && stop.length ? { stop } : {}),
    ...(extraBody && typeof extraBody === "object" ? extraBody : {})
  };
  const headers = { "content-type": "application/json", ...authHeaderMaybe(apiKey) };
  return httpJson({ url, method: "POST", headers, body, timeoutMs });
}

/* --------------------------
   Critical: redView repair + immutability
   -------------------------- */

function cloneRedView(redView) {
  // Node 20 has structuredClone; this prevents accidental mutation.
  return structuredClone(redView);
}

function repairAdvanceLegalityIfNeeded(rv, logger) {
  const metaAdv = rv?.meta?.advanceLegalTargets || [];
  const legal = rv?.legalTargetsByCard || {};
  const advArr = legal?.DELIBERATE_ADVANCE || [];

  const legalIds = advArr.map((t) => t.target_id);
  const mismatch = metaAdv.length > 0 && legalIds.length === 0;

  if (!mismatch) return { repaired: false };

  // Repair: trust meta (it was computed server-side at view generation time)
  rv.legalTargetsByCard = rv.legalTargetsByCard || {};
  rv.legalTargetsByCard.DELIBERATE_ADVANCE = metaAdv.map((rid) => ({
    target_type: "REGION",
    target_id: rid
  }));

  logger?.log("diag_llm_repaired_advance_legality", {
    turn: rv.turn,
    metaAdvanceLegalTargets: metaAdv,
    before: legalIds,
    after: metaAdv
  });

  return { repaired: true };
}

/* --------------------------
   Staff plan (tempo-first)
   -------------------------- */

function regionValue(type) {
  return ({ HABITAT: 100, PORT: 90, COMMS: 85, INDUSTRY: 70, POWER: 55, WILDS: 30 }[type] || 30);
}

function filterToLegalAndBudget(rv, ops) {
  const hand = new Set(rv.hand || []);
  const legal = rv.legalTargetsByCard || {};
  const cpMax = rv.resources?.cp ?? 0;

  const cardById = new Map((rv.cards || []).map((c) => [c.id, c]));
  let spent = 0;
  const out = [];

  for (const op of ops || []) {
    if (!hand.has(op.card_id)) continue;
    const card = cardById.get(op.card_id);
    if (!card) continue;

    const tgt = op.targets?.[0];
    if (!tgt) continue;
    if (tgt.target_type !== card.target) continue;

    const allowed = legal[op.card_id] || [];
    const ok = allowed.some((t) => t.target_type === tgt.target_type && t.target_id === tgt.target_id);
    if (!ok) continue;

    if (spent + card.cp > cpMax) continue;
    spent += card.cp;
    out.push(op);
  }

  return { ops: out, cpUsed: spent, cpMax };
}

function buildStaffPlan(rv) {
  const hand = new Set(rv.hand || []);
  const legal = structuredClone(rv.legalTargetsByCard || {}); // DO NOT MUTATE rv
  const cardById = new Map((rv.cards || []).map((c) => [c.id, c]));
  const cpMax = rv.resources?.cp ?? 0;

  const regions = new Map((rv.regions || []).map((r) => [r.id, r]));
  const links = new Map((rv.links || []).map((l) => [l.id, l]));

  const scoreAdvance = (rid) => {
    const r = regions.get(rid);
    if (!r) return -1;
    let s = regionValue(r.type);
    if (r.control === "CONTESTED") s += 80;
    if (r.control === "NEUTRAL") s += 35;
    return s;
  };

  const scoreChoke = (lid) => {
    const l = links.get(lid);
    if (!l) return -1;
    const a = regions.get(l.a);
    const b = regions.get(l.b);
    let s = 0;
    for (const rr of [a, b]) {
      if (!rr) continue;
      if (rr.control === "BLUE") s += 80 + regionValue(rr.type) * 0.2;
      if (rr.control === "CONTESTED") s += 30;
    }
    if (typeof l.capacity === "number") s += l.capacity * 8;
    return s;
  };

  const pickBest = (targets, scorer) => {
    let best = null;
    let bestS = -1e9;
    for (const t of targets || []) {
      const s = scorer(t.target_id);
      if (s > bestS) {
        bestS = s;
        best = t;
      }
    }
    return best;
  };

  const ops = [];
  let spent = 0;

  const tryAdd = (cardId, target, parameters, notes) => {
    if (!hand.has(cardId)) return false;
    const card = cardById.get(cardId);
    if (!card) return false;
    if (!target) return false;
    if (spent + card.cp > cpMax) return false;

    ops.push({
      card_id: cardId,
      targets: [target],
      ...(parameters ? { parameters } : {}),
      ...(notes ? { notes } : {})
    });
    spent += card.cp;
    return true;
  };

  // 1) Tempo: advance if legal
  if (hand.has("DELIBERATE_ADVANCE") && (legal.DELIBERATE_ADVANCE || []).length) {
    const local = [...legal.DELIBERATE_ADVANCE];
    while (spent + (cardById.get("DELIBERATE_ADVANCE")?.cp ?? 999) <= cpMax && local.length) {
      const tgt = pickBest(local, scoreAdvance);
      if (!tgt) break;
      tryAdd("DELIBERATE_ADVANCE", tgt, undefined, "Tempo.");
      // remove selected target from local list only (not rv)
      const idx = local.findIndex((x) => x.target_id === tgt.target_id);
      if (idx >= 0) local.splice(idx, 1);
    }
  }

  // 2) Interdict / jam
  if (hand.has("INTERDICT_LINK") && (legal.INTERDICT_LINK || []).length) {
    tryAdd("INTERDICT_LINK", pickBest(legal.INTERDICT_LINK, scoreChoke), undefined, "Choke.");
  }
  if (hand.has("JAMMING_CORRIDOR") && (legal.JAMMING_CORRIDOR || []).length) {
    tryAdd("JAMMING_CORRIDOR", pickBest(legal.JAMMING_CORRIDOR, scoreChoke), undefined, "Jam.");
  }

  // 3) Fill CP greedily
  const usedPairs = new Set(ops.map((o) => `${o.card_id}:${o.targets[0].target_id}`));
  let progress = true;
  while (progress) {
    progress = false;
    let best = null;

    for (const cid of rv.hand || []) {
      const card = cardById.get(cid);
      if (!card) continue;
      if (spent + card.cp > cpMax) continue;

      const targets = legal[cid] || [];
      for (const t of targets) {
        const key = `${cid}:${t.target_id}`;
        if (usedPairs.has(key)) continue;

        let s = 10;
        if (cid === "DELIBERATE_ADVANCE") s = scoreAdvance(t.target_id);
        else if (cid === "INTERDICT_LINK" || cid === "JAMMING_CORRIDOR") s = scoreChoke(t.target_id);
        s = s / Math.max(1, card.cp);

        if (!best || s > best.s) best = { cid, target: t, s };
      }
    }

    if (best) {
      if (tryAdd(best.cid, best.target, undefined, "Fill.")) {
        usedPairs.add(`${best.cid}:${best.target.target_id}`);
        progress = true;
      }
    }
  }

  return { operations: filterToLegalAndBudget(rv, ops).ops };
}

/* --------------------------
   Minimal LLM parse (kept simple)
   -------------------------- */

function extractFirstJsonObject(text) {
  // super simple extractor: assume model returns a JSON object or close enough
  const s = (text || "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = s.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function normalizeOpsFromAnyShape(obj, rv) {
  const cards = rv.cards || [];
  const cardTarget = new Map(cards.map((c) => [c.id, c.target]));

  const rawOps = Array.isArray(obj?.operations) ? obj.operations : (obj && typeof obj === "object" ? [obj] : []);
  const ops = [];

  for (const o of rawOps) {
    if (!o || typeof o !== "object") continue;

    const card_id = o.card_id || o.action || o.selected_card;
    if (!card_id || typeof card_id !== "string") continue;

    const targetType = cardTarget.get(card_id);
    let tgt = null;

    if (Array.isArray(o.targets) && o.targets[0]?.target_id && o.targets[0]?.target_type) {
      tgt = { target_type: o.targets[0].target_type, target_id: o.targets[0].target_id };
    } else if (typeof o.target_id === "string" && targetType) {
      tgt = { target_type: targetType, target_id: o.target_id };
    } else if (typeof o.target === "string" && targetType) {
      tgt = { target_type: targetType, target_id: o.target };
    }

    if (!tgt) continue;

    const op = {
      card_id,
      targets: [tgt],
      ...(o.parameters && typeof o.parameters === "object" ? { parameters: o.parameters } : {}),
      ...(typeof o.notes === "string" ? { notes: o.notes } : {})
    };

    const parsed = CanonicalOpSchema.safeParse(op);
    if (parsed.success) ops.push(parsed.data);
  }

  return ops;
}

function shouldAcceptLlmOverStaff(rv, llmOps, staffPlan) {
  const staff = filterToLegalAndBudget(rv, staffPlan.operations || []);
  const llm = filterToLegalAndBudget(rv, llmOps || []);
  if (llm.ops.length === 0) return false;
  if (llm.cpUsed >= staff.cpUsed) return true;
  if (llm.cpMax > 0 && llm.cpUsed / llm.cpMax >= 0.8) return true;
  return false;
}

/* --------------------------
   Main
   -------------------------- */

export async function getRedOrders({ redView, config, logger }) {
  const prof = getProfile(config, "red");
  const turn = redView.turn;

  // IMPORTANT: operate on a clone so we cannot mutate server redView
  const rv = cloneRedView(redView);
  repairAdvanceLegalityIfNeeded(rv, logger);

  const staffPlan = buildStaffPlan(rv);
  logger?.log("red_staff_plan", {
    turn,
    llmBuildId: LLM_BUILD_ID,
    staffPlan,
    meta: rv.meta,
    legalAdvanceInInput: (rv.legalTargetsByCard?.DELIBERATE_ADVANCE || []).map((t) => t.target_id).sort()
  });

  if (!prof.enabled) {
    logger?.log("red_decision", { turn, chosen: "staff", reason: "llm_disabled", finalOps: staffPlan.operations });
    return staffPlan;
  }

  try {
    await ensureModelLoaded(prof);
  } catch (e) {
    logger?.log("red_decision", { turn, chosen: "staff", reason: "model_load_failed", error: String(e?.message || e), finalOps: staffPlan.operations });
    return staffPlan;
  }

  const system = [
    "Return ONLY JSON: {\"operations\":[...]}",
    "Choose targets ONLY from legalTargetsByCard[card_id].",
    "Prioritize DELIBERATE_ADVANCE if legal.",
    "No extra text."
  ].join("\n");

  const userPayload = {
    turn: rv.turn,
    resources: rv.resources,
    hand: rv.hand,
    cards: rv.cards,
    legalTargetsByCard: rv.legalTargetsByCard,
    staff_recommended_plan: staffPlan
  };

  logger?.log("red_llm_prompt_inputs", { turn, redView: { meta: rv.meta, hand: rv.hand, legalTargetsByCard: rv.legalTargetsByCard } });

  const messages = [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(userPayload) }
  ];

  const extraBody = {
    ...(prof.oobaMode ? { mode: prof.oobaMode } : {}),
    ...(prof.instructionTemplate ? { instruction_template: prof.instructionTemplate } : {})
  };

  let rawText = "";
  try {
    const json = await callOpenAICompatibleChat({
      baseUrl: prof.baseUrl,
      apiKey: prof.apiKey,
      model: prof.model,
      messages,
      temperature: prof.temperature,
      maxTokens: prof.maxTokens,
      topP: prof.topP,
      topK: prof.topK,
      stop: prof.stop,
      extraBody,
      timeoutMs: prof.timeoutMs
    });
    rawText = json?.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    logger?.log("red_decision", { turn, chosen: "staff", reason: "llm_call_failed", error: String(e?.message || e), finalOps: staffPlan.operations });
    return staffPlan;
  }

  logger?.log("red_llm_raw", { turn, rawLlmText: rawText });

  const obj = extractFirstJsonObject(rawText);
  if (!obj) {
    logger?.log("red_decision", { turn, chosen: "staff", reason: "llm_no_json", finalOps: staffPlan.operations });
    return staffPlan;
  }

  const normalized = normalizeOpsFromAnyShape(obj, rv);
  const llmFiltered = filterToLegalAndBudget(rv, normalized);

  logger?.log("red_llm_parsed", { turn, normalizedOps: normalized, cleanedOps: llmFiltered.ops, cpUsed: llmFiltered.cpUsed, cpMax: llmFiltered.cpMax });

  if (shouldAcceptLlmOverStaff(rv, llmFiltered.ops, staffPlan)) {
    logger?.log("red_decision", { turn, chosen: "llm", reason: "llm_plan_accepted", finalOps: llmFiltered.ops });
    return { operations: llmFiltered.ops };
  }

  logger?.log("red_decision", { turn, chosen: "staff", reason: "staff_stronger_or_llm_weaker", llmOps: llmFiltered.ops, finalOps: staffPlan.operations });
  return staffPlan;
}