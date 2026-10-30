# BranchPilot

Architecture for a budgeted search controller using Meta Muse Code as its initial coding agent.

- [Architecture proposal](docs/architecture.md): module boundaries, SDK mapping, lifecycle, evidence and budgets, recovery, compatibility tests and staged implementation.
- [TypeScript contracts](docs/contracts.ts): proposed BranchPilot domain and service interfaces; no SDK dependency or runtime implementation.
- [Configuration examples](docs/config-examples.ts): benchmark optimization and idea exploration, checked against the proposed contracts.

This repository currently contains the design only. Referenced fixtures, evaluator definitions, isolation profiles and the tested Muse compatibility lock are future implementation inputs. Start with stage 1 of the architecture: one Muse attempt, one external evaluator and a persisted result.
