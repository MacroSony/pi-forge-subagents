# Changelog

## Unreleased

- Initial optional-package scaffold for Lane 3 of pi-forge 0.5.0.
- `ForgeHostSession`: discover/connect to the active pi-forge host over the
  `/subagent` host port; list profiles and prepare prompts through the port;
  observe host disposal.
- Extension entry point registers `/subagent list | plan` surface.
- Full `forge_subagent` execution chain: own `subagents.json` config,
  `ForgeHostSession.resolveProfile`, backend preflight + sealing via
  `@zihanw/pi-subagent-runtime`, host compile through the host port, interactive
  approval, and execution. Integration test covers preflight->seal->prepare->execute.
