#!/usr/bin/env node
/**
 * dsh-subagent-dispatch — self-check (fake ctx probes against the REAL host modules).
 *
 * WHY THE RESOLVE HOOK
 * --------------------
 * The plugin imports `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-subagent`,
 * which live in the DSH installation, not in the workspace. A bare import from
 * here would fail (or, worse, silently resolve to a stub). This script
 * registers a `node:module` resolve hook that maps bare specifiers onto the
 * host `node_modules` directory, then imports the real host modules and the
 * plugin. So `defineTool`, `assertObjectJsonSchema` (schema DSL + subset),
 * `assertUsableCwd` and `parentAgentOptionsForDelegation` are the host's own
 * implementations, never local stand-ins: a green run here means the plugin's
 * arguments were accepted by the host compiler, not by a lookalike.
 *
 * WHAT IS FAKED
 * -------------
 * Only the seams a plugin may not own: `ctx.subagents` (a recorder in place of
 * the real activation backend), `ctx.tools` (a registry that captures the
 * definition), `ctx.effect`, `ctx.logger`, and `ctx.llm` (a route table that
 * answers `resolveModelInfo` with the same `reasoning.efforts` shape the real
 * `LlmRuntime` returns). Every assertion about a request shape reads that
 * recorder, which is exactly what the host would have received.
 *
 * OUTPUT CONTRACT
 * ---------------
 * One line per case; every assertion line ends with ` PASS` except
 * `HOST_MODULES`, which ends with the resolved host path. The final line is
 * `result: OK` on success.
 */

import { existsSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolvePath(here, '..')

/* ------------------------------------------------------------------ *
 * 1. Locate the DSH host node_modules and hook bare specifiers onto it
 * ------------------------------------------------------------------ */

function findHostModules() {
  const candidates = []
  if (process.env.DSH_HOST_MODULES) candidates.push(process.env.DSH_HOST_MODULES)
  // Walk up from the workspace and from this file: covers a source checkout
  // that keeps the host packages in a workspace-level node_modules.
  for (const start of [process.cwd(), here]) {
    let dir = start
    for (;;) {
      candidates.push(join(dir, 'node_modules'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const appData = process.env.LOCALAPPDATA
  if (appData !== undefined) {
    candidates.push(join(appData, 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh', 'node_modules'))
    candidates.push(join(appData, 'Programs', 'deepseek-harness', 'resources', 'app', 'dsh', 'node_modules'))
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
      && existsSync(join(candidate, '@deepseek-ai', 'dsh-subagent', 'lib', 'index.js'))) return candidate
  }
  throw new Error('cannot locate the DSH host node_modules (containing @deepseek-ai/dsh-tools and @deepseek-ai/dsh-subagent);'
    + ` looked at:\n- ${candidates.join('\n- ')}\nSet DSH_HOST_MODULES to that directory and retry.`)
}

const hostModules = findHostModules()

/** A specifier that must go through the host resolver (not relative/absolute/URL). */
function isBareSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('\\')) return false
  return !specifier.includes(':')
}

/** Resolve one bare specifier inside the host node_modules (no nested resolution). */
function resolveBare(specifier) {
  const parts = specifier.split('/')
  const nameLength = specifier.startsWith('@') ? 2 : 1
  const name = parts.slice(0, nameLength).join('/')
  const subpath = parts.slice(nameLength).join('/')
  const dir = join(hostModules, name)
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    pkg = {}
  }
  const pick = (entry) => (typeof entry === 'string'
    ? entry
    : (entry && (entry.import ?? entry.default ?? entry.node ?? entry.require)))
  const exportsField = pkg.exports
  let target
  if (subpath === '') {
    const isConditionMap = exportsField !== undefined && typeof exportsField === 'object'
      && !Object.keys(exportsField).some((key) => key.startsWith('.'))
    target = isConditionMap ? pick(exportsField) : undefined
    if (target === undefined) target = pick(exportsField?.['.'])
    if (target === undefined && typeof exportsField === 'string') target = exportsField
    if (target === undefined) target = pkg.main ?? pkg.module
  } else {
    const key = `./${subpath}`
    if (exportsField !== undefined && typeof exportsField === 'object') target = pick(exportsField[key])
    if (target === undefined) target = key
  }
  if (target === undefined) throw new Error(`cannot resolve "${specifier}" inside ${hostModules}`)
  return pathToFileURL(join(dir, target))
}

const hookSource = [
  `const hostModules = ${JSON.stringify(hostModules)};`,
  'import { readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'import { pathToFileURL } from "node:url";',
  `const isBareSpecifier = ${isBareSpecifier.toString()};`,
  `const resolveBare = ${resolveBare.toString()};`,
  'export async function resolve(specifier, context, next) {',
  '  if (!isBareSpecifier(specifier)) return next(specifier, context);',
  '  try { return { url: resolveBare(specifier).href, shortCircuit: true }; } catch { return next(specifier, context); }',
  '}',
].join('\n')

register(`data:text/javascript,${encodeURIComponent(hookSource)}`, import.meta.url)

const toolsModule = await import('@deepseek-ai/dsh-tools')
const subagentModule = await import('@deepseek-ai/dsh-subagent')
const plugin = await import(pathToFileURL(join(packageDir, 'lib', 'index.js')).href)
// The stock workflow tool AND the PTC executor are the independent oracles:
// the first is where the model-facing definition/section must come from, the
// second renders the PTC `tools:sdk` section the model actually programs
// against. Both are real host modules, never local stand-ins.
const stockWorkflowModule = await import('@deepseek-ai/dsh-tool-workflow')
const ptcExecutorModule = await import('@deepseek-ai/dsh-tool-executor-ptc')

/* ------------------------------------------------------------------ *
 * 2. Harness plumbing
 * ------------------------------------------------------------------ */

const failures = []
const passed = []

function messageOf(error) {
  return error instanceof Error && error.message ? error.message : String(error)
}

function normalizePath(value) {
  return value.split('\\').join('/')
}

/** Report one passing case; the detail goes before ` PASS` so the line ends with it. */
function pass(label, detail) {
  passed.push(label)
  console.log(detail === undefined ? `${label} PASS` : `${label} ${detail} PASS`)
}

async function probe(label, run) {
  try {
    const detail = await run()
    pass(label, detail)
    return true
  } catch (error) {
    failures.push(`${label}: ${messageOf(error)}`)
    console.log(`${label} FAIL ${messageOf(error)}`)
    return false
  }
}

async function rejectsWith(run, pattern, what) {
  let thrown
  try {
    await run()
  } catch (error) {
    thrown = error
  }
  if (thrown === undefined) throw new Error(`${what}: expected a rejection, but the call resolved`)
  if (!pattern.test(messageOf(thrown))) {
    throw new Error(`${what}: rejection message did not match ${pattern}: ${messageOf(thrown)}`)
  }
  return thrown
}

/** Key-order-insensitive deep equality, so assertions never depend on object insertion order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Capture the STOCK `workflow` definition and prompt section by running the
 * stock module's own `apply()` against a minimal fake context. This is the
 * independent oracle for the "same shape as the original" requirement: no
 * description, parameter or section text is ever copied into this script.
 *
 * `Config({})` is passed deliberately: the stock `apply()` reads its config
 * without defaults (plan OI4), so an empty object would capture
 * `toolName: undefined` and produce a garbage baseline.
 */
let stockWorkflowBaselineCache
async function stockWorkflowBaseline() {
  if (stockWorkflowBaselineCache !== undefined) return stockWorkflowBaselineCache
  const definitions = []
  const sections = []
  const fakeCtx = {
    systemPrompt: {
      section: (definition) => {
        sections.push(definition)
        return () => {}
      },
      getSectionOrder: () => 2600,
    },
    tools: {
      register: (definition) => {
        definitions.push(definition)
        return () => {}
      },
    },
    on: () => () => {},
    get: () => undefined,
    effect: (factory) => {
      factory()
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} },
  }
  stockWorkflowModule.apply(fakeCtx, stockWorkflowModule.Config({}))
  if (definitions.length !== 1) throw new Error(`stock workflow registered ${definitions.length} definitions, expected 1`)
  if (sections.length !== 1) throw new Error(`stock workflow registered ${sections.length} sections, expected 1`)
  const definition = definitions[0]
  const section = sections[0]
  if (definition.name !== TAKEOVER_STOCK_NAME) {
    throw new Error(`stock workflow name is ${String(definition.name)}, expected ${TAKEOVER_STOCK_NAME}`)
  }
  if (section.name !== `tool:${TAKEOVER_STOCK_NAME}`) {
    throw new Error(`stock workflow section name is ${String(section.name)}, expected tool:${TAKEOVER_STOCK_NAME}`)
  }
  stockWorkflowBaselineCache = { definition, section }
  return stockWorkflowBaselineCache
}

/* Fake LLM runtime: the same `reasoning.efforts` metadata shape the host returns. */
const ROUTES = {
  'deepseek-account/deepseek-flash': {
    reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' },
  },
  'deepseek-account/deepseek-lite': {
    reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' },
  },
  'deepseek-account/deepseek-nothink': {},
}

function createFakeLlm() {
  return {
    async resolveModelInfo(provider, model, signal) {
      if (signal?.aborted) throw new Error('aborted')
      const route = ROUTES[`${provider}/${model}`]
      if (route === undefined) throw new Error(`LLM provider "${provider}" does not serve model "${model}"`)
      return { provider, id: model, name: model, ...(route.reasoning === undefined ? {} : { reasoning: route.reasoning }) }
    },
  }
}

function fakeParent(options = {}) {
  return {
    id: 'parent-agent',
    options: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high', ...options },
    session: {
      header: { id: 'parent-session', delegationDepth: 0 },
      // `parentAgentOptionsForDelegation` reads the latest request header first.
      requestHeader: () => undefined,
    },
  }
}

/* ------------------------------------------------------------------ *
 * 2b. Seams the `run_workflow` tool drives (fake engine + minimal semver)
 * ------------------------------------------------------------------ */

/**
 * Minimal semver: enough to evaluate the peer ranges this plugin declares.
 *
 * Deliberately local — no `semver` dependency — because the assertion that the
 * declared range accepts BOTH 0.2.1-rc.2 and 0.2.2-rc.1 (and still rejects
 * 0.2.0 / 0.3.0) has to run in a bare checkout with no installed packages.
 * Implements semver 2.0.0 precedence (§11), including the rule that a
 * prerelease version only satisfies a comparator set when some comparator in
 * that set carries a prerelease on the SAME [major, minor, patch] tuple.
 */
function parseSemver(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text)
  if (match === null) throw new Error(`not a semver version: ${text}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareSemverIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key])
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1 // a release outranks any prerelease of it
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    if (left.pre[index] === undefined) return -1
    if (right.pre[index] === undefined) return 1
    const compared = compareSemverIdentifiers(left.pre[index], right.pre[index])
    if (compared !== 0) return compared
  }
  return 0
}

/** Parse one comparator set (`">=0.2.1-rc.2 <0.3.0"`) into comparators. */
function parseComparatorSet(text) {
  const tokens = text.trim().split(/\s+/).filter((token) => token !== '')
  if (tokens.length === 0) throw new Error(`empty comparator set in "${text}"`)
  return tokens.map((token) => {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token)
    if (match === null) throw new Error(`unsupported comparator "${token}" in "${text}"`)
    return { op: match[1] ?? '=', version: parseSemver(match[2]) }
  })
}

function satisfiesComparatorSet(versionText, comparators) {
  const version = parseSemver(versionText)
  for (const { op, version: bound } of comparators) {
    const compared = compareSemver(version, bound)
    const satisfied = op === '>=' ? compared >= 0
      : op === '>' ? compared > 0
        : op === '<=' ? compared <= 0
          : op === '<' ? compared < 0
            : compared === 0
    if (!satisfied) return false
  }
  if (version.pre.length === 0) return true
  // semver §11: a prerelease only matches when a comparator pins the same tuple
  // AND itself carries a prerelease.
  return comparators.some(({ version: bound }) => bound.pre.length > 0
    && bound.major === version.major && bound.minor === version.minor && bound.patch === version.patch)
}

/** `"A || B"` range membership with the minimal semver above. */
function satisfiesRange(versionText, rangeText) {
  return rangeText.split('||').some((part) => satisfiesComparatorSet(versionText, parseComparatorSet(part)))
}

/**
 * Fake `ctx.workflowEngine` — the seam `run_workflow` drives.
 *
 * The plugin's whole contract with the engine is
 * `start(request) -> { id, result, dispose }`, plus the `subagentProvider`
 * field on `request` (0.2.2 `dsh-workflow-ptc` accepts it; the stock
 * `workflow` tool never passes it). Recording `request` verbatim is exactly
 * what the host would have received.
 *
 * The fake also captures the temporary provider at `start()` time — that is the
 * only moment it is registered — so cases can exercise its delegation after the
 * tool has released it.
 */
function createFakeWorkflowEngine(state) {
  const engine = {
    calls: [],
    runs: [],
    behavior: {
      outcome: 'completed',
      value: undefined,
      startError: undefined,
      resultError: undefined,
      evaluateScript: false,
      // When set, the natural settlement waits for this promise. A case uses it
      // to keep the run LIVE while it drives `workflow/*` events: the mirror and
      // recorder subscribe between `start()` and settlement, so an event emitted
      // after the run settled would be dropped by both (stock `:21-35` / `:95-114`
      // look the run up in an `active` map that `stop` / `finish` has cleared).
      gate: undefined,
    },
    start(request) {
      engine.calls.push(request)
      if (typeof request.subagentProvider === 'string') {
        state.tempProviderName = request.subagentProvider
        state.tempProvider = state.providers.get(request.subagentProvider)
      }
      if (engine.behavior.startError !== undefined) throw engine.behavior.startError
      const record = { runId: `wf-run-${engine.runs.length + 1}`, disposed: 0, cancels: [] }
      engine.runs.push(record)
      let settleCancelled
      const cancelled = new Promise((resolveSettled) => {
        settleCancelled = resolveSettled
      })
      const natural = (async () => {
        if (engine.behavior.gate !== undefined) await engine.behavior.gate
        if (engine.behavior.resultError !== undefined) throw engine.behavior.resultError
        const value = engine.behavior.evaluateScript
          ? await evaluateWorkflowScript(request.script, request.args, state)
          : engine.behavior.value
        return { stopReason: engine.behavior.outcome, ...(value === undefined ? {} : { value }) }
      })()
      // A case may assert a synchronous start() failure without ever awaiting
      // the result; keep that rejection from surfacing as unhandled.
      natural.catch(() => {})
      // Cancellation outranks a still-open natural settlement (stock job path:
      // `cancel: (reason) => run.cancel(reason ?? "background workflow job killed")`).
      const result = Promise.race([natural, cancelled])
      result.catch(() => {})
      return {
        id: record.runId,
        result,
        cancel(reason) {
          record.cancels.push(reason)
          settleCancelled({ stopReason: 'cancelled' })
        },
        async dispose() {
          record.disposed += 1
        },
      }
    },
  }
  return engine
}

/**
 * Fake `ctx.get('jobs')` registry — the seam `run_in_background: true` drives.
 *
 * The contract asserted here is `dsh-jobs-local`'s own: `start(spec)` calls
 * `spec.run(handle)` SYNCHRONOUSLY before returning the id (`:439`), which is
 * what lets the tool read `run.id` for its `{ kind: 'background', jobId, runId }`
 * return; `kill` forwards to the producer's `cancel` (`:537-541`) and the
 * settlement is the producer's `done` (`:476-501`). Recording the `spec`
 * verbatim is exactly what the host registry would have received.
 */
function createFakeJobs() {
  const jobs = {
    starts: [],
    killCalls: [],
    start(spec) {
      const record = { id: `job-${jobs.starts.length + 1}`, spec, handle: undefined, producer: undefined }
      const handle = {
        id: record.id,
        progress: [],
        appends: [],
        updateProgress(title) {
          handle.progress.push(title)
        },
        append(text, options) {
          handle.appends.push({ text, options })
        },
      }
      record.handle = handle
      jobs.starts.push(record)
      record.producer = spec.run(handle)
      return record.id
    },
    kill(jobId, reason) {
      const record = jobs.starts.find((entry) => entry.id === jobId)
      jobs.killCalls.push({ jobId, reason })
      if (typeof record?.producer?.cancel !== 'function') {
        throw new Error(`kill(${String(jobId)}) reached no cancel handler`)
      }
      record.producer.cancel(reason)
      return record.producer.done
    },
    find(jobId) {
      return jobs.starts.find((entry) => entry.id === jobId)
    },
    last() {
      return jobs.starts[jobs.starts.length - 1]
    },
  }
  return jobs
}

/** A promise a case resolves by hand (gates the engine's settlement). */
function deferred() {
  let resolve
  const promise = new Promise((resolveIt) => {
    resolve = resolveIt
  })
  return { promise, resolve }
}

/** Let every already-queued microtask run — enough for a tool call to reach `await run.result`. */
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Settle a promise or fail the case. The gated cases hold a run open on
 * purpose; a plugin that never answers must surface as one red case, not as a
 * hung suite (a hang would leave the runbook without its `result:` line).
 */
function timed(promise, what, timeoutMs = 5000) {
  let timer
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${timeoutMs}ms`)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/**
 * Run a workflow script body the way the real engine does, with a recorder
 * `agent()` that mimics A1 (`null` means the child failed — never a success
 * value) and the `log` / `phase` / `args` globals.
 */
async function evaluateWorkflowScript(script, args, state) {
  const agentCalls = []
  const agent = async (prompt, options) => {
    agentCalls.push({ prompt, options })
    return null
  }
  const log = () => {}
  const phase = () => {}
  state.scriptAgentCalls = agentCalls
  const factory = new Function('agent', 'log', 'phase', 'args', `return (async () => {\n${script}\n})()`)
  return factory(agent, log, phase, args)
}

/** The stock tool name this plugin takes over, in the inherited (preset) layer. */
const TAKEOVER_STOCK_NAME = 'workflow'

/**
 * Mount the plugin on a fake context and return the recorder.
 * @param config - plugin config passed to `apply`.
 * @param options - `engine`: `'property'` (ctx.workflowEngine, default),
 *   `'get'` (only ctx.get('workflowEngine')), or `'none'` (neither).
 *   `agentPresets`: fake preset registry returned by ctx.get('agentPresets') —
 *   the only read that reaches an agent's isolated preset group.
 *   `stockTools`: the inherited tools face (defaults to the stock `workflow`).
 *   `agents`: fake `agents` service returned by ctx.get('agents') — the
 *   rescan source the takeover uses for agents that already exist.
 */
function mount(config = {}, options = {}) {
  const state = {
    providers: new Map(),
    tools: new Map(),
    activations: [],
    runs: [],
    effects: [],
    registerCalls: [],
    releases: [],
    doubleReleases: [],
    // Seams the stock tool drives and this plugin must feature-detect:
    // `ctx.tools.guard`, `ctx.systemPrompt`, `ctx.on`, `ctx.get('jobs')`,
    // and `parent.session.append`.
    guards: [],
    sections: [],
    // ONE OWN prompt-section table per agent, mirroring the host's scoped
    // `systemPrompt.section()` layers (`dsh-scope` `ScopedLayers.effect`):
    // a scoped entry with the same NAME shadows the global/preset one instead
    // of duplicating it (`merge()` = global first, nearest scope last).
    agentSections: new Map(),
    sectionOrderNames: [],
    listeners: new Map(),
    warnings: [],
    appends: [],
    jobs: undefined,
    // Same-name takeover seams (v0.5.0). `stockTools` is the INHERITED face —
    // the agent's preset layer, where the stock `workflow` tool lives —
    // `agentOwn` is one OWN table per agent, and `tools` stays this plugin's
    // global layer. `tools.get(name, scope)` merges them own-first, exactly
    // like the host's `view(scope)` (`dsh-tools/lib/index.js:3055-3074`).
    stockTools: new Map(options.stockTools ?? [[TAKEOVER_STOCK_NAME, { name: TAKEOVER_STOCK_NAME, stock: true }]]),
    agentOwn: new Map(),
    agentGuards: new Map(),
    agentRegisters: [],
    fiberDisposals: [],
    // PTC engine fallback seams: the official engine mount records here.
    pluginMounts: [],
    mountedEngine: undefined,
  }
  const parent = fakeParent()
  const appendMode = options.sessionAppend ?? 'record'
  if (appendMode !== 'none') {
    // The durable-record seam. `throw` models a session that refuses the
    // append: the tool must warn once and keep going (stock `:57-70`).
    parent.session.append = (type, data) => {
      if (appendMode === 'throw') throw new Error('session append refused')
      state.appends.push({ type, data })
    }
  }
  const engine = createFakeWorkflowEngine(state)
  const jobs = createFakeJobs()
  state.jobs = jobs
  state.engine = engine
  const engineMode = options.engine ?? 'property'
  const agentPresets = options.agentPresets
  const ctx = {
    subagents: {
      getProvider: (providerName) => state.providers.get(providerName),
      registerProvider: (provider) => {
        if (state.providers.has(provider.name)) throw new Error(`provider "${provider.name}" already registered`)
        state.providers.set(provider.name, provider)
        state.registerCalls.push(provider.name)
        // 0.2.2 returns the Cordis effect disposer; a second call is recorded
        // rather than silently swallowed so `disposed exactly once` is real.
        let released = false
        return () => {
          if (released) {
            state.doubleReleases.push(provider.name)
            return
          }
          released = true
          state.releases.push(provider.name)
          state.providers.delete(provider.name)
        }
      },
      async startActivation(spec) {
        state.activations.push(spec)
        const childId = `child-${state.activations.length}`
        const record = { childId, spec, disposed: 0 }
        state.runs.push(record)
        return {
          childId,
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: `child ${childId} done` }],
            ...(spec.request?.outputSchema === undefined ? {} : { structured: { answer: 'ok' } }),
          }),
          async dispose() {
            record.disposed += 1
          },
        }
      },
    },
    tools: {
      register: (definition) => {
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
      // Stock host contract: `guard(guard)` takes a FUNCTION whose argument is
      // the exec (`dsh-tools/lib/index.js:3017-3022`), and execution denies when
      // it returns a string (`:2743-2748`). Capturing the function — never a
      // name string — is what keeps these cases honest.
      guard: (guardFunction) => {
        state.guards.push(guardFunction)
        return () => {}
      },
      // `get(name, scope)` is the "is this name visible to that agent" read the
      // takeover pre-checks with (`dsh-tools/lib/index.js:3091-3092`); without
      // a scope it is the plain global lookup.
      get: (toolName, scope) => layeredToolGet(state, toolName, scope),
    },
    // `ctx.systemPrompt.section(...)` + `getSectionOrder(name)`; the host's
    // TOOL_WORKFLOW order is 2600 (`dsh-system-prompt/lib/index.js:31`).
    systemPrompt: {
      section: (definition) => {
        state.sections.push(definition)
        return () => {}
      },
      getSectionOrder: (name) => {
        state.sectionOrderNames.push(name)
        return 2600
      },
    },
    // The event bus the engine publishes `workflow/*` on. Handlers are kept so
    // `emit()` can drive them exactly as the engine would.
    on: (event, handler) => {
      const handlers = state.listeners.get(event) ?? []
      handlers.push(handler)
      state.listeners.set(event, handlers)
      return () => {}
    },
    effect: (factory) => {
      const disposable = factory()
      state.effects.push(disposable)
      return () => {}
    },
    logger: {
      info: () => {},
      warn: (message) => state.warnings.push(String(message)),
    },
    llm: createFakeLlm(),
  }
  if (engineMode === 'property') ctx.workflowEngine = engine
  // cordis also exposes services through `ctx.get(name)`; the plugin must try
  // both readings, so the harness has to be able to model either one. The
  // preset registry arrives the same way (`ctx.get('agentPresets')`) — that is
  // the only service that can read an agent's isolated preset group.
  ctx.get = (serviceName) => {
    if (serviceName === 'workflowEngine') return engineMode === 'none' ? state.mountedEngine : engine
    if (serviceName === 'ptcRuntime') return options.ptcRuntime
    if (serviceName === 'loader') return options.loader
    if (serviceName === 'agentPresets') return agentPresets
    if (serviceName === 'jobs') return options.jobs === 'none' ? undefined : jobs
    // `agents.list()` is the takeover's source for agents that already existed
    // when the plugin loaded (`dsh-tool-subagent/lib/index.js:564` / `:602`).
    if (serviceName === 'agents') return options.agents
    return undefined
  }
  /** Fire one `workflow/*` event the way the engine does; returns the handler count. */
  const emit = (event, ...args) => {
    const handlers = state.listeners.get(event) ?? []
    for (const handler of handlers) handler(...args)
    return handlers.length
  }
  // The official engine is mounted through `ctx.plugin` only when no preset
  // engine resolved. A `pluginThrows` option models a failing mount.
  ctx.plugin = async (Engine, pluginConfig) => {
    state.pluginMounts.push({ Engine, config: pluginConfig })
    if (options.pluginThrows !== undefined) throw new Error(options.pluginThrows)
    state.mountedEngine = options.mountedEngine ?? engine
    return { dispose() {} }
  }
  // LEGACY DEFAULT for the harness only: most cases drive the alias
  // implementation directly through the global `run_workflow` registration,
  // which production hides while the takeover is active (single disclosure).
  // A case opts into the production default with `{ exposeRunWorkflow:
  // undefined }`; `{ exposeRunWorkflow: true }` restores the alias explicitly.
  plugin.apply(ctx, { exposeRunWorkflow: true, ...config })
  return { ctx, state, parent, engine, jobs, emit }
}

/* ------------------------------------------------------------------ *
 * 2d. Agent-scope seams the same-name takeover drives (v0.5.0)
 * ------------------------------------------------------------------ */

/**
 * The layered read behind every `tools.get(name, scope)` in this harness.
 *
 * Host order (`dsh-tools/lib/index.js:3055-3074`): the scope's OWN layer wins,
 * then the inherited face (global + ancestor layers). A restriction filters the
 * inherited face only (`:3041`), which is why a name denied to one agent reads
 * back `undefined` instead of an error.
 */
function layeredToolGet(state, toolName, scope) {
  if (scope === undefined) return state.tools.get(toolName)
  // A restriction filters the inherited face (`dsh-tools/lib/index.js:3041`),
  // so a denied name must read back `undefined` even though the layer holds it.
  const denied = new Set(scope?.viewOptions?.denied ?? [])
  if (denied.has(toolName)) return undefined
  const own = state.agentOwn.get(scope)
  if (own !== undefined && own.has(toolName)) return own.get(toolName)
  return state.tools.get(toolName) ?? state.stockTools.get(toolName)
}

/**
 * The layered view behind `tools.view(scope)` — host contract
 * (`dsh-tools/lib/index.js:485-505`): a `visible` map (own layer over
 * inherited, minus restrictions) plus the PRE-restriction `knownNames` set.
 * That second field is what separates "this agent never had `workflow`" from
 * "`restrict({ deny: ['workflow'] })` filtered it": in the latter the name is
 * still known. `run_code` is the PTC executor's own transport and never sits
 * in the registry, so a case models it with `viewOptions.runCode`.
 */
function layeredToolView(state, scope) {
  const own = state.agentOwn.get(scope)
  const options = scope?.viewOptions ?? {}
  const denied = new Set(options.denied ?? [])
  const visible = new Map()
  const knownNames = new Set()
  for (const [name, definition] of state.tools) {
    knownNames.add(name)
    if (!denied.has(name)) visible.set(name, definition)
  }
  for (const [name, definition] of state.stockTools) {
    knownNames.add(name)
    if (!denied.has(name)) visible.set(name, definition)
  }
  if (own !== undefined) {
    for (const [name, definition] of own) {
      knownNames.add(name)
      visible.set(name, definition)
    }
  }
  if (options.runCode === true) {
    knownNames.add('run_code')
    visible.set('run_code', { name: 'run_code', ptcTransport: true })
  }
  return { visible, knownNames }
}

/**
 * One fake agent: its OWN tools table, its own guard list, and an
 * `agent.ctx.inject` modelling the host's thenable fiber.
 *
 * `inject` must be awaited before the registration is visible — the host
 * returns a thenable fiber (`cordis/lib/index.js:1600-1606`, usage
 * `dsh-tool-subagent/lib/index.js:585-593`) — so the callback lands on a
 * microtask here and two announcements in one tick really do race.
 *
 * `ownTools` (an array of `[name, definition]`) seeds the OWN layer, which is
 * how a case models "somebody else already holds this name here" and "an
 * earlier plugin instance left its definition behind".
 */
function makeFakeAgent(state, id, ownTools = [], viewOptions = {}) {
  const agent = { id }
  // What this agent's `view(scope)` reports: `runCode` models the PTC
  // transport; `denied` models a `restrict({ deny: [...] })` filter.
  agent.viewOptions = viewOptions
  const own = new Map()
  for (const [toolName, definition] of ownTools) own.set(toolName, definition)
  state.agentOwn.set(agent, own)
  const fiber = {
    paths: ['tools'],
    disposed: 0,
    dispose() {
      fiber.disposed += 1
      state.fiberDisposals.push(agent)
    },
  }
  agent.fiber = fiber
  const scopedTools = {
    // `NamedEntries.insert` throws only on a duplicate in the SAME table
    // (`dsh-scope/lib/index.js:27-38`); an inherited same-name is allowed —
    // that is exactly what a takeover relies on.
    register(definition) {
      if (own.has(definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered in this scope`)
      }
      own.set(definition.name, definition)
      state.agentRegisters.push({ agent, name: definition.name })
      return () => own.delete(definition.name)
    },
    guard(guardFunction) {
      const list = state.agentGuards.get(agent) ?? []
      list.push(guardFunction)
      state.agentGuards.set(agent, list)
      return () => {}
    },
    get: (toolName, scope) => layeredToolGet(state, toolName, scope),
    // `view(scope)` is the read the bounded PTC supplement uses to tell a
    // missing capability from a filtered one (`dsh-tools/lib/index.js:470-506`).
    view: (scope) => layeredToolView(state, scope ?? agent),
  }
  const scopedSections = new Map()
  state.agentSections.set(agent, scopedSections)
  const scopedPrompt = {
    // Same-scope duplicate names throw in the host (`NamedEntries`); an
    // ancestor's same-name section is NOT a duplicate — the nearer one wins
    // (`dsh-scope` `merge`).
    section(definition) {
      if (scopedSections.has(definition.name)) {
        throw new Error(`prompt section "${definition.name}" is already registered in this scope`)
      }
      scopedSections.set(definition.name, definition)
      return () => scopedSections.delete(definition.name)
    },
    getSectionOrder: () => 2600,
  }
  agent.ctx = {
    inject(_paths, callback) {
      const invoke = () => Promise.resolve()
        .then(() => callback({ tools: scopedTools, systemPrompt: scopedPrompt }))
        .then(() => fiber)
      return {
        then: (resolveInjected, rejectInjected) => invoke().then(resolveInjected, rejectInjected),
        catch: (rejectInjected) => invoke().then(undefined, rejectInjected),
      }
    },
  }
  return agent
}

/**
 * The prompt sections an agent actually assembles: the GLOBAL/preset layer
 * (modelled by `state.sections`) merged with that agent's OWN layer, nearest
 * scope winning a duplicate name — the host's `ScopedLayers.merge` order.
 */
function effectiveSections(state, agent) {
  const merged = new Map(state.sections.map((section) => [section.name, section]))
  const own = state.agentSections.get(agent)
  if (own !== undefined) for (const [name, section] of own) merged.set(name, section)
  return [...merged.values()]
}

/** Fire one agent-lifecycle event; returns the handlers' values, unawaited. */
function fireAgentEvent(state, event, payload) {
  const handlers = state.listeners.get(event) ?? []
  return handlers.map((handler) => handler(payload))
}

/** Announce a new agent the way `agent/created` (`mode: 'serial'`) does, and wait. */
async function announceAgent(state, agent) {
  for (const pending of fireAgentEvent(state, 'agent/created', { agent, source: 'check' })) await pending
}

/** Let deferred `inject` callbacks, awaits and queued microtasks settle. */
async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await tick()
}

/** The OWN tools table of one agent. */
function agentOwnOf(state, agent) {
  return state.agentOwn.get(agent) ?? new Map()
}

/** The guard list registered on ONE agent's scope. */
function agentGuardsOf(state, agent) {
  return state.agentGuards.get(agent) ?? []
}

/** The text `output.render` produced, for a part list or a single rendered value. */
function renderedText(definition, args, value) {
  const rendered = definition.output.render(args, value)
  return Array.isArray(rendered)
    ? rendered.map((part) => part?.text ?? '').join('')
    : String(rendered?.text ?? '')
}

function execFor(parent) {
  return { agent: parent, signal: new AbortController().signal }
}

/**
 * The same exec shape, but the calling agent carries a context.
 *
 * The engine lives in the agent's isolated preset group, which ctx.get cannot
 * walk to; `agentPresets.serviceFor` is the first read, and the agent's own
 * ctx is the next fallback when the registry is absent or misses. Modeling
 * both seams is the point of these cases.
 */
function execWithAgentCtx(parent, agentCtx) {
  return { agent: { ...parent, ctx: agentCtx }, signal: new AbortController().signal }
}

/**
 * Fake `ctx.agentPresets` registry — the only read that reaches an agent's
 * ISOLATED preset group.
 *
 * The host registers `workflowEngine` inside that group, where neither the
 * plugin's global ctx nor a plain `agent.ctx` property can see it; the host
 * API for it is `serviceFor(agent, name)`
 * (`dsh-agent-preset-registry/lib/index.js:725`). `impl` is the behaviour
 * under test; the recorder counts every call so a case can assert the registry
 * was consulted exactly once and with the calling agent.
 */
function fakeAgentPresets(impl) {
  const record = { calls: 0, names: [], agents: [] }
  return {
    record,
    serviceFor(agent, name) {
      record.calls += 1
      record.names.push(name)
      record.agents.push(agent)
      return impl(agent, name)
    },
  }
}

/** An agent ctx that records every read, so precedence can be asserted. */
function recordingAgentCtx() {
  const reads = []
  const ctx = {
    get(serviceName) {
      reads.push(`get:${serviceName}`)
      return undefined
    },
  }
  Object.defineProperty(ctx, 'workflowEngine', {
    get() {
      reads.push('property:workflowEngine')
      return undefined
    },
  })
  return { ctx, reads }
}

const EXPECTED_PARAMETERS = ['cwd', 'description', 'model', 'preset', 'prompt', 'provider', 'reasoning_effort', 'schema']

/* ------------------------------------------------------------------ *
 * 3. Cases
 * ------------------------------------------------------------------ */

// HOST_MODULES — the imports above resolved onto the installation, and the
// symbols this plugin relies on are the host's own.
const hostToolsPath = normalizePath(fileURLToPath(resolveBare('@deepseek-ai/dsh-tools')))
const hostSubagentPath = normalizePath(fileURLToPath(resolveBare('@deepseek-ai/dsh-subagent')))
{
  const problems = []
  if (!existsSync(hostToolsPath)) problems.push(`dsh-tools not found at ${hostToolsPath}`)
  if (!hostToolsPath.endsWith('node_modules/@deepseek-ai/dsh-tools/lib/index.js')) problems.push(`unexpected dsh-tools path ${hostToolsPath}`)
  if (!hostSubagentPath.endsWith('node_modules/@deepseek-ai/dsh-subagent/lib/index.js')) problems.push(`unexpected dsh-subagent path ${hostSubagentPath}`)
  for (const symbol of ['defineTool', 'assertObjectJsonSchema', 'valueSchemaSpecToJsonSchema', 'parameterSchemaSpecToJsonSchema']) {
    if (typeof toolsModule[symbol] !== 'function') problems.push(`dsh-tools export ${symbol} missing`)
  }
  for (const symbol of ['assertUsableCwd', 'parentAgentOptionsForDelegation', 'delegationDepthOf']) {
    if (typeof subagentModule[symbol] !== 'function') problems.push(`dsh-subagent export ${symbol} missing`)
  }
  if (problems.length > 0) {
    failures.push(`HOST_MODULES: ${problems.join('; ')}`)
    console.log(`HOST_MODULES FAIL ${problems.join('; ')}`)
  } else {
    // Ends with the path on purpose (the runbook greps this line for the host package).
    console.log(`HOST_MODULES PASS ${hostToolsPath}`)
  }
}

await probe('SCHEMA_DSL', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  if (tool === undefined) throw new Error('the dispatch_subagent definition was not registered')
  if (tool.parameters.type !== 'object') throw new Error(`parameters.type is ${tool.parameters.type}, expected object`)
  const names = Object.keys(tool.parameters.properties).sort()
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_PARAMETERS)) throw new Error(`parameter names are ${names.join(',')}`)
  if (JSON.stringify(tool.parameters.required) !== JSON.stringify(['prompt', 'description'])) {
    throw new Error(`root required is ${JSON.stringify(tool.parameters.required)}, expected prompt+description`)
  }
  for (const [name, node] of Object.entries(tool.parameters.properties)) {
    if (Object.hasOwn(node, 'required')) throw new Error(`parameter ${name} kept a per-property required flag in the compiled schema`)
  }
  if (tool.parameters.properties.schema.type !== undefined) {
    throw new Error('the `schema` parameter must stay an annotation-only `type: "json"` node')
  }
  // The host's own validator rejects a call that omits a required argument.
  await rejectsWith(() => tool.execute({ prompt: 'x' }, execFor(parent)), /invalid arguments/, 'missing description')
  // The DSL forbids an array-form required list inside `items` (allowRequired: false).
  let dslError
  try {
    toolsModule.defineTool({
      name: 'dsl_probe',
      description: 'probe',
      parameters: {
        rows: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: true,
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
      output: { schema: { type: 'string' }, render: () => [] },
      execute: () => 'ok',
    })
  } catch (error) {
    dslError = error
  }
  if (dslError === undefined) throw new Error('the host DSL accepted an array-form required list inside items')
  if (!/not supported by the value schema DSL/.test(messageOf(dslError))) {
    throw new Error(`unexpected DSL rejection: ${messageOf(dslError)}`)
  }
  return '8 dispatch_subagent parameters, property-level required, items-required rejected'
})

await probe('PROVIDER_LOCAL_CAPS', async () => {
  const { state } = mount()
  const provider = state.providers.get('dispatch-local')
  if (provider === undefined) throw new Error('dispatch-local was not registered')
  const caps = provider.capabilities
  for (const cap of ['agentPreset', 'agentOptions', 'outputSchema', 'depthLimit']) {
    if (caps[cap] !== true) throw new Error(`dispatch-local capabilities.${cap} is ${String(caps[cap])}, expected true`)
  }
  if (provider.inheritsParentContext !== false) throw new Error('dispatch-local inheritsParentContext must be false')
  if (typeof provider.prepareContinuable !== 'function') throw new Error('dispatch-local must implement prepareContinuable (local backend)')
  if (provider.start !== undefined) throw new Error('dispatch-local must not implement start (it is the local backend)')
  const prepared = await provider.prepareContinuable({ signal: new AbortController().signal })
  if (prepared === null || typeof prepared !== 'object' || Object.keys(prepared).length !== 0) {
    throw new Error(`prepareContinuable returned ${JSON.stringify(prepared)}, expected {}`)
  }
  return 'agentPreset/agentOptions/outputSchema/depthLimit=true, prepareContinuable={}'
})

await probe('PRESET_ON', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  await tool.execute({ prompt: 'do it', description: 'preset probe', preset: 'ptc' }, execFor(parent))
  if (state.activations.length !== 1) throw new Error(`expected 1 activation, saw ${state.activations.length}`)
  const spec = state.activations[0]
  if (spec.provider !== 'dispatch-local') throw new Error(`activation provider is ${String(spec.provider)}`)
  if (spec.request.agentPreset !== 'ptc') throw new Error(`request.agentPreset is ${String(spec.request.agentPreset)}`)
  if (spec.request.maxDepth !== 1) throw new Error(`request.maxDepth is ${String(spec.request.maxDepth)}, expected 1`)
  if (spec.label !== 'preset probe') throw new Error(`label is ${String(spec.label)}`)
  if (spec.delivery !== 'caller') throw new Error(`delivery is ${String(spec.delivery)}`)
  return 'request.agentPreset=ptc'
})

await probe('PRESET_OFF', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  await tool.execute({ prompt: 'do it', description: 'no preset' }, execFor(parent))
  const spec = state.activations[0]
  if (Object.hasOwn(spec.request, 'agentPreset')) throw new Error(`request.agentPreset was set without a preset argument: ${String(spec.request.agentPreset)}`)
  if (Object.hasOwn(spec.request, 'agentOptions')) throw new Error('request.agentOptions was set without any route/effort argument')
  if (Object.hasOwn(spec.request, 'outputSchema')) throw new Error('request.outputSchema was set without a schema argument')
  if (Object.hasOwn(spec.request, 'cwd')) throw new Error('request.cwd was set without a cwd argument')
  return 'agentPreset/agentOptions/outputSchema/cwd all absent'
})

await probe('EFFORT_ON', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  await tool.execute({
    prompt: 'do it',
    description: 'effort probe',
    provider: 'deepseek-account',
    model: 'deepseek-lite',
    reasoning_effort: 'high',
  }, execFor(parent))
  const spec = state.activations[0]
  const options = spec.request.agentOptions
  if (options === undefined) throw new Error('request.agentOptions is missing')
  if (options.reasoningEffort !== 'high') throw new Error(`agentOptions.reasoningEffort is ${String(options.reasoningEffort)}`)
  if (options.model !== 'deepseek-lite') throw new Error(`agentOptions.model is ${String(options.model)}`)
  if (options.provider !== 'deepseek-account') throw new Error(`agentOptions.provider is ${String(options.provider)}`)
  return 'agentOptions={provider,model,reasoningEffort:high}'
})

await probe('EFFORT_ONLY', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  await tool.execute({ prompt: 'do it', description: 'effort only', reasoning_effort: 'max' }, execFor(parent))
  const spec = state.activations[0]
  const options = spec.request.agentOptions
  if (options === undefined) throw new Error('request.agentOptions is missing')
  if (options.reasoningEffort !== 'max') throw new Error(`agentOptions.reasoningEffort is ${String(options.reasoningEffort)}`)
  if (Object.hasOwn(options, 'provider') || Object.hasOwn(options, 'model')) {
    throw new Error(`an effort-only call must not pin a route: ${JSON.stringify(options)}`)
  }
  return 'agentOptions={reasoningEffort:max} with the parent route inherited'
})

await probe('EFFORT_UNSUPPORTED', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  const error = await rejectsWith(() => tool.execute({
    prompt: 'do it',
    description: 'bad effort',
    model: 'deepseek-lite',
    provider: 'deepseek-account',
    reasoning_effort: 'max',
  }, execFor(parent)), /does not support reasoning effort "max"/, 'unsupported effort')
  if (!/supported efforts: low, high/.test(messageOf(error))) {
    throw new Error(`the error does not list the supported efforts: ${messageOf(error)}`)
  }
  if (state.activations.length !== 0) throw new Error('a child was started despite the invalid effort')
  return 'rejected before dispatch, lists low, high'
})

await probe('EFFORT_NO_REASONING', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  const error = await rejectsWith(() => tool.execute({
    prompt: 'do it',
    description: 'no reasoning model',
    model: 'deepseek-nothink',
    provider: 'deepseek-account',
    reasoning_effort: 'high',
  }, execFor(parent)), /does not support reasoning effort "high"/, 'model without reasoning metadata')
  if (!/advertises no reasoning efforts/.test(messageOf(error))) {
    throw new Error(`the error does not explain the missing metadata: ${messageOf(error)}`)
  }
  if (state.activations.length !== 0) throw new Error('a child was started despite the unsupported effort')
  return 'rejected before dispatch, explains the model advertises none'
})

await probe('ROUTE_UNRESOLVABLE', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  const error = await rejectsWith(() => tool.execute({
    prompt: 'do it',
    description: 'bad route',
    provider: 'missing-provider',
    model: 'some-model',
  }, execFor(parent)), /cannot resolve the child LLM route "missing-provider\/some-model"/, 'unknown route')
  if (!/does not serve model/.test(messageOf(error))) throw new Error(`the underlying cause was dropped: ${messageOf(error)}`)
  if (state.activations.length !== 0) throw new Error('a child was started on an unresolvable route')
  return 'rejected before dispatch, host cause preserved'
})

await probe('ROUTE_PAIR', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  await rejectsWith(() => tool.execute({
    prompt: 'do it',
    description: 'provider only',
    provider: 'deepseek-account',
  }, execFor(parent)), /`provider` and `model` must be supplied together/, 'provider without model')
  await rejectsWith(() => tool.execute({
    prompt: 'do it',
    description: 'model only',
    model: 'deepseek-lite',
  }, execFor(parent)), /`provider` and `model` must be supplied together/, 'model without provider')
  if (state.activations.length !== 0) throw new Error('a child was started with a half-specified route')
  return 'both half-route shapes rejected before dispatch'
})

const STRUCTURED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string' } },
  required: ['answer'],
}

await probe('SCHEMA_OUTPUT', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  // The host accepts this schema on the subagent structured-output path.
  toolsModule.assertObjectJsonSchema(STRUCTURED_SCHEMA)
  const value = await tool.execute({
    prompt: 'answer',
    description: 'structured probe',
    schema: STRUCTURED_SCHEMA,
  }, execFor(parent))
  const spec = state.activations[0]
  if (JSON.stringify(spec.request.outputSchema) !== JSON.stringify(STRUCTURED_SCHEMA)) {
    throw new Error(`request.outputSchema is ${JSON.stringify(spec.request.outputSchema)}`)
  }
  if (JSON.stringify(value.structured) !== JSON.stringify({ answer: 'ok' })) {
    throw new Error(`the tool did not surface the structured result: ${JSON.stringify(value)}`)
  }
  return 'request.outputSchema forwarded, host assertObjectJsonSchema accepts it'
})

await probe('SCHEMA_REJECTED', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  await rejectsWith(() => tool.execute({
    prompt: 'answer',
    description: 'bad schema',
    schema: { type: 'string' },
  }, execFor(parent)), /object-rooted/, 'string-rooted schema')
  await rejectsWith(() => tool.execute({
    prompt: 'answer',
    description: 'bad schema 2',
    // A keyword outside the enforced subset (the host rejects it by name).
    schema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string', minLength: 3 } } },
  }, execFor(parent)), /not a supported keyword/, 'schema outside the enforced subset')
  if (state.activations.length !== 0) throw new Error('a child was started with an invalid output schema')
  return 'non-object root and unsupported keyword both rejected before dispatch'
})

await probe('CWD_INVALID', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get('dispatch_subagent')
  await rejectsWith(() => tool.execute({
    prompt: 'do it',
    description: 'relative cwd',
    cwd: 'relative/dir',
  }, execFor(parent)), /cwd must be an absolute path/, 'relative cwd')
  await rejectsWith(() => tool.execute({
    prompt: 'do it',
    description: 'missing cwd',
    cwd: join(packageDir, 'does-not-exist'),
  }, execFor(parent)), /cwd is not an accessible directory/, 'missing cwd')
  if (state.activations.length !== 0) throw new Error('a child was started with an unusable cwd')
  return 'relative and missing directories rejected by the host assertUsableCwd'
})

await probe('PROVIDER_CAPS', async () => {
  const { state } = mount()
  const provider = state.providers.get('dispatch')
  if (provider === undefined) throw new Error('the external dispatch provider was not registered')
  if (provider.capabilities.agentPreset !== true) throw new Error('capabilities.agentPreset must be true')
  if (provider.capabilities.agentOptions !== true) throw new Error('capabilities.agentOptions must be true (effort/model are forwarded)')
  if (provider.capabilities.outputSchema !== true) throw new Error('capabilities.outputSchema must be true (the schema is forwarded)')
  if (provider.inheritsParentContext !== false) throw new Error('inheritsParentContext must be false')
  if (typeof provider.start !== 'function') throw new Error('the external provider must implement start')
  if (provider.prepareContinuable !== undefined) throw new Error('the external provider must not implement prepareContinuable (that would select the local backend)')
  return 'agentPreset=true, inheritsParentContext=false, start only'
})

await probe('PROVIDER_DELEGATION', async () => {
  const { state, parent } = mount({
    preset: 'ptc',
    reasoningEffort: 'max',
    model: 'deepseek-flash',
    routeProvider: 'deepseek-account',
  })
  const provider = state.providers.get('dispatch')
  const prompt = [{ type: 'text', text: 'whole-run prompt' }]
  const run = await provider.start({
    parent,
    prompt,
    label: 'workflow-run',
    signal: new AbortController().signal,
    maxDepth: 1,
  })
  if (state.activations.length !== 1) throw new Error(`expected 1 delegated activation, saw ${state.activations.length}`)
  const spec = state.activations[0]
  if (spec.provider !== 'spawn') throw new Error(`delegated provider is ${String(spec.provider)}, expected spawn`)
  if (spec.request.agentPreset !== 'ptc') throw new Error(`delegated request.agentPreset is ${String(spec.request.agentPreset)}`)
  if (JSON.stringify(spec.request.agentOptions) !== JSON.stringify({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  })) throw new Error(`delegated agentOptions are ${JSON.stringify(spec.request.agentOptions)}`)
  if (spec.request.maxDepth !== 1) throw new Error(`delegated maxDepth is ${String(spec.request.maxDepth)}`)
  if (spec.request.parent !== parent) throw new Error('the delegated request did not reuse the caller parent')
  if (JSON.stringify(spec.request.prompt) !== JSON.stringify(prompt)) throw new Error('the delegated prompt was not forwarded verbatim')
  if (typeof run?.id !== 'string' || typeof run?.dispose !== 'function') throw new Error('start did not return { id, result, dispose }')
  if (typeof run.result?.then !== 'function') throw new Error('start did not return a promise as result')
  if ((await run.result).stopReason !== 'completed') throw new Error('the delegated result did not reach the caller')
  return 'spawn + preset=ptc + effort=max + model=deepseek-flash forwarded'
})

await probe('PROVIDER_NO_RECURSION', async () => {
  const ctxFor = () => {
    const state = { providers: new Map() }
    return {
      subagents: {
        getProvider: (providerName) => state.providers.get(providerName),
        registerProvider: (provider) => state.providers.set(provider.name, provider),
        async startActivation() { throw new Error('must not start') },
      },
      tools: { register: () => () => {} },
      effect: (factory) => { factory() },
      logger: { info: () => {}, warn: () => {} },
      llm: createFakeLlm(),
    }
  }
  let thrown = 0
  for (const [config, pattern] of [
    [{ providerName: 'spawn', delegateProviderName: 'spawn' }, /`delegateProviderName` must not equal `providerName`/],
    [{ providerName: 'dispatch', localProviderName: 'dispatch' }, /`providerName` and `localProviderName` must differ/],
    [{ localProviderName: 'loop', delegateProviderName: 'loop' }, /`delegateProviderName` must not equal `localProviderName`/],
  ]) {
    try {
      plugin.apply(ctxFor(), config)
      throw new Error(`apply accepted a self-delegating config: ${JSON.stringify(config)}`)
    } catch (error) {
      if (!pattern.test(messageOf(error))) throw error
      thrown += 1
    }
  }
  if (thrown !== 3) throw new Error(`expected 3 self-delegation rejections, saw ${thrown}`)
  return 'providerName/localProviderName/delegateProviderName collisions all rejected'
})

await probe('PROVIDER_RUN_ID_SYNTHETIC', async () => {
  const { state, parent } = mount({ preset: 'standard' })
  const provider = state.providers.get('dispatch')
  const run = await provider.start({
    parent,
    prompt: [{ type: 'text', text: 'x' }],
    signal: new AbortController().signal,
  })
  const innerChildId = state.activations[0] && state.runs[0].childId
  if (!/^dispatch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run.id)) {
    throw new Error(`run.id is "${run.id}", expected dispatch:<uuid>`)
  }
  if (run.id === innerChildId) throw new Error('run.id must not pretend to be the inner child id')
  const second = await provider.start({
    parent,
    prompt: [{ type: 'text', text: 'y' }],
    signal: new AbortController().signal,
  })
  if (second.id === run.id) throw new Error('two runs share one synthetic id')
  return 'run.id is a fresh dispatch:<uuid> per run'
})

await probe('PROVIDER_DISPOSE', async () => {
  const { state, parent } = mount()
  const provider = state.providers.get('dispatch')
  const run = await provider.start({
    parent,
    prompt: [{ type: 'text', text: 'x' }],
    signal: new AbortController().signal,
  })
  const record = state.runs[0]
  await run.result
  await run.dispose()
  if (record.disposed !== 1) throw new Error(`inner dispose ran ${record.disposed} times, expected 1`)
  await run.dispose()
  if (record.disposed !== 1) throw new Error(`dispose is not idempotent: ${record.disposed} inner disposals`)
  return 'dispose forwards once and is idempotent'
})

/* ------------------------------------------------------------------ *
 * 3b. Cases for `run_workflow` (per-run preset / effort / model)
 * ------------------------------------------------------------------ */

const WF_TOOL_NAME = 'run_workflow'
// NARROW EXCEPTION (plan §2.5 / T4 change-notes): `run_workflow` gained the
// `run_in_background` argument, so this exact-name list grows by one. Nothing
// else in this case changed.
const WF_PARAMETERS = ['args', 'max_total_agents', 'meta', 'model', 'preset', 'provider', 'reasoning_effort', 'run_in_background', 'script']
const WF_SCRIPT = "const child = await agent('do it', { label: 'probe' }); return { child }"
// The stock `meta` object requires BOTH `name` and `description`
// (`dsh-tool-workflow/lib/index.js:279-294`), and the plugin keeps that schema
// verbatim, so every fixture carries both.
const WF_META = { name: 'probe-workflow', description: 'Probe workflow used by the self-check.' }
const TEMP_PREFIX_STATE = (state) => state.registerCalls.filter((name) => name !== 'dispatch' && name !== 'dispatch-local')

await probe('WF_TOOL_SCHEMA', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  if (tool === undefined) throw new Error(`the ${WF_TOOL_NAME} definition was not registered`)
  if (tool.parameters.type !== 'object') throw new Error(`${WF_TOOL_NAME} parameters.type is ${String(tool.parameters.type)}`)
  const names = Object.keys(tool.parameters.properties).sort()
  if (JSON.stringify(names) !== JSON.stringify(WF_PARAMETERS)) {
    throw new Error(`${WF_TOOL_NAME} parameter names are ${names.join(',')}, expected ${WF_PARAMETERS.join(',')}`)
  }
  const required = [...(tool.parameters.required ?? [])].sort()
  if (JSON.stringify(required) !== JSON.stringify(['meta', 'script'])) {
    throw new Error(`${WF_TOOL_NAME} root required is ${JSON.stringify(tool.parameters.required)}, expected script+meta only`)
  }
  for (const [name, node] of Object.entries(tool.parameters.properties)) {
    // The compiled schema may legitimately carry a nested `required` ARRAY on
    // an object parameter (stock `meta` does); only the authoring shorthand —
    // a boolean `required: true` left on the property node — is forbidden.
    if (node.required === true) throw new Error(`parameter ${name} kept a per-property required flag in the compiled schema`)
  }
  if (tool.parameters.properties.script.type !== 'string') throw new Error(`script.type is ${String(tool.parameters.properties.script.type)}`)
  if (tool.parameters.properties.meta.type !== 'object') throw new Error(`meta.type is ${String(tool.parameters.properties.meta.type)}`)
  const maxDescription = String(tool.parameters.properties.max_total_agents.description ?? '')
  // A3: the description must say "positive integer" and point at the engine
  // request field, so a model knows how the cap is applied. The exact spelling
  // of the field is the implementation's, so accept `request.maxTotalAgents`
  // and `the engine request \`maxTotalAgents\`` alike.
  if (!/positive integer/i.test(maxDescription)) {
    throw new Error(`max_total_agents must document a positive integer cap, got: ${maxDescription}`)
  }
  if (!/maxTotalAgents/.test(maxDescription) || !/request/i.test(maxDescription)) {
    throw new Error(`max_total_agents must document the forwarded request.maxTotalAgents field, got: ${maxDescription}`)
  }
  // The host's own validator enforces the required pair before execute() runs.
  await rejectsWith(() => tool.execute({ script: WF_SCRIPT }, execFor(parent)), /invalid arguments/, 'meta omitted')
  if (state.engine.calls.length !== 0) throw new Error('an invalid call reached the workflow engine')
  return '9 parameters, required=script+meta, max_total_agents→request.maxTotalAgents'
})

await probe('WF_NO_ENGINE', async () => {
  const { state, parent } = mount({}, { engine: 'none' })
  const tool = state.tools.get(WF_TOOL_NAME)
  const error = await rejectsWith(
    () => tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent)),
    /no workflow engine/,
    'host without a workflow engine',
  )
  if (state.engine.calls.length !== 0) throw new Error('start() was reached without a workflow engine')
  if (TEMP_PREFIX_STATE(state).length !== 0) throw new Error('a provider was registered without a workflow engine')
  return `rejected before dispatch (${messageOf(error).slice(0, 48)}…)`
})

// The stock `ptc` preset ships `workflow-ptc` / `tool-workflow` disabled, so a
// PTC agent has no engine at any readable scope. The plugin must mount the
// OFFICIAL engine on first use — and only then.
await probe('WF_PTC_ENGINE_MOUNT', async () => {
  const { state, parent } = mount({}, { engine: 'none', ptcRuntime: { language: 'typescript' } })
  const tool = state.tools.get(WF_TOOL_NAME)
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  if (state.pluginMounts.length !== 1) throw new Error(`ctx.plugin called ${state.pluginMounts.length} times, expected 1`)
  const provider = state.pluginMounts[0]?.config?.provider
  if (provider !== 'spawn') throw new Error(`engine mount provider is ${JSON.stringify(provider)}, expected spawn`)
  if (state.engine.calls.length !== 1) throw new Error(`engine.start called ${state.engine.calls.length} times, expected 1`)
  if (value.runId !== state.engine.runs[0].runId) throw new Error('the run id did not come from the mounted engine')
  return 'no preset engine + ts PTC runtime -> official engine mounted once, run completed'
})

await probe('WF_PTC_ENGINE_LOADER', async () => {
  const loaderCalls = []
  function FakeEngine() {}
  const { state, parent } = mount({}, {
    engine: 'none',
    ptcRuntime: { language: 'typescript' },
    loader: {
      import: async (name) => {
        loaderCalls.push(name)
        return { default: FakeEngine }
      },
    },
  })
  const tool = state.tools.get(WF_TOOL_NAME)
  await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  if (loaderCalls.length !== 1 || loaderCalls[0] !== '@deepseek-ai/dsh-workflow-ptc') {
    throw new Error(`loader.import saw ${JSON.stringify(loaderCalls)}, expected the engine package once`)
  }
  if (state.pluginMounts.length !== 1) throw new Error('the engine was not mounted through the loader module')
  if (state.pluginMounts[0].Engine !== FakeEngine) throw new Error('the mounted class came from somewhere else')
  if (state.engine.calls.length !== 1) throw new Error('the workflow did not run after the loader mount')
  return 'loader.import routed the engine package; mounted once; run completed'
})

await probe('WF_PTC_ENGINE_LOADER_FALLBACK', async () => {
  const { state, parent } = mount({}, {
    engine: 'none',
    ptcRuntime: { language: 'typescript' },
    loader: { import: async () => { throw new Error('synthetic loader miss') } },
  })
  const tool = state.tools.get(WF_TOOL_NAME)
  await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  if (state.pluginMounts.length !== 1) throw new Error('a loader miss must fall back to the bare import, not abort the mount')
  if (!state.warnings.some((line) => /synthetic loader miss/.test(line))) throw new Error('the loader miss was not warned')
  return 'loader miss warned, bare import used, engine mounted once'
})

await probe('WF_PTC_ENGINE_CACHED', async () => {
  const { state, parent } = mount({}, { engine: 'none', ptcRuntime: { language: 'typescript' } })
  const tool = state.tools.get(WF_TOOL_NAME)
  await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  if (state.pluginMounts.length !== 1) throw new Error(`ctx.plugin called ${state.pluginMounts.length} times for 2 calls, expected 1`)
  if (state.engine.calls.length !== 2) throw new Error(`engine.start called ${state.engine.calls.length} times, expected 2`)
  return 'the second call reuses the mounted engine (1 mount, 2 starts)'
})

await probe('WF_PTC_ENGINE_SKIPPED', async () => {
  const { state, parent } = mount({}, { engine: 'property', ptcRuntime: { language: 'typescript' } })
  const tool = state.tools.get(WF_TOOL_NAME)
  await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  if (state.pluginMounts.length !== 0) throw new Error('ctx.plugin was called although a preset engine resolved')
  if (state.engine.calls.length !== 1) throw new Error('the preset engine was not used')
  return 'preset engine wins; the fallback is never mounted'
})

await probe('WF_PTC_ENGINE_NO_RUNTIME', async () => {
  const { state, parent } = mount({}, { engine: 'none' })
  const tool = state.tools.get(WF_TOOL_NAME)
  const error = await rejectsWith(
    () => tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent)),
    /no workflow engine/,
    'no engine + no PTC runtime',
  )
  if (!/TypeScript PTC runtime/.test(messageOf(error))) throw new Error(`the error lacks the runtime reason: ${messageOf(error)}`)
  if (state.pluginMounts.length !== 0) throw new Error('ctx.plugin was called without a PTC runtime')
  if (state.engine.calls.length !== 0) throw new Error('start() was reached without an engine')
  if (TEMP_PREFIX_STATE(state).length !== 0) throw new Error('a provider was registered without an engine')
  return 'no runtime -> readable error, no mount, no provider, no start'
})

await probe('WF_PTC_ENGINE_MOUNT_FAILS', async () => {
  const { state, parent } = mount({}, {
    engine: 'none',
    ptcRuntime: { language: 'typescript' },
    pluginThrows: 'synthetic mount failure',
  })
  const tool = state.tools.get(WF_TOOL_NAME)
  const error = await rejectsWith(
    () => tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent)),
    /no workflow engine/,
    'a failing engine mount',
  )
  if (!/synthetic mount failure/.test(messageOf(error))) throw new Error(`the error lacks the mount cause: ${messageOf(error)}`)
  if (state.engine.calls.length !== 0) throw new Error('start() was reached after a failed mount')
  if (TEMP_PREFIX_STATE(state).length !== 0) throw new Error('a provider was registered after a failed mount')
  return 'mount failure -> original error + cause, no provider, no start'
})

