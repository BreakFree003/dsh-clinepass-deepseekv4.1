#!/usr/bin/env node
/**
 * Unmount dsh-clinepass.
 *
 * Removes the loader row from `cordis.patch.yml` (backed up), deletes the plugin
 * directory, and — unless `--keep-provider` — removes the
 * `llm-pi-ai.providers.cline-pass` profile the plugin provisioned. Leaving that
 * profile behind would leave a route nobody injects the pin into any more, so
 * removing it is the default.
 *
 * Both edits are line surgery, not parse-and-dump: every comment and unrelated
 * key keeps its exact place. Two normalizations are possible and documented:
 * a patch file with no array at all gains `[]`, and a file with no final line
 * ending gains one.
 *
 *   node uninstall.mjs
 *   node uninstall.mjs --keep-provider        # leave the provider card in place
 *   node uninstall.mjs --dry-run
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectEol, escapeRegExp, idPattern, parsePatch, rebuildPatch } from './patch-file.mjs'

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
  console.log(`Usage: node uninstall.mjs [options]

  --dsh-home <path>   DSH_HOME to uninstall from (default $DSH_HOME or ~/.dsh)
  --profile <name>    profile under it          (default web)
  --name <dir>        plugin directory name     (default dsh-clinepass)
  --provider <id>     provisioned provider id   (default cline-pass)
  --keep-provider     do not touch settings.yaml
  --dry-run           print what would change, write nothing
`)
  process.exit(0)
}

const dryRun = has('dry-run')
const dshHome = path.resolve(String(option('dsh-home', process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))))
const profile = String(option('profile', 'web'))
const name = String(option('name', 'dsh-clinepass'))
const provider = String(option('provider', 'cline-pass'))

const profileDir = path.join(dshHome, 'profiles', profile)
const targetDir = path.join(profileDir, 'plugins', name)
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const settingsPath = path.join(dshHome, 'settings.yaml')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

console.log(`dsh-clinepass uninstaller
  DSH_HOME : ${dshHome}
  profile  : ${profile}
  plugin   : ${targetDir}
  provider : ${provider}${dryRun ? '\n  mode     : dry run' : ''}
`)

// ── 1. drop the loader row ──────────────────────────────────────────────────
const rowPattern = idPattern('clinepass')

if (!fs.existsSync(patchPath)) {
  console.log('  no cordis.patch.yml — nothing to unmount')
} else {
  const current = fs.readFileSync(patchPath, 'utf8')
  const parsed = parsePatch(current)
  const eol = parsed.eol
  const keep = parsed.entries.filter((entry) => !entry.lines.some((line) => rowPattern.test(line)))
  if (keep.length === parsed.entries.length) {
    console.log('  no `clinepass` row found — nothing to remove')
  } else {
    const backup = `${patchPath}.bak-${stamp}`
    console.log(`  ${dryRun ? 'would remove' : 'remove'} the loader row and its comment header (backup: ${path.basename(backup)})`)
    if (!dryRun) {
      fs.copyFileSync(patchPath, backup)
      // With no entries left the document must still be a YAML array; the blank
      // line that separated the removed entry goes with it.
      const preamble = [...parsed.preamble]
      while (preamble.length > 0 && preamble[preamble.length - 1].trim() === '') preamble.pop()
      const shaped = keep.length === 0 ? { ...parsed, entries: keep, preamble: [...preamble, '[]'] } : { ...parsed, entries: keep }
      fs.writeFileSync(patchPath, rebuildPatch(shaped, eol))
    }
  }
}

// ── 2. delete the plugin directory ──────────────────────────────────────────
if (fs.existsSync(targetDir)) {
  console.log(`  ${dryRun ? 'would delete' : 'delete'} ${targetDir}`)
  if (!dryRun) fs.rmSync(targetDir, { recursive: true, force: true })
} else {
  console.log('  plugin directory already absent')
}

// ── 3. drop the provisioned provider profile ────────────────────────────────
if (has('keep-provider')) {
  console.log('  provider profile left in place (--keep-provider)')
} else {
  console.log(`  ${removeProvider(settingsPath, provider, dryRun)}`)
}

/** Indentation of a line, or undefined when it is blank or a comment. */
function indentOf(line) {
  if (line.trim() === '' || line.trim().startsWith('#')) return undefined
  return line.match(/^ */)[0].length
}

