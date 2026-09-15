# dsh-clinepass

把 **Cline Pass** 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh），并把每条请求**钉死在 DeepSeek 官方渠道**上（不回退）。
API key 在 **设置 → 模型** 里直接填。**默认不开任何本地端口。**

> Cline Pass for DeepSeek Harness. One provider route, pinned to the DeepSeek upstream channel, with the API key entered on **Settings → Models**.

> **分享性质，非长期维护项目。** 这是作者自用插件的公开快照：按 MIT **原样**提供，
> **不承诺持续维护，也不承诺跟进上游 dsh 的接口漂移**。插件依赖 dsh 的内部行为
> （pi-ai 每次请求新建 client、不传自己的 `options.fetch`，因此真正发请求的是全局
> `fetch`）；上游哪天改掉这一点，插件会**静默失效**——下面的状态文件
> （`hook: installed`）就是为这件事准备的报警器。装之前建议先读「验证」一节。
> 能跑测试不代表上游永远不变。

---

## 它做了什么（架构）

两件事各由最合适的部分负责：

1. **路由本身**是一个普通的 **pi-ai provider profile**（`llm-pi-ai.providers.cline-pass`）：OpenAI 兼容协议 + 一个存在凭据库里的 key。
   正因为如此，它才会**原生出现在「设置 → 模型」**里 —— key 输入框、模型目录、地址都是 dsh 自带的界面，不需要自写 UI，也不需要一个可能随 dsh 升级而漂移的手写流式 adapter。

2. **本插件**只做一件事：给请求体加上**渠道钉选字段**。
   Cline Pass 的钉选是请求体里的 `providerOptions.gateway.only`，而 dsh 刻意屏蔽了 pi-ai 的 `openRouterRouting` / `vercelGatewayRouting` 兼容开关 —— settings 里写不了。插件把这个字段加在**出去的请求**上，字节层面其它什么都不動，SSE / 工具调用 / 推理 / 用量 / 图片全部走 pi-ai 已验证的通路。

```
dsh ──pi-ai──> https://api.cline.bot/api/v1   （进程内改写请求体，无监听、无端口）
```

注入方式是**进程内**的：包一层 `globalThis.fetch`，只改写发往**本网关**的 `chat/completions` 请求体。
依赖的是 pi-ai 的既有行为（它每次请求新建 client、不传自己的 `options.fetch`，所以真正承载请求的就是全局 fetch）；万一将来 dsh 改成自带 fetch，就会**静默失效** —— 下面的状态文件就是为此存在的。

> **0.5.0 起，本插件不再开任何监听。** 之前的 loopback 反代 transport（`transport: proxy` / `listen` / `captureDir`）已经删除；旧配置里还留着这些字段不会报错，但会在启动日志里被指出一次并忽略。

只有落到 `upstream` 这一个 origin 的 `chat/completions` 会被改写；**其它 provider 的请求连对象都不会被复制**（同一个 `init` 原样传给原函数）。

插件启动时还会**自动登记**那条 provider profile：不存在就创建；如果它认得出是自己建的那张卡、只是地址过期了（例如从旧版反代换过来后地址还指着 `127.0.0.1:8791`），就只把地址改回来；认不出（是别人/手工建的）就原样不动并在日志里报警。

---

## 环境要求

- dsh `0.1.5` 及以上（开发者预览版系列）
- Node.js ≥ 20
- 一个 Cline Pass API key（`sk_...`）

**没有任何第三方依赖**：插件只用 Node 内置模块，`index.js` 一个文件就能读完、审完。`test-fetch.mjs` / `test-settings.mjs` / `test-install.mjs` 在任何目录都能跑（不需要 dsh 的 `node_modules`）；`smoke-test.mjs` 要读 `settings.yaml`，所以需要 dsh 自带的 `js-yaml`。

## 安装

### 方式 A：一条命令（推荐）

```sh
dsh plugin --profile web add github:BreakFree003/dsh-clinepass-deepseekv4.1
```

`dsh plugin` 把命令转发给 profile 目录里的 pnpm；装完它再看这个包有没有声明
`dsh.bundle.patch`（`package.json` 里有），有就**自动把 `dsh-clinepass` 追加进
`dsh.profile.bundles`** —— 不用 clone，也不用自己动 `cordis.patch.yml`。插件行来自
包自带的 `cordis.patch.yml`；卸载同样交给 pnpm：

