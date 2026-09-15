# Changelog

## 0.6.0

**Distribution only — no runtime change.** The pin hook, its options and its
defaults are identical to 0.5.1; what changed is how the plugin gets mounted, so
that it can be installed straight from the repository in one command.

Added:

- **`cordis.patch.yml`, plus `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  in the manifest.** The package is now a dsh *bundle*:
  `dsh plugin --profile web add github:BreakFree003/dsh-clinepass-deepseekv4.1`
  installs it with pnpm, which then notices the declaration and appends
  `dsh-clinepass` to `dsh.profile.bundles` by itself — no clone, no hand-written
  loader row, and `dsh plugin remove dsh-clinepass` takes it back out. The row
  inside the bundle patch is the same canonical config `install.mjs` writes
  (`upstream` + `pin`), so the two install routes cannot drift.
- Repository, homepage and bugs metadata; `dsh-plugin` / `dsh-bundle` keywords.

Removed:

- **The `install` lifecycle script** (`"install": "node install.mjs"`). It was
  wrong twice over. As a dependency it would silently rewrite the *installer's*
  `$DSH_HOME` on any plain `pnpm install`, and pnpm's build gate refuses a
  git-hosted package that declares one — `ERR_PNPM_IGNORED_BUILDS`, reproduced
  here, which broke exactly the one-command install above. The installer is still
  run explicitly as `node install.mjs`.

Unchanged: `index.js`, every option and default, the status-file format, and the
`install.mjs` / `uninstall.mjs` route (still supported, and still what to use
where there is no pnpm).

## 0.5.1

**Fixes and dead-code removal from an independent adversarial review** (two
reviewers: an instrumented branch-count run plus a 28-site mutation sweep, and a
separate read of the whole file; 273 checks now, all green).

Fixed — each was reproduced before the fix:

- **A stale `content-length` could hang a request.** The `init.body` branch
  dropped it only when the caller supplied headers, while the `Request` branch
  already fell back to the input's — so a `Request` plus `init.body` forwarded
  the old length while the body grew. Both branches now fall back, and a
  three-way control (no plugin / before / after) goes from a 3 s timeout to a
  200 in ~10 ms.
- **The ownership watcher warned and rewrote the status file every 30 s
  forever**, and could never report recovery: it now acts on the state
  *transition* only — one warning per replacement, one write per change, and a
  restored native fetch is reported as `uninstalled` instead of a false
  `foreign` alarm.
- **The status file was written non-atomically**, while the README tells users to
  `cat` it and `smoke-test.mjs` `JSON.parse`s it — a read inside the truncate
  window could redden a healthy install. Now written via `.tmp` + `rename`.
- **An invalid `upstream` installed a hook and wrote a broken card**
  (`baseURL: "api.cline.bot/api/v1"`) past an error log. It is now refused
  before anything is installed or provisioned.
- **A card stranded on a loopback address stopped pinning silently**: the repair
  was gated on `api`/`apiKeyEnv` matching, so a card whose keys the user had
  renamed was never moved off the removed transport and the hook (origin
  matched) pinned nothing. The address is now repaired in that case too, and the
  log says why.
- **`displayName`, `contextWindow` and `maxTokens` were write-once**: changing
  them in the loader row did nothing to an existing card. They are repaired like
  the address is.
- **`upstream` carrying a path** produced `…/api/v1/api/v1` while the hook still
  matched by origin; the origin is now used, with a warning.
- **A stored reasoning effort was realigned for a different model** on the same
  route; the model is now part of the check (`other-model`).

Deleted — provably unreachable or write-only, verified by branch counters and by
mutating them out (no check changes behaviour):

- the redundant `Buffer.isBuffer` branch (`Buffer` is an `ArrayBuffer` view);
- the `[name, value][]` header branch (no caller, 0 hits in every suite);
- `install()`'s `current === wrapper` branch and its `original === null` guard
  (unreachable, and the only path that could ever set `globalThis.fetch = null`);
- the third `status` bag parameter and its three `Object.assign`s, plus the
  write-only `status.transport` / `profile` / `effort` fields;
- the hand-written `EFFORT_MAP` literal (derived from `EFFORT_LEVELS` now, so the
  two cannot drift).

Kept deliberately, after reviewing the reviewers' suggestions: the `calling`
re-entrancy guard (removing it turns the gateway path into a hang rather than an
error), `FETCH_MARK` unwrapping, `withoutBodyLength`, the `ignoredOptions` warn
loop, the level merge with `RETIRED_EFFORTS`, and the status file itself. The
"`apply` opens no listener" check was vacuous — it patched `http.createServer`,
which this module never imports — and is now a real process-resource probe with
its own positive control.

## 0.5.0

**The loopback proxy is gone: the plugin now opens no listener at all.** 0.3.0
stopped *using* the port by default; 0.5.0 removes the code, so a `dsh-clinepass`
install has no port to allocate, no port to free, and no second process holding
the traffic.

- **Removed**: `createPinProxy` (a reverse proxy plus its helpers), and the
  `transport`, `listen`, `captureDir`, `address` and `baseURL` options — ~330
  lines of `index.js` (1172 → 852).
- **A legacy config still boots.** Those options are read, reported once at
  boot ("`\"listen\"` is no longer used: …") and recorded as `ignoredOptions` in
  the status file, so the upgrade is visible even where plugin `warn` lines are
  not; a card left over from an older install is repaired to the gateway in the
  same write. A silently ignored option would look like it took effect, which is
  the failure mode this plugin exists to avoid, so the report is deliberate.
