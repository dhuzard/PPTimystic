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

## Storyline and prose

Use the installed generic human-review workflow for a document such as:

```sh
human-review projects/NAME/story/review.md
```

For story suggestions and their decisions, follow `.claude/skills/story/SKILL.md`. If the generic tool is unavailable, provide the document path and describe the missing review capability. When the creator asks to edit the actual slides, switch to the native studio above.
