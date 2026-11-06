#!/usr/bin/env node
// 离线诊断：从 Magpie 的 usage.jsonl / app.log 与插件的 traces.jsonl / state.json
// 还原「哪个上游 provider+model 正在限流、有多慢、当前被冻了多久」。
// 不启动服务、不发请求， purely read-only。
//
//   node scripts/upstream-report.mjs            # 最近 1 小时
//   node scripts/upstream-report.mjs --hours 24
//   node scripts/upstream-report.mjs --json

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { magpieConfigDir } from "../src/config.mjs";
import { summarizeUpstream, quotaPressure } from "../src/core.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const hours = Math.max(1, Number(argOf("--hours", "1")) || 1);
const asJSON = args.includes("--json");
const dir = magpieConfigDir();
const usageFile = path.join(dir, "usage.jsonl");
const quotaFile = path.join(dir, "quotas.json");
const pluginDir = path.join(dir, "free-switch");
const stateFile = path.join(pluginDir, "state.json");
const tracesFile = path.join(pluginDir, "traces.jsonl");
const appLog = path.join(os.homedir(), "Library", "Logs", "magpie", "app.log");

function readJSONL(file, maxLines = 20000) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.trim().split("\n").slice(-maxLines);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a partial last line is normal for an append-only log */
    }
  }
  return out;
}

const now = Date.now();
const since = now - hours * 3600_000;
const rows = readJSONL(usageFile).filter((r) => {
  const at = Date.parse(r?.t ?? "");
  return Number.isFinite(at) && at >= since;
});
const summary = summarizeUpstream(rows, { now, windowMs: hours * 3600_000, minErrors: 1 });

let quotas = {};
try {
  quotas = JSON.parse(fs.readFileSync(quotaFile, "utf8"));
} catch {
  /* optional */
}
// quotas.json 里 windows[].used 是「已用百分比」，网关端点则是绝对数；
// 这里统一换算成 { used, remaining } 再交给 quotaPressure。
const quotaWindows = quotaPressure(
  Object.entries(quotas ?? {}).map(([key, value]) => ({
    provider: value?.quota?.provider ?? key.split("/")[0],
    name: value?.quota?.name ?? key,
    windows: (Array.isArray(value?.quota?.windows) ? value.quota.windows : []).map((w) => {
      const used = Number(w?.used);
      if (!Number.isFinite(used)) return w;
      if (Number.isFinite(Number(w?.remaining))) return w;
      return { ...w, used, remaining: Math.max(0, 100 - used) };
    }),
  })),
);

let state = {};
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {
  /* optional */
}
const cooling = Object.entries(state?.models ?? {})
  .filter(([, v]) => Number(v?.until) > now)
  .map(([id, v]) => ({ id, reason: v.reason, secondsLeft: Math.round((v.until - now) / 1000), failures: v.failures ?? 0 }))
  .sort((a, b) => b.secondsLeft - a.secondsLeft);

const traces = readJSONL(tracesFile, 2000).filter((t) => Number(t?.at) >= since);
const failedTraces = traces.filter((t) => !t.ok && !t.aborted);
const attempts = traces.flatMap((t) => t.attempts ?? []);
const slowAttempts = attempts.filter((a) => Number(a.ms) > 30_000);
const timedOut = attempts.filter((a) => a.timedOut);

let logLines = [];
try {
  logLines = fs.readFileSync(appLog, "utf8").trim().split("\n").slice(-4000)
    .filter((l) => /failed: (429|5\d\d|499)|plugin \[warn\]/.test(l))
    .slice(-15);
} catch {
  /* optional */
}

const report = {
  generatedAt: new Date(now).toISOString(),
  windowHours: hours,
  usageRows: rows.length,
  errors: rows.filter((r) => r.agent === "free-switch" && Number(r.status) >= 400 && Number(r.status) !== 499).length,
  cancels499: rows.filter((r) => Number(r.status) === 499).length,
  limited: summary.filter((s) => s.limited),
  otherModels: summary.filter((s) => !s.limited).slice(0, 10),
  quotaTight: quotaWindows.filter((q) => q.tight),
  cooling,
  traces: { total: traces.length, failed: failedTraces.length, slowAttempts: slowAttempts.length, timedOut: timedOut.length },
  recentLogLines: logLines,
};

if (asJSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (s) => console.log(s);
  line(`AutoSwitch 上游诊断 · 最近 ${hours} 小时 · ${report.generatedAt}`);
  line(`usage.jsonl: ${report.usageRows} 行, 上游错误 ${report.errors}, 调用方取消(499) ${report.cancels499}`);
  line(`traces: ${report.traces.total} 次请求, 失败 ${report.traces.failed}, 慢尝试(>30s) ${report.traces.slowAttempts}, 首字节超时 ${report.traces.timedOut}`);
  line("");
  line("受限模型（已排除 499 与非插件发起的调用）:");
  if (!report.limited.length) line("  （无）");
  for (const s of report.limited) {
    line(`  ${s.id}`);
    line(`    429/408: ${s.rateLimited}, 5xx/网络: ${s.serverErrors}, 调用 ${s.calls}, p50/p90 ${s.p50Ms}/${s.p90Ms}ms, TTFT p50 ${s.p50TtftMs}ms`);
    line(`    最后错误: ${String(s.lastError ?? "").slice(0, 160)}`);
  }
  line("");
  line("紧张的配额窗口:");
  if (!report.quotaTight.length) line("  （无）");
  for (const q of report.quotaTight) line(`  ${q.name} / ${q.window}: 剩余 ${q.pct}% (${q.remaining}/${q.remaining + q.used})`);
  line("");
  line("当前冷却中的模型:");
  if (!cooling.length) line("  （无）");
  for (const c of cooling.slice(0, 20)) line(`  ${c.id} — ${c.reason ?? "?"}, 剩余 ${c.secondsLeft}s, 连续失败 ${c.failures}`);
  if (logLines.length) {
    line("");
    line("app.log 最近的失败行:");
    for (const l of logLines) line(`  ${l.slice(0, 220)}`);
  }
}
