import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { deckSchema, projectSchema, type Deck } from '../src/core/model.js';
import { analyzeStory, keywords, storyMarkdown, storylineSchema, type StoryRole } from '../src/story/index.js';

const config = projectSchema.parse({ version: 1, title: 'Story test', source_locale: 'en-US', output_locales: ['en-US'] });
type Row = { id: string; layout?: string; title: string; message?: string; evidence?: string };
function deck(rows: Row[]): Deck {
  return deckSchema.parse({ version: 1, slides: rows.map(row => ({
    id: row.id, layout: row.layout ?? 'statement', evidence: row.evidence ?? 'conceptual',
    content: { 'en-US': { title: row.title, message: row.message ?? '' } }
  })) });
}
const storyline = (roles: Record<string, StoryRole | [StoryRole, string?, string?]>, extra: Record<string, unknown> = {}) => storylineSchema.parse({
  version: 1, throughline: 'Sleep loss impairs memory consolidation in mice', ...extra,
  slides: Object.fromEntries(Object.entries(roles).map(([id, value]) => {
    const [role, section, transition] = Array.isArray(value) ? value : [value];
    return [id, { role, ...(section ? { section } : {}), ...(transition ? { transition } : {}) }];
  }))
});
const codes = (report: ReturnType<typeof analyzeStory>) => report.issues.map(issue => issue.code);

const coherent = deck([
  { id: 'S001', layout: 'title', title: 'Sleep and memory in mice' },
  { id: 'S002', title: 'Memory consolidation depends on sleep', message: 'Sleep supports memory consolidation.' },
  { id: 'S003', title: 'Does sleep loss impair memory consolidation?', message: 'Memory after deprivation is untested.' },
  { id: 'S004', layout: 'workflow', title: 'Sleep deprivation before memory testing', message: 'Mice were tested after deprivation.' },
  { id: 'S005', title: 'Deprived mice showed lower memory scores', message: 'Memory scores fell after sleep deprivation.', evidence: 'established' },
  { id: 'S006', layout: 'conclusion', title: 'Sleep loss is associated with weaker memory consolidation', message: 'Memory consolidation needs sleep.', evidence: 'interpretation' }
]);

