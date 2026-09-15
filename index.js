/**
 * dsh-clinepass — Cline Pass on the built-in pi-ai route, pinned to DeepSeek.
 *
 * Two pieces, each doing the thing it is good at:
 *
 *  1. The route itself is a plain **pi-ai provider profile**
 *     (`llm-pi-ai.providers.cline-pass`): an OpenAI-compatible endpoint whose
 *     API key lives in the credential store. That is why the provider — and its
 *     key field — appears natively on Settings → Models; no custom UI, and no
 *     hand-written streaming adapter that can drift from the harness contract.
 *
 *  2. This plugin adds the field itself, on the way out, without touching the
 *     route's proven request path. Cline Pass picks the upstream channel from a
 *     request-body field (`providerOptions.gateway.only`), and dsh deliberately
 *     withholds pi-ai's `openRouterRouting` / `vercelGatewayRouting` compat
 *     switches, so the field cannot be expressed in settings.
 *
 *     The injection is **in-process**: wrap `globalThis.fetch` for the lifetime
 *     of the process and rewrite the body of the gateway's own
 *     chat-completions calls. No socket, no port, no second copy of the
 *     traffic; every other request (and every other provider's endpoint) stays
 *     byte-for-byte on the original path. SSE, tool calls, reasoning, usage and
 *     images are left to pi-ai unchanged.
 *
 *     A loopback reverse proxy used to be offered as a second transport; it was
 *     removed in 0.5.0 so that this plugin never opens a listener at all. A
 *     configuration that still asks for it is reported and served by the
 *     in-process hook instead (see `withDefaults`).
 *
 * The plugin also **provisions** the pi-ai profile on first boot (create when
 * absent, repair a stale address, never rewrite anything else), so mounting the
 * plugin is the whole install.
 *
 * Deliberately dependency-free: only Node built-ins, so the whole thing can be
 * read, tested and audited in one file.
 *
 * @module dsh-clinepass
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Stable plugin id used by loader diagnostics. */
export const name = 'clinepass'

/** The settings seam is required: the provider profile is provisioned through it. */
export const inject = ['settings']

/** Provider route this plugin pins. */
export const PROVIDER = 'cline-pass'

/** Model id as the gateway wants it (`type/model`), and as declared in the profile. */
export const MODEL = 'cline-pass/deepseek-v4.1-flash'

/** Settings namespace the provider profile lives in — this is what puts the key field on the Models page. */
export const PROFILE_NS = 'llm-pi-ai'

/** Wire protocol of the Cline Pass endpoint. */
export const PROFILE_API = 'openai-completions'

/** Credential reference the Models page writes, and pi-ai resolves. */
export const KEY_REF = 'CLINE_PASS_API_KEY'

/** The path every OpenAI-compatible route appends to its base URL. */
export const PROFILE_PATH = '/api/v1'

/**
 * Marks a wrapper as ours, carrying the fetch it replaced.
 *
 * Re-mounting a plugin in one process (a reload, an HMR pass) would otherwise
 * leave a chain of wrappers, each holding the previous one as its "original";
 * reading the marker unwraps straight back to the real fetch.
 */
const FETCH_MARK = Symbol.for('dsh-clinepass.fetch-hook')

const DEFAULT_UPSTREAM = 'https://api.cline.bot'
const DEFAULT_PIN = ['deepseek']
const DEFAULT_CONTEXT_WINDOW = 921600
const DEFAULT_MAX_TOKENS = 131072

/** Coerce a configured number to the positive integer the model catalog requires. */
function positiveInteger(value, fallback) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

/** True for a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Shallow equality that ignores key order (for two level→wire maps). */
function sameEntries(a, b) {
  const left = Object.keys(a ?? {})
  const right = Object.keys(b ?? {})
  return left.length === right.length && left.every((key) => key in b && a[key] === b[key])
}

/**
 * Fill every unset field.
 *
 * Configuration can arrive from a patch row, a settings section, or a partial
 * edit, and not every path applies schema defaults — so nothing here trusts the
 * raw object to be complete.
 *
 * Options that only the removed loopback transport used (`transport`, `listen`,
 * `captureDir`, `address`, `baseURL`) are accepted and ignored: an old patch row
 * or an old settings file must not stop the plugin from loading. Each one is
 * reported once, and their names travel in `ignoredOptions` — so the status file
 * shows them too, for a front end where plugin `warn` lines are not visible.
 *
 * @param raw - whatever configuration arrived.
 * @param logger - where to report a removed option.
 * @returns a complete configuration.
 */
