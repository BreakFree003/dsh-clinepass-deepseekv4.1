/**
 * Tests for the usage half of dsh-clinepass: the response normaliser, the
 * gateway read, the `/api` Fetch-route handler (caching, dedupe, failure
 * classification) and the wiring `apply` performs for the Settings → Models
 * card.
 *
 * No dsh process, no network and no React: a stub `fetch` stands in for the
 * gateway and a stub credential provider for `ctx.credentials`. The one thing
 * that *is* real is the `Request`/`Response` pair the route handler speaks —
 * that is the boundary dsh's own bridge crosses, so faking it would test
 * nothing.
 *
 * Run: node test-usage.mjs
 */
import fs from 'node:fs'
import { createUsageHandler, fetchUsage, installUsageRoute, normalizeUsage, USAGE_BOOT_GLOBAL, USAGE_PATH, USAGE_ROUTE, USAGE_WINDOWS, withDefaults } from './index.js'

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

const KEY = 'sk_test_key_do_not_leak_0123456789abcdef'

/** The payload the live gateway actually answers with (captured 2026-09-16). */
const LIVE_PAYLOAD = {
  data: {
    limits: [
      { type: 'five_hour', percentUsed: 1, resetsAt: '2026-09-16T11:38:00.490486029Z' },
      { type: 'weekly', percentUsed: 81, resetsAt: '2026-09-21T08:59:44.492448409Z' },
      { type: 'monthly', percentUsed: 91, resetsAt: '2026-09-29T08:04:36.494436849Z' },
    ],
  },
  success: true,
}

/**
 * A gateway double. `responder(url, init)` returns a `Response`; `calls`
 * records every request so headers, method and URL can be asserted exactly.
 */
function gateway(responder) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init, authorization: init?.headers?.Authorization ?? init?.headers?.authorization })
    return responder(url, init, calls.length)
  }
  return { calls, fetch }
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A credential provider double; `undefined` value means "nothing stored". */
const credentialsFor = (value) => ({
  resolve: async (ref) => (value === undefined ? undefined : { value, source: 'file', ref }),
})

const usageRequest = (query = '') => new Request(`http://127.0.0.1:3080${USAGE_ROUTE}${query}`)

// ── 1. the response normaliser ──────────────────────────────────────────────
console.log('\n── 1. normalizeUsage ─────────────────────────────────────')
{
  const live = normalizeUsage(LIVE_PAYLOAD)
  check('the live payload normalises', live.ok === true, JSON.stringify(live))
  check('…to the three windows in card order', live.limits.map((l) => l.type).join(',') === USAGE_WINDOWS.join(','), JSON.stringify(live.limits.map((l) => l.type)))
  // The host keeps the wire field exactly as the gateway named it; turning it
  // into "remaining" is a presentation decision owned by the browser half.
  check('percentUsed is carried through as used, not pre-flipped to remaining', live.limits[1].percentUsed === 81, String(live.limits[1].percentUsed))
  check(
    'nanosecond resetsAt is normalised to millisecond ISO',
    live.limits[0].resetsAt === '2026-09-16T11:38:00.490Z',
    String(live.limits[0].resetsAt),
  )

  const clamped = normalizeUsage({
    success: true,
    data: { limits: [{ type: 'five_hour', percentUsed: 150 }, { type: 'weekly', percentUsed: -3 }, { type: 'monthly', percentUsed: 42.5 }] },
  })
  check('percentUsed is clamped to 0…100', clamped.limits.map((l) => l.percentUsed).join(',') === '100,0,42.5', JSON.stringify(clamped.limits.map((l) => l.percentUsed)))
  check('a missing resetsAt becomes null', clamped.limits[0].resetsAt === null, String(clamped.limits[0].resetsAt))

  const odd = normalizeUsage({
    success: true,
    data: {
      limits: [
        { type: 'experimental_pool', percentUsed: 9 },
        { type: 'five_hour', percentUsed: 10, resetsAt: 'not a date' },
        { type: 'weekly', percentUsed: '34' },
        { type: 'monthly', percentUsed: Number.NaN },
      ],
    },
  })
  check('an unknown window type is skipped', odd.limits.every((l) => l.type !== 'experimental_pool'), JSON.stringify(odd.limits))
  check('a string percentUsed is refused, not coerced', odd.limits.every((l) => l.type !== 'weekly'), JSON.stringify(odd.limits))
  check('a non-finite percentUsed is refused', odd.limits.every((l) => l.type !== 'monthly'), JSON.stringify(odd.limits))
  check('an unreadable resetsAt degrades to null, not a bad date', odd.limits[0].resetsAt === null, String(odd.limits[0].resetsAt))

  check('success must be exactly true', normalizeUsage({ success: 'true', data: { limits: [] } }).ok === false)
  check('a missing limits array is refused', normalizeUsage({ success: true, data: {} }).ok === false)
  check('a non-array limits is refused', normalizeUsage({ success: true, data: { limits: 'x' } }).ok === false)
  check('a non-object payload is refused', normalizeUsage(null).ok === false && normalizeUsage('{}').ok === false)
  const empty = normalizeUsage({ success: true, data: { limits: [] } })
  check('no windows at all is a valid, empty answer', empty.ok === true && empty.limits.length === 0, JSON.stringify(empty))
}

