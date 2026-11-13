import { z } from 'zod';
import type { SlideScene } from '../core/scene.js';

export const roles = ['owner', 'editor', 'reviewer'] as const;
export type Role = typeof roles[number];
export interface Actor { id: string; name: string; role: Role }
const id = z.string().min(1).max(160);
export const operationSchema = z.object({
  slideId: id, locale: z.string().min(2).max(40), objectId: id.optional(),
  expectedRevision: z.number().int().nonnegative(),
  kind: z.enum(['text', 'native-text', 'geometry', 'style', 'image', 'add', 'delete', 'status', 'translation-review']),
  value: z.unknown(), authorize: z.array(id).max(100).default([]),
}).strict();
export type Operation = z.infer<typeof operationSchema>;
export const textUpdateSchema = z.object({
  slideId: id, locale: z.string().min(2).max(40), objectId: id,
  generation: id, update: z.string().min(1).max(1_400_000),
  authorize: z.array(id).max(100).default([]),
}).strict();
export const commentSchema = z.object({
  slideId: id, locale: z.string().min(2).max(40), objectId: id.optional(),
  message: z.string().trim().min(1).max(10000),
  category: z.enum(['content','layout','typography','illustration','translation','scientific-correction','global-theme']).default('content'),
  askAgent: z.boolean().default(false),
}).strict();
export interface Comment extends z.infer<typeof commentSchema> {
  id: string; actor: Actor; createdAt: string; resolved: boolean;
  replies: { id: string; actor: Actor; message: string; createdAt: string }[];
}
export interface AgentJob {
  id: string; commentId: string; slideId: string; locale: string; objectId?: string;
  message: string; actor: Actor; createdAt: string; baseRevision: number;
  status: 'queued' | 'running' | 'awaiting-agent' | 'proposed' | 'applied' | 'conflict' | 'failed';
  operations?: Operation[]; summary?: string; error?: string;
}
export interface Presence { actor: Actor; slideId?: string; objectId?: string; x?: number; y?: number; updatedAt: number }
export interface ObjectLock { key: string; actor: Actor; expiresAt: number }
export interface TextState { generation: string; update: string }
export interface HistoryEntry { id: string; actor: Actor; slideId: string; kind: string; createdAt: string; revision: number; undone?: boolean }
export interface ReferencePreview { image: string; status?: 'pending'|'current'|'failed'; revision?: number; error?: string; video?: { src:string; poster:string; x:number; y:number; w:number; h:number }; shapes?: {id:string;label:string;kind:'text'|'shape'|'image'|'video';x:number;y:number;w:number;h:number;nativeText?:{runs:import('./pptx-native.js').PptxRun[];editable:boolean;reason?:string}}[] }
export interface SessionSnapshot {
  project: string; title: string; locale: string; locales: string[]; sourceLocale: string;
  revision: number; actor: Actor;
  slides: { id: string; status: string; locked: boolean; review?: string; scene?: SlideScene; reference?: ReferencePreview; error?: string }[];
  comments: Comment[]; jobs: AgentJob[]; presence: Presence[]; locks: ObjectLock[];
  history: HistoryEntry[]; texts: Record<string, TextState>; agentConfigured: boolean;
  exportBlocked?: boolean;
  briefReady?: boolean;
  issues: { severity: string; code: string; message: string; slide?: string; locale?: string }[];
}
/** Yjs documents contain exactly one plain Y.Text named `text`. */
export const textKey = (slideId: string, locale: string, objectId: string) => `${slideId}|${locale}|${objectId}`;