/**
 * Index of the first meaningful line at or after `from` whose indent is at most
 * `indent`; `limit` when there is none.
 */
function endOfBlock(lines, from, indent, limit) {
  for (let i = from; i < limit; i += 1) {
    const current = indentOf(lines[i])
    if (current !== undefined && current <= indent) return i
  }
  return limit
}

/**
 * Remove `llm-pi-ai.providers.<provider>` from settings.yaml by line surgery.
 *
 * The whole `providers:` dict is dropped only when this was its last entry. A
 * comment written directly above the removed provider goes with it; a comment
 * above the *next* provider stays with that provider.
 *
 * @param file - settings.yaml path.
 * @param provider - the provider key to drop.
 * @param dry - when true, report only.
 * @returns a human-readable outcome.
 */
function removeProvider(file, provider, dry) {
  if (!fs.existsSync(file)) return `no ${path.basename(file)} — skipped`
  const text = fs.readFileSync(file, 'utf8')
  const eol = detectEol(text)
  const lines = text.split('\n')
  const base = path.basename(file)

  const ns = lines.findIndex((line) => /^llm-pi-ai:\s*$/.test(line))
  if (ns === -1) return `no llm-pi-ai section in ${base} — skipped`
  const nsEnd = endOfBlock(lines, ns + 1, 0, lines.length)

  let providers = -1
  let providersIndent = 0
  for (let i = ns + 1; i < nsEnd; i += 1) {
    const match = /^(\s*)providers:\s*$/.exec(lines[i])
    if (match !== null) {
      providers = i
      providersIndent = match[1].length
      break
    }
  }
  if (providers === -1) return `no providers dict in llm-pi-ai — skipped`
  const providersEnd = endOfBlock(lines, providers + 1, providersIndent, nsEnd)

  const keyPattern = new RegExp(`^(\\s*)${escapeRegExp(provider)}:\\s*$`)
  let start = -1
  let entryIndent = 0
  for (let i = providers + 1; i < providersEnd; i += 1) {
    const match = keyPattern.exec(lines[i])
    if (match !== null && match[1].length > providersIndent) {
      start = i
      entryIndent = match[1].length
      break
    }
  }
  if (start === -1) return `provider "${provider}" is not in ${base} — skipped`

  // A comment block directly above the entry documents that entry, so it leaves
  // with it (the mirror of the "next provider's comment stays" rule). The end
  // scan still walks from the key line itself.
  const keyLine = start
  while (start - 1 > providers && lines[start - 1].trim().startsWith('#') && lines[start - 1].match(/^ */)[0].length > providersIndent) {
    start -= 1
  }

  // The entry runs through every deeper-indented line, and through a blank or
  // comment line only when the next meaningful line is still deeper — otherwise
  // that comment introduces whatever comes next and must stay.
  let end = keyLine + 1
  while (end < providersEnd) {
    const current = indentOf(lines[end])
    if (current === undefined) {
      let next = end
      while (next < providersEnd && indentOf(lines[next]) === undefined) next += 1
      if (next >= providersEnd || indentOf(lines[next]) <= entryIndent) break
      end = next
      continue
    }
    if (current > entryIndent) {
      end += 1
      continue
    }
    break
  }

  const leftovers = lines
    .slice(providers + 1, providersEnd)
    .filter((line, index) => {
      const absolute = providers + 1 + index
      return (absolute < start || absolute >= end) && indentOf(line) !== undefined
    })
  const dropDict = leftovers.length === 0
  const from = dropDict ? providers : start
  const to = dropDict ? providersEnd : end

  const next = [...lines.slice(0, from), ...lines.slice(to)]
  const removed = `${lines.slice(from, to).join('\n')}${eol}`.length
  const backup = `${file}.bak-${stamp}`
  if (!dry) {
    fs.copyFileSync(file, backup)
    fs.writeFileSync(file, next.join('\n'))
  }
  return `${dry ? 'would remove' : 'removed'} llm-pi-ai.providers.${provider}${dropDict ? ' (and the now-empty providers dict)' : ''} (${removed} bytes, backup ${path.basename(backup)})`
}

console.log('\nRestart dsh to finish. The "Cline Pass" card disappears from Settings → Models.')