// ── 2. the gateway read ─────────────────────────────────────────────────────
console.log('\n── 2. fetchUsage ─────────────────────────────────────────')
{
  const cfg = withDefaults({})
  const ok = gateway(() => jsonResponse(LIVE_PAYLOAD))
  const result = await fetchUsage(cfg, KEY, { fetch: ok.fetch })
  check('the live payload is read end to end', result.ok === true && result.limits.length === 3, JSON.stringify(result))
  check('the URL is the endpoint CodexBar pins', ok.calls[0].url === `https://api.cline.bot${USAGE_PATH}`, ok.calls[0].url)
  check('…with GET', ok.calls[0].init.method === 'GET', String(ok.calls[0].init.method))
  check('…with a bearer authorization', ok.calls[0].authorization === `Bearer ${KEY}`, String(ok.calls[0].authorization))
  check('…and an Accept header', ok.calls[0].init.headers.Accept === 'application/json', String(ok.calls[0].init.headers.Accept))
  check('…and an abort signal (the timeout)', ok.calls[0].init.signal !== undefined)

  const custom = withDefaults({ upstream: 'https://proxy.test' })
  const viaProxy = gateway(() => jsonResponse(LIVE_PAYLOAD))
  await fetchUsage(custom, KEY, { fetch: viaProxy.fetch })
  check('a configured upstream is honoured', viaProxy.calls[0].url === `https://proxy.test${USAGE_PATH}`, viaProxy.calls[0].url)

  const cases = [
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate-limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [418, 'http'],
  ]
  for (const [status, reason] of cases) {
    const g = gateway(() => jsonResponse({ error: 'nope' }, status))
    const out = await fetchUsage(cfg, KEY, { fetch: g.fetch })
    check(`HTTP ${status} is classified as ${reason}`, out.ok === false && out.reason === reason, JSON.stringify(out))
  }

  const notJson = gateway(() => new Response('<html>gateway</html>', { status: 200 }))
  check('a non-JSON 200 is a parse failure', (await fetchUsage(cfg, KEY, { fetch: notJson.fetch })).reason === 'parse')

  const wrongShape = gateway(() => jsonResponse({ success: false }))
  check('a well-formed but unsuccessful body is a parse failure', (await fetchUsage(cfg, KEY, { fetch: wrongShape.fetch })).reason === 'parse')

  const thrown = gateway(() => {
    throw new TypeError('fetch failed')
  })
  check('a thrown fetch is a network failure, not an exception', (await fetchUsage(cfg, KEY, { fetch: thrown.fetch })).reason === 'network')

  const aborted = gateway(() => {
    const error = new Error('timed out')
    error.name = 'TimeoutError'
    throw error
  })
  check('a timeout is its own reason', (await fetchUsage(cfg, KEY, { fetch: aborted.fetch })).reason === 'timeout')

  // The whole point of fetching on the host side: the key must not travel back.
  const everyPath = []
  for (const [status, body] of [[200, LIVE_PAYLOAD], [401, {}], [500, {}]]) {
    const g = gateway(() => jsonResponse(body, status))
    everyPath.push(JSON.stringify(await fetchUsage(cfg, KEY, { fetch: g.fetch })))
  }
  check('the key never appears in any result', everyPath.every((text) => !text.includes(KEY)))
}

// ── 3. the route handler ────────────────────────────────────────────────────
console.log('\n── 3. createUsageHandler ─────────────────────────────────')
{
  const cfg = withDefaults({})
  // Every handler below is handed the gateway double through the handler's own
  // `fetch` option, so this test never touches the network.
  const withGateway = (g, config = cfg) => createUsageHandler({ credentials: credentialsFor(KEY) }, config, quiet, { fetch: g.fetch })

  const noKey = gateway(() => jsonResponse(LIVE_PAYLOAD))
  const withoutKey = createUsageHandler({ credentials: credentialsFor(undefined) }, cfg, quiet, { fetch: noKey.fetch })
  const first = await withoutKey(usageRequest())
  const firstBody = await first.json()
  check('no stored credential is reported as such', firstBody.ok === false && firstBody.reason === 'no-key', JSON.stringify(firstBody))
  check('…and the gateway is not called at all', noKey.calls.length === 0)

  const noStore = createUsageHandler({}, cfg, quiet)
  const noStoreBody = await (await noStore(usageRequest())).json()
  check('a missing credential service is reported, not thrown', noStoreBody.reason === 'no-credentials', JSON.stringify(noStoreBody))

  const g = gateway(() => jsonResponse(LIVE_PAYLOAD))
  const response = await withGateway(g)(usageRequest())
  check('a successful read answers 200', response.status === 200, String(response.status))
  check('…as JSON', String(response.headers.get('content-type')).startsWith('application/json'), String(response.headers.get('content-type')))
  check('…that must not be cached by the browser', response.headers.get('cache-control') === 'no-store', String(response.headers.get('cache-control')))
  const body = await response.json()
  check('…carrying the limits and a fetch time', body.ok === true && body.limits.length === 3 && typeof body.fetchedAt === 'string', JSON.stringify(body))
  check('…and never the key', !JSON.stringify(body).includes(KEY))
  check('…and the authorization header is the only place the key went', g.calls[0].authorization === `Bearer ${KEY}`)

  // Caching: the page re-renders the card often; the gateway must not see that.
  const cached = gateway(() => jsonResponse(LIVE_PAYLOAD))
  const caching = withGateway(cached)
  await caching(usageRequest())
  await caching(usageRequest())
  await caching(usageRequest())
  check('a successful read is cached', cached.calls.length === 1, `calls=${cached.calls.length}`)

  const forced = gateway(() => jsonResponse(LIVE_PAYLOAD))
  const forcing = withGateway(forced)
  await forcing(usageRequest())
  await forcing(usageRequest('?refresh=1'))
  check('?refresh=1 bypasses the cache', forced.calls.length === 2, `calls=${forced.calls.length}`)

  const cacheOff = gateway(() => jsonResponse(LIVE_PAYLOAD))
  const uncached = withGateway(cacheOff, withDefaults({ usageCacheMs: 0 }))
  await uncached(usageRequest())
  await uncached(usageRequest())
  check('usageCacheMs: 0 means always refetch', cacheOff.calls.length === 2, `calls=${cacheOff.calls.length}`)

  // The success window must actually *expire*, and it must be the configured
  // value: asserting only "3 calls -> 1" passes for any window whatsoever, so a
  // regression that pinned it to 60 minutes would ship green. `Date.now` is the
  // handler's only clock, so stepping it is enough.
  const realNow = Date.now
  const expiring = gateway(() => jsonResponse(LIVE_PAYLOAD))
  const expiringHandler = withGateway(expiring, withDefaults({ usageCacheMs: 1000 }))
  await expiringHandler(usageRequest())
  await expiringHandler(usageRequest())
  check('a success inside usageCacheMs is served from the cache', expiring.calls.length === 1, `calls=${expiring.calls.length}`)
  Date.now = () => realNow() + 1500
  await expiringHandler(usageRequest())
  Date.now = realNow
  check('…and refetched once the window has passed', expiring.calls.length === 2, `calls=${expiring.calls.length}`)

  // A failure is remembered too, but only for the short negative window: that is
  // what stops a user flipping between settings panes from re-hitting a gateway
  // that is down, without hiding a freshly fixed key for a whole minute.
  const failing = gateway(() => jsonResponse({}, 500))
  const brieflyRemembered = withGateway(failing)
  await brieflyRemembered(usageRequest())
  await brieflyRemembered(usageRequest())
  check('a failure is not re-read on every pane flip', failing.calls.length === 1, `calls=${failing.calls.length}`)
  await brieflyRemembered(usageRequest('?refresh=1'))
  check('…but the refresh button still bypasses it', failing.calls.length === 2, `calls=${failing.calls.length}`)
  Date.now = () => realNow() + 6000
  await brieflyRemembered(usageRequest())
  Date.now = realNow
  check('…and it expires, so a fixed key is never hidden for long', failing.calls.length === 3, `calls=${failing.calls.length}`)

  // A burst (card mount plus a refresh click) must not become a burst of calls.
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const concurrent = gateway(async () => {
    await gate
    return jsonResponse(LIVE_PAYLOAD)
  })
  const deduped = withGateway(concurrent)
  const burst = Promise.all([deduped(usageRequest()), deduped(usageRequest()), deduped(usageRequest())])
  release()
  const burstBodies = await Promise.all((await burst).map((item) => item.json()))
  check('concurrent reads are deduplicated to one gateway call', concurrent.calls.length === 1, `calls=${concurrent.calls.length}`)
  check('…and every caller still gets the answer', burstBodies.every((item) => item.ok === true && item.limits.length === 3))

  const exploding = {
    credentials: {
      resolve: async () => {
        throw new Error('credential store exploded')
      },
    },
  }
  const log = recorder()
  const crash = createUsageHandler(exploding, cfg, log)
  const crashResponse = await crash(usageRequest())
  const crashBody = await crashResponse.json()
  check('an unexpected throw answers 500 rather than rejecting', crashResponse.status === 500 && crashBody.reason === 'internal', JSON.stringify(crashBody))
  check('…and is reported to the log', log.lines.warn.length === 1, JSON.stringify(log.lines.warn))
}

