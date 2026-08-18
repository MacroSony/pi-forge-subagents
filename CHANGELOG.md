# Changelog

## Unreleased

- Initial optional-package scaffold for Lane 3 of pi-forge 0.5.0.
- `ForgeHostSession`: discover/connect to the active pi-forge host over the
  `/subagent` host port; list profiles and prepare prompts through the port;
  observe host disposal.
- Extension entry point registers `/subagent list | plan` surface.
