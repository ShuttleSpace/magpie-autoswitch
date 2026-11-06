import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  PROVIDER,
  VERSION,
  cooldownFor,
  cooldownSummary,
  discoverFreeModels,
  buildModelCatalog,
  paidCandidates,
  summarizeUpstream,
  quotaPressure,
  stuckCalls,
  demoteUpstream,
  buildStatsCharts,
  STRATEGIES,
  STRATEGY_LABELS,
  reorderByExpiry,
  formatPaidWindow,
  parsePaidWindow,
  withinPaidWindow,
  matchesModel,
  needsOf,
  selectCandidates,
  shouldStop,
} from "./core.mjs";
import { appendTrace, configPath, loadConfig, loadState, readAllProviders, readCredits, readTraces, saveState, writeJSON, STATE_MAX_AGE } from "./config.mjs";
import { fetchModelRows, fetchUsageRows, fetchConcurrency, fetchQuotas, gatewayAddress, postChat, readLimited } from "./gateway.mjs";
import { createConsole } from "./console.mjs";

const SDK = "@ai-sdk/openai-compatible";
// The gateway never contacts this address: a plugin's fetch is the provider.
// It only has to be a valid base for the model rows magpie builds.
const BASE = "http://127.0.0.1/free-switch/v1";
const MAX_PREFIX = 16 * 1024;

let providerIcon;

function iconURI() {
  if (providerIcon !== undefined) return providerIcon;
  try {
    providerIcon = `data:image/png;base64,${fs.readFileSync(new URL("../icon.png", import.meta.url)).toString("base64")}`;
  } catch {
    providerIcon = "";
  }
  return providerIcon;
}

function log(input, level, message) {
  try {
    input?.client?.app?.log?.({ body: { service: PROVIDER, level, message } });
  } catch {
    /* logging must never break a request */
  }
}

function bool(value) {
  return typeof value === "boolean" ? value : undefined;
}

function envBool(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}

function modelDef(count = 0, maxContext = 0) {
  const context = Math.max(32_768, Math.min(1_000_000, maxContext || 131_072));
  const output = Math.max(4096, Math.min(65_536, Math.floor(context / 4)));
  return {
    id: "auto",
    providerID: PROVIDER,
    name: count > 0 ? `AutoSwitch · Auto (${count})` : "AutoSwitch · Auto",
    api: { id: "auto", url: BASE, npm: SDK },
    limit: { context, output },
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      attachment: true,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    },
    options: {},
    headers: {},
    status: "active",
    release_date: "",
    free: true,
  };
}

function prepareBody(body, candidate) {
  const next = { ...body, model: candidate.id };
  const levels = Array.isArray(candidate.reasoningLevels) ? candidate.reasoningLevels : [];
  const unsupportedEffort =
    typeof next.reasoning_effort === "string" && levels.length > 0 && !levels.includes(next.reasoning_effort);
  if (candidate.reasoning === false || unsupportedEffort) {
    delete next.reasoning_effort;
    delete next.reasoning;
    delete next.thinking;
    if (next.output_config && typeof next.output_config === "object" && next.output_config.effort !== undefined) {
      const { effort, ...rest } = next.output_config;
      if (Object.keys(rest).length) next.output_config = rest;
      else delete next.output_config;
    }
  }
  if (next.stream === true) next.stream_options = { ...next.stream_options, include_usage: true };
  return next;
}

function errorResponse(status, message, attempts = [], retryAfter = 0, requestId = "") {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "x-free-switch-attempts": String(attempts.length),
  };
  if (requestId) headers["x-free-switch-request"] = requestId;
  if (retryAfter > 0) headers["retry-after"] = String(Math.ceil(retryAfter));
  const body = {
    error: {
      type: status === 429 ? "rate_limit_error" : "free_switch_exhausted",
      message,
      attempts: attempts.map((a) => ({
        model: a.model,
        status: a.status || 0,
        ms: a.ms,
        reason: a.reason,
        cooldownUntil: a.cooldownUntil,
        error: a.error ? String(a.error).slice(0, 500) : undefined,
      })),
    },
  };
  return new Response(JSON.stringify(body), { status, headers });
}

function decorate(response, candidate, trace) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("x-free-switch-model", candidate.id);
  headers.set("x-free-switch-request", trace.id);
  headers.set("x-free-switch-attempts", String(trace.attempts.length));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function passthroughError(response, text, candidate, trace) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("x-free-switch-model", candidate.id);
  headers.set("x-free-switch-request", trace.id);
  headers.set("x-free-switch-attempts", String(trace.attempts.length));
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}

function replayResponse(response, chunks, reader) {
  let index = 0;
  const stream = new ReadableStream(
    {
      async pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
          return;
        }
        try {
          const part = await reader.read();
          if (part.done) controller.close();
          else controller.enqueue(part.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function inspectStream(text) {
  const trimmed = text.trimStart();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed);
      if (value?.error) return { ok: false, error: JSON.stringify(value.error).slice(0, 500) };
      return { ok: true };
    } catch {
      return undefined;
    }
  }
  if (/^event:\s*error/m.test(trimmed)) return { ok: false, error: trimmed.slice(0, 500) };
  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") return { ok: true };
    try {
      const value = JSON.parse(data);
      if (value?.error || value?.type === "error") {
        return { ok: false, error: JSON.stringify(value.error ?? value).slice(0, 500) };
      }
      return { ok: true };
    } catch {
      // A data line split across chunks: keep reading.
      return undefined;
    }
  }
  return undefined;
}

