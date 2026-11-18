import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { input, select } from '@inquirer/prompts';
import { buildProject } from '../core/build.js';
import { artifactIssues, inspectArtifacts } from '../core/artifacts.js';
import { bundleProject } from '../core/bundle.js';
import { doctor } from '../core/doctor.js';
import { createProject, availableName } from '../core/projects.js';
import { creatorBriefStatus } from '../core/brief.js';
import { interviewCreator, approveInteractively } from './brief.js';
import { exists, hash, hashFile, loadProject, projectDir, readYaml, safePath, stamp, writeYaml, atomicWrite, root } from '../core/io.js';
import { localeSchema, projectSchema } from '../core/model.js';
import { ingest } from '../content/ingest.js';
import { translationRequest, importTranslations } from '../localization/index.js';
import { validateContent, validatePptx } from '../validation/index.js';
import { renderProject } from '../rendering/index.js';
import { applyRevision } from '../feedback/index.js';
import { prepareImages, attachImage } from '../images/index.js';

const cli=new Command().name('pptimistic').description('Create editable presentations locally. No API key required.').version('0.3.0');
cli.hook('preAction',async (_root,command)=>{
  if (!['setup','new','demo','build','render','translate','revise','images','ingest'].includes(command.name())) return;
  const name=command.processedArgs[0] ?? command.opts().project ?? (command.name()==='demo'?'demo':undefined);
  if (name) { const {assertNoActiveSession}=await import('../session/lease.js');await assertNoActiveSession(name); }
});
const defaults=projectSchema.parse({title:'PPTimistic',...await readYaml(path.join(root,'config/defaults.yaml'))});
const language=(value?:string) => (value??process.env.LC_ALL??process.env.LANG??Intl.DateTimeFormat().resolvedOptions().locale).toLowerCase().startsWith('fr')?'fr':'en';
const themePresets=['editorial-minimal','scientific-technical','illustrated-minimal','ink-watercolor'];
const split=(s:string)=>s.split(',').map(s=>s.trim()).filter(Boolean);
function projectOption(c:Command) {
  c.argument('[projectName]','Project folder under projects/ (also accepted when npm drops --project)')
    .option('-p, --project <name>','Project folder under projects/','demo');
  c.hook('preAction',command=>{
    const name=command.processedArgs[0] as string|undefined;
    if (!name) return;
    if (command.getOptionValueSource('project')==='cli') throw new Error('Specify the project once, using --project or a positional name.');
    command.setOptionValue('project',name);
  });
  return c;
}
function print(value:unknown) { console.log(typeof value==='string'?value:JSON.stringify(value,null,2)); }

