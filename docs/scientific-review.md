# Scientific review and revision

A deck can be well built and still overstate its evidence, lose its audience or bury its argument. The scientific review workflow adds three things to PPTimistic:

- a **scientific presentation expert** (an agent) that critically reviews the deck and records structured findings;
- a **presentation builder** (an agent) that implements only the changes the creator accepted;
- a deterministic **orchestrator**, `npm run review`, that validates every exchange, records decisions, plans and applies revisions safely, and decides when to stop.

> The scientific presentation expert identifies and justifies improvements. The builder implements authorized changes. Deterministic validators test machine-checkable properties. A subsequent independent review evaluates whether the scientific communication actually improved.

`npm run review` never performs AI analysis. The semantic review comes from whichever agent you run with the role files in [`agents/`](../agents/README.md). In Claude Code that is `/scientific-review NAME`; any other agent host can read the same files. Without a connected agent, the command still prepares context, validates submissions and manages decisions, plans and revisions, and says so.

## The loop

```text
BUILD → REVIEW → (creator decides) → PLAN → AUTHORIZE → REVISE → VALIDATE → RENDER → RE-REVIEW → FINALIZE
```

| Step | Command | Who |
| --- | --- | --- |
| Prepare review context | `npm run review -- --project NAME --mode prepare` | orchestrator |
| Review | writes `review/submission.yaml` | reviewer agent |
| Record the review | `npm run review -- --project NAME --mode submit` | orchestrator (validates, all or nothing) |
| Review page | `npm run review -- --project NAME --mode report` → `review/review.md` + human-review threads | orchestrator |
| Decide | `npm run review -- --project NAME --mode decide --finding REV-001 --decision accept --by "Name"` | **creator** (an agent may only transcribe their decision) |
| Plan | `npm run review -- --project NAME --mode plan` → `review/plan.yaml` | orchestrator |
| Revise, build, validate, render | `npm run review -- --project NAME --mode apply` | builder agent |
| Check and prepare re-review | `npm run review -- --project NAME --mode verify` | orchestrator |
| Re-review | submits `verifications` | reviewer agent (fresh context) |
| Continue or stop | `npm run review -- --project NAME --mode status` | orchestrator |

Other modes: `link` records a human-review thread ID for a finding, and `configure` changes the workflow mode or round limit (`--by` is required).

The creator can restrict revisions at the start:

```sh
npm run review -- --project NAME --mode configure --scope-slides S002,S003 --scope-classes wording,layout,object-geometry --by "Name"
```

Set both scope options together. `--scope-slides all` permits every slide; `none` permits none. Omission retains previous settings; existing projects default to no additional scope restriction. Scope applies to assisted and autonomous plans and is rechecked at apply. A move affects the interval it crosses; throughline/framework changes affect all slides. Scope exclusions also prevent recording manual work as implemented. Arbitrary edits outside these commands cannot be policed.

## Modes

- **review-only**: findings, assessment and questions only. `plan` and `apply` refuse to run.
- **assisted** (default): the creator accepts or rejects each finding, and the builder applies accepted ones.
- **autonomous**: the creator opts in, in an interactive terminal, to named change classes (`object-geometry`, `layout`). The builder may then apply those without a per-finding decision, but only for visual, technical or accessibility findings with a verified or evidence-based basis, and only on draft, unprotected slides. Scientific wording, evidence classes, data, citations, chart values and the storyline always need a decision.

The default limit is **two revision rounds** (`configure --max-rounds N`, from 1 to 10). The status command stops the loop when no critical or major finding remains open, when only creator decisions remain, when findings have stalled (two failed attempts), or when the limit is reached. A model's own quality score is never a stopping criterion.

## Findings

Each finding has a stable ID (`REV-001`), a `category` (scientific-validity, evidence-provenance, narrative-structure, visual-design, accessibility, audience-suitability, pacing, editorial-clarity, technical-quality), a `severity` (critical, major, minor, optional) and a separate `basis`:

| Basis | Meaning |
| --- | --- |
| `verified-error` | demonstrable from a cited source, claim link or validation code the finding lists |
| `evidence-based-concern` | a supported reason to doubt, not proven |
| `editorial-judgment` | a reasonable editorial choice |
| `design-preference` | a subjective visual preference |
| `open-question` | information is missing |

Severity never implies verification. `evidence.status` has no "verified" value. The most it can say is `source-read-by-reviewer`, which means the reviewer read the locally extracted passage; whether it supports the wording remains a human decision. Each finding also records what was `inspected`, the lens (`perspective`), the agent and model, the review round, the deck revision and every targeted slide's fingerprint.

