import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import JSZip from 'jszip';
import { deckSchema, projectSchema, type Deck } from '../src/core/model.js';
import { decide, emptyLedger, mergeSubmission, slideFingerprint, unsupportedTokens, workflowStatus, type SubmitContext } from '../src/review/ledger.js';
import { heuristicPrompts } from '../src/review/context.js';
import { buildPlan } from '../src/review/plan.js';
import { reviewMarkdown, reviewThreads } from '../src/review/report.js';
import type { Ledger } from '../src/review/schema.js';
import { analyzeStory, storylineSchema } from '../src/story/index.js';
import { claimSchema } from '../src/core/model.js';
import { claimFingerprint, claimVerificationState } from '../src/content/claims.js';

// FICTIONAL TEST DATA. "Compound Z" and every number below are invented for these tests.
const config = projectSchema.parse({ version: 1, title: 'Fictional review fixture', source_locale: 'en-US', output_locales: ['en-US', 'fr-FR'] });
const source = 'FICTIONAL FIXTURE. In this observational dataset, treated mice (n = 12) spent 42% more time in the open arms than controls (p = 0.03). Treatment was not randomized.';
function fixture(): Deck {
  const text = (title: string, message = '') => ({ title, message });
  return deckSchema.parse({ version: 1, slides: [
    { id: 'S001', layout: 'title', evidence: 'conceptual', content: { 'en-US': text('Compound Z and anxiety-like behaviour (fictional)'), 'fr-FR': text('Composé Z (fictif)') } },
    { id: 'S002', layout: 'statement', evidence: 'interpretation', source_refs: ['SRC1'],
      content: { 'en-US': text('Compound Z reduces anxiety in mice', 'Treated mice spent 42% more time in open arms (n = 12)'), 'fr-FR': text('Le composé Z réduit l’anxiété', 'Plus de temps en bras ouverts') } },
    { id: 'S003', layout: 'statement', evidence: 'established', source_refs: ['SRC1'], content: { 'en-US': text('Open-arm time was similar at baseline'), 'fr-FR': text('Temps similaire au départ') } },
    { id: 'S004', layout: 'conclusion', evidence: 'interpretation', status: 'approved', source_refs: ['SRC1'], content: { 'en-US': text('Compound Z is associated with more open-arm time'), 'fr-FR': text('Association') } },
    { id: 'S005', layout: 'statement', evidence: 'conceptual', content: { 'en-US': text('A possible mechanism'), 'fr-FR': text('Un mécanisme possible') } }
  ] });
}
const revision = 'a'.repeat(64);
const context = (deck: Deck, extra: Partial<SubmitContext> = {}): SubmitContext => ({
  deck, config, revision, sources: { SRC1: { extracted: source }, SRC2: {} }, currentPreviews: new Set(), now: new Date('2026-11-18T10:00:00Z'), ...extra
});
const finding = (overrides: Record<string, unknown> = {}) => ({
  changes_scientific_meaning: false,
  category: 'scientific-validity', severity: 'major', basis: 'evidence-based-concern', confidence: 'high', slide_ids: ['S002'],
  title: 'Causal title exceeds observational evidence', observation: 'The title says "reduces"; the source is observational and not randomized.',
  evidence: { source_refs: ['SRC1'], locators: ['Results'], status: 'source-read-by-reviewer' }, inspected: ['source-yaml', 'extracted-source'],
  rationale: 'An observational, non-randomized comparison does not establish causation.', recommendation: 'Use associational wording that keeps the population.',
  proposed_change: { type: 'wording', target: 'title', suggested_text: 'Compound Z is associated with more open-arm time in mice' },
  acceptance_criteria: ['The title does not claim causation.'], ...overrides
});
const submission = (findings: unknown[], extra: Record<string, unknown> = {}) => ({
  kind: 'review', version: 1, agent: { role: 'reviewer', name: 'Test reviewer', model: 'fixture' }, context_revision: revision, findings, ...extra
});
const reject = (ledger: Ledger, raw: unknown, ctx = context(fixture())) => { try { mergeSubmission(ledger, raw, ctx); } catch (error) { return (error as Error).message; } throw new Error('expected rejection'); };

describe('review contract', () => {
  test('scientific meaning must be classified explicitly; agents cannot submit verification metadata', () => {
    expect(reject(emptyLedger(), submission([finding({ changes_scientific_meaning: undefined })]))).toContain('changes_scientific_meaning');
    expect(reject(emptyLedger(), submission([finding({ verified: true })]))).toContain('verified');
    expect(reject(emptyLedger(), submission([finding({ human_verification: { verified_by: 'Agent' } })]))).toContain('human_verification');
  });
  test('a valid report gets stable, sequential finding IDs and slide fingerprints', () => {
    const deck = fixture();
    const { ledger, result } = mergeSubmission(emptyLedger(), submission([finding(), finding({ slide_ids: ['S005'], category: 'narrative-structure', severity: 'minor', basis: 'editorial-judgment', title: 'Mechanism slide lacks a bridge', evidence: { status: 'not-applicable' }, inspected: ['storyline'], proposed_change: { type: 'storyline', change: { kind: 'transition', text: 'What could explain this association?' } } })]), context(deck));
    expect(result.created).toEqual(['REV-001', 'REV-002']);
    expect(ledger.findings[0]).toMatchObject({ status: 'proposed', provenance: { round: 1, reviewed_revision: revision, slide_fingerprints: { S002: slideFingerprint(deck.slides[1]) } } });
    const again = mergeSubmission(ledger, submission([finding({ id: 'REV-001', observation: 'Updated wording of the observation.' }), finding({ slide_ids: ['S003'], title: 'Another', proposed_change: { type: 'none' }, acceptance_criteria: [] })]), context(deck));
    expect(again.result).toMatchObject({ updated: ['REV-001'], created: ['REV-003'] });
    expect(again.ledger.findings.find(f => f.id === 'REV-001')?.status).toBe('proposed');
    expect(again.ledger.review_rounds).toBe(2);
  });

  test('malformed recommendations, unknown IDs and false verification claims are rejected as a whole', () => {
    const ledger = emptyLedger();
    expect(reject(ledger, submission([finding({ acceptance_criteria: [] })]))).toContain('acceptance criterion');
    expect(reject(ledger, submission([finding({ slide_ids: ['S002', 'S003'] })]))).toContain('exactly one slide');
    expect(reject(ledger, submission([finding({ slide_ids: ['S999'] })]))).toContain('unknown slide S999');
    expect(reject(ledger, submission([finding({ evidence: { source_refs: ['NOPE'], status: 'requires-human-verification' } })]))).toContain('unknown source reference NOPE');
    // There is no "verified" evidence status: a source link never establishes support.
    expect(reject(ledger, submission([finding({ evidence: { source_refs: ['SRC1'], status: 'verified' } })]))).toContain('evidence.status');
    expect(reject(ledger, submission([finding({ basis: 'verified-error', evidence: { status: 'requires-human-verification' }, inspected: ['source-yaml'] })]))).toContain('verified scientific error must cite');
    expect(reject(ledger, submission([finding({ evidence: { source_refs: ['SRC2'], status: 'source-read-by-reviewer' } })]))).toContain('no locally extracted text');
    expect(reject(ledger, submission([finding({ id: 'REV-404' })]))).toContain('unknown finding ID');
    expect(reject(ledger, submission([finding()], { context_revision: 'b'.repeat(64) }))).toContain('changed after review/context.json');
    // A rejected submission records nothing.
    expect(ledger.findings).toEqual([]);
  });

  test('visual inspection can be claimed only for slides with a current render', () => {
    const visual = finding({ category: 'visual-design', basis: 'design-preference', inspected: ['rendered-preview'], evidence: { status: 'not-applicable' },
      title: 'Message crowds the title', proposed_change: { type: 'object-geometry', object: 'message', override: { y: 3 } } });
    expect(reject(emptyLedger(), submission([visual], { rendered_previews_viewed: ['S002'] }))).toContain('no current rendered preview');
    expect(reject(emptyLedger(), submission([visual]))).toContain('rendered_previews_viewed');
    const ok = mergeSubmission(emptyLedger(), submission([visual], { rendered_previews_viewed: ['S002'] }), context(fixture(), { currentPreviews: new Set(['S002']) }));
    expect(ok.result.created).toEqual(['REV-001']);
  });
});

