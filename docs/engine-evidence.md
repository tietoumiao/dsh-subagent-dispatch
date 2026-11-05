# 引擎证据（源码 路径:行号 — 原文）

**结论先行**
1. 宿主按「有没有 `prepareContinuable`」分流 local / external；preset、`agentOptions`、`outputSchema`、`maxDepth` 全在
   **本地**路径由宿主挂载，且被 `assertCapabilities` 逐项门控。
2. `workflow` 的 `agent()` **没有** preset / effort 入口（`effort` 在 deferred 列表），所以那边只能 **per-run**。
3. 库存 `subagent` 工具本身**已能**按次给 route / effort（受设置白名单门控），本包不宣称独有。
4. 0.2.2-rc.1 没有动上面这些接缝（比对方法与原文见 §9），所以同一份实现同时支持 0.2.1-rc.2 与 0.2.2-rc.1；
   peer 范围因此写成两个析取项（原因见 §9.5）。

宿主根（桌面版默认安装位置）：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai`
下文 `$D` 指上述目录（与下文 `$H` 同义）。
复现方式：`sed -n '<行>p' "$H/<文件>"`（`H` 即上述目录）。下文行号全部**逐条实测**取过原文。

---

## 1. activation 选路与 external 分支

- `dsh-subagent/lib/index.js:3047` — `return provider.prepareContinuable === void 0 ? manager.startExternal(spec) : manager.startLocal(spec);`
- `dsh-subagent/lib/index.js:1391` — `async startLocal(spec) {`
- `dsh-subagent/lib/index.js:1483` — `async startExternal(spec) {`
- `dsh-subagent/lib/index.js:2998` — `return this.expectProvider(name).start(request);`
  （上下文 `:2996-2998`：`startExternal: (name, request) => { return this.expectProvider(name).start(request); }`）
- `dsh-subagent/lib/index.js:1783` — `childId = run.id;`
- `dsh-subagent/lib/index.js:1787` — `await run.dispose();`
  （上下文 `:1776-1789`：external 分支 `const run = await inputs.start(controller.signal)` → `childId = run.id` →
  `assertChildIdAvailable(childId)`，冲突则 `await run.dispose()` 后抛出 ⇒ 外部 provider **不能**把内层子会话 id 当自己的 `run.id`。）

## 2. capabilities 门控

- `dsh-subagent/lib/index.js:3311` — `assertCapabilities(provider, request) {`
- `dsh-subagent/lib/index.js:3312` — `if (request.agentPreset !== void 0 && (!provider.capabilities.agentPreset || provider.inheritsParentContext)) throw new SubagentError(\`subagent provider "${provider.name}" does not support independent agent preset selection\`, "UNSUPPORTED_CAPABILITY");`
- `dsh-subagent/lib/index.js:3313` — `const needs = [`
  （`:3313-3327` 的 `needs` 表：`request.agentOptions` ⇒ 需 `agentOptions`；`request.outputSchema` ⇒ 需 `outputSchema`；
  `request.maxDepth` ⇒ 需 `depthLimit`；缺则 `UNSUPPORTED_CAPABILITY`。）
- `dsh-subagent/lib/index.js:3316` — `cap: "agentOptions"`

## 3. 父 route 继承

- `dsh-subagent/lib/index.js:293` — `function parentAgentOptionsForDelegation(parent) {`
- `dsh-subagent/lib/index.js:295` — `if (requestConfig === void 0) return { ...parent.options };`
  （`:293-303` 全函数：先取 `parent.session.requestHeader()?.config`，再用它覆盖 `parent.options` 的 provider / model /
  reasoningEffort。因此父 route **可能缺字段**，不能盲信。）

## 4. workflow：startChild、per-run provider、agent() 白名单

- `dsh-workflow-ptc/lib/index.js:327` — `async startChild(request) {`
- `dsh-workflow-ptc/lib/index.js:330` — `const run = await this.subagents.startActivation({`
  （`:330-347` 的 `request` 只有 `cwd` / `prompt` / `parent` / `outputSchema?` / `agentOptions{provider?,model?}`；
  **不带 `agentPreset`，不带 `reasoningEffort`** ⇒ per-run 的 preset / effort 只能由 provider 自己注入。）
- `dsh-workflow-ptc/lib/index.js:336` — `cwd: await this.cwd,`
- `dsh-workflow-ptc/lib/index.js:573` — `if (provider.length === 0 || provider !== provider.trim()) throw new WorkflowError("workflow subagentProvider must be a non-empty normalized string", "INVALID_ARGUMENT");`
- `dsh-workflow-ptc/lib/index.js:623` — `const subagentProvider = resolveSubagentProvider(this.ctx, this.config.provider, request.subagentProvider);`

### `agent()` 的选项白名单与 deferred 项（原文抄录）

> ⚠️ 注意：以下两段**不是**普通源码行，而是 `dsh-workflow-ptc/lib/index.js:12` 这一行
> `const WORKFLOW_GUEST_SOURCE = "..."` 的**内嵌源串**里（该行是一整条 JS 字符串，`\n` 转义）。引用时写成 `:12`，
> 不要把排版后的换行当成真实行号。

- `dsh-workflow-ptc/lib/index.js:12` — `const WORKFLOW_GUEST_SOURCE = "import * as vm from \"node:vm\";`

该行内嵌源串里的关键片段（**按文件里的字符逐个抄**：`\n` 是反斜杠 + `n`，`\"` 是反斜杠 + 引号，缩进是真实制表符）：

```text
SUPPORTED_AGENT_OPTIONS = new Set([\n\t\"label\",\n\t\"phase\",\n\t\"schema\",\n\t\"provider\",\n\t\"model\"\n]);
DEFERRED_AGENT_OPTIONS = new Set([\n\t\"effort\",\n\t\"isolation\",\n\t\"agentType\"\n]);
if (DEFERRED_AGENT_OPTIONS.has(key)) throw new WorkflowError(`agent() option \"${key}\" is deferred and not supported by this engine (supported: label, phase, schema, provider, model)`, \"UNSUPPORTED_OPTION\");
SUPPORTED_AGENT_OPTIONS.has(key)) continue;
```

（去转义后的可读形态：

```js
const SUPPORTED_AGENT_OPTIONS = new Set(["label", "phase", "schema", "provider", "model"]);
const DEFERRED_AGENT_OPTIONS = new Set(["effort", "isolation", "agentType"]);
```

）

## 5. effort 元数据与校验

- `dsh-llm/lib/index.js:2111` — `async resolveModelInfo(provider, model, signal) {`
- `dsh-llm/lib/index.js:2182` — `resolveCallWithInfo(config, info) {`
- `dsh-llm/lib/index.js:2190` — `if (reasoning === void 0) {`
- `dsh-llm/lib/index.js:2191` — `if (requested !== void 0) throw new LlmError(\`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"\`, "UNSUPPORTED_REASONING_EFFORT");`
- `dsh-llm/lib/index.js:2195` — `if (!reasoning.efforts.some((effort) => effort.id === effective)) throw new LlmError(\`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"\`, "UNSUPPORTED_REASONING_EFFORT");`
  （两处同文案不同分支：`:2191` 是模型**未声明** reasoning（`reasoning === void 0`），`:2195` 是声明了但不含该档
  （`reasoning.efforts` 里找不到）。本插件在**派发前**用 `resolveModelInfo` 的 `reasoning.efforts[].id` 复刻这套判定，
  错误信息里列出支持的档位。）

## 6. 工具 schema DSL（`defineTool`）

- `dsh-tools/lib/index.js:721` — `if (Object.hasOwn(input, "items")) tasks.push({`
  （`:721-730`：`items` 递归时带 `allowRequired: false` ⇒ **items 内不许**数组式 `required`，属性级 `required: true` 才合法。）
- `dsh-tools/lib/index.js:802` — `function parameterSchemaSpecToJsonSchema(spec) {`
- `dsh-tools/lib/index.js:838` — `function defineTool(options) {`
  （`:838-849`：`const parameters = parameterSchemaSpecToJsonSchema(options.parameters);`
  `const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);` —— 参数与输出都过 DSL，且必须给 `output.render`。）

## 7. 库存 subagent 工具的按次能力（门控事实）

- `dsh-tool-subagent/lib/index.js:163` — `const model = await llm.resolveModelInfo(provider.id, request.model, signal);`
- `dsh-tool-subagent/lib/index.js:230` — `const ids = new Set([...this.config.agentPreset === void 0 ? [] : [this.config.agentPreset], ...this.config.allowedAgentPresets ?? []]);`
- `dsh-tool-subagent/lib/index.js:314` — `modelSelectionSettings: z.boolean().default(false),`
- `dsh-tool-subagent/lib/index.js:360` — `const modelSelectionCapable = config.modelSelectionSettings === true;`
- `dsh-tool-subagent/lib/index.js:400` — `...presets.choices === void 0 ? {} : { agent_preset: {`
- `dsh-tool-subagent/lib/index.js:414` — `reasoning_effort: {`
  （⇒ 库存工具确实有 `agent_preset` / `reasoning_effort` 参数，但 `agent_preset` 只为配置里声明的候选长出来，
  `reasoning_effort` 只在 `modelSelectionSettings` + 设置 `enabled` + `allowedModels` 同时成立时出现。）

## 8. 库存 `spawn` provider（external 通道的默认委派目标）

- `dsh-subagent-spawn-in-process/lib/index.js:12` — `const Config = z.object({ providerName: z.string().default("spawn") });`
- `dsh-subagent-spawn-in-process/lib/index.js:21` — `capabilities = {`
  （`:21-26`：`agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true`；`:27` `inheritsParentContext = false`；
  `:32` `return Promise.resolve({});` ⇒ 本地 provider，`prepareContinuable` 空 seed。）

---

## 9. 0.2.2 适配

**本节的用途**：判「0.3.0 这一份实现能不能同时挂到 0.2.1-rc.2 与 0.2.2-rc.1 上」。答案取决于三个接缝有没有动：
`agent()` 选项白名单、`subagentProvider` 每轮口子、`registerProvider` 的 disposer 语义。三条都**没动**，
外加两条与 `run_workflow` 的 `max_total_agents` / 返回值形状有关的事实（9.6）。

### 9.1 比对方法（四步，都可复现）

0.2.2-rc.1 的源码是 npm 包里的 `lib/index.js`，解在 `_tmp\v022\`，文件名带 `__lib_index.js` 后缀：
`dsh-subagent__lib_index.js`、`dsh-workflow-ptc__lib_index.js`、`dsh-tools__lib_index.js`、
`dsh-tool-workflow__lib_index.js`（另有 `dsh-tool-workflow__package.json`，其 `version` 为 `0.2.2-rc.1`，
是本节「这批文件确实是 0.2.2-rc.1」的锚点）。0.2.1-rc.2 一侧取本机安装根 `$H`。

1. **整文件 diff**：`diff "$H/<pkg>/lib/index.js" "_tmp/v022/<pkg>__lib_index.js"`。为了不被第 12 行的巨串
   带偏，实践上先把第 12 行换成占位符再 diff（否则它算「一行删、一行加」）。结果——**两种口径分开写，别混用**：
   `dsh-tool-workflow` 两版**逐字节相同**（任何口径都是 0 减 0 增）；`dsh-workflow-ptc` 不屏蔽任何行时是
   2 减 6 增，按上述方法屏蔽第 12 行（`WORKFLOW_GUEST_SOURCE` 巨串）后是 1 减 5 增（PTC 的 `programFormat`
   三元表达式改成三分支查表）；`dsh-subagent` **原始 diff 是 13 减 28 增**，同一脚本把第 12 行换成占位符后是
   **14 减 29 增**（该文件第 12 行是 `import` 行、不是巨串，屏蔽它只改变 diff 的对齐；语义改动清单按原始
   13 减 28 增读：settlement 消息新增 `omitClosingText`、`Service.init` 里改 `sessionProjections` 注册）。
   `dsh-tools` 的 0.2.2 包是分块产物
   （开头是 `import { a as ToolNotFoundError, ... }`，665 行对 3 810 行），**行号不可比**，本节不引用它的行号。
2. **guest 源串单独比**：`WORKFLOW_GUEST_SOURCE` 是 `dsh-workflow-ptc/lib/index.js:12` 上的**一整条字符串**，
   整文件 diff 会把它当成一行，看不出里面改了什么。取两版第 12 行，用 `indexOf` 定位块并逐字节比较：
   从 `const SUPPORTED_AGENT_OPTIONS = new Set([` 起的 **108 字符前缀（整块 114 字符）**逐字节相同
   （108 = 整块 114 字符去掉开头的 `const `；两版该字面量整块都是 114 字符且逐字节一致），`DEFERRED_AGENT_OPTIONS` 同理。
   整行长度确实不同（0.2.1-rc.2 为 40 815、0.2.2-rc.1 为 40 558 字符）；`agent()` 相关的片段
   （`async agent(rawPrompt, rawOpts) {`、`readAgentOptions(rawOpts) {`、两处 `return null`）两版**都在**。
   本节**没有**逐段穷举那 257 个字符差在哪（realm / materialize 一段明显重写过），所以结论只声明到
   「白名单块逐字节相同」这一层，不外推到「guest 源串整体没变」。
3. **逐行取原文**：`sed -n '<行>p' <文件>`（0.2.2-rc.1 一侧对 `_tmp\v022\*.js`）。
4. **peer 范围单独实测**：这不是源码比对，见 9.5。

> 说明：`_tmp\v022\` 是本次比对的临时解包目录，不在仓库里；上面四步是重跑方式，别引用目录本身当证据。

### 9.2 结论一：`agent()` 的选项白名单**未变**

原文（`_tmp\v022\dsh-workflow-ptc__lib_index.js:12`，guest 源串内，**转义原样**）：

```text
const SUPPORTED_AGENT_OPTIONS = new Set([\n\t\"label\",\n\t\"phase\",\n\t\"schema\",\n\t\"provider\",\n\t\"model\"\n]);
const DEFERRED_AGENT_OPTIONS = new Set([\n\t\"effort\",\n\t\"isolation\",\n\t\"agentType\"\n]);
```

`\n` 是反斜杠 + n，`\t` 处是**真实制表符**，`\"` 是反斜杠 + 引号 —— 整行 40 558 字符，别按排版断行当真实行号。

去转义后的可读形态（与 §4 同一份）：

```js
const SUPPORTED_AGENT_OPTIONS = new Set(["label", "phase", "schema", "provider", "model"]);
const DEFERRED_AGENT_OPTIONS = new Set(["effort", "isolation", "agentType"]);
```

判定依据两条：

- 0.2.2-rc.1：`_tmp\v022\dsh-workflow-ptc__lib_index.js:12` 含上面两个 Set。
- 0.2.1-rc.2：`$H/dsh-workflow-ptc/lib/index.js:12` 含同样两个 Set，且两版的
  `SUPPORTED_AGENT_OPTIONS` 字面量**逐字节相同**（**108 字符前缀，整块 114 字符**，两版各 114 字符）。

⇒ `run_workflow` 依然**不能**让脚本写 `agent({ effort })`（抛 `UNSUPPORTED_OPTION`），preset / effort 只能靠
run 级 `subagentProvider` 注入。

### 9.3 结论二：`subagentProvider` 的每轮口子**仍在**

- `_tmp\v022\dsh-workflow-ptc__lib_index.js:575` — `function resolveSubagentProvider(ctx, configured, override) {`
- `:576` — `const provider = override ?? configured;`
- `:577` — `if (provider.length === 0 || provider !== provider.trim()) throw new WorkflowError("workflow subagentProvider must be a non-empty normalized string", "INVALID_ARGUMENT");`
- `:578` — `if (ctx.subagents.getProvider(provider) === void 0) throw new WorkflowError(\`no subagent provider registered for "${provider}"\`, "AGENT_START");`
  （⇒ 名字必须在 `start()` 里**已经注册**；临时 provider 必须在 `start` 之前注册，不能延后。）
- `:624` — `start(request) {`（引擎入口）
- `:627` — `const subagentProvider = resolveSubagentProvider(this.ctx, this.config.provider, request.subagentProvider);`
  （⇒ `request.subagentProvider` 仍然**压过**引擎配置里的 `provider`，这就是 `run_workflow` 的注入口。）
- `:648` — `const run = new PtcWorkflowRun(runCtx, subagents, runCtx.ptcRuntime, id, meta, request.parent, init, subagentProvider, ...)`
- `:330` — `const run = await this.subagents.startActivation({`，`:331` — `provider: this.provider,`
  （⇒ 每个 workflow 子 agent 的 activation `spec.provider` 就是这个 run 级的 provider。`startChild` 的
  `request` 仍只有 `cwd` / `prompt` / `parent` / `outputSchema?` / `agentOptions{provider?,model?}`，
  **不带** `agentPreset`、**不带** `reasoningEffort`。）

### 9.4 结论三：`registerProvider` 返回 **cordis effect disposer**

- `_tmp\v022\dsh-subagent__lib_index.js:3269` — `* @returns the exact Cordis effect disposer.`
- `:3271` — `registerProvider(provider) {`
- `:3274` — `return this.ctx.effect(function* () {`
- `:3275` — `if (this.providers.has(name)) throw new SubagentError(\`a subagent provider named "${name}" is already registered\`, "DUPLICATE_PROVIDER");`
- `:3277-3280` — `yield () => { this.providers.delete(name); this.emitLifecycle("subagent/provider-removed", name); };`

⇒ 返回值**就是** `ctx.effect(...)` 的 disposer，调用一次即注销该名字；重复注册同名 provider 会抛
`DUPLICATE_PROVIDER`。`run_workflow` 因此必须每次用一个唯一名字（`dispatch-wf:<uuid>`），并在 `finally`
里调一次 disposer。

同源的选路事实（两版一致，只是行号位移）：`_tmp\v022\dsh-subagent__lib_index.js:3062` —
`return provider.prepareContinuable === void 0 ? manager.startExternal(spec) : manager.startLocal(spec);`
⇒ **不实现** `prepareContinuable` 才是 external 通道，这条判据 0.2.2-rc.1 没变。

### 9.5 peer 范围：为什么要写成两个析取项

`peerDependencies` 的值是 `>=0.2.1-rc.2 <0.3.0 || >=0.2.2-rc.1 <0.3.0`。第二个析取项不是冗余 ——
用**宿主安装根自带的** semver 实测（在 `$H/..` 下 `node -e "require('semver').satisfies(...)"`，
即 `resources\app\dsh\node_modules\semver`；这是比对用的现成库，不是本插件的依赖）：

```text
satisfies("0.2.2-rc.1", ">=0.2.1-rc.2 <0.3.0")                        → false
satisfies("0.2.2-rc.1", ">=0.2.1-rc.2 <0.3.0 || >=0.2.2-rc.1 <0.3.0")  → true
satisfies("0.2.1-rc.2", "… 同上析取 …")                                 → true
satisfies("0.3.0",      "… 同上析取 …")                                 → false
```

原因：npm semver 的 prerelease 规则是「只有当一个比较符与目标版本共享同一个 `[major,minor,patch]` 元组、
且该比较符带 prerelease 时，prerelease 版本才可能满足该范围」。`>=0.2.1-rc.2 <0.3.0` 里唯一带 prerelease
的比较符是 `0.2.1-rc.2`（元组 `0.2.1`），对 `0.2.2-rc.1`（元组 `0.2.2`）不开放 ⇒ 必须补
`>=0.2.2-rc.1 <0.3.0` 这个析取项。`scripts/check.mjs` 用一个自写的最小比较（不引外部 semver 包）钉住这条断言。

**宿主口径（同样是实测）**：宿主 `evaluatePluginCompatibility`（`dsh-app-boot/lib/index.js:311`）经
`unmetRequirements` 调用 :276-278 的 `satisfies` 辅助函数，而它是
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。带上这个选项后，
`satisfies("0.2.2-rc.1", ">=0.2.1-rc.2 <0.3.0")` 实测为 **true**（上面代码块第一行的 `false` 只是
npm/pnpm 默认规则的结果）。因此在**宿主侧** `>=0.2.1-rc.2 <0.3.0` **单项就够**；第二个析取项
`>=0.2.2-rc.1 <0.3.0` **是为 npm/pnpm 默认 prerelease 规则准备的**（`pnpm install` 解析
`peerDependencies` 时不带该选项）。

### 9.6 另两条与 `run_workflow` 直接相关的事实

- **`request.maxTotalAgents` 是 `start()` 的输入口，不是脚本能改的东西**：
  `_tmp\v022\dsh-workflow-ptc__lib_index.js:628` — `const maxTotalAgents = resolveMaxTotalAgents(request.maxTotalAgents, this.config.maxTotalAgents);`
  `:584` — `if (!Number.isSafeInteger(requested) || requested < 1) throw new WorkflowError("workflow maxTotalAgents must be a positive safe integer", "INVALID_ARGUMENT");`
  `:585` — `if (requested > ceiling) throw new WorkflowError(\`workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}\`, "INVALID_ARGUMENT");`
  `:604` — 引擎配置默认 `maxTotalAgents: z.natural().min(1).default(1e3)`。
  （⇒ `run_workflow` 的 `max_total_agents` 只能**降到**引擎 ceiling 以下，超了在 `start()` 就报错。）
- **`agent()` 的失败是 `null`，不是抛错**：`_tmp\v022\dsh-workflow-ptc__lib_index.js:12`（guest 源串内）里
  `if (result.structured === void 0) {` 分支与「`stopReason` 非 `completed`」分支都返回 `null`。
  ⇒ `run_workflow` 的结果里出现 `null` 属**子 run 失败**，不是插件吞错；插件只负责把 `run.result` 原样带出。

### 9.7 引擎在哪个作用域：必须用 `agentPresets.serviceFor(agent, 'workflowEngine')`

`workflowEngine` 注册在 agent 的 **isolated preset group**（preset 的独立作用域）里（profile 的 `workflow-ptc`
行落在 preset 的 plugins 列表内），而本插件由 bundle patch **插在全局**。Cordis 的 `get()` **只向上找，不向旁支 /
子挂载找**，所以两层都取不到：

- 插件全局 ctx 的 `ctx.workflowEngine` / `ctx.get('workflowEngine')` 看不到；
- 调用方 agent 的 `agent.ctx.workflowEngine` / `agent.ctx.get('workflowEngine')` **同样看不到**——agent.ctx 与
  preset 的 isolated group 是并列挂载，不是父子链。

真机现象（上一版只改到 agent.ctx 后重启仍复现）：

```text
Error: run_workflow: this host exposes no workflow engine (workflowEngine.start is undefined) — tried, in order:
the calling agent's context (agent.ctx.workflowEngine, agent.ctx.get('workflowEngine')) and this plugin's context (...)
```

宿主自己的读法在 preset registry 服务上：

- `$H/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:725` —
  `serviceFor(agent, name) {`
  ```js
  const mount = this.generationFor(agent.ctx)?.mount;
  return mount === void 0 ? void 0 : serviceForMount(this.owner, mount, name);
  ```
  文档注释原文：**"Read a service supplied inside an Agent's isolated preset group."**
  （`serviceForMount` 在 `:136`。）它先拿 agent 所属 generation 的 mount，再从**那个 mount** 读服务——这正是
  `agent.ctx` 与插件 ctx 都走不到的 scope。

⇒ **`run_workflow` 的第一顺位是 `ctx.get('agentPresets')`（取不到再试 `ctx.agentPresets`）→
`.serviceFor(agent, 'workflowEngine')`，然后才回落 agent.ctx / 插件 ctx。**
解析顺序固定为 ① `agentPresets.serviceFor(agent, 'workflowEngine')` → ② `agent.ctx.workflowEngine` →
③ `agent.ctx.get('workflowEngine')` → ④ `ctx.workflowEngine` → ⑤ `ctx.get('workflowEngine')`；
每一层都要求候选对象的 `start` 是可调用函数，拿到对象但 `start` 不是函数时**继续往下找**，不提前返回；
`serviceFor` 不存在（老宿主）或抛错都**静默回落**，不改变工具的可调用性。

证据：`scripts/check.mjs` 的 `WF_ENGINE_PRESET_SCOPE`（两层 ctx 都空，只有 `serviceFor` 给引擎，断言
`serviceFor` 1 次、`start` 1 次、agent.ctx 0 次读取）/ `WF_ENGINE_SERVICEFOR_THROWS` /
`WF_ENGINE_SERVICEFOR_NOT_CALLABLE`，以及 `_tmp\verify-engine-scope2\probe.mjs`（真实 `defineTool` + 假 ctx
的 `apply()` → `run_workflow.execute()` 全链路探针）。

### 9.8 这一节**没有**验证的

- 本机装的仍是 **0.2.1-rc.2**，0.2.2-rc.1 只做了**静态源码比对**，没有把插件装到 0.2.2-rc.1 上跑过。
- `_tmp\v022\` 是解包产物，不是 npm 完整依赖树；「0.2.2-rc.1 的 `dsh-tools` 行号」这类需要行号一致的断言，
  本节一律不写。
- 9.2 ~ 9.4 的三条结论只覆盖**这几个接缝**；`dsh-subagent` 其余改动（settlement / projections）是否影响
  本插件的子 agent 收尾，**未验证**（本插件不读那些字段，但也没有实跑证据）。

---

## 10. 库存 `dsh-tool-workflow` 的对外可观察能力（0.5.0「两个名字」的对齐依据）

**本节用途**：**`workflow` 与 `run_workflow` 是同一实现的两个名字**。库存 `workflow` 工具
（`@deepseek-ai/dsh-tool-workflow`）的五项对外可观察能力——后台 job、进度事件、运行记录、结果截断、
systemPrompt 指引——由本插件等价实现；库存工具本身由**同名接管**（0.5.0）在 agent 的 own 作用域里被同名压住，
模型调 `workflow` 即**真重定向**到本插件的 `executeWorkflow`（`shadowStockWorkflow: false` 可关，见 §10.5；
v0.4.0 的旧做法是 `ctx.tools.guard` 执行期拒绝，现只作兜底，见 §10.3）。

**行号口径（重要）**：本节行号**全部**取自宿主安装根 0.2.1-rc.2 的
`$H/dsh-tool-workflow/lib/index.js`（下文 `$T`，442 行），每条都能用 `sed -n '<行>p' "$T"` 复现原文；
**本插件侧只写行为契约，不写行号**——插件文件每次改动行号都会漂移，写进文档第二天就是假证据。

### 10.1 清单：能力 → 库存位置 → 本插件等价实现

| 能力 | 库存位置（`sed` 可复现） | 原文要点 | 本插件等价实现（行为契约） |
|---|---|---|---|
| 进度镜像（mirror，写 job 输出环） | `:19-45`（`createWorkflowRecordMirror`）、`:21` / `:27` / `:30` / `:33` | 订阅四个 `workflow/*` 事件；`workflow/phase` 调 `job.updateProgress(title)` 并 `job.append('▸ …', { channel: 'log' })`，其余三类只 `append(…, { channel: 'log' })` | 等价 mirror：订阅同名同形状的四事件，写进 job 输出环（phase 同时更新 progress 行） |
| 运行记录（recorder，写 session） | `:83-130`（`createWorkflowRecorder`）、`:95` / `:106`（两个 agent 事件）、`:98` / `:109` / `:117` / `:124`（四条记录类型） | 记录类型 `tool-workflow/agent-start` / `agent-end` / `run-start` / `run-end`；`append` 抛错只 `ctx.logger.warn` 一次并停用该 run（`:89-93`） | 等价 recorder：同样的四条记录类型 + 同样的「记录失败不影响工具执行」语义 |
| 后台 job 注册 | `:217-258`（`startBackgroundRun`）、`:224`（`jobs.start`）、`:225`（`kind`）、`:226`（`label`）、`:227`（`owner`）、`:228`（`toolCall`） | `jobs.start({ kind: 'workflow', label: args.meta.name, owner: parent.id, toolCall, run })`；`jobs` 缺失抛 `:220` 的固定错误串 | 同形注册：`kind: 'workflow'`、`owner: parent.id`、`toolCall: { callId, rootCallId }`；`jobs` 缺失抛同风格可读错 |
| 后台 run 归属 | `:229-235`（`run(handle)` 内同步起引擎，**不传** `exec.signal`） | run 归 job 所有；取消只由 registry kill / owner teardown 触发 | 同形：后台分支不起 tool-step signal，取消权在 job |
| 取消链 | `:239-241`（`cancel: (reason) => run.cancel(reason ?? 'background workflow job killed')`） | job 的 `cancel` 调 `run.cancel` | 同形：`job_kill` → `jobs.kill` → `hooks.cancel` → `run.cancel('background workflow job killed')`（宿主侧 `dsh-tool-jobs/lib/index.js:406` → `dsh-jobs-local/lib/index.js:644-655` `killJob` → `job.cancel(reason)`） |
| 结算语义 | `:242-254`（`done`）→ `:178-196`（`jobOutcomeOf`） | `done`：先 `run.dispose()`（失败只 warn `:245-247`）、mirror 停、recorder finish+abandon，再 `jobOutcomeOf(result, meta.name, maxResultChars)`；completed → `{status:'completed', detail:'N agent(s)', result: 截断文本}`（`:180-184`），cancelled → `{status:'killed'}`（`:185`），error → `{status:'failed', detail}`（`:186-189`） | 同形：结算顺序与三种 stopReason 映射一致 |
| 结果截断 | `:68`（`maxResultChars: z.natural().min(1).default(5e4)`）、`:198-202`（`renderResult`）、`:382`（render 用同一函数） | 前缀 `workflow "<name>" completed (N agent(s)).\nReturn value:\n`；超长 `rendered.slice(0, maxChars) + '\n… [truncated: N more characters]'` | 同函数语义：配置项 `maxResultChars` 默认 50000，前台 render 与后台 job 结果都走同一 `renderResult`，后缀逐字相同（`… [truncated: N more characters]`） |
| systemPrompt 指引 | `:64-66`（`inject` 含 `systemPrompt`）、`:265-269`（`ctx.systemPrompt.section`）、`:267`（`order`） | `order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW')`；`name: 'tool:' + toolName`；text 指向本工具 | 注册一条同类 section：`order` 取 `TOOL_WORKFLOW`（= **2600**，`dsh-system-prompt/lib/index.js:31`；`getSectionOrder` 定义 `:262`），text 明确「workflow 请用 `run_workflow`」 |
| 输出 schema | `:339-379`（`oneOf` 两支）、`:380-383`（render）、`:417-422`（前台返回值 `kind: 'foreground'`） | 两支 `oneOf`：`background`(`jobId`/`runId`) 与 `foreground`(`runId`/`agentsStarted`/`result`)，各支 `additionalProperties: false` | 同形 `oneOf` + 同形 render（后台文案点名 `job_output` / `job_kill`） |
| 参数 | `:333-335`（`run_in_background`） | 布尔、默认 false；`true` 才走后台 | 同名参数 `run_in_background`（默认 false） |
| systemPrompt 顺序常量 | `dsh-system-prompt/lib/index.js:31` | `TOOL_WORKFLOW: 2600,` | 直接复用该常量取序，不自造数值 |

### 10.2 四个进度事件：同名、同形状、同一总线

事件由**引擎**在共享 cordis 总线上发出，本插件**不自造事件**（自造会让 UI 与 `job_output` 看到两套口径）：

- `workflow/phase` — `$T:21`，载荷 `(info, title)`，`info.id` 即 runId；库存动作 = `job.updateProgress(title)` + `job.append('▸ ' + title + '\n', { channel: 'log' })`。
- `workflow/log` — `$T:27`，载荷 `(info, message)`，只 `append(message + '\n', { channel: 'log' })`。
- `workflow/agent-start` — `$T:30`，载荷 `(info, agent)`，写 `agent #<seq> <label> started`。
- `workflow/agent-end` — `$T:33`，载荷 `(info, agent)`，写 `agent #<seq> <outcome>`。

写进 job 输出环的那批 chunk 的 `channel` 是 `'log'`，而 `dsh-tool-jobs/lib/index.js:62`
是 `chunks.filter((chunk) => chunk.channel !== 'log')` ⇒ 这批叙事**不进模型可见的 `job_output` 文本**，
只喂 UI 运行视图与 `job_output` 的结构化进度行；同一批事件另由 recorder 落成 durable session 记录（§10.1 第 2 行）。

### 10.3 guard 语义：执行期拒绝（**v0.4.0 的旧做法**，0.5.0 起只作兜底）

> **口径提醒**：0.5.0 起 `workflow` 这个名字由**同名接管**（§10.5）真重定向到本插件的 `executeWorkflow`。
> 下面这条 `ctx.tools.guard` 路径只在两种情况下仍然是行为主体：① 某个 agent 的 own 层已放着**别人**的同名工具
> （接管注册撞 duplicate，只能退成拒绝）；② `shadowedToolNames` 里**非接管名**的库存名（默认过滤后为空）。

- 注册：`dsh-tools/lib/index.js:3017-3022` — `guard(guard) { return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), { label: 'tools.guard()', notify: false }); }`。
- 执行期：`dsh-tools/lib/index.js:3024-3032` — `guardReason(exec)`：全局层 guard 先判，再 `chainLayers(exec.agent)` 逐个
  `const reason = guard(exec); if (reason !== void 0) return reason;` ⇒ 返回串即拒绝，返回 `undefined` 放行；
  **没有 guard 能强制放行**（`:3008-3013` 注释原文）。因为全局层先判，接管名必须从全局拒名单里剔出，
  否则会把本插件自己注册的 own 层定义一起拒掉。
- 结论：guard 只能**拒绝执行**，不能摘掉工具列表里的条目；而 0.5.0 的接管是**同名替换定义**（§10.5），
  两者不是一回事——文档不许把接管写成「隐藏」，也不许把兜底 guard 写成主要机制。

### 10.4 与库存的差异（等价实现口径）与未验证项

**差异（不是缺陷，必须写明）**

1. **recorder 依赖 `parent.session.append`**：宿主未暴露可追加的 session 时，本插件的 `recorder.start` 返回 `false`、
   该 run 不记录（后续 `finish` / `abandon` 空转，不抛错）；`append` 抛错只 `warn` 一次并停用该 run（同库存 `:89-93`）。
   库存无条件读 `parent.session.append`（没有 `typeof` 守卫）。⇒ 记录的**可用性**取决于宿主；
   该差异必须留在本节与 0.4.0 的 change-notes 里。
2. **插件侧落点不写行号**：见本节开头的行号口径。本节所有行号证据是**库存源码**，不是本插件源码。
   本插件的实现与用例状态以 `lib/index.js` / `scripts/check.mjs` 的当前版本为准。
3. **`jobs` 注册表的读法**：库存用 `ctx.get('jobs')`；本插件按「`ctx.get('jobs')` 取不到再试 `ctx.jobs`」探测，
   只在 `run_in_background: true` 分支缺 `jobs` 时报错，前台完全不受影响。

**未对齐 / 未验证（禁止读成已对齐）**

- **已对齐（口径写死）**：接管生效时，工具列表里那一条 `workflow` 的定义**就是本插件这份**（own 覆盖 inherited，
  §10.5 事实 1）。「列表里还有 `workflow`」是设计如此，不是残留。
- **未对齐（已知边界）**：`restrict` 若在**接管之后**才施加，own 层定义豁免 restriction（`:3040-3041`），该 agent 仍看得见
  我们的 `workflow`；接管**之前** deny 的 agent 则 `get(...) === undefined` ⇒ 跳过。
- **未对齐**：本插件不导出 `Config` schema（`cordis.patch.yml:11` 原文 `The plugin does NOT export a Config`），
  库存导出 `Config`（`$T:66-70`）；
  能力等价、形态不等价。
- **未验证**：UI 工具卡片 / workflow 运行视图是否真能看到这批进度事件——**没有真机点验**（只有假 ctx 探针）。
- **未验证**：真机 `job_kill` 端到端取消引擎 run——**没有在宿主实跑**，取消链是源码 + 假 registry 断言的。
- **未验证**：`systemPrompt` section 是否真的进到最终 prompt（order 2600 是否正确落位）——同样只有探针。

### 10.5 0.5.0 同名接管的宿主依据（own 覆盖 inherited / `get(name, agent)` 预检 / `agent/created`）

0.5.0 用**同名接管 = 真重定向**替换 §10.3 记录的 v0.4.0 旧做法（执行期拒绝）：`workflow` 这个名字在 agent 的 own 层解析到本插件的定义，
库存 `workflow` 被同名压住。下面六条宿主事实是本方案的**判定依据**（不是启发式），行号全部取自宿主安装根
0.2.1-rc.2 的 `$H/dsh-tools/lib/index.js` 与 `$H/dsh-tool-cordis/lib/types/api-catalog.js`，
`sed -n '<行>p'` 可复现；本插件侧仍只写行为契约、不写行号。

| # | 事实 | 位置 | 要点 / 原文 |
|---|---|---|---|
| 1 | **own 覆盖 inherited** | `dsh-tools/lib/index.js:3055-3074`（`view(scope)`） | `:3058-3062` 先把 global 层 + 祖先链合并成 `inherited`（`if (layer === own) continue;` 跳过 own 层）；`:3066-3070` 只对 inherited 做 `layers.every((layer) => layer.admits(name))` 过滤；**`:3071-3074` 再用 own 层的每一条 `visible.set(name, definition)` 覆盖** ⇒ 在 agent 的 own 层注册同名 `workflow` 就压住了 preset 层（祖先层）里的库存定义 |
| 2 | **restriction 只过滤 inherited，不过滤 own 层** | `:3040-3041`（`view` 上方注释）、`:3002`（`restrictableNames` 取自 `view(scope)`）、`:3066-3070` | 注释原文 “A restriction filters what a scope inherits — the global layer and every ancestor layer on its chain — and never what its OWN layer registers.” ⇒ ① 被 `restrict({ deny: ['workflow'] })` deny 的 agent 在 `get` 时**看不到**该名（我们据此**跳过**，不制造能力扩张）；② 反向：接管**之后**才施加的 restriction 摘不掉 own 层那份定义（已知边界，§10.4） |
| 3 | **`get(name, scope)` 就是「该 agent 现在看得见什么」** | `:3091-3092` | `get(name, scope) { return this.view(scope).visible.get(name); }` ⇒ 接管预检 `runtimeCtx.tools.get(takeoverToolName, agent) === undefined` 精确等价于「这个 agent 本来就没有这个名字」，是「重定向 ≠ 能力扩张」的判定依据；`scope` 省略时才是全局视图 |
| 4 | **`agent/created` 允许逐 agent 初始化，listener 抛错即打掉创建** | `dsh-tool-cordis/lib/types/api-catalog.js:3956-3960` | `mode: 'serial'`，payload `{ agent, source, signal? }`；描述原文 “Listeners run in order and are awaited before creation resolves… A throw or rejection fails creation and skips later listeners.” ⇒ 接管逻辑必须**整段 try/catch**（「不抛」是硬要求，不是风格） |
| 5 | **`agent/disposed` 是释放逐 agent 注册的时点** | `api-catalog.js:3964-3969` | `mode: 'emit'`，payload `{ agent }`；描述原文 “…emits this after driver quiescence and scoped-registration unwind, but before session detachment.” 宿主自己的写法：`agent.ctx.inject(...)` 的 fiber 存进 `scopedInstalls`（`dsh-tool-subagent/lib/index.js:585-593`），`agent/disposed` 里 `removeScoped` + `fiber.dispose()`（`:592-603`、`:605-610`），另在 `tools/change` 上重扫（`:601-612`）——本插件照抄这三件 |
| 6 | **「同一实现」不能靠函数对象同一证明** | `dsh-tools/lib/index.js:838`（`defineTool` 入口）、`:857-859`（`output.render` 包装）、`:866-870`（`execute` 包装） | `defineTool` 每次都新建 `output.render` 闭包与 `async execute(args, exec) { const violations = validate(args); …; return userExecute(args, exec); }` 闭包 ⇒ 同一个 `executeWorkflow` 传两次，产出的 `def.execute` 仍是**两个不同函数对象**。所以证据只能是「行为委托（两条路径各真跑一次）+ 同一 `sharedExecute` 标记 + 参数表 / `output.schema` 深等」，**禁止**写 `a.execute === b.execute` |

**由此得到的插件侧行为契约（本插件不写行号）**：`agent/created` 里 `await agent.ctx.inject(['tools'], runtimeCtx => …)` →
回调内 `runtimeCtx.tools.get(takeoverToolName, agent)` 预检（`undefined` ⇒ 跳过）→ own 层
`register(buildWorkflowDefinition(takeoverToolName, shared))`（`shared` 里就是唯一实现 `executeWorkflow`）；own 层已有
带 `takeoverMarker` 的定义 ⇒ **采纳**（不重复注册、不转拒绝）；own 层是**别人**的同名 ⇒ 撞 duplicate，只在该 agent 上加
兜底 `tools.guard`。`agent/disposed` 释放该 agent 的 fiber，插件级 effect 在 unload 时释放全部接管，`tools/change` 与存量
`agents.list()` 补扫保证幂等（`inFlight` 同步锁 / B 态不写 `adopted` 以便重试）。

---

## 结论（写死）

- **workflow `agent()` 的 `reasoning_effort` 只能 per-run 生效，不是 per-call**：`effort` 在 `DEFERRED_AGENT_OPTIONS`
  里，`agent({effort: ...})` 抛 `UNSUPPORTED_OPTION`；`startChild` 的 activation request 里也没有 `agentPreset` /
  `reasoningEffort` 字段。因此本包为 workflow 提供两条 per-run 路：external provider `dispatch`（整轮注入，
  workflow 自己调），和工具 `run_workflow`（同样的注入，但注册一个本次专用 provider，模型可直接调用）。
- **`run_workflow` 先经 `agentPresets.serviceFor(agent, 'workflowEngine')` 读 isolated preset group 里的引擎，
  再回落 agent.ctx / 插件 ctx**：引擎装在 preset 的 plugins 列表里时，两层 ctx 都看不到它（Cordis `get()` 只向上找），
  只有 registry 的 `serviceFor` 能按 agent 的 generation mount 取到（§9.7，
  `dsh-agent-preset-registry/lib/index.js:725`）。
- 本插件的 per-call 通道是工具 `dispatch_subagent`，backend 固定本地 provider（有 `prepareContinuable` ⇒ 走
  `startLocal`；0.2.1-rc.2 在 `:3047`、0.2.2-rc.1 在 `:3062`），所以 preset / agentOptions / outputSchema 由宿主挂载，
  结构上不触发 external 的 `childId = run.id` 冲突。
- external provider 返回**合成 id** `dispatch:<uuid>`，不取内层 `childId`（0.2.1-rc.2 `:1783-1789`；
  0.2.2-rc.1 `:1789` `childId = run.id;`、`:1793` `await run.dispose();`）。
- **0.5.0 起 `workflow` 与 `run_workflow` 是同一实现的两个名字**：库存 `workflow` 工具的后台 job / 进度事件 / 运行记录 /
  结果截断 / systemPrompt 指引五项对外可观察能力由本插件等价实现（§10 逐条给出库存行号与原文要点），
  库存工具的名字由**同名接管**在 agent own 层压住（`shadowStockWorkflow: false` 可关，宿主依据见 §10.5）。
  **接管 ≠ 工具列表隐藏**：那一条 `workflow` 的定义换成了本插件这份，调用是**真执行**；
  执行期拒绝（guard）只作兜底（§10.3，v0.4.0 的旧做法）。

## 未验证项（诚实边界）

- **`dispatch` provider 本体真机仍未跑通，待人 smoke**：`scripts/check.mjs` 只断言**委派请求形状**（`delegateProviderName`、
  注入的 preset/effort/model、合成 `dispatch:<uuid>`、`dispose` 转发一次）与假 ctx 的调用次数；
  `dispatch` 本体的 UI 投影与收尾等价性、`resident`/ownership 事件身份的实际效果，均**未验证**。
  （`workflow` / `run_workflow` 自带的 per-run 临时 provider 路径已实测：② 的子会话头 `agentPreset: "minimal"`。）
- 库存 `subagent` 工具的 route/effort 参数在本机 profile 设置下是否真的开放，取决于 profile 的
  `modelSelectionSettings` + `enabled` + `allowedModels`；本文档只引用源码门控事实，**未**在本机实跑这些参数。
- **0.2.2-rc.1 只做了静态源码比对，没在本机跑过**：本机装的是 0.2.1-rc.2，§9 的三条结论来自两版源码的
  逐字节/逐行对比，没有「装到 0.2.2-rc.1 上实跑」的证据。
- **已实测：真机双通道（0.5.0 同名接管后，2026-11-06）**——`workflow` 与 `run_workflow` 在活宿主上都完成；证据是解
  `.dsh/sessions/.../session.v4.jsonl.zstd` 后的**子会话头 `agentPreset`**（不是工具回显）：① `workflow(script, meta)`
  （不传 `preset`）⇒ 子会话 `c64608b7-…` 头 `agentPreset: "cordis"`（继承调用方）；②
  `workflow(script, meta, preset:"minimal", reasoning_effort:"low")` ⇒ 子会话 `f255b1b5-…` 头 `agentPreset: "minimal"`；
  ③ `run_workflow(...)` 更早一轮可用 ⇒ 子会话 `282820af-…` 头 `agentPreset: "cordis"`。三次 run 的 `run-end` 都是
  `stopReason: completed`。
- **0.5.0 同名接管的其余真机项未验证**（都是假 ctx 探针测不到的）：① UI 工具卡片 / workflow 运行视图是否真能看到
  `workflow/phase` / `workflow/log` / `workflow/agent-start` / `workflow/agent-end` 这批进度；② 真机
  `job_kill` 端到端是否真把引擎 run 取消；③ `systemPrompt` section（order `TOOL_WORKFLOW` = 2600）是否真的
  进到最终 prompt；④ 插件热重载后遗留的 stale 接管定义是否仍能执行（本插件按 `takeoverMarker` 采纳并 warn，
  但不转拒绝）。以上四项都记「未验证」，不许写成已对齐（§10.4）。
- **本节行号只证明宿主契约，不证明本插件实现**：§10 的所有 `:行` 都是宿主安装根
  `dsh-tool-workflow/lib/index.js` / `dsh-tools/lib/index.js` / `dsh-tool-cordis/.../api-catalog.js` 的，
  本插件侧只写行为契约（行号会随改动漂移）。
  本插件是否已落地这些能力，以 `lib/index.js` / `scripts/check.mjs` 的当前版本为准。
- **recorder 依赖 `parent.session.append`**：宿主不提供可追加 session 时该 run 不记录（`recorder.start` 返回 `false`，
  不抛错）。这是与库存的**实现差异**，不是「已完全对齐」。