describe('storyline analysis', () => {
  test('a coherent research story produces no flow prompts', () => {
    const report = analyzeStory(coherent, config, storyline({ S001: 'opening', S002: 'context', S003: 'question', S004: 'approach', S005: 'evidence', S006: 'conclusion' }));
    expect(report.issues).toEqual([]);
    expect(report.slides.map(slide => slide.role)).toEqual(['opening', 'context', 'question', 'approach', 'evidence', 'conclusion']);
  });

  test('without a storyline, only conservative layout-based roles are inferred', () => {
    const report = analyzeStory(coherent, config);
    expect(report.slides.map(slide => [slide.role, slide.inferred])).toEqual([
      ['opening', true], [undefined, false], [undefined, false], ['approach', true], [undefined, false], ['conclusion', true]
    ]);
    expect(report.issues.find(issue => issue.code === 'story-role-missing')?.message).toContain('S002, S003, S005');
  });

  test('reports missing beats and evidence shown before the question', () => {
    const report = analyzeStory(coherent, config, storyline({ S001: 'opening', S002: 'evidence', S003: 'evidence', S004: 'approach', S005: 'evidence', S006: 'interpretation' }));
    expect(report.issues.filter(issue => issue.code === 'story-beat-missing').map(issue => issue.message).join(' ')).toMatch(/question.*take-home/s);
    expect(report.issues.find(issue => issue.code === 'story-order')?.slide).toBe('S002');
    const abt = analyzeStory(coherent, config, storyline({ S001: 'opening', S002: 'context', S003: 'question', S004: 'approach', S005: 'evidence', S006: 'conclusion' }, { framework: 'abt' }));
    expect(codes(abt)).not.toContain('story-beat-missing');
  });

  test('flags content after the conclusion and main slides after backup', () => {
    const report = analyzeStory(coherent, config, storyline({ S001: 'opening', S002: 'context', S003: 'question', S004: 'conclusion', S005: 'evidence', S006: 'backup' }));
    expect(report.issues.filter(issue => issue.code === 'story-order').map(issue => issue.slide)).toEqual(['S005']);
    const backup = analyzeStory(coherent, config, storyline({ S001: 'opening', S002: 'context', S003: 'question', S004: 'backup', S005: 'evidence', S006: 'conclusion' }));
    expect(backup.issues.filter(issue => issue.code === 'story-order').map(issue => issue.slide)).toEqual(['S005', 'S006']);
  });

  test('sections must be contiguous and section boundaries need a recorded bridge', () => {
    const report = analyzeStory(coherent, config, storyline({
      S001: ['opening', 'Why'], S002: ['context', 'Why'], S003: ['question', 'Why'],
      S004: ['approach', 'How', 'So we deprived mice of sleep and tested them.'], S005: ['evidence', 'What'], S006: ['conclusion', 'How']
    }));
    expect(report.issues.filter(issue => issue.code === 'story-bridge').map(issue => issue.slide)).toEqual(['S003', 'S005']);
    expect(report.issues.find(issue => issue.code === 'story-section-split')?.slide).toBe('S006');
    expect(report.sections.map(section => section.name)).toEqual(['Why', 'How', 'What', 'How']);
  });

  test('prompts on abrupt topic shifts and repeated titles unless a transition is recorded', () => {
    const jumpy = deck([
      { id: 'A1', title: 'Coral reefs are bleaching faster', message: 'Ocean temperatures are rising.' },
      { id: 'A2', title: 'Budget planning for next year', message: 'Spending categories.' },
      { id: 'A3', title: 'Budget planning for the next year', message: 'Spending categories again.' }
    ]);
    const roles = { A1: 'context', A2: 'question', A3: 'question' } as const;
    const report = analyzeStory(jumpy, config, storyline(roles));
    expect(report.issues.filter(issue => ['story-topic-shift', 'story-repetition'].includes(issue.code)).map(issue => [issue.code, issue.slide])).toEqual([
      ['story-topic-shift', 'A2'], ['story-repetition', 'A3']
    ]);
    const bridged = analyzeStory(jumpy, config, storylineSchema.parse({ version: 1, slides: { A1: { role: 'context', transition: 'Protecting reefs needs funding.' }, A2: { role: 'question' }, A3: { role: 'question' } } }));
    expect(codes(bridged)).not.toContain('story-topic-shift');
  });

  test('flags a conclusion more certain than the evidence that precedes it', () => {
    const overclaim = deck([
      { id: 'C1', title: 'Does sleep loss impair memory?' },
      { id: 'C2', title: 'Memory scores were lower after sleep deprivation', evidence: 'interpretation' },
      { id: 'C3', layout: 'conclusion', title: 'Sleep loss causes memory impairment', evidence: 'established' }
    ]);
    const report = analyzeStory(overclaim, config, storyline({ C1: 'question', C2: 'evidence', C3: 'conclusion' }, { framework: 'free' }));
    expect(report.issues.find(issue => issue.code === 'story-certainty')?.slide).toBe('C3');
  });

  test('flags topic-label titles and endings unrelated to the throughline', () => {
    const labels = deck([
      { id: 'D1', title: 'Why might sleep matter for memory?' },
      { id: 'D2', title: 'Results', evidence: 'established' },
      { id: 'D3', layout: 'conclusion', title: 'Future funding priorities', evidence: 'interpretation' }
    ]);
    const report = analyzeStory(labels, config, storyline({ D1: 'question', D2: 'evidence', D3: 'conclusion' }, { framework: 'free' }));
    expect(report.issues.filter(issue => issue.code === 'story-title').map(issue => issue.slide)).toEqual(['D2', 'D3']);
    expect(report.issues.find(issue => issue.code === 'story-throughline')?.slide).toBe('D3');
  });

  test('uses the brief central message and duration as context', () => {
    const report = analyzeStory(coherent, config, undefined, { centralMessage: 'Sleep loss weakens memory consolidation', durationMinutes: 2 });
    expect(report.throughline).toBe('Sleep loss weakens memory consolidation');
    expect(report.pace).toEqual({ slides: 6, minutes: 2, secondsPerSlide: 20 });
    expect(codes(report)).toContain('story-pace');
    expect(codes(report)).not.toContain('story-throughline');
  });

  test('rejects storyline entries for unknown slides and renders an escaped read-through', () => {
    const report = analyzeStory(coherent, config, storyline({ S001: 'opening', GONE: 'evidence' }));
    expect(report.issues.find(issue => issue.code === 'story-unknown-slide')).toMatchObject({ severity: 'error', slide: 'GONE' });
    const markdown = storyMarkdown('demo', { storyline: 'content/storyline.yaml', ...analyzeStory(deck([{ id: 'X1', title: 'A | B <c>' }]), config) });
    expect(markdown).toContain('A \\| B &lt;c&gt;');
    expect(markdown).toContain('*no role*');
  });

  test('keywords ignore stop words, accents and simple inflection', () => {
    expect([...keywords('The consolidation of memories')]).toEqual(['conso', 'memor']);
    expect(keywords('Mémoire')).toEqual(keywords('memoires'));
  });
});

