import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import YAML from 'yaml';
import { z } from 'zod';
import { atomicWrite, exists, hash, hashFile, loadProject, safePath, stamp } from '../core/io.js';
import { customObjectSchema, deckSchema, nativeTextRunSchema, slideSchema, visualObjectOverrideSchema, type Slide } from '../core/model.js';
import { importPptxScene, type PptxEdit, type PptxRun, type PptxScene } from './pptx-native.js';
import { buildSlideScene, type SceneObject, type SlideScene } from '../core/scene.js';
import { buildProject, fingerprints, loadProtectionBaseline, protectionIssues } from '../core/build.js';
import { renderProject } from '../rendering/index.js';
import { validateGeometry } from '../layouts/index.js';
import { validateContent } from '../validation/index.js';
import { creatorBriefStatus } from '../core/brief.js';
import { consistency, translationSourceFingerprint } from '../localization/index.js';
import { commentSchema, operationSchema, textKey, textUpdateSchema, type Actor, type AgentJob, type Comment, type HistoryEntry, type ObjectLock, type Operation, type Presence, type ReferencePreview, type SessionSnapshot } from './contracts.js';

export class SessionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function fail(status: number, message: string): never { throw new SessionError(status, message); }
interface StoredHistory extends HistoryEntry { before: Slide; after: Slide; authorized: string[] }
interface Metadata { version: 1; revision: number; sourceHash: string; sourceAssetsHash?: string; comments: Comment[]; jobs: AgentJob[]; history: StoredHistory[]; authorized: string[] }
interface TextDocument { doc: Y.Doc; generation: string; value: string }
type LoadedProject = Awaited<ReturnType<typeof loadProject>>;
const MAX_TEXT = 100_000;
const protectedStatus = (value?: string) => value === 'approved' || value === 'locked';
const cleanActor = (actor: Actor): Actor => ({ id: actor.id, name: actor.name, role: actor.role });
const refPath = z.string().regex(/^output\/reference\/[A-Za-z0-9._-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const normalizeNativeText = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();
const nativeText = (runs: PptxRun[]) => runs.map((run, i) => `${i && run.paragraph !== runs[i-1].paragraph ? '\n' : ''}${run.text}`).join('');
const inputPptx=z.string().max(1024).refine(value=>value.startsWith('inputs/') && !/[\\:\u0000-\u001f]/.test(value) && value.split('/').every(part=>part!=='.'&&part!=='..'&&part!=='') && /\.pptx$/i.test(value),'Use a project-relative PowerPoint under inputs/.');
const referenceSchema = z.object({version:z.literal(1),source:inputPptx,sourceSha256:digest,locale:z.string(),slides:z.array(z.object({
  id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),image:refPath,sha256:digest,
  shapes:z.array(z.object({id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*:ref-\d+$/),label:z.string().max(200),kind:z.enum(['text','shape','image','video']),x:z.number().nonnegative(),y:z.number().nonnegative(),w:z.number().nonnegative(),h:z.number().nonnegative()}).strict()).optional(),
  video:z.object({file:refPath,sha256:digest,poster:refPath,posterSha256:digest,x:z.number().nonnegative(),y:z.number().nonnegative(),w:z.number().positive(),h:z.number().positive()}).strict().optional()
}).strict())}).strict();

