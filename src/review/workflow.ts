import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { atomicWrite, exists, hash, hashFile, loadProject, readYaml, safePath, stamp, writeYaml } from '../core/io.js';
import { creatorBriefStatus } from '../core/brief.js';
import { buildProject } from '../core/build.js';
import { inspectArtifacts } from '../core/artifacts.js';
import type { Deck } from '../core/model.js';
import { validateContent } from '../validation/index.js';
import { translationFreshness } from '../localization/index.js';
import { applyRevision } from '../feedback/index.js';
import { readStoryline, storylinePath } from '../story/index.js';
import { applyStructureChanges } from '../story/review.js';
import { assertNoActiveSession } from '../session/lease.js';
import { currentPreviews, deckRevision, inspectSourceAuthority, prepareContext, readSources, sourceTexts } from './context.js';
import { decide, emptyLedger, mergeSubmission, slideFingerprint, workflowStatus, type Decision } from './ledger.js';
import { buildPlan, targetValue } from './plan.js';
import { autonomousEligible, revisionRestriction } from './policy.js';
import { assertExplanatoryContracts } from './contracts.js';
import { reviewMarkdown, reviewThreads } from './report.js';
import {
  autonomousClasses, contextPath, ledgerPath, ledgerSchema, manifestDir, planPath, planSchema, reportPath, revisionScopeSchema,
  type Ledger, type Plan, type PlanItem
} from './schema.js';

