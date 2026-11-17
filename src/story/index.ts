import { z } from 'zod';
import { exists, readYaml, safePath, writeYaml } from '../core/io.js';
import { readCreatorBrief } from '../core/brief.js';
import type { Deck, Project, Slide } from '../core/model.js';

// The storyline is editorial planning metadata. It annotates the authoritative
// slide order in content/slides.yaml; it never reorders, rewrites or renders slides.
export const storyRoles = ['opening', 'roadmap', 'context', 'question', 'approach', 'evidence', 'interpretation', 'implication', 'conclusion', 'backup'] as const;
export const storyFrameworks = ['research', 'abt', 'free'] as const;
export type StoryRole = typeof storyRoles[number];
export type StoryFramework = typeof storyFrameworks[number];

const slideId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
export const storySlideSchema = z.object({
  role: z.enum(storyRoles).optional(),
  section: z.string().trim().min(1).max(80).optional(),
  // A planned spoken bridge from this slide into the next one (source language).
  transition: z.string().max(1000).default('')
}).strict();
export const storylineSchema = z.object({
  version: z.literal(1),
  framework: z.enum(storyFrameworks).default('research'),
  // The single sentence the whole presentation argues.
  throughline: z.string().max(1000).default(''),
  slides: z.record(slideId, storySlideSchema).default({})
}).strict();
export type Storyline = z.infer<typeof storylineSchema>;
export const storylinePath = 'content/storyline.yaml';

export interface StoryIssue { severity: 'error' | 'warning'; code: string; slide?: string; message: string }
export interface StoryContext { centralMessage?: string; durationMinutes?: number }
export interface StorySlide {
  position: number; id: string; layout: Slide['layout']; evidence: Slide['evidence'];
  role?: StoryRole; inferred: boolean; section?: string;
  title: string; message: string; transition: string;
}

/** Beats each framework expects, with the reason a missing beat weakens flow. */
const requiredBeats: Record<StoryFramework, Partial<Record<StoryRole, string>>> = {
  research: {
    question: 'No slide states the question, gap or problem the presentation answers, so the audience may not know why the evidence matters.',
    approach: 'No slide explains how the evidence was obtained, so the audience cannot judge it.',
    evidence: 'No slide presents the evidence that supports the conclusion.',
    conclusion: 'No slide states the take-home message.'
  },
  abt: {
    context: 'No "And" beat: no slide establishes the shared context.',
    question: 'No "But" beat: no slide introduces the tension, gap or problem.',
    conclusion: 'No "Therefore" beat: no slide resolves the tension with a take-home message.'
  },
  free: {}
};

/** Conservative defaults when no role is recorded. Inferred roles never trigger stylistic warnings. */
export function inferRole(slide: Slide, index: number): StoryRole | undefined {
  if (index === 0 && slide.layout === 'title') return 'opening';
  if (slide.layout === 'conclusion') return 'conclusion';
  if (slide.layout === 'chart') return 'evidence';
  if (slide.layout === 'workflow') return 'approach';
  return undefined;
}

const stopwords = new Set(`
about above after again against also among because been before being below between both cannot could does doing down during each from further have having here into itself just more most must only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your yours make makes made show shows shown
avec aussi autre autres avant avoir cette ceux chaque comme dans depuis donc elle elles entre être fait faire leur leurs mais même moins nous notre nos plus pour quand quel quelle quels quelles sans selon sont sous tous tout toute toutes très votre vous être ainsi alors après celle celles cela`.trim().split(/\s+/));
/** Lowercase content-word stems; a crude, language-light proxy for shared topic. */
export function keywords(text: string): Set<string> {
  const words = text.normalize('NFC').toLowerCase().match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? [];
  return new Set(words.filter(w => w.length >= 4 && !stopwords.has(w)).map(w => w.normalize('NFD').replace(/\p{M}/gu, '').slice(0, 5)));
}
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter(word => b.has(word)).length;
const jaccard = (a: Set<string>, b: Set<string>) => a.size + b.size ? overlap(a, b) / new Set([...a, ...b]).size : 0;
const firstLine = (text: string) => text.split('\n')[0].trim();