const explanatoryContract = (extra: Record<string, unknown> = {}) => ({
  audience_question: 'Can a review legitimately find no issue?', central_message: 'NONE is a legitimate outcome',
  introduces: [], prerequisites: [], worked_example: 'A sound slide yields NONE.',
  must_preserve: [{ field: 'body', text: 'NONE is a legitimate outcome' }],
  success_checks: ['The audience can explain why NONE is legitimate.'], ...extra
});

describe('contracts, claim types and scope', () => {
  test('prerequisites follow actual deck order and success checks enter critic acceptance criteria', () => {
    const deck = fixture();
    const story = storylineSchema.parse({ version: 1, slides: {
      S002: { explanatory_contract: explanatoryContract({ prerequisites: ['Review outcome'] }) },
      S003: { explanatory_contract: explanatoryContract({ introduces: ['Review outcome'], must_preserve: [] }) }
    } });
    expect(analyzeStory(deck, config, story).issues).toContainEqual(expect.objectContaining({ code: 'story-prerequisite-order', slide: 'S002', message: expect.stringContaining('S003') }));
    const reordered = structuredClone(deck);
    [reordered.slides[1], reordered.slides[2]] = [reordered.slides[2], reordered.slides[1]];
    expect(analyzeStory(reordered, config, story).issues.some(i => i.code === 'story-prerequisite-order')).toBe(false);
    const ledger = mergeSubmission(emptyLedger(), submission([finding()]), context(deck, { storyline: story })).ledger;
    expect(ledger.findings[0].acceptance_criteria).toContain('The audience can explain why NONE is legitimate.');
  });

  test('claim type is separate from evidence strength and personal verification becomes stale on changes', () => {
    const slide = fixture().slides[1], provenance = { sha256: 'b'.repeat(64), extracted_sha256: 'c'.repeat(64) };
    const claim = claimSchema.parse({ id: 'C001', field: 'title', source_ref: 'SRC1', excerpt: source,
      claim_type: 'proposed-capability', qualification_note: 'Proposed only; no implementation evidence.' });
    expect(claimVerificationState(slide, claim, provenance)).toBe('not-verified');
    claim.human_verification = { verified_by: 'Test Creator', verified_at: '2026-11-18T10:00:00Z', claim_sha256: claimFingerprint(slide, claim, provenance) };
    expect(claimVerificationState(slide, claim, provenance)).toBe('current');
    expect(claimVerificationState(slide, claim, provenance, false)).toBe('stale');
    expect(claimVerificationState(slide, { ...claim, claim_type: 'implemented-capability' }, provenance)).toBe('stale');
    expect(claimVerificationState(slide, { ...claim, qualification_note: 'Changed qualification' }, provenance)).toBe('stale');
    expect(claimVerificationState(slide, claim, { ...provenance, sha256: 'd'.repeat(64) })).toBe('stale');
    slide.content['en-US'].title = 'Changed wording';
    expect(claimVerificationState(slide, claim, provenance)).toBe('stale');
    expect(claimSchema.safeParse({ ...claim, verified: true }).success).toBe(false);
  });

  test('scope covers slide changes, the interval crossed by a move, and deck-wide metadata', () => {
    const deck = fixture();
    let ledger = mergeSubmission(emptyLedger(), submission([finding(), finding({ slide_ids: ['S005'], title: 'Move mechanism',
      proposed_change: { type: 'storyline', change: { kind: 'move', after: 'S001' } } }), finding({ title: 'Throughline', slide_ids: ['S002'],
      proposed_change: { type: 'storyline', change: { kind: 'throughline', text: 'A qualified interpretation' } } })]), context(deck)).ledger;
    ledger = decide(ledger, ['REV-001', 'REV-002', 'REV-003'], 'accept', 'Test Creator', deck);
    ledger.settings.revision_scope = { slide_ids: ['S002', 'S005'], allowed_change_classes: ['wording', 'storyline'] };
    let plan = buildPlan({ ledger, deck, config, revision, briefApproved: true });
    expect(plan.items.map(i => i.finding)).toEqual(['REV-001']);
    expect(plan.deferred).toEqual([expect.objectContaining({ finding: 'REV-002', reason: expect.stringContaining('S003, S004') }), expect.objectContaining({ finding: 'REV-003', reason: expect.stringContaining('S001') })]);
    ledger.settings.revision_scope.allowed_change_classes = ['layout'];
    plan = buildPlan({ ledger, deck, config, revision, briefApproved: true });
    expect(plan.items).toEqual([]);
    expect(plan.deferred.every(d => d.reason.includes('change class'))).toBe(true);
    expect(workflowStatus(ledger, deck)).toMatchObject({ can_revise: false, ready_for_builder: [], reasons: expect.arrayContaining(['revision-restricted']) });
  });

  test('autonomous mode refuses meaning changes even when accepted; assistance still permits creator decisions', () => {
    const deck = fixture();
    let ledger = mergeSubmission(emptyLedger(), submission([finding({ changes_scientific_meaning: true,
      category: 'visual-design', proposed_change: { type: 'layout', layout: 'comparison' } })]), context(deck)).ledger;
    ledger.settings.workflow = 'autonomous'; ledger.settings.autonomous_classes = ['layout'];
    expect(buildPlan({ ledger, deck, config, revision, briefApproved: true }).deferred[0].reason).toContain('scientific meaning');
    ledger = decide(ledger, ['REV-001'], 'accept', 'Test Creator', deck);
    expect(buildPlan({ ledger, deck, config, revision, briefApproved: true }).items).toEqual([]);
    ledger.settings.workflow = 'assisted';
    expect(buildPlan({ ledger, deck, config, revision, briefApproved: true }).items[0].status).toBe('ready');
  });
});

