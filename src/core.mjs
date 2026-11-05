// Pure selection, cooldown and retry-parsing rules for Free Switch. Nothing
// here touches the network or the filesystem, so the behaviour can be tested
// without a running magpie.

export const PROVIDER = "free-switch";
export const SELF_PROVIDERS = new Set([PROVIDER, `${PROVIDER}-plugin`]);

// Bump alongside RELEASE_NOTES.md when shipping a change.
export const VERSION = "0.3.0";

export const DEFAULT_CONFIG = {
  // The order providers (or full model ids) are tried in. Anything left over
  // follows alphabetically by provider and then by model id.
  priority: [
    "opencode-zen-free",
    "our-free-model",
    "kilo",
    "cline",
    "workbuddy-ai",
    "workbuddy",
  ],
  // Empty means every provider magpie currently serves.
  includeProviders: [],
  excludeProviders: [],
  includeModels: [],
  excludeModels: [],
  // A provider listed here is treated as free even if its /v1/models row has
  // no zero pricing (some relays omit the field).
  freeProviders: [],
  // 优先级（偏好模型）：检查后，优先使用这些模型，尽管它们在优先级数组中靠后。
  preferredModels: [],
  maxTries: 6,
  refreshSeconds: 60,
  cooldownSeconds: 60,
  serverErrorCooldownSeconds: 30,
  authErrorCooldownSeconds: 300,
  modelGoneCooldownSeconds: 600,
  // 区域限制（如 “This model is not available in your country”）：直接禁用该
  // 模型并移到末尾，除非用户在控制台手动清除冷却重新启用。
  countryBlockCooldownSeconds: 24 * 60 * 60,
  maxCooldownSeconds: 8 * 60 * 60,
  // After every awake model failed, still try the cooling ones. The request
  // then either succeeds or comes back with a useful error instead of a
  // hard "all models are cooling".
  tryCooling: true,
  // One model per provider in the first pass, then a second from each, so a
  // provider whose whole free pool is rate limited cannot eat every try.
  diversifyProviders: true,
  console: false,
  consolePort: 17890,
};

