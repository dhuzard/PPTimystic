import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, exists, loadProject, readYaml, safePath, stamp, writeYaml } from '../core/io.js';
import { creatorBriefStatus } from '../core/brief.js';
import { deckSchema, type Deck, type Project } from '../core/model.js';
import { applyRevision } from '../feedback/index.js';
import { readStoryline, storylinePath, storylineSchema, storyFrameworks, storyRoles, storyReport, type StoryIssue, type Storyline } from './index.js';

// Story suggestions are proposals awaiting a human decision. They live beside, not
// inside, the authoritative sources, and only `applySuggestions` turns an accepted
// proposal into a source change (with backups, feedback records and protection checks).
export const suggestionsPath = 'story/suggestions.yaml';
export const reviewPath = 'story/review.md';
const slideId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const text = z.string().trim().min(1).max(2000);
export const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), role: z.enum(storyRoles) }).strict(),
  z.object({ kind: z.literal('section'), section: z.string().trim().min(1).max(80) }).strict(),
  z.object({ kind: z.literal('transition'), text }).strict(),
  z.object({ kind: z.literal('throughline'), text }).strict(),
  z.object({ kind: z.literal('framework'), framework: z.enum(storyFrameworks) }).strict(),
  z.object({ kind: z.literal('title'), text, locale: z.string().optional() }).strict(),
  z.object({ kind: z.literal('message'), text, locale: z.string().optional() }).strict(),
  // Move the slide directly after another slide ID, or to the start when `after` is null.
  z.object({ kind: z.literal('move'), after: slideId.nullable() }).strict(),
  // Anything that needs new authored content or judgment (adding, merging or splitting slides).
  z.object({ kind: z.literal('other'), description: text }).strict()
]);
export const suggestionStatuses = ['proposed', 'discussing', 'accepted', 'rejected', 'applied', 'withdrawn'] as const;
export const suggestionSchema = z.object({
  id: z.string().regex(/^SG-\d{3,}$/),
  origin: z.enum(['analysis', 'story-maker']).default('story-maker'),
  slides: z.array(slideId).default([]),
  issue: z.string().optional(),
  rationale: text,
  change: changeSchema,
  status: z.enum(suggestionStatuses).default('proposed'),
  // human-review shared thread that carries the discussion and the decision.
  thread: z.string().regex(/^t_[A-Za-z0-9_]+$/).optional(),
  decided_at: z.string().datetime().optional()
}).strict().superRefine((value, ctx) => {
  const single = ['transition', 'title', 'message', 'move'].includes(value.change.kind);
  if (single && value.slides.length !== 1) ctx.addIssue({ code: 'custom', message: `${value.change.kind} suggestions target exactly one slide` });
  if (['role', 'section'].includes(value.change.kind) && !value.slides.length) ctx.addIssue({ code: 'custom', message: `${value.change.kind} suggestions target at least one slide` });
});
export const suggestionsFileSchema = z.object({
  version: z.literal(1),
  // The story maker's diagnosis of the current arc and broader ideas, in Markdown.
  notes: z.string().max(20000).default(''),
  suggestions: z.array(suggestionSchema).default([])
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const suggestion of value.suggestions) {
    if (seen.has(suggestion.id)) ctx.addIssue({ code: 'custom', message: `Duplicate suggestion ID ${suggestion.id}` });
    seen.add(suggestion.id);
  }
});
export type Suggestion = z.infer<typeof suggestionSchema>;
export type SuggestionsFile = z.infer<typeof suggestionsFileSchema>;
export type Change = z.infer<typeof changeSchema>;
export type Candidate = { origin: 'analysis'; issue: string; slides: string[]; rationale: string; change: Change | { kind: 'title' | 'transition'; text: '' }; needs_wording: boolean };

export async function readSuggestions(dir: string): Promise<SuggestionsFile> {
  const file = await safePath(dir, suggestionsPath);
  if (!(await exists(file))) return suggestionsFileSchema.parse({ version: 1 });
  const parsed = suggestionsFileSchema.safeParse(await readYaml(file));
  if (!parsed.success) throw new Error(`Invalid ${suggestionsPath}:\n${parsed.error.issues.map(issue => `${issue.path.join('.') || 'suggestions'}: ${issue.message}`).join('\n')}`);
  return parsed.data;
}
export const isOpen = (s: Suggestion) => s.status === 'proposed' || s.status === 'discussing';