describe('scientific integrity', () => {
  test('suggested wording cannot introduce numbers or DOIs absent from the slide and its sources', () => {
    expect(unsupportedTokens('42% more time (n = 12, p = 0.03)', source)).toEqual([]);
    expect(unsupportedTokens('In 24 mice, see 10.1234/fake.5', source)).toEqual(['24', '10.1234/fake.5']);
    expect(reject(emptyLedger(), submission([finding({ proposed_change: { type: 'wording', target: 'title', suggested_text: 'Compound Z halves anxiety in 24 mice' } })]))).toContain('24');
    const supported = mergeSubmission(emptyLedger(), submission([finding({ proposed_change: { type: 'wording', target: 'message', suggested_text: 'Treated mice (n = 12) spent 42% more time in open arms; treatment was not randomized' } })]), context(fixture()));
    expect(supported.result.created).toHaveLength(1);
  });

  test('a missing result is requested, never filled in', () => {
    const missing = finding({ basis: 'open-question', title: 'No effect size or interval', proposed_change: { type: 'wording', target: 'message', suggested_text: null },
      recommendation: 'Ask the creator for the effect size and confidence interval; do not estimate them.' });
    const { ledger } = mergeSubmission(emptyLedger(), submission([missing]), context(fixture()));
    const accepted = decide(ledger, ['REV-001'], 'accept', 'Test Creator', fixture());
    const plan = buildPlan({ ledger: accepted, deck: fixture(), config, revision, briefApproved: true });
    expect(plan.items).toEqual([]);
    expect(plan.deferred[0].reason).toContain('has no wording');
    // A builder draft that invents a value is refused.
    const draft = { kind: 'builder', version: 1, agent: { role: 'builder', name: 'Test builder' }, context_revision: revision };
    expect(reject(accepted, { ...draft, drafts: [{ finding: 'REV-001', suggested_text: 'Effect size d = 0.8', note: 'estimated' }] })).toContain('0.8');
    const drafted = mergeSubmission(accepted, { ...draft, drafts: [{ finding: 'REV-001', suggested_text: 'Treated mice (n = 12) spent 42% more time in open arms', note: 'From SRC1 Results' }] }, context(fixture()));
    // Builder-drafted wording goes back to the creator.
    expect(drafted.ledger.findings[0]).toMatchObject({ status: 'proposed', decision: undefined });
  });

  test('conceptual content cannot be reclassified as evidence without a source', () => {
    expect(reject(emptyLedger(), submission([finding({ slide_ids: ['S005'], category: 'evidence-provenance', title: 'Upgrade', evidence: { status: 'not-applicable' }, inspected: ['source-yaml'],
      proposed_change: { type: 'evidence-class', evidence: 'established' } })]))).toContain('unsourced content as evidence');
  });

  test('unsupported causal wording is surfaced as a prompt, and a sound slide may need no change', () => {
    const deck = fixture();
    const prompts = heuristicPrompts(deck, config);
    expect(prompts.filter(p => p.code === 'causal-language').map(p => p.slide)).toEqual(['S002']);
    expect(prompts.some(p => p.code === 'claim-unlinked' && p.slide === 'S003')).toBe(true);
    const french = heuristicPrompts(deck, { ...config, source_locale: 'fr-FR' });
    expect(french.find(p => p.code === 'causal-language')?.message).toContain('réduit');
    const cures = structuredClone(deck);
    cures.slides[4].content['en-US'].title = 'Exercise cures anxiety';
    expect(heuristicPrompts(cures, config).filter(p => p.code === 'causal-language').map(p => p.slide)).toEqual(['S002', 'S005']);
    const { ledger } = mergeSubmission(emptyLedger(), submission([finding()], { slide_assessments: [{ slide: 'S003', verdict: 'no-change-needed', note: 'Descriptive and sourced.' }] }), context(deck));
    expect(ledger.slide_assessments.S003).toMatchObject({ verdict: 'no-change-needed' });
    expect(reviewMarkdown(ledger, deck, config)).toContain('no-change-needed: Descriptive and sourced.');
    expect(reject(emptyLedger(), submission([finding()], { slide_assessments: [{ slide: 'S002', verdict: 'no-change-needed' }] }))).toContain('no-change-needed');
  });

  test('the review page never presents a finding as verified', () => {
    const { ledger } = mergeSubmission(emptyLedger(), submission([finding()]), context(fixture()));
    const page = reviewMarkdown(ledger, fixture(), config);
    expect(page).toContain('support is not independently verified');
    expect(page).toContain('**REV-001 · proposed**');
    expect(reviewThreads(ledger, fixture(), config)[0]).toMatchObject({ quote: 'REV-001 · proposed', replacement: 'REV-001 · accepted' });
  });
});

