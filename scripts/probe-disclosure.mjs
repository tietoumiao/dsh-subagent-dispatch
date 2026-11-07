#!/usr/bin/env node
/**
 * Disclosure-contract integration probe (run from anywhere):
 *
 *   DSH_HOST_MODULES=<dir containing @deepseek-ai/*> node scripts/probe-disclosure.mjs
 *
 * `DSH_HOST_MODULES` defaults to walking up from the current directory looking
 * for `node_modules/@deepseek-ai/dsh-tools`.
 */
/**
 * Host-module resolver: maps bare `@deepseek-ai/*` specifiers onto the DSH
 * installation so a probe can import the REAL host modules from a workspace
 * checkout (same hook `scripts/check.mjs` uses — kept here so the probe is a
 * standalone file without touching the delivered self-check).
 */
import { existsSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function findHostModules() {
  const candidates = []
  if (process.env.DSH_HOST_MODULES) candidates.push(process.env.DSH_HOST_MODULES)
  for (const start of [process.cwd()]) {
    let dir = start
    for (;;) {
      candidates.push(join(dir, 'node_modules'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))) return candidate
  }
  throw new Error(`cannot locate the DSH host node_modules; looked at:\n- ${candidates.join('\n- ')}`)
}

const hostModules = findHostModules()

function isBareSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('\\')) return false
  return !specifier.includes(':')
}

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


/**
 * REAL-CORDIS integration probe for the disclosure contract.
 *
 * REAL: the Cordis context, `@deepseek-ai/dsh-tools` ToolsService,
 * `@deepseek-ai/dsh-system-prompt` SystemPrompt, `@deepseek-ai/dsh-scope`
 * scoping, the stock `@deepseek-ai/dsh-tool-workflow` plugin, and this
 * package's own `apply()`.
 * STUBBED: only the provider seams a plugin does not own — workflowEngine,
 * jobs, subagents, llm, logger — plus a minimal tool executor that renders the
 * declarations the model would receive (`describe()`). No assertion below reads
 * a stub: the two surfaces under test are the host's own `tools.view()` and
 * `systemPrompt.assemble()`.
 *
 * Mounts the REAL host services (`@deepseek-ai/dsh-tools` ToolsService,
 * `@deepseek-ai/dsh-system-prompt` SystemPrompt) on a REAL Cordis context,
 * mounts the REAL stock `@deepseek-ai/dsh-tool-workflow` inside a "preset"
 * child scope, mounts THIS plugin at the root (the "bundle/global" scope, the
 * layering the desktop profile uses), then creates an agent scope whose parent
 * is the preset scope and announces it through `agent/created`.
 *
 * Asserts, against the host's own assembly code (not a fake):
 *  1. standard shape: the agent view has exactly one workflow capability
 *     (`workflow`) and the assembled prompt carries the stock usage rule ONCE;
 *  2. PTC shape (no stock tool, `run_code` transport): `workflow` is
 *     supplemented and the rule is assembled once;
 *  3. the alias is not disclosed beside the takeover name.
 *
 * Run from the plugin dir: DSH_HOST_MODULES=... node <this file>
 */
import { fileURLToPath as _fileURLToPath } from 'node:url'

const { Context } = await import('@deepseek-ai/cordis')
const { createScope, scopeOf } = await import('@deepseek-ai/dsh-scope')
const { ToolsService } = await import('@deepseek-ai/dsh-tools')
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const stockWorkflow = await import('@deepseek-ai/dsh-tool-workflow')
const pluginDir = dirname(dirname(_fileURLToPath(import.meta.url)))
const plugin = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href)

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** The services the plugin row injects, stubbed at the provider level only. */
const providerSeams = {
  name: 'probe-services',
  apply(ctx) {
    ctx.provide('workflowEngine', { start: async () => { throw new Error('probe: engine not used') } })
    ctx.provide('jobs', { start: () => { throw new Error('probe: jobs not used') } })
    const providers = new Map()
    ctx.provide('subagents', {
      getProvider: (providerName) => providers.get(providerName),
      registerProvider: (provider) => {
        if (providers.has(provider.name)) throw new Error(`provider "${provider.name}" already registered`)
        providers.set(provider.name, provider)
        return () => providers.delete(provider.name)
      },
      startActivation: async () => { throw new Error('probe: activation not used') },
    })
    ctx.provide('llm', { resolveModelInfo: async () => ({ reasoning: { efforts: [] } }) })
    ctx.provide('logger', { info: (m) => console.log('LOG info:', m), warn: (m) => console.log('LOG warn:', m) })
  },
}

/**
 * A native-executor shim: the host's REAL executor contract (`describe` returns
 * the declarations the model receives). A native executor renders every tool
 * the agent can see — that is exactly the disclosure surface under test.
 */
function executorShim(options = {}) {
  const extraNames = options.extraNames ?? []
  return {
    describe: (definitions = []) => {
      const visible = definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }))
      const extra = extraNames
        .filter((name) => !visible.some((schema) => schema.name === name))
        .map((name) => ({ name, description: `${name} transport`, parameters: { type: 'object', properties: {} } }))
      return { schemas: [...visible, ...extra], knownNames: [...visible, ...extra].map((schema) => schema.name) }
    },
    execute: async () => { throw new Error('probe: execution not used') },
  }
}

