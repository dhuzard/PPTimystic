import { afterAll, beforeAll, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import * as Y from 'yjs';
import sharp from 'sharp';
import { demoDeck, ideaSvg } from '../src/content/demo.js';
import type { SessionSnapshot } from '../src/session/contracts.js';

const repo=process.cwd();
let sandbox:string, child:ChildProcessWithoutNullStreams, origin:string;
let owner='', editor='', reviewer='';
const file=(relative:string)=>path.join(sandbox,'projects/demo',relative);
async function api(route:string,body?:unknown,cookie=owner,requestOrigin=origin) {
  const response=await fetch(`${origin}${route}`,{method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:requestOrigin,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const raw=await response.text(); let value:any;
  try {value=JSON.parse(raw);} catch {value=raw;}
  return {status:response.status,value,response};
}
async function state(locale='en-US') {const result=await api(`/api/state?locale=${locale}`);expect(result.status).toBe(200);return result.value as SessionSnapshot;}
async function operation(slideId:string,objectId:string,kind:string,value:unknown,cookie=owner,authorize:string[]=[],revision?:number,locale='en-US') {
  return api('/api/operations',{slideId,locale,objectId:objectId||undefined,kind,value,expectedRevision:revision??(await state()).revision,authorize},cookie);
}

beforeAll(async()=>{
  sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'pptimistic-session-security-'));
  await fs.cp(path.join(repo,'config'),path.join(sandbox,'config'),{recursive:true});
  await fs.mkdir(file('content'),{recursive:true});await fs.mkdir(file('assets/reference'),{recursive:true});await fs.mkdir(file('inputs'),{recursive:true});
  await fs.writeFile(file('assets/reference/idea.svg'),ideaSvg);await fs.writeFile(file('inputs/private.txt'),'Private input is not an editor asset.');
  await fs.writeFile(file('project.yaml'),YAML.stringify({version:1,title:'Session security fixture',source_locale:'en-US',output_locales:['en-US','fr-FR'],theme:'editorial-minimal'}));
  const deck=demoDeck('Session security fixture');deck.slides[0].status='locked';deck.slides[0].locked=true;
  await fs.writeFile(file('content/slides.yaml'),YAML.stringify(deck));
  const helper=path.join(sandbox,'session-helper.mts');
  await fs.writeFile(helper,`import {startSession} from ${JSON.stringify(pathToFileURL(path.join(repo,'src/session/server.ts')).href)};
import {buildProject} from ${JSON.stringify(pathToFileURL(path.join(repo,'src/core/build.ts')).href)};
await buildProject('demo');
const session=await startSession({project:'demo',port:0});
console.log('SESSION_READY:'+JSON.stringify({url:session.url,ownerToken:session.ownerToken,editorToken:session.editorToken,reviewerToken:session.reviewerToken}));
process.stdin.resume();process.stdin.once('data',async()=>{await session.close();process.exit(0);});
`);
  child=spawn(process.execPath,['--import',pathToFileURL(path.join(repo,'node_modules/tsx/dist/loader.mjs')).href,helper],{cwd:sandbox,stdio:'pipe',windowsHide:true});
  const ready=await new Promise<{url:string;ownerToken:string;editorToken:string;reviewerToken:string}>((resolve,reject)=>{
    let output='';const timeout=setTimeout(()=>reject(new Error(`Session startup timed out: ${output}`)),45000);
    child.stderr.on('data',data=>{output+=data.toString();});
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Session exited ${code}: ${output}`));});
    child.stdout.on('data',data=>{output+=data.toString();const line=output.split(/\r?\n/).find(line=>line.startsWith('SESSION_READY:'));if(line){clearTimeout(timeout);resolve(JSON.parse(line.slice('SESSION_READY:'.length)));}});
  });
  origin=new URL(ready.url).origin;
  async function join(token:string,name:string){const response=await api('/api/join',{token,name},'');expect(response.status,JSON.stringify(response.value)).toBeLessThan(300);return response.response.headers.get('set-cookie')!.split(';')[0];}
  owner=await join(ready.ownerToken,'Owner');editor=await join(ready.editorToken,'Editor');reviewer=await join(ready.reviewerToken,'Reviewer');
},60000);
afterAll(async()=>{
  if(child && child.exitCode===null){await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.stdin.write('stop\n');setTimeout(()=>{child.kill();resolve();},4000).unref();});}
  if(sandbox)await fs.rm(sandbox,{recursive:true,force:true});
});

test('private state requires a session and cross-origin writes and non-assets are rejected',async()=>{
  expect((await api('/api/state?locale=en-US',undefined,'')).status).toBe(401);
  expect((await api('/api/comments',{slideId:'S003',locale:'en-US',message:'Foreign origin'},owner,'https://foreign.invalid')).status).toBe(403);
  expect((await api('/api/assets?path=inputs%2Fprivate.txt')).status).toBeGreaterThanOrEqual(400);
  expect((await api('/api/assets?path=assets%2F..%2Finputs%2Fprivate.txt')).status).toBeGreaterThanOrEqual(400);
});

test('preview manifests cannot expose input files and retained upload provenance is immutable',async()=>{
  await fs.mkdir(file('output/previews/en-US'),{recursive:true});
  await fs.writeFile(file('inputs/contact-sheet.png'),'PRIVATE_IMAGE_BYTES');
  await fs.writeFile(file('output/previews/en-US/latest.json'),JSON.stringify({folder:file('inputs')}));
  const preview=await api('/api/previews?locale=en-US');
  expect(preview.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(preview.value)).not.toContain('PRIVATE_IMAGE_BYTES');
  const disguised=await fetch(`${origin}/api/uploads`,{method:'POST',headers:{Cookie:owner,Origin:origin,'Content-Type':'image/png'},body:'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>'});
  expect(disguised.status).toBe(400);
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#338855'}}).png().toBuffer();
  const upload=()=>fetch(`${origin}/api/uploads`,{method:'POST',headers:{Cookie:owner,Origin:origin,'Content-Type':'image/png'},body:bytes});
  const first=await upload();expect(first.status).toBe(200);const {asset}=await first.json() as {asset:string};
  const initial=(await fs.readdir(file('assets/session'))).filter(name=>name.endsWith('.provenance.json'));
  const saved=await fs.readFile(file(`assets/session/${initial[0]}`),'utf8');
  expect((await upload()).status).toBe(200);
  expect((await fs.readdir(file('assets/session'))).filter(name=>name.endsWith('.provenance.json'))).toHaveLength(initial.length+1);
  expect(await fs.readFile(file(`assets/session/${initial[0]}`),'utf8')).toBe(saved);
  await fs.writeFile(file(asset),'External image change');
  expect((await upload()).status).toBe(409);expect(await fs.readFile(file(asset),'utf8')).toBe('External image change');
});

test('reviewers can comment while edits and protection authorization require the correct role',async()=>{
  expect((await operation('S003','S003:title','text','Reviewer edit',reviewer)).status).toBe(403);
  expect((await api('/api/comments',{slideId:'S003',locale:'en-US',message:'Please retain the source.',category:'content'},reviewer)).status).toBeLessThan(300);
  const before=await fs.readFile(file('content/slides.yaml'),'utf8');
  expect((await operation('S001','S001:title','text','Unauthorized owner edit')).status).toBe(403);
  expect((await operation('S001','S001:title','text','Spoofed approval',editor,['S001'])).status).toBe(403);
  expect(await fs.readFile(file('content/slides.yaml'),'utf8')).toBe(before);
  expect((await operation('S001','S001:title','text','Reviewed title',owner,['S001'])).status).toBeLessThan(300);
  expect((await api('/api/exports?file=presentation.en-US.pptx')).status).toBe(409);
});

test('stale object geometry is rejected without losing the accepted edit',async()=>{
  const revision=(await state()).revision;
  expect((await operation('S004','S004:title','geometry',{x:.8},editor,[],revision)).status).toBeLessThan(300);
  expect((await operation('S004','S004:title','geometry',{x:.9},editor,[],revision)).status).toBe(409);
  expect((await state()).slides.find(slide=>slide.id==='S004')!.scene!.objects.find(object=>object.role==='title')!.x).toBe(.8);
});

test('live snapshots report text overflow before an export is attempted',async()=>{
  const original=(await state()).slides.find(slide=>slide.id==='S004')!.scene!.objects.find(object=>object.role==='title')!;
  expect((await operation('S004','S004:title','geometry',{w:1,h:.3})).status).toBe(200);
  expect((await state()).issues).toContainEqual(expect.objectContaining({code:'text-overflow',slide:'S004',locale:'en-US'}));
  expect((await operation('S004','S004:title','geometry',{w:original.w,h:original.h})).status).toBe(200);
});

test('unsupported visual style properties fail without recording a misleading successful edit',async()=>{
  const current=await state(),workflow=current.slides.find(slide=>slide.id==='S003')!.scene!;
  for (const [slideId,id,value,authorize] of [
    ['S004','S004:chart',{fontSize:22},[]],
    ['S003',workflow.objects.find(object=>object.type==='shape')!.id,{bold:true},[]],
    ['S003',workflow.objects.find(object=>object.type==='connector')!.id,{fill:'112233'},[]],
    ['S002','S002:illustration',{color:'112233'},['S002']],
  ] as [string,string,unknown,string[]][]) expect((await operation(slideId,id,'style',value,owner,authorize)).status).toBe(400);
  expect((await state()).revision).toBe(current.revision);
});

test('accepted illustrations and added images require explicit owner replacement or removal authority',async()=>{
  expect((await operation('S002','S002:illustration','image',{asset:'assets/reference/idea.svg'},editor)).status).toBe(403);
  expect((await operation('S002','S002:illustration','geometry',{x:7.1},owner)).status).toBe(403);
  const id='object-42345678-1234-4234-8234-123456789abc';
  const added=await operation('S005','','add',{id,type:'image',x:9,y:6.25,w:2,h:.55,asset:'assets/reference/idea.svg',alt:'A supplied illustration'});
  expect(added.status,JSON.stringify(added.value)).toBeLessThan(300);
  const before=await fs.readFile(file('content/slides.yaml'),'utf8');
  const addedState=await state(),entry=addedState.history.at(-1)!;
  expect((await api('/api/undo',{id:entry.id,expectedRevision:addedState.revision})).status).toBe(403);
  expect((await operation('S005',`S005:${id}`,'delete',null)).status).toBe(403);
  expect(await fs.readFile(file('content/slides.yaml'),'utf8')).toBe(before);
  expect((await operation('S005',`S005:${id}`,'delete',null,owner,['S005'])).status).toBeLessThan(300);
});

test('agent proposals reject a changed slide context even when their target object is untouched',async()=>{
  expect((await api('/api/comments',{slideId:'S003',locale:'en-US',objectId:'S003:title',message:'Review the title in context.',askAgent:true})).status).toBe(200);
  const snapshot=await state(),job=snapshot.jobs.at(-1)!;
  expect((await api(`/api/jobs/${job.id}/propose`,{summary:'A proposed title',operations:[{slideId:'S003',locale:'en-US',objectId:'S003:title',kind:'text',value:'Proposed after review',expectedRevision:snapshot.revision}]})).status).toBe(200);
  expect((await operation('S003','S003:body','text','A collaborator changed the slide context.')).status).toBe(200);
  expect((await api(`/api/jobs/${job.id}/apply`,{})).status).toBe(409);
  expect((await state()).jobs.find(item=>item.id===job.id)!.status).toBe('conflict');
});

test('concurrent plain-text updates merge, while rich or foreign Yjs types cannot mutate source',async()=>{
  const initial=await state(),key='S003|en-US|S003:title',shared=initial.texts[key];
  const updates:string[]=[];
  for(const suffix of [' A',' B']){
    const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(shared.update,'base64'));const vector=Y.encodeStateVector(doc);
    doc.getText('text').insert(doc.getText('text').length,suffix);updates.push(Buffer.from(Y.encodeStateAsUpdate(doc,vector)).toString('base64'));doc.destroy();
  }
  for(const update of updates)expect((await api('/api/text',{slideId:'S003',locale:'en-US',objectId:'S003:title',generation:shared.generation,update},editor)).status).toBeLessThan(300);
  const merged=await state(),title=merged.slides.find(slide=>slide.id==='S003')!.scene!.objects.find(object=>object.role==='title')!.text!;
  expect(title).toContain(' A');expect(title).toContain(' B');
  const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(merged.texts[key].update,'base64'));doc.getMap('forbidden').set('payload','unexpected');
  const rejected=await api('/api/text',{slideId:'S003',locale:'en-US',objectId:'S003:title',generation:merged.texts[key].generation,update:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')},editor);doc.destroy();
  expect(rejected.status).toBe(400);expect((await state()).revision).toBe(merged.revision);
});

test('custom translation can be completed in the editor and missing content cannot be approved',async()=>{
  const id='object-32345678-1234-4234-8234-123456789abc';
  expect((await operation('S005','', 'add',{id,type:'text',x:.7,y:6.4,w:3,h:.4,text:'Supplied text'})).status).toBeLessThan(300);
  const french=await state('fr-FR');
  expect(french.slides.find(slide=>slide.id==='S005')!.scene!.objects.find(object=>object.role===id)).toMatchObject({text:'',missingTranslation:true});
  expect((await operation('S005','', 'translation-review','approved',owner,[],undefined,'fr-FR')).status).toBe(400);
  expect((await operation('S005',`S005:${id}`,'text','Texte fourni',owner,[],undefined,'fr-FR')).status).toBeLessThan(300);
  expect((await state('fr-FR')).slides.find(slide=>slide.id==='S005')!.scene!.objects.find(object=>object.role===id)!.text).toBe('Texte fourni');
});

test('external source edits invalidate old text generations without overwriting the external file',async()=>{
  const prior=await state(),key='S003|en-US|S003:title';
  const deck=YAML.parse(await fs.readFile(file('content/slides.yaml'),'utf8'));deck.slides[2].content['en-US'].title='External revision';
  const bytes=YAML.stringify(deck);await fs.writeFile(file('content/slides.yaml'),bytes);
  expect((await api('/api/text',{slideId:'S003',locale:'en-US',objectId:'S003:title',generation:prior.texts[key].generation,update:prior.texts[key].update},editor)).status).toBe(409);
  expect(await fs.readFile(file('content/slides.yaml'),'utf8')).toBe(bytes);
  expect((await state()).texts[key].generation).not.toBe(prior.texts[key].generation);
});

test('external retained image changes revoke stored export authorization and invalidate cached scenes',async()=>{
  // Establish an explicit recorded grant for a protected slide without changing its wording.
  const current=await state();
  const title=current.slides.find(slide=>slide.id==='S001')!.scene!.objects.find(object=>object.role==='title')!.text!;
  expect((await operation('S001','S001:title','text',title,owner,['S001'])).status).toBe(200);
  const before=JSON.parse(await fs.readFile(file('.session/state.json'),'utf8'));
  expect(before.authorized).toContain('S001');expect(before.sourceAssetsHash).toMatch(/^[a-f0-9]{64}$/);
  const image=await fs.readFile(file('assets/reference/idea.svg'));
  await fs.appendFile(file('assets/reference/idea.svg'),'\n<!-- external image change -->');
  const refreshed=await state();
  const after=JSON.parse(await fs.readFile(file('.session/state.json'),'utf8'));
  expect(after.authorized).toEqual([]);expect(after.sourceAssetsHash).not.toBe(before.sourceAssetsHash);expect(refreshed.revision).toBeGreaterThan(before.revision);
  expect((await api('/api/export',{locale:'en-US'})).status).toBeGreaterThanOrEqual(400);
  await fs.writeFile(file('assets/reference/idea.svg'),image);
});


test('scientific readiness report is readable by session members but only owner can sign or override',async()=>{
  const report=await api('/api/readiness',undefined,reviewer);
  expect(report.status).toBe(200);
  expect(report.value.status).toBeDefined();
  const payload={
    revision:'a'.repeat(64),record_sha256:'b'.repeat(64),
    acknowledgement:{
      scientific_positioning_read:true,methods_and_limitations_understood:true,
      expert_questions_reviewed:true,unresolved_findings_reviewed:true
    }
  };
  expect((await api('/api/readiness/approve',payload,reviewer)).status).toBe(403);
  expect((await api('/api/readiness/approve',payload,editor)).status).toBe(403);
  expect((await api('/api/readiness/override',{revision:payload.revision,record_sha256:payload.record_sha256,
    reason:'The presenter explicitly acknowledges the remaining scientific uncertainty.',confirmed:true},editor)).status).toBe(403);
  expect((await api('/api/readiness/finding',{id:'REV-001',decision:'accept'},editor)).status).toBe(403);
  // Even the owner cannot sign a project with no independent review.
  expect((await api('/api/readiness/approve',payload,owner)).status).toBeGreaterThanOrEqual(400);
});
