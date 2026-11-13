import fs from 'node:fs/promises';
import path from 'node:path';
import { projectDir, writeYaml, atomicWrite, exists } from './io.js';
import { projectSchema } from './model.js';
import { blankBrief } from './brief.js';
import { demoDeck, ideaSvg } from '../content/demo.js';
import { translationSourceFingerprint } from '../localization/index.js';
import { ingest, deckFromMarkdown } from '../content/ingest.js';

export const styleSpec = `# Illustration style — version 1\n\nPalette: restrained teal (#225E63), white, pale gray-green.\nTechnique: flat geometric vector-like illustration.\nStroke: consistent thin lines; no sketch texture.\nTexture: none. Lighting: flat. Perspective: orthographic.\nGeometry: simple circles and straight connections. Detail: low.\nBackground: white or pale gray-green. Proportions: diagrammatic, never empirical.\nComplexity: one visual idea, at most five objects.\nNegative space: at least one third of the composition.\nComposition: centered with safe space for separately editable text.\n\nMaster prompt: Create a conceptual scientific communication illustration using the specification above. No text, letters, numbers, charts, or simulated empirical results.\n\nReference analysis: no reference has been analyzed automatically. Place your reference images under assets/reference/ and ask an agent to inspect them and revise each field. Do not claim a match until reviewed.\n`;
export const presentationBrief = `# Presentation brief\n\nFor real projects, complete and approve presentation-brief.yaml before authoring or exporting slides. This Markdown file is for supplementary notes, examples and links; it is not the validated brief. Do not put confidential or identifying details in externally shared materials. The authoritative slide content remains content/slides.yaml.\n\n- Purpose and desired audience action: Unknown\n- Audience, prior knowledge and accessibility needs: Unknown\n- Delivery mode, venue and presentation duration: Unknown\n- Core message, scope and required slide plan: Unknown\n- Sources, evidence limitations and open questions: Unknown\n- Visual preferences, references and required assets: Unknown\n- Source and output languages, terminology and translation needs: Unknown\n- Required format, deadline and other constraints: Unknown\n- Decisions, assumptions and questions for review: Unknown\n`;
export async function createProject(options:{name:string;title:string;source:string;locales:string[];theme:string;inputs?:string;fromPlan?:boolean;briefRequired?:boolean}) {
  const dir=projectDir(options.name);
  // mkdir without recursive makes concurrent/rerun collisions fail before any user file changes.
  await fs.mkdir(path.dirname(dir),{recursive:true});
  try { await fs.mkdir(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException).code==='EEXIST') throw new Error(`Project ${options.name} already exists; nothing was overwritten. Use build or choose a new --project name.`);
    throw e;
  }
  const config=projectSchema.parse({version:1,title:options.title,source_locale:options.source,output_locales:options.locales,theme:options.theme,brief_required:options.briefRequired??false});
  for (const p of ['inputs','content','assets/reference','assets/generated','feedback','output']) await fs.mkdir(path.join(dir,p),{recursive:true});
  await writeYaml(path.join(dir,'project.yaml'),config);
  await writeYaml(path.join(dir,'presentation-brief.yaml'),blankBrief(config));
  await atomicWrite(path.join(dir,'assets/reference/idea.svg'),ideaSvg);
  await atomicWrite(path.join(dir,'illustration-style.md'),styleSpec);
  await atomicWrite(path.join(dir,'presentation-brief.md'),presentationBrief);
  let deck=demoDeck(options.title);
  if (!['en-US','fr-FR'].includes(options.source)) throw new Error('Initial sample content is available in en-US and fr-FR. For other source languages, create with en-US then replace the content and source_locale together.');
  // The authored bilingual fictional starter was reviewed as a pair. A later
  // source edit invalidates only its corresponding translated slide.
  for (const slide of deck.slides) for (const locale of ['en-US','fr-FR']) if (locale!==options.source)
    slide.content[locale].source_fingerprint=translationSourceFingerprint(slide,options.source);
  if (options.inputs) {
    const refs=await ingest(dir,options.inputs);
    if (options.fromPlan) {
      const imported=await deckFromMarkdown(dir,refs,options.source);
      if (!imported) throw new Error('--from-plan requires exactly one Markdown file with ## slide headings. Inputs were retained for inspection.');
      deck=imported;
    } else {
      await atomicWrite(path.join(dir,'content/INPUTS-README.txt'),'Documents have been retained and extracted with provenance in sources.yaml. The current deck is a fictional demonstration, not a summary of these documents. Ask your coding agent to author content/slides.yaml from the sources, or use --from-plan for a Markdown slide plan.');
    }
  }
  await writeYaml(path.join(dir,'content/slides.yaml'),deck);
  return dir;
}
export async function availableName(base='my-presentation') {
  let n=base,index=2;
  while(await exists(projectDir(n))) n=`${base}-${index++}`;
  return n;
}
