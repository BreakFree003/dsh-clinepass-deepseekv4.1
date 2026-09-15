/**
 * Tests for the dsh-clinepass in-process pin hook (`transport: 'fetch'`).
 *
 * No dsh process and no gateway: `globalThis.fetch` is replaced by a recording
 * stub for the unit checks, and real local HTTP servers stand in for the gateway
 * for the integration checks — so the hook is exercised through undici exactly
 * as dsh exercises it, including uninstall restoring the original.
 *
 * Run: node test-fetch.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createFetchPin, isGatewayChat, provisionProfile, statusFileFor, withDefaults } from './index.js'

// The hook publishes a status file by default; keep every run's out of the
// user's real DSH_HOME (and let the default resolution be what is exercised).
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clinepass-fetch-'))
process.env.DSH_HOME = SCRATCH
const STATUS = path.join(SCRATCH, 'dsh-clinepass-status.json')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

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

const GATEWAY = 'https://api.cline.bot'
const CHAT = `${GATEWAY}/api/v1/chat/completions`

const CHAT_BODY = {
  model: 'cline-pass/deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  max_tokens: 512,
  tools: [{ type: 'function', function: { name: 'x' } }],
}

const jsonInit = (extra = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk_test' },
  body: JSON.stringify(CHAT_BODY),
  ...extra,
})

/** Replace globalThis.fetch with a recording stub; returns the stub and a restore. */
function stubFetch(handler) {
  const real = globalThis.fetch
  const calls = []
  const fn = (input, init) => {
    calls.push({ input, init })
    return handler(input, init, calls.length)
  }
  globalThis.fetch = fn
  return { calls, fn, restore: () => { globalThis.fetch = real } }
}

/** The JSON body of a recorded call whose input was a string/URL. */
function bodyOf(call) {
  const raw = typeof call.init?.body === 'string' ? call.init.body : Buffer.from(call.init?.body ?? '').toString('utf8')
  return JSON.parse(raw)
}

const only = (call) => bodyOf(call).providerOptions?.gateway?.only

// ── 1. URL scoping ──────────────────────────────────────────────────────────
console.log('\n── 1. URL scoping ────────────────────────────────────────')
check('the gateway chat endpoint matches', isGatewayChat(CHAT, GATEWAY) === true)
check('a query string still matches', isGatewayChat(`${CHAT}?x=1`, GATEWAY) === true)
check('a trailing slash still matches', isGatewayChat(`${CHAT}/`, GATEWAY) === true)
check('another provider is not touched', isGatewayChat('https://api.deepseek.com/v1/chat/completions', GATEWAY) === false)
check('another host on the same path is not touched', isGatewayChat('https://evil.test/api/v1/chat/completions', GATEWAY) === false)
check('a same-host non-chat path is not touched', isGatewayChat(`${GATEWAY}/api/v1/models`, GATEWAY) === false)
check('a lookalike path is not touched', isGatewayChat(`${GATEWAY}/api/v1/chat/completions-extra`, GATEWAY) === false)
check('a relative URL is not touched', isGatewayChat('/api/v1/chat/completions', GATEWAY) === false)
check('a non-URL is not touched', isGatewayChat('not a url', GATEWAY) === false)

// ── 2. install / uninstall ──────────────────────────────────────────────────
console.log('\n── 2. install and uninstall ──────────────────────────────')
{
  const native = globalThis.fetch

  const absent = createFetchPin({}, recorder())
  check('uninstall before install is a no-op', absent.uninstall() === 'absent')

  const installed = stubFetch(() => new Response('{}'))
  const hook = createFetchPin({}, recorder())
  check('install reports success', hook.install() === 'installed')
  check('globalThis.fetch is the hook', globalThis.fetch !== installed.fn && globalThis.fetch !== native)
  check('installing twice is still one hook', hook.install() === 'installed')
  check('uninstall restores what was there before', hook.uninstall() === 'restored' && globalThis.fetch === installed.fn)
  installed.restore()

  // A reload in the same process must not leave a chain of wrappers behind.
  const one = createFetchPin({}, recorder())
  const two = createFetchPin({}, recorder())
  one.install()
  two.install()
  const live = globalThis.fetch
  check('a displaced instance refuses to unhook the live one', one.uninstall() === 'foreign' && globalThis.fetch === live)
  check('the displaced instance leaves the live record alone', JSON.parse(fs.readFileSync(STATUS, 'utf8')).hook === 'installed', fs.readFileSync(STATUS, 'utf8'))
  check('the live hook still uninstalls cleanly', two.uninstall() === 'restored' && globalThis.fetch === native)

  const third = createFetchPin({}, recorder())
  third.install()
  const foreign = () => 'someone else'
  globalThis.fetch = foreign
  check('a foreign replacement is left alone', third.uninstall() === 'foreign' && globalThis.fetch === foreign)
  globalThis.fetch = native

  globalThis.fetch = undefined
  const logger = recorder()
  check('a missing global fetch is reported, not guessed at', createFetchPin({}, logger).install() === 'unavailable' && globalThis.fetch === undefined)
  check('the failure reaches the log', logger.lines.error.some((line) => line.includes('no global fetch')))
  globalThis.fetch = native
}