describe('deduplication and loops', () => {
  test('repeated findings merge, rejected ones are suppressed, and reappearing resolved ones reopen', () => {
    const deck = fixture();
    let { ledger } = mergeSubmission(emptyLedger(), submission([finding()]), context(deck));
    const repeat = mergeSubmission(ledger, submission([finding({ observation: 'Same issue, phrased differently.' })]), context(deck));
    expect(repeat.result).toMatchObject({ created: [], updated: ['REV-001'] });
    ledger = decide(repeat.ledger, ['REV-001'], 'reject', 'Test Creator', deck);
    const suppressed = mergeSubmission(ledger, submission([finding()]), context(deck));
    expect(suppressed.result.suppressed).toEqual([expect.objectContaining({ matches: 'REV-001' })]);
    expect(suppressed.ledger.findings).toHaveLength(1);
    const reopened = mergeSubmission(ledger, submission([finding({ reopen_reason: 'The creator added a randomized replication.' })]), context(deck));
    expect(reopened.result.reopened).toEqual(['REV-001']);
    expect(reject(ledger, submission([finding({ id: 'REV-001' })]))).toContain('reopen_reason');
  });

  test('two failed re-reviews stall a finding instead of looping', () => {
    const deck = fixture();
    let { ledger } = mergeSubmission(emptyLedger(), submission([finding()]), context(deck));
    ledger = decide(ledger, ['REV-001'], 'accept', 'Test Creator', deck);
    const verify = (outcome: string) => submission([], { verifications: [{ finding: 'REV-001', outcome, note: 'Checked the new title against SRC1.', inspected: ['source-yaml'] }] });
    for (const expected of ['unresolved', 'stalled']) {
      ledger.findings[0].status = 'applied';
      ledger = mergeSubmission(ledger, verify('unresolved'), context(deck)).ledger;
      expect(ledger.findings[0].status).toBe(expected);
    }
    expect(workflowStatus(ledger)).toMatchObject({ stalled: ['REV-001'], stop: true });
    expect(workflowStatus(ledger).reasons).toContain('stalled');
  });

  test('visual findings are resolved only after viewing a render', () => {
    const deck = fixture();
    const visual = finding({ category: 'visual-design', basis: 'design-preference', evidence: { status: 'not-applicable' }, inspected: ['geometry-report'], title: 'Message too low', proposed_change: { type: 'object-geometry', object: 'message', override: { y: 3 } } });
    const ledger = mergeSubmission(emptyLedger(), submission([visual]), context(deck)).ledger;
    ledger.findings[0].status = 'applied';
    expect(reject(ledger, submission([], { verifications: [{ finding: 'REV-001', outcome: 'resolved', note: 'Geometry looks fine.', inspected: ['geometry-report'] }] }))).toContain('only after viewing a current render');
  });
});

describe('decisions and planning', () => {
  const base = () => {
    const deck = fixture();
    const findings = [finding(),
      finding({ slide_ids: ['S004'], title: 'Conclusion omits the population', proposed_change: { type: 'wording', target: 'title', suggested_text: 'In treated mice, Compound Z is associated with more open-arm time' } }),
      finding({ slide_ids: ['S005'], category: 'evidence-provenance', title: 'Mechanism slide must read as a hypothesis', evidence: { status: 'not-applicable' }, inspected: ['source-yaml'], proposed_change: { type: 'evidence-class', evidence: 'hypothesis' } }),
      finding({ slide_ids: ['S002'], category: 'visual-design', basis: 'evidence-based-concern', severity: 'minor', evidence: { status: 'not-applicable' }, inspected: ['geometry-report'], title: 'Message overlaps footer', proposed_change: { type: 'object-geometry', object: 'message', override: { y: 3 } } }),
      finding({ slide_ids: ['S003'], title: 'Add the baseline table', proposed_change: { type: 'manual', description: 'Add the baseline table from the source.' } })];
    return { deck, ledger: mergeSubmission(emptyLedger(), submission(findings), context(deck)).ledger };
  };

  test('accepted findings become ready items; protected, stale and conflicting ones are blocked', () => {
    const { deck, ledger } = base();
    expect(() => decide(ledger, ['REV-001'], 'accept', 'Test Creator', deck, { authorize: ['S002'] })).toThrow('not approved or locked');
    expect(() => decide(ledger, ['REV-001'], 'request-alternative', 'Test Creator', deck)).toThrow('alternative');
    let decided = decide(ledger, ['REV-001', 'REV-002', 'REV-003', 'REV-005'], 'accept', 'Test Creator', deck);
    let plan = buildPlan({ ledger: decided, deck, config, revision, briefApproved: true });
    expect(plan.items.find(i => i.finding === 'REV-001')).toMatchObject({ status: 'ready', translation_review: ['fr-FR'], approval: 'creator-accepted' });
    expect(plan.items.find(i => i.finding === 'REV-002')).toMatchObject({ status: 'blocked', authorization: 'missing', protected_slides: ['S004'] });
    expect(plan.items.map(i => i.finding)).toEqual(['REV-003', 'REV-001', 'REV-002']);
    expect(plan.deferred.map(d => d.finding)).toEqual(['REV-005']);
    expect(plan.items.some(i => i.finding === 'REV-004')).toBe(false);

    decided = decide(decided, ['REV-002'], 'accept', 'Test Creator', deck, { authorize: ['S004'] });
    expect(buildPlan({ ledger: decided, deck, config, revision, briefApproved: true }).items.find(i => i.finding === 'REV-002')).toMatchObject({ status: 'ready', authorization: 'recorded' });

    // The creator edited S002 after deciding: the old decision must not overwrite it.
    const edited = structuredClone(deck);
    edited.slides[1].content['en-US'].message = 'Edited by the creator';
    plan = buildPlan({ ledger: decided, deck: edited, config, revision, briefApproved: true });
    expect(plan.items.find(i => i.finding === 'REV-001')).toMatchObject({ status: 'blocked' });
    expect(plan.items.find(i => i.finding === 'REV-001')?.reason).toContain('changed after');
  });

  test('conflicting changes to one target are both blocked', () => {
    const deck = fixture();
    const { ledger } = mergeSubmission(emptyLedger(), submission([finding(),
      finding({ perspective: 'reviewer-3', category: 'editorial-clarity', title: 'Shorter title', proposed_change: { type: 'wording', target: 'title', suggested_text: 'Compound Z and open-arm time' } })]), context(deck));
    const plan = buildPlan({ ledger: decide(ledger, ['REV-001', 'REV-002'], 'accept', 'Test Creator', deck), deck, config, revision, briefApproved: true });
    expect(plan.items.every(i => i.status === 'blocked' && i.reason.includes('Conflicts'))).toBe(true);
  });

  test('mode, brief and iteration limits fail closed', () => {
    const { deck, ledger } = base();
    expect(() => buildPlan({ ledger, deck, config, revision, briefApproved: false })).toThrow('brief is not approved');
    expect(() => buildPlan({ ledger: { ...ledger, settings: { ...ledger.settings, workflow: 'review-only' } }, deck, config, revision, briefApproved: true })).toThrow('review-only');
    expect(() => buildPlan({ ledger: { ...ledger, revision_rounds: 2 }, deck, config, revision, briefApproved: true })).toThrow('Iteration limit');
  });

  test('autonomous mode applies only opted-in, non-scientific changes to draft slides', () => {
    const { deck, ledger } = base();
    const assisted = buildPlan({ ledger, deck, config, revision, briefApproved: true });
    expect(assisted.items).toEqual([]);
    const opted = { ...ledger, settings: { ...ledger.settings, workflow: 'autonomous' as const, autonomous_classes: ['object-geometry' as const] } };
    const plan = buildPlan({ ledger: opted, deck, config, revision, briefApproved: true });
    expect(plan.items.map(i => [i.finding, i.approval])).toEqual([['REV-004', 'autonomous-policy']]);
    expect(workflowStatus(opted, deck)).toMatchObject({ can_revise: true, ready_for_builder: ['REV-004'] });
  });
});

