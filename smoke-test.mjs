#!/usr/bin/env node
/**
 * Post-install / post-upgrade smoke test.
 *
 * Drives the real gateway through the route the Models page configures and
 * checks the things that can silently break:
 *
 *   1. the pin is injected in-process — the profile points straight at the
 *      gateway, this plugin opens no listener, and the running dsh's
 *      `dsh-clinepass-status.json` confirms the hook is installed and has been
 *      pinning requests
 *   2. the gateway serves DeepSeek for a pinned request (`finalProvider`, no
 *      fallbacks) — i.e. the pin reached the wire and was honoured
 *   3. the credential the Models page stored is the one the route resolves
 *
 * Run it from the installed plugin directory (so `js-yaml` resolves alongside
 * dsh) or from the package directory. `--negative` additionally proves the pin
 * field is load-bearing by asking for a channel that cannot exist.
 *
 *   node smoke-test.mjs
 *   node smoke-test.mjs --negative
 *   DSH_HOME=/tmp/dsh node smoke-test.mjs
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)
const DSH_HOME = path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const PROVIDER = 'cline-pass'
/** Port the old proxy transport would use; override with CLINE_PROXY_PORT. */
const LEGACY_PORT = Number(process.env.CLINE_PROXY_PORT ?? 8791)

/** Resolve js-yaml from wherever dsh keeps it. */
function yamlLoader() {
  const candidates = [
    import.meta.url,
    path.join(DSH_HOME, 'profiles', PROFILE, 'entry.js'),
    // The profile's own dependency link into the dsh install, which is where
    // js-yaml actually lives for every install method.
    path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(DSH_HOME, 'profiles', PROFILE, 'plugins', 'dsh-clinepass', 'smoke-test.mjs'),
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]
  for (const base of candidates) {
    try {
      return createRequire(base)('js-yaml')
    } catch {
      /* try the next location */
    }
  }
  return null
}

const yaml = yamlLoader()
if (yaml === null) {
  console.error('dsh-clinepass smoke: cannot find js-yaml. Run this from the installed plugin directory, or set DSH_HOME.')
  process.exit(1)
}

const readYaml = (file) => (fs.existsSync(file) ? yaml.load(fs.readFileSync(file, 'utf8')) : undefined)
const settings = readYaml(path.join(DSH_HOME, 'settings.yaml')) ?? {}
const credentials = readYaml(path.join(DSH_HOME, '.credentials.yaml')) ?? {}
const profile = settings['llm-pi-ai']?.providers?.[PROVIDER]

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

if (profile === undefined) {
  console.error(`dsh-clinepass smoke: settings has no llm-pi-ai.providers.${PROVIDER}.`)
  console.error('Start dsh once with the plugin mounted (it provisions the profile), or add it on Settings → Models.')
  process.exit(1)
}

const keyRef = profile.apiKeyEnv ?? 'CLINE_PASS_API_KEY'
const key = credentials.refs?.[keyRef]
const modelId = profile.models?.[0]?.id
const baseURL = String(profile.baseURL ?? '')
const origin = baseURL.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '')

console.log('── inputs ────────────────────────────────────────────────')
console.log(`  DSH_HOME     : ${DSH_HOME}`)
console.log(`  profile      : llm-pi-ai.providers.${PROVIDER}`)
console.log(`  baseURL      : ${baseURL}`)
console.log(`  model        : ${modelId}`)
console.log(`  key ref      : ${keyRef} (${key === undefined ? 'MISSING' : `stored, len ${String(key).length}`})`)
console.log('')

// ── 1. the transport ────────────────────────────────────────────────────────
console.log('── 1. pin transport ──────────────────────────────────────')

/** The port a loader row would listen on, if it carries one at all. */
function configuredPort() {
  const patch = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
  if (!fs.existsSync(patch)) return LEGACY_PORT
  const lines = fs.readFileSync(patch, 'utf8').split('\n')
  const start = lines.findIndex((line) => /id:\s*['"]?clinepass['"]?\s*$/.test(line))
  if (start === -1) return LEGACY_PORT
  for (let i = start; i < lines.length && i < start + 12; i += 1) {
    const match = /^\s*listen:\s*(\S+)/.exec(lines[i])
    if (match !== null) return Number(String(match[1]).split(':').pop())
    if (i > start && /^\s*-?\s*id:/.test(lines[i])) break
  }
  return LEGACY_PORT
}

/** True when nothing accepts a TCP connection on that loopback port. */
function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const done = (closed) => {
      socket.destroy()
      resolve(closed)
    }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    socket.setTimeout(1500, () => done(true))
  })
}

const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(baseURL)
if (loopback) {
  // Only reachable from a card left over from the removed proxy transport: the
  // route would talk to a listener that no longer exists.
  check('the card points at the gateway, not at a local listener', false, `${baseURL} — the loopback transport was removed in 0.5.0; restart dsh so the card is repaired`)
}

/**
 * The fetch this process has not wrapped.
 *
 * The pin lives in the running dsh process, so this script installs the
 * plugin's own hook to exercise the installed code — and the negative control
 * below needs the unwrapped one.
 */
const nativeFetch = globalThis.fetch
let hook = null

