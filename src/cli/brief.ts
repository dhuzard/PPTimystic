import { confirm, input } from '@inquirer/prompts';
import type { Project } from '../core/model.js';
import { approveCreatorBrief, blankBrief, briefingSummary, creatorBriefStatus, readCreatorBrief, saveCreatorBrief } from '../core/brief.js';

const meaningful = (value: string): true | string =>
  value.trim().length >= 6 && !/^(unknown|tbd|todo|n\/a|not applicable|not specified|not provided|none)$/i.test(value.trim())
    ? true : 'Provide a meaningful answer (not a placeholder).';

function field(value: unknown): string { return typeof value === 'string' ? value : ''; }

/** The creator, not a slide-generation agent, reviews and explicitly approves the brief. */
export async function interviewCreator(dir: string, config: Project, fr: boolean): Promise<boolean> {
  const current = (await readCreatorBrief(dir) ?? blankBrief(config)) as ReturnType<typeof blankBrief>;
  const ask = async (en: string, french: string, initial: unknown) => input({
    message: fr ? french : en, default: field(initial), validate: meaningful,
  });
  console.log(fr ? '\n1/5 — Qui crée la présentation ?' : '\n1/5 — Who is creating the presentation?');
  const creator = {
    profile: await ask('Your role, background and relationship to the topic', 'Votre rôle, parcours et lien avec le sujet', current.creator?.profile),
    expertise: await ask('Your expertise and knowledge of the subject', 'Votre expertise et connaissance du sujet', current.creator?.expertise),
    working_preferences: await ask('How you want to work: style, level of detail and preferences', 'Votre manière de travailler : style, niveau de détail et préférences', current.creator?.working_preferences),
  };
  console.log(fr ? '\n2/5 — Pourquoi et pour qui ?' : '\n2/5 — Why and for whom?');
  const goal = {
    purpose: await ask('What should this presentation achieve?', 'Quel est le but de cette présentation ?', current.goal?.purpose),
    audience_action: await ask('What should the audience understand, decide or do afterward?', 'Que doit comprendre, décider ou faire le public après ?', current.goal?.audience_action),
    central_message: await ask('One essential message the audience should remember', 'Le message essentiel à retenir', current.goal?.central_message),
  };
  const audience = {
    description: await ask('Who is the target audience (roles, size, context)?', 'Quel est le public (profils, taille, contexte) ?', current.audience?.description),
    prior_knowledge: await ask('What does the audience already know?', 'Quelles connaissances le public possède-t-il déjà ?', current.audience?.prior_knowledge),
    needs_and_concerns: await ask('Audience interests, sensitivities, questions or accessibility needs', 'Attentes, sensibilités, questions ou besoins du public', current.audience?.needs_and_concerns),
  };
  console.log(fr ? '\n3/5 — Conditions de présentation' : '\n3/5 — Presentation conditions');
  const minutes = await input({
    message: fr ? 'Durée en minutes (1–480)' : 'Duration in minutes (1–480)',
    default: current.delivery?.duration_minutes ? String(current.delivery.duration_minutes) : '',
    validate: value => /^(?:[1-9]\d{0,2})$/.test(value) && Number(value) <= 480 ? true : 'Enter 1–480 minutes.',
  });
  const delivery = {
    format_and_setting: await ask('Setting, medium and delivery mode (talk, classroom, webinar, etc.)', 'Cadre, support et format (conférence, classe, webinaire, etc.)', current.delivery?.format_and_setting),
    duration_minutes: Number(minutes),
  };
  console.log(fr ? '\n4/5 — Contenu et fiabilité' : '\n4/5 — Content and evidence');
  const content = {
    scope_and_structure: await ask('Topics and structure to include; what must be prioritized?', 'Sujets, structure et priorités à inclure', current.content?.scope_and_structure),
    evidence_and_sources: await ask('Available references, figures and evidence (or explain what is missing)', 'Références, figures et preuves disponibles (ou manquantes)', current.content?.evidence_and_sources),
    uncertainties_and_exclusions: await ask('Claims to qualify, uncertainties and things to exclude', 'Points incertains, nuances et éléments à exclure', current.content?.uncertainties_and_exclusions),
  };
  console.log(fr ? '\n5/5 — Ton, visuels et contraintes' : '\n5/5 — Tone, visuals and constraints');
  const design = {
    tone: await ask('Preferred tone and amount of text/detail', 'Ton souhaité et densité du contenu', current.design?.tone),
    visual_preferences: await ask('Visual style, examples and design references', 'Style visuel, exemples et références graphiques', current.design?.visual_preferences),
  };
  const constraints = {
    source_locale: config.source_locale, output_locales: config.output_locales,
    accessibility_and_other: await ask('Accessibility, deadlines, branding and other constraints', 'Accessibilité, échéances, identité visuelle et autres contraintes', current.constraints?.accessibility_and_other),
  };
  const further_wishes = await input({
    message: fr ? 'Autres souhaits (facultatif)' : 'Any additional wishes (optional)',
    default: field(current.further_wishes),
  });
  const draft = { version: 1 as const, creator, goal, audience, delivery, content, design, constraints, further_wishes };
  // No approval is inherited when answers change.
  await saveCreatorBrief(dir, draft);
  console.log('\n' + briefingSummary(draft));
  await approveInteractively(dir, config, fr, draft);
  return true;
}

export async function approveInteractively(dir: string, config: Project, fr: boolean, draft?: unknown): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('Creator approval requires an interactive terminal; --yes never supplies consent.');
  const raw = draft ?? await readCreatorBrief(dir);
  console.log('\n' + briefingSummary(raw));
  const approved = await confirm({
    message: fr ? 'Confirmez-vous personnellement ce brief ?' : 'Do you personally approve this brief?',
    default: false,
  });
  if (!approved) throw new Error('Creator did not approve the brief; export remains blocked.');
  const approvedBy = await input({
    message: fr ? 'Nom de la personne qui approuve' : 'Name of the approving creator',
    validate: meaningful,
  });
  const complete = approveCreatorBrief(raw, config, approvedBy);
  await saveCreatorBrief(dir, complete);
  const status = await creatorBriefStatus(dir, config);
  if (!status.approved) throw new Error('Approval verification failed: ' + status.errors.join('; '));
  console.log(fr ? 'Brief validé et approuvé.' : 'Creator brief validated and approved.');
}
