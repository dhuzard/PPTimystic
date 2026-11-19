import { afterAll, beforeAll, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const repo = process.cwd();
let sandbox: string;

async function cli(...args: string[]) {
  try {
    const run = await exec(process.execPath, [
      '--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href,
      path.join(repo, 'src/cli/index.ts'), ...args,
    ], { cwd: sandbox, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, output: run.stdout + run.stderr };
  } catch (error) {
    const run = error as { code: number; stdout: string; stderr: string };
    return { code: run.code, output: run.stdout + run.stderr };
  }
}

beforeAll(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'pptimistic-bundle-test-'));
  await fs.cp(path.join(repo, 'config'), path.join(sandbox, 'config'), { recursive: true });
  expect((await cli('setup', '--yes', '--project', 'delivery', '--no-render')).code).toBe(0);
  await fs.writeFile(path.join(sandbox, 'projects/delivery/inputs/private.txt'), 'PRIVATE FIXTURE CONTENT');
}, 60000);

afterAll(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

test('bundle verifies current PPTX files and excludes original inputs by default', async () => {
  const run = await cli('bundle', '--project', 'delivery');
  expect(run.code).toBe(0);
  const result = JSON.parse(run.output) as { folder: string; manifest: string; includedInputs: string[] };
  const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8')) as {
    files: { path: string; sha256: string }[]; provenance: Record<string, { pptxSha256: string; sourceFingerprint: string; authoredFileHashes: Record<string, string> }>;
    originalInputsIncluded: string[];
  };
  expect(result.includedInputs).toEqual([]);
  expect(manifest.originalInputsIncluded).toEqual([]);
  expect(manifest.files.map(file => file.path).sort()).toEqual(['presentation.en-US.pptx', 'presentation.fr-FR.pptx', 'validation.json']);
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(result.folder, file.path));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
  }
  for (const locale of ['en-US', 'fr-FR']) {
    expect(manifest.provenance[locale].pptxSha256).toBe(manifest.files.find(file => file.path === `presentation.${locale}.pptx`)?.sha256);
    expect(manifest.provenance[locale].sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.provenance[locale].authoredFileHashes['content/slides.yaml']).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(await fs.readdir(result.folder)).not.toContain('inputs');
}, 60000);

test('original input inclusion requires an explicit file path', async () => {
  const rejected = await cli('bundle', '--project', 'delivery', '--input', '../private.txt');
  expect(rejected.code).not.toBe(0);
  expect(rejected.output).toContain('under inputs/');
  const run = await cli('bundle', '--project', 'delivery', '--input', 'inputs/private.txt');
  expect(run.code).toBe(0);
  const result = JSON.parse(run.output) as { folder: string; includedInputs: string[] };
  expect(result.includedInputs).toEqual(['inputs/private.txt']);
  expect(await fs.readFile(path.join(result.folder, 'inputs/private.txt'), 'utf8')).toBe('PRIVATE FIXTURE CONTENT');
}, 60000);

test('latest previews accept PowerPoint and LibreOffice PDF names and verify source hashes', async () => {
  const project = path.join(sandbox, 'projects/delivery');
  const state = JSON.parse(await fs.readFile(path.join(project, 'output/build-state.json'), 'utf8')) as {
    files: Record<string, string>; provenance: Record<string, { sourceFingerprint: string }>;
  };
  for (const [locale, renderer] of [['en-US', 'powerpoint'], ['fr-FR', 'libreoffice']]) {
    const folder = path.join(project, 'output/previews', locale, 'fixture');
    await fs.mkdir(folder, { recursive: true });
    const slides = Array.from({ length: 5 }, (_, i) => `slide-${String(i + 1).padStart(3, '0')}.png`);
    for (const file of [...slides, 'contact-sheet.png', renderer === 'powerpoint' ? 'presentation.pdf' : `presentation.${locale}.pdf`]) await fs.writeFile(path.join(folder, file), `fixture ${file}`);
    await fs.writeFile(path.join(folder, 'render.json'), JSON.stringify({ renderer, pptxSha256: state.files[locale], sourceFingerprint: state.provenance[locale].sourceFingerprint, slides }));
    await fs.writeFile(path.join(project, 'output/previews', locale, 'latest.json'), JSON.stringify({ folder }));
  }
  const run = await cli('bundle', '--project', 'delivery', '--previews', 'latest');
  expect(run.code, run.output).toBe(0);
  const result = JSON.parse(run.output) as { folder: string };
  for (const locale of ['en-US', 'fr-FR']) {
    expect(await fs.readFile(path.join(result.folder, 'previews', locale, 'presentation.pdf'), 'utf8')).toContain('fixture presentation');
    expect((await fs.readdir(path.join(result.folder, 'previews', locale))).filter(file => file.startsWith('slide-'))).toHaveLength(5);
  }
  const stale = JSON.parse(await fs.readFile(path.join(project, 'output/previews/en-US/fixture/render.json'), 'utf8'));
  stale.sourceFingerprint = '0'.repeat(64);
  await fs.writeFile(path.join(project, 'output/previews/en-US/fixture/render.json'), JSON.stringify(stale));
  const rejected = await cli('bundle', '--project', 'delivery', '--previews', 'latest');
  expect(rejected.code).not.toBe(0);
  expect(rejected.output).toContain('stale');
}, 60000);

test('bundle refuses a stale presentation after source content changes', async () => {
  const source = path.join(sandbox, 'projects/delivery/content/slides.yaml');
  const original = await fs.readFile(source);
  try {
    await fs.writeFile(source, original.toString('utf8').replace('PPTimistic', 'PPTimistic revised'));
    const run = await cli('bundle', '--project', 'delivery');
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('older than the current project source');
  } finally { await fs.writeFile(source, original); }
}, 60000);


test('a real-project delivery bundle is blocked without a current scientific readiness gate', async () => {
  const config = path.join(sandbox, 'projects/delivery/project.yaml');
  const original = await fs.readFile(config, 'utf8');
  const real = original.replace('brief_required: false', 'brief_required: true');
  expect(real).not.toBe(original);
  try {
    await fs.writeFile(config, real);
    const run = await cli('bundle', '--project', 'delivery');
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('Scientific Positioning & Readiness Gate blocked delivery');
  } finally {
    await fs.writeFile(config, original);
  }
}, 60000);
