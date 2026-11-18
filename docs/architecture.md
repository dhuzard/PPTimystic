# Architecture and content model

The engine is local and agent-independent. YAML is the editable source; PptxGenJS assembles an actual Open XML PPTX. TypeScript runs through tsx, with separate strict type checking. An optional TypeScript session server provides a shared browser editor and background agent queue without requiring a database or external service. See [shared sessions](session.md) for invitations and agent configuration.

```text
config/              reusable themes and documented defaults
src/cli/             guided setup and portable commands
src/core/            schemas, projects, diagnostics, build snapshots
src/content/         source extraction, provenance, literal Markdown plans
src/layouts/         nine native PowerPoint layouts, geometry records
src/images/          provider contract, local assets, prompts and metadata
src/localization/    manual translation requests and consistency checks
src/story/           storyline roles, read-through, flow prompts, suggestions and review page
src/review/          scientific-review contract, ledger, revision planner, guarded builder, manifests
src/feedback/        feedback log and structured source revisions
src/session/         HTTP/SSE server, shared editor, Yjs text, journal, agent queue
src/rendering/       LibreOffice/Poppler or Windows PowerPoint rendering
src/validation/      content, contrast, source hashes and PPTX checks
projects/<name>/     isolated presentation source and output
templates/project/   minimal source examples
examples/            Markdown plan and revision examples
tests/               local unit and actual PPTX integration tests
agents/              provider-neutral agent role definitions (reviewer, audience panel, builder)
```

## Project configuration

```yaml
version: 1
title: My study
source_locale: fr-FR
output_locales: [fr-FR, en-US]
theme: editorial-minimal
content: content/slides.yaml
font: Inter  # optional; install locally, do not commit a proprietary font
glossary: [DVC]  # exact protected spellings, identical across languages
```

The default theme uses white `FFFFFF`, near-black `161616`, gray `52525B` and teal `225E63`. Theme files centralize headings, body size, margins, palette and font. All decks are 16:9. Arial is the reliable default; configure Inter when installed. `config/defaults.yaml` supplies the CLI's starter source language, output languages and theme. Each project retains its own saved settings afterward.

## Slides

```yaml
version: 1
slides:
  - id: S001
    layout: workflow
    status: draft
    locked: false
    evidence: conceptual
    source_refs: []
    citations: []
    content:
      fr-FR:
        title: Une progression explicite
        message: Rendre chaque étape vérifiable.
        body: Exemple de schéma conceptuel.
        notes: Aucune donnée expérimentale n'est représentée.
        labels: [Sources, Relecture, Partage]
        caption: ''
        alt: ''
        seriesNames: []
        review: draft
      en-US:
        title: Make the process explicit
        message: Make every step reviewable.
        body: Conceptual workflow example.
        notes: No experimental data are represented.
        labels: [Sources, Review, Share]
        review: draft
```

The array order controls slide order. IDs never depend on current position after authoring. Do not renumber existing IDs when inserting or moving a slide. `status` and localized `review` support `draft`, `review`, `approved`, `locked`; the optional global `locked` flag also protects the slide. `evidence` is `established`, `interpretation`, `hypothesis`, `conceptual` or `missing`. Citations are user-supplied literal strings, not automatically verified bibliography entries.

### Editable objects and shared sessions

`buildSlideScene` composes the native layout into stable objects such as `S001:title` and `S001:illustration`. The browser and PowerPoint renderer consume that scene. Text objects retain bindings to localized source fields; edits never depend on scraping or saving browser HTML. Source elements retain their layout role IDs. Additional objects use a persisted `object-<UUID>` ID.

Geometry uses slide inches. `visual_objects` stores position, size and appearance overrides keyed by role, for example:

```yaml
visual_objects:
  title:
    x: 0.7
    y: 0.6
    w: 11.8
    h: 1.2
    style: { color: '225E63', fontSize: 32, bold: true }
```

Added text, rectangular shapes and images live in `slide.objects` with `id`, `type`, `x`, `y`, `w`, `h`, optional `style`, and an `asset` path for images. Text and image alt descriptions live in `content[locale].objects[id].text` and `.alt`; missing translations are explicit. Accepted custom images carry `accepted: true`, and their bytes participate in build fingerprints and protection baselines.

