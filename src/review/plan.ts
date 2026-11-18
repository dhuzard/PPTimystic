import { hash } from '../core/io.js';
import type { Deck, Project } from '../core/model.js';
import type { Storyline } from '../story/index.js';
import { isProtected, slideFingerprint } from './ledger.js';
import { actionable, autonomousClasses, planSchema, type Ledger, type Plan, type PlanItem, type ProposedChange } from './schema.js';
import { autonomousEligible, revisionRestriction } from './policy.js';

// The planner turns decided findings into a concrete, checkable plan. It never decides
// anything itself: every item traces to a creator acceptance or to the creator's explicit
// autonomous opt-in for narrowly scoped, non-scientific change classes.

const order: ProposedChange['type'][] = ['evidence-class', 'layout', 'object-geometry', 'wording', 'storyline'];
/** The current value a change would replace. Apply refuses when it differs from the planned one. */
export function targetValue(change: ProposedChange, slides: string[], deck: Deck, storyline: Storyline | undefined, config: Project): unknown {
  const slide = deck.slides.find(s => s.id === slides[0]);
  switch (change.type) {
    case 'wording': return slide?.content[change.locale ?? config.source_locale]?.[change.target] ?? null;
    case 'evidence-class': return slide?.evidence ?? null;
    case 'layout': return slide?.layout ?? null;
    case 'object-geometry': return slide?.visual_objects?.[change.object] ?? null;
    case 'storyline': {
      const c = change.change;
      if (c.kind === 'move') return deck.slides.map(s => s.id);
      if (c.kind === 'throughline') return storyline?.throughline ?? '';
      if (c.kind === 'framework') return storyline?.framework ?? 'research';
      return slides.map(id => storyline?.slides[id] ?? null);
    }
    default: return null;
  }
}
/** Whether the change would leave the source exactly as it is. */
function isNoOp(change: ProposedChange, current: unknown, slides: string[], deck: Deck): boolean {
  switch (change.type) {
    case 'wording': return current === change.suggested_text;
    case 'evidence-class': return current === change.evidence;
    case 'layout': return current === change.layout;
    case 'object-geometry': {
      const old = (current ?? {}) as Record<string, unknown> & { style?: Record<string, unknown> };
      const { style, ...geometry } = change.override;
      return Object.entries(geometry).every(([k, v]) => old[k] === v) && Object.entries(style ?? {}).every(([k, v]) => old.style?.[k] === v);
    }
    case 'storyline': {
      const c = change.change;
      if (c.kind === 'move') { const ids = deck.slides.map(s => s.id), at = ids.indexOf(slides[0]); return c.after === null ? at === 0 : ids[at - 1] === c.after; }
      if (c.kind === 'throughline') return current === c.text;
      if (c.kind === 'framework') return current === c.framework;
      const entries = current as ({ role?: string; section?: string; transition?: string } | null)[];
      return entries.every(e => c.kind === 'role' ? e?.role === c.role : c.kind === 'section' ? e?.section === c.section : e?.transition === c.text);
    }
    default: return false;
  }
}
const checksFor: Record<string, string[]> = {
  'wording': ['source-validation', 'text-fit', 'translation-freshness', 'build', 'render'],
  'evidence-class': ['source-validation', 'unsupported-claim', 'story-certainty', 'build'],
  'layout': ['geometry', 'text-fit', 'build', 'render'],
  'object-geometry': ['geometry', 'bounds-and-overlap', 'build', 'render'],
  'storyline': ['story-flow', 'build']
};