/**
 * Deterministic starting points derived from the flow prompts. Structural moves are
 * concrete; wording is left empty for the story maker to write from the sources.
 */
export function candidateSuggestions(report: Awaited<ReturnType<typeof storyReport>>, storyline?: Storyline): Candidate[] {
  const slides = report.slides, ids = slides.map(slide => slide.id);
  const before = (index: number) => index > 0 ? ids[index - 1] : null;
  const candidates: Candidate[] = [];
  const add = (issue: StoryIssue | string, slideIds: string[], rationale: string, change: Candidate['change'], needs_wording = false) =>
    candidates.push({ origin: 'analysis', issue: typeof issue === 'string' ? issue : issue.code, slides: slideIds, rationale, change, needs_wording });
  for (const slide of slides) if (slide.inferred && slide.role && !storyline?.slides[slide.id]?.role) add('story-role-missing', [slide.id], `The ${slide.layout} layout suggests a ${slide.role} role. Recording it makes the story structure explicit.`, { kind: 'role', role: slide.role });
  if (!storyline?.throughline.trim() && report.centralMessage) add('story-throughline', [], 'Start the throughline from the central message in the approved brief.', { kind: 'throughline', text: report.centralMessage });
  const conclusion = slides.findIndex(slide => slide.role === 'conclusion');
  const backup = slides.findIndex(slide => slide.role === 'backup');
  const evidence = slides.findIndex(slide => slide.role === 'evidence');
  const framing = slides.findIndex(slide => slide.role === 'context' || slide.role === 'question');
  for (const issue of report.issues) {
    const index = slides.findIndex(slide => slide.id === issue.slide);
    const slide = slides[index];
    switch (issue.code) {
      case 'story-order':
        if (slide && conclusion >= 0 && index > conclusion && slide.role !== 'backup' && (backup < 0 || index < backup)) add(issue, [slide.id], `Show this ${slide.role} before the conclusion so the take-home message comes last.`, { kind: 'move', after: before(conclusion) });
        else if (slide && backup >= 0 && index > backup) add(issue, [slide.id], 'Keep main slides before the backup material.', { kind: 'move', after: before(backup) });
        else if (slide && index === evidence && framing > evidence) add(issue, [ids[framing]], 'State the context or question before the first evidence slide.', { kind: 'move', after: before(evidence) });
        else if (slide && index === evidence) add(issue, [], 'Add a slide that states the question the evidence answers, using the brief and sources.', { kind: 'other', description: `Add a question slide before ${slide.id}.` });
        break;
      case 'story-bridge': if (slide) add(issue, [slide.id], issue.message, { kind: 'transition', text: '' }, true); break;
      case 'story-topic-shift': if (index > 0) add(issue, [ids[index - 1]], issue.message, { kind: 'transition', text: '' }, true); break;
      case 'story-title': case 'story-certainty': if (slide) add(issue, [slide.id], issue.message, { kind: 'title', text: '' }, true); break;
      case 'story-beat-missing': case 'story-repetition': case 'story-section-split': case 'story-evidence': case 'story-pace': case 'story-opening':
        add(issue, issue.slide ? [issue.slide] : [], issue.message, { kind: 'other', description: issue.message }); break;
    }
  }
  return candidates;
}

