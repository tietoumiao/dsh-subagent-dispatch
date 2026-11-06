# dsh-subagent-dispatch

给 DSH 补上**两条互补的委派通道**：一条**按次（per-call）**可调（`dispatch_subagent`），一条**按轮（per-run）**可配
（工具 `run_workflow` 与 external provider `dispatch`，同一套注入机制的两个入口）。
**0.5.0 起额外承担一件事**：**同名接管（真重定向）**——对每个**本来就能看见** `workflow` 的 agent，本插件在
**该 agent 自己的作用域（own 层）**再注册一个名为 `workflow` 的工具，其 `execute` 与 `run_workflow` 是
**同一 `executeWorkflow`**、参数表与 `output.schema` 由**同一工厂**产出 ⇒ 在宿主 own 覆盖 inherited 的解析顺序下
（`dsh-tools/lib/index.js:3055-3074`），模型调 `workflow` **直接真执行**本插件实现（后台 job / 进度事件 / 运行记录 /
结果截断 / systemPrompt 指引一应俱全），不再有「先撞一次拒绝」的往返。

| 通道 | 形态 | 能按次改什么 | 谁用 |
|---|---|---|---|
| `dispatch_subagent` | Host 工具 | `preset` / `reasoning_effort` / `provider`+`model` / `cwd` / `schema` | 主 agent 直接派子任务 |
| `workflow` / `run_workflow` | Host 工具（**两个名字、同一实现**：同一 `executeWorkflow` + 同一工厂） | 无（整轮一套：`preset` / `reasoning_effort` / `provider`+`model` / `max_total_agents`；另加 `run_in_background`） | 主 agent 直接起一个 workflow run；两个名字随便用 |
| `dispatch` | **external** subagent provider | 无（整轮一套配置：`preset` / `reasoningEffort` / `routeProvider`+`model`） | `workflow` 的 `subagentProvider: 'dispatch'` |
| 库存 `workflow` 工具 | **被同名接管**（own 层同名定义压住 inherited，真重定向；`shadowStockWorkflow: false` 可关） | —— | 模型照旧调 `workflow`，实际执行的是本插件那份定义 |

