import {afterAll,beforeAll,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import PptxGenJS from 'pptxgenjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {approveCreatorBrief} from '../src/core/brief.js';
import {projectSchema} from '../src/core/model.js';
import {analysisSchema} from '../src/evidence/workbench.js';

const exec=promisify(execFile),repo=process.cwd();
let root:string;
async function cli(...args:string[]){
  try{
    const r=await exec(process.execPath,['--import',pathToFileURL(path.join(repo,'node_modules/tsx/dist/loader.mjs')).href,
      path.join(repo,'src/cli/index.ts'),...args],{cwd:root,timeout:90000,maxBuffer:8*1024*1024});
    return {code:0,stdout:r.stdout,stderr:r.stderr};
  }catch(e){const x=e as {code:number;stdout:string;stderr:string};
    return {code:x.code,stdout:x.stdout,stderr:x.stderr};}
}
beforeAll(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'pptimistic-evidence-'));
  await fs.cp(path.join(repo,'config'),path.join(root,'config'),{recursive:true});
  const inputs=path.join(root,'papers');await fs.mkdir(inputs);
  await fs.writeFile(path.join(inputs,'paper-one.txt'),'The measured activity varied across cages.\nThe sensor failed to detect all behaviours.\n');
  await fs.writeFile(path.join(inputs,'paper-two.md'),'# Comparative evidence\nThe authors report an alternative explanation for activity changes.\n');
  const created=await cli('new','--yes','--project','science','--inputs',inputs,'--no-render');
  expect(created.code,created.stderr).toBe(0);
  const parent=path.join(root,'projects/science');
  const config=projectSchema.parse(YAML.parse(await fs.readFile(path.join(parent,'project.yaml'),'utf8')));
  const blank=YAML.parse(await fs.readFile(path.join(parent,'presentation-brief.yaml'),'utf8'));
  const brief={...blank,
    creator:{profile:'Methods researcher studying home cage monitoring',expertise:'Experience in scientific measurements',
      working_preferences:'Traceable evidence and source quotations'},
    goal:{purpose:'Present methodological limitations of home-cage monitoring',
      audience_action:'Evaluate scientific methods and uncertainty',
      central_message:'HCM measurements require their experimental context'},
    audience:{description:'Scientific methods and AI experts',prior_knowledge:'Knowledge of experimental measurements',
      needs_and_concerns:'Expect precise mechanisms and useful caveats'},
    delivery:{format_and_setting:'Methods seminar',duration_minutes:15},
    content:{scope_and_structure:'Comparison, limitations and next steps',
      evidence_and_sources:'Two local papers and original data provenance',
      uncertainties_and_exclusions:'Do not infer causality without experiments'},
    design:{tone:'Precise and qualified scientific communication',
      visual_preferences:'Editable diagrams with measured data labels'},
    constraints:{source_locale:'en-US',output_locales:['en-US'],
      accessibility_and_other:'Readable scientific graphics'}};
  await fs.writeFile(path.join(parent,'presentation-brief.yaml'),YAML.stringify(approveCreatorBrief(brief,config,'Fixture Presenter')));
},60000);
afterAll(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});});

test('source knowledge inventory refuses to call unreviewed papers analyzed',async()=>{
  const r=await cli('knowledge','--project','science','--mode','prepare');
  expect(r.code,r.stderr).toBe(0);
  const status=JSON.parse(r.stdout);
  expect(status.complete).toBe(false);
  expect(status.files).toHaveLength(2);
  expect(status.pending_chunks).toBeGreaterThan(0);
  const index=await fs.readFile(path.join(root,'projects/science/knowledge/README.md'),'utf8');
  expect(index).toContain('HCM measurements require their experimental context');
  const note=await fs.readFile(path.join(root,'projects/science/knowledge/sources',status.files[0].id+'.md'),'utf8');
  expect(note).toContain('PENDING');
},90000);

test('a missing agent provider must not impersonate a complete evidence workflow',async()=>{
  const status=await cli('knowledge','--project','science','--mode','run');
  expect(status.code).not.toBe(0);
  expect(status.stderr).toContain('No source analyst configured');
});

test('source analysis contract requires full chunk coverage and supported claim fields',()=>{
  const raw={kind:'source-analysis',version:1,revision:'a'.repeat(64),
    source_id:'SRC-abc123def456',chunk_id:'C0001',source_sha256:'b'.repeat(64),
    analyst:{name:'Test reviewer',model:'Configured adapter'},
    coverage:'entire-chunk-read',relevance:'Relevant experimental methods and uncertainty.',
    findings:[{claim:'Activity was measured',quote:'The measured activity varied',
      stance:'qualifies',use:'argument',caveat:'No causal inference was established.'}]};
  expect(analysisSchema.safeParse(raw).success).toBe(true);
  expect(analysisSchema.safeParse({...raw,coverage:'sampled-only'}).success).toBe(false);
  expect(analysisSchema.safeParse({...raw,findings:[{...raw.findings[0],stance:'invented'}]}).success).toBe(false);
});

test('review-only PowerPoint import preserves original and blocks generic export',async()=>{
  const p=new PptxGenJS();p.layout='LAYOUT_WIDE';p.addSlide().addText('Measurements need context',{x:1,y:1,w:9,h:1});
  const input=path.join(root,'presentation.pptx'),bytes=Buffer.from(await p.write({outputType:'nodebuffer'}) as ArrayBuffer);
  await fs.writeFile(input,bytes);
  const imported=await cli('review-pptx','--project','pptx-audit','--file',input,'--title','Imported PPTX');
  expect(imported.code,imported.stderr).toBe(0);
  const preserved=await fs.readFile(path.join(root,'projects/pptx-audit/inputs/original.pptx'));
  expect(preserved).toEqual(bytes);
  const mirror=YAML.parse(await fs.readFile(path.join(root,'projects/pptx-audit/content/slides.yaml'),'utf8'));
  expect(mirror.slides[0].content['en-US'].title).toContain('Measurements need context');
  const build=await cli('build','--project','pptx-audit');
  expect(build.code).not.toBe(0);
  expect(build.stderr).toContain('Review-only project');
  const prepared=await cli('review','--project','pptx-audit','--mode','prepare');
  expect(prepared.code,prepared.stderr).toBe(0);
},90000);
