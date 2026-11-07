/**
 * dsh-subagent-dispatch — per-call and per-run subagent dispatch for DSH 0.2.1.
 *
 * WHAT THIS PACKAGE REGISTERS (one row, three registrations)
 * ---------------------------------------------------------
 * 1. LOCAL subagent provider `dispatch-local` (config `localProviderName`).
 *    It exists only so the tool below has a backend it controls: a provider
 *    that "only prepares" (`prepareContinuable` returns `{}`, no seed) lets the
 *    host materialize the child itself (`startLocal` → `applyChildComposition`,
 *    dsh-subagent lib/index.js:1391-1477) and honor the request fields this
 *    package promises.
 * 2. EXTERNAL subagent provider `dispatch` (config `providerName`). External
 *    means "no `prepareContinuable`", so the host takes `startExternal`
 *    (dsh-subagent lib/index.js:1483-1521) and calls `start(request)`; the
 *    returned handle is `{ id, result, dispose }` (manager.materializeTracked:
 *    `run.id` becomes the child id, `run.result` is awaited, `run.dispose()` is
 *    the teardown). This one implements `start` by delegating to an ordinary
 *    in-process provider (`delegateProviderName`, default `spawn`), injecting
 *    the CONFIGURED preset / reasoning effort / model — the per-RUN half of the
 *    capability matrix, for `workflow`'s `subagentProvider` and friends, which
 *    accept no per-call preset or effort.
 * 3. The `dispatch_subagent` tool (config `toolName`) — the per-CALL half.
 * 4. The `run_workflow` tool (config `workflowToolName`) — the per-RUN half a
 *    MODEL can call directly. `workflow`'s `agent()` accepts label / phase /
 *    schema / provider / model only (see ENGINE LIMITS), so a run-wide preset
 *    or effort can only arrive through the engine's own `subagentProvider`
 *    override. When such an override is needed this tool registers a
 *    name-unique EXTERNAL provider (the same machinery as (2), configured for
 *    THIS call), passes its name as `request.subagentProvider` to
 *    `ctx.workflowEngine.start`, and disposes it again in a `finally`.
 *
 * HARD CONDITIONS (do not "simplify" these away)
 * ----------------------------------------------
 * - Mounting an agent preset requires a provider with `capabilities.agentPreset`
 *   AND `inheritsParentContext === false`; otherwise `assertCapabilities`
 *   (dsh-subagent lib/index.js:3311-3328) rejects the activation before any
 *   child exists. Both providers below satisfy this.
 * - `outputSchema` / `agentOptions` / `maxDepth` are capability-gated the same
 *   way (:3313-3327), so the local provider advertises all of them and the
 *   external one only forwards what it really passes through.
 * - The tool schema is authored in the host value-schema DSL and compiled by
 *   `defineTool` → `parameterSchemaSpecToJsonSchema` (dsh-tools
 *   lib/index.js:802-811, 838-849). Requiredness is expressed per property with
 *   `required: true`; the DSL rejects any other shape inside `items`
 *   (`allowRequired: false`, :721-730) — an array-form required list inside an
 *   item is an author error, not a warning.
 * - `reasoning_effort` is validated HERE, before `startActivation`, because the
 *   host only rejects it later, once the child is being created. The supported
 *   set comes from the live LLM runtime (`ctx.llm.resolveModelInfo`, effort ids
 *   under `reasoning.efforts`), which is the same metadata
 *   `LlmRuntime.resolveCallWithInfo` enforces with `UNSUPPORTED_REASONING_EFFORT`
 *   (dsh-llm lib/index.js:2182-2207). No clamping, no aliasing: an unsupported
 *   effort is a readable error that lists what the model does support.
 *
 * ENGINE LIMITS THIS PACKAGE DOES NOT PAPER OVER
 * ----------------------------------------------
 * - `workflow`'s `agent()` helper takes label / phase / provider / model /
 *   schema only; preset and reasoning effort are not per-call options there.
 *   That is why the per-run provider exists, and why this package never claims
 *   per-call preset/effort for `workflow` children.
 * - A per-run provider only sees what the caller puts on the request. If a
 *   `workflow` call passes its own `provider`/`model`, those win over the
 *   configured ones (they arrive as `request.agentOptions`).
 * - An external run's id is synthesized (`dispatch:<uuid>`), not the inner
 *   child's session id; the inner id is not surfaced because the host owns the
 *   external child's identity.
 *
 * STOCK OBSERVABILITY THIS TOOL NOW CARRIES (and what it takes over)
 * ------------------------------------------------------------------
 * Two names, ONE implementation: `run_workflow` absorbed the model-facing
 * surface of the stock `workflow` tool (`@deepseek-ai/dsh-tool-workflow`), and
 * the per-agent takeover makes the stock NAME resolve to the same
 * `executeWorkflow`, so nothing a caller observes is lost either way.
 * Each item below is implemented against the stock source, not re-invented:
 * - `run_in_background` (default false) → the run becomes an owned
 *   `ctx.get('jobs').start({ kind: 'workflow', label, owner, toolCall, run })`
 *   job and the call returns `{ kind: 'background', jobId, runId }` (stock
 *   `dsh-tool-workflow/lib/index.js:218-260`, `:388-398`); the job's settlement
 *   is the run's settlement (`jobOutcomeOf`, stock :178-196) and a registry
 *   kill cancels the engine run.
 * - `workflow/phase` / `workflow/log` / `workflow/agent-start` /
 *   `workflow/agent-end` are subscribed with the stock names and payloads and
 *   mirrored into the owning job (`createWorkflowRecordMirror`, stock :19-44;
 *   emitted by the engine, consumed here).
 * - Durable `tool-workflow/run-start|agent-start|agent-end|run-end` records are
 *   appended to the parent Session (`createWorkflowRecorder`, stock :83-134) —
 *   observer-only, a failing append only warns.
 * - `Config.maxResultChars` (default 50000, stock :68) caps the rendered
 *   foreground result and the background job's carried result
 *   (`renderResult`, stock :198-202, identical truncation suffix).
 * - A `systemPrompt.section` at `getSectionOrder('TOOL_WORKFLOW')` (stock :265-269).
 * - `workflow` is TAKEN OVER, not denied: for every agent that can already see
 *   a tool called `Config.takeoverToolName` (`workflow` by default), `apply()`
 *   registers a definition produced by the SAME `buildWorkflowDefinition`
 *   factory in that agent's OWN scope, so the stock name resolves to
 *   `executeWorkflow`. An agent that has no such tool is left alone (a takeover
 *   is a redirect, never a capability grant); `Config.shadowStockWorkflow
 *   : false` is the master switch (no takeover, no fallback guard).
 * - `ctx.tools.guard` remains only as a FALLBACK for an agent whose own scope
 *   already holds somebody else's same-name tool, and for the OTHER configured
 *   STOCK names (`Config.shadowedToolNames`): a global guard would refuse the
 *   very definition this package registers per agent, so `workflow` is filtered
 *   out of the deny list whenever the takeover is active. Guards are monotonic
 *   deny-only and can never deny this package's own tools.
 *
 * NOT ALIGNED (see docs/engine-evidence.md): the stock tool's `presentCall` /
 * `presentResult` generic cards are not re-implemented here, and this tool's
 * own per-run knobs (preset / reasoning_effort / provider+model) have no stock
 * counterpart.
 */

import { randomUUID } from 'node:crypto'

import { assertUsableCwd, delegationDepthOf, parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { assertObjectJsonSchema, defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-subagent-dispatch'
// `systemPrompt` is a HARD dependency, exactly like the stock tool declares it
// (`dsh-tool-workflow/lib/index.js:61-65`: ['tools','workflowEngine','systemPrompt']).
// Declaring it here is what orders apply() AFTER that service exists; without
// it, `ctx.systemPrompt` can be undefined at apply() time on a real host and
// the run_workflow prompt section would silently never register. The read
// below is still try/catch-guarded (a proxy-backed context can throw for a
// service it does not hold — same reasoning as `usableEngine`).
export const inject = ['subagents', 'tools', 'llm', 'systemPrompt']

/** Provider that backs the per-call tool. */
const DEFAULT_LOCAL_PROVIDER = 'dispatch-local'
/** Provider that backs whole-run delegation (workflow subagentProvider). */
const DEFAULT_EXTERNAL_PROVIDER = 'dispatch'
/** The in-process provider the external one delegates to. */
const DEFAULT_DELEGATE_PROVIDER = 'spawn'
/** Tool name published to models. */
const DEFAULT_TOOL_NAME = 'dispatch_subagent'
/** Tool name published to models for whole-run delegation. */
const DEFAULT_WORKFLOW_TOOL_NAME = 'run_workflow'
/** Prefix of a per-run provider name; a UUID makes every name unique. */
const DEFAULT_WORKFLOW_PROVIDER_PREFIX = 'dispatch-wf'
/** How much of the workflow result an error detail line embeds. */
const RENDER_RESULT_CHARS = 4000
/**
 * Config `maxResultChars` default — SAME value as the stock `workflow` tool
 * (`dsh-tool-workflow/lib/index.js:68`, `z.natural().min(1).default(5e4)`).
 * It caps the rendered result text AND the background job's carried result
 * (stock :183 / :198-202).
 */
const DEFAULT_MAX_RESULT_CHARS = 50000
/**
 * Section order the stock tool uses for its prompt section:
 * `ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW')`
 * (`dsh-tool-workflow/lib/index.js:267`; the order table itself is
 * `dsh-system-prompt/lib/index.js:31`, `TOOL_WORKFLOW: 2600`). Kept as a
 * literal fallback for a host whose section table predates that name.
 */
const DEFAULT_WORKFLOW_SECTION_ORDER = 2600
/**
 * The stock `workflow` description, VERBATIM
 * (`@deepseek-ai/dsh-tool-workflow/lib/types/index.js`, `DESCRIPTION`; 1667
 * characters). The stock module does not export it, so it is cloned here — the
 * parity case in `scripts/check.mjs` captures the stock definition at runtime
 * and asserts `===`, so any drift fails loudly instead of silently diverging.
 */
const STOCK_WORKFLOW_DESCRIPTION = `Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.

Script-body hooks:
- \`agent(prompt, opts?): Promise<any>\` — run one subagent to completion. Without \`opts.schema\` it resolves to the child's final text; with \`opts.schema\` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf) it resolves to the validated object. Resolves \`null\` when the child fails (filter with \`.filter(Boolean)\`). Other opts: \`label\` (display), \`phase\` (progress group), and independent \`provider\`/\`model\` LLM target overrides.
- \`pipeline(items, ...stages): Promise<any[]>\` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives \`(prev, item, index)\`. A stage throw drops that ITEM to \`null\` and skips its remaining stages.
- \`parallel(thunks): Promise<any[]>\` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to \`null\`.
- \`phase(title)\` — start a progress phase; \`log(message)\` — narrate progress; \`args\` — the tool call's \`args\` input, verbatim.

Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) end the whole script instead of producing \`null\`. The script has no filesystem, network, timer, or Node.js APIs; the agents do the work.`
/**
 * The stock prompt section body (`dsh-tool-workflow/lib/index.js:265-269`),
 * parameterized by the model-facing tool name exactly as the stock module does.
 * With the default takeover name (`workflow`) this is byte-identical to the
 * stock text; the parity case asserts that at runtime.
 */
function stockWorkflowSectionText(toolName) {
  return `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.`
}
/**
 * The PTC transport name (`dsh-tool-executor-ptc` declares `run_code`
 * separately from the registry). Used only to tell a PTC agent — which never
 * had a `workflow` capability — apart from an agent whose `workflow` was
 * denied by a restriction: the former may be supplemented, the latter never.
 */
const PTC_TRANSPORT_NAME = 'run_code'
/**
 * The per-run knobs this plugin ADDS to the stock parameter table. They are
 * optional-only: `WF_STOCK_DEFINITION_PARITY` asserts the stock fields are
 * unchanged and every addition is not required.
 */
const PLUGIN_WORKFLOW_PARAMETERS = ['preset', 'reasoning_effort', 'provider', 'model', 'max_total_agents']
/**
 * Legacy deny list: stock tool names this package used to shadow by denying them
 * at execution time. It survives for names the takeover does NOT claim — Config
 * `shadowedToolNames` replaces the list, this package's own tool name is always
 * removed from it (a guard can deny, never force-allow), and so is the takeover
 * name while the takeover is active. With the default takeover on, the list is
 * therefore EMPTY and no global guard is registered at all.
 */
const DEFAULT_SHADOWED_TOOL_NAMES = ['workflow']
/**
 * Default name this package TAKES OVER in each agent's own scope: the stock
 * tool name whose observable behaviour `run_workflow` already carries. Taking
 * the name over is therefore a REDIRECT of an existing capability, never a new
 * one — for an agent that has no such tool, nothing is registered (see
 * `installTakeover`). `Config.takeoverToolName` renames it.
 */
const DEFAULT_TAKEOVER_TOOL_NAME = 'workflow'
/**
 * Identity marker stamped onto EVERY definition `buildWorkflowDefinition`
 * produces. Deliberately a STRING: a `Symbol()` is a fresh value in every
 * module instance, so it could not answer "is the `workflow` already sitting in
 * this agent's own layer OUR registration?" after a plugin reload. With a
 * value-equal string, that question is decidable (plan §2.6 state C) and a
 * stale registration is ADOPTED instead of degraded into a denial.
 */
const TAKEOVER_MARKER = 'dsh-subagent-dispatch/takeover/1'
/**
 * Host-reserved tool names a takeover may never claim: `register()` throws on
 * `run_code` (`dsh-tools/lib/index.js:2981`). This package's own two tool names
 * are rejected as well (`takeoverNameProblem` call site) — registering one of
 * them in an agent's own scope would shadow this package itself.
 */
const RESERVED_TAKEOVER_NAMES = ['run_code']

function messageOf(error) {
  return error instanceof Error && error.message ? error.message : String(error)
}

function textOf(blocks) {
  return (blocks ?? []).filter((block) => block && block.type === 'text').map((block) => block.text).join('')
}

/** Reject an empty model-facing selection value (an empty string is not "unset"). */
function selectionOf(value, field, toolName) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${toolName}: \`${field}\` must be a string`)
  if (value.length === 0) throw new Error(`${toolName}: \`${field}\` must be non-empty`)
  return value
}

