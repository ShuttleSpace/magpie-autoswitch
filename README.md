# magpie-free-switch

给 [Magpie](https://github.com/yetone/magpie) 用的 **免费模型自动切换** 插件。已在 Magpie 0.1.1987 上验证：本地网关发现 54 个免费模型（取决于启用的供应商），一次请求在 3 次尝试后由 cline 的免费模型成功回答。

它在 Magpie 当前启用的供应商里找出所有 **零价格（免费）模型**，合成一个模型给 Agent 用：

```text
free-switch/auto
```

请求先按你配置的顺序尝试“苏醒”的免费模型；遇到 429 限流、5xx、断网、401/403、模型下线时，自动换下一个。插件会记住每个模型的冷却苏醒时间（优先读上游返回的 `Retry-After`、`x-ratelimit-reset`、`resets_at` 等），冷却中的模型排在苏醒模型之后；如果所有模型都在冷却，就按顺序逐个确认。每次尝试和切换都会记录，并可以在本机打开一个只读为主的 Web 控制台查看。

## 安装

```sh
# 本地目录
magpie plugin add ./magpie-free-switch

# 发布到 npm 后
magpie plugin add magpie-free-switch

# 命令行直接登录（免密钥）
magpie plugin login free-switch
```

装好后：

1. 打开 Magpie 的 **Providers（供应商）** 页面，找到 **Free Switch**。
2. 点 **启用 Free Switch（无需密钥）**。这是免密钥登录，不需要填 API Key。
3. 回到供应商页面刷新模型。
4. 在 Agent 的模型选择里选 `free-switch/auto`。

> 插件本身不保存任何供应商密钥。它通过 Magpie 自己的网关 `MAGPIE_ADDR` 读取 `/v1/models` 并转发 `/v1/chat/completions`，所以真正的账号、密钥、配额和协议转换仍然由 Magpie 管理。
>
> 如果本机已经有一个 id 为 `free-switch` 的 provider，Magpie 会把插件显示为 `free-switch-plugin`，模型 id 也会变成 `free-switch-plugin/auto`（登录时用 `magpie plugin login free-switch-plugin`）。插件内部已经排除这两种自身 id，不会递归调用自己。

## 它怎么选模型

1. **发现**：读取 Magpie 的 `/v1/models`，只保留 `pricing.prompt` 和 `pricing.completion` 都为 0 的模型（也识别 `free: true` 和 `cost.input/output` 为 0）。`auto/*`、`group/*` 以及插件自己的模型会被排除。
2. **排序**：按 `config.json` 的 `priority` 排；没写进优先级的模型按 provider、model id 排序。默认优先：
   `opencode-zen-free` → `our-free-model` → `kilo` → `cline` → `workbuddy-ai` → `workbuddy`。
   默认还会按 provider 轮转：第一轮每个 provider 取一个模型，再取第二个，避免一个 provider 的免费池整体限流时占满所有重试次数。`diversifyProviders: false` 可改成严格按列表顺序。
3. **偏好优先**：勾选了“偏好”的模型（见下方控制台说明）会排到最前面，优先被尝试，不管它们在 `priority` 列表里的顺序如何。适合把“有的模型太蠢了”这种不想要的模型压到后面，让好用的模型先上。
4. **苏醒优先**：没有冷却的模型排在前面；正在冷却的模型排在后面。如果所有模型都在冷却，就按原顺序逐个尝试确认。
5. **能力匹配**：请求带 tools、图片或 reasoning 时，优先挑明确支持这些能力的模型；如果一个都不匹配，直接返回明确错误，避免把每个模型都试一遍。
6. **切换**：每个请求最多尝试 `maxTries` 个模型（默认 6）。成功即返回；失败按状态码决定冷却时长。
7. **冷却**：
   - 429：优先用 `Retry-After`、`x-ratelimit-reset`、`x-ratelimit-reset-requests/tokens`、`anthropic-ratelimit-*-reset`、`x-magpie-limit-reset` 或错误正文里的 `resets_at` / “try again in 2m30s” 等提示；没有提示时默认 60 秒，连续失败翻倍。
   - 5xx / 断网 / 408 / 409 / 425：默认 30 秒，连续失败翻倍。
   - 401 / 403：默认 5 分钟。
   - 404 或明确的“模型不存在/不支持”：默认 10 分钟。
   - 400 / 422 这种请求本身的问题：直接返回，不会把每个模型都试一遍。
   - 所有冷却都受 `maxCooldownSeconds`（默认 8 小时）限制。
8. **恢复**：冷却时间过去后，模型自动重新进入“苏醒”候选，和顺序更靠前的苏醒模型一起参与下一次选择；成功一次就清空失败计数。

9. **付费策略**：默认只在免费模型之间切换（`strategy: "free"`）。可选策略：
   - `free`（完全免费）：只走免费候选池，付费模型从不自动参与。
   - `paid-first`（先付费后免费）：先按 `maxPaidTries`（默认 2）个付费模型尝试，再进入免费池。
   - `free-first`（先免费后付费）：先走免费池，全部失败/耗尽后再用付费模型兜底。
   付费候选池由 `paidCandidates` 从全量目录（含付费行）过滤：排除禁用供应商/模型、冷却中的付费模型，并按本次请求的能力过滤（失败则放宽）。付费尝试受 `maxPaidTries` 与 `maxTries` 双重上限，避免一次 failover 失控计费。付费模型的**手动切换**（console「切换付费」）始终可用、不受策略限制，由用户显式触发即计费。

   更细的付费策略（控制台策略下拉框旁的两个输入框，仅策略非 `free` 时显示）：
   - `paidWindow`：自动使用付费模型的时间窗口（**本地时间**），格式 `"22:00-06:00"`，支持跨午夜；留空/`null` 表示全天。窗口外自动切换只用免费模型。
   - `paidMinBalance`：供应商余额下限，默认 `0`（不限制）。读取 Magpie `quotas.json` / `credits-daily.json` 的 `balance`；余额低于该值时该供应商的付费模型不再自动参与。没有余额数据的供应商不拦截（无法判断就不阻止）。
   - 手动切换付费模型同样不受时间窗口与余额下限限制（用户显式动作）。
   - 被策略挡住的付费模型会在控制台行内标注「窗口外」/「余额不足」，便于确认为什么没自动使用。

### 限时免费模型（如 `workbuddy-ai/hy4-preview`）

插件**只从 Magpie 的 `/v1/models` 发现模型**，能否纳入完全取决于 Magpie 暴露的数据。一个模型会被判定为免费，当且仅当它满足以下任一明确信号：

- `free: true`
- `pricing.prompt` 和 `pricing.completion` 都为 `0`
- `cost.input` 和 `cost.output` 都为 `0`
- 名字里含 `(free)` 或独立的 `free` 词（仅当该模型没有价格信息时）

像 `workbuddy-ai/hy4-preview` 这种“限时免费”的模型，Magpie 当前只在列表里暴露它，但**没有给出价格、没有 `free` 标记、名字也不含 `free`**——插件无法判断它到底是不是免费，而**安全原则是绝不把“价格未知”的模型当免费**（否则你可能被扣费）。所以这类模型默认不会被纳入。

如果 Magpie 在限免活动期间给该模型打上上面任一信号（最常见是把价格标 `0` 或加 `free: true`），插件会**自动**纳入，无需改任何配置。

如果你确认某个限时免费模型确实免费、想手动加进来，用 `config.json` 的 `includeModels` 精确指定（绕过价格判定强制纳入）：

```json
{
  "includeModels": ["workbuddy-ai/hy4-preview"]
}
```

- 想整 provider 强制免费，用 `freeProviders`：`{ "freeProviders": ["workbuddy-ai"] }`。
- ⚠️ 这两个字段是“强制白名单”，**请只填你确认确实免费的模型**。填错可能把付费模型纳入并实际产生调用费用。`excludeModels` / `excludeProviders` 永远优先，即使白名单命中也会排除。
- 改完 `config.json` 后，在控制台点“刷新模型”（或等 `refreshSeconds` 自动刷新）即生效。

### 流式请求

插件会先读上游流的前 16 KB，确认第一段不是 `error` 事件，再把字节原样交给 Agent。这样 429、空流、首帧错误仍然可以切换。**如果错误发生在已经输出内容之后**，请求已经交给 Agent，无法无感切换，会按上游错误结束。

## Web 控制台

默认关闭，按需打开：

1. **Providers → Free Switch → 编辑（铅笔）→ Plugin options**。
2. 打开 **本地 Web 控制台**。
3. 等 5 秒内插件启动监听，打开：

```text
http://127.0.0.1:17890
```

也可以不经过 Magpie UI，直接用环境变量启动（适合 `magpie serve` / 服务器）：

```sh
FREE_SWITCH_CONSOLE=1 FREE_SWITCH_CONSOLE_PORT=17890 magpie serve
```

控制台只监听 `127.0.0.1`，不会暴露到局域网。页面每 2 秒刷新，显示：

- 请求数、切换次数、成功率、耗尽次数、正在冷却的模型数；
- 每个免费模型按供应商树形分组，含苏醒/冷却状态、冷却剩余时间（天/时/分）、最近状态、失败次数；按“苏醒时间 / 名称 / 冷却优先”排序，冷却模型排到末尾；
- **偏好勾选**：每个模型行里有一个复选框，勾上后该模型会排到最前面优先尝试（写入 `config.json` 的 `preferredModels`）。再点一次取消。面板标题会显示当前偏好模型数量；
- **刷新模型** 和 **清空冷却** 按钮，以及每个模型单独的“清除”按钮；
- **手动切换 / 禁用**：每个模型行有「切换」「清除」「禁用」按钮；「切换」把该模型设为**下一次** `free-switch/auto` 请求的强制目标（清空它自己的冷却与失败计数，并排到候选最前），提交后对当前已在进行中的请求不生效；「禁用」让该模型不再参与自动切换（标记为已禁用，排到末尾），「启用」恢复；区域限制（如 “not available in your country”）会自动触发这种禁用，需手动「启用」才恢复；
- **选择提供商（顶栏对话框）**：顶栏「选择提供商」按钮弹出对话框，列出 Magpie `providers.json` 里的**全部**供应商。自带免费模型的供应商默认勾选（免费模型参与自动切换）；付费供应商（无免费模型）默认不勾选，可手动勾选。带积分额度或余额的供应商在行内显示「积分 已用/总额」。对话框内有过滤输入框，勾选结果实时写入 `config.json` 的 `includeProviders`；取消全部勾选恢复跨所有供应商自动切换；
- **已选提供商（左栏）**：只显示当前勾选的供应商，卡片纵向布局（图标 + 名称 + 禁用/启用一行，状态点 + 苏醒/偏好 + 积分/余额一行）；**点击卡片**只筛选该供应商的模型，再点一次恢复全部；「禁用」让该供应商下所有模型不参与自动切换，「启用」恢复；
- **模型列表（右栏）**：默认展示**全部**免费模型，按优先级排序：正在使用 → 苏醒（偏好）→ 苏醒 → 冷却 → 已禁用；点选左栏某供应商后只显示它的模型。排序下拉可切换 优先级 / 苏醒时间 / 按名称 / 冷却优先；每行含「偏好」勾选、切换 / 清除 / 禁用操作与冷却剩余时间；左右栏之间有可拖拽分隔条，两栏各自独立滚动；
- 详细的每次切换记录保留在 `~/.config/magpie/free-switch/traces.jsonl`，可用 `cat` / 任意 JSONL 查看器阅读，不在控制台里展示。

控制台端口在 `~/.config/magpie/free-switch/config.json` 的 `consolePort` 修改；端口被占用时会自动往后找 10 个端口。实际地址也会写进 Magpie 日志和供应商的 Usage 卡片。

## 配置文件

首次运行会自动创建：

```text
~/.config/magpie/free-switch/
├── config.json     # 可编辑
├── state.json      # 冷却与统计，插件自动维护
└── traces.jsonl    # 调用追踪，超过 2 MB 自动保留最近 1000 行
```

Windows 下是 `%APPDATA%\magpie\free-switch\`；设置了 `XDG_CONFIG_HOME` 时是 `$XDG_CONFIG_HOME/magpie/free-switch/`。可以用 `MAGPIE_CONFIG_DIR` 指定 Magpie 配置目录（测试/便携环境）。

`config.json` 默认值：

```json
{
  "priority": [
    "opencode-zen-free",
    "our-free-model",
    "kilo",
    "cline",
    "workbuddy-ai",
    "workbuddy"
  ],
  "includeProviders": [],
  "excludeProviders": [],
  "includeModels": [],
  "excludeModels": [],
  "freeProviders": [],
  "preferredModels": [],
  "strategy": "free",
  "maxPaidTries": 2,
  "paidWindow": null,
  "paidMinBalance": 0,
  "maxTries": 6,
  "refreshSeconds": 60,
  "cooldownSeconds": 60,
  "serverErrorCooldownSeconds": 30,
  "authErrorCooldownSeconds": 300,
  "modelGoneCooldownSeconds": 600,
  "maxCooldownSeconds": 28800,
  "tryCooling": true,
  "diversifyProviders": true,
  "console": false,
  "consolePort": 17890
}
```

| 字段 | 作用 |
| --- | --- |
| `priority` | 优先顺序。可以写 provider id、完整 model id、`*` 通配或 `/正则/`。 |
| `includeProviders` / `excludeProviders` | 只包含/排除某些 provider；空数组表示全部。 |
| `includeModels` / `excludeModels` | 只包含/排除某些模型，同样支持通配和正则。 |
| `freeProviders` | 强制把这些 provider 的模型视为免费（有些中转不返回 pricing）。 |
| `preferredModels` | 偏好模型列表。勾选（或在配置里列出）的模型会优先被尝试，支持 provider id、完整 model id、`*` 通配或 `/正则/`。控制台里勾选会自动写入这里。 |
| `strategy` | 自动切换策略：`free`（完全免费，默认）、`paid-first`（先付费后免费）、`free-first`（先免费后付费）。控制台模型面板下拉框实时生效。 |
| `maxPaidTries` | 单次请求最多尝试的付费模型数（默认 2），用于 `paid-first` / `free-first` 策略，防止失控计费。 |
| `paidWindow` | 自动使用付费模型的时间窗口（本地时间），如 `"22:00-06:00"`（支持跨午夜）；`null`/留空表示全天。窗口外只走免费池。 |
| `paidMinBalance` | 供应商余额下限，默认 `0`（不限制）。余额低于该值时该供应商的付费模型不自动参与；无余额数据不拦截。 |
| `maxTries` | 一个请求最多尝试几个模型，1–20。 |
| `refreshSeconds` | 模型列表缓存时间，默认 60 秒；控制台“刷新模型”会立即刷新。 |
| `cooldownSeconds` | 429 没有重置提示时的基础冷却秒数。 |
| `serverErrorCooldownSeconds` | 5xx/网络错误的基础冷却秒数。 |
| `authErrorCooldownSeconds` | 401/403 的冷却秒数。 |
| `modelGoneCooldownSeconds` | 404/模型不可用的冷却秒数。 |
| `maxCooldownSeconds` | 冷却上限，默认 8 小时。 |
| `tryCooling` | 苏醒模型都失败后，是否继续尝试冷却中的模型。 |
| `diversifyProviders` | 默认开：第一轮每个 provider 只取一个模型，再取第二个，避免一个 provider 的免费池全被限流时占满所有重试次数。关掉后严格按优先级列表顺序。 |
| `console` / `consolePort` | Web 控制台开关和端口。Magpie 的 Plugin options 开关优先；`console` 字段只在宿主没有 options 时作为后备，服务器可用 `FREE_SWITCH_CONSOLE`。 |

环境变量覆盖：`FREE_SWITCH_CONSOLE`、`FREE_SWITCH_CONSOLE_PORT`、`FREE_SWITCH_MAX_TRIES`、`FREE_SWITCH_REFRESH_SECONDS`、`FREE_SWITCH_TRY_COOLING`、`FREE_SWITCH_DIVERSIFY_PROVIDERS`、`FREE_SWITCH_PRIORITY`、`FREE_SWITCH_INCLUDE_PROVIDERS`、`FREE_SWITCH_EXCLUDE_PROVIDERS`、`FREE_SWITCH_STRATEGY`、`FREE_SWITCH_MAX_PAID_TRIES`、`FREE_SWITCH_PAID_WINDOW`、`FREE_SWITCH_PAID_MIN_BALANCE`。如果 Magpie 网关不在本机回环地址、需要真实网关密钥，可设置 `FREE_SWITCH_GATEWAY_KEY`。

## 追踪数据

`traces.jsonl` 每行一次请求，结构大致如下：

```json
{
  "id": "…",
  "at": 1760000000000,
  "requested": "auto",
  "session": "ses_…",
  "stream": true,
  "attempts": [
    { "model": "opencode-zen-free/deepseek-v4.1-flash-free", "provider": "opencode-zen-free", "status": 429, "ms": 210, "reason": "retry-after", "cooldownUntil": 1760000060000 },
    { "model": "cline/cline-free/nemotron-3.5-super-vl", "provider": "cline", "status": 200, "ms": 1840, "ok": true }
  ],
  "finalModel": "cline/cline-free/nemotron-3.5-super-vl",
  "ok": true,
  "durationMs": 2050
}
```

`state.json` 保存每个模型的 `until`（苏醒时间）、`reason`、`failures`、最近状态和总统计。点控制台的“清空冷却”会立即重置；删除 `state.json` 则在插件重载后生效。

## 已知限制

- **只支持 Chat Completions 协议**。Magpie 会把 Anthropic Messages、Responses、Gemini 等请求翻译成 Chat 后再交给插件，所以大多数 Agent 都能用；插件自己不会直接说 Anthropic/Gemini 原生协议。
- **免费判定依赖 `/v1/models` 的 pricing**。如果某个中转把免费模型标成非零价格，或者完全不返回 pricing，它不会被自动选中；可以用 `freeProviders` 强制加入。
- **切换发生在首字节之前**。已经流式输出后的错误无法重放，除非 Agent 自己重试。
- **模型能力是尽力匹配**。插件会看 `/v1/models` 的 `tool_call`、`modalities`、`reasoning` 字段；字段缺失时按保守处理，如果能力要求没有任何匹配项，会返回错误而不是逐个试。
- **不绕过供应商自己的限制**。免费额度、账号风控、模型下架仍由供应商决定；本插件只是把“换一个免费模型再试”自动化。
- **控制台没有登录**。它只绑定 `127.0.0.1`，不要用端口转发把它暴露给不受信任的网络。服务器或容器里它绑定的是容器内的回环地址，需要 SSH 端口转发才能从本机浏览器打开；也可以直接看 `traces.jsonl`。
- 插件通过 Magpie 网关转发，因此 Magpie 必须保持运行；在 Magpie 里看到的用量会记在 `free-switch` 这个调用方名下，同时底层供应商也会各自记账。

## 开发

```sh
cd magpie-free-switch
npm test          # 等价于 node --test test/*.test.mjs
```

测试覆盖：免费模型过滤、优先级、苏醒/冷却排序、能力匹配、Retry-After/重置时间解析、429/5xx/401/404/400 的冷却策略、非流式与流式切换、400 直通，以及控制台 HTTP 服务。

目录：

```text
index.mjs              Magpie 入口
src/plugin.mjs         provider/auth/fetch 钩子与切换主循环
src/core.mjs           纯函数：发现、排序、冷却、重置时间解析
src/config.mjs         配置、状态、追踪文件
src/gateway.mjs        访问 Magpie 网关
src/console.mjs        本地 Web 控制台服务
src/console.html       控制台页面
test/                  Node 内置测试
```

## License

MIT

## 更新日志

### 0.2.0
- 新增**禁用 / 启用供应商**与**禁用 / 启用模型**：在控制台一键禁用后，该供应商下所有模型（或单个模型）不再参与自动切换，卡片置灰、明确标「已禁用」；「启用」恢复。区域限制（如 “not available in your country”）会**自动禁用**该模型，需手动启用才恢复。禁用状态持久化在 `state.json`。
- 新增**手动切换**：每个模型行有「切换」按钮，把该模型设为下一次 `free-switch/auto` 请求的强制目标（清空其冷却与失败计数并排到候选最前），对当前进行中的请求不生效，下一次请求即生效。
- `free-switch/auto` 的 failover 现在跳过所有被禁用（模型级或供应商级）的模型。
