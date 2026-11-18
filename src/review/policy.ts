import type { Deck, Slide } from '../core/model.js';
import { autonomousClasses, type FindingRecord, type Ledger } from './schema.js';

export const isProtected = (slide: Slide, locale?: string) =>
  slide.locked || ['approved', 'locked'].includes(slide.status) || Boolean(locale && ['approved', 'locked'].includes(slide.content[locale]?.review ?? ''));

export function autonomousEligible(f: FindingRecord, ledger: Ledger, deck: Deck) {
  const c = f.proposed_change;
  return !f.changes_scientific_meaning && ledger.settings.workflow === 'autonomous' && f.status === 'proposed'
    && (autonomousClasses as readonly string[]).includes(c.type) && ledger.settings.autonomous_classes.includes(c.type as typeof autonomousClasses[number])
    && ['visual-design', 'technical-quality', 'accessibility'].includes(f.category)
    && ['verified-error', 'evidence-based-concern'].includes(f.basis)
    && f.slide_ids.every(id => { const s = deck.slides.find(x => x.id === id); return s && !isProtected(s) && s.status === 'draft'; });
}

/** A move affects the whole interval it crosses; deck-level metadata affects every slide. */
export function affectedSlides(f: Pick<FindingRecord, 'slide_ids' | 'proposed_change'>, deck: Deck): string[] {
  const c = f.proposed_change, ids = deck.slides.map(s => s.id);
  if (c.type === 'storyline') {
    if (c.change.kind === 'throughline' || c.change.kind === 'framework') return ids;
    if (c.change.kind === 'move') {
      const next = ids.filter(id => id !== f.slide_ids[0]);
      next.splice(c.change.after === null ? 0 : next.indexOf(c.change.after) + 1, 0, f.slide_ids[0]);
      return ids.filter((id, index) => next[index] !== id);
    }
  }
  return f.slide_ids.length ? f.slide_ids : ids;
}

export function revisionRestriction(f: FindingRecord, ledger: Ledger, deck: Deck): string | undefined {
  if (ledger.settings.workflow === 'autonomous' && f.changes_scientific_meaning)
    return 'This finding changes scientific meaning. Switch to assisted mode for a creator-decided revision.';
  const scope = ledger.settings.revision_scope;
  if (!scope) return;
  if (!scope.allowed_change_classes.includes(f.proposed_change.type)) return `Revision scope excludes change class ${f.proposed_change.type}.`;
  const outside = scope.slide_ids === null ? [] : affectedSlides(f, deck).filter(id => !scope.slide_ids!.includes(id));
  if (outside.length) return `Revision scope excludes affected slides ${outside.join(', ')}.`;
}
