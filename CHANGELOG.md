# Changelog

## Unreleased

- Initial optional-package scaffold for Lane 3 of pi-forge 0.5.0.
- `ForgeHostSession`: discover/connect to the active pi-forge host over the
  `/subagent` host port; list profiles and prepare prompts through the port;
  observe host disposal.
- Extension entry point registers `/subagent list | plan` surface.
- Packed-install smoke verified together with the main package (`main + optional`).
- Aligned prerelease version to 0.5.0-beta.1.
- Full `forge_subagent` execution chain: own `subagents.json` config,
  `ForgeHostSession.resolveProfile`, backend preflight + sealing via
  `@zihanw/pi-subagent-runtime`, host compile through the host port, interactive
  approval, and execution. Integration test covers preflight->seal->prepare->execute.
- Lane 3.5 parity:
  - Added `forge_subagent_profiles` discovery tool.
  - Added `/forge-agent backends|plan|run` commands.
  - Added parallel-approval serialization and unattended backend pinning.
  - Added `summaryInToolDescription` config support.
  - Added read-only legacy `config.json.subagents` fallback.
- Lane 4a: the package now owns the 0.4 execution contract locally
  (`src/contract/`, names unchanged): request, preflight, plan, response,
  context budgeting, tool negotiation, and their validators. Portable leaves
  import directly from `@zihanw/pi-subagent-runtime`; host-owned domain shapes
  are structural mirror types; snapshot profile validation narrows to
  structural checks plus content fingerprints (deep schema validation is
  host-owned). Only host-port DTOs (`Forge*` wire types, `ForgeHostClient`,
  wire validators) come from `@zihanw/pi-forge/subagent`. `npm pack` now
  rebuilds via `prepack`.
- Lane 4c: the package now has its own `check:packed` smoke — it packs both
  packages, installs them into a temporary consumer, loads both packed
  extension factories over a shared event bus, and runs discover →
  listProfiles → resolveProfile → prepare → dispose → host-shutdown against a
  fixture workspace, ending with rediscovery failure after disposal.
