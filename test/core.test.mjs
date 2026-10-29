import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  cooldownActive,
  cooldownFor,
  discoverFreeModels,
  isFreeModel,
  modelProblem,
  needsOf,
  normalizeModel,
  parseDuration,
  parseReset,
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
