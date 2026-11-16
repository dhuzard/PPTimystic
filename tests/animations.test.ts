import { afterAll, beforeAll, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import YAML from 'yaml';
import { demoDeck, ideaSvg } from '../src/content/demo.js';
import { projectSchema, slideSchema, themeSchema, type ProjectAnimations, type Slide, type Theme } from '../src/core/model.js';
import { drawSlide, validateGeometry, type SlideGeometry } from '../src/layouts/index.js';
import { finalizeAccessibility } from '../src/layouts/accessibility.js';
import { finalizeAnimations } from '../src/layouts/animations.js';
import { fingerprints } from '../src/core/build.js';
import { validatePptx } from '../src/validation/index.js';

const exec = promisify(execFile), repo = process.cwd();
let sandbox: string, theme: Theme;
beforeAll(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'pptimistic-animations-'));
  await fs.mkdir(path.join(sandbox, 'assets/reference'), { recursive: true });
  await fs.writeFile(path.join(sandbox, 'assets/reference/idea.svg'), ideaSvg);
  theme = themeSchema.parse(YAML.parse(await fs.readFile('config/themes/editorial-minimal.yaml', 'utf8')));
});
afterAll(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

async function build(slides: Slide[], animations?: ProjectAnimations) {
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
  const geometry: SlideGeometry[] = [];
  for (const [index, slide] of slides.entries()) geometry.push(await drawSlide(pptx, slide, slide.content['en-US'], theme, 'en-US', sandbox, index, { animations }));
  const file = path.join(sandbox, `deck-${crypto.randomUUID()}.pptx`);
  await pptx.writeFile({ fileName: file });
  await finalizeAccessibility(file, geometry);
  await finalizeAnimations(file, geometry);
  await validatePptx(file, slides.length);
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const xml = await Promise.all(slides.map((_, index) => zip.file(`ppt/slides/slide${index + 1}.xml`)!.async('string')));
  return { geometry, xml };
}
const workflow = () => structuredClone(demoDeck('Animation fixture').slides[2]);
const effects = (xml: string) => [...xml.matchAll(/presetID="(\d+)"[^>]*presetSubtype="(\d+)"[^>]*nodeType="(\w+)"/g)].map(m => `${m[1]}/${m[2]}/${m[3]}`);
const spid = (xml: string, name: string) => xml.match(new RegExp(`<p:cNvPr id="(\\d+)" name="${name}[" |]`))![1];

test('slides without animation settings stay static and ungrouped', async () => {
  const { geometry, xml } = await build(demoDeck('Static').slides);
  expect(geometry.every(g => g.animation === undefined)).toBe(true);
  for (const slide of xml) { expect(slide).not.toContain('<p:timing'); expect(slide).not.toContain('<p:grpSp>'); }
});

test('a deck-wide default fades items in on click and groups each workflow box, label and incoming arrow', async () => {
  const { geometry, xml } = await build([workflow()], {});
  const steps = geometry[0].animation!.steps;
  expect(steps.map(step => step.roles)).toEqual([['message'], ['decoration-1', 'node-0'], ['connector-0', 'decoration-2', 'node-1'], ['connector-1', 'decoration-3', 'node-2'], ['connector-2', 'decoration-4', 'node-3'], ['body']]);
  expect(steps.every(step => step.effect === 'fade' && step.trigger === 'on-click' && step.durationMs === 500)).toBe(true);
  const slide = xml[0];
  // Title and footer remain static; each step is one fade on click.
  expect(effects(slide)).toEqual(Array(6).fill('10/0/clickEffect'));
  expect(slide).not.toContain(`spid="${spid(slide, 'S003:title')}"`);
  expect(slide).not.toContain(`spid="${spid(slide, 'S003:footer')}"`);
  const groups = [...slide.matchAll(/<p:grpSp>([\s\S]*?)<\/p:grpSp>/g)];
  expect(groups).toHaveLength(4);
  const members = (group: string) => [...group.matchAll(/<p:cNvPr id="\d+" name="(S003:[a-z0-9-]+)/g)].map(m => m[1]);
  expect(members(groups[1][1])).toEqual(['S003:node-group-1', 'S003:connector-0', 'S003:decoration-2', 'S003:node-1']);
  expect(groups[1][1]).toContain('descr="Sources → Structure; Structure"');
  // The group, not its children, is the animation target; z-order and geometry are unchanged.
  const groupId = groups[1][1].match(/<p:cNvPr id="(\d+)"/)![1];
  expect(slide).toContain(`<p:spTgt spid="${groupId}"/>`);
  expect(slide).not.toContain(`<p:spTgt spid="${spid(slide, 'S003:node-1')}"/>`);
  expect(slide).toContain(`<p:bldP spid="${spid(slide, 'S003:message')}" grpId="0" animBg="1"/>`);
});

test('the fictional chart disclosure enters with its chart', async () => {
  const chart = demoDeck('Chart').slides[3];
  const { geometry, xml } = await build([chart], {});
  expect(geometry[0].animation!.steps.map(step => step.roles)).toEqual([['message'], ['chart', 'fictional-disclosure'], ['caption']]);
  expect(effects(xml[0])).toEqual(['10/0/clickEffect', '10/0/clickEffect', '10/0/withEffect', '10/0/clickEffect']);
  expect(xml[0]).toContain(`<p:bldGraphic spid="${spid(xml[0], 'S004:chart')}" grpId="0"><p:bldAsOne/></p:bldGraphic>`);
});

test('explicit steps choose effects, directions, timing and groups; unlisted objects stay static', async () => {
  const slide = workflow();
  slide.animations = { effect: 'wipe', duration: 0.8, steps: [
    { targets: ['message'], effect: 'fly-in', direction: 'left' },
    { targets: ['node-0', 'decoration-1'], group: true },
    { targets: ['body'], effect: 'appear', trigger: 'after-previous', delay: 0.25 }
  ] };
  const { geometry, xml } = await build([slide]);
  expect(validateGeometry(geometry[0])).toEqual([]);
  expect(geometry[0].animation!.steps.map(({ roles, effect, direction, trigger, durationMs, delayMs }) => ({ roles, effect, direction, trigger, durationMs, delayMs }))).toEqual([
    { roles: ['message'], effect: 'fly-in', direction: 'left', trigger: 'on-click', durationMs: 800, delayMs: 0 },
    { roles: ['node-0', 'decoration-1'], effect: 'wipe', direction: 'bottom', trigger: 'on-click', durationMs: 800, delayMs: 0 },
    { roles: ['body'], effect: 'appear', direction: undefined, trigger: 'after-previous', durationMs: 800, delayMs: 250 }
  ]);
  const xmlSlide = xml[0];
  expect(effects(xmlSlide)).toEqual(['2/8/clickEffect', '22/4/clickEffect', '1/0/afterEffect']);
  expect(xmlSlide).toContain('<p:strVal val="0-#ppt_w/2"/>');
  expect(xmlSlide).toContain('filter="wipe(down)"');
  // After-previous waits for the 800 ms wipe, then applies its own 250 ms delay.
  expect(xmlSlide).toMatch(/<p:cond delay="800"\/><\/p:stCondLst><p:childTnLst><p:par><p:cTn id="\d+" presetID="1"[^>]*><p:stCondLst><p:cond delay="250"\/>/);
  // Only the explicitly requested group is created; other workflow nodes stay ungrouped and static.
  expect(xmlSlide.match(/<p:grpSp>/g)).toHaveLength(1);
  expect(xmlSlide).not.toContain(`<p:spTgt spid="${spid(xmlSlide, 'S003:node-1')}"/>`);
});

test('an opening after-previous step starts automatically with the slide', async () => {
  const slide = workflow();
  slide.animations = { steps: [{ targets: ['message'], trigger: 'after-previous' }, { targets: ['body'], trigger: 'with-previous' }] };
  const { xml } = await build([slide]);
  expect(xml[0]).toContain('<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>');
  expect(effects(xml[0])).toEqual(['10/0/afterEffect', '10/0/withEffect']);
});

test('invalid animation requests are reported before any PPTX is written', async () => {
  const slide = workflow();
  slide.animations = { direction: 'left', steps: [
    { targets: ['missing-object'] }, { targets: ['footer'] }, { targets: ['title', 'message'], group: true }, { targets: ['message'] }, { targets: ['node-0'], group: true }
  ] };
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
  const messages = validateGeometry(await drawSlide(pptx, slide, slide.content['en-US'], theme, 'en-US', sandbox, 0)).map(issue => `${issue.severity}:${issue.code}:${issue.message}`);
  expect(messages).toEqual([
    expect.stringMatching(/^error:animation:Animation step 1: "missing-object" is not a visible object/),
    expect.stringMatching(/^error:animation:Animation step 2: "footer" stays visible/),
    expect.stringMatching(/^error:animation:Animation step 3: the slide title and native charts cannot be placed inside a PowerPoint group/),
    expect.stringMatching(/^warning:animation:Animation step 3: direction "left" has no effect on "fade"/),
    expect.stringMatching(/^error:animation:Animation step 4: "message" is already animated/),
    expect.stringMatching(/^error:animation:Animation step 5: a group needs at least two objects/),
    expect.stringMatching(/^warning:animation:Animation step 5: direction "left"/)
  ]);
  const chart = demoDeck('Chart').slides[3];
  chart.animations = { steps: [{ targets: ['chart'] }, { targets: ['fictional-disclosure'] }] };
  const geometry = await drawSlide(pptx, chart, chart.content['en-US'], theme, 'en-US', sandbox, 1);
  expect(validateGeometry(geometry)).toContainEqual(expect.objectContaining({ severity: 'error', code: 'animation', message: expect.stringContaining('fictional-data disclosure') }));
});

test('slides can opt out of the deck default, and the default is part of protected fingerprints', async () => {
  const slides = demoDeck('Opt out').slides.slice(0, 2);
  slides[1].animations = { enabled: false };
  const { geometry, xml } = await build(slides, { effect: 'appear' });
  expect(geometry[0].animation!.steps.every(step => step.effect === 'appear')).toBe(true);
  expect(geometry[1].animation).toBeUndefined();
  expect(xml[1]).not.toContain('<p:timing');
  const deck = { version: 1 as const, slides };
  const none = await fingerprints(sandbox, deck, theme), fade = await fingerprints(sandbox, deck, theme, {}), appear = await fingerprints(sandbox, deck, theme, { effect: 'appear' });
  expect(fade.S001.fingerprint).not.toBe(none.S001.fingerprint);
  expect(appear.S001.fingerprint).not.toBe(fade.S001.fingerprint);
  expect(appear.S002.fingerprint).toBe(none.S002.fingerprint);
});

test('overlapping added objects enter together and a box with text becomes one group', async () => {
  const box = 'object-12345678-1234-4234-8234-123456789abc', label = 'object-12345678-1234-4234-8234-123456789abd', far = 'object-12345678-1234-4234-8234-123456789abe';
  const slide = slideSchema.parse({ id: 'C1', layout: 'statement', animations: {}, content: { 'en-US': { title: 'Custom objects', message: 'Message', objects: { [label]: { text: 'Inside the box' }, [far]: { text: 'Elsewhere' } } } },
    objects: [{ id: box, type: 'shape', x: 1, y: 5, w: 4, h: 1.2 }, { id: label, type: 'text', x: 1.2, y: 5.2, w: 3, h: .6 }, { id: far, type: 'text', x: 8, y: 5.2, w: 3, h: .6 }] });
  const { geometry, xml } = await build([slide]);
  expect(geometry[0].animation!.steps.map(step => [step.roles, step.group])).toEqual([[['message'], false], [[box, label], true], [[far], false]]);
  expect(xml[0].match(/<p:grpSp>/g)).toHaveLength(1);
});

test('schemas reject unknown animation effects and settings', () => {
  expect(slideSchema.safeParse({ ...workflow(), animations: { effect: 'spin' } }).success).toBe(false);
  expect(slideSchema.safeParse({ ...workflow(), animations: { steps: [{ targets: [] }] } }).success).toBe(false);
  expect(projectSchema.safeParse({ version: 1, title: 'T', source_locale: 'en-US', output_locales: ['en-US'], animations: { effect: 'fade', speed: 'fast' } }).success).toBe(false);
});

test('CLI build writes animations and protects approved slides from a new deck-wide default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pptimistic-animation-cli-'));
  const cli = async (...args: string[]) => {
    try { const r = await exec(process.execPath, ['--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href, path.join(repo, 'src/cli/index.ts'), ...args], { cwd: root, timeout: 60000 }); return { code: 0, output: r.stdout + r.stderr }; }
    catch (e) { const r = e as { code: number; stdout: string; stderr: string }; return { code: r.code, output: r.stdout + r.stderr }; }
  };
  try {
    await fs.cp(path.join(repo, 'config'), path.join(root, 'config'), { recursive: true });
    expect((await cli('setup', '--yes', '--project', 'demo', '--no-render')).code).toBe(0);
    const project = path.join(root, 'projects/demo');
    const deck = YAML.parse(await fs.readFile(path.join(project, 'content/slides.yaml'), 'utf8'));
    deck.slides[0].status = 'approved';
    await fs.writeFile(path.join(project, 'content/slides.yaml'), YAML.stringify(deck));
    expect((await cli('build', '--project', 'demo', '--authorize', 'S001')).code).toBe(0);
    const config = YAML.parse(await fs.readFile(path.join(project, 'project.yaml'), 'utf8'));
    config.animations = {};
    await fs.writeFile(path.join(project, 'project.yaml'), YAML.stringify(config));
    const refused = await cli('build', '--project', 'demo');
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain('S001: approved/locked slide changed');
    expect((await cli('build', '--project', 'demo', '--authorize', 'S001')).code).toBe(0);
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(project, 'output/presentation.en-US.pptx')));
    expect(await zip.file('ppt/slides/slide3.xml')!.async('string')).toContain('<p:grpSp>');
    expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('<p:timing>');
    expect((await cli('validate', '--project', 'demo')).code).toBe(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 120000);
