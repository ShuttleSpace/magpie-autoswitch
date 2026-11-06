import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  cooldownActive,
  cooldownFor,
  buildModelCatalog,
  countryBlocked,
  discoverFreeModels,
  isFreeModel,
  modelProblem,
  needsOf,
  normalizeModel,
  paidCandidates,
  parseDuration,
  parsePaidWindow,
  parseReset,
  formatPaidWindow,
  withinPaidWindow,
  summarizeUpstream,
  quotaPressure,
  stuckCalls,
  demoteUpstream,
  buildStatsCharts,
  selectCandidates,
  shouldStop,
  supports,
} from "../src/core.mjs";

const free = (id, provider = id.split("/")[0], extra = {}) => ({
  id,
  owned_by: provider,
  display_name: id,
  pricing: { prompt: "0", completion: "0" },
  ...extra,
});

test("a model is free only when both directions are priced at zero", () => {
  assert.equal(isFreeModel(free("zen/a")), true);
  assert.equal(isFreeModel({ id: "paid/a", pricing: { prompt: "0.000001", completion: "0.000002" } }), false);
  assert.equal(isFreeModel({ id: "unknown/a" }), false);
  assert.equal(isFreeModel({ id: "null/a", pricing: { prompt: null, completion: null } }), false, "null pricing is unknown, not zero");
  assert.equal(isFreeModel({ id: "empty/a", pricing: { prompt: "", completion: "" } }), false, "empty pricing is unknown, not zero");
  assert.equal(isFreeModel({ id: "free/a" }), true, "a name with free and no pricing is the narrow fallback");
  assert.equal(isFreeModel({ id: "x/a", pricing: { prompt: 0, completion: 0 }, type: "embedding" }), true, "pricing decides; type is filtered later");
});

test("buildModelCatalog keeps all providers with a free flag, paid included", () => {
  const rows = [
    free("zen/a"),
    { id: "codearts/glm-5.3", pricing: { prompt: "0.000001", completion: "0.000002" } },
    free("zen/b"),
    { id: "free-switch/auto" },
  ];
  const catalog = buildModelCatalog(rows);
  assert.deepEqual(catalog.map((m) => m.id), ["codearts/glm-5.3", "zen/a", "zen/b"], "sorted by provider");
  assert.equal(catalog[0].free, false, "paid models stay in the catalog with free=false");
  assert.equal(catalog[1].free, true);
});

test("groups, self models and non-chat rows are not candidates", () => {
  assert.equal(normalizeModel(free("auto/hy3")), undefined);
  assert.equal(normalizeModel(free("group/fast")), undefined);
  assert.equal(normalizeModel(free("free-switch/auto")), undefined);
  assert.equal(normalizeModel(free("free-switch-plugin/auto", "free-switch-plugin")), undefined);
  assert.equal(normalizeModel({ ...free("x/a"), type: "embedding" }), undefined);
  assert.equal(normalizeModel({ ...free("x/a"), modalities: { output: ["image"] } }), undefined);
  assert.equal(normalizeModel(free("x/a"))?.provider, "x");
});

test("discovery keeps zero-priced rows, applies filters and priority", () => {
  const rows = [
    free("workbuddy/hy3", "workbuddy"),
    free("opencode-zen-free/b", "opencode-zen-free"),
    free("opencode-zen-free/a", "opencode-zen-free"),
    free("paid/c", "paid", { pricing: { prompt: "1", completion: "1" } }),
    free("auto/group", "workbuddy"),
    free("free-switch/auto", "free-switch"),
  ];
  const models = discoverFreeModels(rows, { ...DEFAULT_CONFIG, priority: ["opencode-zen-free", "workbuddy"] });
  assert.deepEqual(
    models.map((m) => m.id),
    ["opencode-zen-free/a", "workbuddy/hy3", "opencode-zen-free/b"],
    "one model per provider first, then the next round",
  );
  const strictOrder = discoverFreeModels(rows, { ...DEFAULT_CONFIG, priority: ["opencode-zen-free", "workbuddy"], diversifyProviders: false });
  assert.deepEqual(strictOrder.map((m) => m.id), ["opencode-zen-free/a", "opencode-zen-free/b", "workbuddy/hy3"]);
  const onlyZen = discoverFreeModels(rows, { ...DEFAULT_CONFIG, includeProviders: ["opencode-zen-free"] });
  assert.deepEqual(onlyZen.map((m) => m.id), ["opencode-zen-free/a", "opencode-zen-free/b"]);
  const noZen = discoverFreeModels(rows, { ...DEFAULT_CONFIG, excludeProviders: ["opencode-zen-free"] });
  assert.deepEqual(noZen.map((m) => m.id), ["workbuddy/hy3"]);
});

