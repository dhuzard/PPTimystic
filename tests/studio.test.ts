import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import YAML from 'yaml';
import sharp from 'sharp';
import { deckSchema, localizedSchema, layouts, themeSchema } from '../src/core/model.js';
import { demoDeck } from '../src/content/demo.js';
import { validatePptx, contrast } from '../src/validation/index.js';
import { consistency, protectedTokens, type TranslationProvider } from '../src/localization/index.js';
import { ingest } from '../src/content/ingest.js';
import { assertExternalPolicy, type ImageProvider } from '../src/images/index.js';
import { drawSlide, validateGeometry } from '../src/layouts/index.js';
import PptxGenJS from 'pptxgenjs';
import { protectionIssues, type BuildState } from '../src/core/build.js';
import { within, safePath } from '../src/core/io.js';
import { approveCreatorBrief } from '../src/core/brief.js';
import { projectSchema } from '../src/core/model.js';

const exec=promisify(execFile), repo=process.cwd();
let sandbox:string;
async function cli(...args:string[]) {
  try { const r=await exec(process.execPath,['--import',pathToFileURL(path.join(repo,'node_modules/tsx/dist/loader.mjs')).href,path.join(repo,'src/cli/index.ts'),...args],{cwd:sandbox,timeout:60000,maxBuffer:8*1024*1024});return {code:0,output:r.stdout+r.stderr}; }
  catch(e) {const r=e as {code:number;stdout:string;stderr:string};return {code:r.code,output:r.stdout+r.stderr};}
}
const file=(p:string)=>path.join(sandbox,'projects/demo',p);
async function deck() {return YAML.parse(await fs.readFile(file('content/slides.yaml'),'utf8'));}
async function save(value:unknown) {await fs.writeFile(file('content/slides.yaml'),YAML.stringify(value));}
async function approveTestFixture(name:string) {
  const base=path.join(sandbox,'projects',name);
  const cfg=projectSchema.parse(YAML.parse(await fs.readFile(path.join(base,'project.yaml'),'utf8')));
  const raw=YAML.parse(await fs.readFile(path.join(base,'presentation-brief.yaml'),'utf8'));
  const filled={...raw,
    creator:{profile:'Research scientist presenting original work',expertise:'Experienced neuroscientist',working_preferences:'Concise, evidence-based and editable slides'},
    goal:{purpose:'Explain experimental findings',audience_action:'Critically assess the research',central_message:'Evidence and uncertainty must be clearly communicated'},
    audience:{description:'Research colleagues and collaborators',prior_knowledge:'Knowledgeable about research methods',needs_and_concerns:'Relevant comparisons and limitations need to be clear'},
    delivery:{format_and_setting:'In-person research seminar',duration_minutes:25},
    content:{scope_and_structure:'Introduction, methods, observations and limitations',evidence_and_sources:'Imported local documents only',uncertainties_and_exclusions:'No empirical results absent from the supplied sources'},
    design:{tone:'Scientifically precise, concise wording',visual_preferences:'Editable diagrams and readable figures'},
    constraints:{source_locale:cfg.source_locale,output_locales:cfg.output_locales,accessibility_and_other:'High contrast, no confidential participant information'},
    further_wishes:'Keep full details in notes',
  };
  await fs.writeFile(path.join(base,'presentation-brief.yaml'),YAML.stringify(approveCreatorBrief(filled,cfg,'Test Creator')));
}


beforeAll(async()=>{
  sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'pptimistic-test-'));
  await fs.cp(path.join(repo,'config'),path.join(sandbox,'config'),{recursive:true});
  const r=await cli('setup','--yes','--project','demo','--no-render');
  expect(r.output).not.toContain('Error:');expect(r.code).toBe(0);
},60000);
afterAll(async()=>{await fs.rm(sandbox,{recursive:true,force:true});});

