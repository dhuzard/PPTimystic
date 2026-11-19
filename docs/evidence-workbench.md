# Goal-oriented evidence workbench — issue #17, first increment

PPTimystic has two scientific input workflows.

**Review an existing PowerPoint:** Import the original PPTX non-destructively. Extract an explicitly incomplete text mirror to enable slide-level scientific review; render the ORIGINAL slides for actual visual inspection when local tools are available. Never rebuild the imported presentation from the mirror.

**Create a presentation from research sources:** The owner first states and approves the purpose, central message, audience, knowledge level, and uncertainty. They upload local PDFs and other documents. The system inventories and extracts them, then a configured agent reviews every extractable chunk against the approved goal, another invocation synthesizes across documents, and a fresh skeptical critic identifies opposing interpretations, gaps and questions.

## What the current Studio does

The HTML Studio header has Goal & audience, Sources & evidence, and Scientific review.

Goal & audience provides a human-edited brief, draft save and explicit owner approval. It does not invent answers. The Sources & evidence panel accepts PDF, DOCX, PPTX, Markdown, TXT and CSV research files. Uploaded originals remain in the project with SHA-256 provenance. Text extraction failures and scanned sources remain explicit unresolved inputs.

After the brief has been approved, Refresh source inventory writes the local knowledge plan. It indexes **every** source, recording extraction status, stable text offsets, source/text hashes and every chunk still pending. Indexing is deterministic and does not claim to understand the paper.

Run complete source analysis invokes a trusted configured agent subprocess in three sequential stages: (1) source analyst on each extracted chunk; (2) cross-source synthesizer; (3) fresh skeptical critic. Roles run in separate contexts, although they may use the same model. No configured provider means no agentic analysis, never a simulated success. External transmission and paid use require user confirmations.

## Local knowledge artifacts

Under each project directory:

- knowledge/plan.json: goal fingerprint, full source manifest and chunk coverage.
- knowledge/README.md: extraction and review coverage for all source files.
- knowledge/sources/SRC-….md: proposed findings, exact cited quotations, supporting/contradicting/qualifying directions, suggested use and caveats.
- knowledge/analyses/SRC-…-C….json: validated per-chunk agent responses.
- knowledge/SYNTHESIS.md: cross-paper arguments, disagreements, gaps and skeptical questions.
- knowledge/SLIDE-CANDIDATES.md: evidence-linked candidate arguments for human selection.

An agent statement must cite a quote that exists verbatim in the cited extracted source chunk. This proves text membership, **not** correct inference. The review revision includes current knowledge artifacts, making prior readiness approval stale when evidence changes. Unreadable PDFs are never silently counted as analyzed.

Figures, charts, scanned-page graphics, raw measurements and reuse rights are NOT validated by text extraction. Any proposed visual remains a candidate requiring original-page inspection. Scientific provenance must follow final slide claims. Source text and PDF content are data, never instructions.

## Developer fallback

For an existing approved project, use the knowledge command in modes prepare, status or run. Run requires an explicit, operator-trusted agent configuration. The original PowerPoint review import command is review-pptx with a file, new project name and title; it attempts original-slide rendering where local tools are installed, without changing the supplied PowerPoint. The scientific review and readiness commands remain the final independent critique path.

## Limits and remaining issue #17 milestones

The GUI currently supports brief editing, research-source import, evidence-agent execution, and viewing Markdown notes **inside an existing project session**. It does not yet offer a fully packaged, one-click first-run launcher and project library. A local provider adapter must be configured by a trusted operator at session start. Automatic execution of the independent scientific reviewer and its re-review/revision loop from the browser are not implemented in this increment.

A complete non-coder workflow must still provide project creation and PPTX review-only import in a home screen, in-UI provider setup and diagnostics, automatic independent review after each scientific revision, and end-to-end browser tests. Do not declare the complete multi-agent product production-ready until those milestones pass.

The same scientific caution applies to imported PPTX files. The text mirror can omit grouped content, notes, charts and animations. Full readiness for this mode requires a renderer to produce original-slide images and a reviewer who genuinely inspected them. A missing or stale original render cannot receive a positive readiness verdict.