const exec = promisify(execFile), repo = process.cwd();
let sandbox: string;
async function cli(...args: string[]) {
  try { const r = await exec(process.execPath, ['--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href, path.join(repo, 'src/cli/index.ts'), ...args], { cwd: sandbox, timeout: 60000 }); return { code: 0, output: r.stdout + r.stderr }; }
  catch (e) { const r = e as { code: number; stdout: string; stderr: string }; return { code: r.code, output: r.stdout + r.stderr }; }
}
describe('story command', () => {
  beforeAll(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'pptimistic-story-'));
    await fs.cp(path.join(repo, 'config'), path.join(sandbox, 'config'), { recursive: true });
    expect((await cli('demo', '--project', 'demo', '--no-render')).code).toBe(0);
  }, 60000);
  afterAll(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });
  test('scaffolds a storyline without overwriting it, writes a read-through, and fails on unknown IDs', async () => {
    const storyFile = path.join(sandbox, 'projects/demo/content/storyline.yaml');
    const slidesBefore = await fs.readFile(path.join(sandbox, 'projects/demo/content/slides.yaml'), 'utf8');
    const init = await cli('story', '--project', 'demo', '--init');
    expect(init.code).toBe(0);
    const scaffold = YAML.parse(await fs.readFile(storyFile, 'utf8'));
    expect(scaffold.slides.S001.role).toBe('opening');
    expect(scaffold.slides.S002.role).toBeUndefined();
    expect(await fs.readFile(path.join(sandbox, 'projects/demo/content/slides.yaml'), 'utf8')).toBe(slidesBefore);
    const again = await cli('story', '--project', 'demo', '--init');
    expect(again.code).not.toBe(0);
    expect(again.output).toContain('nothing was overwritten');

    const french = await cli('story', '--project', 'demo', '--locale', 'fr-FR', '--write-markdown');
    expect(french.code).toBe(0);
    const markdown = await fs.readFile(path.join(sandbox, 'projects/demo/output/storyline.md'), 'utf8');
    expect(markdown).toContain('Une idée claire par diapositive');

    scaffold.slides.S999 = { role: 'evidence' };
    await fs.writeFile(storyFile, YAML.stringify(scaffold));
    const broken = await cli('story', '--project', 'demo');
    expect(broken.code).toBe(1);
    expect(broken.output).toContain('story-unknown-slide');
    delete scaffold.slides.S999;
    await fs.writeFile(storyFile, YAML.stringify(scaffold));
  });

  test('suggestion loop: candidates, review page, threads, guarded application', async () => {
    const base = path.join(sandbox, 'projects/demo');
    const analysis = await cli('story', '--project', 'demo');
    const report = JSON.parse(analysis.output.slice(analysis.output.indexOf('{')));
    expect(report.candidates.some((c: { issue: string; change: { kind: string } }) => c.issue === 'story-topic-shift' && c.change.kind === 'transition')).toBe(true);

    const slides = YAML.parse(await fs.readFile(path.join(base, 'content/slides.yaml'), 'utf8'));
    slides.slides.find((s: { id: string }) => s.id === 'S005').status = 'approved';
    await fs.writeFile(path.join(base, 'content/slides.yaml'), YAML.stringify(slides));
    await fs.mkdir(path.join(base, 'story'), { recursive: true });
    const suggestions = { version: 1, notes: 'The arc jumps from method to data without saying *why*.', suggestions: [
      { id: 'SG-001', slides: ['S002'], rationale: 'It frames the problem the deck answers.', change: { kind: 'role', role: 'question' }, status: 'accepted' },
      { id: 'SG-002', slides: ['S002'], rationale: 'Bridge into the workflow.', change: { kind: 'transition', text: 'So how do we get there?' }, status: 'accepted' },
      { id: 'SG-003', slides: ['S004'], rationale: 'Show the data before the method.', change: { kind: 'move', after: 'S002' }, status: 'accepted' },
      { id: 'SG-004', slides: ['S005'], rationale: 'State the take-home message.', change: { kind: 'title', text: 'Start every talk from the evidence' }, status: 'accepted' },
      { id: 'SG-005', slides: ['S003'], rationale: 'Clearer statement.', change: { kind: 'title', text: 'Sources become shared understanding step by step' } },
      { id: 'SG-006', rationale: 'Needs new content.', change: { kind: 'other', description: 'Add a recap slide.' }, status: 'rejected' }
    ] };
    await fs.writeFile(path.join(base, 'story/suggestions.yaml'), YAML.stringify(suggestions));

    const review = await cli('story', '--project', 'demo', '--review');
    expect(review.code).toBe(0);
    const out = JSON.parse(review.output.slice(review.output.indexOf('{')));
    expect(out.open).toBe(1);
    // A title rewrite is suggested inline on the current title; other kinds anchor on their token.
    expect(out.threads).toEqual([expect.objectContaining({ suggestion: 'SG-005', quote: 'From sources to a shared understanding', replacement: 'Sources become shared understanding step by step' })]);
    const page = await fs.readFile(path.join(base, 'story/review.md'), 'utf8');
    expect(page).toContain('**SG-005 · proposed**');
    expect(page).toContain('SG-006 · rejected');
    expect(page).toContain('The arc jumps from method to data');

    const notAccepted = await cli('story', '--project', 'demo', '--apply', 'SG-005');
    expect(notAccepted.code).toBe(1);
    expect(notAccepted.output).toContain('Record the reviewer');
    const blocked = await cli('story', '--project', 'demo', '--apply', 'SG-001,SG-004');
    expect(blocked.code).toBe(1);
    expect(blocked.output).toContain('S005 approved/locked');
    expect(YAML.parse(await fs.readFile(path.join(base, 'content/storyline.yaml'), 'utf8')).slides.S002.role).toBeUndefined();

    const applied = await cli('story', '--project', 'demo', '--apply', 'SG-001,SG-002,SG-003,SG-004', '--authorize', 'S005');
    expect(applied.code).toBe(0);
    const after = YAML.parse(await fs.readFile(path.join(base, 'content/slides.yaml'), 'utf8'));
    expect(after.slides.map((s: { id: string }) => s.id)).toEqual(['S001', 'S002', 'S004', 'S003', 'S005']);
    expect(after.slides[4].content['en-US'].title).toBe('Start every talk from the evidence');
    expect(after.slides[4].content['fr-FR'].title).toBe('Partir des preuves');
    const storyline = YAML.parse(await fs.readFile(path.join(base, 'content/storyline.yaml'), 'utf8'));
    expect(storyline.slides.S002).toMatchObject({ role: 'question', transition: 'So how do we get there?' });
    const saved = YAML.parse(await fs.readFile(path.join(base, 'story/suggestions.yaml'), 'utf8'));
    expect(saved.suggestions.map((s: { status: string }) => s.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'proposed', 'rejected']);
    const feedback = await fs.readdir(path.join(base, 'feedback'));
    expect(feedback.some(name => name.endsWith('.story-order-before.yaml'))).toBe(true);
    expect(feedback.some(name => name.endsWith('.storyline-before.yaml'))).toBe(true);
  });
});
