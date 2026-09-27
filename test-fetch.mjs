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
import { createFetchPin, installPromptDisplay, isGatewayChat, isTerminatorFrame, nextFrameEnd, provisionProfile, routingOfText, statusFileFor, withDefaults } from './index.js'

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

/**
 * A host plugin-context double.
 *
 * `apply` also registers a prompt-assembly listener on the Cordis event bus, so
 * the double records the event names it was asked to listen for — that is how a
 * thrown-away ctx would otherwise hide a registration.
 */
function ctxFor(logger, settings, effect = () => {}) {
  const listeners = new Map()
  return {
    logger,
    settings,
    effect,
    listeners,
    on(event, listener, options) {
      listeners.set(event, { listener, options })
    },
  }
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

/**
 * 一份「由 provider 服务」的网关响应。
 *
 * 本地闸（`enforcement: strict`，默认）拿到响应后会读 `gateway.routing` 判断真正服务
 * 这次请求的是谁，读不出允许的渠道就整条拒掉。所以假网关的响应必须带上这段元数据 ——
 * 不带的话这些「钉选/透传」用例全会撞在闸上（那本身是对的，见第 4b 节）。
 *
 * @param provider - `finalProvider` 的值。
 * @param resolved - `resolvedProvider` 的值（默认与 `finalProvider` 相同）。
 * @returns 响应体 JSON 文本。
 */
function gatewayBody(provider = 'deepseek', resolved = provider) {
  return JSON.stringify({
    ok: true,
    choices: [
      {
        message: {
          provider_metadata: {
            gateway: {
              routing: {
                finalProvider: provider,
                resolvedProvider: resolved,
                fallbacksAvailable: [],
                modelAttempts: [{ providerAttempts: [{ provider, success: true }] }],
              },
            },
          },
        },
      },
    ],
  })
}

const GATEWAY_BODY = gatewayBody('deepseek')

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
  const expected = new Response(GATEWAY_BODY)
  const stub = stubFetch(() => expected)
  const logger = recorder()
  const hook = createFetchPin({}, logger)
  hook.install()

  const init = jsonInit()
  const response = await globalThis.fetch(CHAT, init)
  const sent = stub.calls[0]
  check('the gateway call was seen', hook.counters.seen === 1, JSON.stringify(hook.counters))
  // 闸会读完整条响应再重建一个（body 换成缓冲后的那份），所以这里比内容、不比对象身份。
  check('the verified response is passed through', (await response.text()) === GATEWAY_BODY, `HTTP ${response.status}`)
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

// ── 4b. the local gate ──────────────────────────────────────────────────────
//
// 网关自 2026-09-22 起不再执行 providerOptions.gateway.only，钉选改由插件在本地兑现：
// 读完整条响应、从 routing 里读出真正服务它的渠道，不在允许列表里就整条丢掉。
console.log('\n── 4b. the local gate ────────────────────────────────────')
{
  // 允许 deepseek，网关却说是 alibaba → 必须拒，而且响应体里不能有任何模型输出。
  const stub = stubFetch(() => new Response(gatewayBody('alibaba')))
  const logger = recorder()
  const hook = createFetchPin({}, logger)
  hook.install()
  const response = await globalThis.fetch(CHAT, jsonInit())
  const body = await response.text()
  check('a foreign channel is refused with 400', response.status === 400, `HTTP ${response.status}`)
  check('the refusal is machine-readable', /PROVIDER_PIN_VIOLATION/.test(body), body.slice(0, 100))
  check('the model output is not handed over', !/"ok":true/.test(body), body.slice(0, 100))
  check('the refusal is counted', hook.counters.blocked === 1, JSON.stringify(hook.counters))
  check('the violation names the provider', hook.state().lastViolation?.finalProvider === 'alibaba', JSON.stringify(hook.state().lastViolation ?? null).slice(0, 120))
  check('the violation is logged as an error', logger.lines.error.some((line) => line.includes('拦下')), JSON.stringify(logger.lines.error))
  hook.uninstall()

  // warn：同样判定，但放行，只记录。
  const warnStub = stubFetch(() => new Response(gatewayBody('alibaba')))
  const warnHook = createFetchPin({ enforcement: 'warn' }, recorder())
  warnHook.install()
  const warned = await globalThis.fetch(CHAT, jsonInit())
  check('warn lets a foreign response through', warned.status === 200 && (await warned.text()) === gatewayBody('alibaba'), `HTTP ${warned.status}`)
  check('warn still counts and records it', warnHook.counters.blocked === 1 && warnHook.state().lastViolation?.finalProvider === 'alibaba')
  warnHook.uninstall()

  // off：不校验、不缓冲 —— 响应对象原样返回。
  const offExpected = new Response(gatewayBody('alibaba'))
  const offStub = stubFetch(() => offExpected)
  const offHook = createFetchPin({ enforcement: 'off' }, recorder())
  offHook.install()
  check('off returns the very same response', (await globalThis.fetch(CHAT, jsonInit())) === offExpected)
  check('off blocks nothing', offHook.counters.blocked === 0 && offHook.state().lastViolation === null, JSON.stringify(offHook.counters))
  offHook.uninstall()

  // 没有 routing 元数据 = 无法证明 → strict 下按未通过处理（fail closed）。
  const muteStub = stubFetch(() => new Response('{"ok":true}'))
  const muteHook = createFetchPin({}, recorder())
  muteHook.install()
  const mute = await globalThis.fetch(CHAT, jsonInit())
  check('a response with no routing metadata is refused', mute.status === 400 && /PROVIDER_PIN_VIOLATION/.test(await mute.text()), `HTTP ${mute.status}`)
  muteHook.uninstall()

  // 非 2xx 原样放行：那是失败的调用，改写它会掩盖配额/限流。
  const errStub = stubFetch(() => new Response('{"error":"rate limited"}', { status: 429 }))
  const errHook = createFetchPin({}, recorder())
  errHook.install()
  const err = await globalThis.fetch(CHAT, jsonInit())
  check('an upstream error passes through untouched', err.status === 429 && errHook.counters.blocked === 0, `HTTP ${err.status}`)
  errHook.uninstall()

  // 两个「谁服务了它」的字段必须都指向允许的渠道：网关哪天开始让它们不一致，
  // 就该停下来看，而不是挑好看的那个信。
  const splitStub = stubFetch(() => new Response(gatewayBody('deepseek', 'alibaba')))
  const splitHook = createFetchPin({}, recorder())
  splitHook.install()
  const split = await globalThis.fetch(CHAT, jsonInit())
  check(
    'a disagreeing resolvedProvider is refused',
    split.status === 400 && /PROVIDER_PIN_VIOLATION/.test(await split.text()) && /resolvedProvider=alibaba/.test(String(splitHook.state().lastViolation?.reason)),
    `HTTP ${split.status}: ${String(splitHook.state().lastViolation?.reason)}`,
  )
  splitHook.uninstall()

  // 恢复顺序必须**逆序**：每个 stub 记下的 `real` 是它创建时的那个 fetch，
  // 顺序恢复会把 globalThis.fetch 留在中间某个已经作废的 stub 上。
  splitStub.restore(); errStub.restore(); muteStub.restore(); offStub.restore(); warnStub.restore(); stub.restore()
}

// ── 5. per-model pins and an empty pin ──────────────────────────────────────
console.log('\n── 5. per-model pins, empty pin ──────────────────────────')
{
  const stub = stubFetch(() => new Response(GATEWAY_BODY))
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
  const makeSettings = (value, { revision = 7, legacyGet = false } = {}) => {
    const writes = []
    const double = {
      writes,
      // 0.1.7's `SettingsForms` has no `get()`: the live value is on the descriptor.
      // `legacyGet` models the host before that, to keep the fallback covered.
      describe: () => [{ ns: 'llm-pi-ai', revision, value }],
      mutate: async (ns, ops, expectedRevision) => {
        writes.push({ ns, ops, expectedRevision })
        return { kind: 'written' }
      },
    }
    if (legacyGet) double.get = () => value
    return double
  }
  const cfg = withDefaults({})
  cfg.baseURL = `${cfg.upstream}/api/v1`

  const legacyRead = makeSettings({ providers: { deepseek: {} } }, { legacyGet: true })
  check('a host that only exposes get() still provisions', (await provisionProfile(legacyRead, cfg, recorder())) === 'created', JSON.stringify(legacyRead.writes))

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
  const mismatchNotes = []
  check(
    'a card this plugin did not write is never rewritten',
    (await provisionProfile(customFetchProfile, cfg, recorder(), (reason) => mismatchNotes.push(reason))) === 'mismatch' && customFetchProfile.writes.length === 0,
  )
  check(
    '…and the reason travels beside the verdict, not only into the log',
    mismatchNotes.length === 1 && mismatchNotes[0].includes('not the one this plugin wrote') && mismatchNotes[0].includes('SOMEONE_ELSES_KEY') === false,
    JSON.stringify(mismatchNotes),
  )

  // A settings service that refuses the write: the verdict alone ("failed") says
  // nothing an operator can act on, and the log line may land nowhere.
  const refusing = {
    get: () => ({}),
    describe: () => [{ ns: 'llm-pi-ai', revision: 7 }],
    mutate: async () => {
      throw new Error('No configurable plugin entry "llm-pi-ai"')
    },
  }
  const failureNotes = []
  check(
    'a refused settings write is reported as failed',
    (await provisionProfile(refusing, cfg, recorder(), (reason) => failureNotes.push(reason))) === 'failed',
  )
  check(
    '…carrying the message that explains it',
    failureNotes.length === 1 && failureNotes[0].includes('No configurable plugin entry') && failureNotes[0].startsWith('could not provision'),
    JSON.stringify(failureNotes),
  )

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
  check(
    'the provisioning result starts unrecorded',
    read().provision === null && hook.state().provision === null,
    JSON.stringify({ file: read().provision, state: hook.state().provision }),
  )
  hook.noteProvision('present')
  check(
    'the provisioning result reaches the status file, not only the log',
    read().provision === 'present' && hook.state().provision === 'present',
    JSON.stringify({ file: read().provision, state: hook.state().provision }),
  )
  check(
    'a clean provisioning carries no reason',
    read().provisionReason === null && hook.state().provisionReason === null,
    JSON.stringify(read().provisionReason),
  )
  hook.noteProvision('failed', 'could not provision the "cline-pass" profile: No configurable plugin entry "llm-pi-ai"')
  check(
    'a failed provisioning carries the sentence that explains it',
    read().provision === 'failed' && /No configurable plugin entry/.test(read().provisionReason ?? '') && hook.state().provisionReason === read().provisionReason,
    JSON.stringify({ file: read().provisionReason, state: hook.state().provisionReason }),
  )
  check(
    'nothing is recorded as skipped before anything is skipped',
    read().lastSkipped === null && hook.state().lastSkipped === null,
    JSON.stringify(read().lastSkipped),
  )

  await globalThis.fetch(CHAT, jsonInit())
  const afterPin = read()
  check('a pinned request is counted', afterPin.counters.pinned === 1 && afterPin.counters.seen === 1, JSON.stringify(afterPin.counters))
  check('the last pin is described', afterPin.lastPin?.model === CHAT_BODY.model && JSON.stringify(afterPin.lastPin?.only) === '["deepseek"]', JSON.stringify(afterPin.lastPin))
  await globalThis.fetch(CHAT, { method: 'POST', body: 'not json' })
  check('a skipped request is counted too', read().counters.skipped === 1 && read().counters.seen === 2, JSON.stringify(read().counters))
  // The reason used to live only in a `logger.warn` line, and whether those lines
  // reach a file at all depends on the host (the README records a deployment where
  // they do not). `seen` climbing while `pinned` does not has to be answerable from
  // the status file alone.
  const afterSkip = read()
  check(
    'a skipped request records why, and which request',
    afterSkip.lastSkipped?.reason === 'the body is not JSON' && afterSkip.lastSkipped?.url === CHAT,
    JSON.stringify(afterSkip.lastSkipped),
  )
  check(
    '…with a timestamp, and in the in-process state too',
    typeof afterSkip.lastSkipped?.at === 'string' && hook.state().lastSkipped?.reason === afterSkip.lastSkipped.reason,
    JSON.stringify(hook.state().lastSkipped),
  )
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
  const boot = ctxFor(logger, settings, (register) => { disposer = register() })
  await apply(boot, {})
  check('apply hooks the global fetch', globalThis.fetch !== realFetch)
  check('apply opens no listener at all', tcpServers() === baseline, `tcp servers ${baseline} -> ${tcpServers()}`)
  check('the profile is created against the gateway', settings.writes[0]?.ops[0]?.value?.baseURL === 'https://api.cline.bot/api/v1', JSON.stringify(settings.writes[0]?.ops[0]?.value?.baseURL))
  check('a stored "max" effort is left alone', settings.writes.length === 1 && !settings.writes.some((write) => write.ns === 'agent-default-model'), JSON.stringify(settings.writes.map((write) => write.ns)))
  check('apply reports the in-process hook', logger.lines.info.some((line) => line.includes('pin injected in-process, no listener')))
  check('apply registers the prompt-display listener', boot.listeners.has('system-prompt/assemble'))
  check('…and says which model id the prompt will show', logger.lines.info.some((line) => line.includes('prompt shows deepseek-v4.1-flash')), JSON.stringify(logger.lines.info))
  disposer()
  check('unloading restores the global fetch', globalThis.fetch === realFetch)

  const oddEffort = makeSettings({ providers: {} }, 'turbo')
  let oddDisposer
  await apply(ctxFor(recorder(), oddEffort, (register) => { oddDisposer = register() }), {})
  check('an unsupported stored effort is realigned to high', oddEffort.writes[1]?.ops[0]?.value === 'high', JSON.stringify(oddEffort.writes[1]?.ops[0]))
  oddDisposer()
  check('that hook is disposed again', globalThis.fetch === realFetch)

  // A config still asking for the removed loopback transport must not open one.
  const legacySettings = makeSettings({ providers: {} })
  const legacyBoot = recorder()
  let legacyDisposer
  await apply(ctxFor(legacyBoot, legacySettings, (register) => { legacyDisposer = register() }), { transport: 'proxy', listen: '127.0.0.1:0' })
  check('a legacy transport: proxy config opens no listener', tcpServers() === baseline, `tcp servers ${baseline} -> ${tcpServers()}`)
  check('…and is reported, then served in-process', legacyBoot.lines.warn.some((line) => line.includes('"transport"')) && globalThis.fetch !== realFetch, JSON.stringify(legacyBoot.lines.warn))
  check('…and its card still points at the gateway', legacySettings.writes[0].ops[0].value.baseURL === 'https://api.cline.bot/api/v1', legacySettings.writes[0].ops[0].value.baseURL)
  legacyDisposer()
  check('…and the hook is disposed again', globalThis.fetch === realFetch)

  const badUrl = recorder()
  const badUrlSettings = makeSettings({ providers: {} })
  globalThis.fetch = realFetch
  let badUrlEffects = 0
  const badUrlCtx = ctxFor(badUrl, badUrlSettings, () => { badUrlEffects += 1 })
  await apply(badUrlCtx, { upstream: 'api.cline.bot' })
  check('an upstream that is not a URL is reported at boot', badUrl.lines.error.some((line) => line.includes('is not a URL')), JSON.stringify(badUrl.lines.error))
  // …and nothing happens: no hook to dispose, no card written from a typo.
  check('…nothing is hooked', globalThis.fetch === realFetch && badUrlEffects === 0, `effects=${badUrlEffects}`)
  check('…and no card is written from it', badUrlSettings.writes.length === 0, JSON.stringify(badUrlSettings.writes))
  check('…and not even the prompt listener is registered', badUrlCtx.listeners.size === 0, JSON.stringify([...badUrlCtx.listeners.keys()]))

  const noFetch = recorder()
  const savedFetch = globalThis.fetch
  globalThis.fetch = undefined
  await apply(ctxFor(noFetch, makeSettings({ providers: {} })), {})
  globalThis.fetch = savedFetch
  check('a hook that could not be installed says so', noFetch.lines.error.some((line) => line.includes('could not hook the global fetch')))
  check('…and is not also announced as injected', !noFetch.lines.info.some((line) => line.includes('pin injected in-process')), JSON.stringify(noFetch.lines.info))

  const shadowed = recorder()
  await apply(ctxFor(shadowed, makeSettings({ providers: {} })), { pins: { 'cline-pass/deepseek-v4.1-flash': [] } })
  check(
    'an empty per-model pin that shadows a real one is reported',
    shadowed.lines.warn.some((line) => line.includes('pins["cline-pass/deepseek-v4.1-flash"] is empty')),
    JSON.stringify(shadowed.lines.warn),
  )

  const displayOff = recorder()
  let displayOffDisposer
  const displayOffCtx = ctxFor(displayOff, makeSettings({ providers: {} }), (register) => { displayOffDisposer = register() })
  await apply(displayOffCtx, { plainModelId: false })
  check('plainModelId: false registers no prompt listener', !displayOffCtx.listeners.has('system-prompt/assemble'), JSON.stringify([...displayOffCtx.listeners.keys()]))
  check('…and the boot line says the configured id is what shows', displayOff.lines.info.some((line) => line.includes('prompt shows the configured model id')), JSON.stringify(displayOff.lines.info))
  displayOffDisposer()

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
    // 带 routing 元数据：本地闸要读它才放行（见 gatewayBody）。
    res.end(GATEWAY_BODY)
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

// ── 12. the prompt display ──────────────────────────────────────────────────
console.log('\n── 12. the prompt display ────────────────────────────────')
{
  const cfg = withDefaults({})
  const ctx = ctxFor(recorder(), undefined)
  installPromptDisplay(ctx, cfg)
  const registered = ctx.listeners.get('system-prompt/assemble')
  check('the assembly listener is registered on the event bus', registered !== undefined)
  // The whole reason the rewrite works: `installModelSelection` applies the
  // session's live selection *after* every inner listener returns, and only a
  // listener outside it ever sees the model the next request will use.
  check('…prepended, so it sits outside the model-selection listener', registered?.options?.prepend === true, JSON.stringify(registered?.options))

  /** An assembly as the loop leaves it, with the live selection already applied. */
  const assembly = (variables = {}) => ({
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' },
      { name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.' },
      { name: 'tool:bash', text: 'Model {{model}}, literally.', interpolate: false },
    ],
    contexts: [],
    tools: [],
    variables: { provider: 'cline-pass', model: 'cline-pass/deepseek-v4.1-flash', cwd: '/tmp', ...variables },
  })
  const through = (input) => registered.listener(input, {}, () => Promise.resolve(input))
  const textOf = (result, name) => result.sections.find((section) => section.name === name).text

  const live = await through(assembly())
  check(
    'the persona shows the bare DeepSeek id',
    textOf(live, 'deployment:persona-prefix') === 'You are a coding agent powered by the deepseek-v4.1-flash model.',
    textOf(live, 'deployment:persona-prefix'),
  )
  check('…while the variables keep the wire id', live.variables.model === 'cline-pass/deepseek-v4.1-flash', live.variables.model)
  check('a sibling variable in the same section still resolves later', textOf(live, 'deployment:persona-suffix') === 'Your working directory is {{cwd}}.')
  check('a literal (interpolate: false) section is untouched', textOf(live, 'tool:bash') === 'Model {{model}}, literally.')
  check('the harness identity is untouched', textOf(live, 'harness:identity') === 'You are an AI agent powered by DeepSeek Harness.')
  check('the input assembly is not mutated', assembly().sections[1].text === 'You are a coding agent powered by the {{model}} model.')

  const official = assembly({ provider: 'deepseek', model: 'deepseek-v4-flash' })
  check('an official bare id is a no-op (same assembly)', (await through(official)) === official)
  const otherRoute = assembly({ provider: 'other', model: 'other/glm-5.3-flash' })
  check('another route’s prefixed id is not ours to rename', (await through(otherRoute)) === otherRoute)
  const bareOnThisRoute = assembly({ model: 'glm-5.3-flash' })
  check('a bare id on this route is a no-op', (await through(bareOnThisRoute)) === bareOnThisRoute)
  const prefixOnly = assembly({ model: 'cline-pass/' })
  check('a prefix with no model behind it is a no-op', (await through(prefixOnly)) === prefixOnly)
  const noReference = { ...assembly(), sections: [{ name: 'deployment:persona-prefix', text: 'Be brief.' }] }
  check('a persona without the reference is a no-op', (await through(noReference)) === noReference)
  check('an assembly with no section list is passed straight through', (await through(undefined)) === undefined)

  const renamed = ctxFor(recorder(), undefined)
  installPromptDisplay(renamed, withDefaults({ provider: 'tunnel', model: 'tunnel/deepseek-v4.1-flash' }))
  const renamedLive = await renamed.listeners.get('system-prompt/assemble').listener(assembly({ provider: 'tunnel', model: 'tunnel/deepseek-v4.1-flash' }), {}, () => Promise.resolve(assembly({ provider: 'tunnel', model: 'tunnel/deepseek-v4.1-flash' })))
  check(
    'a renamed route strips its own prefix, not a hardcoded one',
    textOf(renamedLive, 'deployment:persona-prefix') === 'You are a coding agent powered by the deepseek-v4.1-flash model.',
    textOf(renamedLive, 'deployment:persona-prefix'),
  )
}

// ── 13. the streaming gate ──────────────────────────────────────────────────
//
// routing 元数据只在最后一帧出现，所以「校验」与「边流边显示」只能靠**扣住终止帧**
// 共存：内容立即转发，裁决通过才放行 [DONE]；违规就中断响应体 —— 消费者的流异常会让
// dsh 只落一条 assistant/attempt，绝不装配 assistant/message（于是工具不执行）。
console.log('\n── 13. the streaming gate ────────────────────────────────')
{
  const enc = (text) => new TextEncoder().encode(text)
  const delta = (index) => `data: ${JSON.stringify({ choices: [{ delta: { content: `tok${index}` } }] })}\n\n`
  const routingFrame = (provider, resolved = provider) => `data: ${gatewayBody(provider, resolved)}\n\n`
  const sse = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const frames = (...parts) => sse(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(enc(part))
      controller.close()
    },
  }))

  /** 逐块读完一个响应体；出错时把错误一起带回来（流式中断是正常结局之一）。 */
  async function drain(response) {
    const parts = []
    const reader = response.body.getReader()
    for (;;) {
      try {
        const { done, value } = await reader.read()
        if (done) return { text: parts.join(''), error: null }
        parts.push(new TextDecoder().decode(value))
      } catch (error) {
        return { text: parts.join(''), error }
      }
    }
  }

  // 内容必须**在裁决之前**到达消费者：上游只发了一帧 delta 就停住，此刻就该能读到它。
  // 缓冲路径下这次 read() 会一直等下去（这正是 TPS 被搞坏的那条路）。
  {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const stub = stubFetch(() => sse(new ReadableStream({
      async start(controller) {
        controller.enqueue(enc(delta(0)))
        await gate
        controller.enqueue(enc(routingFrame('deepseek')))
        controller.enqueue(enc('data: [DONE]\n\n'))
        controller.close()
      },
    })))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const reader = (await globalThis.fetch(CHAT, jsonInit())).body.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    check('strict streams content before the verdict', first.includes('tok0'), JSON.stringify(first))
    release()
    const tail = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      tail.push(new TextDecoder().decode(value))
    }
    check('the held terminator is released once the verdict passes', tail.join('').includes('[DONE]'), JSON.stringify(tail.join('')))
    check('a verified stream is recorded', hook.state().lastVerified?.provider === 'deepseek', JSON.stringify(hook.state().lastVerified ?? null))
    check('a verified stream blocks nothing', hook.counters.blocked === 0, JSON.stringify(hook.counters))
    hook.uninstall()
    stub.restore()
  }

  // 违规：内容照常流出去（这是拿回 TPS 的代价），但终止帧永远不到，响应体在裁决处报错。
  {
    const stub = stubFetch(() => frames(delta(0), routingFrame('alibaba'), 'data: [DONE]\n\n'))
    const logger = recorder()
    const hook = createFetchPin({}, logger)
    hook.install()
    const { text, error } = await drain(await globalThis.fetch(CHAT, jsonInit()))
    check('a foreign streamed channel still delivers the content frames', text.includes('tok0'), JSON.stringify(text))
    check('…but never the terminator', !text.includes('[DONE]'), JSON.stringify(text))
    check('…and the body fails instead of completing', error !== null && /渠道校验未通过/.test(error.message), String(error?.message))
    check('the streamed refusal names no retryable keyword', error !== null && !/rate|timeout|network|fetch|5\d\d/.test(error.message), String(error?.message))
    check('the streamed violation is counted', hook.counters.blocked === 1, JSON.stringify(hook.counters))
    check('the streamed violation names the provider', hook.state().lastViolation?.finalProvider === 'alibaba', JSON.stringify(hook.state().lastViolation ?? null).slice(0, 120))
    check('the streamed violation is logged as an error', logger.lines.error.some((line) => line.includes('拦下')), JSON.stringify(logger.lines.error))
    hook.uninstall()
    stub.restore()
  }

  // 没有 routing 元数据 = 不可证明 → 同样 fail closed，终止帧也不放行。
  {
    const stub = stubFetch(() => frames(delta(0), 'data: [DONE]\n\n'))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { text, error } = await drain(await globalThis.fetch(CHAT, jsonInit()))
    check('a streamed response with no routing metadata is refused', error !== null && /没有 gateway\.routing 元数据/.test(String(error?.detail)), String(error?.message))
    check('…and its terminator is withheld too', !text.includes('[DONE]'), JSON.stringify(text))
    hook.uninstall()
    stub.restore()
  }

  // warn 不扣终止帧、不中断，只记录 —— 于是 warn 也重获流式（旧实现里它同样缓冲）。
  {
    const stub = stubFetch(() => frames(delta(0), routingFrame('alibaba'), 'data: [DONE]\n\n'))
    const hook = createFetchPin({ enforcement: 'warn' }, recorder())
    hook.install()
    const { text, error } = await drain(await globalThis.fetch(CHAT, jsonInit()))
    check('warn streams a foreign response to the end', error === null && text.includes('tok0') && text.includes('[DONE]'), JSON.stringify(text))
    check('warn still counts and records it', hook.counters.blocked === 1 && hook.state().lastViolation?.finalProvider === 'alibaba')
    hook.uninstall()
    stub.restore()
  }

  // 上游中途坏掉（用户按停止、socket 断）不是渠道违规：错误原样传下去，不计数。
  {
    const stub = stubFetch(() => sse(new ReadableStream({
      start(controller) {
        controller.enqueue(enc(delta(0)))
        controller.error(new Error('socket broke'))
      },
    })))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { error } = await drain(await globalThis.fetch(CHAT, jsonInit()))
    check('an upstream stream failure is passed through', error !== null && error.message === 'socket broke', String(error?.message))
    check('…and is not counted as a violation', hook.counters.blocked === 0 && hook.state().lastViolation === null, JSON.stringify(hook.counters))
    hook.uninstall()
    stub.restore()
  }

  // warn 下同一个失败的流也不该被算成违规（判定只在流正常收尾时发生）。
  check('the frame splitter accepts LF blank lines', nextFrameEnd(enc('data: {}\n\nrest')) === 'data: {}\n\n'.length)
  check('the frame splitter accepts CRLF blank lines', nextFrameEnd(enc('data: {}\r\n\r\nrest')) === 'data: {}\r\n\r\n'.length)
  check('an incomplete frame yields -1', nextFrameEnd(enc('data: {}')) === -1)
  check('a terminator is recognised among other frames', isTerminatorFrame(enc('data: [DONE]\n\n')) && isTerminatorFrame(enc('data:[DONE]\n\n')))
  // 只认 `data:` 后最多一个空格 —— 多一格 openai 解码器就不认它是终止帧（它剥掉一个空格后
  // 看 startsWith('[DONE]')），会把这一帧丢给 JSON.parse 让整条流报错。扣帧范围要和消费者一致。
  check('…but only with the spacing the consumer accepts', !isTerminatorFrame(enc('data:  [DONE]\n\n')))
  check('the frame splitter accepts CR-only blank lines', nextFrameEnd(enc('data: {}\r\rrest')) === 'data: {}\r\r'.length)
  check('a terminator without a trailing blank line is still a terminator', isTerminatorFrame(enc('data: [DONE]')))
  // 裸 `data` 行也会被拼进负载（消费者一样），于是拼接结果以 `\n[DONE]` 开头 —— 这一帧对
  // 双方都不是终止帧。锁住这个方向，免得哪天「更严」悄悄变成「更松」。
  check('a bare `data` line before it makes it not a terminator', !isTerminatorFrame(enc('data\rdata: [DONE]\r\r')))
  check('content frames are never mistaken for a terminator', !isTerminatorFrame(enc('data: {"a":1}\n\n')))
}