test("preferred models are tried first regardless of priority", () => {
  const rows = [
    free("workbuddy/hy3", "workbuddy"),
    free("opencode-zen-free/b", "opencode-zen-free"),
    free("opencode-zen-free/a", "opencode-zen-free"),
    free("kilo/x", "kilo"),
    free("cline/y", "cline"),
  ];
  const config = {
    ...DEFAULT_CONFIG,
    priority: ["opencode-zen-free", "kilo"],
    preferredModels: ["cline/y", "workbuddy/hy3"],
  };
  const models = discoverFreeModels(rows, config);
  const ids = models.map((m) => m.id);
  // Preferred models should appear before non-preferred ones.
  const firstPref = Math.min(...ids.filter((id) => config.preferredModels.includes(id)).map((id) => ids.indexOf(id)));
  const firstNonPref = Math.min(...ids.filter((id) => !config.preferredModels.includes(id)).map((id) => ids.indexOf(id)));
  assert.ok(firstPref < firstNonPref, "preferred models come first");
  assert.deepEqual(
    ids.filter((id) => config.preferredModels.includes(id)).sort(),
    ["cline/y", "workbuddy/hy3"],
    "all preferred models are present and first",
  );
});

test("preferred provider pattern moves all matching models first", () => {
  const rows = [
    free("workbuddy/hy3", "workbuddy"),
    free("opencode-zen-free/b", "opencode-zen-free"),
    free("opencode-zen-free/a", "opencode-zen-free"),
    free("kilo/x", "kilo"),
  ];
  const config = {
    ...DEFAULT_CONFIG,
    priority: ["opencode-zen-free"],
    preferredModels: ["kilo"],
  };
  const models = discoverFreeModels(rows, config);
  const ids = models.map((m) => m.id);
  assert.equal(ids[0], "kilo/x", "preferred provider's model comes first");
});

test("awake models come first and keep their order; all cooling keeps order too", () => {
  const models = ["a", "b", "c"].map((id) => ({ id, provider: "p", toolcall: true, image: true, reasoning: true }));
  const now = 1_000_000;
  const state = {
    a: { until: now - 1 },
    b: { until: now + 60_000 },
    c: { until: now + 120_000 },
  };
  const awake = selectCandidates(models, state, {}, { ...DEFAULT_CONFIG, maxTries: 6 }, now);
  assert.deepEqual(awake.ordered.map((m) => m.id), ["a", "b", "c"]);
  assert.equal(awake.awake, 1);
  assert.equal(awake.cooling, 2);

  const allCooling = selectCandidates(models, { a: { until: now + 1 }, b: { until: now + 2 }, c: { until: now + 3 } }, {}, { ...DEFAULT_CONFIG, maxTries: 6 }, now);
  assert.deepEqual(allCooling.ordered.map((m) => m.id), ["a", "b", "c"]);

  const awakeOnly = selectCandidates(models, state, {}, { ...DEFAULT_CONFIG, tryCooling: false }, now);
  assert.deepEqual(awakeOnly.ordered.map((m) => m.id), ["a"]);
});

test("disabled models and providers are excluded from the failover pool", () => {
  const models = [
    { id: "zen/a", provider: "zen", toolcall: true, image: true, reasoning: true },
    { id: "kilo/b", provider: "kilo", toolcall: true, image: true, reasoning: true },
    { id: "cline/c", provider: "cline", toolcall: true, image: true, reasoning: true },
  ];
  const now = 1_000_000;
  // model-level disable
  const withDisabled = { "kilo/b": { disabled: true, until: 0 } };
  const r1 = selectCandidates(models, withDisabled, {}, DEFAULT_CONFIG, now);
  assert.deepEqual(r1.ordered.map((m) => m.id), ["zen/a", "cline/c"], "disabled model skipped");
  assert.equal(r1.skippedDisabled, 1);
  // provider-level disable via the disabledProviders argument
  const r2 = selectCandidates(models, {}, {}, DEFAULT_CONFIG, now, ["cline"]);
  assert.deepEqual(r2.ordered.map((m) => m.id), ["zen/a", "kilo/b"], "disabled provider skipped");
  assert.equal(r2.skippedDisabled, 1);
  // a disabled model is excluded even if it would otherwise be cooling;
  // a non-disabled cooling model still takes part in the failover
  const cool = { "zen/a": { until: now + 50 } };
  const r3 = selectCandidates(models, { ...withDisabled, ...cool }, {}, DEFAULT_CONFIG, now);
  assert.deepEqual(r3.ordered.map((m) => m.id), ["cline/c", "zen/a"]);
  assert.ok(!r3.ordered.some((m) => m.id === "kilo/b"), "disabled kilo/b still excluded while cooling");
});

