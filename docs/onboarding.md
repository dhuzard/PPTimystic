# Creator discovery and approval (mandatory for real presentations)

PPTimistic must understand **who is presenting, why, to whom, and under which constraints** before it generates a real deck. A good-looking slide is not evidence that the presentation serves its purpose. The creator, not an AI agent, owns the brief.

## The two modes

- **Real presentation:** `npm run new -- --project NAME`, or interactive `npm run setup`. These projects have `brief_required: true` in `project.yaml`. Until onboarding is complete and approved, `build`, `validate`, browser export and delivery bundling cannot succeed.
- **Fictional demonstration:** `npm run demo -- --project demo`, or unattended `npm run setup -- --yes` with no source documents. These create only the openly labeled demo, with `brief_required: false`. The demo exception is **not** a production workflow. Existing projects without the new flag remain legacy-compatible; set `brief_required: true` in their `project.yaml` to adopt the gate.

Using `--yes` with `new` **does not constitute creator consent**. It scaffolds a draft and stops before building. Supplying source documents to `setup --yes` also requires subsequent approval.

## Recommended first run

Install Node.js >=22.13, clone the repository, run `npm install`, then:

```sh
npm run new -- --project seminar --inputs "path/to/source-documents" --source en-US --locales en-US --no-render
# The interactive CLI asks about your presentation and requests your explicit approval.
npm run brief -- --project seminar --check
npm run build -- --project seminar
npm run validate -- --project seminar
npm run session -- --project seminar --port 0
```

The CLI creates editable slides from authored `content/slides.yaml`. Source documents are ingested locally; they are not automatically synthesized. If no evidence-based slide content has been authored, the starter is fictional and must be treated as a placeholder.

### Headless creation or use from a coding agent

```sh
npm run new -- --project seminar --yes --inputs "path/to/source-documents" --no-render
# A project is created, but build and export remain blocked.
npm run brief -- --project seminar
# In an interactive terminal: the creator answers, reviews and approves.
npm run brief -- --project seminar --check
npm run build -- --project seminar
```

An agent can help prepare questions, suggest a structure, or populate a **draft** `presentation-brief.yaml` from creator-supplied facts. The agent must not invent creator preferences, infer approval, or run the interactive approval on the creator's behalf.

## What the interview covers

The guided interview has five sections, with follow-up questions for relevant details:

1. **Creator profile:** presenter role, experience with the subject, preferred working style and level of detail.
2. **Purpose and audience:** desired outcome/action, one essential take-home message, audience identity, prior knowledge, likely concerns and accessibility needs.
3. **Delivery context:** format (class, conference, webinar, pitch, etc.), venue/setting and duration.
4. **Content and evidence:** scope, proposed narrative or mandatory sections, supplied documents, evidence gaps, caveats and exclusions.
5. **Editorial wishes and constraints:** tone, visual references, degree of visual/text emphasis, languages, branding, accessibility, delivery deadline and additional preferences.

Answers must be substantive. If something is truly unavailable or irrelevant, explain *why* in a sentence (for example, “No empirical data: this is a conceptual introduction”). Bare placeholders such as “Unknown”, “TBD” or “N/A” do not count as validated answers. The tool does not evaluate scientific truth or the quality of the brief's strategic choices: the creator must review them.

## Files, status and validation

- `projects/NAME/presentation-brief.yaml` — **authoritative structured brief** with the interview answers and an optional `approval` record. The CLI can recreate the draft from the saved answers.
- `projects/NAME/presentation-brief.md` — supplementary free-form working notes; it does not satisfy the gate.
- `projects/NAME/project.yaml` — contains `brief_required: true`, languages and theme.
- `projects/NAME/content/slides.yaml` — source of the actual slide content, not the brief.

`npm run brief -- --project NAME --check` reports incomplete answers, language mismatch, missing approval or approval invalidated by later edits; it exits nonzero if the gate is closed. `npm run validate -- --project NAME --source-only` also reports `creator-brief` errors. A real `build` is **rejected** if approval is missing.

The approval stores a SHA-256 fingerprint of the validated brief's substantive fields and the approving person's name/time. Changing an approved answer or a project language invalidates approval. Re-review and approve using:

```sh
npm run brief -- --project seminar --approve
```

This command **requires an interactive terminal** and an explicit affirmative decision. To redo the interview, omit `--approve`. The approval mechanism documents creator intent; it is a workflow safeguard, **not cryptographic identity verification or an authorization boundary** for someone who directly edits local YAML.

Do not add patient information, unpublished confidential content, personal secrets or unnecessary identifying information to the brief. It is stored locally and is not included in standard delivery bundles.

## After approval

1. Agree on the narrative and slide plan before drafting detailed slides.
2. Ask the agent to author slide text only from the supplied sources and recorded brief. Preserve evidence limits and presenter voice.
3. Build and validate. Inspect the real presentation (not just the browser approximation); check scientific support, accessibility and legibility.
4. Discuss feedback and apply changes while preserving protected assets and reviewed content.
5. Bundle the current editable PPTX and relevant provenance for delivery.

For command-by-command workflows see [workflows](workflows.md), [shared sessions](session.md), and [limitations](limitations.md).
