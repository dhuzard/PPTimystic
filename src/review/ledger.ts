import { hash } from '../core/io.js';
import type { Deck, Project, Slide } from '../core/model.js';
import type { Storyline } from '../story/index.js';
import { autonomousEligible, isProtected, revisionRestriction } from './policy.js';
export { isProtected } from './policy.js';
import {
  actionable, awaitingCreator, closedByCreator, ledgerSchema, submissionSchema,
  type FindingInput, type FindingRecord, type Ledger, type ProposedChange, type Submission
} from './schema.js';

// Pure ledger logic. Every function validates the whole input first and throws a single
// error listing every problem, so a rejected submission or decision never half-applies.

export const emptyLedger = (): Ledger => ledgerSchema.parse({ version: 1 });
export const slideFingerprint = (slide: Slide) => hash(JSON.stringify(slide));

/** Where a change lands, independent of its wording. Two findings with the same key are duplicates. */
export function changeTarget(change: ProposedChange): string {
  switch (change.type) {
    case 'wording': return `wording:${change.target}:${change.locale ?? ''}`;
    case 'object-geometry': return `geometry:${change.object}`;
    case 'storyline': return `storyline:${change.change.kind}`;
    default: return change.type;
  }
}
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function findingKey(f: Pick<FindingInput, 'category' | 'slide_ids' | 'object_ids' | 'proposed_change' | 'title'>) {
  // Changes with a concrete target dedupe on the target; observations and manual work dedupe on their title.
  const anchor = ['none', 'manual'].includes(f.proposed_change.type) ? normalize(f.title) : '';
  return hash(JSON.stringify([f.category, [...f.slide_ids].sort(), [...f.object_ids].sort(), changeTarget(f.proposed_change), anchor]));
}