// The engine lives in the preset scope of the CALLING AGENT, not in this
// plugin's global scope. These cases mount the plugin without a reachable
// engine and hand one over only through `exec.agent.ctx`.
await probe('WF_ENGINE_AGENT_SCOPE', async () => {
  const { state, parent } = mount({}, { engine: 'none' })
  const tool = state.tools.get(WF_TOOL_NAME)
  // Plugin ctx exposes nothing (engine: 'none' makes both of its reads empty).
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execWithAgentCtx(parent, {
    get: (serviceName) => (serviceName === 'workflowEngine' ? state.engine : undefined),
  }))
  if (state.engine.calls.length !== 1) {
    throw new Error(`expected exactly 1 engine.start call through agent.ctx, saw ${state.engine.calls.length}`)
  }
  if (value.runId !== state.engine.runs[0].runId) {
    throw new Error(`output runId is ${String(value.runId)}, expected the agent-scope run ${state.engine.runs[0].runId}`)
  }
  return 'plugin ctx empty, agent.ctx.get("workflowEngine") resolved it, start() 1×'
})

await probe('WF_ENGINE_FALLBACK', async () => {
  const { state, parent } = mount() // plugin ctx.workflowEngine is the usable fake engine
  const tool = state.tools.get(WF_TOOL_NAME)
  // An OBJECT under the same name without a callable start() is not a hit.
  const unusable = { start: 'not-a-function' }
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execWithAgentCtx(parent, {
    workflowEngine: unusable,
    get: (serviceName) => (serviceName === 'workflowEngine' ? unusable : undefined),
  }))
  if (state.engine.calls.length !== 1) {
    throw new Error(`the plugin-scope engine was not used as the fallback (start calls: ${state.engine.calls.length})`)
  }
  if (value.runId !== state.engine.runs[0].runId) {
    throw new Error(`output runId is ${String(value.runId)}, expected the plugin-scope run ${state.engine.runs[0].runId}`)
  }
  return 'agent ctx object without callable start() skipped, plugin ctx engine used'
})

