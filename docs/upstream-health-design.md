# 上游健康雷达 — 设计（2026-11-06）

## 问题

Magpie 网关已经记录了每次调用的完整上游响应，但插件目前只靠「自己发出的请求失败」来回溯冷却，导致两类体验问题：

1. **报错慢**：上游 429/5xx 常在 30s–3m+ 才返回（实测 `429 after 3m23s`），而插件对单次尝试**没有超时**（`timeoutSignal` 只用在 `/v1/models`），`peekStream` 等首字节也无 deadline；`maxTries: 6` 串行放大到十几分钟。
2. **恢复难**：一次失败后 `Retry-After` / 指数退避把模型冻几小时（实测两个 deepseek 被冻 ~5h、cline/gemma 累积 63 次失败），下一次请求可用候选骤减，于是「提示恢复」后立刻断开。同时 SSE 首字节后的错误无法重放、`499`（调用方取消）被误计为上游失败。

## 方案（已获用户批准：A 完整方案）

### 1. 只读可观测（新增，可降级）

`src/gateway.mjs` 增加三个 GET（带 bearer、5s 超时、失败返回 `undefined`）：

- `fetchUsageRows(limit)` → `/v1/magpie/usage/requests?period=7d&limit=N`
  每行含 `agent, provider, model, req, status, ms, ttft_ms, err, err_type, t, session`。
  **坑**：同一请求有「外层 `agent:opencode, provider:free-switch`」和「内层 `agent:free-switch, provider:workbuddy-ai`」两行；只统计 `agent === "free-switch"` 且 `provider !== free-switch` 的行。`status=499` 是 opencode 取消，**排除**。`period` 参数部分无效、`status` 过滤不支持 → 客户端自行按时间窗筛。
- `fetchConcurrency()` → `/v1/magpie/concurrency`：`active[]` 有 `phase: "upstream"`、`ms`、`model`、`provider`、`session`，用于发现「卡住的在飞请求」。
- `fetchQuotas()` → `/v1/magpie/quotas`：`windows[].used/remaining/resetsAt`，可提前预判配额耗尽（workbuddy-ai Extra credits 已用 98%）。

这些是 Magpie 内网端点（不在 `/` 的 API 清单里），跨版本可能变：**全部 try/catch + 独立超时，拿不到就退回现状**。

### 2. 纯函数聚合（`src/core.mjs`）

`summarizeUpstream(rows, { now, windowMs, minErrors })`：按 `req`（完整 `provider/model`）聚合 →
`{ id, provider, model, calls, errors, rateLimited, serverErrors, timeouts, lastStatus, lastError, lastErrorAt, p50Ms, p90Ms, p50TtftMs, stuckCalls, limited, softUntil }`

- `limited` = 窗口内 `429/408/425/5xx/502` 次数 ≥ `minErrors`（默认 2），且最近一次错误之后没有成功。
- `softUntil` = `lastErrorAt + clamp(30s * 2^(errors-1), 30s, maxSoftCooldownSeconds)`。软冷却只影响排序，**不写 `state.models`、不改变硬冷却**。
- `quotaPressure(quotas)` → `[{ provider, window, used, remaining, pct, resetsAt, tight }]`（`tight` = 剩余 < 15%）。
- `stuckCalls(active, thresholdMs)` → 在飞且 `ms > threshold` 的行。

### 3. 决策（`src/plugin.mjs`）

- **单次首字节超时**：`firstByteTimeoutSeconds`（默认 25，0=禁用）。对每次 `postChat` 用 `AbortSignal.any([request.signal, timeout])`，首字节到达后用 `clearTimeout` 取消（不能杀掉已开始的流式输出）。`peekStream` 加同样的 deadline 参数。超时视为网络错误（status 0），走既有冷却 + 立刻切下一个；不再让整条 failover 链被一个慢上游拖住。
- **主动软降权**：把 `summarizeUpstream` 得到的 `limited` 模型，在 `selectCandidates` 之后排到 ordered 末尾（付费候选也一样过滤）。不改候选池成员、不删模型，只调顺序 → 已有冷却/偏好/priority 语义不受影响。
- **499 误伤修复**：`AbortError` / `request.signal.aborted` 时直接 break，不写冷却；`cooldownFor` 增加 `status: 499` 直接返回 `undefined`。
- **避免冻结过久**：`maxResetSeconds`（默认 1800）钳制 `parseReset` 返回的超长 `Retry-After`；`maxCooldownSeconds` 保持不变。
- 后台每 `upstreamRefreshSeconds`（默认 20）拉一次三个端点，缓存到 `upstreamCache`；`getState` 暴露 `upstream: { at, error, summary, quotas, active, stuck }`。不阻塞请求路径。

### 4. 控制台（`src/console.html`）

- 顶栏加「上游状态」按钮 → dialog：受限模型表（provider/model、状态 tag、最近错误、p50/p90 延迟、TTFT、最近错误时间）、配额窗口进度、卡住的在飞请求、数据时间与降级提示。
- 模型行对被软降权的模型加一个「上游受限」标记（tag），一键可清除（重新拉取）。
- 「刷新上游状态」按钮走 `POST /api/upstream` 强制刷新。
- 设置 dialog 增加相关配置项说明。

### 5. 离线诊断脚本（`scripts/upstream-report.mjs`）

读 `~/.config/magpie/usage.jsonl` + `app.log` + 插件 `traces.jsonl` / `state.json`，输出按 provider+model 的最近 1h/24h 429/5xx 统计、p50/p90 延迟、最后一次错误、当前冷却项对照。零运行时风险，便于事后排查。

### 6. 安全边界（不变）

- 免费 failover 候选池仍是 `discoverFreeModels` 的结果；付费模型仍只在显式策略/手动切换下进入。
- 所有新端点只读、失败静默降级；不新增任何会产生计费的请求路径。
- 软降权只排序，不删除候选；超时只影响单次尝试，不改变 `maxTries` 语义。

## 测试

- `core.test.mjs`：`summarizeUpstream`（过滤 499/双层行、窗口、limited、softUntil、p50/p90）、`quotaPressure`、`stuckCalls`、`cooldownFor(499)`、`parseReset` 钳制。
- `plugin.test.mjs`：网关三个端点的 mock、超时后切换、软降权顺序、`/api/upstream`、499 不写冷却。
- 全部 `node --check` + `npm test` + 无头浏览器渲染新 dialog。

## 验收

重启 magpie 后由用户目视确认上游状态面板、模型标记、超时行为；确认前不标记完成。
