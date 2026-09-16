#!/usr/bin/env node
/**
 * Mount dsh-clinepass into a dsh profile.
 *
 * Copies the plugin into `<DSH_HOME>/profiles/<profile>/plugins/<name>/` and
 * writes the loader row into that profile's `cordis.patch.yml` (idempotent,
 * backed up, comments preserved). Re-running upgrades the row to the current
 * canonical form.
 *
 * There is one transport: the pin is injected in-process by wrapping
 * `globalThis.fetch`, so this plugin never opens a listener. `--transport` and
 * `--port` were removed in 0.5.0 and are now refused with a pointer to the
 * status file, which is how a running install is checked.
 *
 * The provider itself — including its API-key field on Settings → Models — is
 * provisioned by the plugin on the next dsh start.
 *
 *   node install.mjs                        # ~/.dsh, profile web, in-process pin
 *   node install.mjs --dsh-home /tmp/dsh --profile headless
 *   node install.mjs --dry-run
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { idPattern, parsePatch, rebuildPatch } from './patch-file.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)

/** Read `--name value` (or a boolean when the next token is another flag). */
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const has = (name) => argv.includes(`--${name}`)

if (has('help') || has('h')) {
  console.log(`Usage: node install.mjs [options]

  --dsh-home <path>   DSH_HOME to install into   (default $DSH_HOME or ~/.dsh)
  --profile <name>    profile under it           (default web)
  --name <dir>        plugin directory name      (default dsh-clinepass)
  --no-patch          copy files only, do not touch cordis.patch.yml
  --dry-run           print what would change, write nothing

Re-running rewrites the loader row with the canonical config. Use --no-patch to
keep a hand-edited row.
`)
  process.exit(0)
}

// Removed with the loopback transport in 0.5.0: say so instead of ignoring the
// flag, because a silently ignored --port is exactly the kind of surprise this
// plugin exists to avoid.
for (const removed of ['transport', 'port']) {
  if (has(removed)) {
    console.error(`dsh-clinepass: --${removed} was removed in 0.5.0 — the loopback proxy transport is gone and the pin is injected in-process, with no listener.`)
    console.error('Drop the flag; the installer writes the portless row. Check a running install with:')
    console.error(`  cat ${path.join(String(option('dsh-home', process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))), 'dsh-clinepass-status.json')}`)
    process.exit(1)
  }
}

const dryRun = has('dry-run')
const dshHome = path.resolve(String(option('dsh-home', process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))))
const profile = String(option('profile', 'web'))
const name = String(option('name', 'dsh-clinepass'))

const profileDir = path.join(dshHome, 'profiles', profile)
if (!fs.existsSync(profileDir)) {
  console.error(`dsh-clinepass: no profile at ${profileDir}`)
  console.error(`Start it once so dsh creates the profile (e.g. \`dsh ${profile}\`), then re-run this installer.`)
  process.exit(1)
}

const targetDir = path.join(profileDir, 'plugins', name)
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
// `cordis.patch.yml` is here because the copied `package.json` references it —
// `dsh.bundle.patch` and `exports["./cordis.patch.yml"]` — so leaving it out
// ships a manifest that points at a file the directory does not contain.
const files = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'test-fetch.mjs', 'test-settings.mjs', 'test-usage.mjs', 'smoke-test.mjs']

/** The loader row: the pin is injected in-process, so nothing listens. */
const FETCH_BLOCK = `# ── dsh-clinepass ─────────────────────────────────────────────────────────
# A pin-injecting hook in front of the Cline Pass gateway. The provider itself
# is a normal pi-ai profile (llm-pi-ai.providers.cline-pass, provisioned by the
# plugin on start), which is what puts its API-key field on Settings → Models.
# Requests to the gateway have their body pinned to one upstream channel on the
# way out, in this process — no listener, no port.
- insert:
    - id: clinepass
      name: './plugins/${name}/index.js'
      config:
        upstream: https://api.cline.bot
        pin:
          - deepseek
`

const BLOCK = FETCH_BLOCK

console.log(`dsh-clinepass installer
  DSH_HOME  : ${dshHome}
  profile   : ${profile}
  plugin    : ${targetDir}
  patch     : ${patchPath}
  transport : in-process fetch hook (no listener)${dryRun ? '\n  mode      : dry run' : ''}
`)