await probe('WF_ENGINE_AGENT_PRECEDENCE', async () => {
  const { state, parent } = mount() // plugin-scope engine that must NOT be reached
  const tool = state.tools.get(WF_TOOL_NAME)
  const agentStarts = []
  const agentEngine = {
    start(request) {
      agentStarts.push(request)
      return {
        id: 'agent-scope-run',
        result: Promise.resolve({ stopReason: 'completed', value: { scope: 'agent' } }),
        async dispose() {},
      }
    },
  }
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execWithAgentCtx(parent, {
    workflowEngine: agentEngine,
  }))
  if (agentStarts.length !== 1) throw new Error(`the agent-scope engine was called ${agentStarts.length} times, expected 1`)
  if (state.engine.calls.length !== 0) throw new Error('the plugin-scope engine was reached although the agent scope had one')
  if (value.runId !== 'agent-scope-run') throw new Error(`output runId is ${String(value.runId)}, expected the agent-scope run`)
  return 'agent scope wins over plugin scope (1 vs 0 start calls)'
})

// The real failure shape: the engine is mounted inside the agent's isolated
// preset group, so neither ctx exposes it as `workflowEngine`; only
// `agentPresets.serviceFor(agent, 'workflowEngine')` reaches it.
await probe('WF_ENGINE_PRESET_SCOPE', async () => {
  let presetEngine
  const presets = fakeAgentPresets(() => presetEngine)
  const { state, parent } = mount({}, { engine: 'none', agentPresets: presets })
  presetEngine = state.engine
  const { ctx: agentCtx, reads } = recordingAgentCtx()
  const tool = state.tools.get(WF_TOOL_NAME)
  const exec = execWithAgentCtx(parent, agentCtx)
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META }, exec)
  if (presets.record.calls !== 1) {
    throw new Error(`agentPresets.serviceFor was called ${presets.record.calls} times, expected exactly 1`)
  }
  if (presets.record.names[0] !== 'workflowEngine') {
    throw new Error(`serviceFor asked for "${String(presets.record.names[0])}", expected "workflowEngine"`)
  }
  if (presets.record.agents[0] !== exec.agent) {
    throw new Error('serviceFor did not receive the calling agent')
  }
  if (state.engine.calls.length !== 1) {
    throw new Error(`expected exactly 1 engine.start call through agentPresets, saw ${state.engine.calls.length}`)
  }
  if (reads.length !== 0) {
    throw new Error(`agent.ctx was consulted after serviceFor resolved the engine: ${reads.join(',')}`)
  }
  if (value.runId !== state.engine.runs[0].runId) {
    throw new Error(`output runId is ${String(value.runId)}, expected the preset-scope run ${state.engine.runs[0].runId}`)
  }
  return 'plugin ctx + agent.ctx empty, agentPresets.serviceFor resolved it (1 call), start() 1×'
})