Every new finding requires `changes_scientific_meaning: true|false`, including visual findings. Autonomous mode refuses true values even for accepted findings; use assisted mode for creator-approved scientific changes. Legacy records without the flag are read conservatively as true. Updating the flag requires a fresh creator decision. This enforces a declared restriction; a reviewer can still misclassify meaning.

## Explanatory contracts

The story maker owns optional `explanatory_contract` entries in `content/storyline.yaml`. Old storylines remain valid. A contract records the audience question, central message, prerequisites, worked example (or explicit null), text to preserve and success checks. `introduces` names concepts the slide explains:

```yaml
slides:
  S003:
    role: approach
    explanatory_contract:
      audience_question: What can a review return?
      central_message: NONE is a legitimate outcome
      introduces: [review outcome]
      prerequisites: []
      worked_example: A sound slide returns NONE without an unnecessary edit.
      must_preserve:
        - {field: body, text: NONE is a legitimate outcome, locale: en-US}
      success_checks:
        - The audience can explain when NONE is appropriate.
```

Prerequisites use explicit concept names, compared case-insensitively in actual deck order. Story checks flag later introductions and prerequisites with no recorded introduction; the latter may already be audience prior knowledge. They do not infer dependencies from prose. `story --write-markdown` includes the contract for narrative review.

`must_preserve` binds text to a visible field (`title`, `message`, `body` or `caption`) and optional locale (default source language). Apply checks the source field and native text objects, normalizing whitespace and Unicode NFC. Deleting the text, moving it to notes or selecting a layout that omits it rolls back every source change before build. The original contract remains the transaction baseline. Exact text can still mislead in context; preservation does not establish scientific validity. Success checks join findings' acceptance criteria at submit and re-review; their semantic success remains the critic's judgment.

## Claim types and personal verification

Claims in `content/slides.yaml` support `claim_type`: `definition`, `measured-result`, `implemented-capability`, `proposed-capability` or `illustrative-example`, independently of slide evidence strength. Optional `qualification_note` records scope, uncertainty or implementation limits. Older claims display as unclassified.

Only a person verifies a claim after reading its source:

```sh
npm run claims -- --project NAME --verify S003/C001 --by "Name"
```

This needs interactive human confirmation and a classified, valid claim; protected slides also require explicit `--authorize S003`. It records `human_verification: {verified_by, verified_at, claim_sha256}`, with backup and feedback history. Reports expose type, qualification and verification state without excerpt text. Changes to wording, type, qualification, translation or source provenance make verification stale. Agents may transcribe metadata a person explicitly supplies but never verify on their behalf. Direct filesystem access cannot authenticate the identity of someone editing YAML.

## Independence and source authority

`prepare` reports `source_authority` for every output language, including actual PPTX slide counts. Modified, untracked or unverifiable deliveries, unreadable PPTX files and PPTX/YAML count mismatches require reconciliation before reviewer submission. Missing output permits source-only review; stale output is identified separately. These checks never overwrite a delivery or perform general PPTX import. Snapshot revisions include source/extraction and output bytes, so changes after preparation invalidate submissions.

Re-review context includes original snapshots, current slides, before/after values, available render comparisons, evidence and contract success checks. Builder justifications, decision discussion notes and links to builder manifests are excluded. Acceptance snapshots cover manual work too; missing legacy snapshots are explicit. Use a fresh reviewer context and do not supply builder reports through another channel.

Reviewer instructions require every claimed safeguard to show what it rejects and a relevant error that can still pass. Mechanisms should expose inputs, decisions and outcomes. Specific defect prompts cover precision called accuracy, conclusions before prerequisites, examples that fail to show their limitation, and proposals described as implemented.

The full schema is in [`src/review/schema.ts`](../src/review/schema.ts). The role files contain annotated examples.

### What `submit` refuses

Submissions are checked against the current deck and rejected as a whole, so nothing is recorded, when:
- the deck changed after `prepare` (`context_revision` mismatch);
- a slide, object, source or claim ID does not exist;
- a recommendation is malformed: no acceptance criteria, a single-slide change aimed at several slides, an empty geometry change;
- suggested wording introduces **numbers or DOIs** found neither on the slide nor in its extracted sources (this catches invented sample sizes, statistics and references, but not invented words);
- a finding upgrades unsourced content to `established` or `interpretation`;
- a finding claims `rendered-preview` inspection for a slide without a current render, or a source reading for a source with no extracted text;
- a `verified-error` about scientific validity cites nothing that demonstrates it;
- a slide is marked `no-change-needed` while the same submission proposes a major change to it;
- a visual or accessibility finding is marked `resolved` without viewing a current render.

