# pi-config-gui

A local web app for editing the config files of
[pi](https://pi.dev), the terminal coding agent — specifically its two agent
documents, `models.json` (custom providers and models) and `auth.json`
(stored API keys). It opens in your browser, points at your pi agent
directory, and lets you wire up a local endpoint — Ollama, LM Studio, vLLM,
a llama.cpp router, anything OpenAI-compatible — with a preset, a live probe
and a checkbox import of the models actually serving, while keeping your
file's comments and formatting intact.

A sister app to
[opencode-config-gui](https://github.com/Jumpywizard77/Opencode-config-gui); same
save-integrity machinery, different config universe.

## Why

Connecting a self-hosted model server to pi means hand-writing a provider
block in `models.json`: the right `baseUrl`, the right `api` string, a
placeholder `apiKey`, and one entry per model with `contextWindow`/`maxTokens`
guesswork. Meanwhile `auth.json` is a file full of live credentials that
careless editors reformat or clobber while pi is running. This tool:

- **Keeps your files yours.** It edits JSONC *in place*: comments, key
  order and formatting survive round-trips (only the regions you touch
  change).
- **Edits exactly two documents.** `models.json` gets the full editor;
  `auth.json` gets a key editor with rebase-safe saves. `settings.json`,
  `mcp.json` and `keybindings.json` are detected and listed read-only —
  never edited, never written.
- **Validates before saving**, against pi's published `models.json` schema
  (refreshed from pi.dev, cached on disk, vendored fallback for offline),
  and refuses writes that would introduce *new* errors into an otherwise
  valid file.
- **Backs up every save** next to your config and writes atomically, so a
  crash mid-save cannot leave a half-written config.
- **Probes your server** (`{baseUrl}/models`) and imports what it really
  serves, merging by model ID — entries you already tuned are never touched.

It never copies your keys anywhere else, never logs them, and never sends
them anywhere except the provider endpoint you explicitly ask it to probe.

**Heads-up:** after saving, run `/model` (or `/reload`) in pi to pick changes
up.

## Quick start

```
npx pi-config-gui
```

That starts a server bound to `127.0.0.1` on a free port and opens your
browser. Pick a tab (Providers & Models / API Keys / Raw JSON), edit, save.

Flags:

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port to bind on 127.0.0.1 (default: 0 = any free port) |
| `--agent-dir <path>` | pi agent directory (default: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`) |
| `--static <dir>` | Built UI assets dir (default: `<package>/dist/ui` when it exists) |
| `--no-open` | Do not launch a browser |
| `--help` | Usage |

Requires Node.js 20 or newer at runtime.

### Agent directory resolution

pi has no project-level config: everything lives in ONE agent directory,
resolved as

1. the `--agent-dir` flag (relative paths resolve against the shell's cwd),
2. else the `PI_CODING_AGENT_DIR` environment variable,
3. else `~/.pi/agent` (`%USERPROFILE%\.pi\agent` on Windows).

The GUI reads and writes only inside that directory, and the API addresses
files by document id (`models`, `auth`, …) — the browser never sends a path.
A document that does not exist yet is listed with `exists: false` and gets
created on first explicit save, seeded with the minimal
`{ "$schema": "https://pi.dev/schemas/models.schema.json", "providers": {} }`
for `models.json` or `{}` for `auth.json` (on POSIX, a newly created
`auth.json` is created mode `0600`). The GUI never writes a "helpful" default
provider you didn't add.

### Running straight from a clone

The launcher scripts for this folder install dependencies and build on first
run, then start the server. Arguments pass through to the CLI:

```
.\launch.bat --agent-dir .\fixtures\agent-dir     # Windows
./launch.sh --agent-dir ./fixtures/agent-dir      # Linux / macOS
npm start -- --no-open                            # any platform (needs a build first)
```

## What you can do

- **Providers & Models** (`models.json`) — structured provider editor with
  presets for the local-runtime crowd (**Ollama** `:11434/v1`, **LM Studio**
  `:1234/v1`, **vLLM** `:8000/v1`, **llama.cpp router** `:9931/v1`, plus a
  generic custom endpoint). `api` strings, masked `apiKey` (literal, `$NAME`
  / `${NAME}` env and `!command` forms), `headers` rows, `authHeader`, and a
  provider-level `compat` block as schema-validated JSON. Per-model fields
  (`reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`, …) plus a
  `modelOverrides` editor keyed by model ID. Built-in provider rerouting
  (setting only `baseUrl` under e.g. `"anthropic"`) uses the same form.
- **Endpoint probe + import** — check `baseUrl` (+ key) against `/models`;
  get ok / auth-failed / unreachable / not-compatible plus the model list.
  Import merges **by model ID**: existing entries are never overwritten, and
  imported models get pi's schema defaults (`contextWindow: 128000`,
  `maxTokens: 16384`) flagged for review in the UI only — the review flag is
  never written to your file.
- **API Keys** (`auth.json`) — `{"type":"api_key", …}` entries are editable
  (provider id, masked key, `!command` key form, `env` rows); OAuth and any
  other credential shape are listed read-only — they belong to pi's
  `/login` / `/logout` — and stay byte-stable across GUI saves.
- **Raw JSON tab** — edit either document as text when you need full
  control; validation problems are reported against the same validators.
- **Schema badge** — honest provenance: live schema from pi.dev, disk cache
  (`~/.cache/pi-config-gui/models-schema.json`), or the copy vendored in the
  package, so it also works offline. `auth.json` has no published schema; a
  small hand-written one covers the documented credential shapes and accepts
  unknown entry shapes with a warning.

## `//` comments in models.json

pi's loader accepts `//` line comments and trailing commas in `models.json`
since [pi PR #4162](https://github.com/earendil-works/pi/pull/4162). The GUI
**preserves** comments and trailing commas in regions it doesn't touch, and
writes none itself — it never adds a comment to your file.

Caveat: a pi older than PR #4162 rejects `//` comments *the file already
contains* — the GUI preserving them is correct, current pi parses them, but
an old pi will refuse to load a commented file regardless of who wrote the
comments. If you are stuck on pre-#4162 pi, keep your `models.json`
comment-free.

## auth.json: how the GUI touches your secrets

`auth.json` is a live file: pi refreshes OAuth tokens in it *while it runs*.
The GUI treats it accordingly:

- **Rebased saves.** Your key edits are surgical path-edits that get
  *rebased onto freshly-read disk content* at save time — not written from a
  possibly stale snapshot. In practice: pi rotating an OAuth token while your
  editor is open does not conflict and does not get clobbered by your save;
  your edit lands on top of the rotated file. A conflict (409) is raised only
  when pi changed an entry *you actually edited* — then the UI offers Reload
  (discard your pending edits, after confirm) or nothing else; the structured
  key editor deliberately has no Force-save, because force-saving a stale
  snapshot could revoke a live session. (`models.json`, and `auth.json` via
  the Raw JSON tab's full-text override, keep the classic staleness /
  Reload-or-Force-save semantics.)
- **`!command` keys are never executed.** Some auth entries resolve their
  key by running a command (`"!command": "op read …"`). The GUI displays the
  entry, warns you, and never runs that command — not when probing, not
  ever. Its probe resolves literal and `$ENV` keys only; for `!command`
  entries it offers a paste-the-resolved-value box if you want to test a key
  once.
- **OAuth entries are read-only and byte-stable** — displayed, never
  rewritten, never included in a save.
- **Secrets never leak into logs or output.** Key values are masked in the
  UI, never appear in server logs, validation messages, error strings or
  probe diagnostics; probe requests carry a key only to the endpoint you
  pressed Probe for.

## Security posture

- The server binds `127.0.0.1` only — never a public interface.
- Every request — the `/api/*` routes and the built UI it serves alike —
  must carry a local `Host` (and a matching `Origin` when present); foreign
  hosts and cross-site origins get a hard 403, which is what blocks
  DNS-rebinding and drive-by requests. Static assets answer GET/HEAD only.
  No CORS headers, ever.
- No analytics, no telemetry, no update pings. The only outbound requests
  are the ones you trigger: the schema refresh from pi.dev and endpoint
  probes you press.
- File access is confined to the documents discovery finds in the resolved
  agent dir; the API takes document ids, never paths, so arbitrary paths
  over the wire are not a thing.
- `auth.json` is handled as *your* file: the GUI can show and edit its keys
  (masked) because it runs loopback on your machine under your own file
  permissions.

## Releasing

Manual, on purpose: `npm publish` from the `pi-config-gui/` folder, ever.
`prepublishOnly` runs typecheck, tests and build first. There are **no CI
workflows and no repo-infra changes for this app** — the parent repo's GitHub
Actions belong to opencode-config-gui and must not be pointed here.

## Contributing

Requirements: Node.js **>= 22.12** for the dev toolchain (vitest 5 needs it —
the *shipped* code only needs Node 20, and the smoke script is what guards
that floor) and npm.

```
npm ci
npm run typecheck
npx vitest run         # or: npm test
npm run build          # tsc -> vite (UI) -> scripts/postbuild.mjs
npm run smoke          # boots dist/cli.js against a throwaway agent dir,
                       # checks /api/state + config echo + UI + Host guard
node dist/cli.js --no-open
```

Dev loop: `npm run dev:server` (API on port **8711**, watching `dist/`) plus
`npm run dev:ui` (Vite dev server proxying `/api` to 8711).

Layout: `src/core` (JSONC path-edits, discovery, schema ladder, auth rebase,
presets, probe — pure TypeScript), `src/server` (node:http glue,
127.0.0.1-only), `src/ui` (React + Vite), `test/` (vitest).
`scripts/postbuild.mjs` copies the vendored schema into `dist/` and keeps
the shebang and exec bit on `dist/cli.js`.

## About this code

This codebase was written almost entirely by AI coding agents, directed and
reviewed by a human who mostly just said "sir, yes sir." It is a
self-contained fork of opencode-config-gui; the duplication across the folder
boundary is by design. Expect it to work — 180 tests and a stack of review
passes say so — but extend it at your own risk.

## License

MIT (see `license` in `package.json`) — do whatever you want with it, just
keep the copyright line. Your configs and your API keys were never part of
the deal anyway; they stay in your files.
