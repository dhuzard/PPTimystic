import PptxGenJS from 'pptxgenjs';
import sharp from 'sharp';
import { safePath } from './io.js';
import { composeSlide, WIDTH, HEIGHT, type SlideGeometry } from '../layouts/index.js';
import type { Slide, Localized, Theme, ProjectAnimations } from './model.js';
import { customObjectUnits, planSlideAnimation } from '../layouts/animations.js';

export type SceneBinding = { field: 'title'|'message'|'body'|'caption'|'labels'; index?: number } | { field: 'visual.asset' } | { field: 'objects'; id: string; property: 'text'|'alt' };
export type SceneObject = {
  id: string; role: string; type: 'text'|'shape'|'image'|'connector'|'chart';
  x: number; y: number; w: number; h: number;
  text?: string; binding?: SceneBinding; data?: unknown; shape?: string; missingTranslation?: boolean; imageAspectRatio?: number;
  options: Record<string, any>;
};
export type SlideScene = {
  id: string; locale: string; width: number; height: number; background: string;
  notes: string; objects: SceneObject[]; geometry: SlideGeometry;
};

function bindingFor(role: string, model: Slide, c: Localized): SceneBinding | undefined {
  if (role === 'illustration') return { field: 'visual.asset' };
  if (role === 'title' || role === 'message' || role === 'body') return { field: role };
  if (role === 'caption') return { field: model.layout === 'full-image' && !c.caption ? 'message' : 'caption' };
  const node = /^node-(\d+)$/.exec(role);
  const heading = /^comparison-heading-(\d+)$/.exec(role);
  if (node || heading) return { field: 'labels', index: Number((node ?? heading)![1]) };
  const comparison = /^comparison-body-(\d+)$/.exec(role);
  if (comparison) return { field: comparison[1] === '0' ? 'message' : 'body' };
  return undefined;
}

