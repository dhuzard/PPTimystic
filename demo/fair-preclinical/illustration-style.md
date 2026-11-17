# Illustration style — version 1 (ink + muted-pink watercolor)

Copy this file over `projects/fair-preclinical/illustration-style.md` after the project exists. `npm run images` embeds it in every per-slide prompt record.

Reference analysis: there are **no user-supplied reference images**. This specification comes from the creator's written direction in issue #5 ("hand-drawn dark ink on muted pink, dreamy watercolor washes, generous whitespace"). The resulting [style study](illustrations/style-study-v1.svg) was inspected visually as a PNG rendered with sharp at 1200×900. If reference images are added later, revise each field and record what was inspected.

- **Palette:** ink `#2A2226` (near-black, warm); washes `#E3B9BC` (blush), `#D79AA3` (dusty rose), `#B9A3B4` (grey-mauve accent, at most one per image). The slide background is `#F6ECEB` (theme `ink-watercolor`); images are composed to sit on it without a visible box.
- **Technique:** single-weight pen line drawing over loose, translucent watercolor washes. The washes are **behind** the line work and do not follow outlines exactly.
- **Stroke:** 3–5 px at 1200 px width, round caps and joins, gently wavering (low-frequency displacement, never jagged); 2 px at 45–85% opacity for secondary marks and hatching.
- **Texture:** soft, bleeding wash edges with light paper grain inside washes; no grain on the ink.
- **Lighting:** none modelled; at most a few hatch lines for a ground shadow.
- **Perspective:** flat or a slight three-quarter view; no vanishing-point drawing.
- **Geometry:** simple, slightly irregular hand-drawn shapes (sheets, tags, tools, everyday lab objects). No precise charts.
- **Detail:** low; 2–5 objects per image, each recognizable at 3 m on a projected slide.
- **Background:** transparent; the wash provides the ground. No frame or border.
- **Proportions:** symbolic, never empirical; nothing that reads as data, an axis or a measurement.
- **Complexity:** one visual idea per image, matching the slide's single message.
- **Negative space:** at least 40% of the canvas left as background.
- **Composition:** centered, 4:3 canvas (1200×900), with a 10% margin on all sides so the slide's `text-image` frame never crops ink.
- **Never:** text, letters, numbers, logos, faces of identifiable people, animals in distress, or simulated results.

## Master prompt (v1)

> Original conceptual illustration for a scientific workshop slide. Hand-drawn dark warm-ink pen line (single weight, gently wavering) over loose muted-pink watercolor washes (blush, dusty rose, one optional grey-mauve accent), transparent background, generous negative space, 2–5 simple objects expressing exactly one idea. No text, letters, numbers, logos, charts or data. Central message: {{message}}. Slide brief: {{brief}}.

## Production rule

Each per-slide illustration is an original SVG authored in this style (or a creator-supplied drawing). It is attached with `npm run images -- --project fair-preclinical --slide ID --asset FILE`, so the hash and provenance are recorded, and the creator accepts it before it counts as final.
