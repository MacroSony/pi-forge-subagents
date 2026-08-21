# pi-forge-subagents (optional)

Optional subagent integration for [pi-forge](https://github.com/MacroSony/pi-forge).
Discovers the active main `pi-forge` host through the versioned
`@zihanw/pi-forge/subagent` host port and owns subagent execution and config.

This package depends only on the published host-port contract — resource
selectors, prompt-compilation access facts, and backend facts in; immutable
preparation artifacts out. It never imports main-package internals.

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
    "global:reviewer": { "enabled": true }
  }
}
```

## Development

```sh
npm install
npm run verify
```
