# 能力矩阵：per-call 与 per-run

**一句话**：本页所有格子只回答「这个通道能不能把某个 knob 交给子 agent」，以及**在哪一层**生效。
**per-run ≠ per-call**：第三、四、五行是**整轮一套配置**，任何一格都不代表「每次调用可改」。
**per-call 在 workflow 侧仍然不可**；**per-run 现在有两条路** —— workflow 自己写 `subagentProvider`（第 4 行），
和模型直接调本插件的 `run_workflow`（第 5 行），两者注入机制相同。
**两个名字同一实现**：0.5.0 起 `workflow` 与 `run_workflow` 是同一实现的**两个名字**——每个 agent 的 own 作用域里注册
一份名为 `workflow` 的定义（同一 `executeWorkflow` + 同一工厂产出），库存 `workflow` 被同名压住，模型调 `workflow`
就是**真重定向**（`shadowStockWorkflow: false` 可关）。详见下一节「workflow 的两个名字（0.5.0 · 同名接管）」。

宿主安装根（下文 `H`）：桌面版默认安装在
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai`
下文 `$D` 指上述目录（与下文 `$H` 同义；`%LOCALAPPDATA%` 在 Windows 上展开为 `<用户主目录>\AppData\Local`）。
下文 `文件:行` **一律是 0.2.1-rc.2 本机安装根 `$H` 的行号**（不是 0.2.2-rc.1 快照 `_tmp/v022/` 的行号），因此每一条都可直接 `sed -n '<行>p' "$H/<文件>"` 复现原文；原文抄录见 [`engine-evidence.md`](engine-evidence.md)。

**本插件侧不写行号**（每次改动都会漂移），只写行为契约：本页出现的 `lib/index.js:<行>` 一律指宿主安装根 `$H` 下的 `dsh-*` 包文件；本插件自己的落点只用符号名指代（如「`dispatch_subagent` 的 `ctx.tools.register(defineTool(...))`」），与 [`engine-evidence.md`](engine-evidence.md) 的「行号口径」一致。

## workflow 的两个名字（0.5.0 · 同名接管）

**表述统一**：**`workflow` 与 `run_workflow` 是同一实现的「两个名字」**——同一 `executeWorkflow`（唯一实现）+ 同一
`buildWorkflowDefinition` 工厂产出的 `description` / `parameters` / `output{schema,render}`。机制是**同名接管**：
本插件为每个**本来就能看见** `workflow` 的 agent，在该 agent 的 **own 作用域**注册同名定义；宿主解析工具时
**own 覆盖 inherited**（`dsh-tools/lib/index.js:3055-3074`），所以 preset 层里的库存 `workflow` 被同名压住 ⇒
模型调 `workflow` 直接执行本插件实现，这是**真重定向**（不是隐藏，也不是 v0.4.0 那种执行期拒绝）。

**三条边界（写死，别再猜）**

1. **本来没有 `workflow` 的 agent 跳过**：`tools.get(takeoverToolName, agent) === undefined` ⇒ 不注册。接管是重定向，
   **不是能力扩张**；被 `restrict({ deny: ['workflow'] })` 挡掉的 agent 同样返回 `undefined` ⇒ 跳过。
2. **接管不可用时回退 guard**：该 agent 的 own 层已放着**别人**的同名工具 ⇒ 只在这一个 agent 上注册
   `ctx.tools.guard` 兜底（拒 `takeoverToolName`）；`shadowedToolNames` 里**非接管名**的库存名仍走全局 guard，
   默认过滤后为空 ⇒ 默认一条 guard 都不注册。`shadowStockWorkflow: false` ⇒ 既不接管也不注册任何 guard。
3. **接管名与总开关**：`Config.takeoverToolName`（默认 `'workflow'`）、`Config.shadowStockWorkflow`（默认 `true`，
   总开关）。接管名非法（空 / 非字符串 / 撞本插件两个工具名 / 撞宿主保留名 `run_code`）时 **warn + 不接管，不抛错**。

> 「同一实现」= **同一 `executeWorkflow` + 同一工厂产出**，**不是**「同一个函数对象」：宿主 `defineTool` 每次调用都
> 新建 `execute` 包装闭包（`dsh-tools/lib/index.js:838` 入口、`:866-870` 包装）⇒ 两次 `defineTool` 的 `execute` 必然
> 不是同一对象。证明用「行为委托 + 同一 `sharedExecute` + 参数表/schema 深等」，**禁止**写 identity 断言。

### 已对齐（宿主源码可证；行号为宿主安装根 `$H` 下的 `dsh-tool-workflow` / `dsh-tools` / `dsh-tool-cordis` 包文件，`sed -n '<行>p'` 可复现）

| 能力 | 库存依据（`sed` 可复现） | 本插件等价行为 | 证明方式 |
|---|---|---|---|
| 后台 job | `:217-258` `startBackgroundRun`；`:224` `jobs.start`；`:225` `kind: "workflow"`；`:226` `label`；`:227` `owner: parent.id`；`:228` `toolCall` | `run_in_background: true` → 以 `kind:'workflow'` / `owner: parent.id` / `toolCall:{callId,rootCallId}` 起后台 job，返回 `{kind:'background', jobId, runId}` | 源码行号 + 假 ctx 用例 `WF_BACKGROUND_JOB` |
| 取消链 | `:239-241` `cancel: (reason) => run.cancel(...)`；宿主 `dsh-tool-jobs/lib/index.js:406` → `dsh-jobs-local/lib/index.js:644-655` `killJob` → `job.cancel(reason)` | `job_kill` → `jobs.kill` → `hooks.cancel` → `run.cancel('background workflow job killed')` | 源码链路 + 假 registry 用例 `WF_BACKGROUND_CANCEL` |
| 结算语义 | `:242-254` `done`；`:178-196` `jobOutcomeOf` | completed → `{status:'completed', detail:'N agent(s)', result:<截断文本>}`；cancelled → `{status:'killed'}`；error → `{status:'failed', detail}` | 源码行号 |
| 进度事件 | `:19-45` mirror：`workflow/phase` `:21`、`workflow/log` `:27`、`workflow/agent-start` `:30`、`workflow/agent-end` `:33` | 订阅同名同形状四事件：phase 更新 progress 行 + `append(…,{channel:'log'})`，其余三类只 append | 源码行号 + 用例 `WF_PROGRESS_MIRROR`（事件由引擎在共享总线发，本插件不自造） |
| 运行记录 | `:83-130` recorder；`:98` / `:109` / `:117` / `:124` 四条记录类型 | `tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end` 写 session；append 失败只 warn 并停用该 run | 源码行号 + 用例 `WF_RECORDER_EVENTS`（差异见下） |
| 结果截断 | `:68` `maxResultChars` 默认 `5e4`；`:198-202` `renderResult` | 配置项 `maxResultChars` 默认 50000；前台 render 与后台 job 结果同一函数，后缀 `… [truncated: N more characters]` | 源码行号 |
| systemPrompt 指引 | `:262-269` `ctx.systemPrompt.section`；`:267` `getSectionOrder('TOOL_WORKFLOW')`；`dsh-system-prompt/lib/index.js:31` = 2600 | 注册一条 section（order = `TOOL_WORKFLOW`），正文写明 `workflow` 与 `run_workflow` 是同一实现的两个名字 | 源码行号 |
| **同名接管（真重定向）** | `dsh-tools/lib/index.js:3055-3074`（`view`：inherited 先合并、**own 最后覆盖**）；`:3091-3092`（`get(name, scope)` = `view(scope).visible.get(name)`）；`:3040-3041`（restriction 只过滤 inherited，**不过滤 own 层**）；`dsh-tool-cordis/lib/types/api-catalog.js:3956-3960`（`agent/created`：`mode:'serial'`，listener 抛错即打掉创建） | `apply()` 在每个 agent 的 `agent/created`（+ 存量扫描 + `tools/change` 重扫）里做：`tools.get(takeoverToolName, agent) === undefined` ⇒ 跳过；own 层已带本插件 marker ⇒ 采纳（不重复注册、不转拒绝）；注册成功 ⇒ 模型调 `workflow` 落到 `executeWorkflow`。注册失败（own 层是**别人**的同名）⇒ 仅该 agent 上一条兜底 guard | 源码行号 + 用例 `TAKEOVER_LISTENER` / `TAKEOVER_EXECUTE_DELEGATION` / `TAKEOVER_IDEMPOTENT` / `TAKEOVER_FALLBACK_GUARD` / `TAKEOVER_DISABLED` / `TAKEOVER_SKIP_ABSENT` / `TAKEOVER_ADOPT_OWN` |
| 兜底 guard（接管不可用时） | `dsh-tools/lib/index.js:3017-3022` `guard(guard)`；`:3024-3032` `guardReason(exec)`（全局层先判，再 `chainLayers(exec.agent)`） | 只为「别人的同名」那一个 agent 注册 `ctx.tools.guard`；`run_workflow` 永不被拒，接管名在接管激活时被剔出拒名单 | 源码行号 + 用例 `WF_SHADOW_GUARD`（已按接管语义改写） |
| 输出 schema | `:339-379` `oneOf` 两支；`:380-383` render；`:417-422` 前台返回 `kind:'foreground'` | 同形 `oneOf`（background / foreground）与同形 render 文案 | 源码行号 |

### 已实测（真机证据，2026-11-06）

| 项 | 判定 | 事实 |
|---|---|---|
| 真机双通道（`workflow` 与 `run_workflow` 各调一次） | **已实测** | 活宿主上三个探针脚本各跑一次；证据是解 `.dsh/sessions/.../session.v4.jsonl.zstd` 后的**子会话头 `agentPreset`**（不是工具回显）：① `workflow(script, meta)`（不传 `preset`）⇒ 完成，子会话头 `cordis`（继承调用方）；② `workflow(script, meta, preset:"minimal", reasoning_effort:"low")` ⇒ 完成，子会话头 `minimal`；③ `run_workflow(...)` 更早一轮同样可用。对照：`takeover-demo`→`c64608b7-…`（cordis）、`takeover-preset`→`f255b1b5-…`（minimal）、`shadow-demo`→`282820af-…`（cordis），三次 run-end 都是 `completed` |

### 未对齐 / 未验证（如实写，禁止写成已对齐）

| 项 | 判定 | 事实 |
|---|---|---|
| 工具列表里那一条 `workflow` 换了定义 | **已对齐（口径写死）** | 接管生效时 own 层定义**同名胜出**（`:3071-3074`）⇒ 模型看到/调用的 `workflow` 就是本插件这份（description / parameters / `output.schema` 与 `run_workflow` 同源）。想「库存定义 + 本插件定义并存」只能 `shadowStockWorkflow: false` |
| `restrict` 在接管**之后**施加 | **未对齐（已知边界）** | own 层注册豁免 restriction（宿主注释 `:3040-3041`）⇒ 后置 deny `workflow` 不会摘掉我们那份定义；接管**之前** deny 的 agent 则 `get(...) === undefined` ⇒ 跳过。宿主自身也依赖这条豁免，本包不挑战 |
| 不导出 `Config` schema | **未对齐** | 库存导出 `Config`（`:66-70`）；本插件 `apply(ctx, config)` 直读、每字段有缺省值，`cordis.patch.yml` 明说不导出 |
| UI 工具卡片 / workflow 运行视图可见进度 | **未验证** | 没有真机点验（no browser）；只有假 ctx 探针断言订阅与写入 |
| 插件热重载后遗留的 stale 接管定义可执行 | **未验证** | 正常情况下插件级清理 effect 在 unload 时释放全部接管；若未跑到，新实例按 `takeoverMarker` 采纳并 warn，但旧闭包能否继续执行未在真机验证 |
| 真机 `job_kill` 端到端取消引擎 run | **未验证** | 未在宿主实跑；只有源码链路 + 假 registry 用例 `WF_BACKGROUND_CANCEL` |
| systemPrompt section 是否进最终 prompt | **未验证** | order = 2600 的取值已静态核对，落位未在真机验证 |
| recorder 依赖 `parent.session.append` | **差异（未完全对齐）** | 宿主不提供可追加 session 时该 run 不记录（`recorder.start` 返回 `false`，不抛错）；append 抛错只 warn 并停用该 run。库存无条件读 `session.append` |

## 矩阵（5 行 × 6 列）

| 通道 | preset | reasoning_effort | provider+model | schema | cwd | 依据文件:行 |
|---|---|---|---|---|---|---|
| **本插件工具 `dispatch_subagent`**（per-call） | **能**：`preset` 落 `request.agentPreset`；省略则请求对象上**不出现该键** | **能**：`reasoning_effort` 落 `request.agentOptions.reasoningEffort`，派发前按模型档位校验并列出支持档位 | **能**：`provider`+`model` 成对落 `request.agentOptions`，是**子 agent 的 LLM route**（backend 固定为本地 provider `dispatch-local`） | **能**：`schema` 先过宿主 `assertObjectJsonSchema`，再落 `request.outputSchema` | **能**：绝对路径，宿主 `assertUsableCwd` 校验后落 `request.cwd` | `dsh-subagent/lib/index.js:3047`（`prepareContinuable` 存在 ⇒ `startLocal`）；`dsh-subagent/lib/index.js:3311`（`assertCapabilities`）；`dsh-tools/lib/index.js:838`（`defineTool` 编译 DSL）；本地实现：`dispatch_subagent` 的 `ctx.tools.register(defineTool({…}))`（本插件侧不写行号，只写行为契约） |
| **库存 `subagent` 工具**（per-call） | **有条件**：工具行配了 `agentPreset` / `allowedAgentPresets` 才长出 `agent_preset` 参数，且候选只能取这两处的并集 | **有条件**：需工具行 `modelSelectionSettings: true` **且** profile 设置 `enabled=true` **且** `allowedModels` 非空，才出现 `reasoning_effort` | **有条件**：同上（三者同时满足），`provider` 与 `model` 必须成对，实际路由由 `llm.resolveCallConfig` 预检 | **能**：`schema` 直接是参数 | **能**：`cwd` 直接是参数 | `dsh-tool-subagent/lib/index.js:400`（`agent_preset`）、`:414`（`reasoning_effort`）、`:360`（`modelSelectionSettings` 门控）、`:230`（候选 preset 并集）、`:163`（`resolveModelInfo`）、`:314`（配置默认 `false`）、`:386`（`cwd` 参数）、`:463`（透传到 activation） |
| **`workflow` `agent()` + `subagentProvider:'dispatch'`**（per-run） | **能，但按轮**：preset 由 provider 自身在 `start(request)` 里注入；`agent()` 的选项白名单**没有** preset | **能，但按轮**：`effort` 在 `DEFERRED_AGENT_OPTIONS` 里，`agent({effort})` 直接抛 `UNSUPPORTED_OPTION`；唯一来源是 provider 配置的 `reasoningEffort` | **能（按轮配置）**：`agent()` 可按次给 `provider`/`model`（白名单里有），落在 `request.agentOptions`，**优先于** provider 配置值 | **能（按次）**：`agent({schema})` 落 `request.outputSchema` | **不能**：`startChild` 写死 `cwd: await this.cwd`（workflow 自己的目录），`agent()` 无可传 cwd 的选项 | `dsh-workflow-ptc/lib/index.js:327`（`startChild`）、`:330`（`startActivation`）、`:573`（`subagentProvider` 校验）、`:623`（`resolveSubagentProvider`）、`:12`（`WORKFLOW_GUEST_SOURCE` 内嵌源串：`SUPPORTED_AGENT_OPTIONS` / `DEFERRED_AGENT_OPTIONS`） |
| **本插件工具 `workflow` / `run_workflow`**（两个名字，同一实现；per-run，模型可直接调用） | **能，但按轮**：工具先注册一个**本次专用**的 external provider（名字 `dispatch-wf:<uuid>`），把 `preset` 注入它；脚本里每次 `agent()` 拉起的子 run 都挂这个 preset，`agent()` 自己仍没有 preset 选项 | **能，但按轮**：同上，由这个临时 provider 把值放进 `agentOptions.reasoningEffort`；工具在**起 workflow 之前**用 `ctx.llm.resolveModelInfo` 校验档位，不支持就报错并列出支持档位 | **能（按轮）**：`provider`+`model` 必须成对，整轮注进临时 provider；脚本内 `agent({provider, model})` 按次给的值**优先于**工具参数 | **能（按次）**：由脚本里 `agent({schema})` 给，与本工具参数无关 | **不能**：cwd 仍由 workflow 引擎 `startChild` 的 `cwd: await this.cwd` 决定 | `dsh-workflow-ptc/lib/index.js:620`（`start(request)`）、`:623`（`resolveSubagentProvider(..., request.subagentProvider)`）、`:644`（传进 `new PtcWorkflowRun(...)`）、`:331`（子 agent 的 `spec.provider`）、`:574`（名字未注册即拒：`no subagent provider registered for "…"` / `AGENT_START`；所在函数体 `:571-575`）、`:12`（`agent()` 白名单内嵌源串）；`dsh-subagent/lib/index.js:3256`（`registerProvider`）、`:3259`（返回 `ctx.effect(...)` 的 disposer）、`:3260`（同名即 `DUPLICATE_PROVIDER`）；本地实现：同一 `buildWorkflowDefinition` 工厂 + 同一 `executeWorkflow`，`run_workflow` 走插件作用域注册、`workflow` 走同名接管注册进 agent own 层（本插件侧不写行号，只写行为契约） |
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
5. **`run_workflow` 不是新的 per-call 通道，它是 per-run 的第二个入口。** 它做的事和 workflow 自己写
   `subagentProvider` 完全一样（注册一个 provider → 引擎按 run 用它），区别只在**谁发起**：不用改 workflow 脚本，
   模型直接调工具。`agent({effort})` / `agent({preset})` 依然被引擎拒掉——工具没有、也不可能绕过 `agent()` 白名单。
   临时 provider 是**一次调用一份**：名字唯一（`dispatch-wf:<uuid>`）、`finally` 里调 disposer 释放，
   不带 `preset` / `reasoning_effort` / `provider`+`model` 时**不注册**、`subagentProvider` 也不传。

## 结论行

- **`workflow` 与 `run_workflow` 是同一实现的「两个名字」**（0.5.0，同名接管）：同名定义注册进每个已经能看见
  `workflow` 的 agent 的 own 层 ⇒ 库存定义被同名压住 ⇒ 模型调哪个名字都落到同一 `executeWorkflow`
  （`shadowStockWorkflow: false` 可关，关了回到两套入口并存）。表里第 3、4 行是**注入机制**的说明。
- `workflow` `agent()` 的 `reasoning_effort` 只能 **per-run** 生效，**不是 per-call**。
- per-run 现在**两条路**：external provider `dispatch`（workflow 配置 / `subagentProvider`，整轮一套）与工具
  `run_workflow` / `workflow`（模型直接调用，同样是整轮一套）。两者注入的字段完全相同。
- **per-call 在 workflow 侧仍然不可**：`run_workflow` 也没有 per-call preset / effort，它只是把 per-run 配置
  从「改 workflow 脚本 / 配置」变成「一次工具调用」。
- 把 run-level 能力写成 per-call 属**文档错误**，不属配置差异。
- external 通道里的 **`dispatch` provider 本体**（workflow 配置 `subagentProvider: 'dispatch'`）**宿主真机未跑通，待人 smoke**；
  但 `workflow` / `run_workflow` 自带的 per-run 临时 provider 路径已实测（合成 id `dispatch-wf-…`，见「已实测」栏 ②），
  两者走同一 external 机制。本页只描述设计口径，不宣称 `dispatch` 本体已验证。
- peer 支持范围 `>=0.2.1-rc.2 <0.3.0 || >=0.2.2-rc.1 <0.3.0`：0.2.2-rc.1 的下述接缝未变
  （`agent()` 白名单 / `subagentProvider` 口子 / `registerProvider` disposer），依据见
  [`engine-evidence.md`](engine-evidence.md) §9。