test("capability requirements filter candidates, then relax if nothing fits", () => {
  const models = [
    { id: "text", provider: "p", toolcall: false, image: false, reasoning: false },
    { id: "all", provider: "p", toolcall: true, image: true, reasoning: true },
  ];
  const needs = { tools: true, images: true, reasoning: true };
  const picked = selectCandidates(models, {}, needs, DEFAULT_CONFIG, 0);
  assert.deepEqual(picked.ordered.map((m) => m.id), ["all"]);
  assert.equal(supports(models[0], needs), false);
  assert.equal(supports(models[1], needs), true);

  const relaxed = selectCandidates([models[0]], {}, needs, DEFAULT_CONFIG, 0);
  assert.deepEqual(relaxed.ordered.map((m) => m.id), ["text"]);
  assert.equal(relaxed.capable, 0);
});

test("needsOf sees tools, images and reasoning", () => {
  assert.deepEqual(needsOf({ messages: [{ role: "user", content: "hi" }] }), {
    tools: false,
    images: false,
    reasoning: false,
    stream: false,
  });
  assert.equal(needsOf({ tools: [{ type: "function" }] }).tools, true);
  assert.equal(needsOf({ functions: [{ name: "x" }] }).tools, true);
  assert.equal(needsOf({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }).images, true);
  assert.equal(needsOf({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }).images, false);
  assert.equal(needsOf({ reasoning_effort: "high" }).reasoning, true);
  assert.equal(needsOf({ stream: true }).stream, true);
});

test("retry hints are read from headers and common error bodies", () => {
  const now = 1_700_000_000_000;
  const a = parseReset(new Headers({ "retry-after": "30" }), "", now);
  assert.equal(a.seconds, 30);
  const b = parseReset(new Headers({ "x-ratelimit-reset": String(Math.floor(now / 1000) + 90) }), "", now);
  assert.equal(b.seconds, 90);
  const c = parseReset(new Headers({}), '{"error":{"message":"Rate limit reached, try again in 2m30s"}}', now);
  assert.equal(c.seconds, 150);
  const d = parseReset(new Headers({}), `{"error":{"resets_at":"${new Date(now + 120_000).toISOString()}"}}`, now);
  assert.equal(d.seconds, 120);
  assert.equal(parseReset(new Headers({}), "no hint", now), undefined);
});

test("cooldownFor chooses the reset hint first, then a bounded backoff", () => {
  const now = 1_700_000_000_000;
  const config = { ...DEFAULT_CONFIG, cooldownSeconds: 60, serverErrorCooldownSeconds: 30, authErrorCooldownSeconds: 300, modelGoneCooldownSeconds: 600, maxCooldownSeconds: 3600 };
  const limited = cooldownFor({ status: 429, headers: new Headers({ "retry-after": "45" }), bodyText: "", now, config });
  assert.equal(limited.seconds, 45);
  assert.equal(limited.failures, 1);

  const noHint = cooldownFor({ status: 429, headers: new Headers({}), bodyText: "", previousFailures: 1, now, config });
  assert.equal(noHint.seconds, 120, "the second 429 doubles the base cooldown");

  const server = cooldownFor({ status: 503, headers: new Headers({}), bodyText: "", previousFailures: 0, now, config });
  assert.equal(server.seconds, 30);

  const serverWithHint = cooldownFor({ status: 503, headers: new Headers({ "retry-after": "120" }), bodyText: "", previousFailures: 0, now, config });
  assert.equal(serverWithHint.seconds, 120, "a 5xx retry hint wins over the backoff");

  const auth = cooldownFor({ status: 401, headers: new Headers({}), bodyText: "", now, config });
  assert.equal(auth.seconds, 300);

  const gone = cooldownFor({ status: 404, headers: new Headers({}), bodyText: "", now, config });
  assert.equal(gone.seconds, 600);

  const badRequest = cooldownFor({ status: 400, headers: new Headers({}), bodyText: "invalid temperature", now, config });
  assert.equal(badRequest, undefined);

  const modelBad = cooldownFor({ status: 400, headers: new Headers({}), bodyText: "model is not supported", now, config });
  assert.equal(modelBad.seconds, 600);
});