```sh
dsh plugin --profile web remove dsh-clinepass
```

要锁版本就带上 tag（不带则取默认分支的最新提交）：

```sh
dsh plugin --profile web add github:BreakFree003/dsh-clinepass-deepseekv4.1#v0.6.0
```

> 这条路径要求 PATH 上有 `pnpm` —— `dsh plugin` 本身就是 pnpm 转发器。

### 方式 B：用安装器（不需要 pnpm，离线可用）

```sh
git clone https://github.com/BreakFree003/dsh-clinepass-deepseekv4.1
cd dsh-clinepass-deepseekv4.1
node install.mjs                    # 默认装进 ~/.dsh，profile web
```

常用参数：

```sh
node install.mjs --dsh-home /tmp/mydsh         # 装进别的 DSH_HOME
node install.mjs --profile headless            # 装进别的 profile
node install.mjs --dry-run                     # 只看会改什么
```

> `--transport` / `--port` 在 0.5.0 已移除。安装器会明确拒绝它们，而不是默默忽略 —— 一个被忽略的 `--port` 看起来会像"生效了"。

安装器会：把插件复制到 `<DSH_HOME>/profiles/<profile>/plugins/dsh-clinepass/`，并把一条 loader 行追加到该 profile 的 `cordis.patch.yml`（**幂等**，改动前自动备份；重跑会把旧行升级成当前规范形态）。

> **A 和 B 二选一。** 两条路径挂载的都是 id 为 `clinepass` 的那一行，只是来源不同：
> A 取包自带的 `cordis.patch.yml`，B 往你 profile 的 `cordis.patch.yml` 里写。同时用
> 会挂两份。换路径前先按「卸载」清掉上一种。

### 方式 C：手动

1. 复制 `index.js`、`package.json`、`test-fetch.mjs`、`test-settings.mjs` 到 `<DSH_HOME>/profiles/<profile>/plugins/dsh-clinepass/`；
2. 在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 里加一段（见 `patch.example.yml`）：

```yaml
- insert:
    - id: clinepass
      name: './plugins/dsh-clinepass/index.js'
      config:
        upstream: https://api.cline.bot
        pin:
          - deepseek
```

### 然后

1. **重启 dsh**（profile 只在启动时读取）：终端里 `Ctrl-C`，再 `dsh web`。
2. 打开 **设置 → 模型**，会出现一张 **Cline Pass** 卡片（插件启动时自动登记）。把 API key 粘进去、保存。
3. 在模型选择器里选 **Cline Pass / DeepSeek V4.1 Flash**。

想让它成为默认模型，在 `~/.dsh/settings.yaml` 里加：

```yaml
agent-default-model:
  provider: cline-pass
  model: cline-pass/deepseek-v4.1-flash
  reasoningEffort: high
```

> 档位只有两个：`high`（线上 `reasoning_effort: "high"`）和 `max`（线上 `"max"`）。`max` 就是 pi-ai 升级顺序里的最高档，profile 里可以直接声明它，不需要别名。
> 从旧版本升上来不用手改：插件会把卡片地址改回网关，把卡片里那两个档位声明补齐，并清掉已废弃的 `xhigh`；如果你 settings 里存的正是 `xhigh`，启动时会把它改成 `max`（同一个意思，不会悄悄降档）。

---

## 设置 key（重点）

「设置 → 模型 → Cline Pass → 编辑」里的 **API 密钥** 就是它：

- key 存在 dsh 凭据库里，引用名 `CLINE_PASS_API_KEY`；
- 卡片会显示「API 密钥已配置 / 缺失」；
- 换 key 直接覆盖，不需重启。

key 也可以在启动环境里给（凭据库优先）：`CLINE_PASS_API_KEY=sk_... dsh web`。

---

## 配置项

