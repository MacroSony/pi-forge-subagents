# pi-forge-subagents (optional)

Optional subagent integration for [pi-forge](https://github.com/MacroSony/pi-forge).
Discovers the active main `pi-forge` host through the versioned
`@zihanw/pi-forge/subagent` host port and owns subagent execution and config.

This package depends only on the published host-port contract — resource
selectors, prompt-compilation access facts, and backend facts in; immutable
preparation artifacts out. It never imports main-package internals.

## Development

```sh
npm install
npm run verify
```