export function withDefaults(raw, logger = console) {
  const ignored = Array.isArray(raw?.ignoredOptions) ? [...raw.ignoredOptions] : []
  for (const removed of ['transport', 'listen', 'captureDir', 'address', 'baseURL']) {
    if (raw?.[removed] !== undefined) {
      if (!ignored.includes(removed)) ignored.push(removed)
      logger.warn?.(
        '[clinepass] "%s" is no longer used: the loopback proxy transport was removed in 0.5.0 and the pin is injected in-process, with no listener. Remove the option.',
        removed,
      )
    }
  }
  const pin = Array.isArray(raw?.pin) ? raw.pin.map(String).filter((entry) => entry.length > 0) : DEFAULT_PIN
  const pins = {}
  if (isPlainObject(raw?.pins)) {
    for (const [model, channels] of Object.entries(raw.pins)) {
      if (Array.isArray(channels)) pins[model] = channels.map(String).filter((entry) => entry.length > 0)
    }
  }
  const text = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  const rawUpstream = text(raw?.upstream, DEFAULT_UPSTREAM)
  let upstream = rawUpstream
  try {
    const parsed = new URL(rawUpstream)
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      // `upstream` is an origin: the profile appends `PROFILE_PATH` itself, so a
      // leftover path would be doubled while the hook still matched by origin.
      upstream = parsed.origin
      logger.warn?.('[clinepass] upstream "%s" carries a path; using its origin "%s" (the route already appends %s)', rawUpstream, upstream, PROFILE_PATH)
    }
  } catch {
    // Not a URL: `apply` reports it and installs nothing.
  }
  return {
    upstream: upstream.replace(/\/+$/, ''),
    pin,
    pins,
    provider: text(raw?.provider, PROVIDER),
    model: text(raw?.model, MODEL),
    displayName: text(raw?.displayName, 'Cline Pass'),
    contextWindow: positiveInteger(raw?.contextWindow, DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInteger(raw?.maxTokens, DEFAULT_MAX_TOKENS),
    apiKeyEnv: text(raw?.apiKeyEnv, KEY_REF),
    provision: raw?.provision !== false,
    alignReasoningEffort: raw?.alignReasoningEffort !== false,
    statusFile: raw?.statusFile === false ? false : typeof raw?.statusFile === 'string' && raw.statusFile.length > 0 ? raw.statusFile : true,
    ignoredOptions: ignored,
  }
}

/**
 * Where the in-process hook reports what it has done.
 *
 * There is no listener to ask, and plugin `info` lines are not shown by every
 * dsh front end, so a run that silently stopped pinning would look exactly like
 * a healthy one. This file is the plain, always-available answer:
 * `hook: "installed"` says the wrapper is in the global fetch, and the counters
 * say whether requests are actually reaching it.
 *
 * @param cfg - the complete configuration.
 * @returns the path, or null when the status file is disabled.
 */
export function statusFileFor(cfg) {
  if (cfg.statusFile === false) return null
  if (typeof cfg.statusFile === 'string' && cfg.statusFile.length > 0) return cfg.statusFile
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-clinepass-status.json')
}

/** The pin list that applies to one wire model. */
export function pinFor(config, model) {
  const perModel = model === undefined ? undefined : config.pins?.[model]
  if (Array.isArray(perModel)) return perModel
  return config.pin ?? []
}

/**
 * Add the gateway pin to a parsed chat request body.
 *
 * @param body - the parsed request body (not mutated).
 * @param only - the upstream channels to restrict to.
 * @returns the body to send, and whether the pin was written.
 */
export function withPin(body, only) {
  if (!isPlainObject(body)) return { body, pinned: false }
  if (!Array.isArray(only) || only.length === 0) return { body, pinned: false }
  const existing = isPlainObject(body.providerOptions) ? body.providerOptions : {}
  const gateway = isPlainObject(existing.gateway) ? existing.gateway : {}
  return {
    body: { ...body, providerOptions: { ...existing, gateway: { ...gateway, only } } },
    pinned: true,
  }
}

/**
 * Thinking levels this model advertises.
 *
 * These are pi-ai's own level ids, and the wire spelling is whatever the profile
 * declares for each (`dsh-llm-pi-ai` turns `reasoningEfforts` into
 * `model.thinkingLevelMap`, and pi-ai sends `thinkingLevelMap[level]` verbatim as
 * `reasoning_effort`).
 *
 * Exactly two levels are offered, and both are pi-ai ids a profile may declare:
 * `high` dispatches `reasoning_effort: "high"` and `max` dispatches
 * `reasoning_effort: "max"`. `max` is in pi-ai's escalation order
 * (`off/minimal/low/medium/high/xhigh/max`), so it needs no alias.
 */
