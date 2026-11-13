import fs from 'node:fs/promises';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { atomicWrite, exists, hash, hashFile, loadProject, readYaml, safePath, stamp } from './io.js';
import { resolveChartData } from '../content/chart-data.js';
import { drawSlide, validateGeometry } from '../layouts/index.js';
import { finalizeAccessibility } from '../layouts/accessibility.js';
import { validateContent, validatePptx, type Issue } from '../validation/index.js';
import type { Deck, Project, Theme } from './model.js';

export type BuildProvenance = { chartSelections?:Record<string,Awaited<ReturnType<typeof resolveChartData>>['selection']>; buildId:string; locale:string; pptxSha256:string; sourceFingerprint:string; sources:Record<string,string>; sourceRecords:Record<string,{path:string; sha256:string; recordedSha256:string; extracted?:{path:string; sha256:string; recordedSha256:string}}> ; assets:Record<string,{path:string; sha256:string}>; prompts:Record<string,{path:string; sha256:string; role:'preparation-or-reuse'; generationProvenance:'unavailable'}> };
export type BuildState = { version?:2; files: Record<string,string>; slides: Record<string,{ fingerprint:string; protected:boolean; acceptedAsset?:{path:string; sha256:string}; acceptedAssets?:Record<string,{path:string; sha256:string}>; locales: Record<string,{ fingerprint:string; protected:boolean }> }>; provenance?:Record<string,BuildProvenance> };
async function customAssetEvidence(dir:string, slide:Deck['slides'][number]) {
  const assets:Record<string,{path:string;sha256:string}>={};
  for (const object of slide.objects??[]) if (object.type==='image' && object.asset) {
    const file=await safePath(dir,object.asset);
    assets[object.id]={path:object.asset,sha256:await exists(file) ? await hashFile(file) : '<missing>'};
  }
  return assets;
}
async function sourceEvidence(dir:string,deck:Deck) {
  const index=await safePath(dir,'content/sources.yaml');
  const present=await exists(index);
  const indexSha256=present ? await hashFile(index) : '<missing>';
  const entries: {id:string;path:string;sha256:string;extracted?:string;extracted_sha256?:string}[]=present ? (await readYaml(index)).sources : [];
  const records:BuildProvenance['sourceRecords']={};
  for (const id of [...new Set(deck.slides.flatMap(s=>s.source_refs))].sort()) {
    const entry=entries.find(e=>e.id===id);
    if (!entry) {records[id]={path:'<missing>',sha256:'<missing>',recordedSha256:'<missing>'};continue;}
    const file=await safePath(dir,entry.path);
    const extracted=entry.extracted ? await safePath(dir,entry.extracted) : undefined;
    records[id]={path:entry.path,sha256:await exists(file) ? await hashFile(file) : '<missing>',recordedSha256:entry.sha256,
      ...(extracted ? {extracted:{path:entry.extracted!,sha256:await exists(extracted) ? await hashFile(extracted) : '<missing>',recordedSha256:entry.extracted_sha256??'<missing>'}} : {})};
  }
  return {indexSha256,records};
}
export async function sourceFingerprint(dir:string, config:Project, deck:Deck, theme:Theme, locale:string) {
  const slides=await Promise.all(deck.slides.map(async s=>{
    const asset=s.visual?.asset ? await safePath(dir,s.visual.asset) : undefined;
    return {...s,content:s.content[locale]??null,assetSha256:asset && await exists(asset) ? await hashFile(asset) : asset ? '<missing>' : null,
      ...(s.objects?.some(object=>object.type==='image') ? {objectAssets:await customAssetEvidence(dir,s)} : {})};
  }));
  const briefFile = config.brief_required ? await safePath(dir, 'presentation-brief.yaml') : undefined;
  const briefHash = briefFile ? (await exists(briefFile) ? await hashFile(briefFile) : '<missing>') : undefined;
  // Preserve legacy demo fingerprints: before the onboarding feature, this
  // optional project setting was absent rather than explicitly false.
  const { brief_required: _required, ...legacyConfig } = config;
  const configFingerprint = config.brief_required ? config : legacyConfig;
  return hash(JSON.stringify({config:configFingerprint,theme,locale,slides,sourceEvidence:await sourceEvidence(dir,deck),...(config.brief_required?{briefHash}:{})}));
}
export async function fingerprints(dir: string, deck: Awaited<ReturnType<typeof loadProject>>['deck'], theme: unknown) {
  const result: BuildState['slides']={};
  for (const s of deck.slides) {
    const assetPath = s.visual?.asset ? await safePath(dir,s.visual.asset) : undefined;
    const asset = assetPath ? (await exists(assetPath) ? await hashFile(assetPath) : '<missing>') : '';
    const { content, status, locked, ...shared }=s;
    const objectAssets=await customAssetEvidence(dir,s);
    const acceptedAssets=Object.fromEntries((s.objects??[]).filter(object=>object.type==='image' && object.accepted).map(object=>[object.id,objectAssets[object.id]]));
    const base={shared,theme,asset,...(Object.keys(objectAssets).length ? {objectAssets} : {})};
    result[s.id]={fingerprint:hash(JSON.stringify(base)),protected:locked||status==='approved'||status==='locked',
      ...(s.visual?.accepted && s.visual.asset ? {acceptedAsset:{path:s.visual.asset,sha256:asset}} : {}),
      ...(Object.keys(acceptedAssets).length ? {acceptedAssets} : {}),
      locales:Object.fromEntries(Object.entries(content).map(([locale,c])=>{
        const {review,...text}=c;
        return [locale,{fingerprint:hash(JSON.stringify(text)),protected:review==='approved'||review==='locked'}];
      }))};
  }
  return result;
}
export function protectionIssues(previous: BuildState|undefined,next: BuildState['slides'], authorized: string[]) {
  const issues: string[]=[];
  if (!previous) return issues;
  for (const [id,old] of Object.entries(previous.slides)) {
    if (authorized.includes(id)) continue;
    const n=next[id];
    if (Object.entries(old.acceptedAssets??{}).some(([key,asset])=>!n?.acceptedAssets?.[key] || n.acceptedAssets[key].path!==asset.path || n.acceptedAssets[key].sha256!==asset.sha256)) issues.push(`${id}: accepted custom image changed, removed, or acceptance removed. Explicitly authorize it with --authorize ${id}.`);
    else if (old.acceptedAsset && (!n?.acceptedAsset || n.acceptedAsset.path!==old.acceptedAsset.path || n.acceptedAsset.sha256!==old.acceptedAsset.sha256)) issues.push(`${id}: accepted image changed or acceptance removed. Explicitly authorize it with --authorize ${id}.`);
    else if (old.protected && (!n || !n.protected || n.fingerprint!==old.fingerprint || Object.entries(old.locales).some(([l,v])=>n.locales[l]?.fingerprint!==v.fingerprint))) issues.push(`${id}: approved/locked slide changed. Explicitly authorize it with --authorize ${id}.`);
    else if (Object.entries(old.locales).some(([l,v])=>v.protected && (!n || n.fingerprint!==old.fingerprint || !n.locales[l]?.protected || n.locales[l]?.fingerprint!==v.fingerprint))) issues.push(`${id}: approved/locked translation changed. Explicitly authorize it with --authorize ${id}.`);
  }
  return issues;
}
export async function loadProtectionBaseline(dir:string):Promise<{state:BuildState|undefined; legacyUnverifiable:boolean}> {
  const output=await safePath(dir,'output');
  const stateFile=path.join(output,'build-state.json');
  const previous: BuildState|undefined=await exists(stateFile) ? JSON.parse(await fs.readFile(stateFile,'utf8')) : undefined;
  let legacyUnverifiable=Boolean(previous && previous.version!==2);
  // Older states did not record accepted assets separately. Recover the baseline
  // from the corresponding build snapshot, failing closed if its bytes changed.
  const lastReport=path.join(output,'build.json');
  if (previous && await exists(lastReport)) {
    const {buildId}=JSON.parse(await fs.readFile(lastReport,'utf8')) as {buildId?:string};
    if (buildId && /^[A-Za-z0-9-]+$/.test(buildId)) {
      const snapshot=path.join(output,'history',buildId,'source.snapshot.json');
      if (await exists(snapshot)) {
        const old=JSON.parse(await fs.readFile(snapshot,'utf8')) as {deck:Deck; theme:Theme};
        const recovered=await fingerprints(dir,old.deck,old.theme);
        for (const [id,slide] of Object.entries(recovered)) {
          if (slide.acceptedAsset && previous.slides[id] && !previous.slides[id].acceptedAsset) {
            previous.slides[id].acceptedAsset={...slide.acceptedAsset,sha256:slide.fingerprint===previous.slides[id].fingerprint ? slide.acceptedAsset.sha256 : '<unverifiable>'};
          }
        }
        legacyUnverifiable=false;
      }
    }
  }
  return {state:previous,legacyUnverifiable};
}
export async function buildProject(name: string, options: {locale?:string; authorize?:string[]}={}) {
  const {dir,config,deck,theme}=await loadProject(name);
  if (deck.slides.some(slide=>slide.native_text && Object.keys(slide.native_text.objects).length)) throw new Error('This project contains edits to original PowerPoint objects. Generic build cannot preserve them; reconcile the native edits with the presentation-specific builder first.');
  const locales=options.locale ? [options.locale] : config.output_locales;
  const output=await safePath(dir,'output');
  await fs.mkdir(output,{recursive:true});
  const stateFile=path.join(output,'build-state.json');
  const {state:previous,legacyUnverifiable}=await loadProtectionBaseline(dir);
  const next=await fingerprints(dir,deck,theme);
  const issues: Issue[]=await validateContent(dir,config,deck,theme,locales);
  if (legacyUnverifiable) for (const [id,old] of Object.entries(previous?.slides??{})) if ((!next[id] || next[id].fingerprint!==old.fingerprint) && !options.authorize?.includes(id)) issues.push({severity:'error',code:'protected-slide',message:`${id}: legacy image protection baseline is unavailable and shared slide content changed. Explicitly authorize it with --authorize ${id}.`});
  for (const message of protectionIssues(previous,next,options.authorize??[])) issues.push({severity:'error',code:'protected-slide',message});
  // Validate every configured translation even on a locale-specific build, but let unrelated
  // missing translations remain visible warnings so one finished language can be exported.
  const allIssues=await validateContent(dir,config,deck,theme);
  for (const issue of allIssues.filter(i=>i.locale && !locales.includes(i.locale))) issues.push({...issue,severity:'warning'});
  await atomicWrite(path.join(output,'validation.json'),JSON.stringify(issues,null,2));
  if (issues.some(i=>i.severity==='error')) throw new Error(`Validation failed:\n${issues.filter(i=>i.severity==='error').map(i=>`${i.slide??''} ${i.locale??''}: ${i.message}`).join('\n')}`);
  for (const locale of locales) {
    const file=path.join(output,`presentation.${locale}.pptx`);
    if (await exists(file)) {
      const expected=previous?.files[locale];
      if (!expected || await hashFile(file)!==expected) throw new Error(`Externally modified or untracked PPTX: ${file}. Preserve it under a new name and reconcile edits into YAML; build will not overwrite it.`);
    }
  }
  const buildId=`${stamp()}-${crypto.randomUUID().slice(0,8)}`;
  const sources:Record<string,string>={
    'project.yaml':await hashFile(await safePath(dir,'project.yaml')),
    ...(config.brief_required ? {'presentation-brief.yaml':await hashFile(await safePath(dir,'presentation-brief.yaml'))} : {}),
    [config.content]:await hashFile(await safePath(dir,config.content)),
    [`config/themes/${config.theme}.yaml`]:await hashFile(path.join(process.cwd(),'config','themes',`${config.theme}.yaml`))
  };
  const evidence=await sourceEvidence(dir,deck);
  sources['content/sources.yaml']=evidence.indexSha256;
  const assets:BuildProvenance['assets']={},prompts:BuildProvenance['prompts']={};
  for (const slide of deck.slides) {
    if (slide.visual?.asset) assets[slide.id]={path:slide.visual.asset,sha256:await hashFile(await safePath(dir,slide.visual.asset))};
    for (const [id,evidence] of Object.entries(await customAssetEvidence(dir,slide))) assets[`${slide.id}:${id}`]=evidence;
    const prompt=`assets/generated/${slide.id}.prompt.json`, p=await safePath(dir,prompt);
    if (await exists(p)) {
      const bytes=await fs.readFile(p);
      const record=JSON.parse(bytes.toString()) as {recordPath?:string};
      const candidate=record.recordPath ? await safePath(dir,record.recordPath) : undefined;
      if (candidate && await exists(candidate) && await hashFile(candidate)===hash(bytes)) prompts[slide.id]={path:record.recordPath!,sha256:hash(bytes),role:'preparation-or-reuse',generationProvenance:'unavailable'};
      else {
        const copy=`output/history/${buildId}/prompts/${slide.id}.json`;
        await atomicWrite(await safePath(dir,copy),bytes);
        prompts[slide.id]={path:copy,sha256:hash(bytes),role:'preparation-or-reuse',generationProvenance:'unavailable'};
      }
    }
  }
  const chartSelections: NonNullable<BuildProvenance['chartSelections']>={};
  for (const slide of deck.slides) if (slide.layout==='chart' && slide.chart && !slide.chart.fictional) chartSelections[slide.id]=(await resolveChartData(dir,slide)).selection;
  const staging=path.join(output,'.staging',buildId);
  await fs.mkdir(staging,{recursive:true});
  const geometry=[];
  try {
    for (const locale of locales) {
      const pptx=new PptxGenJS();
      pptx.layout='LAYOUT_WIDE'; pptx.author='PPTimistic'; pptx.subject='Source-driven, editable presentation'; pptx.title=config.title;
      pptx.theme={headFontFace:theme.font,bodyFontFace:theme.font};
      for (const [index,model] of deck.slides.entries()) {
        const g=await drawSlide(pptx,model,model.content[locale],theme,locale,dir,index);
        geometry.push(g); issues.push(...validateGeometry(g));
      }
      if (issues.some(i=>i.severity==='error')) break;
      const file=path.join(staging,`presentation.${locale}.pptx`);
      await pptx.writeFile({fileName:file,compression:true});
      await finalizeAccessibility(file,geometry.filter(slide=>slide.locale===locale));
      await validatePptx(file,deck.slides.length);
    }
    await atomicWrite(path.join(output,'validation.json'),JSON.stringify(issues,null,2));
    if (issues.some(i=>i.severity==='error')) throw new Error(`Layout validation failed:\n${issues.filter(i=>i.severity==='error').map(i=>`${i.slide} ${i.locale}: ${i.message}`).join('\n')}`);
    const history=path.join(output,'history',buildId);
    await fs.mkdir(history,{recursive:true});
    const state: BuildState={version:2,files:{...previous?.files},slides:next,provenance:{...previous?.provenance}};
    const archived:Record<string,BuildProvenance|{pptxSha256:string; provenance:'unavailable'}>={};
    for (const locale of locales) {
      const fileName=`presentation.${locale}.pptx`, dest=path.join(output,fileName);
      if (await exists(dest)) {
        await fs.copyFile(dest,path.join(history,fileName));
        const oldHash=await hashFile(dest), oldProvenance=previous?.provenance?.[locale];
        archived[fileName]=oldProvenance?.pptxSha256===oldHash ? oldProvenance : {pptxSha256:oldHash,provenance:'unavailable'};
      }
      await fs.rename(path.join(staging,fileName),dest);
      state.files[locale]=await hashFile(dest);
      state.provenance![locale]={buildId,locale,pptxSha256:state.files[locale],sourceFingerprint:await sourceFingerprint(dir,config,deck,theme,locale),sources,sourceRecords:evidence.records,assets,prompts,chartSelections};
    }
    const changed=deck.slides.filter(s=>!previous?.slides[s.id] || JSON.stringify(previous.slides[s.id])!==JSON.stringify(next[s.id])).map(s=>s.id);
    const report={buildId,locales,changedSlides:changed,removedSlides:Object.keys(previous?.slides??{}).filter(id=>!next[id]),issues,
      note:'PPTX files are reassembled in full. Unchanged stored assets are reused; changed slide IDs identify source revisions, not partial ZIP rendering.'};
    await atomicWrite(path.join(history,'source.snapshot.json'),JSON.stringify({config,deck,theme,previousState:previous},null,2));
    await atomicWrite(path.join(history,'manifest.json'),JSON.stringify({buildId,archived,generated:Object.fromEntries(locales.map(locale=>[`presentation.${locale}.pptx`,state.provenance![locale]]))},null,2));
    await atomicWrite(path.join(history,'build.json'),JSON.stringify(report,null,2));
    await atomicWrite(path.join(output,'geometry.json'),JSON.stringify(geometry,null,2));
    await atomicWrite(path.join(output,'build.json'),JSON.stringify(report,null,2));
    await atomicWrite(stateFile,JSON.stringify(state,null,2));
    return {dir,output,files:locales.map(l=>path.join(output,`presentation.${l}.pptx`)),report};
  } finally { await fs.rm(staging,{recursive:true,force:true}); }
}