describe('complete local workflow',()=>{
  test('setup provides a private brief with unknown context and rebuilding preserves user answers',async()=>{
    const brief=file('presentation-brief.md');
    const starter=await fs.readFile(brief,'utf8');
    expect(starter).toContain('Audience, prior knowledge and accessibility needs: Unknown');
    expect(starter).toContain('Visual preferences, references and required assets: Unknown');
    const completed=starter.replace('Audience, prior knowledge and accessibility needs: Unknown','Audience, prior knowledge and accessibility needs: Clinicians');
    await fs.writeFile(brief,completed);
    const result=await cli('build','--project','demo');
    expect(result.code).toBe(0);
    expect(await fs.readFile(brief,'utf8')).toBe(completed);
  },60000);
  test('fresh setup generates independent French/English editable decks',async()=>{
    for(const locale of ['en-US','fr-FR']) {
      const pptx=file(`output/presentation.${locale}.pptx`);
      expect(await validatePptx(pptx,5)).toEqual({slides:5,valid:true});
      const zip=await JSZip.loadAsync(await fs.readFile(pptx));
      expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('<a:t>PPTimistic</a:t>');
      const diagram=await zip.file('ppt/slides/slide3.xml')!.async('string');
      expect(diagram).toContain(locale==='fr-FR'?'Relecture':'Review');
      expect((diagram.match(/<p:sp>/g)??[]).length).toBeGreaterThan(6);
      expect(Object.keys(zip.files).filter(n=>/^ppt\/charts\/chart\d+\.xml$/.test(n))).toHaveLength(1);
      expect(Object.keys(zip.files).some(n=>n.endsWith('.xlsx'))).toBe(true);
      expect(Object.keys(zip.files).some(n=>/^ppt\/media\/image/.test(n))).toBe(true);
      const notes=await zip.file('ppt/notesSlides/notesSlide3.xml')!.async('string');expect(notes).toContain('S003');
      expect(notes).toContain('conceptual');
    }
    const d=await deck();expect(d.slides.map((s:{id:string})=>s.id)).toEqual(['S001','S002','S003','S004','S005']);
  });
  test('setup rerun refuses collision and preserves user files',async()=>{
    const before=await fs.readFile(file('content/slides.yaml'),'utf8');
    await fs.writeFile(file('inputs/precious.txt'),'Keep this research');
    const r=await cli('setup','--yes','--project','demo','--no-render');
    expect(r.code).not.toBe(0);expect(r.output).toContain('nothing was overwritten');
    expect(await fs.readFile(file('inputs/precious.txt'),'utf8')).toBe('Keep this research');
    expect(await fs.readFile(file('content/slides.yaml'),'utf8')).toBe(before);
  });
  test('PPTX validation rejects negative shape extents that Office cannot open',async()=>{
    const zip=await JSZip.loadAsync(await fs.readFile(file('output/presentation.en-US.pptx')));
    const original=await zip.file('ppt/slides/slide1.xml')!.async('string');
    zip.file('ppt/slides/slide1.xml',original.replace(/<a:ext cx="\d+"/,'<a:ext cx="-1"'));
    const broken=path.join(sandbox,'negative-extent.pptx');await fs.writeFile(broken,await zip.generateAsync({type:'nodebuffer'}));
    await expect(validatePptx(broken,5)).rejects.toThrow('negative shape extent');
  });
  test('new projects are isolated and input imports are explicitly distinguished from summaries',async()=>{
    const input=path.join(sandbox,'documents');await fs.mkdir(input);await fs.writeFile(path.join(input,'study.txt'),'Actual source: 8 mg. No result supplied.');
    const r=await cli('new','--yes','--project','second','--inputs',input,'--no-render');
    expect(r.code).toBe(0);expect(r.output).toContain('not a summary');
    expect(await fs.readFile(path.join(sandbox,'projects/second/inputs/study.txt'),'utf8')).toContain('8 mg');
    expect(await fs.readFile(file('inputs/precious.txt'),'utf8')).toContain('Keep this research');
  });
  test('clean first-run path imports local sources, completes a manual translation, validates, renders optionally and bundles',async()=>{
    const input=path.join(sandbox,'first-run-documents');await fs.mkdir(input);await fs.writeFile(path.join(input,'plan.md'),'# Plan\n\n## First observation\nThe supplied plan reports no measured result.');
    const created=await cli('new','--yes','--project','first-run','--inputs',input,'--from-plan','--locales','en-US','--no-render');
    expect(created.code,created.output).toBe(0);
    expect(await fs.readFile(path.join(sandbox,'projects/first-run/inputs/plan.md'),'utf8')).toContain('no measured result');
    const requestRun=await cli('translate','--project','first-run','--to','fr-FR');expect(requestRun.code,requestRun.output).toBe(0);
    const requestFile=(await fs.readdir(path.join(sandbox,'projects/first-run/content'))).find(name=>name.startsWith('translation-request.fr-FR.'))!;
    const requestPath=path.join(sandbox,'projects/first-run/content',requestFile),request=YAML.parse(await fs.readFile(requestPath,'utf8'));
    const translated={...request,slides:request.slides.map((item:any)=>({id:item.id,source_fingerprint:item.source_fingerprint,translation:{
      ...item.source,title:'Première observation',body:'Le plan fourni ne rapporte aucun résultat mesuré.',
      notes:'Importé littéralement du plan fourni. Les affirmations scientifiques doivent être relues.'
    }}))};
    const completed=path.join(sandbox,'translation-fr.yaml');await fs.writeFile(completed,YAML.stringify(translated));
    expect((await cli('translate','--project','first-run','--to','fr-FR','--file',completed)).code).toBe(0);
    const blocked=await cli('build','--project','first-run');
    expect(blocked.code).not.toBe(0);
    expect(blocked.output).toContain('creator.profile');
    await approveTestFixture('first-run');
    expect((await cli('brief','--project','first-run','--check')).code).toBe(0);
    expect((await cli('build','--project','first-run')).code).toBe(0);
    expect((await cli('validate','--project','first-run')).code).toBe(0);
    const rendered=await cli('render','--project','first-run','--renderer','libreoffice');expect(rendered.code,rendered.output).toBe(0);
    expect(rendered.output).toMatch(/Rendered with|No complete local renderer/);
    const bundled=await cli('bundle','--project','first-run');expect(bundled.code,bundled.output).toBe(0);
    const result=JSON.parse(bundled.output);expect(result.includedInputs).toEqual([]);
    expect(await fs.readFile(result.manifest,'utf8')).toContain('originalInputsIncluded');
  },120000);
  test('Markdown plan respects order and copies body without invention',async()=>{
    const input=path.join(sandbox,'plan');await fs.mkdir(input);
    await fs.writeFile(path.join(input,'plan.md'),'# Study\n\n## First observation\nSupplied sentence.\n\n## Second observation\nNo result is available.');
    const r=await cli('new','--yes','--project','plan','--inputs',input,'--from-plan','--locales','en-US','--no-render');expect(r.output).not.toContain('Error:');expect(r.code).toBe(0);
    const d=YAML.parse(await fs.readFile(path.join(sandbox,'projects/plan/content/slides.yaml'),'utf8'));
    expect(d.slides.map((s:{content:Record<string,{title:string}>})=>s.content['en-US'].title)).toEqual(['First observation','Second observation']);
    expect(d.slides[0].source_refs).toHaveLength(1);expect(d.slides[1].content['en-US'].body).toBe('No result is available.');
  });
  test('build validates, reuses assets, and versions previous outputs',async()=>{
    const before=await fs.readFile(file('assets/reference/idea.svg'));
    expect((await cli('build','--project','demo')).code).toBe(0);
    const history=await fs.readdir(file('output/history'));
    const backups=await Promise.all(history.map(p=>fs.readdir(file(`output/history/${p}`))));
    expect(backups.flat()).toContain('presentation.en-US.pptx');
    expect(await fs.readFile(file('assets/reference/idea.svg'))).toEqual(before);
    expect((await cli('validate','--project','demo')).code).toBe(0);
  });
  test('missing translation fails explicitly and cannot be silently exported',async()=>{
    const d=await deck(), original=structuredClone(d);delete d.slides[2].content['fr-FR'];await save(d);
    const r=await cli('build','--project','demo');expect(r.code).not.toBe(0);expect(r.output).toContain('Translation is missing');
    await save(original);
  });
  test('manual translation request contains no fake translated content',async()=>{
    const r=await cli('translate','--project','demo','--to','it-IT');expect(r.code).toBe(0);expect(r.output).toContain('No translation provider');
    const files=await fs.readdir(file('content'));const request=files.find(f=>f.startsWith('translation-request.it-IT.'))!;
    const data=YAML.parse(await fs.readFile(file(`content/${request}`),'utf8'));expect(data.slides).toHaveLength(5);expect(data.slides[0].translation).toBeNull();
  });
  test('complete manual translations import by stable IDs and export independently',async()=>{
    // Use already human-authored demo French to exercise the import path, with no service.
    const d=await deck();const input=path.join(sandbox,'translation.yaml');
    await fs.writeFile(input,YAML.stringify({version:1,from:'en-US',to:'fr-FR',slides:d.slides.map((s:any)=>({id:s.id,translation:s.content['fr-FR']}))}));
    expect((await cli('translate','--project','demo','--to','fr-FR','--file',input)).code).toBe(0);
    expect((await cli('build','--project','demo','--locale','fr-FR')).code).toBe(0);
  });
  test('feedback is logged without claiming natural-language edits were applied',async()=>{
    const before=await fs.readFile(file('content/slides.yaml'),'utf8');
    const r=await cli('revise','--project','demo','--slide','S002','--message','Use less text.');expect(r.code).toBe(0);expect(r.output).toContain('no automatic interpretation');
    expect(await fs.readFile(file('content/slides.yaml'),'utf8')).toBe(before);
  });
  test('structured revisions preserve slide IDs and unchanged content',async()=>{
    const original=await deck();const patch=path.join(sandbox,'revision.yaml');
    await fs.writeFile(patch,YAML.stringify({slide:'S002',locale:'en-US',category:'content',message:'Shorten the supporting explanation.',patch:{body:'Leave space to think.'}}));
    expect((await cli('revise','--project','demo','--file',patch)).code).toBe(0);
    const d=await deck();expect(d.slides[1].content['en-US'].body).toBe('Leave space to think.');expect(d.slides[1].content['en-US'].message).toBe(original.slides[1].content['en-US'].message);expect(d.slides[2]).toEqual(original.slides[2]);expect(d.slides[1].id).toBe('S002');
    const stale=await cli('build','--project','demo');expect(stale.code).not.toBe(0);expect(stale.output).toContain('requires review');
    expect((await cli('build','--project','demo','--locale','en-US')).code).toBe(0);await save(original);
  });
  test('locked slides resist source edits, unlock bypass, and structured revisions',async()=>{
    const d=await deck(),original=structuredClone(d);d.slides[0].locked=true;d.slides[0].status='locked';await save(d);
    expect((await cli('build','--project','demo')).code).toBe(0);
    const patch=path.join(sandbox,'locked-revision.yaml');
    await fs.writeFile(patch,YAML.stringify({slide:'S001',locale:'en-US',category:'content',message:'Attempt an unapproved change.',patch:{body:'Changed'}}));
    expect((await cli('revise','--project','demo','--file',patch)).output).toContain('explicit --authorize');
    d.slides[0].content['en-US'].title='Unauthorized change';await save(d);
    const r=await cli('build','--project','demo');expect(r.code).not.toBe(0);expect(r.output).toContain('approved/locked');
    d.slides[0].locked=false;d.slides[0].status='draft';await save(d);expect((await cli('build','--project','demo')).code).not.toBe(0);
    await save(original);expect((await cli('build','--project','demo','--authorize','S001')).code).toBe(0);
  });
  test('externally modified PPTX is never overwritten',async()=>{
    const p=file('output/presentation.en-US.pptx');const original=await fs.readFile(p);
    await fs.appendFile(p,'manual-edit-marker');
    const r=await cli('build','--project','demo');expect(r.code).not.toBe(0);expect(r.output).toContain('Externally modified');
    expect((await fs.readFile(p,'utf8')).endsWith('manual-edit-marker')).toBe(true);
    await fs.writeFile(p,original);
  });
  test('unknown slide IDs and malformed content return useful failures',async()=>{
    expect((await cli('revise','--project','demo','--slide','NOPE','--message','change')).output).toContain('Unknown slide ID');
    expect((await cli('build','--project','../escape')).output).toContain('Project name');
    const d=await deck();const invalid=structuredClone(d);invalid.slides[1].id='S001';await save(invalid);
    expect((await cli('build','--project','demo')).output).toContain('Slide IDs must be unique');await save(d);
  });
  test('setup reports a recoverable missing input path before making a project',async()=>{
    const missing=path.join(sandbox,'does-not-exist');
    const run=await cli('new','--yes','--project','bad-input','--inputs',missing,'--no-render');
    expect(run.code).not.toBe(0);expect(run.output).toContain(`Input folder not found: ${missing}`);
    expect(run.output).toContain('Check the path and try again');
    await expect(fs.access(path.join(sandbox,'projects/bad-input'))).rejects.toThrow();
  });
  test('image prompts reuse accepted assets and require explicit replacement approval',async()=>{
    expect((await cli('images','--project','demo','--slide','S002')).code).toBe(0);
    const meta=JSON.parse(await fs.readFile(file('assets/generated/S002.prompt.json'),'utf8'));expect(meta.status).toBe('reused');expect(meta.sha256).toHaveLength(64);
    expect(meta.prompt).toContain('Never include text');
    const r=await cli('images','--project','demo','--slide','S002','--asset',file('assets/reference/idea.svg'));expect(r.code).not.toBe(0);expect(r.output).toContain('--authorize');
  });
  test('all nine layouts assemble actual PPTX with every preset',async()=>{
    const source=demoDeck('Layout verification');
    for(const preset of ['editorial-minimal','scientific-technical','illustrated-minimal']) {
      const theme=themeSchema.parse(YAML.parse(await fs.readFile(path.join(sandbox,`config/themes/${preset}.yaml`),'utf8')));
      const p=new PptxGenJS();p.layout='LAYOUT_WIDE';
      for(const [i,layout] of layouts.entries()) {
        const s=structuredClone(layout==='chart'?source.slides[3]:layout==='text-image'||layout==='full-image'?source.slides[1]:source.slides[2]);
        s.id=`LAYOUT${i}`;s.layout=layout;const c=s.content['en-US'];c.title='One clear idea';c.body='A short supporting statement.';c.message='An editable explanation.';
        if(layout==='comparison')c.labels=['First','Second'];
        expect(validateGeometry(await drawSlide(p,s,c,theme,'en-US',file(''),i))).toEqual([]);
      }
      const out=path.join(sandbox,`${preset}.pptx`);await p.writeFile({fileName:out});expect((await validatePptx(out,9)).valid).toBe(true);
    }
  });
  test('missing referenced assets, altered sources and excessive content fail validation',async()=>{
    const original=await deck(),d=structuredClone(original);d.slides[1].visual.asset='assets/missing.png';await save(d);
    expect((await cli('build','--project','demo')).output).toContain('Missing asset');
    const dense=structuredClone(original);dense.slides[1].content['en-US'].body='Too much text. '.repeat(150);await save(dense);
    expect((await cli('build','--project','demo','--locale','en-US')).output).toContain('overflow');await save(original);
    const input=path.join(sandbox,'projects/plan/inputs/plan.md');const backup=await fs.readFile(input);await fs.appendFile(input,'\nChanged source.');
    expect((await cli('validate','--project','plan')).output).toContain('Source missing or changed');await fs.writeFile(input,backup);
  });
});

