import { describe, expect, test } from 'vitest';
import { approveCreatorBrief, blankBrief, briefDigest, checkCreatorBrief } from '../src/core/brief.js';
import { projectSchema } from '../src/core/model.js';

const config = projectSchema.parse({
  version: 1, title: 'Research seminar', source_locale: 'en-US',
  output_locales: ['en-US'], theme: 'editorial-minimal', brief_required: true,
});
function completeBrief() {
  return {
    ...blankBrief(config),
    creator: {
      profile: 'Researcher presenting their own work',
      expertise: 'Experienced neuroscientist with presentation experience',
      working_preferences: 'Prefers concise slides, cautious titles and editable visualizations',
    },
    goal: {
      purpose: 'Explain the current state of the research and obtain feedback',
      audience_action: 'Critically assess methods and identify collaboration opportunities',
      central_message: 'Research conclusions depend on transparent and reproducible evidence',
    },
    audience: {
      description: 'Mixed audience of neuroscientists and research engineers',
      prior_knowledge: 'Familiar with experiments but not the software architecture',
      needs_and_concerns: 'Needs legible charts, definitions of jargon and accurate uncertainty',
    },
    delivery: { format_and_setting: 'In-person scientific research seminar', duration_minutes: 25 },
    content: {
      scope_and_structure: 'Problem, approach, validated observations, limitations, next steps',
      evidence_and_sources: 'Local manuscript and source figures; do not invent missing results',
      uncertainties_and_exclusions: 'No causal claims without appropriate experimental support',
    },
    design: {
      tone: 'Technically precise and restrained, one central message per slide',
      visual_preferences: 'Minimal diagrams, restrained colors, editable charts and figures',
    },
    constraints: {
      source_locale: 'en-US', output_locales: ['en-US'],
      accessibility_and_other: 'High contrast and readable fonts, no identifying participant data',
    },
    further_wishes: 'Keep important methodological details in speaker notes',
  };
}

describe('creator onboarding gate', () => {
  test('real projects reject an empty draft and absent approval', () => {
    const blank = blankBrief(config);
    const initial = checkCreatorBrief(blank, config);
    expect(initial.required).toBe(true);
    expect(initial.approved).toBe(false);
    expect(initial.errors.some(error => error.includes('creator.profile'))).toBe(true);

    const filled = completeBrief();
    const status = checkCreatorBrief(filled, config);
    expect(status.approved).toBe(false);
    expect(status.errors.join(' ')).toContain('Creator approval');
  });

  test('approval fingerprints all substantive answers and detects later changes', () => {
    const filled = completeBrief();
    const approved = approveCreatorBrief(filled, config, 'Test Researcher');
    const ok = checkCreatorBrief(approved, config);
    expect(ok.approved).toBe(true);
    expect(approved.approval?.content_sha256).toBe(briefDigest(filled));
    const edited = {
      ...approved,
      goal: { ...approved.goal, central_message: 'A completely different message from the original creator brief' },
    };
    const invalid = checkCreatorBrief(edited, config);
    expect(invalid.approved).toBe(false);
    expect(invalid.errors.join(' ')).toContain('changed after approval');
  });

  test('language configuration changes require reapproval', () => {
    const approved = approveCreatorBrief(completeBrief(), config, 'Test Researcher');
    const changedConfig = projectSchema.parse({ ...config, output_locales: ['en-US', 'fr-FR'] });
    const status = checkCreatorBrief(approved, changedConfig);
    expect(status.approved).toBe(false);
    expect(status.errors.join(' ')).toContain('languages differ');
  });

  test('generic placeholders cannot satisfy required answers', () => {
    const draft = completeBrief();
    draft.creator.profile = 'Unknown';
    expect(() => approveCreatorBrief(draft, config, 'Test Researcher')).toThrow('creator.profile');
  });

  test('explicit demo and old projects remain compatible', () => {
    const demo = projectSchema.parse({ ...config, brief_required: false });
    expect(checkCreatorBrief(undefined, demo)).toEqual({ required: false, approved: true, errors: [] });
  });
});
