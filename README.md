# pi-forge-subagents (optional)

Optional subagent integration for [pi-forge](https://github.com/MacroSony/pi-forge).
Discovers the active main `pi-forge` host through the versioned
`@zihanw/pi-forge/subagent` host port and owns subagent execution and config.

This package uses intentional public contracts only (the host port, settings UI contribution port, and local command-contribution entry) — resource
selectors, prompt-compilation access facts, and backend facts in; immutable
preparation artifacts out. It never imports main-package internals.

## Development compatibility

Presets with `tools.initial` require the Forge **0.5.5 development implementation** and this package's **post-0.5.3 tool-negotiation fix**. The published 0.5.3 implementation ignores `initial` during plan validation and is not compatible with such Presets. Use matching local checkouts until the paired releases are available. Omitted `initial` retains legacy selection; `[]` means no default tools, and allow/deny plus request access still constrain execution.

The new `/forge subagent` lane additionally imports `@zihanw/pi-forge/command-contribution`, which requires the matching main development build; older published main packages do not expose this entry. The existing dependency range is not a compatibility guarantee until the coordinated release floor is updated.

For CLI `plan/run`, put `--backend` before the task. Use `--` before task text containing literal flags; internal task whitespace and quotes are preserved, not interpreted by a shell. Legacy `/forge-agent` shares this parser.

The next paired release is planned as Forge **0.5.5** / subagents **0.5.4**. Before publishing, raise this package's Forge dependency floor to **0.5.5**, update lockfiles/dev SDK pins, and rerun cross-package and packed execution tests. Current development manifest versions/ranges have not yet been bumped and must not be read as certification of older combinations. The packed check now exercises actual `initial` preparation, plan validation, and inert execution with both read and write otherwise available.

### Nested usage

The final `forge_subagent` tool result preserves the runtime's `response.usage` in
`details.response.usage` and, when request coverage is available, adds the main
Forge public `/subagent` contract at `details.forgeNestedUsage` (schema version
1). The nested receipt includes `requests`, `input`, and `output`; `cacheRead`
and `cacheWrite` are included only when cache coverage is complete. Mixed
coverage omits that pair so the UI can display cache as unknown. A legacy
runtime without request coverage is retained but receives no invented nested
request count. A top-level native Pi `usage` is emitted only for complete,
consistent token/cost coverage; partial or invalid values are never padded with
zeros.

This mapping requires a compatible development build of the Forge host and
`@zihanw/pi-subagent-runtime` usage contract. The published beta.4 runtime is
accepted defensively: without its coverage metadata the run completes without
native or nested attribution. Full compatibility with older runtimes is not
promised.

## Surfaces

- `forge_subagent_profiles`: model-callable, no-egress discovery of enabled profiles.
- `forge_subagent`: model-callable foreground delegation with approval.
- `/forge subagent help|list|backends|config|plan|run|status|result|cancel|release`: canonical human command lane
  contributed directly to `/forge` for profile discovery, dry planning, approved execution (foreground or background),
  background task management, and child continuation lifecycle.
  A compatible `/forge-agent` command is also registered directly.
- `/subagent list|plan`: legacy minimal host-port smoke surface (does not execute runtime).

Subagent configuration lives in `.pi/forge/subagents.json` (project) and
`~/.pi/forge/subagents.json` (global). Legacy `config.json.subagents` is accepted
as a read-only fallback with a warning.

Profile keys are scope selectors, not just profile names. Use canonical
`project:<id>` or `global:<id>` keys. A bare key is retained for compatibility
with project profiles only and never grants authority to a same-named global
profile:

```json
{
  "backend": "pi-rpc-readonly",
  "timeoutMs": 120000,
  "allowAgentInvocationWithoutApproval": true,
  "profiles": {
    "global:image-viewer": { "enabled": true },
    "global:reviewer": { "enabled": true },
    "project:fixer": {
      "enabled": true,
      "backend": "pi-bwrap-write"
    }
  }
}
```

`pi-bwrap-write` is an opt-in Linux backend. Selecting it is the write
authorization: it projects isolated `workspace-write` access, exposes
read/search/edit/write/`bash`, and edits the current git work tree directly.
The approval dialog shows the effective access and read-write mount. Commit or
stash existing work before delegation and review the result with `git diff`.
Combining this backend with `allowAgentInvocationWithoutApproval: true` is an
explicit unattended/YOLO choice: writes proceed without a fresh human prompt.
The backend rejects non-git workspaces by default and protects top-level local
`.git` metadata inside Bubblewrap.

For the first dogfood lane, stored or ambient credentials are projected only
for the selected model for Anthropic, OpenAI, Google Gemini, OpenRouter, and
OpenCode. OAuth-only providers whose child cannot consume Pi's `--api-key`
override remain outside this first lane. Other providers can supply `bubblewrap.env` or `bubblewrap.envForModel` through
the programmatic runtime options until provider coverage is expanded.

`pi-inprocess` is a workspace-write backend that runs the subagent directly in
the host model runtime. It provides the same tool surface as `pi-bwrap-write`,
but with a shared-user boundary: there is **no OS isolation**, so the subagent
runs with your user's permissions instead of inside Bubblewrap. Use it for
profiles that need extension-registered providers, such as OAuth-based or
custom-streaming providers, because those providers are available in the host
process and cannot resolve in fresh-process backends that spawn children with
`--no-extensions`.

When a profile uses an extension-registered provider with
`pi-subprocess-readonly`, `pi-rpc-readonly`, or `pi-bwrap-write`, preparation
fails with a `host.model-not-portable` diagnostic. Switch that profile to a
built-in or `models.json`-declared provider, or route it to `pi-inprocess`.

The web editor exposes separate **Subagents · Project** and **Subagents · Global**
settings pages. Each page edits only the displayed `subagents.json` file, uses
the live Forge profile catalog for its profile picker, and treats empty values
as removal of that scope's override. New entries for missing profiles are
rejected; previously configured missing or legacy entries remain visible so
they can be removed or migrated.

## CLI usage and features

Both `/forge subagent` (canonical) and `/forge-agent` (compatible alias) provide
the human subagent command interface.

### Subcommands

```sh
# Discovery and configuration
/forge subagent help
/forge subagent list
/forge subagent backends
/forge subagent config

# Dry planning (validates full delegated request without provider transport)
/forge subagent plan <profile> [--backend <id>] [--cwd <path>] [--keep-context] [--continue <id>] [--] <task>

# Execution (requires interactive human approval)
/forge subagent run <profile> [--backend <id>] [--cwd <path>] [--keep-context] [--continue <id>] [--background] [--] <task>

# Background task management
/forge subagent status [id]
/forge subagent result <id>
/forge subagent cancel <id>

# In-process session continuation release
/forge subagent release <continueId>
```

### Options

- `--backend <id>`, `--backend=<id>`: Select an execution backend before the task.
- `--cwd <path>`, `--cwd=<path>`: Specify the target working directory for the subagent run. Quoted paths with spaces (e.g. `--cwd "/path with spaces/project"`) are fully supported.
- `--keep-context`: Retain the child session in memory after a successful turn for subsequent continuation turns.
- `--continue <id>`, `--continue=<id>`: Continue a previously retained in-process child session. Specifying `--continue` automatically implies context retention (`keepContext: true`).
- `--background`: Launch the subagent in the background after explicit interactive human approval (`run` only; rejected for `plan`).
- `--`: Delimiter marking the beginning of the task text. Preserves literal flags, whitespace, and quotes without shell interpretation.

Model tools expose the same options as `cwd`, `keepContext`, `continueId`, and
`background` on `forge_subagent`. Use `forge_subagent_task` with `action`
`status` / `result` / `cancel` and a run `id`, or `release` and a continuation
`id`. These are new tool schemas: use matching development runtime + optional
builds and restart/reload the test host before trying them. Published beta.4
runtime rejects context retention explicitly rather than pretending to resume.

### In-process continuation lifecycle

- **Backend restriction**: In-process child session continuation (`--keep-context`, `--continue`, and `release`) is supported only on the `pi-inprocess` backend. `pi-bwrap-write` and fresh-process backends do not support session continuation.
- **Parent lifetime**: Continuation handles are stored in the host parent process memory and are strictly private to the owning parent session. They do not survive host session reloads, session switches/forks that create a new session, or process restarts. Navigating branches within the same session does not clone the child: a handle still refers to one serialized conversation.
- **Full context, no automatic summary**: Retained children disable automatic compaction in memory; if context limits are reached, start a new child instead of silently replacing history with a summary. Model/tool/profile/system changes require a new child.
- **Explicit release**: To free memory before session exit, invoke `/forge subagent release <continueId>`.

### Target working directory (`--cwd`)

- **Interactive verification**: In CLI runs, the target working directory is displayed and bound to the interactive human approval dialog before execution.
- **External unattended access**: When subagents are invoked in unattended mode (`allowAgentInvocationWithoutApproval: true`), targeting an external directory requires exact canonical path authorization in `allowedWorkingDirectories` in the trusted parent `.pi/forge/subagents.json`.
- **Allowlist precedence**: Project `allowedWorkingDirectories` replaces the global list; `[]` revokes external targets. Relative project paths are resolved from the parent cwd, global paths from the global Forge config directory. This is an explicit exact-directory list, not a recursive filesystem grant.
- **Isolation**: Subagent runs targeting an external working directory use parent Forge profiles and delegation authorization; target directory `.pi/forge/` profiles, local extensions, skills and context files are **not** auto-loaded by the child. Native SDK project settings may still be read from the target; these do not grant additional Forge delegation permissions.

### Background tasks and usage accounting

- **Approval before launch**: Background tasks use the same approval policy as foreground runs. CLI execution always asks; model tools may use explicitly trusted unattended configuration.
- **No injected followups**: Launching a background task does not inject automatic assistant messages into the ongoing chat.
- **Non-claiming inspection**: `/forge subagent result <id>` reads results with `claimUsage=false`. Human inspection never steals token or cost accounting from subsequent model-directed tool collection.
- **Result ownership**: Model-tool collection uses `forge_subagent_task` (`action: "result"`, `id: <runId>`), is allowed only on the launch branch or its descendant, and credits usage once per task. Repeated reads return output without another receipt.
- **No CLI ledger**: Native Pi model usage is credited solely through model tool-result collection; the CLI does not maintain a duplicate usage accounting ledger.

### Cancellation semantics

- **Foreground**: Respects the turn abort signal (`ctx.signal` / Ctrl+C / abort).
- **Background**: Continues running across parent conversation turns; cancel explicitly with `/forge subagent cancel <id>` or let it terminate automatically on parent session shutdown.

## Development

```sh
npm install
npm run verify
```
