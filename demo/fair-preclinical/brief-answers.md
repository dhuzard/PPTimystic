# Creator interview — proposed answers (draft, not approved)

These answers restate, in the order PPTimistic asks its questions, the facts the creator wrote in [issue #5](https://github.com/dhuzard/PPTimystic/issues/5). They are **not** an approved brief. They are a crib sheet for the recorded interview (`npm run brief -- --project fair-preclinical`): edit them into your own words, then type or paste them on camera. Only the creator can answer "yes" to *Do you personally approve this brief?*. No agent and no `--yes` flag can do this.

Keep every answer non-sensitive: it will appear in a public video. Each answer must be at least 6 characters; placeholders such as "TBD", "N/A" or "Unknown" are rejected by design.

## 1/5 — Who is creating the presentation?

| Prompt | Proposed answer |
|---|---|
| Your role, background and relationship to the topic | Preclinical researcher who teaches good research practices, including data management and metadata, to colleagues and students. |
| Your expertise and knowledge of the subject | Working knowledge of FAIR data and preclinical metadata in practice; I use community standards and ontologies but I am not presenting new research results. |
| How you want to work: style, level of detail and preferences | Agree the message and slide plan first, then design. Keep slides minimal and put supporting detail and references in the speaker notes. |

## 2/5 — Why and for whom?

| Prompt | Proposed answer |
|---|---|
| What should this presentation achieve? | Give an introductory 5-minute workshop talk on FAIR data in preclinical research, explaining what the FAIR principles ask for and why metadata matters. |
| What should the audience understand, decide or do afterward? | Recognize how metadata and shared standards improve discovery, interpretation and reuse of preclinical data, and know where to start in their own work. |
| One essential message the audience should remember | Good metadata and shared standards are what make preclinical data findable, understandable and reusable by others. |
| Who is the target audience (roles, size, context)? | Preclinical researchers (students, postdocs, staff scientists and technicians) attending a short workshop session. |
| What does the audience already know? | Varied: some have never heard of FAIR or metadata standards, others already deposit data in repositories. Assume no prior FAIR knowledge. |
| Audience interests, sensitivities, questions or accessibility needs | They want practical relevance, not jargon; some worry FAIR means making all data open or adds heavy paperwork. Slides must be readable from the back of a room. |

## 3/5 — Presentation conditions

| Prompt | Proposed answer |
|---|---|
| Duration in minutes (1–480) | `5` |
| Setting, medium and delivery mode | Live, spoken workshop talk with projected 16:9 slides; about 40 seconds per content slide, 6–7 content slides plus a short acknowledgements and references slide. |

## 4/5 — Content and evidence

| Prompt | Proposed answer |
|---|---|
| Topics and structure to include; what must be prioritized? | What FAIR means and does not guarantee; why preclinical context matters; findable versus accessible; interoperability through shared vocabularies; reusability through provenance and licences; roles of standards such as ISA, OBI, ARRIVE 2.0 and MNMS; a concrete takeaway; acknowledgements and references last. |
| Available references, figures and evidence (or explain what is missing) | Wilkinson et al. 2016 (original FAIR Guiding Principles); the GO FAIR Foundation website; publications of the standards themselves (ISA, OBI, ARRIVE 2.0, MNMS, FAIRsharing). No empirical data are presented: this is a conceptual introduction. Every graphic needs a citation and licence check. |
| Claims to qualify, uncertainties and things to exclude | Do not claim FAIR guarantees reuse or requires open data. Do not imply any one standard is mandatory or universal, and do not confuse a model, ontology, reporting guideline and registry. Home-cage-monitoring resources (HCMO) only if I supply an authoritative reference. |

## 5/5 — Tone, visuals and constraints

| Prompt | Proposed answer |
|---|---|
| Preferred tone and amount of text/detail | Calm, scientifically cautious and practical. One message per slide: an assertion-style title plus one or two short sentences. |
| Visual style, examples and design references | Hand-drawn dark ink illustrations on muted-pink watercolor washes, generous whitespace and minimalist typography; one illustration per content slide; subtle fade-in animations. |
| Accessibility, deadlines, branding and other constraints | High-contrast, large sans-serif text; alt text for every illustration; references on the final slide; no logos implying endorsement; every reused image credited with its licence. |
| Any additional wishes (optional) | The deck should work on its own as a 5-minute talk, separately from the YouTube walkthrough that shows how it was made. |

## Project settings used at creation

| Setting | Value |
|---|---|
| Project name | `fair-preclinical` |
| Title | `FAIR data in preclinical research` |
| Source / output language | `en-US` / `en-US` |
| Visual preset | `ink-watercolor` (added for this demo; see `config/themes/ink-watercolor.yaml`) |