/** Write a file with a backup beside it; returns the backup's basename. */
function writeWithBackup(file, text) {
  const backup = `${file}.bak-${stamp}`
  fs.copyFileSync(file, backup)
  fs.writeFileSync(file, text)
  return path.basename(backup)
}

// ── 1. copy the plugin files ────────────────────────────────────────────────
for (const file of files) {
  const from = path.join(HERE, file)
  if (!fs.existsSync(from)) continue
  console.log(`  ${dryRun ? 'would copy' : 'copy'} ${file} -> ${path.join(targetDir, file)}`)
  if (dryRun) continue
  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(from, path.join(targetDir, file))
}

// Files that were part of an older install and are not shipped any more. Leaving
// a stale `test-proxy.mjs` behind would document a transport that no longer
// exists (and fail when run), so it is removed — this is a fixed list, not a
// sweep of the directory.
const RETIRED_FILES = ['test-proxy.mjs']
for (const file of RETIRED_FILES) {
  const target = path.join(targetDir, file)
  if (!fs.existsSync(target)) continue
  console.log(`  ${dryRun ? 'would remove' : 'remove'} ${file} (not part of 0.5.0)`)
  if (!dryRun) fs.rmSync(target)
}

// ── 2. write the loader row ─────────────────────────────────────────────────
const rowPattern = idPattern('clinepass')

if (has('no-patch')) {
  console.log('  patch skipped (--no-patch)')
} else if (!fs.existsSync(patchPath)) {
  console.log(`  ${dryRun ? 'would create' : 'create'} ${patchPath}`)
  if (!dryRun) fs.writeFileSync(patchPath, BLOCK)
} else {
  const parsed = parsePatch(fs.readFileSync(patchPath, 'utf8'))
  const eol = parsed.eol
  const blockLines = BLOCK.replace(/\s*$/, '').split('\n')
  const at = parsed.entries.findIndex((entry) => entry.lines.some((line) => rowPattern.test(line)))

  if (at !== -1) {
    const existing = parsed.entries[at].lines.join('\n').replace(/\s*$/, '')
    const canonical = blockLines.join('\n').replace(/\s*$/, '')
    if (existing === canonical) {
      console.log('  loader row already canonical — left as is')
    } else {
      console.log(`  ${dryRun ? 'would refresh' : 'refresh'} the existing loader row (upstream/pin/comments)`)
      if (!dryRun) {
        parsed.entries[at] = { lines: blockLines, text: blockLines.join('\n') }
        console.log(`    backup: ${writeWithBackup(patchPath, rebuildPatch(parsed, eol))}`)
      }
    }
  } else {
    // Replace an empty-array literal in place — only a bare `[]` at column 0 is
    // the array it looks like; an indented `[]` is some entry's own value.
    const emptyAt = parsed.preamble.findIndex((line) => /^\[\]\s*$/.test(line))
    if (emptyAt !== -1) {
      console.log(`  ${dryRun ? 'would replace' : 'replace'} the empty patch array with the loader row`)
      if (!dryRun) {
        const separator = emptyAt > 0 && parsed.preamble[emptyAt - 1].trim() !== '' ? [''] : []
        parsed.preamble.splice(emptyAt, 1, ...separator, ...blockLines)
        console.log(`    backup: ${writeWithBackup(patchPath, rebuildPatch(parsed, eol))}`)
      }
    } else {
      console.log(`  ${dryRun ? 'would append' : 'append'} the loader row`)
      if (!dryRun) {
        parsed.entries.push({ lines: ['', ...blockLines], text: ['', ...blockLines].join('\n') })
        console.log(`    backup: ${writeWithBackup(patchPath, rebuildPatch(parsed, eol))}`)
      }
    }
  }
}

console.log(`
Next steps
  1. Restart dsh (the profile is read at startup):   Ctrl-C, then \`dsh web\`
  2. Open Settings → Models. A "Cline Pass" card appears (the plugin provisions
     it on start). Paste your Cline Pass API key there and save.
  3. Pick "Cline Pass / DeepSeek V4.1 Flash" in the model selector.

Verify
  # the running dsh writes its hook state and counters here (no listener to curl):
  cat ${path.join(dshHome, 'dsh-clinepass-status.json')}
  # hook=installed + pinned climbing = the pin is live; seen climbing without
  # pinned means requests are being skipped (the dsh log says why)
  node ${path.join(targetDir, 'test-fetch.mjs')}    # pin hook, no dsh needed
  DSH_HOME=${dshHome} node smoke-test.mjs  # from this package dir: real gateway round trip
`)
