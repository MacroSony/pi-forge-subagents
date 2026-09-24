# pi-forge-subagents (optional)

Optional subagent integration for [pi-forge](https://github.com/MacroSony/pi-forge).
Discovers the active main `pi-forge` host through the versioned
`@zihanw/pi-forge/subagent` host port and owns subagent execution and config.

This package depends only on the published host-port contract — resource
selectors, prompt-compilation access facts, and backend facts in; immutable
preparation artifacts out. It never imports main-package internals.

## Development compatibility

Presets with `tools.initial` require the Forge **0.5.5 development implementation** and this package's **post-0.5.3 tool-negotiation fix**. The published 0.5.3 implementation ignores `initial` during plan validation and is not compatible with such Presets. Use matching local checkouts until the paired releases are available. Omitted `initial` retains legacy selection; `[]` means no default tools, and allow/deny plus request access still constrain execution.

The next paired release is planned as Forge **0.5.5** / subagents **0.5.4**. Before publishing, raise this package's Forge dependency floor to **0.5.5**, update lockfiles/dev SDK pins, and rerun cross-package and packed execution tests. Current development manifest versions/ranges have not yet been bumped and must not be read as certification of older combinations. The packed check now exercises actual `initial` preparation, plan validation, and inert execution with both read and write otherwise available.

## Surfaces

- `forge_subagent_profiles`: model-callable, no-egress discovery of enabled profiles.
- `forge_subagent`: model-callable foreground delegation with approval.
- `/forge-agent backends|plan|run`: human command surface for backend discovery,
  dry planning, and approved execution.
- `/subagent list|plan`: minimal host-port smoke surface.

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

## Development

```sh
npm install
npm run verify
```