全部有默认值，只挂载就够用。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `upstream` | `https://api.cline.bot` | 真网关 origin |
| `pin` | `['deepseek']` | 所有请求限制到的上游渠道 |
| `pins` | `{}` | 按模型覆盖，如 `{ 'cline-pass/deepseek-v4.1-flash': ['deepseek'] }` |
| `provider` | `cline-pass` | provider 路由 id（= profile 的 key） |
| `model` | `cline-pass/deepseek-v4.1-flash` | 模型 id，**原样作为线上 `model` 字段**（网关要求 `type/model`） |
| `displayName` | `Cline Pass` | 选择器里的名字 |
| `contextWindow` / `maxTokens` | `921600` / `131072` | 模型容量，登记 profile 时使用 |
| `apiKeyEnv` | `CLINE_PASS_API_KEY` | profile 里记录的凭据引用 |
| `provision` | `true` | 启动时自动登记 provider profile（缺失则创建；自家卡片地址过期则只修地址） |
| `alignReasoningEffort` | `true` | 若 `agent-default-model.reasoningEffort` 不是本模型声明的档位（只剩 `high` / `max` 两个），启动时对齐：废弃的 `xhigh` → `max`，其它不认识的值 → `high` |
| `statusFile` | `true` | 把钉选状态写到 `<DSH_HOME>/dsh-clinepass-status.json`（见下）；也可给自定义路径，或 `false` 关掉 |

> `pin: []` = 不注入任何字段（纯透传）。`pins` 优先于 `pin`；把某个模型配成 `pins: { '<model>': [] }` 等于**单独关掉**那条路由的钉选，启动时会警告。
>
> 已删除（0.5.0）：`transport`、`listen`、`captureDir`，以及旧版的 `address` / `baseURL`。旧配置里留着不会报错，启动日志会各指出一次。

## 验证

```sh
cat ~/.dsh/dsh-clinepass-status.json     # 正在跑的 dsh 自己写的状态（见下）
# {"service":"dsh-clinepass","transport":"fetch","hook":"installed","pin":["deepseek"],
#  "counters":{"seen":4,"pinned":4,"skipped":0},"lastPin":{"model":"cline-pass/...","only":["deepseek"],...},
#  "ignoredOptions":[],"pid":1234}

node test-package.mjs       # 打包不变量：bundle 声明可用、无生命周期脚本、bundle 行与安装器行不漂移
node test-fetch.mjs         # 单元测试：URL 域限定/透传保真/安装卸载/请求体形态/robustness/状态文件/真 fetch 集成
node test-settings.mjs      # 配置面（含已删除选项）、profile 登记与修复、档位迁移
node test-install.mjs       # 安装器/卸载器往返测试（幂等、注释不丢、逐字节还原）
node smoke-test.mjs         # 冒烟：读状态文件确认活着的 dsh 挂着钩子 + 经真网关跑一轮，断言 finalProvider=deepseek
node smoke-test.mjs --negative   # 追加反向对照：不可能渠道必须被拒绝
```

没有测试框架，全是自带断言的 Node 脚本（零依赖）。`npm test` 跑前四个；其中
`test-fetch.mjs` 末尾会真的往网关发一次请求，需要网络。`smoke-test.mjs` 另外还要求
**正在运行**的 dsh。

`hook` 字段就是「静默失效」的报警器：`installed` = 钩子在全局 fetch 上；`uninstalled` = 被卸载了；`unavailable` = 装不进去（有东西先替换了 fetch，日志里会报，这种情况现在没有备用 transport 可切，要先找出是哪个插件抢了全局 fetch）；`foreign` = 装好之后有别的代码把全局 fetch 换掉了（插件每 30 秒自查一次，所以最迟半分钟内可见；换掉之后请求就不再被钉）。`counters.seen` 是落到本网关的 chat 请求数，`pinned` 是真正注入了钉选的请求数 —— **`seen` 涨而 `pinned` 不涨**就说明有请求被跳过了（日志里有 `[clinepass] not pinning ...` 的原因）。状态文件里**不含任何凭据**，并且只有当前持有全局 fetch 的那个插件实例会写它。

`smoke-test.mjs` 会先读状态文件确认**正在运行的 dsh** 里钩子是 `installed`、且计数器在动（pid 已退出/`hook: uninstalled` 时会明确说明它只能验到哪一步；记录里的 pid 存活才作数），确认本插件没有监听任何本地端口，再用同一份插件代码在测试进程里注入一次、打真网关断言 `finalProvider: "deepseek"`。