/**
 * LOCAL provider for the 0.2.1 activation backend.
 *
 * `prepareContinuable` existing is what routes the host to `startLocal`, which
 * creates the child, mounts `request.agentPreset`, and applies
 * `request.agentOptions` / `request.outputSchema` / `request.maxDepth`: this
 * provider prepares and never creates, so the host keeps ownership and
 * `DUPLICATE_CHILD` (a provider-created session colliding with the tracked
 * `run.id`, :1769-1789) cannot happen.
 *
 * @param providerName - registered provider name.
 */
function createLocalProvider(providerName) {
  return {
    name: providerName,
    // Preset mounting and per-call agent options/schema/depth each need their
    // own advertised capability; see assertCapabilities.
    capabilities: { agentPreset: true, agentOptions: true, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
    async prepareContinuable(request) {
      if (request?.signal?.aborted) throw new Error(`${providerName}: request aborted before the child was prepared`)
      // No seed: the dispatched prompt is the only context the child gets.
      return {}
    },
  }
}

/** Merge the configured per-run child options under the request's own. */
function composeDelegatedAgentOptions(config, requested) {
  const configured = {
    ...(config.routeProvider === undefined ? {} : { provider: config.routeProvider }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  }
  const merged = { ...configured, ...(requested ?? {}) }
  return Object.keys(merged).length === 0 ? undefined : merged
}

/**
 * EXTERNAL provider for whole-run delegation.
 *
 * The host calls `start(request)` and treats the return value as the run
 * handle: `id` becomes the child id, `result` is awaited, `dispose` is the
 * teardown. The actual child is started through `ctx.subagents.startActivation`
 * on `delegateProviderName`, so the configured preset / effort / model land on
 * the child exactly as a per-call dispatch would.
 *
 * @param options - provider name, configured defaults, and the subagents seam.
 */
function createExternalProvider({ providerName, config, subagents }) {
  const delegateProviderName = config.delegateProviderName ?? DEFAULT_DELEGATE_PROVIDER
  return {
    name: providerName,
    // `agentPreset` must be advertised because this provider forwards
    // `request.agentPreset` to the delegate; `inheritsParentContext` must be
    // false for the same reason. `agentOptions` / `outputSchema` / `depthLimit`
    // are honest only because every one of them is forwarded below.
    capabilities: { agentPreset: true, agentOptions: true, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
    async start(request) {
      const signal = request.signal
      const agentPreset = request.agentPreset ?? config.preset
      const agentOptions = composeDelegatedAgentOptions(config, request.agentOptions)
      let inner
      try {
        inner = await subagents.startActivation({
          provider: delegateProviderName,
          label: request.label ?? `${providerName}:run`,
          signal,
          // The result travels through the returned handle, so the inner child
          // hands it to the caller of this call (not to the outer parent's inbox).
          delivery: 'caller',
          request: {
            parent: request.parent,
            prompt: request.prompt,
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
            ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
            ...(agentPreset === undefined ? {} : { agentPreset }),
            ...(agentOptions === undefined ? {} : { agentOptions }),
            ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
          },
        })
      } catch (cause) {
        throw new Error(`${providerName}: could not start the delegated "${delegateProviderName}" run: ${messageOf(cause)}`, { cause })
      }
      let disposed = false
      return {
        // Synthesized identity: the host owns the external child's id, and this
        // provider must not pretend the inner local child id is its own.
        id: `${providerName}:${randomUUID()}`,
        result: inner.result,
        async dispose() {
          if (disposed) return
          disposed = true
          await inner.dispose()
        },
      }
    },
  }
}

/**
 * Resolve the child's Agent options and validate the route and effort BEFORE
 * any child is started.
 *
 * @param ctx - plugin context (needs the `llm` service).
 * @param parent - the delegating agent the route would be inherited from.
 * @param selection - per-call provider / model / reasoning_effort.
 * @param signal - tool-call cancellation.
 * @param toolName - diagnostic prefix.
 */
async function resolveAgentOptions(ctx, parent, selection, signal, toolName) {
  const { provider, model, reasoningEffort } = selection
  if (provider === undefined && model === undefined && reasoningEffort === undefined) return undefined
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error(`${toolName}: \`provider\` and \`model\` must be supplied together`
      + ` (got provider=${provider === undefined ? 'undefined' : `"${provider}"`}, model=${model === undefined ? 'undefined' : `"${model}"`})`)
  }
  const parentOptions = parentAgentOptionsForDelegation(parent)
  const routeProvider = provider ?? parentOptions.provider
  const routeModel = model ?? parentOptions.model
  if (routeProvider === undefined || routeModel === undefined) {
    throw new Error(`${toolName}: cannot resolve an LLM route for \`reasoning_effort\`: the parent route is`
      + ` provider=${parentOptions.provider === undefined ? 'undefined' : `"${parentOptions.provider}"`}`
      + ` model=${parentOptions.model === undefined ? 'undefined' : `"${parentOptions.model}"`}.`
      + ' Pass `provider` and `model` together, or drop `reasoning_effort`.')
  }
  const llm = ctx.llm
  if (llm === undefined) throw new Error(`${toolName}: cannot resolve the child LLM route because the \`llm\` service is unavailable`)
  let info
  try {
    info = await llm.resolveModelInfo(routeProvider, routeModel, signal)
  } catch (cause) {
    throw new Error(`${toolName}: cannot resolve the child LLM route "${routeProvider}/${routeModel}": ${messageOf(cause)}`, { cause })
  }
  if (reasoningEffort !== undefined) {
    const efforts = (info?.reasoning?.efforts ?? []).map((effort) => effort.id)
    if (!efforts.includes(reasoningEffort)) {
      const supported = efforts.length === 0
        ? 'this model advertises no reasoning efforts, so omit `reasoning_effort`'
        : `supported efforts: ${efforts.join(', ')}`
          + ` (default: ${info.reasoning.defaultEffort ?? 'none'})`
      throw new Error(`${toolName}: provider "${routeProvider}" model "${routeModel}" does not support reasoning effort`
        + ` "${reasoningEffort}" — ${supported}`)
    }
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/** Validate a caller-supplied structured-output schema against the host subset. */
function assertDispatchSchema(schema, toolName) {
  try {
    assertObjectJsonSchema(schema)
  } catch (cause) {
    throw new Error(`${toolName}: \`schema\` must be an object-rooted JSON Schema from the subset the subagent`
      + ` structured-output contract enforces: ${messageOf(cause)}`, { cause })
  }
  return schema
}

/**
 * Read one candidate engine through `read`, keeping only a usable one.
 *
 * A candidate whose `start` is not a function is NOT a hit: the caller keeps
 * looking, so an object parked under the same service name cannot shadow the
 * real engine. The read is guarded because a proxy-backed context may throw
 * for a service it does not inject.
 */
function usableEngine(read) {
  try {
    const candidate = read()
    if (candidate !== null && candidate !== undefined && typeof candidate.start === 'function') return candidate
  } catch {
    // A proxy-backed context may throw for a service it does not hold.
  }
  return undefined
}

/**
 * Resolve the workflow engine without declaring it as a hard dependency.
 *
 * `inject` in this host is an array (or a name-to-config map), so an optional
 * service cannot be declared: adding `workflowEngine` to `inject` would make
 * the whole plugin (including `dispatch_subagent`) fail to load on a host that
 * ships without the workflow package.
 *
 * SCOPE MATTERS. `workflowEngine` is registered inside an agent preset's
 * ISOLATED GROUP (a profile's `workflow-ptc` row lives in the preset's plugin
 * list), while this plugin is patched in globally by the bundle. Cordis
 * `get()` only walks UP, so neither this global context nor a property read on
 * the calling agent's context finds a service mounted in that isolated group —
 * the real failure was `workflowEngine.start is undefined` at both levels.
 *
 * The preset registry exposes the one supported read:
 * `agentPresets.serviceFor(agent, 'workflowEngine')` — "Read a service supplied
 * inside an Agent's isolated preset group"
 * (`@deepseek-ai/dsh-agent-preset-registry/lib/index.js:725`, implementation
 * `serviceForMount(...)` at `:136`). It resolves the mount of the agent's
 * generation and reads the service from THAT mount, which is exactly the scope
 * neither `agent.ctx` nor this plugin's ctx can walk to.
 *
 * Order: (1) `ctx.get('agentPresets')` (falling back to `ctx.agentPresets`)
 * → `.serviceFor(agent, 'workflowEngine')`, (2) `agent.ctx.workflowEngine`,
 * (3) `agent.ctx.get('workflowEngine')`, (4) `ctx.workflowEngine`, (5)
 * `ctx.get('workflowEngine')`. Every read is guarded and a candidate without
 * a callable `start` never stops the search; a missing or throwing
 * `serviceFor` (older host) falls through to the next level silently.
 *
 * @param ctx - plugin (global) context — hosts `agentPresets` and the fallback scope.
 * @param agent - the calling agent, when the caller has one; omit it to keep
 *   the pre-scope behaviour (plugin context only).
 * @returns the engine, or `undefined` when no scope exposes a usable one.
 */
function workflowEngineOf(ctx, agent) {
  if (agent !== null && agent !== undefined) {
    // The ONLY read that reaches an isolated preset group. Guarded in three
    // ways: a throwing ctx.get, a host without agentPresets, and a
    // serviceFor that throws or yields an object whose start is not callable.
    const fromPreset = usableEngine(() => {
      let registry
      try {
        registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
      } catch {
        registry = undefined
      }
      if (registry === undefined || registry === null) registry = ctx.agentPresets
      if (registry === null || typeof registry !== 'object' || typeof registry.serviceFor !== 'function') return undefined
      return registry.serviceFor(agent, 'workflowEngine')
    })
    if (fromPreset !== undefined) return fromPreset
  }
  const agentCtx = agent === null || agent === undefined ? undefined : agent.ctx
  if (agentCtx !== null && agentCtx !== undefined) {
    const fromAgent = usableEngine(() => agentCtx.workflowEngine)
      ?? usableEngine(() => (typeof agentCtx.get === 'function' ? agentCtx.get('workflowEngine') : undefined))
    if (fromAgent !== undefined) return fromAgent
  }
  return usableEngine(() => ctx.workflowEngine)
    ?? usableEngine(() => (typeof ctx.get === 'function' ? ctx.get('workflowEngine') : undefined))
}

/**
 * Lazy PTC engine fallback.
 *
 * The stock `ptc` preset ships `workflow-ptc` / `tool-workflow` DISABLED, so an
 * agent on that preset has no `workflowEngine` at any scope the caller can read
 * and this package's workflow tool would be a dead entry — visible in the PTC
 * tool surface (dsh-ops publishes every agent tool inside `run_code`) but
 * failing on every call. That is the one shape a PTC user must not meet.
 *
 * The fallback mounts the OFFICIAL engine (`@deepseek-ai/dsh-workflow-ptc`, the
 * same package the disabled preset row would have loaded) once per plugin
 * context, and only when none of the read attempts in `workflowEngineOf` found
 * an engine and the host exposes the TypeScript PTC runtime the engine needs.
 * The dynamic import keeps the package out of load-time dependencies: a host
 * without it still loads this plugin and gets the original readable error.
 */
const ptcEngineStates = new WeakMap()

function ptcRuntimeOf(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('ptcRuntime') : undefined
  } catch {
    return undefined
  }
}

/**
 * Import the official engine the way the HOST resolves its own packages.
 *
 * A profile plugin lives in a "linked" resolution layer, where app-boot only
 * routes a bare specifier when the plugin declares it in `peerDependencies`
 * (`app-boot/lib/index.js` `readPeerNames`/`routeLinked`). The engine is an
 * OPTIONAL package this plugin must not require at install time, so the bare
 * `import()` is not enough: go through the host loader first, whose imports
 * are anchored at the profile and therefore route installation packages
 * regardless of that peer list. The bare import stays as the fallback for
 * hosts without a reachable loader service.
 */
async function importWorkflowPtcEngine(ctx) {
  let loader
  try {
    loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
  } catch {
    loader = undefined
  }
  if (loader !== null && loader !== undefined && typeof loader.import === 'function') {
    try {
      return await loader.import('@deepseek-ai/dsh-workflow-ptc')
    } catch (error) {
      ctx.logger?.warn?.(`${name}: loader.import('@deepseek-ai/dsh-workflow-ptc') failed (${messageOf(error)});`
        + ' retrying with a bare dynamic import')
    }
  }
  return await import('@deepseek-ai/dsh-workflow-ptc')
}

async function mountPtcEngine(ctx) {
  const mod = await importWorkflowPtcEngine(ctx)
  const Engine = mod?.default ?? mod
  if (typeof Engine !== 'function') {
    throw new Error('@deepseek-ai/dsh-workflow-ptc has no default plugin export')
  }
  // `ctx.plugin()` is legal outside apply(): it only requires an active fiber
  // (cordis/lib/index.js:1691-1694). The new fiber belongs to this plugin's
  // fiber, so Cordis disposes it on unload — never dispose it a second time.
  const fiber = ctx.plugin(Engine, { provider: 'spawn' })
  await fiber
  const engine = usableEngine(() => (typeof ctx.get === 'function' ? ctx.get('workflowEngine') : undefined))
  if (engine === undefined) {
    throw new Error('the mounted @deepseek-ai/dsh-workflow-ptc engine did not publish a usable workflowEngine service')
  }
  return engine
}

/**
 * Resolve the engine for one tool call, mounting the PTC fallback when needed.
 * @param ctx - plugin context.
 * @param agent - the calling agent (preset scope first).
 * @param options - `autoMount: false` disables the fallback for this call.
 * @returns `{ engine, source, reason }`; `reason` explains a missing engine.
 */
async function resolveWorkflowEngine(ctx, agent, options = {}) {
  const existing = workflowEngineOf(ctx, agent)
  if (existing !== undefined) return { engine: existing, source: 'host' }
  if (options.autoMount === false) {
    return {
      engine: undefined,
      source: 'none',
      reason: 'automatic PTC engine mounting is disabled (`autoMountPtcEngine: false`)',
    }
  }
  const runtime = ptcRuntimeOf(ctx)
  if (runtime === null || runtime === undefined || runtime.language !== 'typescript') {
    return {
      engine: undefined,
      source: 'none',
      reason: 'the host exposes no TypeScript PTC runtime to mount the official engine on',
    }
  }
  let state = ptcEngineStates.get(ctx)
  if (state === undefined) {
    state = { promise: undefined, engine: undefined }
    ptcEngineStates.set(ctx, state)
  }
  // A cached engine can outlive its fiber (HMR, an unlucky dispose). Identity
  // against the live service is the cheap liveness check; stale => remount.
  if (state.engine !== undefined) {
    const current = usableEngine(() => (typeof ctx.get === 'function' ? ctx.get('workflowEngine') : undefined))
    if (current === state.engine) return { engine: state.engine, source: 'fallback' }
    state.engine = undefined
    state.promise = undefined
  }
  if (state.promise === undefined) {
    state.promise = mountPtcEngine(ctx).then(
      (engine) => {
        state.engine = engine
        return engine
      },
      (error) => {
        // Never cache a failure: a later call may see the runtime/package ready.
        state.promise = undefined
        throw error
      },
    )
  }
  try {
    const engine = await state.promise
    return { engine, source: 'fallback' }
  } catch (error) {
    ctx.logger?.warn?.(`${name}: automatic @deepseek-ai/dsh-workflow-ptc mount failed: ${messageOf(error)}`)
    return {
      engine: undefined,
      source: 'none',
      reason: `automatic @deepseek-ai/dsh-workflow-ptc mount failed: ${messageOf(error)}`,
    }
  }
}

/** Reject an empty workflow script body (a blank body is not a workflow). */
function assertWorkflowScript(script, toolName) {
  if (typeof script !== 'string' || script.trim().length === 0) {
    throw new Error(`${toolName}: \`script\` must be a non-empty string holding the JavaScript workflow body`
      + ' (a plain body: no `export const meta`, no TypeScript)')
  }
  return script
}

/** Reject a meta block that is not a plain object carrying a non-empty `name`. */
function assertWorkflowMeta(meta, toolName) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    const seen = meta === null ? 'null' : Array.isArray(meta) ? 'an array' : typeof meta
    throw new Error(`${toolName}: \`meta\` must be a plain object (name/description/phases), got ${seen}`)
  }
  if (typeof meta.name !== 'string' || meta.name.trim().length === 0) {
    throw new Error(`${toolName}: \`meta.name\` must be a non-empty string — it names the workflow in progress output; got ${JSON.stringify(meta.name)}`)
  }
  return meta
}

/** Reject a non positive-safe-integer engine budget before any run starts. */
function positiveIntegerOf(value, field, toolName) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${toolName}: \`${field}\` must be a positive safe integer (got ${JSON.stringify(value)})`)
  }
  return value
}