// ── 3. pass-through fidelity ────────────────────────────────────────────────
console.log('\n── 3. everything else goes out untouched ─────────────────')
{
  const stub = stubFetch(() => new Response('{}'))
  const hook = createFetchPin({}, recorder())
  hook.install()

  const foreignInit = jsonInit()
  await globalThis.fetch('https://api.deepseek.com/v1/chat/completions', foreignInit)
  check('another provider keeps its exact init object', stub.calls[0].init === foreignInit)
  check('another provider keeps its body byte-for-byte', stub.calls[0].init.body === foreignInit.body)

  const modelsInit = { method: 'GET' }
  await globalThis.fetch(`${GATEWAY}/api/v1/models`, modelsInit)
  check('a non-chat path is untouched', stub.calls[1].init === modelsInit)

  const weird = { method: 'POST', body: '{}' }
  await globalThis.fetch(42, weird)
  check('an unreadable input is passed through', stub.calls[2].init === weird)

  check('ignored requests are not counted as seen', hook.counters.seen === 0, JSON.stringify(hook.counters))
  hook.uninstall()
  stub.restore()
}

// ── 4. the pin itself ───────────────────────────────────────────────────────
console.log('\n── 4. the pin ────────────────────────────────────────────')
{
  const expected = new Response('sentinel')
  const stub = stubFetch(() => expected)
  const logger = recorder()
  const hook = createFetchPin({}, logger)
  hook.install()

  const init = jsonInit()
  const response = await globalThis.fetch(CHAT, init)
  const sent = stub.calls[0]
  check('the gateway call was seen', hook.counters.seen === 1, JSON.stringify(hook.counters))
  check('the response is the real one', response === expected)
  check('the body carries the pin', JSON.stringify(only(sent)) === '["deepseek"]', JSON.stringify(only(sent)))
  check('the model is preserved', bodyOf(sent).model === CHAT_BODY.model)
  check('the messages are preserved', JSON.stringify(bodyOf(sent).messages) === JSON.stringify(CHAT_BODY.messages))
  check('the stream flag is preserved', bodyOf(sent).stream === true)
  check('the tools are preserved', JSON.stringify(bodyOf(sent).tools) === JSON.stringify(CHAT_BODY.tools))
  check('the max_tokens are preserved', bodyOf(sent).max_tokens === 512)
  check('the method is preserved', sent.init.method === 'POST')
  check('the headers are preserved', sent.init.headers.authorization === 'Bearer sk_test' && sent.init.headers['content-type'] === 'application/json')
  check('the caller\'s init object is not mutated', init.body === JSON.stringify(CHAT_BODY))
  check('the request has a plain string body', typeof sent.init.body === 'string')
  check('the request URL is the original', sent.input === CHAT)
  check('the pin is logged', logger.lines.info.some((line) => line.includes('pinned to deepseek')))

  const urlObject = jsonInit()
  await globalThis.fetch(new URL(CHAT), urlObject)
  check('a URL object is pinned too', JSON.stringify(only(stub.calls[1])) === '["deepseek"]')
  check('a URL object call keeps its URL argument', stub.calls[1].input instanceof URL)

  // An existing gateway key must survive; only `only` is ours.
  const kept = jsonInit()
  kept.body = JSON.stringify({ ...CHAT_BODY, providerOptions: { gateway: { order: ['a'] }, other: 1 } })
  await globalThis.fetch(CHAT, kept)
  check(
    'other providerOptions survive the pin',
    JSON.stringify(bodyOf(stub.calls[2]).providerOptions) === '{"gateway":{"order":["a"],"only":["deepseek"]},"other":1}',
    JSON.stringify(bodyOf(stub.calls[2]).providerOptions),
  )

  // A caller-supplied body length must not survive a body that grew.
  const withLength = jsonInit({ headers: { 'content-type': 'application/json', 'content-length': '12', authorization: 'Bearer sk_test' } })
  await globalThis.fetch(CHAT, withLength)
  const sentLength = stub.calls[3]
  check('a stale content-length is dropped', sentLength.init.headers['content-length'] === undefined, JSON.stringify(sentLength.init.headers))
  check('the other headers are kept', sentLength.init.headers.authorization === 'Bearer sk_test' && sentLength.init.headers['content-type'] === 'application/json')
  check("the caller's headers object is not mutated", withLength.headers['content-length'] === '12')

  const headerBag = new Headers({ 'content-type': 'application/json', 'content-length': '12', authorization: 'Bearer sk_test' })
  await globalThis.fetch(CHAT, { method: 'POST', headers: headerBag, body: JSON.stringify(CHAT_BODY) })
  const sentBag = stub.calls[4]
  check('a Headers instance is copied rather than mutated', headerBag.has('content-length') && !sentBag.init.headers.has('content-length'), String(sentBag.init.headers.get('content-length')))
  check('the copied Headers keep the rest', sentBag.init.headers.get('authorization') === 'Bearer sk_test')

  const clean = jsonInit()
  await globalThis.fetch(CHAT, clean)
  check('untouched headers keep their identity', stub.calls[5].init.headers === clean.headers)

  hook.uninstall()
  stub.restore()
}