`provision` 字段说明 provider 卡片的登记结果：`created`（新建）/ `present`（已存在）/ `repaired`（地址过期已修正）/ `mismatch`（那张卡片不是本插件建的，未改动；请求会绕过钉选，需要你手动改地址）/ `failed`（settings 写入失败，日志里会有原因）。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 设置 → 模型里没有 Cline Pass 卡片 | dsh 还没重启；或 `provision` 被关掉、settings 只读。看日志与状态文件的 `hook`；也可手动按 `patch.example.yml` 里的 profile 结构添加 |
| 卡片里 API 地址不是 `https://api.cline.bot/api/v1` | 那张卡片不是本插件建的（`provision: mismatch`），插件不去改它。改成网关地址，否则请求绕过钉选 |
| 状态文件里 `hook: unavailable` | 有别的插件先替换了 `globalThis.fetch`。找出是哪个插件；现在没有备用 transport，钩子装不进去时请求会不带钉选 |
| 状态文件里 `hook: foreign` | 装好之后全局 fetch 被别的代码换掉了（插件每 30 秒自查）。换掉之后的请求不再被钉，排查是哪个插件 |
| 状态文件里 `seen` 在涨、`pinned` 不涨 | 有请求被跳过：日志里的 `[clinepass] not pinning request #N: ...` 会给出原因（非 JSON 体、流式体、无 body），或按模型的 `pins` 被配成了 `[]` |
| `reasoningEffort: max` 能用吗 | 能，而且是两个档位里的最高档。卡片里声明 `high` / `max`：线上分别发 `reasoning_effort: "high"` / `"max"`。旧卡片里多出来的 `xhigh` 会被清掉；settings 里存的 `xhigh` 会被改成 `max` |
| 状态文件里 `seen: 0` 但你刚聊过 | 那条路由没走本网关（地址被改过 / 选了别的 provider），或 dsh 里跑的不是这份插件 |
| `UNKNOWN_MODEL` | profile 里的 `models[].id` 与 dsh 选择的模型不一致。id 必须是 `cline-pass/deepseek-v4.1-flash` 这种带前缀形式 |
| `UNSUPPORTED_REASONING_EFFORT` | 存的档位不在卡片声明的档位里（只有 `high` / `max`）。插件启动时会把默认模型的那个值对齐（`xhigh` → `max`，其它 → `high`）；**若某个已存会话仍报错**，在输入框的档位选择里重选一次即可 |
| `MISSING_CREDENTIAL` | 还没在设置页填 key，或填到了别的引用名 |
| 启动日志说 `"listen" is no longer used` | 旧配置里还留着已删除的反代选项；删掉那个字段即可（不影响运行） |
| 严格钉选的代价 | `fallbacksAvailable: []` 意味着 deepseek 渠道不可用时请求直接失败、**不会回退** —— 这是「钉死」的语义 |

## 安全说明

- **不监听任何端口**：插件只包一层 `globalThis.fetch`，且只改写发往 `upstream` 的 `chat/completions`。
- 插件**不持有** API key —— key 由 dsh 从凭据库取出、写进请求头，插件只加一个路由字段。状态文件里只有计数、时间、模型名与钉选渠道，没有密钥。
- 日志只打印请求方法/路径/模型/钉选渠道，`authorization` 会被脱敏成 `sk_ab…yz (len=NN)` 这种形状（形状示例，不是任何真实 key）。
- 旧版的 `captureDir` 会把请求/响应原文（含对话内容）落盘，该功能已随反代一起删除。

## 与 npm 上 `dsh-cline-pass` 的区别

npm 上另有一个名字很像的包 **`dsh-cline-pass`**（作者 yhshzh），解决的问题有重叠，路线不同：
它**自带** provider 适配器、渠道枚举与账户池，走 npm 发布；本插件（`dsh-clinepass`，**没有连字符**）
刻意反过来 —— 不自带适配器，复用 dsh 内置的 pi-ai 路由，只往出站请求体里注入渠道钉选字段，
所以不存在第二套会随上游漂移的流式适配器。

两者都会注册 provider 路由，**不要同时挂载**。装之前看清楚名字。

## 卸载

**方式 A（bundle）装的：**

```sh
# 1. 先摘掉自动登记的那张 provider 卡片 —— 这一步要在移除包之前跑
DSH_HOME=~/.dsh node ~/.dsh/profiles/web/node_modules/dsh-clinepass/uninstall.mjs --profile web
# 2. 再让 pnpm 移除包，并自动把它从 dsh.profile.bundles 摘掉
dsh plugin --profile web remove dsh-clinepass
```

第 1 步会顺带报「没找到 `clinepass` 行」「插件目录已不存在」——bundle 布局下这两件事本来
就无事可做，它真正干活的是删掉 `settings.yaml` 里的 `llm-pi-ai.providers.cline-pass`。
想留着那张卡片就加 `--keep-provider`。

