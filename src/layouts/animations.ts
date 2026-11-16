import fs from 'node:fs/promises';
import JSZip from 'jszip';
import type { AnimationSettings, ProjectAnimations, Slide } from '../core/model.js';

/** A set of scene roles that should enter together; `group` also makes them one PowerPoint group. */
export type AnimationUnit = { roles: string[]; group?: boolean; name?: string };
export type AnimationEffect = NonNullable<AnimationSettings['effect']>;
export type AnimationDirection = NonNullable<AnimationSettings['direction']>;
export type AnimationTrigger = NonNullable<AnimationSettings['trigger']>;
export type PlannedAnimationStep = {
  roles: string[]; group: boolean; name: string;
  effect: AnimationEffect; direction?: AnimationDirection; trigger: AnimationTrigger;
  durationMs: number; delayMs: number;
};
export type AnimationIssue = { severity: 'error' | 'warning'; message: string };
export type AnimationPlan = { source: 'automatic' | 'explicit'; steps: PlannedAnimationStep[]; issues: AnimationIssue[] };

export const animationDefaults = { effect: 'fade', trigger: 'on-click', duration: 0.5, delay: 0 } as const;
const directional: AnimationEffect[] = ['wipe', 'fly-in'];
/** Footer and citations remain visible from the first frame so sources are never hidden. */
const staticRoles = new Set(['footer', 'citation']);

export function animationsEnabled(slide: Slide, project?: ProjectAnimations) {
  if (slide.animations?.enabled !== undefined) return slide.animations.enabled;
  if (slide.animations) return true;
  return project ? project.enabled !== false : false;
}

function settings(...layers: (AnimationSettings | undefined)[]) {
  const merged: AnimationSettings = { ...animationDefaults };
  for (const layer of layers) for (const key of ['effect', 'direction', 'trigger', 'duration', 'delay'] as const) {
    if (layer?.[key] !== undefined) (merged as Record<string, unknown>)[key] = layer[key];
  }
  return merged as Required<Omit<AnimationSettings, 'direction'>> & Pick<AnimationSettings, 'direction'>;
}

/**
 * Resolve the effective entrance sequence for one composed slide.
 * Automatic sequences use the layout's own units (for example box + label + arrow);
 * explicit `steps` list exactly the roles to animate, and every other object stays static.
 */
export function planSlideAnimation(slide: Slide, project: ProjectAnimations | undefined, objects: { role: string; type: string }[], units: AnimationUnit[]): AnimationPlan | undefined {
  if (!animationsEnabled(slide, project)) return undefined;
  const issues: AnimationIssue[] = [];
  const types = new Map(objects.map(object => [object.role, object.type]));
  const base = settings(project, slide.animations);
  const steps: PlannedAnimationStep[] = [];
  const used = new Set<string>();
  const explicit = slide.animations?.steps;
  const sourceSteps = explicit ?? units.map(unit => ({ targets: unit.roles, group: unit.group, name: unit.name }));
  for (const [index, step] of sourceSteps.entries()) {
    const layer = explicit ? settings(project, slide.animations, step as AnimationSettings) : base;
    const roles: string[] = [];
    for (const role of step.targets) {
      if (!types.has(role)) {
        if (explicit) issues.push({ severity: 'error', message: `Animation step ${index + 1}: "${role}" is not a visible object on this slide. Known objects: ${[...types.keys()].filter(r => !staticRoles.has(r)).join(', ')}.` });
        continue;
      }
      if (staticRoles.has(role)) { issues.push({ severity: 'error', message: `Animation step ${index + 1}: "${role}" stays visible so sources and slide numbers are never hidden.` }); continue; }
      if (used.has(role)) { issues.push({ severity: 'error', message: `Animation step ${index + 1}: "${role}" is already animated in an earlier step.` }); continue; }
      used.add(role); roles.push(role);
    }
    if (!roles.length) continue;
    let group = Boolean(step.group);
    if (group && roles.length < 2) {
      if (explicit) issues.push({ severity: 'error', message: `Animation step ${index + 1}: a group needs at least two objects.` });
      group = false;
    }
    if (group && roles.some(role => role === 'title' || types.get(role) === 'chart')) {
      issues.push({ severity: 'error', message: `Animation step ${index + 1}: the slide title and native charts cannot be placed inside a PowerPoint group; list them in their own step.` });
      group = false;
    }
    if (explicit && layer.direction && !directional.includes(layer.effect)) issues.push({ severity: 'warning', message: `Animation step ${index + 1}: direction "${layer.direction}" has no effect on "${layer.effect}".` });
    steps.push({ roles, group, name: (step as { name?: string }).name ?? `animation-group-${index + 1}`,
      effect: layer.effect, ...(directional.includes(layer.effect) ? { direction: layer.direction ?? 'bottom' } : {}),
      trigger: layer.trigger, durationMs: Math.round(layer.duration * 1000), delayMs: Math.round(layer.delay * 1000) });
  }
  // A fictional chart must never be visible without its disclosure.
  const stepOf = (role: string) => steps.findIndex(step => step.roles.includes(role));
  const chart = stepOf('chart'), disclosure = stepOf('fictional-disclosure');
  if (chart >= 0 && disclosure > chart) issues.push({ severity: 'error', message: 'The fictional-data disclosure must appear in the same step as the chart or earlier.' });
  if (!steps.length && !issues.length) issues.push({ severity: 'warning', message: 'Animations are enabled but no object on this slide is animated.' });
  return { source: explicit ? 'explicit' : 'automatic', steps, issues };
}

