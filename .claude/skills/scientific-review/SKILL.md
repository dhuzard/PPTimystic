---
name: scientific-review
description: Scientific presentation expert and builder loop for a PPTimistic deck. Reviews scientific validity, narrative, visuals, audience fit and likely Q&A questions as structured findings, lets the creator accept or reject each one in the human-review page, has the builder apply accepted changes with rebuild, validation and render, then independently re-reviews. Use when the user runs /scientific-review, or asks for a scientific, critical, expert, audience or "reviewer 3" review of a deck, or for Q&A preparation.
---

# Scientific review loop

The roles are defined in provider-neutral files. Read them once per session: [`agents/README.md`](../../../agents/README.md), [`agents/scientific-reviewer.md`](../../../agents/scientific-reviewer.md), [`agents/audience-panel.md`](../../../agents/audience-panel.md) and [`agents/presentation-builder.md`](../../../agents/presentation-builder.md). Also read `docs/scientific-review.md`. Follow `AGENTS.md` throughout. Below, `NAME` is the project and `P` is `projects/NAME`.

Arguments: a project name, and optionally `report` (review only: no revisions), `verify` (re-review after a revision) or a list of audience lenses. If no project is named, pick it as the story skill does and name your choice.

## 1. Review

1. Run `npm run review -- --project NAME --mode status` and `--mode prepare`. If `previews.current` is false and a renderer exists (`npm run doctor`), build the source language and render first (`npm run build -- --project NAME --locale <source>` then `npm run render -- --project NAME --locale <source>`), then prepare again. If the brief is not approved, you can still review; say on the page that revisions are blocked.
   Check `source_authority.authoritative` before any build or review. If false, stop for reconciliation of the preserved PPTX and YAML. Let the creator choose scope at the start with `review --mode configure --scope-slides S002,S003 --scope-classes wording,layout --by NAME`; transcribe only their choice. `all` permits every slide, `none` permits none; omission preserves existing scope. Existing projects default to no additional scope restriction.
2. Run the review in the `scientific-reviewer` subagent (`.claude/agents/scientific-reviewer.md`). Give it the project name and the lenses to apply. Choose them from the brief's audience: by default, the scientific expert plus `data-expert`, `reviewer-3`, `science-friend`, `methods-specialist` for methods/AI talks, and one lens matching the audience (`newcomer`, `decision-maker` or `field-rival`). When lenses are independent, run them as parallel subagents and merge their outputs into one `P/review/submission.yaml`, removing duplicates.
3. Run `npm run review -- --project NAME --mode submit`. If it reports errors, the subagent fixes the submission and resubmits. Never weaken a finding just to pass validation: errors mean the finding claimed something it could not support.

## 2. Creator decisions

1. Run `npm run review -- --project NAME --mode report`. It writes `P/review/review.md` and returns one thread per open finding.
2. If `human-review` is on the PATH, post each thread: `human-review suggest P/review/review.md --quote "<quote>" --replacement "<replacement>" --body "<body>" --agent "Scientific reviewer" --model "<model id>"`. Record each returned ID with `npm run review -- --project NAME --mode link --finding REV-… --thread <id>`. Open the page with `human-review P/review/review.md`, run `human-review poll P/review/review.md` in the background, and end your turn. Summarize the assessment, the two or three most important findings and the anticipated questions. Without human-review, show the report path and ask the creator to decide in chat.
3. Transcribe each decision exactly. Accepted thread: `--mode decide --finding REV-… --decision accept --by "<creator name>"`. Add `--authorize SLIDE` only when that thread's body said accepting authorizes an approved or locked slide. Rejected: `--decision reject`. A reply asking for something different: `--decision request-alternative --note "<what they asked>"`. The reviewer subagent then submits a variant under the same ID, and you post it. Never decide on the creator's behalf. Answer questions on the page with `human-review reply`.

## 3. Revise (skip in `report` mode)

Run the `presentation-builder` subagent (`.claude/agents/presentation-builder.md`). It runs `--mode plan` and `--mode apply`, handles deferred items (drafts go back to the creator as proposals), and reports from the manifest. Post blocked items and drafts on the page for the creator.

## 4. Re-review

Run `npm run review -- --project NAME --mode verify`, then start a **fresh** `scientific-reviewer` subagent for the verifications. It judges the current source and renders, not the builder's summary. Submit. Then run `--mode status`, and continue only while `can_revise` is true and the creator wants another round. The default limit is two revision rounds.

Give re-review only prepared context, original/current slide artifacts and extracted evidence. Exclude builder notes, reports, ledger history and manifests. Check contract success checks and claim types. Human claim verification belongs exclusively to a person; agents never verify on their behalf.

## Mandatory scientific positioning and readiness signoff

Before substantial authoring, challenge the brief's intellectual framing: look for relevant prior approaches, an overstated or unclear contribution and a missing demonstrated mechanism. Do not merely make the initial creator framing more fluent. For the final deck, after the independent re-review, run `npm run readiness -- --project NAME --mode prepare`, ask a fresh scientific-reviewer context (with the methods-specialist and field-rival lenses when relevant) to fill `review/readiness-submission.yaml`, then run `npm run readiness -- --project NAME --mode submit` and `--mode status`. The gate must address the six mandatory areas, alternatives, implemented-versus-proposed claims and difficult questions. If NOT READY, present the blockers to the creator **before** discussing slide aesthetics. Draft builds and previews are allowed; the final `bundle` is blocked. Never let an agent approve a human override. Full contract: `docs/readiness-gate.md`.

## Finish

Report the files changed, changed slide IDs, retained assets, languages awaiting translation review, validation results, render folders (and whether images were actually viewed), findings resolved, rejected, blocked or stalled, open questions for human scientific review, and the anticipated questions with their answer basis. Never claim the science is verified: say what a person still has to check.