// ── 4. route registration ───────────────────────────────────────────────────
console.log('\n── 4. installUsageRoute ──────────────────────────────────')
{
  const cfg = withDefaults({})
  const registered = []
  const routeCtx = {
    credentials: credentialsFor(KEY),
    connection: { fetch: { register: (route) => registered.push(route) } },
  }
  const outcome = installUsageRoute(routeCtx, cfg, quiet)
  check('registration reports success', outcome === 'installed', outcome)
  check('exactly one route is registered', registered.length === 1, String(registered.length))
  check('…at the configured path', registered[0].path === USAGE_ROUTE, registered[0].path)
  check('…for GET only', registered[0].methods.join(',') === 'GET', registered[0].methods.join(','))
  check('…with a buffered body mode', registered[0].requestBody === 'buffered', registered[0].requestBody)
  check('…and a handler dsh can call', typeof registered[0].fetch === 'function')

  const custom = withDefaults({ usageRoute: '/api/other.usage' })
  const customRoutes = []
  installUsageRoute({ connection: { fetch: { register: (route) => customRoutes.push(route) } } }, custom, quiet)
  check('a configured usageRoute is used as given', customRoutes[0].path === '/api/other.usage', customRoutes[0].path)

  const noRegistry = recorder()
  check('a ctx without connection fails without throwing', installUsageRoute({}, cfg, noRegistry) === 'failed')
  check('…and says so', noRegistry.lines.warn.some((line) => line.includes('connection.fetch')), JSON.stringify(noRegistry.lines.warn))

  const log = recorder()
  const throwing = {
    connection: {
      fetch: {
        register: () => {
          throw new Error('duplicate route')
        },
      },
    },
  }
  check('a throwing registry is reported, not propagated', installUsageRoute(throwing, cfg, log) === 'failed')
  check('…with the reason', log.lines.warn.some((line) => line.includes('duplicate route')), JSON.stringify(log.lines.warn))
}

