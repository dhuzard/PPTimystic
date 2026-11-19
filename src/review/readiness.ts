import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { atomicWrite, exists, hash, loadProject, safePath, stamp, writeYaml } from '../core/io.js';
import { sourceFingerprint } from '../core/build.js';
import { deckRevision, inspectSourceAuthority } from './context.js';
import { readLedger } from './workflow.js';
import type { Ledger } from './schema.js';

const substantive = z.string().trim().min(20).max(4000).refine(
  value => !/^(todo|tbd|unknown|not sure|placeholder|none)$/i.test(value),
  'Explain the finding or explicitly explain why it is not applicable.'
);
const shortText = z.string().trim().min(8).max(400);
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const checkSchema = z.object({
  status: z.enum(['pass', 'warning', 'block']),
  assessment: substantive,
  evidence_or_gap: substantive,
  presenter_action: shortText
}).strict();

export const readinessChecks = [
  'problem_and_contribution', 'methodological_landscape', 'actual_mechanism',
  'evidence_and_limitations', 'narrative_value', 'expert_audience_readiness'
] as const;

const submissionBase = z.object({
  kind: z.literal('scientific-readiness'),
  version: z.literal(1),
  revision: revisionSchema,
  reviewer: z.object({
    name: shortText,
    model: shortText,
    independent_from_builder: z.literal(true),
    inspected: z.array(z.enum(['approved-brief', 'slide-source', 'speaker-notes', 'rendered-slides', 'code', 'literature', 'source-documents']))
      .min(2).refine(items => items.includes('approved-brief') && items.includes('slide-source'), 'Inspect the brief and slide source.'),
    uninspected_material: substantive
  }).strict(),
  intended_audience: substantive,
  contribution_in_one_sentence: substantive,
  what_is_not_demonstrated: substantive,
  checks: z.object({
    problem_and_contribution: checkSchema,
    methodological_landscape: checkSchema,
    actual_mechanism: checkSchema,
    evidence_and_limitations: checkSchema,
    narrative_value: checkSchema,
    expert_audience_readiness: checkSchema
  }).strict(),
  alternatives: z.array(z.object({
    approach: shortText,
    relevance: z.enum(['relevant', 'not-relevant', 'uncertain']),
    comparison: substantive,
    evidence_or_gap: substantive
  }).strict()).min(1),
  capabilities: z.array(z.object({
    claim: substantive,
    status: z.enum(['implemented', 'demonstrated', 'proposed', 'conceptual']),
    evidence_or_limit: substantive
  }).strict()).min(1),
  expert_questions: z.array(z.object({
    question: substantive,
    answer_status: z.enum(['supported', 'partial', 'unknown']),
    defensible_answer_or_gap: substantive
  }).strict()).min(3),
  verdict: z.enum(['ready', 'ready-with-warnings', 'not-ready'])
}).strict();

function checkVerdict(value: z.infer<typeof submissionBase>, ctx: z.RefinementCtx) {
  const ratings = readinessChecks.map(key => value.checks[key].status);
  if (ratings.includes('block') && value.verdict !== 'not-ready')
    ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'A blocked dimension requires NOT READY.' });
  if (ratings.includes('warning') && value.verdict === 'ready')
    ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'A warning cannot be reported as unqualified READY.' });
  if (value.expert_questions.some(question => question.answer_status !== 'supported') && value.verdict === 'ready')
    ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'Unanswered or partly answered expert questions must remain visible as warnings.' });
}
export const readinessSubmissionSchema = submissionBase.superRefine(checkVerdict);
const overrideSchema = z.object({
  by: z.string().trim().min(2).max(160),
  reason: substantive,
  at: z.string().datetime(),
  reviewed_record_sha256: revisionSchema
}).strict();
export const readinessRecordSchema = submissionBase.extend({
  submitted_at: z.string().datetime(),
  override: overrideSchema.optional()
}).strict().superRefine(checkVerdict);
export type ReadinessRecord = z.infer<typeof readinessRecordSchema>;

export const readinessFile = 'review/readiness.json';
export const readinessReportFile = 'review/readiness.md';
export const readinessDraftFile = 'review/readiness-submission.yaml';
export const readinessApprovalFile = 'review/readiness-approval.json';

export const readinessAcknowledgmentSchema = z.object({
  scientific_positioning_read: z.literal(true),
  methods_and_limitations_understood: z.literal(true),
  expert_questions_reviewed: z.literal(true),
  unresolved_findings_reviewed: z.literal(true)
}).strict();

export const readinessApprovalSchema = z.object({
  version: z.literal(1),
  approved_by: z.string().trim().min(2).max(160),
  approved_at: z.string().datetime(),
  revision: revisionSchema,
  record_sha256: revisionSchema,
  acknowledgement: readinessAcknowledgmentSchema,
  note: z.string().trim().max(2000).default('')
}).strict();
export type ReadinessApproval = z.infer<typeof readinessApprovalSchema>;