// Numbers and DOIs a suggestion introduces must already exist in the slide or its sources.
// This catches invented sample sizes, p-values and references; it cannot catch invented words.
const numberPattern = /(?<![\p{L}\p{N}.])\d+(?:[.,]\d+)*(?:\s?%)?/gu;
const doiPattern = /\b10\.\d{4,9}\/[^\s"'<>)\]]+/gi;
const canonicalNumber = (value: string) => value.replace(/\s/g, '').replace(/,(\d{3})(?!\d)/g, '$1').replace(',', '.');
export function unsupportedTokens(text: string, corpus: string) {
  const doi = (d: string) => d.toLowerCase().replace(/[.,;]+$/, '');
  const withoutDois = (value: string) => value.replace(doiPattern, ' ');
  const numbers = new Set((withoutDois(corpus).match(numberPattern) ?? []).map(canonicalNumber));
  const dois = new Set((corpus.match(doiPattern) ?? []).map(doi));
  return [
    ...(withoutDois(text).match(numberPattern) ?? []).filter(n => !numbers.has(canonicalNumber(n))),
    ...(text.match(doiPattern) ?? []).map(doi).filter(d => !dois.has(d))
  ];
}
/** Everything a revised wording may legitimately draw numbers and DOIs from. */
export function slideCorpus(slide: Slide, sourceTexts: string[]) {
  const localized = Object.values(slide.content).flatMap(c => [c.title, c.message, c.body, c.notes, c.caption, c.alt, ...c.labels, ...c.seriesNames]);
  const chart = slide.chart?.series.flatMap(s => s.values.map(String)) ?? [];
  const claims = (slide.claims ?? []).map(claim => claim.excerpt);
  return [...localized, ...slide.citations, ...chart, ...claims, ...sourceTexts].join('\n');
}

export interface SubmitContext {
  deck: Deck; config: Project; revision: string;
  /** Source IDs known to content/sources.yaml, with locally extracted text where available. */
  sources: Record<string, { extracted?: string }>;
  /** Slides whose rendered preview is current for the source revision. */
  currentPreviews: Set<string>;
  now?: Date;
  storyline?: Storyline;
}
export interface SubmitResult { created: string[]; updated: string[]; reopened: string[]; suppressed: { key: string; matches: string; reason: string }[]; verified: string[]; withdrawn: string[]; questions: string[]; drafts: string[]; outcomes: string[] }

const nextId = (ids: string[], prefix: string) => {
  const max = ids.reduce((n, id) => Math.max(n, Number(id.slice(prefix.length + 1)) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
};
const history = (ledger: Ledger, at: string, event: string, actor: string, detail = '') => ledger.history.push({ at, event, actor, detail: detail.slice(0, 4000) });

function checkFinding(f: FindingInput, ctx: SubmitContext, viewed: Set<string>, ledger: Ledger, errors: string[]) {
  const label = f.id ?? `"${f.title}"`;
  const err = (message: string) => errors.push(`${label}: ${message}`);
  const slides = f.slide_ids.map(id => ctx.deck.slides.find(s => s.id === id));
  f.slide_ids.forEach((id, i) => { if (!slides[i]) err(`unknown slide ${id}. Slide IDs are stable; use IDs from review/context.json.`); });
  const known = slides.filter((s): s is Slide => Boolean(s));
  for (const object of f.object_ids) if (object.startsWith('object-') && !known.some(s => s.objects?.some(o => o.id === object))) err(`unknown object ${object} on ${f.slide_ids.join(', ') || 'the deck'}.`);
  for (const ref of f.evidence.source_refs) if (!ctx.sources[ref]) err(`unknown source reference ${ref}; it is not in content/sources.yaml.`);
  const claimOwners = f.slide_ids.length ? known : ctx.deck.slides;
  for (const claim of f.evidence.claim_ids) if (!claimOwners.some(s => s.claims?.some(c => c.id === claim))) err(`unknown claim ${claim}.`);
  if (f.inspected.includes('rendered-preview')) {
    const required = f.slide_ids.length ? f.slide_ids : [...viewed];
    if (!required.length || required.some(id => !viewed.has(id))) err('claims a rendered-preview inspection for a slide that is not listed in rendered_previews_viewed with a current preview. Render first, or record what was actually inspected.');
  }
  const readsSources = f.evidence.status === 'source-read-by-reviewer' || f.inspected.includes('extracted-source');
  if (readsSources) {
    if (!f.evidence.source_refs.length) err('an extracted-source inspection must list the source_refs that were read.');
    for (const ref of f.evidence.source_refs) if (ctx.sources[ref] && ctx.sources[ref].extracted === undefined) err(`source ${ref} has no locally extracted text, so it cannot have been read. Use requires-human-verification.`);
  }
  if (f.evidence.status === 'source-read-by-reviewer' && !f.inspected.includes('extracted-source')) err('source-read-by-reviewer requires inspected: extracted-source.');
  if (f.regression_of && !ledger.findings.some(x => x.id === f.regression_of)) err(`regression_of ${f.regression_of} is not a known finding.`);
  const c = f.proposed_change, slide = known[0];
  if (c.type === 'wording' && slide) {
    const locale = c.locale ?? ctx.config.source_locale;
    if (!slide.content[locale]) err(`${slide.id} has no ${locale} content to revise.`);
    if (c.suggested_text) {
      const sourceTexts = [...new Set([...slide.source_refs, ...f.evidence.source_refs])].map(ref => ctx.sources[ref]?.extracted ?? '');
      const invented = unsupportedTokens(c.suggested_text, slideCorpus(slide, sourceTexts));
      if (invented.length) err(`suggested_text introduces numbers or DOIs found neither on the slide nor in its extracted sources: ${[...new Set(invented)].join(', ')}. Never supply values the evidence does not contain; leave suggested_text null and ask the creator.`);
    }
  }
  if (c.type === 'evidence-class' && slide && ['established', 'interpretation'].includes(c.evidence) && !slide.source_refs.length && !slide.citations.length)
    err(`reclassifying ${slide.id} as ${c.evidence} would present unsourced content as evidence. Attach a source first or keep it conceptual/hypothesis.`);
  if (c.type === 'storyline' && c.change.kind === 'move' && c.change.after && !ctx.deck.slides.some(s => s.id === (c.change as { after: string }).after)) err(`cannot move after unknown slide ${c.change.after}.`);
}

/** Validate an agent submission against the current deck and merge it into the ledger. */
export function mergeSubmission(input: Ledger, raw: unknown, ctx: SubmitContext): { ledger: Ledger; result: SubmitResult } {
  const parsed = submissionSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid submission:\n${parsed.error.issues.map(i => `${i.path.join('.') || 'submission'}: ${i.message}`).join('\n')}`);
  const submission: Submission = parsed.data;
  const ledger: Ledger = structuredClone(input);
  const at = (ctx.now ?? new Date()).toISOString();
  const errors: string[] = [];
  const result: SubmitResult = { created: [], updated: [], reopened: [], suppressed: [], verified: [], withdrawn: [], questions: [], drafts: [], outcomes: [] };
  if (submission.context_revision !== ctx.revision) errors.push('The presentation changed after review/context.json was prepared. Run review --mode prepare again and review the current source.');
  const actor = `${submission.agent.role}:${submission.agent.name}`;
  const find = (id: string) => ledger.findings.find(f => f.id === id);

  if (submission.kind === 'builder') {
    for (const draft of submission.drafts) {
      const f = find(draft.finding);
      if (!f) { errors.push(`${draft.finding}: unknown finding.`); continue; }
      if (f.proposed_change.type !== 'wording' || f.proposed_change.suggested_text !== null || !actionable.includes(f.status)) { errors.push(`${f.id}: drafts are only for accepted wording findings that have no suggested text.`); continue; }
      const slide = ctx.deck.slides.find(s => s.id === f.slide_ids[0]);
      const sourceTexts = [...new Set([...(slide?.source_refs ?? []), ...f.evidence.source_refs])].map(ref => ctx.sources[ref]?.extracted ?? '');
      const invented = slide ? unsupportedTokens(draft.suggested_text, slideCorpus(slide, sourceTexts)) : [];
      if (invented.length) { errors.push(`${f.id}: draft introduces numbers or DOIs not found on the slide or in its sources: ${[...new Set(invented)].join(', ')}.`); continue; }
    }
    for (const outcome of submission.outcomes) {
      const f = find(outcome.finding);
      if (!f) { errors.push(`${outcome.finding}: unknown finding.`); continue; }
      if (!actionable.includes(f.status)) errors.push(`${f.id} is ${f.status}; the builder reports outcomes only for accepted or unresolved findings.`);
      if (outcome.outcome === 'implemented-manually') {
        const restriction = revisionRestriction(f, ledger, ctx.deck);
        if (restriction) errors.push(`${f.id}: ${restriction}`);
        if (f.proposed_change.type !== 'manual') errors.push(`${f.id}: only manual findings are implemented by hand; structured changes go through review --mode plan/apply.`);
        const unchanged = f.slide_ids.filter(id => { const s = ctx.deck.slides.find(x => x.id === id); return !s || slideFingerprint(s) === (f.decision?.slide_fingerprints[id] ?? f.provenance.slide_fingerprints[id]); });
        if (f.slide_ids.length && unchanged.length === f.slide_ids.length) errors.push(`${f.id}: reported as implemented, but ${unchanged.join(', ')} did not change since the decision.`);
      }
    }
    if (errors.length) throw new Error(`Submission rejected; nothing was recorded:\n${errors.join('\n')}`);
    for (const draft of submission.drafts) {
      const f = find(draft.finding)!;
      // The exact wording was never approved: it goes back to the creator as a proposal.
      f.proposed_change = { ...(f.proposed_change as Extract<ProposedChange, { type: 'wording' }>), suggested_text: draft.suggested_text };
      f.key = findingKey(f); f.status = 'proposed'; f.decision = undefined; f.updated_at = at;
      history(ledger, at, 'builder-draft', actor, `${f.id}: ${draft.note}`);
      result.drafts.push(f.id);
    }
    for (const outcome of submission.outcomes) {
      const f = find(outcome.finding)!;
      f.builder = { outcome: outcome.outcome, note: outcome.note, at };
      f.status = outcome.outcome === 'implemented-manually' ? 'applied' : 'blocked';
      if (f.status === 'applied') f.applied = { manifest: 'manual', round: Math.max(ledger.revision_rounds, 1), at };
      f.updated_at = at;
      history(ledger, at, `builder-${outcome.outcome}`, actor, `${f.id}: ${outcome.note}`);
      result.outcomes.push(f.id);
    }
    return { ledger: ledgerSchema.parse(ledger), result };
  }

  const viewed = new Set(submission.rendered_previews_viewed);
  for (const id of viewed) if (!ctx.currentPreviews.has(id)) errors.push(`rendered_previews_viewed lists ${id}, but no current rendered preview exists for it. Render the current build first.`);
  const round = ledger.review_rounds + 1;
  const keys = new Map<string, string>();
  for (const f of submission.findings) {
    checkFinding(f, ctx, viewed, ledger, errors);
    const key = findingKey(f);
    if (keys.has(key)) errors.push(`"${f.title}" duplicates "${keys.get(key)}" in the same submission; merge them.`);
    keys.set(key, f.title);
    if (f.id) {
      const existing = find(f.id);
      if (!existing) errors.push(`${f.id}: unknown finding ID. Omit id for a new finding.`);
      else if (closedByCreator.includes(existing.status) && !f.reopen_reason) errors.push(`${f.id} is ${existing.status}. Give reopen_reason (what changed) to raise it again.`);
    }
  }
  const touched = new Map(submission.findings.map(f => [f, f.slide_ids]));
  for (const a of submission.slide_assessments) {
    if (!ctx.deck.slides.some(s => s.id === a.slide)) errors.push(`slide_assessments: unknown slide ${a.slide}.`);
    if (a.verdict === 'no-change-needed' && [...touched].some(([f, ids]) => ids.includes(a.slide) && ['critical', 'major'].includes(f.severity) && f.proposed_change.type !== 'none'))
      errors.push(`${a.slide} is assessed as no-change-needed but this submission proposes a critical or major change to it.`);
  }
  for (const v of submission.verifications) {
    const f = find(v.finding);
    if (!f) { errors.push(`${v.finding}: unknown finding.`); continue; }
    if (f.status !== 'applied') errors.push(`${f.id} is ${f.status}; only applied findings are re-reviewed.`);
    if (v.outcome === 'resolved' && ['visual-design', 'accessibility'].includes(f.category) && !v.inspected.includes('rendered-preview'))
      errors.push(`${f.id}: a ${f.category} finding can be marked resolved only after viewing a current render. Use partially-resolved and say what was checked.`);
    if (v.inspected.includes('rendered-preview') && f.slide_ids.some(id => !viewed.has(id))) errors.push(`${f.id}: verification claims a rendered-preview inspection that is not listed in rendered_previews_viewed.`);
  }
  for (const id of submission.withdraw) {
    const f = find(id);
    if (!f) errors.push(`${id}: unknown finding.`);
    else if (!['proposed', 'discussing', 'accepted', 'blocked', 'unresolved'].includes(f.status)) errors.push(`${id} is ${f.status} and cannot be withdrawn.`);
  }
  for (const q of submission.anticipated_questions) {
    for (const id of q.slide_ids) if (!ctx.deck.slides.some(s => s.id === id)) errors.push(`question "${q.question}": unknown slide ${id}.`);
    for (const ref of q.source_refs) if (!ctx.sources[ref]) errors.push(`question "${q.question}": unknown source ${ref}.`);
    if (q.answer_basis === 'supported-by-sources' && !q.source_refs.length) errors.push(`question "${q.question}": supported-by-sources needs the source_refs that contain the answer.`);
    if (q.id && !ledger.questions.some(x => x.id === q.id)) errors.push(`${q.id}: unknown question ID.`);
  }
  if (errors.length) throw new Error(`Submission rejected; nothing was recorded:\n${errors.join('\n')}`);

  const fingerprints = (ids: string[]) => Object.fromEntries((ids.length ? ids : ctx.deck.slides.map(s => s.id))
    .map(id => [id, slideFingerprint(ctx.deck.slides.find(s => s.id === id)!)]));
  const provenance = (ids: string[]) => ({ agent: submission.agent, round, reviewed_at: at, reviewed_revision: ctx.revision, slide_fingerprints: fingerprints(ids) });
  for (const input of submission.findings) {
    const { id: _id, reopen_reason, ...body } = input;
    if (body.proposed_change.type !== 'none') body.acceptance_criteria = [...new Set([
      ...body.acceptance_criteria,
      ...(body.slide_ids.length ? body.slide_ids : ctx.deck.slides.map(s => s.id)).flatMap(id => ctx.storyline?.slides[id]?.explanatory_contract?.success_checks ?? [])
    ])];
    const key = findingKey(input);
    const existing = input.id ? find(input.id) : ledger.findings.find(f => f.key === key);
    if (existing && !input.id && closedByCreator.includes(existing.status) && !reopen_reason) {
      // The creator already decided; repeating the suggestion must not restart the conversation.
      result.suppressed.push({ key, matches: existing.id, reason: `${existing.id} is ${existing.status}` });
      continue;
    }
    if (!existing) {
      const id = nextId(ledger.findings.map(f => f.id), 'REV');
      ledger.findings.push({ ...body, id, key, status: 'proposed', provenance: provenance(input.slide_ids), unresolved_count: 0, updated_at: at });
      result.created.push(id);
      continue;
    }
    const changed = JSON.stringify(existing.proposed_change) !== JSON.stringify(input.proposed_change)
      || existing.changes_scientific_meaning !== input.changes_scientific_meaning;
    const reopen = closedByCreator.includes(existing.status) || existing.status === 'resolved';
    Object.assign(existing, body, { key, provenance: provenance(input.slide_ids), updated_at: at });
    if (reopen_reason) existing.reopen_reason = reopen_reason;
    if (reopen || changed) {
      // A different change, or a problem that came back, needs a fresh creator decision.
      existing.status = 'proposed'; existing.decision = undefined;
      (reopen ? result.reopened : result.updated).push(existing.id);
      history(ledger, at, reopen ? 'finding-reopened' : 'finding-revised', actor, `${existing.id}${reopen_reason ? `: ${reopen_reason}` : ''}`);
    } else result.updated.push(existing.id);
  }
  for (const v of submission.verifications) {
    const f = find(v.finding)!;
    f.resolution = { outcome: v.outcome, note: v.note, round, at };
    if (v.outcome === 'resolved') f.status = 'resolved';
    else {
      f.unresolved_count += 1;
      // Two failed attempts at the same finding is a stall, not a reason to keep looping.
      f.status = f.unresolved_count >= 2 ? 'stalled' : 'unresolved';
    }
    f.updated_at = at;
    result.verified.push(f.id);
  }
  for (const id of submission.withdraw) { const f = find(id)!; f.status = 'withdrawn'; f.updated_at = at; result.withdrawn.push(id); }
  for (const a of submission.slide_assessments) {
    const slide = ctx.deck.slides.find(s => s.id === a.slide)!;
    ledger.slide_assessments[a.slide] = { verdict: a.verdict, note: a.note, round, fingerprint: slideFingerprint(slide) };
  }
  for (const q of submission.anticipated_questions) {
    const existing = q.id ? ledger.questions.find(x => x.id === q.id) : ledger.questions.find(x => normalize(x.question) === normalize(q.question));
    if (existing) Object.assign(existing, q, { id: existing.id, round });
    else ledger.questions.push({ ...q, id: nextId(ledger.questions.map(x => x.id), 'Q'), round });
    result.questions.push(existing?.id ?? ledger.questions.at(-1)!.id);
  }
  if (submission.assessment) ledger.assessment = { ...submission.assessment, round, agent: actor };
  ledger.review_rounds = round;
  history(ledger, at, 'review-submitted', actor, `round ${round}: ${result.created.length} new, ${result.updated.length} updated, ${result.reopened.length} reopened, ${result.suppressed.length} suppressed, ${result.verified.length} verified`);
  return { ledger: ledgerSchema.parse(ledger), result };
}

export const decisions = ['accept', 'reject', 'defer', 'discuss', 'request-alternative'] as const;
export type Decision = typeof decisions[number];
/** Record a creator decision transcribed from the review page or terminal. */
export function decide(input: Ledger, ids: string[], decision: Decision, by: string, deck: Deck, options: { note?: string; authorize?: string[]; now?: Date; sourceLocale?: string } = {}) {
  const ledger: Ledger = structuredClone(input);
  const at = (options.now ?? new Date()).toISOString();
  const errors: string[] = [];
  if (!by.trim() || by.trim().length < 2) errors.push('Name the person who decided (--by).');
  if (decision === 'request-alternative' && !options.note?.trim()) errors.push('Say what alternative is wanted (--note).');
  const authorize = options.authorize ?? [];
  const selected = ids.map(id => {
    const f = ledger.findings.find(x => x.id === id);
    if (!f) { errors.push(`${id}: unknown finding.`); return undefined; }
    if (!['proposed', 'discussing', 'blocked', 'unresolved', 'accepted', 'deferred', 'stalled'].includes(f.status)) errors.push(`${id} is ${f.status}; it can no longer be decided.`);
    for (const slide of f.slide_ids) if (!deck.slides.some(s => s.id === slide)) errors.push(`${id}: slide ${slide} no longer exists.`);
    return f;
  }).filter((f): f is FindingRecord => Boolean(f));
  for (const slide of authorize) {
    const target = deck.slides.find(s => s.id === slide);
    if (!selected.some(f => f.slide_ids.includes(slide))) errors.push(`--authorize ${slide}: none of the decided findings targets it.`);
    else if (target && !isProtected(target, options.sourceLocale)) errors.push(`--authorize ${slide}: the slide is not approved or locked; nothing to authorize.`);
  }
  if (authorize.length && decision !== 'accept') errors.push('--authorize applies only to accepted findings.');
  if (errors.length) throw new Error(`Decision not recorded:\n${errors.join('\n')}`);
  for (const f of selected) {
    f.decision = { decision, by: by.trim(), at, ...(options.note ? { note: options.note } : {}),
      authorized_slides: authorize.filter(id => f.slide_ids.includes(id)),
      slide_fingerprints: Object.fromEntries(f.slide_ids.map(id => [id, slideFingerprint(deck.slides.find(s => s.id === id)!)])) };
    f.status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : decision === 'defer' ? 'deferred' : 'discussing';
    if (decision === 'accept') f.last_error = undefined;
    f.updated_at = at;
  }
  history(ledger, at, `creator-${decision}`, `creator:${by.trim()}`, `${ids.join(', ')}${authorize.length ? ` (authorized ${authorize.join(', ')})` : ''}${options.note ? `: ${options.note}` : ''}`);
  return ledgerSchema.parse(ledger);
}

export type StopReason = 'review-only' | 'iteration-limit' | 'awaiting-creator' | 'no-actionable-high-priority' | 'stalled' | 'awaiting-re-review' | 'nothing-to-review' | 'revision-restricted';
/** Deterministic stopping rules. A model's own quality score is never one of them. */
export function workflowStatus(ledger: Ledger, deck?: Deck) {
  const count = (statuses: string[]) => ledger.findings.filter(f => statuses.includes(f.status));
  const changing = (f: FindingRecord) => f.proposed_change.type !== 'none';
  const highPriority = (f: FindingRecord) => ['critical', 'major'].includes(f.severity);
  const waiting = count(awaitingCreator), applied = count(['applied']), stalled = count(['stalled']), blocked = count(['blocked']);
  const candidates = [...count(actionable).filter(changing), ...(deck ? ledger.findings.filter(f => autonomousEligible(f, ledger, deck)) : [])];
  const restricted = deck ? candidates.flatMap(f => { const reason = revisionRestriction(f, ledger, deck); return reason ? [{ finding: f.id, reason }] : []; }) : [];
  const todo = candidates.filter(f => !restricted.some(r => r.finding === f.id));
  const openHigh = ledger.findings.filter(f => highPriority(f) && [...awaitingCreator, ...actionable, 'applied', 'blocked'].includes(f.status) && changing(f));
  const reasons: StopReason[] = [];
  if (!ledger.review_rounds) reasons.push('nothing-to-review');
  if (ledger.settings.workflow === 'review-only') reasons.push('review-only');
  if (ledger.revision_rounds >= ledger.settings.max_rounds && (todo.length || waiting.length)) reasons.push('iteration-limit');
  if (applied.length) reasons.push('awaiting-re-review');
  if (restricted.length && !todo.length) reasons.push('revision-restricted');
  if (waiting.length && !todo.length) reasons.push('awaiting-creator');
  if (stalled.length && !todo.length && !waiting.length) reasons.push('stalled');
  if (ledger.review_rounds && !openHigh.length) reasons.push('no-actionable-high-priority');
  const canRevise = ledger.settings.workflow !== 'review-only' && ledger.revision_rounds < ledger.settings.max_rounds && todo.length > 0;
  const next = !ledger.review_rounds ? 'Run review --mode prepare, then let the scientific reviewer submit a report.'
    : applied.length ? 'Re-review: run review --mode verify, then let the reviewer submit verifications for the applied findings.'
    : canRevise ? 'Run review --mode plan, then review --mode apply.'
    : restricted.length ? 'The creator must revise the scope or use assisted mode for scientific-meaning changes before these findings can be applied.'
    : waiting.length ? 'The creator decides on the open findings (review --mode report shows them).'
    : 'Stop. Report unresolved, blocked and stalled findings to the creator.';
  const tally = Object.fromEntries(['proposed', 'discussing', 'accepted', 'rejected', 'deferred', 'blocked', 'applied', 'resolved', 'unresolved', 'stalled', 'withdrawn']
    .map(status => [status, ledger.findings.filter(f => f.status === status).length]).filter(([, n]) => n));
  return {
    workflow: ledger.settings.workflow, max_rounds: ledger.settings.max_rounds,
    review_rounds: ledger.review_rounds, revision_rounds: ledger.revision_rounds, findings: tally,
    open_high_priority: openHigh.map(f => f.id), awaiting_creator: waiting.map(f => f.id), ready_for_builder: todo.map(f => f.id),
    awaiting_re_review: applied.map(f => f.id), blocked: blocked.map(f => f.id), stalled: stalled.map(f => f.id),
    restricted,
    can_revise: canRevise, stop: !canRevise && !applied.length, reasons, next
  };
}