// An older/incompatible registry may throw from serviceFor; that must be a
// silent miss, not a failed tool call. The plugin ctx engine is the fallback.
await probe('WF_ENGINE_SERVICEFOR_THROWS', async () => {
  const presets = fakeAgentPresets(() => {
    throw new Error('registry exploded')
  })
  const { state, parent } = mount({}, { agentPresets: presets })
  const tool = state.tools.get(WF_TOOL_NAME)
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  if (presets.record.calls !== 1) {
    throw new Error(`serviceFor was called ${presets.record.calls} times, expected 1 before falling through`)
  }
  if (state.engine.calls.length !== 1) {
    throw new Error(`a throwing serviceFor suppressed the plugin-scope fallback (start calls: ${state.engine.calls.length})`)
  }
  if (value.runId !== state.engine.runs[0].runId) {
    throw new Error(`output runId is ${String(value.runId)}, expected the plugin-scope run ${state.engine.runs[0].runId}`)
  }
  return 'throwing serviceFor ignored, plugin ctx engine used'
})

// A service object that is present but not an engine must not shadow the real
// one: `start` has to be callable, exactly like the property reads.
await probe('WF_ENGINE_SERVICEFOR_NOT_CALLABLE', async () => {
  const presets = fakeAgentPresets(() => ({ start: 'not-a-function' }))
  const { state, parent } = mount({}, { agentPresets: presets })
  const tool = state.tools.get(WF_TOOL_NAME)
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  if (presets.record.calls !== 1) {
    throw new Error(`serviceFor was called ${presets.record.calls} times, expected 1 before falling through`)
  }
  if (state.engine.calls.length !== 1) {
    throw new Error(`a non-callable start shadowed the plugin-scope engine (start calls: ${state.engine.calls.length})`)
  }
  if (value.runId !== state.engine.runs[0].runId) {
    throw new Error(`output runId is ${String(value.runId)}, expected the plugin-scope run ${state.engine.runs[0].runId}`)
  }
  return 'serviceFor object without callable start() skipped, plugin ctx engine used'
})

await probe('WF_EMPTY_SCRIPT', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  await rejectsWith(() => tool.execute({ script: '   ', meta: WF_META }, execFor(parent)), /script/, 'blank script')
  await rejectsWith(() => tool.execute({ script: 42, meta: WF_META }, execFor(parent)), /script/, 'non-string script')
  if (state.engine.calls.length !== 0) throw new Error('start() was reached with an empty script')
  return 'blank and non-string scripts rejected before start()'
})

await probe('WF_BAD_META', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  for (const meta of [null, [], 'x']) {
    await rejectsWith(
      () => tool.execute({ script: WF_SCRIPT, meta }, execFor(parent)),
      /meta/,
      `meta ${JSON.stringify(meta)}`,
    )
  }
  if (state.engine.calls.length !== 0) throw new Error('start() was reached with a non-object meta')
  return 'null / array / string meta all rejected before start()'
})

await probe('WF_EFFORT_UNSUPPORTED', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  const error = await rejectsWith(() => tool.execute({
    script: WF_SCRIPT,
    meta: WF_META,
    provider: 'deepseek-account',
    model: 'deepseek-lite',
    reasoning_effort: 'max',
  }, execFor(parent)), /does not support reasoning effort "max"/, 'unsupported per-run effort')
  if (!/supported efforts: low, high/.test(messageOf(error))) {
    throw new Error(`the error does not list the supported efforts: ${messageOf(error)}`)
  }
  if (state.engine.calls.length !== 0) throw new Error('start() was reached despite the invalid effort')
  if (TEMP_PREFIX_STATE(state).length !== 0) throw new Error('a temporary provider was registered despite the invalid effort')
  return 'rejected before start(), lists low, high, no provider registered'
})

await probe('WF_TEMP_PROVIDER', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META, preset: 'ptc', reasoning_effort: 'high' }, execFor(parent))
  if (state.engine.calls.length !== 1) throw new Error(`expected 1 engine.start call, saw ${state.engine.calls.length}`)
  const request = state.engine.calls[0]
  const tempName = request.subagentProvider
  if (typeof tempName !== 'string' || tempName === '') throw new Error(`engine received subagentProvider=${String(tempName)}`)
  if (tempName === 'dispatch' || tempName === 'dispatch-local') throw new Error(`the temporary provider reused the name "${tempName}"`)
  const temp = TEMP_PREFIX_STATE(state)
  if (temp.length !== 1) throw new Error(`expected exactly 1 temporary provider registration, saw ${temp.length} (${temp.join(',')})`)
  if (temp[0] !== tempName) throw new Error(`registered "${temp[0]}" but passed subagentProvider="${tempName}"`)
  const provider = state.tempProvider
  if (provider === undefined) throw new Error('the temporary provider was not registered when start() ran')
  if (provider.name !== tempName) throw new Error(`provider.name is ${String(provider.name)}`)
  if (provider.capabilities?.agentPreset !== true) throw new Error('the temporary provider must advertise capabilities.agentPreset')
  if (provider.capabilities?.agentOptions !== true) throw new Error('the temporary provider must advertise capabilities.agentOptions')
  if (provider.inheritsParentContext !== false) throw new Error('the temporary provider must not inherit the parent context')
  if (typeof provider.start !== 'function') throw new Error('the temporary provider must implement start (external backend)')
  // Drive the delegation the engine would drive: preset + effort must land on
  // the child request, and per-run config must stay out of the parent's way.
  const prompt = [{ type: 'text', text: 'whole-run prompt' }]
  await provider.start({ parent, prompt, signal: new AbortController().signal })
  if (state.activations.length !== 1) throw new Error(`expected 1 delegated activation, saw ${state.activations.length}`)
  const spec = state.activations[0]
  if (spec.provider !== 'spawn') throw new Error(`delegated provider is ${String(spec.provider)}, expected spawn`)
  if (spec.request.agentPreset !== 'ptc') throw new Error(`delegated agentPreset is ${String(spec.request.agentPreset)}`)
  if (spec.request.agentOptions?.reasoningEffort !== 'high') {
    throw new Error(`delegated reasoningEffort is ${String(spec.request.agentOptions?.reasoningEffort)}`)
  }
  if (request.meta?.name !== WF_META.name) throw new Error('meta was not forwarded to the engine')
  if (request.parent !== parent) throw new Error('the engine did not get the caller parent')
  if (request.signal === undefined) throw new Error('the engine did not get a signal')
  if (JSON.stringify(value) === '{}') throw new Error('the tool returned an empty value')
  return `subagentProvider=${tempName.slice(0, 22)}…, preset=ptc, effort=high → spawn`
})

await probe('WF_MODEL_ONLY', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  // 00-req 判据 4 fixes `provider` + `model` as a PAIR (the same rule the
  // per-call tool enforces), so a lone `model` is refused before anything
  // starts — no provider registered, no engine call. Plan open issue OI1/OI2
  // records this resolution (option a).
  const before = state.registerCalls.length
  await rejectsWith(
    () => tool.execute({ script: WF_SCRIPT, meta: WF_META, model: 'deepseek-lite' }, execFor(parent)),
    /`provider` and `model` must be supplied together/,
    'model without provider',
  )
  if (state.registerCalls.length !== before) throw new Error('a half-specified route registered a provider')
  if (state.engine.calls.length !== 0) throw new Error('a half-specified route reached the workflow engine')
  // The model the caller CAN pin (as a pair) must reach the child request.
  await tool.execute({
    script: WF_SCRIPT,
    meta: WF_META,
    provider: 'deepseek-account',
    model: 'deepseek-lite',
  }, execFor(parent))
  if (state.engine.calls.length !== 1) throw new Error(`expected 1 engine call for the paired route, saw ${state.engine.calls.length}`)
  const tempName = state.engine.calls[0].subagentProvider
  if (typeof tempName !== 'string' || tempName === '') throw new Error('a paired provider/model run must pass a temporary subagentProvider')
  const provider = state.tempProvider
  if (provider === undefined) throw new Error('the temporary provider was not registered for the paired route')
  await provider.start({ parent, prompt: [{ type: 'text', text: 'x' }], signal: new AbortController().signal })
  const spec = state.activations[0]
  if (spec.request.agentOptions?.model !== 'deepseek-lite') {
    throw new Error(`delegated agentOptions.model is ${String(spec.request.agentOptions?.model)}`)
  }
  if (spec.request.agentOptions?.provider !== 'deepseek-account') {
    throw new Error(`delegated agentOptions.provider is ${String(spec.request.agentOptions?.provider)}`)
  }
  if (Object.hasOwn(spec.request.agentOptions ?? {}, 'reasoningEffort')) {
    throw new Error('a run without reasoning_effort must not inject one')
  }
  if (Object.hasOwn(spec.request, 'agentPreset')) throw new Error('a run without preset must not inject an agentPreset')
  return 'model-only refused (pair rule, no registration), paired route injects provider+model'
})

await probe('WF_NO_PROVIDER', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  const before = state.registerCalls.length
  await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  const request = state.engine.calls[0]
  if (Object.hasOwn(request, 'subagentProvider')) {
    throw new Error(`a run without preset/effort/model must not pass subagentProvider (got ${String(request.subagentProvider)})`)
  }
  // Delta, not an absolute count: apply() legitimately registers dispatch-local
  // and dispatch up front, so only the change caused by this call matters.
  const delta = state.registerCalls.length - before
  if (delta !== 0) throw new Error(`expected no provider registration for a plain run, saw ${delta}`)
  if (state.releases.length !== 0) throw new Error('a plain run released a provider it never registered')
  return 'subagentProvider key absent, registerProvider delta = 0'
})

await probe('WF_DISPOSER_ONCE', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  await tool.execute({ script: WF_SCRIPT, meta: WF_META, preset: 'ptc' }, execFor(parent))
  const first = TEMP_PREFIX_STATE(state)
  if (first.length !== 1) throw new Error(`expected 1 temporary provider, saw ${first.length}`)
  const firstReleases = state.releases.filter((providerName) => providerName === first[0])
  if (firstReleases.length !== 1) throw new Error(`the disposer ran ${firstReleases.length} times on the success path, expected 1`)
  if (state.providers.has(first[0])) throw new Error('the temporary provider survived the run')
  // The engine can refuse before a run exists (0.2.2 validates script/meta in
  // start()); the temporary provider must still be released exactly once.
  state.engine.behavior.startError = new Error('workflow refused: unsupported script')
  await rejectsWith(
    () => tool.execute({ script: WF_SCRIPT, meta: WF_META, preset: 'ptc' }, execFor(parent)),
    /workflow refused/,
    'engine refusing to start',
  )
  const second = TEMP_PREFIX_STATE(state).filter((providerName) => providerName !== first[0])
  if (second.length !== 1) throw new Error(`expected a fresh temporary provider on the retry, saw ${second.length}`)
  const secondReleases = state.releases.filter((providerName) => providerName === second[0])
  if (secondReleases.length !== 1) throw new Error(`the disposer ran ${secondReleases.length} times on the error path, expected 1`)
  if (state.doubleReleases.length !== 0) throw new Error(`a disposer was invoked twice: ${state.doubleReleases.join(',')}`)
  return 'success path and start()-error path each release exactly once, no double release'
})

await probe('WF_RESULT_AND_DISPOSE', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  state.engine.behavior.value = { mark: 'after-await' }
  const value = await tool.execute({
    script: WF_SCRIPT,
    meta: WF_META,
    args: { row: 1 },
    max_total_agents: 5,
  }, execFor(parent))
  const request = state.engine.calls[0]
  if (request.maxTotalAgents !== 5) throw new Error(`requests.maxTotalAgents is ${String(request.maxTotalAgents)}, expected 5`)
  if (request.script !== WF_SCRIPT) throw new Error('the script body was not forwarded verbatim')
  if (JSON.stringify(request.meta) !== JSON.stringify(WF_META)) throw new Error(`meta is ${JSON.stringify(request.meta)}`)
  if (JSON.stringify(request.args) !== JSON.stringify({ row: 1 })) throw new Error(`args is ${JSON.stringify(request.args)}`)
  if (request.signal === undefined) throw new Error('start() did not receive signal: exec.signal')
  const record = state.engine.runs[0]
  if (record.disposed !== 1) throw new Error(`run.dispose() ran ${record.disposed} times, expected 1`)
  // The tool's own contract: `{ runId, agentsStarted, result }`, where `result`
  // is the JSON value the script returned (null when it returned nothing).
  const payload = JSON.stringify(value)
  if (value.runId !== record.runId) throw new Error(`output runId is ${String(value.runId)}, expected ${record.runId}`)
  if (JSON.stringify(value.result) !== JSON.stringify({ mark: 'after-await' })) {
    throw new Error(`the script value was not surfaced as result: ${payload.slice(0, 160)}`)
  }
  if (typeof value.agentsStarted !== 'number') throw new Error(`agentsStarted is ${String(value.agentsStarted)}`)
  return 'result awaited and surfaced, run.dispose() once, maxTotalAgents=5 forwarded'
})

await probe('WF_NULL_AGENT_RESULT', async () => {
  const { state, parent } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  state.engine.behavior.evaluateScript = true
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  const agentCalls = state.scriptAgentCalls ?? []
  if (agentCalls.length !== 1) throw new Error(`the script's agent() was called ${agentCalls.length} times, expected 1`)
  const payload = JSON.stringify(value)
  // A1: agent() returning null means the child failed. The tool must hand the
  // null through untouched — never swallow it, never fake a success value.
  if (!payload.includes('"child":null')) {
    throw new Error(`agent() → null was not passed through to the script result: ${payload.slice(0, 200)}`)
  }
  if (payload.includes('false') && payload.includes('"ok"')) throw new Error('a null child result was reported as success')
  return 'agent() → null reaches the script untouched and is not treated as success'
})

/* ------------------------------------------------------------------ *
 * 3c. Cases for the stock capabilities `run_workflow` absorbed
 *     (output shape, background jobs, progress mirror, durable records,
 *     result truncation, execution-time shadowing, prompt section)
 * ------------------------------------------------------------------ */

await probe('WF_OUTPUT_ONEOF', async () => {
  const { state } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  const schema = tool.output?.schema
  if (schema === undefined) throw new Error(`${WF_TOOL_NAME} registered no output schema`)
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length !== 2) {
    throw new Error(`output.schema.oneOf is ${JSON.stringify(schema.oneOf)}, expected the stock two branches`)
  }
  // The host subset forbids `type` beside `oneOf` (dsh-tools/lib/index.js:206-232).
  if (Object.hasOwn(schema, 'type')) throw new Error('output.schema must not carry `type` beside `oneOf`')
  const branchOf = (kind) => schema.oneOf.find((branch) => branch.properties?.kind?.const === kind)
  const branches = [
    [branchOf('background'), ['jobId', 'kind', 'runId']],
    [branchOf('foreground'), ['agentsStarted', 'kind', 'result', 'runId']],
  ]
  for (const [branch, expected] of branches) {
    if (branch === undefined) throw new Error(`no oneOf branch carries kind=${expected.join(',')}`)
    const kind = branch.properties.kind.const
    if (branch.additionalProperties !== false) throw new Error(`the ${kind} branch must set additionalProperties: false`)
    const names = Object.keys(branch.properties).sort()
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(`the ${kind} branch properties are ${names.join(',')}, expected ${expected.join(',')}`)
    }
    // `required` arrives either as the root list or as per-property flags; the
    // host compiler hoists the latter, so accept both readings.
    for (const requiredName of expected) {
      const rootList = Array.isArray(branch.required) ? branch.required : []
      if (!rootList.includes(requiredName) && branch.properties[requiredName].required !== true) {
        throw new Error(`the ${kind} branch does not require ${requiredName}`)
      }
    }
  }
  const foreground = branchOf('foreground')
  if (foreground.properties.agentsStarted.type !== 'integer') throw new Error('foreground.agentsStarted must be an integer')
  if (foreground.properties.result.type !== undefined) {
    throw new Error('foreground.result must stay the annotation-only `json` node (no `type`)')
  }
  return 'oneOf: background{kind,jobId,runId} | foreground{kind,runId,agentsStarted,result}'
})

