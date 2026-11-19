# Audience panel (review lenses)

The panel is a set of **lenses** the scientific reviewer can apply: imagined attendees, each with a point of view. Each lens produces perspective-tagged findings (`perspective: <lens>`) and, above all, **anticipated questions** that help the creator prepare for Q&A. The panel uses the same submission and the same integrity rules as the reviewer. It never edits slides.

Choose the lenses that fit the audience in the approved brief. A grant committee, a lab meeting and a public lecture call for different panels. Four to six lenses is usually enough. When the host can run independent sub-agents, give each lens its own context so the lenses do not anchor on one another, then merge their output into one submission, removing duplicates.

| Lens (`perspective`) | Who | Looks for | Typical question |
| --- | --- | --- | --- |
| `data-expert` | Statistician, data hawk | Real data, *n*, the test used, effect sizes and intervals, multiple comparisons, denominators, what the error bars are | "What is *n* per group, and is that the SD or the SEM?" |
| `design-critic` | Picky designer | Alignment, spacing, hierarchy, consistency between slides, font sizes, colour use, clutter | (Mostly findings, not questions.) |
| `presentation-style` | Presentation coach | Prose vs bullets vs numbered lists vs diagram; where an illustration would explain; build sequences that reveal the argument | "Could this list be a two-step diagram?" |
| `science-friend` | Supportive colleague | What works and should be kept; the strongest version of the talk. Honest: names at least one real weakness | "Your second result is the strongest; why not lead with it?" |
| `reviewer-3` | Critical, rarely satisfied | Alternative explanations, confounders, overreach, missing controls, cherry-picking, generalisability | "Couldn't the effect be explained by body weight alone?" |
| `newcomer` | Adjacent-field scientist or student | Jargon, undefined acronyms, missing context, the slide where they got lost | "What does FAIR stand for, and why does it matter here?" |
| `decision-maker` | Funder, chair, manager | The "so what?", the request, costs and risks; can they state the take-home message after the last slide? | "What do you need from us, and by when?" |
| `field-rival` | Competing specialist | Novelty claims, missing or selective citations, comparison with prior work | "How does this differ from the 2022 benchmark by X et al.?" |
| `methods-specialist` | Technical peer in the stated research field | Where the mechanism operates, actual algorithm/architecture, relevant alternative methods, reproducible evidence and failure boundaries | "What did you implement, and what does it do that a simpler established method cannot?" |
| `rigor-ethics` | Methods and ethics officer | Randomisation, blinding, preregistration, reporting guidelines (e.g. ARRIVE, CONSORT, STROBE) where they apply, 3Rs, consent, conflicts of interest, data availability | "Were the outcome assessors blinded?" |
| `back-row` | Attendee far from the screen | Readability at distance, contrast, colour-blind safety, dense slides, non-native-speaker clarity | (Mostly accessibility findings.) |

## Anticipated questions

```yaml
anticipated_questions:
  - perspective: data-expert
    slide_ids: [S005]
    question: What is the sample size per group, and how were outliers handled?
    why_likely: The chart shows group means without n or error bars.
    difficulty: moderate          # easy, moderate, hard
    answer_basis: creator-must-supply   # supported-by-sources, creator-must-supply, not-answerable-with-current-evidence
    answer_notes: The source reports n = 12 per group; outlier handling is not described.
    source_refs: [SRC1]
    backup_slide_suggested: true
```

- **Never invent the answer.** `answer_notes` may only point to what the sources contain, or say what the creator must supply. `supported-by-sources` requires the `source_refs` that contain the answer.
- A question the current evidence cannot answer (`not-answerable-with-current-evidence`) is valuable: it tells the creator to prepare an honest "we don't know yet".
- Suggest a backup slide when a likely, hard question needs a figure or table to answer well.
- Questions are deduplicated by wording across rounds. Reuse a listed `Q-…` ID to update one.

## Tone of each lens

Lenses differ in **what they notice**, not in honesty. `reviewer-3` is demanding but still specific and evidence-based: no manufactured objections. `science-friend` is positive but still truthful: no flattery. Every lens follows the integrity rules in [scientific-reviewer.md](scientific-reviewer.md).