// ── 5. what apply mounts ────────────────────────────────────────────────────
console.log('\n── 5. apply wiring ───────────────────────────────────────')
{
  const { apply } = await import('./index.js')

  /**
   * A host context double that records injections and calls them back.
   *
   * Index-injection listeners are *collected*, not fired at subscription time:
   * the real event is emitted when the web server renders a page, long after
   * boot. Firing it synchronously would evaluate the announcement before the
   * route had been mounted — exactly the boot-order hazard it must survive.
   */
  function hostCtx() {
    const injected = []
    const routes = []
    const listeners = []
    const listen = (event, listener) => {
      // The plugin also listens for `system-prompt/assemble` (the pre-existing
      // route-prefix rewrite); only the index-injection seat matters here.
      if (event === 'webserver/index-inject') listeners.push(listener)
    }
    const child = {
      credentials: credentialsFor(KEY),
      connection: { fetch: { register: (route) => routes.push(route) } },
      on: listen,
    }
    const ctx = {
      logger: quiet,
      inject: (deps, callback) => {
        injected.push(deps)
        callback(child)
      },
      get: () => undefined,
      on: listen,
      effect: () => {},
    }
    /** Render a page, as the web server would. */
    const emit = () => {
      const globals = []
      for (const listener of listeners) listener(globals)
      return globals
    }
    return { ctx, injected, routes, listeners, emit }
  }

  const on = hostCtx()
  await apply(on.ctx, { provision: false })
  check('apply asks for the services the card needs', on.injected.length === 1 && on.injected[0].join(',') === 'connection,credentials', JSON.stringify(on.injected))
  check('…registers the usage route', on.routes.length === 1 && on.routes[0].path === USAGE_ROUTE, JSON.stringify(on.routes.map((r) => r.path)))
  const onGlobals = on.emit()
  check(
    '…and announces the route to the browser half',
    onGlobals.length === 1 && onGlobals[0].name === USAGE_BOOT_GLOBAL && onGlobals[0].value.usageRoute === USAGE_ROUTE,
    JSON.stringify(onGlobals),
  )
  check('…as a global index row', onGlobals[0].kind === 'global', onGlobals[0].kind)
  check('…whose value is JSON-serializable (the row contract)', JSON.parse(JSON.stringify(onGlobals[0].value)).usageRoute === USAGE_ROUTE)
  check('…marked enabled', onGlobals[0].value.enabled === true, JSON.stringify(onGlobals[0].value))

  // The `usage: false` contract. The browser half is discovered from
  // package.json and is therefore loaded whatever this option says, so skipping
  // the route leaves the card mounted and fetching a path nobody serves; it then
  // reports "could not reach the gateway" forever, and the option's documented
  // purpose ("the card is not mounted at all") is a lie. The host must say so.
  const off = hostCtx()
  await apply(off.ctx, { provision: false, usage: false })
  check('usage: false mounts no route', off.injected.length === 0 && off.routes.length === 0, JSON.stringify({ injected: off.injected, routes: off.routes.length }))
  check('…but still announces, so the card can hide itself', off.listeners.length === 1, `listeners=${off.listeners.length}`)
  const offGlobals = off.emit()
  check('…saying it is disabled', offGlobals.length === 1 && offGlobals[0].value.enabled === false, JSON.stringify(offGlobals))
  check('…with no route to call', offGlobals[0].value.usageRoute === null, JSON.stringify(offGlobals[0].value))

  // A route that failed to register must not be advertised: the browser would
  // otherwise be sent to a path nobody serves.
  const broken = hostCtx()
  broken.ctx.inject = (deps, callback) => {
    callback({
      credentials: credentialsFor(KEY),
      connection: {
        fetch: {
          register: () => {
            throw new Error('duplicate route')
          },
        },
      },
      on: () => {},
    })
  }
  await apply(broken.ctx, { provision: false })
  const brokenGlobals = broken.emit()
  check(
    'a failed registration is not advertised as usable',
    brokenGlobals[0].value.enabled === false && brokenGlobals[0].value.usageRoute === null,
    JSON.stringify(brokenGlobals),
  )

  const custom = hostCtx()
  await apply(custom.ctx, { provision: false, usageRoute: '/api/custom.usage' })
  const customGlobals = custom.emit()
  check('a custom route reaches both the route table and the browser', custom.routes[0].path === '/api/custom.usage' && customGlobals[0].value.usageRoute === '/api/custom.usage')

  const legacy = hostCtx()
  legacy.ctx.inject = undefined
  const legacyLog = recorder()
  legacy.ctx.logger = legacyLog
  await apply(legacy.ctx, { provision: false })
  check('a context without ctx.inject degrades with a warning, not a throw', legacyLog.lines.warn.some((line) => line.includes('cannot inject services')), JSON.stringify(legacyLog.lines.warn))
}

// ── 6. the option surface ───────────────────────────────────────────────────
console.log('\n── 6. usage options ──────────────────────────────────────')
{
  const cfg = withDefaults({})
  check('usage is on by default', cfg.usage === true)
  check('the default route is the documented one', cfg.usageRoute === USAGE_ROUTE, cfg.usageRoute)
  check('the default timeout is 15 s', cfg.usageTimeoutMs === 15000, String(cfg.usageTimeoutMs))
  check('the default cache is 60 s', cfg.usageCacheMs === 60000, String(cfg.usageCacheMs))
  check('usage: false is respected', withDefaults({ usage: false }).usage === false)
  check('cache 0 is accepted, not treated as unset', withDefaults({ usageCacheMs: 0 }).usageCacheMs === 0, String(withDefaults({ usageCacheMs: 0 }).usageCacheMs))
  check('cache -1 falls back', withDefaults({ usageCacheMs: -1 }).usageCacheMs === 60000)
  check('a non-numeric timeout falls back', withDefaults({ usageTimeoutMs: 'soon' }).usageTimeoutMs === 15000)
  check('a blank usageRoute falls back', withDefaults({ usageRoute: '' }).usageRoute === USAGE_ROUTE)
}

