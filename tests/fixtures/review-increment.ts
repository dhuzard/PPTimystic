import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

// Deterministic smoke run with synthetic creator decisions. No agent evaluation or scientific verification.
// Usage: npx tsx tests/fixtures/review-increment.ts EMPTY_OUTPUT_DIR [auto|powerpoint|libreoffice]
const [destination, renderer = 'auto'] = process.argv.slice(2);
if (!destination || !['auto', 'powerpoint', 'libreoffice'].includes(renderer)) throw new Error('Usage: tsx tests/fixtures/review-increment.ts EMPTY_OUTPUT_DIR [renderer]');
const output = path.resolve(destination), repo = process.cwd(), exec = promisify(execFile);
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length) throw new Error('Fixture output directory must be empty; existing artifacts are preserved.');
await fs.cp(path.join(repo, 'config'), path.join(output, 'config'), { recursive: true });
await fs.mkdir(path.join(output, 'src/rendering'), { recursive: true });
await fs.copyFile(path.join(repo, 'src/rendering/powerpoint.ps1'), path.join(output, 'src/rendering/powerpoint.ps1'));
async function cli(...args: string[]) {
  const result = await exec(process.execPath, ['--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href,
    path.join(repo, 'src/cli/index.ts'), ...args], { cwd: output, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  if (args[0] === 'demo') return result.stdout; // demo prints several command results.
  const start = result.stdout.indexOf('{');
  return start < 0 ? result.stdout : JSON.parse(result.stdout.slice(start));
}
const project = 'review-increment', dir = path.join(output, 'projects', project);
const read = async (file: string) => YAML.parse(await fs.readFile(path.join(dir, file), 'utf8'));
const write = async (file: string, value: unknown) => fs.writeFile(path.join(dir, file), YAML.stringify(value));
await cli('demo', '--project', project, '--no-render');
const config = await read('project.yaml');
config.title = 'Scientific review increment — fictional fixture'; config.output_locales = ['en-US'];
await write('project.yaml', config);
const deck = await read('content/slides.yaml');
deck.slides[2].content['en-US'].body = 'NONE is a legitimate outcome';
const sourceText = 'FICTIONAL instructional example: NONE is a legitimate outcome. This example does not report a measured result.';
const sourceHash = createHash('sha256').update(sourceText).digest('hex');
await fs.mkdir(path.join(dir, 'inputs'), { recursive: true });
await fs.mkdir(path.join(dir, 'content/extracted'), { recursive: true });
await fs.writeFile(path.join(dir, 'inputs/review-example.txt'), sourceText);
await fs.writeFile(path.join(dir, 'content/extracted/review-example.txt'), sourceText);
await write('content/sources.yaml', { version: 1, sources: [{ id: 'SRC1', path: 'inputs/review-example.txt', sha256: sourceHash,
  extracted: 'content/extracted/review-example.txt', extracted_sha256: sourceHash }] });
deck.slides[2].source_refs = ['SRC1'];
deck.slides[2].claims = [{ id: 'C001', field: 'body', source_ref: 'SRC1', excerpt: 'NONE is a legitimate outcome', locator: 'Fictional example',
  claim_type: 'illustrative-example', qualification_note: 'Instructional example; no measured result or human verification claimed.' }];
await write('content/slides.yaml', deck);
await write('content/storyline.yaml', { version: 1, framework: 'free', throughline: 'A review may legitimately return NONE.', slides: {
  S002: { role: 'context', explanatory_contract: {
    audience_question: 'What result can a review return?', central_message: 'Review outcomes need an explicit definition.',
    prerequisites: ['review outcome'], introduces: [], worked_example: null, must_preserve: [], success_checks: ['The outcome vocabulary is explained.']
  } },
  S003: { role: 'approach', explanatory_contract: {
    audience_question: 'Must every review propose a change?', central_message: 'NONE is a legitimate outcome',
    introduces: ['review outcome'], prerequisites: [], worked_example: 'A sound slide returns NONE.',
    must_preserve: [{ field: 'body', text: 'NONE is a legitimate outcome' }], success_checks: ['The audience can explain when NONE is appropriate.']
  } }
} });
await cli('build', '--project', project);
const beforeRender = await cli('render', '--project', project, '--locale', 'en-US', '--renderer', renderer);
const prepared = await cli('review', '--project', project, '--mode', 'prepare');
assert.equal(prepared.source_authority.authoritative, true);
const finding = (target: string, text: string) => ({
  category: 'editorial-clarity', severity: 'minor', basis: 'editorial-judgment', confidence: 'high', changes_scientific_meaning: false,
  slide_ids: ['S003'], title: `Fixture ${target} change`, observation: 'Synthetic fixture finding.',
  evidence: { status: 'not-applicable' }, inspected: ['source-yaml'], rationale: 'Exercise the guarded revision workflow.', recommendation: 'Apply the fixture text.',
  proposed_change: { type: 'wording', target, suggested_text: text }, acceptance_criteria: ['The requested field matches the fixture wording.']
});
await write('review/submission.yaml', { kind: 'review', version: 1, agent: { role: 'reviewer', name: 'Deterministic fictional fixture' },
  context_revision: prepared.revision, findings: [finding('title', 'A review can legitimately return NONE'), finding('body', 'Every review must find an error.')] });
await cli('review', '--project', project, '--mode', 'submit');
await cli('review', '--project', project, '--mode', 'configure', '--scope-slides', 'S003', '--scope-classes', 'wording', '--by', 'Fictional fixture creator');
await cli('review', '--project', project, '--mode', 'decide', '--finding', 'REV-001,REV-002', '--decision', 'accept', '--by', 'Fictional fixture creator');
await cli('review', '--project', project, '--mode', 'plan');
const originalSource = await fs.readFile(path.join(dir, 'content/slides.yaml'));
let rejected = false;
try { await cli('review', '--project', project, '--mode', 'apply', '--no-render'); }
catch (error) { rejected = /must preserve/.test(String((error as { stderr?: string }).stderr)); }
assert.ok(rejected, 'The destructive fixture change must be rejected.');
assert.deepEqual(await fs.readFile(path.join(dir, 'content/slides.yaml')), originalSource);
await cli('review', '--project', project, '--mode', 'decide', '--finding', 'REV-002', '--decision', 'reject', '--by', 'Fictional fixture creator');
// Keep the failed manifest and its plan intact; avoid reusing its timestamped plan ID.
await cli('review', '--project', project, '--mode', 'plan');
const applied = await cli('review', '--project', project, '--mode', 'apply', '--renderer', renderer);
assert.deepEqual(applied.changed_slides, ['S003']); assert.deepEqual(applied.validation_errors, []);
const verified = await cli('review', '--project', project, '--mode', 'verify');
const context = JSON.parse(await fs.readFile(path.join(dir, 'review/context.json'), 'utf8'));
assert.equal(context.to_verify[0].original_slides[0].content['en-US'].title, deck.slides[2].content['en-US'].title);
assert.ok(context.storyline.flow_prompts.some((p: { code: string }) => p.code === 'story-prerequisite-order'));
const manifest = await read(path.relative(dir, applied.manifest));
assert.ok(manifest.retained_assets.every((a: { preserved: boolean }) => a.preserved));
const claims = await cli('claims', '--project', project);
assert.equal(claims.claims[0].claim_type, 'illustrative-example'); assert.equal(claims.claims[0].verification_state, 'not-verified');
const result = { fictional: true, project: dir, generated_at: new Date().toISOString(), renderer,
  changed_slide_ids: applied.changed_slides, preserved_assets: manifest.retained_assets, validation_errors: applied.validation_errors,
  preservation_rollback: 'passed', independent_original_snapshot: 'present', prerequisite_order_prompt: 'present',
  claim_type: claims.claims[0].claim_type, claim_verification_state: claims.claims[0].verification_state,
  before_render: beforeRender, after_render: applied.render, verification: verified,
  visual_inspection: 'Not performed by the script; inspect the real PNG previews.',
  scientific_review: 'Not performed. Findings and creator decisions are synthetic test inputs, not agent evaluation.' };
await fs.writeFile(path.join(output, 'qa-manifest.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, manifest: path.join(output, 'qa-manifest.json'), ...result }, null, 2));
