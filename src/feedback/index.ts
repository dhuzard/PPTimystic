import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadProject, writeYaml, atomicWrite, stamp, safePath } from '../core/io.js';
import { localizedSchema, slideSchema, visualObjectOverrideSchema } from '../core/model.js';

const categories=['content','layout','typography','illustration','translation','scientific-correction','global-theme'] as const;
export const revisionSchema=z.object({
  slide:z.string(),locale:z.string().optional(),category:z.enum(categories),message:z.string().min(1),
  patch:z.object({
    title:z.string().min(1).optional(),message:z.string().optional(),body:z.string().optional(),
    notes:z.string().optional(),caption:z.string().optional(),alt:z.string().optional(),
    labels:z.array(z.string()).optional(),seriesNames:z.array(z.string()).optional(),
    review:z.enum(['draft','review','approved','locked']).optional()
  }).strict().optional(),layout:slideSchema.shape.layout.optional(),
  status:z.enum(['draft','review','approved','locked']).optional(),
  // Evidence reclassification and per-object geometry are shared (not localized) slide fields.
  evidence:z.enum(['established','interpretation','hypothesis','conceptual','missing']).optional(),
  visual_objects:z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),visualObjectOverrideSchema.omit({hidden:true})).optional()
}).strict();
export async function applyRevision(name:string,request:unknown,authorized:string[]=[]) {
  const r=revisionSchema.parse(request);
  const {dir,config,deck}=await loadProject(name);
  const s=deck.slides.find(s=>s.id===r.slide);
  if (!s) throw new Error(`Unknown slide ID: ${r.slide}`);
  const changing=!!(r.patch||r.layout||r.status||r.evidence||r.visual_objects);
  const protectedSlide=s.locked||s.status==='approved'||s.status==='locked'||(r.locale && ['approved','locked'].includes(s.content[r.locale]?.review));
  if (changing && protectedSlide && !authorized.includes(s.id)) throw new Error(`${s.id} is approved/locked; explicit --authorize ${s.id} is required.`);
  if (r.patch) {
    if (!r.locale || !s.content[r.locale]) throw new Error('A patch requires an existing --locale. Use translate to add a language.');
    s.content[r.locale]=localizedSchema.parse({...s.content[r.locale],...r.patch});
  }
  if (r.layout) s.layout=r.layout;
  if (r.evidence) s.evidence=r.evidence;
  // Merge into existing overrides so unrelated position, size or style values are kept.
  if (r.visual_objects) for (const [role,override] of Object.entries(r.visual_objects)) {
    const old=s.visual_objects?.[role];
    s.visual_objects={...s.visual_objects,[role]:visualObjectOverrideSchema.parse({...old,...override,...(old?.style||override.style?{style:{...old?.style,...override.style}}:{})})};
  }
  if (r.status) { s.status=r.status; s.locked=r.status==='locked'; }
  const id=`${stamp()}-${crypto.randomUUID().slice(0,8)}`;
  const file=await safePath(dir,config.content);
  if (changing) {
    await atomicWrite(path.join(dir,`feedback/${id}.before.yaml`),await fs.readFile(file));
    await writeYaml(file,deck);
  }
  await writeYaml(path.join(dir,`feedback/${id}.yaml`),{...r,at:new Date().toISOString(),applied:changing,authorized});
  return {slide:r.slide,changed:changing,record:`feedback/${id}.yaml`,message:changing?'Source revised. Build to validate and export.':'Feedback recorded for your agent; no automatic interpretation was performed.'};
}
