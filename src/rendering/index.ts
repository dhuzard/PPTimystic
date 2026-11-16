import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { atomicWrite, exists, hash, loadProject, root, safePath, stamp } from '../core/io.js';
import { artifactIssues, inspectArtifacts } from '../core/artifacts.js';
import { fingerprints } from '../core/build.js';
import { writeRevisionPreviews } from './revision-previews.js';

const exec=promisify(execFile);
export async function run(command:string,args:string[],timeout=120000) {
  return exec(command,args,{timeout,windowsHide:true,maxBuffer:8*1024*1024});
}
export async function findTool(name:string, extra:string[] = []) {
  for (const candidate of [...extra,name].filter(Boolean)) {
    try {
      if (path.isAbsolute(candidate) && await exists(candidate)) return candidate;
      const {stdout}=await run(process.platform==='win32'?'where.exe':'which',[candidate],5000);
      if (stdout.trim()) return stdout.trim().split(/\r?\n/)[0];
    } catch { /* optional tool */ }
  }
  return undefined;
}
export async function capabilities() {
  const soffice=await findTool('soffice',[process.env.SOFFICE_PATH??'',...(process.platform==='win32'?['C:/Program Files/LibreOffice/program/soffice.exe']:['/Applications/LibreOffice.app/Contents/MacOS/soffice'])]);
  const pdftoppm=await findTool('pdftoppm',[process.env.PDFTOPPM_PATH??'']);
  let powerpoint=false;
  if (process.platform==='win32') {
    try { const r=await run('powershell.exe',['-NoProfile','-Command',"if ([type]::GetTypeFromProgID('PowerPoint.Application')) { 'available' }"],10000); powerpoint=r.stdout.includes('available'); } catch { /* optional */ }
  }
  return {soffice,pdftoppm,powerpoint};
}
export async function contactSheet(folder:string, files:string[]) {
  const width=640,height=360,gap=24,cols=2,rows=Math.ceil(files.length/cols);
  const canvas=sharp({create:{width:cols*(width+gap)+gap,height:rows*(height+gap)+gap,channels:3,background:'#e4e4e7'}});
  const tiles=await Promise.all(files.map(async(file,i)=>({input:await sharp(path.join(folder,file)).resize(width,height,{fit:'contain',background:'#fff'}).png().toBuffer(),left:gap+(i%cols)*(width+gap),top:gap+Math.floor(i/cols)*(height+gap)})));
  await canvas.composite(tiles).png().toFile(path.join(folder,'contact-sheet.png'));
}
export async function renderProject(name:string,locale?:string,renderer='auto') {
  const {dir,config,deck:source,theme}=await loadProject(name);
  const tools=await capabilities();
  const selected=renderer==='auto' ? (tools.soffice&&tools.pdftoppm?'libreoffice':tools.powerpoint?'powerpoint':'none') : renderer;
  if (selected==='none' || (selected==='libreoffice' && (!tools.soffice||!tools.pdftoppm)) || (selected==='powerpoint' && !tools.powerpoint)) {
    return {available:false,message:'No complete local renderer. Install LibreOffice and pdftoppm, or use PowerPoint on Windows. PPTX creation remains available.',folders:[] as string[]};
  }
  const artifacts = await inspectArtifacts(name, locale);
  const freshnessIssues = artifactIssues(artifacts);
  if (freshnessIssues.length) throw new Error(freshnessIssues.map(i => `${i.locale}: ${i.message}`).join('\n'));
  const folders:string[]=[];
  const slideStates=await fingerprints(dir,source,theme,config.animations);
  for (const lang of locale?[locale]:config.output_locales) {
    const artifact = artifacts.find(a => a.locale === lang)!;
    const deck=await safePath(dir,`output/presentation.${lang}.pptx`);
    if (!(await exists(deck))) throw new Error(`Build ${lang} before rendering.`);
    const output=await safePath(dir,`output/previews/${lang}/${stamp()}-${crypto.randomUUID().slice(0,8)}`);
    const latest=await safePath(dir,`output/previews/${lang}/latest.json`);
    const previousFolder=await exists(latest) ? (JSON.parse(await fs.readFile(latest,'utf8')) as {folder:string}).folder : undefined;
    // Keep all preview reads within this project's retained preview history.
    const previous=previousFolder ? await safePath(dir,path.relative(dir,previousFolder)) : undefined;
    await fs.mkdir(output,{recursive:true});
    if (selected==='powerpoint') {
      await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'src/rendering/powerpoint.ps1'),'-Deck',deck,'-Destination',output]);
    } else {
      // A unique profile avoids interfering with the user's running LibreOffice instance.
      const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pptimistic-lo-'));
      try {
        const {pathToFileURL}=await import('node:url');
        await run(tools.soffice!,[`-env:UserInstallation=${pathToFileURL(profile).href}`,'--headless','--convert-to','pdf','--outdir',output,deck]);
        const pdf=path.join(output,`presentation.${lang}.pdf`);
        if (!(await exists(pdf))) throw new Error('LibreOffice did not produce a PDF.');
        await run(tools.pdftoppm!,['-png','-scale-to','1600',pdf,path.join(output,'slide')]);
      } finally { await fs.rm(profile,{recursive:true,force:true}); }
    }
    const files=(await fs.readdir(output)).filter(f=>/\.png$/i.test(f)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    if (!files.length) throw new Error('Renderer produced no slide images.');
    await writeRevisionPreviews(output,files,source.slides.map(slide=>{
      const state=slideStates[slide.id];
      const {review: _review, source_fingerprint: _sourceFingerprint, ...authoredText}=slide.content[lang];
      return {id:slide.id,fingerprint:hash(JSON.stringify([state.fingerprint,authoredText])),
        protected:state.protected||state.locales[lang].protected,acceptedAsset:state.acceptedAsset};
    }),lang,artifact.sha256!,previous);
    await contactSheet(output,files);
    await atomicWrite(path.join(output,'render.json'),JSON.stringify({renderer:selected,pptx:deck,pptxSha256:artifact.sha256,sourceFingerprint:artifact.sourceFingerprint,artifactStatus:artifact.status,slides:files,revisionPreviews:'revision-previews.json',visualInspection:'Not performed automatically. Open contact-sheet.png and individual previews.'},null,2));
    await atomicWrite(await safePath(dir,`output/previews/${lang}/latest.json`),JSON.stringify({folder:output},null,2));
    folders.push(output);
  }
  return {available:true,message:`Rendered with ${selected}.`,folders};
}