// ── 5. per-model pins and an empty pin ──────────────────────────────────────
console.log('\n── 5. per-model pins, empty pin ──────────────────────────')
{
  const stub = stubFetch(() => new Response('{}'))
  const hook = createFetchPin({ pin: ['deepseek'], pins: { 'cline-pass/other': ['anthropic'] } }, recorder())
  hook.install()

  await globalThis.fetch(CHAT, jsonInit())
  check('an unlisted model uses the default pin', JSON.stringify(only(stub.calls[0])) === '["deepseek"]')

  const other = jsonInit()
  other.body = JSON.stringify({ ...CHAT_BODY, model: 'cline-pass/other' })
  await globalThis.fetch(CHAT, other)
  check('a listed model uses its own pin', JSON.stringify(only(stub.calls[1])) === '["anthropic"]')
  hook.uninstall()

  const off = createFetchPin({ pin: [] }, recorder())
  off.install()
  const untouched = jsonInit()
  await globalThis.fetch(CHAT, untouched)
  check('an empty pin leaves the request exactly as it was', stub.calls[2].init === untouched)
  check('an empty pin counts as skipped', off.counters.skipped === 1, JSON.stringify(off.counters))
  off.uninstall()
  stub.restore()
}

// ── 6. body shapes ──────────────────────────────────────────────────────────
console.log('\n── 6. body shapes ────────────────────────────────────────')
{
  const stub = stubFetch(() => new Response('{}'))
  const logger = recorder()
  const hook = createFetchPin({}, logger)
  hook.install()
  const encoded = JSON.stringify(CHAT_BODY)

  await globalThis.fetch(CHAT, { method: 'POST', body: Buffer.from(encoded) })
  check('a Buffer body is pinned', JSON.stringify(only(stub.calls[0])) === '["deepseek"]')

  await globalThis.fetch(CHAT, { method: 'POST', body: new TextEncoder().encode(encoded) })
  check('a Uint8Array body is pinned', JSON.stringify(only(stub.calls[1])) === '["deepseek"]')

  await globalThis.fetch(CHAT, { method: 'POST', body: new TextEncoder().encode(encoded).buffer })
  check('an ArrayBuffer body is pinned', JSON.stringify(only(stub.calls[2])) === '["deepseek"]')

  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close() } })
  const streamInit = { method: 'POST', duplex: 'half', body: stream }
  await globalThis.fetch(CHAT, streamInit)
  check('a stream body is left alone', stub.calls[3].init === streamInit)
  check('the stream skip is explained', logger.lines.warn.some((line) => line.includes('ReadableStream')))

  const notJson = { method: 'POST', body: 'not json at all' }
  await globalThis.fetch(CHAT, notJson)
  check('a non-JSON body is left alone', stub.calls[4].init === notJson)
  check('the non-JSON skip is explained', logger.lines.warn.some((line) => line.includes('not JSON')))

  const arrayBody = { method: 'POST', body: '[1,2,3]' }
  await globalThis.fetch(CHAT, arrayBody)
  check('a JSON array body is left alone', stub.calls[5].init === arrayBody)
  check('the non-object skip is explained', logger.lines.warn.some((line) => line.includes('not a JSON object')))

  // A Request carries its own body: it is rebuilt, not dropped.
  const request = new Request(CHAT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) },
    body: encoded,
  })
  await globalThis.fetch(request)
  const sent = stub.calls[6]
  check('a Request is rebuilt rather than dropped', sent.input instanceof Request, String(sent.input?.constructor?.name))
  check('the rebuilt Request keeps its method', sent.input.method === 'POST')
  check('the rebuilt Request keeps its headers', sent.input.headers.get('content-type') === 'application/json')
  check('the rebuilt Request drops the stale length', sent.input.headers.get('content-length') === null, String(sent.input.headers.get('content-length')))
  check('the original Request is left alone', request.headers.get('content-length') !== null)
  check('the rebuilt Request carries the pin', JSON.stringify(JSON.parse(await sent.input.text()).providerOptions) === '{"gateway":{"only":["deepseek"]}}')
  check('the original is called with the rebuilt Request alone', sent.init === undefined, String(sent.init))

  check('pinned requests are counted', hook.counters.pinned === 4, JSON.stringify(hook.counters))
  check('unpinned requests are counted', hook.counters.skipped === 3, JSON.stringify(hook.counters))
  check('every gateway request is counted', hook.counters.seen === 7, JSON.stringify(hook.counters))
  hook.uninstall()
  stub.restore()
}