**方式 B（安装器）装的：**

```sh
node uninstall.mjs                  # 移除 loader 行 + 插件目录 + 自动登记的 profile
node uninstall.mjs --keep-provider  # 保留设置页那张卡片
```

两种方式卸载后都要**重启 dsh**，「Cline Pass」卡片才会从设置页消失。

---

## English

**dsh-clinepass** connects Cline Pass to DeepSeek Harness with every request **pinned to the DeepSeek upstream channel** (strict, no fallback), and its API key entered on **Settings → Models**.

**Architecture.** The route is an ordinary **pi-ai provider profile** (`llm-pi-ai.providers.cline-pass`, OpenAI-compatible, key from the credential store) — which is exactly why dsh renders a native provider card with a key field for it. The plugin only adds `providerOptions.gateway.only` to outgoing requests, leaving streaming, tool calls, reasoning, usage and images on pi-ai's proven path. The pin is injected **in-process**: the plugin wraps `globalThis.fetch` for the life of the process and rewrites **only** this gateway's chat-completions bodies — **no listener, no port, nothing to configure for transport**. (0.5.0 removed the optional loopback reverse proxy; a config still naming `transport` / `listen` / `captureDir` is reported once and ignored.) Only requests to the configured `upstream` origin are ever touched, and unrelated calls are passed through as the exact same arguments. On start the plugin also **provisions** the profile (repairing only a recognisably-own stale address, never overwriting a foreign one) and aligns an unsupported stored reasoning level.

**Install.** `dsh plugin --profile web add github:BreakFree003/dsh-clinepass-deepseekv4.1` — the package declares `dsh.bundle.patch`, so `dsh plugin` (a pnpm forwarder) installs it and appends it to `dsh.profile.bundles` on its own: no clone, no hand-edited patch. Append `#v0.6.0` to pin a tag. Without pnpm, `node install.mjs` copies the plugin into the profile and appends the loader row instead (idempotent + backed up) — use one route or the other, never both. Restart dsh either way, then set the key on Settings → Models. Configuration defaults are complete — `upstream`, `pin`, `pins`, `provider`, `model`, `apiKeyEnv`, `provision`, `alignReasoningEffort`, `statusFile`. **No third-party dependencies**: the plugin imports only Node built-ins, so the whole thing is one auditable file.

**Verify.** `cat ~/.dsh/dsh-clinepass-status.json` — the running dsh writes its hook state and counters there (`hook: installed`, `seen`/`pinned`/`skipped`, last pin), which is how a silently bypassed hook becomes visible; `node test-package.mjs` (packaging invariants: the bundle declaration is installable, no lifecycle scripts, and the bundle and installer rows cannot drift), `node test-fetch.mjs` (URL scoping, pass-through fidelity, install/uninstall and reload semantics, body shapes, robustness, status file, integration through the real fetch), `node test-settings.mjs` (the option surface, provisioning and the effort migration), `node test-install.mjs` (install/uninstall round trips), `node smoke-test.mjs [--negative]` (checks the live process's status file, then runs a real gateway round trip asserting `finalProvider: "deepseek"` and no fallbacks). 

**Uninstall.** Bundle install: run `uninstall.mjs` from the installed package (`node <profile>/node_modules/dsh-clinepass/uninstall.mjs` — it drops the provisioned provider profile), then `dsh plugin --profile web remove dsh-clinepass`. Installer install: `node uninstall.mjs [--keep-provider]`. Restart dsh afterwards.

**Status.** Shared as-is for others to use, **not a maintained project**: no support promise, no commitment to track upstream dsh changes. The plugin leans on an internal dsh/pi-ai detail (pi-ai builds a fresh client per request and passes no `options.fetch`, so the real transport is the global `fetch`); if that ever changes the pin fails **silently**, which is exactly what the status file's `hook` field exists to expose.

**See also.** A related package named `dsh-cline-pass` (npm, by yhshzh) solves overlapping problems with a self-contained provider adapter and account pool; this one (`dsh-clinepass`, no hyphen) deliberately reuses dsh's built-in pi-ai route and only injects the pin field. Both register provider routes — do not mount both.

**Security.** The plugin opens no socket at all, and the hook only rewrites requests aimed at the configured gateway origin. It holds no credential of its own (the key travels in the request header dsh sets), its status file contains no secrets, and logs redact the auth header.

## License

MIT — see [LICENSE](./LICENSE).