await probe('WF_BACKGROUND_JOB', async () => {
  const { state, parent, engine } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  if (tool.parameters.properties.run_in_background?.type !== 'boolean') {
    throw new Error(`run_in_background.type is ${String(tool.parameters.properties.run_in_background?.type)}, expected boolean`)
  }
  const exec = { ...execFor(parent), callId: 'call-1', rootCallId: 'root-1' }
  const value = await timed(
    tool.execute({ script: WF_SCRIPT, meta: WF_META, run_in_background: true }, exec),
    'the run_in_background call',
  )
  if (value.kind !== 'background') throw new Error(`output.kind is ${String(value.kind)}, expected background`)
  if (typeof value.jobId !== 'string' || value.jobId === '') throw new Error(`output.jobId is ${String(value.jobId)}`)
  if (typeof value.runId !== 'string' || value.runId === '') throw new Error(`output.runId is ${String(value.runId)}`)
  const names = Object.keys(value).sort()
  if (JSON.stringify(names) !== JSON.stringify(['jobId', 'kind', 'runId'])) {
    throw new Error(`the background value carries ${names.join(',')}, expected kind+jobId+runId`)
  }
  const started = state.jobs.last()
  if (started === undefined) throw new Error('jobs.start was never called')
  if (started.id !== value.jobId) throw new Error(`jobs.start returned ${started.id}, the tool reported ${value.jobId}`)
  const spec = started.spec
  if (spec.kind !== 'workflow') throw new Error(`jobs.start spec.kind is ${String(spec.kind)}, expected workflow`)
  if (spec.owner !== parent.id) throw new Error(`jobs.start spec.owner is ${String(spec.owner)}, expected the calling agent id`)
  if (spec.label !== WF_META.name) throw new Error(`jobs.start spec.label is ${String(spec.label)}, expected the meta name`)
  if (typeof spec.run !== 'function') throw new Error('jobs.start spec.run is not a function')
  if (spec.toolCall === null || typeof spec.toolCall !== 'object') throw new Error('jobs.start spec.toolCall is not an object')
  if (spec.toolCall.callId !== 'call-1' || spec.toolCall.rootCallId !== 'root-1') {
    throw new Error(`spec.toolCall is ${JSON.stringify(spec.toolCall)}, expected the creating invocation ids`)
  }
  if (engine.calls.length !== 1) throw new Error(`expected 1 engine.start, saw ${engine.calls.length}`)
  if (value.runId !== engine.runs[0].runId) throw new Error(`output.runId is not the engine run id ${engine.runs[0].runId}`)
  // The run belongs to the job: a registry kill or an owner teardown cancels it,
  // never the tool step's own signal (stock `:224-258`).
  if (engine.calls[0].signal !== undefined) throw new Error('a background run must not carry the tool-step signal')
  const outcome = await timed(started.producer.done, 'the job settlement')
  if (outcome.status !== 'completed') throw new Error(`job outcome is ${String(outcome.status)}, expected completed`)
  return `kind=workflow owner=agent label=${WF_META.name}, runId is the engine id, toolCall forwarded`
})

await probe('WF_BACKGROUND_CANCEL', async () => {
  const { state, parent, engine } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  const gate = deferred()
  engine.behavior.gate = gate.promise
  engine.behavior.value = { ok: true }
  const value = await timed(
    tool.execute({ script: WF_SCRIPT, meta: WF_META, run_in_background: true }, execFor(parent)),
    'the run_in_background call',
  )
  const started = state.jobs.find(value.jobId)
  if (started === undefined) throw new Error(`the jobs registry has no record for ${value.jobId}`)
  const record = engine.runs[0]
  state.jobs.kill(value.jobId)
  if (record.cancels.length !== 1) throw new Error(`engine run.cancel ran ${record.cancels.length} times, expected 1`)
  if (record.cancels[0] !== 'background workflow job killed') {
    throw new Error(`cancel reason is ${JSON.stringify(record.cancels[0])}, expected the stock default`)
  }
  const outcome = await timed(started.producer.done, 'the cancelled job settlement')
  if (outcome.status !== 'killed') throw new Error(`job outcome is ${String(outcome.status)}, expected killed`)
  if (record.disposed !== 1) throw new Error(`run.dispose() ran ${record.disposed} times after settlement, expected 1`)
  gate.resolve()
  return 'job_kill → run.cancel(stock default reason) → outcome killed, dispose exactly once'
})

await probe('WF_PROGRESS_MIRROR', async () => {
  const { state, parent, engine, emit } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  for (const event of ['workflow/phase', 'workflow/agent-start', 'workflow/agent-end']) {
    if ((state.listeners.get(event) ?? []).length === 0) throw new Error(`no ctx.on subscription for ${event}`)
  }
  const hasLog = (state.listeners.get('workflow/log') ?? []).length > 0
  const gate = deferred()
  engine.behavior.gate = gate.promise
  engine.behavior.value = { ok: true }
  const value = await timed(
    tool.execute({ script: WF_SCRIPT, meta: WF_META, run_in_background: true }, execFor(parent)),
    'the run_in_background call',
  )
  const started = state.jobs.find(value.jobId)
  if (started === undefined) throw new Error('the background run registered no job handle')
  const handle = started.handle
  const info = { id: value.runId }
  if (emit('workflow/phase', info, 'Fan out') !== 1) {
    throw new Error(`workflow/phase has ${emit('workflow/phase', info, 'Fan out')} live handlers, expected exactly 1`)
  }
  if (hasLog) emit('workflow/log', info, 'hello log')
  emit('workflow/agent-start', info, { seq: 1, label: 'researcher', childId: 'c1' })
  emit('workflow/agent-end', info, { seq: 1, outcome: 'completed' })
  if (!handle.progress.includes('Fan out')) {
    throw new Error(`job.updateProgress saw ${JSON.stringify(handle.progress)}, expected the phase title verbatim`)
  }
  for (const entry of handle.appends) {
    if (entry.options?.channel !== 'log') throw new Error(`a mirrored append did not use channel "log": ${JSON.stringify(entry)}`)
  }
  const logText = handle.appends.map((entry) => entry.text).join('')
  const fragments = ['Fan out', 'researcher', 'completed', ...(hasLog ? ['hello log'] : [])]
  for (const fragment of fragments) {
    if (!logText.includes(fragment)) throw new Error(`the job log stream is missing ${JSON.stringify(fragment)}: ${logText}`)
  }
  gate.resolve()
  await timed(started.producer.done, 'the mirrored job settlement')
  return 'phase→updateProgress+log, agent-start/agent-end → log chunks, all channel "log"'
})

await probe('WF_RECORDER_EVENTS', async () => {
  const { state, parent, engine, emit } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  const gate = deferred()
  engine.behavior.gate = gate.promise
  engine.behavior.value = { ok: true }
  const execution = tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  // The recorder subscribes before the run is awaited, so the run is live here.
  await tick()
  const runId = engine.runs[0].runId
  emit('workflow/agent-start', { id: runId }, { seq: 1, label: 'researcher', childId: 'c1' })
  emit('workflow/agent-end', { id: runId }, { seq: 1, outcome: 'completed' })
  gate.resolve()
  await timed(execution, 'the recorded foreground call')
  const types = state.appends.map((entry) => entry.type)
  const expected = [
    'tool-workflow/run-start',
    'tool-workflow/agent-start',
    'tool-workflow/agent-end',
    'tool-workflow/run-end',
  ]
  if (JSON.stringify(types) !== JSON.stringify(expected)) {
    throw new Error(`session records are ${types.join(',')}, expected ${expected.join(',')}`)
  }
  // A session that refuses the append must only warn: recording is never
  // allowed to fail the tool call (stock `:57-70` + `:843-849`).
  const refusing = mount({}, { sessionAppend: 'throw' })
  refusing.engine.behavior.value = { ok: true }
  const refusingTool = refusing.state.tools.get(WF_TOOL_NAME)
  const value = await refusingTool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(refusing.parent))
  if (typeof value?.runId !== 'string') throw new Error('the tool failed instead of degrading when session.append threw')
  if (refusing.state.warnings.length < 1) throw new Error('a refused append produced no logger.warn')
  if (!/append/i.test(refusing.state.warnings[0])) {
    throw new Error(`the warning does not mention the failed append: ${refusing.state.warnings[0]}`)
  }
  if (refusing.state.appends.length !== 0) throw new Error('records were kept after the session refused one')
  return 'run-start/agent-start/agent-end/run-end once each; refused append warns once and the tool still succeeds'
})

await probe('WF_RECORD_RESOLVES_EXTERNAL_CHILD_ID', async () => {
  // With a per-run provider the engine only knows our synthesized id
  // (`<provider>:<uuid>`). The durable record must carry the REAL child session
  // id — that is what the Web UI opens when a member row is clicked.
  const { state, parent, engine, emit } = mount()
  const tool = state.tools.get(WF_TOOL_NAME)
  const gate = deferred()
  engine.behavior.gate = gate.promise
  engine.behavior.value = { ok: true }
  const execution = tool.execute({ script: WF_SCRIPT, meta: WF_META, preset: 'minimal' }, execFor(parent))
  await tick()
  const runId = engine.runs[0].runId
  const providerName = state.tempProviderName
  if (typeof providerName !== 'string') throw new Error('the per-run provider was not registered')
  const provider = state.providers.get(providerName)
  if (provider === undefined) throw new Error('the per-run provider is missing from the registry')
  const handle = await provider.start({
    parent,
    prompt: [{ type: 'text', text: 'probe' }],
    agentPreset: 'minimal',
  })
  const innerChildId = state.runs.at(-1)?.childId
  if (typeof innerChildId !== 'string') throw new Error('the delegated activation produced no child id')
  if (handle.id === innerChildId) throw new Error('the provider reused the host-owned child id (DUPLICATE_CHILD risk)')
  emit('workflow/agent-start', { id: runId }, { seq: 1, label: 'delegated', childId: handle.id })
  emit('workflow/agent-end', { id: runId }, { seq: 1, outcome: 'completed' })
  gate.resolve()
  await timed(execution, 'the recorded foreground call')
  await handle.dispose()
  const started = state.appends.find((entry) => entry.type === 'tool-workflow/agent-start')
  if (started === undefined) throw new Error('no agent-start record was appended')
  if (started.data.childId !== innerChildId) {
    throw new Error(`the record kept the synthesized id instead of the session id: ${String(started.data.childId)}`)
  }
  return 'synthesized provider id → real child session id in the durable record'
})

await probe('WF_TRUNCATE_RESULT', async () => {
  const { state, parent, engine } = mount({ maxResultChars: 20 })
  const tool = state.tools.get(WF_TOOL_NAME)
  engine.behavior.value = { longText: 'x'.repeat(200) }
  const value = await tool.execute({ script: WF_SCRIPT, meta: WF_META }, execFor(parent))
  const rendered = tool.output.render({ meta: WF_META }, value)
  const text = Array.isArray(rendered)
    ? rendered.map((part) => part.text ?? '').join('')
    : String(rendered?.text ?? '')
  if (!/… \[truncated: \d+ more characters\]/.test(text)) {
    throw new Error(`the foreground render is not truncated: ${text.slice(-140)}`)
  }
  // The background job's settled result is produced by the same renderer.
  const background = mount({ maxResultChars: 20 })
  background.engine.behavior.value = { longText: 'x'.repeat(200) }
  const backgroundTool = background.state.tools.get(WF_TOOL_NAME)
  await timed(
    backgroundTool.execute({ script: WF_SCRIPT, meta: WF_META, run_in_background: true }, execFor(background.parent)),
    'the run_in_background call',
  )
  const outcome = await timed(background.jobs.starts[0].producer.done, 'the truncated job settlement')
  if (typeof outcome.result !== 'string' || !/… \[truncated: \d+ more characters\]/.test(outcome.result)) {
    throw new Error(`the job result is not truncated: ${String(outcome.result).slice(-140)}`)
  }
  return 'maxResultChars=20 → "… [truncated: N more characters]" on the foreground render and the job result'
})

await probe('WF_SHADOW_GUARD', async () => {
  // Judgement 3 — the guard no longer denies `workflow`. The stock name is
  // TAKEN OVER per agent instead, and a GLOBAL guard is evaluated before the
  // agent chain (`dsh-tools/lib/index.js:3025-3026`): denying `workflow` here
  // would refuse the very definition this package registers one layer down.
  // The deny list survives only for OTHER configured stock names.
  const { state } = mount()
  if (state.guards.length !== 0) {
    throw new Error(`the default configuration registered ${state.guards.length} global guard(s), expected 0`)
  }
  const custom = mount({ shadowedToolNames: ['some-stock'] })
  if (custom.state.guards.length !== 1) {
    throw new Error(`shadowedToolNames:['some-stock'] registered ${custom.state.guards.length} guards, expected exactly 1`)
  }
  const customGuard = custom.state.guards[0]
  if (typeof customGuard !== 'function') {
    throw new Error('ctx.tools.guard did not receive a function (host contract: guard(exec => reason))')
  }
  const denied = customGuard({ name: 'some-stock' })
  if (typeof denied !== 'string' || denied === '') {
    throw new Error(`guardFn({ name: 'some-stock' }) returned ${String(denied)}, expected a readable reason`)
  }
  if (!denied.includes(WF_TOOL_NAME)) throw new Error(`the denial does not point at ${WF_TOOL_NAME}: ${denied}`)
  if (customGuard({ name: TAKEOVER_STOCK_NAME }) !== undefined) {
    throw new Error('the takeover name must never be refused by the global guard')
  }
  if (customGuard({ name: WF_TOOL_NAME }) !== undefined) {
    throw new Error(`${WF_TOOL_NAME} must never be refused, even when listed`)
  }
  if (customGuard({}) !== undefined) throw new Error('an exec without a name must be allowed')
  if (customGuard(undefined) !== undefined) throw new Error('a missing exec must be allowed')
  // Naming the takeover name explicitly does not put it back in the list.
  const explicit = mount({ shadowedToolNames: [TAKEOVER_STOCK_NAME, 'some-stock'] })
  if (explicit.state.guards.length !== 1) {
    throw new Error(`a list naming the takeover name registered ${explicit.state.guards.length} guards, expected 1`)
  }
  if (explicit.state.guards[0]({ name: 'some-stock' }) === undefined) {
    throw new Error('the configured stock name was not shadowed')
  }
  if (explicit.state.guards[0]({ name: TAKEOVER_STOCK_NAME }) !== undefined) {
    throw new Error('the takeover name stayed in the deny list and would refuse our own definition')
  }
  // A list holding ONLY the takeover name leaves nothing to deny ⇒ no guard.
  const onlyTakeover = mount({ shadowedToolNames: [TAKEOVER_STOCK_NAME] })
  if (onlyTakeover.state.guards.length !== 0) {
    throw new Error(`${onlyTakeover.state.guards.length} guards registered for the takeover name alone, expected 0`)
  }
  // Master switch: neither a guard nor a takeover.
  const off = mount({ shadowStockWorkflow: false })
  if (off.state.guards.length !== 0) throw new Error('shadowStockWorkflow:false must not register a guard')
  const offAgent = makeFakeAgent(off.state, 'agent-switch-off')
  await announceAgent(off.state, offAgent)
  if (agentOwnOf(off.state, offAgent).size !== 0) {
    throw new Error('shadowStockWorkflow:false still took the stock name over for an agent')
  }
  if (agentGuardsOf(off.state, offAgent).length !== 0) {
    throw new Error('shadowStockWorkflow:false still registered a per-agent guard')
  }
  return 'default → 0 global guards; ["some-stock"] denies only it; takeover name never denied; master switch off'
})

await probe('TAKEOVER_LISTENER', async () => {
  const { state } = mount()
  if ((state.listeners.get('agent/created') ?? []).length === 0) {
    throw new Error('no agent/created listener was registered')
  }
  if ((state.listeners.get('agent/disposed') ?? []).length === 0) {
    throw new Error('no agent/disposed listener was registered')
  }
  const stock = state.stockTools.get(TAKEOVER_STOCK_NAME)
  if (stock === undefined) throw new Error('the harness has no stock definition to take over')
  const agent = makeFakeAgent(state, 'agent-listener')
  await announceAgent(state, agent)
  const definition = agentOwnOf(state, agent).get(TAKEOVER_STOCK_NAME)
  if (definition === undefined) {
    throw new Error(`the agent's OWN layer received no "${TAKEOVER_STOCK_NAME}" definition`)
  }
  if (definition.name !== TAKEOVER_STOCK_NAME) {
    throw new Error(`the registered definition is named "${String(definition.name)}"`)
  }
  if (typeof definition.takeoverMarker !== 'string' || definition.takeoverMarker === '') {
    throw new Error('the registered definition carries no takeover marker')
  }
  // Shadowed, not replaced: the inherited stock definition is untouched, and
  // nothing lands in the plugin's global layer.
  if (state.stockTools.get(TAKEOVER_STOCK_NAME) !== stock) {
    throw new Error('the inherited stock definition was replaced instead of shadowed')
  }
  if (state.tools.get(TAKEOVER_STOCK_NAME) !== undefined) {
    throw new Error('the takeover registered in the GLOBAL layer instead of the agent OWN layer')
  }
  if (layeredToolGet(state, TAKEOVER_STOCK_NAME, agent) !== definition) {
    throw new Error('tools.get("workflow", agent) does not resolve to the taken-over definition')
  }
  return 'agent/created + agent/disposed listeners; the OWN layer shadows the stock workflow'
})