// ── 7. robustness: the hook must never break a request ──────────────────────
console.log('\n── 7. robustness ─────────────────────────────────────────')
{
  const native = globalThis.fetch

  // A body that explodes on inspection.
  const one = stubFetch(() => new Response('{}'))
  const oneLog = recorder()
  const oneHook = createFetchPin({}, oneLog)
  oneHook.install()
  const trapped = { method: 'POST', get body() { throw new Error('boom') } }
  const response = await globalThis.fetch(CHAT, trapped)
  check('a throwing init falls back to an unpinned request', one.calls[0].init === trapped && response.status === 200)
  check('the hook failure is reported', oneLog.lines.warn.some((line) => line.includes('pin hook failed')))
  oneHook.uninstall()
  one.restore()

  // An upstream failure must reach the caller unchanged.
  const two = stubFetch(() => Promise.reject(new Error('upstream exploded')))
  const twoHook = createFetchPin({}, recorder())
  twoHook.install()
  let caught = null
  await globalThis.fetch(CHAT, jsonInit()).catch((error) => { caught = error })
  check('an upstream rejection is not swallowed', caught?.message === 'upstream exploded')
  twoHook.uninstall()
  two.restore()

  // A wrapped function that throws synchronously must still reject, like fetch.
  const three = stubFetch(() => { throw new Error('sync') })
  const threeHook = createFetchPin({}, recorder())
  threeHook.install()
  let syncCaught = null
  const promise = globalThis.fetch('https://api.deepseek.com/v1/chat/completions', {})
  check('a synchronous throw becomes a rejection, like fetch', promise instanceof Promise)
  await promise.catch((error) => { syncCaught = error })
  check('the synchronous error arrives intact', syncCaught?.message === 'sync')
  threeHook.uninstall()
  three.restore()
  check('every case cleaned up', globalThis.fetch === native)

  // Re-installing an installed hook must not re-wrap whatever it already
  // wrapped — that is how a wrapper chain starts.
  const four = stubFetch(() => new Response('{}'))
  const fourHook = createFetchPin({ statusFile: false }, recorder())
  fourHook.install()
  const fourWrapper = globalThis.fetch
  check('re-installing is a no-op', fourHook.install() === 'installed' && globalThis.fetch === fourWrapper)
  fourHook.install()
  fourHook.uninstall()
  check('one uninstall fully restores', globalThis.fetch === four.fn, String(globalThis.fetch?.name))
  four.restore()

  // A wrapped function that calls the global fetch synchronously would recurse
  // forever; it must fail loudly instead of starving the event loop.
  const nativeTwo = globalThis.fetch
  globalThis.fetch = (input, init) => globalThis.fetch(input, init)
  const loopHook = createFetchPin({ statusFile: false }, recorder())
  loopHook.install()
  let recursive = null
  await globalThis.fetch(CHAT, jsonInit()).catch((error) => { recursive = error })
  check('a synchronous delegate is refused, not looped', /refusing to recurse/.test(String(recursive?.message)), String(recursive?.message).slice(0, 80))
  await globalThis.fetch('https://api.deepseek.com/v1/chat/completions', {}).catch((error) => { recursive = error })
  check('…including on non-gateway calls', /refusing to recurse/.test(String(recursive?.message)), String(recursive?.message).slice(0, 80))
  loopHook.uninstall()
  globalThis.fetch = nativeTwo
}

