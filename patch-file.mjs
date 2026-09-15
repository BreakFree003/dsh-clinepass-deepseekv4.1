/**
 * Line-oriented helpers for a profile's `cordis.patch.yml`.
 *
 * Install and uninstall both edit a user's patch file, and the only acceptable
 * outcome is that comments and unrelated entries keep their exact place — a
 * parse-and-dump would reformat the file, so everything here works on lines.
 *
 * Shape of a patch document:
 *
 *   preamble            comments/blank lines above the first entry
 *   entries             one per top-level `- ` list item, each owning the
 *                       contiguous comment run written directly above it
 *   trailer             a blank/comment run at EOF (file-level, not owned by
 *                       the last entry, so removing that entry keeps it)
 *
 * @module dsh-clinepass/patch-file
 */

/** Escape a string for use inside a regular expression. */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A pattern matching a loader row's id, tolerating quotes and trailing comments.
 *
 * @param id - the entry id (e.g. `clinepass`).
 * @returns a regular expression.
 */
export function idPattern(id) {
  return new RegExp(`^\\s*-?\\s*id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*(?:#.*)?$`)
}

/** The line ending a document uses (CRLF when it contains any). */
export function detectEol(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Split a patch document into preamble, entries and trailer.
 *
 * Lines are normalized (a trailing `\r` is dropped) and the document's own line
 * ending is returned, so a caller can render the same file back unchanged.
 *
 * @param text - the document.
 * @returns `{ preamble, entries, trailer, eol }`; an entry is `{ lines, text }`.
 */
export function parsePatch(text) {
  const eol = detectEol(text)
  const lines = String(text)
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  const starts = []
  lines.forEach((line, index) => {
    if (/^- /.test(line)) starts.push(index)
  })
  if (starts.length === 0) return { preamble: lines, entries: [], trailer: [], eol }

  const headerOf = starts.map((start) => {
    let header = start
    // Only the contiguous comment run directly above the entry: a blank line
    // ends it, which keeps the file's own preamble comment in the preamble.
    while (header - 1 >= 0 && lines[header - 1].trim().startsWith('#')) header -= 1
    return header
  })

  const entries = starts.map((start, index) => {
    const from = headerOf[index]
    const to = index + 1 < starts.length ? headerOf[index + 1] : lines.length
    const body = lines.slice(from, to)
    return { lines: body, text: body.join('\n') }
  })

  // A blank/comment run at EOF belongs to the file, not to the last entry.
  const trailer = []
  const last = entries[entries.length - 1]
  while (last.lines.length > 1) {
    const tail = last.lines[last.lines.length - 1]
    if (tail.trim() === '' || tail.trim().startsWith('#')) {
      trailer.unshift(last.lines.pop())
      continue
    }
    break
  }
  last.text = last.lines.join('\n')

  return { preamble: lines.slice(0, headerOf[0]), entries, trailer, eol }
}

/**
 * Render a patch document back to text.
 *
 * The shape is rendered verbatim: an empty array is the caller's decision (it
 * may hold a `[]` line in its preamble already), so nothing is injected here.
 * Trailing whitespace is normalized and the document ends with one line ending;
 * that is the only rewriting this pair of scripts does.
 *
 * @param shape - `{ preamble, entries, trailer }`.
 * @param eol - the line ending to write.
 * @returns the document text.
 */
export function rebuildPatch({ preamble, entries, trailer }, eol = '\n') {
  const lines = [...preamble, ...entries.flatMap((entry) => entry.lines), ...trailer]
  const text = lines
    .join(eol)
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/[ \t\r\n]*$/, '')
  return `${text}${eol}`
}
