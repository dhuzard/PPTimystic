# Agent roles

These files define PPTimistic's agent roles in plain Markdown. They are provider-neutral: any agent host that can read files and run `npm` commands can take a role, whether Claude Code, Codex or something else. Host-specific wrappers, such as `.claude/skills/` and `.claude/agents/`, only point here. The editorial and scientific contract in [`AGENTS.md`](../AGENTS.md) applies to every role.

| Role | File | Writes | Never |
| --- | --- | --- | --- |
| Scientific presentation expert | [scientific-reviewer.md](scientific-reviewer.md) | `review/submission.yaml` (findings, verifications, questions) | edits slides, decides for the creator |
| Audience panel (review lenses) | [audience-panel.md](audience-panel.md) | perspective-tagged findings and anticipated questions, inside the reviewer's submission | edits slides |
| Presentation builder | [presentation-builder.md](presentation-builder.md) | source changes through `review --mode apply`, `npm run revise`; builder submissions | changes anything the creator did not accept |
| Story maker | [`.claude/skills/story/SKILL.md`](../.claude/skills/story/SKILL.md) | `story/suggestions.yaml` | applies unaccepted suggestions |
| Review orchestrator | `npm run review` (deterministic code, not an agent) | ledger, plan, manifests, review page | performs semantic review |

## How the roles exchange work

Roles never pass free-form messages to each other. They exchange validated artifacts through the deterministic `review` command:

```text
review --mode prepare  → review/context.json         (what the reviewer works from)
Scientific reviewer    → review/submission.yaml      → review --mode submit → review/ledger.yaml
review --mode report   → review/review.md + threads  (creator accepts / rejects / discusses)
review --mode decide   → decisions recorded per finding, stamped with each slide's fingerprint
review --mode plan     → review/plan.yaml            (ready, blocked and deferred items)
Presentation builder   → review --mode apply         → source changes + build + validation + render
                                                     → review/manifests/<plan>.manifest.yaml
review --mode verify   → checks the manifest against the actual source, then prepares re-review
Scientific reviewer    → verifications (+ regressions) → review --mode submit
review --mode status   → deterministic stop / continue decision
```

The reviewer and builder should run as separate agent contexts when the host allows it. The reviewer judges the revised deck from the current source and renders, never from the builder's report. See [docs/scientific-review.md](../docs/scientific-review.md) for commands, file formats and modes.