export const EFFORT_LEVELS = ['high', 'max']

/** The declared levels and the wire value each one dispatches (identity here). */
const EFFORT_MAP = Object.fromEntries(EFFORT_LEVELS.map((level) => [level, level]))

/**
 * Level ids this plugin used to declare and no longer offers.
 *
 * `xhigh` was an earlier alias for the top level (it also dispatched `"max"`).
 * It is retired so the composer lists `high` / `max` only: provisioning drops it
 * from an existing card, and a stored `xhigh` is moved to the level that means
 * the same thing on the wire rather than silently losing effort.
 */
const RETIRED_EFFORTS = { xhigh: 'max' }

/**
 * Realign a stored reasoning effort that the installed model cannot serve.
 *
 * `high` and `max` are valid; a retired id is moved to the level it used to
 * dispatch; anything else (a level belonging to another model, or a hand-edited
 * typo) would fail every turn with UNSUPPORTED_REASONING_EFFORT, so it is
 * realigned to `high`. Disable with `alignReasoningEffort: false`.
 *
 * @param settings - the settings service.
 * @param cfg - the complete plugin configuration.
 * @param logger - where to report.
 * @returns `'ok' | 'aligned' | 'absent' | 'other-provider' | 'failed'`.
 */
export async function alignReasoningEffort(settings, cfg, logger = console) {
  const ns = 'agent-default-model'
  try {
    const current = settings.get?.(ns)
    if (current === null || typeof current !== 'object') return 'absent'
    if (current.provider !== cfg.provider) return 'other-provider'
    // The effort belongs to a model; another model on the same route may well
    // declare different levels, so leave it alone.
    if (typeof current.model === 'string' && current.model.length > 0 && current.model !== cfg.model) return 'other-model'
    const effort = current.reasoningEffort
    if (typeof effort !== 'string' || effort.length === 0 || EFFORT_LEVELS.includes(effort)) return 'ok'
    // A retired id keeps its old meaning (top effort); everything else is not a
    // level this model serves and falls back to the safe middle.
    const mapped = RETIRED_EFFORTS[effort] ?? 'high'
    const revision = settings.describe?.({ redactSecrets: true })?.find((entry) => entry.ns === ns)?.revision
    await settings.mutate(ns, [{ op: 'set', path: ['reasoningEffort'], value: mapped }], revision)
    if (effort in RETIRED_EFFORTS) {
      logger.warn?.(
        '[clinepass] agent-default-model.reasoningEffort "%s" is a retired level id; it was moved to "%s" (the same effort). Re-pick a level in the composer if a session was saved with "%s".',
        effort,
        mapped,
        effort,
      )
    } else {
      logger.warn?.(
        '[clinepass] agent-default-model.reasoningEffort "%s" is not a level this model serves; set it to "%s". Re-pick a level in the composer if a session was saved with "%s".',
        effort,
        mapped,
        effort,
      )
    }
    return 'aligned'
  } catch (error) {
    logger.warn?.('[clinepass] could not align the stored reasoning effort: %s', error instanceof Error ? error.message : String(error))
    return 'failed'
  }
}

/**
 * The request URL a `fetch()` call is aimed at, or null when it cannot be read.
 *
 * `fetch` accepts a string, a `URL`, or a `Request`; anything else is left
 * alone rather than guessed at.
 *
 * @param input - the first argument of a fetch call.
 * @returns the absolute URL, or null.
 */
function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return null
}

/**
 * True when `url` is this gateway's chat-completions endpoint.
 *
 * Scoping matters more than it looks: a global hook sees *every* provider's
 * traffic, and `providerOptions` is not a field every OpenAI-compatible API
 * accepts — a host that rejects unknown arguments would start failing the
 * moment an unrelated route was rewritten. So the origin has to match the
 * configured upstream, and the path has to be the completions endpoint.
 *
 * @param url - the request URL.
 * @param upstream - the configured gateway base (e.g. `https://api.cline.bot`).
 * @returns whether the pin applies to this request.
 */
export function isGatewayChat(url, upstream) {
  let target
  let origin
  try {
    target = new URL(url)
    origin = new URL(upstream)
  } catch {
    return false
  }
  return target.origin === origin.origin && /\/chat\/completions\/?$/.test(target.pathname)
}

