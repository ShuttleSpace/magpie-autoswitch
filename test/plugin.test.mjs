import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConsole } from "../src/console.mjs";
import { gatewayAddress } from "../src/gateway.mjs";
import { loadConfig } from "../src/config.mjs";
import { createFreeSwitchPlugin } from "../src/plugin.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "magpie-free-switch-"));
}

async function fakeGateway(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      const rows = handler.models ?? [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: rows }));
      return;
    }
    if (handler.magpie && req.url.startsWith("/v1/magpie/")) {
      const value = handler.magpie(req.url);
      if (value === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(body);
      return handler.chat(req, res, body, calls);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    calls,
    url: `127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

function models() {
  return [
    {
      id: "zen/a",
      owned_by: "opencode-zen-free",
      display_name: "Zen A",
      pricing: { prompt: "0", completion: "0" },
      tool_call: true,
      reasoning: true,
      reasoning_levels: ["low", "high"],
      modalities: { input: ["text", "image"], output: ["text"] },
      context_window: 128000,
      max_output_tokens: 32000,
    },
    {
      id: "zen/b",
      owned_by: "opencode-zen-free",
      display_name: "Zen B",
      pricing: { prompt: "0", completion: "0" },
      tool_call: true,
      reasoning: true,
      modalities: { input: ["text"], output: ["text"] },
      context_window: 64000,
      max_output_tokens: 16000,
    },
    {
      id: "paid/c",
      owned_by: "paid",
      display_name: "Paid C",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      modalities: { input: ["text"], output: ["text"] },
    },
    {
      id: "auto/group",
      owned_by: "opencode-zen-free",
      display_name: "Group",
      pricing: { prompt: "0", completion: "0" },
      modalities: { input: ["text"], output: ["text"] },
    },
  ];
}

test("failover marks a 429 model cooling and the next request starts with the awake one", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  const gateway = await fakeGateway({
    models: models(),
    chat(req, res, body) {
      if (body.model === "zen/a") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "20" });
        res.end(JSON.stringify({ error: { message: "rate limited, try again in 20s" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
    },
  });
  process.env.MAGPIE_ADDR = gateway.url;
  const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const request = () =>
    loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-session": "ses-test" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });

  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-free-switch-model"), "zen/b");
  assert.equal(first.headers.get("x-free-switch-attempts"), "2");
  const firstBody = await first.json();
  assert.equal(firstBody.model, "zen/b");
  assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/a", "zen/b"]);

  const state = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "state.json"), "utf8"));
  assert.ok(state.models["zen/a"].until > Date.now());
  assert.equal(state.models["zen/b"].failures, 0);
  assert.equal(state.stats.requests, 1);
  assert.equal(state.stats.switches, 1);

  gateway.calls.length = 0;
  const second = await request();
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-free-switch-model"), "zen/b");
  assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/b"], "the cooling model is not tried while an awake one exists");

  const traces = fs
    .readFileSync(path.join(dir, "free-switch", "traces.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(traces.length, 2);
  assert.equal(traces[0].attempts.length, 2);
  assert.equal(traces[0].ok, true);
  assert.equal(traces[0].attempts[0].status, 429);
  assert.equal(traces[0].attempts[1].status, 200);

  await hooks.lifecycle.dispose();
  const restarted = await createFreeSwitchPlugin({ magpie: { option: () => false } });
  const restartedLoader = await restarted.auth.loader(async () => ({ type: "api", key: "public" }));
  gateway.calls.length = 0;
  const afterRestart = await restartedLoader.fetch(`${restartedLoader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/b"], "the cooldown survives a plugin restart");
  await restarted.lifecycle.dispose();

  await gateway.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a streamed reply is peeked before any byte is handed to the caller", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  const gateway = await fakeGateway({
    models: models(),
    chat(req, res, body) {
      if (body.model === "zen/a") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  process.env.MAGPIE_ADDR = gateway.url;
  const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-free-switch-model"), "zen/b");
  const text = await response.text();
  assert.match(text, /hello/);
  assert.match(text, /\[DONE\]/);
  assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/a", "zen/b"]);
  await hooks.lifecycle.dispose();
  await gateway.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// magpie 把上游 429/5xx 包成 HTTP 200 的 SSE 流：先发一个正常的 role chunk，
// 再发一个 `data: {"error": ...}` 帧。插件若只看第一帧就会把失败当成成功，
// 不切换模型，调用方（opencode）收到 429 后只能自己退避重试。
const IN_BAND_429 =
  'data: {"error":{"message":"WorkBuddy: 您的使用量已超出频率限制，将在 2026-11-11 11:10:47 UTC+8 重置 (429: you can retry your request)","type":"api_error"}}\n\n';
const ROLE_CHUNK = 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n';

test("an in-band SSE error frame fails over instead of being reported as success", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  const gateway = await fakeGateway({
    models: models(),
    chat(req, res, body) {
      if (body.model === "zen/a") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // magpie 真实形态：同一个 chunk 里既有正常帧，也有错误帧。
        res.write(ROLE_CHUNK + IN_BAND_429);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  process.env.MAGPIE_ADDR = gateway.url;
  const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-free-switch-model"), "zen/b", "the in-band 429 must trigger failover");
  const text = await response.text();
  assert.match(text, /hello/);
  assert.doesNotMatch(text, /you can retry your request/, "the caller must not receive the upstream error frame");
  assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/a", "zen/b"]);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "state.json"), "utf8"));
  assert.equal(state.models["zen/a"].lastStatus, 429, "the attempt is recorded as a rate limit, not a generic 502");
  assert.ok(state.models["zen/a"].until > Date.now(), "the rate-limited model is cooling");
  await hooks.lifecycle.dispose();
  await gateway.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 顺序无关：即便错误帧排在有效帧之前（同一 chunk 内），也要识别出来。
test("an in-band error frame is detected regardless of frame order", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  const gateway = await fakeGateway({
    models: models(),
    chat(req, res, body) {
      if (body.model === "zen/a") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // 错误帧在前、有效帧在后，仍要识别为失败。
        res.write(IN_BAND_429 + ROLE_CHUNK);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  process.env.MAGPIE_ADDR = gateway.url;
  const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-free-switch-model"), "zen/b", "the in-band 429 must trigger failover");
  const text = await response.text();
  assert.match(text, /hello/);
  assert.doesNotMatch(text, /you can retry your request/);
  assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/a", "zen/b"]);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "state.json"), "utf8"));
  assert.equal(state.models["zen/a"].lastStatus, 429, "the attempt is recorded as a rate limit, not a generic 502");
  assert.ok(state.models["zen/a"].until > Date.now(), "the rate-limited model is cooling");
  await hooks.lifecycle.dispose();
  await gateway.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a healthy stream that starts with a role-only chunk is still streamed", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  const gateway = await fakeGateway({
    models: models(),
    chat(req, res, body) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(ROLE_CHUNK);
      res.write('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  process.env.MAGPIE_ADDR = gateway.url;
  const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(gateway.calls.length, 1, "a healthy stream must not be retried");
  const text = await response.text();
  assert.match(text, /hello/);
  assert.match(text, /\[DONE\]/);
  await hooks.lifecycle.dispose();
  await gateway.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a caller-shaped 400 is passed through instead of burning every free model", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  const gateway = await fakeGateway({
    models: models(),
    chat(req, res, body) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid temperature" } }));
    },
  });
  process.env.MAGPIE_ADDR = gateway.url;
  const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", temperature: 9, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 400);
  assert.equal(gateway.calls.length, 1);
  assert.match(await response.text(), /invalid temperature/);
  await hooks.lifecycle.dispose();
  await gateway.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the gateway address is normalized for loopback and IPv6", () => {
  const previous = process.env.MAGPIE_ADDR;
  try {
    process.env.MAGPIE_ADDR = "0.0.0.0:3425";
    assert.equal(gatewayAddress(), "http://127.0.0.1:3425");
    process.env.MAGPIE_ADDR = "[::1]:3425";
    assert.equal(gatewayAddress(), "http://[::1]:3425");
    process.env.MAGPIE_ADDR = "http://localhost:4000/v1";
    assert.equal(gatewayAddress(), "http://localhost:4000");
    delete process.env.MAGPIE_ADDR;
    assert.equal(gatewayAddress(), "http://127.0.0.1:3425");
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_ADDR;
    else process.env.MAGPIE_ADDR = previous;
  }
});

test("the console serves the page and its state on loopback", async () => {
  const consoleServer = createConsole({
    getState: async () => ({ now: 123, stats: { requests: 1 }, models: [], traces: [] }),
    refresh: async () => {},
    clearCooldown: async () => {},
  });
  const url = await consoleServer.start(0);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /AUTOSWITCH/);
  assert.match(html, /id="settings-btn"/, "the topbar has a settings entry");
  assert.match(html, /id="chart-outcomes"/, "chart containers are present");
  assert.match(html, /id="set-strategy"/, "settings panel has a strategy selector");
  assert.match(html, /id="set-core-save"/, "settings panel has editable core scheduling params");
  assert.match(html, /id="set-paid-save"/, "settings panel has editable paid params");
  assert.match(html, /value="expiry-first"/, "the strategy list includes expiry-first");
  assert.match(html, /\.chart-grid\s*\{/, "assembled CSS from src/console/*.css is inlined");
  assert.match(html, /function renderCharts\(\)/, "assembled JS from src/console/*.js is inlined");
  assert.doesNotMatch(html, /__CONSOLE_CSS__|__CONSOLE_JS__/, "no unreplaced placeholders");
  // 拼接后的脚本必须是可解析的（用 new Function 做语法检查，不执行）。
  const script = html.split("<script>\n")[1].split("\n</script>")[0];
  assert.doesNotThrow(() => new Function(script));
  const state = await fetch(`${url}/api/state`);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).now, 123);
  const icon = await fetch(`${url}/icon.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
  const notes = await fetch(`${url}/api/release-notes`);
  assert.equal(notes.status, 200);
  assert.equal(typeof (await notes.json()).notes, "string");
  await consoleServer.stop();
  assert.equal(consoleServer.running, false);
});

test("the console queue API adds, removes, moves and runs queued models", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const configFile = path.join(dir, "free-switch", "config.json");
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    // console: true 让插件自己的 syncConsole 保持这个控制台存活（否则它会
    // 在 config.console 为 false 时把控制台关掉，测试里的 fetch 就连不上）。
    fs.writeFileSync(configFile, JSON.stringify({ switchQueue: [], console: true, consolePort: 0 }));
    const api = await createFreeSwitchPlugin({ magpie: { option: () => undefined } });
    const post = async (path, body) => {
      const res = await fetch(`${api.console.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return { status: res.status, body: await res.json() };
    };
    await api.console.start(0);

    let r = await post("/api/queue/add", { model: "zen/a" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.switchQueue, ["zen/a"]);

    r = await post("/api/queue/add", { model: "paid/c" });
    assert.deepEqual(r.body.switchQueue, ["zen/a", "paid/c"]);

    r = await post("/api/queue/add", { model: "zen/a" });
    assert.deepEqual(r.body.switchQueue, ["zen/a", "paid/c"], "adding twice does not duplicate the entry");

    r = await post("/api/queue/add", { model: "" });
    assert.equal(r.body.ok, false, "an empty model is rejected");
    assert.deepEqual(r.body.switchQueue, ["zen/a", "paid/c"]);

    r = await post("/api/queue/move", { model: "paid/c", direction: "up" });
    assert.deepEqual(r.body.switchQueue, ["paid/c", "zen/a"], "move up puts the model first");

    r = await post("/api/queue/move", { model: "paid/c", direction: "down" });
    assert.deepEqual(r.body.switchQueue, ["zen/a", "paid/c"], "move down puts the model last");

    r = await post("/api/queue/remove", { model: "zen/a" });
    assert.deepEqual(r.body.switchQueue, ["paid/c"]);

    const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(saved.switchQueue, ["paid/c"], "the queue is persisted to config.json");

    r = await post("/api/queue/run", {});
    assert.equal(r.body.ok, true);
    assert.equal(r.body.manualSwitch?.model, "paid/c", "running the queue forces the head model");
    assert.deepEqual(r.body.switchQueue, [], "running the queue consumes the head entry");

    r = await post("/api/queue/add", { model: "zen/b" });
    assert.deepEqual(r.body.switchQueue, ["zen/b"]);
    r = await post("/api/queue/clear", {});
    assert.deepEqual(r.body.switchQueue, []);

    await api.lifecycle.dispose();
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the preferred API toggles a model in config.json", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const configFile = path.join(dir, "free-switch", "config.json");
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ preferredModels: [] }));
    const consoleServer = createConsole({
      getState: async () => ({ now: 1, stats: {}, config: { preferredModels: loadConfig().preferredModels }, models: [{ id: "zen/a" }, { id: "zen/b" }], traces: [] }),
      refresh: async () => {},
      clearCooldown: async () => {},
    });
    const url = await consoleServer.start(0);
    let res = await fetch(`${url}/api/preferred`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "zen/a" }),
    });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.deepEqual(body.config.preferredModels, ["zen/a"]);
    let saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(saved.preferredModels, ["zen/a"]);
    // Toggle off
    res = await fetch(`${url}/api/preferred`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "zen/a" }),
    });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.deepEqual(body.config.preferredModels, []);
    saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(saved.preferredModels, []);
    // Missing model field -> 400
    res = await fetch(`${url}/api/preferred`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    await consoleServer.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig normalizes the switch queue into a clean list of model ids", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const configFile = path.join(dir, "free-switch", "config.json");
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ switchQueue: [" paid/b ", "free/a", 42, "", "   ", null, "free/a"] }));
    const config = loadConfig();
    assert.deepEqual(config.switchQueue, ["paid/b", "free/a"], "blank, non-string and duplicate ids are dropped");
    // A queue that is not an array falls back to the default (empty) list.
    fs.writeFileSync(configFile, JSON.stringify({ switchQueue: "paid/b" }));
    assert.deepEqual(loadConfig().switchQueue, []);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preferred-bulk sets all / inverts / clears the visible models", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const configFile = path.join(dir, "free-switch", "config.json");
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ preferredModels: ["zen/a"] }));
    const consoleServer = createConsole({
      getState: async () => ({ now: 1, stats: {}, config: { preferredModels: loadConfig().preferredModels }, models: [], traces: [] }),
      refresh: async () => {},
      clearCooldown: async () => {},
    });
    const url = await consoleServer.start(0);
    const post = async (mode, models) => {
      const res = await fetch(`${url}/api/preferred-bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, models }),
      });
      assert.equal(res.status, 200);
      return (await res.json()).config.preferredModels;
    };
    assert.deepEqual(await post("all", ["zen/a", "zen/b", "zen/c"]), ["zen/a", "zen/b", "zen/c"]);
    assert.deepEqual(await post("invert", ["zen/a", "zen/b", "zen/c"]), []);
    assert.deepEqual(await post("none", ["zen/a", "zen/b", "zen/c"]), []);
    const bad = await fetch(`${url}/api/preferred-bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "nope", models: [] }),
    });
    assert.equal(bad.status, 400);
    await consoleServer.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("console providers endpoint sets the includeProviders whitelist", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const configFile = path.join(dir, "free-switch", "config.json");
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ includeProviders: ["kiro"] }));
    const readInclude = () => {
      try { return JSON.parse(fs.readFileSync(configFile, "utf8")).includeProviders || []; } catch { return []; }
    };
    const consoleServer = createConsole({
      getState: async () => ({ now: 1, stats: {}, config: { includeProviders: readInclude() }, models: [{ id: "zen/a", provider: "kilo" }, { id: "zen/b", provider: "kiro" }], traces: [] }),
      refresh: async () => {},
      clearCooldown: async () => {},
    });
    const url = await consoleServer.start(0);
    let res = await fetch(`${url}/api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: ["kilo", "kiro"] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(readInclude(), ["kilo", "kiro"]);
    // Drop back to all providers with an empty list
    res = await fetch(`${url}/api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(readInclude(), []);
    await consoleServer.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("console provider endpoint selects the failover provider", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const configFile = path.join(dir, "free-switch", "config.json");
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ includeProviders: [] }));
    const readInclude = () => {
      try { return JSON.parse(fs.readFileSync(configFile, "utf8")).includeProviders || []; } catch { return []; }
    };
    const consoleServer = createConsole({
      getState: async () => ({ now: 1, stats: {}, config: { includeProviders: readInclude() }, models: [{ id: "zen/a", provider: "kilo" }], traces: [] }),
      refresh: async () => {},
      clearCooldown: async () => {},
    });
    const url = await consoleServer.start(0);
    let res = await fetch(`${url}/api/provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "kilo" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(readInclude(), ["kilo"]);
    let saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(saved.includeProviders, ["kilo"]);
    // Select all -> empty list
    res = await fetch(`${url}/api/provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "" }),
    });
    assert.equal(res.status, 200);
    saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(saved.includeProviders, []);
    await consoleServer.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCredits reads magpie quota balances and credit usage", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "quotas.json"), JSON.stringify({
      "codearts/me": { at: "2026-11-05T14:11:42Z", quota: { provider: "codearts", name: "CodeArts", icon: "x", plan: "体验版", balance: "$0.00", windows: [{ name: "总积分", used: 100, display: "4400/4500", amount: 4500, limit: 4500, unit: "credits", resetsAt: "2026-11-23T16:00:00Z" }] } },
    }));
    fs.writeFileSync(path.join(dir, "credits-daily.json"), JSON.stringify({
      "trae-cn|me|Credits": { since: "2026-10-28", last: { used: 947.15, total: 1600, at: "2026-11-05T10:14:45Z" } },
    }));
    const { readCredits } = await import("../src/config.mjs");
    const credits = readCredits();
    assert.ok(Array.isArray(credits));
    const codearts = credits.find((c) => c.provider === "codearts");
    assert.ok(codearts, "codearts should appear in the credit snapshot");
    assert.equal(codearts.balance, "$0.00");
    // magpie 的 resetsAt 是 ISO 字符串，必须被归一化成毫秒时间戳，否则
    // expiry-first 的队列重排（和控制台的到期倒计时）会静默失效。
    assert.equal(codearts.resetAt, Date.parse("2026-11-23T16:00:00Z"));
    const trae = credits.find((c) => c.provider === "trae-cn");
    assert.ok(trae, "trae-cn should appear in the credit snapshot");
    assert.equal(trae.total, 1600);
    assert.equal(trae.used, 947.15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCredits falls back to runsOutAt and ignores windows without a reset time", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "quotas.json"), JSON.stringify({
      "minimax-code/x": { quota: { provider: "minimax-code", name: "MiniMax Code", windows: [{ name: "Credits", used: 0, runsOutAt: "2026-12-05T16:00:00Z", limit: 400, unit: "credits" }] } },
      "no-reset/y": { quota: { provider: "no-reset", name: "No Reset", windows: [{ name: "Credits", used: 0, limit: 400, unit: "credits" }] } },
    }));
    const { readCredits } = await import("../src/config.mjs");
    const credits = readCredits();
    const minimax = credits.find((c) => c.provider === "minimax-code");
    assert.equal(minimax.resetAt, Date.parse("2026-12-05T16:00:00Z"), "runsOutAt is used when resetsAt is missing");
    const none = credits.find((c) => c.provider === "no-reset");
    assert.equal(none.resetAt, undefined, "a window without any reset time yields no expiry info");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("console disable / enable / switch endpoints route to the right handler", async () => {
  const state = { models: {}, disabledProviders: [], manualSwitch: null, stats: {} };
  const consoleServer = createConsole({
    getState: async () => state,
    refresh: async () => {},
    clearCooldown: async () => {},
    disable: async (body) => {
      if (body?.provider) state.disabledProviders.push(body.provider);
      return { ok: true };
    },
    enable: async (body) => {
      if (body?.provider) state.disabledProviders = state.disabledProviders.filter((p) => p !== body.provider);
      return { ok: true };
    },
    switch: async (model) => {
      if (model) state.manualSwitch = { model, at: 1 };
      return { ok: true };
    },
    cancelSwitch: async () => {
      state.manualSwitch = null;
      return { ok: true };
    },
    setStrategy: async (body) => {
      state.strategyBody = body;
      return { ok: true };
    },
    refreshUpstream: async (force) => {
      state.upstreamForced = force;
      return { ok: true };
    },
  });
  const url = await consoleServer.start(0);
  let res = await fetch(`${url}/api/disable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "kilo" }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).disabledProviders.includes("kilo"), true);

  res = await fetch(`${url}/api/enable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "kilo" }),
  });
  assert.equal((await res.json()).disabledProviders.includes("kilo"), false);

  res = await fetch(`${url}/api/switch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "zen/a" }),
  });
  assert.equal(res.status, 200);
  var switched = await res.json();
  assert.equal(switched.manualSwitch.model, "zen/a");
  assert.equal(switched.switchedModel, "zen/a", "the endpoint echoes the pending switch");

  res = await fetch(`${url}/api/cancel-switch`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).manualSwitch, null, "cancel clears the pending switch");

  res = await fetch(`${url}/api/strategy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ strategy: "paid-first", maxPaidTries: 3, paidWindow: "22:00-06:00", paidMinBalance: 20 }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(state.strategyBody, { strategy: "paid-first", maxPaidTries: 3, paidWindow: "22:00-06:00", paidMinBalance: 20 });

  res = await fetch(`${url}/api/upstream`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 200);
  assert.equal(state.upstreamForced, true, "the upstream refresh endpoint forces a fresh read");

  // unknown endpoint -> 404
  res = await fetch(`${url}/api/nope`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 404);
  await consoleServer.stop();
});