/** Covers reviewer context, outputs, and image/assets used to build the deck. */
export async function readinessRevision(project: string) {
  const { dir, config, deck, theme } = await loadProject(project);
  const reviewRevision = await deckRevision(dir, config);
  const renderedSources = await Promise.all(config.output_locales.map(async locale => ({
    locale, fingerprint: await sourceFingerprint(dir, config, deck, theme, locale)
  })));
  return { reviewRevision, revision: hash(JSON.stringify({ reviewRevision, renderedSources })) };
}

export type ReadinessDecision = {
  required: boolean;
  status: 'not-required' | 'not-reviewed' | 'stale' | 'not-ready' | 'ready-with-warnings' | 'ready' | 'overridden' | 'awaiting-human-approval';
  can_deliver: boolean;
  blockers: string[];
  risks: string[];
  unresolved_high_priority: string[];
  revision?: string;
  verdict?: ReadinessRecord['verdict'];
  reviewed_by?: string;
  submitted_at?: string;
  override?: ReadinessRecord['override'];
  record_sha256?: string;
  human_approval?: ReadinessApproval;
};

export function evaluateReadiness(
  ledger: Ledger,
  record: ReadinessRecord | undefined,
  revision: string,
  reviewRevision: string
): ReadinessDecision {
  const blockers: string[] = [], risks: string[] = [];
  if (!ledger.review_rounds || !ledger.assessment) blockers.push('No completed scientific review and overall assessment.');
  if (ledger.reviewed_revision !== reviewRevision || ledger.assessment?.reviewed_revision !== reviewRevision)
    blockers.push('The scientific review and its assessment are absent or stale for the current deck.');
  if (!record) blockers.push('No Scientific Positioning & Readiness Gate submission.');
  else if (record.revision !== revision) blockers.push('Readiness assessment is stale: the deck, sources, images or output changed.');
  const high = ledger.findings.filter(f =>
    ['critical', 'major'].includes(f.severity) && !['resolved', 'withdrawn'].includes(f.status)).map(f => f.id);
  if (high.length) risks.push('Unresolved critical/major scientific findings: ' + high.join(', ') + '.');
  if (record?.verdict === 'not-ready') risks.push('Independent reviewer judged the presentation NOT READY.');
  let attested: Omit<ReadinessRecord, 'override'> | undefined;
  if (record) { const { override: _ignored, ...body } = record; attested = body; }
  const overridden = Boolean(record?.override && attested &&
    record.override.reviewed_record_sha256 === hash(JSON.stringify(attested)));
  const can_deliver = blockers.length === 0 && (risks.length === 0 || overridden);
  const status: ReadinessDecision['status'] = blockers.length ? (!record ? 'not-reviewed' : 'stale')
    : risks.length ? (overridden ? 'overridden' : 'not-ready')
    : record?.verdict ?? 'not-reviewed';
  return {
    required: true, status, can_deliver, blockers, risks, unresolved_high_priority: high,
    revision, verdict: record?.verdict, reviewed_by: record?.reviewer.name,
    submitted_at: record?.submitted_at, override: overridden ? record?.override : undefined,
    record_sha256: record ? hash(JSON.stringify(record)) : undefined
  };
}

async function currentRecord(dir: string): Promise<ReadinessRecord | undefined> {
  const file = await safePath(dir, readinessFile);
  if (!await exists(file)) return undefined;
  const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  return readinessRecordSchema.parse(raw);
}

export async function readinessStatus(project: string): Promise<ReadinessDecision> {
  const { dir, config } = await loadProject(project);
  if (!config.brief_required) return { required: false, status: 'not-required', can_deliver: true, blockers: [], risks: [], unresolved_high_priority: [] };
  const { reviewRevision, revision } = await readinessRevision(project);
  const ledger = await readLedger(dir);
  let record: ReadinessRecord | undefined;
  try { record = await currentRecord(dir); }
  catch (error) {
    return { required: true, status: 'not-ready', can_deliver: false,
      blockers: ['Invalid readiness record: ' + (error as Error).message], risks: [], unresolved_high_priority: [], revision };
  }
  const scientific = evaluateReadiness(ledger, record, revision, reviewRevision);
  // The independent model's verdict is not the presenter's sign-off.
  // A missing approval is blocking even for READY and READY WITH WARNINGS.
  if (!scientific.can_deliver) return scientific;
  const approvalPath = await safePath(dir, readinessApprovalFile);
  if (await exists(approvalPath)) {
    try {
      const approval = readinessApprovalSchema.parse(JSON.parse(await fs.readFile(approvalPath, 'utf8')));
      if (approval.revision === revision && approval.record_sha256 === scientific.record_sha256)
        return { ...scientific, human_approval: approval };
    } catch {
      // Invalid approval records must never unlock delivery.
    }
  }
  return {
    ...scientific, status: 'awaiting-human-approval', can_deliver: false,
    blockers: [...scientific.blockers, 'The presenter must personally review and sign off in the HTML studio before final delivery.']
  };
}