/**
 * Drop a body-length header that no longer describes the rewritten body.
 *
 * The OpenAI SDK sends no `content-length` (undici computes it), which is why
 * this is not load-bearing today — but a caller that does set one would declare
 * a length that no longer matches its body, and `fetch` refuses a
 * `transfer-encoding` that arrives alongside a body. Cheap to get right.
 *
 * @param headers - `init.headers` (plain object, `Headers`, or [name, value] pairs).
 * @returns the same headers when there is nothing to fix, otherwise a copy.
 */
function withoutBodyLength(headers) {
  if (headers === undefined || headers === null || typeof headers !== 'object') return headers
  const pattern = /^(content-length|transfer-encoding)$/i
  if (typeof Headers === 'function' && headers instanceof Headers) {
    if (!headers.has('content-length') && !headers.has('transfer-encoding')) return headers
    const copy = new Headers(headers)
    copy.delete('content-length')
    copy.delete('transfer-encoding')
    return copy
  }
  const found = Object.keys(headers).filter((key) => pattern.test(key))
  if (found.length === 0) return headers
  const copy = { ...headers }
  for (const key of found) delete copy[key]
  return copy
}

/**
 * The body of a fetch call as text, when this hook can rewrite it.
 *
 * Strings are what the OpenAI SDK sends (`body: JSON.stringify(...)`), so that
 * is the path that matters; buffers are accepted because a hand-rolled caller
 * may send them. A stream, `FormData` or `Blob` cannot be inspected without
 * buffering it, and buffering a request is a worse idea than skipping it.
 *
 * @param body - `init.body`.
 * @returns `{ text }` when rewritable, `{ skip }` with a reason otherwise.
 */
function bodyText(body) {
  if (typeof body === 'string') return { text: body }
  if (body instanceof ArrayBuffer) return { text: Buffer.from(body).toString('utf8') }
  // `Buffer` is an ArrayBuffer view, so this branch covers it too.
  if (ArrayBuffer.isView(body)) return { text: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8') }
  if (body === undefined || body === null) return { skip: 'no body' }
  return { skip: `a ${body.constructor?.name ?? typeof body} body` }
}

/**
 * Render the pinned body, or say why it was left alone.
 *
 * A body with no pin configured (`pin: []`) is a legitimate "pass through" and
 * is deliberately *not* a problem; an unreadable one is.
 *
 * @param text - the request body as text.
 * @param cfg - the complete configuration.
 * @returns `{ text, only, model }` when rewritten, else `{ problem }`.
 */
function pinnedBody(text, cfg) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { problem: 'the body is not JSON' }
  }
  if (!isPlainObject(body)) return { problem: 'the body is not a JSON object' }
  const only = pinFor(cfg, typeof body.model === 'string' ? body.model : undefined)
  const applied = withPin(body, only)
  if (!applied.pinned) return { untouched: true }
  return { text: JSON.stringify(applied.body), only, model: body.model ?? null }
}

/**
 * Build the in-process pin hook without a plugin context (used by apply() and tests).
 *
 * Installing replaces `globalThis.fetch` with a wrapper that inspects only this
 * gateway's chat-completions calls; every other call is passed to the original
 * function with the original arguments, synchronously and unmodified. Any
 * failure inside the hook is caught and turns into an ordinary unpinned request
 * plus a warning — a broken hook must not break the user's traffic.
 *
 * @param config - a complete configuration.
 * @param logger - optional logger ({info,warn,error}).
 * @returns the hook: `install()`, `uninstall()`, counters and `profileBaseURL()`.
 */
