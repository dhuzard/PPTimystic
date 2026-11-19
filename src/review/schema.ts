import { z } from 'zod';
import { layouts, visualObjectOverrideSchema } from '../core/model.js';
import { structureChangeSchema } from '../story/review.js';

// The scientific-review contract. Reviewer and builder agents exchange these structured
// artifacts through the deterministic `review` command; they never talk to each other in
// free prose. Nothing in a finding is a verified fact: severity, basis and evidence status
// record the reviewer's claim and how it was formed, not an independent verification.

export const reviewDir = 'review';
export const ledgerPath = 'review/ledger.yaml';
export const contextPath = 'review/context.json';
export const planPath = 'review/plan.yaml';
export const reportPath = 'review/review.md';
export const manifestDir = 'review/manifests';

const slideId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
// Layout roles (title, message, node-2, chart…) or persisted custom objects.
const objectId = z.string().regex(/^(?:[A-Za-z][A-Za-z0-9_-]*|object-[0-9a-f-]{36})$/);
const text = (max = 2000) => z.string().trim().min(1).max(max);
const findingId = z.string().regex(/^REV-\d{3,}$/);
const questionId = z.string().regex(/^Q-\d{3,}$/);

export const categories = ['scientific-validity', 'evidence-provenance', 'narrative-structure', 'visual-design', 'accessibility',
  'audience-suitability', 'pacing', 'editorial-clarity', 'technical-quality'] as const;
export const severities = ['critical', 'major', 'minor', 'optional'] as const;
/** How the finding was formed. Independent of severity: a critical finding can still be an open question. */
export const bases = ['verified-error', 'evidence-based-concern', 'editorial-judgment', 'design-preference', 'open-question'] as const;
export const confidences = ['high', 'medium', 'low'] as const;
/**
 * What the reviewer did with the evidence. There is deliberately no "verified" value:
 * reading a source passage, matching a citation string or checking a hash never
 * establishes that the source supports the wording. A person decides that.
 */
export const evidenceStatuses = ['requires-human-verification', 'source-read-by-reviewer', 'no-source-supplied', 'not-applicable'] as const;
/** What the reviewer actually looked at. `rendered-preview` is accepted only when current previews exist. */
export const inspections = ['source-yaml', 'storyline', 'brief', 'extracted-source', 'validation-report', 'geometry-report', 'rendered-preview'] as const;
/** Review lenses (see agents/audience-panel.md). The default is the scientific presentation expert. */
export const perspectives = ['scientific-expert', 'presentation-style', 'data-expert', 'design-critic', 'science-friend', 'reviewer-3',
  'newcomer', 'decision-maker', 'field-rival', 'rigor-ethics', 'back-row'] as const;
/** A builder may block or report manual work; it can never defer or reject what the creator accepted. */
export const builderOutcomes = ['blocked-needs-evidence', 'blocked-needs-creator', 'implemented-manually'] as const;
export const wordingTargets = ['title', 'message', 'body', 'notes', 'caption', 'alt'] as const;
export const evidenceClasses = ['established', 'interpretation', 'hypothesis', 'conceptual', 'missing'] as const;

export const proposedChangeSchema = z.discriminatedUnion('type', [
  // An observation, question or "keep as is" note with no source change.
  z.object({ type: z.literal('none') }).strict(),
  // `suggested_text: null` means the creator (or builder, for creator approval) must still write the wording.
  z.object({ type: z.literal('wording'), target: z.enum(wordingTargets), locale: z.string().optional(), suggested_text: text(4000).nullable() }).strict(),
  z.object({ type: z.literal('evidence-class'), evidence: z.enum(evidenceClasses) }).strict(),
  z.object({ type: z.literal('layout'), layout: z.enum(layouts) }).strict(),
  // Position, size or style of one existing scene object (a visual_objects override).
  z.object({ type: z.literal('object-geometry'), object: objectId, override: visualObjectOverrideSchema.omit({ hidden: true }) }).strict(),
  // Narrative structure reuses the storyline change kinds (role, section, transition, throughline, framework, move).
  z.object({ type: z.literal('storyline'), change: structureChangeSchema }).strict(),
  // Anything requiring authored content, new data, charts, illustrations, animations or new slides.
  z.object({ type: z.literal('manual'), description: text() }).strict()
]);
export type ProposedChange = z.infer<typeof proposedChangeSchema>;
export const changeTypes = ['none', 'wording', 'evidence-class', 'layout', 'object-geometry', 'storyline', 'manual'] as const;