test("an exhausted provider account is rested as a whole, not model by model", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    // 上游额度用尽时整段 provider 都会失败（OpenCode Zen Free 的账号额度是
    // 共用的）：一个模型报「额度用尽」，同 provider 的其它模型不必再试。
    const quotaBody = (provider) =>
      JSON.stringify({
        error: {
          code: null,
          message: `${provider}: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going (out of its allowance: not asked again before 20:37 UTC+8)`,
          type: "rate_limit_error",
        },
      });
    const gateway = await fakeGateway({
      models: [
        {
          id: "opencode-zen-free/a",
          owned_by: "opencode-zen-free",
          display_name: "Zen A",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "opencode-zen-free/b",
          owned_by: "opencode-zen-free",
          display_name: "Zen B",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "healthy/x",
          owned_by: "healthy",
          display_name: "Healthy X",
          pricing: { prompt: "0", completion: "0" },
        },
      ],
      chat(req, res, body) {
        if (body.model.startsWith("opencode-zen-free/")) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "600" });
          res.end(quotaBody("OpenCode Zen Free"));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
      },
    });
    process.env.MAGPIE_ADDR = gateway.url;
    const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
    const request = () =>
      loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      });

    try {
      const first = await request();
      assert.equal(first.status, 200, "a healthy provider still answers");
      const zenTries = gateway.calls.map((x) => x.model).filter((m) => m.startsWith("opencode-zen-free/"));
      assert.equal(zenTries.length, 1, `only one zen model is tried, not all of them: ${zenTries.join(", ")}`);
      assert.ok(gateway.calls.some((x) => x.model === "healthy/x"), "the healthy provider is reached");

      // provider 级冷却落盘：下一次请求直接跳过整个 provider。
      const state = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "state.json"), "utf8"));
      assert.ok(state.providers["opencode-zen-free"], "the provider is rested as a whole");
      assert.ok(state.providers["opencode-zen-free"].until > Date.now(), "the rest has a future until");

      gateway.calls.length = 0;
      const second = await request();
      assert.equal(second.status, 200);
      assert.equal(
        gateway.calls.filter((x) => x.model.startsWith("opencode-zen-free/")).length,
        0,
        "the resting provider is skipped entirely on the next request",
      );
      assert.ok(gateway.calls.some((x) => x.model === "healthy/x"), "the healthy provider still answers");
    } finally {
      await hooks.lifecycle.dispose();
      await gateway.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a 502-wrapped quota error rests the whole provider and shows up in console state", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    // Magpie 会把上游 429 包成 HTTP 502 + api_error，正文里只有额度字样。
    const quota = JSON.stringify({
      message: "OpenCode Zen Free: Free usage limit reached. Free models work in OpenCode (out of its allowance: not asked again before 20:00 UTC+8)",
      type: "api_error",
    });
    const rows = ["opencode-zen-free/a", "opencode-zen-free/b", "healthy/x"].map((id) => ({
      id,
      owned_by: id.split("/")[0],
      pricing: { prompt: "0", completion: "0" },
    }));
    const gateway = await fakeGateway({
      models: rows,
      chat(req, res, body) {
        if (body.model.startsWith("opencode-zen-free/")) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(quota);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
      },
    });
    process.env.MAGPIE_ADDR = gateway.url;
    const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
    try {
      const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-free-switch-model"), "healthy/x");
      assert.deepEqual(gateway.calls.map((x) => x.model), ["opencode-zen-free/a", "healthy/x"], "the sibling of the exhausted model is skipped");

      const saved = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "state.json"), "utf8"));
      assert.equal(saved.providers["opencode-zen-free"].lastStatus, 429, "the wrapped error is recognised as a rate limit");
      assert.ok(saved.providers["opencode-zen-free"].until > Date.now());

      const url = await hooks.console.start(0);
      try {
        const state = await (await fetch(`${url}/api/state`)).json();
        const rest = (state.providerRests || []).find((r) => r.provider === "opencode-zen-free");
        assert.ok(rest, "console state exposes the provider-level rest");
        assert.equal(rest.lastStatus, 429);
        assert.ok(rest.until > Date.now());
      } finally {
        await hooks.console.stop();
      }
    } finally {
      await hooks.lifecycle.dispose();
      await gateway.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an in-band SSE quota error rests the whole provider", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    // HTTP 200 的 SSE 错误帧：没有裸 429，也没有 Retry-After。
    const quotaFrame =
      'data: {"error":{"message":"OpenCode Zen Free: Free usage limit reached. out of its allowance: not asked again before 20:00 UTC+8","type":"api_error"}}\n\n';
    const rows = ["opencode-zen-free/a", "opencode-zen-free/b", "healthy/x"].map((id) => ({
      id,
      owned_by: id.split("/")[0],
      pricing: { prompt: "0", completion: "0" },
    }));
    const gateway = await fakeGateway({
      models: rows,
      chat(req, res, body) {
        if (body.model.startsWith("opencode-zen-free/")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(ROLE_CHUNK + quotaFrame);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      },
    });
    process.env.MAGPIE_ADDR = gateway.url;
    const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
    try {
      const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-free-switch-model"), "healthy/x");
      assert.deepEqual(gateway.calls.map((x) => x.model), ["opencode-zen-free/a", "healthy/x"]);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "state.json"), "utf8"));
      assert.equal(saved.providers["opencode-zen-free"].lastStatus, 429);
      assert.ok(saved.providers["opencode-zen-free"].until > Date.now());
    } finally {
      await hooks.lifecycle.dispose();
      await gateway.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an HTTP 200 JSON quota error body rests the whole provider", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    const rows = ["opencode-zen-free/a", "opencode-zen-free/b", "healthy/x"].map((id) => ({
      id,
      owned_by: id.split("/")[0],
      pricing: { prompt: "0", completion: "0" },
    }));
    const gateway = await fakeGateway({
      models: rows,
      chat(req, res, body) {
        if (body.model.startsWith("opencode-zen-free/")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "OpenCode Zen Free: Free usage limit reached (out of its allowance: not asked again before 20:00 UTC+8)" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
      },
    });
    process.env.MAGPIE_ADDR = gateway.url;
    const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
    try {
      const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-free-switch-model"), "healthy/x");
      assert.deepEqual(gateway.calls.map((x) => x.model), ["opencode-zen-free/a", "healthy/x"]);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "state.json"), "utf8"));
      assert.equal(saved.providers["opencode-zen-free"].lastStatus, 429);
    } finally {
      await hooks.lifecycle.dispose();
      await gateway.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manual switch through the real console wiring forces the next request", async () => {  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
  fs.writeFileSync(path.join(dir, "free-switch", "config.json"), JSON.stringify({ console: true, consolePort: 0, refreshSeconds: 5 }));
  const gateway = await fakeGateway({
    models: models(),
    chat(req, res, body) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
    },
  });
  process.env.MAGPIE_ADDR = gateway.url;
  const logs = [];
  const hooks = await createFreeSwitchPlugin({
    magpie: { option: () => undefined },
    client: { app: { log: (entry) => logs.push(entry?.body?.message ?? "") } },
  });
  let consoleURL = "";
  for (let i = 0; i < 40 && !consoleURL; i++) {
    consoleURL = logs.map((x) => String(x).match(/web console: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]).find(Boolean) || "";
    if (!consoleURL) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(consoleURL, "the plugin started its console");

  const res = await fetch(`${consoleURL}/api/switch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "zen/b" }),
  });
  assert.equal(res.status, 200);
  const switched = await res.json();
  assert.equal(switched.ok, true, "the real switch callback accepts the console's string model");
  assert.equal(switched.manualSwitch?.model, "zen/b");

  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const reply = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("x-free-switch-model"), "zen/b", "the forced model is used first");
  assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/b"]);

  await hooks.lifecycle.dispose();
  await gateway.close();
});

test("a hanging upstream is cut off and the next candidate answers", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
  fs.writeFileSync(path.join(dir, "free-switch", "config.json"), JSON.stringify({ firstByteTimeoutSeconds: 1, refreshSeconds: 5, cooldownSeconds: 1, serverErrorCooldownSeconds: 1 }));
  const gateway = await fakeGateway({
    models: models(),
    chat(req, res, body) {
      if (body.model === "zen/a") return; // never answers: hang until aborted
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
    },
  });
  process.env.MAGPIE_ADDR = gateway.url;
  const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const started = Date.now();
  const reply = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  });
  const elapsed = Date.now() - started;
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("x-free-switch-model"), "zen/b");
  assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/a", "zen/b"]);
  assert.ok(elapsed < 5000, `the timeout should cut the hang quickly, took ${elapsed}ms`);
  await hooks.lifecycle.dispose();
  await gateway.close();
});

test("upstream health from magpie demotes a limited model and is exposed in state", async () => {
  const dir = tmpdir();
  process.env.MAGPIE_CONFIG_DIR = dir;
  fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
  fs.writeFileSync(path.join(dir, "free-switch", "config.json"), JSON.stringify({ refreshSeconds: 5, upstreamRefreshSeconds: 5, upstreamMinErrors: 1, firstByteTimeoutSeconds: 0 }));
  const now = Date.now();
  const iso = (msBack) => new Date(now - msBack).toISOString();
  const gateway = await fakeGateway({
    models: models(),
    magpie(url) {
      if (url.startsWith("/v1/magpie/usage/requests")) {
        return { rows: [
          { agent: "free-switch", provider: "opencode-zen-free", model: "a", req: "zen/a", status: 429, ms: 60000, ttft_ms: 30000, err: "rate limited", err_type: "api_error", t: iso(3_000) },
          { agent: "opencode", provider: "free-switch", model: "auto", req: "free-switch/auto", status: 429, ms: 100, err: "outer", t: iso(30_000) },
          { agent: "free-switch", provider: "opencode-zen-free", model: "a", req: "zen/a", status: 499, ms: 1000, err: "canceled", t: iso(20_000) },
        ] };
      }
      if (url.startsWith("/v1/magpie/concurrency")) return { active: [{ id: 1, agent: "free-switch", provider: "opencode-zen-free", model: "zen/a", ms: 120000, phase: "upstream" }], data: {}, requests: 1 };
      if (url.startsWith("/v1/magpie/quotas")) return { data: [{ provider: "zen", name: "Zen", windows: [{ name: "Credits", used: 98, remaining: 2, resetsAt: "2026-12-01T00:00:00Z" }] }] };
      return undefined;
    },
    chat(req, res, body) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
    },
  });
  process.env.MAGPIE_ADDR = gateway.url;
  const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const reply = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("x-free-switch-model"), "zen/b", "the recently-429 model is tried last");
  assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/b"]);
  await hooks.lifecycle.dispose();
  await gateway.close();
});

test("the switch queue is tried before the regular candidates and survives a restart", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    // 队列把 zen/b 排到 zen/a 前面：下一次请求必须先试 zen/b。
    fs.writeFileSync(path.join(dir, "free-switch", "config.json"), JSON.stringify({ switchQueue: ["zen/b"] }));
    const gateway = await fakeGateway({
      models: models(),
      chat(req, res, body) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
      },
    });
    process.env.MAGPIE_ADDR = gateway.url;
    const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
    const reply = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("x-free-switch-model"), "zen/b", "the queued model is tried first");
    assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/b"]);
    await hooks.lifecycle.dispose();

    // 重启后队列仍在（持久化在 config.json），行为不变。
    gateway.calls.length = 0;
    const restarted = await createFreeSwitchPlugin({ magpie: { option: () => false } });
    const restartedLoader = await restarted.auth.loader(async () => ({ type: "api", key: "public" }));
    const afterRestart = await restartedLoader.fetch(`${restartedLoader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(afterRestart.status, 200);
    assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/b"], "the queue survives a plugin restart");
    await restarted.lifecycle.dispose();
    await gateway.close();
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a paid model in the queue is not auto-tried under the free-only strategy", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    // 策略 = 完全免费：队列里的付费模型不能被自动尝试。
    fs.writeFileSync(path.join(dir, "free-switch", "config.json"), JSON.stringify({ strategy: "free", switchQueue: ["paid/c"] }));
    const gateway = await fakeGateway({
      models: models(),
      chat(req, res, body) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
      },
    });
    process.env.MAGPIE_ADDR = gateway.url;
    const hooks = await createFreeSwitchPlugin({ magpie: { option: () => false } });
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
    const reply = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(reply.status, 200);
    assert.ok(!gateway.calls.some((x) => x.model === "paid/c"), "the queued paid model is never auto-tried under the free strategy");
    assert.deepEqual(gateway.calls.map((x) => x.model), ["zen/a"], "the free pool is used instead");
    await hooks.lifecycle.dispose();
    await gateway.close();
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a price-unknown model is discoverable in the catalog and auto-tried once queued", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    // 价格未知模型不在免费池里，但用户显式入队后应被调度（完全免费策略下视为用户确认）。
    fs.writeFileSync(path.join(dir, "free-switch", "config.json"), JSON.stringify({ strategy: "free", switchQueue: ["unknown/mystery"], console: true, consolePort: 0 }));
    const rows = [
      ...models(),
      { id: "unknown/mystery", owned_by: "unknown", display_name: "Mystery", modalities: { input: ["text"], output: ["text"] } },
    ];
    const gateway = await fakeGateway({
      models: rows,
      chat(req, res, body) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
      },
    });
    process.env.MAGPIE_ADDR = gateway.url;
    const hooks = await createFreeSwitchPlugin({ magpie: { option: () => undefined } });
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
    try {
      await loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "warmup" }] }),
      });
      const url = await hooks.console.url;
      const state = await (await fetch(`${url}/api/state`)).json();
      const entry = (state.catalog || []).find((m) => m.id === "unknown/mystery");
      assert.ok(entry, "price-unknown model is visible in the catalog");
      assert.equal(entry.priceUnknown, true);
      assert.equal(state.models.some((m) => m.id === "unknown/mystery"), false, "it is not in the auto free pool");

      const reply = await loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(reply.status, 200);
      assert.equal(gateway.calls[0].model, "unknown/mystery", "the queued price-unknown model is tried first");
    } finally {
      await hooks.console.stop();
      await hooks.lifecycle.dispose();
      await gateway.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("changing the strategy reorders the queue and persists the new order", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const configFile = path.join(dir, "free-switch", "config.json");
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ strategy: "free", switchQueue: ["paid/c", "zen/a"], console: true, consolePort: 0 }));
    // 目录里 paid/c 是付费模型、zen/a 是免费模型。
    const gateway = await fakeGateway({
      models: models(),
      chat(req, res) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
      },
    });
    process.env.MAGPIE_ADDR = gateway.url;
    const api = await createFreeSwitchPlugin({ magpie: { option: () => undefined } });
    await api.console.start(0);
    // 让插件先发现一次目录，reorderQueue 才知道哪个是付费模型。
    await fetch(`${api.console.url}/api/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    const post = async (path, body) => {
      const res = await fetch(`${api.console.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return res.json();
    };

    // 完全免费 → 免费模型在前。
    let body = await post("/api/strategy", { strategy: "free" });
    assert.equal(body.ok, true);
    assert.deepEqual(body.switchQueue, ["zen/a", "paid/c"], "the free strategy puts free models first");

    // 先付费后免费 → 付费模型在前。
    body = await post("/api/strategy", { strategy: "paid-first" });
    assert.equal(body.ok, true);
    assert.deepEqual(body.switchQueue, ["paid/c", "zen/a"], "paid-first puts paid models first");

    const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(saved.switchQueue, ["paid/c", "zen/a"], "the reordered queue is persisted to config.json");
    await api.lifecycle.dispose();
    await gateway.close();
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setConfig validates and persists the editable whitelist", async () => {
  const dir = tmpdir();
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, "free-switch"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "free-switch", "config.json"),
      JSON.stringify({ strategy: "free", maxTries: 6, refreshSeconds: 60, cooldownSeconds: 60, firstByteTimeoutSeconds: 25, maxPaidTries: 2, paidWindow: null, paidMinBalance: 0, tryCooling: true }),
    );
    const api = await createFreeSwitchPlugin({ magpie: { option: () => false } });
    let res = await api.setConfig({
      strategy: "expiry-first",
      maxTries: "12",
      refreshSeconds: 120,
      cooldownSeconds: 300,
      firstByteTimeoutSeconds: 10,
      maxPaidTries: 3,
      paidWindow: "22:00-06:00",
      paidMinBalance: 5,
      tryCooling: false,
    });
    assert.equal(res.ok, true);
    assert.ok(res.changed.includes("strategy"));
    assert.ok(res.changed.includes("maxTries"));
    let saved = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "config.json"), "utf8"));
    assert.equal(saved.strategy, "expiry-first");
    assert.equal(saved.maxTries, 12, "string coerced to clamped integer");
    assert.equal(saved.firstByteTimeoutSeconds, 10);
    assert.equal(saved.paidWindow, "22:00-06:00");
    assert.equal(saved.paidMinBalance, 5);
    assert.equal(saved.tryCooling, false);
    // 非法策略被拒绝，且不破坏已保存的其它字段
    res = await api.setConfig({ strategy: "bogus" });
    assert.equal(res.ok, false);
    saved = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "config.json"), "utf8"));
    assert.equal(saved.strategy, "expiry-first", "invalid strategy rejected, prior value kept");
    // 非法付费窗口被拒绝
    res = await api.setConfig({ paidWindow: "noonish" });
    assert.equal(res.ok, false);
    saved = JSON.parse(fs.readFileSync(path.join(dir, "free-switch", "config.json"), "utf8"));
    assert.equal(saved.paidWindow, "22:00-06:00");
    await api.lifecycle.dispose();
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