test("country-blocked responses are disabled for a long cooldown, not retried", () => {
  const now = 1_700_000_000_000;
  const config = { ...DEFAULT_CONFIG, countryBlockCooldownSeconds: 24 * 60 * 60, maxCooldownSeconds: 8 * 60 * 60 };
  const cases = [
    { status: 403, body: "This model is not available in your country" },
    { status: 400, body: "The model is not available in your region." },
    { status: 200, body: "geographic restriction: not accessible in your location" },
    { status: 0, error: new Error("model not available in your country yet") },
  ];
  for (const c of cases) {
    const cd = cooldownFor({ status: c.status, headers: new Headers({}), bodyText: c.body ?? "", error: c.error, now, config });
    assert.ok(cd, `应识别区域限制 (${c.body || c.error?.message})`);
    assert.equal(cd.reason, "区域不可用");
    assert.equal(cd.seconds, 24 * 60 * 60, "区域限制使用长冷却 = 禁用");
    assert.equal(cd.disabled, true, "区域限制同时标记 disabled，需手动启用才恢复");
  }
  // 普通 403 仍按登录拒绝处理，不被误判为区域限制
  const plainAuth = cooldownFor({ status: 403, headers: new Headers({}), bodyText: "invalid api key", now, config });
  assert.equal(plainAuth.reason, "sign-in refused");
  // 区域限制优先于 429 之外的状态分支
  const blockOverGone = cooldownFor({ status: 404, headers: new Headers({}), bodyText: "This model is not available in your country", now, config });
  assert.equal(blockOverGone.reason, "区域不可用");
});

test("countryBlocked detects regional restrictions", () => {
  assert.equal(countryBlocked("This model is not available in your country"), true);
  assert.equal(countryBlocked("model not available in your region"), true);
  assert.equal(countryBlocked("geographic restriction applied"), true);
  assert.equal(countryBlocked("该模型在您所在国家不可用"), true);
  assert.equal(countryBlocked("rate limit exceeded"), false);
  assert.equal(countryBlocked("invalid api key"), false);
  assert.equal(countryBlocked(404), false);
  assert.equal(countryBlocked(), false);
});

test("request-shaped errors stop the failover; model and quota errors continue", () => {
  assert.equal(shouldStop(400, "invalid temperature"), true);
  assert.equal(shouldStop(422, "messages must be an array"), true);
  assert.equal(shouldStop(400, "model is not supported"), false);
  assert.equal(shouldStop(404, "model not found"), false);
  assert.equal(shouldStop(429, "rate limited"), false);
  assert.equal(modelProblem("model not available"), true);
  assert.equal(modelProblem("invalid temperature"), false);
});

test("parseDuration handles seconds, compound durations, epochs and ISO dates", () => {
  assert.equal(parseDuration("30"), 30_000);
  assert.equal(parseDuration("1m30s"), 90_000);
  assert.equal(parseDuration("1h2m3s"), 3_723_000);
  assert.equal(parseDuration("250ms"), 250);
  const epoch = Math.floor(Date.now() / 1000) + 60;
  const ms = parseDuration(String(epoch));
  assert.ok(ms > 50_000 && ms <= 60_000);
});

test("cooldownActive only looks forward", () => {
  assert.equal(cooldownActive({ until: 200 }, 100), true);
  assert.equal(cooldownActive({ until: 100 }, 100), false);
  assert.equal(cooldownActive(undefined, 100), false);
});

test("paidCandidates keeps only paid rows of the catalog, in order", () => {
  const catalog = [
    { id: "zen/a", provider: "zen", name: "a", free: true },
    { id: "zen/b", provider: "zen", name: "b", free: false },
    { id: "cn/glm", provider: "cn", name: "glm", free: false },
  ];
  const paid = paidCandidates(catalog, {}, DEFAULT_CONFIG, DEFAULT_CONFIG, Date.now(), []);
  assert.deepEqual(paid.map((m) => m.id), ["zen/b", "cn/glm"]);
});

