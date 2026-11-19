# Mandatory Scientific Positioning & Readiness Gate

A polished deck can be scientifically under-positioned. PPTimystic must **not** confuse improving a creator's initial narrative with independently assessing whether that narrative is fit for its audience.

The gate is required for every **real project using the approved-brief workflow** before the delivery bundle is produced. Draft PowerPoint builds and renders remain permitted because a reviewer needs them to examine the material. They are **not** release approvals. Directly copying files from output/ bypasses the packaging workflow; no local tool can prevent manual distribution.

## Principle

The reviewer must ensure that the presenter can explain:

1. **What is demonstrated** — the actual result, implementation and tested boundary.
2. **What is not demonstrated** — proposals, extrapolations, unvalidated mechanisms and missing evidence.
3. **How it fits the field** — relevant alternatives, intellectual contribution and reasons for choosing the approach.
4. **What an expert will challenge** — questions, defensible answers, unknowns and the audience's expected level.

This is **not** a requirement to mention neuro-symbolic AI, embeddings, encoders, decoders or any fashionable method. Mention and compare a method only when it is genuinely relevant to the problem, audience and claimed contribution. The gate must reduce confusion, not inflate jargon.

## Required independent scientific checks

Every gate submission has six mandatory dimensions, each marked pass, warning or block, with a substantive assessment, explicit evidential basis or gap, and action for the presenter.

| Dimension | What the reviewer must establish |
| --- | --- |
| Problem and contribution | Why the problem matters; the contribution, novelty and scope; what is already known |
| Methodological landscape | Relevant established approaches and alternatives; where the current work sits; trade-offs, without obligatory jargon |
| Actual mechanism | Inputs, algorithmic steps, where safeguards run, what they reject, what they *cannot* reject; architecture versus aspiration |
| Evidence and limitations | Measured results versus smoke tests, illustrated examples, external work and future research; baseline adequacy and uncertainty |
| Narrative value | Whether each section adds a distinct scientific step, and which repeated slides or claims should be consolidated |
| Expert audience readiness | Suitability for the exact audience and venue; use case, defensible Q&A, and what the speaker must know |

Additionally:
- Give at least one meaningful alternative (or a substantiated explanation of its irrelevance). The alternatives field may mark an option not relevant; it must explain why.
- Classify actual capabilities as implemented, demonstrated, proposed or conceptual with evidence and boundaries.
- Write at least three difficult questions and mark their answers supported, partial or unknown.
- State relevant materials *not inspected*. Do not claim independent source/code/literature inspection when it did not happen.
- In a methods/AI conference, explicitly distinguish symbolic validation, retrieval, constrained decoding, end-to-end learning and neuro-symbolic integration *where they are materially relevant*. A tutorial or clinical talk has different comparators.

A reviewer must first read the approved brief and slides, independently reconsider the intended framing, then inspect available code, source literature and speaker notes as necessary. A separate agent context reduces anchoring but cannot prove reviewer independence.

## Workflow and hard boundary

Prepare and run the ordinary scientific review first. Address its findings and rerun the independent review after scientific revisions.

~~~sh
npm run review -- --project my-talk --mode prepare
# Independent reviewer submits review/submission.yaml, with findings and assessment
npm run review -- --project my-talk --mode submit

npm run readiness -- --project my-talk --mode prepare
# Different reviewer context fills review/readiness-submission.yaml
npm run readiness -- --project my-talk --mode submit
npm run readiness -- --project my-talk --mode status
npm run bundle -- --project my-talk
~~~

The readiness process produces:
- review/readiness.json — current structured assessment with the reviewer identity and revision
- review/readiness.md — human-readable scientific readiness report
- review/readiness-submission.yaml — reviewer draft; incomplete placeholders cannot pass schema validation

**An independent AI verdict is not human approval.** The authenticated presenter must open the HTML studio, review the complete report, acknowledge its four statements and sign off on the exact current revision. Without this final manual sign-off, **all real-project final downloads and bundles are blocked**, even when the reviewer says READY.

**NOT READY** or any unresolved critical/major scientific finding blocks bundling. A stale review, missing assessment or changed source/asset/output blocks bundling irrespective of previously recorded approval. **READY WITH WARNINGS** allows bundling only when there are no unresolved critical/major findings; the warnings remain visible.

The gate deliberately distinguishes *scientific readiness* from *scientific truth*. A structured AI review cannot prove scientific correctness. Its findings remain accountable to a human scientific expert. External edits made to a delivered PowerPoint must first be reconciled with the reviewed source.

## Human override

A creator can explicitly accept known scientific risks, including a NOT READY reviewer verdict, but only after a **current** independent review and readiness record exist:

~~~sh
npm run readiness -- --project my-talk --mode override \
  --by "The presenter" \
  --reason "I accept the unresolved methodological positioning and will explicitly disclose its limits."
~~~

The CLI asks for an interactive confirmation, default **No**. The HTML studio also provides a human-only risk override requiring a substantive reason and an explicit acknowledgment; a separate final presenter sign-off is still required. It writes the presenter, reason, timestamp and a hash bound to the assessed revision. The delivery manifest records the override and outstanding risks. An override cannot excuse no review, invalid files, stale evidence or missing provenance. Non-interactive agents cannot approve an override through the CLI.

## Change invalidation and limits

A gate decision is bound to the deck/source revision and source fingerprints, including relevant assets. Changes to slides, inputs, translations, themes or output PowerPoint files require a fresh assessment. A human override is bound to the exact prior reviewer record and does not silently apply to modified assessments.

The deterministic CLI validates structure, source freshness, substantive fields, reviewer-verdict consistency, unresolved review findings and recorded overrides. It **cannot** independently verify that the reviewer truly understood the field, that the sources support every assessment, or that the speaker has rehearsed the answers. For high-stakes talks, use a real expert rehearsal and retain unresolved concerns in the final speaker notes.

## HTML review experience

Launch the existing browser studio (the project must first be created and its brief approved):

~~~sh
npm run session -- --project my-talk --port 0
~~~

Join using the **owner invitation**, then select **Scientific review** in the header. The panel shows the independent verdict, six scientific checks, methodological alternatives, actual versus proposed capabilities, open findings and expert Q&A. The owner can accept, reject, defer or request an alternative to each finding without using a CLI command; clicking a slide opens its existing comment thread. **Only the owner** can acknowledge the four final statements. The server records `review/readiness-approval.json` with the review SHA and the exact deck revision; a changed review or deck makes sign-off stale. Reviewers and editors can read but not approve. The actual download endpoint and final `bundle` both enforce the same readiness status.

The browser currently **displays** the scientific reviewer report and collects decisions; it does **not yet execute** the independent AI reviewer or create projects without the existing setup process. A future project-launch/onboarding screen is still needed for a genuinely no-terminal first-run experience. A user can manually copy a file from the local working directory, which software cannot prevent.

Legacy/demo projects without the approved-brief workflow are not automatically migrated. Newly created real projects have the workflow enabled. Existing real projects should be migrated to the approved-brief workflow so the gate cannot be skipped by labeling them as demos.
