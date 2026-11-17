# Proposed slide plan — FAIR data in preclinical research (draft for creator review)

**Status: proposal only.** Under the project's editorial contract, `content/slides.yaml` is written only after the creator has approved the brief (`npm run brief -- --project fair-preclinical --check` passes) **and** agreed this plan. Titles below are working statements, not final copy. Evidence classes follow the repo's vocabulary: established, interpretation, hypothesis, conceptual or missing. Source keys refer to [sources.md](sources.md).

**Timing target:** 5 minutes spoken = title 15 s + 7 content slides × ~37 s (≈ 4 min 20 s) + references 20 s ≈ **4 min 55 s**. If a rehearsal runs long, merge S04 and S05 into "Findable, accessible and interoperable are separate qualities".

| ID | Layout | Working title (assertion) | Supporting sentence(s), 1–2 | Evidence | Sources | Illustration idea (ink + wash, no text) |
|---|---|---|---|---|---|---|
| S01 | title | FAIR data in preclinical research | Metadata and shared standards help others find, understand and reuse our data. | conceptual | — | — |
| S02 | text-image | FAIR names four qualities of data and metadata, not a file format or a single tool | The principles are guidance for humans **and machines** to find and use data. They do not require data to be open: access may need authentication and authorisation. | established | FAIR2016 (abstract; principle A1.2) | Four simple objects in a row: magnifier, key, two interlocking puzzle pieces, recycling arrows |
| S03 | text-image | A preclinical measurement is hard to interpret without its experimental context | Animal model, housing, intervention, acquisition and analysis all shape what a value means. Data lacking appropriate metadata cannot be fully interrogated or integrated. | interpretation, supported | ARRIVE2020 (reporting items), MNMS2024 (abstract) | A single data point on paper surrounded by faint context: cage, clock, syringe, sensor |
| S04 | text-image | Being findable and being accessible are separate requirements | Findable: a persistent identifier and rich metadata in a searchable resource. Accessible: retrievable by that identifier through a standard protocol, with metadata kept even if the data are gone. | established | FAIR2016 (F1, F4, A1, A2) | A catalogue card drawer (find) next to a door with a lock (access) |
| S05 | text-image | Interoperability depends on shared meaning, not only shared file formats | Metadata should use a formal, shared language and vocabularies that are themselves FAIR, with qualified references to other data. | established | FAIR2016 (I1–I3) | Two hands exchanging a tag; matching symbols on both ends of a thread |
| S06 | text-image | Reuse requires rich context: description, provenance and a clear licence | Rich, accurate description, detailed provenance and a clear usage licence let someone else judge whether the data fit their question. | established | FAIR2016 (R1, R1.1–R1.3) | The style-study sheet with its tag, plus a small ribbon/seal for the licence |
| S07 | text-image | Standards play different roles: a framework, an ontology, a reporting guideline, a registry | ISA structures investigation–study–assay metadata; OBI defines terms; ARRIVE 2.0 lists what to report; MNMS proposes a minimal metadata set for in vivo data; FAIRsharing helps find standards. | established (roles as self-described) | ISA2012, OBI2016, ARRIVE2020, MNMS2024, FAIRsharing2019 | Four distinct tools on a bench: scaffold, dictionary, checklist, signpost |
| S08 | text-image | Start now: record context during the experiment, using an existing community standard | Choose a suitable standard before collecting data, capture provenance as you go, and validate your metadata before sharing. | interpretation (recommendation) | FAIR2016 (R1.3), MNMS2024 | A notebook open beside an experiment in progress, pen mid-stroke |
| S09 | statement | Acknowledgements & References | Acknowledgements are supplied by the creator. References listed in compact form (author, year, journal, DOI). | — | all | — (text only, for legibility) |

## Open questions for the creator (to resolve before authoring)

1. **Acknowledgements:** who to thank (colleagues, funders, the GO FAIR Foundation for CC BY content). The agent must not invent these.
2. **HCMO / home-cage-monitoring ontology:** include it only with an authoritative reference you supply. A BioPortal entry exists ("Home Cage Monitoring", namespace `w3id.org/hcm-ontology`), but its scope and maturity have not been reviewed here.
3. **MNMS wording:** the paper *proposes* MNMS and calls for adoption (Moresis et al. 2024). The slide must not present it as an adopted or mandatory standard.
4. **GO FAIR screenshot:** use it in the video only (recommended), or also as the S02 image with attribution? Using it in the deck would replace the hand-drawn illustration on that slide.
5. **Animations:** a fade-in of the sentence, then the illustration, on content slides. This depends on the animation support currently uncommitted in this working tree; see [video/README.md](../../video/README.md).
6. **S09 layout:** the existing `statement` layout holds about six reference lines at 24 pt. If more references are kept, they move to the notes and a QR link, or a dedicated references layout is needed.

## What the tool does vs. what people do

| Step | Who |
|---|---|
| Interview, brief storage, approval fingerprint, gate on build/validate | PPTimistic (deterministic) |
| Answering the interview; approving the brief and this plan | Creator |
| Drafting this plan and the slide YAML from the brief and sources | Coding agent, reviewed by the creator |
| Source retention with SHA-256 hashes; claim-to-source links; claim report | PPTimistic (deterministic); links do **not** prove support |
| Judging whether a source supports a sentence | Creator / scientific reviewer |
| Illustrations | Agent-authored original SVGs following `illustration-style.md`, accepted by the creator |
| Native PPTX build, geometry/legibility validation, PowerPoint preview rendering | PPTimistic (deterministic) |