Each session holds a project lease and serializes source mutations and exports. Browser text updates use a separate Yjs document and generation per localized object. Object edits carry a base revision; agent proposals also check changes to their slide context. Before committing, the server validates the candidate, checks protection and source hashes, saves a source backup, and records a recoverable pending transaction. `.session/state.json` retains feedback, jobs and history while YAML remains authoritative. External source or image changes invalidate collaborative text generations and pending authorization. CLI writers refuse to race an active session.

Imported translations carry a `source_fingerprint` that records the source wording and shared chart/citation context reviewed for that locale. When those inputs change, validation marks the translation stale and blocks export until review. A layout-only change does not invalidate wording review. Older translations without this field are reported as untracked, rather than as verified current. The fingerprint records review context, not semantic equivalence.

An optional claim link connects one visible source-language field to a locally extracted source excerpt. For example, after ingesting a document, replace the illustrative source ID and excerpt below with values from your own `content/sources.yaml` and `content/extracted/` files:

```yaml
source_refs: [SRC-example]
claims:
  - id: CLM-001
    field: title
    source_ref: SRC-example
    locator: Results, paragraph 2
    excerpt: Exact words from the retained source document.
```

The source ID must be indexed and attached to the slide; the excerpt must match local extracted text after whitespace normalization. The original document and extracted text must retain their recorded hashes. Claim IDs must be unique within the presentation. The link records provenance, not scientific validity: a reviewer must still decide whether the excerpt supports the slide wording. `npm run claims -- --project NAME` prints a local report containing the linked slide field's text in every authored language, source and extraction paths and hashes, locator, excerpt hash and length, and validation status. It also reports whether the current original and extracted bytes match ingestion-time hashes. `--write-markdown` writes `output/claims-report.md` with relative links to those local files. Neither report prints the excerpt itself. Treat reports as potentially confidential because they contain slide text and source paths. Presenter notes include claim IDs and locators but not the extracted passage. For sources without usable extracted text, use ordinary citations and manual review until a suitable local extraction is available.

