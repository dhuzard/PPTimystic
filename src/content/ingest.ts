import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { parse } from 'csv-parse/sync';
import { atomicWrite, exists, hash, readYaml, safePath, stamp, writeYaml } from '../core/io.js';
import { deckSchema, type Deck } from '../core/model.js';

export type SourceRecord = { id: string; path: string; sha256: string; kind: string; extracted?: string; extracted_sha256?: string; error?: string };
const images = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];
async function files(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not imported: ${entry.name}`);
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(p)); else if (entry.isFile()) result.push(p);
  }
  return result;
}
export async function ingest(dir: string, input?: string) {
  const source = input ? path.resolve(input) : path.join(dir, 'inputs');
  const projectReal = await fs.realpath(dir);
  const sourceReal = await fs.realpath(source);
  if (input && sourceReal !== path.join(projectReal, 'inputs') && (sourceReal === projectReal || projectReal.startsWith(sourceReal + path.sep))) {
    throw new Error('Input folder cannot contain the project itself.');
  }
  const list = await files(source);
  const records: SourceRecord[] = [];
  await fs.mkdir(path.join(dir, 'inputs'), { recursive: true });
  for (const file of list) {
    const relative = path.relative(source, file);
    const destination = await safePath(dir, path.join('inputs', relative));
    const data = await fs.readFile(file);
    // Preserve existing inputs. Identical inputs can be re-ingested safely.
    if (path.resolve(file) !== destination) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try { await fs.writeFile(destination, data, { flag: 'wx' }); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (hash(await fs.readFile(destination)) !== hash(data)) throw new Error(`Input already exists with different contents: ${relative}`);
      }
    }
    const ext = path.extname(file).toLowerCase();
    const record: SourceRecord = { id: `SRC-${hash(Buffer.from(relative)).slice(0,12)}`, path: path.join('inputs', relative).replaceAll('\\', '/'), sha256: hash(data), kind: ext.slice(1) };
    try {
      let text: string | undefined;
      if (['.md', '.txt'].includes(ext)) text = data.toString('utf8');
      else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ buffer: data });
        text = result.value;
        if (result.messages.length) record.error = result.messages.map(m => m.message).join('; ');
      } else if (ext === '.pdf') {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(data) });
        try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
        if (text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim().length < 10) throw new Error('No usable text; scanned PDFs require local OCR.');
      } else if (ext === '.pptx') {
        const { importPptxScene } = await import('../session/pptx-native.js');
        const original = await importPptxScene(data).catch(error => { throw new Error('Unsupported or malformed PowerPoint source: '+(error as Error).message); });
        text = original.slides.map((slide, i) => [
          '## Original slide '+(i+1),
          ...slide.objects.map(o=>o.runs.map(run=>run.text).join(' ')).filter(Boolean)
        ].join('\n')).join('\n\n');
        if (!text.trim()) throw new Error('PowerPoint has no extractable text. Visual review is required.');
      } else if (ext === '.csv') {
        const rows = parse(data, { bom: true, columns: false, skip_empty_lines: true });
        text = JSON.stringify(rows, null, 2);
      } else if (images.includes(ext)) { /* Retained verbatim as an asset; no invented image interpretation. */ }
      else throw new Error('Unsupported extraction format. File retained; convert locally or ask an agent to extract it.');
      if (text !== undefined) {
        record.extracted = `content/extracted/${record.id}.txt`;
        record.extracted_sha256 = hash(text);
        await atomicWrite(await safePath(dir, record.extracted), text);
      }
    } catch (e) { record.error = (e as Error).message; }
    records.push(record);
  }
  // Keep a provenance history rather than replacing the previous ingestion record.
  await writeYaml(path.join(dir, `content/ingestion-${stamp()}.yaml`), { sources: records });
  const sourceIndex=await safePath(dir,'content/sources.yaml');
  const previous: SourceRecord[]=await exists(sourceIndex) ? (await readYaml(sourceIndex)).sources : [];
  const merged=new Map(previous.map(r=>[r.id,r]));
  for(const record of records) merged.set(record.id,record);
  await writeYaml(sourceIndex, { sources: [...merged.values()] });
  return records;
}

// Explicit opt-in: Markdown headings define slide order. No scientific summarization.
export async function deckFromMarkdown(dir: string, refs: SourceRecord[], locale: string): Promise<Deck | undefined> {
  const plans = refs.filter(r => r.kind === 'md' && r.extracted && !r.error);
  if (plans.length !== 1) return undefined;
  const plan = plans[0];
  const text = await fs.readFile(await safePath(dir, plan.extracted!), 'utf8');
  const sections = text.split(/^##\s+/m).slice(1);
  if (!sections.length) return undefined;
  return deckSchema.parse({ version: 1, slides: sections.map((s, index) => {
    const [title, ...body] = s.split(/\r?\n/);
    return { id: `S${String(index + 1).padStart(3, '0')}`, layout: 'statement', evidence: 'missing', source_refs: [plan.id],
      content: { [locale]: { title: title.trim(), body: body.join('\n').trim(), notes: 'Imported verbatim from supplied Markdown. Scientific claims require human review.' } } };
  }) });
}