/** Group overlapping added objects so a custom box and its text enter together. */
export function customObjectUnits(objects: { role: string; type: string; x: number; y: number; w: number; h: number }[]): AnimationUnit[] {
  const units: { unit: AnimationUnit; boxes: typeof objects }[] = [];
  const overlaps = (a: typeof objects[number], b: typeof objects[number]) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
  for (const object of objects) {
    const existing = units.find(entry => entry.boxes.some(box => overlaps(box, object)));
    if (existing) { existing.unit.roles.push(object.role); existing.boxes.push(object); }
    else units.push({ unit: { roles: [object.role] }, boxes: [object] });
  }
  return units.map(({ unit, boxes }, index) => ({ ...unit, group: unit.roles.length > 1 && boxes.some(box => box.type === 'shape'), name: `object-group-${index + 1}` }));
}

const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&apos;');
const unescapeXml = (value: string) => value.replace(/&(amp|quot|lt|gt|apos);/g, (_, entity: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" })[entity]!);
type Element = { kind: string; xml: string; start: number; end: number; id: number; name: string };
type Target = { spid: number; kind: string };

function elements(tree: string): Element[] {
  return [...tree.matchAll(/<p:(sp|pic|graphicFrame|cxnSp|grpSp)\b[^>]*>[\s\S]*?<\/p:\1>/g)].map(match => {
    const nv = match[0].match(/<p:cNvPr\b[^>]*>/)?.[0] ?? '';
    return { kind: match[1], xml: match[0], start: match.index!, end: match.index! + match[0].length,
      id: Number(nv.match(/\bid="(\d+)"/)?.[1]), name: unescapeXml(nv.match(/\bname="([^"]*)"/)?.[1] ?? '') };
  });
}
function bounds(xml: string) {
  const off = xml.match(/<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/), ext = xml.match(/<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
  if (!off || !ext) throw new Error('Animation group: member has no position');
  return { x: Number(off[1]), y: Number(off[2]), cx: Number(ext[1]), cy: Number(ext[2]) };
}

// Effect markup mirrors what PowerPoint 16 writes for the same presets.
const subtypes: Record<AnimationDirection, number> = { top: 1, right: 2, bottom: 4, left: 8 };
const wipeFilter: Record<AnimationDirection, string> = { top: 'up', right: 'right', bottom: 'down', left: 'left' };
const flyFrom: Record<AnimationDirection, [string, string]> = { left: ['0-#ppt_w/2', '#ppt_y'], right: ['1+#ppt_w/2', '#ppt_y'], top: ['#ppt_x', '0-#ppt_h/2'], bottom: ['#ppt_x', '1+#ppt_h/2'] };
const animatesWithBuild = (kind: string) => kind === 'sp' || kind === 'graphicFrame';

function timingXml(effects: (Target & { step: PlannedAnimationStep; trigger: AnimationTrigger })[]) {
  type Inner = { offset: number; end: number; effects: typeof effects };
  const clicks: { auto: boolean; inners: Inner[] }[] = [];
  for (const effect of effects) {
    if (effect.trigger === 'on-click' || !clicks.length) clicks.push({ auto: effect.trigger !== 'on-click', inners: [] });
    const click = clicks.at(-1)!, last = click.inners.at(-1);
    if (!last || effect.trigger === 'after-previous' && last.effects.length) click.inners.push({ offset: effect.trigger === 'after-previous' ? last?.end ?? 0 : 0, end: 0, effects: [] });
    const inner = click.inners.at(-1)!;
    inner.effects.push(effect);
    inner.end = Math.max(inner.end, inner.offset + effect.step.delayMs + (effect.step.effect === 'appear' ? 0 : effect.step.durationMs));
  }
  let id = 2;
  const target = (spid: number) => `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
  const behaviors = ({ spid, step }: Target & { step: PlannedAnimationStep }) => {
    const visible = `<p:set><p:cBhvr><p:cTn id="${++id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${target(spid)}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
    const dur = step.durationMs;
    if (step.effect === 'appear') return visible;
    if (step.effect === 'fade') return `${visible}<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${++id}" dur="${dur}"/>${target(spid)}</p:cBhvr></p:animEffect>`;
    if (step.effect === 'wipe') return `${visible}<p:animEffect transition="in" filter="wipe(${wipeFilter[step.direction!]})"><p:cBhvr><p:cTn id="${++id}" dur="${dur}"/>${target(spid)}</p:cBhvr></p:animEffect>`;
    const [x, y] = flyFrom[step.direction!];
    const motion = (attribute: string, from: string) => `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${++id}" dur="${dur}" fill="hold"/>${target(spid)}<p:attrNameLst><p:attrName>${attribute}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#${attribute}"/></p:val></p:tav></p:tavLst></p:anim>`;
    return `${visible}${motion('ppt_x', x)}${motion('ppt_y', y)}`;
  };
  const preset = (step: PlannedAnimationStep) => step.effect === 'fade' ? [10, 0] : step.effect === 'appear' ? [1, 0] : [step.effect === 'wipe' ? 22 : 2, subtypes[step.direction!]];
  const nodeType = { 'on-click': 'clickEffect', 'with-previous': 'withEffect', 'after-previous': 'afterEffect' } as const;
  const sequence = clicks.map(click => {
    const clickId = ++id;
    const start = click.auto ? '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : '<p:cond delay="indefinite"/>';
    const inners = click.inners.map(inner => {
      const innerId = ++id;
      const effectXml = inner.effects.map(effect => {
        const effectId = ++id, [presetId, subtype] = preset(effect.step);
        const grpId = animatesWithBuild(effect.kind) ? ' grpId="0"' : '';
        return `<p:par><p:cTn id="${effectId}" presetID="${presetId}" presetClass="entr" presetSubtype="${subtype}" fill="hold"${grpId} nodeType="${nodeType[effect.trigger]}"><p:stCondLst><p:cond delay="${effect.step.delayMs}"/></p:stCondLst><p:childTnLst>${behaviors(effect)}</p:childTnLst></p:cTn></p:par>`;
      }).join('');
      return `<p:par><p:cTn id="${innerId}" fill="hold"><p:stCondLst><p:cond delay="${inner.offset}"/></p:stCondLst><p:childTnLst>${effectXml}</p:childTnLst></p:cTn></p:par>`;
    }).join('');
    return `<p:par><p:cTn id="${clickId}" fill="hold"><p:stCondLst>${start}</p:stCondLst><p:childTnLst>${inners}</p:childTnLst></p:cTn></p:par>`;
  }).join('');
  const builds = [...new Map(effects.map(effect => [effect.spid, effect])).values()].map(({ spid, kind }) =>
    kind === 'sp' ? `<p:bldP spid="${spid}" grpId="0" animBg="1"/>` : kind === 'graphicFrame' ? `<p:bldGraphic spid="${spid}" grpId="0"><p:bldAsOne/></p:bldGraphic>` : '').join('');
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${sequence}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${builds ? `<p:bldLst>${builds}</p:bldLst>` : ''}</p:timing>`;
}

/** Group objects and add entrance timing to one generated slide part. */
export function animateSlideXml(xml: string, slideId: string, plan: AnimationPlan): string {
  if (!plan.steps.length) return xml;
  if (xml.includes('<p:timing')) throw new Error(`Animations: ${slideId} already contains timing`);
  const treeMatch = xml.match(/(<p:spTree>)([\s\S]*)(<\/p:spTree>)/);
  if (!treeMatch) throw new Error(`Animations: ${slideId} has no shape tree`);
  const tree = treeMatch[2], all = elements(tree);
  const byRole = (role: string) => {
    const key = `${slideId}:${role}`;
    const found = all.filter(element => element.name === key || element.name.startsWith(`${key} | `));
    if (found.length !== 1) throw new Error(`Animations: ${found.length ? 'duplicate' : 'missing'} object ${key}`);
    return found[0];
  };
  let nextId = Math.max(0, ...[...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map(match => Number(match[1])));
  const replacements = new Map<Element, string>();
  const effects: Parameters<typeof timingXml>[0] = [];
  for (const step of plan.steps) {
    const members = step.roles.map(byRole);
    let targets: Target[];
    if (step.group) {
      members.sort((a, b) => a.start - b.start);
      const boxes = members.map(member => bounds(member.xml));
      const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
      const cx = Math.max(...boxes.map(b => b.x + b.cx)) - x, cy = Math.max(...boxes.map(b => b.y + b.cy)) - y;
      const spid = ++nextId;
      const labels = members.map(member => member.name.split(' | ').slice(1).join(' | ')).filter(Boolean);
      const descr = labels.length ? ` descr="${escapeXml(labels.join('; '))}"` : '';
      const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${spid}" name="${escapeXml(`${slideId}:${step.name}`)}"${descr}/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${x}" y="${y}"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></p:grpSpPr>${members.map(member => member.xml).join('')}</p:grpSp>`;
      // The group takes the z-order position of its lowest member.
      members.forEach((member, index) => replacements.set(member, index ? '' : group));
      targets = [{ spid, kind: 'grpSp' }];
    } else targets = members.map(member => ({ spid: member.id, kind: member.kind }));
    targets.forEach((target, index) => effects.push({ ...target, step, trigger: index ? 'with-previous' : step.trigger }));
  }
  let rebuilt = '', cursor = 0;
  for (const element of all) {
    rebuilt += tree.slice(cursor, element.start) + (replacements.has(element) ? replacements.get(element)! : element.xml);
    cursor = element.end;
  }
  rebuilt += tree.slice(cursor);
  let updated = xml.replace(treeMatch[0], () => `${treeMatch[1]}${rebuilt}${treeMatch[3]}`);
  const timing = timingXml(effects);
  const anchor = ['</p:transition>', '</p:clrMapOvr>', '</p:cSld>'].find(tag => updated.includes(tag));
  if (!anchor) throw new Error(`Animations: cannot place timing in ${slideId}`);
  updated = updated.replace(anchor, () => `${anchor}${timing}`);
  return updated;
}

/** Add native entrance animations to a newly staged deck. Never use on an existing user presentation. */
export async function finalizeAnimations(file: string, slides: { id: string; animation?: AnimationPlan }[]) {
  if (!slides.some(slide => slide.animation?.steps.length)) return;
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  for (const [index, slide] of slides.entries()) {
    if (!slide.animation?.steps.length) continue;
    const part = `ppt/slides/slide${index + 1}.xml`, entry = zip.file(part);
    if (!entry) throw new Error(`Animations: missing ${part}`);
    zip.file(part, animateSlideXml(await entry.async('string'), slide.id, slide.animation));
  }
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