await probe('TAKEOVER_EXECUTE_DELEGATION', async () => {
  const { state, parent, engine } = mount()
  const agent = makeFakeAgent(state, 'agent-delegation')
  await announceAgent(state, agent)
  const takeover = agentOwnOf(state, agent).get(TAKEOVER_STOCK_NAME)
  const runWorkflow = state.tools.get(WF_TOOL_NAME)
  if (takeover === undefined) throw new Error('the takeover registered no definition to execute')
  if (runWorkflow === undefined) throw new Error(`${WF_TOOL_NAME} is not registered globally`)
  // Same implementation, proven three ways — never by function identity.
  // `defineTool` wraps `execute` in a fresh closure per call
  // (`dsh-tools/lib/index.js:866-870`), so `execute` identity is false by
  // construction and asserting it would be a permanently red case.
  if (takeover.sharedExecute !== runWorkflow.sharedExecute) {
    throw new Error('the two definitions do not share the one executeWorkflow')
  }
  if (JSON.stringify(takeover.parameters) !== JSON.stringify(runWorkflow.parameters)) {
    throw new Error('the takeover and run_workflow expose different parameter tables')
  }
  if (JSON.stringify(takeover.output.schema) !== JSON.stringify(runWorkflow.output.schema)) {
    throw new Error('the takeover and run_workflow expose different output schemas')
  }
  if (takeover.description !== runWorkflow.description) {
    throw new Error('the takeover and run_workflow expose different descriptions')
  }
  // The one thing the two names DO differ in: the host's per-call wrapper.
  const takeoverExecute = takeover.execute
  const runWorkflowExecute = runWorkflow.execute
  if (takeoverExecute === runWorkflowExecute) {
    throw new Error('the two definitions share one execute function — impossible under the host wrapper, so this'
      + ' assertion has been wrongly rewritten as an identity check')
  }
  // Behavioural delegation: each name reaches the engine exactly once.
  engine.behavior.value = { ok: true }
  const args = { script: WF_SCRIPT, meta: WF_META }
  const exec = execFor(parent)
  const before = engine.calls.length
  const takeoverValue = await takeover.execute(args, exec)
  const afterTakeover = engine.calls.length
  if (afterTakeover !== before + 1) {
    throw new Error(`the takeover execute did not reach the engine (${before} → ${afterTakeover})`)
  }
  const runWorkflowValue = await runWorkflow.execute(args, exec)
  const afterBoth = engine.calls.length
  if (afterBoth !== afterTakeover + 1) {
    throw new Error(`the ${WF_TOOL_NAME} execute did not reach the engine (${afterTakeover} → ${afterBoth})`)
  }
  const takeoverText = renderedText(takeover, args, takeoverValue)
  const runWorkflowText = renderedText(runWorkflow, args, runWorkflowValue)
  if (takeoverText === '') throw new Error('the takeover execute rendered an empty result')
  if (takeoverText !== runWorkflowText) {
    throw new Error(`the two names rendered different results:\n${takeoverText}\n---\n${runWorkflowText}`)
  }
  return 'both names ran once each (engine.calls +1 / +1), identical text, one sharedExecute, identical parameters/schema'
})

await probe('TAKEOVER_IDEMPOTENT', async () => {
  const agents = { list: () => [] }
  const { state, emit } = mount({}, { agents })
  const agent = makeFakeAgent(state, 'agent-idempotent')
  // Rescan path (the plugin may load AFTER the agent exists): `agents.list()`
  // plus a `tools/change` retry must take the agent over exactly once.
  agents.list = () => [agent]
  emit('tools/change')
  await settle()
  const registrationsOf = (target) => state.agentRegisters.filter((entry) => entry.agent === target)
  if (registrationsOf(agent).length !== 1) {
    throw new Error(`the rescan registered ${registrationsOf(agent).length} definitions, expected 1`)
  }
  // Two further announcements change nothing (the adopted set short-circuits).
  await announceAgent(state, agent)
  await announceAgent(state, agent)
  if (registrationsOf(agent).length !== 1) {
    throw new Error(`two further announcements produced ${registrationsOf(agent).length} registrations in total, expected 1`)
  }
  // Two announcements in ONE tick race: `takeoverInFlight` is written
  // synchronously, before the first await, so only one survives.
  const racing = makeFakeAgent(state, 'agent-racing')
  fireAgentEvent(state, 'agent/created', { agent: racing, source: 'check' })
  fireAgentEvent(state, 'agent/created', { agent: racing, source: 'check' })
  await settle()
  if (registrationsOf(racing).length !== 1) {
    throw new Error(`two announcements in one tick produced ${registrationsOf(racing).length} registrations, expected 1`)
  }
  return 'rescan + two announcements + two racing announcements → exactly one registration per agent'
})

await probe('TAKEOVER_FALLBACK_GUARD', async () => {
  const { state } = mount()
  // Somebody ELSE's definition already owns the name in this agent's OWN layer
  // (no marker): registering would throw a duplicate, so the only honest answer
  // is one warning plus a per-agent denial for that name — never a global guard.
  const foreign = { name: TAKEOVER_STOCK_NAME, foreign: true }
  const agent = makeFakeAgent(state, 'agent-foreign', [[TAKEOVER_STOCK_NAME, foreign]])
  let thrown
  try {
    await announceAgent(state, agent)
  } catch (error) {
    thrown = error
  }
  if (thrown !== undefined) {
    throw new Error(`the agent/created listener threw (it would abort agent creation): ${messageOf(thrown)}`)
  }
  if (state.warnings.length < 1) throw new Error('a duplicate own-layer name produced no logger.warn')
  if (!state.warnings.some((warning) => /could not take over/i.test(warning))) {
    throw new Error(`the warning does not report the failed takeover: ${state.warnings.join(' | ')}`)
  }
  const guards = agentGuardsOf(state, agent)
  if (guards.length !== 1) throw new Error(`${guards.length} per-agent guards registered, expected exactly 1`)
  const guardFunction = guards[0]
  const denied = guardFunction({ name: TAKEOVER_STOCK_NAME })
  if (typeof denied !== 'string' || denied === '') {
    throw new Error(`the fallback guard returned ${String(denied)}, expected a readable reason`)
  }
  if (!denied.includes(WF_TOOL_NAME)) throw new Error(`the denial does not point at ${WF_TOOL_NAME}: ${denied}`)
  if (guardFunction({ name: WF_TOOL_NAME }) !== undefined) {
    throw new Error(`the fallback guard refuses ${WF_TOOL_NAME}`)
  }
  if (guardFunction({ name: 'other' }) !== undefined) {
    throw new Error('the fallback guard refuses names that are not the takeover name')
  }
  if (agentOwnOf(state, agent).get(TAKEOVER_STOCK_NAME) !== foreign) {
    throw new Error(`the foreign definition was replaced instead of left in place`)
  }
  if (state.guards.length !== 0) {
    throw new Error(`the fallback leaked into the GLOBAL layer (${state.guards.length} global guard(s))`)
  }
  return 'foreign same-name → no throw, warn, one per-agent denial pointing at run_workflow, 0 global guards'
})

await probe('TAKEOVER_FOREIGN_KEPT', async () => {
  // Production default (single disclosure): the alias is NOT published, so a
  // denial would point at nothing. A takeover that cannot land must not take
  // anything away — the foreign definition keeps serving the name and NO guard
  // is installed for it.
  const { state } = mount({ exposeRunWorkflow: undefined })
  const foreign = { name: TAKEOVER_STOCK_NAME, foreign: true }
  const agent = makeFakeAgent(state, 'agent-foreign-kept', [[TAKEOVER_STOCK_NAME, foreign]])
  await announceAgent(state, agent)
  if (agentGuardsOf(state, agent).length !== 0) {
    throw new Error('a per-agent guard was registered although no alias exists to redirect to')
  }
  if (agentOwnOf(state, agent).get(TAKEOVER_STOCK_NAME) !== foreign) {
    throw new Error('the foreign definition was replaced or removed instead of left in place')
  }
  if (layeredToolGet(state, TAKEOVER_STOCK_NAME, agent) !== foreign) {
    throw new Error('the agent no longer resolves the foreign definition — the capability was lost')
  }
  if (!state.warnings.some((warning) => /could not take over/i.test(warning))) {
    throw new Error(`the failed takeover produced no warning: ${state.warnings.join(' | ')}`)
  }
  return 'alias hidden + foreign owner → capability preserved, 0 guards, one warning'
})

await probe('TAKEOVER_DISABLED', async () => {
  const { state } = mount({ shadowStockWorkflow: false })
  if ((state.listeners.get('agent/created') ?? []).length !== 0) {
    throw new Error('shadowStockWorkflow:false still subscribes to agent/created')
  }
  const agent = makeFakeAgent(state, 'agent-disabled')
  await announceAgent(state, agent)
  if (agentOwnOf(state, agent).size !== 0) {
    throw new Error('shadowStockWorkflow:false still registered a takeover definition')
  }
  if (agentGuardsOf(state, agent).length !== 0) {
    throw new Error('shadowStockWorkflow:false still registered a per-agent guard')
  }
  if (state.guards.length !== 0) throw new Error('shadowStockWorkflow:false still registered a global guard')
  if (state.agentRegisters.length !== 0) throw new Error('shadowStockWorkflow:false still caused a registration')
  // The switch disables the TAKEOVER, never the plugin's own tool.
  if (state.tools.get(WF_TOOL_NAME) === undefined) {
    throw new Error(`${WF_TOOL_NAME} is missing under shadowStockWorkflow:false`)
  }
  if (layeredToolGet(state, TAKEOVER_STOCK_NAME, agent) !== state.stockTools.get(TAKEOVER_STOCK_NAME)) {
    throw new Error('shadowStockWorkflow:false did not leave the stock definition in place')
  }
  return 'master switch off → no listener, no takeover, no guard; run_workflow and the stock workflow untouched'
})

await probe('TAKEOVER_SKIP_ABSENT', async () => {
  // Review major-3 — an agent that cannot SEE the name (its preset layer holds
  // no stock tool, or `restrict({ deny: ['workflow'] })` filtered it) must not
  // be handed one. A takeover redirects an existing capability; it never grants
  // one. `tools.get(name, agent) === undefined` ⇒ skip, silently.
  const { state } = mount({}, { stockTools: new Map() })
  // Without this the case would pass vacuously against a plugin that never
  // subscribed: the skip must be the takeover's decision, not its absence.
  if ((state.listeners.get('agent/created') ?? []).length === 0) {
    throw new Error('no agent/created listener — the skip would be vacuous')
  }
  const agent = makeFakeAgent(state, 'agent-absent')
  await announceAgent(state, agent)
  if (agentOwnOf(state, agent).size !== 0) {
    throw new Error(`the OWN layer received ${agentOwnOf(state, agent).size} definition(s) although the name was`
      + ' never visible to that agent (a takeover must not grant a capability)')
  }
  if (state.agentRegisters.length !== 0) throw new Error('an absent name still produced a registration')
  if (agentGuardsOf(state, agent).length !== 0) throw new Error('an absent name still produced a per-agent guard')
  if (state.guards.length !== 0) throw new Error('an absent name still produced a global guard')
  if (state.warnings.some((warning) => /could not take over/i.test(warning))) {
    throw new Error(`skipping an absent name must not look like a failure: ${state.warnings.join(' | ')}`)
  }
  return 'agent without the name → nothing registered, no guard, no failure warning'
})

await probe('TAKEOVER_ADOPT_OWN', async () => {
  // Review major-1 — a definition carrying this package's takeover marker is
  // OURS: left behind by an earlier plugin instance that outlived a reload.
  // Adopt it: never register again, and never degrade into a denial.
  const first = mount()
  const firstAgent = makeFakeAgent(first.state, 'agent-earlier-instance')
  await announceAgent(first.state, firstAgent)
  const leftover = agentOwnOf(first.state, firstAgent).get(TAKEOVER_STOCK_NAME)
  if (leftover === undefined) throw new Error('the first instance registered no definition to leave behind')
  if (typeof leftover.takeoverMarker !== 'string' || leftover.takeoverMarker === '') {
    throw new Error('the registered definition carries no takeover marker to recognise it by')
  }
  // Seed a SECOND instance with that leftover: its `sharedExecute` belongs to
  // the first instance, so only the marker can identify it as ours.
  const second = mount()
  const agent = makeFakeAgent(second.state, 'agent-adopted', [[TAKEOVER_STOCK_NAME, leftover]])
  await announceAgent(second.state, agent)
  if (agentOwnOf(second.state, agent).get(TAKEOVER_STOCK_NAME) !== leftover) {
    throw new Error('the adopted definition was replaced instead of kept')
  }
  if (second.state.agentRegisters.length !== 0) {
    throw new Error(`adopting our own definition still registered ${second.state.agentRegisters.length} definition(s)`)
  }
  if (agentGuardsOf(second.state, agent).length !== 0) {
    throw new Error('adopting our own definition degraded into a denial guard')
  }
  if (second.state.guards.length !== 0) throw new Error('adopting our own definition registered a global guard')
  if (second.state.warnings.length !== 1) {
    throw new Error(`${second.state.warnings.length} warnings, expected exactly one stale executeWorkflow warning:`
      + ` ${second.state.warnings.join(' | ')}`)
  }
  if (!/different executeworkflow/i.test(second.state.warnings[0])) {
    throw new Error(`the warning does not report the stale executeWorkflow: ${second.state.warnings[0]}`)
  }
  return 'marker matched → adopted: 0 registrations, 0 guards, one stale-executeWorkflow warning'
})

await probe('WF_STOCK_DEFINITION_PARITY', async () => {
  // Criterion 2 — "same shape as the stock definition". The oracle is a
  // runtime capture of the REAL `@deepseek-ai/dsh-tool-workflow` apply(); no
  // description, parameter or required list is copied into this file.
  const stock = await stockWorkflowBaseline()
  const { state } = mount({ exposeRunWorkflow: true })
  const tool = state.tools.get(WF_TOOL_NAME)
  if (tool === undefined) throw new Error(`the ${WF_TOOL_NAME} definition was not registered`)
  if (tool.description !== stock.definition.description) {
    throw new Error(`description differs from the stock DESCRIPTION`
      + ` (${String(tool.description).length} vs ${stock.definition.description.length} chars)`)
  }
  const stockParameters = stock.definition.parameters.properties
  const pluginParameters = tool.parameters.properties
  if (JSON.stringify([...(stock.definition.parameters.required ?? [])].sort()) !== JSON.stringify(['meta', 'script'])) {
    throw new Error(`the stock oracle's required list is ${JSON.stringify(stock.definition.parameters.required)}, expected script+meta`
      + ' (the capture itself is wrong)')
  }
  if (canonicalJson(pluginParameters.meta) !== canonicalJson(stockParameters.meta)) {
    throw new Error('meta parameter is not structurally identical to the stock one (properties/required/additionalProperties)')
  }
  for (const stockName of Object.keys(stockParameters)) {
    if (canonicalJson(pluginParameters[stockName]) !== canonicalJson(stockParameters[stockName])) {
      throw new Error(`stock parameter "${stockName}" differs from the stock definition`)
    }
  }
  const stockRequired = [...(stock.definition.parameters.required ?? [])].sort()
  const pluginRequired = [...(tool.parameters.required ?? [])].sort()
  if (JSON.stringify(pluginRequired) !== JSON.stringify(stockRequired)) {
    throw new Error(`root required is ${JSON.stringify(pluginRequired)}, expected the stock ${JSON.stringify(stockRequired)}`)
  }
  const additions = Object.keys(pluginParameters).filter((name) => !Object.hasOwn(stockParameters, name)).sort()
  const expectedAdditions = ['max_total_agents', 'model', 'preset', 'provider', 'reasoning_effort']
  if (JSON.stringify(additions) !== JSON.stringify(expectedAdditions)) {
    throw new Error(`added parameters are ${additions.join(',')}, expected exactly ${expectedAdditions.join(',')}`)
  }
  for (const name of additions) {
    if (pluginParameters[name].required === true) {
      throw new Error(`plugin addition "${name}" is required; every plugin per-run knob must stay optional`)
    }
  }
  if (typeof stock.definition.description !== 'string' || stock.definition.description.length < 1000) {
    throw new Error('the stock oracle captured no real description')
  }
})

await probe('WF_ALIAS_HIDDEN', async () => {
  // Criterion 1/5 — production default: the takeover serves the capability, the
  // global alias is NOT published, so any workflow-shaped name set is exactly
  // ['workflow'].
  const { state } = mount({ exposeRunWorkflow: undefined })
  if (state.tools.has(WF_TOOL_NAME)) {
    throw new Error(`${WF_TOOL_NAME} is still published globally although the takeover is active`)
  }
  if ((state.listeners.get('agent/created') ?? []).length === 0) {
    throw new Error('no agent/created listener — the takeover would be inactive and this case vacuous')
  }
  const agent = makeFakeAgent(state, 'agent-alias-hidden')
  await announceAgent(state, agent)
  const own = agentOwnOf(state, agent)
  if (own.size !== 1 || !own.has(TAKEOVER_STOCK_NAME)) {
    throw new Error(`the agent's OWN layer is [${[...own.keys()].join(',')}], expected exactly [workflow]`)
  }
  const registrations = state.agentRegisters.filter((entry) => entry.agent === agent)
  if (registrations.length !== 1 || registrations[0].name !== TAKEOVER_STOCK_NAME) {
    throw new Error(`registrations are ${registrations.map((entry) => entry.name).join(',')}, expected exactly one workflow`)
  }
  const workflowNames = [...layeredToolView(state, agent).visible.keys()]
    .filter((name) => name.includes('workflow'))
    .sort()
  if (JSON.stringify(workflowNames) !== JSON.stringify(['workflow'])) {
    throw new Error(`the agent's workflow-capability names are ${JSON.stringify(workflowNames)}, expected ["workflow"]`)
  }
})