export function analyzeStory(deck: Deck, config: Project, storyline?: Storyline, context: StoryContext = {}, locale = config.source_locale) {
  const issues: StoryIssue[] = [];
  const warn = (code: string, message: string, slide?: string) => issues.push({ severity: 'warning', code, message, slide });
  const known = new Set(deck.slides.map(slide => slide.id));
  for (const id of Object.keys(storyline?.slides ?? {})) if (!known.has(id)) issues.push({ severity: 'error', code: 'story-unknown-slide', slide: id, message: `${id} is in ${storylinePath} but not in the deck. Remove or rename the entry; slide IDs are stable and never renumbered.` });

  const slides: StorySlide[] = deck.slides.map((slide, index) => {
    const entry = storyline?.slides[slide.id];
    const inferred = entry?.role ? undefined : inferRole(slide, index);
    const text = slide.content[locale] ?? slide.content[config.source_locale];
    return { position: index + 1, id: slide.id, layout: slide.layout, evidence: slide.evidence,
      role: entry?.role ?? inferred, inferred: Boolean(inferred), section: entry?.section,
      title: text?.title ?? '', message: text?.message ?? '', transition: entry?.transition ?? '' };
  });
  const framework = storyline?.framework ?? 'research';
  const throughline = storyline?.throughline.trim() || context.centralMessage?.trim() || '';
  const main = slides.filter(slide => slide.role !== 'backup');
  const roleOf = (role: StoryRole) => slides.filter(slide => slide.role === role);

  const unassigned = slides.filter(slide => !slide.role);
  if (unassigned.length) warn('story-role-missing', `No story role for ${unassigned.map(s => s.id).join(', ')}. Record one of ${storyRoles.join(', ')} in ${storylinePath} so the flow can be checked.`);
  if (storyline && !storyline.throughline.trim()) warn('story-throughline', `${storylinePath} has no throughline: state in one sentence what the whole presentation argues${context.centralMessage ? ' (the approved brief records a central message to start from)' : ''}.`);

  const first = slides[0];
  if (first?.role && !first.inferred && !['opening', 'context', 'question'].includes(first.role)) warn('story-opening', `The deck opens with a ${first.role} slide. Audiences follow more easily when the opening establishes the topic, context or question first.`, first.id);
  for (const [role, reason] of Object.entries(requiredBeats[framework]) as [StoryRole, string][]) if (!roleOf(role).length) warn('story-beat-missing', `${framework} framework: ${reason}`);

  const firstFraming = slides.findIndex(slide => slide.role === 'context' || slide.role === 'question');
  const firstEvidence = slides.findIndex(slide => slide.role === 'evidence');
  if (firstEvidence >= 0 && (firstFraming < 0 || firstEvidence < firstFraming) && (framework !== 'free' || firstFraming >= 0)) warn('story-order', `Evidence appears (slide ${slides[firstEvidence].position}) before any context or question slide. State why the evidence matters before showing it.`, slides[firstEvidence].id);
  const firstConclusion = slides.findIndex(slide => slide.role === 'conclusion');
  if (firstConclusion >= 0) for (const slide of slides.slice(firstConclusion + 1)) {
    if (slide.role && ['context', 'question', 'approach', 'evidence', 'interpretation'].includes(slide.role)) warn('story-order', `A ${slide.role} slide follows the conclusion (slide ${firstConclusion + 1}). Move it before the conclusion or mark it as backup so the take-home message comes last.`, slide.id);
  }
  const firstBackup = slides.findIndex(slide => slide.role === 'backup');
  if (firstBackup >= 0) for (const slide of slides.slice(firstBackup + 1)) if (slide.role !== 'backup') warn('story-order', `A main slide follows backup material (slide ${firstBackup + 1}). Keep backup slides together at the end.`, slide.id);

  // Sections should be contiguous; boundaries are where the audience most needs a bridge.
  const closedSections = new Set<string>();
  for (const [index, slide] of slides.entries()) {
    const previous = slides[index - 1];
    if (!slide.section || previous?.section === slide.section) continue;
    if (closedSections.has(slide.section)) warn('story-section-split', `Section "${slide.section}" resumes after another section. Group its slides together or rename one part.`, slide.id);
    if (previous?.section) {
      closedSections.add(previous.section);
      if (!previous.transition.trim() && previous.role !== 'opening') warn('story-bridge', `No transition is recorded from section "${previous.section}" into "${slide.section}". Note how ${previous.id} leads into ${slide.id}.`, previous.id);
    }
  }

  // Lexical continuity is only a prompt for human review: shared words do not prove logical flow.
  for (const [index, slide] of slides.entries()) {
    const previous = slides[index - 1];
    if (!previous) continue;
    const scaffolding = ['opening', 'roadmap', 'backup'];
    if (previous.transition.trim() || (slide.section && slide.section !== previous.section) || scaffolding.includes(previous.role ?? '') || scaffolding.includes(slide.role ?? '')) continue;
    const before = keywords(`${previous.title} ${previous.message}`), after = keywords(`${slide.title} ${slide.message}`);
    const titleA = keywords(previous.title), titleB = keywords(slide.title);
    if (titleA.size >= 3 && titleB.size >= 3 && jaccard(titleA, titleB) >= 0.6) warn('story-repetition', `${previous.id} and ${slide.id} have very similar titles. If they make the same point, merge them; otherwise make the difference explicit.`, slide.id);
    else if (before.size && after.size && !overlap(before, after)) warn('story-topic-shift', `${previous.id} → ${slide.id} share no key terms and no transition is recorded. Check the link is clear, record a transition, or start a new section.`, slide.id);
  }

  // Certainty must not grow at the end of the story without supporting evidence.
  const established = slides.findIndex(slide => slide.evidence === 'established' && slide.role !== 'conclusion' && slide.role !== 'implication');
  for (const [index, slide] of slides.entries()) {
    if ((slide.role === 'conclusion' || slide.role === 'implication') && slide.evidence === 'established' && (established < 0 || established > index)) warn('story-certainty', `${slide.id} is classified as established, but no earlier slide presents established evidence. Check that the ${slide.role} does not claim more certainty than the slides that lead to it.`, slide.id);
    if (slide.role === 'evidence' && !slide.inferred && ['conceptual', 'missing'].includes(slide.evidence)) warn('story-evidence', `${slide.id} is an evidence beat but its evidence is ${slide.evidence}. Classify the evidence or give the slide a different role.`, slide.id);
    if (!slide.inferred && slide.role && ['evidence', 'interpretation', 'conclusion'].includes(slide.role) && slide.title.trim().split(/\s+/).length <= 3) warn('story-title', `"${firstLine(slide.title)}" reads as a topic label. In a titles-only read-through, a short statement of the finding carries the story better, with the strength of the evidence preserved.`, slide.id);
  }

  // The throughline and brief are written in the source language; compare like with like.
  if (throughline && locale === config.source_locale) {
    const target = keywords(throughline);
    const closing = roleOf('conclusion');
    if (target.size && closing.length && !closing.some(slide => overlap(target, keywords(`${slide.title} ${slide.message}`)))) warn('story-throughline', `No conclusion slide shares key terms with the ${storyline?.throughline.trim() ? 'throughline' : 'brief\'s central message'}. Check that the ending restates what the presentation argues.`, closing.at(-1)!.id);
  }

  const minutes = context.durationMinutes;
  const pace = minutes ? { slides: main.length, minutes, secondsPerSlide: Math.round(minutes * 60 / Math.max(main.length, 1)) } : undefined;
  if (pace && pace.secondsPerSlide < 30) warn('story-pace', `${pace.slides} main slides for ${minutes} minutes leaves about ${pace.secondsPerSlide} s per slide. Consider merging slides or moving detail to backup.`);

  const sections: { name: string; slides: string[] }[] = [];
  for (const slide of slides) {
    const name = slide.section ?? '';
    if (sections.at(-1)?.name === name) sections.at(-1)!.slides.push(slide.id);
    else sections.push({ name, slides: [slide.id] });
  }
  return { framework, throughline, centralMessage: context.centralMessage, locale, pace, sections, slides, issues };
}
export type StoryReport = ReturnType<typeof analyzeStory>;

