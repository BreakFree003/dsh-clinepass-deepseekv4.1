/**
 * Install / uninstall round-trip tests.
 *
 * Both scripts edit user files by line surgery, so the thing that matters is
 * that they are idempotent and that install → uninstall puts the file back
 * exactly as it was — including every comment, and including the awkward shapes
 * (an empty-array literal, a provider that is the only key in its dict, a
 * comment documenting the next provider, a quoted entry id, CRLF endings).
 * Two normalizations are expected and asserted as such: a patch file with no
 * array at all gains `[]`, and a file with no final line ending gains one.
 *
 * Run: node test-install.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clinepass-install-'))

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

let seq = 0
/**
 * Materialize a DSH_HOME with one profile and return paths plus a runner.
 *
 * @param patch - cordis.patch.yml content (or undefined to omit the file).
 * @param settings - settings.yaml content (or undefined to omit the file).
 */
function home({ patch, settings } = {}) {
  const dir = path.join(ROOT, `home-${++seq}`)
  fs.mkdirSync(path.join(dir, 'profiles', 'web'), { recursive: true })
  const patchPath = path.join(dir, 'profiles', 'web', 'cordis.patch.yml')
  const settingsPath = path.join(dir, 'settings.yaml')
  if (patch !== undefined) fs.writeFileSync(patchPath, patch)
  if (settings !== undefined) fs.writeFileSync(settingsPath, settings)
  const run = (script, ...args) =>
    execFileSync(process.execPath, [path.join(HERE, script), '--dsh-home', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    dir,
    patchPath,
    settingsPath,
    read: (file) => fs.readFileSync(file, 'utf8'),
    install: (...args) => run('install.mjs', ...args),
    uninstall: (...args) => run('uninstall.mjs', ...args),
    exists: (file) => fs.existsSync(file),
  }
}

// ── 1. install → uninstall restores the patch file ──────────────────────────
console.log('\n── 1. patch round trips ──────────────────────────────────')
const PATCH_CASES = [
  ['empty array literal', '# my patch layer\n[]\n'],
  ['comments only', '# just comments\n# and more\n'],
  ['empty file', ''],
  ['one existing entry', '# existing layer\n- id: web\n  config:\n    searchProvider: exa\n'],
  [
    'several entries with their own comments',
    '# layer one\n- id: web\n  config:\n    searchProvider: exa\n\n# layer two\n- id: agent-default-model\n  config:\n    provider: deepseek\n',
  ],
  ['no trailing newline', '# tight\n- id: web\n  config:\n    a: 1'],
]
for (const [label, patch] of PATCH_CASES) {
  const h = home({ patch })
  const before = h.read(h.patchPath)
  h.install()
  const installed = h.read(h.patchPath)
  check(`${label}: the row was added`, /id: clinepass/.test(installed))
  h.install()
  check(`${label}: install is idempotent`, (h.read(h.patchPath).match(/id: clinepass/g) ?? []).length === 1)
  h.uninstall()
  const after = h.read(h.patchPath)
  // Two normalize rather than restore: a file with no array at all gains the
  // `[]` shell (it has to be a valid patch document), and a file with no final
  // newline gains one.
  const normalized = label === 'comments only' || label === 'empty file' ? `${before.replace(/\s*$/, '')}\n[]\n` : `${before.replace(/\s*$/, '')}\n`
  const extra = label === 'empty file' ? '[]\n' : undefined
  const ok = after === before || after === normalized || (extra !== undefined && after === extra)
  check(`${label}: uninstall restores the file`, ok, after === before ? 'byte-identical' : JSON.stringify(after))
  check(`${label}: comments survive`, !before.includes('#') || after.includes(before.split('\n').find((line) => line.startsWith('#'))), JSON.stringify(after))
}

// ── 2. the loader row is removed, not just commented out ────────────────────
console.log('\n── 2. removal is surgical ────────────────────────────────')
{
  const h = home({ patch: '# existing layer\n- id: web\n  config:\n    searchProvider: exa\n' })
  h.install()
  h.uninstall()
  check('the neighbour entry survives', /- id: web[\s\S]*searchProvider: exa/.test(h.read(h.patchPath)), JSON.stringify(h.read(h.patchPath)))
  check('no clinepass comment header is left behind', !h.read(h.patchPath).includes('dsh-clinepass'), JSON.stringify(h.read(h.patchPath)))
}

// ── 3. settings.yaml surgery ────────────────────────────────────────────────
console.log('\n── 3. provider removal from settings.yaml ────────────────')

const SETTINGS_TAIL = `ui-conversation:
  busyEnter: steer
`
{
  // cline-pass is the only provider: the whole dict goes, nothing dangles.
  const h = home({
    patch: '[]\n',
    settings: `llm-pi-ai:\n  providers:\n    cline-pass:\n      apiKeyEnv: CLINE_PASS_API_KEY\n      api: openai-completions\n      baseURL: http://127.0.0.1:8791/api/v1\n      models:\n        - id: cline-pass/deepseek-v4.1-flash\n${SETTINGS_TAIL}`,
  })
  h.uninstall()
  const after = h.read(h.settingsPath)
  check('only-provider case removes the profile', !after.includes('cline-pass'), JSON.stringify(after))
  check('only-provider case drops the empty dict', !/providers:/.test(after), JSON.stringify(after))
  check('the following top-level key survives', after.includes('ui-conversation:'), JSON.stringify(after))
}
{
  // The comment above the NEXT provider belongs to that provider.
  const h = home({
    patch: '[]\n',
    settings: `llm-pi-ai:\n  providers:\n    cline-pass:\n      apiKeyEnv: CLINE_PASS_API_KEY\n      baseURL: http://127.0.0.1:8791/api/v1\n    # ── the user's own DeepSeek route ──\n    deepseek:\n      apiKeyEnv: DEEPSEEK_API_KEY\n${SETTINGS_TAIL}`,
  })
  h.uninstall()
  const after = h.read(h.settingsPath)
  check('the next provider survives', after.includes('deepseek:\n      apiKeyEnv: DEEPSEEK_API_KEY'), JSON.stringify(after))
  check("the next provider's comment survives", after.includes("the user's own DeepSeek route"), JSON.stringify(after))
  check('the removed provider is gone', !after.includes('cline-pass'), JSON.stringify(after))
}
{
  // A sibling key of `providers` must not be dragged out with the dict.
  const h = home({
    patch: '[]\n',
    settings: `llm-pi-ai:\n  providers:\n    cline-pass:\n      apiKeyEnv: CLINE_PASS_API_KEY\n      baseURL: http://127.0.0.1:8791/api/v1\n  defaultContextWindow: 128000\n${SETTINGS_TAIL}`,
  })
  h.uninstall()
  const after = h.read(h.settingsPath)
  check('a sibling key after providers survives', after.includes('defaultContextWindow: 128000'), JSON.stringify(after))
  check('the empty providers dict is dropped', !/providers:/.test(after), JSON.stringify(after))
}
{
  // --keep-provider leaves settings.yaml alone.
  const settings = `llm-pi-ai:\n  providers:\n    cline-pass:\n      baseURL: http://127.0.0.1:8791/api/v1\n`
  const h = home({ patch: '[]\n', settings })
  h.uninstall('--keep-provider')
  check('--keep-provider leaves settings.yaml untouched', h.read(h.settingsPath) === settings)
}
{
  // Comments elsewhere in the file are never collateral damage.
  const h = home({
    patch: '[]\n',
    settings: `# top comment\nllm-pi-ai:\n  # inner comment\n  providers:\n    cline-pass:\n      baseURL: http://127.0.0.1:8791/api/v1\n    other:\n      baseURL: https://x.test/v1\n# bottom comment\n`,
  })
  h.uninstall()
  const after = h.read(h.settingsPath)
  check('comments outside the entry survive', after.includes('# top comment') && after.includes('# inner comment') && after.includes('# bottom comment'), JSON.stringify(after))
  check('the other provider survives', after.includes('other:\n      baseURL: https://x.test/v1'), JSON.stringify(after))
}

// ── 4. the plugin directory is removed ─────────────────────────────────────
console.log('\n── 4. plugin directory ───────────────────────────────────')
{
  const h = home({ patch: '[]\n' })
  h.install()
  const dir = path.join(h.dir, 'profiles', 'web', 'plugins', 'dsh-clinepass')
  check(
    'install copies the plugin',
    ['index.js', 'package.json', 'test-fetch.mjs', 'test-settings.mjs', 'smoke-test.mjs'].every((file) => fs.existsSync(path.join(dir, file))),
    fs.readdirSync(dir).join(' '),
  )
  check('…and copies no proxy transport', !fs.readdirSync(dir).some((file) => file.includes('proxy')), fs.readdirSync(dir).join(' '))
  h.uninstall()
  check('uninstall deletes the plugin directory', !fs.existsSync(dir))
  check('a backup of the patch file exists', fs.readdirSync(path.join(h.dir, 'profiles', 'web')).some((file) => file.startsWith('cordis.patch.yml.bak-') && !file.endsWith('.')))
}

// ── 5. the canonical row is portless, and upgrades take effect ──────────────
console.log('\n── 5. canonical rows / upgrades ──────────────────────────')
{
  const h = home({ patch: '# my layer\n[]\n' })
  h.install()
  const row = h.read(h.patchPath)
  check('the canonical row sets no transport', !/transport:/.test(row), JSON.stringify(row))
  check('the canonical row opens no listener', !/listen:/.test(row), JSON.stringify(row))
  check('the canonical row still names the gateway and the pin', /upstream: https:\/\/api\.cline\.bot/.test(row) && /- deepseek/.test(row))
  h.install()
  check('re-installing is idempotent', (h.read(h.patchPath).match(/id: clinepass/g) ?? []).length === 1)

  // The removed flags are refused rather than ignored: a silently dropped
  // `--port` would look like it took effect.
  for (const removed of [['--port', '8801'], ['--transport', 'proxy'], ['--transport', 'fetch'], ['--transport', 'fetchy']]) {
    let threw = null
    try {
      h.install(...removed)
    } catch (error) {
      threw = error
    }
    check(`${removed.join(' ')} is refused`, threw !== null, threw === null ? 'exit 0' : 'exit non-zero')
  }
  check('…and the row is still the canonical portless one', !/transport:/.test(h.read(h.patchPath)) && !/listen:/.test(h.read(h.patchPath)), JSON.stringify(h.read(h.patchPath)))
}
{
  // A legacy 0.1.0 row (baseURL/displayName/apiKeyEnv, no upstream) is upgraded.
  const legacy = `- insert:\n    - id: clinepass\n      name: './plugins/dsh-clinepass/index.js'\n      config:\n        displayName: Cline Pass\n        apiKeyEnv: CLINE_PASS_API_KEY\n        baseURL: https://api.cline.bot/api/v1\n        pin:\n          - deepseek\n`
  const h = home({ patch: legacy })
  h.install()
  const after = h.read(h.patchPath)
  check('a legacy row is upgraded to the canonical config', !/baseURL:/.test(after) && !/listen:/.test(after) && /pin:\n          - deepseek/.test(after), JSON.stringify(after))
  check('upgrading keeps exactly one row', (after.match(/id: clinepass/g) ?? []).length === 1)
}

// ── 6. awkward patch shapes ─────────────────────────────────────────────────
console.log('\n── 6. awkward patch shapes ───────────────────────────────')
{
  // An indented `[]` is some entry's own list value, not the patch array.
  const shape = `- id: web\n  config:\n    blockedTools:\n      []\n`
  const h = home({ patch: shape })
  h.install()
  check('an indented [] value is untouched', h.read(h.patchPath).includes('      []'), JSON.stringify(h.read(h.patchPath)))
  check('the row was still added', /id: clinepass/.test(h.read(h.patchPath)))
}
{
  // `[]` followed by a trailing comment must not be reordered or lost.
  const h = home({ patch: '[]\n# tail comment\n' })
  h.install()
  h.uninstall()
  check('[] plus a trailing comment round-trips', h.read(h.patchPath) === '[]\n# tail comment\n', JSON.stringify(h.read(h.patchPath)))
}
{
  // A quoted id is the same row.
  const quoted = `- insert:\n    - id: 'clinepass'\n      name: './plugins/dsh-clinepass/index.js'\n      config:\n        listen: 127.0.0.1:8791\n`
  const h = home({ patch: quoted })
  h.install()
  check('a quoted id is recognised (no duplicate row)', (h.read(h.patchPath).match(/id: ['"]?clinepass/g) ?? []).length === 1, JSON.stringify(h.read(h.patchPath)))
}
{
  // CRLF files keep their line endings.
  const crlf = '# my layer\r\n[]\r\n'
  const h = home({ patch: crlf })
  h.install()
  check('install writes CRLF into a CRLF file', h.read(h.patchPath).includes('\r\n'), JSON.stringify(h.read(h.patchPath).slice(0, 60)))
  h.uninstall()
  check('CRLF round-trips byte-for-byte', h.read(h.patchPath) === crlf, JSON.stringify(h.read(h.patchPath)))
}

// ── 7. settings surgery: a comment above the removed provider ───────────────
console.log('\n── 7. comment above the removed provider ─────────────────')
{
  const h = home({
    patch: '[]\n',
    settings: `llm-pi-ai:\n  providers:\n    # ── ours, generated ──\n    cline-pass:\n      apiKeyEnv: CLINE_PASS_API_KEY\n      baseURL: http://127.0.0.1:8791/api/v1\n    deepseek:\n      apiKeyEnv: DEEPSEEK_API_KEY\n`,
  })
  h.uninstall()
  const after = h.read(h.settingsPath)
  check('the comment above the removed provider goes with it', !after.includes('ours, generated'), JSON.stringify(after))
  check('the next provider survives', after.includes('deepseek:'), JSON.stringify(after))
}
{
  // --provider must be treated literally, not as a pattern.
  const settings = `llm-pi-ai:\n  providers:\n    a.b:\n      baseURL: http://one.test/v1\n    axb:\n      baseURL: http://two.test/v1\n    keep:\n      baseURL: http://three.test/v1\n`
  const h = home({ patch: '[]\n', settings })
  h.uninstall('--provider', 'a.b')
  const after = h.read(h.settingsPath)
  check('a dotted provider name is escaped', after.includes('axb:') && !after.includes('a.b:'), JSON.stringify(after))
  check('an unrelated provider survives', after.includes('keep:'), JSON.stringify(after))
}
{
  const h = home({ patch: '[]\n', settings: `llm-pi-ai:\n  providers:\n    keep:\n      baseURL: http://x.test/v1\n` })
  let threw = null
  try {
    h.uninstall('--provider', '[')
  } catch (error) {
    threw = error
  }
  check('a regex-metacharacter provider name does not crash', threw === null, threw === null ? 'ok' : String(threw))
}

console.log(`\nRESULT: ${failures.length === 0 ? 'INSTALL OK' : `FAILED (${failures.join(' | ')})`}`)
fs.rmSync(ROOT, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 2)
