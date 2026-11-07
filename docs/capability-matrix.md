# 能力矩阵：per-call 与 per-run

**一句话**：本页所有格子只回答「这个通道能不能把某个 knob 交给子 agent」，以及**在哪一层**生效。
**per-run ≠ per-call**：第三、四、五行是**整轮一套配置**，任何一格都不代表「每次调用可改」。
**per-call 在 workflow 侧仍然不可**；**per-run 有两条路** —— workflow 自己写 `subagentProvider`（第 4 行），
和模型直接调 `workflow`（第 5 行，本插件为这次调用注册临时 provider），两者注入机制相同。
**单条披露（0.6.0 起）**：模型侧默认只看见**一条** workflow 能力，名字 `workflow`；`run_workflow` 降级为**别名**，
默认隐藏，`exposeRunWorkflow: true` 恢复单独披露，`shadowStockWorkflow: false` 是兼容模式（回到两套入口）。
详见下一节「单条披露与别名兼容（0.6.0）」。

宿主安装根（下文 `$H`）：桌面版默认安装在
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai`
下文 `$D` 指上述目录（与下文 `$H` 同义；`%LOCALAPPDATA%` 在 Windows 上展开为 `<用户主目录>\AppData\Local`）。
**行号口径（0.6.0 校正）**：本页 `文件:行` 的行号取自 **0.2.1-rc.2** 的解包快照，**不是**当前安装版本的行号。
当前宿主是 **0.2.2-rc.1**，多份包在该版本被重新打包（例如 `dsh-tools` 的实现搬进 `lib/shared-*.js`，`lib/index.js`
只剩 665 行），行号整体漂移，**不要按行号复现**。复现请按符号名：

```bash
grep -n "<符号>" "$H/dsh-tools/lib/index.js" "$H/dsh-tools/lib/shared-"*.js
grep -n "<符号>" "$H/dsh-subagent/lib/index.js"
```

0.2.2-rc.1 上重新核对过的锚点见 [`engine-evidence.md`](engine-evidence.md) §12。原文抄录见同一文件。

**本插件侧不写行号**（每次改动都会漂移），只写行为契约：本页出现的 `lib/index.js:<行>` 一律指宿主安装根 `$H` 下的 `dsh-*` 包文件；本插件自己的落点只用符号名指代（如「`dispatch_subagent` 的 `ctx.tools.register(defineTool(...))`」），与 [`engine-evidence.md`](engine-evidence.md) 的「行号口径」一致。

## 单条披露与别名兼容（0.6.0）

**默认形态（单条披露）**：本插件为每个**本来就能看见** `workflow` 的 agent，在该 agent 的 **own 作用域**注册同名定义；
宿主解析工具时 **own 覆盖 inherited**（`dsh-tools/lib/index.js:3055-3074`），所以预设层里的库存 `workflow` 被同名压住 ⇒
模型面里 workflow 形状的名字集合**恰好是 `['workflow']`**。插件作用域的 `run_workflow` **默认不注册**（宿主没有
「注册但隐藏」的 API，「隐藏」= 不注册全局别名）。

| 配置 | 行为 | 模型面名字集合 |
|---|---|---|
| 默认（`exposeRunWorkflow` 省略，`shadowStockWorkflow: true`） | 同名接管；别名不注册 | `['workflow']` |
| `exposeRunWorkflow: true` | 接管照常 + 恢复 `run_workflow` 注册 | `['workflow', 'run_workflow']` |
| `shadowStockWorkflow: false` | 不接管、不注册 guard；别名恢复注册 | `['run_workflow', 'workflow'(库存)]` |

**别名兼容口径**：`run_workflow` 的实现与定义都保留（不是删除），但**默认不注册**（因此不可调用）；与 `workflow` 同一 `buildWorkflowDefinition` 工厂 + 同一
`executeWorkflow`、同一参数表；默认只影响**披露**。两条恢复路径发布的都是同一份实现，不存在第二份代码。

**三条边界（写死，别再猜）**

1. **本来没有 `workflow` 的 agent 跳过**：`tools.get(takeoverToolName, agent) === undefined` ⇒ 不注册。接管是重定向，
   **不是能力扩张**；被 `restrict({ deny: ['workflow'] })` 挡掉的 agent 同样返回 `undefined` ⇒ 跳过，**不补位**。
2. **PTC 补位是唯一有界例外**：agent 有 `run_code` transport 且 `workflow` 名**从未存在**（`knownNames` 不含）⇒
   补一条 `workflow`；`knownNames` 含但 `visible` 不含（restriction）⇒ **跳过**，不把 deny 翻成 grant。
3. **接管不可用时回退 guard**：该 agent 的 own 层已放着**别人**的同名工具 ⇒ 只在这一个 agent 上注册 `ctx.tools.guard`
   兜底（拒 `takeoverToolName`）；`shadowedToolNames` 里**非接管名**的库存名仍走全局 guard，默认过滤后为空 ⇒
   默认一条 guard 都不注册。`shadowStockWorkflow: false` ⇒ 既不接管也不注册任何 guard。

> 「同一实现」= **同一 `executeWorkflow` + 同一工厂产出**，**不是**「同一个函数对象」：宿主 `defineTool` 每次调用都
> 新建 `execute` 包装闭包（`dsh-tools/lib/index.js:838` 入口、`:866-870` 包装）⇒ 两次 `defineTool` 的 `execute` 必然
> 不是同一对象。证明用「行为委托 + 同一 `sharedExecute` + 参数表/schema 深等」，**禁止**写 identity 断言。

### 原版同形（库存定义逐字/结构对齐）

库存 `@deepseek-ai/dsh-tool-workflow` **不导出** `DESCRIPTION`，所以对账是**运行时捕获**库存 `apply()`
（fake ctx + `Config({})`）后逐项比较，不手抄源码。当前结果：

| 项 | 库存 | 本插件 | 断言 |
|---|---|---|---|
| `description` | 1667 字符 | **逐字相同** | `===`（`WF_STOCK_DEFINITION_PARITY`） |
| 参数表 | `script` / `meta` / `args` / `run_in_background` 四字段 | 四字段结构与描述逐项相同 | 逐字段 `canonicalJson` 深等 |
| 根 `required` | `['script','meta']` | 相同 | 排序后相等 |
| `meta` | `additionalProperties:true`，`required:['name','description']`，`properties.name/description/whenToUse/phases`；`phases.items.title` 必填 | 相同 | `canonicalJson` 深等 |
| 插件 per-run 字段 | —— | `preset` / `reasoning_effort` / `provider` / `model` / `max_total_agents`，**全部可选追加** | 新增集合恰好这五个、无 required |

### 已对齐（宿主源码可证；行号为宿主安装根 `$H` 下的包文件，`sed -n '<行>p'` 可复现）

| 能力 | 库存依据 | 本插件等价行为 | 证明方式 |
|---|---|---|---|
| 后台 job | `:217-258` `startBackgroundRun`；`:224`；`:225` `kind:"workflow"`；`:226`；`:227`；`:228` | `run_in_background: true` → `kind:'workflow'` / `owner: parent.id` / `toolCall` 起后台 job，返回 `{kind:'background', jobId, runId}` | 源码行号 + 用例 `WF_BACKGROUND_JOB` |
| 取消链 | `:239-241`；`dsh-tool-jobs/lib/index.js:406`；`dsh-jobs-local/lib/index.js:644-655` | `job_kill` → `jobs.kill` → `hooks.cancel` → `run.cancel('background workflow job killed')` | 源码链路 + 用例 `WF_BACKGROUND_CANCEL` |
| 结算语义 | `:242-254` `done`；`:178-196` `jobOutcomeOf` | completed / cancelled / error 三态同形 | 源码行号 |
| 进度事件 | `:19-45` mirror：`workflow/phase` `:21`、`workflow/log` `:27`、`workflow/agent-start` `:30`、`workflow/agent-end` `:33` | 订阅同名同形状四事件，写进 job 输出环 | 用例 `WF_PROGRESS_MIRROR` |
| 运行记录 | `:83-130` recorder；`:98` / `:109` / `:117` / `:124` | 同四条 `tool-workflow/*` 记录类型写 session；append 失败只 warn | 用例 `WF_RECORDER_EVENTS` |
| 结果截断 | `:68` `maxResultChars` 默认 `5e4`；`:198-202` `renderResult` | `maxResultChars` 默认 50000；同一 truncation 后缀 | `WF_TRUNCATE_RESULT` |
| **systemPrompt 指引** | `:262-269`；`:267` `getSectionOrder('TOOL_WORKFLOW')`；`dsh-system-prompt/lib/index.js:31` = 2600 | **一条** section：order 2600、name `tool:workflow`、正文=库存 section 逐字；不含 takeover/executeWorkflow/two names/run_workflow | `WF_SECTION_STOCK_ONCE` / `WF_SYSTEM_PROMPT_SECTION` |
| **同名接管（真重定向）** | `dsh-tools/lib/index.js:3055-3074`（own 覆盖 inherited）；`:3091-3092`；`:3040-3041`；`dsh-tool-cordis/lib/types/api-catalog.js:3956-3960` | 预检 `get(...)===undefined` ⇒ 跳过；own 层已有 marker ⇒ 采纳；注册 ⇒ 模型调 `workflow` 落 `executeWorkflow`；失败 ⇒ 仅该 agent 兜底 guard | `TAKEOVER_*` 7 例 |
| 兜底 guard | `:3017-3022` `guard`；`:3024-3032` `guardReason` | 只在**别名已发布**且「别人的同名」占着该 agent 的 own 层时注册一条（只拒该名）；单条披露默认下 0 条，外国定义原样保留 | `TAKEOVER_FALLBACK_GUARD` / `TAKEOVER_FOREIGN_KEPT` / `WF_SHADOW_GUARD` |
| 输出 schema | `:339-379` `oneOf`；`:380-383` render；`:417-422` 前台 | 同形 `oneOf` 与 render | `WF_OUTPUT_ONEOF` |

### PTC 档：workflow 补位与 `tools:sdk` 单条

PTC 的 `run_code` 是执行器 `describe()` 声明的 transport，**不进 registry**，`view().visible` 看不到它；本插件改问
`tools.selectExecutor(agent).describe().knownNames` 是否含 `run_code`，并用 `view.knownNames` 区分「deny」与「从未存在」：

| 情形 | 判定 | 行为 | 模型面 |
|---|---|---|---|
| PTC agent（有 `run_code`，workflow 从未存在） | `knownNames` 不含 `workflow` 且有 `run_code` | own 层补一条 `workflow`（同一工厂定义） | `tools:sdk` 的 `ToolArgsMap` **恰好 1 条** workflow 绑定 |
| 普通 agent（无 `run_code`） | 无 workflow、无 transport | 不补 | 无 workflow |
| `restrict({ deny:['workflow'] })` | `knownNames` 含、`visible` 不含 | 跳过 | 仍无 workflow（deny 生效） |

补位定义是真实 `defineTool` 产物，可在 `run_code` 里 `await tools.workflow(...)`；**PTC 预设自身若已启用库存
`workflow`**，模型面由「预设库存 + 同名接管」提供，不重复补位。**真机 PTC（`dispatch_subagent(preset:ptc)` 子会话
`tools:sdk` 单条 + `await tools.workflow` 跑完）当前是「未验证」**，原因见下栏，本文档不宣称已测。

### 已实测 / 未验证 / 无法判定（三档，2026-11-06）

> **已实测** = 跑过的命令 + 原始输出/退出码；**未验证** = 文件已写或源码已读但没跑；**无法判定** = 信号读不到或依赖
> 动态环境。假 ctx 探针只算「已实测（单元）」，不算真机。

| 项 | 档位 | 证据 / 原因 |
|---|---|---|
| 68 例自检全绿（含新增 10 例） | **已实测** | `DSH_HOST_MODULES=… node scripts/check.mjs` → `cases: 68 passed` / `result: OK`（exit 0） |
| 默认单条披露：workflow 形状名恰好 `['workflow']`，全局无 `run_workflow` | **已实测（单元）** | `WF_ALIAS_HIDDEN` PASS |
| 原版同形（1667 字符 DESCRIPTION、四参数、required、结构化 meta） | **已实测（单元）** | `WF_STOCK_DEFINITION_PARITY` PASS |
| 一条 section、库存逐字、无实现词；**注册在 agent 作用域并 shadow 预设那条**（全局 0 条） | **已实测（单元 + 真实 Cordis 集成）** | `WF_SECTION_STOCK_ONCE` / `WF_SECTION_SHADOWS_STOCK` / `WF_SYSTEM_PROMPT_SECTION` PASS；集成探针 `systemPrompt.assemble()` 组装后 1 条 |
| 别名隐藏 / `exposeRunWorkflow: true` 恢复 / `shadowStockWorkflow: false` 兼容 | **已实测（单元）** | `WF_ALIAS_SWITCH` PASS |
| `restrict` 不扩张 | **已实测（单元）** | `WF_RESTRICT_NO_GRANT` PASS（0 注册、0 guard） |
| PTC 补位单条 + `tools:sdk` 恰好一条绑定 + 可执行 | **已实测（单元）** | `WF_PTC_SUPPLEMENT` PASS（真实 `renderToolsSdk` 计数 `workflow:` 行 = 1） |
| 标准/cordis 形态：agent 视图单条 `workflow`、`run_workflow` 不出现 | **已实测（真实 Cordis 集成）** | ``scripts/probe-disclosure.mjs` 标准段 6/6 PASS（真 `dsh-tools.view()` / 真 `systemPrompt.assemble()`；库存工具挂预设作用域、插件挂全局） |
| 标准/cordis 档**活宿主**重扫工具面 | **未验证** | 运行中宿主的模块是改动前的旧实例（`link:` 安装 + Node 模块缓存），需重启后复验 |
| PTC 形态：无库存工具 + `run_code` 传输 ⇒ `workflow` 补位、section 一条、别名不出现 | **已实测（真实 Cordis 集成）** | 同一探针 PTC 段 4/4 PASS；补位判定走真 `selectExecutor(agent).describe().knownNames` |
| PTC 档**活宿主**：`tools:sdk` 单条、`await tools.workflow` 跑完 | **未验证** | 需宿主会话起 PTC 子会话；既有真机证据是旧模块（本机 worklog 的 `evidence/ptc-real.json`，未随包发布；`realCall: "undeterminable"`），不得写成已验证 |
| PTC 预设已启用库存 `workflow` 的真实组合（库存 + 同名接管） | **未验证** | 单元层已按「已可见 ⇒ 重定向」建模，未在真机组合观测 |
| 后台 job 进度 UI、真机 `job_kill` 取消引擎 run | **未验证** | 只有假 ctx 订阅/写入断言 |
| systemPrompt section 进入最终 prompt（order 2600 落位） | **未验证** | 常量与注册名已静态核对，真机 prompt 未捕获 |
| 热重载后 stale 接管定义仍可执行 | **未验证** | 按 `takeoverMarker` 采纳并 warn，旧闭包行为未在真机验证 |
| 0.2.2-rc.1 运行时行为 | **已实测（本机已升级到 0.2.2-rc.1）** | `scripts/check.mjs` 的 68 例与 `scripts/probe-disclosure.mjs` 的 10 条断言都对 **0.2.2-rc.1** 的宿主模块实跑；其余旧记录里写「本机只装 0.2.1-rc.2」的段落已按此校正 |
| `dispatch` external provider 本体收尾等价性 | **无法判定** | 活宿主未跑通，仅请求形状断言 |

## 矩阵（5 行 × 6 列）

| 通道 | preset | reasoning_effort | provider+model | schema | cwd | 依据文件:行 |
|---|---|---|---|---|---|---|
| **本插件工具 `dispatch_subagent`**（per-call） | **能**：`preset` 落 `request.agentPreset`；省略则请求对象上**不出现该键** | **能**：`reasoning_effort` 落 `request.agentOptions.reasoningEffort`，派发前按模型档位校验并列出支持档位 | **能**：`provider`+`model` 成对落 `request.agentOptions`，是**子 agent 的 LLM route**（backend 固定为本地 provider `dispatch-local`） | **能**：`schema` 先过宿主 `assertObjectJsonSchema`，再落 `request.outputSchema` | **能**：绝对路径，宿主 `assertUsableCwd` 校验后落 `request.cwd` | `dsh-subagent/lib/index.js:3047`（`prepareContinuable` 存在 ⇒ `startLocal`）；`dsh-subagent/lib/index.js:3311`（`assertCapabilities`）；`dsh-tools/lib/index.js:838`（`defineTool` 编译 DSL）；本地实现：`dispatch_subagent` 的 `ctx.tools.register(defineTool({…}))`（本插件侧不写行号，只写行为契约） |
| **库存 `subagent` 工具**（per-call） | **有条件**：工具行配了 `agentPreset` / `allowedAgentPresets` 才长出 `agent_preset` 参数，且候选只能取这两处的并集 | **有条件**：需工具行 `modelSelectionSettings: true` **且** profile 设置 `enabled=true` **且** `allowedModels` 非空，才出现 `reasoning_effort` | **有条件**：同上（三者同时满足），`provider` 与 `model` 必须成对，实际路由由 `llm.resolveCallConfig` 预检 | **能**：`schema` 直接是参数 | **能**：`cwd` 直接是参数 | `dsh-tool-subagent/lib/index.js:400`（`agent_preset`）、`:414`（`reasoning_effort`）、`:360`（`modelSelectionSettings` 门控）、`:230`（候选 preset 并集）、`:163`（`resolveModelInfo`）、`:314`（配置默认 `false`）、`:386`（`cwd` 参数）、`:463`（透传到 activation） |
| **`workflow` `agent()` + `subagentProvider:'dispatch'`**（per-run） | **能，但按轮**：preset 由 provider 自身在 `start(request)` 里注入；`agent()` 的选项白名单**没有** preset | **能，但按轮**：`effort` 在 `DEFERRED_AGENT_OPTIONS` 里，`agent({effort})` 直接抛 `UNSUPPORTED_OPTION`；唯一来源是 provider 配置的 `reasoningEffort` | **能（按轮配置）**：`agent()` 可按次给 `provider`/`model`（白名单里有），落在 `request.agentOptions`，**优先于** provider 配置值 | **能（按次）**：`agent({schema})` 落 `request.outputSchema` | **不能**：`startChild` 写死 `cwd: await this.cwd`（workflow 自己的目录），`agent()` 无可传 cwd 的选项 | `dsh-workflow-ptc/lib/index.js:327`（`startChild`）、`:330`（`startActivation`）、`:573`（`subagentProvider` 校验）、`:623`（`resolveSubagentProvider`）、`:12`（`WORKFLOW_GUEST_SOURCE` 内嵌源串：`SUPPORTED_AGENT_OPTIONS` / `DEFERRED_AGENT_OPTIONS`） |
| **本插件工具 `workflow`**（库存名，默认唯一披露；别名 `run_workflow` 同源，默认隐藏；per-run，模型可直接调用） | **能，但按轮**：工具先注册一个**本次专用**的 external provider（名字 `dispatch-wf:<uuid>`），把 `preset` 注入它；脚本里每次 `agent()` 拉起的子 run 都挂这个 preset，`agent()` 自己仍没有 preset 选项 | **能，但按轮**：同上，由这个临时 provider 把值放进 `agentOptions.reasoningEffort`；工具在**起 workflow 之前**用 `ctx.llm.resolveModelInfo` 校验档位，不支持就报错并列出支持档位 | **能（按轮）**：`provider`+`model` 必须成对，整轮注进临时 provider；脚本内 `agent({provider, model})` 按次给的值**优先于**工具参数 | **能（按次）**：由脚本里 `agent({schema})` 给，与本工具参数无关 | **不能**：cwd 仍由 workflow 引擎 `startChild` 的 `cwd: await this.cwd` 决定 | `dsh-workflow-ptc/lib/index.js:620`（`start(request)`）、`:623`（`resolveSubagentProvider(..., request.subagentProvider)`）、`:644`（传进 `new PtcWorkflowRun(...)`）、`:331`（子 agent 的 `spec.provider`）、`:574`（名字未注册即拒：`no subagent provider registered for "…"` / `AGENT_START`；所在函数体 `:571-575`）、`:12`（`agent()` 白名单内嵌源串）；`dsh-subagent/lib/index.js:3256`（`registerProvider`）、`:3259`（返回 `ctx.effect(...)` 的 disposer）、`:3260`（同名即 `DUPLICATE_PROVIDER`）；本地实现：同一 `buildWorkflowDefinition` 工厂 + 同一 `executeWorkflow`，`workflow` 走同名接管注册进 agent own 层、别名 `run_workflow` 默认不注册（`exposeRunWorkflow: true` 或兼容模式才注册，本插件侧不写行号，只写行为契约） |
| **库存 subagent provider 配置**（per-run） | **有条件（按轮）**：provider 必须 `capabilities.agentPreset: true` **且** `inheritsParentContext: false`，否则 `assertCapabilities` 在子 agent 创建前拒 | **有条件（按轮）**：provider 得自己把 `reasoningEffort` 放进传给宿主的 `agentOptions`（宿主不会替你补） | **能（按轮）**：provider 在 `agentOptions` / 委派请求里自定 route；宿主只做预检 | **有条件（按轮）**：需 `capabilities.outputSchema: true` | **能（按轮）**：provider 可自定 cwd（`prepareContinuable` 的 `cwd` 或委派请求里的 `cwd`） | `dsh-subagent/lib/index.js:3311`（三条 capability 门）、`:3313`（`agentOptions`/`outputSchema`/`depthLimit` 逐个门控）、`dsh-subagent-spawn-in-process/lib/index.js:21`（库存 `spawn`：四项 capability 全 `true`、`inheritsParentContext=false`） |

## 每行的边界说明（写死，别再猜）

1. **本插件工具 = 默认就开、不需要改 profile 设置的同时按次通道；库存工具在门控都打开时也能同时给（见上表第 2 行「库存 `subagent` 工具」）。** backend 固定 `dispatch-local`（本地 provider），
   所以 preset / agentOptions / outputSchema 由宿主 `startLocal` → `applyChildComposition` 挂载，碰不到 external 的
   `childId = run.id` 校验。
2. **库存 `subagent` 工具并非「不能」，而是「门控」。** 它按次给 route / effort 的能力是**设置项**决定的：
   `modelSelectionSettings: true` 只声明能力，真正开不开看 profile 设置 `enabled` 与 `allowedModels`；preset 走
   `agentPreset` / `allowedAgentPresets`。文档不许把它说成「本插件独有」。
3. **workflow 侧没有 per-call preset / effort 入口。** `SUPPORTED_AGENT_OPTIONS = {label, phase, schema, provider, model}`，
   `DEFERRED_AGENT_OPTIONS = {effort, isolation, agentType}` 命中即 `UNSUPPORTED_OPTION`。所以 `subagentProvider:'dispatch'`
   提供的是**整轮**注入：**不是 per-call**。
4. **`cwd` 在 workflow 侧不是能力，是常量。** `startChild` 里 `cwd: await this.cwd` 已经定了；`agent()` 传什么都没用。
5. **`workflow`（及默认隐藏的别名 `run_workflow`）不是新的 per-call 通道，它是 per-run 的第二个入口。** 它做的事和
   workflow 自己写 `subagentProvider` 完全一样（注册一个 provider → 引擎按 run 用它），区别只在**谁发起**：不用改
   workflow 脚本，模型直接调工具；默认只披露 `workflow`，`run_workflow` 由 `exposeRunWorkflow: true` 或兼容模式恢复。
   `agent({effort})` / `agent({preset})` 依然被引擎拒掉——工具没有、也不可能绕过 `agent()` 白名单。
   临时 provider 是**一次调用一份**：名字唯一（`dispatch-wf:<uuid>`）、`finally` 里调 disposer 释放，
   不带 `preset` / `reasoning_effort` / `provider`+`model` 时**不注册**、`subagentProvider` 也不传。

## PTC 档（dsh-ops）的引擎兜底

标准 `ptc` 预设默认把 `workflow-ptc` / `tool-workflow` 两行 `disabled: true`（`standard` / `cordis` 则启用）。
本插件的 `workflow` 在五级解析全部落空、且宿主有 TypeScript `ptcRuntime` 时，会按需动态 import 官方
`@deepseek-ai/dsh-workflow-ptc` 并在插件 ctx 上 `ctx.plugin(Engine, { provider: 'spawn' })` 挂载一次：

- **触发口径**：只看**调用方 agent** 的五级解析结果；`serviceFor` 命中（standard / cordis / 自定义带引擎的预设）时
  绝不挂载。兜底引擎是进程级、活到插件卸载。
- **失败口径**：无 `ptcRuntime` / import 失败 / 挂载抛错 ⇒ 保持原“no workflow engine”错误并附原因与两条修法
  （preset 启用两行，或安装 `@deepseek-ai/dsh-workflow-ptc`）；不注册临时 provider、不启动 run。
- **关闭开关**：`autoMountPtcEngine: false`。
- **证据**：`scripts/check.mjs` 的 `WF_PTC_ENGINE_MOUNT` / `_CACHED` / `_SKIPPED` / `_NO_RUNTIME` / `_MOUNT_FAILS`
  为假 ctx 探针（**已实测（单元）**）；真实 Cordis 集成探针证明 **PTC 形态的 `workflow` 补位与单条 section**
  （`scripts/probe-disclosure.mjs` PTC 段 4/4 PASS），但**活宿主 PTC 会话**仍未重跑（本机 worklog 的 `evidence/ptc-real.json` 记 `realCall:
  "undeterminable"`）⇒ 真机 `tools:sdk` 单条与 `await tools.workflow` 跑完**不写成已验证**。

## 结论行

- **单条披露（0.6.0）**：默认模型面只有一条 workflow 能力，名字 `workflow`；它是同名接管后的本插件定义（同一
  `executeWorkflow` + 同一工厂）。`run_workflow` 降级为**别名**：默认**不注册**（模型侧不可见），实现与定义保留；`exposeRunWorkflow: true` 恢复
  单独披露，`shadowStockWorkflow: false` 是兼容模式（两套入口并存）。表里第 3、4 行是**注入机制**的说明。
- `workflow` `agent()` 的 `reasoning_effort` 只能 **per-run** 生效，**不是 per-call**。
- per-run 现在**两条路**：external provider `dispatch`（workflow 配置 / `subagentProvider`，整轮一套）与工具
  `workflow`（模型直接调用，同样是整轮一套）。两者注入的字段完全相同。
- **per-call 在 workflow 侧仍然不可**：默认披露的 `workflow` 也没有 per-call preset / effort，它只是把 per-run 配置
  从「改 workflow 脚本 / 配置」变成「一次工具调用」。
- 把 run-level 能力写成 per-call 属**文档错误**，不属配置差异。
- external 通道里的 **`dispatch` provider 本体**（workflow 配置 `subagentProvider: 'dispatch'`）**宿主真机未跑通，待人 smoke**；
  `workflow` 自带的 per-run 临时 provider 路径曾在旧轮真机跑通，但 0.6.0 单条披露后的真机形态**未验证**
  （本页只描述设计口径，不宣称 `dispatch` 本体已验证）。
- peer 支持范围 `>=0.2.1-rc.2 <0.3.0 || >=0.2.2-rc.1 <0.3.0`：0.2.2-rc.1 的下述接缝未变
  （`agent()` 白名单 / `subagentProvider` 口子 / `registerProvider` disposer），依据见
  [`engine-evidence.md`](engine-evidence.md) §9。
