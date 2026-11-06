import fs from "node:fs";
import http from "node:http";
import { loadConfig, configPath, writeJSON } from "./config.mjs";
import { VERSION } from "./core.mjs";

const PAGE = fs.readFileSync(new URL("./console.html", import.meta.url), "utf8");
const ICON = fs.readFileSync(new URL("../icon.png", import.meta.url));
const RELEASE_NOTES = (() => {
  try {
    return fs.readFileSync(new URL("../RELEASE_NOTES.md", import.meta.url), "utf8");
  } catch {
    return "";
  }
})();

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  });
  res.end(body);
}

async function readBody(req, max = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body is not JSON");
  }
}

// A tiny loopback-only console. It is read-only except for refreshing the
// catalog and clearing a cooldown, so it needs no token; it never listens on
// anything but 127.0.0.1.
export function createConsole({ getState, refresh, clearCooldown, disable, enable, switch: setManualSwitch, cancelSwitch, setStrategy }) {
  let server;
  let port = 0;
  let requestedPort = 0;
  let starting;
  let lastError;

  const handler = async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return html(res, 200, PAGE);
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { ok: true, port, lastError: lastError ?? null });
      }
      if (req.method === "GET" && url.pathname === "/icon.png") {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": ICON.length,
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff",
        });
        return res.end(ICON);
      }
      if (req.method === "GET" && url.pathname === "/api/release-notes") {
        return json(res, 200, { version: VERSION, notes: RELEASE_NOTES });
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(res, 200, await getState());
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        await refresh?.(true);
        return json(res, 200, await getState());
      }
      if (req.method === "POST" && url.pathname === "/api/clear") {
        const body = await readBody(req);
        await clearCooldown?.(typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined);
        return json(res, 200, await getState());
      }
      if (req.method === "POST" && url.pathname === "/api/disable") {
        const body = await readBody(req);
        const result = await disable?.(body);
        const state = await getState();
        return json(res, 200, { ...state, ok: result?.ok !== false });
      }
      if (req.method === "POST" && url.pathname === "/api/enable") {
        const body = await readBody(req);
        const result = await enable?.(body);
        const state = await getState();
        return json(res, 200, { ...state, ok: result?.ok !== false });
      }
      if (req.method === "POST" && url.pathname === "/api/switch") {
        const body = await readBody(req);
        const result = await setManualSwitch?.(body?.model);
        const state = await getState();
        return json(res, 200, { ...state, ok: result?.ok !== false, error: result?.error, switchedModel: result?.ok === false ? null : (state.manualSwitch?.model ?? null) });
      }
      if (req.method === "POST" && url.pathname === "/api/cancel-switch") {
        const result = await cancelSwitch?.();
        const state = await getState();
        return json(res, 200, { ...state, ok: result?.ok !== false, error: result?.error });
      }
      if (req.method === "POST" && url.pathname === "/api/strategy") {
        const body = await readBody(req);
        const result = await setStrategy?.(body);
        const state = await getState();
        return json(res, 200, { ...state, ok: result?.ok !== false, error: result?.error });
      }
      if (req.method === "POST" && url.pathname === "/api/providers") {
        const body = await readBody(req);
        const incoming = Array.isArray(body?.providers) ? body.providers : [];
        const config = loadConfig();
        const set = new Set();
        for (const p of incoming) {
          const value = typeof p === "string" ? p.trim() : "";
          if (value && !set.has(value)) set.add(value);
        }
        config.includeProviders = [...set];
        writeJSON(configPath(), config);
        const next = await getState();
        next.lastAction = { at: Date.now(), kind: "providers", providers: config.includeProviders };
        return json(res, 200, next);
      }
      if (req.method === "POST" && url.pathname === "/api/provider") {
        const body = await readBody(req);
        const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
        const config = loadConfig();
        config.includeProviders = provider ? [provider] : [];
        writeJSON(configPath(), config);
        const next = await getState();
        next.lastAction = { at: Date.now(), kind: "provider", provider: provider || null };
        return json(res, 200, next);
      }
      if (req.method === "POST" && url.pathname === "/api/preferred") {
        const body = await readBody(req);
        const modelId = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
        if (!modelId) return json(res, 400, { error: "missing model field" });
        const config = loadConfig();
        const preferredModels = Array.isArray(config.preferredModels) ? [...config.preferredModels] : [];
        const index = preferredModels.indexOf(modelId);
        if (index >= 0) {
          preferredModels.splice(index, 1);
        } else {
          preferredModels.push(modelId);
        }
        config.preferredModels = preferredModels;
        writeJSON(configPath(), config);
        return json(res, 200, await getState());
      }
      if (req.method === "POST" && url.pathname === "/api/preferred-bulk") {
        const body = await readBody(req);
        const ids = Array.isArray(body?.models) ? [...new Set(body.models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()))] : [];
        const mode = body?.mode;
        if (!["all", "invert", "none"].includes(mode)) return json(res, 400, { error: "mode must be all | invert | none" });
        const config = loadConfig();
        const current = Array.isArray(config.preferredModels) ? [...config.preferredModels] : [];
        let next;
        if (mode === "all") {
          next = [...current];
          for (const id of ids) if (!next.includes(id)) next.push(id);
        } else if (mode === "none") {
          const drop = new Set(ids);
          next = current.filter((p) => !drop.has(p));
        } else {
          const set = new Set(current);
          for (const id of ids) {
            if (set.has(id)) set.delete(id);
            else set.add(id);
          }
          next = [...set];
        }
        config.preferredModels = next;
        writeJSON(configPath(), config);
        return json(res, 200, await getState());
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) });
    }
  };

  function listen(portToTry, attempts = 10) {
    return new Promise((resolve, reject) => {
      const candidate = http.createServer(handler);
      const fail = (error) => {
        candidate.close(() => {});
        if (error?.code === "EADDRINUSE" && attempts > 1 && portToTry !== 0 && portToTry < 65535) {
          listen(portToTry + 1, attempts - 1).then(resolve, reject);
          return;
        }
        reject(error);
      };
      candidate.once("error", fail);
      candidate.once("listening", () => {
        candidate.off("error", fail);
        candidate.on("error", (error) => {
          lastError = String(error?.message ?? error);
        });
        server = candidate;
        port = candidate.address().port;
        lastError = undefined;
        try {
          candidate.unref?.();
        } catch {
          /* Bun has no unref on every server shape */
        }
        resolve({ port, url: `http://127.0.0.1:${port}` });
      });
      candidate.listen(portToTry, "127.0.0.1");
    });
  }

  return {
    get running() {
      return !!server;
    },
    get port() {
      return port;
    },
    get requestedPort() {
      return requestedPort;
    },
    get url() {
      return port ? `http://127.0.0.1:${port}` : "";
    },
    get lastError() {
      return lastError;
    },
    async start(portToTry = 17890) {
      requestedPort = Number(portToTry) || 0;
      if (server) {
        if (requestedPort === 0 || requestedPort === port) return this.url;
        // A port change in config.json restarts the listener.
        await this.stop();
      }
      if (starting) return starting;
      starting = listen(requestedPort)
        .then((value) => {
          starting = undefined;
          return value.url;
        })
        .catch((error) => {
          starting = undefined;
          lastError = String(error?.message ?? error);
          throw error;
        });
      return starting;
    },
    async stop() {
      if (starting) {
        try {
          await starting;
        } catch {
          /* it never started */
        }
      }
      if (!server) return;
      const old = server;
      server = undefined;
      port = 0;
      try {
        old.closeAllConnections?.();
      } catch {
        /* not every runtime has it */
      }
      await new Promise((resolve) => old.close(() => resolve()));
    },
  };
}