test("paidCandidates skips disabled providers/models and cooling entries", () => {
  const catalog = [
    { id: "zen/b", provider: "zen", name: "b", free: false },
    { id: "zen/c", provider: "zen", name: "c", free: false },
  ];
  const paid = paidCandidates(catalog, {}, DEFAULT_CONFIG, DEFAULT_CONFIG, Date.now(), ["zen/c"]);
  assert.deepEqual(paid.map((m) => m.id), ["zen/b"]);
  const cooling = paidCandidates([{ id: "zen/b", provider: "zen", name: "b", free: false }], { "zen/b": { until: Date.now() + 60_000, reason: "rate" } }, DEFAULT_CONFIG, DEFAULT_CONFIG, Date.now(), []);
  assert.deepEqual(cooling, []);
});

test("paidCandidates filters by capability needs, then relaxes when nothing fits", () => {
  const catalog = [
    { id: "zen/b", provider: "zen", name: "b", free: false, toolcall: false },
    { id: "cn/glm", provider: "cn", name: "glm", free: false, toolcall: true },
  ];
  const needs = { tools: true, images: false, reasoning: false, stream: false };
  const capable = paidCandidates(catalog, {}, needs, DEFAULT_CONFIG, Date.now(), []);
  assert.deepEqual(capable.map((m) => m.id), ["cn/glm"]);
});

test("parsePaidWindow / formatPaidWindow round-trip and reject bad input", () => {
  assert.deepEqual(parsePaidWindow("22:00-06:00"), { start: 22 * 60, end: 6 * 60 });
  assert.deepEqual(parsePaidWindow("01:00~02:30"), { start: 60, end: 150 });
  assert.deepEqual(parsePaidWindow({ start: "00:15", end: "23:45" }), { start: 15, end: 23 * 60 + 45 });
  assert.equal(parsePaidWindow(null), null);
  assert.equal(parsePaidWindow(""), null);
  assert.equal(parsePaidWindow("24:00-01:00"), null, "hour out of range");
  assert.equal(parsePaidWindow("22:00"), null, "missing end");
  assert.equal(parsePaidWindow("nope"), null);
  assert.equal(formatPaidWindow({ start: 22 * 60, end: 6 * 60 }), "22:00-06:00");
  assert.equal(formatPaidWindow("7:05-8:00"), "07:05-08:00");
  assert.equal(formatPaidWindow(null), null);
});

test("withinPaidWindow handles all-day, normal and wrap-around windows", () => {
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m).getTime();
  assert.equal(withinPaidWindow(null, at(12)), true, "no window means all day");
  assert.equal(withinPaidWindow("00:00-00:00", at(12)), true, "empty window is all day");
  assert.equal(withinPaidWindow("09:00-17:00", at(10)), true);
  assert.equal(withinPaidWindow("09:00-17:00", at(17)), false, "end is exclusive");
  assert.equal(withinPaidWindow("22:00-06:00", at(23, 30)), true);
  assert.equal(withinPaidWindow("22:00-06:00", at(5, 59)), true);
  assert.equal(withinPaidWindow("22:00-06:00", at(12)), false);
});

test("paidCandidates honours the paid window", () => {
  const catalog = [{ id: "zen/b", provider: "zen", name: "b", free: false }];
  const noon = new Date(2026, 0, 1, 12, 0).getTime();
  const night = new Date(2026, 0, 1, 23, 0).getTime();
  const config = { ...DEFAULT_CONFIG, paidWindow: "22:00-06:00" };
  assert.deepEqual(paidCandidates(catalog, {}, config, config, noon, []), [], "outside window");
  assert.deepEqual(paidCandidates(catalog, {}, config, config, night, []), catalog, "inside window");
});

test("paidCandidates skips providers whose balance is below the floor", () => {
  const catalog = [
    { id: "zen/b", provider: "zen", name: "b", free: false },
    { id: "cn/glm", provider: "cn", name: "glm", free: false },
  ];
  const config = { ...DEFAULT_CONFIG, paidMinBalance: 10 };
  const credits = [
    { provider: "zen", balance: 5 },
    { provider: "cn", balance: 50 },
  ];
  assert.deepEqual(paidCandidates(catalog, {}, config, config, Date.now(), [], credits).map((m) => m.id), ["cn/glm"]);
  assert.deepEqual(
    paidCandidates(catalog, {}, config, config, Date.now(), [], [{ provider: "zen" }]).map((m) => m.id),
    ["zen/b", "cn/glm"],
    "unknown balance is not blocked"
  );
});

