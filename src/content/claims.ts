import fs from 'node:fs/promises';
import type { Claim, Slide } from '../core/model.js';
import { deckSchema } from '../core/model.js';
import { atomicWrite, hash, hashFile, loadProject, readYaml, safePath, stamp, writeYaml } from '../core/io.js';
import { assertNoActiveSession } from '../session/lease.js';

export interface ClaimSource { sha256: string; extracted_sha256?: string }
/** Binds human verification to wording, classification, qualifications and source provenance. */
export function claimFingerprint(slide: Slide, claim: Claim, source?: ClaimSource) {
  const { human_verification: _verification, ...content } = claim;
  return hash(JSON.stringify({ claim: content, text: Object.fromEntries(Object.entries(slide.content).sort(([a], [b]) => a.localeCompare(b))
    .map(([locale, c]) => [locale, c[claim.field]])), source: source ? { sha256: source.sha256, extracted_sha256: source.extracted_sha256 } : null }));
}
export function claimVerificationState(slide: Slide, claim: Claim, source?: ClaimSource, sourceCurrent = true) {
  return !claim.human_verification ? 'not-verified' : sourceCurrent && claim.human_verification.claim_sha256 === claimFingerprint(slide, claim, source) ? 'current' : 'stale';
}

/** CLI calls this only after interactive personal confirmation. An agent must never call it for itself. */
export async function recordHumanClaimVerification(project: string, slideId: string, claimId: string, by: string, source: ClaimSource, expectedFingerprint: string, authorize: string[] = []) {
  await assertNoActiveSession(project);
  if (!by.trim()) throw new Error('Human verification needs the person who verified the claim.');
  const { dir, config, deck } = await loadProject(project);
  const slide = deck.slides.find(s => s.id === slideId), claim = slide?.claims?.find(c => c.id === claimId);
  if (!slide || !claim) throw new Error(`Unknown claim ${slideId}/${claimId}.`);
  if (!claim.claim_type) throw new Error('Classify the claim before human verification.');
  const sources = (await readYaml(await safePath(dir, 'content/sources.yaml'))).sources as { id: string; path: string; sha256: string; extracted?: string; extracted_sha256?: string }[];
  const currentSource = sources.find(s => s.id === claim.source_ref);
  if (!currentSource?.extracted || !currentSource.extracted_sha256 || currentSource.sha256 !== source.sha256 || currentSource.extracted_sha256 !== source.extracted_sha256
    || await hashFile(await safePath(dir, currentSource.path)) !== currentSource.sha256
    || await hashFile(await safePath(dir, currentSource.extracted)) !== currentSource.extracted_sha256)
    throw new Error('Source provenance changed during personal verification. Read and verify the current source again.');
  if (claimFingerprint(slide, claim, currentSource) !== expectedFingerprint) throw new Error('The claim changed during personal verification. Read and verify the current claim again.');
  if ((slide.locked || ['approved', 'locked'].includes(slide.status) || Object.values(slide.content).some(c => ['approved', 'locked'].includes(c.review))) && !authorize.includes(slideId))
    throw new Error(`${slideId} is approved/locked; explicit --authorize ${slideId} is required.`);
  const file = await safePath(dir, config.content);
  const at = `${stamp()}-${crypto.randomUUID().slice(0, 8)}`, before = await fs.readFile(file);
  claim.human_verification = { verified_by: by.trim(), verified_at: new Date().toISOString(), claim_sha256: claimFingerprint(slide, claim, source) };
  deckSchema.parse(deck);
  await atomicWrite(await safePath(dir, `feedback/${at}.claim-verification.backup.yaml`), before);
  await writeYaml(file, deck);
  await writeYaml(await safePath(dir, `feedback/${at}.claim-verification.yaml`), { slide: slideId, claim: claimId, category: 'scientific-correction',
    message: 'Human claim verification recorded', authorized: authorize, ...claim.human_verification });
  return { slide: slideId, claim: claimId, ...claim.human_verification };
}