- **The installer refuses `--transport` / `--port`** instead of dropping them,
  with the status-file path as the replacement for the old `curl /health`.
- **`test-proxy.mjs` → `test-settings.mjs`.** The transport-independent coverage
  (option surface, provisioning, repair, the reasoning-effort migration) moved
  to its own suite; the proxy-transport tests are gone with the code. Suites:
  `node test-fetch.mjs && node test-settings.mjs && node test-install.mjs`.
- **Why it stayed this long**: it was kept as an escape hatch for the case where
  something else replaces `globalThis.fetch` (the in-process hook cannot install
  itself then). The status file now names that case (`hook: unavailable`), and
  the trade is stated in the README rather than carried as code.

## 0.4.0

**Two reasoning levels, no alias: `high` and `max`.**

- **`xhigh` is retired.** The route now declares exactly `{ high: 'high',
  max: 'max' }`, so the composer and the model card list two levels instead of
  three. `max` never needed an alias: it is a pi-ai level id a profile may
  declare, and the declared spelling is what goes on the wire
  (`thinkingLevelMap[level] ?? level`).
- **Existing cards are migrated by the provisioning repair.** A declared
  `xhigh` is dropped from the model entry while any level the user added
  themselves (e.g. `medium`) is kept, so a card written by 0.3.0 becomes the
  two-level card in one write.