for (const command of ['setup','new','demo']) {
  cli.command(command).description(command==='setup'?'Guided first-run setup (English/French)':command==='demo'?'Create or rebuild the five-slide bilingual demo':'Create an independent presentation project')
    .option('-p, --project <name>','New project name (existing projects are preserved)')
    .option('--title <text>','Presentation title','PPTimistic')
    .option('--source <locale>','Original content language',defaults.source_locale)
    .option('--locales <list>','Comma-separated output languages',defaults.output_locales.join(','))
    .option('--theme <name>',themePresets.join(', '),defaults.theme)
    .option('--inputs <folder>','Local folder of source documents')
    .option('--from-plan','Import exactly one Markdown plan, using ## headings as slide titles')
    .option('--ui <language>','CLI interface language: en or fr')
    .option('--yes','Noninteractive defaults; never approves overwriting')
    .option('--no-render','Skip optional preview generation')
    .action(async o=>{
      const fr=language(o.ui)==='fr';
      print(fr?'Bienvenue dans PPTimistic. Vos documents restent sur cet ordinateur.':'Welcome to PPTimistic. Your documents stay on this computer.');
      const diagnostics=await doctor();
      if (!diagnostics.nodeOk||!diagnostics.writable||diagnostics.dependencies.some(d=>!d.available)) {
        const missing=diagnostics.dependencies.filter(d=>!d.available).map(d=>d.name);
        throw new Error(`Setup stopped before creating a project. ${!diagnostics.nodeOk?'Install Node.js 22.13 or later. ':''}${!diagnostics.writable?'Make the repository folder writable. ':''}${missing.length?`Install project dependencies with npm install (missing: ${missing.join(', ')}).`:''} Run npm run doctor for details.`);
      }
      print(fr?'Création de diapositives PowerPoint modifiables, sans service payant.':'Creating editable PowerPoint slides, without paid services.');
      print({rendering:diagnostics.rendering,fonts:diagnostics.fonts});
      let title=o.title,source=o.source,locales=o.locales,theme=o.theme,inputs=o.inputs;
      const interactive=!o.yes&&process.stdin.isTTY&&command!=='demo';
      if (interactive) {
        title=await input({message:fr?'Titre de la présentation':'Presentation title',default:title});
        source=await select({message:fr?'Langue du contenu original':'Original content language',choices:[{name:'English',value:'en-US'},{name:'Français',value:'fr-FR'}],default:source});
        locales=await input({message:fr?'Langues de sortie (séparées par des virgules)':'Output languages (comma-separated)',default:locales});
        theme=await select({message:fr?'Style visuel':'Visual preset',choices:themePresets.map(value=>({name:value,value})),default:theme});
        inputs=await input({message:fr?'Dossier de documents (facultatif)':'Document folder (optional)',default:inputs??''});
      }
      localeSchema.parse(source); const outputs=split(locales).map(l=>localeSchema.parse(l));
      // Validate settings before creating any directory.
      if (!['en-US','fr-FR'].includes(source)) throw new Error('The starter supports en-US/fr-FR. Other languages can be authored manually after setup.');
      if (!themePresets.includes(theme)) throw new Error(`Unknown theme: ${theme}`);
      if (inputs && !(await exists(path.resolve(inputs)))) throw new Error(`Input folder not found: ${path.resolve(inputs)}. Check the path and try again; for a plan, pass its containing folder with --from-plan.`);
      const name=o.project??(command==='demo'?'demo':await availableName('my-presentation'));
      // "demo" and unattended setup without sources remain explicitly fictional.
      // All newly created real projects require a substantive, creator-approved brief.
      const briefRequired = command==='new' || (command==='setup' && (interactive || Boolean(inputs) || Boolean(o.fromPlan)));
      if (command==='demo'&&await exists(projectDir(name))) print(`Rebuilding existing ${name}; its source content is preserved.`);
      else await createProject({name,title,source,locales:outputs,theme,inputs:inputs||undefined,fromPlan:o.fromPlan,briefRequired});
      const {dir,config}=await loadProject(name);
      if (config.brief_required && interactive) await interviewCreator(dir,config,fr);
      if (inputs) {
        const sources=(await readYaml(path.join(projectDir(name),'content/sources.yaml'))).sources;
        const failures=sources.filter((s:{error?:string})=>s.error);
        if(failures.length) print({extractionWarnings:failures});
      }
      if (inputs && !o.fromPlan) print(fr?'Documents importés. Le contenu actuel est une démonstration fictive, pas un résumé de vos documents.':'Documents imported. The current content is a fictional demonstration, not a summary of your documents.');
      const brief=await creatorBriefStatus(dir,config);
      if (!brief.approved) {
        print(fr?`Projet préparé, mais aucun PowerPoint ne sera généré avant validation du brief. Lancez : npm run brief -- --project ${name} --ui fr`:`Project created as a draft. PowerPoint generation is blocked until the creator approves the brief. Run: npm run brief -- --project ${name}`);
        print({briefIssues:brief.errors});
        return;
      }
      if (config.brief_required) {
        print(fr?`Brief approuvé. Rédigez et relisez maintenant projects/${name}/content/slides.yaml à partir des sources, puis lancez npm run build -- --project ${name}.`:`Brief approved. Author and review projects/${name}/content/slides.yaml from the sources, then run npm run build -- --project ${name}.`);
        return;
      }
      const result=await buildProject(name); print({powerpoints:result.files});
      if (o.render) print(await renderProject(name));
      print(fr?`Prêt. Éditez projects/${name}/content/slides.yaml, puis : npm run build -- --project ${name}.`:`Ready. Edit projects/${name}/content/slides.yaml, then run npm run build -- --project ${name}.`);
    });
}
projectOption(cli.command('brief').description('Mandatory creator interview, brief verification, or explicit human approval'))
  .option('--check','Check completion and approval without editing')
  .option('--approve','Approve a completed YAML brief after interactive human review')
  .option('--ui <language>','Interface language: en or fr')
  .action(async (_name,o)=>{
    if (o.check && o.approve) throw new Error('Choose --check or --approve, not both.');
    const {dir,config}=await loadProject(o.project);
    const fr=language(o.ui)==='fr';
    if (!config.brief_required) {
      print('This demo/legacy project does not enforce a creator brief. New real projects require it.');
      return;
    }
    if (o.check) {
      const status=await creatorBriefStatus(dir,config);
      print(status);
      if (!status.approved) process.exitCode=1;
      return;
    }
    if (!process.stdin.isTTY) throw new Error('The creator interview and approval require a terminal. --yes cannot approve a brief.');
    if (o.approve) await approveInteractively(dir,config,fr);
    else await interviewCreator(dir,config,fr);
  });