### Duplicates and loops

Reusing an ID updates that finding. A new finding with the same category, slides, objects and change target as an existing one is merged into it. A finding the creator rejected or deferred, or that was withdrawn, is **suppressed** if raised again, unless the reviewer gives `reopen_reason`. A resolved finding that comes back is reopened for a decision. Two unsuccessful re-reviews mark a finding `stalled`.

### Statuses

`proposed` → (`discussing`) → `accepted` / `rejected` / `deferred` → `applied` → `resolved` / `unresolved` / `stalled`. The builder can mark a finding `blocked` (missing evidence or creator input), or `applied` for manual work. Changing a finding's proposed change, or a builder drafting its wording, sends it back to `proposed`.

## Safety guarantees

- **Brief gate.** Reviewing is allowed before the brief is approved; planning, revising and building are not.
- **Protection.** A change to an approved or locked slide is blocked unless the creator's recorded decision includes `--authorize SLIDE`. `applyRevision` and the build check protection again.
- **No stale overwrites.** Each decision records the fingerprint of every targeted slide. If a slide changed after the decision, its plan item is blocked until the creator confirms again. Each plan item records the hash of its target's current value, and `apply` refuses the whole plan if any target changed after planning.
- **All or nothing.** `apply` snapshots the source. If any change or the build fails (for example text overflow or an object outside the slide), it restores the source, records the failed attempt under `feedback/`, keeps the findings accepted with `last_error`, writes a `rolled-back` manifest and exits with an error.
- **One writer.** `apply` refuses while a shared session holds the project lease.
- **Translations.** Source-wording changes make other languages' translations stale. The builder rebuilds every language whose translations are still current, and lists the others under `build.locales_not_built` and `translation_review_required` for review with `npm run translate`.
- **History.** Every submission is archived under `review/submissions/`, and every ledger version under `review/history/`. Plans and manifests are kept under `review/manifests/`, source backups under `feedback/`, and builds under `output/history/`.

## Files

| File | Content |
| --- | --- |
| `review/context.json` | what the reviewer works from: brief, storyline, slides, sources, validation, heuristic prompts, render status, open findings, items to verify |
| `review/submission.yaml` | the agent's latest submission (template: `submission.template.yaml`) |
| `review/ledger.yaml` | authoritative findings, decisions, questions, assessments, settings and history |
| `review/review.md` | the human-review page |
| `review/plan.yaml` | the current revision plan |
| `review/manifests/PLAN-….manifest.yaml` | what was actually changed: before and after values, feedback records, changed slides, retained assets, build, validation, render and comparisons |

All of these contain slide text and may contain confidential material. Keep them local; `projects/*` is not committed.

## Heuristic prompts

`context.json` includes lexical prompts: causal wording on a non-established slide, claims without claim-level provenance, numbers without a linked claim, fictional charts, and illustrations on evidence slides. They only tell the reviewer where to look. They are not findings and establish nothing.

## Limitations

- The quality of the review depends on the reviewer agent. The orchestrator can check that a finding is well formed, traceable and honest about what was inspected. It cannot check that the finding is right.
- The number and DOI check cannot catch invented words, mechanisms or citations written without a DOI.
- Findings are reviewed in the source language. Translations are reviewed separately.
- Manual changes (new slides, charts, illustrations, animations) are made with existing commands and reported by the builder. The orchestrator verifies only that the slide changed.
- The browser studio does not yet show review findings. Decisions use the human-review page or the CLI.
- Rendering requires LibreOffice and pdftoppm, or PowerPoint on Windows. Without one, visual findings cannot be resolved.

## Fictional smoke fixture

Run `npx tsx tests/fixtures/review-increment.ts EMPTY_OUTPUT_DIR powerpoint` (or `libreoffice`/`auto`) to retain a fresh demo build, before/after previews and `qa-manifest.json`. It exercises prerequisite prompts, destructive-change rollback, a permitted revision, accepted-asset retention and original snapshots. Findings and creator decisions are explicitly synthetic. This is a deterministic integration check; it does not run agents, score defect detection or establish scientific communication quality. The separate evaluation harness remains deferred.
