import { describe, expect, test } from 'vitest';
import { hash } from '../src/core/io.js';
import { emptyLedger } from '../src/review/ledger.js';
import {
  evaluateReadiness, readinessChecks, readinessRecordSchema,
  readinessSubmissionSchema, readinessApprovalSchema, type ReadinessRecord
} from '../src/review/readiness.js';

const revision = 'a'.repeat(64);
const reviewedRevision = 'b'.repeat(64);
const substantial = 'This was inspected directly against the supplied slide sources and relevant technical mechanisms.';
const check = () => ({
  status: 'pass' as const,
  assessment: substantial,
  evidence_or_gap: substantial,
  presenter_action: 'No material correction required.'
});

function submission() {
  return {
    kind: 'scientific-readiness' as const, version: 1 as const, revision,
    reviewer: {
      name: 'Independent Reviewer', model: 'Scientific reviewer model',
      independent_from_builder: true as const,
      inspected: ['approved-brief', 'slide-source', 'speaker-notes'],
      uninspected_material: 'Only the current slide sources and speaker notes were available for inspection.'
    },
    intended_audience: 'Researchers familiar with machine learning and scientific ontology engineering.',
    contribution_in_one_sentence: 'The talk distinguishes implemented ontology membership validation from future agentic orchestration.',
    what_is_not_demonstrated: 'The current prototypes do not establish end-to-end scientific correctness or comparative superiority.',
    checks: Object.fromEntries(readinessChecks.map(key => [key, check()])),
    alternatives: [{
      approach: 'Unconstrained retrieval-augmented generation',
      relevance: 'relevant',
      comparison: 'This baseline retrieves candidate evidence but does not guarantee that the returned terms are admissible.',
      evidence_or_gap: 'No direct baseline comparison has been supplied; the speaker should mark this as future evaluation.'
    }],
    capabilities: [{
      claim: 'The implementation rejects a returned term outside the configured candidate list.',
      status: 'implemented',
      evidence_or_limit: 'The reviewed Python validation function checks candidate membership; semantic suitability remains unresolved.'
    }],
    expert_questions: Array.from({ length: 3 }, (_, i) => ({
      question: 'What observable error category would demonstrate why the selected mechanism matters? Example ' + (i + 1),
      answer_status: 'supported',
      defensible_answer_or_gap: 'The source illustrates rejection of out-of-set term identifiers, but not comprehensive semantic validity.'
    })),
    verdict: 'ready'
  };
}
function record(): ReadinessRecord {
  return readinessRecordSchema.parse({ ...submission(), submitted_at: '2026-11-19T17:00:00Z' });
}
function reviewedLedger() {
  const ledger = emptyLedger();
  ledger.review_rounds = 1;
  ledger.reviewed_revision = reviewedRevision;
  ledger.assessment = {
    summary: substantial, central_message_as_understood: substantial, audience_fit: substantial,
    strengths: [], key_risks: [], round: 1, agent: 'reviewer:Independent Reviewer',
    reviewed_revision: reviewedRevision
  };
  return ledger;
}

