import fs from "node:fs";
import http from "node:http";
import { loadConfig, configPath, writeJSON } from "./config.mjs";

const PAGE = fs.readFileSync(new URL("./console.html", import.meta.url), "utf8");

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
export function createConsole({ getState, refresh, clearCooldown, disable, enable, switch: setManualSwitch }) {
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
        return json(res, 200, { ...state, ok: result?.ok !== false });
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