export async function assertReadyForDelivery(project: string) {
  const status = await readinessStatus(project);
  if (!status.can_deliver) throw new Error(
    'Scientific Positioning & Readiness Gate blocked delivery:\n' +
    [...status.blockers, ...status.risks].join('\n') + '\nRun npm run readiness -- --project ' + project + ' --mode status.'
  );
  return status;
}

export async function prepareReadiness(project: string) {
  const { dir } = await loadProject(project);
  const { revision } = await readinessRevision(project);
  const template = {
    kind: 'scientific-readiness', version: 1, revision,
    reviewer: { name: '', model: '', independent_from_builder: true,
      inspected: ['approved-brief', 'slide-source'], uninspected_material: '' },
    intended_audience: '', contribution_in_one_sentence: '', what_is_not_demonstrated: '',
    checks: Object.fromEntries(readinessChecks.map(key => [key,
      { status: 'block', assessment: '', evidence_or_gap: '', presenter_action: '' }])),
    alternatives: [{ approach: '', relevance: 'uncertain', comparison: '', evidence_or_gap: '' }],
    capabilities: [{ claim: '', status: 'conceptual', evidence_or_limit: '' }],
    expert_questions: Array.from({ length: 3 }, () => ({
      question: '', answer_status: 'unknown', defensible_answer_or_gap: ''
    })),
    verdict: 'not-ready'
  };
  const file = await safePath(dir, readinessDraftFile);
  await writeYaml(file, template);
  return { file, revision, next: 'An independent reviewer fills every field using the brief, deck, mechanisms and relevant evidence. The placeholder template is intentionally invalid.' };
}

function reportMarkdown(record: ReadinessRecord) {
  const lines = [
    '# Scientific Positioning & Readiness Gate', '',
    '**Verdict:** ' + record.verdict + ' · **Reviewer:** ' + record.reviewer.name + ' (' + record.reviewer.model + ')',
    '**Reviewed:** ' + record.submitted_at, '',
    '## Scientific claim', '', record.contribution_in_one_sentence, '',
    '## What is not demonstrated', '', record.what_is_not_demonstrated, '',
    '## Required independent checks', ''
  ];
  for (const key of readinessChecks) {
    const c = record.checks[key];
    lines.push('### ' + key.replaceAll('_', ' ') + ' — ' + c.status, '', c.assessment, '',
      '**Basis or gap:** ' + c.evidence_or_gap, '', '**Presenter action:** ' + c.presenter_action, '');
  }
  lines.push('## Relevant alternatives', '');
  for (const a of record.alternatives) lines.push('- **' + a.approach + '** (' + a.relevance + '): ' + a.comparison + ' Basis/gap: ' + a.evidence_or_gap);
  lines.push('', '## Actual capability versus proposed work', '');
  for (const c of record.capabilities) lines.push('- **' + c.status + ':** ' + c.claim + ' — ' + c.evidence_or_limit);
  lines.push('', '## Difficult expert questions', '');
  for (const q of record.expert_questions) lines.push('- **' + q.question + '** (' + q.answer_status + '): ' + q.defensible_answer_or_gap);
  if (record.override) lines.push('', '## Human override', '', record.override.by + ': ' + record.override.reason);
  lines.push('', '**Review limitations:** ' + record.reviewer.uninspected_material, '');
  return lines.join('\n');
}

export async function submitReadiness(project: string, file: string) {
  const { dir, config, deck } = await loadProject(project);
  if (!config.brief_required) throw new Error('The gate is only required for real projects with the approved-brief workflow.');
  const { revision, reviewRevision } = await readinessRevision(project);
  const ledger = await readLedger(dir);
  if (!ledger.assessment || ledger.assessment.reviewed_revision !== reviewRevision || ledger.reviewed_revision !== reviewRevision)
    throw new Error('A current independent scientific review with an overall assessment is required first. Run review --mode prepare and submit.');
  const authority = await inspectSourceAuthority(project, deck);
  if (!authority.authoritative) throw new Error('Reconcile externally edited presentation artifacts before readiness review.');
  const parsed = readinessSubmissionSchema.safeParse(YAML.parse(await fs.readFile(file, 'utf8')));
  if (!parsed.success) throw new Error('Readiness submission invalid:\n' +
    parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('\n'));
  if (parsed.data.revision !== revision) throw new Error('Readiness submission is stale; run readiness --mode prepare and review the changed deck.');
  const record = readinessRecordSchema.parse({ ...parsed.data, submitted_at: new Date().toISOString() });
  const destination = await safePath(dir, readinessFile);
  if (await exists(destination)) {
    const history = await safePath(dir, 'review/history/' + stamp() + '-' + crypto.randomUUID().slice(0, 8) + '.readiness.json');
    await atomicWrite(history, await fs.readFile(destination));
  }
  await atomicWrite(destination, JSON.stringify(record, null, 2));
  await atomicWrite(await safePath(dir, readinessReportFile), reportMarkdown(record));
  return readinessStatus(project);
}