{
  const expected = process.env.CLINE_UPSTREAM ?? 'https://api.cline.bot'
  check('the profile points at the gateway itself', baseURL === `${expected}/api/v1`, baseURL)
  // The removed transport used to listen here; a leftover listener is worth
  // knowing about, and on a healthy install there is none.
  const port = configuredPort()
  // The detail must report what was actually observed: an unconditional
  // "accepted a connection" printed next to an `ok` reads like the port is open.
  const oldPortClosed = await portIsClosed(port)
  check(
    `nothing is listening on the old proxy port ${port}`,
    oldPortClosed,
    oldPortClosed ? 'no listener (the plugin opens none)' : 'something is still listening, from an older install — stop it or free the port',
  )

  // The running dsh writes this file: it is the proof that the hook is in its
  // process and that requests actually reach it.
  const statusPath = path.join(DSH_HOME, 'dsh-clinepass-status.json')
  let pinned = null
  try {
    pinned = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  } catch {
    pinned = null
  }
  if (pinned === null) {
    check(
      'the running dsh reports its pin state',
      false,
      `${statusPath} is missing — restart dsh with the plugin mounted, or set statusFile in the loader row`,
    )
  } else {
    console.log(`       ${statusPath}`)
    console.log(`       hook=${pinned.hook} transport=${pinned.transport} pid=${pinned.pid} seen=${pinned.counters?.seen} pinned=${pinned.counters?.pinned} skipped=${pinned.counters?.skipped}`)
    check('the running dsh uses the fetch transport', pinned.transport === 'fetch', String(pinned.transport))
    // A record outlives the process that wrote it, so only a live pid can
    // support a claim about the live hook.
    let alive = false
    if (Number.isInteger(pinned.pid) && pinned.pid > 0) {
      try {
        process.kill(pinned.pid, 0)
        alive = true
      } catch {
        alive = false
      }
    }
    if (!alive) {
      console.log(`       (dsh pid ${pinned.pid} is not running — this record is from a finished run, so the live hook could not be checked)`)
      console.log('       (start dsh, send one message, and re-run to verify the hook in the live process)')
    } else {
      check('the hook is installed in the running dsh', pinned.hook === 'installed', String(pinned.hook))
      check(
        'requests are actually reaching the hook',
        (pinned.counters?.seen ?? 0) === 0 || (pinned.counters?.pinned ?? 0) > 0,
        `${pinned.counters?.pinned ?? 0} of ${pinned.counters?.seen ?? 0} gateway requests were pinned — the rest were skipped (see the dsh log)`,
      )
      if ((pinned.counters?.seen ?? 0) === 0) console.log('       (no gateway request since boot; send one and re-run to see the counters move)')
      if (pinned.lastPin !== undefined && pinned.lastPin !== null) console.log(`       last pin: ${pinned.lastPin.at} ${pinned.lastPin.model} -> ${pinned.lastPin.only?.join(', ')}`)
    }
  }

  // Exercise the installed code end to end; its own status file is off so the
  // running dsh's record above is not overwritten.
  const { createFetchPin } = await import('./index.js')
  hook = createFetchPin(
    { upstream: origin, statusFile: false },
    { info: () => {}, warn: (line, ...rest) => console.log(`       ${String(line).replace(/%s/g, () => String(rest.shift() ?? ''))}`), error: () => {} },
  )
  check('the installed pin hook can be installed', hook.install() === 'installed', 'this process only; dsh installs its own at boot')
}

// ── 2. a real pinned turn ───────────────────────────────────────────────────
console.log('\n── 2. pinned turn through the gateway ────────────────────')

/** Collect every routing record in a parsed SSE frame. */
function findRouting(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) findRouting(entry, out)
    return out
  }
  if (node.routing !== undefined && node.routing !== null && typeof node.routing === 'object') out.push(node.routing)
  for (const value of Object.values(node)) findRouting(value, out)
  return out
}

let routing = null
let content = ''
let streamError = null
if (key === undefined) {
  check('credential stored', false, `${keyRef} is missing — type it on Settings → Models`)
} else {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], stream: true, max_tokens: 512 }),
  })
  const text = await response.text()
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data.length === 0 || data === '[DONE]') continue
    try {
      const json = JSON.parse(data)
      if (json.error !== undefined) streamError = json.error.message ?? JSON.stringify(json.error)
      for (const found of findRouting(json)) routing = found
      for (const choice of json.choices ?? []) content += choice.delta?.content ?? ''
    } catch {
      /* partial frame */
    }
  }
  check('gateway answered 200', response.status === 200, String(response.status))
  check('no stream error', streamError === null, String(streamError).slice(0, 120))
  check('model answered', content.trim().length > 0, JSON.stringify(content.trim().slice(0, 40)))
  check('served by deepseek', routing?.finalProvider === 'deepseek', String(routing?.finalProvider))
  check(
    'no fallback channels were available',
    Array.isArray(routing?.fallbacksAvailable) && routing.fallbacksAvailable.length === 0,
    JSON.stringify(routing?.fallbacksAvailable),
  )
  if (routing?.planningReasoning !== undefined) console.log(`       planningReasoning: ${String(routing.planningReasoning).slice(0, 110)}`)
}

// ── 3. the pin is load-bearing (optional) ───────────────────────────────────
if (argv.includes('--negative')) {
  console.log('\n── 3. negative control (impossible channel) ──────────────')
  const gateway = String(profile.baseURL ?? '').replace(new RegExp(`^${origin}`), '')
  const upstream = process.env.CLINE_UPSTREAM ?? 'https://api.cline.bot'
  // Deliberately through the unwrapped fetch: a hook would overwrite the
  // impossible pin with the real one and prove nothing.
  const response = await nativeFetch(`${upstream}${gateway}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], providerOptions: { gateway: { only: ['__no_such_upstream__'] } } }),
  })
  const text = await response.text()
  check('an impossible pin is refused', /No available providers match the 'only' filter/.test(text), `${response.status} ${text.slice(0, 90)}`)
}

hook?.uninstall()

console.log(`\nRESULT: ${failures.length === 0 ? 'SMOKE OK' : `FAILED (${failures.join(' | ')})`}`)
process.exit(failures.length === 0 ? 0 : 2)
