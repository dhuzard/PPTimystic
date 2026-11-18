import type { Deck, Project } from '../core/model.js';
import { isProtected, workflowStatus } from './ledger.js';
import { awaitingCreator, severities, type FindingRecord, type Ledger, type ProposedChange } from './schema.js';

const md = (value: unknown) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/[\\`*_[\]|]/g, m => `\\${m}`).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const token = (f: FindingRecord) => `${f.id} · ${f.status}`;

export function describeChange(change: ProposedChange, slides: string[], deck: Deck, config: Project) {
  const on = slides.join(', ') || 'the deck';
  const current = (target: string, locale?: string) => deck.slides.find(s => s.id === slides[0])?.content[locale ?? config.source_locale]?.[target as 'title'];
  switch (change.type) {
    case 'none': return 'No source change (observation or question).';
    case 'wording': return change.suggested_text === null
      ? `Rewrite the ${change.target} of ${on}${change.locale ? ` (${change.locale})` : ''}; wording still to be written and approved.`
      : `Change the ${change.target} of ${on}${change.locale ? ` (${change.locale})` : ''} from "${current(change.target, change.locale) ?? ''}" to "${change.suggested_text}".`;
    case 'evidence-class': return `Reclassify the evidence of ${on} as ${change.evidence}.`;
    case 'layout': return `Change the layout of ${on} to ${change.layout}.`;
    case 'object-geometry': return `Adjust ${change.object} on ${on}: ${JSON.stringify(change.override)}.`;
    case 'storyline': {
      const c = change.change;
      return c.kind === 'move' ? `Move ${on} ${c.after ? `after ${c.after}` : 'to the start'}.`
        : c.kind === 'role' ? `Give ${on} the story role ${c.role}.` : c.kind === 'section' ? `Put ${on} in section "${c.section}".`
        : c.kind === 'transition' ? `Transition from ${on}: "${c.text}".` : c.kind === 'throughline' ? `Throughline: "${c.text}".` : `Use the ${c.framework} framework.`;
    }
    case 'manual': return `Manual work: ${change.description}`;
  }
}
const evidenceLabel: Record<string, string> = {
  'requires-human-verification': 'requires human verification',
  'source-read-by-reviewer': 'reviewer read the extracted source; support is not independently verified',
  'no-source-supplied': 'no source supplied',
  'not-applicable': 'not applicable'
};
function protectedNote(f: FindingRecord, deck: Deck) {
  if (f.proposed_change.type === 'none' || f.proposed_change.type === 'storyline' && f.proposed_change.change.kind !== 'move') return '';
  const locked = f.slide_ids.filter(id => { const s = deck.slides.find(x => x.id === id); return s && isProtected(s); });
  return locked.length ? `${locked.join(', ')} is approved or locked: accepting this finding authorizes changing it.` : '';
}

/** The human-review page. Decisions are made per finding token; nothing changes until accepted and applied. */
export function reviewMarkdown(ledger: Ledger, deck: Deck, config: Project) {
  const status = workflowStatus(ledger, deck);
  const lines = [`# Scientific review — ${md(config.title)}`, '',
    '> Accept, reject or discuss each finding where it appears, or select text to comment. Nothing changes in the deck until a finding is accepted, planned and applied. Severity is the reviewer\'s judgment of importance, not a verification: the basis line says how each finding was formed, and no source link here establishes that a source supports a claim. That remains your decision.', ''];
  const a = ledger.assessment;
  lines.push('## Overall assessment', '');
  if (!a) lines.push('*No assessment yet.*', '');
  else {
    lines.push(`*Round ${a.round}, ${md(a.agent)}*`, '', md(a.summary), '', `**Central message as understood:** ${md(a.central_message_as_understood)}`, '', `**Audience fit:** ${md(a.audience_fit)}`, '');
    if (a.strengths.length) lines.push('**Strengths**', '', ...a.strengths.map(s => `- ${md(s)}`), '');
    if (a.key_risks.length) lines.push('**Key risks**', '', ...a.key_risks.map(s => `- ${md(s)}`), '');
  }
  lines.push('## Status', '', `Workflow: ${status.workflow} · review rounds ${status.review_rounds} · revision rounds ${status.revision_rounds} of ${status.max_rounds}`, '',
    `Next: ${md(status.next)}`, '');
  const block = (f: FindingRecord, decided = false) => {
    const note = protectedNote(f, deck);
    const head = `- **${token(f)}** — ${md(f.title)} (${md(f.slide_ids.join(', ') || 'deck')})`;
    if (decided) return [`${head}${f.decision ? ` · ${md(f.decision.decision)} by ${md(f.decision.by)}` : ''}${f.resolution ? ` · re-review: ${md(f.resolution.outcome)}` : ''}${f.builder ? ` · builder: ${md(f.builder.outcome)} — ${md(f.builder.note)}` : ''}${f.last_error ? ` · last attempt failed: ${md(f.last_error)}` : ''}`];
    return [head,
      `  - ${f.severity} · ${f.category} · basis: ${f.basis} · confidence: ${f.confidence} · lens: ${f.perspective}${f.regression_of ? ` · regression of ${f.regression_of}` : ''}`,
      `  - Observation: ${md(f.observation)}`,
      `  - Changes scientific meaning: ${f.changes_scientific_meaning ? 'yes' : 'no'}`,
      `  - Why it matters: ${md(f.rationale)}`,
      `  - Recommendation: ${md(f.recommendation)}`,
      `  - Proposed change: ${md(describeChange(f.proposed_change, f.slide_ids, deck, config))}`,
      ...(f.acceptance_criteria.length ? [`  - Done when: ${f.acceptance_criteria.map(md).join('; ')}`] : []),
      `  - Evidence: ${evidenceLabel[f.evidence.status]}${f.evidence.source_refs.length ? ` (${md(f.evidence.source_refs.join(', '))}${f.evidence.locators.length ? `; ${md(f.evidence.locators.join(', '))}` : ''})` : ''} · inspected: ${f.inspected.join(', ')}`,
      ...(f.decision?.note ? [`  - Discussion: ${md(f.decision.note)}`] : []),
      ...(note ? [`  - *${md(note)}*`] : [])];
  };
  const open = ledger.findings.filter(f => awaitingCreator.includes(f.status));
  lines.push('## Findings awaiting your decision', '');
  if (!open.length) lines.push('*None.*', '');
  for (const severity of severities) {
    const group = open.filter(f => f.severity === severity);
    if (group.length) lines.push(`### ${severity[0].toUpperCase()}${severity.slice(1)}`, '', ...group.flatMap(f => block(f)), '');
  }
  const progress = ledger.findings.filter(f => ['accepted', 'applied', 'blocked', 'unresolved', 'stalled'].includes(f.status));
  if (progress.length) lines.push('## In progress', '', ...progress.flatMap(f => block(f, true)), '');
  lines.push('## Slide by slide', '', '| Slide | Title | Reviewer verdict | Findings |', '| --- | --- | --- | --- |');
  for (const slide of deck.slides) {
    const verdict = ledger.slide_assessments[slide.id];
    const related = ledger.findings.filter(f => f.slide_ids.includes(slide.id) && !['withdrawn'].includes(f.status)).map(f => `${f.id} (${f.status})`);
    lines.push(`| ${md(slide.id)} | ${md(slide.content[config.source_locale]?.title)} | ${verdict ? `${verdict.verdict}${verdict.note ? `: ${md(verdict.note)}` : ''}` : '—'} | ${related.join(', ') || '—'} |`);
  }
  lines.push('', '## Anticipated questions', '');
  if (!ledger.questions.length) lines.push('*None yet.*');
  for (const q of ledger.questions) lines.push(`- **${q.id}** [${q.perspective} · ${q.difficulty}${q.slide_ids.length ? ` · ${md(q.slide_ids.join(', '))}` : ''}] ${md(q.question)} — ${md(q.why_likely)} Answer: ${q.answer_basis}${q.answer_notes ? ` (${md(q.answer_notes)})` : ''}${q.backup_slide_suggested ? ' · backup slide suggested' : ''}`);
  const closed = ledger.findings.filter(f => ['rejected', 'deferred', 'resolved', 'withdrawn'].includes(f.status));
  if (closed.length) lines.push('', '## Closed', '', ...closed.flatMap(f => block(f, true)));
  return lines.join('\n') + '\n';
}

/** One shared human-review thread per open finding, anchored on its status token. */
export function reviewThreads(ledger: Ledger, deck: Deck, config: Project) {
  return ledger.findings.filter(f => awaitingCreator.includes(f.status) && !f.thread).map(f => {
    const note = protectedNote(f, deck);
    return { finding: f.id, quote: token(f), replacement: `${f.id} · accepted`,
      body: `${f.rationale}\n\nAccepting: ${describeChange(f.proposed_change, f.slide_ids, deck, config)}${note ? `\n\n${note}` : ''}\n\nBasis: ${f.basis}; evidence ${evidenceLabel[f.evidence.status]}.` };
  });
}
