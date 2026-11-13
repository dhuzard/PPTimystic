import { z } from 'zod';
import path from 'node:path';
import { exists, hash, readYaml, safePath, writeYaml } from './io.js';
import { localeSchema, type Project } from './model.js';

// Structured, local-only onboarding. An answer must be substantive; "Unknown"
// and similar placeholders are deliberately not accepted as approvals.
const answer = z.string().trim().min(6).max(4000).refine(
  value => !/^(unknown|tbd|todo|n\/a|not applicable|not specified|not provided|none)$/i.test(value),
  'Give a concrete answer, or explain explicitly what is not applicable.'
);
const bodySchema = z.object({
  version: z.literal(1),
  creator: z.object({
    profile: answer,
    expertise: answer,
    working_preferences: answer,
  }).strict(),
  goal: z.object({
    purpose: answer,
    audience_action: answer,
    central_message: answer,
  }).strict(),
  audience: z.object({
    description: answer,
    prior_knowledge: answer,
    needs_and_concerns: answer,
  }).strict(),
  delivery: z.object({
    format_and_setting: answer,
    duration_minutes: z.number().int().min(1).max(480),
  }).strict(),
  content: z.object({
    scope_and_structure: answer,
    evidence_and_sources: answer,
    uncertainties_and_exclusions: answer,
  }).strict(),
  design: z.object({
    tone: answer,
    visual_preferences: answer,
  }).strict(),
  constraints: z.object({
    source_locale: localeSchema,
    output_locales: z.array(localeSchema).min(1),
    accessibility_and_other: answer,
  }).strict(),
  further_wishes: z.string().trim().max(4000).default(''),
}).strict();
const approvalSchema = z.object({
  approved_by: answer,
  approved_at: z.string().datetime(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const briefSchema = bodySchema.extend({ approval: approvalSchema.optional() }).strict();
export type CreatorBrief = z.infer<typeof briefSchema>;
export type BriefBody = z.infer<typeof bodySchema>;
export interface BriefStatus { required: boolean; approved: boolean; errors: string[] }

const withoutApproval = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { approval: _approval, ...body } = raw as Record<string, unknown>;
  return body;
};
export const blankBrief = (config: Project): CreatorBrief => ({
  version: 1,
  creator: { profile: '', expertise: '', working_preferences: '' },
  goal: { purpose: '', audience_action: '', central_message: '' },
  audience: { description: '', prior_knowledge: '', needs_and_concerns: '' },
  delivery: { format_and_setting: '', duration_minutes: 0 },
  content: { scope_and_structure: '', evidence_and_sources: '', uncertainties_and_exclusions: '' },
  design: { tone: '', visual_preferences: '' },
  constraints: { source_locale: config.source_locale, output_locales: config.output_locales, accessibility_and_other: '' },
  further_wishes: '',
});
export const briefDigest = (body: BriefBody) => hash(JSON.stringify(bodySchema.parse(body)));

function parseBody(raw: unknown): { body?: BriefBody; errors: string[] } {
  const parsed = bodySchema.safeParse(withoutApproval(raw));
  if (parsed.success) return { body: parsed.data, errors: [] };
  return { errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'brief'}: ${issue.message}`) };
}
export async function readCreatorBrief(dir: string): Promise<unknown> {
  const file = await safePath(dir, 'presentation-brief.yaml');
  return await exists(file) ? await readYaml(file) : undefined;
}
export async function saveCreatorBrief(dir: string, raw: unknown) {
  const parsed = briefSchema.parse(raw);
  await writeYaml(await safePath(dir, 'presentation-brief.yaml'), parsed);
}
export function checkCreatorBrief(raw: unknown, config: Project): BriefStatus {
  if (!config.brief_required) return { required: false, approved: true, errors: [] };
  if (raw === undefined) return { required: true, approved: false, errors: [
    'Missing presentation-brief.yaml. Run npm run brief -- --project NAME.'
  ] };
  const { body, errors } = parseBody(raw);
  if (!body) return { required: true, approved: false, errors };
  if (body.constraints.source_locale !== config.source_locale ||
      JSON.stringify(body.constraints.output_locales) !== JSON.stringify(config.output_locales)) {
    errors.push('Brief languages differ from project.yaml; review the brief and approve it again.');
  }
  const approval = approvalSchema.safeParse((raw as CreatorBrief).approval);
  if (!approval.success) errors.push('Creator approval missing or malformed. Run npm run brief -- --project NAME --approve.');
  else if (approval.data.content_sha256 !== briefDigest(body)) errors.push(
    'Creator brief changed after approval. Review it with the creator and approve it again.'
  );
  return { required: true, approved: errors.length === 0, errors };
}
export async function creatorBriefStatus(dir: string, config: Project): Promise<BriefStatus> {
  if (!config.brief_required) return { required: false, approved: true, errors: [] };
  return checkCreatorBrief(await readCreatorBrief(dir), config);
}
export function approveCreatorBrief(raw: unknown, config: Project, approvedBy: string, now = new Date()): CreatorBrief {
  const { body, errors } = parseBody(raw);
  if (!body) throw new Error(`Cannot approve incomplete creator brief:\n${errors.join('\n')}`);
  if (body.constraints.source_locale !== config.source_locale ||
      JSON.stringify(body.constraints.output_locales) !== JSON.stringify(config.output_locales))
    throw new Error('Brief languages must match project.yaml before approval.');
  const person = answer.parse(approvedBy);
  return { ...body, approval: { approved_by: person, approved_at: now.toISOString(), content_sha256: briefDigest(body) } };
}
export function briefingSummary(raw: unknown): string {
  const { body, errors } = parseBody(raw);
  if (!body) throw new Error(`Incomplete creator brief:\n${errors.join('\n')}`);
  return [
    `Creator: ${body.creator.profile} — ${body.creator.expertise}`,
    `Working preferences: ${body.creator.working_preferences}`,
    `Purpose: ${body.goal.purpose}`,
    `Desired audience action: ${body.goal.audience_action}`,
    `Central message: ${body.goal.central_message}`,
    `Audience: ${body.audience.description} (${body.audience.prior_knowledge})`,
    `Needs: ${body.audience.needs_and_concerns}`,
    `Delivery: ${body.delivery.format_and_setting}, ${body.delivery.duration_minutes} min`,
    `Content: ${body.content.scope_and_structure}`,
    `Evidence: ${body.content.evidence_and_sources}`,
    `Uncertainties/exclusions: ${body.content.uncertainties_and_exclusions}`,
    `Tone and visuals: ${body.design.tone}; ${body.design.visual_preferences}`,
    `Accessibility/constraints: ${body.constraints.accessibility_and_other}`,
    `Languages: ${body.constraints.source_locale} → ${body.constraints.output_locales.join(', ')}`,
    `Further wishes: ${body.further_wishes || 'None recorded'}`,
  ].join('\n');
}
