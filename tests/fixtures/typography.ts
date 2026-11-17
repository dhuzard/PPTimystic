import { layouts, slideSchema, type Slide } from '../../src/core/model.js';

// Fictional, public text for testing composition and translation reflow only.
const copy = {
  'en-US': { title:'A clear message invites discussion', message:'A practical observation adds context.', body:'A longer explanation connects the example to a careful discussion while leaving space around the text.', caption:'Fictional example values for a presentation layout check.', alt:'Fictional chart with three example categories, showing values 12, 19 and 15.', labels:['First example','Second example','Third example'], seriesNames:['Fictional values'] },
  'fr-FR': { title:'Un message clair invite à discuter', message:'Une observation pratique précise le contexte.', body:'Une explication plus longue relie cet exemple à une discussion attentive tout en laissant de l’espace autour du texte.', caption:'Valeurs fictives utilisées pour vérifier la mise en page.', alt:'Graphique fictif à trois catégories présentant les valeurs 12, 19 et 15.', labels:['Premier exemple','Deuxième exemple','Troisième exemple'], seriesNames:['Valeurs fictives'] },
  'it-IT': { fictionalNotice:'Dati fittizi — nessuna inferenza scientifica.', title:'Un messaggio chiaro invita al dialogo', message:'Un’osservazione pratica precisa il contesto.', body:'Una spiegazione più lunga collega questo esempio a una discussione attenta lasciando spazio intorno al testo.', caption:'Valori fittizi usati per verificare l’impaginazione.', alt:'Grafico fittizio con tre categorie e valori 12, 19 e 15.', labels:['Primo esempio','Secondo esempio','Terzo esempio'], seriesNames:['Valori fittizi'] }
} as const;
export const fixtureLocales = ['en-US','fr-FR','it-IT'] as const;
export const fixtureThemes = ['editorial-minimal','illustrated-minimal','scientific-technical','ink-watercolor'] as const;
export function typographyFixture(): Slide[] {
  return layouts.map((layout,index)=>slideSchema.parse({
    id:`QA${String(index+1).padStart(2,'0')}`,layout,evidence:'conceptual',
    content:Object.fromEntries(fixtureLocales.map(locale=>[locale,{...copy[locale],notes:copy[locale].body}])),
    ...(layout==='chart'?{chart:{fictional:true,series:[{values:[12,19,15]}]}}:{})
  }));
}