test("summarizeUpstream ignores outer rows and 499, groups by req", () => {
  const now = Date.parse("2026-11-06T14:00:00+08:00");
  const rows = [
    { agent: "opencode", provider: "free-switch", model: "auto", req: "free-switch/auto", status: 429, t: "2026-11-06T13:59:00+08:00", ms: 100, err: "outer", agent2: 1 },
    { agent: "free-switch", provider: "workbuddy-ai", model: "hy3", req: "workbuddy-ai/hy3", status: 429, t: "2026-11-06T13:55:00+08:00", ms: 60000, ttft_ms: 30000, err: "too many requests", err_type: "api_error" },
    { agent: "free-switch", provider: "workbuddy-ai", model: "hy3", req: "workbuddy-ai/hy3", status: 502, t: "2026-11-06T13:56:00+08:00", ms: 40000, err: "bad gateway", err_type: "stream_error" },
    { agent: "free-switch", provider: "workbuddy-ai", model: "hy3", req: "workbuddy-ai/hy3", status: 499, t: "2026-11-06T13:57:00+08:00", ms: 1300, err: "the agent canceled the request" },
    { agent: "free-switch", provider: "cline", model: "gemma:free", req: "cline/gemma:free", status: 200, t: "2026-11-06T13:58:00+08:00", ms: 5000, ttft_ms: 800 },
  ];
  const out = summarizeUpstream(rows, { now, windowMs: 900_000, minErrors: 2 });
  assert.equal(out.length, 2, "outer free-switch row and 499 are excluded");
  const hy3 = out.find((s) => s.id === "workbuddy-ai/hy3");
  assert.equal(hy3.calls, 2, "499 (caller cancel) is not counted as an upstream call");
  assert.equal(hy3.errors, 2);
  assert.equal(hy3.rateLimited, 1);
  assert.equal(hy3.serverErrors, 1);
  assert.equal(hy3.limited, true);
  assert.equal(hy3.lastError, "bad gateway");
  assert.equal(hy3.softUntil, hy3.lastErrorAt + 60_000, "soft demotion is 30s * 2^(errors-1)");
  assert.ok(hy3.softUntil < now, "an old error no longer demotes");
  assert.ok(hy3.errTypes.includes("stream_error"));
  assert.equal(hy3.p50TtftMs, 30000);
  const cline = out.find((s) => s.id === "cline/gemma:free");
  assert.equal(cline.limited, false);
  assert.equal(cline.errors, 0);
});

test("summarizeUpstream clears limited after a newer success and respects the window", () => {
  const now = Date.parse("2026-11-06T14:00:00+08:00");
  const base = { agent: "free-switch", provider: "zen", model: "a", req: "zen/a" };
  const out = summarizeUpstream([
    { ...base, status: 429, t: "2026-11-06T13:50:00+08:00", ms: 1000, err: "limit" },
    { ...base, status: 429, t: "2026-11-06T13:51:00+08:00", ms: 1000, err: "limit" },
    { ...base, status: 200, t: "2026-11-06T13:55:00+08:00", ms: 1000 },
  ], { now, windowMs: 900_000, minErrors: 2 });
  assert.equal(out[0].limited, false, "a newer success clears the penalty");
  const old = summarizeUpstream([
    { ...base, status: 429, t: "2026-11-06T13:00:00+08:00", ms: 1000, err: "limit" },
  ], { now, windowMs: 900_000, minErrors: 1 });
  assert.equal(old.length, 0, "rows outside the window are ignored");
});

test("quotaPressure and stuckCalls", () => {
  const q = quotaPressure([{ provider: "workbuddy-ai", name: "WorkBuddy", windows: [{ name: "Extra credits", used: 98, remaining: 2 }, { name: "Credits", used: 5, remaining: 95, resetsAt: "2026-11-30T15:59:59Z" }] }]);
  assert.equal(q[0].window, "Extra credits");
  assert.equal(q[0].pct, 2);
  assert.equal(q[0].tight, true);
  assert.equal(q[1].tight, false);
  const stuck = stuckCalls([
    { id: 1, agent: "free-switch", provider: "workbuddy-ai", model: "workbuddy-ai/hy3", ms: 120000, phase: "upstream" },
    { id: 2, agent: "opencode", provider: "free-switch", model: "free-switch/auto", ms: 10, phase: "upstream" },
  ], 30_000);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].ms, 120000);
});