// ── 8. provisioning on the portless transport ───────────────────────────────
console.log('\n── 8. provisioning ───────────────────────────────────────')
{
  const makeSettings = (value, { revision = 7 } = {}) => {
    const writes = []
    return {
      writes,
      get: () => value,
      describe: () => [{ ns: 'llm-pi-ai', revision }],
      mutate: async (ns, ops, expectedRevision) => {
        writes.push({ ns, ops, expectedRevision })
        return { kind: 'written' }
      },
    }
  }
  const cfg = withDefaults({})
  cfg.baseURL = `${cfg.upstream}/api/v1`

  const empty = makeSettings({ providers: { deepseek: {} } })
  check('the profile is created without a local address', (await provisionProfile(empty, cfg, recorder())) === 'created')
  check('the profile points at the gateway itself', empty.writes[0].ops[0].value.baseURL === 'https://api.cline.bot/api/v1', empty.writes[0].ops[0].value.baseURL)
  check('no loopback address is written anywhere', JSON.stringify(empty.writes[0]).includes('127.0.0.1') === false)

  const stale = makeSettings({
    providers: {
      'cline-pass': {
        displayName: 'Cline Pass',
        api: 'openai-completions',
        apiKeyEnv: 'CLINE_PASS_API_KEY',
        baseURL: 'http://127.0.0.1:8791/api/v1',
        models: [{ id: 'cline-pass/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 921600, maxTokens: 131072, input: ['text', 'image'], reasoningEfforts: { high: 'high', xhigh: 'max' } }],
      },
    },
  })
  check('a profile left on the old proxy address is repaired', (await provisionProfile(stale, cfg, recorder())) === 'repaired')
  check(
    'the repair moves the address and retires the alias in one write',
    JSON.stringify(stale.writes[0].ops.map((op) => op.path.join('.'))) === '["providers.cline-pass.baseURL","providers.cline-pass.models"]' &&
      stale.writes[0].ops[0].value === 'https://api.cline.bot/api/v1' &&
      JSON.stringify(stale.writes[0].ops[1].value[0].reasoningEfforts) === '{"high":"high","max":"max"}',
    JSON.stringify(stale.writes[0].ops),
  )

  const upToDate = {
    displayName: 'Cline Pass',
    api: 'openai-completions',
    apiKeyEnv: 'CLINE_PASS_API_KEY',
    baseURL: 'https://api.cline.bot/api/v1',
    models: [{ id: 'cline-pass/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 921600, maxTokens: 131072, input: ['text', 'image'], reasoningEfforts: { high: 'high', max: 'max' } }],
  }
  const present = makeSettings({ providers: { 'cline-pass': structuredClone(upToDate) } })
  check('an already-correct profile is left alone', (await provisionProfile(present, cfg, recorder())) === 'present' && present.writes.length === 0, JSON.stringify(present.writes))

  // An install that still declares the retired `xhigh` alias gets it dropped, and
  // keeps a level the user added themselves.
  const older = structuredClone(upToDate)
  older.models[0].reasoningEfforts = { high: 'high', xhigh: 'max', medium: 'medium' }
  const upgrading = makeSettings({ providers: { 'cline-pass': older } })
  check('a profile that predates the two-level set is repaired', (await provisionProfile(upgrading, cfg, recorder())) === 'repaired', JSON.stringify(upgrading.writes))
  check(
    '…retiring the alias without dropping the user\'s own level',
    JSON.stringify(upgrading.writes[0].ops[0].value[0].reasoningEfforts) === '{"high":"high","medium":"medium","max":"max"}',
    JSON.stringify(upgrading.writes[0].ops[0].value[0].reasoningEfforts),
  )
  check('…and the address is untouched', upgrading.writes[0].ops.length === 1 && upgrading.writes[0].ops[0].path.join('.') === 'providers.cline-pass.models')

  const customFetchProfile = makeSettings({ providers: { 'cline-pass': { api: 'openai-completions', apiKeyEnv: 'SOMEONE_ELSES_KEY', baseURL: 'https://api.cline.bot/api/v1' } } })
  check('a card this plugin did not write is never rewritten', (await provisionProfile(customFetchProfile, cfg, recorder())) === 'mismatch' && customFetchProfile.writes.length === 0)

  // An install written for the removed loopback transport still boots: the
  // options are reported and ignored (never fatal), and the card is repaired to
  // the gateway in the same write.
  const legacyLogs = recorder()
  const stillFine = makeSettings({ providers: {} })
  const legacyCfg = withDefaults({ transport: 'proxy', listen: '127.0.0.1:8791' }, legacyLogs)
  check('a removed transport option does not break provisioning', (await provisionProfile(stillFine, legacyCfg, legacyLogs)) === 'created', JSON.stringify(legacyLogs.lines.warn))
  check('…and the card it writes has no port', stillFine.writes[0].ops[0].value.baseURL === 'https://api.cline.bot/api/v1', stillFine.writes[0].ops[0].value.baseURL)
  check('…while the removed option is reported', legacyLogs.lines.warn.some((line) => line.includes('"transport"')) && legacyLogs.lines.warn.some((line) => line.includes('"listen"')), JSON.stringify(legacyLogs.lines.warn))

  const legacyAddress = makeSettings({ providers: { 'cline-pass': { api: 'openai-completions', apiKeyEnv: 'CLINE_PASS_API_KEY', baseURL: 'http://127.0.0.1:8791/api/v1', models: [{ id: 'cline-pass/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 921600, maxTokens: 131072, input: ['text', 'image'], reasoningEfforts: { high: 'high', max: 'max' } }] } } })
  check('a card left on a loopback address is moved to the gateway', (await provisionProfile(legacyAddress, withDefaults({ listen: '127.0.0.1:8791' }, { warn: () => {} }), recorder())) === 'repaired' && legacyAddress.writes[0].ops[0].value === 'https://api.cline.bot/api/v1', JSON.stringify(legacyAddress.writes[0]?.ops))
}

// ── 9. the status file: a silent bypass has to be visible ───────────────────
console.log('\n── 9. status file ────────────────────────────────────────')
{
  const read = (file = STATUS) => JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.rmSync(STATUS, { force: true })

  const stub = stubFetch(() => new Response('{}'))
  const hook = createFetchPin({ upstream: GATEWAY }, recorder())
  check('the default path lands under DSH_HOME', statusFileFor(withDefaults({})) === STATUS, statusFileFor(withDefaults({})))
  hook.install()
  check('install publishes the hook state', read().hook === 'installed' && read().transport === 'fetch', JSON.stringify(read().hook))
  check('an install with no legacy options publishes an empty ignored list', JSON.stringify(read().ignoredOptions) === '[]', JSON.stringify(read().ignoredOptions))
  check('the counters start at zero', read().counters.pinned === 0 && read().lastPin === null)

  await globalThis.fetch(CHAT, jsonInit())
  const afterPin = read()
  check('a pinned request is counted', afterPin.counters.pinned === 1 && afterPin.counters.seen === 1, JSON.stringify(afterPin.counters))
  check('the last pin is described', afterPin.lastPin?.model === CHAT_BODY.model && JSON.stringify(afterPin.lastPin?.only) === '["deepseek"]', JSON.stringify(afterPin.lastPin))
  await globalThis.fetch(CHAT, { method: 'POST', body: 'not json' })
  check('a skipped request is counted too', read().counters.skipped === 1 && read().counters.seen === 2, JSON.stringify(read().counters))
  check('the status never carries a credential', !JSON.stringify(read()).includes('sk_test'))

  hook.uninstall()
  check('uninstall publishes the final state', read().hook === 'uninstalled')
  stub.restore()

  const custom = path.join(SCRATCH, 'nested', 'mine.json')
  const customHook = createFetchPin({ statusFile: custom }, recorder())
  customHook.install()
  check('a custom path is honoured', fs.existsSync(custom) && customHook.statusPath === custom)
  customHook.uninstall()

  const offHook = createFetchPin({ statusFile: false }, recorder())
  offHook.install()
  check('statusFile: false writes nothing', statusFileFor(withDefaults({ statusFile: false })) === null && offHook.statusPath === null)
  offHook.uninstall()

  // A path that cannot be written must warn once, and must not stop the hook.
  const blocked = path.join(SCRATCH, 'blocked.json')
  fs.writeFileSync(blocked, 'x')
  const blockedLogger = recorder()
  const blockedStub = stubFetch(() => new Response('{}'))
  const blockedHook = createFetchPin({ statusFile: path.join(blocked, 'child.json') }, blockedLogger)
  check('an unwritable status path does not break install', blockedHook.install() === 'installed')
  await globalThis.fetch(CHAT, jsonInit())
  check('the hook still pins despite the status failure', JSON.stringify(only(blockedStub.calls[0])) === '["deepseek"]', JSON.stringify(only(blockedStub.calls[0])))
  check('the write failure is reported once, not per request', blockedLogger.lines.warn.filter((line) => line.includes('could not write')).length === 1, JSON.stringify(blockedLogger.lines.warn))
  blockedHook.uninstall()
  blockedStub.restore()

  // A replacement of the global fetch after install must become visible — once,
  // not on every 30 s tick.
  const bypassStub = stubFetch(() => new Response('{}'))
  const watcherLogs = recorder()
  const watched = createFetchPin({ upstream: GATEWAY }, watcherLogs)
  watched.install()
  check('the ownership check is happy while it owns the global', watched.checkOwnership() === 'installed')
  const foreignFetch = () => new Response('{}')
  globalThis.fetch = foreignFetch
  check('a foreign replacement is reported', watched.checkOwnership() === 'foreign')
  check('the status file says so', read().hook === 'foreign', JSON.stringify(read().hook))
  const warningsAfterFirst = watcherLogs.lines.warn.filter((line) => line.includes('no longer the pin hook')).length
  const mtime = fs.statSync(STATUS).mtimeMs
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let tick = 0; tick < 5; tick += 1) watched.checkOwnership()
  check('…repeated ticks do not warn again', watcherLogs.lines.warn.filter((line) => line.includes('no longer the pin hook')).length === warningsAfterFirst, String(warningsAfterFirst))
  check('…and do not rewrite the status file', fs.statSync(STATUS).mtimeMs === mtime)
  globalThis.fetch = bypassStub.fn
  check('a fetch restored to what this hook captured is not called foreign', watched.checkOwnership() === 'uninstalled', watched.checkOwnership())
  check('…and the record follows it back', read().hook === 'uninstalled', JSON.stringify(read().hook))
  globalThis.fetch = foreignFetch
  watched.checkOwnership()
  check('disposing a displaced hook leaves the foreign fetch alone', watched.uninstall() === 'foreign' && globalThis.fetch === foreignFetch)
  bypassStub.restore()

  // …but a *newer instance of ours* owns the record, so the older one must not
  // claim the hook was replaced.
  const older = createFetchPin({ upstream: GATEWAY }, recorder())
  const newer = createFetchPin({ upstream: GATEWAY }, recorder())
  older.install()
  newer.install()
  check('a newer instance is not mistaken for a foreign one', older.checkOwnership() === 'replaced-by-us', older.checkOwnership())
  check('the newer instance owns the record', read().hook === 'installed', JSON.stringify(read().hook))
  older.uninstall()
  check('disposing the older instance leaves the record intact', read().hook === 'installed', JSON.stringify(read().hook))
  newer.uninstall()
}

// ── 10. apply(): hooks the process, opens nothing ───────────────────────────
console.log('\n── 10. apply() ───────────────────────────────────────────')
{
  const realFetch = globalThis.fetch
  const makeSettings = (value, effort = 'max') => {
    const writes = []
    return {
      writes,
      get: (ns) => (ns === 'llm-pi-ai' ? value : { provider: 'cline-pass', reasoningEffort: effort }),
      describe: () => [{ ns: 'llm-pi-ai', revision: 1 }, { ns: 'agent-default-model', revision: 2 }],
      mutate: async (ns, ops, expectedRevision) => {
        writes.push({ ns, ops, expectedRevision })
        return { kind: 'written' }
      },
    }
  }

  // A listener this plugin opened would show up as a live TCP server handle.
  // `process.getActiveResourcesInfo()` sees *any* server, however it was
  // created, unlike a patched `http.createServer` (which this module never
  // imports). The control below proves the probe can see one.
  const tcpServers = () => process.getActiveResourcesInfo().filter((kind) => kind.toLowerCase() === 'tcpserverwrap').length
  const before = tcpServers()
  const control = http.createServer(() => {})
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve))
  check('the listener probe detects a real listener', tcpServers() === before + 1, `${before} -> ${tcpServers()}`)
  // The control stays open across the apply() calls below, so the probe is
  // proven sensitive at the moment it is used: a listener the plugin opened
  // would show up as one more than this baseline. (Closing the control here
  // would leave its handle in the resource list for a tick, which is exactly
  // the kind of accounting artifact this check must not depend on.)
  const baseline = tcpServers()

  const { apply } = await import('./index.js')
  const settings = makeSettings({ providers: {} })
  const logger = recorder()
  let disposer
  await apply({ logger, settings, effect: (register) => { disposer = register() } }, {})
  check('apply hooks the global fetch', globalThis.fetch !== realFetch)
  check('apply opens no listener at all', tcpServers() === baseline, `tcp servers ${baseline} -> ${tcpServers()}`)
  check('the profile is created against the gateway', settings.writes[0]?.ops[0]?.value?.baseURL === 'https://api.cline.bot/api/v1', JSON.stringify(settings.writes[0]?.ops[0]?.value?.baseURL))
  check('a stored "max" effort is left alone', settings.writes.length === 1 && !settings.writes.some((write) => write.ns === 'agent-default-model'), JSON.stringify(settings.writes.map((write) => write.ns)))
  check('apply reports the in-process hook', logger.lines.info.some((line) => line.includes('pin injected in-process, no listener')))
  disposer()
  check('unloading restores the global fetch', globalThis.fetch === realFetch)

  const oddEffort = makeSettings({ providers: {} }, 'turbo')
  let oddDisposer
  await apply({ logger: recorder(), settings: oddEffort, effect: (register) => { oddDisposer = register() } }, {})
  check('an unsupported stored effort is realigned to high', oddEffort.writes[1]?.ops[0]?.value === 'high', JSON.stringify(oddEffort.writes[1]?.ops[0]))
  oddDisposer()
  check('that hook is disposed again', globalThis.fetch === realFetch)

  // A config still asking for the removed loopback transport must not open one.
  const legacySettings = makeSettings({ providers: {} })
  const legacyBoot = recorder()
  let legacyDisposer
  await apply({ logger: legacyBoot, settings: legacySettings, effect: (register) => { legacyDisposer = register() } }, { transport: 'proxy', listen: '127.0.0.1:0' })
  check('a legacy transport: proxy config opens no listener', tcpServers() === baseline, `tcp servers ${baseline} -> ${tcpServers()}`)
  check('…and is reported, then served in-process', legacyBoot.lines.warn.some((line) => line.includes('"transport"')) && globalThis.fetch !== realFetch, JSON.stringify(legacyBoot.lines.warn))
  check('…and its card still points at the gateway', legacySettings.writes[0].ops[0].value.baseURL === 'https://api.cline.bot/api/v1', legacySettings.writes[0].ops[0].value.baseURL)
  legacyDisposer()
  check('…and the hook is disposed again', globalThis.fetch === realFetch)

  const badUrl = recorder()
  const badUrlSettings = makeSettings({ providers: {} })
  globalThis.fetch = realFetch
  let badUrlEffects = 0
  await apply({ logger: badUrl, settings: badUrlSettings, effect: () => { badUrlEffects += 1 } }, { upstream: 'api.cline.bot' })
  check('an upstream that is not a URL is reported at boot', badUrl.lines.error.some((line) => line.includes('is not a URL')), JSON.stringify(badUrl.lines.error))
  // …and nothing happens: no hook to dispose, no card written from a typo.
  check('…nothing is hooked', globalThis.fetch === realFetch && badUrlEffects === 0, `effects=${badUrlEffects}`)
  check('…and no card is written from it', badUrlSettings.writes.length === 0, JSON.stringify(badUrlSettings.writes))

  const noFetch = recorder()
  const savedFetch = globalThis.fetch
  globalThis.fetch = undefined
  await apply({ logger: noFetch, settings: makeSettings({ providers: {} }), effect: () => {} }, {})
  globalThis.fetch = savedFetch
  check('a hook that could not be installed says so', noFetch.lines.error.some((line) => line.includes('could not hook the global fetch')))
  check('…and is not also announced as injected', !noFetch.lines.info.some((line) => line.includes('pin injected in-process')), JSON.stringify(noFetch.lines.info))

  const shadowed = recorder()
  await apply(
    { logger: shadowed, settings: makeSettings({ providers: {} }), effect: () => {} },
    { pins: { 'cline-pass/deepseek-v4.1-flash': [] } },
  )
  check(
    'an empty per-model pin that shadows a real one is reported',
    shadowed.lines.warn.some((line) => line.includes('pins["cline-pass/deepseek-v4.1-flash"] is empty')),
    JSON.stringify(shadowed.lines.warn),
  )

  globalThis.fetch = realFetch
  await new Promise((resolve) => control.close(resolve))
}

// ── 11. integration: through undici, against real local servers ─────────────
console.log('\n── 11. integration through the real fetch ─────────────────')
{
  const received = []
  const record = (label) => async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    received.push({ label, url: req.url, headers: req.headers, text, body: text.length === 0 ? null : JSON.parse(text) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  }
  const gateway = http.createServer(record('gateway'))
  const elsewhere = http.createServer(record('elsewhere'))
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => elsewhere.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${gateway.address().port}`
  const otherOrigin = `http://127.0.0.1:${elsewhere.address().port}`

  const realFetch = globalThis.fetch
  const hook = createFetchPin({ upstream: origin }, recorder())
  hook.install()

  const response = await globalThis.fetch(`${origin}/api/v1/chat/completions`, jsonInit())
  check('the gateway answered through the hook', response.status === 200)
  check('the wire body is pinned', JSON.stringify(received[0].body.providerOptions) === '{"gateway":{"only":["deepseek"]}}', JSON.stringify(received[0].body.providerOptions))
  check('the wire path is unchanged', received[0].url === '/api/v1/chat/completions', received[0].url)
  check('the wire headers are unchanged', received[0].headers.authorization === 'Bearer sk_test')
  check('the wire model is unchanged', received[0].body.model === CHAT_BODY.model)

  await globalThis.fetch(`${otherOrigin}/api/v1/chat/completions`, jsonInit())
  check('another origin on the same path is not rewritten', received[1].body.providerOptions === undefined, JSON.stringify(received[1].body.providerOptions))

  hook.uninstall()
  await globalThis.fetch(`${origin}/api/v1/chat/completions`, jsonInit())
  check('after uninstall the wire body carries no pin', received[2].body.providerOptions === undefined, JSON.stringify(received[2].body.providerOptions))
  check('uninstall restored the native fetch', globalThis.fetch === realFetch)

  await new Promise((resolve) => gateway.close(resolve))
  await new Promise((resolve) => elsewhere.close(resolve))
}

console.log(`\nRESULT: ${failures.length === 0 ? 'FETCH OK' : `FAILED (${failures.join(' | ')})`}`)
process.exit(failures.length === 0 ? 0 : 2)
