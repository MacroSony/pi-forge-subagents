# Changelog

## Unreleased — 0.5.4 candidate

- Require published Forge ^0.5.8 and runtime ^0.1.0-beta.5; pin development Pi SDKs to 1.0.2. TypeBox is a wildcard optional host peer with development pin 1.3.27, avoiding duplicate host-module warnings.
- Retry generation backend cleanup at most three times and surface the final failure. This is bounded best-effort cleanup, not unconditional resource release.
- Require continuation and usage coverage in release tests by default. Packed checks use exact published dependency floors, normal peer resolution, isolated HOME/agent directories, and real Forge + parent/child SDK sessions with an offline provider. Cover initial tools, target-relative reads, retained history, foreground/background cleanup-failure and cancellation usage exactly once, pending collection without credit, and JSONL reload on Pi 0.87.0 / 1.0.2.
- CI no longer checks out a moving sibling Forge main; usage integration loads the installed Forge artifact instead of sibling source.

- Set effective `allowAgentInvocationWithoutApproval` to `false` with a warning when explicitly present as a non-boolean value (including `null`, strings `'false'`/`'true'`, numbers, and objects/arrays) at that configuration layer, rather than silently retaining a previous layer's `true`. Omitted `allowAgentInvocationWithoutApproval` continues to inherit across layers.
- Add model-tool `cwd`, `keepContext`, `continueId`, and `background` options plus `forge_subagent_task` status/result/cancel/release. Background results credit native/nested usage once, and only on the launch branch or descendants.

- Add CLI flags `--cwd` (supporting quoted paths), `--keep-context`, `--continue` (with implied context retention), and `--background` (run only) to `/forge subagent` and `/forge-agent`.
- Add background task management subcommands: `status [id]`, `result <id>`, and `cancel <id>`. CLI result inspection uses `claimUsage=false` so human inspection never steals accounting from subsequent model collection, and native usage attribution remains credited solely by tool-result collection with no new CLI ledger.
- Add `release <continueId>` subcommand to explicitly release in-process child continuation sessions. Document continuation constraints: supported only on `pi-inprocess`, private to the owning parent session process lifetime (no reload, restart, new-parent-session, or bwrap continuation).
- Enforce that CLI invocations are always human-approved (`unattended: false` is passed to preparation even when project config allows unattended invocation).
- Document target working directory semantics: interactive CLI mode prompts human approval for the target directory; external unattended invocation requires explicit matching entries in `allowedWorkingDirectories` from trusted parent config; target profiles/extensions are not auto-loaded.
- Clarify cancellation semantics: foreground runs respect abort signals, while background tasks persist across parent turns until explicitly cancelled via `cancel <id>` or drained on parent session shutdown.
- Update packed smoke test `scripts/check-packed-install.mjs` to check for `/capability` instead of `/instruction` in sync with current main naming.
- Map complete subagent runtime usage to native Pi tool usage and the main Forge public `/subagent` nested-usage v1 receipt. Runtime response usage remains preserved in details; incomplete, mixed, legacy, or invalid coverage is reported without fabricated zeros or partial native fields. This requires the compatible development Forge/runtime pair; published runtime beta.4 degrades gracefully without native/nested attribution when coverage is unavailable.
- Contribute the canonical `/forge subagent` command lane to `/forge` via `contributeForgeCommand` while keeping `/forge-agent` compatible and preserving the legacy `/subagent` smoke helper.
- Add `list` subcommand to `/forge subagent` and `/forge-agent` listing only enabled configured profiles (execution still revalidates eligibility) with scoped IDs and descriptions with no LLM inference.
- Tighten CLI parsing: reject extra arguments and unknown options; place `--backend` before task text, and use `--` for literal task flags (also on the legacy alias).
- Support `--` task delimiter for `plan` and `run` to permit literal flags in delegated tasks while preserving whitespace and quotes without shell execution.
- Argument completions for subcommands (`help`, `list`, etc.), current profile IDs, `--backend`, and registered backend IDs (including `--backend=` and flags before profile), with session-event context tracking that prevents cwd leakage across session switches.
- Honor `tools.initial` in independent tool negotiation and execution-plan validation, including explicit empty selection, missing names, policy ceilings and access filtering. The plan integrity check remains enforced.
- Exercise the real public Forge prepare → optional plan → inert backend execution path in both cross-package regression and packed-install tests. Both registered read/write tools are otherwise accessible so access filtering cannot hide this regression.
- Runtime beta.5 must be published before final registry lockfile/CI validation and optional 0.5.4 publication; Forge 0.5.8 is the independent published baseline.

