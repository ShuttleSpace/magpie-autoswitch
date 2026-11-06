// Talking to magpie's own gateway. A plugin's fetch runs inside the plugin
// host, and the host is told where the gateway listens as MAGPIE_ADDR; on
// loopback the gateway takes any bearer key, so this plugin names itself and
// lets magpie do the provider routing, protocol translation and accounting.

const USER_AGENT = "magpie-free-switch/0.1.0";
const DEFAULT_ADDR = "127.0.0.1:3425";

export function gatewayAddress() {
  const raw = (process.env.MAGPIE_ADDR || "").trim() || DEFAULT_ADDR;
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return `http://${DEFAULT_ADDR}`;
  }
  let host = url.hostname || "127.0.0.1";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  const port = url.port || "3425";
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `${url.protocol === "https:" ? "https" : "http"}://${bracketed}:${port}`;
}

function authHeaders(extra = {}) {
  const key = (process.env.FREE_SWITCH_GATEWAY_KEY || "").trim() || "magpie-free-switch";
  const headers = new Headers({
    authorization: `Bearer ${key}`,
    "user-agent": USER_AGENT,
    ...extra,
  });
  return headers;
}

export function timeoutSignal(signal, ms = 15_000) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function readLimited(response, max = 64 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < max) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      text += decoder.decode(part.value, { stream: true });
    }
  } catch {
    /* the status and whatever arrived are still useful */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return text.slice(0, max);
}

export async function fetchModelRows(signal) {
  const base = gatewayAddress();
  const response = await fetch(`${base}/v1/models`, {
    headers: authHeaders({ accept: "application/json" }),
    signal: timeoutSignal(signal, 15_000),
    redirect: "error",
  });
  if (!response.ok) {
    const body = await readLimited(response, 4096);
    throw new Error(`magpie /v1/models answered HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  const value = await response.json();
  if (!Array.isArray(value?.data)) throw new Error("magpie /v1/models did not return a data array");
  return value.data;
}

export async function postChat(body, { signal, session } = {}) {
  const base = gatewayAddress();
  const headers = authHeaders({
    "content-type": "application/json",
    accept: body?.stream === true ? "text/event-stream" : "application/json",
  });
  if (session) {
    for (const name of ["x-magpie-session", "x-session-id", "x-session-affinity"]) headers.set(name, session);
  }
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
}

// Read-only observability endpoints of magpie's gateway. These are internal
// (not listed in the root API index), so every caller must tolerate a missing
// or changed endpoint: undefined means "no data", never a thrown error.
async function fetchMagpieJSON(path, signal, timeoutMs = 5000) {
  const response = await fetch(`${gatewayAddress()}${path}`, {
    headers: authHeaders({ accept: "application/json" }),
    signal: timeoutSignal(signal, timeoutMs),
    redirect: "error",
  });
  if (!response.ok) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function fetchUsageRows(signal, limit = 500) {
  const n = Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 500)));
  const value = await fetchMagpieJSON(`/v1/magpie/usage/requests?period=7d&limit=${n}`, signal);
  return Array.isArray(value?.rows) ? value.rows : undefined;
}

export async function fetchConcurrency(signal) {
  const value = await fetchMagpieJSON("/v1/magpie/concurrency", signal);
  return value && typeof value === "object" ? { active: value.active ?? [], data: value.data ?? {}, requests: value.requests ?? 0 } : undefined;
}

export async function fetchQuotas(signal) {
  const value = await fetchMagpieJSON("/v1/magpie/quotas", signal);
  return Array.isArray(value?.data) ? value.data : undefined;
}
