#!/usr/bin/env node
/**
 * enable-subagent-model-selection.mjs
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 *
 * The `subagent` delegation tool exposes optional `provider` / `model` /
 * `reasoning_effort` fields ONLY when the host-level settings provider
 * `@deepseek-ai/dsh-tool-subagent/model-selection-settings` reports
 * `enabled: true`. That provider ships disabled.
 *
 * The gating code is `dsh-tool-subagent/lib/index.js`:
 *
 *     const install = (runtimeCtx, modelSelectionPolicy) => {
 *       const modelSelectionEnabled = modelSelectionPolicy !== void 0;
 *       if (modelSelectionPolicy !== void 0) registerListSubagentModels(runtimeCtx, modelSelectionPolicy);
 *       ...
 *
 * and `modelSelectionPolicy` resolves through `SubagentModelSelectionConfig.current()`,
 * which returns `{ enabled, allowedModels }` — so while `enabled` is false the
 * policy is undefined, `list_subagent_models` is never registered, and the
 * per-call route fields never appear in the tool schema.
 *
 * Multitask's contract is "subagents default to the coordinator's model, but the
 * user may pick a different one". That requires this to be ON. This script turns
 * it on for the desktop profile.
 *
 * ── Why a Node script and not PowerShell ──────────────────────────────────────
 *
 * Two reasons, both learned the hard way in this repo:
 *  1. Windows PowerShell 5.1 decodes BOM-less .ps1 files using the system ANSI
 *     code page, so non-ASCII literals (the Chinese workspace path, box-drawing
 *     characters) get silently mangled. Node reads its own source as UTF-8.
 *  2. The profile already vendors the real `yaml` package
 *     (`profiles/desktop/node_modules/yaml`). Using the SAME parser the loader
 *     uses is the only honest way to prove the edited file still parses.
 *
 * ── Safety ────────────────────────────────────────────────────────────────────
 *
 *  - Backs the patch up before writing.
 *  - Never rewrites existing content: it only APPENDS a managed block.
 *  - After writing, re-parses the file with the real `yaml` package and asserts:
 *      * the document is still a top-level array
 *      * every PRE-EXISTING top-level entry is byte-for-byte structurally intact
 *      * the new entry is present with the expected shape
 *  - Derives `allowedModels` from the profile's OWN `llm-pi-ai` provider
 *    configuration, so the allow-list can never drift from the real routes.
 *  - Idempotent.
 *
 * Usage:
 *   node enable-subagent-model-selection.mjs            # enable
 *   node enable-subagent-model-selection.mjs --revert   # remove the block
 *   node enable-subagent-model-selection.mjs --dry-run  # report only
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// `os.homedir()` rather than `%USERPROFILE%`: this package is published, so it
// must resolve the home directory on macOS and Linux too. The desktop profile
// name is the DSH default; `--profile` overrides it for any other profile.
const PROFILE_DIR = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

const PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml')
const DRY = process.argv.includes('--dry-run')
const REVERT = process.argv.includes('--revert')

const BEGIN = '# --- dsh-multitask subagent-model-selection BEGIN ---'
const END = '# --- dsh-multitask subagent-model-selection END ---'

/** Load the real `yaml` package the loader itself uses. */
function loadYaml() {
  const require = createRequire(path.join(PROFILE_DIR, 'noop.js'))
  try {
    return require('yaml')
  } catch {
    return null
  }
}

/**
 * Read the profile's configured providers so the allow-list matches reality.
 * `llm-pi-ai` carries a `providers` map; each provider lists `models`.
 */
function configuredRoutes(doc) {
  const routes = []
  const seen = new Set()
  for (const entry of Array.isArray(doc) ? doc : []) {
    const providers = entry?.config?.providers
    if (providers === null || typeof providers !== 'object') continue
    for (const [providerId, provider] of Object.entries(providers)) {
      const models = Array.isArray(provider?.models) ? provider.models : []
      for (const model of models) {
        const modelId = typeof model === 'string' ? model : model?.id
        if (typeof providerId !== 'string' || providerId === '') continue
        if (typeof modelId !== 'string' || modelId === '') continue
        const key = `${providerId}\u0000${modelId}`
        if (seen.has(key)) continue
        seen.add(key)
        routes.push({ provider: providerId, model: modelId })
      }
    }
  }
  return routes
}

/**
 * Mirror `assertAllowedModelRoutes` from the shipped model-selection-settings
 * module, so a bad list is caught HERE rather than at session-composition time.
 * A throw there would reject `agent/created` and break session creation.
 */
