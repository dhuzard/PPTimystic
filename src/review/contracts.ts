import type { Deck, Project, Theme } from '../core/model.js';
import { buildSlideScene } from '../core/scene.js';
import type { Storyline } from '../story/index.js';

const normalize = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

/** Exact text preservation, with whitespace normalization. This does not establish scientific support. */
export async function assertExplanatoryContracts(dir: string, config: Project, deck: Deck, theme: Theme, storyline?: Storyline) {
  const errors: string[] = [];
  for (const [id, entry] of Object.entries(storyline?.slides ?? {})) {
    const rules = entry.explanatory_contract?.must_preserve ?? [];
    if (!rules.length) continue;
    const index = deck.slides.findIndex(s => s.id === id), slide = deck.slides[index];
    if (!slide) { errors.push(`${id}: contract slide was removed.`); continue; }
    const scenes = new Map<string, Awaited<ReturnType<typeof buildSlideScene>>>();
    for (const rule of rules) {
      const locale = rule.locale ?? config.source_locale, content = slide.content[locale];
      if (!content || !normalize(content[rule.field]).includes(normalize(rule.text))) {
        errors.push(`${id} (${locale}, ${rule.field}): must preserve "${rule.text}".`); continue;
      }
      let scene = scenes.get(locale);
      if (!scene) { scene = await buildSlideScene(slide, content, theme, locale, dir, index, { animations: config.animations }); scenes.set(locale, scene); }
      if (!scene.objects.some(o => o.type === 'text' && o.binding?.field === rule.field && normalize(o.text ?? '').includes(normalize(rule.text))))
        errors.push(`${id} (${locale}, ${rule.field}): must preserve visible text "${rule.text}"; the layout omits it.`);
    }
  }
  if (errors.length) throw new Error(`Explanatory contract violation:\n${errors.join('\n')}`);
}