describe('ingestion and guardrails',()=>{
  test('TXT, CSV, DOCX and images retain provenance; unsupported files are explicit',async()=>{
    const dir=await fs.mkdtemp(path.join(sandbox,'ingest-'));await fs.mkdir(path.join(dir,'inputs'));
    const doc=new JSZip();doc.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    doc.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    doc.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Supplied Word observation.</w:t></w:r></w:p></w:body></w:document>');
    await fs.writeFile(path.join(dir,'inputs/study.docx'),await doc.generateAsync({type:'nodebuffer'}));
    await fs.writeFile(path.join(dir,'inputs/values.csv'),'group,value\n"A, B",12\nC,15\n');
    await fs.writeFile(path.join(dir,'inputs/study.txt'),'Supplied 8 mg.');
    await fs.writeFile(path.join(dir,'inputs/legacy.pptx'),'unsupported');
    await sharp({create:{width:8,height:8,channels:3,background:'#fff'}}).png().toFile(path.join(dir,'inputs/figure.png'));
    const records=await ingest(dir);expect(records).toHaveLength(5);
    expect(records.find(r=>r.kind==='pptx')?.error).toContain('Unsupported');
    const word=records.find(r=>r.kind==='docx')!;expect(word.error).toBeUndefined();expect(await fs.readFile(path.join(dir,word.extracted!),'utf8')).toContain('Supplied Word observation');
    const csv=records.find(r=>r.kind==='csv')!;expect(await fs.readFile(path.join(dir,csv.extracted!),'utf8')).toContain('A, B');
    expect(records.every(r=>r.sha256.length===64)).toBe(true);
    const additions=await fs.mkdtemp(path.join(sandbox,'additional-'));await fs.writeFile(path.join(additions,'extra.txt'),'New source.');
    await ingest(dir,additions);
    const merged=YAML.parse(await fs.readFile(path.join(dir,'content/sources.yaml'),'utf8')).sources;
    expect(merged).toHaveLength(6);expect(merged.some((s:{id:string})=>s.id===word.id)).toBe(true);
  });
  test('PDF parsing extracts actual text from a valid fixture',async()=>{
    // Minimal actual PDF with byte-accurate xref, no network fixture.
    const stream='BT /F1 14 Tf 72 720 Td (Supplied scientific observation.) Tj ET';
    const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
    const start=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    const dir=await fs.mkdtemp(path.join(sandbox,'pdf-'));await fs.mkdir(path.join(dir,'inputs'));await fs.writeFile(path.join(dir,'inputs/study.pdf'),pdf);
    const records=await ingest(dir);expect(records[0].error).toBeUndefined();expect(await fs.readFile(path.join(dir,records[0].extracted!),'utf8')).toContain('Supplied scientific observation');
  });
  test('numbers, units, DOI, glossary and omitted translations are checked',()=>{
    const source=localizedSchema.parse({title:'Dose 8 mg',notes:'10.1234/example p < 0.05 DVC'});
    const target=localizedSchema.parse({title:'Dose 9 mg',notes:'10.1234/example p < 0.05'});
    expect(consistency(source,target,['DVC']).length).toBeGreaterThan(1);
    expect(protectedTokens('8 mg')).toEqual(['8 mg']);
    expect(deckSchema.safeParse({version:1,slides:[]}).success).toBe(false);
  });
  test('layout checks detect overlap, bounds and excessive text without shrinking',()=>{
    const issues=validateGeometry({id:'S1',locale:'en-US',boxes:[{x:0,y:0,w:1,h:.1,font:24,text:'This cannot possibly fit into this very tiny box',role:'body'},{x:0,y:0,w:15,h:2,role:'image'}]});
    expect(issues.map(i=>i.code)).toEqual(expect.arrayContaining(['text-overflow','bounds','overlap']));expect(contrast('161616','FFFFFF')).toBeGreaterThan(15);
  });
  test('locale locks also protect shared layout and assets',()=>{
    const old:BuildState={files:{},slides:{S001:{fingerprint:'old',protected:false,locales:{'fr-FR':{fingerprint:'text',protected:true}}}}};
    const changed=structuredClone(old.slides);changed.S001.fingerprint='new';
    expect(protectionIssues(old,changed,[])).toHaveLength(1);expect(protectionIssues(old,changed,['S001'])).toHaveLength(0);
  });
  test('provider interfaces support local mocks; external transmission and cost require approval',async()=>{
    const translation:TranslationProvider={name:'fixture',async translate(c){return {...c,title:'Titre'};}};
    expect((await translation.translate(localizedSchema.parse({title:'Title'}),'en-US','fr-FR',[])).title).toBe('Titre');
    const image:ImageProvider={name:'fixture',async generate(r){return {assetPath:r.outputPath,provider:'fixture',parameters:{}};}};
    expect((await image.generate({slideId:'S1',outputPath:'local.png',prompt:'conceptual',styleVersion:'1'})).provider).toBe('fixture');
    expect(()=>assertExternalPolicy({approvedForExternalTransmission:false,approvedForPaidCalls:true,spendingLimit:10,estimatedCost:1})).toThrow('transmission');
    expect(()=>assertExternalPolicy({approvedForExternalTransmission:true,approvedForPaidCalls:false,spendingLimit:0,estimatedCost:1})).toThrow('Paid');
  });
  test('project paths cannot traverse outside their root',async()=>{
    expect(()=>within(sandbox,'../secret')).toThrow('inside');
    await expect(safePath(sandbox,'../secret')).rejects.toThrow('inside');
    expect(demoDeck('Example').slides).toHaveLength(5);
  });
});