const md = (value: unknown) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/[\\`*_[\]|]/g, match => `\\${match}`).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** The text a reviewer sees, which human-review thread quotes must match. */
const plain = (value: string) => value.replace(/\s+/g, ' ').trim();
const token = (s: Suggestion) => `${s.id} · ${s.status}`;
function describe(s: Suggestion, deck: Deck, config: Project) {
  const c = s.change, on = s.slides.join(', ');
  const title = (id: string) => plain(deck.slides.find(slide => slide.id === id)?.content[config.source_locale]?.title ?? id);
  switch (c.kind) {
    case 'role': return `Give ${on} the role ${c.role}.`;
    case 'section': return `Put ${on} in section "${c.section}".`;
    case 'transition': return `Transition from ${on} into the next slide: "${c.text}"`;
    case 'throughline': return `Throughline: "${c.text}"`;
    case 'framework': return `Use the ${c.framework} framework.`;
    case 'title': return `New title for ${on}: "${c.text}"`;
    case 'message': return `New message for ${on}: "${c.text}"`;
    case 'move': return `Move ${on} ${c.after ? `after ${c.after} (${title(c.after)})` : 'to the start'}.`;
    case 'other': return c.description;
  }
}
function protectedSlides(s: Suggestion, deck: Deck) {
  if (!['title', 'message'].includes(s.change.kind)) return [];
  return s.slides.filter(id => { const slide = deck.slides.find(x => x.id === id); return slide && (slide.locked || ['approved', 'locked'].includes(slide.status)); });
}

/** Render the review page and the thread each open suggestion should be posted as. */
export async function writeReview(project: string) {
  const { dir, config, deck } = await loadProject(project);
  const report = await storyReport(dir, config, deck);
  const file = await readSuggestions(dir);
  const destination = await safePath(dir, reviewPath);
  const lines = [`# Story review — ${md(config.title)}`, '',
    '> Accept or reject each suggestion where it appears, select any text to comment or ask the story maker a question, or edit a title directly. Nothing changes in the deck until a suggestion is accepted and applied. Flow prompts are heuristics; whether the story is sound and the evidence supports it remains your judgment.', ''];
  lines.push('## The story maker\'s read', '', file.notes.trim() || '*No notes yet.*', '');
  lines.push('## Throughline', '', report.throughline ? md(report.throughline) : '*Not recorded.*', '',
    `Framework: ${report.framework}${report.pace ? ` · ${report.pace.slides} main slides in ${report.pace.minutes} min (≈ ${report.pace.secondsPerSlide} s per slide)` : ''}`, '');
  lines.push('## Read-through', '');
  for (const section of report.sections) {
    if (section.name) lines.push(`### ${md(section.name)}`, '');
    for (const id of section.slides) {
      const slide = report.slides.find(s => s.id === id)!;
      lines.push(`**${md(slide.title)}**`, '', `${slide.position} · ${md(slide.id)} · ${slide.role ? `${slide.role}${slide.inferred ? ' (inferred)' : ''}` : 'no role'} · ${slide.evidence}`, '');
      if (slide.message.trim()) lines.push(`Message: ${md(slide.message)}`, '');
      if (slide.transition.trim()) lines.push(`→ ${md(slide.transition)}`, '');
    }
  }
  const open = file.suggestions.filter(isOpen), decided = file.suggestions.filter(s => !isOpen(s));
  lines.push('## Suggestions', '');
  if (!open.length) lines.push('*No open suggestions.*', '');
  for (const s of open) {
    const locked = protectedSlides(s, deck);
    lines.push(`- **${token(s)}** — ${md(describe(s, deck, config))} ${md(s.rationale)}${locked.length ? ` *${md(locked.join(', '))} is approved or locked: accepting this suggestion authorizes changing it.*` : ''}`);
  }
  if (decided.length) lines.push('', '### Decided', '', ...decided.map(s => `- ${token(s)} — ${md(describe(s, deck, config))}`));
  lines.push('', '## Flow prompts', '');
  if (!report.issues.length) lines.push('*No flow prompts.*');
  for (const issue of report.issues) lines.push(`- ${issue.code}${issue.slide ? ` (${md(issue.slide)})` : ''}: ${md(issue.message)}`);
  const markdown = lines.join('\n') + '\n';
  await atomicWrite(destination, markdown);

  // Suggest replacements inline where the change rewrites visible text that is unique on
  // the page; otherwise anchor the thread on the suggestion's own status token.
  const rendered = markdown.replace(/\\(.)/g, '$1').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const unique = (quote: string) => Boolean(quote) && rendered.split(quote).length === 2;
  const threads = open.filter(s => !s.thread).map(s => {
    const slide = report.slides.find(x => x.id === s.slides[0]);
    const current = s.change.kind === 'title' ? slide?.title : s.change.kind === 'message' ? slide?.message
      : s.change.kind === 'transition' ? slide?.transition : s.change.kind === 'throughline' ? report.throughline : undefined;
    const quote = current ? plain(current) : '';
    const inline = 'text' in s.change && unique(quote);
    const locked = protectedSlides(s, deck);
    return { suggestion: s.id, quote: inline ? quote : token(s), replacement: inline ? plain((s.change as { text: string }).text) : `${s.id} · accepted`,
      body: `${s.rationale}\n\nAccepting: ${describe(s, deck, config)}${locked.length ? `\n\n${locked.join(', ')} is approved or locked. Accepting this suggestion authorizes changing it.` : ''}` };
  });
  return { file: destination, open: open.length, decided: decided.length, threads,
    ...(open.length ? {} : { warning: 'No open suggestions. The story maker should propose at least one change before opening the review.' }) };
}