test("demoteUpstream moves limited models to the tail without dropping them", () => {
  const now = 1_700_000_000_000;
  const a = { id: "zen/a" }, b = { id: "zen/b" }, c = { id: "zen/c" };
  const summary = [{ id: "zen/a", limited: true, softUntil: now + 60000 }];
  assert.deepEqual(demoteUpstream([a, b, c], summary, now).map((m) => m.id), ["zen/b", "zen/c", "zen/a"]);
  assert.deepEqual(demoteUpstream([a, b], [{ id: "zen/a", limited: true, softUntil: now - 1 }], now).map((m) => m.id), ["zen/a", "zen/b"], "expired soft cooldown is ignored");
  assert.deepEqual(demoteUpstream([a, b], [], now), [a, b]);
});

test("499 is never a cooldown and long Retry-After is capped", () => {
  const now = 1_700_000_000_000;
  const config = { ...DEFAULT_CONFIG, maxResetSeconds: 1800, maxCooldownSeconds: 28800 };
  assert.equal(cooldownFor({ status: 499, headers: new Headers({}), bodyText: "", now, config }), undefined);
  const long = cooldownFor({ status: 429, headers: new Headers({ "retry-after": "18000" }), bodyText: "", now, config });
  assert.equal(long.seconds, 1800, "a 5h Retry-After is capped at 30min");
  const short = cooldownFor({ status: 429, headers: new Headers({ "retry-after": "20" }), bodyText: "", now, config });
  assert.equal(short.seconds, 20);
});

test("buildStatsCharts buckets requests with mutually exclusive results", () => {
  const now = Date.parse("2026-11-06T14:00:00+08:00");
  const at = (m) => now - m * 60_000;
  const trace = (m, extra = {}) => ({ at: at(m), ok: false, exhausted: false, attempts: [{ status: 502 }], durationMs: 1000, ...extra });
  const rows = [
    trace(50, { ok: true, finalModel: "zen/a", attempts: [{ status: 200 }] }),
    trace(40, { ok: true, finalModel: "zen/a", attempts: [{ status: 429 }, { status: 200 }] }),
    trace(30, { exhausted: true, attempts: [{ status: 429 }, { status: 502 }] }),
    trace(20, { aborted: true, attempts: [{ status: 0 }] }),
    trace(10, { attempts: [{ status: 400 }] }),
  ];
  const c = buildStatsCharts(rows, { bucketCount: 6 });
  assert.equal(c.total, 5);
  assert.equal(c.bucketCount, 6);
  assert.equal(c.attempts, 7);
  assert.equal(c.switches, 2, "attempts - requests");
  assert.equal(c.successes + c.exhausted + c.aborted + c.failures, c.total, "results are mutually exclusive and exhaustive");
  assert.equal(c.successes, 2);
  assert.equal(c.exhausted, 1);
  assert.equal(c.aborted, 1);
  assert.equal(c.failures, 1);
  assert.equal(c.buckets.reduce((s, b) => s + b.requests, 0), 5);
  assert.deepEqual(c.models[0], { id: "zen/a", count: 2 }, "only successful requests count toward model usage");
  assert.deepEqual(c.statuses.map((s) => s.status).sort(), [0, 200, 400, 429, 502].sort());
  assert.ok(c.from <= c.to && c.bucketMs > 0);
  assert.equal(buildStatsCharts([], {}).total, 0);
  assert.equal(buildStatsCharts(null, {}).buckets.length, 0);
});

test("buildStatsCharts keeps a single trace in one bucket", () => {
  const c = buildStatsCharts([{ at: Date.now(), ok: true, attempts: [{ status: 200 }], durationMs: 10 }], { bucketCount: 12 });
  assert.equal(c.total, 1);
  assert.equal(c.buckets.reduce((s, b) => s + b.requests, 0), 1);
  assert.equal(c.bucketMs, 1000, "the minimum bucket width is 1s");
});