export function createFetchPin(config, logger = console) {
  const cfg = withDefaults(config, logger)
  let original = null
  let installed = false
  let calling = false
  let hookState = 'absent'
  let lastPin = null
  const counters = { seen: 0, pinned: 0, skipped: 0 }

  /** The base URL the provider profile must point at: the gateway itself. */
  const profileBaseURL = () => `${cfg.upstream}${PROFILE_PATH}`

  // ── the status file: how a silent bypass becomes visible ──────────────────
  const statusPath = statusFileFor(cfg)
  let writeWarned = false

  /**
   * Publish the current state. One small write per pinned request (chat
   * requests are rare, and a synchronous write of a few hundred bytes is
   * cheaper than making this state unreachable), and never allowed to break a
   * request.
   */
  function publish() {
    if (statusPath === null) return
    try {
      fs.mkdirSync(path.dirname(statusPath), { recursive: true })
      const payload = `${JSON.stringify(
        {
          service: 'dsh-clinepass',
          transport: 'fetch',
          hook: hookState,
          upstream: cfg.upstream,
          pin: cfg.pin,
          profileBaseURL: profileBaseURL(),
          counters: { ...counters },
          lastPin,
          // Config keys that were read and ignored, so an upgrade from the
          // port era is visible even where plugin warnings are not.
          ignoredOptions: cfg.ignoredOptions ?? [],
          pid: process.pid,
          at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`
      // Written through a temporary file and renamed: `cat` (the README) and
      // `JSON.parse` (smoke-test) must never catch a half-written file.
      const temporary = `${statusPath}.tmp`
      fs.writeFileSync(temporary, payload)
      fs.renameSync(temporary, statusPath)
    } catch (error) {
      if (!writeWarned) {
        writeWarned = true
        logger.warn?.('[clinepass] could not write %s: %s', statusPath, error instanceof Error ? error.message : String(error))
      }
    }
  }

  /**
   * Decide what to send. Resolves `null` to mean "send the request untouched".
   *
   * @param input - fetch input.
   * @param init - fetch init.
   * @returns `{ kind: 'init', init }` or `{ kind: 'request', request }`, or null.
   */
  async function rewrite(input, init) {
    const direct = init ?? {}
    const hasOwnBody = direct.body !== undefined
    if (hasOwnBody) {
      const { text, skip } = bodyText(direct.body)
      if (skip !== undefined) {
        logger.warn?.('[clinepass] not pinning request #%s: %s', counters.seen, skip)
        return null
      }
      const next = pinnedBody(text, cfg)
      if (next.text === undefined) {
        if (next.problem !== undefined) logger.warn?.('[clinepass] not pinning request #%s: %s', counters.seen, next.problem)
        return null
      }
      return { kind: 'init', init: { ...direct, body: next.text, headers: withoutBodyLength(direct.headers ?? input?.headers) }, next }
    }
    // A `Request` carries its own body; rebuild it with the pinned one, keeping
    // the method, headers and signal it was constructed with.
    if (typeof Request === 'function' && input instanceof Request) {
      const next = pinnedBody(await input.clone().text(), cfg)
      if (next.text === undefined) {
        if (next.problem !== undefined) logger.warn?.('[clinepass] not pinning request #%s: %s', counters.seen, next.problem)
        return null
      }
      const headers = withoutBodyLength(direct.headers ?? input.headers)
      return { kind: 'request', request: new Request(input, { ...direct, body: next.text, headers }), next }
    }
    logger.warn?.('[clinepass] not pinning request #%s: it carries no readable body', counters.seen)
    return null
  }

  /** Log the request the way a capture would. */
  function report(url, next) {
    const id = String(counters.seen).padStart(3, '0')
    logger.info?.(
      '[clinepass] → #%s POST %s pinned to %s (model %s, in-process)',
      id,
      url,
      next.only.join(', '),
      next.model ?? '?',
    )
  }

  /**
   * Hand a call to the function this hook replaced.
   *
   * `fetch` never throws synchronously — it returns a rejected promise — and a
   * wrapper must not change that, whatever implementation it happened to wrap.
   */
  function passThrough(input, init) {
    calling = true
    try {
      return original(input, init)
    } catch (error) {
      return Promise.reject(error)
    } finally {
      calling = false
    }
  }

  const wrapper = function pinnedFetch(input, init) {
    // Only reachable through `globalThis.fetch`, which is only replaced once
    // `original` is set; the guard keeps a hand-driven call readable.
    if (original === null) throw new Error('dsh-clinepass: the pin hook was called before it was installed')
    // A function we wrapped that calls `globalThis.fetch` synchronously would
    // re-enter us forever and starve the event loop. Refusing is loud; hanging
    // is not.
    if (calling) throw new Error('dsh-clinepass: the wrapped fetch calls globalThis.fetch synchronously; refusing to recurse')
    let url
    try {
      url = requestUrl(input)
    } catch {
      url = null
    }
    if (url === null || !isGatewayChat(url, cfg.upstream)) return passThrough(input, init)
    counters.seen += 1
    return rewrite(input, init).then(
      (next) => {
        if (next === null) {
          counters.skipped += 1
          publish()
          return passThrough(input, init)
        }
        counters.pinned += 1
        lastPin = { at: new Date().toISOString(), url, model: next.next.model, only: next.next.only }
        publish()
        report(url, next.next)
        return next.kind === 'request' ? passThrough(next.request) : passThrough(input, next.init)
      },
      (error) => {
        counters.skipped += 1
        publish()
        logger.warn?.(
          '[clinepass] ✗ pin hook failed (%s); sending the request unpinned',
          error instanceof Error ? error.message : String(error),
        )
        return passThrough(input, init)
      },
    )
  }
  wrapper[FETCH_MARK] = () => original

  let ownershipTimer = null

  /** Keep an eye on the global fetch, so a post-install replacement shows up. */
  function startOwnershipCheck() {
    if (ownershipTimer !== null) return
    ownershipTimer = setInterval(() => checkOwnership(), OWNERSHIP_CHECK_MS)
    ownershipTimer.unref?.()
  }

  /** True when this instance is still the one the global fetch points at. */
  const owns = () => globalThis.fetch === wrapper

  /**
   * Is the current global fetch another of ours (a newer instance, after a
   * reload) rather than a foreign function?
   *
   * The distinction matters for the status file: a newer instance owns that
   * record, so this one must not overwrite it, and reporting "foreign" then
   * would be a lie that breaks the smoke test on a healthy reload.
   */
  const ours = () => typeof globalThis.fetch?.[FETCH_MARK] === 'function'

  /**
   * Record what the global fetch is now.
   *
   * Without this, a hook that was quietly unhooked would leave the status file
   * reading `installed` forever — exactly the silent failure the file exists to
   * expose. Three things it deliberately does *not* do: warn more than once for
   * the same replacement (this runs every 30 s for the life of the process),
   * keep claiming `foreign` after ownership comes back, and call a native fetch
   * that someone restored "foreign" — a newer instance of this plugin standing
   * down is not a bypass.
   *
   * @returns the state it observed, for tests and logs.
   */
  function checkOwnership() {
    if (!installed) return 'not-installed'
    const observed = owns() ? 'installed' : ours() ? 'replaced-by-us' : globalThis.fetch === original ? 'uninstalled' : 'foreign'
    const changed = observed !== hookState
    hookState = observed
    // A newer instance of this plugin holds the global fetch, so the status
    // record belongs to it: this one neither warns nor writes.
    if (observed === 'replaced-by-us') return observed
    // Otherwise act on the transition only — one warning per replacement, one
    // write per state change, never a rewrite every 30 s.
    if (changed) {
      publish()
      if (observed === 'foreign') logger.warn?.('[clinepass] globalThis.fetch is no longer the pin hook; requests are going out unpinned')
    }
    return observed
  }

  return {
    config: cfg,
    counters,
    profileBaseURL,
    /** Re-check whether the hook still owns `globalThis.fetch` (also runs on a timer). */
    checkOwnership,
    /**
     * Replace `globalThis.fetch` with the hook.
     *
     * @returns `'installed'`, or `'unavailable'` when there is no global fetch
     *   to wrap (in which case nothing was changed).
     */
    install() {
      // Idempotent: re-installing an installed hook must not capture anything
      // new as its "original", which is how a wrapper chain (or a cycle through
      // a delegate) would otherwise start.
      if (installed) return 'installed'
      const current = globalThis.fetch
      if (typeof current !== 'function') {
        hookState = 'unavailable'
        logger.error?.('[clinepass] there is no global fetch to hook; the pin cannot be injected')
        publish()
        return 'unavailable'
      }
      // Reuse the fetch an earlier wrapper of ours replaced, so a reload cannot
      // grow a chain of wrappers.
      original = typeof current[FETCH_MARK] === 'function' ? current[FETCH_MARK]() : current
      globalThis.fetch = wrapper
      installed = true
      hookState = 'installed'
      publish()
      startOwnershipCheck()
      return 'installed'
    },
    /**
     * Put the original fetch back.
     *
     * @returns `'restored'`, `'absent'` when this hook was not installed, or
     *   `'foreign'` when someone else replaced fetch after us — in which case
     *   theirs is left alone, because restoring would silently discard it. A
     *   displaced instance also stops publishing: the record belongs to whoever
     *   holds the global now.
     */
    uninstall() {
      if (!installed) return 'absent'
      installed = false
      clearInterval(ownershipTimer)
      ownershipTimer = null
      if (!owns()) {
        logger.warn?.('[clinepass] another plugin replaced globalThis.fetch after this one; leaving that in place')
        return 'foreign'
      }
      globalThis.fetch = original
      hookState = 'uninstalled'
      publish()
      return 'restored'
    },
    /** The status file path, or null when it is disabled. */
    statusPath,
  }
}