const MODEL_TYPE = new Set(["model", undefined, null, ""]);
const FREE_WORDS = /(?:^|[/_.\-\s])free(?:$|[/_.\-\s])/i;

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function zero(value) {
  if (value === null || value === undefined || value === "") return false;
  const n = number(value);
  return n === 0;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function providerOf(row) {
  const owned = text(row?.owned_by);
  if (owned) return owned;
  const id = text(row?.id);
  return id.includes("/") ? id.slice(0, id.indexOf("/")) : id;
}

function isSelf(row) {
  const id = text(row?.id);
  const provider = providerOf(row);
  if (SELF_PROVIDERS.has(provider)) return true;
  return SELF_PROVIDERS.has(id.split("/")[0]);
}

export function isGroupID(id) {
  return /^(?:auto|group)\//.test(text(id));
}

// A row of magpie's /v1/models is free when both directions are priced at
// zero. Missing pricing is not zero: a relay that doesn't know a price must
// not be treated as free by accident.
export function isFreeModel(row, config = DEFAULT_CONFIG) {
  if (!row || typeof row !== "object") return false;
  if (row.free === true) return true;
  const provider = providerOf(row);
  if (Array.isArray(config.freeProviders) && config.freeProviders.some((p) => matchesModel({ id: text(row.id), provider }, p))) {
    return true;
  }
  const pricing = row.pricing;
  if (pricing && typeof pricing === "object" && zero(pricing.prompt) && zero(pricing.completion)) return true;
  const cost = row.cost;
  if (cost && typeof cost === "object" && zero(cost.input) && zero(cost.output)) return true;
  // Some providers mark a free model only in its name. This is deliberately
  // narrow and only applies when pricing is absent, never when it is priced.
  if (!pricing && !cost) {
    const id = text(row.id);
    const name = text(row.display_name ?? row.name);
    if (FREE_WORDS.test(id) || /\(free\)|\bfree\b/i.test(name)) return true;
  }
  return false;
}

const UNSAFE_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function normalizeModel(row) {
  if (!row || typeof row !== "object") return undefined;
  const id = text(row.id);
  if (!id || UNSAFE_IDS.has(id) || isSelf(row) || isGroupID(id)) return undefined;
  if (!MODEL_TYPE.has(row.type)) return undefined;
  const output = row.modalities?.output;
  if (Array.isArray(output) && !output.includes("text")) return undefined;
  const provider = providerOf(row);
  if (!provider) return undefined;
  const params = Array.isArray(row.supported_parameters) ? row.supported_parameters : undefined;
  const toolcall = row.tool_call === false ? false : params ? params.includes("tools") || params.includes("tool_choice") : true;
  const levels = Array.isArray(row.reasoning_levels) ? row.reasoning_levels.filter((x) => typeof x === "string") : [];
  const image = Array.isArray(row.modalities?.input) ? row.modalities.input.includes("image") : row.vision === true;
  return {
    id,
    provider,
    name: text(row.display_name ?? row.name) || id,
    pricing: row.pricing ?? row.cost ?? undefined,
    context: number(row.context_window ?? row.context_length) ?? 0,
    maxOutput: number(row.max_output_tokens ?? row.max_tokens) ?? 0,
    toolcall,
    reasoning: row.reasoning === true || levels.length > 0 || (params?.includes("reasoning") ?? false),
    reasoningLevels: levels,
    image,
  };
}

export function matchesPattern(value, pattern) {
  const v = text(value);
  const p = text(pattern);
  if (!v || !p) return false;
  if (p.length > 2 && p.startsWith("/") && p.endsWith("/")) {
    try {
      return new RegExp(p.slice(1, -1)).test(v);
    } catch {
      return false;
    }
  }
  if (p.includes("*")) {
    const re = new RegExp(`^${p.split("*").map(escapeRegExp).join(".*")}$`);
    return re.test(v);
  }
  return v === p || v.startsWith(`${p}/`) || v.includes(`/${p}/`) || v.endsWith(`/${p}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesModel(model, pattern) {
  return matchesPattern(model.provider, pattern) || matchesPattern(model.id, pattern);
}

export function discoverFreeModels(rows, config = DEFAULT_CONFIG) {
  if (!Array.isArray(rows)) return [];
  const includeProviders = Array.isArray(config.includeProviders) ? config.includeProviders : [];
  const excludeProviders = Array.isArray(config.excludeProviders) ? config.excludeProviders : [];
  const includeModels = Array.isArray(config.includeModels) ? config.includeModels : [];
  const excludeModels = Array.isArray(config.excludeModels) ? config.excludeModels : [];
  const preferredModels = Array.isArray(config.preferredModels) ? config.preferredModels : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const model = normalizeModel(row);
    if (!model || seen.has(model.id)) continue;
    // includeModels 是用户显式白名单：强制纳入，跳过免费判定。
    // 请只填写你确认确实免费的模型（例如限时免费活动期间的模型），否则可能产生费用。
    const forced = includeModels.length && includeModels.some((p) => matchesModel(model, p));
    if (!forced && !isFreeModel(row, config)) continue;
    if (includeProviders.length && !includeProviders.some((p) => matchesModel(model, p))) continue;
    if (excludeProviders.some((p) => matchesModel(model, p))) continue;
    if (excludeModels.some((p) => matchesModel(model, p))) continue;
    seen.add(model.id);
    out.push(model);
  }
  out.sort((a, b) => {
    const ap = a.provider.localeCompare(b.provider);
    return ap !== 0 ? ap : a.id.localeCompare(b.id);
  });
  const priority = Array.isArray(config.priority) ? config.priority : [];
  const rank = new Map();
  let next = 0;
  for (const pattern of priority) {
    for (const model of out) {
      if (rank.has(model.id)) continue;
      if (matchesModel(model, pattern)) rank.set(model.id, next++);
    }
  }
  out.sort((a, b) => {
    const ar = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const br = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    const ap = a.provider.localeCompare(b.provider);
    if (ap !== 0) return ap;
    return a.id.localeCompare(b.id);
  });
  // Apply preferred models priority: preferred models come first
  const preferredSet = new Set();
  for (const pattern of preferredModels) {
    for (const model of out) {
      if (matchesModel(model, pattern)) {
        preferredSet.add(model.id);
      }
    }
  }
  out.sort((a, b) => {
    const aPref = preferredSet.has(a.id) ? 0 : 1;
    const bPref = preferredSet.has(b.id) ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    const ar = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const br = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    const ap = a.provider.localeCompare(b.provider);
    if (ap !== 0) return ap;
    return a.id.localeCompare(b.id);
  });
  return config.diversifyProviders === false ? out : roundRobinByProvider(out);
}

// The console-side display uses a full model directory: paid providers'
// models should also be viewable, marked with a free flag. Failover candidate selection still
// goes through discoverFreeModels, which only keeps free models.
export function buildModelCatalog(rows, config = DEFAULT_CONFIG) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const model = normalizeModel(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push({ ...model, free: isFreeModel(row, config) });
  }
  out.sort((a, b) => (a.provider.localeCompare(b.provider)) || a.id.localeCompare(b.id));
  return out;
}

export function roundRobinByProvider(models) {
  const buckets = new Map();
  const order = [];
  for (const model of models) {
    if (!buckets.has(model.provider)) {
      buckets.set(model.provider, []);
      order.push(model.provider);
    }
    buckets.get(model.provider).push(model);
  }
  const out = [];
  let added = true;
  while (added) {
    added = false;
    for (const provider of order) {
      const bucket = buckets.get(provider);
      if (!bucket.length) continue;
      out.push(bucket.shift());
      added = true;
    }
  }
  return out;
}

export function cooldownActive(entry, now = Date.now()) {
  return !!entry && Number.isFinite(entry.until) && entry.until > now;
}

export function needsOf(body) {
  if (!body || typeof body !== "object") return { tools: false, images: false, reasoning: false, stream: false };
  const tools = (Array.isArray(body.tools) && body.tools.length > 0) || (Array.isArray(body.functions) && body.functions.length > 0);
  const reasoning = body.reasoning_effort !== undefined || body.reasoning !== undefined || body.thinking !== undefined || body.output_config?.effort !== undefined;
  return {
    tools,
    images: containsImage(body.messages ?? body.input),
    reasoning,
    stream: body.stream === true,
  };
}

function containsImage(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((x) => containsImage(x, depth + 1));
  if (typeof value !== "object") return false;
  if (value.type === "image_url" || value.type === "image" || value.type === "input_image" || value.type === "inline_data") {
    if (value.type === "inline_data" && typeof value.mime_type === "string" && !value.mime_type.startsWith("image/")) return false;
    return true;
  }
  if (value.image_url !== undefined) return true;
  for (const key of Object.keys(value)) {
    if (containsImage(value[key], depth + 1)) return true;
  }
  return false;
}

export function supports(model, needs) {
  if (!model) return false;
  if (needs.tools && model.toolcall === false) return false;
  if (needs.images && model.image === false) return false;
  if (needs.reasoning && model.reasoning === false) return false;
  return true;
}

// Awake models keep their configured order and always come first. When none
// are awake, the cooling models are tried in that same order: that is the
// "call in order to confirm" path.
export function selectCandidates(models, stateModels, needs, config = DEFAULT_CONFIG, now = Date.now(), disabledProviders = []) {
  const all = Array.isArray(models) ? models : [];
  const isDisabled = (m) => {
    const entry = stateModels?.[m.id];
    if (entry?.disabled) return true;
    const providers = Array.isArray(disabledProviders) ? disabledProviders : [];
    if (!providers.length) return false;
    return providers.some((p) => matchesModel(m, p));
  };
  const enabled = all.filter((m) => !isDisabled(m));
  const capable = enabled.filter((m) => supports(m, needs));
  const pool = capable.length ? capable : enabled;
  const awake = pool.filter((m) => !cooldownActive(stateModels?.[m.id], now));
  const cooling = pool.filter((m) => cooldownActive(stateModels?.[m.id], now));
  const max = Math.max(1, Math.min(20, Math.trunc(Number(config.maxTries) || 6)));
  let ordered;
  if (awake.length) ordered = config.tryCooling === false ? awake : [...awake, ...cooling];
  else ordered = cooling;
  return {
    ordered: ordered.slice(0, max),
    awake: awake.length,
    cooling: cooling.length,
    capable: capable.length,
    total: pool.length,
    skippedDisabled: all.length - enabled.length,
  };
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

export function parseDuration(value, now = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value * 1000);
  const s = text(value);
  if (!s) return undefined;
  // An HTTP date, or an ISO timestamp.
  if (/^[A-Z][a-z]{2},/.test(s) || /^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const at = Date.parse(s);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e12) return Math.max(0, n - now);
    if (n > 1e9) return Math.max(0, n * 1000 - now);
    return Math.max(0, n * 1000);
  }
  let total = 0;
  let found = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi;
  for (const match of s.matchAll(re)) {
    found = true;
    const n = Number(match[1]);
    const unit = match[2].toLowerCase();
    total += n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000);
  }
  if (found) return Math.max(0, total);
  // "20" already handled; an unlabelled decimal is seconds.
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(0, n * 1000) : undefined;
}

function future(until, now, maxMs) {
  if (!Number.isFinite(until)) return undefined;
  const ms = Math.max(1000, Math.min(maxMs, until - now));
  return { until: now + ms, seconds: Math.ceil(ms / 1000) };
}

// Reads every reset hint the vendors are known to send, then the common
// "try again in 20s" / "resets at <timestamp>" shapes in the error body.
export function parseReset(headers, bodyText, now = Date.now(), maxMs = DEFAULT_CONFIG.maxCooldownSeconds * 1000) {
  const candidates = [];
  const add = (value, source) => {
    const parsed = parseDuration(value, now);
    if (!Number.isFinite(parsed)) return;
    const ms = Math.max(1000, parsed);
    const at = now + ms;
    candidates.push({ until: at, source, seconds: Math.ceil(ms / 1000) });
  };
  for (const name of [
    "retry-after",
    "x-ratelimit-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "x-magpie-limit-reset",
    "ratelimit-reset",
  ]) {
    const value = headerValue(headers, name);
    if (value !== undefined && value !== "") add(value, name);
  }
  const body = typeof bodyText === "string" ? bodyText.slice(0, 32_000) : "";
  if (body) {
    for (const match of body.matchAll(/\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/g)) {
      add(match[1], "body timestamp");
    }
    for (const match of body.matchAll(/(?:resets?_at|reset_at|retry_after|retryAt)["']?\s*[:=]\s*["']?(\d{10,13})/gi)) {
      add(match[1], "body reset");
    }
    for (const match of body.matchAll(/(?:try again|retry|reset|available|back)\s+(?:in|after|at)\s+([^.,;\n]{1,40})/gi)) {
      add(match[1], "body duration");
    }
    for (const match of body.matchAll(/\bwait\s+([^.,;\n]{1,40})/gi)) {
      add(match[1], "body duration");
    }
  }
  if (!candidates.length) return undefined;
  // The latest future hint is the safest: retrying before the slowest window
  // resets only burns another try.
  let best;
  for (const c of candidates) {
    if (c.until <= now) continue;
    if (!best || c.until > best.until) best = c;
  }
  if (!best) return undefined;
  const f = future(best.until, now, maxMs);
  return f ? { ...f, source: best.source } : undefined;
}

export function modelProblem(bodyText) {
  const s = typeof bodyText === "string" ? bodyText : "";
  if (!s) return false;
  const namesModel = /\bmodels?\b|模型/i.test(s);
  const refuses = /not\s+(?:found|available|supported|served)|unsupported|does\s*n[o']?t\s+exist|no\s+access|not\s+allowed|不存在|不支持|不可用|无权限|未开通/i.test(s);
  return namesModel && refuses;
}

// 区域限制：模型在你的国家/地区不可用。这类错误不是限流也不是账号问题，
// 重试也不会恢复，所以直接禁用该模型（长冷却），而不是反复尝试。
const COUNTRY_BLOCK = /(?:this\s+)?(?:model|it)\s+(?:is\s+)?not\s+available\s+in\s+(?:your\s+)?(?:country|region|location)|not\s+available\s+in\s+(?:your\s+)?(?:country|region|location)|not\s+supported\s+in\s+(?:your\s+)?(?:country|region)|(?:your\s+)?(?:country|region)\s+(?:is\s+)?not\s+supported|geographic(?:al)?\s+restriction|not\s+accessible\s+in\s+(?:your\s+)?(?:country|region)|该模型[^"]*?(?:国家|地区)[^"]*?(?:不可用|不支持|受限|限制)|(?:国家|地区)[^"]*?(?:不可用|不支持|受限|限制)/i;

export function countryBlocked(...texts) {
  for (const t of texts) {
    if (typeof t === "string" && t && COUNTRY_BLOCK.test(t)) return true;
  }
  return false;
}

export function shouldStop(status, bodyText) {
  // A request-shaped 400/422 is the caller's, not another model's, problem.
  if (status === 400 || status === 422) return !modelProblem(bodyText);
  return false;
}

export function cooldownFor({ status, headers, bodyText, error, previousFailures = 0, now = Date.now(), config = DEFAULT_CONFIG }) {
  const failures = Math.max(0, previousFailures) + 1;
  const maxMs = Math.max(60_000, (Number(config.maxCooldownSeconds) || DEFAULT_CONFIG.maxCooldownSeconds) * 1000);
  const fixed = (seconds, reason) => {
    const ms = Math.max(1000, Math.min(maxMs, (Number(seconds) || 60) * 1000));
    return { until: now + ms, seconds: Math.ceil(ms / 1000), reason, failures };
  };
  const backoff = (seconds, reason) => {
    const ms = Math.min(maxMs, Math.max(1000, (Number(seconds) || 30) * 1000 * 2 ** Math.min(failures - 1, 6)));
    return { until: now + ms, seconds: Math.ceil(ms / 1000), reason, failures };
  };
  if (countryBlocked(bodyText, error?.message)) {
    // 区域限制是持久性“不可用”，用独立的禁用时长（不受 maxCooldownSeconds 上限约束），
    // 默认 24h；用户可在控制台手动清除冷却立即重新启用。
    const ms = Math.max(1000, (Number(config.countryBlockCooldownSeconds) || 24 * 60 * 60) * 1000);
    return { until: now + ms, seconds: Math.ceil(ms / 1000), reason: "区域不可用", failures, disabled: true };
  }
  if (status === 429) {
    const reset = parseReset(headers, bodyText, now, maxMs);
    if (reset) return { ...reset, reason: reset.source || "rate limit", failures };
    return backoff(config.cooldownSeconds, "rate limit");
  }
  if (status === 401 || status === 403) return fixed(config.authErrorCooldownSeconds, "sign-in refused");
  if (status === 404) return fixed(config.modelGoneCooldownSeconds, "model not found");
  if (status === 400 || status === 422) {
    if (modelProblem(bodyText)) return fixed(config.modelGoneCooldownSeconds, "model not available");
    return undefined;
  }
  if (status === 0 || status === 408 || status === 409 || status === 425 || status >= 500) {
    const reset = parseReset(headers, bodyText, now, maxMs);
    if (reset) return { ...reset, reason: reset.source || "retry hint", failures };
    return backoff(config.serverErrorCooldownSeconds, error?.message || `HTTP ${status || "network"}`);
  }
  if (status >= 400 && status < 500) return fixed(config.cooldownSeconds, `HTTP ${status}`);
  return undefined;
}

export function cooldownSummary(entry, now = Date.now()) {
  if (!cooldownActive(entry, now)) return { cooling: false, seconds: 0, until: entry?.until ?? null };
  return { cooling: true, seconds: Math.max(0, Math.ceil((entry.until - now) / 1000)), until: entry.until };
}
