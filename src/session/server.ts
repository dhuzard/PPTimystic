import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { build } from 'esbuild';
import sharp from 'sharp';
import { z, ZodError } from 'zod';
import { atomicWrite, exists, hash, hashFile, projectDir, safePath } from '../core/io.js';
import { inspectArtifacts } from '../core/artifacts.js';
import { SessionError, SessionStore, fail } from './store.js';
import { AgentWorker, agentConfigSchema, type AgentConfig } from './agent.js';
import { NativePreviewWorker } from './native-preview-worker.js';
import type { Actor, Role } from './contracts.js';
import { clientHtml } from './client-page.js';

export interface SessionOptions { project: string; host?: string; port?: number; agentConfig?: AgentConfig }
const token = () => randomBytes(32).toString('base64url');
function sameToken(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
async function body(request: IncomingMessage, limit = 2_000_000) {
  const length = Number(request.headers['content-length'] ?? 0);
  if (length > limit) fail(413, 'Request is too large.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) fail(413, 'Request is too large.'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
async function jsonBody(request: IncomingMessage) {
  if (!request.headers['content-type']?.startsWith('application/json')) fail(415, 'Use application/json.');
  try { return JSON.parse((await body(request)).toString('utf8')); }
  catch (error) { if (error instanceof SessionError) throw error; fail(400, 'Malformed JSON.'); }
}
function json(response: ServerResponse, status: number, data: unknown) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }

async function acquireLease(project: string) {
  const dir = projectDir(project);
  const file = await safePath(dir, '.session/server.lock');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const nonce = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.writeFile(file, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx' }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = JSON.parse(await fs.readFile(file, 'utf8')) as { pid: number };
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (alive) fail(409, 'This project already has an active session server.');
      if (attempt === 1) throw new Error('Cannot acquire the project session lease.');
      await fs.unlink(file);
    }
  }
  return async () => {
    if (await exists(file)) { const saved = JSON.parse(await fs.readFile(file, 'utf8')); if (saved.nonce === nonce) await fs.unlink(file); }
  };
}

export async function startSession(options: SessionOptions) {
  const host = options.host ?? '127.0.0.1', port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(400, 'Port must be an integer from 0 to 65535.');
  const releaseLease = await acquireLease(options.project);
  const store = new SessionStore(options.project);
  let worker: AgentWorker | undefined;
  let nativeWorker: NativePreviewWorker | undefined;
  try {
    await store.initialize();
    if(await exists(await safePath(store.loaded.dir,'content/reference-preview.json'))) nativeWorker=new NativePreviewWorker(store);
    if (options.agentConfig) { const config = agentConfigSchema.parse(options.agentConfig); store.agentConfigured = true; worker = new AgentWorker(store, config); }
    else for (const job of store.metadata.jobs.filter(job => job.status === 'queued')) await store.updateJob(job.id, { status: 'awaiting-agent' });
  } catch (error) { await releaseLease(); throw error; }
  const ownerToken = token(), editorToken = token(), reviewerToken = token();
  const sessions = new Map<string, { actor: Actor; expiresAt: number }>();
  const streams = new Set<{ response: ServerResponse; actor: Actor; locale: string; expiresAt: number }>();
  const attempts = new Map<string, { count: number; start: number }>();
  const directory = path.dirname(fileURLToPath(import.meta.url));
  let script: Uint8Array, css: Buffer;
  try {
    const result = await build({ entryPoints: [path.join(directory, 'client.ts')], bundle: true, write: false, platform: 'browser', target: 'es2022', format: 'esm', minify: true, logLevel: 'silent' });
    script = result.outputFiles[0].contents;
    css = await fs.readFile(path.join(directory, 'client.css'));
  } catch (error) { await releaseLease(); throw error; }
  const allowedHosts = new Set(['localhost','127.0.0.1','[::1]',host]);
  for (const addresses of Object.values(os.networkInterfaces())) for (const address of addresses ?? []) allowedHosts.add(address.family === 'IPv6' ? `[${address.address}]` : address.address);
  let cookieName = 'pptimistic_session';
  let closing = false;
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  const broadcast = () => {
    if (closing || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      void store.run(async () => {
        const states = new Map<string, Awaited<ReturnType<SessionStore['snapshot']>>>();
        for (const stream of streams) {
          if (stream.response.destroyed) { streams.delete(stream); continue; }
          try {
            if (!states.has(stream.locale)) states.set(stream.locale, await store.snapshot(stream.actor, stream.locale));
            const state = { ...states.get(stream.locale)!, actor: stream.actor };
            if (stream.response.writableLength > 4_000_000) { stream.response.end(); streams.delete(stream); continue; }
            stream.response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
          } catch (error) { stream.response.write(`event: session-error\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`); }
        }
      }).catch(() => undefined);
      worker?.schedule();
    }, 75);
  };
  store.on('change', broadcast);
  if (worker) store.on('change', worker.schedule);
  if (nativeWorker) store.on('change', nativeWorker.schedule);

  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (!allowedHosts.has(url.hostname)) fail(403, 'Unrecognized Host header.');
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) fail(403, 'Cross-origin requests are not allowed.');
      if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(clientHtml); return; }
      if (request.method === 'GET' && url.pathname === '/client.js') { response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); response.end(script); return; }
      if (request.method === 'GET' && url.pathname === '/client.css') { response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); response.end(css); return; }
      if (request.method === 'POST' && url.pathname === '/api/join') {
        const address = request.socket.remoteAddress ?? '';
        let attempt = attempts.get(address);
        if (!attempt || attempt.start < Date.now() - 60000) { attempt = { count: 0, start: Date.now() }; attempts.set(address, attempt); }
        if (++attempt.count > 30) fail(429, 'Too many join attempts. Try again in a minute.');
        const input = z.object({ token: z.string().max(200), name: z.string().trim().min(1).max(60) }).strict().parse(await jsonBody(request));
        const role: Role | undefined = sameToken(input.token, ownerToken) ? 'owner' : sameToken(input.token, editorToken) ? 'editor' : sameToken(input.token, reviewerToken) ? 'reviewer' : undefined;
        if (!role) fail(401, 'Invalid session invitation.');
        const session = token(), actor: Actor = { id: crypto.randomUUID(), name: input.name, role };
        sessions.set(session, { actor, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
        response.setHeader('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        json(response, 200, { ok: true, actor, locale: store.loaded.config.source_locale }); return;
      }
      const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim());
      const session = cookies.find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const identity = session ? sessions.get(session) : undefined;
      if (!identity || identity.expiresAt < Date.now()) fail(401, 'Join this session using an invitation link.');
      const actor = identity.actor;
      const locale = url.searchParams.get('locale') ?? store.loaded.config.source_locale;
      if (request.method === 'GET' && url.pathname === '/api/state') { json(response, 200, await store.run(() => store.snapshot(actor, locale))); return; }
      if (request.method === 'GET' && url.pathname === '/api/readiness') {
        const gate = await import('../review/readiness.js');
        json(response, 200, await store.run(() => gate.readinessDetail(store.project))); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        const state = await store.run(() => store.snapshot(actor, locale));
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        const stream = { response, actor, locale, expiresAt: identity.expiresAt }; streams.add(stream);
        request.on('close', () => streams.delete(stream)); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/assets') {
        const file = await store.run(() => store.assetFile(url.searchParams.get('path') ?? ''));
        const data = await sharp(await fs.readFile(file), { limitInputPixels: 40_000_000 }).resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(data); return;
      }
      if (request.method === 'GET' && /^\/api\/reference\/[A-Za-z][A-Za-z0-9_-]*\/(image|video|poster)$/.test(url.pathname)) {
        const [, , , id, kind] = url.pathname.split('/');
        const file=await store.run(()=>store.referenceFile(id,kind as 'image'|'video'|'poster'));
        const data=await fs.readFile(file);
        const contentType=kind==='video'?'video/mp4':'image/png';
        const range=request.headers.range;
        if(range) {
          const match=/^bytes=(\d+)-(\d*)$/.exec(range);
          if(!match) {response.writeHead(416,{'Content-Range':`bytes */${data.length}`});response.end();return;}
          const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),data.length-1):data.length-1;
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=data.length) {response.writeHead(416,{'Content-Range':`bytes */${data.length}`});response.end();return;}
          response.writeHead(206,{'Content-Type':contentType,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${data.length}`,'Content-Length':end-start+1});response.end(data.subarray(start,end+1));return;
        }
        response.writeHead(200,{'Content-Type':contentType,'Accept-Ranges':'bytes','Content-Length':data.length});response.end(data);return;
      }
      if (request.method === 'GET' && url.pathname === '/api/exports') {
        const name = url.searchParams.get('file') ?? '';
        if (!/^presentation\.[A-Za-z0-9-]+\.pptx$/.test(name)) fail(404, 'Unknown export.');
        const file = await safePath(store.loaded.dir, `output/${name}`);
        const baseline = await safePath(store.loaded.dir, 'output/build-state.json');
        if (!await exists(file) || !await exists(baseline)) fail(404, 'Build this export first.');
        const state = JSON.parse(await fs.readFile(baseline, 'utf8'));
        const language = name.slice('presentation.'.length, -'.pptx'.length);
        if (state.files[language] !== await hashFile(file)) fail(409, 'This export was modified outside PPTimistic.');
        const [artifact] = await store.run(() => inspectArtifacts(store.project, language));
        if (artifact.status !== 'current') fail(409, 'This export is older than the current source. Build again before downloading.');
        const gate = await import('../review/readiness.js');
        try { await gate.assertReadyForDelivery(store.project); }
        catch (error) { fail(409, (error as Error).message); }
        response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Content-Disposition': `attachment; filename="${name}"` }); response.end(await fs.readFile(file)); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/previews') {
        if (!store.loaded.config.output_locales.includes(locale)) fail(404, 'Unknown language.');
        const name = url.searchParams.get('file') ?? 'contact-sheet.png';
        if (!/^(contact-sheet|slide-?\d+)\.png$/.test(name)) fail(404, 'Unknown preview.');
        const latest = await safePath(store.loaded.dir, `output/previews/${locale}/latest.json`);
        if (!await exists(latest)) fail(404, 'Render this presentation first.');
        const { folder } = JSON.parse(await fs.readFile(latest, 'utf8'));
        const previewRoot = await safePath(store.loaded.dir, `output/previews/${locale}`);
        const file = await safePath(previewRoot, path.relative(previewRoot, path.join(folder, name)));
        const manifest = JSON.parse(await fs.readFile(await safePath(previewRoot, path.relative(previewRoot, path.join(folder, 'render.json'))), 'utf8'));
        const [artifact] = await store.run(() => inspectArtifacts(store.project, locale));
        if (artifact.status !== 'current' || manifest.pptxSha256 !== artifact.sha256) fail(409, 'This preview is older than the current presentation. Render again.');
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(await fs.readFile(file)); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/readiness/finding') {
        if (actor.role !== 'owner') fail(403, 'Only the session owner can decide on scientific review findings.');
        const input = z.object({
          id: z.string().regex(/^REV-\d{3,}$/),
          decision: z.enum(['accept', 'reject', 'defer', 'discuss', 'request-alternative']),
          note: z.string().trim().max(2000).optional()
        }).strict().parse(await jsonBody(request));
        if (input.decision === 'request-alternative' && !input.note)
          fail(400, 'Explain the alternative you want.');
        const review = await import('../review/workflow.js');
        const updated = await store.run(() => review.recordDecision(store.project, [input.id],
          input.decision, actor.name, { note: input.note, authorize: [] }));
        json(response, 200, { ok: true, result: updated }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/readiness/approve') {
        if (actor.role !== 'owner') fail(403, 'Only the session owner can sign off scientific readiness.');
        const input = z.object({
          revision: z.string().regex(/^[a-f0-9]{64}$/),
          record_sha256: z.string().regex(/^[a-f0-9]{64}$/),
          acknowledgement: z.object({
            scientific_positioning_read: z.literal(true),
            methods_and_limitations_understood: z.literal(true),
            expert_questions_reviewed: z.literal(true),
            unresolved_findings_reviewed: z.literal(true)
          }).strict(),
          note: z.string().max(2000).optional()
        }).strict().parse(await jsonBody(request));
        const gate = await import('../review/readiness.js');
        const decision = await store.run(() => gate.approveReadiness(store.project, { ...input, approved_by: actor.name }));
        json(response, 200, { ok: true, status: decision }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/readiness/override') {
        if (actor.role !== 'owner') fail(403, 'Only the session owner can accept an explicit scientific readiness risk.');
        const input = z.object({
          revision: z.string().regex(/^[a-f0-9]{64}$/),
          record_sha256: z.string().regex(/^[a-f0-9]{64}$/),
          reason: z.string().trim().min(20).max(2000),
          confirmed: z.literal(true)
        }).strict().parse(await jsonBody(request));
        const gate = await import('../review/readiness.js');
        const decision = await store.run(async () => {
          const before = await gate.readinessStatus(store.project);
          if (before.revision !== input.revision || before.record_sha256 !== input.record_sha256)
            fail(409, 'This scientific assessment changed. Read the latest report before overriding.');
          return gate.overrideReadiness(store.project, actor.name, input.reason, true);
        });
        json(response, 200, { ok: true, status: decision }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/uploads') {
        if (actor.role === 'reviewer') fail(403, 'Reviewers cannot upload images.');
        if (!['image/png','image/jpeg','image/webp'].includes(request.headers['content-type'] ?? '')) fail(415, 'Upload PNG, JPEG, or WebP.');
        const bytes = await body(request, 12_000_000);
        let image: Buffer;
        try {
          const decoded=sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
          const metadata=await decoded.metadata();
          if (!['png','jpeg','webp'].includes(metadata.format??'')) fail(400, 'The uploaded file must contain PNG, JPEG, or WebP image data.');
          image = await decoded.rotate().png().toBuffer();
        } catch (error) { if(error instanceof SessionError)throw error;fail(400, 'This image could not be decoded, or exceeds the pixel limit.'); }
        const asset = `assets/session/${hash(image)}.png`;
        await store.run(async () => {
          const file = await safePath(store.loaded.dir, asset);
          if (await exists(file)) { if (await hashFile(file) !== hash(image)) fail(409, 'A retained image changed outside the session. It will not be overwritten.'); }
          else await atomicWrite(file, image);
          await atomicWrite(await safePath(store.loaded.dir, `${asset}.${crypto.randomUUID()}.provenance.json`), JSON.stringify({ provider: 'user-upload', date: new Date().toISOString(), actor, originalSha256: hash(bytes), sha256: hash(image), transform: 'EXIF orientation normalized; decoded to PNG' }, null, 2));
        });
        json(response, 200, { ok: true, asset }); return;
      }
      if (request.method !== 'POST') fail(404, 'Unknown route.');
      const input = await jsonBody(request);
      const result = await store.run(async () => {
        let extra: Record<string, unknown> = {};
        if (url.pathname === '/api/operations') await store.operate(actor, input);
        else if (url.pathname === '/api/text') await store.text(actor, input);
        else if (url.pathname === '/api/comments') extra = { comment: await store.comment(actor, input) };
        else if (/^\/api\/comments\/[^/]+\/(reply|resolve)$/.test(url.pathname)) { const parts = url.pathname.split('/'); await store.thread(actor, parts[3], parts[4], input); }
        else if (url.pathname === '/api/presence') { store.setPresence(actor, input); return { ok: true }; }
        else if (url.pathname === '/api/locks') { store.lock(actor, input); return { ok: true }; }
        else if (url.pathname === '/api/undo') await store.undo(actor, input);
        else if (url.pathname === '/api/export') extra = await store.export(actor, input);
        else if (/^\/api\/jobs\/[^/]+\/(apply|retry|propose)$/.test(url.pathname)) {
          const parts = url.pathname.split('/');
          if (parts[4] === 'apply') await store.applyJob(actor, parts[3], input);
          if (parts[4] === 'retry') await store.retryJob(actor, parts[3]);
          if (parts[4] === 'propose') await store.propose(actor, parts[3], input);
        } else fail(404, 'Unknown route.');
        const responseLocale = typeof input?.locale === 'string' ? input.locale : locale;
        return { ok: true, ...extra, state: await store.snapshot(actor, responseLocale) };
      });
      json(response, 200, result);
    })().catch(error => {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof SessionError ? error.status : error instanceof ZodError ? 400 : 500;
      json(response, status, { error: error instanceof ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : (error as Error).message });
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); }); }
  catch (error) {
    store.dispose(); await releaseLease();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use on ${host}. Choose another port or use --port 0 to select one automatically.`);
    throw error;
  }
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  cookieName = `pptimistic_${actualPort}`;
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${displayHost}:${actualPort}`;
  const heartbeat = setInterval(() => {
    for (const stream of streams) {
      if(stream.expiresAt<Date.now()) {stream.response.end();streams.delete(stream);}
      else stream.response.write(': heartbeat\n\n');
    }
    for (const [key, identity] of sessions) if (identity.expiresAt < Date.now()) sessions.delete(key);
  }, 15000);
  const watcher = setInterval(() => { void store.run(() => store.refresh()).catch(() => undefined); }, 1000);
  worker?.schedule();
  nativeWorker?.schedule();
  const close = async () => {
    if (closing) return; closing = true;
    clearInterval(heartbeat); clearInterval(watcher); clearTimeout(broadcastTimer); await worker?.stop(); await nativeWorker?.stop();
    for (const stream of streams) stream.response.end(); streams.clear();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await store.run(async () => { store.dispose(); await releaseLease(); });
  };
  return { server, url, ownerToken, editorToken, reviewerToken, close, store };
}
