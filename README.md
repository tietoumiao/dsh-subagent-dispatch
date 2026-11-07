# dsh-subagent-dispatch

给 DSH 补上**两条互补的委派通道**：一条**按次（per-call）**可调（`dispatch_subagent`），一条**按轮（per-run）**可配
（工具 `workflow`——库存名，默认唯一披露——与 external provider `dispatch`）。
**0.6.0 起模型侧的 workflow 能力是「单条披露」**：默认每个 agent 的工具视图里 `workflow` 能力**恰好一条**，名字为库存名
`workflow`。本插件为每个**本来就能看见** `workflow` 的 agent，在**该 agent 自己的作用域（own 层）**注册同名定义，其
`execute` 与 `description` / `parameters` 由**同一 `buildWorkflowDefinition` 工厂**产出 ⇒ own 覆盖 inherited
（`dsh-tools/lib/index.js:3055-3074`）⇒ 模型看到并调用的 `workflow` 就是本插件实现（后台 job / 进度事件 / 运行记录 /
结果截断 / systemPrompt 指引一应俱全）。`run_workflow` 降级为**兼容别名**：**默认不注册**（因此模型侧看不见，也不会
多出一条同名描述），实现与定义都保留，`exposeRunWorkflow: true` 恢复单独披露；`shadowStockWorkflow: false` 是兼容模式，
回到「库存 workflow + 本插件 run_workflow」两套入口并存。

| 通道 | 形态 | 能按次改什么 | 谁用 |
|---|---|---|---|
| `dispatch_subagent` | Host 工具 | `preset` / `reasoning_effort` / `provider`+`model` / `cwd` / `schema` | 主 agent 直接派子任务 |
| `workflow` | Host 工具（库存名，**默认唯一披露的 workflow 能力**；own 层同名定义） | 无（整轮一套：`preset` / `reasoning_effort` / `provider`+`model` / `max_total_agents`；另加 `run_in_background`） | 主 agent 直接起一个 workflow run；模型只看见这一个名字 |
| `run_workflow` | Host 工具（**兼容别名**，默认隐藏；`exposeRunWorkflow: true` 恢复单独披露） | 同 `workflow`（同一实现、同一参数表） | 旧脚本 / runbook 继续可调；日常模型面不出现 |
| `dispatch` | **external** subagent provider | 无（整轮一套配置：`preset` / `reasoningEffort` / `routeProvider`+`model`） | `workflow` 的 `subagentProvider: 'dispatch'` |
| 库存 `workflow` 工具 | **被同名接管**（own 层同名定义压住 inherited，真重定向；`shadowStockWorkflow: false` 可关） | —— | 模型照旧调 `workflow`，实际执行的是本插件那份定义 |

