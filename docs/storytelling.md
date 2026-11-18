# Storytelling and flow

A deck is more than a set of good slides. Each slide's title should advance one argument, and the audience should know why each slide follows the previous one. `npm run story` reads the deck in order and helps a person check that it does. It does not write, reorder or reword slides.

```sh
npm run story -- --project talk --init             # draft content/storyline.yaml (never overwrites)
npm run story -- --project talk                    # JSON report with flow prompts
npm run story -- --project talk --write-markdown   # output/storyline.md titles-only read-through
npm run story -- --project talk --locale fr-FR     # read the titles of another output language
```

## The titles-only read-through

`--write-markdown` writes `output/storyline.md`. It lists every slide title in order, grouped by section, with its story role, evidence classification and planned transition. Read the titles aloud in order. Together they should state the argument without the slide bodies; if a title only names a topic ("Results"), the story is carried by the speaker rather than the deck. The file contains slide text, so keep it as private as the deck.

## `content/storyline.yaml`

The storyline is optional editorial planning metadata. `content/slides.yaml` stays authoritative for slide order and content. The storyline annotates slides by their stable IDs:

Each entry may also carry an `explanatory_contract`, owned by the story maker: audience question, central message, explicit concepts introduced and required, a worked example, visible text that revisions must preserve, and success checks. Prerequisite-order prompts use actual deck order. Contracts appear in the titles-only report and scientific-review context; review apply enforces preserved text in the native scene. See [the contract schema and example](scientific-review.md#explanatory-contracts).

```yaml
version: 1
framework: research          # research, abt or free
throughline: Sleep loss is associated with weaker memory consolidation in mice.
slides:
  S001: { role: opening, section: Why }
  S002: { role: context, section: Why }
  S003:
    role: question
    section: Why
    transition: To test this, we deprived mice of sleep before training.
  S004: { role: approach, section: How }
  S005: { role: evidence, section: What we found }
  S006: { role: conclusion, section: What we found }
  S007: { role: backup }
```

These sentences are an illustration of the format, not a scientific result.

- **throughline** — one sentence the whole presentation argues, in the source language. If absent, the approved brief's central message is used for comparison.
- **role** — `opening`, `roadmap`, `context`, `question`, `approach`, `evidence`, `interpretation`, `implication`, `conclusion` or `backup`.
- **section** — optional name for a part of the talk. A section should be contiguous.
- **transition** — the planned spoken bridge from this slide into the next one. It is a presenter's note, not slide text, and is not translated or rendered.

`--init` drafts the file with roles inferred only where the layout makes them likely: a first `title` slide is an opening, `conclusion` is a conclusion, `chart` is evidence and `workflow` is approach. Other slides get no role. Inferred roles are guesses; review and correct every role with the creator. Without a storyline file, the report uses the same conservative inferences and marks them as inferred.

Because the storyline is not rendered, editing it does not change build fingerprints, make outputs stale or require `--authorize` for approved slides. Moving, adding or rewriting slides to improve flow is a normal content change: approved and locked slides still need explicit authorization.

## Frameworks

- **research** expects a question, an approach, evidence and a conclusion, the usual arc of a research talk.
- **abt** expects context ("And"), a tension or problem ("But") and a resolution ("Therefore"), following Olson's And–But–Therefore structure. It suits short talks and nonexpert audiences.
- **free** expects no particular beats; the ordering, continuity and certainty checks still run.

## Flow prompts

Every story check is a **warning** for human review, except an unknown slide ID in the storyline, which is an error.

| Code | Prompt |
| --- | --- |
| `story-role-missing` | Slides without a role cannot be checked for flow. |
| `story-beat-missing` | A beat the chosen framework expects is absent. |
| `story-opening` | The deck opens with something other than an opening, context or question. |
| `story-order` | Evidence before any context or question; content after the conclusion; main slides after backup. |
| `story-section-split` | A section resumes after another section. |
| `story-bridge` | No transition is recorded at a section boundary. |
| `story-topic-shift` | Consecutive slides share no key terms and have no recorded transition. |
| `story-repetition` | Consecutive titles are very similar. |
| `story-certainty` | A conclusion or implication is classified `established` but no earlier slide presents established evidence. |
| `story-evidence` | An evidence beat is classified `conceptual` or `missing`. |
| `story-title` | An evidence, interpretation or conclusion title of three words or fewer, which reads as a topic label. |
| `story-throughline` | No throughline is recorded, or no conclusion shares key terms with it. |
| `story-pace` | Fewer than 30 seconds per main slide for the brief's duration. |

Continuity and throughline checks compare words. They work best in English and French, and are only a proxy: shared words do not prove a logical link, and a well-bridged change of topic can share none. Stylistic prompts (`story-title`, `story-evidence`) apply only to roles recorded by a person, not inferred ones.

## Story maker review loop

The story maker is an agent workflow (`.claude/skills/story/SKILL.md`, `/story` in Claude Code). It runs without asking questions first, always proposes concrete changes, and lets the creator decide in a browser review page with the local `human-review` tool, when it is installed.

1. The agent reads the brief, slides, storyline and the `npm run story` analysis. That analysis includes deterministic `candidates`: concrete moves and roles, plus places that need wording.
2. It writes `story/suggestions.yaml`: a short diagnosis (`notes`) and at least three suggestions. Each suggestion is one change with a rationale, of kind `role`, `section`, `transition`, `throughline`, `framework`, `title`, `message`, `move` or `other`.
3. `npm run story -- --project NAME --review` renders `story/review.md`: the story maker's read, the throughline, a titles-only read-through, the open and decided suggestions, and the flow prompts. It also returns the review thread to post for each open suggestion. A wording change is suggested inline on the current text; other kinds anchor on the suggestion's `SG-001 · proposed` token.
4. The creator accepts or rejects suggestions in the margin, replies to discuss them, selects text to comment, or edits titles directly. The agent answers on the page, revises suggestions, and applies what was accepted.
5. `npm run story -- --project NAME --apply SG-001,SG-004` applies suggestions whose status is `accepted`:
   - storyline kinds update `content/storyline.yaml`;
   - `move` reorders `content/slides.yaml` without renumbering IDs;
   - `title` and `message` go through the revision path, in the source language.

   Each apply keeps a backup and a record under `feedback/`. Wording changes need an approved brief, and approved or locked slides need `--authorize ID`. `other` suggestions (adding, merging or splitting slides) need authored content and are made by hand.

Suggestions are proposals: nothing in the deck changes until a person accepts them. The suggestions file and review page contain slide text, so keep them private.

## Working with an agent

1. After the brief is approved, agree on the throughline and the sequence of roles and sections with the creator **before** drafting slide bodies. Record them in `content/storyline.yaml`.
2. Draft statement titles that carry the argument, matching the strength of the evidence (see the editorial contract in `AGENTS.md`).
3. Run `npm run story -- --project NAME --write-markdown`, read the titles in order, and resolve or consciously accept each prompt. Do not add words only to silence a lexical check.
4. Record transitions where the link between slides is not obvious. Put the spoken wording in the slide notes when the presenter wants it there.
5. Repeat after substantial revisions and before delivery.

The tool cannot judge whether the story is persuasive, whether it suits the audience, or whether the evidence supports each step. Those remain human editorial and scientific decisions.

## Background

Narrative structure can help nonexpert audiences understand and engage with science, but it also raises questions of accuracy and persuasion ([Dahlstrom, 2014](https://doi.org/10.1073/pnas.1320645111)). Olson (2015, *Houston, We Have a Narrative*, University of Chicago Press) proposes the And–But–Therefore structure. The titles-only read-through follows the assertion–evidence practice of statement titles ([Garner and Alley, 2013](https://www.ijee.ie/articles/Vol29-6/23_ijee2791ns.pdf)). These sources inform the prompts; they do not establish that PPTimistic's checks improve a presentation.