/** A single writer owns YAML. Session metadata is a recoverable journal, never the slide authority. */
export class SessionStore extends EventEmitter {
  loaded!: LoadedProject;
  metadata!: Metadata;
  agentConfigured = false;
  private queue: Promise<unknown> = Promise.resolve();
  private docs = new Map<string, TextDocument>();
  private scenes = new Map<string, SlideScene>();
  private issueCache?: { revision: number; issues: SessionSnapshot['issues'] };
  private changed = new Map<string, number>();
  private presence = new Map<string, Presence>();
  private locks = new Map<string, ObjectLock>();
  private file = '';
  private configHash = '';
  private themeHash = '';
  private reference?: z.infer<typeof referenceSchema>;
  private referenceHash?: string;
  private nativeScene?: PptxScene;
  private nativePreviews = new Map<string, { fingerprint: string; revision: number; status: 'current'|'failed'; error?: string }>();
  constructor(public project: string) { super(); }
  run<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(task);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  async initialize() {
    this.loaded = await loadProject(this.project);
    const refFile=await safePath(this.loaded.dir,'content/reference-preview.json');
    if(await exists(refFile)) {
      this.referenceHash = await hashFile(refFile);
      this.reference=referenceSchema.parse(JSON.parse(await fs.readFile(refFile,'utf8')));
      if(await hashFile(await safePath(this.loaded.dir,this.reference.source))!==this.reference.sourceSha256) fail(409,'The reference PowerPoint has changed. Recreate its preview before opening this session.');
      if(new Set(this.reference.slides.map(s=>s.id)).size!==this.reference.slides.length || this.reference.slides.some(s=>!this.loaded.deck.slides.some(slide=>slide.id===s.id) || s.shapes?.some((shape,index)=>shape.id!==`${s.id}:ref-${index+1}`))) fail(400,'Reference preview slide or object IDs do not match this project.');
    }
    this.file = await safePath(this.loaded.dir, this.loaded.config.content);
    const current = await hashFile(this.file);
    const assetsHash = await this.assetSignature(this.loaded);
    const state = await safePath(this.loaded.dir, '.session/state.json');
    this.metadata = await exists(state) ? JSON.parse(await fs.readFile(state, 'utf8')) : {
      version: 1, revision: 0, sourceHash: current, sourceAssetsHash: assetsHash, comments: [], jobs: [], history: [], authorized: [],
    };
    if (this.metadata.version !== 1) fail(500, 'Unsupported session journal version.');
    const pending = await safePath(this.loaded.dir, '.session/pending.json');
    if (await exists(pending)) {
      const transaction = JSON.parse(await fs.readFile(pending, 'utf8')) as { hash: string; metadata: Metadata };
      if (current === transaction.hash) this.metadata = transaction.metadata;
      await fs.unlink(pending);
    }
    if (this.metadata.sourceHash !== current || this.metadata.sourceAssetsHash !== assetsHash) { this.metadata.revision++; this.metadata.authorized = []; }
    this.metadata.sourceHash = current; this.metadata.sourceAssetsHash = assetsHash;
    this.changed.set('*', this.metadata.revision);
    for (const job of this.metadata.jobs) if (job.status === 'running') { job.status = 'failed'; job.error = 'Session restarted during agent execution. Retry explicitly.'; }
    this.configHash = await hashFile(await safePath(this.loaded.dir, 'project.yaml'));
    this.themeHash = hash(JSON.stringify(this.loaded.theme));
    await this.persist();
  }
  private async persist() {
    await atomicWrite(await safePath(this.loaded.dir, '.session/state.json'), JSON.stringify(this.metadata, null, 2));
  }
  private async assetSignature(loaded: LoadedProject) {
    const references = [...new Set(loaded.deck.slides.flatMap(slide=>[
      ...(slide.visual?.asset ? [slide.visual.asset] : []),
      ...(slide.objects??[]).filter(object=>object.type==='image' && object.asset).map(object=>object.asset!),
    ]))].sort();
    const evidence: [string,string][]=[];
    for (const relative of references) {
      const file=await safePath(loaded.dir,relative);
      evidence.push([relative,await exists(file) ? await hashFile(file) : '<missing>']);
    }
    // Include configuration and theme so grants cannot survive a visual change
    // made while the server was stopped.
    return hash(JSON.stringify({assets:evidence,config:loaded.config,theme:loaded.theme}));
  }
  private notify() { this.emit('change'); }
  private invalidate() {
    this.scenes.clear(); this.issueCache = undefined;
  }
  /** Reload external edits and reject requests based on the old source, including CRDT generations. */
  async refresh(reject = false) {
    const next = await loadProject(this.project);
    const file = await safePath(next.dir, next.config.content);
    const current = await hashFile(file);
    const configHash = await hashFile(await safePath(next.dir, 'project.yaml'));
    const themeHash = hash(JSON.stringify(next.theme));
    const assetsHash = await this.assetSignature(next);
    if (current === this.metadata.sourceHash && assetsHash === this.metadata.sourceAssetsHash && configHash === this.configHash && themeHash === this.themeHash) return false;
    this.loaded = next; this.file = file; this.configHash = configHash; this.themeHash = themeHash;
    this.metadata.sourceHash = current; this.metadata.sourceAssetsHash = assetsHash; this.metadata.revision++; this.metadata.authorized = [];
    for (const value of this.docs.values()) value.doc.destroy();
    this.docs.clear(); this.changed.clear(); this.locks.clear(); this.invalidate();
    this.changed.set('*', this.metadata.revision);
    await this.persist(); this.notify();
    if (reject) fail(409, 'Project source changed outside the session. Reload before applying this edit.');
    return true;
  }
  private slide(id: string, locale: string, slides = this.loaded.deck.slides) {
    const slide = slides.find(item => item.id === id);
    if (!slide) fail(404, 'Unknown slide.');
    if (!this.loaded.config.output_locales.includes(locale) || !slide.content[locale]) fail(400, `Missing configured translation: ${locale}.`);
    return slide;
  }
  private async scene(slide: Slide, locale: string) {
    const key = `${locale}:${hash(JSON.stringify(slide))}`;
    if (!this.scenes.has(key)) this.scenes.set(key, await buildSlideScene(slide, slide.content[locale], this.loaded.theme, locale, this.loaded.dir, this.loaded.deck.slides.findIndex(s => s.id === slide.id), {allowMissingTranslations:true}));
    return this.scenes.get(key)!;
  }
  private async object(slide: Slide, locale: string, objectId?: string): Promise<SceneObject> {
    if (objectId === `${slide.id}:notes`) return { id: objectId, role: 'notes', type: 'text', x: 0, y: 0, w: 1, h: 1, text: slide.content[locale].notes, options: {} };
    const object = (await this.scene(slide, locale)).objects.find(item => item.id === objectId);
    if (!object) fail(404, 'Unknown slide object.');
    return object;
  }
  private doc(slide: Slide, locale: string, object: SceneObject) {
    const key = textKey(slide.id, locale, object.id);
    const value = object.text ?? '';
    let entry = this.docs.get(key);
    if (!entry || entry.value !== value) {
      entry?.doc.destroy();
      const doc = new Y.Doc(); doc.getText('text').insert(0, value);
      entry = { doc, generation: crypto.randomUUID(), value }; this.docs.set(key, entry);
    }
    return entry;
  }
  private setText(slide: Slide, locale: string, object: SceneObject, value: string) {
    if (value.length > MAX_TEXT) fail(400, 'Text exceeds 100,000 characters.');
    const content = slide.content[locale];
    if (object.binding && Object.values(slide.native_text?.objects ?? {}).some(item => item.binding === object.binding?.field))
      fail(409, 'This field is bound to original PowerPoint text. Edit the original object to preserve its paragraph structure.');
    if (object.role === 'notes') content.notes = value;
    else if (object.binding?.field === 'objects') {
      content.objects ??= {};
      content.objects[object.binding.id] = { ...content.objects[object.binding.id], [object.binding.property]: value };
    } else if (object.binding?.field === 'labels') content.labels[object.binding.index!] = value;
    else if (object.binding && object.binding.field !== 'visual.asset') content[object.binding.field] = value;
    else fail(400, 'This generated text is read-only. Edit its source data instead.');
  }
  private editor(actor: Actor) { if (actor.role === 'reviewer') fail(403, 'Reviewers can comment, but cannot edit slides.'); }
  private authorization(actor: Actor, slide: Slide, locale: string, kind: string, authorized: string[]) {
    this.editor(actor);
    if (authorized.length && actor.role !== 'owner') fail(403, 'Only the session owner can explicitly authorize protected edits.');
    if (authorized.some(id => id !== slide.id)) fail(400, 'Authorization must name only the slide being edited.');
    const shared = !['text', 'native-text', 'translation-review'].includes(kind);
    const protectedContent = slide.locked || protectedStatus(slide.status) ||
      (shared ? Object.values(slide.content).some(c => protectedStatus(c.review)) : protectedStatus(slide.content[locale].review));
    if ((protectedContent || kind === 'image' && slide.visual?.accepted) && !authorized.includes(slide.id)) fail(403, `${slide.id} is protected. The owner must explicitly authorize this change.`);
    if (['status', 'translation-review'].includes(kind) && actor.role !== 'owner') fail(403, 'Only the owner can change review status.');
  }
  private checkRevision(operation: Operation) {
    const last = Math.max(this.changed.get('*') ?? 0, this.changed.get(operation.slideId) ?? 0,
      this.changed.get(`${operation.slideId}:${operation.objectId ?? '*'}`) ?? 0);
    if (operation.expectedRevision > this.metadata.revision || operation.expectedRevision < last)
      fail(409, 'This object changed after your edit started. Reload and review the current version.');
  }
  private checkLock(actor: Actor, slideId: string, objectId?: string) {
    const lock = this.locks.get(`${slideId}|${objectId}`);
    if (lock && lock.expiresAt > Date.now() && lock.actor.id !== actor.id) fail(409, `${lock.actor.name} is moving this object. Try again when they finish.`);
  }
  private async asset(asset: string) {
    if (!asset.startsWith('assets/')) fail(400, 'Images must be retained under the project assets folder.');
    const file = await safePath(this.loaded.dir, asset);
    if (!await exists(file)) fail(400, 'Image asset is missing. Upload it first.');
    if (!/\.(png|jpe?g|webp|svg)$/i.test(file)) fail(400, 'Unsupported image asset.');
    return file;
  }
  private async nativeSource() {
    if (!this.reference || !this.referenceHash) fail(409, 'Native editing requires a verified reference manifest.');
    const manifest = await safePath(this.loaded.dir, 'content/reference-preview.json');
    if (await hashFile(manifest) !== this.referenceHash) fail(409, 'Reference mapping changed. Restart and verify the original-object mapping.');
    const source = await fs.readFile(await safePath(this.loaded.dir, this.reference.source));
    if (hash(source) !== this.reference.sourceSha256) fail(409, 'Original PowerPoint digest changed. Nothing was overwritten.');
    if (!this.nativeScene) {
      try { this.nativeScene = await importPptxScene(source); }
      catch { fail(409, 'Original PowerPoint cannot be safely mapped for native editing.'); }
    }
    const scene = this.nativeScene;
    if (scene.digest !== this.reference.sourceSha256 || scene.slides.length !== this.loaded.deck.slides.length || this.reference.slides.length !== scene.slides.length ||
      this.reference.slides.some((slide, index) => slide.id !== this.loaded.deck.slides[index].id))
      fail(409, 'Original slide order or count does not match the reference mapping.');
    return { source, scene };
  }
  private nativeSlide(slide: Slide, scene: PptxScene) {
    const index = this.loaded.deck.slides.findIndex(item => item.id === slide.id);
    const imported = scene.slides[index], reference = this.reference!.slides[index];
    if (!imported || reference?.id !== slide.id || !reference.shapes || reference.shapes.length !== imported.objects.length)
      fail(409, 'Original object counts do not match the verified preview.');
    for (const [ordinal, object] of imported.objects.entries()) {
      const shape = reference.shapes[ordinal], geometry = object.geometry;
      const kindMatches = object.kind === 'picture' ? ['image','video'].includes(shape.kind) : object.kind === 'shape' && shape.kind === (object.runs.length ? 'text' : 'shape');
      if (object.ordinal !== ordinal || shape.id !== `${slide.id}:ref-${ordinal+1}` || !kindMatches || !geometry ||
        [geometry.x/914400-shape.x, geometry.y/914400-shape.y, geometry.cx/914400-shape.w, geometry.cy/914400-shape.h].some(delta => Math.abs(delta) > 0.002))
        fail(409, 'Original object identity, type, or geometry does not match the verified preview.');
    }
    if (slide.native_text && (slide.native_text.sourceSha256 !== scene.digest || slide.native_text.slidePart !== imported.part))
      fail(409, 'Native text overrides belong to a different original PowerPoint.');
    for (const [id, override] of Object.entries(slide.native_text?.objects ?? {})) {
      const object = imported.objects.find(item => item.id === id);
      if (!object?.textEditable || override.runs.length !== object.runs.length || override.runs.some((run, i) => run.paragraph !== object.runs[i].paragraph || run.run !== object.runs[i].run))
        fail(409, 'Native text overrides no longer match a supported original object.');
      if (override.binding && slide.content[this.reference!.locale]?.[override.binding] !== nativeText(override.runs))
        fail(409, 'Canonical text and original-object overrides differ. Reconcile them before editing.');
    }
    return imported;
  }
  private nativePreviewFingerprint(slide: Slide) {
    return hash(JSON.stringify({sourceSha256:this.reference?.sourceSha256,overrides:slide.native_text ?? null}));
  }
  private async setNativeText(slide: Slide, operation: Operation) {
    if (operation.locale !== this.reference?.locale || operation.locale !== this.loaded.config.source_locale)
      fail(400, 'Native text editing is limited to the original presentation language.');
    const { scene } = await this.nativeSource();
    const imported = this.nativeSlide(slide, scene);
    const ordinal = this.reference!.slides.find(item => item.id === slide.id)!.shapes!.findIndex(item => item.id === operation.objectId);
    const object = imported.objects[ordinal];
    if (!object?.textEditable) fail(400, 'This original object does not support safe text editing.');
    const { runs } = z.object({ runs: z.array(nativeTextRunSchema).min(1) }).strict().parse(operation.value);
    if (runs.length !== object.runs.length || runs.some((run, index) => run.paragraph !== object.runs[index].paragraph || run.run !== object.runs[index].run))
      fail(400, 'Keep the original paragraph and run structure.');
    if (runs.reduce((size, run) => size + run.text.length, 0) > MAX_TEXT) fail(400, 'Text exceeds 100,000 characters.');
    const previous = slide.native_text?.objects[object.id];
    const content = slide.content[operation.locale];
    const originalText = normalizeNativeText(nativeText(object.runs));
    const bindings = (['title','message'] as const).filter(field => originalText && normalizeNativeText(content[field]) === originalText);
    if (!previous && bindings.length > 1) fail(409, 'Original text matches multiple canonical fields. Reconcile its binding first.');
    const binding = previous?.binding ?? (!previous && bindings.length === 1 ? bindings[0] : undefined);
    if (binding && imported.objects.filter(item => normalizeNativeText(nativeText(item.runs)) === originalText).length !== 1)
      fail(409, 'Multiple original objects match the canonical text. Reconcile their binding first.');
    if (binding === 'title' && !nativeText(runs).trim()) fail(400, 'A title cannot be blank.');
    slide.native_text ??= { sourceSha256: scene.digest, slidePart: imported.part, objects: {} };
    slide.native_text.objects[object.id] = { runs, ...(binding ? { binding } : {}) };
    if (binding) content[binding] = nativeText(runs);
  }
  /** Read-only rendering input: always the immutable original plus every current YAML override. */
  async nativePreviewInput(slideId: string): Promise<{source:Buffer;digest:string;edits:PptxEdit[];index:number;revision:number;sourceHash:string}> {
    await this.refresh(true);
    const { source, scene } = await this.nativeSource();
    const index = this.loaded.deck.slides.findIndex(slide => slide.id === slideId);
    if (index < 0) fail(404, 'Unknown slide.');
    this.nativeSlide(this.loaded.deck.slides[index], scene);
    const edits: PptxEdit[] = [];
    for (const slide of this.loaded.deck.slides) if (slide.native_text) {
      const imported = this.nativeSlide(slide, scene);
      for (const [objectId, override] of Object.entries(slide.native_text.objects)) edits.push({slidePart:imported.part,objectId,runs:structuredClone(override.runs)});
    }
    return {source,digest:scene.digest,edits,index,revision:this.metadata.revision,sourceHash:this.metadata.sourceHash};
  }
  /** Call outside store.run: publication owns the same queue as edits. */
  async publishNativePreview(slideId: string, expectedFingerprint: string, relativeImage: string, sha256: string) {
    return this.run(async () => {
      const input = await this.nativePreviewInput(slideId);
      if (input.sourceHash !== expectedFingerprint) fail(409, 'Preview was rendered from an older source revision.');
      refPath.parse(relativeImage); digest.parse(sha256);
      if (!relativeImage.endsWith('.png') || await hashFile(await safePath(this.loaded.dir,relativeImage)) !== sha256) fail(409, 'Native preview image failed verification.');
      const reference = this.reference!.slides[input.index];
      reference.image = relativeImage; reference.sha256 = sha256;
      const slide = this.loaded.deck.slides[input.index];
      this.nativePreviews.set(slideId,{fingerprint:this.nativePreviewFingerprint(slide),revision:this.metadata.revision,status:'current'});
      this.notify();
    });
  }
  async failNativePreview(slideId: string, expectedSourceHash: string, error: string) {
    return this.run(async () => {
      await this.refresh(true);
      if (this.metadata.sourceHash !== expectedSourceHash) return;
      const slide = this.loaded.deck.slides.find(item => item.id === slideId);
      if (!slide) fail(404, 'Unknown slide.');
      this.nativePreviews.set(slideId,{fingerprint:this.nativePreviewFingerprint(slide),revision:this.metadata.revision,status:'failed',error:error.slice(0,1000)});
      this.notify();
    });
  }
  private async candidate(actor: Actor, raw: unknown, deck = this.loaded.deck) {
    const operation = operationSchema.parse(raw);
    const slide = this.slide(operation.slideId, operation.locale, deck.slides);
    this.authorization(actor, slide, operation.locale, operation.kind, operation.authorize);
    this.checkRevision(operation); this.checkLock(actor, slide.id, operation.objectId);
    if (operation.kind === 'native-text') {
      await this.setNativeText(slide, operation);
    } else if (operation.kind === 'add') {
      const input = z.object({ id: z.string().optional(), type: z.enum(['text','shape','image']), x: z.number(), y: z.number(), w: z.number(), h: z.number(), text: z.string().max(MAX_TEXT).optional(), alt: z.string().max(MAX_TEXT).optional(), asset: z.string().optional(), style: visualObjectOverrideSchema.shape.style }).strict().parse(operation.value);
      const { text, alt, ...values } = input;
      const object = customObjectSchema.parse({ ...values, id: input.id ?? `object-${crypto.randomUUID()}`, ...(input.type === 'image' ? { accepted: true } : {}) });
      if (object.x<0 || object.y<0 || object.x+object.w>13.334 || object.y+object.h>7.501) fail(400, 'Object must stay inside the slide.');
      if (slide.objects?.some(item => item.id === object.id)) fail(409, 'Object ID already exists.');
      if (object.type === 'text' && !text?.trim()) fail(400, 'A text box needs text.');
      if (object.type === 'image') { if (!alt?.trim()) fail(400, 'An image needs an alt description.'); await this.asset(object.asset!); }
      slide.objects ??= []; slide.objects.push(object);
      const content = slide.content[operation.locale]; content.objects ??= {};
      content.objects[object.id] = { ...(text !== undefined ? { text } : {}), ...(alt !== undefined ? { alt } : {}) };
      operation.objectId = `${slide.id}:${object.id}`;
    } else if (operation.kind === 'status') {
      slide.status = z.enum(['draft','review','approved','locked']).parse(operation.value); slide.locked = slide.status === 'locked';
    } else if (operation.kind === 'translation-review') {
      const review = z.enum(['draft','review','approved','locked']).parse(operation.value);
      if (['approved','locked'].includes(review)) {
        const content=slide.content[operation.locale];
        const problems=operation.locale===this.loaded.config.source_locale ? [] : consistency(slide.content[this.loaded.config.source_locale],content,this.loaded.config.glossary);
        for (const object of slide.objects??[]) {
          const property=object.type==='text' ? 'text' : object.type==='image' ? 'alt' : undefined;
          if (property && !content.objects?.[object.id]?.[property]?.trim()) problems.push(`${object.id}: localized ${property} is required`);
        }
        if (problems.length) fail(400, `Translation cannot be approved: ${problems.join('; ')}`);
      }
      slide.content[operation.locale].review = review;
      if (['approved','locked'].includes(review) && operation.locale !== this.loaded.config.source_locale)
        slide.content[operation.locale].source_fingerprint = translationSourceFingerprint(slide, this.loaded.config.source_locale);
    } else {
      const object = await this.object(slide, operation.locale, operation.objectId);
      const customAccepted = slide.objects?.find(item => item.id === object.role)?.accepted;
      if (customAccepted && ['image','delete'].includes(operation.kind) && !operation.authorize.includes(slide.id)) fail(403, 'The owner must explicitly authorize changing an accepted image.');
      if (operation.kind === 'text') this.setText(slide, operation.locale, object, z.string().max(MAX_TEXT).parse(operation.value));
      if (operation.kind === 'geometry' || operation.kind === 'style') {
        if (object.role === 'notes') fail(400, 'Notes have no slide geometry.');
        const value = operation.kind === 'geometry'
          ? z.object({ x: z.number().finite().min(0).optional(), y: z.number().finite().min(0).optional(), w: z.number().finite().positive().optional(), h: z.number().finite().nonnegative().optional() }).strict().parse(operation.value)
          : { style: visualObjectOverrideSchema.shape.style.unwrap().parse(operation.value) };
        if ('style' in value) {
          const allowed:Record<SceneObject['type'],string[]>={text:['color','fill','fontSize','bold'],shape:['color','fill'],connector:['color'],chart:['color','fill'],image:[]};
          const keys=Object.keys(value.style);
          if (!keys.length || keys.some(key=>!allowed[object.type].includes(key))) fail(400, `Unsupported style property for ${object.type}.`);
        }
        const box = { ...object, ...value };
        if (box.x + box.w > 13.334 || box.y + box.h > 7.501) fail(400, 'Object must stay inside the slide.');
        slide.visual_objects ??= {};
        const previous = slide.visual_objects[object.role] ?? {};
        slide.visual_objects[object.role] = { ...previous, ...value, ...('style' in value ? { style: { ...previous.style, ...value.style } } : {}) };
      }
      if (operation.kind === 'image') {
        const { asset, alt } = z.object({ asset: z.string().max(500), alt: z.string().max(MAX_TEXT).optional() }).strict().parse(operation.value);
        await this.asset(asset);
        const custom = slide.objects?.find(item => item.id === object.role && item.type === 'image');
        if (custom) { custom.asset = asset; custom.accepted = true; if (alt !== undefined) { slide.content[operation.locale].objects ??= {}; slide.content[operation.locale].objects![custom.id] = { ...slide.content[operation.locale].objects![custom.id], alt }; } }
        else if (object.role === 'illustration' || object.role === 'illustration-placeholder') {
          slide.visual = { ...slide.visual, brief: slide.visual?.brief ?? '', asset, accepted: true };
          if (alt !== undefined) slide.content[operation.locale].alt = alt;
        } else fail(400, 'Select an image to replace.');
      }
      if (operation.kind === 'delete') {
        if (!slide.objects?.some(item => item.id === object.role)) fail(400, 'Only added objects can be deleted. Source elements remain protected.');
        slide.objects = slide.objects.filter(item => item.id !== object.role);
        if (slide.visual_objects) delete slide.visual_objects[object.role];
        for (const content of Object.values(slide.content)) if (content.objects) delete content.objects[object.role];
      }
    }
    slideSchema.parse(slide);
    return operation;
  }
  private async persistChange(actor: Actor, deck: LoadedProject['deck'], operations: Operation[], kind?: string) {
    deckSchema.parse(deck);
    const ids = [...new Set(operations.map(o => o.slideId))];
    const authorized = [...new Set(operations.flatMap(o => o.authorize))];
    // Current accepted artwork is protected even before its first PowerPoint build.
    // This also covers undo, which replaces whole slide objects rather than using
    // an individual geometry/image operation.
    for (const id of ids) {
      if (authorized.includes(id)) continue;
      const before=this.loaded.deck.slides.find(slide=>slide.id===id)!;
      const after=deck.slides.find(slide=>slide.id===id)!;
      const visualChanged=before.visual?.accepted && JSON.stringify({visual:before.visual,override:before.visual_objects?.illustration})!==JSON.stringify({visual:after.visual,override:after.visual_objects?.illustration});
      const customChanged=(before.objects??[]).some(object=>object.type==='image' && object.accepted &&
        JSON.stringify({object,override:before.visual_objects?.[object.id]})!==JSON.stringify({object:after.objects?.find(item=>item.id===object.id),override:after.visual_objects?.[object.id]}));
      if (visualChanged || customChanged) fail(403, `${id}: changing accepted image properties or placement requires explicit owner authorization.`);
    }
    const { state: baseline, legacyUnverifiable } = await loadProtectionBaseline(this.loaded.dir);
    const next = await fingerprints(this.loaded.dir, deck, this.loaded.theme);
    const knownAuthorized = [...new Set([...this.metadata.authorized, ...authorized])];
    const problems = protectionIssues(baseline, next, knownAuthorized);
    if (problems.length || legacyUnverifiable && ids.some(id => baseline?.slides[id] && !knownAuthorized.includes(id)))
      fail(403, problems.join('\n') || 'Legacy protection baseline requires explicit owner authorization.');
    const current = await fs.readFile(this.file);
    if (hash(current) !== this.metadata.sourceHash) { await this.refresh(); fail(409, 'Source changed during this edit. Nothing was overwritten.'); }
    const revision = this.metadata.revision + 1;
    const transactionId = `${stamp()}-${crypto.randomUUID()}`;
    const nextMetadata = structuredClone(this.metadata);
    nextMetadata.revision = revision; nextMetadata.authorized = knownAuthorized;
    nextMetadata.sourceAssetsHash = await this.assetSignature({...this.loaded,deck});
    const after = YAML.stringify(deck); nextMetadata.sourceHash = hash(after);
    for (const id of ids) nextMetadata.history.push({ id: `${transactionId}-${id}`, actor: cleanActor(actor), slideId: id, kind: kind ?? operations.map(o => o.kind).join(', '), createdAt: new Date().toISOString(), revision,
      before: structuredClone(this.loaded.deck.slides.find(s => s.id === id)!), after: structuredClone(deck.slides.find(s => s.id === id)!), authorized });
    await atomicWrite(await safePath(this.loaded.dir, `feedback/${transactionId}.before.yaml`), current);
    await atomicWrite(await safePath(this.loaded.dir, `feedback/${transactionId}.yaml`), YAML.stringify({ actor, operations, revision, authorized, at: new Date().toISOString(), sourceBefore: this.metadata.sourceHash, sourceAfter: nextMetadata.sourceHash }));
    const pending = await safePath(this.loaded.dir, '.session/pending.json');
    await atomicWrite(pending, JSON.stringify({ hash: nextMetadata.sourceHash, metadata: nextMetadata }));
    if (operations.some(operation => operation.kind === 'native-text')) {
      try { await this.nativeSource(); } catch (error) { await fs.unlink(pending); throw error; }
    }
    if (await hashFile(this.file) !== this.metadata.sourceHash || await this.assetSignature(this.loaded) !== this.metadata.sourceAssetsHash) { await fs.unlink(pending); await this.refresh(); fail(409, 'Source or retained assets changed during this edit. Nothing was overwritten.'); }
    await atomicWrite(this.file, after);
    this.loaded.deck = deck; this.metadata = nextMetadata; this.invalidate();
    for (const operation of operations) {
      this.changed.set(`${operation.slideId}:${operation.objectId ?? '*'}`, revision);
      if (['status','translation-review','add','delete','native-text'].includes(operation.kind)) this.changed.set(operation.slideId, revision);
    }
    await this.persist(); await fs.unlink(pending); this.notify();
  }
  async operate(actor: Actor, raw: unknown) {
    await this.refresh(true);
    const deck = structuredClone(this.loaded.deck);
    const operation = await this.candidate(actor, raw, deck);
    await this.persistChange(actor, deck, [operation]);
  }
  async text(actor: Actor, raw: unknown) {
    await this.refresh(true); this.editor(actor);
    const request = textUpdateSchema.parse(raw);
    const slide = this.slide(request.slideId, request.locale);
    this.authorization(actor, slide, request.locale, 'text', request.authorize);
    const object = await this.object(slide, request.locale, request.objectId);
    if (object.type !== 'text') fail(400, 'Concurrent editing is available for text objects.');
    const entry = this.doc(slide, request.locale, object);
    if (entry.generation !== request.generation) fail(409, 'Text was replaced or the session restarted. Reload and reapply your unsent edit.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(request.update)) fail(400, 'Malformed collaborative text update.');
    const candidate = new Y.Doc(); candidate.getText('text');
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(entry.doc));
      Y.applyUpdate(candidate, Buffer.from(request.update, 'base64'));
      if ([...candidate.share.keys()].some(key => key !== 'text')) fail(400, 'Only plain text updates are accepted.');
      const delta = candidate.getText('text').toDelta();
      if (delta.some((item: {insert: unknown; attributes?: unknown}) => typeof item.insert !== 'string' || item.attributes && Object.keys(item.attributes).length)) fail(400, 'Rich content is not supported in this plain text field.');
      const value = candidate.getText('text').toString();
      if (value.length > MAX_TEXT) fail(400, 'Text exceeds 100,000 characters.');
      if (value !== entry.value) {
        const deck = structuredClone(this.loaded.deck);
        this.setText(this.slide(slide.id, request.locale, deck.slides), request.locale, object, value);
        await this.persistChange(actor, deck, [{ slideId: slide.id, locale: request.locale, objectId: object.id, expectedRevision: this.metadata.revision, kind: 'text', value, authorize: request.authorize }], 'collaborative text');
      }
      Y.applyUpdate(entry.doc, Buffer.from(request.update, 'base64')); entry.value = value;
    } finally { candidate.destroy(); }
  }
  async snapshot(actor: Actor, locale: string): Promise<SessionSnapshot> {
    await this.refresh();
    if (!this.loaded.config.output_locales.includes(locale)) fail(400, 'Unknown output language.');
    const texts: SessionSnapshot['texts'] = {};
    const slides: SessionSnapshot['slides'] = [];
    let native: PptxScene | undefined, nativeError: string | undefined;
    if (locale === this.reference?.locale && this.reference.slides.some(slide => slide.shapes?.length)) {
      try { native = (await this.nativeSource()).scene; } catch (error) { nativeError = (error as Error).message; }
    }
    for (const slide of this.loaded.deck.slides) {
      const reference=locale===this.reference?.locale ? this.reference.slides.find(item=>item.id===slide.id) : undefined;
      const preview = this.nativePreviews.get(slide.id);
      const status: ReferencePreview['status'] = nativeError ? 'failed' : preview ? (preview.fingerprint === this.nativePreviewFingerprint(slide) ? preview.status : 'pending') : slide.native_text ? 'pending' : 'current';
      let nativeObjects: PptxScene['slides'][number]['objects'] | undefined, mappingError = nativeError;
      if (reference && native) {
        try { nativeObjects = this.nativeSlide(slide,native).objects; } catch (error) { mappingError = (error as Error).message; }
      }
      const shapes = reference?.shapes?.map((shape, index) => {
        const object = nativeObjects?.[index], override = object && slide.native_text?.objects[object.id];
        return {...shape,...(shape.kind === 'text' ? {nativeText:{runs:structuredClone(override?.runs ?? object?.runs ?? []),editable:!!object?.textEditable && !mappingError, ...(!object?.textEditable || mappingError ? {reason:mappingError ?? object?.reason ?? 'Unsupported original text object.'} : {})}} : {})};
      });
      const visibleReference: ReferencePreview | undefined=reference ? {image:`/api/reference/${encodeURIComponent(slide.id)}/image`,status,revision:preview?.revision ?? 0,...(status === 'failed' ? {error:nativeError ?? preview?.error} : {}),...(shapes?{shapes}:{}),...(reference.video?{video:{src:`/api/reference/${encodeURIComponent(slide.id)}/video`,poster:`/api/reference/${encodeURIComponent(slide.id)}/poster`,x:reference.video.x,y:reference.video.y,w:reference.video.w,h:reference.video.h}}:{})} : undefined;
      const summary = { id: slide.id, status: slide.status, locked: slide.locked, review: slide.content[locale]?.review, ...(visibleReference?{reference:visibleReference}:{}) };
      if (!slide.content[locale]) { slides.push({ ...summary, error: `Missing translation: ${locale}` }); continue; }
      try {
        const scene = structuredClone(await this.scene(slide, locale));
        const notes = await this.object(slide, locale, `${slide.id}:notes`);
        for (const object of [...scene.objects, notes]) {
          if (object.type === 'text' && (object.binding || object.role === 'notes')) {
            const entry = this.doc(slide, locale, object);
            texts[textKey(slide.id, locale, object.id)] = { generation: entry.generation, update: Buffer.from(Y.encodeStateAsUpdate(entry.doc)).toString('base64') };
          }
          if (object.type === 'image') {
            const asset = object.role === 'illustration' ? slide.visual?.asset : slide.objects?.find(item => item.id === object.role)?.asset;
            delete object.options.data;
            if (asset) object.options.path = `/api/assets?path=${encodeURIComponent(asset)}`;
          }
        }
        // Show authored notes, without adding provenance text to the editable field.
        scene.notes = slide.content[locale].notes;
        slides.push({ ...summary, scene });
      } catch (error) { slides.push({ ...summary, error: (error as Error).message }); }
    }
    if (this.issueCache?.revision !== this.metadata.revision) {
      const issues = await validateContent(this.loaded.dir, this.loaded.config, this.loaded.deck, this.loaded.theme);
      this.issueCache = { revision: this.metadata.revision, issues };
    }
    const brief = await creatorBriefStatus(this.loaded.dir, this.loaded.config);
    const now = Date.now();
    for (const [id, entry] of this.presence) if (entry.updatedAt < now - 45000) this.presence.delete(id);
    for (const [id, entry] of this.locks) if (entry.expiresAt <= now) this.locks.delete(id);
    return { project: this.project, title: this.loaded.config.title, locale, locales: this.loaded.config.output_locales, sourceLocale: this.loaded.config.source_locale,
      revision: this.metadata.revision, actor, slides, texts, comments: this.metadata.comments, jobs: this.metadata.jobs,
      history: this.metadata.history.slice(-100).map(({before,after,authorized,...entry}) => entry),
      presence: [...this.presence.values()], locks: [...this.locks.values()], agentConfigured: this.agentConfigured, briefReady: brief.approved, exportBlocked: !brief.approved || this.loaded.deck.slides.some(slide => slide.native_text) || await exists(await safePath(this.loaded.dir,'content/.block-session-export')),
      issues: [...this.issueCache.issues.filter(issue=>issue.code!=='creator-brief'),...brief.errors.map(message=>({severity:'error' as const,code:'creator-brief',message})),...slides.flatMap(slide=>slide.scene ? validateGeometry(slide.scene.geometry) : [])] };
  }
  async comment(actor: Actor, raw: unknown) {
    await this.refresh(true);
    const input = commentSchema.parse(raw);
    const slide = this.slide(input.slideId, input.locale);
    if (input.objectId && !this.reference?.slides.find(s=>s.id===slide.id)?.shapes?.some(shape=>shape.id===input.objectId)) await this.object(slide, input.locale, input.objectId);
    const comment: Comment = { ...input, id: crypto.randomUUID(), actor: cleanActor(actor), createdAt: new Date().toISOString(), resolved: false, replies: [] };
    this.metadata.comments.push(comment);
    if (input.askAgent) this.metadata.jobs.push({ id: crypto.randomUUID(), commentId: comment.id, slideId: input.slideId, locale: input.locale, objectId: input.objectId, message: input.message, actor: cleanActor(actor), createdAt: comment.createdAt, baseRevision: this.metadata.revision, status: this.agentConfigured ? 'queued' : 'awaiting-agent' });
    await this.persist(); this.notify(); return comment;
  }
  async thread(actor: Actor, id: string, action: string, input: unknown) {
    const comment = this.metadata.comments.find(c => c.id === id);
    if (!comment) fail(404, 'Unknown comment.');
    if (action === 'reply') {
      const { message } = z.object({ message: z.string().trim().min(1).max(10000) }).strict().parse(input);
      comment.replies.push({ id: crypto.randomUUID(), actor: cleanActor(actor), message, createdAt: new Date().toISOString() });
    } else {
      if (actor.role !== 'owner' && comment.actor.id !== actor.id) fail(403, 'Only the author or owner can resolve a thread.');
      comment.resolved = z.object({ resolved: z.boolean() }).strict().parse(input).resolved;
    }
    await this.persist(); this.notify();
  }
  setPresence(actor: Actor, raw: unknown) {
    const value = z.object({ slideId: z.string().max(160).optional(), objectId: z.string().max(160).optional(), x: z.number().finite().min(0).max(14).optional(), y: z.number().finite().min(0).max(8).optional() }).strict().parse(raw);
    this.presence.set(actor.id, { actor, ...value, updatedAt: Date.now() }); this.notify();
  }
  lock(actor: Actor, raw: unknown) {
    this.editor(actor);
    const input = z.object({ slideId: z.string().max(160), objectId: z.string().max(160), release: z.boolean().optional() }).strict().parse(raw);
    const key = `${input.slideId}|${input.objectId}`;
    this.checkLock(actor, input.slideId, input.objectId);
    if (input.release) this.locks.delete(key);
    else this.locks.set(key, { key, actor, expiresAt: Date.now() + 15000 });
    this.notify();
  }
  async undo(actor: Actor, raw: unknown) {
    await this.refresh(true); this.editor(actor);
    const input = z.object({ id: z.string(), expectedRevision: z.number(), authorize: z.array(z.string()).default([]) }).strict().parse(raw);
    const entry = this.metadata.history.find(item => item.id === input.id);
    if (!entry || entry.undone) fail(409, 'This change cannot be undone.');
    if (entry.actor.id !== actor.id && actor.role !== 'owner') fail(403, 'Only the author or owner can undo this change.');
    const current = this.loaded.deck.slides.find(s => s.id === entry.slideId)!;
    if (input.expectedRevision !== this.metadata.revision || JSON.stringify(current) !== JSON.stringify(entry.after)) fail(409, 'The slide changed since this revision. Undo would overwrite newer work.');
    const locale = this.loaded.config.source_locale;
    this.authorization(actor, current, locale, 'undo', input.authorize);
    const deck = structuredClone(this.loaded.deck);
    deck.slides[deck.slides.findIndex(s => s.id === entry.slideId)] = structuredClone(entry.before);
    await this.persistChange(actor, deck, [{ slideId: entry.slideId, locale, expectedRevision: this.metadata.revision, kind: 'status', value: current.status, authorize: input.authorize }], 'undo');
    this.metadata.history.find(item => item.id === entry.id)!.undone = true;
    await this.persist();
  }
  async updateJob(id: string, update: Partial<AgentJob>) {
    const job = this.metadata.jobs.find(j => j.id === id); if (!job) fail(404, 'Unknown agent job.');
    Object.assign(job, update); await this.persist(); this.notify(); return job;
  }
  async propose(actor: Actor, id: string, raw: unknown) {
    if (actor.role !== 'owner') fail(403, 'Only the owner can submit agent proposals.');
    const input = z.object({ summary: z.string().max(10000), operations: z.array(operationSchema).min(1).max(50) }).strict().parse(raw);
    const job = this.metadata.jobs.find(j => j.id === id); if (!job) fail(404, 'Unknown agent job.');
    if (input.operations.some(op => op.slideId !== job.slideId || op.locale !== job.locale || op.authorize.length)) fail(400, 'Agent proposals must target the requested slide/language and cannot grant authorization.');
    input.operations.forEach(op => { op.expectedRevision = job.baseRevision; });
    await this.updateJob(id, { status: 'proposed', summary: input.summary, operations: input.operations, error: undefined });
  }
  async applyJob(actor: Actor, id: string, raw: unknown) {
    this.editor(actor);
    const { authorize } = z.object({ authorize: z.array(z.string()).default([]) }).strict().parse(raw);
    const job = this.metadata.jobs.find(j => j.id === id);
    if (!job || job.status !== 'proposed' || !job.operations?.length) fail(409, 'No proposal is ready to apply.');
    try {
      await this.refresh(true);
      if ((this.changed.get('*')??0)>job.baseRevision || this.metadata.history.some(entry=>entry.slideId===job.slideId && entry.revision>job.baseRevision))
        fail(409, 'The slide changed after the agent received its context. Retry the job with the current slide.');
      const deck = structuredClone(this.loaded.deck); const operations: Operation[] = [];
      for (const op of job.operations) operations.push(await this.candidate(actor, { ...op, authorize }, deck));
      await this.persistChange(actor, deck, operations, 'agent proposal');
      await this.updateJob(id, { status: 'applied', error: undefined });
    } catch (error) {
      if (error instanceof SessionError && error.status === 409) await this.updateJob(id, { status: 'conflict', error: error.message });
      throw error;
    }
  }
  async retryJob(actor: Actor, id: string) {
    this.editor(actor); await this.refresh(true);
    const job = this.metadata.jobs.find(j => j.id === id); if (!job) fail(404, 'Unknown agent job.');
    if (['queued','running','applied'].includes(job.status)) fail(409, 'This job cannot be retried in its current state.');
    return this.updateJob(id, { status: this.agentConfigured ? 'queued' : 'awaiting-agent', baseRevision: this.metadata.revision, operations: undefined, error: undefined });
  }
  async export(actor: Actor, raw: unknown) {
    this.editor(actor); await this.refresh(true);
    const brief=await creatorBriefStatus(this.loaded.dir,this.loaded.config);
    if(!brief.approved) fail(409, 'Creator brief not approved. Run npm run brief -- --project '+this.project+'. '+brief.errors.join('; '));
    if (this.loaded.deck.slides.some(slide => slide.native_text)) fail(409, 'Native text edits are saved in YAML. PowerPoint export remains disabled until native roundtrip validation is complete.');
    if (await exists(await safePath(this.loaded.dir, 'content/.block-session-export'))) fail(409, 'This trial uses a presentation with custom layouts or media. Session export is disabled because the generic renderer cannot reproduce the original PowerPoint.');
    const { locale, render } = z.object({ locale: z.string(), render: z.boolean().default(false) }).strict().parse(raw);
    if (!this.loaded.config.output_locales.includes(locale)) fail(400, 'Unknown output language.');
    const result = await buildProject(this.project, { locale, authorize: this.metadata.authorized });
    this.metadata.authorized = []; await this.persist();
    const previews = render ? await renderProject(this.project, locale) : undefined;
    this.notify(); return { files: result.files.map(file => path.basename(file)), report: result.report, render: previews };
  }
  async assetFile(relative: string) {
    const referenced = this.loaded.deck.slides.some(slide => slide.visual?.asset === relative || slide.objects?.some(object => object.asset === relative));
    // Uploaded assets may be previewed before attachment, but never arbitrary project files.
    if (!referenced && !/^assets\/session\/[a-f0-9]{64}\.png$/.test(relative)) fail(404, 'Unknown session image.');
    return this.asset(relative);
  }
  async referenceFile(id:string,kind:'image'|'video'|'poster') {
    const reference=this.reference?.slides.find(s=>s.id===id);
    if(!reference || !this.reference) fail(404,'Unknown slide reference.');
    const entry=kind==='image'?{file:reference.image,hash:reference.sha256}:kind==='video'&&reference.video?{file:reference.video.file,hash:reference.video.sha256}:kind==='poster'&&reference.video?{file:reference.video.poster,hash:reference.video.posterSha256}:undefined;
    if(!entry) fail(404,'This slide has no reference media.');
    if(await hashFile(await safePath(this.loaded.dir,this.reference.source))!==this.reference.sourceSha256) fail(409,'The reference PowerPoint changed. Recreate the preview.');
    const file=await safePath(this.loaded.dir,entry.file);
    if(await hashFile(file)!==entry.hash) fail(409,'Reference media changed. Recreate the preview.');
    return file;
  }
  dispose() { for (const entry of this.docs.values()) entry.doc.destroy(); this.removeAllListeners(); }
}
