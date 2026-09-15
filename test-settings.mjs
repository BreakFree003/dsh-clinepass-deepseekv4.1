/**
 * Tests for the transport-independent half of dsh-clinepass: the pin helpers,
 * profile provisioning, the reasoning-effort migration, and the option surface
 * (including the options 0.5.0 removed).
 *
 * No dsh process and no network: a stub settings service stands in for
 * ctx.settings, so the write ops, their order and their expected revision are
 * asserted exactly.
 *
 * Run: node test-settings.mjs
 */
import { alignReasoningEffort, pinFor, provisionProfile, withDefaults, withPin } from './index.js'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

/** A logger that records what was reported, with `%s` substituted like a real one. */
function recorder() {
  const lines = { info: [], warn: [], error: [] }
  const format = (template, args) => {
    let index = 0
    return String(template).replace(/%s/g, () => String(args[index++] ?? ''))
  }
  const record = (level) => (template, ...args) => lines[level].push(format(template, args))
  return { lines, info: record('info'), warn: record('warn'), error: record('error') }
}

/** Minimal settings service double. */
function makeSettings(value, { revision = 3, ns = 'llm-pi-ai' } = {}) {
  const writes = []
  return {
    writes,
    get: () => value,
    describe: () => [{ ns, revision }],
    mutate: async (target, ops, expectedRevision) => {
      writes.push({ ns: target, ops, expectedRevision })
      return { kind: 'written' }
    },
  }
}