/** The approved-or-not brief is read only for context; this never approves or edits it. */
function briefContext(raw: unknown): StoryContext {
  const brief = raw as { goal?: { central_message?: unknown }; delivery?: { duration_minutes?: unknown } } | undefined;
  const centralMessage = typeof brief?.goal?.central_message === 'string' && brief.goal.central_message.trim() ? brief.goal.central_message : undefined;
  const minutes = brief?.delivery?.duration_minutes;
  return { centralMessage, durationMinutes: typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : undefined };
}
export async function readStoryline(dir: string): Promise<Storyline | undefined> {
  const file = await safePath(dir, storylinePath);
  if (!(await exists(file))) return undefined;
  const parsed = storylineSchema.safeParse(await readYaml(file));
  if (!parsed.success) throw new Error(`Invalid ${storylinePath}:\n${parsed.error.issues.map(issue => `${issue.path.join('.') || 'storyline'}: ${issue.message}`).join('\n')}`);
  return parsed.data;
}
export async function storyReport(dir: string, config: Project, deck: Deck, locale = config.source_locale) {
  if (!config.output_locales.includes(locale) && locale !== config.source_locale) throw new Error(`Unknown locale ${locale}; choose one of ${config.output_locales.join(', ')}.`);
  const storyline = await readStoryline(dir);
  const report = analyzeStory(deck, config, storyline, briefContext(await readCreatorBrief(dir)), locale);
  return { storyline: storyline ? storylinePath : 'absent', ...report };
}