**单条披露（0.6.0）**：`apply()` 监听 `agent/created`（并补扫存量 agent、`tools/change` 重扫），对每个
`ctx.tools.get('workflow', agent)` **已经可见**的 agent，在该 agent 的 own 层注册由同一个 `buildWorkflowDefinition`
工厂产出的定义 ⇒ 库存 `workflow` 在 own 覆盖 inherited 的解析顺序下**被同名压住**；插件作用域里的 `run_workflow`
**默认不注册**（宿主没有「注册但隐藏」的 API，「隐藏」= 不注册全局别名），因此模型面里 workflow 形状的名字集合就是
`['workflow']`。三条边界写死：① **本来没有 `workflow` 的 agent 一律跳过**（接管是重定向，不是能力扩张；
被 `restrict({ deny: ['workflow'] })` 挡掉的 agent 同样返回 `undefined` ⇒ 跳过、不补位）；② PTC 档的 `workflow` 补位
是唯一的有界例外（见 [「PTC 档」](#ptc-档dsh-ops的-workflow-补位与引擎兜底)）；③ 接管失败（own 层已有**别人**的同名
工具）或宿主缺缝时**回退**到该 agent 上的 `ctx.tools.guard`。接管名走 `Config.takeoverToolName`（默认 `'workflow'`）；
`exposeRunWorkflow` / `shadowStockWorkflow` 两个开关的语义见下文 [「披露形态与别名兼容（0.6.0）」](#披露形态与别名兼容060)。

**先看结论**：宿主 `workflow` 的 `agent()` **没有** `preset` 与 `effort` 入口（`effort` 被显式列为 deferred，见
[`docs/engine-evidence.md`](docs/engine-evidence.md)），所以那一侧只能**按轮（per-run）**配置；本包的三条通道**不会**
把按轮能力说成按次。**per-call 在 workflow 侧仍然不可**；**per-run 两条路**：`workflow` 自己配
`subagentProvider: 'dispatch'`，或者让模型直接调本插件注册的 `workflow`（为这一次调用注册一个专用 provider）。
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

## 披露形态与别名兼容（0.6.0）

**默认（单条披露）**：每个本来就能看见 `workflow` 的 agent，工具视图里 workflow 能力**有且仅有**一条，名字
`workflow`；`run_workflow` 别名**不注册**到插件作用域，因此模型侧看不见。`workflow` 与 `run_workflow` 仍是
**同一实现**（同一 `executeWorkflow` + 同一 `buildWorkflowDefinition` 工厂），只是默认只披露其中一个名字。

| 配置 | 生效行为 | 模型面名字集合 | 用途 |
|---|---|---|---|
| 默认（`exposeRunWorkflow` 省略，`shadowStockWorkflow: true`） | 同名接管；别名不注册 | `['workflow']` | 单条披露（推荐） |
| `exposeRunWorkflow: true` | 同名接管**照常**，同时把 `run_workflow` 注册回插件作用域 | `['workflow', 'run_workflow']` | 双披露，仅供仍要显式调别名的旧脚本；不是默认 |
| `shadowStockWorkflow: false` | 不接管、不注册任何 guard；`run_workflow` 恢复注册 | `['run_workflow', 'workflow'(库存)]` | 兼容模式：回到两套入口并存 |

**别名兼容口径**：`run_workflow` **没有被删除**——实现函数、定义工厂、参数表都保留（`script` / `meta` / `args` 库存字段
逐字一致，另加可选 per-run 字段），缺的只是**默认不注册**这一步：宿主没有「注册但隐藏」的 API，所以「不披露」在这里
就等于「不注册到任何作用域」，模型看不到、也调不到。要显式用它：`exposeRunWorkflow: true` 恢复注册（接管照常），
或 `shadowStockWorkflow: false`（那时没有接管去服务模型，别名本来就会注册）。两条恢复路径发布的都是**同一份**
`buildWorkflowDefinition` 产物，不存在第二份实现。

**要恢复到 0.4.0 之前的形态**：配置 `shadowStockWorkflow: false` —— 既不接管、也不注册 guard，库存 `workflow`
与 `run_workflow` 同时可用。**v0.4.0 的旧做法（已废弃）**是 `ctx.tools.guard` 的**执行期拒绝**；0.6.0 的拒绝串只保留在
「别人的同名」这条兜底路径上，且**永不拒绝本插件自己的工具**。逐条三档状态见
[「已实测 / 未验证 / 无法判定」](#已实测--未验证--无法判定三档2026-11-06)。

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

- **backend 固定为本地通道**：工具永远走本包注册的本地 provider（名字由 `localProviderName` 定，默认 `dispatch-local`；
  它有 `prepareContinuable`，宿主因此走 `startLocal`）。
  `provider` / `model` 参数只影响**子 agent 的 LLM route**，不会把 backend 换成 external 通道——
  所以工具路径在结构上碰不到 `DUPLICATE_CHILD`。
- route 解析顺序：按次 `provider`+`model` → 父会话路由（`parentAgentOptionsForDelegation`）。解析不出就给可读错，
  **绝不**把 `undefined` 喂给 `resolveModelInfo`。
- 深度预算：`maxDepth = delegationDepthOf(parent) + 1`（只借一级）。
- 收口：先 `Promise.allSettled([run.result])`，再 `dispose()`；失败时把子 agent 已产出的文本带上。

返回（也是 DSL 编译的 output schema）：`provider` / `childId` / `stopReason` / `text` / `preset?` / `reasoningEffort?` /
`model?` / `structured?`。

## 工具 `workflow`（per-run，模型默认唯一可调；库存名）

存在的理由：`workflow` 的 `agent()` 收不了 `preset` / `effort`（白名单只有 `label` / `phase` / `schema` /
`provider` / `model`，`effort` 命中 `DEFERRED_AGENT_OPTIONS` 即抛 `UNSUPPORTED_OPTION`）。绕过它只有一条合法路：
把配置塞进 run 级 `subagentProvider`。本工具替调用方做这件事——**为这一次调用**注册一个名字唯一的 external provider，
把它的名字交给 `ctx.workflowEngine.start({ …, subagentProvider })`，跑完在 `finally` 里释放。
引擎对象的解析顺序是「`ctx.get('agentPresets')`（取不到再试 `ctx.agentPresets`）→ `.serviceFor(agent, 'workflowEngine')`
→ 调用方 agent 的 ctx → 本插件全局 ctx」；每层都要求候选对象的 `start` 是可调用函数，`serviceFor` 缺失或抛错都静默回落。

### 原版同形（与库存 `@deepseek-ai/dsh-tool-workflow` 逐字/结构对齐）

库存模块**不导出** `DESCRIPTION`，所以对账不是手抄源码，而是**运行时捕获**：把库存 `apply()` 施加到最小 fake ctx
（`tools.register` / `systemPrompt.section` / `on` / `get` / `logger` / `effect`，并传 `Config({})` 避免
`toolName: undefined` 的垃圾基线），拿到库存注册的定义与 section，再与本插件的定义逐项比较。当前证据：

| 项 | 库存值 | 本插件值 | 断言 |
|---|---|---|---|
| `description` | 1667 字符（`DESCRIPTION` 模板串） | **逐字相同** | `tool.description === stock.definition.description` |
| 参数表 | 四字段 `script` / `meta` / `args` / `run_in_background` | 四字段**结构相同**（描述、嵌套、requiredness 逐项等） | `canonicalJson` 逐字段深等 |
| 根 `required` | `['script', 'meta']` | **相同** | 排序后相等 |
| `meta` | 对象，`additionalProperties: true`，`required: ['name','description']`，`properties.name/description/whenToUse/phases`；`phases.items` 内 `title` 必填 | **结构相同** | `canonicalJson(meta)` 深等 |
| 插件 per-run 字段 | —— | `preset` / `reasoning_effort` / `provider` / `model` / `max_total_agents`，**全部可选追加** | 新增集合恰好这五个，且无一个 `required: true` |

这就是**原版同形**：模型看到的 `workflow` description 与参数契约就是库存那份；插件只在其上追加可选 per-run 字段，
不改写、不挤掉库存字段。对账用例：`WF_STOCK_DEFINITION_PARITY`（PASS，见下方三档表）。

`run_workflow` 是**别名**：与 `workflow` 走同一 `buildWorkflowDefinition` 工厂、同一 `executeWorkflow`，参数表/description
完全一致；区别只在**披露**（默认隐藏，见上一节）。

| 参数 | 类型 | 必填 | 落到哪 | 说明 |
|---|---|---|---|---|
| `script` | string | ✅ | `request.script` | workflow 脚本体（引擎自己的 `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` / `args` 语义不变）。 |
| `meta` | object | ✅ | `request.meta` | **结构化**库存形状：`name` / `description` 必填，`whenToUse` / `phases` 可选；非对象在起 workflow 前就被拒。 |
| `args` | json | — | `request.args` | 脚本里通过全局 `args` 读。 |
| `preset` | string | — | 临时 provider 的 preset | **整轮**生效：脚本里每一次 `agent()` 拉起的子 run 都挂这个 preset。 |
| `reasoning_effort` | string | — | 临时 provider 的 `agentOptions.reasoningEffort` | **整轮**生效；起 workflow **之前**用 `ctx.llm.resolveModelInfo` 校验档位。 |
| `provider` | string | — | 临时 provider 的 `agentOptions.provider` | **子 agent 的 LLM route**。必须与 `model` 成对。 |
| `model` | string | — | 临时 provider 的 `agentOptions.model` | 由 `provider` 解释的模型 id。必须与 `provider` 成对。 |
| `max_total_agents` | number | — | `request.maxTotalAgents` | 本次 run 的子 agent 总数上限；只能**降到**引擎 ceiling 以下。 |
| `run_in_background` | boolean | — | 分支开关（不落 `request`） | `true` 走后台：立刻返回 `{kind:'background', jobId, runId}`；默认 `false`。 |

要点：

- **带参才注册**：只有给了 `preset` / `reasoning_effort` / `provider`+`model` 时才注册临时 provider
  （名字 `dispatch-wf:<uuid>`），都不给时既不注册、`subagentProvider` 也是 `undefined`。
- **恰好一次释放**：disposer 在 `finally` 里调用，成功 / 失败 / 抛错都只调一次；后台 run 在 job 结算里释放。
- **起 workflow 之前先校验**：引擎缺失、`script` 为空、`meta` 非对象、`reasoning_effort` 不被模型支持，四种都在
  `start()` **之前**报可读错。
- **不改变能力边界**：脚本里写 `agent({ effort })` 仍然被引擎拒。本工具给的是 **per-run**，不是 per-call。
- **返回形状两支**：前台 `{kind:'foreground', runId, agentsStarted, result}`；后台
  `{kind:'background', jobId, runId}`（输出 schema 是 `oneOf`，同库存 `:339-379`）。

## 同名接管与 systemPrompt（单条披露的实现）

**表述统一（0.6.0）**：模型面只披露 `workflow` 一条；它是**同名接管**后的本插件定义——同一 `executeWorkflow`（唯一实现）
+ 同一 `buildWorkflowDefinition` 工厂产出的 `description` / `parameters` / `output{schema,render}`。`run_workflow` 是默认
隐藏的**别名**。总开关 `Config.shadowStockWorkflow`（默认 `true`）；接管名 `Config.takeoverToolName`（默认 `'workflow'`）；
别名披露开关 `Config.exposeRunWorkflow`（默认 `false`）。

> 「同一实现」= **同一 `executeWorkflow` + 同一工厂产出**，**不是**「同一个函数对象」：宿主 `defineTool` 每次调用都新建
> 包装闭包（`dsh-tools/lib/index.js:838` 入口、`:866-870` 包装）⇒ 两次 `defineTool` 产出的 `execute` 必然是不同函数对象。
> 证据用「行为委托 + 同一 `sharedExecute` + 参数表/schema 深等」三件，不写 identity 断言。

**一条 systemPrompt 指引（不泄漏接管实现，且按作用域正确落位）**：为**每个真正拿到 workflow 能力的 agent**，在**该 agent
自己的作用域**注册**一条** section：`order = getSectionOrder('TOOL_WORKFLOW')`（= 2600），`name = tool:workflow`，正文是
**库存 section 文本逐字**（`Use the workflow tool ONLY when …`，见 [`docs/engine-evidence.md`](docs/engine-evidence.md) §10.1）。
正文**不含** `takeover` / `executeWorkflow` / `two names` / `run_workflow` 这几个实现词——它们只出现在源码注释和本 README 里。

为什么是 agent 作用域而不是全局：`dsh-system-prompt` 的 section 表是**按名合并作用域链**的（`dsh-scope`
`ScopedLayers.merge`：全局先、`chainLayers` 由远到近，**近的胜**），所以同名 section 在 agent 层会**shadow** 预设/全局那条，
而不是变成第二条；同层重名才会抛错。这样两种宿主形态都只有一条：① standard/cordis（库存在**预设作用域**注册了同名
section）⇒ 我们这条 shadow 它；② PTC（库存 `tool-workflow` 被预设禁用、没有任何 section）⇒ 我们这条就是唯一一条。
全局注册在 ① 里会与预设那条并存（`apply()` 早于任何 agent 存在，没法靠 agent 层去 shadow 全局自身），在「库存与本插件
同层」的形态里还会撞同名——两种都是错的，所以**接管激活时全局 0 条 section**（用例 `WF_SYSTEM_PROMPT_SECTION` 断言）。
`shadowStockWorkflow: false`（兼容模式、无接管）才回到全局注册一条 `tool:run_workflow` 指引。

### 已对齐（源码可证；行号取自 0.2.1-rc.2 快照，当前安装是 0.2.2-rc.1 ⇒ 按符号名复现，见 `docs/engine-evidence.md` §12）

| 能力 | 库存依据 | 本插件行为 |
|---|---|---|
| 后台 job | `:217-258`；`jobs.start` `:224`；`kind` `:225`；`label` `:226`；`owner: parent.id` `:227`；`toolCall` `:228` | `run_in_background: true` → `ctx.get('jobs').start({ kind:'workflow', label: meta.name, owner: parent.id, toolCall })`，返回 `{kind:'background', jobId, runId}` |
| 取消链 | `:239-241` `cancel → run.cancel`；`dsh-tool-jobs/lib/index.js:406`；`dsh-jobs-local/lib/index.js:644-655` | `job_kill` → `jobs.kill` → `hooks.cancel` → `run.cancel('background workflow job killed')`；job 结算后 `run.dispose()` 恰好一次 |
| 结算语义 | `:242-254` `done`；`:178-196` `jobOutcomeOf` | completed → `{status:'completed', detail:'N agent(s)', result:<截断文本>}`；cancelled → killed；error → failed |
| 进度事件 | mirror `:19-45`：`workflow/phase` `:21`、`workflow/log` `:27`、`workflow/agent-start` `:30`、`workflow/agent-end` `:33` | 订阅**同名同形状**四事件（引擎在共享总线发，本插件不自造）：phase 更新 job progress 行 + append，其余只 append |
| 运行记录 | recorder `:83-130`；记录类型 `:98` / `:109` / `:117` / `:124` | `tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end` 写 session；append 抛错只 warn 并停用该 run |
| 结果截断 | `:68` `maxResultChars` 默认 `5e4`；`renderResult` `:198-202` | 配置项 `maxResultChars` 默认 **50000**；前台 render 与后台 job 结果走同一函数，后缀 `… [truncated: N more characters]` 逐字同库存 |
| systemPrompt 指引 | `:262-269`；`:267` `getSectionOrder('TOOL_WORKFLOW')`；`dsh-system-prompt/lib/index.js:31` = 2600 | 注册**一条** section（order = `TOOL_WORKFLOW`，name `tool:workflow`），正文 = 库存 section 文本逐字；不含实现词 |
| **同名接管（真重定向）** | `dsh-tools/lib/index.js:3055-3074`（own 覆盖 inherited）；`:3091-3092`（`get(name, scope)`）；`:3040-3041`（restriction 只过滤 inherited）；`agent/created` 契约 `dsh-tool-cordis/lib/types/api-catalog.js:3956-3960` | `apply()` 在 `agent/created`（+ 存量补扫 + `tools/change` 重扫）里预检：`get(takeoverToolName, agent) === undefined` ⇒ **跳过**；own 层已带 marker ⇒ **采纳**；注册成功 ⇒ 模型调 `workflow` 落到 `executeWorkflow`。失败（别人的同名）⇒ 只在那一个 agent 上注册兜底 `tools.guard` |
| 兜底 guard | `dsh-tools/lib/index.js:3017-3022` `guard(guard)`；`:3024-3032` `guardReason(exec)` | **仅在别名已发布**（`exposeRunWorkflow: true` 或兼容模式）且「别人的同名」占着该 agent 的 own 层时注册一条、只拒该名并指向 `run_workflow`；**单条披露默认下 0 条 guard**（没有别名可指，拒绝等于删能力 ⇒ 外国定义原样保留，用例 `TAKEOVER_FOREIGN_KEPT`）；默认 `shadowedToolNames` 过滤后为空 ⇒ 无全局 guard |
| 输出 schema | `:339-379` `oneOf` 两支；`:380-383` render；`:417-422` 前台 `kind:'foreground'` | 同形 `oneOf`（background / foreground）与同形 render 文案 |

### PTC 档（dsh-ops）的 workflow 补位与引擎兜底

**PTC 补位**：PTC 会话的 `run_code` 是执行器的 transport，**不进 registry**，所以普通 `view().visible` 看不到它；本插件改问
`tools.selectExecutor(agent).describe().knownNames` 是否含 `run_code`，并同时用 `view.knownNames` 区分两种「看不见」：

| 情形 | 判定 | 行为 |
|---|---|---|
| PTC agent（有 `run_code`，workflow 名从未存在） | `knownNames` 不含 `workflow` 且 transport 含 `run_code` | 在该 agent own 层补**一条** `workflow`（同一工厂定义），使 `tools:sdk` 渲染出**恰好一条** workflow 绑定 |
| 普通 agent（无 `run_code`，也没有 workflow） | 两者都不满足 | **不补**——接管/补位不是能力扩张 |
| `restrict({ deny: ['workflow'] })` 的 agent | `knownNames` **含** `workflow` 但 `visible` 不含 | **跳过**，不把 deny 翻成 grant |

补位后的 `workflow` 是真实 `defineTool` 产物，`await tools.workflow(...)`（`run_code` 内）可执行；PTC 的 `tools:sdk` 由
执行器 `renderToolsSdk` 生成，`ToolArgsMap` 里 workflow 绑定数**恰好 1**，且不出现 `run_workflow` 别名。**注意**：PTC 预设
自身可能已挂库存 `workflow` 行（`preset-ptc` 的 `workflow-ptc` / `tool-workflow` 两行默认 `disabled: true`，若 profile 启用则
库存工具在），那种情况下模型面由「预设内库存 + 同名接管」提供，本插件**不重复补位**（`get` 已可见 ⇒ 走重定向路径）。

**引擎兜底**（与 0.5.0 相同）：标准 `ptc` 预设把 `workflow-ptc` / `tool-workflow` 两行标成 `disabled: true`，本插件的
`workflow` 在五级解析全部落空、且宿主有 TypeScript `ptcRuntime` 时，按需动态 import 官方
`@deepseek-ai/dsh-workflow-ptc` 并在插件 ctx 上 `ctx.plugin(Engine, { provider: 'spawn' })` 挂载一次：

- **触发口径**：只看**调用方 agent** 的五级解析结果；`serviceFor` 命中时绝不挂载。兜底引擎是进程级、活到插件卸载。
- **失败口径**：无 `ptcRuntime` / import 失败 / 挂载抛错 ⇒ 保持原“no workflow engine”错误并附原因与两条修法。
- **关闭开关**：`autoMountPtcEngine: false`。
- **证据**：`scripts/check.mjs` 的 `WF_PTC_ENGINE_*` 为假 ctx 探针（已实测）；**真机 PTC 会话未验证**（原因见三档表），
  因此本文档**不把 PTC 真机标为已验证**。

### 已实测 / 未验证 / 无法判定（三档，2026-11-06）

> 判定标准：**已实测** = 跑过的命令 + 原始输出/退出码；**未验证** = 文件已写或源码已读但没跑；**无法判定** = 信号读不到
> 或依赖动态环境。假 ctx 探针一律只算「已实测（单元）」，不算真机。以下逐条落清，禁止四舍五入。

| 项 | 档位 | 证据 / 原因 |
|---|---|---|
| 统一 69 例自检全绿（含新增 11 例） | **已实测** | `DSH_HOST_MODULES=… node scripts/check.mjs` → `cases: 69 passed` / `result: OK`（exit 0） |
| 真 Cordis + 真 `dsh-tools`/`dsh-system-prompt`/库存 `dsh-tool-workflow` 集成：标准档 agent 视图 workflow 名集合 = `['workflow']`、section 恰好一条且为库存正文 | **已实测（真实 Cordis 集成）** | ``scripts/probe-disclosure.mjs`（随包发布，可复跑）→ `result: OK (10/10)`（预设作用域挂库存工具、插件挂全局、agent 作用域经 `agent/created` 注入；断言读宿主真实 `tools.view()` 与 `systemPrompt.assemble()`） |
| 同一集成下的 PTC 形态：无库存工具 + `run_code` 传输 ⇒ `workflow` 补位进视图、section 恰好一条、`run_workflow` 不出现 | **已实测（真实 Cordis 集成）** | 同上探针后半段 4 条断言全 PASS（`selectExecutor(agent).describe().knownNames` 含 `run_code` 时才补位） |
| 单条披露：默认 agent 视图 workflow 名字集合 = `['workflow']`，全局无 `run_workflow` | **已实测（单元）** | 用例 `WF_ALIAS_HIDDEN` PASS（own 层恰好一条 `workflow`；可见 workflow 形状名恰好 `['workflow']`） |
| 原版同形：description 1667 字符逐字、四参数、required `script`+`meta`、meta required `name`+`description` | **已实测（单元）** | 用例 `WF_STOCK_DEFINITION_PARITY` PASS（运行时捕获库存 `apply()` 后逐项 `===` / 深等） |
| 一条 section、正文库存逐字、无 takeover/executeWorkflow/two names/run_workflow；注册位置是 **agent 自己的作用域**（同名 shadow 库存那条，不重复、不撞名） | **已实测（单元 + 真实 Cordis 集成）** | 用例 `WF_SECTION_STOCK_ONCE`（组装后恰好一条、文本与库存捕获相等、禁用词不命中）、`WF_SECTION_SHADOWS_STOCK`（预设层那条被 agent 层 shadow，且预设层对象未被改写）、`WF_SYSTEM_PROMPT_SECTION`（接管激活时**全局 0 条**，规则在 agent 层）；集成探针两次 `systemPrompt.assemble()` 都是 1 条 |
| 别名默认隐藏 + `exposeRunWorkflow: true` 恢复 + `shadowStockWorkflow: false` 兼容模式 | **已实测（单元）** | 用例 `WF_ALIAS_SWITCH` PASS（两条恢复路径都注册 `run_workflow`，兼容模式无 `agent/created` 监听、无 guard） |
| `restrict({ deny: ['workflow'] })` 不被强塞 | **已实测（单元）** | 用例 `WF_RESTRICT_NO_GRANT` PASS（0 个 own 定义、0 次注册、0 条 guard） |
| PTC 补位：own 层恰好一条、`tools:sdk` 恰好一条 workflow 绑定、补位定义可执行、别名不出现 | **已实测（单元）** | 用例 `WF_PTC_SUPPLEMENT` PASS（用真实 `renderToolsSdk` 渲染，`ToolArgsMap` 里 `workflow:` 行数 = 1；`execute` 返回 `kind:'foreground'`） |
| 标准/cordis 档真机工具视图恰好一条 `workflow`、`run_workflow` 不出现 | **未验证** | 只有假 ctx 分层视图断言；本次 worker 会话未在活宿主重扫工具面（需宿主会话执行 `tools:` 快照）。原因：文档任务不在真机跑；不据此宣称真机单条 |
| PTC 档真机：`dispatch_subagent(preset:ptc)` 子会话 `tools:sdk` 单条且 `await tools.workflow` 跑完 | **未验证** | 真机侧只有未重启前的旧模块证据（本机 worklog 的 `evidence/ptc-real.json`，未随包发布；其中 `realCall: "undeterminable"`）；**真实 Cordis 集成**已覆盖补位与单条，但活宿主 `run_code` 里实调未跑，**不得**写成已验证 |
| `workflow` 在 PTC 预设已被启用时的真实组合（预设库存 + 同名接管） | **未验证** | 已按 OI2 在单元层区分「已可见 ⇒ 重定向 / 不可见且 PTC ⇒ 补位」，但未在真机 PTC 组合上观测 |
| 后台 job 进度事件在 UI 运行视图可见、真机 `job_kill` 取消引擎 run | **未验证** | 假 ctx 只断言订阅与写入；无浏览器点验、无真机取消 smoke |
| systemPrompt section 真的进入最终 prompt（order 2600 落位） | **未验证** | order 常量与注册名已静态核对 + 单元断言；真机 prompt 未捕获 |
| 插件热重载后 stale 接管定义仍可执行 | **未验证** | 正常 unload 会释放；异常残留按 marker 采纳并 warn，但旧闭包行为未在真机验证 |
| 宿主版本 | **已实测** | 本机安装为 **0.2.2-rc.1**（`resources/app.asar` 内 2501 处版本串、`.tmp/host-modules` 同版）；68 例自检与 10 条集成断言都在该版本实跑 |
| `dispatch` external provider 本体真机收尾等价性 | **无法判定** | 活宿主未跑通；只有请求形状断言，依赖宿主 external 分支动态行为 |

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
        # —— 0.5.0 起（同名接管相关）——
        maxResultChars: 50000             # 结果展示文本上限，默认同库存 5e4
        shadowStockWorkflow: true         # 总开关，默认开：按 agent 同名接管 workflow；false ⇒ 兼容模式，既不接管也不 guard
        exposeRunWorkflow: false          # 别名披露开关：默认 false（隐藏 run_workflow）；true ⇒ 恢复单独披露
        takeoverToolName: workflow        # 接管的工具名，默认 'workflow'（非法名 ⇒ warn + 不接管，不抛）
        shadowedToolNames: ['workflow']   # 仍未接管的库存名（接管名会被自动剔出；默认过滤后为空 ⇒ 无全局 guard）
```

接管与 guard 相关的配置项（全部可选，缺省即下表；本包**不导出** `Config` schema）：

| 键 | 默认 | 作用 |
|---|---|---|
| `maxResultChars` | `50000` | 结果**展示文本**上限（前台 render 与后台 job 结果共用；同库存 `:68`）。输出值本身不改写。 |
| `shadowStockWorkflow` | `true` | **接管总开关**。`true` ⇒ 对每个本来就能看见 `takeoverToolName` 的 agent 做**同名接管**（真重定向）；`false` ⇒ **既不接管也不注册任何 guard**（兼容模式，`run_workflow` 随之恢复注册，库存 `workflow` + 本插件 `run_workflow` 两套入口并存）。 |
| `exposeRunWorkflow` | `false` | **别名披露开关**。`false`（默认，接管激活时）⇒ `run_workflow` **不注册**，模型面只有 `workflow`；`true` ⇒ 接管照常，同时恢复 `run_workflow` 的单独披露（双披露，供旧脚本）。接管不可用时（如 `shadowStockWorkflow: false`）别名本来就会注册。 |
| `takeoverToolName` | `'workflow'` | 要接管的工具名，也是默认唯一披露的 workflow 名。必须是非空字符串，且不等于本插件自己的两个工具名（`run_workflow` / `dispatch_subagent`）、不等于宿主保留名 `run_code`；不满足时 **warn + 不接管、不抛错**。 |
| `shadowedToolNames` | `['workflow']` | **接管之外**的库存工具名（走全局 `ctx.tools.guard` 兜底拒绝）。下列名字**永远**被剔出：`workflowToolName`、`toolName`（本包两个工具，guard 只能拒绝不能放行）；接管激活时再加 `takeoverToolName` **和** 默认库存名 `workflow`（否则全局 guard 先于 agent 链求值，会把我们自己注册的定义 / 重命名接管时该 agent 仍可用的库存 `workflow` 一并拒掉）⇒ 默认过滤后为**空**，一条全局 guard 都不注册。 |
| `workflowToolName` | `'run_workflow'` | 本插件 workflow 工具的**别名**名（默认不注册，`exposeRunWorkflow: true` 或兼容模式下才披露）。 |
| `toolName` | `'dispatch_subagent'` | 按次派发工具的对外名；改了它，systemPrompt / 回执里的自称随之改变。 |
| `workflowProviderPrefix` | `'dispatch-wf'` | per-run 临时 provider 的名字前缀（实际名字 = `前缀-<uuid>`，每次唯一，跑完释放）。 |
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
| `workflow`（默认唯一披露；别名 `run_workflow` 同源，per-run） | 能（**按轮**，临时 provider 注入） | 能（**按轮**，临时 provider 注入；派发前校验档位） | 能（按轮，专为本次调用注册的 provider） | 能（由脚本里 `agent({schema})` 给） | 不能（由 workflow 的 cwd 决定） |
| `workflow` `agent()` + `subagentProvider: 'dispatch'`（per-run） | 能（**按轮**，provider 注入） | 能（**按轮**，provider 注入） | 能（按轮配置，按次 `agent()` 的 `provider`/`model` 优先） | 能（`agent()` 的 `schema`） | 不能（由 workflow 的 cwd 决定） |
| 库存 subagent provider 配置（per-run） | 能**有条件**（`capabilities.agentPreset` 且 `inheritsParentContext: false`） | 能**有条件**（provider 自己把 effort 放进 `agentOptions`） | 能（provider 自定） | 能**有条件**（`outputSchema` capability） | 能（provider 自定） |

逐格写着「能 / 不能 / 有条件」以及每格的**依据文件:行**见 [`docs/capability-matrix.md`](docs/capability-matrix.md)。
**per-run ≠ per-call**：上表后三行是**按轮**配置，任何一格都不构成「每次调用可改」。workflow 侧**没有** per-call
preset / effort 入口；模型默认可调的 `workflow` 与 `subagentProvider: 'dispatch'` 是同一件事的两个入口（谁发起不同）。
**单条披露**：上表描述的是**注入机制**；默认模型面只有 `workflow` 一个名字（接管后解析到本插件定义，同一
`executeWorkflow` + 同一工厂）。`run_workflow` 是默认隐藏的**别名**，`exposeRunWorkflow: true` 恢复披露；
`shadowStockWorkflow: false` 时接管关闭，两个名字是两套入口（库存实现 + 本插件实现）。

## 限制与诚实边界

- **未对齐：工具卡片（`presentCall` / `presentResult`）没复刻**。库存 `workflow` 用 `presentCall` 把卡片标题渲染成
  `workflow: <meta.name>` 并展示原始脚本，本插件的定义没有这两个回调 ⇒ 工具卡片的**外观**与库存不同（工具名、参数、
  执行、结果文本都不受影响）。这是 0.6.0 已知差异，列在这里而不是「已对齐」表里。
- **未对齐：前台取消走引擎自己的 signal 监听**。库存 `workflow` 在 `exec.signal` 上挂一个监听、`finally` 里摘掉，
  取消时 `run.cancel('parent step aborted')`；本实现把取消交给引擎（`dsh-workflow-ptc` 自己挂 `signal` 监听，
  已核对 0.2.2-rc.1 源码），因此**换成不自带该监听的引擎**时前台取消会失效——这是引擎契约，不是本包的
  silent fallback。错误串也因此不是库存那句 `workflow run was cancelled`。

- `workflow` `agent()` 的选项白名单只有 `SUPPORTED_AGENT_OPTIONS = label / phase / schema / provider / model`；
  `DEFERRED_AGENT_OPTIONS = effort / isolation / agentType`，命中即抛 `UNSUPPORTED_OPTION`。
  ⇒ **workflow 侧 `reasoning_effort` 只能 per-run 生效，不是 per-call**。源码原文与行号见
  [`docs/engine-evidence.md`](docs/engine-evidence.md)。
- **`dispatch` provider（external 通道）宿主真机仍未跑通，待人 smoke**。`scripts/check.mjs` 的探针只证明**请求形状**
  （委派到 `delegateProviderName`、注入的 preset/effort/model、合成 `dispatch:<uuid>`、`dispose` 转发一次）——
  `dispatch` provider 自己的 external 子 agent 收尾等价性、`resident`/ownership 事件身份仍**无法判定**。
- **单条披露后的真机形态未验证**：0.5.0 构建曾在活宿主跑通 `workflow`（含 `preset` / `reasoning_effort` 落位）与
  `run_workflow`（旧轮真机证据）；0.6.0 改成「默认隐藏别名」后，**没有**在真机上重扫标准/cordis 档的工具面来确认
  `run_workflow` 不出现。`scripts/check.mjs` 的 `WF_ALIAS_HIDDEN` 是分层假 ctx 断言，不是真机证据。
- **peer 范围两侧证据不同**：本机安装是 **0.2.2-rc.1**，`scripts/check.mjs`（68 例）与
  `scripts/probe-disclosure.mjs`（10 条）都在该版本的宿主模块上**实跑**；0.2.1-rc.2 一侧只有**源码比对**
  （`docs/engine-evidence.md` §9）⇒ 那一侧**无法判定**。
- 库存 `subagent` 工具本身已能按次给 `provider` / `model` / `reasoning_effort`（受 profile 设置白名单门控）
  并条件性给 `agent_preset`；本包不宣称这些能力本身是独家能力。差异只在于：**默认设置下**本工具的 `preset` +
  `reasoning_effort` 即同时可用（库存工具需先在其工具行与 profile 设置里打开门控才能同时给），另外多一条 per-run
  注入的 external provider。
- `isConcurrencySafe: () => false`：同一 workspace 上并发派发不安全，串行调用。
- **peer 覆盖（0.6.0 已修）**：`export const inject = ['subagents', 'tools', 'llm', 'systemPrompt']` 是**数组形式 =
  必需依赖**（Cordis `Inject.resolve` 把数组里每个名字置 `null`，缺一个 `apply()` 根本不跑），所以 `systemPrompt`
  必须在 `peerDependencies` 里 —— 0.6.0 已补 `@deepseek-ai/dsh-system-prompt`（peer 5 → 6，
  `PEER_RANGE_PRE_RELEASE` 同步改成 6 条断言）。代码里的判空与 `try/catch` 保留，是给「服务在但 `section()` 抛错 /
  注入的是代理对象」这类宿主差异兜底，**不是**「缺包也能跑」。`dsh-agent` / `dsh-session` 在 peer 里但没有 import，
  保留只为不改动安装期解析。
- **本包不导出 `Config` schema**（`cordis.patch.yml` 里已明说 `The plugin does NOT export a Config schema`）；配置项由
  `apply(ctx, config = {})` 直接读、每个字段都有缺省值（见上方配置表）。**这一条是「未对齐」**：库存 `workflow`
  导出 `Config`（`dsh-tool-workflow/lib/index.js:66-70`），能力等价、形态不等价。
- **其余真机项未验证**（假 ctx 探针测不到）：① UI 工具卡片 / workflow 运行视图是否真能看到 `workflow/*` 进度；
  ② 真机 `job_kill` 是否真把引擎 run 取消；③ 插件热重载后遗留的 stale 接管定义是否仍能执行（本包会按
  `takeoverMarker` 采纳并 warn，但不转拒绝）；④ systemPrompt section 是否真的进入最终 prompt。
- **接管是重定向，不是隐藏、也不是能力扩张（口径写死）**：库存 `workflow` 的定义在 agent own 层被同名覆盖
  （`dsh-tools/lib/index.js:3055-3074`），所以「工具列表里还有 `workflow`」是**设计如此**——那一条已经是本插件的定义；
  而没有这个工具的 agent **不会**被塞进来（PTC 补位是唯一有界例外）。`ctx.tools.guard` 只剩**兜底**作用。
- **recorder 依赖 `parent.session.append`**：宿主不提供可追加 session 时 `recorder.start` 返回 `false`、该 run 不记录
  （后续 `finish` / `abandon` 空转，不抛错）；append 抛错只 `warn` 一次并停用该 run。库存无条件读 `session.append` ⇒
  **记录能力等价、形态有差异**。

## PTC 档（dsh-ops）：引擎兜底的加载与缓存细节

> 披露形态（`tools:sdk` 单条、补位判据）见上一节 [「PTC 档（dsh-ops）的 workflow 补位与引擎兜底」](#ptc-档dsh-ops的-workflow-补位与引擎兜底)。

官方 `ptc` 预设（`@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`）把 `workflow-ptc` 与 `tool-workflow` 两行标成
`disabled: true`，而 `standard` / `cordis` 没有；dsh-ops 只增强工具面、不补引擎。所以 PTC 会话里的 `workflow`
曾经是“工具目录里有、一调就报 `no workflow engine`”的死条目。

`lib/index.js` 的 `resolveWorkflowEngine` 现在这样处理一次调用：

- 先走原有五级解析（`agentPresets.serviceFor` → `agent.ctx` → 插件 ctx）；命中就直接用，**不挂任何东西**。
- 都没命中、且宿主有 `ptcRuntime`（`language === 'typescript'`）时，首次调用按需加载官方引擎，再
  `ctx.plugin(Engine, { provider: 'spawn' })` 挂载；成功后缓存，**失败不缓存**、下次可重试；
  缓存项每次用前按 `ctx.get('workflowEngine')` 身份复验，fiber 被回收就重挂。
- 加载入口**先走宿主 loader**（`ctx.get('loader').import('@deepseek-ai/dsh-workflow-ptc')`），失败再退到裸
  `await import(...)`。原因：profile 插件在 app-boot 的“linked”解析层里，裸包名只有在 `peerDependencies` 里声明过
  才会被路由；引擎是可选包，不能为了解析把它写成硬 peer，而 loader 的 import 以 profile 为锚、能路由 installation 包。
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
# 自检与集成探针都需要宿主包目录（宿主的 @deepseek-ai/*），显式给出即可：
DSH_HOST_MODULES="<profile-or-app>/node_modules" node scripts/check.mjs   # 全绿时末行 result: OK
DSH_HOST_MODULES="<…>/node_modules" node scripts/probe-disclosure.mjs    # 末行 result: OK (10/10)
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
`TAKEOVER_FALLBACK_GUARD`、`TAKEOVER_DISABLED`、`TAKEOVER_SKIP_ABSENT`、`TAKEOVER_ADOPT_OWN`。
0.6.0 的单条披露/同形另有 11 例：`WF_STOCK_DEFINITION_PARITY`、`WF_ALIAS_HIDDEN`、`WF_ALIAS_SWITCH`、
`WF_SECTION_STOCK_ONCE`、`WF_SECTION_SHADOWS_STOCK`、`WF_RESTRICT_NO_GRANT`、`WF_PTC_SUPPLEMENT`、
`WF_ERROR_NAMES_CALLED_TOOL`、`TAKEOVER_FOREIGN_KEPT`、`WF_GLOSSARY_NO_DEAD_NAMES`、`WF_RECORD_RESOLVES_EXTERNAL_CHILD_ID`。**当前总数 69 例，全绿时 `result: OK`**
（`DSH_HOST_MODULES=… node scripts/check.mjs` → `cases: 69 passed`）。
**这些是假 ctx 用例**：它们证明的是调用形状与事件订阅，不证明真机行为（见上方三档表）。

## 文件

```text
package.json        manifest（dsh.bundle.patch、exports ./locale/*.json 与 ./icon、files）
cordis.patch.yml    bundle 层：insert dsh-subagent-dispatch 行
lib/index.js        apply(ctx, config) —— provider×2 + dispatch_subagent + workflow（库存名，默认唯一披露；别名
                    run_workflow 默认隐藏）+ 同名接管 / PTC 补位 / 兜底 guard / 后台 job / 进度镜像 / 运行记录 /
                    结果截断 / systemPrompt section
docs/capability-matrix.md   五行 × 六列能力矩阵 + 「单条披露与别名兼容」已对齐 / 已实测 / 未验证分栏
docs/engine-evidence.md     引擎层源码证据（路径:行号 + 原文）；§9 是 0.2.2 适配比对，§10 是库存工具可观察行为对账，
                            §10.5 是同名接管的宿主依据，§10.6 是单条披露/原版同形/PTC 证据分栏
locale/{en,zh}.json Plugin Manager / Settings 显示元数据
icon.svg            包图标
scripts/check.mjs   假 ctx 探针（对真宿主模块）
scripts/probe-disclosure.mjs  真实 Cordis 集成探针（真 dsh-tools / dsh-system-prompt / 库存 workflow）
LICENSE             MIT
```

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