/* ================================================================== *
 * STOCK-PARITY OBSERVATION SEAMS
 * ------------------------------------------------------------------
 * Everything in this block is an equivalent implementation of the stock
 * `@deepseek-ai/dsh-tool-workflow` behaviour `run_workflow` now carries. The
 * stock module exports only `{ Config, apply, inject, name }`
 * (`dsh-tool-workflow/lib/index.js:442`), so its mirror / recorder /
 * renderer / job-outcome mapper cannot be imported: they are re-implemented
 * here, function for function, with the stock source line quoted at each
 * seam. DIFFERENCES (all noted where they occur):
 *  - `ctx.on` and `session.append` are feature-detected here (a fake/host
 *    context without them keeps the tool working, silently unobserved),
 *    while the stock module assumes both.
 *  - `renderResult` tolerates a `undefined` value (stock :199 would throw
 *    on `rendered.length`); the text is otherwise identical.
 * ================================================================== */

/** Render a contained recording failure without trusting the thrown value (stock :72-78). */
function renderRecordingError(error) {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/**
 * Live-progress mirror for background runs — stock `createWorkflowRecordMirror`
 * (`dsh-tool-workflow/lib/index.js:19-44`). The engine's progress events become
 * `log` chunks on the owning job plus that job's live progress line. Same event
 * names, same payload shape, same append text, line for line:
 *  - `workflow/phase`     (stock :21) → `job.updateProgress(title)` + `▸ ${title}\n`
 *  - `workflow/log`       (stock :27) → `${message}\n`
 *  - `workflow/agent-start` (stock :30) → `agent #${agent.seq} ${agent.label} started\n`
 *  - `workflow/agent-end` (stock :33) → `agent #${agent.seq} ${agent.outcome}\n`
 *
 * FEATURE DIFFERENCE: the subscriptions are skipped when `ctx.on` is absent
 * (the stock module would throw). The returned taps are identical.
 */
function createWorkflowRecordMirror(ctx) {
  const active = new Map()
  if (typeof ctx.on === 'function') {
    ctx.on('workflow/phase', (info, title) => {
      const job = active.get(info?.id)
      if (job === undefined) return
      job.updateProgress(title)
      job.append(`▸ ${title}\n`, { channel: 'log' })
    })
    ctx.on('workflow/log', (info, message) => {
      active.get(info?.id)?.append(`${message}\n`, { channel: 'log' })
    })
    ctx.on('workflow/agent-start', (info, agent) => {
      active.get(info?.id)?.append(`agent #${agent.seq} ${agent.label} started\n`, { channel: 'log' })
    })
    ctx.on('workflow/agent-end', (info, agent) => {
      active.get(info?.id)?.append(`agent #${agent.seq} ${agent.outcome}\n`, { channel: 'log' })
    })
  }
  return {
    start(runId, job) {
      active.set(runId, job)
    },
    stop(runId) {
      active.delete(runId)
    },
  }
}

/**
 * Durable per-run record, projected into the parent Session — stock
 * `createWorkflowRecorder` (`dsh-tool-workflow/lib/index.js:83-134`). Event
 * types and payload shapes are the stock ones:
 *  - `tool-workflow/run-start`  { runId, name }            (stock :117)
 *  - `tool-workflow/agent-start` { runId, seq, label, phase?, childId } (stock :98)
 *  - `tool-workflow/agent-end`  { runId, seq, outcome }    (stock :109)
 *  - `tool-workflow/run-end`    { runId, stopReason }      (stock :124)
 *
 * A failing append disables durable recording for that run (stock :85-94) and
 * NEVER fails the tool call: this whole layer is observer-only.
 *
 * FEATURE DIFFERENCE: `session.append` is required per call (absent → the
 * run is simply not recorded); the stock module reads it unconditionally.
 */
function createWorkflowRecorder(ctx) {
  const active = new Map()
  const append = (session, type, data) => {
    try {
      const appendRecord = session.append.bind(session)
      appendRecord(type, data)
      return true
    } catch (error) {
      ctx.logger?.warn?.(`${name}: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`)
      return false
    }
  }
  if (typeof ctx.on === 'function') {
    ctx.on('workflow/agent-start', (info, agent) => {
      const session = active.get(info?.id)
      if (session === undefined) return
      if (!append(session, 'tool-workflow/agent-start', {
        runId: info.id,
        seq: agent.seq,
        label: agent.label,
        ...agent.phase === undefined ? {} : { phase: agent.phase },
        childId: agent.childId,
      })) active.delete(info.id)
    })
    ctx.on('workflow/agent-end', (info, agent) => {
      const session = active.get(info?.id)
      if (session === undefined) return
      if (!append(session, 'tool-workflow/agent-end', {
        runId: info.id,
        seq: agent.seq,
        outcome: agent.outcome,
      })) active.delete(info.id)
    })
  }
  return {
    start(session, run, metaName) {
      if (session === undefined || session === null || typeof session.append !== 'function') return false
      if (!append(session, 'tool-workflow/run-start', {
        runId: run.id,
        // Stock :119-120 reads `run.meta.name`; the real engine run carries
        // `meta`, so the caller's validated `meta.name` is only a fallback for
        // an engine whose run handle omits it.
        name: run.meta?.name ?? metaName,
      })) return false
      active.set(run.id, session)
      return true
    },
    finish(runId, stopReason) {
      const session = active.get(runId)
      if (session !== undefined) append(session, 'tool-workflow/run-end', {
        runId,
        stopReason,
      })
      active.delete(runId)
    },
    abandon(runId) {
      active.delete(runId)
    },
  }
}

/**
 * Render the run's outcome text: meta name, agent count, and the JSON value,
 * capped at `maxChars` with the stock suffix — stock `renderResult`
 * (`dsh-tool-workflow/lib/index.js:198-202`). The suffix is byte-identical:
 * `\n… [truncated: N more characters]`.
 */
function renderResult(metaName, agentsStarted, value, maxChars) {
  const rendered = JSON.stringify(value, null, 2) ?? 'undefined'
  const capped = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_RESULT_CHARS
  const clipped = rendered.length > capped
    ? `${rendered.slice(0, capped)}\n… [truncated: ${rendered.length - capped} more characters]`
    : rendered
  return `workflow "${metaName}" completed (${agentsStarted} agent${agentsStarted === 1 ? '' : 's'}).\nReturn value:\n${clipped}`
}

/**
 * Map a settled background run onto the job outcome vocabulary — stock
 * `jobOutcomeOf` (`dsh-tool-workflow/lib/index.js:178-196`): a completed run
 * carries the rendered (capped) return value as the job's `result`, a
 * cancelled run settles `killed`, an errored run fails with the script's
 * failure message.
 */
function jobOutcomeOf(result, metaName, maxChars) {
  switch (result?.stopReason) {
    case 'completed': return {
      status: 'completed',
      detail: `${result.agentsStarted} agent${result.agentsStarted === 1 ? '' : 's'}`,
      result: renderResult(metaName, result.agentsStarted, result.value, maxChars),
    }
    case 'cancelled': return { status: 'killed' }
    case 'error': return {
      status: 'failed',
      detail: result.error ?? 'unknown error',
    }
    default: return {
      status: 'failed',
      detail: `workflow run ended abnormally (${String(result?.stopReason)})`,
    }
  }
}

/** Resolve the `systemPrompt` service without trusting a proxy-backed context. */
function systemPromptOf(ctx) {
  try {
    const direct = ctx.systemPrompt
    if (direct !== undefined && direct !== null) return direct
  } catch {
    // A proxy-backed context may throw for a service it does not hold.
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  } catch {
    return undefined
  }
}

/**
 * Validate one `run_workflow` call and resolve everything the run needs.
 *
 * Runs BEFORE any provider is registered and BEFORE the engine starts, so a
 * rejection here costs nothing and registers nothing — the same ordering the
 * foreground path has always had.
 */
async function prepareWorkflowCall(ctx, args, exec, parent, toolName, autoMountPtcEngine = true) {
  // The engine lives in the agent's ISOLATED PRESET GROUP, which neither this
  // plugin's global scope nor a plain read on agent.ctx can reach;
  // `agentPresets.serviceFor` is the registry's read for that scope. When the
  // preset ships no engine (stock `ptc`), `resolveWorkflowEngine` mounts the
  // official PTC engine once, so the tool is never a visible-but-dead entry.
  const resolved = await resolveWorkflowEngine(ctx, parent, { autoMount: autoMountPtcEngine })
  const engine = resolved.engine
  if (engine === undefined) {
    const reason = resolved.reason === undefined ? '' : ` (${resolved.reason})`
    throw new Error(`${toolName}: this host exposes no workflow engine — the active agent preset has not enabled one${reason}.`
      + ' Tried agentPresets.serviceFor(agent, \'workflowEngine\'), agent.ctx.workflowEngine / agent.ctx.get(\'workflowEngine\'),'
      + ' and this plugin\'s ctx.workflowEngine / ctx.get(\'workflowEngine\').'
      + ' Enable the `workflow-ptc` + `tool-workflow` rows in the active agent preset, or install'
      + ' `@deepseek-ai/dsh-workflow-ptc` so the automatic PTC fallback can mount it')
  }
  const scriptText = assertWorkflowScript(args.script, toolName)
  const meta = assertWorkflowMeta(args.meta, toolName)
  const preset = selectionOf(args.preset, 'preset', toolName)
  const reasoningEffort = selectionOf(args.reasoning_effort, 'reasoning_effort', toolName)
  const provider = selectionOf(args.provider, 'provider', toolName)
  const model = selectionOf(args.model, 'model', toolName)
  // Pairing and effort support are the same rules the per-call tool enforces.
  const agentOptions = await resolveAgentOptions(ctx, parent, { provider, model, reasoningEffort }, exec?.signal, toolName)
  const maxTotalAgents = positiveIntegerOf(args.max_total_agents, 'max_total_agents', toolName)
  return {
    engine,
    scriptText,
    meta,
    preset,
    reasoningEffort,
    provider,
    model,
    agentOptions,
    maxTotalAgents,
    // A per-run provider is needed only when this call actually overrides
    // something a provider can carry (preset, effort, route).
    needsRunProvider: preset !== undefined || agentOptions !== undefined,
  }
}

/**
 * Register the per-run external provider for THIS call.
 *
 * Stock `workflow` has no such seam (this is this package's injection point),
 * so only the lifecycle rules are borrowed: a name-unique provider, released
 * exactly once. Returns the name to hand to the engine plus a one-shot
 * disposer; both are `undefined` when the call overrides nothing.
 */
function registerRunProvider(ctx, options, prepared) {
  const { workflowToolName, workflowProviderPrefix, delegateProviderName } = options
  if (!prepared.needsRunProvider) return { subagentProvider: undefined, dispose: undefined }
  // Name-unique: two concurrent runs must never collide on
  // DUPLICATE_PROVIDER, and the name must differ from the two static
  // providers this package registers.
  const runProviderName = `${workflowProviderPrefix}-${randomUUID()}`
  const runProvider = createExternalProvider({
    providerName: runProviderName,
    config: {
      delegateProviderName,
      ...(prepared.preset === undefined ? {} : { preset: prepared.preset }),
      ...(prepared.agentOptions?.provider === undefined ? {} : { routeProvider: prepared.agentOptions.provider }),
      ...(prepared.agentOptions?.model === undefined ? {} : { model: prepared.agentOptions.model }),
      ...(prepared.agentOptions?.reasoningEffort === undefined ? {} : { reasoningEffort: prepared.agentOptions.reasoningEffort }),
    },
    subagents: ctx.subagents,
  })
  const disposer = ctx.subagents.registerProvider(runProvider)
  if (typeof disposer === 'function') return { subagentProvider: runProviderName, dispose: disposer }
  // Older hosts returned nothing; the run still works, but the name stays
  // registered for the lifetime of the plugin.
  ctx.logger?.warn?.(`${workflowToolName}: ctx.subagents.registerProvider returned no disposer for "${runProviderName}";`
    + ' the temporary provider will not be released')
  return { subagentProvider: runProviderName, dispose: undefined }
}

/**
 * Start the run as an owned `ctx.jobs` job and return its ids immediately —
 * stock `startBackgroundRun` (`dsh-tool-workflow/lib/index.js:218-260`).
 *
 * The engine run is started INSIDE the job starter with no tool-step signal:
 * the run belongs to the job, so a registry kill (or owner teardown) is what
 * cancels it, and its settlement IS the job's settlement — dispose, stop the
 * mirrors, map the stop reason onto the job outcome (a completed run's capped
 * return value rides `result` to the model's first read after settlement).
 */
function startBackgroundRun(ctx, options, prepared, args, parent, toolCall, recordsRun, calledName = options.workflowToolName) {
  const { workflowToolName, mirror, recorder, maxResultChars } = options
  const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') {
    throw new Error(`${calledName}: background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`)
  }
  let run
  const jobId = jobs.start({
    kind: 'workflow', // stock :225
    label: args.meta.name, // stock :226
    owner: parent.id, // stock :227
    toolCall, // stock :228
    run: (job) => { // stock :229
      const registration = registerRunProvider(ctx, options, prepared)
      try {
        // No `signal`: the run belongs to the job (stock :230-235 passes none).
        run = prepared.engine.start({
          script: prepared.scriptText,
          meta: prepared.meta,
          ...(args.args === undefined ? {} : { args: args.args }),
          parent,
          ...(registration.subagentProvider === undefined ? {} : { subagentProvider: registration.subagentProvider }),
          ...(prepared.maxTotalAgents === undefined ? {} : { maxTotalAgents: prepared.maxTotalAgents }),
        })
        if (run === null || run === undefined || typeof run.cancel !== 'function' || typeof run.result?.then !== 'function') {
          throw new Error(`${calledName}: the workflow engine returned no cancellable run handle (start() produced no awaitable result with cancel())`)
        }
      } catch (cause) {
        // A start() that throws must not leave this call's provider behind.
        if (registration.dispose !== undefined) {
          const dispose = registration.dispose
          Promise.resolve().then(() => dispose()).catch(() => {})
        }
        throw cause
      }
      mirror.start(run.id, job) // stock :236
      if (recordsRun) recorder.start(parent.session, run, args.meta.name) // stock :237
      return {
        cancel: (reason) => { // stock :239-241
          run.cancel(reason ?? 'background workflow job killed')
        },
        done: run.result.then(async (result) => { // stock :242
          try {
            await run.dispose() // stock :243-247
          } catch (error) {
            ctx.logger?.warn?.(`background workflow run ${run.id} dispose failed: ${messageOf(error)}`)
          }
          mirror.stop(run.id) // stock :248
          if (recordsRun) {
            recorder.finish(run.id, result?.stopReason) // stock :250
            recorder.abandon(run.id) // stock :251
          }
          if (registration.dispose !== undefined) {
            const dispose = registration.dispose
            registration.dispose = undefined
            try {
              await dispose()
            } catch (error) {
              ctx.logger?.warn?.(`${workflowToolName}: temporary provider dispose failed: ${messageOf(error)}`)
            }
          }
          return jobOutcomeOf(result, args.meta.name, maxResultChars) // stock :253
        }),
      }
    },
  })
  // `jobs.start` runs the starter synchronously, so the run handle exists here.
  return { kind: 'background', jobId, runId: String(run.id) }
}