/** The part of a finding an agent writes. Bookkeeping fields are added by the CLI. */
export const findingInputSchema = z.object({
  // Reuse the ID of a finding listed in the review context to update it; omit for a new one.
  id: findingId.optional(),
  category: z.enum(categories),
  severity: z.enum(severities),
  basis: z.enum(bases),
  confidence: z.enum(confidences),
  changes_scientific_meaning: z.boolean(),
  perspective: z.enum(perspectives).default('scientific-expert'),
  slide_ids: z.array(slideId).default([]),
  object_ids: z.array(objectId).default([]),
  title: text(160),
  observation: text(),
  evidence: z.object({
    source_refs: z.array(z.string().min(1)).default([]),
    claim_ids: z.array(z.string().min(1)).default([]),
    locators: z.array(z.string().min(1)).default([]),
    validation_codes: z.array(z.string().min(1)).default([]),
    status: z.enum(evidenceStatuses)
  }).strict(),
  inspected: z.array(z.enum(inspections)).min(1),
  rationale: text(),
  recommendation: text(),
  proposed_change: proposedChangeSchema,
  expected_benefit: text(600).optional(),
  acceptance_criteria: z.array(text(400)).default([]),
  // Set when this finding is a problem introduced by an earlier revision.
  regression_of: findingId.optional(),
  // Required to raise again a finding the creator rejected or that was withdrawn.
  reopen_reason: text(600).optional()
}).strict().superRefine((f, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const c = f.proposed_change;
  if (c.type !== 'none' && !f.acceptance_criteria.length) issue('A finding that proposes a change needs at least one acceptance criterion.');
  if (['wording', 'evidence-class', 'layout', 'object-geometry'].includes(c.type) && f.slide_ids.length !== 1) issue(`${c.type} changes target exactly one slide.`);
  if (c.type === 'object-geometry' && !Object.keys(c.override).length) issue('object-geometry needs at least one position, size or style value.');
  if (c.type === 'storyline' && ['transition', 'move'].includes(c.change.kind) && f.slide_ids.length !== 1) issue(`storyline ${c.change.kind} changes target exactly one slide.`);
  if (c.type === 'storyline' && ['role', 'section'].includes(c.change.kind) && !f.slide_ids.length) issue(`storyline ${c.change.kind} changes target at least one slide.`);
  if (f.evidence.status === 'source-read-by-reviewer' && !f.evidence.source_refs.length) issue('source-read-by-reviewer requires the source_refs that were read.');
  if (f.basis === 'verified-error' && f.category === 'scientific-validity' && !f.evidence.source_refs.length && !f.evidence.validation_codes.length && !f.evidence.claim_ids.length)
    issue('A verified scientific error must cite the source, claim or validation result that demonstrates it; otherwise use evidence-based-concern or open-question.');
});
export type FindingInput = z.infer<typeof findingInputSchema>;

export const findingStatuses = ['proposed', 'discussing', 'accepted', 'rejected', 'deferred', 'blocked', 'applied', 'resolved', 'unresolved', 'stalled', 'withdrawn'] as const;
export type FindingStatus = typeof findingStatuses[number];
/** Statuses where the creator still has to decide. */
export const awaitingCreator: FindingStatus[] = ['proposed', 'discussing'];
/** Statuses the builder may act on. */
export const actionable: FindingStatus[] = ['accepted', 'unresolved'];
/** Statuses that are finished and never re-proposed without a reason. */
export const closedByCreator: FindingStatus[] = ['rejected', 'withdrawn', 'deferred'];