// 首字节守卫：等待响应头 / 首个 SSE event 时限时；每收到一个 chunk 就重置，
// 所以慢慢输出 reasoning 的模型不会被误杀，真正「挂着不发数据」的才超时。
// 成功后必须 clear()，否则会中断已经开始的流式输出。
function firstByteGuard(requestSignal, seconds) {
  const ms = Number(seconds) > 0 ? Number(seconds) * 1000 : 0;
  if (!ms) return { signal: requestSignal, clear() {}, reset() {}, timedOut: () => false, ms: 0 };
  const controller = new AbortController();
  let timer;
  let expired = false;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = () => {
    if (expired) return;
    clear();
    timer = setTimeout(() => {
      expired = true;
      controller.abort(new Error(`first byte timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    timer.unref?.();
  };
  if (typeof AbortSignal.any !== "function" || !requestSignal) {
    return { signal: requestSignal, clear() {}, reset() {}, timedOut: () => false, ms: 0 };
  }
  arm();
  const composed = AbortSignal.any([requestSignal, controller.signal]);
  return {
    signal: composed,
    clear,
    reset: arm,
    timedOut: () => expired,
    ms,
  };
}

async function peekStream(response, guard) {
  if (!response.body) return { ok: true, response };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (bytes < MAX_PREFIX) {
      const part = await reader.read();
      if (part.done) {
        const hasPayload = /^\s*data:/m.test(text) || text.trimStart().startsWith("{");
        if (!hasPayload) return { ok: false, error: "upstream returned an empty stream" };
        const verdict = inspectStream(text);
        if (verdict) return verdict.ok ? { ok: true, response: replayResponse(response, chunks, reader) } : verdict;
        return { ok: false, error: "upstream stream had no parsable event" };
      }
      chunks.push(part.value);
      bytes += part.value.byteLength;
      text += decoder.decode(part.value, { stream: true });
      guard?.reset();
      const verdict = inspectStream(text);
      if (verdict) {
        if (!verdict.ok) {
          try {
            await reader.cancel();
          } catch {
            /* already closed */
          }
          return verdict;
        }
        return { ok: true, response: replayResponse(response, chunks, reader) };
      }
    }
    // Keepalive comments or a provider that never sends a data line: the
    // status was 200 and the caller may still get a usable stream.
    return { ok: true, response: replayResponse(response, chunks, reader) };
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      /* already closed */
    }
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export async function createFreeSwitchPlugin(input = {}, _options = {}) {
  const state = loadState();
  const traces = readTraces(100);
  let cache = { models: [], catalog: [], at: 0, error: undefined };
  let upstreamCache = { at: 0, fetching: null, error: undefined, rows: [], active: [], quotas: [], data: {} };
  let discovery;
  let lastLoggedCount = -1;
  let consoleTimer;
  let upstreamTimer;
  let consoleStarting = false;
  let lastConsoleURL = "";
  let disposed = false;

  const console = createConsole({
    getState: () => getState(),
    refresh: (force) => discover(force),
    clearCooldown: (model) => clearCooldown(model),
    disable: (body) => disableWith(body),
    enable: (body) => enableWith(body),
    switch: (value) => setManualSwitch(typeof value === "string" ? value : value?.model),
    cancelSwitch: () => cancelManualSwitch(),
    setStrategy: (strategy) => setStrategy(strategy),
    setConfig: (config) => setConfig(config),
    refreshUpstream: () => refreshUpstream(true),
  });

  function effectiveConfig() {
    const config = loadConfig();
    try {
      if (typeof input?.magpie?.option === "function") {
        const ids = [PROVIDER, `${PROVIDER}-plugin`];
        const values = ids.map((id) => bool(input.magpie.option(id, "console"))).filter((value) => value !== undefined);
        if (values.length) config.console = values.includes(true);
      }
    } catch {
      /* an older host without options */
    }
    // An explicit environment variable is for headless/server use and wins.
    const envConsole = envBool("FREE_SWITCH_CONSOLE");
    if (envConsole !== undefined) config.console = envConsole;
    return config;
  }

  async function discover(force = false, signal) {
    const config = effectiveConfig();
    if (!force && cache.at && Date.now() - cache.at < config.refreshSeconds * 1000) return cache.models;
    if (discovery) return discovery;
    discovery = (async () => {
      try {
        const rows = await fetchModelRows(signal);
        const models = discoverFreeModels(rows, config);
        const catalog = buildModelCatalog(rows, config);
        cache = { models, catalog, at: Date.now(), error: undefined };
        if (models.length !== lastLoggedCount) {
          lastLoggedCount = models.length;
          log(input, "info", `discovered ${models.length} free model${models.length === 1 ? "" : "s"}`);
        }
        return models;
      } catch (error) {
        signal?.throwIfAborted();
        cache = { ...cache, error: String(error?.message ?? error) };
        if (cache.models.length) {
          log(input, "warn", `model discovery failed, keeping ${cache.models.length} known free models: ${cache.error}`);
          return cache.models;
        }
        throw error;
      } finally {
        discovery = undefined;
      }
    })();
    return discovery;
  }

  // 读取 Magpie 网关的只读观测端点。全部并行、独立超时、失败保留旧数据；
  // 拿不到时 upstreamCache.error 只在控制台显示，不影响任何请求路径。
  async function refreshUpstream(force = false) {
    const config = effectiveConfig();
    if (!force && upstreamCache.at && Date.now() - upstreamCache.at < config.upstreamRefreshSeconds * 1000) return upstreamCache;
    if (upstreamCache.fetching) return upstreamCache.fetching;
    upstreamCache.fetching = (async () => {
      const results = await Promise.allSettled([fetchUsageRows(undefined, 500), fetchConcurrency(), fetchQuotas()]);
      const rows = results[0].status === "fulfilled" ? results[0].value : undefined;
      const concurrency = results[1].status === "fulfilled" ? results[1].value : undefined;
      const quotas = results[2].status === "fulfilled" ? results[2].value : undefined;
      const errors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason));
      const unavailable = results.filter((r) => r.status === "fulfilled" && r.value === undefined).length;
      upstreamCache = {
        at: Date.now(),
        fetching: null,
        rows: rows ?? upstreamCache.rows,
        active: concurrency?.active ?? upstreamCache.active,
        data: concurrency?.data ?? upstreamCache.data,
        quotas: quotas ?? upstreamCache.quotas,
        error: errors.length ? errors.join("; ") : unavailable ? `${unavailable} 个观测端点不可用（可能版本较旧）` : undefined,
      };
      return upstreamCache;
    })();
    return upstreamCache.fetching;
  }

  function upstreamView(config = effectiveConfig()) {
    const now = Date.now();
    return {
      at: upstreamCache.at || null,
      error: upstreamCache.error ?? null,
      summary: summarizeUpstream(upstreamCache.rows, {
        now,
        windowMs: config.upstreamWindowSeconds * 1000,
        minErrors: config.upstreamMinErrors,
        maxSoftCooldownMs: config.upstreamMaxSoftCooldownSeconds * 1000,
      }),
      quotas: quotaPressure(upstreamCache.quotas),
      active: upstreamCache.active,
      data: upstreamCache.data,
      stuck: stuckCalls(upstreamCache.active, config.upstreamStuckMs),
      windowSeconds: config.upstreamWindowSeconds,
    };
  }

  function markCooldown(candidate, cooldown, status, error) {
    const previous = state.models[candidate.id] ?? {};
    state.models[candidate.id] = {
      ...previous,
      provider: candidate.provider,
      name: candidate.name,
      until: cooldown.until,
      reason: cooldown.reason,
      failures: cooldown.failures,
      disabled: !!cooldown.disabled,
      lastStatus: status,
      lastError: error ? String(error).slice(0, 1000) : previous.lastError,
      lastAttemptAt: Date.now(),
    };
    try {
      saveState(state);
    } catch {
      /* a read-only config directory must not break a request */
    }
  }

  function markSuccess(candidate, status) {
    const previous = state.models[candidate.id] ?? {};
    state.models[candidate.id] = {
      ...previous,
      provider: candidate.provider,
      name: candidate.name,
      until: 0,
      reason: undefined,
      failures: 0,
      disabled: false,
      lastStatus: status,
      lastError: undefined,
      lastSuccessAt: Date.now(),
      lastAttemptAt: Date.now(),
    };
    try {
      saveState(state);
    } catch {
      /* a read-only config directory must not break a request */
    }
  }

  function finishTrace(trace) {
    if (trace.finished) return;
    trace.finished = true;
    trace.durationMs = Math.max(0, Date.now() - trace.at);
    state.stats.requests += 1;
    state.stats.attempts += trace.attempts.length;
    state.stats.switches += Math.max(0, trace.attempts.length - 1);
    if (trace.ok) state.stats.successes += 1;
    else if (trace.exhausted) state.stats.exhausted += 1;
    else state.stats.failures += 1;
    try {
      saveState(state);
    } catch {
      /* a read-only config directory must not break a request */
    }
    traces.push(trace);
    while (traces.length > 200) traces.shift();
    try {
      appendTrace(trace);
    } catch {
      /* tracing is housekeeping; the in-memory list still has it */
    }
  }

  function retryAfterOf(attempts) {
    const now = Date.now();
    const times = attempts.map((a) => a.cooldownUntil).filter((x) => Number.isFinite(x) && x > now);
    if (!times.length) return 30;
    return Math.max(1, Math.ceil((Math.min(...times) - now) / 1000));
  }

  async function handleChat(request, body) {
    const requested = typeof body.model === "string" ? body.model.trim() : "";
    const isAuto = requested === "auto" || requested === "free" || requested === "default" || /\/auto$/.test(requested);
    if (!isAuto) {
      return errorResponse(404, `AutoSwitch 只提供 ${PROVIDER}/auto，收到 ${requested || "(空)"}`);
    }
    const session =
      request.headers.get("x-magpie-session") ||
      request.headers.get("x-session-id") ||
      request.headers.get("x-session-affinity") ||
      (typeof body.metadata?.session_id === "string" ? body.metadata.session_id : "") ||
      "";
    const trace = {
      id: randomUUID(),
      at: Date.now(),
      requested: requested || "auto",
      session: session || undefined,
      stream: body.stream === true,
      attempts: [],
      ok: false,
      exhausted: false,
    };

    let models;
    try {
      models = await discover(false, request.signal);
    } catch (error) {
      trace.error = `discovery failed: ${String(error?.message ?? error)}`;
      finishTrace(trace);
      return errorResponse(503, `无法从 Magpie 获取免费模型：${trace.error}`, trace.attempts, 0, trace.id);
    }
    if (!models.length) {
      trace.exhausted = true;
      trace.error = "no free models discovered";
      finishTrace(trace);
      return errorResponse(503, "没有发现免费模型。请确认 Magpie 里已启用至少一个提供免费模型的供应商，然后刷新模型列表。", trace.attempts, 0, trace.id);
    }

    const config = effectiveConfig();
    const needs = needsOf(body);
    const catalog = cache.catalog ?? [];
    const manual = state.manualSwitch && typeof state.manualSwitch.model === "string" ? state.manualSwitch : null;
    let forced = null;
    let forcedDisabled = false;
    if (manual) {
      // 手动切换：先在免费池里找，找不到再到全量目录里找付费模型（用户在控制台
      // 显式点了「切换」，此时允许计费）。两种情况都把 forced 排到候选最前。
      forced = models.find((m) => m.id === manual.model || m.id.startsWith(`${manual.model}/`)) || null;
      if (!forced) {
        const paid = catalog.find((m) => m.free === false && (m.id === manual.model || m.id.startsWith(`${manual.model}/`)));
        if (paid) {
          forced = paid;
          log(input, "warn", `manual switch to PAID model ${paid.id}: this attempt may incur charges`);
        }
      }
      forcedDisabled = !!forced && !!(state.models[forced.id]?.disabled || (Array.isArray(state.disabledProviders) && state.disabledProviders.some((p) => matchesModel(forced, p))));
      if (forced && !forcedDisabled) {
        state.models[forced.id] = { ...(state.models[forced.id] ?? {}), until: 0, reason: undefined, failures: 0, disabled: false, lastAttemptAt: Date.now() };
      }
      // 一次性：消费后立即落盘，避免重启后旧切换被重复应用。
      state.manualSwitch = null;
      try {
        saveState(state);
      } catch {
        /* a read-only config directory must not break a request */
      }
    }
    const selection = selectCandidates(models, state.models, needs, config, Date.now(), state.disabledProviders);
    const strategy = STRATEGIES.has(config.strategy) ? config.strategy : "free";
    // 上游雷达：只把观察到近期 429/5xx 的模型排到末尾，不删除候选。
    // 数据来自后台缓存，拿不到时 summary 为空 → demoteUpstream 原样返回。
    const upstream = upstreamView(config);
    let ordered = demoteUpstream(selection.ordered, upstream.summary, Date.now());
    const max = Math.max(1, Math.min(20, Math.trunc(Number(config.maxTries) || 6)));
    if (strategy === "paid-first" || strategy === "free-first" || strategy === "expiry-first") {
      // 策略并入付费候选。付费候选受 maxPaidTries 严格限制；合并后整体按
      // maxTries 切片，保证单次请求总尝试数有上限，避免失控计费。
      const paid = demoteUpstream(paidCandidates(catalog, state.models, needs, config, Date.now(), state.disabledProviders, readCredits()), upstream.summary, Date.now())
        .filter((m) => !forced || m.id !== forced.id)
        .slice(0, Math.max(0, Math.trunc(Number(config.maxPaidTries) || 0)));
      // paid-first 以付费在前、免费在后；free-first / expiry-first 反之。
      ordered = strategy === "paid-first" ? [...paid, ...ordered] : [...ordered, ...paid];
      ordered = ordered.slice(0, max);
      if (strategy === "expiry-first") {
        // 免费优先的基础上，段内按「积分/配额即将到期」重排：到期越近越先用，
        // 无到期信息的型号沉到该段末尾。
        ordered = reorderByExpiry(ordered, readCredits());
      }
    }
    if (forced && !forcedDisabled) {
      ordered = [forced, ...ordered.filter((m) => m.id !== forced.id)];
    }
    // 付费策略模式下候选来自 paidCandidates（已按能力过滤或放宽），直接用 ordered
    // 判断是否有可用候选，避免只看免费池的 capability 计数。
    const capabilityOk = strategy === "free" ? selection.capable > 0 : ordered.some((m) => supports(m, needs));
    if (!ordered.length || ((needs.tools || needs.images || needs.reasoning) && !capabilityOk)) {
      trace.exhausted = true;
      trace.error = "no candidate for request capabilities";
      finishTrace(trace);
      return errorResponse(503, `没有满足本次请求能力要求的免费模型（工具=${needs.tools ? "是" : "否"}，图片=${needs.images ? "是" : "否"}，推理=${needs.reasoning ? "是" : "否"}）。`, trace.attempts, 0, trace.id);
    }

    let last;
    for (const candidate of ordered) {
      if (request.signal.aborted) {
        trace.aborted = true;
        break;
      }
      const attemptStarted = Date.now();
      const attempt = {
        model: candidate.id,
        provider: candidate.provider,
        startedAt: attemptStarted,
        status: 0,
        ok: false,
        ms: 0,
      };
      trace.attempts.push(attempt);
      const upstreamBody = prepareBody(body, candidate);
      // 首字节守卫：上游 429/5xx 常常几十秒甚至几分钟不回首个 event。
      // 超时按网络错误处理（短冷却 + 立刻切下一个），成功则清除守卫，
      // 不能中断已经开始输出 token 的流。
      const guard = firstByteGuard(request.signal, config.firstByteTimeoutSeconds);
      let response;
      try {
        response = await postChat(upstreamBody, { signal: guard.signal, session: session || undefined });
      } catch (error) {
        const timedOut = guard.timedOut();
        guard.clear();
        attempt.ms = Date.now() - attemptStarted;
        attempt.error = String(error?.message ?? error);
        attempt.timedOut = timedOut;
        if (request.signal.aborted) {
          trace.aborted = true;
          break;
        }
        const cooldown = cooldownFor({
          status: 0,
          error,
          previousFailures: state.models[candidate.id]?.failures ?? 0,
          now: attemptStarted,
          config,
        });
        if (cooldown) {
          attempt.reason = timedOut ? "first byte timeout" : cooldown.reason;
          attempt.cooldownUntil = cooldown.until;
          markCooldown(candidate, { ...cooldown, reason: attempt.reason }, 0, attempt.error);
        }
        last = { status: 0, text: attempt.error };
        log(input, "warn", `${candidate.id}: ${timedOut ? "first byte timeout" : attempt.error}`);
        continue;
      }
      // 非流式：响应头到达即视为首字节已到，不能让守卫杀掉正在生成的长回复。
      if (upstreamBody.stream !== true) guard.clear();

      try {
        attempt.status = response.status;
      if (!response.ok) {
        let text;
        try {
          text = await readLimited(response, 64 * 1024);
        } catch (error) {
          text = String(error?.message ?? error);
        }
        attempt.ms = Date.now() - attemptStarted;
        attempt.error = text.slice(0, 1000);
        const cooldown = cooldownFor({
          status: response.status,
          headers: response.headers,
          bodyText: text,
          previousFailures: state.models[candidate.id]?.failures ?? 0,
          now: attemptStarted,
          config,
        });
        if (cooldown) {
          attempt.reason = cooldown.reason;
          attempt.cooldownUntil = cooldown.until;
          markCooldown(candidate, cooldown, response.status, attempt.error);
        }
        last = { status: response.status, text, response };
        log(input, "warn", `${candidate.id}: HTTP ${response.status}${cooldown ? `, cooling ${cooldown.seconds}s` : ""}`);
        if (shouldStop(response.status, text)) {
          trace.error = text.slice(0, 500);
          trace.finalModel = candidate.id;
          finishTrace(trace);
          return passthroughError(response, text, candidate, trace);
        }
        continue;
      }

      if (upstreamBody.stream === true) {
        const peek = await peekStream(response, guard);
        attempt.ms = Date.now() - attemptStarted;
        if (!peek.ok) {
          attempt.error = peek.error;
          if (request.signal.aborted) {
            trace.aborted = true;
            break;
          }
          attempt.status = 502;
          const cooldown = cooldownFor({
            status: 502,
            headers: response.headers,
            bodyText: peek.error,
            previousFailures: state.models[candidate.id]?.failures ?? 0,
            now: attemptStarted,
            config,
          });
          if (cooldown) {
            attempt.reason = cooldown.reason;
            attempt.cooldownUntil = cooldown.until;
            markCooldown(candidate, cooldown, 502, peek.error);
          }
          last = { status: 502, text: peek.error };
          log(input, "warn", `${candidate.id}: stream error: ${peek.error}`);
          continue;
        }
        attempt.ok = true;
        markSuccess(candidate, response.status);
        trace.ok = true;
        trace.finalModel = candidate.id;
        finishTrace(trace);
        log(input, "info", `${candidate.id} answered after ${trace.attempts.length} attempt${trace.attempts.length === 1 ? "" : "s"}`);
        return decorate(peek.response, candidate, trace);
      }

      let text;
      try {
        text = await response.text();
      } catch (error) {
        attempt.ms = Date.now() - attemptStarted;
        attempt.status = 502;
        attempt.error = String(error?.message ?? error);
        last = { status: 502, text: attempt.error };
        log(input, "warn", `${candidate.id}: ${attempt.error}`);
        continue;
      }
      attempt.ms = Date.now() - attemptStarted;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!text.trim() || parsed?.error) {
        attempt.error = parsed?.error ? JSON.stringify(parsed.error).slice(0, 1000) : "upstream returned an empty body";
        attempt.status = 502;
        const cooldown = cooldownFor({
          status: 502,
          headers: response.headers,
          bodyText: attempt.error,
          previousFailures: state.models[candidate.id]?.failures ?? 0,
          now: attemptStarted,
          config,
        });
        if (cooldown) {
          attempt.reason = cooldown.reason;
          attempt.cooldownUntil = cooldown.until;
          markCooldown(candidate, cooldown, 502, attempt.error);
        }
        last = { status: 502, text };
        log(input, "warn", `${candidate.id}: ${attempt.error}`);
        continue;
      }
      attempt.ok = true;
      markSuccess(candidate, response.status);
      trace.ok = true;
      trace.finalModel = candidate.id;
      finishTrace(trace);
      log(input, "info", `${candidate.id} answered after ${trace.attempts.length} attempt${trace.attempts.length === 1 ? "" : "s"}`);
      return decorate(new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }), candidate, trace);
      } finally {
        guard.clear();
      }
    }
    trace.error = last?.text?.slice(0, 500) || last?.error?.message || last?.error || "all candidates failed";
    finishTrace(trace);
    const status = trace.attempts.length && trace.attempts.every((a) => a.status === 429) ? 429 : 502;
    return errorResponse(
      status,
      `所有免费模型都不可用（尝试 ${trace.attempts.length} 个）。最近错误：${trace.error}`,
      trace.attempts,
      retryAfterOf(trace.attempts),
      trace.id,
    );
  }

  function disableModel(modelId) {
    const id = typeof modelId === "string" ? modelId.trim() : "";
    if (!id) return { ok: false, error: "missing model" };
    const previous = state.models[id] ?? {};
    state.models[id] = {
      ...previous,
      provider: previous.provider,
      name: previous.name,
      disabled: true,
      until: 0,
      reason: "手动禁用",
      failures: previous.failures ?? 0,
      lastAttemptAt: Date.now(),
    };
    try {
      saveState(state);
    } catch {
      /* a read-only config directory must not break a request */
    }
    return { ok: true };
  }

  function enableModel(modelId) {
    const id = typeof modelId === "string" ? modelId.trim() : "";
    if (!id) return { ok: false, error: "missing model" };
    // Clearing the entry clears the manual disable flag (and the cooldown).
    clearCooldown(id);
    return { ok: true };
  }

  function disableProvider(provider) {
    const p = typeof provider === "string" ? provider.trim() : "";
    if (!p) return { ok: false, error: "missing provider" };
    const list = Array.isArray(state.disabledProviders) ? [...state.disabledProviders] : [];
    if (!list.includes(p)) list.push(p);
    state.disabledProviders = list;
    try {
      saveState(state);
    } catch {
      /* a read-only config directory must not break a request */
    }
    return { ok: true };
  }

  function enableProvider(provider) {
    const p = typeof provider === "string" ? provider.trim() : "";
    if (!p) return { ok: false, error: "missing provider" };
    state.disabledProviders = (Array.isArray(state.disabledProviders) ? [...state.disabledProviders] : []).filter((x) => x !== p);
    try {
      saveState(state);
    } catch {
      /* a read-only config directory must not break a request */
    }
    return { ok: true };
  }

  async function disableWith(body = {}) {
    const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    if (provider) return disableProvider(provider);
    if (model) return disableModel(model);
    return { ok: false, error: "missing model or provider" };
  }

  async function enableWith(body = {}) {
    const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    if (provider) return enableProvider(provider);
    if (model) return enableModel(model);
    return { ok: false, error: "missing model or provider" };
  }

  function setManualSwitch(model) {
    const m = typeof model === "string" ? model.trim() : "";
    if (!m) return { ok: false, error: "missing model" };
    state.manualSwitch = { model: m, at: Date.now() };
    try {
      saveState(state);
    } catch {
      /* a read-only config directory must not break a request */
    }
    return { ok: true };
  }

  function cancelManualSwitch() {
    state.manualSwitch = null;
    try {
      saveState(state);
    } catch {
      /* a read-only config directory must not break a request */
    }
    return { ok: true };
  }

  // 控制台设置自动切换策略与付费策略参数。策略只影响自动候选池；手动切换到
  // 付费模型始终可用。接受 { strategy, maxPaidTries, paidWindow, paidMinBalance }
  // （旧调用也可直接传 strategy 字符串）。
  function setStrategy(input) {
    const body = input && typeof input === "object" ? input : { strategy: input };
    const config = loadConfig();
    if (body.strategy !== undefined) {
      const s = typeof body.strategy === "string" ? body.strategy.trim() : "";
      if (!STRATEGIES.has(s)) return { ok: false, error: `unknown strategy: ${s || "(empty)"}` };
      config.strategy = s;
    }
    if (body.maxPaidTries !== undefined) {
      const n = Number(body.maxPaidTries);
      if (!Number.isFinite(n)) return { ok: false, error: "maxPaidTries must be a number" };
      config.maxPaidTries = Math.max(0, Math.min(20, Math.trunc(n)));
    }
    if (body.paidWindow !== undefined) {
      const raw = body.paidWindow === "" ? null : body.paidWindow;
      const parsed = parsePaidWindow(raw);
      if (raw !== null && raw !== undefined && !parsed) {
        return { ok: false, error: "paidWindow must look like 22:00-06:00" };
      }
      config.paidWindow = formatPaidWindow(parsed);
    }
    if (body.paidMinBalance !== undefined) {
      const n = Number(body.paidMinBalance);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: "paidMinBalance must be >= 0" };
      config.paidMinBalance = n > 0 ? n : 0;
    }
    try {
      writeJSON(configPath(), config);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    return { ok: true };
  }

  // 控制台「设置」面板可手动配置的参数白名单：核心调度参数 + 付费/策略参数。
  // 每个字段独立校验，校验不通过的字段被忽略（不影响其它字段），返回 changed
  // 列表便于前端提示。与 setStrategy 共用同一份 loadConfig/writeJSON 落盘路径。
  function setConfig(input) {
    const body = input && typeof input === "object" ? input : {};
    const config = loadConfig();
    const changed = [];
    const clampInt = (key, min, max, raw) => {
      if (raw === undefined) return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      config[key] = Math.max(min, Math.min(max, Math.trunc(n)));
      changed.push(key);
    };
    if (body.strategy !== undefined) {
      const s = typeof body.strategy === "string" ? body.strategy.trim() : "";
      if (!STRATEGIES.has(s)) return { ok: false, error: `unknown strategy: ${s || "(empty)"}` };
      config.strategy = s;
      changed.push("strategy");
    }
    clampInt("maxTries", 1, 20, body.maxTries);
    clampInt("refreshSeconds", 5, 3600, body.refreshSeconds);
    clampInt("cooldownSeconds", 1, 86400, body.cooldownSeconds);
    clampInt("firstByteTimeoutSeconds", 0, 600, body.firstByteTimeoutSeconds);
    clampInt("maxPaidTries", 0, 20, body.maxPaidTries);
    if (body.paidWindow !== undefined) {
      const raw = body.paidWindow === "" ? null : body.paidWindow;
      const parsed = parsePaidWindow(raw);
      if (raw !== null && raw !== undefined && !parsed) {
        return { ok: false, error: "paidWindow must look like 22:00-06:00" };
      }
      config.paidWindow = formatPaidWindow(parsed);
      changed.push("paidWindow");
    }
    if (body.paidMinBalance !== undefined) {
      const n = Number(body.paidMinBalance);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: "paidMinBalance must be >= 0" };
      config.paidMinBalance = n > 0 ? n : 0;
      changed.push("paidMinBalance");
    }
    if (body.tryCooling !== undefined) {
      const v = bool(body.tryCooling);
      if (v !== undefined) {
        config.tryCooling = v;
        changed.push("tryCooling");
      }
    }
    try {
      writeJSON(configPath(), config);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    return { ok: true, changed };
  }

  function clearCooldown(model) {
    if (model) delete state.models[model];
    else state.models = {};
    try {
      saveState(state);
    } catch {
      /* the in-memory reset still works */
    }
  }

  function getState() {
    const config = effectiveConfig();
    const now = Date.now();
    // 清理长期未使用且已苏醒的模型条目，防止 state.models 无限增长
    for (const id of Object.keys(state.models)) {
      const entry = state.models[id];
      const until = Number(entry.until ?? 0);
      const last = Number(entry.lastAttemptAt ?? entry.updatedAt ?? 0);
      if (until <= now && (!last || now - last > STATE_MAX_AGE)) {
        delete state.models[id];
      }
    }
    const models = cache.models.map((model) => {
      const entry = state.models[model.id] ?? {};
      const summary = cooldownSummary(entry, now);
      const preferred = Array.isArray(config.preferredModels) && config.preferredModels.some((p) => matchesModel(model, p));
      return {
        id: model.id,
        provider: model.provider,
        name: model.name,
        preferred,
        cooling: summary.cooling,
        until: summary.until,
        failures: entry.failures ?? 0,
        lastStatus: entry.lastStatus ?? null,
        lastError: entry.lastError ?? null,
        reason: entry.reason ?? null,
        disabled: !!entry.disabled || (Array.isArray(state.disabledProviders) && state.disabledProviders.some((p) => matchesModel(model, p))),
        lastSuccessAt: entry.lastSuccessAt ?? null,
        context: model.context,
        image: model.image,
        toolcall: model.toolcall,
        reasoning: model.reasoning,
      };
    });
    const credits = readCredits();
    const paidWindowActive = withinPaidWindow(config.paidWindow, now);
    const paidMinBalance = Number(config.paidMinBalance) > 0 ? Number(config.paidMinBalance) : 0;
    const balanceByProvider = new Map();
    if (paidMinBalance) {
      for (const c of credits) {
        const b = Number(c?.balance);
        if (c?.provider && Number.isFinite(b)) balanceByProvider.set(c.provider, b);
      }
    }
    // 付费模型为何不参与自动切换：窗口外 / 余额低于下限。null 表示可自动使用。
    const paidBlockedReason = (model) => {
      if (model.free) return null;
      if (!paidWindowActive) return "window";
      const b = balanceByProvider.get(model.provider);
      if (b !== undefined && b < paidMinBalance) return "balance";
      return null;
    };
    return {
      now,
      gateway: gatewayAddress(),
      version: VERSION,
      strategies: [...STRATEGIES],
      strategyLabels: STRATEGY_LABELS,
      configFile: configPath(),
      discoveredAt: cache.at || null,
      discoveryError: cache.error ?? null,
      console: { url: console.url, port: console.port, running: console.running },
      stats: { ...state.stats },
      config: {
        maxTries: config.maxTries,
        refreshSeconds: config.refreshSeconds,
        cooldownSeconds: config.cooldownSeconds,
        countryBlockCooldownSeconds: config.countryBlockCooldownSeconds,
        tryCooling: config.tryCooling,
        priority: config.priority,
        includeProviders: config.includeProviders,
        excludeProviders: config.excludeProviders,
        preferredModels: config.preferredModels,
        strategy: config.strategy,
        maxPaidTries: config.maxPaidTries,
        paidWindow: config.paidWindow,
        paidMinBalance: config.paidMinBalance,
        paidWindowActive,
        firstByteTimeoutSeconds: config.firstByteTimeoutSeconds,
        upstreamRefreshSeconds: config.upstreamRefreshSeconds,
        upstreamWindowSeconds: config.upstreamWindowSeconds,
        upstreamMinErrors: config.upstreamMinErrors,
        maxResetSeconds: config.maxResetSeconds,
      },
      upstream: upstreamView(config),
      disabledProviders: Array.isArray(state.disabledProviders) ? [...state.disabledProviders] : [],
      manualSwitch: state.manualSwitch ?? null,
      allProviders: (() => {
        try { return readAllProviders(); } catch { return []; }
      })(),
      credits,
      models,
      catalog: (cache.catalog ?? []).map((model) => {
        const entry = state.models[model.id] ?? {};
        const summary = cooldownSummary(entry, now);
        const preferred = Array.isArray(config.preferredModels) && config.preferredModels.some((p) => matchesModel(model, p));
        return {
          id: model.id,
          provider: model.provider,
          name: model.name,
          free: !!model.free,
          paidBlocked: paidBlockedReason(model),
          cooling: summary.cooling,
          until: summary.until,
          failures: entry.failures ?? 0,
          lastStatus: entry.lastStatus ?? null,
          lastError: entry.lastError ?? null,
          reason: entry.reason ?? null,
          disabled: !!entry.disabled || (Array.isArray(state.disabledProviders) && state.disabledProviders.some((p) => matchesModel(model, p))),
          preferred,
          lastSuccessAt: entry.lastSuccessAt ?? null,
        };
      }),
      traces: traces.slice(-50).reverse(),
      statsCharts: buildStatsCharts(traces, { bucketCount: 12 }),
      activeModel: (() => {
        for (let i = traces.length - 1; i >= 0; i--) {
          const t = traces[i];
          if (t && t.finalModel) {
            return { id: t.finalModel, at: t.at, ok: !!t.ok };
          }
        }
        return null;
      })(),
    };
  }

  async function syncConsole() {
    if (disposed) return;
    const config = effectiveConfig();
    if (config.console) {
      if (console.running && (config.consolePort === 0 || console.requestedPort === config.consolePort)) return;
      if (consoleStarting) return;
      consoleStarting = true;
      try {
        const url = await console.start(config.consolePort);
        if (url !== lastConsoleURL) {
          lastConsoleURL = url;
          log(input, "info", `web console: ${url}`);
        }
      } catch (error) {
        log(input, "warn", `web console could not start on port ${config.consolePort}: ${String(error?.message ?? error)}`);
      } finally {
        consoleStarting = false;
      }
      return;
    }
    if (console.running) {
      await console.stop();
      lastConsoleURL = "";
    }
  }

  consoleTimer = setInterval(syncConsole, 5000);
  consoleTimer.unref?.();
  const kick = setTimeout(syncConsole, 0);
  kick.unref?.();
  const upstreamKick = setTimeout(() => { refreshUpstream(true).catch(() => {}); }, 0);
  upstreamKick.unref?.();
  upstreamTimer = setInterval(() => { refreshUpstream().catch(() => {}); }, Math.max(5, effectiveConfig().upstreamRefreshSeconds) * 1000);
  upstreamTimer.unref?.();

  return {
    lifecycle: {
      async dispose() {
        disposed = true;
        clearInterval(consoleTimer);
        clearInterval(upstreamTimer);
        clearTimeout(kick);
        clearTimeout(upstreamKick);
        await console.stop();
      },
    },
    async config(cfg) {
      cfg.provider ??= {};
      const previous = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        ...previous,
        name: previous.name || "AutoSwitch",
        npm: SDK,
        api: BASE,
        models: {
          ...(previous.models ?? {}),
          auto: modelDef(0),
        },
      };
    },
    auth: {
      provider: PROVIDER,
      single: true,
      icon: iconURI(),
      maxConcurrency: 4,
      options: [
        {
          key: "console",
          label: "本地 Web 控制台",
          description: "在 127.0.0.1 上打开追踪、冷却和免费模型面板。端口在 free-switch/config.json 的 consolePort，默认 17890。",
          default: false,
        },
      ],
      methods: [
        {
          type: "api",
          keyless: true,
          label: "启用 AutoSwitch（无需密钥）",
          placeholder: "public",
          async authorize() {
            return { type: "success", key: "public" };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        if (auth.type !== "api") throw new Error("AutoSwitch 使用免密钥登录");
        return {
          baseURL: BASE,
          apiKey: "public",
          async fetch(input, init) {
            const request = new Request(input, init);
            let pathname = "";
            try {
              pathname = new URL(request.url).pathname;
            } catch {
              /* the error below names the endpoint */
            }
            if (request.method !== "POST" || !pathname.endsWith("/chat/completions")) {
              throw new Error("Unsupported endpoint or method");
            }
            request.signal.throwIfAborted();
            let body;
            try {
              body = await request.json();
            } catch {
              throw new Error("Invalid JSON chat request");
            }
            if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid chat request");
            return handleChat(request, body);
          },
        };
      },
      async usage() {
        const config = effectiveConfig();
        const count = cache.models.length;
        const consoleText = console.running ? ` · ${console.url}` : config.console ? " · 控制台启动中" : "";
        return { plan: `AutoSwitch · ${count} 个免费模型${consoleText}`, windows: [] };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        let models = cache.models;
        try {
          models = await discover(false);
        } catch {
          models = cache.models;
        }
        const maxContext = models.reduce((value, model) => Math.max(value, model.context || 0), 0);
        return { auto: modelDef(models.length, maxContext) };
      },
    },
    // 供控制台 /api/config 调用的同一份落盘逻辑，暴露出来便于测试与复用。
    setConfig: (config) => setConfig(config),
  };
}

