# pi-forge-subagents (optional)

Optional subagent integration for [pi-forge](https://github.com/MacroSony/pi-forge).
Discovers the active main `pi-forge` host through the versioned
`@zihanw/pi-forge/subagent` host port and owns subagent execution and config.

This package uses intentional public contracts only (the host port, settings UI contribution port, and local command-contribution entry) — resource
selectors, prompt-compilation access facts, and backend facts in; immutable
preparation artifacts out. It never imports main-package internals.

## Compatibility and release validation

This 0.5.4 candidate requires **Forge ^0.5.8** and
**pi-subagent-runtime ^0.1.0-beta.5**. The Forge host is already published;
release the runtime before installing/publishing this optional package from
npm. Candidate versions here do not imply registry availability.

Pi SDK packages and TypeBox are optional wildcard host peers, not bundled
runtime dependencies. Development pins are Pi **1.0.2** and TypeBox **1.3.27**.
The packed real-host/real-child gate also runs against Pi **0.87.0** with
TypeBox **1.3.7**. These are tested combinations, not a claim that every Pi
release is supported. Built-in in-process execution requires Pi's ModelRuntime
and authenticated preparation APIs; peers alone do not certify an older host.

`tools.initial` is honored by both the Forge compiler and runtime plan
validation: omitted retains legacy selection, `[]` means no default tools,
and allow/deny plus request access still constrain execution. Published
Subagents 0.5.3 ignored `initial` in validation; upgrade both the optional
package and runtime to use these features. `/forge subagent` uses the published
Forge command-contribution port, not an unreleased main branch.

For CLI `plan/run`, put `--backend` before the task. Use `--` before task text
containing literal flags; internal task whitespace and quotes are preserved,
not interpreted by a shell. Legacy `/forge-agent` shares this parser.

### Reproducible packed gate

`npm run check:packed` installs this tarball against exact published Forge and
runtime dependency floors, with normal peer resolution. It fails rather than
skipping when a required artifact is unavailable. For pre-publication tests:

```sh
PI_SUBAGENT_RUNTIME_PACKAGE=/absolute/path/runtime.tgz npm run check:packed
PI_TEST_VERSION=0.87.0 TYPEBOX_TEST_VERSION=1.3.7 \
  PI_SUBAGENT_RUNTIME_PACKAGE=/absolute/path/runtime.tgz npm run check:packed
```

`PI_FORGE_PACKAGE` can select an explicit Forge tarball/spec; `PI_FORGE_ROOT`
is a separate opt-in local-checkout probe, never the default release gate.
The test uses an isolated HOME/agent directory, real SDK parent and child
sessions plus the real Forge compiler, and an offline synthetic provider.
It checks `initial: [read]` / `[]`, target-relative reads, complete retained
history, cleanup-failure usage in foreground/background, cancellation after a
billed turn, pending inspection without credit, one-time collection,
and JSONL reload. It does not certify live-provider billing or remote CI.

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

This mapping requires the dependency floors above. Runtime beta.4 receipts
are handled defensively without invented attribution, but beta.4 is not a
supported release combination. Tests require new coverage and continuation
by default; `FORGE_EXPECT_LEGACY_RUNTIME=1` is only for an explicit legacy probe.

## Surfaces

- `forge_subagent_profiles`: model-callable, no-egress discovery of enabled profiles.
- `forge_subagent`: model-callable foreground/background delegation with approval or trusted unattended configuration.
- `forge_subagent_task`: status/result/cancel, metadata-only contexts listing, and retained-context release.
- `/forge subagent help|list|backends|config|plan|run|status|result|cancel|contexts|release`: canonical human command lane
  contributed directly to `/forge` for profile discovery, dry planning, approved execution (foreground or background),
  background task management, and child continuation lifecycle.
  A compatible `/forge-agent` command is also registered directly.
- `/subagent list|plan`: legacy minimal host-port smoke surface (does not execute runtime).

Subagent configuration lives in `.pi/forge/subagents.json` (project) and
`~/.pi/forge/subagents.json` (global). Legacy `config.json.subagents` is accepted
as a read-only fallback with a warning.

In the development source, an omitted `allowAgentInvocationWithoutApproval`
inherits the preceding layer. An explicit boolean overrides it; an explicit
non-boolean value (including `null` or the string `"false"`) instead sets that
layer to `false` and emits a warning. A valid boolean in a higher-priority layer
can still override normally. This field-level fix is not in published 0.5.3.
An unreadable, malformed, or non-object config file is still ignored with a
warning, so an earlier valid layer may remain effective. Untrusted project
settings are ignored, and delegation execution still requires project trust.

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

### One worker, per-run model and thinking

`allowAgentModelOverrides` is **false by default**. Enable it in trusted global
or project configuration to let unattended model calls supply `model`
(`provider/id`) and/or `thinkingLevel`. It does not enable delegation by itself:
`allowAgentInvocationWithoutApproval` and the profile's `enabled` setting still
apply. A per-profile boolean overrides the effective top-level default:

```json
{
  "allowAgentInvocationWithoutApproval": true,
  "profiles": {
    "global:minimal-worker": {
      "enabled": true,
      "backend": "pi-inprocess",
      "allowAgentModelOverrides": true
    }
  }
}
```

The parent can then call one profile with different settings for independent
children, without creating a separate profile for each model:

```json
{
  "profileId": "global:minimal-worker",
  "model": "openai-codex/gpt-6.1-sol",
  "thinkingLevel": "high",
  "task": "Review the patch without editing files."
}
```

- Omitted fields retain the saved profile defaults. Overrides never rewrite a
  profile. When continuing a retained child, omission preserves that child's
  effective model/thinking instead.
- Thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`,
  subject to the selected model's actual support. Unknown/unavailable models or
  unsupported thinking levels fail preflight: no model fallback or silent
  thinking clamp.
- This grant is not a model allowlist: any host-available model supported by the
  configured backend may be selected. It can change cost and which provider
  receives delegated prompt data. It does **not** change backend, tool, cwd,
  trust, or egress-policy boundaries.
- Omitting a config field inherits it; an explicit non-boolean (including null)
  sets that layer's field false with a warning. Existing config-layer precedence
  remains unchanged; malformed whole files are still ignored with a warning.
- Permission is checked again before execution after awaited preparation or
  approval work. A non-default retained model/thinking combination cannot be
  continued unattended once its override permission is revoked. Explicitly
  changing a retained child's model/thinking requires a new child.
- Interactive runs can propose overrides without this unattended grant, but
  still require approval of the exact effective model/thinking plan.
- Both scoped web settings pages and profile rows expose Inherit/Enabled/Disabled;
  `forge_subagent_profiles` shows the effective unattended override permission.

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
/forge subagent plan <profile> [--backend <id>] [--model <provider/id>] [--thinking <level>] [--cwd <path>] [--keep-context] [--continue <id>] [--] <task>

# Execution (requires interactive human approval)
/forge subagent run <profile> [--backend <id>] [--model <provider/id>] [--thinking <level>] [--cwd <path>] [--keep-context] [--continue <id>] [--background] [--] <task>

# Background task management
/forge subagent status [id]
/forge subagent result <id>
/forge subagent cancel <id>

# In-process session continuation release
/forge subagent contexts
/forge subagent release <context-or-task-id>
```

### Options

- `--backend <id>`, `--backend=<id>`: Select an execution backend before the task.
- `--cwd <path>`, `--cwd=<path>`: Specify the target working directory for the subagent run. Quoted paths with spaces (e.g. `--cwd "/path with spaces/project"`) are fully supported.
- `--model <provider/id>` / `--thinking <level>`: Per-run overrides; CLI execution still always requires human approval.
- `--keep-context`: Retain the child session in memory after a successful turn for subsequent continuation turns.
- `--continue <id>`, `--continue=<id>`: Continue a previously retained in-process child session. Specifying `--continue` automatically implies context retention (`keepContext: true`).
- `--background`: Launch the subagent in the background after explicit interactive human approval (`run` only; rejected for `plan`).
- `--`: Delimiter marking the beginning of the task text. Preserves literal flags, whitespace, and quotes without shell interpretation.

Model tools expose the same options as `model`, `thinkingLevel`, `cwd`, `keepContext`, `continueId`, and
`background` on `forge_subagent`. Use `forge_subagent_task` with `action`
`status` / `result` / `cancel` and a task `id`, `contexts` for retained-context metadata,
or `release` and a context or finished background-task `id`. These are new tool schemas: install the matching runtime + optional
artifacts and restart/reload the test host before trying them. Published beta.4
runtime rejects context retention explicitly rather than pretending to resume.

### Cleanup failures

Generation teardown makes up to three immediate `runtime.dispose()` attempts
with a runtime that owns backend cleanup. Recovered backend failures stop
retrying; a persistent or unrecoverable lifecycle failure is logged. This is
bounded best-effort cleanup, not a promise that every resource is released;
there is no background retry service. Child requests with validated receipts
remain billable even when cleanup fails.

### In-process continuation lifecycle

- **Backend restriction**: In-process child session continuation (`--keep-context`, `--continue`, and `release`) is supported only on the `pi-inprocess` backend. `pi-bwrap-write` and fresh-process backends do not support session continuation.
- **Parent lifetime**: Continuation handles are stored in the host parent process memory and are strictly private to the owning parent session. They do not survive host session reloads, session switches/forks that create a new session, or process restarts. Navigating branches within the same session does not clone the child: a handle still refers to one serialized conversation. Context handles and continuation are session-wide: explicitly continuing a child from another branch shares its prior history. Branches are not a confidentiality boundary. The background `result` branch gate prevents accidental output/usage collection on the wrong branch; it is not an ACL against explicit continuation.
- **Full context, no automatic summary**: Retained children disable automatic compaction in memory; if context limits are reached, start a new child instead of silently replacing history with a summary. Model/thinking/tool/profile/system changes require a new child.
- **Explicit release**: Use `/forge subagent contexts` to discover retained handles, then `/forge subagent release <context-or-task-id>`. Listing/release are owner-session controls, not result collection: they do not return transcript/output or claim usage, and can be used from another branch. Release preserves uncollected task output and its one-time usage receipt. Running task release rejects rather than silently cancelling; busy/prepared retained contexts must become idle first.
- **Short, opaque handles**: Public task IDs use `t-<short namespace>-<counter>` and context IDs use `c-<short namespace>-<counter>`. They are generated by the host, not guessed or synthesized by the model. A task has the same ID from plan/launch through status and final response. Core runtime UUIDs and fingerprints remain internal/audit data, not values the model must copy. Fresh adapter instances use fresh namespaces so stale pre-reload handles are not recycled into new tasks. These handles are not authorization tokens and do not survive reload/restart.


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