Claims optionally add `claim_type` (definition, measured-result, implemented-capability, proposed-capability, illustrative-example), `qualification_note` and fingerprint-bound `human_verification`. Only a person records verification through interactive `claims --verify SLIDE/CLAIM --by NAME`; agents may read sources without asserting verification. See [scientific review](scientific-review.md#claim-types-and-personal-verification) for stale verification and protection rules.

Layouts: `title`, `statement`, `text-image`, `full-image`, `diagram`, `workflow`, `chart`, `comparison`, `conclusion`. Diagram/workflow labels require 2–5 items. Comparison uses two `labels` as headings and `message`/`body` as the left/right explanations. Full-image uses a separate illustration and an editable title/caption; it is never a rasterized complete slide. Add table support by extending the schema and drawing native `addTable` objects; a dedicated table layout is not included yet.

An illustration uses a project-relative path:

```yaml
visual:
  asset: assets/generated/S001.png
  brief: A conceptual representation of the process, no text.
  accepted: true
```

PNG, JPEG, WebP and SVG assets are accepted. For Office compatibility, only the separate illustration is normalized to PNG at embedding time; the source asset remains intact. All explanatory text belongs in editable slide fields. Provide localized `alt` descriptions. `visual.brief` is language-neutral production metadata, not a translated audience-facing label.

A chart uses native editable PowerPoint charts with an embedded workbook:

```yaml
chart:
  fictional: true
  series:
    - values: [8, 12, 10]
# Under each content locale:
# labels: [A, B, C]
# seriesNames: [Fictional example]
```

These numbers illustrate the fictional schema; they are not a scientific dataset. Nonfictional charts require the CSV binding below and a source reference. Fictional charts require `fictional: true`. The layout always prints an editable fictional-data disclosure independently of the author caption. English and French disclosures are built in. For another output locale, supply `fictionalNotice` in that slide's localized content, for example `fictionalNotice: Dati fittizi — solo dimostrazione` for `it-IT`. The build rejects a missing notice. A scientific reviewer must confirm any manually supplied wording.

For a nonfictional chart backed by an ingested CSV, use an explicit binding instead of inline `series` values:

```yaml
chart:
  fictional: false
  data_ref: SRC-your-ingested-csv-id
  binding:
    source_sha256: <sha256 from content/sources.yaml>
    category_column: Group
    value_columns: [Response]
    rows: [2, 3, 4] # 1-based CSV record numbers; row 1 is the header
source_refs: [SRC-your-ingested-csv-id]
# Source-locale labels must match selected Group cells in row order.
# Source-locale seriesNames must match value_columns in order.
```

Column names and rows are selected explicitly; the original CSV bytes must match the recorded hash. PowerPoint chart data and its embedded editable workbook use the selected values directly, without computed transformations. Replacing or re-ingesting a changed CSV does not silently approve new chart values: review the data selection and update `source_sha256` deliberately. The source-language category and series labels are checked against the CSV, while translated labels remain positionally aligned and need human scientific review.

### Animations

Animations are off unless requested. They are written as native PowerPoint entrance effects, so presenters can still edit them in the Animation Pane. They never change wording, geometry or translations. Enable them for the whole deck in `project.yaml`:

```yaml
animations: {}            # fade in each item on click (the default)
# animations: { effect: wipe, direction: left, trigger: on-click, duration: 0.6 }
```

Or enable, tune or disable them for a single slide in `slides.yaml`. A slide setting overrides the project setting:

```yaml
animations: { enabled: false }   # this slide stays static
```

Settings are `effect` (`fade` (default), `appear`, `wipe`, `fly-in`), `direction` for `wipe`/`fly-in` (`left`, `right`, `top`, `bottom` (default)), `trigger` (`on-click` (default), `with-previous`, `after-previous`), `duration` in seconds (default 0.5) and `delay` in seconds (default 0).

Without `steps`, each layout uses an automatic reveal order. The title, footer, citations and accent decorations stay visible. The message, body, illustration, caption and comparison columns enter one at a time. In `workflow` and `diagram` slides, each node's box, label and incoming arrow become **one PowerPoint group** that fades in as a unit. A fictional chart always enters together with its disclosure. Overlapping added objects enter together, and an added box with text inside it becomes a group.

To describe a specific sequence, list `steps`. Each step names scene roles (as used in `visual_objects`, or `object-<UUID>` IDs) that enter together. Any role not listed stays static:

```yaml
animations:
  effect: fade
  steps:
    - targets: [message]
      effect: fly-in
      direction: left
    - targets: [decoration-1, node-0]   # box + label
      group: true                       # also make them one PowerPoint group
    - targets: [connector-0, decoration-2, node-1]
      group: true
      trigger: after-previous
      delay: 0.3
    - targets: [body]
```

Only the first object of a step uses the step's trigger; the rest start with it. Validation rejects unknown, hidden or repeated targets. It also rejects animating the footer or citations, grouping the title or a chart, and revealing a fictional disclosure after its chart. `geometry.json` records the effective plan for each slide. Animation settings are shared, language-neutral slide content. Changing them on an approved or locked slide, including through a new deck-wide default that reaches that slide, requires `--authorize`.

## Validation and rebuilds

Validation rejects duplicate IDs, missing original/target text, unknown or altered sources, missing referenced assets, inconsistent chart labels, invalid language tags, inadequate theme text contrast, probable text overflow, unexpected object intersections and off-slide geometry. It checks ZIP/XML structure, internal relationships, slide count and native text in produced PPTX files. Font consistency is controlled by a single theme; citation/footer text has an intentional 10 pt exception. These checks do not establish scientific truth or guarantee PowerPoint layout under every font substitution.

Build fingerprints include content, theme and asset bytes. Stored protection baselines catch direct YAML edits to approved/locked content, including protected translations and shared layout changes. Accepted illustration paths, bytes and acceptance status are protected independently of slide approval. `--authorize S001,S002` is an explicit allowance, not a request for permission. No authorization is inferred from a rebuild. A newly authored protected slide or accepted image establishes its baseline on its first successful build.

Unchanged illustration files are reused. PPTX ZIPs are reassembled in full; there is no partial-slide ZIP renderer. Builds report changed stable IDs, preserve prior PPTX files and store source snapshots. Each history manifest links archived and newly generated PPTX hashes to their recorded source documents, assets and image-prompt preparations. A prompt record describes preparation or reuse; it does not prove that the prompt generated an accepted image. `validate` checks that exported files are current with authored source; `--source-only` skips that delivery check. Exact binary output may differ because Office metadata contains timestamps; reproducibility means retained source, settings and assets, not guaranteed byte-identical ZIPs. A generated asset is reused rather than regenerated probabilistically.
