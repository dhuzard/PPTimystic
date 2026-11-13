import { z } from 'zod';

export const localeSchema = z.string().refine(s => {
  try { return Intl.getCanonicalLocales(s)[0] === s; } catch { return false; }
}, 'Use a canonical BCP 47 identifier, e.g. fr-FR or en-US');
export const layouts = ['title', 'statement', 'text-image', 'full-image', 'diagram', 'workflow', 'chart', 'comparison', 'conclusion'] as const;
export const localizedSchema = z.object({
  title: z.string().min(1), message: z.string().default(''), body: z.string().default(''),
  notes: z.string().default(''), caption: z.string().default(''), alt: z.string().default(''),
  fictionalNotice: z.string().optional(),
  source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  objects: z.record(z.string().regex(/^object-[0-9a-f-]{36}$/), z.object({ text: z.string().optional(), alt: z.string().optional() }).strict()).optional(),
  labels: z.array(z.string()).default([]), seriesNames: z.array(z.string()).default([]),
  review: z.enum(['draft', 'review', 'approved', 'locked']).default('draft')
}).strict();
// Explicit traceability metadata; these links do not assert scientific validity.
export const claimSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  field: z.enum(['title', 'message', 'body', 'caption']),
  source_ref: z.string().refine(value => Boolean(value.trim()), 'Source reference must not be blank'),
  excerpt: z.string().refine(value => Boolean(value.trim()), 'Source excerpt must not be blank'),
  locator: z.string().refine(value => Boolean(value.trim()), 'Locator must not be blank').optional()
}).strict();
export const visualObjectOverrideSchema = z.object({
  x: z.number().finite().optional(), y: z.number().finite().optional(),
  w: z.number().finite().positive().optional(), h: z.number().finite().min(0).optional(),
  hidden: z.boolean().optional(),
  style: z.object({ color: z.string().regex(/^[A-Fa-f0-9]{6}$/).optional(), fill: z.string().regex(/^[A-Fa-f0-9]{6}$/).optional(), fontSize: z.number().finite().min(1).max(120).optional(), bold: z.boolean().optional() }).strict().optional()
}).strict();
export type VisualObjectOverride = z.infer<typeof visualObjectOverrideSchema>;
export const customObjectSchema = z.object({
  id: z.string().regex(/^object-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  type: z.enum(['text', 'shape', 'image']),
  x: z.number().finite(), y: z.number().finite(), w: z.number().finite().positive(), h: z.number().finite().positive(),
  asset: z.string().min(1).optional(), accepted: z.boolean().optional(),
  style: visualObjectOverrideSchema.shape.style
}).strict().refine(o => o.type === 'image' ? Boolean(o.asset) : !o.asset && !o.accepted, 'Only images have an asset or acceptance, and images require an asset');
export const nativeTextRunSchema = z.object({
  paragraph: z.number().int().nonnegative(), run: z.number().int().nonnegative(),
  text: z.string().max(100_000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\r\n]/.test(value), 'Keep paragraph boundaries and valid XML text')
}).strict();
export const nativeTextSchema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  slidePart: z.string().regex(/^ppt\/slides\/slide\d+\.xml$/),
  objects: z.record(z.string().min(1).max(200), z.object({
    runs: z.array(nativeTextRunSchema).min(1), binding: z.enum(['title', 'message']).optional()
  }).strict())
}).strict();
export const slideSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  layout: z.enum(layouts), status: z.enum(['draft', 'review', 'approved', 'locked']).default('draft'),
  locked: z.boolean().default(false), evidence: z.enum(['established', 'interpretation', 'hypothesis', 'conceptual', 'missing']).default('missing'),
  source_refs: z.array(z.string()).default([]), citations: z.array(z.string()).default([]),
  claims: z.array(claimSchema).optional(),
  content: z.record(localeSchema, localizedSchema),
  native_text: nativeTextSchema.optional(),
  objects: z.array(customObjectSchema).optional(),
  visual_objects: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/), visualObjectOverrideSchema).optional(),
  visual: z.object({ asset: z.string().optional(), brief: z.string().default(''), accepted: z.boolean().default(false), decorative: z.boolean().optional() }).strict().optional(),
  chart: z.object({
    fictional: z.boolean().default(false), data_ref: z.string().optional(),
    series: z.array(z.object({ values: z.array(z.number().finite()).min(1) })).default([]),
    binding: z.object({
      source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      category_column: z.string().min(1), value_columns: z.array(z.string().min(1)).min(1),
      rows: z.array(z.number().int().min(2)).min(1)
    }).strict().optional()
  }).strict().optional()
}).strict();
export const deckSchema = z.object({ version: z.literal(1), slides: z.array(slideSchema).min(1) }).strict();
export const projectSchema = z.object({
  version: z.literal(1), title: z.string().min(1), source_locale: localeSchema,
  output_locales: z.array(localeSchema).min(1), theme: z.string().regex(/^[a-z-]+$/).default('editorial-minimal'),
  content: z.string().default('content/slides.yaml'), font: z.string().optional(),
  // Old projects remain compatible; newly created real projects set this to true.
  brief_required: z.boolean().default(false),
  glossary: z.array(z.string()).default([])
}).strict();
export const themeSchema = z.object({
  name: z.string(), background: z.string().regex(/^[A-Fa-f0-9]{6}$/),
  foreground: z.string().regex(/^[A-Fa-f0-9]{6}$/), secondary: z.string().regex(/^[A-Fa-f0-9]{6}$/),
  accent: z.string().regex(/^[A-Fa-f0-9]{6}$/), pale: z.string().regex(/^[A-Fa-f0-9]{6}$/),
  font: z.string(), heading: z.number().min(28).max(44), body: z.number().min(18).max(28),
  margin: z.number().min(0.5).max(0.9)
}).strict();
export type Slide = z.infer<typeof slideSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Localized = z.infer<typeof localizedSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type Deck = z.infer<typeof deckSchema>;