/** How often an installed hook re-checks that it still owns the global fetch. */
const OWNERSHIP_CHECK_MS = 30_000

/**
 * Ensure the pi-ai provider profile exists and points at the right place.
 *
 * Create when absent; repair only the address when the profile is recognisably
 * ours (same protocol and credential ref) — anything else is left untouched and
 * reported, because silently rewriting a user's provider is worse than a warning.
 *
 * The address is always the gateway itself: there is no local listener.
 *
 * @param settings - the settings service.
 * @param cfg - the complete plugin configuration.
 * @param logger - where to report.
 * @returns `'created' | 'present' | 'repaired' | 'mismatch' | 'failed'`.
 */
export async function provisionProfile(settings, cfg, logger = console) {
  const revision = () => settings.describe?.({ redactSecrets: true })?.find((entry) => entry.ns === PROFILE_NS)?.revision
  const attempt = async () => {
    const profile = {
      displayName: cfg.displayName,
      apiKeyEnv: cfg.apiKeyEnv,
      api: PROFILE_API,
      baseURL: `${cfg.upstream}${PROFILE_PATH}`,
      models: [
        {
          id: cfg.model,
          name: 'DeepSeek V4.1 Flash',
          contextWindow: cfg.contextWindow,
          maxTokens: cfg.maxTokens,
          input: ['text', 'image'],
          // The level ids this route offers and the `reasoning_effort` each one
          // dispatches: exactly `high` and `max`.
          reasoningEfforts: { ...EFFORT_MAP },
        },
      ],
    }
    const existing = settings.get(PROFILE_NS)?.providers?.[cfg.provider]
    if (existing === undefined) {
      await settings.mutate(PROFILE_NS, [{ op: 'set', path: ['providers', cfg.provider], value: profile }], revision())
      logger.info?.('[clinepass] provisioned "%s" on Settings → Models (%s) — add your API key there', cfg.provider, profile.baseURL)
      return 'created'
    }
    // A scalar where a profile belongs is a broken route, not a healthy one.
    if (typeof existing !== 'object' || existing === null) {
      logger.warn?.('[clinepass] the "%s" provider profile is not an object (%s); fix it on Settings → Models', cfg.provider, JSON.stringify(existing))
      return 'mismatch'
    }

    const ours = existing.api === PROFILE_API && existing.apiKeyEnv === cfg.apiKeyEnv
    const ourModel = profile.models[0]
    const models = Array.isArray(existing.models) ? existing.models : []
    const at = models.findIndex((entry) => isPlainObject(entry) && entry.id === cfg.model)

    // Bring the model entry up to date — the declared levels (a new level, or a
    // wire spelling fix, has to reach installs that already have this card) and
    // the advertised capacity — without dropping anything else the entry
    // declares. Ids this plugin retired are dropped so the composer lists what
    // the route actually serves today.
    let nextModels = models
    if (at === -1) nextModels = [...models, ourModel]
    else {
      const declared = isPlainObject(models[at].reasoningEfforts) ? models[at].reasoningEfforts : {}
      const kept = Object.fromEntries(Object.entries(declared).filter(([id]) => !(id in RETIRED_EFFORTS)))
      const merged = { ...kept, ...ourModel.reasoningEfforts }
      const entry = { ...models[at] }
      let changed = false
      if (!sameEntries(declared, merged)) {
        entry.reasoningEfforts = merged
        changed = true
      }
      for (const field of ['contextWindow', 'maxTokens']) {
        if (entry[field] !== ourModel[field]) {
          entry[field] = ourModel[field]
          changed = true
        }
      }
      if (changed) nextModels = models.map((candidate, index) => (index === at ? entry : candidate))
    }

    const addressSame = existing.baseURL === profile.baseURL
    const levelsSame = nextModels === models
    const displaySame = existing.displayName === profile.displayName
    if (addressSame && levelsSame && displaySame) return 'present'
    if (!ours) {
      // A card this plugin did not write is left alone — with one exception. An
      // address on loopback is the footprint of the transport this plugin used
      // to offer, nothing listens there any more, and a card pointing at it pins
      // nothing at all: repair exactly that, and say so.
      const stranded = typeof existing.baseURL === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(existing.baseURL)
      if (!addressSame && stranded) {
        await settings.mutate(PROFILE_NS, [{ op: 'set', path: ['providers', cfg.provider, 'baseURL'], value: profile.baseURL }], revision())
        logger.warn?.(
          '[clinepass] the "%s" profile points at a local address nothing listens on (%s); moved it to %s. Its api/apiKeyEnv are not the ones this plugin writes, so nothing else was touched — check the key on Settings → Models',
          cfg.provider,
          existing.baseURL,
          profile.baseURL,
        )
        return 'repaired'
      }
      logger.warn?.(
        '[clinepass] the "%s" provider profile is not the one this plugin wrote (api/apiKeyEnv differ), so it is left alone; it points at %s, not %s — fix it on Settings → Models or requests will bypass the pin',
        cfg.provider,
        String(existing.baseURL),
        profile.baseURL,
      )
      return 'mismatch'
    }
    const ops = []
    if (!addressSame) ops.push({ op: 'set', path: ['providers', cfg.provider, 'baseURL'], value: profile.baseURL })
    if (!displaySame) ops.push({ op: 'set', path: ['providers', cfg.provider, 'displayName'], value: profile.displayName })
    if (!levelsSame) ops.push({ op: 'set', path: ['providers', cfg.provider, 'models'], value: nextModels })
    await settings.mutate(PROFILE_NS, ops, revision())
    logger.info?.(
      '[clinepass] repaired the "%s" profile (%s)',
      cfg.provider,
      [!addressSame ? `address → ${profile.baseURL}` : null, !displaySame ? 'display name' : null, !levelsSame ? 'model entry' : null].filter(Boolean).join(', '),
    )
    return 'repaired'
  }

  try {
    return await attempt()
  } catch (error) {
    // A concurrent settings write, or llm-pi-ai not registered yet, is worth one
    // retry: without the profile the route never reaches the gateway.
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      return await attempt()
    } catch (retryError) {
      logger.warn?.('[clinepass] could not provision the "%s" profile: %s', cfg.provider, retryError instanceof Error ? retryError.message : String(retryError))
      return 'failed'
    }
  }
}