// ── 7. the browser half's contract ──────────────────────────────────────────
console.log('\n── 7. client bundle contract ─────────────────────────────')
{
  const manifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const source = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')

  check('package.json exports the client bundle', manifest.exports['./client'] === './client.js', String(manifest.exports['./client']))
  check('…and ships it', manifest.files.includes('client.js'))
  check('…and declares it as a web client half', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client))
  check('the bundle registers under the package name', source.includes("id: 'dsh-clinepass'"), 'module id')
  check('…with the loader facade', source.includes('__ModuleLoader__.load'))
  check('…exporting inject and apply', source.includes('exports.inject = inject') && source.includes('exports.apply = apply'))
  check('…depending only on the slots and locale services', source.includes("var inject = ['slots', 'locale']"), 'inject')
  check('…and on React from the shell baseline', source.includes("require('react')"))
  check('…registering the Models provider-card seat keyed by llm-pi-ai', source.includes("'settings.models.provider-card'") && source.includes("key: SETTINGS_NS") && source.includes("var SETTINGS_NS = 'llm-pi-ai'"))
  check('…filtering to this plugin’s own route', source.includes("var PROVIDER = 'cline-pass'") && source.includes('entry.provider === PROVIDER'))
  check('the browser half carries no credential', !/CLINE_PASS_API_KEY/.test(source) && !/sk_/.test(source))

  // The regression this check exists for: `ctx.locale` threw
  // `cannot get property "locale" without inject` in the live shell, because
  // cordis refuses an *undeclared* service property instead of returning
  // undefined. The render test below could never catch it — that guard lives in
  // the real context proxy, not in a stub — so the declaration is checked here,
  // statically, against every service the bundle actually touches.
  const declared = new Set(
    (/var inject = \[([^\]]*)\]/.exec(source)?.[1] ?? '')
      .split(',')
      .map((name) => name.trim().replace(/^'|'$/g, ''))
      .filter(Boolean),
  )
  // Context members that are not services: the event bus, lifecycle and helpers.
  const NOT_SERVICES = new Set(['on', 'off', 'once', 'emit', 'parallel', 'waterfall', 'bail', 'serial', 'effect', 'inject', 'provide', 'get', 'set', 'scope', 'logger', 'start', 'stop', 'dispose'])
  // Comments discuss `ctx.connection.fetch.register` and friends; scanning them
  // would invent services the code never touches. `[^:]//` keeps `https://` intact.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const touched = new Set([...code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]))
  const undeclared = [...touched].filter((name) => !NOT_SERVICES.has(name) && !declared.has(name))
  check(
    'every service the bundle touches is declared in inject',
    undeclared.length === 0,
    `touched=${[...touched].join(',')} declared=${[...declared].join(',')} undeclared=${undeclared.join(',')}`,
  )
  check('…including locale', declared.has('locale'), [...declared].join(','))
}

