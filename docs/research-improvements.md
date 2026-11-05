# Frontier models and related-project research

Researched November 4, 2026. This pass inspected public documentation, GitHub READMEs, selected implementation files, and the installed Muse SDK declarations. No third-party plugin was installed, no external source code was copied, and no Muse runtime or provider was contacted.

## Model policy for difficult work

Meta describes Muse Wonder as its most capable model family for complex software engineering, with Wonder Full as the higher-capability variant. Full is offered through eligible Muse Code subscriptions; API-key access to Wonder is not access to Full. Reasoning effort `max` does not turn Wonder into Full. These are product descriptions, not a BranchPilot quality benchmark. [Meta model catalog](https://dev.meta.ai/docs/models), [Wonder overview](https://dev.meta.ai/models/muse-wonder).

The Muse templates now request:

```json
{
  "agent": {
    "model": {
      "kind": "preference",
      "choices": [
        { "displayLabel": "Muse Wonder Full" },
        { "modelId": "muse-wonder-1.0" }
      ]
    },
    "effort": { "kind": "highest", "minimum": "high" }
  }
}
```

Each choice is an exact selector against the host's `model/list` result. The Full label is a preference, not a claim that every runtime/account exposes that spelling. Its actual selectable ID comes from the matching row. If the label differs, replace the selector with the exact `providerId` and `modelId` observed in your runtime. Ambiguous matches fail before a turn. The source of these fields and effort capabilities is `ModelCatalogEntry` in the installed SDK 1.4.14 declarations (`dist/src/msp.d.ts`). [Official SDK repository](https://github.com/meta-models/muse-code-sdk).

When Full is absent, the explicitly listed Wonder choice is allowed and its fallback reason is recorded. Remove the second choice to require Full. If neither is advertised, execution fails before submitting a prompt; there is no Spark or host-default fallback. The highest known advertised tier is selected in the order `max`, `xhigh`, `high`, subject to the minimum. Unknown capabilities, unsupported tiers, and an ambiguous model require configuration changes. A selected model with insufficient effort evidence does not silently fall through to another model.

Settings must apply and pass readback before work begins. Confirmed provider/model/effort and selection reasons are persisted per attempt and shown in reports. Recovery retains the original confirmed selection rather than resolving a new preference. This policy applies to every attempt in the configured run: it does not use a speculative difficulty classifier or delegate implementation to a cheaper model.

Use `examples/muse-frontier.template.json` for longer attempts and automatic strategy selection. Its illustrative limits are 256,000 total tokens, four attempts, 64,000 reserved tokens and 30 minutes per attempt, concurrency one. Replace the fixture task/evaluator and choose your own limits. Reservations include the usage reported for the session, not only visible answer tokens, and cancellation is not a hard provider cap. `examples/muse.template.json` retains the small compatibility-example budget with the same model preference. Both still require an independently verified runtime lock.

## Related work and decisions

| Project / primary source | Relevant idea | BranchPilot decision |
|---|---|---|
| [SWE-Search / Moatless](https://github.com/aorwall/moatless-tree-search), [feedback implementation](https://github.com/aorwall/moatless-tree-search/blob/main/moatless/feedback/feedback_agent.py), [ICLR paper](https://arxiv.org/abs/2410.20285) | Search with iterative feedback; learning from alternative branches while distinguishing their file state. | Added bounded development-history handoffs and explicitly labeled sibling findings for tree attempts. Our summaries use existing records, with no extra model judgment call. |
| [agent-mcts](https://github.com/natsu0529/mcts-llm-agent) | Wrap an existing coding agent with isolated branches, external test feedback, a journal, and budget-aware search. Its README explicitly treats missing cost as unknown. | Added different approach prompts for alternatives and a narrow escape from repeated failed retries. Retained independent evaluation and unresolved-usage liabilities. Our tree strategy remains a bounded beam, not MCTS. |
| [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md), [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | Structured branch summaries, cumulative file tracking, and persisted state separate from model context. | Added cumulative changed-file summaries and bounded ancestor/sibling context. Full evidence stays in the run archive; reports show actual confirmed model settings. |
| [Aider repository map](https://aider.chat/docs/repomap.html), [architect/editor approach](https://aider.chat/2024/09/26/architect.html) | Select useful context within a budget; separate design reasoning and mechanical editing when the workflow benefits. | Keep stable task instructions at the front and compact evaluation samples into estimates, uncertainty, and sample counts. A separate paid architect/editor stage is deferred pending evidence of benefit with Muse. |
| [claude-code-muse](https://github.com/jellologic/claude-code-muse) | A real Muse delegation plugin whose supervisor runs acceptance checks on the final worker tree. Completion and acceptance are distinct. | Retained independently executed checks on exact snapshots and explicit usage provenance. Its inexpensive worker defaults are not the model policy used here. |
| [Sparkguard](https://github.com/ReARCLabs/sparkguard) | Muse plugin with persisted rules, pre-tool checks, and file snapshots. | Retained controller enforcement and snapshot isolation; handoffs now explicitly distinguish evidence text from governing instructions. No model-based referee or network memory service was added. |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | Small agent control flow and inspectable trajectories. | Keep additions local and inspectable instead of introducing another agent framework. No new dependencies. |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Durable workflow state, interrupts, and recovery. | Retain the existing event log, reservation ledger, and recovery receipts. A framework migration would not resolve Muse's transport-specific question-continuation limitation. |

Repository claims and benchmark numbers were not independently reproduced. None is evidence of a measured improvement for BranchPilot or Muse.

## Behavior added

- **Handoffs:** the base snapshot, cumulative changed files, current checks, metric estimates/uncertainty/sample counts, and recent development findings accompany a fresh session. Up to four ancestors and three siblings fit within a 12,000-character history budget. Larger text is explicitly abbreviated. This is a history limit, not a token limit for the entire prompt. Goals and constraints remain intact.
- **Independent alternatives:** best-of-N receives no sibling results or proposals. Alternatives cycle through three task-specific focus prompts; this encourages diversity without claiming that it guarantees different solutions. Parallel dispatch preserves the same intent ordering.
- **Stagnation escape:** automatic retry can switch to best-of-N after two completed, settled attempts produce identical snapshots, proposals, hypotheses, and complete failed executable development evidence. New findings, changed metrics, missing evidence, infrastructure trouble, or unresolved work prevent this shortcut. It uses the existing remaining budget and does not affect fixed retry mode.
- **Held-out protection:** no held-out evaluation rows enter handoffs or stagnation decisions. Final selection still closes development.

The changes add no extra model calls. Their expected benefit is better use of paid attempts; actual solution quality, latency, and token cost still need a controlled live comparison. Shorter serialized feedback or fewer repeated attempts must not be presented as a measured model speedup.

## Deferred work

Strict compilation and all **200 offline tests passed** after this pass. The 18 added regressions cover model preferences/effort, confirmation before dispatch, confirmed-setting replay/recovery, handoff boundaries, distinct independent prompts, and stagnation decisions. No model quality or live throughput benchmark was run.

Live catalog/entitlement verification, root-only accounting, permissions, edits, cancellation, containment, and recovery remain unverified. Full availability and its exact catalog label must be checked with the intended account. Native workers stay disabled pending complete child accounting. Live question continuation still needs a persistent host. UCT/MCTS, model-based critics, and separate architect/editor calls need a trustworthy reward/usage design and task-level quality comparisons before being added.