export async function readLedger(dir: string): Promise<Ledger> {
  const file = await safePath(dir, ledgerPath);
  if (!await exists(file)) return emptyLedger();
  const raw = await readYaml(file);
  // Legacy records remain readable but are never eligible for autonomous meaning changes.
  if (Array.isArray(raw?.findings)) for (const finding of raw.findings)
    if (finding && finding.changes_scientific_meaning === undefined) finding.changes_scientific_meaning = true;
  const parsed = ledgerSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${ledgerPath}:\n${parsed.error.issues.map(i => `${i.path.join('.') || 'ledger'}: ${i.message}`).join('\n')}`);
  return parsed.data;
}
async function writeLedger(dir: string, ledger: Ledger) {
  const file = await safePath(dir, ledgerPath);
  // Keep the previous ledger so review history survives an interrupted or mistaken write.
  if (await exists(file)) await atomicWrite(await safePath(dir, `review/history/${stamp()}-${crypto.randomUUID().slice(0, 8)}.ledger.yaml`), await fs.readFile(file));
  await writeYaml(file, ledgerSchema.parse(ledger));
}

/** BUILD → REVIEW: write the context the reviewer works from, plus a submission template. */
export async function prepare(project: string) {
  const { dir } = await loadProject(project);
  const ledger = await readLedger(dir);
  const context = await prepareContext(project, ledger);
  await atomicWrite(await safePath(dir, contextPath), JSON.stringify(context, null, 2));
  const template = await safePath(dir, 'review/submission.template.yaml');
  await writeYaml(template, { kind: 'review', version: 1, agent: { role: 'reviewer', name: 'Scientific presentation expert', model: '<model id>' },
    context_revision: context.revision, assessment: null, rendered_previews_viewed: [], findings: [], slide_assessments: [], verifications: [], withdraw: [], anticipated_questions: [] });
  return { context: path.join(dir, contextPath), template, revision: context.revision, round: context.next_review_round,
    previews: context.previews, source_authority: context.source_authority, brief_approved: context.brief.approved, to_verify: context.to_verify.map(f => f.id),
    next: 'The reviewer reads review/context.json and the role definitions, writes review/submission.yaml, then runs review --mode submit.' };
}

/** REVIEW (or builder notes) → ledger. Validated against the current deck; all or nothing. */
export async function submit(project: string, file: string) {
  const { dir, config, deck } = await loadProject(project);
  const raw = YAML.parse(await fs.readFile(path.resolve(file), 'utf8'));
  if (raw?.kind === 'review') {
    const authority = await inspectSourceAuthority(project, deck);
    if (!authority.authoritative) throw new Error(`Scientific review blocked: ${authority.issues.map(i => i.message).join('\n')}`);
  }
  const records = await readSources(dir);
  const previews = await currentPreviews(project, dir, config.source_locale);
  const ledger = await readLedger(dir);
  const merged = mergeSubmission(ledger, raw, {
    deck, config, revision: await deckRevision(dir, config), sources: await sourceTexts(dir, records),
    currentPreviews: new Set(previews.current ? Object.keys(previews.slides) : []), storyline: await readStoryline(dir)
  });
  // Archive the exact submission for provenance.
  await atomicWrite(await safePath(dir, `review/submissions/${stamp()}-${(raw?.kind ?? 'unknown')}.yaml`), YAML.stringify(raw));
  await writeLedger(dir, merged.ledger);
  return { ...merged.result, status: workflowStatus(merged.ledger, deck) };
}

export async function report(project: string) {
  const { dir, config, deck } = await loadProject(project);
  const ledger = await readLedger(dir);
  const destination = await safePath(dir, reportPath);
  await atomicWrite(destination, reviewMarkdown(ledger, deck, config));
  const threads = reviewThreads(ledger, deck, config);
  return { file: destination, threads, status: workflowStatus(ledger, deck) };
}

export async function recordDecision(project: string, ids: string[], decision: Decision, by: string, options: { note?: string; authorize?: string[] }) {
  const { dir, config, deck } = await loadProject(project);
  const ledger = decide(await readLedger(dir), ids, decision, by, deck, { ...options, sourceLocale: config.source_locale });
  if (decision === 'accept') for (const id of ids) {
    const finding = ledger.findings.find(f => f.id === id)!;
    await atomicWrite(await safePath(dir, `review/originals/${id}.json`), JSON.stringify({
      decided_at: finding.decision!.at,
      slides: deck.slides.filter(s => !finding.slide_ids.length || finding.slide_ids.includes(s.id))
    }, null, 2));
  }
  await writeLedger(dir, ledger);
  return { decided: ids, decision, status: workflowStatus(ledger, deck) };
}

export async function linkThread(project: string, id: string, thread: string) {
  const { dir } = await loadProject(project);
  const ledger = await readLedger(dir);
  const finding = ledger.findings.find(f => f.id === id);
  if (!finding) throw new Error(`Unknown finding ${id}.`);
  finding.thread = thread;
  await writeLedger(dir, ledgerSchema.parse(ledger));
  return { finding: id, thread };
}

export async function configure(project: string, settings: { workflow?: Ledger['settings']['workflow']; maxRounds?: number; classes?: string[]; scope?: Ledger['settings']['revision_scope']; by: string }) {
  const { dir, deck } = await loadProject(project);
  const ledger = await readLedger(dir);
  const classes = settings.classes ?? ledger.settings.autonomous_classes;
  for (const c of classes) if (!(autonomousClasses as readonly string[]).includes(c)) throw new Error(`Autonomous change classes are limited to ${autonomousClasses.join(', ')}. Scientific wording, evidence, data, citations and storyline always need a per-finding decision.`);
  const scope = settings.scope ? revisionScopeSchema.parse(settings.scope) : ledger.settings.revision_scope;
  for (const id of scope?.slide_ids ?? []) if (!deck.slides.some(s => s.id === id)) throw new Error(`Unknown scope slide ${id}.`);
  ledger.settings = { ...ledger.settings, ...(settings.workflow ? { workflow: settings.workflow } : {}), ...(settings.maxRounds ? { max_rounds: settings.maxRounds } : {}),
    autonomous_classes: classes as Ledger['settings']['autonomous_classes'], revision_scope: scope, configured_by: settings.by, configured_at: new Date().toISOString() };
  ledger.history.push({ at: new Date().toISOString(), event: 'settings-changed', actor: `creator:${settings.by}`, detail: JSON.stringify(ledger.settings) });
  await writeLedger(dir, ledgerSchema.parse(ledger));
  return ledger.settings;
}

/** PLAN: turn accepted (or explicitly opted-in) findings into a checkable revision plan. */
export async function plan(project: string) {
  const { dir, config, deck } = await loadProject(project);
  const ledger = await readLedger(dir);
  const result = buildPlan({ ledger, deck, config, storyline: await readStoryline(dir), revision: await deckRevision(dir, config), briefApproved: (await creatorBriefStatus(dir, config)).approved });
  await writeYaml(await safePath(dir, planPath), result);
  return { file: path.join(dir, planPath), id: result.id, ready: result.items.filter(i => i.status === 'ready').map(i => i.finding),
    blocked: result.items.filter(i => i.status === 'blocked').map(i => ({ finding: i.finding, reason: i.reason })), deferred: result.deferred,
    translation_review: [...new Set(result.items.flatMap(i => i.translation_review))] };
}

type ChangeRecord = { finding: string; slide: string; kind: string; target: string; before: unknown; after: unknown; before_sha256: string; after_sha256: string; feedback_record?: string };
const category = (item: PlanItem) => ['scientific-validity', 'evidence-provenance'].includes(item.category) ? 'scientific-correction' as const
  : ['layout', 'object-geometry'].includes(item.change.type) ? 'layout' as const : 'content' as const;
const describeTarget = (item: PlanItem) => item.change.type === 'wording' ? item.change.target : item.change.type === 'object-geometry' ? item.change.object : item.change.type === 'storyline' ? item.change.change.kind : item.change.type;
function acceptedAssets(deck: Deck) {
  return deck.slides.flatMap(slide => [
    ...(slide.visual?.accepted && slide.visual.asset ? [{ slide: slide.id, path: slide.visual.asset }] : []),
    ...(slide.objects ?? []).filter(o => o.type === 'image' && o.accepted && o.asset).map(o => ({ slide: slide.id, path: o.asset! }))
  ]);
}

/** REVISE → VALIDATE → RENDER. All-or-nothing: a failed revision or build restores the previous source. */
export async function apply(project: string, options: { render?: boolean; renderer?: string } = {}) {
  await assertNoActiveSession(project);
  const { dir, config, deck } = await loadProject(project);
  const ledger = await readLedger(dir);
  const planFile = await safePath(dir, planPath);
  if (!await exists(planFile)) throw new Error('No revision plan. Run review --mode plan first.');
  const current: Plan = planSchema.parse(await readYaml(planFile));
  if (ledger.settings.workflow === 'review-only') throw new Error('This review runs in review-only mode; revisions are blocked.');
  if (!(await creatorBriefStatus(dir, config)).approved) throw new Error('The creator brief is not approved, so revisions and builds are blocked.');
  if (ledger.revision_rounds >= ledger.settings.max_rounds) throw new Error(`Iteration limit reached (${ledger.settings.max_rounds} revision rounds).`);
  if (current.round !== ledger.revision_rounds + 1) throw new Error('This plan belongs to an earlier revision round. Run review --mode plan again.');
  const ready = current.items.filter(i => i.status === 'ready');
  if (!ready.length) throw new Error('Nothing in the plan is ready to apply. Resolve blocked items with the creator, or run review --mode plan again.');
  const storyline = await readStoryline(dir);
  const conflicts: string[] = [];
  for (const item of ready) {
    const f = ledger.findings.find(x => x.id === item.finding);
    if (!f) { conflicts.push(`${item.finding} no longer exists.`); continue; }
    const restriction = revisionRestriction(f, ledger, deck);
    if (restriction) conflicts.push(`${f.id}: ${restriction}`);
    if (JSON.stringify(item.slides) !== JSON.stringify(f.slide_ids) || item.category !== f.category) conflicts.push(`${f.id}: plan targets changed.`);
    if (item.approval === 'creator-accepted' && (!['accepted', 'unresolved'].includes(f.status) || f.decision?.at !== item.decided_at)) conflicts.push(`${f.id} was decided again after planning (${f.status}).`);
    if (item.approval === 'autonomous-policy' && !autonomousEligible(f, ledger, deck)) conflicts.push(`${f.id} is no longer eligible for autonomous revision.`);
    if (JSON.stringify(f.proposed_change) !== JSON.stringify(item.change)) conflicts.push(`${f.id} changed after planning.`);
    if (hash(JSON.stringify(targetValue(item.change, item.slides, deck, storyline, config) ?? null)) !== item.target_sha256) conflicts.push(`${f.id}: ${item.slides.join(', ')} ${describeTarget(item)} changed after planning; newer edits are never overwritten.`);
  }
  if (conflicts.length) throw new Error(`Plan is stale; nothing was changed:\n${conflicts.join('\n')}\nRun review --mode plan again.`);

  const at = stamp();
  const contentFile = await safePath(dir, config.content), storyFile = await safePath(dir, storylinePath);
  const snapshot = { content: await fs.readFile(contentFile), storyline: await exists(storyFile) ? await fs.readFile(storyFile) : undefined };
  const before = { revision: await deckRevision(dir, config), content_sha256: hash(snapshot.content), storyline_sha256: snapshot.storyline ? hash(snapshot.storyline) : null };
  const authorized = [...new Set(ready.flatMap(i => i.authorization === 'recorded' ? i.protected_slides : []))];
  const manifestName = `${manifestDir}/${current.id}.manifest.yaml`;
  const changes: ChangeRecord[] = [];
  const translationReview: Record<string, string[]> = {};
  let build: Awaited<ReturnType<typeof buildProject>> | undefined;
  let skippedLocales: string[] = [];
  try {
    // The original contract is the baseline even if a revision also edits storyline metadata.
    await assertExplanatoryContracts(dir, config, deck, (await loadProject(project)).theme, storyline);
    for (const item of ready) {
      const slide = item.slides[0];
      const message = `Scientific review ${item.finding} (${current.id})`;
      const c = item.change;
      const beforeValue = targetValue(c, item.slides, (await loadProject(project)).deck, await readStoryline(dir), config);
      let record: string | undefined;
      if (c.type === 'wording') record = (await applyRevision(project, { slide, locale: c.locale ?? config.source_locale, category: category(item), message, patch: { [c.target]: c.suggested_text! } }, authorized)).record;
      else if (c.type === 'evidence-class') record = (await applyRevision(project, { slide, category: category(item), message, evidence: c.evidence }, authorized)).record;
      else if (c.type === 'layout') record = (await applyRevision(project, { slide, category: category(item), message, layout: c.layout }, authorized)).record;
      else if (c.type === 'object-geometry') record = (await applyRevision(project, { slide, category: category(item), message, visual_objects: { [c.object]: c.override } }, authorized)).record;
      else if (c.type === 'storyline') await applyStructureChanges(project, [{ slides: item.slides, change: c.change }], at);
      const afterValue = targetValue(c, item.slides, (await loadProject(project)).deck, await readStoryline(dir), config);
      changes.push({ finding: item.finding, slide: item.slides.join(',') || 'deck', kind: c.type, target: describeTarget(item), before: beforeValue, after: afterValue,
        before_sha256: hash(JSON.stringify(beforeValue ?? null)), after_sha256: hash(JSON.stringify(afterValue ?? null)), ...(record ? { feedback_record: record } : {}) });
      for (const locale of item.translation_review) (translationReview[locale] ??= []).push(slide);
    }
    // Build every locale whose translations are current; otherwise only the source language,
    // and report the others for translation review instead of exporting stale wording.
    const revised = (await loadProject(project)).deck;
    await assertExplanatoryContracts(dir, config, revised, (await loadProject(project)).theme, storyline);
    skippedLocales = config.output_locales.filter(l => l !== config.source_locale && revised.slides.some(s => s.content[l] && translationFreshness(s, config.source_locale, l).state === 'stale'));
    build = await buildProject(project, { ...(skippedLocales.length ? { locale: config.source_locale } : {}), authorize: authorized });
  } catch (error) {
    // Restore the source exactly as it was; keep the failed state for diagnosis.
    await atomicWrite(path.join(dir, `feedback/${at}.review-failed-attempt.yaml`), await fs.readFile(contentFile));
    await atomicWrite(contentFile, snapshot.content);
    if (snapshot.storyline) await atomicWrite(storyFile, snapshot.storyline); else await fs.rm(storyFile, { force: true });
    const message = (error as Error).message;
    const failed = ledgerSchema.parse(ledger);
    for (const item of ready) { const f = failed.findings.find(x => x.id === item.finding); if (f) f.last_error = message.slice(0, 4000); }
    failed.history.push({ at: new Date().toISOString(), event: 'revision-rolled-back', actor: 'builder', detail: `${current.id}: ${message}`.slice(0, 4000) });
    await writeYaml(await safePath(dir, manifestName), { version: 1, plan: current.id, outcome: 'rolled-back', at: new Date().toISOString(), before, attempted: changes, error: message,
      note: 'Every source change in this attempt was reverted. Findings stay accepted; fix the cause (for example shorten wording that overflowed) and plan again.' });
    await writeLedger(dir, failed);
    throw new Error(`Revision failed and was rolled back; the source is unchanged.\n${message}`);
  }

  const after = await loadProject(project);
  const changedSlides = after.deck.slides.filter(s => { const old = deck.slides.find(x => x.id === s.id); return !old || slideFingerprint(old) !== slideFingerprint(s); }).map(s => s.id);
  const orderChanged = JSON.stringify(deck.slides.map(s => s.id)) !== JSON.stringify(after.deck.slides.map(s => s.id));
  const issues = await validateContent(after.dir, after.config, after.deck, after.theme);
  const artifacts = await inspectArtifacts(project);
  const assets = await Promise.all(acceptedAssets(deck).map(async asset => {
    const kept = acceptedAssets(after.deck).some(a => a.slide === asset.slide && a.path === asset.path);
    const file = await safePath(dir, asset.path);
    return { ...asset, sha256: await exists(file) ? await hashFile(file) : '<missing>', preserved: kept };
  }));
  let render: Record<string, unknown> = { requested: false, note: 'Rendering skipped (--no-render). Visual changes are unverified until previews are rendered and viewed.' };
  if (options.render !== false) {
    try {
      const { renderProject } = await import('../rendering/index.js');
      const result = await renderProject(project, config.source_locale, options.renderer ?? 'auto');
      const previews = result.available ? await currentPreviews(project, dir, config.source_locale) : undefined;
      render = { requested: true, available: result.available, message: result.message, folders: result.folders.map(f => path.relative(dir, f).split(path.sep).join('/')),
        comparisons: previews?.current ? Object.fromEntries(changedSlides.map(id => [id, previews.slides[id]])) : {},
        visual_inspection: 'Not performed by the builder. The re-review must view the images before judging visual findings.' };
    } catch (error) { render = { requested: true, available: false, error: (error as Error).message }; }
  }
  const manifest = {
    version: 1, plan: current.id, outcome: 'applied', at: new Date().toISOString(), round: current.round, workflow: current.workflow,
    before, after: { revision: await deckRevision(dir, config), content_sha256: await hashFile(contentFile), storyline_sha256: await exists(storyFile) ? await hashFile(storyFile) : null },
    changes, original_slides: deck.slides, changed_slides: changedSlides, order_changed: orderChanged, authorized_slides: authorized,
    deviations: current.items.filter(i => i.status !== 'ready').map(i => ({ finding: i.finding, reason: i.reason })).concat(current.deferred),
    retained_assets: assets, translation_review_required: translationReview,
    build: { id: build.report.buildId, files: build.files.map(f => path.relative(dir, f).split(path.sep).join('/')), changed_slides: build.report.changedSlides,
      locales_not_built: skippedLocales.map(locale => ({ locale, reason: 'Translations are stale; review them (npm run translate) before exporting this language.' })) },
    validation: { errors: issues.filter(i => i.severity === 'error').map(({ code, slide, locale, message }) => ({ code, slide, locale, message })),
      warnings: issues.filter(i => i.severity === 'warning').length,
      artifacts: artifacts.map(({ locale, status }) => ({ locale, status })),
      note: skippedLocales.length ? 'translation-stale errors for locales listed under build.locales_not_built are expected until those translations are reviewed.' : '' },
    render
  };
  await writeYaml(await safePath(dir, manifestName), manifest);
  await fs.rename(planFile, await safePath(dir, `${manifestDir}/${current.id}.plan.yaml`));
  const nowIso = new Date().toISOString();
  for (const item of ready) {
    const f = ledger.findings.find(x => x.id === item.finding)!;
    if (item.approval === 'autonomous-policy') f.decision = { decision: 'accept', by: `autonomous policy (${ledger.settings.configured_by ?? 'creator opt-in'})`, at: nowIso, authorized_slides: [], slide_fingerprints: {} };
    f.status = 'applied'; f.applied = { manifest: manifestName, round: current.round, at: nowIso }; f.last_error = undefined; f.updated_at = nowIso;
  }
  ledger.revision_rounds = current.round;
  ledger.history.push({ at: nowIso, event: 'revision-applied', actor: 'builder', detail: `${current.id}: ${ready.map(i => i.finding).join(', ')}; changed ${changedSlides.join(', ') || 'order only'}` });
  await writeLedger(dir, ledger);
  const blockingErrors = manifest.validation.errors.filter(e => !(e.code === 'translation-stale' && e.locale && skippedLocales.includes(e.locale)));
  return { manifest: path.join(dir, manifestName), applied: ready.map(i => i.finding), changed_slides: changedSlides, translation_review_required: translationReview,
    validation_errors: blockingErrors, render, status: workflowStatus(ledger, after.deck) };
}

/** VALIDATE → RE-REVIEW: check the latest manifest against the actual source, then prepare the re-review. */
export async function verify(project: string) {
  const { dir, config, deck } = await loadProject(project);
  const folder = await safePath(dir, manifestDir);
  const files = await exists(folder) ? (await fs.readdir(folder)).filter(f => f.endsWith('.manifest.yaml')).sort() : [];
  const storyline = await readStoryline(dir);
  let latest: { file: string; changes: { finding: string; after_sha256: string; present: boolean }[] } | undefined;
  for (const file of files.reverse()) {
    const manifest = await readYaml(path.join(folder, file)) as { outcome: string; changes: ChangeRecord[] };
    if (manifest.outcome !== 'applied') continue;
    const ledger = await readLedger(dir);
    latest = { file: `${manifestDir}/${file}`, changes: manifest.changes.map(change => {
      const finding = ledger.findings.find(f => f.id === change.finding);
      const now = finding ? hash(JSON.stringify(targetValue(finding.proposed_change, finding.slide_ids, deck, storyline, config) ?? null)) : '';
      return { finding: change.finding, after_sha256: change.after_sha256, present: now === change.after_sha256 };
    }) };
    break;
  }
  const artifacts = (await inspectArtifacts(project)).map(({ locale, status }) => ({ locale, status }));
  const prepared = await prepare(project);
  return { manifest: latest?.file ?? null, changes: latest?.changes ?? [], changed_since_apply: latest?.changes.filter(c => !c.present).map(c => c.finding) ?? [],
    artifacts, previews: prepared.previews, to_verify: prepared.to_verify, context: prepared.context,
    next: prepared.to_verify.length ? 'The reviewer independently re-reviews the to_verify findings from the current source and previews, and submits verifications (and any regressions as new findings).' : 'Nothing awaits re-review.' };
}

export async function status(project: string) {
  const { dir, deck } = await loadProject(project);
  return workflowStatus(await readLedger(dir), deck);
}