const fingerprintMap = z.record(slideId, z.string().regex(/^[a-f0-9]{64}$/));
const actorSchema = z.object({ role: z.enum(['reviewer', 'builder']), name: text(120), model: z.string().max(160).optional() }).strict();
export const findingRecordSchema = findingInputSchema.safeExtend({
  id: findingId,
  status: z.enum(findingStatuses),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.object({
    agent: actorSchema, round: z.number().int().min(1), reviewed_at: z.string().datetime(),
    reviewed_revision: z.string().regex(/^[a-f0-9]{64}$/),
    // Each slide as it was when reviewed. A later change makes decisions stale.
    slide_fingerprints: fingerprintMap
  }).strict(),
  decision: z.object({
    decision: z.enum(['accept', 'reject', 'defer', 'discuss', 'request-alternative']),
    by: text(160), at: z.string().datetime(), note: z.string().max(2000).optional(),
    // Recorded authority for approved/locked slides; never inferred.
    authorized_slides: z.array(slideId).default([]),
    slide_fingerprints: fingerprintMap
  }).strict().optional(),
  builder: z.object({ outcome: z.enum(builderOutcomes), note: text(), at: z.string().datetime() }).strict().optional(),
  applied: z.object({ manifest: z.string(), round: z.number().int().min(1), at: z.string().datetime() }).strict().optional(),
  resolution: z.object({ outcome: z.enum(['resolved', 'partially-resolved', 'unresolved', 'regressed']), note: text(), round: z.number().int().min(1), at: z.string().datetime() }).strict().optional(),
  unresolved_count: z.number().int().min(0).default(0),
  last_error: z.string().max(4000).optional(),
  thread: z.string().regex(/^t_[A-Za-z0-9_]+$/).optional(),
  updated_at: z.string().datetime()
}).superRefine((f, ctx) => {
  if (f.status === 'resolved' && !f.resolution) ctx.addIssue({ code: 'custom', message: `${f.id}: resolved findings need a re-review resolution.` });
});
export type FindingRecord = z.infer<typeof findingRecordSchema>;

export const questionInputSchema = z.object({
  id: questionId.optional(),
  perspective: z.enum(perspectives),
  slide_ids: z.array(slideId).default([]),
  question: text(600),
  why_likely: text(600),
  difficulty: z.enum(['easy', 'moderate', 'hard']),
  // Whether the supplied sources contain an answer. Never invent the answer itself.
  answer_basis: z.enum(['supported-by-sources', 'creator-must-supply', 'not-answerable-with-current-evidence']),
  answer_notes: z.string().max(2000).default(''),
  source_refs: z.array(z.string().min(1)).default([]),
  backup_slide_suggested: z.boolean().default(false)
}).strict();
export const questionRecordSchema = questionInputSchema.safeExtend({ id: questionId, round: z.number().int().min(1) });

export const assessmentSchema = z.object({
  summary: text(6000),
  central_message_as_understood: text(1000),
  audience_fit: text(2000),
  strengths: z.array(text(600)).default([]),
  key_risks: z.array(text(600)).default([])
}).strict();

export const slideAssessmentSchema = z.object({
  slide: slideId,
  verdict: z.enum(['no-change-needed', 'changes-proposed', 'not-reviewed']),
  note: z.string().max(1000).default('')
}).strict();

export const verificationSchema = z.object({
  finding: findingId,
  outcome: z.enum(['resolved', 'partially-resolved', 'unresolved', 'regressed']),
  note: text(),
  inspected: z.array(z.enum(inspections)).min(1)
}).strict();

export const builderOutcomeSchema = z.object({
  finding: findingId,
  outcome: z.enum(builderOutcomes),
  note: text()
}).strict();