/**
 * Validate `Config.takeoverToolName` (plan §2.8): a non-empty, non-blank
 * string that is neither a host-reserved name nor one of this package's own
 * tool names. Returns a readable reason, or `undefined` when the name is
 * usable. Never throws — the caller warns and disables the takeover.
 */
function takeoverNameProblem(candidate, ownToolNames) {
  if (typeof candidate !== 'string') return `must be a string (got ${candidate === null ? 'null' : typeof candidate})`
  if (candidate.trim().length === 0) return 'must not be empty or blank'
  if (RESERVED_TAKEOVER_NAMES.includes(candidate)) return `"${candidate}" is a name the host reserves`
  if (ownToolNames.includes(candidate)) return `"${candidate}" is this package's own tool name`
  return undefined
}

/**
 * The ONE producer of every `workflow`-shaped definition this package
 * registers: `run_workflow` (below, in `apply()`) and the per-agent takeover
 * both come from here, so the description, the parameter table, the output
 * schema/render and the executed implementation cannot drift apart.
 *
 * `shared` carries the single implementation (`executeWorkflow`) and the
 * definition template (everything except `name` / `execute`). The returned
 * object is the host's own `defineTool` product — note that `defineTool` is NOT
 * an identity transform: it wraps `execute` in a fresh closure per call, so
 * `a.execute !== b.execute` even for the same `executeWorkflow`. That is why
 * the same-implementation proof is the `sharedExecute` marker below (plus the
 * shared template), never a function-identity assertion.
 */