- **A stored `xhigh` is not silently downgraded.** `alignReasoningEffort` now
  maps a retired id to the level it used to dispatch (`xhigh` → `max`) and only
  falls back to `high` for a value this model has never served (a typo, another
  model's level). A session saved with `xhigh` is still fixed by re-picking a
  level in the composer.
- Docs (`README.md`) updated: two levels, and what the boot repair does to an
  old card and to an old `agent-default-model.reasoningEffort`.

## 0.3.0

**The listener is gone by default: the pin is injected in-process.** The old
reverse proxy remains as an opt-in escape hatch (`transport: proxy`).

- **New default `transport: fetch`**: the plugin wraps `globalThis.fetch` and
  rewrites the body of this gateway's `chat/completions` calls on the way out.
  No socket, no port, no second copy of the traffic. Justification, verified
  against the installed bundles: pi-ai builds a **new OpenAI client per request**
  (`api/openai-completions.js` → `createClient`, `fetch: options?.fetch`), the
  SDK then resolves `options.fetch ?? globalThis.fetch`, and `dsh-llm-pi-ai`
  never passes `fetch` — so the global is what actually carries the request, and
  a wrapper installed at boot is what carries every request after it.
- **Scoped to the gateway origin.** A global hook sees *every* provider's
  traffic, and `providerOptions` is not a field every OpenAI-compatible API
  accepts, so only URLs whose origin matches `upstream` and whose path is
  `/chat/completions` are considered; everything else is handed to the original
  fetch with the original arguments, synchronously and unmodified.
- **A silent bypass is made visible**: the running process writes
  `<DSH_HOME>/dsh-clinepass-status.json` with `hook` (`installed` /
  `unavailable` / `uninstalled` / `foreign`), `seen` / `pinned` / `skipped`
  counters and the last pin. Plugin `info` lines are not shown by every dsh
  front end, so without this a hook that stopped firing would look healthy. An
  installed hook re-checks `globalThis.fetch` every 30 seconds, so a post-install
  replacement by another plugin turns into `hook: "foreign"` instead of a frozen
  `installed`; only the instance that currently owns the global publishes, so a
  reload's older instance cannot overwrite the live record.
  `statusFile: false` (or a custom path) is supported; the file holds no
  credentials.
- **The profile migrates itself**: `provisionProfile` now takes the base URL from
  `apply()` (the gateway origin on `fetch`, the bound listener on `proxy`), so an
  install coming from 0.2.0 has its card repaired from
  `http://127.0.0.1:8791/api/v1` to `https://api.cline.bot/api/v1` at the next
  start — verified end to end through a real dsh run.
- **Hook lifecycle**: installing twice cannot grow a chain of wrappers (a marked
  wrapper is unwrapped back to the real fetch, so a reload restores the original
  in one step), re-installing an installed hook is a no-op, a fetch replaced by
  someone else after us is left alone on uninstall, a missing global fetch is
  reported instead of guessed at, and any error inside the hook degrades to an
  ordinary unpinned request. A synchronous throw from a wrapped function is
  turned into a rejected promise, because that is what `fetch` does; a wrapped
  function that calls `globalThis.fetch` synchronously (which would otherwise
  re-enter the hook forever and starve the event loop) is refused with a clear
  error.
- **A `listen` value that only the proxy transport uses is no longer parsed
  eagerly**: a malformed leftover in a loader row used to abort `apply()` on the
  `fetch` transport, and is now reported through the provisioning outcome
  instead. An `upstream` that is not a URL, and a per-model `pins` entry of `[]`
  that silently disables pinning while `pin` is set, are both reported at boot.
- `install.mjs` writes the canonical portless row by default; `--port` now
  implies `--transport proxy`, and `--transport` selects it explicitly.
  `test-install.mjs` covers the round trip between both row shapes.
- `smoke-test.mjs` verifies the live process through the status file (with a pid
  liveness check, so a record left by a finished run cannot be mistaken for a
  live hook), asserts nothing is listening on the old proxy port, and runs its
  own pinned turn through the real gateway.
- **`reasoningEffort: max` is a first-class level.** `max` is part of pi-ai's own
  escalation order (`off/minimal/low/medium/high/xhigh/max`) and a profile may
  declare it, so the declared levels are `{ high: high, xhigh: max, max: max }` —
  `xhigh` kept as the older alias, both dispatching `reasoning_effort: "max"`.
  Every value any generation of this plugin wrote is therefore valid and nothing
  is rewritten; a level the model does not declare is realigned to `high`, instead
  of the previous special-cased `max → xhigh`.
- **The repair reaches profiles that already exist.** `provisionProfile` used to
  maintain only `baseURL`, so a newly declared level (or a model entry that went
  missing) never reached an install that already had the card. It now reconciles
  the model entry's declared levels as well — merging rather than replacing, so a
  level the user added themselves survives — in the same single write as the
  address repair, and reports `repaired`.
- Added `test-fetch.mjs`: URL scoping, pass-through fidelity (argument identity),
  install/uninstall/reload/foreign-replacement semantics, per-model and empty
  pins, body shapes (string, Buffer, typed array, ArrayBuffer, stream, `Request`),
  robustness (throwing getters, upstream rejections, synchronous throws), the
  status file, and an integration pass through the real `fetch` against local
  servers with a negative control.

## 0.2.0

The route now lives where dsh can render it, so **the API key is entered on
Settings → Models**.

- **Architecture change**: the Cline Pass route is a plain pi-ai provider
  profile (`llm-pi-ai.providers.cline-pass`) instead of a custom `LlmAdapter`.
  The Models page renders a native key field only for the `llm-pi-ai` /
  `llm-deepseek` namespaces (`layoutOf`), and disables Save for anything else —
  a custom settings namespace could only ever show "edit settings.yaml".
  Streaming, tool calls, reasoning, usage and images now ride pi-ai's own,
  already-verified path.
- **The plugin is now a pin-injecting reverse proxy** (`127.0.0.1:8791` by
  default): it adds `providerOptions.gateway.only` to chat bodies and forwards
  everything else byte-for-byte, including streaming responses.
- **Zero dependencies**: only Node built-ins, so the proxy is one auditable file
  and the tests run without dsh's `node_modules`.
- **Self-provisioning**: on start the plugin creates the provider profile when it
  is absent and repairs a stale `baseURL` when the profile is recognisably ours;
  a profile that is not ours is left alone and reported through `/health`.
- **Hardened request path**: a client that dies mid-upload can no longer surface
  an unhandled rejection into dsh's fatal handler; chunked request bodies are
  accepted; a junk `providerOptions` value can no longer be spread into an
  object; a mid-stream upstream failure closes the connection instead of
  appending prose to the SSE body; response writes honour backpressure
  (measured: 64 KB buffered for a 6 MB body, against 5.6 MB before the fix).
- **Migrates a stored reasoning effort** the new route cannot serve: the adapter
  generation offered a level literally named `max`, which pi-ai rejects, so a
  leftover `agent-default-model.reasoningEffort: max` is realigned to `xhigh`
  (the same value on the wire) at boot. Disable with
  `alignReasoningEffort: false`.
- **`/health`** endpoint reporting the pin, the reachable address, the
  provisioning outcome and the effort alignment.
- Optional **`captureDir`** to dump request/response pairs for wire debugging.
- **Installer/uninstaller** are idempotent, back up before writing, and restore
  `cordis.patch.yml` byte-for-byte across the awkward shapes it can (an `[]`
  literal, entries with their own comment headers, CRLF line endings); two
  normalizations are documented — a file with no array at all gains `[]` and a
  file with no final line ending gains one. The settings
  surgery drops `providers.cline-pass` without touching a comment that documents
  the next provider or a sibling key.
- Added `test-proxy.mjs` (13 sections), `test-install.mjs`, `smoke-test.mjs`,
  `patch.example.yml`, README (中文 / English), LICENSE.

## 0.1.0

First cut: a self-contained `LlmAdapter` for provider `cline-pass`, pinned with
`providerOptions.gateway.only = ["deepseek"]`, key from the credential store.
Worked, but its configuration surface was inert (the `installSection`
`setSource` hook hands over a getter, which was fed to the defaults helper as a
value), and the Models page could not offer a key field for a custom settings
namespace. Superseded by 0.2.0; the adapter generation is kept in the
verification workspace under `legacy-adapter-plugin/`.