// ── 14. the streamed gate, attacked ─────────────────────────────────────────
//
// 独立审查（2026-09-23，全新上下文的子代理）逐条攻过这个闸。下面是它真的攻破的那一处，
// 加上几处只能靠回归测试守住的边界：routing 藏在**被扣住**的终止帧里、取消被误记成违规、
// 块边界落在帧中间、上游不发空行就关流、对抗性的渠道名把错误文案带成「可重试」。
console.log('\n── 14. the streamed gate, attacked ───────────────────────')
{
  const enc = (text) => new TextEncoder().encode(text)
  const delta = (index) => `data: ${JSON.stringify({ choices: [{ delta: { content: `tok${index}` } }] })}\n\n`
  const routingFrame = (provider) => `data: ${gatewayBody(provider)}\n\n`
  const sse = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const wire = (parts) => new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === 'string' ? enc(part) : part)
      controller.close()
    },
  })
  /** 把一段字节按给定切点分块：模拟真实的块边界（会落在帧中间）。 */
  const sliced = (bytes, cuts) => {
    const parts = []
    let at = 0
    for (const cut of [...cuts, bytes.length]) {
      parts.push(bytes.slice(at, cut))
      at = cut
    }
    return parts
  }
  const join = (parts) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of parts) {
      out.set(part, at)
      at += part.length
    }
    return out
  }
  const same = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index])
  const text = (bytes) => new TextDecoder().decode(bytes)
  async function drainBytes(response) {
    const parts = []
    const reader = response.body.getReader()
    for (;;) {
      try {
        const { done, value } = await reader.read()
        if (done) return { bytes: join(parts), error: null }
        parts.push(value)
      } catch (error) {
        return { bytes: join(parts), error }
      }
    }
  }

  // 审查里唯一能造出「别家的工具真的执行了」的洞：只扫转发出去的帧，于是藏在**被扣住**
  // 的终止帧里的 routing 从未被读过，闸拿上一帧的旧结论（deepseek）替它背书。
  {
    const hidden = `data: [DONE]\ndata: ${gatewayBody('alibaba')}\n\n`
    const stub = stubFetch(() => sse(wire([delta(0), routingFrame('deepseek'), hidden])))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { bytes, error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('routing inside the held terminator frame is judged too', error !== null && /finalProvider=alibaba/.test(String(error?.detail)), `${String(error?.message ?? '').slice(0, 60)} | ${String(error?.detail ?? '')}`)
    check('…so a hidden channel blocks the call', hook.counters.blocked === 1, JSON.stringify(hook.counters))
    check('…and an earlier allowed routing does not excuse it', !text(bytes).includes('[DONE]'), JSON.stringify(text(bytes)).slice(-70))
    hook.uninstall()
    stub.restore()
  }

  // 反面：藏在终止帧里的 routing 是允许的 → 正常放行（别矫枉过正判成违规）。
  {
    const hidden = `data: [DONE]\ndata: ${gatewayBody('deepseek')}\n\n`
    const stub = stubFetch(() => sse(wire([delta(0), hidden])))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { bytes, error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('an allowed routing inside the terminator frame still passes', error === null && text(bytes).includes('[DONE]'), String(error?.message ?? ''))
    check('…and is recorded as verified', hook.state().lastVerified?.provider === 'deepseek', JSON.stringify(hook.state().lastVerified ?? null))
    hook.uninstall()
    stub.restore()
  }

  // 块边界落在帧中间：`data:` 中间、`[DONE]` 中间、以及最后一个字节单独一块。
  // 转发必须与线上字节逐字节相同（今天只做了 includes 检查）。
  {
    const raw = delta(0) + delta(1) + routingFrame('deepseek') + 'data: [DONE]\n\n'
    const bytes = enc(raw)
    const cuts = [1, raw.indexOf('data: [DONE]') + 3, raw.indexOf('[DONE]') + 3, bytes.length - 1]
    const stub = stubFetch(() => sse(wire(sliced(bytes, cuts))))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { bytes: got, error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('a frame split mid-`data:` is forwarded byte-for-byte', error === null && same(got, bytes), `${got.length}/${bytes.length} bytes, error=${String(error?.message ?? 'none')}`)
    hook.uninstall()
    stub.restore()
  }

  // CRLF 帧，且正好切在空行的 `\r` 与 `\n` 之间 —— 切帧只看字节，不能在这里劈错。
  {
    const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\r\n\r\n`
      + routingFrame('deepseek').replace(/\n/g, '\r\n')
      + 'data: [DONE]\r\n\r\n'
    const bytes = enc(raw)
    const blank = raw.indexOf('\r\n\r\n') + 3
    const stub = stubFetch(() => sse(wire(sliced(bytes, [blank]))))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { bytes: got, error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('a CRLF frame split between CR and LF stays byte-identical', error === null && same(got, bytes), `${got.length}/${bytes.length} bytes, error=${String(error?.message ?? 'none')}`)
    check('…and the CRLF terminator is recognised', hook.state().lastVerified?.provider === 'deepseek')
    hook.uninstall()
    stub.restore()
  }

  // 上游不发最后的空行就关流：剩下的那一帧照样要判（两个分支此前都没被覆盖过）。
  {
    const stub = stubFetch(() => sse(wire([delta(0), `data: ${gatewayBody('deepseek')}`])))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('a final frame with no blank line before EOF is still judged', error === null && hook.state().lastVerified?.provider === 'deepseek', `error=${String(error?.message ?? 'none')}`)
    hook.uninstall()
    stub.restore()
  }

  // 上游发完 [DONE] 却不关连接：不能等到它关流才放行终止帧（实测客户端会一直等到空闲
  // 超时）。第一帧 [DONE] 就是这次响应的结尾 —— 消费者也是这么认的。
  {
    let upstreamClosed = false
    const stub = stubFetch(() => sse(new ReadableStream({
      start(controller) {
        controller.enqueue(enc(delta(0)))
        controller.enqueue(enc(routingFrame('deepseek')))
        controller.enqueue(enc('data: [DONE]\n\n'))
        // 故意不 close：模拟「网关发完却不关连接」。
        void (async () => { await new Promise((resolve) => setTimeout(resolve, 5000)); upstreamClosed = true; controller.close() })()
      },
    })))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const started = Date.now()
    const { bytes, error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    const took = Date.now() - started
    check('the terminator is released without waiting for upstream EOF', error === null && text(bytes).includes('[DONE]') && took < 1000, `${took}ms, upstreamClosed=${upstreamClosed}, error=${String(error?.message ?? 'none')}`)
    check('…and the verdict was still reached', hook.state().lastVerified?.provider === 'deepseek')
    hook.uninstall()
    stub.restore()
  }

  // 两帧 [DONE]：第一帧就收尾（不再读第二帧），消费者照样拿到一个完整的终止帧。
  {
    const stub = stubFetch(() => sse(wire([delta(0), routingFrame('deepseek'), 'data: [DONE]\n\n', 'data: [DONE]\n\n'])))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { bytes, error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    const doneCount = (text(bytes).match(/\[DONE\]/g) ?? []).length
    check('a duplicated terminator yields exactly one [DONE] and nothing after it', error === null && doneCount === 1 && text(bytes).endsWith('data: [DONE]\n\n'), `count=${doneCount}, tail=${JSON.stringify(text(bytes)).slice(-40)}`)
    hook.uninstall()
    stub.restore()
  }

  // 声明了 SSE 却没有 body：没法边流边判 → 退回缓冲路径失败关闭（400），而不是抛异常。
  {
    const stub = stubFetch(() => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const response = await globalThis.fetch(CHAT, jsonInit())
    check('an SSE response with no body fails closed with 400', response.status === 400 && /PROVIDER_PIN_VIOLATION/.test(await response.text()), `HTTP ${response.status}`)
    hook.uninstall()
    stub.restore()
  }

  // 取消（用户按停止）：裁决没发生 —— 记 unverified，**绝不能**算成违规。
  {
    const controller = new AbortController()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const stub = stubFetch(() => sse(new ReadableStream({
      async start(stream) {
        stream.enqueue(enc(delta(0)))
        await gate
        stream.error(new DOMException('aborted', 'AbortError'))
      },
    })))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const pending = drainBytes(await globalThis.fetch(CHAT, { ...jsonInit(), signal: controller.signal }))
    controller.abort()
    release()
    const { error } = await pending
    check('an aborted stream is not counted as a violation', hook.counters.blocked === 0 && hook.counters.unverified === 1, JSON.stringify(hook.counters))
    check('…and is recorded as unverified, with why', hook.state().lastUnverified?.reason === 'aborted', JSON.stringify(hook.state().lastUnverified ?? null).slice(0, 130))
    check('…while the abort still reaches the caller', error !== null, String(error?.message))
    hook.uninstall()
    stub.restore()
  }

  // 消费者自己取消（dsh 中止 / break）：同样不是违规，也不能在取消后补一次裁决。
  {
    const stub = stubFetch(() => sse(new ReadableStream({
      start(stream) {
        stream.enqueue(enc(delta(0)))
      },
    })))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const reader = (await globalThis.fetch(CHAT, jsonInit())).body.getReader()
    await reader.read()
    await reader.cancel('user stopped')
    await new Promise((resolve) => setTimeout(resolve, 10))
    check('a consumer cancel is not a violation either', hook.counters.blocked === 0 && hook.counters.unverified === 1, JSON.stringify(hook.counters))
    check('…and never invents a verdict', hook.state().lastVerified === null && hook.state().lastViolation === null)
    hook.uninstall()
    stub.restore()
  }

  // 伪造的 routing 盖在真 routing **之后**：只信「最后一处」就等于把判决交给被审的一方 ——
  // 服务这次请求的渠道控制着自己那部分帧，可以自称 deepseek 把真话盖掉。
  {
    const stub = stubFetch(() => sse(wire([delta(0), routingFrame('alibaba'), routingFrame('deepseek'), 'data: [DONE]\n\n'])))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { bytes, error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('a forged allowed routing cannot override a real foreign one', error !== null && hook.counters.blocked === 1, `blocked=${hook.counters.blocked}, detail=${String(error?.detail ?? 'none')}`)
    check('…and its terminator is withheld', !text(bytes).includes('[DONE]'), JSON.stringify(text(bytes)).slice(-60))
    hook.uninstall()
    stub.restore()
  }

  // CR 单独作行分隔符（SSE 规范允许，消费者也认）：终止帧判定与 routing 提取都要跟上，
  // 否则「我们以为转发了、它以为结束了」，或反过来漏读元数据。
  {
    check('a CR-separated terminator is recognised', isTerminatorFrame(enc('x\rdata: [DONE]\r\r')))
    check('a CR-separated routing frame is read', routingOfText(`data: ${gatewayBody('deepseek')}\r\r`)?.finalProvider === 'deepseek')
    const stub = stubFetch(() => sse(wire([delta(0), `data: ${gatewayBody('alibaba')}\r\r`, 'data: [DONE]\r\r'])))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { bytes, error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('a CR-separated violation withholds its terminator too', error !== null && !text(bytes).includes('[DONE]'), `blocked=${hook.counters.blocked}, detail=${String(error?.detail ?? 'none')}`)
    hook.uninstall()
    stub.restore()
  }

  // 状态文件里记的必须是**被拒的那一处** routing：伪造者把一个自称「由允许渠道提供」的
  // routing 放在最后，不能连「谁服务了这次请求」这个诊断也一起改掉。
  {
    const stub = stubFetch(() => sse(wire([delta(0), routingFrame('alibaba'), routingFrame('deepseek'), 'data: [DONE]\n\n'])))
    const hook = createFetchPin({}, recorder())
    hook.install()
    await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('the recorded culprit is the rejected routing, not the last one', hook.state().lastViolation?.finalProvider === 'alibaba', JSON.stringify(hook.state().lastViolation ?? null).slice(0, 110))
    hook.uninstall()
    stub.restore()
  }

  // 缓冲（非 SSE）路径同样逐处判，并记下被拒的那一处。
  {
    const wireText = `data: ${gatewayBody('alibaba')}\n\ndata: ${gatewayBody('deepseek')}\n\n`
    const stub = stubFetch(() => new Response(wireText, { status: 200, headers: { 'content-type': 'application/json' } }))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const response = await globalThis.fetch(CHAT, jsonInit())
    const body = await response.text()
    check('the buffered path judges every routing too', response.status === 400 && /PROVIDER_PIN_VIOLATION/.test(body), `HTTP ${response.status}`)
    check('…and records the rejected one', hook.state().lastViolation?.finalProvider === 'alibaba', JSON.stringify(hook.state().lastViolation ?? null).slice(0, 110))
    check('…while its 400 body carries no gateway-supplied slug', !/alibaba/.test(JSON.parse(body).error.message) && JSON.parse(body).error.allowed.join() === 'deepseek', body.slice(0, 120))
    hook.uninstall()
    stub.restore()
  }

  // 一个 JSON 被拆到两行 `data:`：消费者拼接后能解析，插件也必须解析 —— 否则那一处 foreign
  // routing 根本不会被看到（复审用真实适配器把整条路径跑通过）。
  {
    const full = gatewayBody('alibaba')
    const cut = full.indexOf(',') + 1
    const splitFrame = `data: ${full.slice(0, cut)}\ndata: ${full.slice(cut)}\n\n`
    const stub = stubFetch(() => sse(wire([delta(0), routingFrame('deepseek'), splitFrame, 'data: [DONE]\n\n'])))
    const hook = createFetchPin({}, recorder())
    hook.install()
    const { bytes, error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('a routing split across two data: lines is judged', error !== null && hook.counters.blocked === 1, `blocked=${hook.counters.blocked}, detail=${String(error?.detail ?? 'none')}`)
    check('…and its terminator is withheld', !text(bytes).includes('[DONE]'))
    hook.uninstall()
    stub.restore()
  }

  // 终止帧一到就收尾 —— 上游 body 该被放掉，别让 socket 挂着。
  {
    let cancelled = false
    const stub = stubFetch(() => sse(new ReadableStream({
      start(controller) {
        controller.enqueue(enc(delta(0)))
        controller.enqueue(enc(routingFrame('deepseek')))
        controller.enqueue(enc('data: [DONE]\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })))
    const hook = createFetchPin({}, recorder())
    hook.install()
    await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
    check('the upstream body is released once the verdict is in', cancelled)
    hook.uninstall()
    stub.restore()
  }

  // dsh 会在错误文案上跑好几套判定（重试分类、上下文溢出 → **会话压缩**、配额），而渠道名
  // 来自网关。所以拒绝文案必须**与网关输入无关**：换任何渠道名，文案都要逐字相同。
  // 这里不去镜像那几套正则（镜像必然滞后，第一版就是这么漏的），直接钉住「不插值」。
  {
    const messages = new Map()
    for (const slug of ['alibaba', 'channel-500', 'context_length_exceeded', 'insufficient-balance', 'rate_limit']) {
      const stub = stubFetch(() => sse(wire([delta(0), routingFrame(slug)])))
      const hook = createFetchPin({}, recorder())
      hook.install()
      const { error } = await drainBytes(await globalThis.fetch(CHAT, jsonInit()))
      messages.set(slug, { message: error?.message ?? '', detail: error?.detail ?? '', recorded: hook.state().lastViolation?.finalProvider ?? null })
      hook.uninstall()
      stub.restore()
    }
    const all = [...messages.values()].map((entry) => entry.message)
    const first = all[0]
    check('the refusal message does not depend on the channel name at all', all.every((message) => message === first), `${new Set(all).size} distinct messages`)
    check('…so no channel name can steer any classifier reading it', all.every((message) => !/alibaba|channel-500|context_length_exceeded|insufficient-balance|rate_limit/.test(message)), first.slice(0, 80))
    check('…while the culprit still reaches the diagnostic channels', [...messages.entries()].every(([slug, entry]) => entry.detail.includes(slug) && entry.recorded === slug), JSON.stringify([...messages.entries()].map(([slug, entry]) => [slug, entry.recorded])).slice(0, 140))
  }
}

console.log(`\nRESULT: ${failures.length === 0 ? 'FETCH OK' : `FAILED (${failures.join(' | ')})`}`)
process.exit(failures.length === 0 ? 0 : 2)
