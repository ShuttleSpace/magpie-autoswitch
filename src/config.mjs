import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, STRATEGIES, formatPaidWindow } from "./core.mjs";

const TRACE_MAX_BYTES = 2 * 1024 * 1024;
const TRACE_KEEP_LINES = 1000;
const SELF_PROVIDERS = new Set(["free-switch", "free-switch-plugin"]);
export const STATE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export function magpieConfigDir() {
  const explicit = process.env.MAGPIE_CONFIG_DIR;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return path.join(path.resolve(xdg.trim()), "magpie");
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "magpie");
  return path.join(os.homedir(), ".config", "magpie");
}

export function dataDir() {
  return path.join(magpieConfigDir(), "free-switch");
}

export const configPath = () => path.join(dataDir(), "config.json");
export const statePath = () => path.join(dataDir(), "state.json");
export const tracePath = () => path.join(dataDir(), "traces.jsonl");

// Magpie-side credit snapshot: read quota balances + daily credit usage from
// the magpie config dir so the console can show which providers run on credits.
export function readAllProviders() {
  const dir = magpieConfigDir();
  const parsed = readJSON(path.join(dir, "providers.json"), undefined);
  const list = parsed?.providers;
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => (typeof p === "string" ? { id: p } : { id: p?.id, name: p?.name ?? p?.id }))
    .filter((p) => p.id && !SELF_PROVIDERS.has(p.id));
}

export function readCredits() {
  const dir = magpieConfigDir();
  const quotas = readJSON(path.join(dir, "quotas.json"), {});
  const daily = readJSON(path.join(dir, "credits-daily.json"), {});
  const byId = new Map();
  const add = (providerId, entry) => {
    if (!providerId) return;
    const prev = byId.get(providerId) ?? {};
    byId.set(providerId, {
      provider: entry.provider ?? providerId,
      name: entry.name ?? providerId,
      icon: entry.icon,
      plan: entry.plan,
      accessSku: entry.accessSku,
      balance: entry.balance,
      used: entry.used,
      total: entry.total,
      windows: Array.isArray(entry.windows) ? entry.windows : [],
    });
  };
  for (const key of Object.keys(quotas ?? {})) {
    const q = quotas[key];
    const entry = q?.quota;
    if (!entry) continue;
    add(entry.provider, entry);
  }
  for (const key of Object.keys(daily ?? {})) {
    const parts = key.split("|");
    const providerId = parts[0];
    const entry = daily[key];
    const last = entry?.last;
    if (!providerId || !last) continue;
    add(providerId, { provider: providerId, name: providerId, used: last.used, total: last.total, since: entry?.since });
  }
  return [...byId.values()];
}


function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without modes */
  }
}

export { writeJSON };

function boolEnv(value) {
  if (value === undefined) return undefined;
  return /^(?:1|true|yes|on)$/i.test(String(value).trim());
}