const OUR_CARD = {
  displayName: 'Cline Pass',
  api: 'openai-completions',
  apiKeyEnv: 'CLINE_PASS_API_KEY',
  baseURL: 'https://api.cline.bot/api/v1',
  models: [{ id: 'cline-pass/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 921600, maxTokens: 131072, input: ['text', 'image'], reasoningEfforts: { high: 'high', max: 'max' } }],
}

// ── 1. the option surface ───────────────────────────────────────────────────
console.log('\n── 1. option surface ─────────────────────────────────────')
{
  const cfg = withDefaults({})
  check('the defaults pin deepseek on the official gateway', cfg.pin.join(',') === 'deepseek' && cfg.upstream === 'https://api.cline.bot', JSON.stringify({ pin: cfg.pin, upstream: cfg.upstream }))
  check('no transport option exists any more', cfg.transport === undefined && cfg.listen === undefined && cfg.captureDir === undefined, JSON.stringify(Object.keys(cfg)))
  check('withDefaults strips a trailing slash', withDefaults({ upstream: 'https://x.test/' }).upstream === 'https://x.test')
  const pathCfg = withDefaults({ upstream: 'https://x.test/api/v1' }, { warn: () => {}, info: () => {}, error: () => {} })
  check('an upstream with a path keeps only its origin', pathCfg.upstream === 'https://x.test', pathCfg.upstream)
  const pathLogs = recorder()
  withDefaults({ upstream: 'https://x.test/api/v1' }, pathLogs)
  check('…in one warning', pathLogs.lines.warn.filter((line) => line.includes('carries a path')).length === 1, JSON.stringify(pathLogs.lines.warn))
  check('a non-URL upstream is left for apply to refuse', withDefaults({ upstream: 'api.cline.bot' }).upstream === 'api.cline.bot')
  check('a booleans is not accepted as a size', withDefaults({ maxTokens: true }).maxTokens === 131072, String(withDefaults({ maxTokens: true }).maxTokens))
  check('a numeric string is accepted as a size', withDefaults({ maxTokens: '4096' }).maxTokens === 4096, String(withDefaults({ maxTokens: '4096' }).maxTokens))
  check('provision: false is respected', withDefaults({ provision: false }).provision === false)
  check('alignment can be disabled', withDefaults({ alignReasoningEffort: false }).alignReasoningEffort === false)

  // An install written for the removed loopback transport must still boot: the
  // option is reported once and ignored, never fatal.
  const logs = recorder()
  const legacy = withDefaults({ transport: 'proxy', listen: '127.0.0.1:8791', captureDir: '/tmp/caps', baseURL: 'http://127.0.0.1:8791/api/v1', address: '127.0.0.1:8791' }, logs)
  check('every removed option is reported', ['transport', 'listen', 'captureDir', 'baseURL', 'address'].every((name) => logs.lines.warn.some((line) => line.includes(`"${name}"`))), JSON.stringify(logs.lines.warn))
  check('…and none of them survives into the config', ['transport', 'listen', 'captureDir', 'baseURL', 'address'].every((name) => legacy[name] === undefined), JSON.stringify(Object.keys(legacy)))
  check('…and the pin still applies', legacy.pin.join(',') === 'deepseek')
  check('…and the ignored names are carried for the status file', JSON.stringify(legacy.ignoredOptions) === '["transport","listen","captureDir","address","baseURL"]', JSON.stringify(legacy.ignoredOptions))
  check('a clean config carries none', JSON.stringify(cfg.ignoredOptions) === '[]', JSON.stringify(cfg.ignoredOptions))
  // Passing an already-normalised config through again (apply does) must not
  // re-warn or lose the record.
  const again = recorder()
  check('re-normalising is silent and keeps the record', JSON.stringify(withDefaults(legacy, again).ignoredOptions) === JSON.stringify(legacy.ignoredOptions) && again.lines.warn.length === 0, JSON.stringify(again.lines.warn))
}

// ── 2. the pin body helper ─────────────────────────────────────────────────
console.log('\n── 2. pin helper ─────────────────────────────────────────')
{
  check('withPin writes providerOptions.gateway.only', JSON.stringify(withPin({ model: 'm' }, ['deepseek']).body) === '{"model":"m","providerOptions":{"gateway":{"only":["deepseek"]}}}')
  check('withPin keeps other gateway keys', JSON.stringify(withPin({ providerOptions: { gateway: { order: ['a'] } } }, ['deepseek']).body) === '{"providerOptions":{"gateway":{"order":["a"],"only":["deepseek"]}}}')
  check('withPin keeps unrelated providerOptions keys', JSON.stringify(withPin({ providerOptions: { other: 1 } }, ['deepseek']).body) === '{"providerOptions":{"other":1,"gateway":{"only":["deepseek"]}}}')
  check('withPin does nothing for an empty pin', withPin({ model: 'm' }, []).pinned === false)
  check('pinFor prefers the per-model pin', pinFor({ pin: ['a'], pins: { m: ['b'] } }, 'm').join(',') === 'b')
  check('pinFor falls back to the route pin', pinFor({ pin: ['a'], pins: {} }, 'm').join(',') === 'a')
}

// ── 3. profile provisioning ────────────────────────────────────────────────
console.log('\n── 3. profile provisioning ───────────────────────────────')
{
  const cfg = withDefaults({})
  const empty = makeSettings({ providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } })
  const created = await provisionProfile(empty, cfg, quiet)
  check('creates the profile when absent', created === 'created', created)
  check('writes into llm-pi-ai at providers.cline-pass', empty.writes[0]?.ns === 'llm-pi-ai' && JSON.stringify(empty.writes[0]?.ops[0]?.path) === '["providers","cline-pass"]', JSON.stringify(empty.writes[0]?.ops[0]?.path))
  check('write carries the settings revision', empty.writes[0]?.expectedRevision === 3, String(empty.writes[0]?.expectedRevision))
  const written = empty.writes[0].ops[0].value
  check('profile points at the gateway itself, with no port', written.baseURL === 'https://api.cline.bot/api/v1', written.baseURL)
  check('profile uses an OpenAI-compatible protocol', written.api === 'openai-completions', written.api)
  check('profile names the credential ref', written.apiKeyEnv === 'CLINE_PASS_API_KEY', written.apiKeyEnv)
  check('profile declares the model id the gateway expects', written.models[0].id === 'cline-pass/deepseek-v4.1-flash', written.models[0].id)
  check('profile declares the two reasoning levels', JSON.stringify(written.models[0].reasoningEfforts) === '{"high":"high","max":"max"}', JSON.stringify(written.models[0].reasoningEfforts))
  check('nothing loopback is written anywhere', JSON.stringify(empty.writes).includes('127.0.0.1') === false)

  const present = makeSettings({ providers: { 'cline-pass': structuredClone(OUR_CARD) } })
  check('leaves an up-to-date profile alone', (await provisionProfile(present, cfg, quiet)) === 'present' && present.writes.length === 0, JSON.stringify(present.writes))

  const stale = makeSettings({ providers: { 'cline-pass': { ...structuredClone(OUR_CARD), baseURL: 'http://127.0.0.1:8791/api/v1' } } })
  check('repoints a stale address — the 0.3.0 migration', (await provisionProfile(stale, cfg, quiet)) === 'repaired' && stale.writes[0].ops[0].path.join('.') === 'providers.cline-pass.baseURL' && stale.writes[0].ops[0].value === 'https://api.cline.bot/api/v1', JSON.stringify(stale.writes[0]?.ops))

  const oldLevels = structuredClone(OUR_CARD)
  oldLevels.models[0].reasoningEfforts = { high: 'high', xhigh: 'max' }
  const upgrading = makeSettings({ providers: { 'cline-pass': oldLevels } })
  check('a profile that predates the two-level set is repaired', (await provisionProfile(upgrading, cfg, quiet)) === 'repaired', JSON.stringify(upgrading.writes))
  check('…and touches only the models array', JSON.stringify(upgrading.writes[0].ops.map((op) => op.path.join('.'))) === '["providers.cline-pass.models"]', JSON.stringify(upgrading.writes[0].ops.map((op) => op.path.join('.'))))
  check('…with the retired alias gone', JSON.stringify(upgrading.writes[0].ops[0].value[0].reasoningEfforts) === '{"high":"high","max":"max"}', JSON.stringify(upgrading.writes[0].ops[0].value[0].reasoningEfforts))

  const mutated = structuredClone(OUR_CARD)
  mutated.models[0].reasoningEfforts = { high: 'high', xhigh: 'max', max: 'max', medium: 'medium' }
  const customised = makeSettings({ providers: { 'cline-pass': mutated } })
  check('a level the user added survives, the retired alias does not', (await provisionProfile(customised, cfg, quiet)) === 'repaired' && JSON.stringify(customised.writes[0].ops[0].value[0].reasoningEfforts) === '{"high":"high","max":"max","medium":"medium"}', JSON.stringify(customised.writes[0]?.ops))

  const missingModel = makeSettings({ providers: { 'cline-pass': { displayName: 'Cline Pass', api: 'openai-completions', apiKeyEnv: 'CLINE_PASS_API_KEY', baseURL: 'https://api.cline.bot/api/v1' } } })
  check('a model entry that went missing is restored', (await provisionProfile(missingModel, cfg, quiet)) === 'repaired', JSON.stringify(missingModel.writes))
  check('…as the only change', JSON.stringify(missingModel.writes[0]?.ops.map((op) => op.path.join('.'))) === '["providers.cline-pass.models"]', JSON.stringify(missingModel.writes[0]?.ops.map((op) => op.path.join('.'))))

  const foreign = makeSettings({ providers: { 'cline-pass': { apiKeyEnv: 'SOMEONE_ELSES_KEY', baseURL: 'https://elsewhere.test/v1' } } })
  check('a profile that is not ours is left alone', (await provisionProfile(foreign, cfg, quiet)) === 'mismatch' && foreign.writes.length === 0)

  // …unless it is stranded on a loopback address the removed transport left
  // behind: nothing listens there, so leaving it means nothing gets pinned.
  const stranded = makeSettings({ providers: { 'cline-pass': { api: 'openai-completions', apiKeyEnv: 'MY_RENAMED_KEY', baseURL: 'http://127.0.0.1:8791/api/v1' } } })
  const strandedLogs = recorder()
  check('a stranded card is moved to the gateway even when its keys differ', (await provisionProfile(stranded, cfg, strandedLogs)) === 'repaired' && JSON.stringify(stranded.writes[0]?.ops) === '[{"op":"set","path":["providers","cline-pass","baseURL"],"value":"https://api.cline.bot/api/v1"}]', JSON.stringify(stranded.writes[0]?.ops))
  check('…and the user is told why', strandedLogs.lines.warn.some((line) => line.includes('nothing listens on')), JSON.stringify(strandedLogs.lines.warn))
  const elsewhere = makeSettings({ providers: { 'cline-pass': { apiKeyEnv: 'MY_RENAMED_KEY', baseURL: 'https://elsewhere.test/v1' } } })
  check('a card on someone else\'s address is still left alone', (await provisionProfile(elsewhere, cfg, quiet)) === 'mismatch' && elsewhere.writes.length === 0)

  // A changed display name or capacity must reach an existing card too.
  const renamed = makeSettings({ providers: { 'cline-pass': { ...structuredClone(OUR_CARD), displayName: 'Old Name' } } })
  check('a changed display name is repaired', (await provisionProfile(renamed, cfg, quiet)) === 'repaired' && JSON.stringify(renamed.writes[0]?.ops) === '[{"op":"set","path":["providers","cline-pass","displayName"],"value":"Cline Pass"}]', JSON.stringify(renamed.writes[0]?.ops))
  const upsized = structuredClone(OUR_CARD)
  upsized.models[0].contextWindow = 1000
  const capacity = makeSettings({ providers: { 'cline-pass': upsized } })
  check('a changed capacity is repaired', (await provisionProfile(capacity, cfg, quiet)) === 'repaired' && capacity.writes[0].ops[0].value[0].contextWindow === 921600, JSON.stringify(capacity.writes[0]?.ops))

  for (const scalar of ['oops', 42, null]) {
    const broken = makeSettings({ providers: { 'cline-pass': scalar } })
    check(`a scalar profile (${JSON.stringify(scalar)}) is reported as a mismatch`, (await provisionProfile(broken, cfg, quiet)) === 'mismatch' && broken.writes.length === 0)
  }

  const flaky = makeSettings({ providers: {} })
  let calls = 0
  const realMutate = flaky.mutate
  flaky.mutate = async (...args) => {
    calls += 1
    if (calls === 1) throw new Error('settings conflict')
    return realMutate(...args)
  }
  check('a conflicted write is retried once', (await provisionProfile(flaky, cfg, quiet)) === 'created' && calls === 2, `calls=${calls}`)

  const refused = makeSettings({ providers: {} })
  refused.mutate = async () => {
    throw new Error('settings is read-only')
  }
  const failedLogs = recorder()
  check('a write that keeps failing is reported, not thrown', (await provisionProfile(refused, cfg, failedLogs)) === 'failed' && failedLogs.lines.warn.length === 1, JSON.stringify(failedLogs.lines.warn))

  // A custom upstream has to reach the card, since that is where the hook scopes.
  const custom = makeSettings({ providers: {} })
  await provisionProfile(custom, withDefaults({ upstream: 'https://gateway.test/' }), quiet)
  check('a custom upstream is honoured on the card', custom.writes[0].ops[0].value.baseURL === 'https://gateway.test/api/v1', custom.writes[0].ops[0].value.baseURL)
}

// ── 4. migrating a stored reasoning effort ─────────────────────────────────
console.log('\n── 4. reasoning-effort migration ─────────────────────────')
{
  const cfg = withDefaults({ provider: 'cline-pass' })
  const settings = (value) => makeSettings(value, { ns: 'agent-default-model' })

  const kept = settings({ provider: 'cline-pass', model: 'cline-pass/deepseek-v4.1-flash', reasoningEffort: 'max' })
  check('a "max" effort is left alone', (await alignReasoningEffort(kept, cfg, quiet)) === 'ok' && kept.writes.length === 0, JSON.stringify(kept.writes))

  const high = settings({ provider: 'cline-pass', reasoningEffort: 'high' })
  check('a "high" effort is left alone', (await alignReasoningEffort(high, cfg, quiet)) === 'ok' && high.writes.length === 0)

  const retired = settings({ provider: 'cline-pass', reasoningEffort: 'xhigh' })
  const retiredLogs = recorder()
  check('a retired id keeps its old meaning', (await alignReasoningEffort(retired, cfg, retiredLogs)) === 'aligned' && retired.writes[0]?.ops[0]?.value === 'max', JSON.stringify(retired.writes[0]?.ops))
  check('…and is reported as retired, not as unsupported', retiredLogs.lines.warn.some((line) => line.includes('retired level id')), JSON.stringify(retiredLogs.lines.warn))

  const nonsense = settings({ provider: 'cline-pass', reasoningEffort: 'turbo' })
  const nonsenseLogs = recorder()
  check('an unknown effort falls back to high', (await alignReasoningEffort(nonsense, cfg, nonsenseLogs)) === 'aligned' && nonsense.writes[0]?.ops[0]?.value === 'high', JSON.stringify(nonsense.writes[0]?.ops))
  check('…and is reported as unsupported', nonsenseLogs.lines.warn.some((line) => line.includes('not a level this model serves')))

  const otherModel = settings({ provider: 'cline-pass', reasoningEffort: 'medium' })
  await alignReasoningEffort(otherModel, cfg, quiet)
  check('a level this model does not declare is realigned', otherModel.writes[0]?.ops[0]?.value === 'high', JSON.stringify(otherModel.writes[0]?.ops))

  check('the write carries the settings revision', otherModel.writes[0]?.expectedRevision === 3, String(otherModel.writes[0]?.expectedRevision))

  const other = settings({ provider: 'deepseek', reasoningEffort: 'high' })
  check('another provider is never touched', (await alignReasoningEffort(other, cfg, quiet)) === 'other-provider' && other.writes.length === 0)

  const sibling = settings({ provider: 'cline-pass', model: 'cline-pass/glm-5.3-flash', reasoningEffort: 'xhigh' })
  check('another model on the same route is never touched', (await alignReasoningEffort(sibling, cfg, quiet)) === 'other-model' && sibling.writes.length === 0)

  const absent = settings(undefined)
  check('an absent section is a no-op', (await alignReasoningEffort(absent, cfg, quiet)) === 'absent')

  const throwing = settings({ provider: 'cline-pass', reasoningEffort: 'turbo' })
  throwing.mutate = async () => {
    throw new Error('read-only settings')
  }
  const failedLogs = recorder()
  check('a failed migration is reported, not thrown', (await alignReasoningEffort(throwing, cfg, failedLogs)) === 'failed' && failedLogs.lines.warn.length === 1, JSON.stringify(failedLogs.lines.warn))
}

console.log(`\nRESULT: ${failures.length === 0 ? 'SETTINGS OK' : `FAILED (${failures.join(' | ')})`}`)
process.exit(failures.length === 0 ? 0 : 2)