**两个名字，一份实现（0.5.0）**：`workflow` 与 `run_workflow` **两个名字同一实现**。机制是**同名接管**：
`apply()` 监听 `agent/created`（并补扫存量 agent、`tools/change` 重扫），对每个 `ctx.tools.get('workflow', agent)`
**已经可见**的 agent，在该 agent 的 own 层注册由同一个 `buildWorkflowDefinition` 工厂产出的定义 ⇒ 库存 `workflow`
在 own 覆盖 inherited 的解析顺序下**被同名压住**，模型调 `workflow` 就是**真重定向**到 `executeWorkflow`（不是隐藏，
也不是 v0.4.0 那种执行期拒绝）。三条边界写死：① **本来没有 `workflow` 的 agent 一律跳过**（接管是重定向，不是能力扩张；
被 `restrict({ deny: ['workflow'] })` 挡掉的 agent 同样返回 `undefined` ⇒ 跳过）；② 接管失败（own 层已有**别人**的同名
工具）或宿主缺缝时**回退**到该 agent 上的 `ctx.tools.guard`；③ `shadowStockWorkflow: false` 是**总开关**——既不接管也不
注册 guard（回到两套并存的旧形态）。接管名走 `Config.takeoverToolName`（默认 `'workflow'`）。逐条「已对齐 / 已实测 /
未对齐 / 未验证」见下文 [「workflow 的两个名字（0.5.0 · 同名接管）」](#workflow-的两个名字050--同名接管)。

**先看结论**：宿主 `workflow` 的 `agent()` **没有** `preset` 与 `effort` 入口（`effort` 被显式列为 deferred，见
[`docs/engine-evidence.md`](docs/engine-evidence.md)），所以那一侧只能**按轮（per-run）**配置；本包的三条通道**不会**
把按轮能力说成按次。**per-call 在 workflow 侧仍然不可**；**per-run 现在两条路**：`workflow` 自己配
`subagentProvider: 'dispatch'`，或者让模型直接调 `run_workflow`（本包为这一次调用注册一个专用 provider）——
而 `workflow` 这个名字经同名接管后走的也是**同一份实现**，两条路对模型没有语义差别。
完整五行能力矩阵见 [`docs/capability-matrix.md`](docs/capability-matrix.md)。

## 要求

- **peer 支持范围**：`>=0.2.1-rc.2 <0.3.0 || >=0.2.2-rc.1 <0.3.0`（`ctx.subagents.startActivation` 与
  `ctx.workflowEngine.start` 是硬依赖；缺失时工具在调用期报可读错）。
  **`run_workflow` 优先用 `agentPresets.serviceFor(agent, 'workflowEngine')` 解析 `workflowEngine`（agent 的 isolated
  preset group），之后才回落 `agent.ctx` → 插件全局 ctx**——引擎节点装在 preset 的 plugins 列表里，Cordis 的 `get()` 只
  向上找，插件 ctx 与 `agent.ctx` 都看不到这个独立挂载；`serviceFor` 是宿主 `@deepseek-ai/dsh-agent-preset-registry`
  提供的唯一读法（`@deepseek-ai/dsh-agent-preset-registry/lib/index.js` 第 725 行，文档注释原文 "Read a service supplied inside an Agent's isolated preset group"）。
  两个析取项不是冗余：npm semver 只对「同 `[major,minor,patch]` 元组上有 prerelease 比较符」的 prerelease 版本放行，
  `>=0.2.1-rc.2 <0.3.0` 里的 prerelease 比较符在 `0.2.1` 元组上，**不覆盖** `0.2.2-rc.1`，所以要补 `>=0.2.2-rc.1 <0.3.0`。
  **宿主口径不同**：宿主 `evaluatePluginCompatibility` 用 `semver.satisfies(..., { includePrerelease: true })`
  （`dsh-app-boot/lib/index.js` 约 276–278 行），因此**在宿主侧 `>=0.2.1-rc.2 <0.3.0` 单项就够**；第二个析取项
  `>=0.2.2-rc.1 <0.3.0` 是为 npm/pnpm 默认 prerelease 规则准备的（`pnpm install` 解析 `peerDependencies` 时不带该选项）。
  实测与原理见 [`docs/engine-evidence.md`](docs/engine-evidence.md) §9.5。
- 要挂的 preset 必须已在 roster 里（未知 id 在子 agent 创建期失败）。
- Node.js 22+（`node --check` / `scripts/check.mjs`）。
- 子 agent 的 `reasoning_effort` 需要目标模型声明了 reasoning 档位；未声明的模型会被**派发前**拒掉。

## 安装

在 DSH profile 目录（桌面版 `%USERPROFILE%\.dsh\profiles\desktop`）：

1. 加依赖：

   ```json
   "dependencies": { "dsh-subagent-dispatch": "file:C:/path/to/dsh-subagent-dispatch" }
   ```

2. 把包挂进 bundle 列表（`cordis.patch.yml` 会自动 `insert` 本插件那一行）：

   ```json
   "dsh": { "profile": { "bundles": [ "...", "dsh-subagent-dispatch" ] } }
   ```

3. `pnpm install`，重启宿主。`file:` 依赖是**拷贝**到 profile 的 `node_modules`，改完源码要重新 `pnpm install`。

## Breaking change / 迁移（0.5.0）

**0.5.0 不再是「拒绝」，是「接管」。** 装上 0.5.0 之后，模型**照旧可以调 `workflow`**——它解析到的是本插件的定义
（同一 `executeWorkflow` + 同一工厂产出），与 `run_workflow` **两个名字同一实现**。所以：

1. **本来就不用改任何脚本或 runbook**：`workflow({ script, meta, args })` 原样能用；`run_workflow` 同样能用，参数
   `script` / `meta` / `args` 与库存 `workflow` **逐字相同**。0.4.0 期间为了绕开当时那套拒绝（v0.4.0 的旧做法）而把
   `workflow` 改成
   `run_workflow` 的文档/脚本，**可以保持现状**（两个名字等价），也可以改回去。
2. **默认开启**：`shadowStockWorkflow` 默认 `true`，`apply()` 对每个**本来就能看见** `workflow` 的 agent 做同名接管
   （接管名走 `takeoverToolName`，默认 `'workflow'`）。库存工具的定义在 own 覆盖 inherited 的解析顺序下被同名压住
   （`dsh-tools/lib/index.js:3055-3074`）。
3. **接管是重定向，不是隐藏、也不是能力扩张**：本来没有 `workflow` 的 agent（或该名字被 `restrict` deny 的 agent）
   **不会被塞进来**；`run_workflow` 这个全局名始终存在。
4. **失败才回退 guard**：某个 agent 的 own 层已经放着**别人**的同名工具时，接管注册会撞 duplicate ⇒ 只在那一个
   agent 上注册 `ctx.tools.guard` 兜底（拒 `workflow` 并指向 `run_workflow`），其它 agent 不受影响；全局 guard 默认
   **一条都不注册**（`shadowedToolNames` 在接管激活时会把接管名剔出拒名单，默认过滤后为空）。
5. **要恢复到 0.4.0 之前的形态**：配置 `shadowStockWorkflow: false` —— 既不接管、也不注册 guard，库存 `workflow`
   与 `run_workflow` 同时可用（两套入口并存，见配置表）。
6. **v0.4.0 的旧做法（已废弃，仅作历史记录）**：0.4.0 的「遮盖」是 `ctx.tools.guard` 的**执行期拒绝**——模型多一次
   往返才能改道 `run_workflow`。0.5.0 用同名接管替换它，拒绝串只保留在「别人的同名」这条兜底路径上。

## 工具 `dispatch_subagent`（per-call）

参数走宿主 **value-schema DSL**（`defineTool` → `parameterSchemaSpecToJsonSchema`）。必填性用**属性级** `required: true`；
`items` 内不允许数组式 `required`（DSL 侧 `allowRequired: false`）。

| 参数 | 类型 | 必填 | 落到哪 | 说明 |
|---|---|---|---|---|
| `prompt` | string | ✅ | `request.prompt[0].text` | 自包含任务书；子 agent 不继承本会话，写全路径 / 判据 / 自验方式。 |
| `description` | string | ✅ | `spec.label` | 3–5 词标签，出现在 agent 列表。 |
| `preset` | string | — | `request.agentPreset` | 子 agent 挂载的 preset id。**省略 ⇒ 请求对象上不出现该键**（不是 `undefined` 值），即继承本会话 preset。 |
| `reasoning_effort` | string | — | `request.agentOptions.reasoningEffort` | 派发前用 `ctx.llm.resolveModelInfo` 对照模型档位校验；不支持 ⇒ 报错并列出支持的档位，**不截断、不改写、不派发**。 |
| `provider` | string | — | `request.agentOptions.provider` | **子 agent 的 LLM route provider，不是 subagent backend provider**。必须与 `model` 成对。 |
| `model` | string | — | `request.agentOptions.model` | 由 `provider` 解释的模型 id。必须与 `provider` 成对。 |
| `cwd` | string | — | `request.cwd` | 绝对路径；相对路径 / 不存在目录由宿主 `assertUsableCwd` 在派发前拒。 |
| `schema` | json | — | `request.outputSchema` | 对象根 JSON Schema（子 agent 结构化输出子集）；先过宿主 `assertObjectJsonSchema`。 |

要点：

- **backend 固定**：工具永远走本包注册的**本地** provider `dispatch-local`（有 `prepareContinuable`，宿主走 `startLocal`）。
  `provider` / `model` 参数只影响**子 agent 的 LLM route**，不会把 backend 换成 external 通道——
  所以工具路径在结构上碰不到 `DUPLICATE_CHILD`。
- route 解析顺序：按次 `provider`+`model` → 父会话路由（`parentAgentOptionsForDelegation`）。解析不出就给可读错，
  **绝不**把 `undefined` 喂给 `resolveModelInfo`。
- 深度预算：`maxDepth = delegationDepthOf(parent) + 1`（只借一级）。
- 收口：先 `Promise.allSettled([run.result])`，再 `dispose()`；失败时把子 agent 已产出的文本带上。

返回（也是 DSL 编译的 output schema）：`provider` / `childId` / `stopReason` / `text` / `preset?` / `reasoningEffort?` /
`model?` / `structured?`。

## 工具 `run_workflow` / `workflow`（per-run，模型可直接调用；两个名字同一实现）

存在的理由：`workflow` 的 `agent()` 收不了 `preset` / `effort`（白名单只有 `label` / `phase` / `schema` /
`provider` / `model`，`effort` 命中 `DEFERRED_AGENT_OPTIONS` 即抛 `UNSUPPORTED_OPTION`）。绕过它只有一条合法路：
把配置塞进 run 级 `subagentProvider`。本工具替调用方做这件事——**为这一次调用**注册一个名字唯一的 external provider，
把它的名字交给 `ctx.workflowEngine.start({ …, subagentProvider })`，跑完在 `finally` 里释放。
引擎对象的解析顺序是「`ctx.get('agentPresets')`（取不到再试 `ctx.agentPresets`）→ `.serviceFor(agent, 'workflowEngine')`
→ 调用方 agent 的 ctx（`agent.ctx.workflowEngine` → `agent.ctx.get('workflowEngine')`）→ 本插件全局 ctx
（`ctx.workflowEngine` → `ctx.get('workflowEngine')`）」，即 **`workflowEngine` 先经 preset registry 从 agent 的
isolated preset group 取，取不到才回落 agent.ctx / 插件 ctx**；每层都要求候选对象的 `start` 是可调用函数，
`serviceFor` 缺失或抛错都静默回落，继续往下找。`serviceFor` 的出处：
`@deepseek-ai/dsh-agent-preset-registry/lib/index.js`（第 725 行；实现 `serviceForMount` 在 `:136`）。

| 参数 | 类型 | 必填 | 落到哪 | 说明 |
|---|---|---|---|---|
| `script` | string | ✅ | `request.script` | workflow 脚本体（引擎自己的 `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` / `args` 语义不变）。 |
| `meta` | object | ✅ | `request.meta` | 至少含 `name`；非对象在起 workflow 前就被拒。 |
| `args` | json | — | `request.args` | 脚本里通过全局 `args` 读。 |
| `preset` | string | — | 临时 provider 的 preset | **整轮**生效：脚本里每一次 `agent()` 拉起的子 run 都挂这个 preset。 |
| `reasoning_effort` | string | — | 临时 provider 的 `agentOptions.reasoningEffort` | **整轮**生效；起 workflow **之前**用 `ctx.llm.resolveModelInfo` 校验档位，不支持就报错并列出支持档位。 |
| `provider` | string | — | 临时 provider 的 `agentOptions.provider` | **子 agent 的 LLM route**，不是 subagent backend。必须与 `model` 成对。 |
| `model` | string | — | 临时 provider 的 `agentOptions.model` | 由 `provider` 解释的模型 id。必须与 `provider` 成对。 |
| `max_total_agents` | number | — | `request.maxTotalAgents` | 本次 run 的子 agent 总数上限；只能**降到**引擎 ceiling 以下，超了引擎在 `start()` 报错。 |
| `run_in_background` | boolean | — | 分支开关（不落 `request`） | `true` 走后台：立刻返回 `{kind:'background', jobId, runId}`，返回值随 job 完成通知到达；默认 `false`（前台等结果）。 |

要点：

- **带参才注册**：只有给了 `preset` / `reasoning_effort` / `provider`+`model` 时才注册临时 provider
  （名字 `dispatch-wf:<uuid>`，每次唯一），并把名字作为 `subagentProvider` 传下去；**都不给**时既不注册、
  `subagentProvider` 也是 `undefined`（走引擎自己的配置）。
- **恰好一次释放**：disposer 在 `finally` 里调用，成功 / 失败 / 抛错都只调一次。
- **起 workflow 之前先校验**：`workflowEngine` 缺失（preset registry 的 `serviceFor`、agent 作用域、插件作用域都给不出可用的 `start`）、`script` 为空、`meta` 非对象、`reasoning_effort` 不被模型支持，
  这四种都在 `start()` **之前**报可读错——不会出现「provider 已注册、引擎才抛错」的残留。
- **结果口径**：等 `run.result`，然后 `run.dispose()`；结果里出现 `null` 来自引擎（子 run 失败或 `structured` 缺失，
  引擎返 `null` 而不抛错），不是本工具吞错。
- **不改变能力边界**：脚本里写 `agent({ effort })` 仍然被引擎拒。本工具给的是 **per-run**，不是 per-call。
- **返回形状两支**：前台 `{kind:'foreground', runId, agentsStarted, result}`；后台 `{kind:'background', jobId, runId}`
  （输出 schema 是 `oneOf`，同库存 `:339-379`）。
- **后台的临时 provider 在 job 结算里释放**，不在工具 `finally` 里：后台 run 还没开始就释放会让子 agent 找不到 provider。
  起 run 抛错时立刻释放，不留残留（与前台「恰好一次」同一纪律）。

## workflow 的两个名字（0.5.0 · 同名接管）

**表述统一**：`workflow` 与 `run_workflow` 是 **workflow 的两个名字、同一实现**——同一 `executeWorkflow`（唯一实现）
+ 同一 `buildWorkflowDefinition` 工厂产出的 `description` / `parameters` / `output{schema,render}`。机制是**同名接管**：
`apply()` 为每个**已经能看见** `workflow` 的 agent，在该 agent 的 own 层注册同名定义 ⇒ own 覆盖 inherited
（`dsh-tools/lib/index.js:3055-3074`）⇒ 库存 `workflow` 被同名压住，模型调 `workflow` 就是**真重定向**。
总开关 `Config.shadowStockWorkflow`（默认 `true`）；接管名 `Config.takeoverToolName`（默认 `'workflow'`）。
五项对外可观察能力（后台 job / 进度事件 / 运行记录 / 结果截断 / systemPrompt 指引）由本插件等价实现。

> 「同一实现」= **同一 `executeWorkflow` + 同一工厂产出**，**不是**「同一个函数对象」：宿主 `defineTool` 每次调用都新建
> 包装闭包（`dsh-tools/lib/index.js:838` 入口、`async execute` 包装在 `:866-870`）⇒ 两次 `defineTool` 产出的 `execute`
> 必然是不同函数对象。证据用「行为委托 + 同一 `sharedExecute` + 参数表/schema 深等」三件，不写 identity 断言。

### 已对齐（源码可证；行号 = 宿主安装根 `$H` 下的 `dsh-tool-workflow` / `dsh-tools` / `dsh-tool-cordis` 包文件，`sed -n '<行>p'` 可复现）

> **口径（写死）**：接管生效时，工具列表里那一条 `workflow` 解析到的是**本插件的定义**（own 层覆盖 inherited）——
> 既不是「库存定义被隐藏」，也不是「库存定义被拒」，而是**同名替换**；要「库存定义 + 本插件定义并存」只能
> `shadowStockWorkflow: false`（此时 `workflow` 回到库存实现，按轮配置要显式调 `run_workflow`）。

| 能力 | 库存依据 | 本插件行为 |
|---|---|---|
| 后台 job | `:217-258`；`jobs.start` `:224`；`kind` `:225`；`label` `:226`；`owner: parent.id` `:227`；`toolCall` `:228` | `run_in_background: true` → `ctx.get('jobs').start({ kind:'workflow', label: meta.name, owner: parent.id, toolCall })`，返回 `{kind:'background', jobId, runId}`；`jobs` 缺失抛同风格可读错（`:219-220`） |
| 取消链 | `:239-241` `cancel → run.cancel`；`dsh-tool-jobs/lib/index.js:406`；`dsh-jobs-local/lib/index.js:644-655` | `job_kill` → `jobs.kill` → `hooks.cancel` → `run.cancel('background workflow job killed')`；job 结算后 `run.dispose()` 恰好一次 |
| 结算语义 | `:242-254` `done`；`:178-196` `jobOutcomeOf` | completed → `{status:'completed', detail:'N agent(s)', result:<截断文本>}`；cancelled → killed；error → `{status:'failed', detail}` |
| 进度事件 | mirror `:19-45`：`workflow/phase` `:21`、`workflow/log` `:27`、`workflow/agent-start` `:30`、`workflow/agent-end` `:33` | 订阅**同名同形状**四事件（引擎在共享总线发，本插件不自造）：phase 更新 job progress 行 + `append(…,{channel:'log'})`，其余只 append |
| 运行记录 | recorder `:83-130`；记录类型 `:98` / `:109` / `:117` / `:124` | `tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end` 写 session；append 抛错只 warn 并停用该 run |
| 结果截断 | `:68` `maxResultChars` 默认 `5e4`；`renderResult` `:198-202` | 配置项 `maxResultChars` 默认 **50000**；前台 render 与后台 job 结果走同一函数，超长后缀 `… [truncated: N more characters]` 逐字同库存 |
| systemPrompt 指引 | `:262-269`；`:267` `getSectionOrder('TOOL_WORKFLOW')`；`dsh-system-prompt/lib/index.js:31` = 2600 | 注册一条 section（order = `TOOL_WORKFLOW`，name `tool:run_workflow`），正文写明 `workflow` 与 `run_workflow` 是同一实现的两个名字 |
| **同名接管（真重定向）** | `dsh-tools/lib/index.js:3055-3074`（`view`：inherited 先合并、**own 最后覆盖**）；`:3091-3092`（`get(name, scope)` = `view(scope).visible.get(name)`）；`:3040-3041`（restriction 只过滤 inherited，**不过滤 own 层**）；`agent/created` 契约 `dsh-tool-cordis/lib/types/api-catalog.js:3956-3960`（`mode:'serial'`，listener 抛错即打掉创建） | `apply()` 在 `agent/created`（+ 存量 `agents.list()` 补扫 + `tools/change` 重扫）里 `await agent.ctx.inject(['tools'], …)`：`tools.get(takeoverToolName, agent) === undefined` ⇒ **跳过**；own 层已带本插件 marker ⇒ **采纳**（不重复注册、不转拒绝）；注册成功 ⇒ 模型调 `workflow` 落到 `executeWorkflow`。失败（own 层是**别人**的同名）⇒ 只在那一个 agent 上注册兜底 `tools.guard` |
| 兜底 guard（仅在接管不可用时） | `dsh-tools/lib/index.js:3017-3022` `guard(guard)`；`:3024-3032` `guardReason(exec)`（全局层先判，再 `chainLayers(exec.agent)`） | 只为「别人的同名」那一个 agent 注册 `ctx.tools.guard`（拒 `takeoverToolName`、放行其它名字）；`shadowedToolNames` 里**其余**（非接管名的）库存名仍走全局 guard，默认过滤后为空 ⇒ 默认一条 guard 都不注册；`shadowStockWorkflow: false` 时既不接管也不注册 |
| 输出 schema | `:339-379` `oneOf` 两支；`:380-383` render；`:417-422` 前台 `kind:'foreground'` | 同形 `oneOf`（background / foreground）与同形 render 文案（后台点名 `job_output` / `job_kill`） |

### 未对齐（如实写，不许写成已对齐）

- **`restrict` 在接管之后施加时不生效（已知边界）**：own 层定义豁免 restriction（宿主注释 `:3040-3041`），若某个 agent
  在**我们已经接管之后**才被 `restrict({ deny: ['workflow'] })`，它仍看得见我们的 `workflow`。宿主自身也依赖这条豁免
  （子 agent 的结构化输出工具），本包不挑战；接管**之前**就 deny 的 agent 则天然 `get(...) === undefined` ⇒ 跳过。
- **不导出 `Config` schema**：库存导出 `Config`（`:66-70`），本插件保持 `apply(ctx, config = {})` 直读、每字段有缺省值。
- **recorder 依赖 `parent.session.append`**：宿主不提供可追加 session 时该 run 不记录（`recorder.start` 返回 `false`，
  不抛错）；append 抛错只 `warn` 一次并停用该 run。库存无条件读 `session.append` ⇒ 记录能力等价、形态不完全对齐。

### 已实测（真机证据，2026-11-06）

- **真机双通道（`workflow` 与 `run_workflow`）**：**已实测**——三个探针脚本在活宿主上各跑一次，取证不读工具回显，读的是解压
  `.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd` 后**子会话头**的 `agentPreset` 字段：
  - ① `workflow(script, meta)`（不传 `preset`）⇒ 完成，子会话头 `agentPreset: "cordis"`（继承调用方 preset）；
  - ② `workflow(script, meta, preset:"minimal", reasoning_effort:"low")` ⇒ 完成，子会话头 `agentPreset: "minimal"`
    （按轮 `preset` 确实落到了子 agent）；
  - ③ `run_workflow(...)` 同一脚本可用（更早一轮已验证，同样按子会话头取值）。
  - 对照：`takeover-demo` → 子会话 `c64608b7-…`（`cordis`）；`takeover-preset` → `f255b1b5-…`（`minimal`）；
    `shadow-demo`（`run_workflow`）→ `282820af-…`（`cordis`）。三次 run 的 `tool-workflow/run-end` 都是 `stopReason: completed`。
- **UI workflow 运行视图 / 工具卡片**：没有真机点验（no browser），只有假 ctx 探针断言订阅与写入。
- **真机 `job_kill` 端到端取消引擎 run**：未在宿主实跑，取消链是源码 + 假 registry 用例。
- **systemPrompt section 是否真的进到最终 prompt**：order 2600 已静态核对，落位未在真机验证。
- **插件热重载后的 stale 接管定义**：正常情况下插件级清理 effect 会在 unload 时释放全部接管（不产生 stale）；
  若清理没跑到（崩溃 / await 竞态），新实例按 `takeoverMarker` **采纳**旧定义并 warn。**旧闭包在新实例里是否仍可正常
  执行**，未验证（需真机 reload 场景）。
- 插件侧是否已落地本节各项能力，以 `lib/index.js` / `scripts/check.mjs` 的**当前版本**为准（本文档只把宿主源码行号当证据）。

## external provider `dispatch`（per-run）

存在的唯一理由：`workflow` 的 `agent()` 收不了 `preset` / `effort`，而 provider **整轮**拿到同一个子 agent 配置。
它只实现 `start(request)`（**不实现** `prepareContinuable`，否则宿主会把它改判成本地 provider，external 分支永不触发），
内部委派 `ctx.subagents.startActivation({ provider: delegateProviderName, … })`，把配置的 preset / effort / route 注入进去，
返回 `{ id, result, dispose }`，其中 `id` 是**合成 id** `dispatch:<uuid>`（不是内层子会话 id——内层 id 归宿主所有，
直接拿内层 `childId` 当 `run.id` 会撞 `DUPLICATE_CHILD`）。

配置示例（bundle 行 `config`，全字段可选）：

```yaml
- insert:
    - id: dsh-subagent-dispatch
      name: 'dsh-subagent-dispatch'
      config:
        providerName: dispatch            # external provider 名（workflow subagentProvider 用它）
        localProviderName: dispatch-local # 工具 backend 的本地 provider 名
        delegateProviderName: spawn       # 默认 'spawn'（库存本地 provider，capabilities 全 true）
        preset: ptc                       # 整轮生效：挂到每个 dispatch 子 agent
        reasoningEffort: max              # 整轮生效：workflow 侧唯一能拿到 effort 的入口
        routeProvider: deepseek           # 整轮生效的 LLM route（按次给的值优先）
        model: deepseek-flash
        # —— 0.5.0 新增（同名接管相关）——
        maxResultChars: 50000             # 结果展示文本上限，默认同库存 5e4
        shadowStockWorkflow: true         # 总开关，默认开：按 agent 同名接管 workflow；false ⇒ 既不接管也不 guard
        takeoverToolName: workflow        # 接管的工具名，默认 'workflow'（非法名 ⇒ warn + 不接管，不抛）
        shadowedToolNames: ['workflow']   # 仍未接管的库存名（接管名会被自动剔出；默认过滤后为空 ⇒ 无全局 guard）
```

接管与 guard 相关的配置项（全部可选，缺省即下表；本包**不导出** `Config` schema）：

| 键 | 默认 | 作用 |
|---|---|---|
| `maxResultChars` | `50000` | 结果**展示文本**上限（前台 render 与后台 job 结果共用；同库存 `:68`）。输出值本身不改写。 |
| `shadowStockWorkflow` | `true` | **总开关**。`true` ⇒ 对每个本来就能看见 `takeoverToolName` 的 agent 做**同名接管**（真重定向）；`false` ⇒ **既不接管也不注册任何 guard**（两套入口并存：库存 `workflow` + `run_workflow`）。 |
| `takeoverToolName` | `'workflow'` | 要接管的工具名。它必须是非空字符串，且不等于本插件自己的两个工具名（`run_workflow` / `dispatch_subagent`）、不等于宿主保留名 `run_code`；不满足时 **warn + 不接管、不抛错**（工具仍可正常调）。 |
| `shadowedToolNames` | `['workflow']` | **接管之外的**库存工具名（走全局 `ctx.tools.guard` 兜底拒绝）。`workflowToolName` 自动排除；接管激活时 `takeoverToolName` 也被剔出（否则全局 guard 会先拒掉我们自己注册的定义）⇒ 默认过滤后为**空**，一条全局 guard 都不注册。 |
| `workflowToolName` | `'run_workflow'` | 本插件 workflow 工具的对外名；改它则 systemPrompt section 名一起跟着改。 |
| `enableRunInBackground` | `true` | `false` 时 `run_in_background` 参数仍发布，但传 `true` 会报可读错（同库存 `:389` 口径）。 |

消费方：

- `workflow` 里 `agent(..., { subagentProvider: 'dispatch' })`（或 workflow 配置 `provider: 'dispatch'`）；
- 直接 `ctx.subagents.startActivation({ provider: 'dispatch', … })`。

`apply()` 会 **fail-fast** 拒绝三种自递归命名：`providerName === localProviderName`、
`delegateProviderName === providerName`、`delegateProviderName === localProviderName`。

调用方自己传的 `request.agentOptions.{provider,model}` **优先于**配置值；`request.agentPreset` 优先于 `config.preset`。

## 能力矩阵摘要

| 通道 | preset | reasoning_effort | provider+model | schema | cwd |
|---|---|---|---|---|---|
| `dispatch_subagent`（per-call） | 能 | 能（派发前校验） | 能 | 能 | 能 |
| 库存 `subagent` 工具（per-call） | 有条件（工具行配了 `agentPreset` / `allowedAgentPresets`） | 有条件（`modelSelectionSettings` + 设置里 `enabled` + 非空 `allowedModels`） | 有条件（同上） | 能 | 能 |
| `workflow` / `run_workflow`（per-run，模型可直接调用；两个名字同一实现） | 能（**按轮**，临时 provider 注入） | 能（**按轮**，临时 provider 注入；派发前校验档位） | 能（按轮，专为本次调用注册的 provider） | 能（由脚本里 `agent({schema})` 给） | 不能（由 workflow 的 cwd 决定） |
| `workflow` `agent()` + `subagentProvider: 'dispatch'`（per-run） | 能（**按轮**，provider 注入） | 能（**按轮**，provider 注入） | 能（按轮配置，按次 `agent()` 的 `provider`/`model` 优先） | 能（`agent()` 的 `schema`） | 不能（由 workflow 的 cwd 决定） |
| 库存 subagent provider 配置（per-run） | 能**有条件**（`capabilities.agentPreset` 且 `inheritsParentContext: false`） | 能**有条件**（provider 自己把 effort 放进 `agentOptions`） | 能（provider 自定） | 能**有条件**（`outputSchema` capability） | 能（provider 自定） |

逐格写着「能 / 不能 / 有条件」以及每格的**依据文件:行**见 [`docs/capability-matrix.md`](docs/capability-matrix.md)。
**per-run ≠ per-call**：上表后三行是**按轮**配置，任何一格都不构成「每次调用可改」。workflow 侧**没有** per-call
preset / effort 入口；`run_workflow` 与 `subagentProvider: 'dispatch'` 是同一件事的两个入口（谁发起不同）。
**两个名字同一实现**：上表描述的是**注入机制**；模型侧能调的名字是 `workflow` 与 `run_workflow` 两个——接管生效时
它们解析到**同一份定义**（同一 `executeWorkflow` + 同一工厂），所以对调用方没有语义差别。`shadowStockWorkflow: false`
时接管关闭，两个名字是两套入口（库存实现 + 本插件实现）。

## 限制与诚实边界

- `workflow` `agent()` 的选项白名单只有 `SUPPORTED_AGENT_OPTIONS = label / phase / schema / provider / model`；
  `DEFERRED_AGENT_OPTIONS = effort / isolation / agentType`，命中即抛 `UNSUPPORTED_OPTION`。
  ⇒ **workflow 侧 `reasoning_effort` 只能 per-run 生效，不是 per-call**。源码原文与行号见
  [`docs/engine-evidence.md`](docs/engine-evidence.md)。
- **`dispatch` provider（external 通道）宿主真机仍未跑通，待人 smoke**。`scripts/check.mjs` 的探针只证明**请求形状**
  （委派到 `delegateProviderName`、注入的 preset/effort/model、合成 `dispatch:<uuid>`、`dispose` 转发一次）——
  `dispatch` provider 自己的 external 子 agent 收尾等价性、`resident`/ownership 事件身份仍**未验证**。
  （`workflow` 工具自带的 per-run 临时 provider 路径已实测，见上一节「已实测」①②。）
- **`run_workflow` 已在真机跑通**（更早一轮 `shadow-demo`：完成、真子会话、同一实现），但 `scripts/check.mjs` 仍只覆盖
  「引擎收到的 `subagentProvider` 是那个临时名字、注入参数正确、不带参时不注册也不传、disposer 恰好一次、
  四条错误路径在 `start()` 之前报错」这些形状断言；**重复 / 并发 / 失败重试**没有逐项 smoke，本文件不宣称那几项已验证。
- **peer 范围只在静态层面确认**：0.2.2-rc.1 是**源码比对**结论（见 `docs/engine-evidence.md` §9），本机装的是
  0.2.1-rc.2，没有在 0.2.2-rc.1 上实跑过。
- 库存 `subagent` 工具本身已能按次给 `provider` / `model` / `reasoning_effort`（受 profile 设置白名单门控）
  并条件性给 `agent_preset`；本包不宣称这些能力本身是独家能力。差异只在于：**默认设置下**本工具的 `preset` +
  `reasoning_effort` 即同时可用（库存工具需先在其工具行与 profile 设置里打开门控才能同时给），另外多一条 per-run
  注入的 external provider。
- `isConcurrencySafe: () => false`：同一 workspace 上并发派发不安全，串行调用。
- **peer 未声明 `@deepseek-ai/dsh-system-prompt`（已知小瑕疵，0.4.0 起保留）**：`inject` 含 `systemPrompt`
  （`lib/index.js` 的 `export const inject = ['subagents', 'tools', 'llm', 'systemPrompt']`），但 `peerDependencies`
  里没有对应包；反向地 `dsh-agent` / `dsh-session` 声明了却没被 import。**为什么不补**：`scripts/check.mjs` 的
  `PEER_RANGE_PRE_RELEASE` 用例把 peer 数量硬编码为 5 条，补第 6 条会让自检 `result: FAILED`，而
  `scripts/check.mjs` 不在本次改动范围。**为什么不删**：删掉 `dsh-agent` / `dsh-session` 可能改变安装期解析，
  收益低风险高。运行时已按可选处理：`systemPrompt` 缺失时跳过 section 注册（`typeof systemPrompt.section === 'function'`
  判空），不会因此派发失败；代价是那种宿主上看不到「workflow 与 `run_workflow` 同一实现」的指引。
- **本包不导出 `Config` schema**（`cordis.patch.yml` 里已明说 `The plugin does NOT export a Config schema`）；配置项由
  `apply(ctx, config = {})` 直接读、每个字段都有缺省值（见上方配置表）。**这一条是「未对齐」**：库存 `workflow`
  导出 `Config`（`dsh-tool-workflow/lib/index.js:66-70`），能力等价、形态不等价。
- **「同名接管」的其余三项真机项未验证**（假 ctx 探针测不到，见上一节「未验证」栏）：① UI 的工具卡片 / workflow 运行视图
  是否真能看到 `workflow/phase` / `workflow/log` / `workflow/agent-start` / `workflow/agent-end` 进度；② 真机 `job_kill`
  是否真把引擎 run 取消；③ 插件热重载后遗留的 stale 接管定义是否仍能执行（本包会按 `takeoverMarker` 采纳并 warn，
  但不转拒绝）。**双通道已实测**（`workflow` 默认继承 + `preset`/`reasoning_effort` 落位 + `run_workflow`，见上一节）。
- **接管是重定向，不是隐藏、也不是能力扩张（口径写死）**：库存 `workflow` 的定义在 agent own 层被同名覆盖
  （`dsh-tools/lib/index.js:3055-3074`），所以「工具列表里还有 `workflow`」是**设计如此**——那一条已经是本插件的定义；
  而没有这个工具的 agent **不会**被塞进来。`ctx.tools.guard` 只剩**兜底**作用（别人的同名 / 未接管的库存名）。
- **recorder 依赖 `parent.session.append`**：宿主不提供可追加 session 时 `recorder.start` 返回 `false`、该 run 不记录
  （后续 `finish` / `abandon` 空转，不抛错）；append 抛错只 `warn` 一次并停用该 run。库存无条件读 `session.append` ⇒
  **记录能力等价、形态有差异**。

## PTC 档（dsh-ops）：自动引擎兜底

官方 `ptc` 预设（`@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`）把 `workflow-ptc` 与 `tool-workflow` 两行标成
`disabled: true`，而 `standard` / `cordis` 没有；dsh-ops 只增强工具面、不补引擎。所以 PTC 会话里的 `run_workflow`
曾经是“工具目录里有、一调就报 `no workflow engine`”的死条目。

`lib/index.js` 的 `resolveWorkflowEngine` 现在这样处理一次调用：

- 先走原有五级解析（`agentPresets.serviceFor` → `agent.ctx` → 插件 ctx）；命中就直接用，**不挂任何东西**。
- 都没命中、且宿主有 `ptcRuntime`（`language === 'typescript'`）时，首次调用按需
  `await import('@deepseek-ai/dsh-workflow-ptc')`，再 `ctx.plugin(Engine, { provider: 'spawn' })` 挂载官方引擎；
  成功后缓存，**失败不缓存**、下次可重试；缓存项每次用前按 `ctx.get('workflowEngine')` 身份复验，fiber 被回收就重挂。
- 没有 PTC runtime / import 失败 / 挂载抛错时，错误串固定说明：preset 未启用引擎 + 失败原因 +
  两条修法（在 preset 里启用 `workflow-ptc` + `tool-workflow`，或安装 `@deepseek-ai/dsh-workflow-ptc`）。
- `apply(ctx, { autoMountPtcEngine: false })` 关闭兜底，回到只读行为。

语义边界：兜底引擎是**进程级**的、活到插件卸载；`serviceFor` 先于兜底，所以自带引擎的预设（standard / cordis /
自定义带 `workflow-ptc` 的预设）行为不变。引擎的 `workflow/*` 事件走全局事件总线，UI 与 recorder 仍能收到。
`@deepseek-ai/dsh-workflow-ptc` 是**动态 import**，不进加载期依赖：没有该包的宿主照样加载本插件，只在调用期回退报错。

对应自检用例：`WF_PTC_ENGINE_MOUNT`、`WF_PTC_ENGINE_CACHED`、`WF_PTC_ENGINE_SKIPPED`、
`WF_PTC_ENGINE_NO_RUNTIME`、`WF_PTC_ENGINE_MOUNT_FAILS`。

## 自检

```bash
node --check plugins-src/dsh-subagent-dispatch/lib/index.js
node plugins-src/dsh-subagent-dispatch/scripts/check.mjs   # 全绿时末行 result: OK
```

`scripts/check.mjs` 不假宿主模块：它用 `node:module` resolve 钩子把裸包名映射到 DSH 安装目录，再导入**真**
`dsh-tools` / `dsh-subagent`（`defineTool`、`assertObjectJsonSchema`、`assertUsableCwd`、
`parentAgentOptionsForDelegation` 全是宿主实现），只假 `ctx` 的接缝（`subagents` / `tools` / `llm` / `effect` / `logger`、
0.4.0 的 `tools.guard` / `systemPrompt.section` / `ctx.on` / `ctx.get('jobs')` / `parent.session.append`，以及 0.5.0
接管新增的分层 `tools.get(name, scope)` / `agent.ctx.inject` / `agent/created` / `agent/disposed` / `tools/change`）。
首行 `HOST_MODULES PASS <真实路径>` 守住这一点。

0.4.0 的能力各有对应用例（名称可直接 `grep` 到）：`WF_OUTPUT_ONEOF`、`WF_BACKGROUND_JOB`、`WF_BACKGROUND_CANCEL`、
`WF_PROGRESS_MIRROR`、`WF_RECORDER_EVENTS`、`WF_TRUNCATE_RESULT`、`WF_SHADOW_GUARD`、`WF_SYSTEM_PROMPT_SECTION`。
0.5.0 的同名接管另有 7 例：`TAKEOVER_LISTENER`、`TAKEOVER_EXECUTE_DELEGATION`、`TAKEOVER_IDEMPOTENT`、
`TAKEOVER_FALLBACK_GUARD`、`TAKEOVER_DISABLED`、`TAKEOVER_SKIP_ABSENT`、`TAKEOVER_ADOPT_OWN`（用例总数 44 → **51**；
`WF_SHADOW_GUARD` 已按接管语义改写：默认 0 条全局 guard、`some-stock` 只拒该名、接管名永不被拒）。
**这些是假 ctx 用例**：它们证明的是调用形状与事件订阅，不证明真机行为（见上方「未验证」栏）。

## 文件

```text
package.json        manifest（dsh.bundle.patch、exports ./locale/*.json 与 ./icon、files）
cordis.patch.yml    bundle 层：insert dsh-subagent-dispatch 行
lib/index.js        apply(ctx, config) —— provider×2 + dispatch_subagent + run_workflow/workflow（两个名字同一
                    executeWorkflow；含同名接管 / 兜底 guard / 后台 job / 进度镜像 / 运行记录 / 结果截断 /
                    systemPrompt section）
docs/capability-matrix.md   五行 × 六列能力矩阵 + 「workflow 的两个名字（0.5.0 · 同名接管）」已对齐 / 已实测 / 未对齐 / 未验证分栏
docs/engine-evidence.md     引擎层源码证据（路径:行号 + 原文）；§9 是 0.2.2 适配比对，§10 是库存工具可观察行为对账，
                            §10.5 是 0.5.0 同名接管的宿主依据（own 覆盖 inherited / `get(name, scope)` / 预检）
locale/{en,zh}.json Plugin Manager / Settings 显示元数据
icon.svg            包图标
scripts/check.mjs   假 ctx 探针（对真宿主模块）
LICENSE             MIT
```

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