describe('mandatory scientific positioning and readiness gate', () => {
  test('requires all six independent dimensions, relevant alternatives and difficult Q&A', () => {
    expect(readinessSubmissionSchema.safeParse(submission()).success).toBe(true);
    const incomplete = { ...submission(), checks: { problem_and_contribution: check() }, alternatives: [], expert_questions: [] };
    expect(readinessSubmissionSchema.safeParse(incomplete).success).toBe(false);
    const unexamined = { ...submission(), reviewer: { ...submission().reviewer, inspected: ['slide-source'] } };
    expect(readinessSubmissionSchema.safeParse(unexamined).success).toBe(false);
  });
  test('fails closed on inconsistent verdicts and unanswered expert questions', () => {
    const warnings = { ...submission(), checks: { ...submission().checks,
      methodological_landscape: { ...check(), status: 'warning' } } };
    expect(readinessSubmissionSchema.safeParse(warnings).success).toBe(false);
    expect(readinessSubmissionSchema.safeParse({ ...warnings, verdict: 'ready-with-warnings' }).success).toBe(true);
    const blocked = { ...submission(), checks: { ...submission().checks,
      actual_mechanism: { ...check(), status: 'block' } } };
    expect(readinessSubmissionSchema.safeParse({ ...blocked, verdict: 'ready-with-warnings' }).success).toBe(false);
    expect(readinessSubmissionSchema.safeParse({ ...blocked, verdict: 'not-ready' }).success).toBe(true);
    const unanswered = submission();
    unanswered.expert_questions[0].answer_status = 'unknown';
    expect(readinessSubmissionSchema.safeParse(unanswered).success).toBe(false);
  });
  test('requires current science review, source revision and positioning assessment', () => {
    const fresh = evaluateReadiness(reviewedLedger(), record(), revision, reviewedRevision);
    expect(fresh.status).toBe('ready');
    expect(fresh.can_deliver).toBe(true);
    expect(evaluateReadiness(emptyLedger(), record(), revision, reviewedRevision).can_deliver).toBe(false);
    expect(evaluateReadiness(reviewedLedger(), undefined, revision, reviewedRevision).can_deliver).toBe(false);
    expect(evaluateReadiness(reviewedLedger(), record(), 'c'.repeat(64), reviewedRevision).status).toBe('stale');
    expect(evaluateReadiness(reviewedLedger(), record(), revision, 'c'.repeat(64)).can_deliver).toBe(false);
  });
  test('unresolved major concerns block even after a positive agent verdict', () => {
    const ledger = reviewedLedger();
    ledger.findings.push({ id: 'REV-001', severity: 'major', status: 'rejected' } as typeof ledger.findings[number]);
    const result = evaluateReadiness(ledger, record(), revision, reviewedRevision);
    expect(result.can_deliver).toBe(false);
    expect(result.unresolved_high_priority).toEqual(['REV-001']);
  });
  test('explicit human override is revision-bound and cannot waive missing review', () => {
    const negative = readinessRecordSchema.parse({ ...submission(), verdict: 'not-ready', submitted_at: '2026-11-19T17:00:00Z' });
    const signature = hash(JSON.stringify(negative));
    const signed = readinessRecordSchema.parse({ ...negative,
      override: { by: 'Researcher', reason: 'I accept the unresolved scientific positioning risks and will disclose them orally.',
        at: '2026-11-19T18:00:00Z', reviewed_record_sha256: signature } });
    expect(evaluateReadiness(reviewedLedger(), negative, revision, reviewedRevision).can_deliver).toBe(false);
    expect(evaluateReadiness(reviewedLedger(), signed, revision, reviewedRevision).status).toBe('overridden');
    const altered = readinessRecordSchema.parse({ ...signed, what_is_not_demonstrated: 'The evaluation remains a small unverified laboratory prototype with important limitations.' });
    expect(evaluateReadiness(reviewedLedger(), altered, revision, reviewedRevision).can_deliver).toBe(false);
    expect(evaluateReadiness(emptyLedger(), signed, revision, reviewedRevision).can_deliver).toBe(false);
  });
});


test('manual sign-off requires four affirmative acknowledgements and revision-bound evidence',()=>{
  const valid={
    version:1, approved_by:'Actual Presenter', approved_at:'2026-11-19T19:00:00Z',
    revision:'a'.repeat(64), record_sha256:'b'.repeat(64), ledger_sha256:'c'.repeat(64),
    acknowledgement:{
      scientific_positioning_read:true,methods_and_limitations_understood:true,
      expert_questions_reviewed:true,unresolved_findings_reviewed:true
    },
    note:'I have read and understood the independent review.'
  };
  expect(readinessApprovalSchema.safeParse(valid).success).toBe(true);
  expect(readinessApprovalSchema.safeParse({...valid, acknowledgement:{
    ...valid.acknowledgement, expert_questions_reviewed:false
  }}).success).toBe(false);
  expect(readinessApprovalSchema.safeParse({...valid, record_sha256:'invalid'}).success).toBe(false);
});