cli.command('doctor').description('Check Node, dependencies, fonts, writable storage and optional renderers').option('--ui <language>','Interface language').action(async o=>{
  if(language(o.ui)==='fr') print('Diagnostic : les composants facultatifs manquants ne bloquent pas la création PowerPoint.');
  const d=await doctor();print(d); if(!d.nodeOk||!d.writable||d.dependencies.some(d=>!d.available)) process.exitCode=1;
});
projectOption(cli.command('build').description('Validate and build independent PPTX files; preserve earlier outputs'))
  .option('--locale <locale>','Build one language').option('--authorize <ids>','Explicitly allow changes to these approved/locked slide IDs (comma-separated)')
  .action(async (_name,o)=>{const r=await buildProject(o.project,{locale:o.locale,authorize:split(o.authorize??'')});print({files:r.files,changedSlides:r.report.changedSlides,warnings:r.report.issues});});
projectOption(cli.command('validate').description('Validate source, translations, layout and current PPTX outputs'))
  .option('--source-only','Validate authored source without requiring current PPTX outputs')
  .action(async (_name,o)=>{
  const {dir,config,deck,theme}=await loadProject(o.project);
  const issues=await validateContent(dir,config,deck,theme);
  const {drawSlide,validateGeometry}=await import('../layouts/index.js');
  const {default:PptxGenJS}=await import('pptxgenjs');
  for(const locale of config.output_locales) {
    const p=new PptxGenJS();p.layout='LAYOUT_WIDE';
    for(const [i,s] of deck.slides.entries()) if(s.content[locale]) {
      try {issues.push(...validateGeometry(await drawSlide(p,s,s.content[locale],theme,locale,dir,i,{animations:config.animations})));}
      catch(e) {issues.push({severity:'error',code:'render-object',slide:s.id,locale,message:(e as Error).message});}
    }
    if (!o.sourceOnly) {
      const file=await safePath(dir,`output/presentation.${locale}.pptx`);
      if(await exists(file)) {try {await validatePptx(file,deck.slides.length);} catch(e) {issues.push({severity:'error',code:'pptx',locale,message:(e as Error).message});}}
    }
  }
  if (!o.sourceOnly) issues.push(...artifactIssues(await inspectArtifacts(o.project)));
  print({issues,errors:issues.filter(i=>i.severity==='error').length});
  if(issues.some(i=>i.severity==='error')) process.exitCode=1;
});
projectOption(cli.command('claims').description('Print local claim provenance, slide text and source paths (excerpt text is withheld)'))
  .option('--write-markdown','Write a local Markdown report with links to retained sources under output/')
  .option('--verify <slide/claim>','Personally verify a classified claim after reading its source (interactive human confirmation)')
  .option('--by <name>','Person who verified the claim (--verify)')
  .option('--authorize <list>','Record explicit authority to update protected slides (--verify)')
  .action(async (_name,o)=>{
  const {dir,config,deck,theme}=await loadProject(o.project);
  const sourceIndex=await safePath(dir,'content/sources.yaml');
  const sourceRecords=await exists(sourceIndex)?((await readYaml(sourceIndex)).sources as {id:string;path:string;sha256:string;extracted?:string;extracted_sha256?:string}[]):[];
  const issues=await validateContent(dir,config,deck,theme);
  const {claimFingerprint,claimVerificationState,recordHumanClaimVerification}=await import('../content/claims.js');
  if(o.verify) {
    if(!process.stdin.isTTY) throw new Error('Claim verification requires a person to confirm in an interactive terminal; agents cannot verify claims.');
    if(!o.by?.trim()) throw new Error('--verify requires --by: the person who checked the source.');
    const parts=o.verify.split('/');
    if(parts.length!==2) throw new Error('--verify must be SLIDE/CLAIM.');
    const [slideId,claimId]=parts,slide=deck.slides.find(s=>s.id===slideId),claim=slide?.claims?.find(c=>c.id===claimId);
    if(!slide||!claim) throw new Error(`Unknown claim ${o.verify}.`);
    const source=sourceRecords.find(s=>s.id===claim.source_ref);
    if(!source||issues.some(i=>i.severity==='error'&&(i.claim===claimId||i.slide===slideId&&i.code==='source-integrity'))) throw new Error('Resolve claim and source validation errors before personal verification.');
    if(!claim.claim_type) throw new Error('Classify the claim before human verification.');
    const fingerprint=claimFingerprint(slide,claim,source);
    print({slide:slideId,claim:claimId,text:slide.content[config.source_locale][claim.field],claim_type:claim.claim_type,qualification_note:claim.qualification_note,source:source.path,extracted:source.extracted,locator:claim.locator});
    const {confirm}=await import('@inquirer/prompts');
    if(!await confirm({message:'Have you personally read this source and verified the claim type, wording and qualifications?',default:false})) throw new Error('Not confirmed; claim unchanged.');
    print(await recordHumanClaimVerification(o.project,slideId,claimId,o.by,source,fingerprint,split(o.authorize??'')));
    return;
  }
  async function integrity(relative?:string,recorded?:string) {
    if(!relative||!recorded)return {status:'untracked' as const};
    try {const file=await safePath(dir,relative);if(!await exists(file))return {status:'missing' as const};
      const current_sha256=await hashFile(file);return {status:current_sha256===recorded?'current' as const:'changed' as const,current_sha256};}
    catch {return {status:'missing' as const};}
  }
  const claims=[];
  for(const slide of deck.slides) for(const claim of slide.claims??[]) {
    const source=sourceRecords.find(record=>record.id===claim.source_ref);
    const localizedText=Object.fromEntries(Object.entries(slide.content).map(([locale,content])=>[locale,content[claim.field]]));
    const validationIssues=issues.filter(issue=>issue.claim===claim.id||(issue.code==='source-integrity'&&issue.slide===slide.id));
    const sourceIntegrity=await integrity(source?.path,source?.sha256),extractedIntegrity=await integrity(source?.extracted,source?.extracted_sha256);
    claims.push({slide_id:slide.id,claim_id:claim.id,field:claim.field,claim_type:claim.claim_type??'unclassified',qualification_note:claim.qualification_note,human_verification:claim.human_verification,verification_state:claimVerificationState(slide,claim,source,sourceIntegrity.status==='current'&&extractedIntegrity.status==='current'),localized_text:localizedText,source_ref:claim.source_ref,source_path:source?.path,source_sha256:source?.sha256,source_integrity:sourceIntegrity,extracted_path:source?.extracted,extracted_sha256:source?.extracted_sha256,extracted_integrity:extractedIntegrity,locator:claim.locator,excerpt_sha256:hash(claim.excerpt),excerpt_length:[...claim.excerpt].length,validation_issues:validationIssues.map(({severity,code,message})=>({severity,code,message}))});
  }
  const report={project:o.project,source_locale:config.source_locale,claims};
  if(o.writeMarkdown) {
    const destination=await safePath(dir,'output/claims-report.md');
    const clean=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('[','\\[').replaceAll(']','\\]').replaceAll('|','\\|').replace(/\r?\n/g,' ');
    const link=async(relative?:string)=>{if(!relative)return '—';
      try {const file=await safePath(dir,relative);if(!await exists(file))return 'missing';
        const href=path.relative(path.dirname(destination),file).split(path.sep).map(encodeURIComponent).join('/');
        return `[Open local file](${href})`;}
      catch{return 'missing';}};
    const lines=[`# Claim review — ${clean(o.project)}`,'','This local report contains slide text and source paths. Literal excerpt matching and file hashes do not establish scientific support. Excerpt text is withheld.','','| Slide | Claim | Field | Locator | Original | Extracted | Source state | Extraction state | Review issues |','| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
    for(const claim of claims) lines.push(`| ${clean(claim.slide_id)} | ${clean(claim.claim_id)} | ${clean(claim.field)} | ${clean(claim.locator)} | ${await link(claim.source_path)} | ${await link(claim.extracted_path)} | ${claim.source_integrity.status} | ${claim.extracted_integrity.status} | ${clean(claim.validation_issues.map(issue=>issue.code).join(', ')||'none')} |`);
    lines.push('','## Localized slide text','');
    for(const claim of claims) {lines.push(`### ${clean(claim.slide_id)} / ${clean(claim.claim_id)}`,'',`- Claim type: ${claim.claim_type}`,`- Qualification: ${clean(claim.qualification_note)||'not recorded'}`,`- Human verification: ${claim.verification_state}${claim.human_verification?` (${clean(claim.human_verification.verified_by)}, ${clean(claim.human_verification.verified_at)})`:''}`);for(const [locale,value] of Object.entries(claim.localized_text))lines.push(`- ${clean(locale)}: ${clean(value)}`);lines.push('');}
    await atomicWrite(destination,lines.join('\n'));
    print({file:destination,claims:claims.length,errors:claims.filter(claim=>claim.validation_issues.some(issue=>issue.severity==='error')).length});
  } else print(report);
  if(report.claims.some(claim=>claim.validation_issues.some(issue=>issue.severity==='error'))) process.exitCode=1;
});
projectOption(cli.command('story').description('Read the deck as a story: titles-only read-through, story roles, sections and flow prompts'))
  .option('--locale <locale>','Language of the titles to read (defaults to the source language)')
  .option('--init','Create a draft content/storyline.yaml with conservative inferred roles (never overwrites)')
  .option('--write-markdown','Write a local titles-only read-through to output/storyline.md')
  .option('--review','Render story/review.md from story/suggestions.yaml and list the review thread for each open suggestion')
  .option('--apply <ids>','Apply accepted suggestions (comma-separated SG IDs) with backups and feedback records')
  .option('--authorize <ids>','Allow accepted wording suggestions to change these approved/locked slide IDs')
  .action(async (_name,o)=>{
    const {dir,config,deck}=await loadProject(o.project);
    const {initStoryline,storyMarkdown,storyReport,readStoryline}=await import('../story/index.js');
    const {applySuggestions,candidateSuggestions,writeReview}=await import('../story/review.js');
    if(o.init||o.apply) {const {assertNoActiveSession}=await import('../session/lease.js');await assertNoActiveSession(o.project);}
    if(o.apply) {print(await applySuggestions(o.project,split(o.apply),split(o.authorize??'')));return;}
    if(o.review) {print(await writeReview(o.project));return;}
    if(o.init) print({created:await initStoryline(dir,deck),next:'Review each role with the creator, add sections, transitions and a one-sentence throughline, then rerun story.'});
    const report=await storyReport(dir,config,deck,o.locale);
    if(o.writeMarkdown) {
      const destination=await safePath(dir,'output/storyline.md');
      await atomicWrite(destination,storyMarkdown(o.project,report));
      print({file:destination,slides:report.slides.length,warnings:report.issues.filter(i=>i.severity==='warning').length,errors:report.issues.filter(i=>i.severity==='error').length});
    } else print({...report,candidates:candidateSuggestions(report,await readStoryline(dir)),note:'Story checks are heuristic prompts for human review. They do not establish that the narrative is sound or that the evidence supports it.'});
    if(report.issues.some(i=>i.severity==='error')) process.exitCode=1;
  });
const reviewModes=['prepare','submit','report','decide','link','plan','apply','verify','status','configure'];
projectOption(cli.command('review').description('Scientific review–revision workflow: structured findings, creator decisions, guarded revisions and re-review. The semantic review is done by a configured agent (agents/scientific-reviewer.md); this command never performs AI analysis itself.'))
  .requiredOption('--mode <mode>',reviewModes.join(', '))
  .option('--file <path>','Submission YAML from the reviewer or builder agent (submit)','review/submission.yaml')
  .option('--finding <ids>','Comma-separated finding IDs (decide, link)')
  .option('--decision <decision>','accept, reject, defer, discuss or request-alternative (decide)')
  .option('--by <name>','The person who made the decision or setting (decide, configure)')
  .option('--note <text>','Decision note, or the alternative wanted (decide)')
  .option('--authorize <ids>','Record the creator\'s explicit authority to change these approved/locked slides (decide --decision accept)')
  .option('--thread <id>','human-review thread ID to link to a finding (link)')
  .option('--workflow <mode>','review-only, assisted (default) or autonomous (configure)')
  .option('--max-rounds <n>','Maximum reviewer–builder revision rounds (configure; default 2)')
  .option('--allow-classes <list>','Autonomous change classes: object-geometry, layout (configure --workflow autonomous)')
  .option('--scope-slides <list>','Slides permitted to change: comma-separated IDs, all, or none (configure; pair with --scope-classes)')
  .option('--scope-classes <list>','Permitted revision change classes, comma-separated (configure; pair with --scope-slides)')
  .option('--no-render','Skip preview rendering after applying a revision (apply)')
  .option('--renderer <name>','auto, libreoffice or powerpoint (apply)','auto')
  .action(async (_name,o)=>{
    if(!reviewModes.includes(o.mode)) throw new Error(`Unknown mode ${o.mode}. Choose one of ${reviewModes.join(', ')}.`);
    const review=await import('../review/workflow.js');
    const {decisions}=await import('../review/ledger.js');
    const {workflowModes}=await import('../review/schema.js');
    const {dir}=await loadProject(o.project);
    switch(o.mode) {
      case 'prepare': print(await review.prepare(o.project)); break;
      case 'submit': print(await review.submit(o.project,path.isAbsolute(o.file)?o.file:await safePath(dir,o.file))); break;
      case 'report': print(await review.report(o.project)); break;
      case 'decide': {
        if(!o.finding||!o.decision||!o.by) throw new Error('decide needs --finding, --decision and --by. Record only decisions the creator actually made.');
        if(!(decisions as readonly string[]).includes(o.decision)) throw new Error(`--decision must be one of ${decisions.join(', ')}.`);
        print(await review.recordDecision(o.project,split(o.finding),o.decision,o.by,{note:o.note,authorize:split(o.authorize??'')}));
        break;
      }
      case 'link': if(!o.finding||!o.thread) throw new Error('link needs --finding and --thread.'); print(await review.linkThread(o.project,o.finding,o.thread)); break;
      case 'plan': print(await review.plan(o.project)); break;
      case 'apply': {
        const result=await review.apply(o.project,{render:o.render,renderer:o.renderer});print(result);
        if(result.validation_errors.length) process.exitCode=1;
        break;
      }
      case 'verify': print(await review.verify(o.project)); break;
      case 'status': print(await review.status(o.project)); break;
      case 'configure': {
        if(!o.by) throw new Error('configure needs --by: the creator who chose these settings.');
        if(o.workflow&&!(workflowModes as readonly string[]).includes(o.workflow)) throw new Error(`--workflow must be one of ${workflowModes.join(', ')}.`);
        const maxRounds=o.maxRounds===undefined?undefined:Number(o.maxRounds);
        if(maxRounds!==undefined&&(!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>10)) throw new Error('--max-rounds must be an integer from 1 to 10.');
        const existingSettings=(await review.readLedger(dir)).settings;
        if(o.workflow==='autonomous'||existingSettings.workflow==='autonomous'&&o.workflow===undefined&&o.allowClasses!==undefined) {
          // An agent must not opt a creator into autonomous revisions.
          if(!process.stdin.isTTY) throw new Error('Autonomous revision requires the creator to confirm in an interactive terminal.');
          const {confirm}=await import('@inquirer/prompts');
          const classes=split(o.allowClasses??'');
          if(!classes.length) throw new Error('Name the permitted change classes with --allow-classes (object-geometry, layout).');
          if(!await confirm({message:`Allow the builder to apply ${classes.join(' and ')} fixes to draft slides without asking per finding? Scientific wording, evidence, data, citations and the storyline still need your decision.`,default:false})) throw new Error('Not confirmed; settings unchanged.');
        }
        if((o.scopeSlides===undefined)!==(o.scopeClasses===undefined)) throw new Error('Set --scope-slides and --scope-classes together.');
        const scope=o.scopeSlides===undefined?undefined:{slide_ids:o.scopeSlides==='all'?null:o.scopeSlides==='none'?[]:split(o.scopeSlides),allowed_change_classes:split(o.scopeClasses)};
        const {revisionScopeSchema}=await import('../review/schema.js');
        print(await review.configure(o.project,{workflow:o.workflow,maxRounds,classes:o.allowClasses===undefined?(o.workflow&&o.workflow!=='autonomous'?[]:undefined):split(o.allowClasses),scope:scope?revisionScopeSchema.parse(scope):undefined,by:o.by}));
        break;
      }
    }
  });
projectOption(cli.command('render').description('Create real slide PNG previews, PDF and a contact sheet with a local renderer'))
  .option('--locale <locale>','Render one language').option('--renderer <name>','auto, libreoffice or powerpoint','auto')
  .action(async (_name,o)=>{
    if(!['auto','libreoffice','powerpoint'].includes(o.renderer))throw new Error('Unknown renderer. Choose auto, libreoffice or powerpoint.');
    const result=await renderProject(o.project,o.locale,o.renderer);print(result);
    if(!result.available) print('Install LibreOffice and Poppler (pdftoppm), or use PowerPoint on Windows. Set SOFFICE_PATH and PDFTOPPM_PATH if detection fails. PPTX files are already built and remain usable.');
  });
projectOption(cli.command('bundle').description('Package current PPTX files, validation and provenance for local delivery'))
  .option('--previews <choice>','none or latest; latest requires current rendered previews','none')
  .option('--input <path>','Explicitly include one project-relative original input under inputs/; repeat for more', (value:string, previous:string[])=>[...previous,value], [] as string[])
  .action(async (_name,o)=>{print(await bundleProject(o.project,{previews:o.previews,inputs:o.input}));});
projectOption(cli.command('ingest').description('Retain and extract local documents with hashes; does not invent slide summaries'))
  .option('--inputs <folder>','Folder to import (defaults to project inputs/)')
  .action(async (_name,o)=>{const {dir}=await loadProject(o.project);const records=await ingest(dir,o.inputs);print(records);if(records.some(r=>r.error))process.exitCode=1;});
projectOption(cli.command('translate').description('Export a manual translation request, or validate and import completed translations'))
  .requiredOption('--to <locale>','Target BCP 47 language').option('--file <path>','YAML translation request with translation objects filled in')
  .option('--authorize <ids>','Allow edits to protected slide translations').action(async (_name,o)=>{
    const to=localeSchema.parse(o.to),{dir,config,deck}=await loadProject(o.project);
    if(to===config.source_locale) throw new Error('Target must differ from source locale.');
    const request=translationRequest(deck,config.source_locale,to,config.glossary);
    if(!o.file) {const dest=await safePath(dir,`content/translation-request.${to}.${stamp()}.yaml`);await writeYaml(dest,request);print(`No translation provider configured. Review and fill translation fields in ${dest}, then rerun with --file. Slides requiring translation or review: ${request.slides.length}`);return;}
    const batch=await readYaml(path.resolve(o.file));
    const translated=importTranslations(deck,config.source_locale,to,config.glossary,batch,split(o.authorize??''));
    const contentFile=await safePath(dir,config.content);
    await atomicWrite(path.join(dir,`feedback/${stamp()}.translation-before.yaml`),await fs.readFile(contentFile));
    await writeYaml(contentFile,translated);
    if(!config.output_locales.includes(to))config.output_locales.push(to);
    await writeYaml(path.join(dir,'project.yaml'),config);print(`Imported ${to}. Review translations, then build.`);
  });
projectOption(cli.command('revise').description('Log natural-language feedback or apply a structured, auditable revision'))
  .option('--slide <id>','Stable slide ID').option('--message <text>','Feedback for an agent; logged without automatic interpretation')
  .option('--category <type>','content, layout, typography, illustration, translation, scientific-correction, global-theme','content')
  .option('--file <path>','YAML revision: slide, locale, category, message, patch/layout/status')
  .option('--authorize <ids>','Allow a specific approved/locked slide to change').action(async (_name,o)=>{
    if(!o.file&&(!o.slide||!o.message))throw new Error('Provide --file or both --slide and --message.');
    print(await applyRevision(o.project,o.file?await readYaml(path.resolve(o.file)):{slide:o.slide,category:o.category,message:o.message},split(o.authorize??'')));
  });
projectOption(cli.command('images').description('Prepare per-slide prompts and provenance; reuse accepted local assets'))
  .option('--slide <id>','Only one stable slide ID').option('--asset <file>','Attach a local image (requires --slide)')
  .option('--authorize <ids>','Approve replacing an accepted/protected asset').action(async (_name,o)=>{
    if(o.asset&&!o.slide)throw new Error('--asset requires --slide.');
    print(o.asset?await attachImage(o.project,o.slide,o.asset,split(o.authorize??'')):await prepareImages(o.project,o.slide));
  });

projectOption(cli.command('session').alias('serve').description('Open a shared browser studio with live editing, feedback and native PowerPoint export'))
  .option('--host <address>','Bind address; use 0.0.0.0 only on a trusted private network','127.0.0.1')
  .option('--port <number>','HTTP port (0 selects an available port)','0')
  .option('--agent-config <path>','Local JSON executable configuration for the background agent worker')
  .action(async (_name,o)=>{
    const {startSession}=await import('../session/server.js');
    const {agentConfigSchema}=await import('../session/agent.js');
    const agentConfig=o.agentConfig?agentConfigSchema.parse(JSON.parse(await fs.readFile(path.resolve(o.agentConfig),'utf8'))):undefined;
    const session=await startSession({project:o.project,host:o.host,port:Number(o.port),agentConfig});
    print({message:'PPTimistic shared studio is running. Invitation links grant access to this project; keep the owner link private.',
      url:session.url,owner:`${session.url}/#token=${session.ownerToken}`,editor:`${session.url}/#token=${session.editorToken}`,reviewer:`${session.url}/#token=${session.reviewerToken}`,
      agent:agentConfig?'Configured local worker':'Feedback is queued. Connect a local worker with --agent-config for automatic responses.',
      network:o.host==='127.0.0.1'?'Local computer only.':'Share using this computer’s private network address in place of localhost.'});
    let stopping=false;
    const stop=()=>{if(stopping)return;stopping=true;void session.close().then(()=>{process.exitCode=0;});};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  });

cli.showHelpAfterError();
cli.parseAsync().catch(error=>{console.error(`Error: ${error.message}`);process.exitCode=1;});