/** Not a model action: the CLI requires an interactive creator confirmation. */
export async function overrideReadiness(project: string, by: string, reason: string, confirmed: boolean) {
  if (!confirmed) throw new Error('A person must explicitly confirm the readiness override.');
  if (by.trim().length < 2 || reason.trim().length < 20) throw new Error('Provide the creator name and a substantive reason (at least 20 characters).');
  const before = await readinessStatus(project);
  if (!before.required || !before.revision || before.blockers.length)
    throw new Error('A missing, malformed or stale scientific review cannot be overridden.');
  if (!before.risks.length) throw new Error('No blocking scientific readiness risk exists to override.');
  const { dir } = await loadProject(project);
  const record = await currentRecord(dir);
  if (!record) throw new Error('No readiness record.');
  const { override: _previous, ...reviewed } = record;
  const updated = readinessRecordSchema.parse({
    ...reviewed,
    override: {
      by: by.trim(), reason: reason.trim(), at: new Date().toISOString(),
      reviewed_record_sha256: hash(JSON.stringify(reviewed))
    }
  });
  const destination = await safePath(dir, readinessFile);
  const history = await safePath(dir, 'review/history/' + stamp() + '-' + crypto.randomUUID().slice(0, 8) + '.readiness.json');
  await atomicWrite(history, await fs.readFile(destination));
  await atomicWrite(destination, JSON.stringify(updated, null, 2));
  await atomicWrite(await safePath(dir, readinessReportFile), reportMarkdown(updated));
  return readinessStatus(project);
}


/** Detailed, authenticated reviewer material for the studio; never auto-approves anything. */
export async function readinessDetail(project: string) {
  const { dir, config } = await loadProject(project);
  const [status, ledger] = await Promise.all([readinessStatus(project), readLedger(dir)]);
  const record = config.brief_required ? await currentRecord(dir).catch(() => undefined) : undefined;
  return {
    status, record,
    assessment: ledger.assessment ?? null,
    findings: ledger.findings.map(f => ({
      id: f.id, slide_ids: f.slide_ids, title: f.title, severity: f.severity,
      status: f.status, category: f.category, basis: f.basis,
      observation: f.observation, rationale: f.rationale,
      recommendation: f.recommendation, evidence_status: f.evidence.status
    })),
    questions: ledger.questions.map(q => ({
      question: q.question, why_likely: q.why_likely, difficulty: q.difficulty,
      answer_basis: q.answer_basis, answer_notes: q.answer_notes
    }))
  };
}

/** Only the authenticated studio owner or interactive CLI should invoke this. */
export async function approveReadiness(project: string, input: {
  approved_by: string;
  revision: string;
  record_sha256: string;
  acknowledgement: unknown;
  note?: string;
}) {
  const name = z.string().trim().min(2).max(160).parse(input.approved_by);
  const acknowledgement = readinessAcknowledgmentSchema.parse(input.acknowledgement);
  const note = z.string().trim().max(2000).parse(input.note ?? '');
  const { dir } = await loadProject(project);
  const status = await readinessStatus(project);
  if (!status.required || !['awaiting-human-approval', 'ready', 'ready-with-warnings', 'overridden'].includes(status.status))
    throw new Error('Scientific review must be current and all blocking findings resolved or explicitly overridden before human sign-off.');
  if (!status.revision || input.revision !== status.revision || input.record_sha256 !== status.record_sha256)
    throw new Error('The readiness review changed after you opened the report. Read the latest review and sign again.');
  const record = await currentRecord(dir);
  if (!record || hash(JSON.stringify(record)) !== status.record_sha256)
    throw new Error('The independent scientific readiness record changed. Refresh before signing.');
  const approval = readinessApprovalSchema.parse({
    version: 1, approved_by: name, approved_at: new Date().toISOString(),
    revision: status.revision, record_sha256: status.record_sha256,
    acknowledgement, note
  });
  const destination = await safePath(dir, readinessApprovalFile);
  if (await exists(destination)) {
    const previous = await fs.readFile(destination);
    await atomicWrite(await safePath(dir, 'review/history/' + stamp() +
      '-' + crypto.randomUUID().slice(0, 8) + '.approval.json'), previous);
  }
  await atomicWrite(destination, JSON.stringify(approval, null, 2));
  return readinessStatus(project);
}