function buildWorkflowDefinition(toolName, shared) {
  const { template, executeWorkflow } = shared
  const definition = defineTool({
    ...template,
    name: toolName,
    execute: executeWorkflow,
  })
  definition.sharedExecute = executeWorkflow
  definition.takeoverMarker = TAKEOVER_MARKER
  return definition
}

export function apply(ctx, config = {}) {
  const localProviderName = config.localProviderName ?? DEFAULT_LOCAL_PROVIDER
  const providerName = config.providerName ?? DEFAULT_EXTERNAL_PROVIDER
  const delegateProviderName = config.delegateProviderName ?? DEFAULT_DELEGATE_PROVIDER
  const toolName = config.toolName ?? DEFAULT_TOOL_NAME
  const workflowToolName = config.workflowToolName ?? DEFAULT_WORKFLOW_TOOL_NAME
  const workflowProviderPrefix = config.workflowProviderPrefix ?? DEFAULT_WORKFLOW_PROVIDER_PREFIX
  // Result cap — same default as the stock tool (`dsh-tool-workflow:68`). An
  // unusable value falls back to that default instead of failing the plugin.
  const configuredMaxResultChars = config.maxResultChars
  const maxResultChars = Number.isSafeInteger(configuredMaxResultChars) && configuredMaxResultChars > 0
    ? configuredMaxResultChars
    : DEFAULT_MAX_RESULT_CHARS
  if (configuredMaxResultChars !== undefined && maxResultChars !== configuredMaxResultChars) {
    ctx.logger?.warn?.(`${name}: ignoring \`maxResultChars\` ${JSON.stringify(configuredMaxResultChars)}`
      + ` (must be a positive integer); using ${DEFAULT_MAX_RESULT_CHARS}`)
  }
  if (config.enableRunInBackground === false) {
    ctx.logger?.info?.(`${name}: \`run_in_background\` is published but disabled by \`enableRunInBackground: false\``)
  }
  // `shadowStockWorkflow` is the MASTER SWITCH (judgement 3): on by default,
  // and when on it means "take the stock name over per agent, and keep a
  // per-agent guard only as the fallback for a name somebody else claimed".
  // `false` means neither: no takeover and no guard.
  const shadowStockWorkflow = config.shadowStockWorkflow !== false
  // PTC fallback: when the active preset has no engine (stock `ptc` disables
  // `workflow-ptc`/`tool-workflow`), mount the official engine on first use.
  // On by default; `autoMountPtcEngine: false` restores the read-only behaviour.
  const autoMountPtcEngine = config.autoMountPtcEngine !== false
  const takeoverToolName = config.takeoverToolName ?? DEFAULT_TAKEOVER_TOOL_NAME
  // A configuration mistake never throws (judgement 2): an unusable takeover
  // name only disables the takeover and warns.
  const takeoverProblem = takeoverNameProblem(takeoverToolName, [workflowToolName, toolName])
  const takeoverEnabled = shadowStockWorkflow && takeoverProblem === undefined
  if (takeoverProblem !== undefined) {
    ctx.logger?.warn?.(`${name}: ignoring \`takeoverToolName\` (${takeoverProblem});`
      + ` \`${workflowToolName}\` and \`${toolName}\` keep working and no takeover is attempted`)
  }
  // Disclosure decision, needed by BOTH the global guard and the alias
  // registration below: with single disclosure (`exposeRunWorkflow` off and a
  // live takeover) the alias is NOT registered anywhere, so no model-facing
  // string may point at it.
  const exposeRunWorkflow = config.exposeRunWorkflow === true
  const publishWorkflowAlias = exposeRunWorkflow || !takeoverEnabled
  /**
   * What a model should do when a stock name was shadowed / a takeover could
   * not install its redirect. Depends on whether the alias was actually
   * published — with single disclosure there is no `run_workflow` to point at,
   * and naming a tool the model cannot see would be a dead reference.
   */
  const takeoverRecoveryHint = publishWorkflowAlias
    ? `call \`${workflowToolName}\` instead: same engine and the same script hooks (agent / pipeline / parallel /`
      + ' phase / log / args), plus per-run preset / reasoning_effort / provider+model, background jobs'
      + ' (`run_in_background`), live workflow progress events and durable `tool-workflow/*` run records.'
    : `call \`${takeoverToolName}\` instead: it is the workflow tool this host publishes, with the same engine and`
      + ' the same script hooks (agent / pipeline / parallel / phase / log / args), plus per-run preset /'
      + ' reasoning_effort / provider+model, background jobs (`run_in_background`), live workflow progress events'
      + ' and durable `tool-workflow/*` run records.'

  const configuredShadowed = Array.isArray(config.shadowedToolNames) ? config.shadowedToolNames : DEFAULT_SHADOWED_TOOL_NAMES
  // Names a deny list may NEVER contain:
  //  - this package's own tool (`toolName`): a guard can deny, never allow, so
  //    one stray entry would disable the headline tool;
  //  - the alias (`workflowToolName`): same reason;
  //  - the takeover name AND the stock default while the takeover is on: the
  //    guard runs before the agent chain (`dsh-tools/lib/index.js:3025-3026`),
  //    so it would refuse the very definition this package registers — and with
  //    a renamed takeover the stock name is the only workflow an agent may
  //    still have, so denying it would delete a capability.
  const forbiddenShadowNames = new Set([workflowToolName, toolName])
  if (takeoverEnabled) {
    forbiddenShadowNames.add(takeoverToolName)
    forbiddenShadowNames.add(DEFAULT_TAKEOVER_TOOL_NAME)
  }
  const shadowedToolNames = configuredShadowed
    .filter((toolName_) => typeof toolName_ === 'string' && toolName_.length > 0 && !forbiddenShadowNames.has(toolName_))

  // Three distinct names, or the delegating chain turns into itself: an
  // external provider that delegates to its own name would recurse on every
  // run, and a delegate equal to the local provider would re-enter this tool's
  // own backend.
  if (providerName === localProviderName) {
    throw new Error(`${name}: \`providerName\` and \`localProviderName\` must differ (both are "${providerName}")`)
  }
  if (delegateProviderName === providerName) {
    throw new Error(`${name}: \`delegateProviderName\` must not equal \`providerName\` ("${providerName}") — that provider would delegate to itself`)
  }
  if (delegateProviderName === localProviderName) {
    throw new Error(`${name}: \`delegateProviderName\` must not equal \`localProviderName\` ("${localProviderName}")`)
  }

  const providers = [
    createLocalProvider(localProviderName),
    createExternalProvider({
      providerName,
      config: { ...config, delegateProviderName },
      subagents: ctx.subagents,
    }),
  ]
  for (const provider of providers) {
    if (ctx.subagents.getProvider(provider.name) === undefined) {
      ctx.subagents.registerProvider(provider)
    } else {
      ctx.logger?.info?.(`${name}: subagent provider "${provider.name}" already registered; keeping the existing one`)
    }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: 'Dispatch one subagent with per-call control: `preset` mounts an agent preset on the child,'
      + ' `reasoning_effort` sets the child request\'s reasoning effort (validated against the target model before'
      + ' anything starts), `provider` + `model` switch the child\'s LLM route, `cwd` gives it a different working'
      + ' directory, and `schema` (object-rooted JSON Schema) makes it answer through structured output.'
      + ' Every field is optional except `prompt` and `description`; omit them to inherit from this session.'
      + ' Use this tool when one child needs different knobs than the caller — the stock `subagent` tool exposes'
      + ' `agent_preset` / `reasoning_effort` only when its tool row and profile settings enable them; this tool'
      + ' works without changing those settings, and `workflow`\'s `agent()` accepts no preset or effort at all.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Self-contained task for the child. The child does not inherit this conversation, so include paths, criteria, and how it should verify its work.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Short (3-5 word) label for the child, shown in the agent list.',
      },
      preset: {
        type: 'string',
        description: 'Agent preset id to mount on the child (for example `standard`, `workspace-all`, `ptc`). Omit to inherit this session\'s preset. The preset must exist in the roster; an unknown id fails when the child is created.',
      },
      reasoning_effort: {
        type: 'string',
        description: 'Adapter-owned reasoning effort id for the child\'s effective route (for example low / high / max). Validated against the model\'s advertised efforts before dispatch; an unsupported value fails with the supported list. Omit to inherit a compatible effort or let the model use its default.',
      },
      provider: {
        type: 'string',
        description: 'LLM route provider for the child. Supply together with `model`; omit both to inherit this session\'s route.',
      },
      model: {
        type: 'string',
        description: 'Exact model id interpreted by `provider`. Supply together with `provider`.',
      },
      cwd: {
        type: 'string',
        description: 'Absolute working directory for the child. Omit to inherit this session\'s directory.',
      },
      schema: {
        type: 'json',
        description: 'Object-rooted JSON Schema the child must answer through, using the subagent structured-output contract. Must be type "object" with explicit additionalProperties. Omit for a plain text answer.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true, description: 'Subagent provider that backed this dispatch.' },
          childId: { type: 'string', required: true, description: 'Durable child session id.' },
          stopReason: { type: 'string', required: true, description: 'Terminal stop reason of the child run.' },
          text: { type: 'string', required: true, description: 'Final assistant text of the child (empty when it answered only through structured output).' },
          preset: { type: 'string', description: 'Preset mounted on the child, when one was selected.' },
          reasoningEffort: { type: 'string', description: 'Reasoning effort applied to the child, when one was selected.' },
          model: { type: 'string', description: 'LLM model applied to the child, when one was selected.' },
          structured: { type: 'json', description: 'Structured result, when `schema` was supplied and the child used it.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `[${value.provider} child=${value.childId} stop=${value.stopReason}`
          + `${value.preset === undefined ? '' : ` preset=${value.preset}`}`
          + `${value.reasoningEffort === undefined ? '' : ` effort=${value.reasoningEffort}`}`
          + `${value.model === undefined ? '' : ` model=${value.model}`}]\n`
          + (value.structured === undefined ? '' : `Structured result: ${JSON.stringify(value.structured)}\n`)
          + (value.text ?? ''),
      }],
    },
    // Two dispatches against the same workspace are not safe to run
    // concurrently under the caller's write-scope discipline.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec?.agent
      if (!parent) throw new Error(`${toolName}: requires a calling agent (exec.agent was undefined)`)
      if (typeof ctx.subagents.startActivation !== 'function') {
        throw new Error(`${toolName}: this host exposes no activation API (ctx.subagents.startActivation is undefined) — DSH 0.2.1 or newer is required`)
      }

      const preset = selectionOf(args.preset, 'preset', toolName)
      const reasoningEffort = selectionOf(args.reasoning_effort, 'reasoning_effort', toolName)
      const provider = selectionOf(args.provider, 'provider', toolName)
      const model = selectionOf(args.model, 'model', toolName)
      const cwd = args.cwd === undefined || args.cwd === '' ? undefined : assertUsableCwd(toolName, 'cwd', args.cwd)
      const agentOptions = await resolveAgentOptions(ctx, parent, { provider, model, reasoningEffort }, exec.signal, toolName)
      const outputSchema = args.schema === undefined ? undefined : assertDispatchSchema(args.schema, toolName)

      // Budget: exactly ONE level below this caller, never below its own parent.
      const maxDepth = delegationDepthOf(parent) + 1

      let run
      try {
        run = await ctx.subagents.startActivation({
          provider: localProviderName,
          label: args.description,
          signal: exec.signal,
          // One-shot: the tool result carries the outcome.
          delivery: 'caller',
          request: {
            maxDepth,
            parent,
            prompt: [{ type: 'text', text: args.prompt }],
            ...(preset === undefined ? {} : { agentPreset: preset }),
            ...(cwd === undefined ? {} : { cwd }),
            ...(agentOptions === undefined ? {} : { agentOptions }),
            ...(outputSchema === undefined ? {} : { outputSchema }),
          },
        })
      } catch (cause) {
        throw new Error(`${toolName}: could not start the subagent: ${messageOf(cause)}`, { cause })
      }

      // Foreground ownership: settle the RESULT first, then dispose.
      const [execution] = await Promise.allSettled([run.result])
      const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
      if (execution.status === 'rejected') {
        if (disposal.status === 'rejected') {
          throw new AggregateError([execution.reason, disposal.reason], `${toolName}: child failed and dispose also failed`)
        }
        throw new Error(`${toolName}: child ${run.childId} failed: ${messageOf(execution.reason)}`, { cause: execution.reason })
      }
      if (disposal.status === 'rejected') {
        ctx.logger?.warn?.(`${toolName}: dispose failed for ${run.childId}: ${messageOf(disposal.reason)}`)
      }
      const result = execution.value
      if (result.stopReason !== 'completed' && result.stopReason !== 'aborted') {
        const partial = textOf(result.output)
        throw new Error(`${toolName}: child ${run.childId} ended with ${result.stopReason}`
          + `${partial.length > 0 ? `\nOutput before the run ended:\n${partial}` : ''}`
          + `${result.diagnostic === undefined ? '' : `\ndiagnostic: ${result.diagnostic}`}`)
      }
      return {
        provider: localProviderName,
        childId: run.childId,
        stopReason: result.stopReason,
        text: textOf(result.output),
        ...(preset === undefined ? {} : { preset }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(model === undefined ? {} : { model }),
        ...(result.structured === undefined ? {} : { structured: result.structured }),
      }
    },
  })), `${name} tool`)

  // ------------------------------------------------------------------
  // Observation seams shared by both workflow paths (stock parity).
  // The stock tool builds these once per apply() next to its recorder
  // (`dsh-tool-workflow/lib/index.js:261-264`): the mirror narrates background
  // runs into the owning job's output ring, the recorder writes durable
  // `tool-workflow/*` events into the parent Session. Both are observer-only.
  // ------------------------------------------------------------------
  const mirror = createWorkflowRecordMirror(ctx)
  const recorder = createWorkflowRecorder(ctx)
  const workflowOptions = {
    workflowToolName,
    workflowProviderPrefix,
    delegateProviderName,
    mirror,
    recorder,
    maxResultChars,
  }
  const enableRunInBackground = config.enableRunInBackground !== false

  // Stock `apply()` (`dsh-tool-workflow/lib/index.js:265-269`) registers the
  // explicit-ask guidance as a prompt section named `tool:${toolName}` ordered
  // with TOOL_WORKFLOW. `dsh-system-prompt` merges sections BY NAME across the
  // scope chain and lets the NEAREST scope win (`dsh-scope/lib/index.js`
  // `ScopedLayers.merge`: global first, then `chainLayers` farthest→nearest),
  // so a section registered in the AGENT's own scope with the SAME name
  // SHADOWS a preset/global one instead of duplicating it. That is the only
  // placement that is correct in both host shapes:
  //  - stock plugin mounted in the preset scope (standard / cordis): our
  //    agent-scope section shadows it ⇒ the assembled prompt carries the rule
  //    exactly ONCE, with the stock text verbatim;
  //  - stock plugin absent (PTC preset disables `tool-workflow`): our section
  //    is the only one, so the supplemented `workflow` still gets its rule.
  // A GLOBAL registration would be wrong in the first shape (two different
  // scopes both contribute until the agent scope shadows, and `apply()` runs
  // before any agent exists), and it would still be wrong when the stock
  // plugin mounts in the SAME scope: `NamedEntries` throws on a duplicate name
  // in one layer, and the stock `apply()` is unguarded ⇒ whichever plugin
  // applies second could lose its tool. Per-agent placement avoids both.
  //
  // `shadowStockWorkflow: false` (legacy dual-name mode, no takeover) keeps a
  // GLOBAL section for the alias: there is no agent-scoped capability to
  // describe, and the alias is published in the global layer.
  const systemPrompt = systemPromptOf(ctx)
  const workflowSectionOrder = () => {
    try {
      if (systemPrompt !== undefined && typeof systemPrompt.getSectionOrder === 'function') {
        const resolved = systemPrompt.getSectionOrder('TOOL_WORKFLOW')
        if (typeof resolved === 'number' && Number.isFinite(resolved)) return resolved
      }
    } catch {
      // fall through to the literal order
    }
    return DEFAULT_WORKFLOW_SECTION_ORDER
  }
  if (!takeoverEnabled) {
    if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
      try {
        systemPrompt.section({
          name: `tool:${workflowToolName}`,
          order: workflowSectionOrder(),
          text: `Use the ${workflowToolName} tool ONLY when the user explicitly asks for a workflow or for large`
            + ' multi-agent orchestration: you write a JavaScript script (the tool description documents the exact'
            + ' format) that fans work out across many subagents with phases and structured results. For one or two'
            + ' delegations, prefer plain subagent calls.',
        })
      } catch (error) {
        ctx.logger?.warn?.(`${name}: could not register the ${workflowToolName} prompt section: ${messageOf(error)}`)
      }
    } else {
      ctx.logger?.warn?.(`${name}: no \`systemPrompt\` service on this context; the ${workflowToolName} prompt section is not registered`)
    }
  }

  /**
   * Register the explicit-ask rule in ONE agent's own scope, verbatim stock
   * text, under the stock section name (`tool:${takeoverToolName}`) so it
   * shadows any preset/global copy. Returns the Cordis disposer (owned by the
   * injecting agent fiber, so it goes away with the agent).
   */
  const installAgentSection = (runtimeCtx) => {
    const prompts = systemPromptOf(runtimeCtx)
    if (prompts === undefined || typeof prompts.section !== 'function') {
      ctx.logger?.warn?.(`${name}: the agent scope exposes no \`systemPrompt\` service;`
        + ` the "${takeoverToolName}" usage rule is not registered for this agent`)
      return undefined
    }
    return prompts.section({
      name: `tool:${takeoverToolName}`,
      order: workflowSectionOrder(),
      text: stockWorkflowSectionText(takeoverToolName),
    })
  }

  // Guard for the configured stock names that are NOT taken over. The takeover
  // name itself must never be denied here: a global guard is evaluated BEFORE
  // the agent chain (`dsh-tools/lib/index.js:3025-3026`), so it would refuse the
  // very definition this package registers in each agent's own scope.
  // `shadowStockWorkflow: false` registers no guard at all (master switch).
  //
  // Guards are monotonic — "a returned string denies the execution", "no guard
  // can force-allow a call another guard denied"
  // (`dsh-tools/lib/index.js:3004-3022`, `guardReason` :2743-2750) — so this
  // package's own tool must NEVER be in the deny list: `workflowToolName` is
  // filtered out of `shadowedToolNames` above and short-circuited again here,
  // exactly like the takeover name (also filtered out above while it is active).
  // The list can legitimately be EMPTY: that is the default takeover
  // configuration, and it registers no guard at all.
  if (shadowStockWorkflow && typeof ctx.tools?.guard === 'function' && shadowedToolNames.length > 0) {
    ctx.tools.guard((exec) => {
      // `exec.name` is the invoked tool's global name (`dsh-tools` builds the
      // execution from `exec.name`, `lib/index.js:3231-3249`).
      const calledToolName = exec === undefined || exec === null ? undefined : exec.name
      if (typeof calledToolName !== 'string' || calledToolName.length === 0) return undefined
      if (calledToolName === workflowToolName || calledToolName === toolName) return undefined
      if (!shadowedToolNames.includes(calledToolName)) return undefined
      return `tool "${calledToolName}" is shadowed by ${name}: ${takeoverRecoveryHint}`
    })
  }

  // ------------------------------------------------------------------
  // run_workflow — per-RUN delegation a model may call directly.
  // ------------------------------------------------------------------
  // ONE definition body, TWO names: `buildWorkflowDefinition` turns this
  // template into a full host definition (and stamps `sharedExecute` /
  // `takeoverMarker` on it), so `run_workflow` and the per-agent takeover cannot
  // drift apart — same description, same parameters, same output schema, same
  // `executeWorkflow`.
  const workflowTemplate = {
    name: workflowToolName,
    // VERBATIM stock description (`dsh-tool-workflow` DESCRIPTION). Do not edit:
    // the stock field is the model-facing contract, and the parity case asserts
    // string equality against a runtime capture of the stock definition.
    description: STOCK_WORKFLOW_DESCRIPTION,
    parameters: {
      // The stock parameter table, cloned field for field from
      // `dsh-tool-workflow/lib/index.js:273-337` (same descriptions, same
      // nesting, same requiredness). The per-run knobs below are the ONLY
      // additions, and every one of them is optional.
      script: {
        type: 'string',
        required: true,
        description: 'The plain JavaScript body, not TypeScript and without an `export const meta` statement; top-level await is allowed. End with `return <value>`; the JSON-serializable value is this tool\'s result.',
      },
      meta: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'The workflow identity as plain JSON, not code.',
        properties: {
          name: {
            type: 'string',
            required: true,
            description: 'Short kebab-case workflow name.',
          },
          description: {
            type: 'string',
            required: true,
            description: 'One-line description of what the workflow does.',
          },
          whenToUse: {
            type: 'string',
            description: 'Optional guidance on when this workflow applies.',
          },
          phases: {
            type: 'array',
            description: 'Optional phase declarations matched by phase() calls.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                title: {
                  type: 'string',
                  required: true,
                  description: 'The phase title phase() calls match by exact string.',
                },
                detail: {
                  type: 'string',
                  description: 'Optional one-line description of the phase.',
                },
                provider: {
                  type: 'string',
                  description: 'Optional provider override this phase is expected to use.',
                },
                model: {
                  type: 'string',
                  description: 'Optional model override this phase is expected to use.',
                },
              },
            },
          },
        },
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).',
      },
      preset: {
        type: 'string',
        description: 'Agent preset id mounted on EVERY child of this run (for example `standard`, `ptc`). Per-run, not per call. Omit to keep the engine default.',
      },
      reasoning_effort: {
        type: 'string',
        description: 'Reasoning effort id applied to every child of this run (for example low / high / max). Validated against the model\'s advertised efforts before the workflow starts; an unsupported value fails with the supported list. Omit to inherit a compatible effort.',
      },
      provider: {
        type: 'string',
        description: 'LLM route provider for every child of this run. Supply together with `model`; omit both to inherit this session\'s route.',
      },
      model: {
        type: 'string',
        description: 'Exact model id interpreted by `provider`. Supply together with `provider`.',
      },
      max_total_agents: {
        type: 'number',
        description: 'Optional positive integer cap on the total number of `agent()` children this run may start; forwarded as the engine request `maxTotalAgents` (it must not exceed the engine ceiling configured on the deployment). Omit to use the engine default.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run as a background job: return a job id immediately instead of waiting; the return value arrives with the completion notice.',
      },
    },
    // Output contract: the stock oneOf pair (`dsh-tool-workflow/lib/index.js:339-379`),
    // so a background call and a foreground call stay distinguishable to the
    // host and to the model.
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'background', description: 'This call returned a background job instead of a result.' },
            jobId: { type: 'string', required: true, description: 'Id of the owned background job.' },
            runId: { type: 'string', required: true, description: 'Engine-assigned workflow run id.' },
          },
        }, {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'foreground', description: 'This call waited for the run to settle.' },
            runId: { type: 'string', required: true, description: 'Engine-assigned workflow run id.' },
            agentsStarted: { type: 'integer', required: true, description: 'How many `agent()` children the script started.' },
            result: { type: 'json', required: true, description: 'The JSON value the script returned (null when it returned nothing).' },
          },
        }],
      },
      // Stock render (`dsh-tool-workflow/lib/index.js:380-383`): the background
      // branch points the model at job_output / job_kill; the foreground branch
      // is `renderResult` — name, agent count, and the value capped at
      // `maxResultChars` (stock :198-202).
      render: (args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `workflow "${args.meta.name}" started in the background as job ${value.jobId}. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.`
          : renderResult(args.meta.name, value.agentsStarted, value.result, maxResultChars),
      }],
    },
    // One workflow mutates the same workspace its children write to.
    isConcurrencySafe: () => false,
  }

  // The single implementation BOTH names run: `buildWorkflowDefinition` wires
  // it in as the definition's `execute`. It closes over this apply()'s context,
  // options and result cap, so the takeover definition behaves exactly like
  // `run_workflow` (plan §2.5: same `executeWorkflow`, not the same function
  // object — the host's `defineTool` wraps `execute` in a fresh closure).
  const executeWorkflow = async (args, exec) => {
    // Model-facing errors name the tool the MODEL called, never the internal
    // alias: when the takeover serves `workflow`, an error that said
    // "run_workflow:" would point at a name the model cannot see (0.6.0).
    const calledName = typeof exec?.name === 'string' && exec.name.length > 0 ? exec.name : workflowToolName
    const parent = exec?.agent
    if (!parent) throw new Error(`${calledName}: requires a calling agent (exec.agent was undefined)`)

    // A background call is an owned job, not a tool step: the id comes back
    // immediately and the value rides the job's completion notice (stock
    // `dsh-tool-workflow/lib/index.js:388-398`).
    if (args.run_in_background === true) {
      if (!enableRunInBackground) {
        throw new Error(`${calledName}: \`run_in_background\` is disabled for this tool (enableRunInBackground: false)`)
      }
      const preparedBackground = await prepareWorkflowCall(ctx, args, exec, parent, calledName, autoMountPtcEngine)
      return startBackgroundRun(ctx, workflowOptions, preparedBackground, args, parent, {
        callId: exec.callId,
        rootCallId: exec.rootCallId,
      }, exec.parent === undefined, calledName)
    }

    // Every check below runs BEFORE the workflow starts: a failure here
    // costs nothing and registers nothing.
    const prepared = await prepareWorkflowCall(ctx, args, exec, parent, calledName, autoMountPtcEngine)
    const { engine, scriptText, meta, maxTotalAgents } = prepared

    const registration = registerRunProvider(ctx, workflowOptions, prepared)
    let disposeProvider = registration.dispose
    // Durable per-run records belong to a TOP-LEVEL call only (stock :406):
    // a nested workflow would otherwise double-record the parent's children.
    const recordsRun = exec.parent === undefined

    let run
    let result
    try {
      // `start()` validates synchronously and may throw (SCRIPT_PARSE,
      // META_INVALID, an unresolvable provider). It must be INSIDE the try so
      // a throwing start still releases the temporary provider.
      run = engine.start({
        script: scriptText,
        meta,
        ...(args.args === undefined ? {} : { args: args.args }),
        parent,
        signal: exec.signal,
        ...(registration.subagentProvider === undefined ? {} : { subagentProvider: registration.subagentProvider }),
        ...(maxTotalAgents === undefined ? {} : { maxTotalAgents }),
      })
      if (run === null || run === undefined || typeof run.result?.then !== 'function') {
        throw new Error(`${calledName}: the workflow engine returned no run handle (start() produced no awaitable result)`)
      }
      // Stock :407 — record the run against the parent Session, then let the
      // recorder's own events narrate each child.
      if (recordsRun) recorder.start(parent.session, run, args.meta.name)
      // `run.result` never rejects on the engines this package targets; every
      // failure arrives as a stop reason. The signal is owned by the engine
      // (it attaches and removes its own abort listener), so nothing here
      // needs to forward cancellation.
      result = await run.result
    } finally {
      // Stock `finally` order (:423-435): dispose the run, close the record,
      // then release this call's temporary provider.
      if (run !== undefined && run !== null && typeof run.dispose === 'function') {
        try {
          await run.dispose()
        } catch (cause) {
          ctx.logger?.warn?.(`${workflowToolName}: workflow dispose failed: ${messageOf(cause)}`)
        }
      }
      if (recordsRun) {
        recorder.finish(run?.id, result?.stopReason)
        recorder.abandon(run?.id)
      }
      if (disposeProvider !== undefined) {
        // Exactly once: clear the handle before calling it, so a second
        // finally (or a retried dispose) can never double-release.
        const dispose = disposeProvider
        disposeProvider = undefined
        try {
          await dispose()
        } catch (cause) {
          ctx.logger?.warn?.(`${workflowToolName}: temporary provider dispose failed: ${messageOf(cause)}`)
        }
      }
    }

    if (result === null || typeof result !== 'object') {
      throw new Error(`${calledName}: the workflow run ${String(run?.id)} produced no result record`)
    }
    if (result.stopReason !== 'completed') {
      const detail = typeof result.error === 'string' && result.error.length > 0
        ? `\n${result.error.slice(0, RENDER_RESULT_CHARS)}`
        : ''
      throw new Error(`${calledName}: the workflow run ${String(run.id)} stopped with "${result.stopReason}"${detail}`)
    }
    return {
      kind: 'foreground',
      runId: String(run.id),
      agentsStarted: typeof result.agentsStarted === 'number' ? result.agentsStarted : 0,
      result: result.value === undefined ? null : result.value,
    }
  }

  const workflowShared = { template: workflowTemplate, executeWorkflow }
  // ------------------------------------------------------------------
  // SINGLE DISCLOSURE: the alias is not published while the takeover serves
  // the stock name.
  // ------------------------------------------------------------------
  // The host has no "register but hide" API (`dsh-tools` only offers
  // `register` + `view(scope)`), so "hidden" is implemented as "not
  // registered globally": when the takeover is active the stock `workflow`
  // name is the ONLY workflow capability a model sees, exactly one row.
  // `exposeRunWorkflow: true` restores the global alias (opt-in dual
  // disclosure), and the compatibility mode `shadowStockWorkflow: false`
  // restores it too because there is no takeover to serve the model then.
  // BOTH branches publish the SAME `buildWorkflowDefinition` product, never a
  // copy of the implementation.
  if (publishWorkflowAlias) {
    ctx.effect(() => ctx.tools.register(buildWorkflowDefinition(workflowToolName, workflowShared)), `${name} workflow tool`)
  } else {
    ctx.logger?.info?.(`${name}: \`${workflowToolName}\` is not published as a separate capability —`
      + ` \`${takeoverToolName}\` serves it; set \`exposeRunWorkflow: true\` to publish both`)
  }

  // ------------------------------------------------------------------
  // Same-name takeover (v0.5.0): `workflow` becomes a REDIRECT
  // ------------------------------------------------------------------
  // For every agent that can ALREADY see a tool named `takeoverToolName`,
  // register this package's definition in that agent's OWN scope. Tools are
  // viewed layer by layer with own-over-inherited precedence
  // (`dsh-tools/lib/index.js:3055-3074`), so the stock `workflow` in the preset
  // layer is shadowed by the same name one level down — the model calls
  // `workflow` and `executeWorkflow` runs instead of a denial.
  //
  // Three hard rules:
  // - `tools.get(name, agent) === undefined` ⇒ SKIP. An agent without the name
  //   (no stock tool, or `restrict({ deny: ['workflow'] })`, which filters the
  //   inherited face only) must not be handed one: a takeover is a redirect of
  //   an existing capability, never a capability grant (review major-3).
  // - An own-layer definition already carrying `TAKEOVER_MARKER` is OURS (this
  //   instance, or an earlier one that outlived a reload) ⇒ adopt it. Never
  //   turn that into a denial (review major-1).
  // - `takeoverInFlight` is written SYNCHRONOUSLY, before the first `await`, so
  //   two announcements for one agent in the same tick cannot both register.
  const takeoverFibers = new Map()
  const takeoverInFlight = new WeakSet()
  const takeoverAdopted = new WeakSet()

  /** Release one per-agent registration (host: `fiber.dispose()` on disposal). */
  const takeDownFiber = (fiber) => {
    if (fiber === undefined || fiber === null) return
    try {
      const pending = typeof fiber.dispose === 'function' ? fiber.dispose() : undefined
      if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(() => {})
    } catch (error) {
      ctx.logger?.warn?.(`${name}: releasing a takeover registration failed: ${messageOf(error)}`)
    }
  }

  /**
   * Fallback for an agent whose own scope already holds SOMEBODY ELSE's
   * same-name tool: deny only that name, only on that agent. Registered on the
   * agent's own tools service, so the global layer (and every other agent) is
   * untouched.
   */
  const installFallbackGuard = (agentTools, cause) => {
    // Single disclosure means there is no alias to redirect a model to. Denying
    // a name with no usable alternative would DELETE a capability this agent
    // already had (the foreign definition works), so in that mode the foreign
    // tool is left exactly as it is — a takeover that cannot land must not
    // take anything away.
    if (!publishWorkflowAlias) {
      ctx.logger?.info?.(`${name}: another plugin already owns "${takeoverToolName}" in this agent's scope;`
        + ' leaving it in place (no alias is published, so no guard is registered)')
      return
    }
    if (agentTools === undefined || agentTools === null || typeof agentTools.guard !== 'function') {
      ctx.logger?.warn?.(`${name}: could not take over "${takeoverToolName}" (${messageOf(cause)}) and this scope`
        + ' exposes no tools.guard either; the existing tool stays in place')
      return
    }
    try {
      agentTools.guard((exec) => {
        const calledToolName = exec === undefined || exec === null ? undefined : exec.name
        if (calledToolName !== takeoverToolName) return undefined
        return `tool "${calledToolName}" is already registered in this agent's scope by another plugin, so ${name}`
          + ` could not take it over — ${takeoverRecoveryHint}`
      })
    } catch (error) {
      ctx.logger?.warn?.(`${name}: could not register the fallback guard for "${takeoverToolName}": ${messageOf(error)}`)
    }
  }

  /**
   * Decide whether an agent that does NOT resolve `takeoverToolName` should be
   * given it anyway. Returns `'register'`, `'skip'`, or `undefined` when the
   * host exposes no `view(scope)` and the question cannot be answered.
   *
   * The ONLY grant path is the PTC one: the agent has the `run_code` transport
   * but the workflow name never existed in its face. Two cases are NEVER
   * granted:
   *  - the name is KNOWN but not visible ⇒ `restrict({ deny: ['workflow'] })`
   *    filtered it. A denial is not an absence; supplementing would undo it.
   *  - the name is unknown AND the agent has no `run_code` ⇒ an ordinary agent
   *    that simply does not use workflows; a takeover never invents one.
   */
  const workflowSupplementFor = (agentTools, agent) => {
    if (agentTools === undefined || agentTools === null || typeof agentTools.view !== 'function') return undefined
    let view
    try {
      view = agentTools.view(agent)
    } catch (error) {
      ctx.logger?.warn?.(`${name}: could not read this agent's tool view: ${messageOf(error)}`)
      return undefined
    }
    const knownNames = view?.knownNames
    if (knownNames !== undefined && knownNames !== null && typeof knownNames.has === 'function' && knownNames.has(takeoverToolName)) {
      // Known but filtered out: a restriction owns this decision.
      return 'skip'
    }
    let runCode = view?.visible !== undefined && view?.visible !== null
      && typeof view.visible.has === 'function' && view.visible.has(PTC_TRANSPORT_NAME)
    if (!runCode) {
      // Real host: `run_code` is the PTC executor's own transport, declared by
      // its `describe()` and never entered into the registry, so a plain view
      // cannot show it (plan OI1). Ask the selected executor.
      try {
        const executor = typeof agentTools.selectExecutor === 'function' ? agentTools.selectExecutor(agent) : undefined
        const executorNames = executor?.describe?.()?.knownNames
        runCode = Array.isArray(executorNames) && executorNames.includes(PTC_TRANSPORT_NAME)
      } catch {
        runCode = false
      }
    }
    return runCode ? 'register' : 'skip'
  }

  /** One state decision per (agent, tools) pair — plan §2.6 states A/B/C/D. */
  const installTakeover = (agent, agentTools) => {
    if (agentTools === undefined || agentTools === null) {
      ctx.logger?.warn?.(`${name}: the agent scope exposes no tools service; "${takeoverToolName}" is not taken over for it`)
      return
    }
    // State A (older host): without `get(name, scope)` the "already visible"
    // precondition cannot be proven, and registering anyway could only ADD a
    // capability ⇒ skip and warn.
    if (typeof agentTools.get !== 'function') {
      ctx.logger?.warn?.(`${name}: this host's tools service has no get(name, scope); "${takeoverToolName}" keeps`
        + ` whatever implementation the preset mounted — ${takeoverRecoveryHint}`)
      return
    }
    let visible
    try {
      visible = agentTools.get(takeoverToolName, agent)
    } catch (error) {
      ctx.logger?.warn?.(`${name}: could not read "${takeoverToolName}" from this agent's scope: ${messageOf(error)}`)
      return
    }
    // State B: the agent does not resolve the name. This is one of:
    //  - no workflow capability at all (ordinary agent) ⇒ nothing to redirect;
    //  - `restrict({ deny: ['workflow'] })` ⇒ the name is known but filtered;
    //  - a PTC agent whose preset never mounted `tool-workflow` ⇒ the model has
    //    `run_code` but no workflow binding, so ONE is supplemented.
    // Only the last one is a (bounded) grant; see `workflowSupplementFor`.
    if (visible === undefined || visible === null) {
      const supplement = workflowSupplementFor(agentTools, agent)
      if (supplement === undefined) {
        ctx.logger?.warn?.(`${name}: this host's tools service has no view(scope); cannot tell a PTC agent from a`
          + ` restricted one — "${takeoverToolName}" is not supplemented for this agent`)
        return
      }
      if (supplement === 'skip') return
      if (typeof agentTools.register !== 'function') {
        ctx.logger?.warn?.(`${name}: this agent needs the PTC workflow supplement but its scope exposes no tools.register`)
        return
      }
      try {
        // The SAME definition factory as the alias: one implementation, one
        // parameter table, one description.
        agentTools.register(buildWorkflowDefinition(takeoverToolName, workflowShared))
        takeoverAdopted.add(agent)
      } catch (error) {
        ctx.logger?.warn?.(`${name}: could not supplement "${takeoverToolName}" for a PTC agent: ${messageOf(error)}`)
      }
      return
    }
    // State C: already ours.
    if (visible.takeoverMarker === TAKEOVER_MARKER) {
      if (visible.sharedExecute !== executeWorkflow) {
        ctx.logger?.warn?.(`${name}: the "${takeoverToolName}" already registered in this agent's scope carries this`
          + ' package\'s takeover marker but a DIFFERENT executeWorkflow (left behind by an earlier plugin instance);'
          + ` keeping it — call \`${workflowToolName}\` if its behaviour looks stale`)
      }
      takeoverAdopted.add(agent)
      return
    }
    // State D: somebody else's definition owns the name in this layer.
    if (typeof agentTools.register !== 'function') {
      installFallbackGuard(agentTools, new Error('the agent scope exposes no tools.register'))
      takeoverAdopted.add(agent)
      return
    }
    try {
      agentTools.register(buildWorkflowDefinition(takeoverToolName, workflowShared))
      takeoverAdopted.add(agent)
    } catch (error) {
      // Judgement 2: never throw out of here (a throwing `agent/created`
      // listener aborts agent creation, `api-catalog.js:3960`).
      ctx.logger?.warn?.(`${name}: could not take over "${takeoverToolName}" in this agent's scope: ${messageOf(error)}`)
      installFallbackGuard(agentTools, error)
      takeoverAdopted.add(agent)
    }
  }

  /** Idempotent, never-throwing takeover of ONE agent. */
  const takeOver = async (agent) => {
    if (agent === undefined || agent === null) return
    if (takeoverInFlight.has(agent) || takeoverAdopted.has(agent)) return
    takeoverInFlight.add(agent) // synchronous lock, BEFORE any await
    try {
      const agentCtx = agent.ctx
      if (agentCtx === undefined || agentCtx === null || typeof agentCtx.inject !== 'function') {
        ctx.logger?.warn?.(`${name}: the agent exposes no injectable ctx; "${takeoverToolName}" is not taken over for it`)
        return
      }
      // `inject` returns a thenable fiber and MUST be awaited: a turn that ran
      // before the registration landed would not see the name.
      //
      // The usage rule is installed in the SAME per-agent fiber, right after
      // the tool decision: only an agent that actually ends this pass with a
      // workflow capability gets the explicit-ask guidance (an agent the
      // takeover deliberately skipped must not be handed prose about a tool it
      // cannot see). Same name as the stock section ⇒ shadows it, never
      // duplicates it.
      const fiber = await agentCtx.inject(['tools', 'systemPrompt'], (runtimeCtx) => {
        installTakeover(agent, runtimeCtx?.tools)
        if (!takeoverAdopted.has(agent)) return
        try {
          installAgentSection(runtimeCtx)
        } catch (error) {
          ctx.logger?.warn?.(`${name}: could not register the "${takeoverToolName}" usage rule on this agent:`
            + ` ${messageOf(error)}`)
        }
      })
      if (fiber !== undefined && fiber !== null) takeoverFibers.set(agent, fiber)
    } finally {
      takeoverInFlight.delete(agent)
    }
  }

  if (takeoverEnabled) {
    const rescan = (reason) => {
      let list
      try {
        list = typeof ctx.get === 'function' ? ctx.get('agents')?.list?.() : undefined
      } catch (error) {
        ctx.logger?.warn?.(`${name}: could not read the agent list (${messageOf(error)}); existing agents keep`
          + ` the un-taken-over "${takeoverToolName}"`)
        return
      }
      if (!Array.isArray(list) || list.length === 0) return
      for (const agent of list) {
        takeOver(agent).catch((error) => {
          ctx.logger?.warn?.(`${name}: taking over "${takeoverToolName}" on an existing agent failed (${reason}):`
            + ` ${messageOf(error)}`)
        })
      }
    }
    if (typeof ctx.on === 'function') {
      try {
        // `mode: 'serial'`, awaited inside the creation flow; a throwing
        // listener would abort the creation, so this handler never throws.
        ctx.on('agent/created', async (payload) => {
          try {
            await takeOver(payload?.agent)
          } catch (error) {
            ctx.logger?.warn?.(`${name}: taking over "${takeoverToolName}" on a new agent failed: ${messageOf(error)}`)
          }
        })
        // `mode: 'emit'`, after driver quiescence and scoped unwind.
        ctx.on('agent/disposed', (payload) => {
          const agent = payload?.agent
          const fiber = takeoverFibers.get(agent)
          takeoverFibers.delete(agent)
          takeDownFiber(fiber)
        })
        // Presets can mount AFTER this plugin (host `reconcileComposedAgents`),
        // so a tools/change rescan is the retry path for state B.
        ctx.on('tools/change', () => rescan('tools/change'))
      } catch (error) {
        ctx.logger?.warn?.(`${name}: could not subscribe to the agent lifecycle: ${messageOf(error)}`)
      }
    }
    // Plugin-level cleanup: these registrations live on the AGENT's fiber, so
    // an unloaded plugin would otherwise leave them behind.
    ctx.effect(() => () => {
      for (const fiber of takeoverFibers.values()) takeDownFiber(fiber)
      takeoverFibers.clear()
    }, `${name} takeover cleanup`)
    // Existing agents (plugin loaded / reloaded after they were created).
    rescan('apply')
  }
}