await probe('WF_ALIAS_SWITCH', async () => {
  // Criterion 5 — the alias is still registered and can be re-exposed by config.
  const exposed = mount({ exposeRunWorkflow: true })
  if (!exposed.state.tools.has(WF_TOOL_NAME)) {
    throw new Error(`exposeRunWorkflow: true did not publish ${WF_TOOL_NAME}`)
  }
  if ((exposed.state.listeners.get('agent/created') ?? []).length === 0) {
    throw new Error('exposeRunWorkflow: true disabled the takeover too; it must only restore the alias')
  }
  const compat = mount({ shadowStockWorkflow: false })
  if (!compat.state.tools.has(WF_TOOL_NAME)) {
    throw new Error(`shadowStockWorkflow: false did not restore ${WF_TOOL_NAME}`)
  }
  if ((compat.state.listeners.get('agent/created') ?? []).length !== 0) {
    throw new Error('shadowStockWorkflow: false still subscribed to agent creation (it is the master switch)')
  }
  if (compat.state.guards.length !== 0) throw new Error('shadowStockWorkflow: false registered a global guard')
})

await probe('WF_SECTION_STOCK_ONCE', async () => {
  // Criterion 4 — one section, stock text verbatim, no implementation leak.
  // The assertion reads the CAPTURED runtime objects, never a source slice, so
  // comments that mention the takeover cannot fail it.
  const stock = await stockWorkflowBaseline()
  const { state } = mount()
  const agent = makeFakeAgent(state, 'agent-section-once')
  await announceAgent(state, agent)
  const sections = effectiveSections(state, agent)
  if (sections.length !== 1) {
    throw new Error(`${sections.length} prompt sections assembled, expected exactly 1`)
  }
  const section = sections[0]
  if (section.text !== stock.section.text) {
    throw new Error(`section text is not the stock text verbatim\nplugin: ${String(section.text)}\nstock:  ${stock.section.text}`)
  }
  const forbidden = /takeover|executeworkflow|two names|run_workflow/i
  if (forbidden.test(section.text)) {
    throw new Error(`the section text leaks the takeover implementation: ${section.text}`)
  }
  if (section.name !== 'tool:workflow') {
    throw new Error(`section.name is ${String(section.name)}, expected tool:workflow`)
  }
  if (section.order !== 2600) {
    throw new Error(`section.order is ${String(section.order)}, expected the TOOL_WORKFLOW order 2600`)
  }
})

await probe('WF_SECTION_SHADOWS_STOCK', async () => {
  // Criterion 4 in the STANDARD/CORDIS shape: the stock tool is mounted in a
  // preset (ancestor) scope and registered its own `tool:workflow` section
  // there, but with DIFFERENT text (a host whose stock section was customised).
  // The agent-scope section must SHADOW it — exactly one section assembles, and
  // it is ours (the stock usage rule), never both — and the stock's own
  // registration must never be disturbed.
  const stock = await stockWorkflowBaseline()
  const { state } = mount()
  state.sections.push({ name: 'tool:workflow', order: 2600, text: 'Stock section from the preset scope (customised).' })
  const agent = makeFakeAgent(state, 'agent-section-shadow')
  await announceAgent(state, agent)
  const sections = effectiveSections(state, agent)
  if (sections.length !== 1) {
    throw new Error(`${sections.length} assembled sections, expected the agent's one to shadow the preset's`)
  }
  if (sections[0].text !== stock.section.text) {
    throw new Error(`the preset section was not shadowed: ${String(sections[0].text)}`)
  }
  if (state.sections.length !== 1 || state.sections[0].text !== 'Stock section from the preset scope (customised).') {
    throw new Error('the preset layer section was mutated — a scoped shadow must leave the ancestor untouched')
  }
})

await probe('WF_RESTRICT_NO_GRANT', async () => {
  // Criterion 6 — a `restrict({ deny: ['workflow'] })` agent is never force-fed:
  // the name is KNOWN (pre-restriction) but not visible, and a denial is not an
  // absence. Zero registrations, zero guards.
  const { state } = mount({ exposeRunWorkflow: undefined })
  const agent = makeFakeAgent(state, 'agent-restricted', [], { runCode: true, denied: [TAKEOVER_STOCK_NAME] })
  await announceAgent(state, agent)
  const view = layeredToolView(state, agent)
  if (!view.knownNames.has(TAKEOVER_STOCK_NAME) || view.visible.has(TAKEOVER_STOCK_NAME)) {
    throw new Error('the fixture is wrong: workflow must be known-but-denied for this agent')
  }
  if (agentOwnOf(state, agent).size !== 0) {
    throw new Error(`the restricted agent received ${agentOwnOf(state, agent).size} definition(s) in its OWN layer`)
  }
  if (state.agentRegisters.filter((entry) => entry.agent === agent).length !== 0) {
    throw new Error('the restricted agent received a registration')
  }
  if (agentGuardsOf(state, agent).length !== 0) throw new Error('the restricted agent received a guard')
})

await probe('WF_PTC_SUPPLEMENT', async () => {
  // Criterion 3 (unit half) — a PTC agent (run_code visible, workflow never
  // existed) gets EXACTLY one workflow binding, rendered once in the real PTC
  // `tools:sdk` section, and the binding is callable.
  const { state } = mount({ exposeRunWorkflow: undefined }, { stockTools: new Map() })
  const agent = makeFakeAgent(state, 'agent-ptc', [], { runCode: true })
  await announceAgent(state, agent)
  const own = agentOwnOf(state, agent)
  if (own.size !== 1 || !own.has(TAKEOVER_STOCK_NAME)) {
    throw new Error(`the PTC agent's OWN layer is [${[...own.keys()].join(',')}], expected exactly [workflow]`)
  }
  if (state.tools.has(WF_TOOL_NAME)) throw new Error(`the global ${WF_TOOL_NAME} alias must stay hidden`)
  const view = layeredToolView(state, agent)
  const capabilityNames = [...view.visible.keys()]
  if (capabilityNames.filter((name) => name.includes('workflow')).length !== 1) {
    throw new Error(`decided workflow capabilities are ${JSON.stringify(capabilityNames)}, expected exactly one workflow`)
  }
  if (capabilityNames.includes(WF_TOOL_NAME)) throw new Error(`the ${WF_TOOL_NAME} alias leaked into the PTC view`)
  if (!view.visible.has('run_code')) throw new Error('the PTC view lost its run_code transport')
  // The real PTC renderer is the oracle for "exactly one line in tools:sdk".
  const sdkSchemas = [...view.visible.entries()]
    .filter(([name]) => name !== 'run_code')
    .map(([, definition]) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: definition.output.schema,
    }))
  const sdk = ptcExecutorModule.renderToolsSdk(sdkSchemas)
  // `renderToolsSdk` emits EACH tool twice (once in `ToolArgsMap`, once in
  // `ToolOutputMap`), so count bindings in the arguments interface only.
  const argsInterface = sdk.slice(sdk.indexOf('interface ToolArgsMap {'), sdk.indexOf('interface ToolOutputMap {'))
  if (argsInterface === '') throw new Error('the PTC tools:sdk section has no ToolArgsMap interface')
  const bindings = argsInterface.split('\n').filter((line) => /^\s{2}workflow: /.test(line)).length
  if (bindings !== 1) {
    throw new Error(`the PTC tools:sdk declares ${bindings} workflow bindings, expected exactly 1\n${sdk.slice(0, 400)}`)
  }
  if (sdk.includes(WF_TOOL_NAME)) throw new Error(`the ${WF_TOOL_NAME} alias appears in the PTC tools:sdk`)
  // Callable: the supplemented definition is a real tool.
  const definition = own.get(TAKEOVER_STOCK_NAME)
  const value = await definition.execute(
    { script: 'return 42', meta: { name: 'ptc-probe', description: 'PTC supplement probe' } },
    execFor(agent),
  )
  if (value?.kind !== 'foreground' || typeof value.runId !== 'string') {
    throw new Error(`the supplemented definition did not run: ${JSON.stringify(value)}`)
  }
})

await probe('WF_SYSTEM_PROMPT_SECTION', async () => {
  const { state } = mount()
  // Placement contract: with the takeover active the rule belongs to the AGENT
  // (own scope), not to the global layer — a global copy would race the stock
  // preset's own `tool:workflow` section and, if both landed in one scope,
  // duplicate-name-throw. Nothing global is registered by this plugin.
  if (state.sections.length !== 0) {
    throw new Error(`${state.sections.length} GLOBAL prompt section(s) registered, expected 0 with the takeover active`)
  }
  const agent = makeFakeAgent(state, 'agent-section')
  await announceAgent(state, agent)
  const sections = effectiveSections(state, agent)
  if (sections.length !== 1) throw new Error(`${sections.length} effective sections for the agent, expected 1`)
  const section = sections[0]
  if (section.order !== 2600) {
    throw new Error(`section.order is ${String(section.order)}, expected the TOOL_WORKFLOW order 2600`)
  }
  if (!state.sectionOrderNames.includes('TOOL_WORKFLOW')) {
    throw new Error(`getSectionOrder was asked for ${state.sectionOrderNames.join(',')}, expected TOOL_WORKFLOW`)
  }
  if (section.name !== `tool:${TAKEOVER_STOCK_NAME}`) {
    throw new Error(`section.name is ${String(section.name)}, expected the model-facing name tool:${TAKEOVER_STOCK_NAME}`)
  }
  if (typeof section.text !== 'string' || !section.text.startsWith(`Use the ${TAKEOVER_STOCK_NAME} tool ONLY when`)) {
    throw new Error(`the section text does not carry the stock usage rule: ${String(section.text)}`)
  }
  return 'per-agent section: order=2600, name tool:workflow, stock usage rule, 0 global sections'
})

await probe('WF_GLOSSARY_NO_DEAD_NAMES', async () => {
  // Single disclosure means no model-visible string may name `run_workflow`.
  // Three surfaces are checked here, all reachable in production defaults:
  //  (a) the global shadow guard's denial text,
  //  (b) the deny-list filter (own tools + the stock name can never be denied),
  //  (c) an engine-less call made through the taken-over name.
  const guarded = mount({ exposeRunWorkflow: undefined, ...{ shadowedToolNames: ['some-stock'] } })
  if (guarded.state.guards.length !== 1) {
    throw new Error(`${guarded.state.guards.length} global guards registered, expected 1 for shadowedToolNames`)
  }
  const denial = guarded.state.guards[0]({ name: 'some-stock' })
  if (typeof denial !== 'string' || denial.length === 0) throw new Error('the guard returned no reason')
  if (denial.includes(WF_TOOL_NAME)) {
    throw new Error(`the denial points at the unpublished alias: ${denial}`)
  }
  if (!denial.includes(TAKEOVER_STOCK_NAME)) {
    throw new Error(`the denial does not point at the model-facing name: ${denial}`)
  }

  // A custom takeover name must not push the stock name or this package's own
  // tools into the deny list: a guard can deny, never allow, so one stray entry
  // would delete a working capability.
  const renamed = mount({
    takeoverToolName: 'myflow',
    shadowedToolNames: [TAKEOVER_STOCK_NAME, WF_TOOL_NAME, 'dispatch_subagent', 'some-stock'],
  })
  if (renamed.state.guards.length !== 1) {
    throw new Error(`${renamed.state.guards.length} guards, expected 1`)
  }
  const renamedGuard = renamed.state.guards[0]
  for (const name of [TAKEOVER_STOCK_NAME, WF_TOOL_NAME, 'dispatch_subagent']) {
    if (renamedGuard({ name }) !== undefined) throw new Error(`the guard denies "${name}", which must always be allowed`)
  }
  if (renamedGuard({ name: 'some-stock' }) === undefined) throw new Error('the guard stopped denying an explicitly listed name')

  // Engine-less call through the taken-over name: the error must name the tool
  // the model called, never the hidden alias.
  const engineLess = mount({}, { engine: 'none' })
  const agent = makeFakeAgent(engineLess.state, 'agent-engine-less')
  await announceAgent(engineLess.state, agent)
  const takeover = agentOwnOf(engineLess.state, agent).get(TAKEOVER_STOCK_NAME)
  if (takeover === undefined) throw new Error('no takeover definition to call')
  let message = ''
  try {
    await takeover.execute(
      { script: 'return 1', meta: { name: 'probe', description: 'probe' } },
      { agent, name: TAKEOVER_STOCK_NAME, signal: new AbortController().signal },
    )
  } catch (error) {
    message = messageOf(error)
  }
  if (!message.startsWith(`${TAKEOVER_STOCK_NAME}: `)) {
    throw new Error(`the engine-less error does not name the called tool: ${message}`)
  }
  if (message.includes(WF_TOOL_NAME)) {
    throw new Error(`the engine-less error leaks the hidden alias: ${message}`)
  }
})

await probe('WF_ERROR_NAMES_CALLED_TOOL', async () => {
  // 0.6.0 — nothing the model sees may name a tool it cannot call. Model-facing
  // errors are prefixed with the name the CALLER used, never the hidden alias.
  const { state } = mount({ exposeRunWorkflow: true })
  const agent = makeFakeAgent(state, 'agent-error-names')
  await announceAgent(state, agent)
  const takeover = agentOwnOf(state, agent).get(TAKEOVER_STOCK_NAME)
  const alias = state.tools.get(WF_TOOL_NAME)
  if (takeover === undefined || alias === undefined) throw new Error('fixture incomplete: missing a definition')
  const errorOf = async (definition, name) => {
    try {
      // No `agent` on the exec: the shared implementation rejects before it
      // touches the engine, so the message is the only observable.
      await definition.execute({ script: 'return 1', meta: { name: 'probe', description: 'probe' } }, { name })
    } catch (error) {
      return messageOf(error)
    }
    return ''
  }
  const takeoverMessage = await errorOf(takeover, TAKEOVER_STOCK_NAME)
  const aliasMessage = await errorOf(alias, WF_TOOL_NAME)
  if (!takeoverMessage.startsWith(`${TAKEOVER_STOCK_NAME}: `)) {
    throw new Error(`the takeover error names the wrong tool: ${takeoverMessage}`)
  }
  if (!aliasMessage.startsWith(`${WF_TOOL_NAME}: `)) {
    throw new Error(`the alias error names the wrong tool: ${aliasMessage}`)
  }
  if (takeoverMessage.includes(WF_TOOL_NAME)) {
    throw new Error(`the takeover error leaks the hidden alias name: ${takeoverMessage}`)
  }
})

await probe('PEER_RANGE_PRE_RELEASE', async () => {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const peers = pkg.peerDependencies ?? {}
  const peerNames = Object.keys(peers)
  // 6 since 0.6.0: `systemPrompt` is a REQUIRED injection (the array form of
  // `export const inject` is required, cordis `Inject.resolve`), so the peer
  // set must name the package that provides it.
  if (peerNames.length !== 6) throw new Error(`expected 6 peerDependencies, saw ${peerNames.length} (${peerNames.join(',')})`)
  if (!peerNames.includes('@deepseek-ai/dsh-system-prompt')) {
    throw new Error('peerDependencies does not declare @deepseek-ai/dsh-system-prompt although `inject` requires it')
  }
  const expectedRange = '>=0.2.1-rc.2 <0.3.0 || >=0.2.2-rc.1 <0.3.0'
  for (const peerName of peerNames) {
    if (peers[peerName] !== expectedRange) {
      throw new Error(`peer ${peerName} declares "${peers[peerName]}", expected "${expectedRange}"`)
    }
  }
  // Both prerelease lines of the current install must be accepted; the older
  // release and the next minor must not be.
  const expectations = [['0.2.1-rc.2', true], ['0.2.2-rc.1', true], ['0.2.0', false], ['0.2.3', true], ['0.3.0', false]]
  for (const [version, expected] of expectations) {
    const got = satisfiesRange(version, expectedRange)
    if (got !== expected) {
      throw new Error(`minimal semver: ${version} ${got ? 'satisfies' : 'does not satisfy'} the declared peer range, expected ${expected}`)
    }
  }
  // Same five verdicts against each declared range, to catch a per-peer drift.
  for (const peerName of peerNames) {
    for (const [version, expected] of expectations) {
      if (satisfiesRange(version, peers[peerName]) !== expected) {
        throw new Error(`peer ${peerName} range "${peers[peerName]}" misjudges ${version}`)
      }
    }
  }
  return `0.2.1-rc.2 ✅ 0.2.2-rc.1 ✅ 0.2.0 ❌ 0.2.3 ✅ 0.3.0 ❌ across ${peerNames.length} peers (local semver)`
})

/* ------------------------------------------------------------------ *
 * 4. Verdict
 * ------------------------------------------------------------------ */

if (failures.length === 0) {
  console.log(`cases: ${passed.length} passed`)
  console.log('result: OK')
  process.exitCode = 0
} else {
  console.log(`cases: ${passed.length} passed, ${failures.length} failed`)
  for (const failure of failures) console.log(`  - ${failure}`)
  console.log('result: FAILED')
  process.exitCode = 1
}