/** Scaffold a draft storyline from conservative role inferences. Never overwrites. */
export async function initStoryline(dir: string, deck: Deck) {
  const file = await safePath(dir, storylinePath);
  if (await exists(file)) throw new Error(`${storylinePath} already exists; nothing was overwritten.`);
  const storyline = storylineSchema.parse({ version: 1, framework: 'research', throughline: '',
    slides: Object.fromEntries(deck.slides.map((slide, index) => {
      const role = inferRole(slide, index);
      return [slide.id, { ...(role ? { role } : {}), transition: '' }];
    })) });
  await writeYaml(file, storyline);
  return file;
}

const clean = (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
/** A titles-only read-through ("ghost deck") with roles, sections, transitions and flow prompts. */
export function storyMarkdown(project: string, report: Awaited<ReturnType<typeof storyReport>>) {
  const lines = [`# Storyline — ${clean(project)}`, '',
    'Read the titles in order: together they should tell the argument without the slide bodies. Roles marked *(inferred)* come from the layout, not from an editorial decision. The checks below are heuristic prompts for human review; they cannot judge whether the story is sound or whether the evidence supports it.', '',
    `- Framework: ${report.framework}`, `- Throughline: ${clean(report.throughline) || '*(not recorded)*'}`, `- Language: ${clean(report.locale)}`,
    ...(report.pace ? [`- Pace: ${report.pace.slides} main slides in ${report.pace.minutes} min (≈ ${report.pace.secondsPerSlide} s per slide)`] : []), ''];
  for (const section of report.sections) {
    if (section.name) lines.push(`## ${clean(section.name)}`, '');
    for (const id of section.slides) {
      const slide = report.slides.find(s => s.id === id)!;
      lines.push(`${slide.position}. **${clean(slide.title)}** — ${slide.role ? `${slide.role}${slide.inferred ? ' *(inferred)*' : ''}` : '*no role*'} · ${clean(slide.id)} · ${slide.evidence}`);
      if (slide.transition.trim()) lines.push(`   - → ${clean(slide.transition)}`);
    }
    lines.push('');
  }
  lines.push('## Flow review', '');
  if (!report.issues.length) lines.push('No flow prompts. A human reviewer should still read the titles aloud in order.');
  for (const issue of report.issues) lines.push(`- **${issue.severity}** \`${issue.code}\`${issue.slide ? ` (${clean(issue.slide)})` : ''}: ${clean(issue.message)}`);
  return lines.join('\n') + '\n';
}
