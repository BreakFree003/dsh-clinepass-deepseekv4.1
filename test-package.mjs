/**
 * Packaging invariants — the things that make the two install routes safe to
 * point people at.
 *
 * The plugin can be mounted as a dsh *bundle* (`dsh plugin --profile web add
 * github:...`, which reads this package's own `cordis.patch.yml`) or by
 * `install.mjs` (which writes a row into the profile's patch file). Both must
 * describe the same mount, or "install it either way" quietly means two
 * different installs.
 *
 * Deliberately parser-free and dsh-free: this package ships no dependencies and
 * this file must run anywhere, and both documents are a single `- insert:` row.
 *
 * Each invariant guarded here was a real bug or a real trap:
 *   - the `install` lifecycle script made pnpm refuse a git-hosted install
 *     (`ERR_PNPM_IGNORED_BUILDS`) and would have rewritten the *host's*
 *     `$DSH_HOME` on any plain `pnpm install`;
 *   - a bundle patch missing from `files` turns a working repo install into a
 *     broken tarball;
 *   - a bundle row that drifts from the installer row is invisible until a user
 *     reports a config that does not apply.
 *
 * Run: node test-package.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
const read = (file) => fs.readFileSync(path.join(HERE, file), 'utf8')

// ── 1. the bundle declaration ───────────────────────────────────────────────
console.log('\n── 1. bundle declaration ─────────────────────────────────')
const declared = manifest.dsh?.bundle?.patch
check('the manifest declares dsh.bundle.patch', declared === './cordis.patch.yml', String(declared))
check('the declared patch exists', typeof declared === 'string' && fs.existsSync(path.join(HERE, declared)))
check('the patch is in "files", so a tarball ships it', (manifest.files ?? []).includes('cordis.patch.yml'), JSON.stringify(manifest.files ?? []))
check('the entry point the manifest names exists', typeof manifest.main === 'string' && fs.existsSync(path.join(HERE, manifest.main)), String(manifest.main))

// ── 2. nothing that runs on someone else's machine ──────────────────────────
console.log('\n── 2. no lifecycle scripts ───────────────────────────────')
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) {
  check(`no ${hook} script`, manifest.scripts?.[hook] === undefined, String(manifest.scripts?.[hook]))
}
check('no runtime dependencies', Object.keys(manifest.dependencies ?? {}).length === 0, JSON.stringify(manifest.dependencies ?? {}))
check('no peer dependencies', Object.keys(manifest.peerDependencies ?? {}).length === 0, JSON.stringify(manifest.peerDependencies ?? {}))

// ── 3. version and changelog agree ──────────────────────────────────────────
console.log('\n── 3. version ────────────────────────────────────────────')
const top = /^## (\S+)/m.exec(read('CHANGELOG.md'))
check('the changelog has a version section', top !== null)
check('the top changelog section is the manifest version', top?.[1] === manifest.version, `changelog ${top?.[1]} vs manifest ${manifest.version}`)

// ── 4. the bundle row and the installer row describe one mount ──────────────
console.log('\n── 4. bundle patch parity ────────────────────────────────')
/** Lines that carry meaning: no blanks, no comments, no trailing space. */
const meaningful = (text) =>
  text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
const bundleLines = meaningful(read('cordis.patch.yml'))
const block = /const FETCH_BLOCK = `([\s\S]*?)`\n/.exec(read('install.mjs'))
check('install.mjs still has a FETCH_BLOCK to compare against', block !== null)
if (block !== null) {
  const installerLines = meaningful(block[1])
  // The one permitted difference is the module specifier: the bundle resolves its
  // own bare package name, the installer points at the file it copied.
  const specifierNeutral = (lines) => lines.map((line) => (line.trim().startsWith('name:') ? '  name: <row>' : line))
  check(
    'both rows carry the same config',
    JSON.stringify(specifierNeutral(bundleLines)) === JSON.stringify(specifierNeutral(installerLines)),
    JSON.stringify(bundleLines),
  )
  check('the bundle row mounts the same id as the installer', bundleLines.includes('    - id: clinepass') && installerLines.includes('    - id: clinepass'))
  check('the bundle row names the bare package', bundleLines.includes('      name: dsh-clinepass'), JSON.stringify(bundleLines))
}
check('the row is an insert, not a disable/override', bundleLines[0] === '- insert:', bundleLines[0])

console.log(`\nRESULT: ${failures.length === 0 ? 'PACKAGE OK' : `FAILED (${failures.join(' | ')})`}`)
process.exit(failures.length === 0 ? 0 : 2)
