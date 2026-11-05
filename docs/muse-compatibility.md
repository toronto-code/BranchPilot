# Muse research and offline compatibility audit

Checked November 4, 2026. This audit used Meta's public documentation, its official SDK repository, npm package metadata, and the installed SDK's code/types. No Muse executable, account login, provider request, or live compatibility experiment was run.

## What Muse means here

Muse Code is the terminal/CI coding agent. BranchPilot controls that agent through the Muse Session Protocol (MSP), using `muse serve` and the TypeScript SDK. It does not call Meta's model API directly. [Meta's Muse Code overview](https://dev.meta.ai/docs/muse-code).

Meta lists Muse Spark 1.3 (`muse-spark-1.3`) for cost/latency-sensitive agentic work and Muse Wonder (`muse-wonder-1.0`) for complex, long-running software work. Both have a documented 1,048,576-token context window. Wonder Full is a separate Muse Code subscription variant; raising Wonder's reasoning effort does not select Full. These are Meta's product descriptions, not BranchPilot measurements. [Meta's model catalog](https://dev.meta.ai/docs/models).

BranchPilot supports host defaults, an exact provider/model, or an ordered preference list. The Muse templates now prefer Wonder Full and then Wonder, with the highest known advertised effort; see the [frontier policy](research-improvements.md). Use the **runtime's** `model/list` identifiers and advertised effort `variants`; API model names and documentation examples do not prove a particular account/runtime offers them. An empty catalog and absent active/default rows are legitimate host states. Unknown effort capability cannot justify an explicit effort request. [Model selection cookbook](https://meta-models.github.io/muse-code-sdk/1.4/cookbook/list-models-and-switch-mid-session/).

## SDK and schema findings

The official source and npm metadata reported SDK **1.4.14**. The repo now pins that exact version in both package files and the adapter. Meta recommends pairing SDK/runtime versions and checking changes before upgrading. Its source mirror's publish anchor also names host 1.4.14; the fetched general changelog still starts at 1.4.2, so it does not establish patch-specific runtime behavior. [SDK package source](https://github.com/meta-models/muse-code-sdk/blob/main/clients/sdk-ts/package.json), [pairing policy](https://github.com/meta-models/muse-code-sdk), [publish anchor](https://github.com/meta-models/muse-code-sdk/blob/main/publish-anchor.json), [changelog](https://github.com/meta-models/muse-code-sdk/blob/main/CHANGELOG.md).

The SDK's embedded stable-schema fingerprint is `sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6`. That is an SDK identity, not a fabricated observation of an installed host. Public documentation snapshots can describe different generated schemas. Obtain the actual served fingerprint during future authorized verification.

The SDK treats its own fingerprint mismatch as advisory. BranchPilot now records that warning, while still requiring the served version/fingerprint and binary digest to match the independently verified run lock. This also avoids confusing the SDK's stable-schema pin with a negotiated experimental surface. [Compatibility policy](https://meta-models.github.io/muse-code-sdk/1.4/compatibility/).

The `permissionState` readback used by `requirePermissionProfile` is absent from the SDK's stable Session type. Permission-profile inspection is experimental. The adapter now requests `experimentalApi: true`, checks that it was negotiated, and independently confirms the workspace, session identity, permission profile, and denial mode before submitting a turn. The simulated host now withholds experimental fields unless negotiated. [Permission-profile reference](https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/methods/permissionprofile-list/), [Session reference](https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/types/session/).

## Compatibility corrections implemented

| Area | Change verified offline |
|---|---|
| Model/effort changes | Wait for application after acknowledgement, then verify settings before sending the prompt; waiting is bounded and cancellable. |
| Permissions | Explicit experimental negotiation, SDK profile confirmation, and approval-mode/workspace readback. |
| Durability | Reject ephemeral and unknown durability profiles before model work. Hosts reporting unavailable sandbox enforcement also fail before a turn. |
| SDK identity | Hash all runtime JavaScript modules, and freeze that identity with the run's backend manifest. |
| Authentication | Optional `backend.apiKeyEnv: "META_API_KEY"`; retain runtime-home authentication by default. Never serialize the key value. |
| Environment | Explicit HOME, XDG configuration/data paths, and scratch directory; unrelated ambient variables are excluded. |
| Child work | Detect native child/workflow/background items, request cancellation, persist an untracked-work marker, and keep usage/termination unresolved. |
| Recovery | Parent-only history cannot erase the untracked-work marker or settle child usage. |
| Questions | Normal owned-host execution declines dialogs. Live answer continuation is unavailable for this transport, regardless of a lock flag. |

A model-setting acknowledgement confirms admission; the durable setting can arrive later. The old implementation could reject a valid delayed change. The new checks handle that delay while retaining final readback. [Model selection cookbook](https://meta-models.github.io/muse-code-sdk/1.4/cookbook/list-models-and-switch-mid-session/).

Muse's parent `session/tokenUsage.cumulative` excludes subagent/workflow-child usage. Summing raw cache fields would also miscount the normalized total. This controller supports root-only work: observed child activity leaves a liability requiring independent complete-usage and stop evidence. It does not claim automatic aggregation of a child tree. [Token-usage wire reference](https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/notifications/session-tokenusage/); the installed SDK's `SessionTokenUsageParams` documents child ownership explicitly.

An absent durability field means durable under MSP's compatibility contract; an unknown value does not. This controller needs durable sessions for its recovery design. [Durability profiles](https://meta-models.github.io/muse-code-sdk/1.4/guides/msp-concepts/durability-profiles/).

## Prepare configuration without running Muse

`examples/muse.template.json` provides a configuration scaffold with frontier model preferences and placeholder paths. `examples/muse-frontier.template.json` adds longer attempt limits and automatic strategy selection. `examples/muse-lock.template.json` intentionally cannot authorize execution. Validate configuration syntax without starting anything:

```sh
npm run build
node dist/src/cli.js validate examples/muse.template.json
```

After copying the template, replace paths relative to the new config location. The fixture input/evaluator demonstrate a tiny repair; substitute your actual task before a real run. `doctor` checks local SDK/lock/binary identities only and never launches Muse. Neither command validates authentication or model availability.

For API-key authentication, add `"apiKeyEnv": "META_API_KEY"` to the backend object, and later set that variable outside the config. The same optional field is supported in a smoke specification. Otherwise authenticate the dedicated runtime home when live setup is authorized. Meta documents `META_API_KEY` for noninteractive environments. [Authentication entry point](https://dev.meta.ai/docs/muse-code).

The child process uses `runtimeHome/.config` and `runtimeHome/.local/share` for XDG configuration and data. It does not inherit personal XDG paths. Muse reports its actual data directory as `museHome`; live verification must check that value against the intended directory. [Host operations](https://meta-models.github.io/muse-code-sdk/1.4/guides/host-operations/).

## What still requires real verification

The original compatibility pass had **182 passing offline tests**, including delayed settings, experimental negotiation refusal, missing permission evidence, wrong approval mode, advisory fingerprints, cancellation during setup, all supported child-work detection paths, persistent liabilities, environment handling, and the owned-host continuation block. Subsequent frontier-policy and handoff validation is recorded in [release status](release.md). The suite exercises the real SDK over synthetic frames, plus actual local fixture evaluation. It cannot establish real provider behavior.

The outstanding live gate is the exact SDK/binary pair: authentication, advertised catalog, chosen settings, permissions, an actual file edit and external check, complete root-work usage, cancellation/descendant termination, filesystem containment, and retained recovery. Concurrent hosts remain separately gated. No lock was marked verified and no smoke case was executed against Muse.

**Question continuation needs a transport change as well as testing.** Meta documents that closing the stdio host cancels active turns. The current CLI owns and closes a host per operation, so a later `answer` cannot assume that a pending turn survived. Setting `questionContinuationVerified` cannot enable this path. The existing answer engine is retained for offline protocol tests/future persistent-host integration; production execution declines dialogs and cancels unexpected requests. Read-only reconciliation remains separately gated. [Host shutdown contract](https://meta-models.github.io/muse-code-sdk/1.4/guides/host-operations/).

Root-only operation still requires native workers to be disabled in the verified runtime configuration. Detection is a fallback for visible work, not proof that an arbitrary external tool launched no hidden process. The compatibility lock must reflect actual observed facts; documentation and passing simulations are insufficient.
