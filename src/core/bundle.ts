import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactIssues, inspectArtifacts } from './artifacts.js';
import type { BuildState } from './build.js';
import { hash, hashFile, loadProject, safePath, stamp, within } from './io.js';
import { validateContent, validatePptx } from '../validation/index.js';

type PreviewChoice = 'none' | 'latest';
type BundleOptions = { previews?: PreviewChoice; inputs?: string[] };
type BundleFile = { path: string; sha256: string; bytes: number };

async function addFile(source: string, destination: string, relative: string, files: BundleFile[]) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  const [sourceHash, copyHash, stat] = await Promise.all([hashFile(source), hashFile(destination), fs.stat(destination)]);
  if (sourceHash !== copyHash) throw new Error(`Bundle copy failed verification: ${relative}`);
  files.push({ path: relative.replaceAll('\\', '/'), sha256: copyHash, bytes: stat.size });
}

export async function bundleProject(name: string, options: BundleOptions = {}) {
  const previews = options.previews ?? 'none';
  if (!['none', 'latest'].includes(previews)) throw new Error('Previews must be none or latest.');
  const { dir, config, deck, theme } = await loadProject(name);
  // Draft PPTX builds remain available for inspection. Final delivery is gated.
  const { assertReadyForDelivery } = await import('../review/readiness.js');
  const readiness = await assertReadyForDelivery(name);
  const artifacts = await inspectArtifacts(name);
  const artifactProblems = artifactIssues(artifacts);
  if (artifactProblems.length) throw new Error(artifactProblems.map(issue => `${issue.locale}: ${issue.message}`).join('\n'));
  const state = JSON.parse(await fs.readFile(await safePath(dir, 'output/build-state.json'), 'utf8')) as BuildState;
  const issues = await validateContent(dir, config, deck, theme);
  for (const artifact of artifacts) {
    try { await validatePptx(artifact.file, deck.slides.length); }
    catch (error) { issues.push({ severity: 'error', code: 'pptx', locale: artifact.locale, message: (error as Error).message }); }
  }
  if (issues.some(issue => issue.severity === 'error')) throw new Error(`Bundle validation failed: ${issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('; ')}`);

  const requestedInputs = [...new Set(options.inputs ?? [])];
  const inputFiles: { source: string; relative: string }[] = [];
  for (const input of requestedInputs) {
    const normalized = input.replaceAll('\\', '/');
    if (!normalized.startsWith('inputs/') || normalized.includes('..') || path.isAbsolute(input)) throw new Error(`Explicit input must be a project-relative file under inputs/: ${input}`);
    const source = await safePath(dir, normalized);
    if (!(await fs.stat(source)).isFile()) throw new Error(`Explicit input is not a file: ${input}`);
    inputFiles.push({ source, relative: normalized });
  }

  const previewFiles: { source: string; relative: string; locale: string; renderer: string }[] = [];
  if (previews === 'latest') for (const artifact of artifacts) {
    const latest = await safePath(dir, `output/previews/${artifact.locale}/latest.json`);
    const pointer = JSON.parse(await fs.readFile(latest, 'utf8')) as { folder?: string };
    if (!pointer.folder) throw new Error(`Latest preview is missing for ${artifact.locale}.`);
    const previewRoot = await fs.realpath(await safePath(dir, `output/previews/${artifact.locale}`));
    const projectRoot = await fs.realpath(dir);
    const actualFolder = await fs.realpath(pointer.folder);
    // macOS temp paths may spell the same location as /var or /private/var.
    // Compare canonical paths, then return to project-relative paths for safePath.
    within(previewRoot, path.relative(previewRoot, actualFolder));
    const folder = await safePath(dir, path.relative(projectRoot, actualFolder));
    const reportFile = await safePath(dir, path.relative(dir, path.join(folder, 'render.json')));
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8')) as { pptxSha256?: string; sourceFingerprint?: string; slides?: string[]; renderer?: string };
    if (report.pptxSha256 !== artifact.sha256 || report.sourceFingerprint !== artifact.sourceFingerprint) throw new Error(`Latest preview for ${artifact.locale} is stale. Render again before bundling.`);
    if (!Array.isArray(report.slides) || report.slides.length !== deck.slides.length) throw new Error(`Latest preview slide count is incomplete for ${artifact.locale}.`);
    const pdf = report.renderer === 'powerpoint' ? 'presentation.pdf' : `presentation.${artifact.locale}.pdf`;
    const names = [...report.slides, 'contact-sheet.png', pdf];
    for (const filename of names) {
      if (path.basename(filename) !== filename) throw new Error(`Invalid preview filename: ${filename}`);
      const source = await safePath(dir, path.relative(dir, path.join(folder, filename)));
      if (!(await fs.stat(source)).isFile()) throw new Error(`Preview is missing: ${source}`);
      previewFiles.push({ source, relative: `previews/${artifact.locale}/${filename === pdf ? 'presentation.pdf' : filename}`, locale: artifact.locale, renderer: report.renderer ?? 'unknown' });
    }
  }

  const deliveryRoot = await safePath(dir, 'output/deliveries');
  const identifier = `${stamp()}-${crypto.randomUUID().slice(0, 8)}`;
  const staging = path.join(deliveryRoot, `.staging-${identifier}`);
  const destination = path.join(deliveryRoot, identifier);
  await fs.mkdir(staging, { recursive: true });
  try {
    const files: BundleFile[] = [];
    for (const artifact of artifacts) await addFile(artifact.file, path.join(staging, `presentation.${artifact.locale}.pptx`), `presentation.${artifact.locale}.pptx`, files);
    for (const preview of previewFiles) await addFile(preview.source, path.join(staging, preview.relative), preview.relative, files);
    for (const input of inputFiles) await addFile(input.source, path.join(staging, input.relative), input.relative, files);
    const validation = JSON.stringify({ issues, errors: 0 }, null, 2);
    await fs.writeFile(path.join(staging, 'validation.json'), validation);
    files.push({ path: 'validation.json', sha256: hash(validation), bytes: Buffer.byteLength(validation) });
    const provenance = Object.fromEntries(artifacts.map(artifact => {
      const saved = state.provenance?.[artifact.locale];
      return [artifact.locale, {
        pptxSha256: artifact.sha256,
        sourceFingerprint: artifact.sourceFingerprint,
        authoredFileHashes: saved?.sources ?? {},
        chartSelections: saved?.chartSelections ?? {},
        sources: Object.fromEntries(Object.entries(saved?.sourceRecords ?? {}).map(([id, record]) => [id, { sha256: (record as { sha256: string }).sha256, extractedSha256: (record as { extracted?: { sha256: string } }).extracted?.sha256 }])),
        assets: Object.fromEntries(Object.entries(saved?.assets ?? {}).map(([id, asset]) => [id, { sha256: (asset as { sha256: string }).sha256 }])),
      }];
    }));
    const manifest = { version: 1, project: name, createdAt: new Date().toISOString(), locales: config.output_locales, files, provenance,
      previews: previews === 'latest' ? Object.fromEntries(artifacts.map(a => [a.locale, previewFiles.find(p => p.locale === a.locale)?.renderer])) : {},
      originalInputsIncluded: inputFiles.map(input => input.relative),
      scientificReadiness: {
        status: readiness.status, verdict: readiness.verdict ?? null, revision: readiness.revision ?? null,
        recordSha256: readiness.record_sha256 ?? null, risks: readiness.risks,
        humanOverride: readiness.override ?? null,
        humanApproval: readiness.human_approval ?? null
      },
      visualInspection: 'Not performed by bundling. Review individual preview images before delivery.' };
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await fs.rename(staging, destination);
    return { folder: destination, files: files.length, includedInputs: inputFiles.map(input => input.relative), manifest: path.join(destination, 'manifest.json') };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
