# Demo: FAIR data in preclinical research (5-minute workshop)

Materials for the walkthrough in [issue #5](https://github.com/dhuzard/PPTimystic/issues/5) and [video/](../../video/). This folder holds **inputs to** a real PPTimistic project; it is not the project itself. The project, `projects/fair-preclinical`, is created by the creator on camera ([runbook](../../video/recording-runbook.md)), which keeps the mandatory onboarding genuine.

| File | Status |
|---|---|
| [brief-answers.md](brief-answers.md) | Proposed interview answers, taken from the creator's issue text. **Not approved**; only the creator can approve, interactively. |
| [proposed-slide-plan.md](proposed-slide-plan.md) | Nine-slide plan (title, 7 × ~37 s content slides, references), with evidence classes, sources and open questions. For agreement after brief approval. |
| [sources.md](sources.md) | References verified against PubMed, the standards' roles, and the asset provenance table |
| [illustration-style.md](illustration-style.md) | Style specification v1 and master prompt (ink + muted-pink watercolor) |
| [illustrations/style-study-v1.svg](illustrations/style-study-v1.svg) | Original style study for visual approval. No text; inspected as a rendered PNG |
| [captures/gofair-fair-principles-2026-11-16.png](captures/gofair-fair-principles-2026-11-16.png) | Genuine dated capture of the GO FAIR Foundation FAIR-principles page (CC BY 4.0 per site footer) |

The deck uses the `ink-watercolor` theme preset in [config/themes/ink-watercolor.yaml](../../config/themes/ink-watercolor.yaml).

## Order of work

1. Creator: `npm run new` (draft), then `npm run brief` (interview and personal approval), then `brief --check`.
2. Creator and agent: agree the slide plan and resolve its open questions.
3. Agent: author `content/slides.yaml` and per-slide illustrations. The creator accepts each image before it is attached.
4. Tool: `build`, `validate`, `claims --write-markdown`, `render`. People: review the previews and the claims against their sources.