/** Build the same native-object composition used for PowerPoint without modifying source content. */
export async function buildSlideScene(model: Slide, c: Localized, theme: Theme, locale: string, dir: string, index: number, options: { allowMissingTranslations?: boolean; animations?: ProjectAnimations } = {}): Promise<SlideScene> {
  const objects: SceneObject[] = [];
  let notes = '';
  const add = (type: SceneObject['type'], options: Record<string, any>, data?: unknown, shape?: string) => {
    const name = String(options.objectName ?? '');
    const role = name.startsWith(`${model.id}:`) ? name.slice(model.id.length + 1) : name;
    if (!role) throw new Error(`Scene object on ${model.id} lacks a stable role`);
    if (objects.some(object => object.role === role)) throw new Error(`Duplicate scene role ${role} on ${model.id}`);
    const override = model.visual_objects?.[role];
    if (override?.hidden) {
      if (!model.objects?.some(object => object.id === role)) throw new Error(`Cannot hide source object ${role} on ${model.id}`);
      return;
    }
    const updated = { ...options };
    for (const key of ['x','y','w','h'] as const) if (override?.[key] !== undefined) updated[key] = override[key];
    const style = override?.style;
    if (style?.color !== undefined) {
      if (type === 'connector' || type === 'shape') updated.line = { ...updated.line, color: style.color };
      else if (type === 'chart') updated.chartColors = [style.color,...(updated.chartColors??[]).slice(1)];
      else updated.color = style.color;
    }
    if (style?.fill !== undefined) {
      if (type === 'chart') {
        updated.chartArea = {...updated.chartArea,fill:{color:style.fill}};
        updated.plotArea = {...updated.plotArea,fill:{color:style.fill}};
      } else updated.fill = { ...updated.fill, color: style.fill };
    }
    if (style?.fontSize !== undefined) updated.fontSize = style.fontSize;
    if (style?.bold !== undefined) updated.bold = style.bold;
    objects.push({ id: `${model.id}:${role}`, role, type, x: Number(updated.x), y: Number(updated.y), w: Number(updated.w), h: Number(updated.h),
      ...(type === 'text' ? { text: String(data) } : {}), ...(bindingFor(role,model,c) ? { binding: bindingFor(role,model,c) } : {}),
      ...(type === 'chart' ? { data } : {}), ...(shape ? { shape } : {}), options: updated });
  };
  const native = new PptxGenJS();
  const fakeSlide = {
    background: {},
    addText: (value: string, options: Record<string, any>) => add('text',options,value),
    addShape: (shape: string, options: Record<string, any>) => add(shape === native.ShapeType.line ? 'connector' : 'shape',options,undefined,shape),
    addImage: (options: Record<string, any>) => add('image',options),
    addChart: (shape: string, data: unknown, options: Record<string, any>) => add('chart',options,data,shape),
    addNotes: (value: string) => { notes = value; }
  };
  const fake = { addSlide: () => fakeSlide, ShapeType: native.ShapeType, ChartType: native.ChartType } as unknown as PptxGenJS;
  const geometry = await composeSlide(fake,model,c,theme,locale,dir,index);
  for (const custom of model.objects ?? []) {
    if (objects.some(object => object.role === custom.id)) throw new Error(`Duplicate scene role ${custom.id} on ${model.id}`);
    const localized = c.objects?.[custom.id];
    const base = { x:custom.x, y:custom.y, w:custom.w, h:custom.h, objectName:`${model.id}:${custom.id}` };
    if (custom.type === 'text') {
      if (!localized?.text && !options.allowMissingTranslations) throw new Error(`Missing ${locale} text for ${custom.id}`);
      add('text',{...base,fontFace:theme.font,fontSize:custom.style?.fontSize ?? theme.body,color:custom.style?.color ?? theme.foreground,bold:custom.style?.bold ?? false,...(custom.style?.fill ? {fill:{color:custom.style.fill}} : {}),margin:0,lang:locale},localized?.text ?? '');
    } else if (custom.type === 'shape') {
      add('shape',{...base,fill:{color:custom.style?.fill ?? theme.pale},line:{color:custom.style?.color ?? theme.pale}},undefined,native.ShapeType.rect);
    } else {
      if (!localized?.alt && !options.allowMissingTranslations) throw new Error(`Missing ${locale} alt text for ${custom.id}`);
      const file = await safePath(dir,custom.asset!);
      const buffer = await sharp(file).resize({width:1600,height:1200,fit:'inside'}).png().toBuffer();
      add('image',{...base,data:`image/png;base64,${buffer.toString('base64')}`,altText:localized?.alt ?? ''});
    }
    const object = objects.find(item => item.role === custom.id);
    if (object) {
      if ((custom.type === 'text' && !localized?.text) || (custom.type === 'image' && !localized?.alt)) object.missingTranslation = true;
      if (custom.type === 'text') object.binding = {field:'objects',id:custom.id,property:'text'};
      if (custom.type === 'image') object.binding = {field:'objects',id:custom.id,property:'alt'};
      geometry.boxes.push({ x:object.x,y:object.y,w:object.w,h:object.h,role:custom.id,...(object.type === 'text' ? {text:object.text,font:object.options.fontSize} : {}) });
      geometry.accessibility?.push({key:object.id,name:`${object.id}${localized?.text ? ` | ${localized.text.slice(0,100)}` : ''}`,...(custom.type === 'shape' ? {decorative:true} : {}),...(custom.type === 'image' ? {description:localized?.alt} : {})});
    }
  }
  geometry.boxes = geometry.boxes.filter(box => !model.visual_objects?.[box.role]?.hidden).map(box => {
    const o = model.visual_objects?.[box.role];
    return o ? { ...box, x: o.x ?? box.x, y: o.y ?? box.y, w: o.w ?? box.w, h: o.h ?? box.h, font: o.style?.fontSize ?? box.font } : box;
  });
  if (geometry.accessibility) geometry.accessibility = geometry.accessibility.filter(item => objects.some(object => object.id === item.key));
  const customIds = new Set((model.objects ?? []).map(object => object.id));
  geometry.units = [...(geometry.units ?? []), ...customObjectUnits(objects.filter(object => customIds.has(object.role)))];
  const animation = planSlideAnimation(model, options.animations, objects, geometry.units);
  if (animation) geometry.animation = animation;
  for (const object of objects) if (object.type==='image') {
    const data=String(object.options.data);
    const image=await sharp(Buffer.from(data.slice(data.indexOf(',')+1),'base64')).metadata();
    object.imageAspectRatio=image.width!/image.height!;
  }
  return { id:model.id, locale, width:WIDTH, height:HEIGHT, background:theme.background, notes, objects, geometry };
}

/** Emit scene items as editable PowerPoint objects. */
export function renderSlideScene(pptx: PptxGenJS, scene: SlideScene): void {
  const slide = pptx.addSlide();
  slide.background = {color: scene.background};
  slide.addNotes(scene.notes);
  for (const object of scene.objects) {
    if (object.type === 'text') slide.addText(object.text!,object.options);
    else if (object.type === 'image') {
      const ratio=object.imageAspectRatio??object.w/object.h;
      const height=Math.min(object.h,object.w/ratio),width=height*ratio;
      slide.addImage({...object.options,x:object.x+(object.w-width)/2,y:object.y+(object.h-height)/2,w:width,h:height} as Parameters<typeof slide.addImage>[0]);
    }
    else if (object.type === 'chart') slide.addChart(object.shape as PptxGenJS.CHART_TYPE,object.data as PptxGenJS.IChartOpts[],object.options);
    else slide.addShape(object.shape as PptxGenJS.ShapeType,object.options);
  }
}
