import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, exists, hash, safePath, writeYaml } from './io.js';
import { createProject } from './projects.js';
import { deckSchema, type Deck } from './model.js';
import { importPptxScene } from '../session/pptx-native.js';

export const pptxReviewMarker='content/pptx-review-origin.json';
export type PowerPointReviewOrigin={
  version:1; source:string; source_sha256:string; slide_count:number;
  text_extraction:'partial-ooxml'; visual_review:'not-inspected'; original_preserved:true;
};
/** Review an original file; NEVER represent the analysis mirror as the editable original. */
export async function createPptxReviewProject(input:{
  name:string;title:string;locale:'en-US'|'fr-FR';data:Uint8Array;
}){
  if(input.data.byteLength>25_000_000)throw new Error('PowerPoint exceeds the review-import limit of 25 MB.');
  const bytes=Buffer.from(input.data);
  const scene=await importPptxScene(bytes);
  if(!scene.slides.length || scene.slides.length>250)
    throw new Error('PowerPoint review supports 1–250 slides. Split a larger file into reviewable parts.');
  const id='SRC-'+hash(Buffer.from('original.pptx')).slice(0,12);
  const content=scene.slides.map((slide,i)=>{
    const entries=slide.objects.flatMap(object=>object.runs.length?[
      object.runs.map((run,j,arr)=>(j && run.paragraph!==arr[j-1].paragraph?'\n':'')+run.text).join('')
    ]:[]).map(x=>x.trim()).filter(Boolean);
    const heading=entries[0]?.slice(0,200) || 'Original slide '+(i+1)+' (visual content not extracted)';
    const description=entries.slice(1).join('\n').slice(0,30000);
    return {
      id:'S'+String(i+1).padStart(3,'0'),
      layout:'statement' as const,
      evidence:'missing' as const,
      source_refs:[id],
      content:{[input.locale]:{
        title:heading, body:description,
        notes:'REVIEW-ONLY TEXT MIRROR. The original .pptx is the authority. Charts, figures, tables, grouped objects, speaker notes and animation may not be represented. Inspect original slide visuals before signing a scientific review.'
      }}
    };
  });
  const deck:Deck=deckSchema.parse({version:1,slides:content});
  const extracted=scene.slides.map((slide,i)=>
    '## Original slide '+(i+1)+'\n'+
    slide.objects.map(object=>object.runs.map(run=>run.text).join(' ')).filter(Boolean).join('\n')+'\n').join('\n');
  const sourceSha=hash(bytes);
  const origin:PowerPointReviewOrigin={version:1,source:'inputs/original.pptx',source_sha256:sourceSha,
    slide_count:scene.slides.length,text_extraction:'partial-ooxml',
    visual_review:'not-inspected',original_preserved:true};
  const dir=await createProject({name:input.name,title:input.title,source:input.locale,locales:[input.locale],
    theme:'editorial-minimal',briefRequired:true});
  await atomicWrite(await safePath(dir,'inputs/original.pptx'),bytes);
  const extractedPath='content/extracted/'+id+'.txt';
  await atomicWrite(await safePath(dir,extractedPath),extracted);
  await writeYaml(await safePath(dir,'content/sources.yaml'),{sources:[{
    id,path:origin.source,sha256:sourceSha,kind:'pptx',
    extracted:extractedPath,extracted_sha256:hash(extracted)
  }]});
  await writeYaml(await safePath(dir,'content/slides.yaml'),deck);
  await atomicWrite(await safePath(dir,pptxReviewMarker),JSON.stringify(origin,null,2));
  return {name:input.name,slide_count:scene.slides.length,source_sha256:sourceSha,original_preserved:true,
    warning:'Read-only scientific review mirror. Original PowerPoint remains unchanged. Figures/charts and speaker notes need visual inspection.'};
}
export async function readPptxReviewOrigin(dir:string) {
  const marker=await safePath(dir,pptxReviewMarker);
  if(!await exists(marker))return undefined;
  const raw=JSON.parse(await fs.readFile(marker,'utf8')) as PowerPointReviewOrigin;
  if(raw.version!==1||raw.source!=='inputs/original.pptx'||!raw.original_preserved)
    throw new Error('Invalid original PowerPoint review marker.');
  const file=await safePath(dir,raw.source);
  if(await hash(Buffer.from(await fs.readFile(file)))!==raw.source_sha256)
    throw new Error('Original PowerPoint changed after review import.');
  return raw;
}


/** Best-effort one-pass rendering of the ORIGINAL, never the YAML text mirror. */
export async function renderReviewOriginal(project:string){
  const {loadProject}=await import('./io.js');
  const {dir,config,deck}=await loadProject(project);
  const origin=await readPptxReviewOrigin(dir);
  if(!origin)throw new Error('This project was not created from an original PowerPoint.');
  const {capabilities,run,contactSheet}=await import('../rendering/index.js');
  const tools=await capabilities();
  if(!(tools.soffice&&tools.pdftoppm)&&!tools.powerpoint)
    return {available:false,message:'Install LibreOffice and pdftoppm, or PowerPoint on Windows, to inspect original slide visuals. Text-only review cannot certify graphics.'};
  const os=await import('node:os');
  const {pathToFileURL}=await import('node:url');
  const {root}=await import('./io.js');
  const staging=await fs.mkdtemp(path.join(os.tmpdir(),'pptimistic-original-review-'));
  try{
    const source=await safePath(dir,origin.source);
    if(tools.soffice&&tools.pdftoppm){
      const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pptimistic-review-lo-'));
      try{
        await run(tools.soffice,['-env:UserInstallation='+pathToFileURL(profile).href,
          '--headless','--convert-to','pdf','--outdir',staging,source],180000);
        const pdf=path.join(staging,'original.pdf');
        if(!await exists(pdf))throw new Error('Original PowerPoint did not render to PDF.');
        await run(tools.pdftoppm,['-png','-scale-to','1600',pdf,path.join(staging,'slide')],180000);
      }finally{await fs.rm(profile,{recursive:true,force:true});}
    }else{
      const ps=path.join(root,'src/rendering/powerpoint.ps1');
      await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',ps,
        '-Deck',source,'-Destination',staging],180000);
    }
    const images=(await fs.readdir(staging)).filter(name=>/^slide-?\d+\.png$/i.test(name))
      .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    if(images.length!==origin.slide_count)throw new Error('Original rendering produced '+images.length+
      ' images, expected '+origin.slide_count+'. Review output was not marked current.');
    const target=await safePath(dir,'output/reference');
    await fs.mkdir(target,{recursive:true});
    const frames:{id:string;image:string;sha256:string}[]=[];
    const frameNames:string[]=[];
    for(const [i,file] of images.entries()){
      const name='original-'+String(i+1).padStart(3,'0')+'.png';
      const image=await fs.readFile(path.join(staging,file));
      await atomicWrite(await safePath(dir,'output/reference/'+name),image);
      frames.push({id:deck.slides[i].id,image:'output/reference/'+name,sha256:hash(image)});
      frameNames.push(name);
    }
    await contactSheet(target,frameNames);
    await atomicWrite(await safePath(dir,'content/reference-preview.json'),JSON.stringify({
      version:1,source:origin.source,sourceSha256:origin.source_sha256,locale:config.source_locale,slides:frames
    },null,2));
    return {available:true,slide_count:frames.length,
      message:'Rendered original PowerPoint slides for scientific inspection. Visual content still requires an actual reviewer to view the images.'};
  }finally{await fs.rm(staging,{recursive:true,force:true});}
}