// ── 8. the browser half, actually rendered ──────────────────────────────────
// The card is the one part of this plugin that no `node:test`-style assertion
// reaches by reading source, so this section *runs* `client.js` and renders it.
// React is not a dependency of this package and must not become one, so the
// runtime below is a ~60-line stand-in implementing exactly the six hooks the
// bundle uses. It is not a React conformance test — it is a test that this
// bundle's own render path produces the right text for the right inputs.
console.log('\n── 8. client render ──────────────────────────────────────')
{
  const sameDeps = (a, b) => {
    if (a === undefined || b === undefined) return a === b
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  }

  /** A minimal React runtime: components as plain functions, hooks as slots. */
  function reactRuntime() {
    const hooks = []
    let cursor = 0
    let pending = false
    let effects = []
    /** Live effect cleanups by hook index — so an unmount can actually run them. */
    const cleanups = new Map()
    let cleanupsToRun = []
    const runtime = {
      createElement(type, props, ...children) {
        const flat = []
        const push = (child) => {
          if (Array.isArray(child)) child.forEach(push)
          else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
        }
        children.forEach(push)
        return { type, props: props ?? {}, children: flat }
      },
      useState(initial) {
        const at = cursor++
        if (!(at in hooks)) hooks[at] = { value: typeof initial === 'function' ? initial() : initial }
        const slot = hooks[at]
        return [
          slot.value,
          (next) => {
            slot.value = typeof next === 'function' ? next(slot.value) : next
            pending = true
          },
        ]
      },
      useRef(initial) {
        const at = cursor++
        if (!(at in hooks)) hooks[at] = { value: { current: initial } }
        return hooks[at].value
      },
      useCallback(fn, deps) {
        const at = cursor++
        const slot = hooks[at]
        if (slot === undefined || !sameDeps(slot.deps, deps)) hooks[at] = { value: fn, deps }
        return hooks[at].value
      },
      useEffect(fn, deps) {
        const at = cursor++
        const slot = hooks[at]
        if (slot === undefined || !sameDeps(slot.deps, deps)) {
          // React runs the *previous* cleanup before the new effect, never
          // straight after the old one; queue it for the commit step.
          const previous = cleanups.get(at)
          if (typeof previous === 'function') cleanupsToRun.push(previous)
          hooks[at] = { deps }
          effects.push({ at, fn })
        }
      },
      useSyncExternalStore(_subscribe, getSnapshot) {
        return getSnapshot()
      },
    }
    return {
      runtime,
      begin() {
        cursor = 0
        effects = []
        cleanupsToRun = []
        pending = false
      },
      /** The commit step: pending cleanups first, then the new effects. */
      takeCommit() {
        const commit = { cleanups: cleanupsToRun, effects }
        cleanupsToRun = []
        effects = []
        return commit
      },
      setCleanup(at, fn) {
        cleanups.set(at, fn)
      },
      /** How many intervals this mount currently has live. */
      intervalCount() {
        return globalThis.window.__TIMERS__.ids.size
      },
      /** Unmount: run every live cleanup, as React would. */
      unmount() {
        for (const fn of cleanups.values()) {
          if (typeof fn === 'function') fn()
        }
        cleanups.clear()
      },
      get pending() {
        return pending
      },
    }
  }

  /** Every string in a rendered tree, in order. */
  function textOf(tree) {
    const out = []
    const walk = (node) => {
      if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
      else if (Array.isArray(node)) node.forEach(walk)
      else if (node !== null && typeof node === 'object' && Array.isArray(node.children)) node.children.forEach(walk)
    }
    walk(tree)
    return out
  }

  /**
   * Resolve function components in a tree. `UsageRow` is a pure function of its
   * props (no hooks), so expanding it needs no hook discipline — and it is the
   * only nested component this bundle has.
   */
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand)
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, children: (node.children ?? []).map(expand) }
  }

  /** How many elements in the tree carry this `role`. */
  function countRole(tree, role) {
    if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) return 0
    let count = tree.props?.role === role ? 1 : 0
    for (const child of tree.children ?? []) count += countRole(child, role)
    return count
  }

  const realWindow = globalThis.window
  const registration = { value: null }

  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => {
        registration.value = entry
      },
    },
    __DSH_CLINEPASS__: undefined,
    __ANSWER__: undefined,
    __CALLS__: [],
    __TIMERS__: { started: 0, cleared: 0, ids: new Set() },
    location: { origin: 'http://127.0.0.1:3080' },
    fetch: (url, init) => {
      globalThis.window.__CALLS__.push({ url, init })
      const answer = globalThis.window.__ANSWER__
      const status = globalThis.window.__STATUS__ ?? 200
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => (globalThis.window.__NON_JSON__ === true ? Promise.reject(new SyntaxError('not json')) : Promise.resolve(answer)),
      })
    },
    setInterval: () => {
      const id = ++globalThis.window.__TIMERS__.started
      globalThis.window.__TIMERS__.ids.add(id)
      return id
    },
    clearInterval: (id) => {
      globalThis.window.__TIMERS__.cleared += 1
      globalThis.window.__TIMERS__.ids.delete(id)
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  }

  try {
    await import('./client.js')
    check('the bundle registers itself on load', registration.value !== null && registration.value.id === 'dsh-clinepass', JSON.stringify(registration.value?.id))

    /**
     * Mount one fresh card instance: a new React runtime, a new factory call, a
     * new slot registration and its own fetch log — exactly what the loader does
     * per component instance. Reusing one runtime across cases would leak hook
     * state and quietly test the previous case.
     *
     * `locale` mirrors the shell's service (`getSnapshot`/`subscribe`); omitted,
     * it stands in for the degenerate case where the bundle must fall back to
     * English rather than lose a hook call.
     */
    function mount(locale) {
      const stub = reactRuntime()
      const calls = []
      globalThis.window.__CALLS__ = calls
      globalThis.window.__TIMERS__ = { started: 0, cleared: 0, ids: new Set() }
      const bundle = registration.value.factory((id) => {
        if (id === 'react') return stub.runtime
        throw new Error(`the browser half asked for an unexpected module: ${id}`)
      })
      const registered = []
      bundle.apply({
        slots: {
          inject: (name, callback) => {
            registered.push({ name, seat: callback() })
          },
          register: (options, component) => ({ options, component }),
        },
        locale,
      })
      return { stub, bundle, registered, calls, seat: registered[0].seat }
    }

    const probe = mount()
    check('the bundle exports inject and apply', typeof probe.bundle.apply === 'function' && Array.isArray(probe.bundle.inject), JSON.stringify(probe.bundle.inject))
    check('…and asks for the slots and locale services', probe.bundle.inject.join(',') === 'slots,locale', JSON.stringify(probe.bundle.inject))
    check('apply injects into the Models provider-card seat', probe.registered.length === 1 && probe.registered[0].name === 'settings.models.provider-card', JSON.stringify(probe.registered.map((r) => r.name)))
    check('…keyed by the llm-pi-ai settings namespace', probe.seat.options.key === 'llm-pi-ai', JSON.stringify(probe.seat.options))
    check('…registering the same slot name', probe.seat.options.name === 'settings.models.provider-card', String(probe.seat.options.name))

    const cardProps = (provider, extra = {}) => ({
      provider: { provider, displayName: 'x', settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], active: true },
      configured: true,
      keyConfigured: true,
      ...extra,
    })

    /**
     * Render a mounted card, running the commit step (cleanups first, then the
     * new effects) and settling promises between passes. Call it again on the
     * same seat/stub with different props to drive a prop change through the same
     * instance — the only way the "user saved a new key" path and the cleanup
     * path are exercised at all.
     */
    async function renderCard(seat, stub, props) {
      let tree = null
      for (let pass = 0; pass < 20; pass += 1) {
        stub.begin()
        tree = seat.component(props)
        // The bundle wraps UsageCard one level deep; resolve it.
        if (tree !== null && typeof tree.type === 'function') tree = tree.type(tree.props)
        const commit = stub.takeCommit()
        for (const cleanup of commit.cleanups) cleanup()
        for (const item of commit.effects) {
          const cleanup = item.fn()
          if (typeof cleanup === 'function') stub.setCleanup(item.at, cleanup)
        }
        await new Promise((resolve) => setImmediate(resolve))
        if (!stub.pending) break
      }
      return expand(tree)
    }

    // A foreign provider's card must render nothing at all.
    const foreignMount = mount()
    globalThis.window.__ANSWER__ = { ok: true, limits: [] }
    const foreign = await renderCard(foreignMount.seat, foreignMount.stub, cardProps('deepseek'))
    check('a non-cline-pass card renders nothing', foreign === null, JSON.stringify(foreign))
    check('…and therefore fetches nothing', foreignMount.calls.length === 0, `calls=${foreignMount.calls.length}`)

    // The real card, with the live payload shape.
    const live = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      limits: [
        { type: 'five_hour', percentUsed: 2, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString() },
        { type: 'weekly', percentUsed: 82, resetsAt: new Date(Date.now() + 4 * 86400_000).toISOString() },
        { type: 'monthly', percentUsed: 91, resetsAt: new Date(Date.now() + 12 * 86400_000).toISOString() },
      ],
    }
    const ours = mount()
    globalThis.window.__ANSWER__ = live
    globalThis.window.__DSH_CLINEPASS__ = { usageRoute: '/api/custom.usage' }
    const tree = await renderCard(ours.seat, ours.stub, cardProps('cline-pass'))
    const text = textOf(tree).join(' | ')
    check('the card renders', tree !== null, JSON.stringify(tree)?.slice(0, 200))
    check('…with the title', text.includes('ClinePass 剩余用量') || text.includes('ClinePass remaining usage'), text.slice(0, 160))
    check('…fetching the route the host announced', ours.calls.length === 1 && ours.calls[0].url === '/api/custom.usage', JSON.stringify(ours.calls.map((c) => c.url)))
    check('…same-origin and credentialed', ours.calls[0].init.credentials === 'same-origin', JSON.stringify(ours.calls[0].init))
    check('…naming all three windows', ['5-hour', 'Weekly', 'Monthly'].every((label) => text.includes(label)), text)

    // The displayed quantity is REMAINING (100 − percentUsed), and the bar is the
    // same quantity in both width and colour — a number that says "18% left" above
    // a bar filled to 82% would be self-contradictory.
    const bars = []
    const collectBars = (node) => {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return
      if (node.props?.role === 'progressbar') {
        bars.push({ now: node.props['aria-valuenow'], label: node.props['aria-label'], width: node.children?.[0]?.props?.style?.width })
      }
      for (const child of node.children ?? []) collectBars(child)
    }
    collectBars(tree)
    check('…three bars, one per window', bars.length === 3, JSON.stringify(bars.length))
    check('…showing remaining, not used', bars.map((bar) => bar.now).join(',') === '98,18,9', JSON.stringify(bars.map((bar) => bar.now)))
    check('…so the used figure is gone from the display', !text.includes('82%') && !text.includes('91%') && !text.includes('2%'), text)
    check('…the bar width is the remaining figure', bars.every((bar) => bar.width === bar.now + '%'), JSON.stringify(bars.map((bar) => bar.width)))
    check('…and the accessible name says which', bars.every((bar) => /left/.test(bar.label)), JSON.stringify(bars.map((bar) => bar.label)))
    check('…a progress bar per window', countRole(tree, 'progressbar') === 3, String(countRole(tree, 'progressbar')))
    check('…and a reset countdown', (text.match(/resets in/g) ?? []).length === 3, text)
    check('…but never a key', !/sk_/.test(text), text)

    // Remaining must not leak binary-float noise: 100 − 82.4 is 17.599999999999994.
    // These assertions read the *percent token* out of the bar rather than
    // scanning the whole string: the date next to it is locale-formatted, and
    // de_DE writes `17.9.2026`, which `/\d\.\d{4,}/` over the whole text matches.
    const fractionsOf = (tree) => {
      const values = []
      const walk = (node) => {
        if (node === null || typeof node !== 'object' || Array.isArray(node)) return
        if (node.props?.role === 'progressbar') values.push(String(node.props['aria-valuenow']))
        for (const child of node.children ?? []) walk(child)
      }
      walk(tree)
      return values
    }
    const fractional = mount()
    globalThis.window.__ANSWER__ = { ok: true, fetchedAt: new Date().toISOString(), limits: [
      { type: 'weekly', percentUsed: 82.4, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
    ] }
    const fractionalTree = await renderCard(fractional.seat, fractional.stub, cardProps('cline-pass'))
    check(
      'a fractional percentUsed yields a clean remaining value',
      fractionsOf(fractionalTree).join(',') === '17.6',
      `${fractionsOf(fractionalTree).join(',')} | ${textOf(fractionalTree).join(' ')}`,
    )
    const clamped = mount()
    globalThis.window.__ANSWER__ = { ok: true, fetchedAt: new Date().toISOString(), limits: [
      { type: 'weekly', percentUsed: 100, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
    ] }
    const clampedText = textOf(await renderCard(clamped.seat, clamped.stub, cardProps('cline-pass'))).join(' | ')
    check('an exhausted window bottoms out at 0%', clampedText.includes('0%'), clampedText)
    const overUsed = mount()
    globalThis.window.__ANSWER__ = { ok: true, fetchedAt: new Date().toISOString(), limits: [
      { type: 'weekly', percentUsed: 120, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
    ] }
    const overTree = await renderCard(overUsed.seat, overUsed.stub, cardProps('cline-pass'))
    check('an over-100 percentUsed cannot go negative or overflow', fractionsOf(overTree).join(',') === '0', fractionsOf(overTree).join(','))

    // Without a host announcement the bundle must fall back to the default path.
    const noBoot = mount()
    globalThis.window.__DSH_CLINEPASS__ = undefined
    globalThis.window.__ANSWER__ = live
    await renderCard(noBoot.seat, noBoot.stub, cardProps('cline-pass'))
    check('with no announcement it falls back to the default route', noBoot.calls[0].url === USAGE_ROUTE, noBoot.calls[0].url)

    // The card follows the shell's language, both directions.
    const zhMount = mount({ subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh', revision: 1 }) })
    globalThis.window.__ANSWER__ = live
    const zhText = textOf(await renderCard(zhMount.seat, zhMount.stub, cardProps('cline-pass'))).join(' | ')
    check('the card speaks the shell’s language', ['ClinePass 剩余用量', '5 小时', '每周', '每月', '剩余'].every((label) => zhText.includes(label)), zhText)
    check('…including the countdown and the refresh button', /后重置/.test(zhText) && /刷新/.test(zhText), zhText)
    const zhRejected = mount({ subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh', revision: 1 }) })
    globalThis.window.__ANSWER__ = { ok: false, reason: 'unauthorized' }
    const zhFailure = textOf(await renderCard(zhRejected.seat, zhRejected.stub, cardProps('cline-pass'))).join(' | ')
    check('…and its failure copy', /拒绝了/.test(zhFailure) && /重试/.test(zhFailure), zhFailure)

    // A shell with no locale service must still render, in English.
    const noLocale = mount(undefined)
    globalThis.window.__ANSWER__ = live
    const noLocaleText = textOf(await renderCard(noLocale.seat, noLocale.stub, cardProps('cline-pass'))).join(' | ')
    check('no locale service degrades to English instead of crashing', noLocaleText.includes('ClinePass remaining usage') && noLocaleText.includes('Weekly'), noLocaleText)

    // The failure the user is most likely to hit.
    const missing = mount()
    globalThis.window.__ANSWER__ = { ok: false, reason: 'no-key' }
    const noKey = textOf(await renderCard(missing.seat, missing.stub, cardProps('cline-pass', { keyConfigured: false }))).join(' | ')
    check('a missing key is explained on the card', /API key/.test(noKey), noKey)
    check('…without offering a pointless retry', !/Retry/.test(noKey), noKey)

    const rejectedMount = mount()
    globalThis.window.__ANSWER__ = { ok: false, reason: 'unauthorized' }
    const rejected = textOf(await renderCard(rejectedMount.seat, rejectedMount.stub, cardProps('cline-pass'))).join(' | ')
    check('a rejected key is explained', /rejected/.test(rejected), rejected)
    check('…with a retry offered', /Retry/.test(rejected), rejected)

    const unknownMount = mount()
    globalThis.window.__ANSWER__ = { ok: false, reason: 'something-new' }
    const unknown = textOf(await renderCard(unknownMount.seat, unknownMount.stub, cardProps('cline-pass'))).join(' | ')
    check('an unknown failure reason degrades to the generic message', /read failed/.test(unknown), unknown)

    // `usage: false` on the host. The bundle is discovered from package.json, so
    // the card is mounted whatever the option says; the host's `enabled: false`
    // is the only thing that can stop it fetching a route nobody serves.
    const offMount = mount()
    globalThis.window.__DSH_CLINEPASS__ = { usageRoute: null, enabled: false }
    globalThis.window.__ANSWER__ = { ok: true, limits: [] }
    const offTree = await renderCard(offMount.seat, offMount.stub, cardProps('cline-pass'))
    check('usage: false renders no card', offTree === null, JSON.stringify(offTree))
    check('…and never calls the route', offMount.calls.length === 0, `calls=${offMount.calls.length}`)
    check('…and starts no ticker', offMount.stub.intervalCount() === 0, String(offMount.stub.intervalCount()))

    // A route the host never mounted (an older host, a mistyped path, a proxy).
    const missingMount = mount()
    globalThis.window.__DSH_CLINEPASS__ = undefined
    globalThis.window.__NON_JSON__ = true
    globalThis.window.__STATUS__ = 404
    const notServed = textOf(await renderCard(missingMount.seat, missingMount.stub, cardProps('cline-pass'))).join(' | ')
    globalThis.window.__NON_JSON__ = false
    globalThis.window.__STATUS__ = undefined
    check('a 404 says the route is not served, not that the gateway is unreachable', /not serving the usage route/.test(notServed), notServed)
    check('…and does not blame the network', !/Could not reach the gateway/.test(notServed), notServed)

    // Malformed entries must not take the whole card (and its keyed slot) down:
    // the error boundary renders an invisible empty div and retires the cell.
    const hostileMount = mount()
    globalThis.window.__ANSWER__ = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      limits: [
        null,
        'nonsense',
        { type: 'weekly', percentUsed: 60, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
        { type: 'monthly', percentUsed: null },
        { type: 'five_hour', percentUsed: Number.NaN },
        { type: 'unknown_window', percentUsed: 50 },
        { type: 'constructor', percentUsed: 10 },
      ],
    }
    const hostile = textOf(await renderCard(hostileMount.seat, hostileMount.stub, cardProps('cline-pass'))).join(' | ')
    check('a malformed limits array does not crash the card', hostile.includes('ClinePass remaining usage'), hostile)
    check('…and the one good row still renders', hostile.includes('Weekly') && hostile.includes('40%'), hostile)
    check('…no NaN or bogus 100% leaks into the numbers', !/NaN/.test(hostile) && !/100%/.test(hostile), hostile)
    check('…and a window outside the three is dropped, not guessed', !/unknown_window/.test(hostile) && !/nonsense/.test(hostile), hostile)
    check('…including a name that hits Object.prototype', !/constructor/.test(hostile), hostile)

    // Saving a key must force a re-read past the host's short negative cache.
    const keyMount = mount()
    globalThis.window.__ANSWER__ = { ok: true, limits: [] }
    await renderCard(keyMount.seat, keyMount.stub, cardProps('cline-pass', { keyConfigured: false }))
    check('the first read is not forced (it may use the host cache)', keyMount.calls.length === 1 && keyMount.calls[0].url === '/api/clinepass.usage', JSON.stringify(keyMount.calls.map((c) => c.url)))
    await renderCard(keyMount.seat, keyMount.stub, cardProps('cline-pass', { keyConfigured: true }))
    check('saving a key forces a re-read', keyMount.calls.length === 2 && keyMount.calls[1].url === '/api/clinepass.usage?refresh=1', JSON.stringify(keyMount.calls.map((c) => c.url)))

    // Timers: one ticker for our card, none for anyone else's, cleared on unmount.
    const foreignTimer = mount()
    globalThis.window.__ANSWER__ = { ok: true, limits: [] }
    await renderCard(foreignTimer.seat, foreignTimer.stub, cardProps('deepseek'))
    check('a foreign card starts no ticker', foreignTimer.stub.intervalCount() === 0, String(foreignTimer.stub.intervalCount()))
    foreignTimer.stub.unmount()
    check('…so unmounting it clears nothing', globalThis.window.__TIMERS__.cleared === 0, JSON.stringify(globalThis.window.__TIMERS__))

    const ownTimer = mount()
    await renderCard(ownTimer.seat, ownTimer.stub, cardProps('cline-pass'))
    check('our card starts exactly one ticker', ownTimer.stub.intervalCount() === 1, String(ownTimer.stub.intervalCount()))
    ownTimer.stub.unmount()
    check('…and unmounting clears it', globalThis.window.__TIMERS__.cleared === 1, JSON.stringify(globalThis.window.__TIMERS__))
  } finally {
    if (realWindow === undefined) delete globalThis.window
    else globalThis.window = realWindow
  }
}

console.log(`\nRESULT: ${failures.length === 0 ? 'USAGE OK' : `${failures.length} FAILED`}`)
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`)
  process.exitCode = 1
}