export interface PlanInput { ledger: Ledger; deck: Deck; config: Project; storyline?: Storyline; revision: string; briefApproved: boolean; now?: Date }
export function buildPlan({ ledger, deck, config, storyline, revision, briefApproved, now = new Date() }: PlanInput): Plan {
  if (ledger.settings.workflow === 'review-only') throw new Error('This review runs in review-only mode. Change the workflow (review --mode configure) before planning revisions.');
  if (!briefApproved) throw new Error('The creator brief is not approved, so revisions and builds are blocked. Complete npm run brief first.');
  if (ledger.revision_rounds >= ledger.settings.max_rounds) throw new Error(`Iteration limit reached (${ledger.revision_rounds} of ${ledger.settings.max_rounds} revision rounds). Report the remaining findings to the creator; only they can raise the limit.`);
  const items: PlanItem[] = [], deferred: Plan['deferred'] = [];
  const candidates = ledger.findings.filter(f => (actionable.includes(f.status) && f.proposed_change.type !== 'none') || autonomousEligible(f, ledger, deck)
    || ledger.settings.workflow === 'autonomous' && f.status === 'proposed' && f.changes_scientific_meaning
      && ledger.settings.autonomous_classes.includes(f.proposed_change.type as typeof autonomousClasses[number]));
  for (const f of candidates) {
    const c = f.proposed_change;
    const defer = (reason: string) => deferred.push({ finding: f.id, reason });
    const restriction = revisionRestriction(f, ledger, deck);
    if (restriction) { defer(restriction); continue; }
    if (c.type === 'manual') { defer('Needs authored content, data or design work. The builder implements it by hand (npm run revise) only from the brief and sources, then reports implemented-manually, or reports it blocked.'); continue; }
    if (c.type === 'wording' && c.suggested_text === null) { defer('Accepted in principle but has no wording. The builder drafts wording from the sources (builder submission `drafts`); the creator then approves the exact text.'); continue; }
    const missing = f.slide_ids.filter(id => !deck.slides.some(s => s.id === id));
    if (missing.length) { defer(`Slide ${missing.join(', ')} no longer exists.`); continue; }
    const current = targetValue(c, f.slide_ids, deck, storyline, config);
    if (isNoOp(c, current, f.slide_ids, deck)) { defer(f.status === 'unresolved' ? 'The change is already in the source and the re-review reported it unresolved. The reviewer must propose a different change.' : 'The source already matches this change.'); continue; }
    const approval: PlanItem['approval'] = f.status === 'proposed' ? 'autonomous-policy' : 'creator-accepted';
    const reference = approval === 'creator-accepted' ? f.decision?.slide_fingerprints ?? {} : f.provenance.slide_fingerprints;
    const changedSince = f.slide_ids.filter(id => reference[id] !== slideFingerprint(deck.slides.find(s => s.id === id)!));
    const locale = c.type === 'wording' ? c.locale ?? config.source_locale : undefined;
    const protectedSlides = c.type === 'storyline' && c.change.kind !== 'move' ? [] : f.slide_ids.filter(id => isProtected(deck.slides.find(s => s.id === id)!, locale));
    const authorized = f.decision?.authorized_slides ?? [];
    const authorization: PlanItem['authorization'] = !protectedSlides.length ? 'not-required' : protectedSlides.every(id => authorized.includes(id)) ? 'recorded' : 'missing';
    const translation = c.type === 'wording' && locale === config.source_locale
      ? config.output_locales.filter(l => l !== config.source_locale && deck.slides.find(s => s.id === f.slide_ids[0])?.content[l]) : [];
    const reasons = [
      changedSince.length ? `${changedSince.join(', ')} changed after the ${approval === 'creator-accepted' ? 'creator\'s decision' : 'review'}; the creator must re-confirm (review --mode decide) so newer edits are never overwritten.` : '',
      authorization === 'missing' ? `${protectedSlides.join(', ')} is approved or locked. The creator must explicitly authorize it (review --mode decide --decision accept --authorize ${protectedSlides.join(',')}).` : ''
    ].filter(Boolean);
    items.push({ finding: f.id, slides: f.slide_ids, change: c, category: f.category, target_sha256: hash(JSON.stringify(current ?? null)),
      protected_slides: protectedSlides, authorization, approval, ...(approval === 'creator-accepted' && f.decision ? { decided_at: f.decision.at } : {}), translation_review: translation, checks: checksFor[c.type] ?? ['build'],
      depends_on: [], status: reasons.length ? 'blocked' : 'ready', reason: reasons.join(' ') });
  }
  // Two findings rewriting the same target cannot both be applied; the creator chooses.
  const targetKey = (item: PlanItem) => item.change.type === 'storyline' && ['throughline', 'framework', 'move'].includes(item.change.change.kind)
    ? `deck:${item.change.change.kind}:${item.change.change.kind === 'move' ? item.slides[0] : ''}`
    : `${item.slides.join(',')}:${JSON.stringify(item.change.type === 'wording' ? [item.change.target, item.change.locale] : item.change.type === 'object-geometry' ? item.change.object : item.change.type === 'storyline' ? item.change.change.kind : item.change.type)}`;
  const groups = new Map<string, PlanItem[]>();
  for (const item of items) groups.set(targetKey(item), [...(groups.get(targetKey(item)) ?? []), item]);
  for (const group of groups.values()) if (group.length > 1) for (const item of group) {
    item.status = 'blocked';
    item.reason = `${item.reason} Conflicts with ${group.filter(x => x !== item).map(x => x.finding).join(', ')} on the same target; the creator must keep one.`.trim();
  }
  // Text fit depends on the layout and object geometry it is applied to.
  for (const item of items.filter(i => i.change.type === 'wording'))
    item.depends_on = items.filter(i => ['layout', 'object-geometry'].includes(i.change.type) && i.slides[0] === item.slides[0]).map(i => i.finding);
  for (const item of items.filter(i => i.status === 'ready' && i.depends_on.some(id => items.find(x => x.finding === id)?.status === 'blocked'))) {
    item.status = 'blocked'; item.reason = `${item.reason} Depends on a blocked layout change.`.trim();
  }
  items.sort((a, b) => order.indexOf(a.change.type) - order.indexOf(b.change.type));
  return planSchema.parse({ version: 1, id: `PLAN-${now.toISOString().replace(/[:.]/g, '-')}`, created_at: now.toISOString(), revision,
    workflow: ledger.settings.workflow, round: ledger.revision_rounds + 1, items, deferred });
}