/**
 * Install the in-process pin hook and provision the provider profile.
 *
 * The settings seam is required: provisioning must finish before the first turn
 * resolves the model, and awaiting it here is what makes the provider card exist
 * by the time dsh starts serving.
 *
 * @param ctx - host plugin context.
 * @param config - the resolved plugin config (defaults are complete).
 */
export async function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const cfg = withDefaults(config, logger)
  let status = 'n/a'
  try {
    new URL(cfg.upstream)
  } catch {
    // A typo here would otherwise mean "the pin never matches anything" *and* a
    // broken address written into the card, which is exactly the kind of silence
    // this plugin is supposed to avoid. Leave everything alone and say so.
    logger.error?.('[clinepass] upstream "%s" is not a URL; nothing was installed or provisioned', cfg.upstream)
    return
  }
  for (const [model, channels] of Object.entries(cfg.pins ?? {})) {
    if (Array.isArray(channels) && channels.length === 0 && (cfg.pin ?? []).length > 0) {
      logger.warn?.(
        '[clinepass] pins["%s"] is empty, so requests for that model go out unpinned even though pin is %s',
        model,
        JSON.stringify(cfg.pin),
      )
    }
  }

  const hook = createFetchPin(cfg, logger)
  status = hook.install()
  if (status === 'installed') {
    ctx.effect?.(() => () => {
      hook.uninstall()
    })
  } else {
    logger.error?.(
      '[clinepass] could not hook the global fetch, so requests would go out unpinned. Something replaced globalThis.fetch before this plugin loaded.',
    )
  }

  let provision = 'off'
  if (cfg.provision) {
    const settings = ctx.settings ?? ctx.get?.('settings')
    if (settings === undefined || typeof settings.mutate !== 'function') {
      provision = 'unavailable'
      logger.warn?.('[clinepass] settings service unavailable; the "%s" provider profile was not provisioned', cfg.provider)
    } else {
      provision = await provisionProfile(settings, cfg, logger)
      if (cfg.alignReasoningEffort) await alignReasoningEffort(settings, cfg, logger)
    }
  }

  logger.info?.(
    '[clinepass] route "%s" served by pi-ai via %s; %s; pin %s (profile %s)',
    cfg.provider,
    hook.profileBaseURL(),
    status === 'installed' ? 'pin injected in-process, no listener' : `hook ${status}`,
    (cfg.pin ?? []).join(', ') || '(nothing)',
    provision,
  )
}