/** One agent submission, validated and merged by `review --mode submit`. */
export const submissionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('review'), version: z.literal(1),
    agent: actorSchema.extend({ role: z.literal('reviewer') }),
    // Copied from review/context.json; rejected when the deck changed after preparation.
    context_revision: z.string().regex(/^[a-f0-9]{64}$/),
    assessment: assessmentSchema.optional(),
    rendered_previews_viewed: z.array(slideId).default([]),
    findings: z.array(findingInputSchema).default([]),
    slide_assessments: z.array(slideAssessmentSchema).default([]),
    verifications: z.array(verificationSchema).default([]),
    withdraw: z.array(findingId).default([]),
    anticipated_questions: z.array(questionInputSchema).default([])
  }).strict(),
  z.object({
    kind: z.literal('builder'), version: z.literal(1),
    agent: actorSchema.extend({ role: z.literal('builder') }),
    context_revision: z.string().regex(/^[a-f0-9]{64}$/),
    // Builder-drafted wording for a finding with `suggested_text: null`. It returns to the creator as a proposal.
    drafts: z.array(z.object({ finding: findingId, suggested_text: text(4000), note: text() }).strict()).default([]),
    outcomes: z.array(builderOutcomeSchema).default([])
  }).strict()
]);
export type Submission = z.infer<typeof submissionSchema>;

export const workflowModes = ['review-only', 'assisted', 'autonomous'] as const;
/** Change classes an explicit creator opt-in may allow without per-finding acceptance. */
export const autonomousClasses = ['object-geometry', 'layout'] as const;
export const revisionScopeSchema = z.object({
  // null means every slide; [] permits no slides. Neither is inferred from a finding.
  slide_ids: z.array(slideId).nullable(),
  allowed_change_classes: z.array(z.enum(changeTypes))
}).strict();

export const ledgerSchema = z.object({
  version: z.literal(1),
  settings: z.object({
    workflow: z.enum(workflowModes).default('assisted'),
    max_rounds: z.number().int().min(1).max(10).default(2),
    autonomous_classes: z.array(z.enum(autonomousClasses)).default([]),
    revision_scope: revisionScopeSchema.optional(),
    configured_by: z.string().max(160).optional(),
    configured_at: z.string().datetime().optional()
  }).strict().default({ workflow: 'assisted', max_rounds: 2, autonomous_classes: [] }),
  review_rounds: z.number().int().min(0).default(0),
  reviewed_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  revision_rounds: z.number().int().min(0).default(0),
  assessment: assessmentSchema.extend({ round: z.number().int().min(1), agent: z.string(), reviewed_revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).optional(),
  slide_assessments: z.record(slideId, slideAssessmentSchema.omit({ slide: true }).extend({ round: z.number().int().min(1), fingerprint: z.string() })).default({}),
  findings: z.array(findingRecordSchema).default([]),
  questions: z.array(questionRecordSchema).default([]),
  history: z.array(z.object({ at: z.string().datetime(), event: z.string(), actor: z.string(), detail: z.string().max(4000).default('') }).strict()).default([])
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const f of value.findings) {
    if (seen.has(f.id)) ctx.addIssue({ code: 'custom', message: `Duplicate finding ID ${f.id}` });
    seen.add(f.id);
  }
});
export type Ledger = z.infer<typeof ledgerSchema>;

export const planItemSchema = z.object({
  finding: findingId,
  slides: z.array(slideId),
  change: proposedChangeSchema,
  category: z.enum(categories),
  // SHA-256 of the target's current value; apply refuses if it changed afterwards.
  target_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  protected_slides: z.array(slideId),
  authorization: z.enum(['not-required', 'recorded', 'missing']),
  approval: z.enum(['creator-accepted', 'autonomous-policy']),
  // The decision this item executes; apply refuses if the creator decided again afterwards.
  decided_at: z.string().datetime().optional(),
  translation_review: z.array(z.string()),
  checks: z.array(z.string()),
  depends_on: z.array(findingId),
  status: z.enum(['ready', 'blocked']),
  reason: z.string().default('')
}).strict();
export const planSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^PLAN-[A-Za-z0-9-]+$/),
  created_at: z.string().datetime(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  workflow: z.enum(workflowModes),
  round: z.number().int().min(1),
  items: z.array(planItemSchema),
  deferred: z.array(z.object({ finding: findingId, reason: z.string() }).strict())
}).strict();
export type Plan = z.infer<typeof planSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
