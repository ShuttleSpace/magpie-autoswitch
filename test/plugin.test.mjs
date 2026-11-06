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
    close: () => new Promise((resolve) => server.close(resolve)),
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
    const trae = credits.find((c) => c.provider === "trae-cn");
    assert.ok(trae, "trae-cn should appear in the credit snapshot");
    assert.equal(trae.total, 1600);
    assert.equal(trae.used, 947.15);
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

  // unknown endpoint -> 404
  res = await fetch(`${url}/api/nope`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 404);
  await consoleServer.stop();
});

test("manual switch through the real console wiring forces the next request", async () => {
  const dir = tmpdir();
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
