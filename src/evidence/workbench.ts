import fs from 'node:fs/promises';
import { z } from 'zod';
import { atomicWrite, exists, hash, hashFile, loadProject, readYaml, safePath } from '../core/io.js';
import { creatorBriefStatus, readCreatorBrief, briefDigest, briefSchema } from '../core/brief.js';
import type { SourceRecord } from '../content/ingest.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max = 3000) => z.string().trim().min(1).max(max);
export const sourceFindingSchema = z.object({
  claim: text(1200), quote: text(900), stance: z.enum(['supports','contradicts','qualifies','background','unrelated']),
  use: z.enum(['argument','slide','table','figure','speaker-notes','none']), caveat: text(1200)
}).strict();
export const analysisSchema = z.object({
  kind: z.literal('source-analysis'), version: z.literal(1),
  revision: digest, source_id: z.string().regex(/^SRC-[a-f0-9]{12}$/),
  chunk_id: z.string().regex(/^C\d{4,}$/),
  source_sha256: digest, analyst: z.object({ name: text(160), model: text(200) }).strict(),
  coverage: z.literal('entire-chunk-read'),
  relevance: text(2000), findings: z.array(sourceFindingSchema).max(50)
}).strict();
export type SourceAnalysis = z.infer<typeof analysisSchema>;
const sourceSchema = z.object({
  id: z.string(), path: z.string(), kind: z.string(), sha256: digest,
  extracted_sha256: digest.optional(), status: z.enum(['indexable','missing-text','integrity-error','visual-only']),
  error: z.string().optional(), chars: z.number().int().nonnegative(),
  chunks: z.array(z.object({ id: z.string(), start: z.number().int(), end: z.number().int(), sha256: digest }).strict())
}).strict();
export const knowledgePlanSchema = z.object({
  version: z.literal(1), project: z.string(), created_at: z.string().datetime(), revision: digest,
  brief_sha256: digest,
  goal: z.object({ purpose:z.string(), central_message:z.string(), audience:z.string(), prior_knowledge:z.string(), scope:z.string(), uncertainties:z.string() }).strict(),
  sources: z.array(sourceSchema)
}).strict();
export type KnowledgePlan = z.infer<typeof knowledgePlanSchema>;
type SourceIndex = z.infer<typeof sourceSchema>;
const planPath='knowledge/plan.json';
const chunkPath=(source:string,chunk:string)=>'knowledge/analyses/'+source+'-'+chunk+'.json';
function fragment(text:string) {
  const out:SourceIndex['chunks']=[];let start=0;
  while(start<text.length) {
    let end=Math.min(start+3500,text.length);
    const lineBreak=text.lastIndexOf('\n',end);
    if(end<text.length && lineBreak>start+2100)end=lineBreak+1;
    out.push({id:'C'+String(out.length+1).padStart(4,'0'),start,end,sha256:hash(text.slice(start,end))});
    start=end;
  }
  return out;
}
async function currentGoal(project:string) {
  const {dir,config}=await loadProject(project);
  if(!config.brief_required)throw new Error('An approved real-project brief is required for goal-oriented source analysis.');
  const state=await creatorBriefStatus(dir,config);
  if(!state.approved)throw new Error('Approve the presentation goal and audience first: '+state.errors.join('; '));
  const approved=briefSchema.parse(await readCreatorBrief(dir));
  const {approval:_ignored,...brief}=approved;
  return {dir,brief,briefSha:briefDigest(brief)};
}
async function sourceIndex(dir:string,r:SourceRecord):Promise<SourceIndex> {
  const base={id:r.id,path:r.path,kind:r.kind,sha256:r.sha256}, nonText=['png','jpg','jpeg','svg','webp'].includes(r.kind);
  if(nonText)return {...base,status:'visual-only',error:'Original visual retained. Visual understanding is not provided by text extraction.',chars:0,chunks:[]};
  try{
    if(await hashFile(await safePath(dir,r.path))!==r.sha256)throw new Error('Original SHA-256 mismatch');
    if(r.error)throw new Error(r.error);
    if(!r.extracted || !r.extracted_sha256)throw new Error('No usable extracted text. Scanned or unsupported file requires manual review.');
    const extracted=await fs.readFile(await safePath(dir,r.extracted),'utf8');
    if(hash(extracted)!==r.extracted_sha256)throw new Error('Extracted SHA-256 mismatch');
    if(!extracted.trim())throw new Error('Extracted text is empty.');
    return {...base,extracted_sha256:r.extracted_sha256,status:'indexable',chars:extracted.length,chunks:fragment(extracted)};
  }catch(error){
    const message=(error as Error).message;
    return {...base,status:message.includes('mismatch')?'integrity-error':'missing-text',error:message,chars:0,chunks:[]};
  }
}
export async function readKnowledgePlan(project:string):Promise<KnowledgePlan|undefined>{
  const {dir}=await loadProject(project);
  const p=await safePath(dir,planPath);
  return await exists(p)?knowledgePlanSchema.parse(JSON.parse(await fs.readFile(p,'utf8'))):undefined;
}
async function assertPlan(project:string,plan:KnowledgePlan) {
  const {dir,briefSha}=await currentGoal(project);
  if(briefSha!==plan.brief_sha256)throw new Error('Brief changed: rebuild the source knowledge base.');
  const index=await safePath(dir,'content/sources.yaml');
  const records:SourceRecord[]=await exists(index)?((await readYaml(index)).sources??[]):[];
  if(records.length!==plan.sources.length)throw new Error('Source count changed: rebuild the knowledge base.');
  for(let i=0;i<records.length;i++){
    const r=records[i],p=plan.sources[i];
    if(r.id!==p.id||r.sha256!==p.sha256||(r.extracted_sha256??null)!==(p.extracted_sha256??null))
      throw new Error('Source index changed: rebuild the knowledge base.');
    if(await hashFile(await safePath(dir,r.path))!==r.sha256)throw new Error('Original modified: '+r.id);
    if(r.extracted && await hashFile(await safePath(dir,r.extracted))!==r.extracted_sha256)
      throw new Error('Extracted text modified: '+r.id);
  }
}
export async function prepareKnowledge(project:string){
  const {dir,brief,briefSha}=await currentGoal(project);
  const sourceFile=await safePath(dir,'content/sources.yaml');
  const records:SourceRecord[]=await exists(sourceFile)?((await readYaml(sourceFile)).sources??[]):[];
  const ids=new Set<string>();
  for(const r of records){if(ids.has(r.id))throw new Error('Duplicate source ID '+r.id);ids.add(r.id);}
  const sources=await Promise.all(records.map(r=>sourceIndex(dir,r)));
  const goal={purpose:brief.goal.purpose,central_message:brief.goal.central_message,
    audience:brief.audience.description,prior_knowledge:brief.audience.prior_knowledge,
    scope:brief.content.scope_and_structure,uncertainties:brief.content.uncertainties_and_exclusions};
  const revision=hash(JSON.stringify({briefSha,goal,sources:sources.map(s=>[s.id,s.sha256,s.extracted_sha256??null,s.status,s.chunks.map(c=>c.sha256)])}));
  const old=await readKnowledgePlan(project);
  const plan=knowledgePlanSchema.parse({version:1,project,created_at:old?.revision===revision?old.created_at:new Date().toISOString(),
    revision,brief_sha256:briefSha,goal,sources});
  await atomicWrite(await safePath(dir,planPath),JSON.stringify(plan,null,2));
  await renderNotes(project,plan);
  return knowledgeStatus(project);
}
export async function readChunk(project:string,id:string,chunkId:string){
  const plan=await readKnowledgePlan(project);
  if(!plan)throw new Error('Prepare knowledge first.');
  await assertPlan(project,plan);
  const source=plan.sources.find(s=>s.id===id&&s.status==='indexable');
  const chunk=source?.chunks.find(c=>c.id===chunkId);
  if(!source||!chunk)throw new Error('Source chunk missing or unreadable.');
  const {dir}=await loadProject(project);
  const records:SourceRecord[]=(await readYaml(await safePath(dir,'content/sources.yaml'))).sources;
  const r=records.find(r=>r.id===id)!;
  const value=(await fs.readFile(await safePath(dir,r.extracted!),'utf8')).slice(chunk.start,chunk.end);
  if(hash(value)!==chunk.sha256)throw new Error('Extracted chunk changed.');
  return {plan,source,chunk,text:value};
}
export async function readAnalysis(project:string,id:string,chunkId:string,rev:string) {
  const {dir}=await loadProject(project);const p=await safePath(dir,chunkPath(id,chunkId));
  if(!await exists(p))return undefined;
  try{
    const obj=analysisSchema.parse(JSON.parse(await fs.readFile(p,'utf8')));
    return obj.revision===rev&&obj.source_id===id&&obj.chunk_id===chunkId?obj:undefined;
  }catch{return undefined;}
}
export async function submitAnalysis(project:string,raw:unknown){
  const input=analysisSchema.parse(raw);
  const {plan,source,chunk,text}=await readChunk(project,input.source_id,input.chunk_id);
  if(input.revision!==plan.revision||input.source_sha256!==source.sha256)
    throw new Error('Analysis belongs to another source or presentation goal.');
  for(const f of input.findings)if(!text.includes(f.quote))
    throw new Error('A proposed claim contains an unsupported quotation. No analysis saved.');
  const {dir}=await loadProject(project);
  await atomicWrite(await safePath(dir,chunkPath(source.id,chunk.id)),JSON.stringify(input,null,2));
  await renderNotes(project,plan);
  return knowledgeStatus(project);
}
async function renderNotes(project:string,plan:KnowledgePlan){
  const {dir}=await loadProject(project);
  const index=['# Presentation evidence workbench','','**Goal:** '+plan.goal.purpose,
    '**Central message:** '+plan.goal.central_message,'**Audience:** '+plan.goal.audience,'',
    'Status: local source inventory and analyst proposals, not verified scientific conclusions.','',
    '| Source | Extraction | Chunks read | Notes |','| --- | --- | --- | --- |'];
  for(const source of plan.sources){
    const analyses=await Promise.all(source.chunks.map(c=>readAnalysis(project,source.id,c.id,plan.revision)));
    const total=analyses.filter(Boolean).length;
    index.push('| '+source.id+' | '+source.status+' | '+total+'/'+source.chunks.length+' | [Notes](sources/'+source.id+'.md) |');
    const notes=['# '+source.id+' — '+source.path,'','Original SHA-256: '+source.sha256,
      'Extraction: '+source.status+(source.error?' — '+source.error:''),
      'Analyst coverage: '+total+'/'+source.chunks.length,'',
      'The proposed interpretations below have not been verified by an independent scientific expert.',''];
    for(let i=0;i<source.chunks.length;i++){
      const chunk=source.chunks[i],analysis=analyses[i];
      notes.push('## '+chunk.id+' — original text offsets '+chunk.start+'–'+chunk.end,'');
      if(!analysis){notes.push('PENDING: entire chunk has not received a source analysis.','');continue;}
      notes.push('Analyst: '+analysis.analyst.name+' ('+analysis.analyst.model+')','Relevance: '+analysis.relevance,'');
      if(!analysis.findings.length)notes.push('No relevant evidence proposed from this chunk.','');
      for(const finding of analysis.findings){
        notes.push('### '+finding.stance+' — proposed '+finding.use,'',finding.claim,'',
          'Exact source quotation:','',
          '> '+finding.quote.replace(/\s+/g,' ').trim(),'','Limit / uncertainty: '+finding.caveat,'');
        if(['figure','table'].includes(finding.use))
          notes.push('VISUAL NOT VERIFIED: original page/figure/table must be inspected before reuse.','');
      }
    }
    await atomicWrite(await safePath(dir,'knowledge/sources/'+source.id+'.md'),notes.join('\n')+'\n');
  }
  index.push('','Scanned PDFs and unextracted visuals are not silently counted as reviewed. Exact quote membership does not prove semantic support; scientific and figure review remain necessary.');
  await atomicWrite(await safePath(dir,'knowledge/README.md'),index.join('\n')+'\n');
}
export async function knowledgeStatus(project:string){
  const plan=await readKnowledgePlan(project);
  if(!plan)return {state:'not-prepared' as const,complete:false};
  try{await assertPlan(project,plan);}catch(error){return {state:'stale' as const,complete:false,reason:(error as Error).message,revision:plan.revision};}
  const files=await Promise.all(plan.sources.map(async s=>({
    id:s.id,path:s.path,kind:s.kind,status:s.status,error:s.error,total:s.chunks.length,
    reviewed:(await Promise.all(s.chunks.map(c=>readAnalysis(project,s.id,c.id,plan.revision)))).filter(Boolean).length
  })));
  const blocking=files.filter(f=>f.status==='missing-text'||f.status==='integrity-error');
  const pending=files.reduce((sum,f)=>sum+f.total-f.reviewed,0);
  const complete=files.length>0&&!pending&&!blocking.length;
  return {state:complete?'all-text-reviewed':blocking.length?'sources-blocked':'analysis-pending',
    complete,revision:plan.revision,goal:plan.goal,files,pending_chunks:pending,unreadable_count:blocking.length,
    note:complete?'All extractable text was reviewed by recorded analyst responses. Figures and inference remain unverified.':
      'Do not treat the corpus as completely analyzed while any readable chunk remains pending.'};
}