function listEnv(value) {
  if (value === undefined) return undefined;
  return String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function numberEnv(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function boolish(value, fallback) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

export function loadConfig() {
  try {
    ensureDir();
  } catch {
    /* read-only config directories still get the defaults */
  }
  const file = configPath();
  const saved = readJSON(file, undefined);
  const config = { ...DEFAULT_CONFIG, ...(saved && typeof saved === "object" ? saved : {}) };
  for (const key of ["priority", "includeProviders", "excludeProviders", "includeModels", "excludeModels", "freeProviders", "preferredModels"]) {
    if (!Array.isArray(config[key])) config[key] = [...DEFAULT_CONFIG[key]];
    config[key] = config[key].filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  }
  for (const key of [
    "maxTries",
    "refreshSeconds",
    "cooldownSeconds",
    "serverErrorCooldownSeconds",
    "authErrorCooldownSeconds",
    "modelGoneCooldownSeconds",
    "countryBlockCooldownSeconds",
    "maxCooldownSeconds",
    "consolePort",
  ]) {
    const n = Number(config[key]);
    config[key] = Number.isFinite(n) ? n : DEFAULT_CONFIG[key];
  }
  config.maxTries = Math.max(1, Math.min(20, Math.trunc(config.maxTries)));
  config.refreshSeconds = Math.max(5, Math.min(3600, config.refreshSeconds));
  config.consolePort = Math.max(0, Math.min(65535, Math.trunc(config.consolePort)));
  if (!STRATEGIES.has(config.strategy)) config.strategy = DEFAULT_CONFIG.strategy;
  {
    const paid = Number(config.maxPaidTries);
    config.maxPaidTries = Number.isFinite(paid) ? Math.max(0, Math.min(20, Math.trunc(paid))) : DEFAULT_CONFIG.maxPaidTries;
  }
  config.paidWindow = formatPaidWindow(config.paidWindow);
  {
    const min = Number(config.paidMinBalance);
    config.paidMinBalance = Number.isFinite(min) && min > 0 ? min : 0;
  }
  config.tryCooling = boolish(config.tryCooling, true);
  config.diversifyProviders = boolish(config.diversifyProviders, true);
  config.console = boolish(config.console, false);
  if (!saved) {
    try {
      writeJSON(file, DEFAULT_CONFIG);
    } catch {
      /* the defaults still work in memory */
    }
  }
  applyEnv(config);
  return config;
}

function applyEnv(config) {
  const consoleOn = boolEnv(process.env.FREE_SWITCH_CONSOLE);
  if (consoleOn !== undefined) config.console = consoleOn;
  const port = numberEnv(process.env.FREE_SWITCH_CONSOLE_PORT);
  if (port !== undefined) config.consolePort = Math.max(0, Math.min(65535, Math.trunc(port)));
  const tries = numberEnv(process.env.FREE_SWITCH_MAX_TRIES);
  if (tries !== undefined) config.maxTries = Math.max(1, Math.min(20, Math.trunc(tries)));
  const strategy = process.env.FREE_SWITCH_STRATEGY?.trim();
  if (strategy && STRATEGIES.has(strategy)) config.strategy = strategy;
  const paidTries = numberEnv(process.env.FREE_SWITCH_MAX_PAID_TRIES);
  if (paidTries !== undefined) config.maxPaidTries = Math.max(0, Math.min(20, Math.trunc(paidTries)));
  const paidWindow = process.env.FREE_SWITCH_PAID_WINDOW?.trim();
  if (paidWindow !== undefined) config.paidWindow = formatPaidWindow(paidWindow);
  const paidMinBalance = numberEnv(process.env.FREE_SWITCH_PAID_MIN_BALANCE);
  if (paidMinBalance !== undefined) config.paidMinBalance = Math.max(0, paidMinBalance);
  const refresh = numberEnv(process.env.FREE_SWITCH_REFRESH_SECONDS);
  if (refresh !== undefined) config.refreshSeconds = Math.max(5, Math.min(3600, refresh));
  const cooling = boolEnv(process.env.FREE_SWITCH_TRY_COOLING);
  if (cooling !== undefined) config.tryCooling = cooling;
  const diversify = boolEnv(process.env.FREE_SWITCH_DIVERSIFY_PROVIDERS);
  if (diversify !== undefined) config.diversifyProviders = diversify;
  const priority = listEnv(process.env.FREE_SWITCH_PRIORITY);
  if (priority) config.priority = priority;
  const exclude = listEnv(process.env.FREE_SWITCH_EXCLUDE_PROVIDERS);
  if (exclude) config.excludeProviders = exclude;
  const include = listEnv(process.env.FREE_SWITCH_INCLUDE_PROVIDERS);
  if (include) config.includeProviders = include;
  return config;
}

export function emptyState() {
  return {
    version: 1,
    updatedAt: Date.now(),
    models: {},
    // Provider-level manual disables, e.g. ["kilo"]. A disabled provider never
    // takes part in auto failover until it is enabled again.
    disabledProviders: [],
    // Manual switch target for the next auto request: { model, at }. Consumed
    // by the next free-switch/auto call and cleared afterwards.
    manualSwitch: null,
    stats: {
      requests: 0,
      attempts: 0,
      switches: 0,
      successes: 0,
      failures: 0,
      exhausted: 0,
    },
  };
}

export function loadState() {
  const saved = readJSON(statePath(), undefined);
  const state = emptyState();
  if (saved && typeof saved === "object") {
    if (saved.models && typeof saved.models === "object") state.models = saved.models;
    if (Array.isArray(saved.disabledProviders)) state.disabledProviders = saved.disabledProviders.filter((x) => typeof x === "string" && x.trim());
    if (saved.manualSwitch && typeof saved.manualSwitch === "object") state.manualSwitch = saved.manualSwitch;
    if (saved.stats && typeof saved.stats === "object") state.stats = { ...state.stats, ...saved.stats };
  }
  for (const key of Object.keys(state.stats)) {
    const value = Number(state.stats[key]);
    state.stats[key] = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  }
  const now = Date.now();
  for (const id of ["__proto__", "constructor", "prototype"]) delete state.models[id];
  for (const [id, entry] of Object.entries(state.models)) {
    if (!entry || typeof entry !== "object") {
      delete state.models[id];
      continue;
    }
    const until = Number(entry.until);
    if (!Number.isFinite(until)) {
      delete state.models[id];
      continue;
    }
    entry.until = until;
    const failures = Number(entry.failures);
    entry.failures = Number.isFinite(failures) && failures >= 0 ? Math.trunc(failures) : 0;
    const last = Number(entry.lastAttemptAt ?? entry.updatedAt ?? 0);
    if (until <= now && (!last || now - last > STATE_MAX_AGE)) delete state.models[id];
  }
  return state;
}

export function saveState(state) {
  state.updatedAt = Date.now();
  writeJSON(statePath(), state);
  return state;
}

export function appendTrace(trace) {
  ensureDir();
  const file = tracePath();
  fs.appendFileSync(file, `${JSON.stringify(trace)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  try {
    if (fs.statSync(file).size > TRACE_MAX_BYTES) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(-TRACE_KEEP_LINES).join("\n")}\n`, { mode: 0o600 });
    }
  } catch {
    /* rotation is housekeeping; never fail a request for it */
  }
}

export function readTraces(limit = 50) {
  const file = tracePath();
  let text;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 512 * 1024);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean);
  const out = [];
  for (const line of lines.slice(-Math.max(1, Math.min(500, limit)))) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn last line after a crash */
    }
  }
  return out;
}
