---
name: human-review
description: Review and edit PPTimistic slides in the existing browser studio, with editable text, images, layout and native comments. Use the generic human-review tool for storyline documents and prose feedback.
---

# Human review for PPTimistic

Choose the review surface from what the creator wants to change. For slide text, images or layout, use the existing studio described in `docs/session.md`. For a storyline or prose document, use the generic human-review tool when installed.

Run commands and resolve project paths from the repository root.

## Editable slides

Start or reuse the requested project's local studio:

```sh
npm run session -- --project NAME --port 0
```

Open the native owner invitation directly for the creator, or an editor invitation when that matches their established role. The creator enters a name to join. Invitations grant project access; keep them private and share them only when authorized. Keep the server running while the creator edits. Loopback is the default; network access needs an explicit request.

Explain the available controls briefly:

- Double-click text or select it and use the Text field.
- Select an image to replace it; use **+ Image** to upload an image with its alt description.
- Drag objects or use Position & size to move and resize them.
- Use Comments for feedback on a slide or selected object, and Activity for history and eligible undo.

Edits save through the existing project model. Preserve the studio's protection controls for approved slides, translations and accepted images. Check the current source and session history before making further changes; already saved creator edits are authoritative. Use the session API for agent changes while the project lease is active.

Open the studio directly. The generic human-review overlay can intercept application buttons, forms and image gestures, and its proxy does not forward authenticated app cookies. A screenshot gallery supports visual comments but does not provide native slide-object editing.

Verify that the editing controls are reachable. Use a disposable fictional project for tests that write text or images. Give the creator the live invitation URL and end the turn with the studio running; do not run `human-review poll` for this native mode. Read native comments and session state when resuming work.

## Mandatory final scientific review in the HTML studio

For every real presentation, after the independent scientific reviewer has submitted the current scientific readiness assessment, open the native studio with `npm run session -- --project NAME --port 0` and provide the **owner invitation** to the presenter. The presenter must click **Scientific review** and read the six checks, comparisons, concrete findings, implementation-versus-proposal classification and anticipated expert questions. The panel supports per-finding accept/reject/defer/request-alternative decisions and links to slide comments. An agent must not sign off on the creator's behalf.

The presenter explicitly acknowledges the four scientific-readiness statements and approves the current revision, or records an explanatory risk override *and then* signs the current revision. The readiness gate blocks `bundle` and the studio's final PPTX download until this is complete. A NOT READY assessment must be displayed with its real risks rather than hidden under a cosmetic READY message. The reviewer itself still runs outside the browser; do not describe its execution as a browser feature. See `docs/readiness-gate.md`.

## Storyline and prose

Use the installed generic human-review workflow for a document such as:

```sh
human-review projects/NAME/story/review.md
```

For story suggestions and their decisions, follow `.claude/skills/story/SKILL.md`. If the generic tool is unavailable, provide the document path and describe the missing review capability. When the creator asks to edit the actual slides, switch to the native studio above.