/** Apply suggestions a person accepted. Each change is backed up and logged under feedback/. */
export async function applySuggestions(project: string, ids: string[], authorized: string[] = []) {
  const { dir, config, deck } = await loadProject(project);
  const file = await readSuggestions(dir);
  const selected = ids.map(id => {
    const s = file.suggestions.find(x => x.id === id);
    if (!s) throw new Error(`Unknown suggestion ${id}.`);
    if (s.status !== 'accepted') throw new Error(`${id} is ${s.status}. Record the reviewer's acceptance (status: accepted) before applying it.`);
    if (s.change.kind === 'other') throw new Error(`${id} needs authored content. Make the change by hand, then set its status to applied.`);
    for (const slide of s.slides) if (!deck.slides.some(x => x.id === slide)) throw new Error(`${id} targets unknown slide ${slide}.`);
    if (s.change.kind === 'move' && s.change.after && !deck.slides.some(x => x.id === (s.change as { after: string }).after)) throw new Error(`${id} moves after unknown slide ${s.change.after}.`);
    return s;
  });
  const slideText = selected.filter(s => s.change.kind === 'title' || s.change.kind === 'message');
  if (slideText.length && !(await creatorBriefStatus(dir, config)).approved) throw new Error('The creator brief is not approved, so slide wording cannot be changed yet. Storyline suggestions can still be applied.');
  // Check every protected slide before writing anything, so a batch never half-applies.
  const blocked = [...new Set(selected.flatMap(s => protectedSlides(s, deck)))].filter(id => !authorized.includes(id));
  if (blocked.length) throw new Error(`${blocked.join(', ')} approved/locked. Pass --authorize ${blocked.join(',')} only if the reviewer accepted a suggestion that stated this.`);

  const results: { id: string; applied: string }[] = [];
  const at = stamp();
  let storyline: Storyline | undefined;
  let deckChanged = false;
  const nextDeck: Deck = structuredClone(deck);
  for (const s of selected) {
    const c = s.change;
    if (c.kind === 'title' || c.kind === 'message') {
      const locale = c.locale ?? config.source_locale;
      await applyRevision(project, { slide: s.slides[0], locale, category: 'content', message: `Story suggestion ${s.id}: ${s.rationale}`, patch: { [c.kind]: c.text } }, authorized);
    } else if (c.kind === 'move') {
      const index = nextDeck.slides.findIndex(x => x.id === s.slides[0]);
      const [moving] = nextDeck.slides.splice(index, 1);
      nextDeck.slides.splice(c.after ? nextDeck.slides.findIndex(x => x.id === c.after) + 1 : 0, 0, moving);
      deckChanged = true;
    } else {
      storyline ??= await readStoryline(dir) ?? storylineSchema.parse({ version: 1 });
      if (c.kind === 'throughline') storyline.throughline = c.text;
      else if (c.kind === 'framework') storyline.framework = c.framework;
      else for (const id of s.slides) {
        const entry = storyline.slides[id] ?? { transition: '' };
        if (c.kind === 'role') entry.role = c.role;
        if (c.kind === 'section') entry.section = c.section;
        if (c.kind === 'transition') entry.transition = c.text;
        storyline.slides[id] = entry;
      }
    }
    s.status = 'applied'; s.decided_at ??= new Date().toISOString();
    results.push({ id: s.id, applied: describe(s, deck, config) });
  }
  if (deckChanged) {
    const content = await safePath(dir, config.content);
    // Reload so wording revisions applied above are kept; only the order changes here.
    const current = deckSchema.parse(await readYaml(content));
    const order = nextDeck.slides.map(slide => slide.id);
    current.slides.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    await atomicWrite(path.join(dir, `feedback/${at}.story-order-before.yaml`), await fs.readFile(content));
    await writeYaml(content, deckSchema.parse(current));
  }
  if (storyline) {
    const target = await safePath(dir, storylinePath);
    if (await exists(target)) await atomicWrite(path.join(dir, `feedback/${at}.storyline-before.yaml`), await fs.readFile(target));
    await writeYaml(target, storylineSchema.parse(storyline));
  }
  await writeYaml(path.join(dir, `feedback/${at}.story-suggestions.yaml`), { at: new Date().toISOString(), applied: results, authorized });
  await writeYaml(await safePath(dir, suggestionsPath), suggestionsFileSchema.parse(file));
  return { applied: results, next: 'Rebuild to validate the deck. Translations of changed wording are now marked stale and need review.' };
}