async function makeHost() {
  const root = new Context()
  await root.plugin(providerSeams)
  await root.plugin(SystemPrompt, {})
  await root.plugin(ToolsService, {})
  return root
}

/** Read one service through an injected agent context (Cordis requires inject). */
async function serviceOf(agent, name) {
  let captured
  await agent.ctx.inject([name], (runtimeCtx) => {
    captured = runtimeCtx[name]
  })
  return captured
}

/** Assemble a prompt through the host's own `SystemPrompt.build`. */
async function assemble(agent) {
  const prompt = await serviceOf(agent, 'systemPrompt')
  return await prompt.assemble({ scope: agent.key })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80))
const workflowNames = (view) => [...view.visible.keys()].filter((name) => /workflow/i.test(name))
const workflowSections = (assembly) => assembly.sections.filter((section) => section.name === 'tool:workflow')

/* ------------------------------------------------------------------ *
 * Shape 1 — stock tool-workflow mounted in the preset scope
 * ------------------------------------------------------------------ */
{
  const root = await makeHost()
  const presetKey = { preset: 'standard-probe' }
  const preset = createScope(root, presetKey)
  await preset.ctx.plugin(stockWorkflow, stockWorkflow.Config({}))
  await root.plugin(plugin, {})
  const rootTools = root.get('tools')
  await Promise.resolve(rootTools.setExecutor(executorShim()))
  const agentKey = { id: 'probe-standard' }
  const agent = createScope(root, agentKey, { parent: presetKey })
  agent.key = agentKey
  await root.emit('agent/created', { agent: { ...agentKey, ctx: agent.ctx }, source: 'probe' })
  await settle()

  const toolsService = await serviceOf(agent, 'tools')
  const view = toolsService.view(agentKey)
  const names = workflowNames(view)
  check('standard: exactly one workflow-shaped tool in the agent view', JSON.stringify(names) === JSON.stringify(['workflow']), JSON.stringify(names))
  const definition = view.visible.get('workflow')
  check('standard: the view resolves to a full workflow definition',
    definition !== undefined && typeof definition.execute === 'function' && String(definition.description).length > 1000,
    definition === undefined ? 'absent' : `${String(definition.description).length} chars`)
  check('standard: run_workflow is NOT disclosed beside workflow', !view.visible.has('run_workflow'), 'absent')

  const assembly = await assemble(agent)
  const sections = workflowSections(assembly)
  check('standard: exactly one tool:workflow section assembles', sections.length === 1, `${sections.length}`)
  const text = sections[0]?.text ?? ''
  check('standard: the assembled rule is the stock usage rule', text.startsWith('Use the workflow tool ONLY when the user explicitly asks'), JSON.stringify(text.slice(0, 64)))
  check('standard: no implementation wording in the assembled rule', !/takeover|executeworkflow|two names|run_workflow/i.test(text), JSON.stringify(text.slice(0, 64)))
  await root.dispose?.()
}

/* ------------------------------------------------------------------ *
 * Shape 2 — PTC preset: no stock tool-workflow, run_code transport present
 * ------------------------------------------------------------------ */
{
  const root = await makeHost()
  const presetKey = { preset: 'ptc-probe' }
  const preset = createScope(root, presetKey)
  await root.plugin(plugin, {})
  const agentKey = { id: 'probe-ptc' }
  const agent = createScope(root, agentKey, { parent: presetKey })
  agentKey.ctx = agent.ctx
  agent.key = agentKey
  // A PTC executor announces `run_code` through `describe()`, never through the
  // tool registry; `selectExecutor(agent)` is the host seam the plugin asks.
  const rootTools = root.get('tools')
  // The real PTC executor advertises `run_code` and nothing else as callable;
  // the model programs every other tool inside a `run_code` program, so the
  // declarations it renders ARE the disclosure surface (`tools:sdk`).
  await Promise.resolve(rootTools.setExecutor(executorShim({ extraNames: ['run_code'] }), presetKey))
  await settle()
  const emitted = await root.emit('agent/created', { agent: { ...agentKey, ctx: agent.ctx }, source: 'probe' })
  console.log('DEBUG emit returned', emitted)
  await settle()
  const toolsService = await serviceOf(agent, 'tools')

  await agent.ctx.inject(['tools'], (c) => {
    console.log('DEBUG scopeOf(agent.ctx)=', scopeOf(agent.ctx)?.id, 'scopeOf(injected)=', scopeOf(c)?.id)
  })
  const view = toolsService.view(agentKey)
  const names = workflowNames(view)
  check('ptc: workflow supplemented into the agent view', JSON.stringify(names) === JSON.stringify(['workflow']), JSON.stringify(names))
  check('ptc: run_workflow is NOT disclosed beside workflow', !view.visible.has('run_workflow'), 'absent')
  const assembly = await assemble(agent)
  const sections = workflowSections(assembly)
  check('ptc: exactly one tool:workflow section assembles', sections.length === 1, `${sections.length}`)
  check('ptc: the assembled rule is the stock usage rule',
    (sections[0]?.text ?? '').startsWith('Use the workflow tool ONLY when the user explicitly asks'),
    JSON.stringify((sections[0]?.text ?? '').slice(0, 64)))
  await root.dispose?.()
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\nresult: ${failed.length === 0 ? 'OK' : 'FAILED'} (${results.length - failed.length}/${results.length})`)
process.exit(failed.length === 0 ? 0 : 1)
