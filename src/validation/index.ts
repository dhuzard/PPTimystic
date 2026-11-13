import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { exists, hash, hashFile, readYaml, safePath } from '../core/io.js';
import { type Deck, type Theme, type Project } from '../core/model.js';
import { resolveChartData } from '../content/chart-data.js';
import { consistency, fictionalDataDisclosure, translationFreshness } from '../localization/index.js';
import { chartLabelsNeedingReview } from '../layouts/text-fit.js';
import { creatorBriefStatus } from '../core/brief.js';

export type Issue = { severity: 'error' | 'warning'; code: string; slide?: string; locale?: string; claim?: string; message: string };
function luminance(hex: string) {
  const v = hex.match(/../g)!.map(s => parseInt(s,16)/255).map(n => n <= .04045 ? n/12.92 : ((n+.055)/1.055)**2.4);
  return .2126*v[0]+.7152*v[1]+.0722*v[2];
}
export function contrast(a: string, b: string) { const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
export async function validateContent(dir: string, config: Project, deck: Deck, theme: Theme, locales = config.output_locales) {
  const issues: Issue[] = [];
  const add = (code: string, message: string, slide?: string, locale?: string, severity: 'error'|'warning' = 'error') => issues.push({ severity, code, message, slide, locale });
  const brief = await creatorBriefStatus(dir, config);
  for (const message of brief.errors) add('creator-brief', message);
  if (contrast(theme.foreground,theme.background)<4.5 || contrast(theme.secondary,theme.background)<4.5 || contrast(theme.accent, theme.background)<4.5) add('contrast','Theme text contrast is below 4.5:1.');
  const seen = new Set<string>();
  const seenTitles = new Map<string, Set<string>>();
  const seenClaims = new Set<string>();
  const sources = await exists(path.join(dir,'content/sources.yaml')) ? (await readYaml(path.join(dir,'content/sources.yaml'))).sources as { id: string; path: string; sha256: string; extracted?: string; extracted_sha256?: string }[] : [];
  const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim();
  for (const slide of deck.slides) {
    if (seen.has(slide.id)) add('duplicate-id','Slide IDs must be unique.',slide.id);
    seen.add(slide.id);
    const objectIds=new Set<string>();
    for (const object of slide.objects??[]) {
      if (objectIds.has(object.id)) add('duplicate-object-id',`Object IDs must be unique within the slide: ${object.id}`,slide.id);
      objectIds.add(object.id);
      if (object.type==='image') {
        const asset=await safePath(dir,object.asset!);
        if (!(await exists(asset))) add('missing-asset',`Missing custom image: ${object.asset}`,slide.id);
      }
      const style={...object.style,...slide.visual_objects?.[object.id]?.style};
      if (object.type==='text' && contrast(style.color??theme.foreground,style.fill??theme.background)<4.5) add('object-contrast',`${object.id}: text contrast is below 4.5:1.`,slide.id);
    }
    for (const [role,override] of Object.entries(slide.visual_objects??{})) {
      if (override.hidden && !objectIds.has(role)) add('protected-object',`Source object ${role} cannot be hidden.`,slide.id);
      if (override.style?.color && !objectIds.has(role) && !/^(?:decoration-|connector-|illustration$|chart$)/.test(role)) {
        if (contrast(override.style.color,override.style.fill??(/^node-/.test(role)?theme.pale:theme.background))<4.5) add('object-contrast',`${role}: text contrast is below 4.5:1.`,slide.id);
      }
    }
    if (!slide.content[config.source_locale]) add('source-locale','Missing original content.',slide.id,config.source_locale);
    if (slide.evidence === 'missing') add('evidence','Scientific evidence has not been classified; review the source before approval.',slide.id,undefined,'warning');
    if (['established','interpretation'].includes(slide.evidence) && !slide.source_refs.length && !slide.citations.length) add('unsupported-claim','Scientific claims require a source reference or citation.',slide.id);
    for (const ref of slide.source_refs) {
      const source = sources.find(s => s.id===ref);
      if (!source) add('source-reference',`Unknown source reference: ${ref}`,slide.id);
      else {
        const p = await safePath(dir,source.path);
        if (!(await exists(p)) || await hashFile(p)!==source.sha256) add('source-integrity',`Source missing or changed since ingestion: ${ref}`,slide.id);
      }
    }
    for (const claim of slide.claims ?? []) {
      const addClaim = (code: string, message: string) => issues.push({ severity: 'error', code, slide: slide.id, claim: claim.id, message: `${claim.id}: ${message}` });
      if (seenClaims.has(claim.id)) addClaim('claim-id', 'Claim IDs must be globally unique.');
      seenClaims.add(claim.id);
      const original = slide.content[config.source_locale];
      const hidden = claim.field === 'caption' ? !['chart', 'full-image'].includes(slide.layout)
        : claim.field === 'body' ? ['chart', 'full-image'].includes(slide.layout)
        : claim.field === 'message' && slide.layout === 'full-image' ? Boolean(original?.caption) : false;
      if (!original?.[claim.field].trim() || hidden) addClaim('claim-field', `${claim.field} must contain visible source-locale text in this layout.`);
      const source = sources.find(record => record.id === claim.source_ref);
      if (!slide.source_refs.includes(claim.source_ref) || !source) {
        addClaim('claim-reference', `Source ${claim.source_ref} must appear in slide source_refs and content/sources.yaml.`);
        continue;
      }
      let extracted: string;
      try {
        if (!source.extracted) throw new Error('No extraction recorded');
        if (!source.extracted_sha256) {
          addClaim('claim-source-integrity', `Source ${claim.source_ref} has no ingestion-time extracted-text hash. Re-ingest the local source before using excerpt-backed claims.`);
          continue;
        }
        const data = await fs.readFile(await safePath(dir, source.extracted));
        if (hash(data) !== source.extracted_sha256) {
          addClaim('claim-source-integrity', `Extracted text for ${claim.source_ref} changed since ingestion. Review the original source and re-ingest it before using excerpt-backed claims.`);
          continue;
        }
        extracted = normalized(data.toString('utf8'));
        if (!extracted) throw new Error('Extraction is empty');
      } catch {
        addClaim('claim-source-text', `No usable local extracted text for ${claim.source_ref}. Convert or extract the source locally and ingest it, or use slide citations with manual review instead of an excerpt-backed claim.`);
        continue;
      }
      if (!extracted.includes(normalized(claim.excerpt))) addClaim('claim-excerpt', `Excerpt does not literally match local extracted source ${claim.source_ref} after whitespace normalization; scientific validity still requires human review.`);
    }
    if (slide.visual?.asset) {
      const p = await safePath(dir,slide.visual.asset);
      if (!(await exists(p))) add('missing-asset',`Missing asset: ${slide.visual.asset}`,slide.id);
    } else if (['text-image','full-image'].includes(slide.layout)) add('placeholder','Illustration missing; an explicitly labeled placeholder will be used.',slide.id,undefined,'warning');
    let chartData: Awaited<ReturnType<typeof resolveChartData>> | undefined;
    if (slide.layout === 'chart') {
      if (!slide.chart) add('chart','Chart layout requires chart data.',slide.id);
      else if (slide.chart.fictional) {
        if (slide.chart.binding || !slide.chart.series.length) add('chart-data','Fictional charts require inline data and cannot bind a CSV.',slide.id);
      } else {
        try { chartData = await resolveChartData(dir,slide); }
        catch (error) { add('chart-source',`Invalid CSV chart binding: ${(error as Error).message}`,slide.id); }
        const original=slide.content[config.source_locale];
        if (chartData && original && (JSON.stringify(original.labels)!==JSON.stringify(chartData.labels) || JSON.stringify(original.seriesNames)!==JSON.stringify(slide.chart.binding!.value_columns))) add('chart-source-labels','Source-language chart labels and series names must match the selected CSV categories and column headers.',slide.id,config.source_locale);
      }
    }
    for (const locale of locales) {
      const c = slide.content[locale];
      if (!c) { add('missing-translation',`Translation is missing. Run translate --to ${locale} or supply content manually.`,slide.id,locale); continue; }
      for (const object of slide.objects??[]) {
        const localized=c.objects?.[object.id];
        if (object.type==='text' && !localized?.text?.trim()) add('missing-object-translation',`Provide localized text for ${object.id}; source-language fallback is not used.`,slide.id,locale);
        if (object.type==='image' && !localized?.alt?.trim()) add('alt-text',`Provide a localized alt description for ${object.id}.`,slide.id,locale);
      }
      const title=normalized(c.title);
      const titles=seenTitles.get(locale)??new Set<string>();
      if (!title) add('slide-title','Provide a nonblank localized slide title.',slide.id,locale);
      else if (titles.has(title)) add('duplicate-title','Another slide has the same localized title. Review whether a distinct title would make slide navigation clearer.',slide.id,locale,'warning');
      titles.add(title); seenTitles.set(locale,titles);
      const source = slide.content[config.source_locale];
      if (source && locale !== config.source_locale) {
        const freshness = translationFreshness(slide, config.source_locale, locale);
        if (freshness.state === 'stale') add('translation-stale', `Source wording or shared chart/diagram content changed. This translation requires review; its stored approval is not current. Run translate --to ${locale}.`, slide.id, locale);
        if (freshness.state === 'untracked') add('translation-untracked', `No reviewed source fingerprint is recorded. Translation freshness and any stored approval are unverified. Run translate --to ${locale} to prepare a review request.`, slide.id, locale, 'warning');
      }
      if (source && locale !== config.source_locale) for (const msg of consistency(source,c,config.glossary)) add('translation-consistency',msg,slide.id,locale);
      for (const key of ['labels', 'seriesNames'] as const) if (c[key].some(value => !value.trim())) add('empty-label',`${key}: every array element must contain localized text.`,slide.id,locale);
      if (['diagram','workflow'].includes(slide.layout) && (c.labels.length<2 || c.labels.length>5)) add('diagram-labels','Use 2–5 labels for this layout.',slide.id,locale);
      if (slide.chart) {
        const series=chartData?.series ?? slide.chart.series;
        if (!c.labels.length || series.some(s=>s.values.length!==c.labels.length)) add('chart-labels','Chart labels and values must have matching lengths.',slide.id,locale);
        const crowded=chartLabelsNeedingReview(c.labels,13.333333-2*theme.margin,18);
        if (crowded.length) add('chart-label-review',`Chart category label${crowded.length===1?'':'s'} ${crowded.map(index=>index+1).join(', ')} may wrap or overlap in a local render; shorten or inspect the full-size chart.`,slide.id,locale,'warning');
        if (c.seriesNames.length!==series.length) add('chart-series','Provide a localized name for every chart series.',slide.id,locale);
        if (slide.chart.fictional && !fictionalDataDisclosure(locale,c.fictionalNotice)) add('fictional-disclosure',`Provide fictionalNotice with a reviewed localized fictional-data disclosure for ${locale} before exporting fictional charts.`,slide.id,locale);
      }
      if (['text-image','full-image'].includes(slide.layout) && slide.visual?.asset && !slide.visual.decorative && !c.alt.trim()) add('alt-text','Add an authored localized alt description explaining the illustration’s meaning, or explicitly set visual.decorative: true if it conveys no information.',slide.id,locale);
      if (slide.layout==='chart' && !c.alt.trim()) add('alt-text','Add an authored localized chart alt description explaining the values or trend and its limits. A caption alone is not a chart description.',slide.id,locale);
      if (c.title.length>100) add('title-density','Title exceeds 100 characters; split or shorten it.',slide.id,locale,'warning');
    }
  }
  return issues;
}

export async function validatePptx(file: string, expected: number) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const slides = Object.keys(zip.files).filter(k=>/^ppt\/slides\/slide\d+\.xml$/.test(k));
  if (slides.length!==expected) throw new Error(`PPTX has ${slides.length} slides, expected ${expected}`);
  for (const required of ['[Content_Types].xml','_rels/.rels','ppt/presentation.xml']) if (!zip.file(required)) throw new Error(`PPTX missing ${required}`);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const xml=await entry.async('string');
    if (XMLValidator.validate(xml)!==true) throw new Error(`Invalid XML: ${name}`);
    if (/<a:ext\b[^>]*\b(?:cx|cy)="-\d+"/.test(xml)) throw new Error(`Invalid negative shape extent: ${name}`);
    if (name.endsWith('.rels')) {
      for (const m of xml.matchAll(/<Relationship\s+([^>]+)\/?\s*>/g)) {
        const attrs=m[1];
        if (/TargetMode="External"/.test(attrs)) continue;
        const target=attrs.match(/Target="([^"]+)"/)?.[1];
        if (!target) continue;
        const base=path.posix.dirname(name).replace(/\/?_rels$/,'');
        const resolved=target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(base,target));
        if (!zip.file(resolved)) throw new Error(`Broken PPTX relationship: ${name} → ${target}`);
      }
    }
  }
  for (const name of slides) if (!(await zip.file(name)!.async('string')).includes('<a:t>')) throw new Error(`No editable native text: ${name}`);
  return { slides: slides.length, valid: true };
}