function assertRoutes(routes) {
  if (!Array.isArray(routes)) throw new Error('allowedModels must be an array')
  if (routes.length === 0) throw new Error('enabled model selection requires at least one allowed model')
  const seen = new Set()
  for (const r of routes) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new Error('each route must be an object')
    if (typeof r.provider !== 'string' || r.provider.length === 0) throw new Error('route.provider must be a non-empty string')
    if (typeof r.model !== 'string' || r.model.length === 0) throw new Error('route.model must be a non-empty string')
    const key = `${r.provider}/${r.model}`
    if (seen.has(key)) throw new Error(`duplicate route ${key}`)
    seen.add(key)
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const yaml = loadYaml()
if (yaml === null) throw new Error(`the profile's own "yaml" package is not resolvable from ${PROFILE_DIR}`)

const raw = fs.readFileSync(PATCH, 'utf8')
const installed = raw.includes(BEGIN)

console.log(`profile patch : ${PATCH}`)
console.log(`yaml module   : ${yaml === null ? 'MISSING' : 'resolved'}`)
console.log(`block present : ${installed}`)

const before = yaml.parse(raw)
if (!Array.isArray(before)) throw new Error('the profile patch is not a top-level YAML array; refusing to touch it')
console.log(`entries before: ${before.length}`)

if (REVERT) {
  if (!installed) {
    console.log('nothing to revert')
    process.exit(0)
  }
  const lines = raw.split('\n')
  const b = lines.findIndex((l) => l.includes(BEGIN))
  const e = lines.findIndex((l) => l.includes(END))
  if (b < 0 || e < 0 || e < b) throw new Error('markers are malformed; refusing to edit blindly')
  // Also drop the blank line(s) immediately before the block.
  let from = b
  while (from > 0 && lines[from - 1].trim() === '') from--
  const next = [...lines.slice(0, from), ...lines.slice(e + 1)].join('\n')
  const parsed = yaml.parse(next)
  if (!Array.isArray(parsed)) throw new Error('revert would produce a non-array document')
  if (parsed.length !== before.length - 1) throw new Error(`revert sanity failed: ${before.length} -> ${parsed.length}`)
  if (DRY) {
    console.log('[dry-run] would remove the model-selection block')
    process.exit(0)
  }
  const backup = `${PATCH}.bak-${Date.now()}`
  fs.copyFileSync(PATCH, backup)
  fs.writeFileSync(PATCH, next, 'utf8')
  console.log(`backup        : ${backup}`)
  console.log(`reverted      : ${before.length} -> ${parsed.length} entries`)
  console.log('Restart DeepSeek Harness to apply.')
  process.exit(0)
}

if (installed) {
  console.log('already enabled; leaving the file untouched')
  process.exit(0)
}

const routes = configuredRoutes(before)
assertRoutes(routes)
console.log(`routes found  : ${routes.length} (${routes.map((r) => `${r.provider}/${r.model}`).join(', ')})`)

const block = [
  BEGIN,
  '# Enables per-delegation subagent LLM routing, which the `subagent` tool',
  '# exposes as optional `provider` / `model` / `reasoning_effort` fields plus a',
  '# `list_subagent_models` discovery tool.',
  '#',
  '# Required by dsh-multitask: subagents default to the coordinator\'s model, and',
  '# this is what lets a user pick a DIFFERENT one on a specific delegation. While',
  '# this provider reports enabled: false, those fields are absent from the tool',
  '# schema entirely and no model can be chosen.',
  '#',
  '# NOTE: this is a HOST-plane setting, so it is not scoped to the Multitask',
  '# preset. Removing this block (re-run with --revert) turns the feature back off',
  '# for every preset.',
  '#',
  '# allowedModels is derived from this profile\'s own llm-pi-ai providers so it',
  '# cannot drift from the routes that actually exist.',
  '- id: subagent-model-selection-settings',
  "  name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
  '  config:',
  '    enabled: true',
  '    allowedModels:',
  ...routes.flatMap((r) => [
    `      - provider: ${r.provider}`,
    `        model: ${r.model}`,
  ]),
  END,
].join('\n')

const next = `${raw.replace(/\s+$/, '')}\n\n${block}\n`

// Verify with the real parser BEFORE writing.
const after = yaml.parse(next)
if (!Array.isArray(after)) throw new Error('verification failed: result is not a top-level array')
if (after.length !== before.length + 1) throw new Error(`verification failed: expected ${before.length + 1} entries, got ${after.length}`)

// Every pre-existing entry must survive structurally unchanged.
for (let i = 0; i < before.length; i++) {
  const a = JSON.stringify(before[i])
  const b = JSON.stringify(after[i])
  if (a !== b) throw new Error(`verification failed: entry ${i} changed\n  before: ${a}\n  after:  ${b}`)
}

const added = after[after.length - 1]
if (added?.id !== 'subagent-model-selection-settings') throw new Error('verification failed: new entry has the wrong id')
if (added?.config?.enabled !== true) throw new Error('verification failed: enabled is not true')
assertRoutes(added.config.allowedModels)
if (added.config.allowedModels.length !== routes.length) throw new Error('verification failed: route count mismatch')

console.log(`entries after : ${after.length}`)
console.log('verification  : PASS (parsed by the real yaml package; all prior entries intact)')

if (DRY) {
  console.log('[dry-run] not writing')
  process.exit(0)
}

const backup = `${PATCH}.bak-${Date.now()}`
fs.copyFileSync(PATCH, backup)
fs.writeFileSync(PATCH, next, 'utf8')
console.log(`backup        : ${backup}`)
console.log('enabled       : per-delegation subagent model routing is now ON')
console.log('')
console.log('DSH watches this file and hot-reloads it. In a Multitask session the')
console.log('coordinator now also gets: list_subagent_models')