## 0.5.3 - 2026-09-03

- Add a `pi-inprocess` backend with the same workspace-write tool surface as
  `pi-bwrap-write`. It runs the session against the host model runtime with a
  shared-user boundary and no OS isolation, so extension-registered providers
  (OAuth, custom streaming, and other model providers registered only in the
  host process) can resolve.
- Reject extension-registered model providers on the fresh-process backends
  (`pi-subprocess-readonly`, `pi-rpc-readonly`, `pi-bwrap-write`) during
  preparation with a `host.model-not-portable` diagnostic. Those backends start
  the child with `--no-extensions`; route affected profiles to `pi-inprocess`
  or use a built-in/`models.json`-declared provider.
- Surface tool-negotiation diagnostics in unattended subagent tool results,
  including `tools.*` codes such as `tools.unmatched-allow` and
  `tools.access-filtered`; warn explicitly when a run executes with zero tools;
  and include the final run status in the empty-output fallback.

## 0.5.2 - 2026-08-30

- Add the opt-in Linux `pi-bwrap-write` backend. Backend registration now owns
  the fixed access/tool preset: selecting this backend projects isolated
  workspace-write access without adding a duplicate configuration field.
- Resolve minimal selected-model provider authentication for Bubblewrap instead
  of inheriting the host environment, and show effective access, mounts, and
  process authority in the approval summary.
- Add a real Bubblewrap integration test covering Forge preparation, the
  backend-owned write preset, sandbox execution, and a direct git-workspace
  edit without provider network dependency.
- Report each backend's actual execution and mount-isolation capabilities in
  `/forge-agent backends` instead of describing every backend as read-only.

## 0.5.1 - 2026-08-23

- Added independent Linux, macOS, and Windows GitHub Actions verification for
  the optional package, including its packed-install smoke against the matching
  pi-forge host checkout. Generated output is pinned to LF across platforms.
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
  ui-contribution port (`@zihanw/pi-forge/ui-contribution`) so separate generic
  schema-driven Project and Global settings pages appear in the web editor when
  this package is installed. Each page edits only its raw `subagents.json`
  scope, exposes inherited values explicitly, and selects profile IDs from the
  live Forge catalog. `writeValues` re-validates server-side and preserves
  per-file provenance. The provider registers on session start and disposes on
  session shutdown.
- `/forge-agent config` prints the resolved effective subagent settings with
  sources (backend, timeout, unattended flag, summary flag, and per-profile
  delegation entries), mirroring what the web tab writes.

### Fixed

- Reworked Subagent Settings around explicit raw configuration scopes: trusted projects receive separate Project and Global pages with the exact target file shown, nullable top-level values use Inherit instead of materializing effective defaults, and writes replace only the selected scope's profile table while preserving unrelated keys. The profile key is now selected from the live Forge host catalog rather than typed manually; new missing, cross-scope, or ambiguous duplicate selectors are rejected server-side, existing orphan or legacy entries remain removable, and deleting a row now actually removes it from `subagents.json` instead of reappearing after autosave. Malformed files are reported without being overwritten.

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
- Global profile authorization now reports actionable warnings for bare keys
  such as `reviewer`, which authorize only `project:reviewer`; users must write
  `global:reviewer` for a global host profile. Profile discovery uses the same
  strict selector matching, so a bare key is no longer incorrectly treated as
  matching a global profile while still returning an empty catalog.
  Direct `forge_subagent` and runtime preparation failures now include the same
  `global:<id>` correction when that exact misconfiguration is detected.
- The Subagent Settings record editor now routes newly added `global:<id>`
  entries directly to the global `subagents.json`; their explicit scope is no
  longer lost to the trusted-project default write target. Editing also
  migrates an old wrong-file copy, and untrusted contexts cannot write explicit
  project selectors.
- Bare delegation invocations are canonicalized to `project:<id>` at the
  authorization boundary, preventing host effective lookup from falling back
  to a same-named global profile after a project-only bare authorization.

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