// End-to-end through the real CLI, with real PPTX builds, on a disposable copy of the fictional demo.
const exec = promisify(execFile), repo = process.cwd();
let sandbox = '';
async function cli(...args: string[]) {
  try { const r = await exec(process.execPath, ['--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href, path.join(repo, 'src/cli/index.ts'), ...args], { cwd: sandbox, timeout: 120000 }); return { code: 0, output: r.stdout + r.stderr }; }
  catch (e) { const r = e as { code: number; stdout: string; stderr: string }; return { code: r.code, output: r.stdout + r.stderr }; }
}
const json = (output: string) => JSON.parse(output.slice(output.indexOf('{')));
describe('review command', () => {
  const base = () => path.join(sandbox, 'projects/demo');
  const read = async (file: string) => YAML.parse(await fs.readFile(path.join(base(), file), 'utf8'));
  async function submitFile(body: unknown) {
    await fs.writeFile(path.join(base(), 'review/submission.yaml'), YAML.stringify(body));
    return cli('review', '--project', 'demo', '--mode', 'submit');
  }
  beforeAll(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'pptimistic-review-'));
    await fs.cp(path.join(repo, 'config'), path.join(sandbox, 'config'), { recursive: true });
    expect((await cli('demo', '--project', 'demo', '--no-render')).code).toBe(0);
  }, 120000);
  afterAll(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

  test('report → creator decision → guarded revision → validation → re-review', async () => {
    const prepared = await cli('review', '--project', 'demo', '--mode', 'prepare');
    expect(prepared.code).toBe(0);
    const { revision: rev, previews } = json(prepared.output);
    expect(previews.current).toBe(false);
    const ctx = JSON.parse(await fs.readFile(path.join(base(), 'review/context.json'), 'utf8'));
    expect(ctx.slides.map((s: { id: string }) => s.id)).toEqual(['S001', 'S002', 'S003', 'S004', 'S005']);
    const slidesBefore = await read('content/slides.yaml');
    const common = { changes_scientific_meaning: false, severity: 'minor', confidence: 'medium', evidence: { status: 'not-applicable' }, inspected: ['source-yaml'], acceptance_criteria: ['The title states the process as a claim.'] };
    const sent = await submitFile({ kind: 'review', version: 1, agent: { role: 'reviewer', name: 'Test reviewer' }, context_revision: rev,
      assessment: { summary: 'Fictional demo deck; reviewed for structure only.', central_message_as_understood: 'Evidence-first slides.', audience_fit: 'General.' },
      findings: [
        { ...common, category: 'editorial-clarity', basis: 'editorial-judgment', slide_ids: ['S003'], title: 'Topic-label title', observation: 'Reads as a topic.', rationale: 'A statement title carries the argument.', recommendation: 'State the process as a claim.',
          proposed_change: { type: 'wording', target: 'title', suggested_text: 'Sources become a shared understanding through review' } },
        { ...common, category: 'editorial-clarity', basis: 'design-preference', slide_ids: ['S001'], title: 'Longer opening title', observation: 'Short.', rationale: 'Preference.', recommendation: 'Lengthen.',
          proposed_change: { type: 'wording', target: 'title', suggested_text: 'PPTimistic: editable slides' } }
      ],
      slide_assessments: [{ slide: 'S004', verdict: 'no-change-needed', note: 'Fictional data are disclosed.' }],
      anticipated_questions: [{ perspective: 'data-expert', slide_ids: ['S004'], question: 'Are these real measurements?', why_likely: 'It is a chart.', difficulty: 'easy', answer_basis: 'creator-must-supply' }] });
    expect(sent.code).toBe(0);
    expect(json(sent.output).created).toEqual(['REV-001', 'REV-002']);

    const page = await cli('review', '--project', 'demo', '--mode', 'report');
    expect(json(page.output).threads.map((t: { quote: string }) => t.quote)).toEqual(['REV-001 · proposed', 'REV-002 · proposed']);
    expect(await fs.readFile(path.join(base(), 'review/review.md'), 'utf8')).toContain('Are these real measurements?');

    expect((await cli('review', '--project', 'demo', '--mode', 'decide', '--finding', 'REV-001', '--decision', 'accept', '--by', 'Test Creator')).code).toBe(0);
    expect((await cli('review', '--project', 'demo', '--mode', 'decide', '--finding', 'REV-002', '--decision', 'reject', '--by', 'Test Creator')).code).toBe(0);
    const planned = await cli('review', '--project', 'demo', '--mode', 'plan');
    expect(json(planned.output)).toMatchObject({ ready: ['REV-001'], translation_review: ['fr-FR'] });

    const applied = await cli('review', '--project', 'demo', '--mode', 'apply', '--no-render');
    expect(applied.code).toBe(0);
    const result = json(applied.output);
    expect(result).toMatchObject({ applied: ['REV-001'], changed_slides: ['S003'], translation_review_required: { 'fr-FR': ['S003'] }, validation_errors: [] });
    const after = await read('content/slides.yaml');
    expect(after.slides[2].content['en-US'].title).toBe('Sources become a shared understanding through review');
    // The rejected finding and every other slide are untouched; the accepted image is retained.
    expect(after.slides[0]).toEqual(slidesBefore.slides[0]);
    expect(after.slides.filter((_: unknown, i: number) => i !== 2)).toEqual(slidesBefore.slides.filter((_: unknown, i: number) => i !== 2));
    const manifest = YAML.parse(await fs.readFile(result.manifest, 'utf8'));
    expect(manifest).toMatchObject({ outcome: 'applied', changed_slides: ['S003'], retained_assets: [expect.objectContaining({ slide: 'S002', preserved: true })], render: { requested: false } });
    expect(manifest.changes[0]).toMatchObject({ finding: 'REV-001', before: 'From sources to a shared understanding', after: 'Sources become a shared understanding through review' });
    expect(manifest.validation.errors.some((e: { code: string; locale: string }) => e.code === 'translation-stale' && e.locale === 'fr-FR')).toBe(true);
    // Deliberately add builder justification in every formerly exposed path.
    const anchoring = 'BUILDER-JUSTIFICATION-MUST-NOT-REACH-CRITIC';
    const privateLedger = await read('review/ledger.yaml');
    privateLedger.findings[0].builder = { outcome: 'implemented-manually', note: anchoring, at: new Date().toISOString() };
    privateLedger.findings[0].decision.note = anchoring;
    await fs.writeFile(path.join(base(), 'review/ledger.yaml'), YAML.stringify(privateLedger));
    manifest.justification = anchoring; manifest.changes[0].builder_note = anchoring;
    await fs.writeFile(result.manifest, YAML.stringify(manifest));
    const validate = await cli('validate', '--project', 'demo', '--source-only');
    expect(validate.output).toContain('translation-stale');

    const verified = await cli('review', '--project', 'demo', '--mode', 'verify');
    const v = json(verified.output);
    expect(v.to_verify).toEqual(['REV-001']);
    expect(v.changes).toEqual([expect.objectContaining({ finding: 'REV-001', present: true })]);
    // fr-FR was not rebuilt: its PPTX still matches its own (now stale) translation, which validation reports.
    expect(v.artifacts).toEqual([{ locale: 'en-US', status: 'current' }, { locale: 'fr-FR', status: 'current' }]);
    expect(manifest.build.locales_not_built).toEqual([expect.objectContaining({ locale: 'fr-FR' })]);
    const reviewContext = JSON.parse(await fs.readFile(path.join(base(), 'review/context.json'), 'utf8'));
    expect(JSON.stringify(reviewContext)).not.toContain(anchoring);
    expect(reviewContext.to_verify[0].original_slides[0].content['en-US'].title).toBe('From sources to a shared understanding');
    expect(reviewContext.to_verify[0]).not.toHaveProperty('manifest');
    const newRev = reviewContext.revision;
    const reReview = await submitFile({ kind: 'review', version: 1, agent: { role: 'reviewer', name: 'Independent re-review' }, context_revision: newRev,
      verifications: [{ finding: 'REV-001', outcome: 'resolved', note: 'The new title is a statement and keeps the conceptual framing.', inspected: ['source-yaml'] }] });
    expect(reReview.code).toBe(0);
    const ledger = await read('review/ledger.yaml');
    expect(ledger.findings.map((f: { id: string; status: string }) => [f.id, f.status])).toEqual([['REV-001', 'resolved'], ['REV-002', 'rejected']]);
    expect(json((await cli('review', '--project', 'demo', '--mode', 'status')).output)).toMatchObject({ stop: true, reasons: expect.arrayContaining(['no-actionable-high-priority']) });
  });

  test('protected slides, stale plans, failed builds, active sessions and round limits all leave the source unchanged', async () => {
    const slidesFile = path.join(base(), 'content/slides.yaml');
    const slides = await read('content/slides.yaml');
    slides.slides[4].status = 'approved';
    await fs.writeFile(slidesFile, YAML.stringify(slides));
    // Rebuild so the approved state becomes the protection baseline (translations stay stale: build en-US).
    expect((await cli('build', '--project', 'demo', '--locale', 'en-US')).code).toBe(0);
    const rev = json((await cli('review', '--project', 'demo', '--mode', 'prepare')).output).revision;
    const common = { changes_scientific_meaning: false, confidence: 'high', evidence: { status: 'not-applicable' }, inspected: ['geometry-report'], acceptance_criteria: ['Done.'], rationale: 'Test.', recommendation: 'Test.', observation: 'Test.' };
    expect((await submitFile({ kind: 'review', version: 1, agent: { role: 'reviewer', name: 'Test reviewer' }, context_revision: rev, findings: [
      { ...common, category: 'editorial-clarity', severity: 'major', basis: 'editorial-judgment', slide_ids: ['S005'], title: 'Locked conclusion wording', inspected: ['source-yaml'], proposed_change: { type: 'wording', target: 'message', suggested_text: 'Build a clear, traceable story.' } },
      { ...common, category: 'visual-design', severity: 'major', basis: 'evidence-based-concern', slide_ids: ['S002'], title: 'Move the title off-slide', proposed_change: { type: 'object-geometry', object: 'title', override: { x: 20 } } }
    ] })).code).toBe(0);
    expect((await cli('review', '--project', 'demo', '--mode', 'decide', '--finding', 'REV-003,REV-004', '--decision', 'accept', '--by', 'Test Creator')).code).toBe(0);
    const plan = json((await cli('review', '--project', 'demo', '--mode', 'plan')).output);
    expect(plan.ready).toEqual(['REV-004']);
    expect(plan.blocked).toEqual([expect.objectContaining({ finding: 'REV-003', reason: expect.stringContaining('--authorize S005') })]);

    // An active shared session owns the project: the builder must not race it.
    await fs.mkdir(path.join(base(), '.session'), { recursive: true });
    await fs.writeFile(path.join(base(), '.session/server.lock'), JSON.stringify({ pid: process.pid }));
    const raced = await cli('review', '--project', 'demo', '--mode', 'apply', '--no-render');
    expect(raced.code).toBe(1);
    expect(raced.output).toContain('active shared session');
    await fs.rm(path.join(base(), '.session'), { recursive: true, force: true });

    // The geometry change fails layout validation: the error propagates and the source is restored.
    const before = await fs.readFile(slidesFile, 'utf8');
    const failed = await cli('review', '--project', 'demo', '--mode', 'apply', '--no-render');
    expect(failed.code).toBe(1);
    expect(failed.output).toContain('rolled back');
    expect(failed.output).toContain('outside slide boundaries');
    expect(await fs.readFile(slidesFile, 'utf8')).toBe(before);
    const ledger = await read('review/ledger.yaml');
    expect(ledger.findings.find((f: { id: string }) => f.id === 'REV-004')).toMatchObject({ status: 'accepted', last_error: expect.stringContaining('outside slide boundaries') });
    expect(ledger.history.some((h: { event: string }) => h.event === 'revision-rolled-back')).toBe(true);

    // A plan made before a creator edit cannot overwrite it.
    expect((await cli('review', '--project', 'demo', '--mode', 'decide', '--finding', 'REV-004', '--decision', 'reject', '--by', 'Test Creator')).code).toBe(0);
    expect((await cli('review', '--project', 'demo', '--mode', 'decide', '--finding', 'REV-003', '--decision', 'accept', '--by', 'Test Creator', '--authorize', 'S005')).code).toBe(0);
    expect(json((await cli('review', '--project', 'demo', '--mode', 'plan')).output).ready).toEqual(['REV-003']);
    const edited = await read('content/slides.yaml');
    edited.slides[4].content['en-US'].message = 'Edited by the creator after planning.';
    await fs.writeFile(slidesFile, YAML.stringify(edited));
    const stale = await cli('review', '--project', 'demo', '--mode', 'apply', '--no-render');
    expect(stale.code).toBe(1);
    expect(stale.output).toContain('newer edits are never overwritten');
    expect((await read('content/slides.yaml')).slides[4].content['en-US'].message).toBe('Edited by the creator after planning.');

    // Round limits: with max_rounds 1 already used by the first test, planning stops.
    expect((await cli('review', '--project', 'demo', '--mode', 'configure', '--max-rounds', '1', '--by', 'Test Creator')).code).toBe(0);
    const limited = await cli('review', '--project', 'demo', '--mode', 'plan');
    expect(limited.code).toBe(1);
    expect(limited.output).toContain('Iteration limit');
    const autonomous = await cli('review', '--project', 'demo', '--mode', 'configure', '--workflow', 'autonomous', '--allow-classes', 'layout', '--by', 'An agent');
    expect(autonomous.code).toBe(1);
    expect(autonomous.output).toContain('interactive terminal');
  });

  test('a real project without an approved brief can be reviewed but not revised', async () => {
    expect((await cli('new', '--project', 'gated', '--yes', '--no-render')).code).toBe(0);
    const rev = json((await cli('review', '--project', 'gated', '--mode', 'prepare')).output);
    expect(rev.brief_approved).toBe(false);
    await fs.writeFile(path.join(sandbox, 'projects/gated/review/submission.yaml'), YAML.stringify({ kind: 'review', version: 1, agent: { role: 'reviewer', name: 'Test reviewer' }, context_revision: rev.revision,
      findings: [{ changes_scientific_meaning: false, category: 'editorial-clarity', severity: 'minor', basis: 'editorial-judgment', confidence: 'low', slide_ids: ['S001'], title: 'Scaffold title', observation: 'Placeholder content.', evidence: { status: 'not-applicable' }, inspected: ['source-yaml'],
        rationale: 'The deck is a placeholder.', recommendation: 'Author from sources.', proposed_change: { type: 'layout', layout: 'statement' }, acceptance_criteria: ['Authored.'] }] }));
    expect((await cli('review', '--project', 'gated', '--mode', 'submit')).code).toBe(0);
    expect((await cli('review', '--project', 'gated', '--mode', 'decide', '--finding', 'REV-001', '--decision', 'accept', '--by', 'Test Creator')).code).toBe(0);
    const planned = await cli('review', '--project', 'gated', '--mode', 'plan');
    expect(planned.code).toBe(1);
    expect(planned.output).toContain('brief is not approved');
  });

  test('preservation rollback includes every changed slide; changing scope after planning refuses apply', async () => {
    const name = 'contract-fixture';
    expect((await cli('demo', '--project', name, '--no-render')).code).toBe(0);
    const dir = path.join(sandbox, 'projects', name), sourceFile = path.join(dir, 'content/slides.yaml');
    const slides = YAML.parse(await fs.readFile(sourceFile, 'utf8'));
    slides.slides[2].content['en-US'].body = 'NONE is a legitimate outcome';
    await fs.writeFile(sourceFile, YAML.stringify(slides));
    await fs.writeFile(path.join(dir, 'content/storyline.yaml'), YAML.stringify({ version: 1, slides: { S003: { explanatory_contract: explanatoryContract() } } }));
    expect((await cli('build', '--project', name, '--locale', 'en-US')).code).toBe(0);
    const before = await fs.readFile(sourceFile), pptxFile = path.join(dir, 'output/presentation.en-US.pptx'), pptxBefore = await fs.readFile(pptxFile);
    const rev = json((await cli('review', '--project', name, '--mode', 'prepare')).output).revision;
    await fs.writeFile(path.join(dir, 'review/submission.yaml'), YAML.stringify(submission([
      finding({ category: 'editorial-clarity', evidence: { status: 'not-applicable' }, inspected: ['source-yaml'], slide_ids: ['S001'], title: 'Opening', proposed_change: { type: 'wording', target: 'title', suggested_text: 'Editable scientific communication' } }),
      finding({ category: 'editorial-clarity', evidence: { status: 'not-applicable' }, inspected: ['source-yaml'], slide_ids: ['S003'], title: 'Remove caveat', proposed_change: { type: 'wording', target: 'body', suggested_text: 'Every review yields a finding.' } })
    ], { context_revision: rev })));
    expect((await cli('review', '--project', name, '--mode', 'submit')).code).toBe(0);
    const recorded = YAML.parse(await fs.readFile(path.join(dir, 'review/ledger.yaml'), 'utf8'));
    expect(recorded.findings[1].acceptance_criteria).toContain('The audience can explain why NONE is legitimate.');
    expect((await cli('review', '--project', name, '--mode', 'decide', '--finding', 'REV-001,REV-002', '--decision', 'accept', '--by', 'Test Creator')).code).toBe(0);
    expect((await cli('review', '--project', name, '--mode', 'plan')).code).toBe(0);
    const failed = await cli('review', '--project', name, '--mode', 'apply', '--no-render');
    expect(failed.code).toBe(1); expect(failed.output).toContain('rolled back'); expect(failed.output).toContain('must preserve');
    expect(await fs.readFile(sourceFile)).toEqual(before); expect(await fs.readFile(pptxFile)).toEqual(pptxBefore);

    expect((await cli('review', '--project', name, '--mode', 'decide', '--finding', 'REV-002', '--decision', 'reject', '--by', 'Test Creator')).code).toBe(0);
    expect((await cli('review', '--project', name, '--mode', 'plan')).code).toBe(0);
    expect((await cli('review', '--project', name, '--mode', 'configure', '--scope-slides', 'S003', '--scope-classes', 'wording,layout', '--by', 'Test Creator')).code).toBe(0);
    const scoped = await cli('review', '--project', name, '--mode', 'apply', '--no-render');
    expect(scoped.code).toBe(1); expect(scoped.output).toContain('scope excludes affected slides S001');
    expect(await fs.readFile(sourceFile)).toEqual(before);

    // A layout that leaves the text in YAML but removes its native object also rolls back.
    const revision2 = json((await cli('review', '--project', name, '--mode', 'prepare')).output).revision;
    await fs.writeFile(path.join(dir, 'review/submission.yaml'), YAML.stringify(submission([
      finding({ category: 'visual-design', evidence: { status: 'not-applicable' }, inspected: ['source-yaml'], slide_ids: ['S003'], title: 'Use full image', proposed_change: { type: 'layout', layout: 'full-image' } })
    ], { context_revision: revision2 })));
    expect((await cli('review', '--project', name, '--mode', 'submit')).code).toBe(0);
    expect((await cli('review', '--project', name, '--mode', 'decide', '--finding', 'REV-003', '--decision', 'accept', '--by', 'Test Creator')).code).toBe(0);
    expect(json((await cli('review', '--project', name, '--mode', 'plan')).output).ready).toEqual(['REV-003']);
    const hidden = await cli('review', '--project', name, '--mode', 'apply', '--no-render');
    expect(hidden.code).toBe(1); expect(hidden.output).toContain('layout omits it');
    expect(await fs.readFile(sourceFile)).toEqual(before);
  }, 120000);

  test('a layout replacing an animated object rolls back source and keeps the actual PPTX', async () => {
    const name = 'animation-review';
    expect((await cli('demo', '--project', name, '--no-render')).code).toBe(0);
    const dir = path.join(sandbox, 'projects', name), sourceFile = path.join(dir, 'content/slides.yaml');
    const slides = YAML.parse(await fs.readFile(sourceFile, 'utf8'));
    slides.slides[2].animations = { steps: [{ targets: ['node-0'] }] };
    await fs.writeFile(sourceFile, YAML.stringify(slides));
    expect((await cli('build', '--project', name, '--locale', 'en-US')).code).toBe(0);
    const before = await fs.readFile(sourceFile), pptxFile = path.join(dir, 'output/presentation.en-US.pptx'), pptxBefore = await fs.readFile(pptxFile);
    const rev = json((await cli('review', '--project', name, '--mode', 'prepare')).output).revision;
    await fs.writeFile(path.join(dir, 'review/submission.yaml'), YAML.stringify(submission([
      finding({ category: 'visual-design', evidence: { status: 'not-applicable' }, inspected: ['source-yaml'], slide_ids: ['S003'], title: 'Replace workflow', proposed_change: { type: 'layout', layout: 'statement' } })
    ], { context_revision: rev })));
    expect((await cli('review', '--project', name, '--mode', 'submit')).code).toBe(0);
    expect((await cli('review', '--project', name, '--mode', 'decide', '--finding', 'REV-001', '--decision', 'accept', '--by', 'Test Creator')).code).toBe(0);
    expect((await cli('review', '--project', name, '--mode', 'plan')).code).toBe(0);
    const failed = await cli('review', '--project', name, '--mode', 'apply', '--no-render');
    expect(failed.code).toBe(1); expect(failed.output).toContain('rolled back'); expect(failed.output).toContain('node-0');
    expect(await fs.readFile(sourceFile)).toEqual(before); expect(await fs.readFile(pptxFile)).toEqual(pptxBefore);
  }, 120000);

  test('prepare flags externally edited PPTX bytes and a delivered slide-count mismatch without overwriting', async () => {
    const name = 'external-review';
    expect((await cli('demo', '--project', name, '--no-render')).code).toBe(0);
    const dir = path.join(sandbox, 'projects', name), file = path.join(dir, 'output/presentation.en-US.pptx');
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const xml = await zip.file('ppt/presentation.xml')!.async('string');
    zip.file('ppt/presentation.xml', xml.replace(/<p:sldId\b[^>]*\/>/, ''));
    const modified = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(file, modified);
    const prepared = await cli('review', '--project', name, '--mode', 'prepare');
    expect(prepared.code).toBe(0);
    const result = json(prepared.output);
    expect(result.source_authority).toMatchObject({ authoritative: false, yaml_slide_count: 5 });
    expect(result.source_authority.issues.map((i: { code: string }) => i.code)).toEqual(['modified-output', 'pptx-slide-count-mismatch']);
    expect(result.source_authority.outputs[0].slide_count).toBe(4);
    await fs.writeFile(path.join(dir, 'review/submission.yaml'), YAML.stringify(submission([], { context_revision: result.revision })));
    const blocked = await cli('review', '--project', name, '--mode', 'submit');
    expect(blocked.code).toBe(1); expect(blocked.output).toContain('Scientific review blocked');
    expect(await fs.readFile(file)).toEqual(modified);
  }, 120000);
});
