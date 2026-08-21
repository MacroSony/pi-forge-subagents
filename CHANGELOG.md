# Changelog

## 0.5.1 - Unreleased

- Call-time model override for `forge_subagent`: an optional `model` parameter
  (`provider/id`, parsed and validated) lets the main agent pick the execution
  model per call; resolution order is `model` param over profile default. Same
  policy as the `backend` param — interactive overrides are allowed, unattended
  invocation stays pinned to the profile/configured model and rejects the
  override. The override is carried into the sealed execution plan, and the
  approval summary's existing `Model:` line shows the effective model.
- Restored rich TUI rendering for subagent runs: ported the 0.4-style
  `renderCall`/`renderResult` (pi-tui Container/Markdown) into the current tool,
  adapted to the present details shape — collapsed/expanded states, live
  progress from `details.progress`, the approval receipt, and usage/model stats
  in the expanded result.
- Subagent Settings UI contribution provider: implements the pi-forge
  ui-contribution port (`@zihanw/pi-forge/ui-contribution`) so a generic
  schema-driven "Subagent Settings" tab appears in the web editor when this
  package is installed. `listContributions` maps `ForgeSubagentSettings` to a
  form schema (backend, timeout, unattended-invocation and summary flags, plus a
  per-profile enabled/backend/timeout record table); `writeValues` re-validates
  server-side with the existing validators and persists to `subagents.json`
  with project/global precedence and per-file provenance intact. The provider
  registers on session start and disposes on session shutdown.
- `/forge-agent config` prints the resolved effective subagent settings with
  sources (backend, timeout, unattended flag, summary flag, and per-profile
  delegation entries), mirroring what the web tab writes.

## 0.5.0 - 2026-08-21

- Initial optional-package scaffold for Lane 3 of pi-forge 0.5.0.
- `ForgeHostSession`: discover/connect to the active pi-forge host over the
  `/subagent` host port; list profiles and prepare prompts through the port;
  observe host disposal.
- Extension entry point registers `/subagent list | plan` surface.
- Packed-install smoke verified together with the main package (`main + optional`).
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

### Fixed

- The host profile snapshot is now structurally validated immediately
  after `resolveProfile()`, before the execution intent or backend preflight
  are built (0.5.x review A3). `prepare` fails fast with `snapshot.*`
  diagnostics on a malformed snapshot; regression test asserts backends are
  never touched in that case. Plan creation keeps its own validation as an
  integrity net.
- Profile-level `backend`/`timeoutMs` provenance is reported correctly.
  `loadForgeSubagentSettings` now tracks which config file each `profiles`
  entry came from (`profilesSource`), and `resolveSubagentProfilePolicy`
  reports that file's scope instead of hardcoding `"project"` — a
  global-configured `global:<id>` profile no longer masquerades as
  project-sourced. Regression test covers per-file provenance.
- Host preparation diagnostics are reported exactly once.
  `toPreparationOutput` no longer aliases the top-level `diagnostics` array onto
  `toolNegotiation.diagnostics`, and `prepare()` no longer re-pushes them before
  plan diagnostics are collected. Regression test asserts no duplicated
  host-preparation diagnostics.
- Align dependency policy with the main `pi-forge` package —
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and
  `@earendil-works/pi-tui` are now optional `peerDependencies` (`*`) instead of
  hard `dependencies`, kept as `devDependencies` for local development so the
  extension no longer installs private duplicate copies of Pi packages.
- Serialize disposal of replaced runtime generations in
  `createForgeSubagentRuntime` — teardown of a replaced generation is awaited
  before `prepare`/`execute` use the fresh generation, and disposal errors are
  caught and surfaced instead of becoming unhandled rejections. Regression test
  proves a fresh generation's preflight waits for the replaced generation's
  disposal.

### Changed

- Dev/test Pi SDK pins aligned with the main package at `0.84.2`
  (0.5.x review A4); `pi-coding-agent` no longer lags at `0.83.0`.
- Consume the strengthened `/subagent` host-port DTO types from
  `@zihanw/pi-forge` — `ForgeHostSession.resolveProfile` returns the typed
  `ForgeResolveProfileResponse`, and the runtime preparation path drops its
  `unknown` casts for messages/diagnostics. The only remaining cast is the
  documented snapshot projection at the host boundary.

