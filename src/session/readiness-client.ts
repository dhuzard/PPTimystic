/** Scientific readiness cockpit for the existing authenticated browser studio.
 * The server owns review authority and revision-bound sign-off; this UI never
 * calls an agent's scientific judgment an independently verified fact.
 */
export type ReadinessView = {
  status: {
    required: boolean; status: string; can_deliver: boolean;
    revision?: string; record_sha256?: string; verdict?: string;
    blockers: string[]; risks: string[]; unresolved_high_priority: string[];
    human_approval?: { approved_by: string; approved_at: string; note: string };
    override?: { by: string; reason: string; at: string };
  };
  record?: {
    reviewer: { name: string; model: string; uninspected_material: string };
    contribution_in_one_sentence: string; what_is_not_demonstrated: string;
    intended_audience: string;
    checks: Record<string, { status: string; assessment: string; evidence_or_gap: string; presenter_action: string }>;
    alternatives: { approach: string; relevance: string; comparison: string; evidence_or_gap: string }[];
    capabilities: { claim: string; status: string; evidence_or_limit: string }[];
    expert_questions: { question: string; answer_status: string; defensible_answer_or_gap: string }[];
  };
  findings: { id: string; title: string; severity: string; status: string; slide_ids: string[];
    observation: string; rationale: string; recommendation: string; basis: string; evidence_status: string }[];
  questions: { question: string; why_likely: string; difficulty: string; answer_basis: string; answer_notes?: string }[];
};

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]!));
const labels: Record<string, string> = {
  problem_and_contribution: 'Problem and scientific contribution',
  methodological_landscape: 'Positioning against existing methods',
  actual_mechanism: 'What is actually implemented',
  evidence_and_limitations: 'Evidence, benchmarks and limitations',
  narrative_value: 'Distinct scientific value, not repetition',
  expert_audience_readiness: 'Readiness for expert questions'
};
export const readinessLabel = (code: string) => ({
  'not-required':'Demo', 'not-reviewed':'Review required', stale:'Review outdated',
  'not-ready':'NOT READY', 'ready-with-warnings':'Ready with warnings',
  ready:'Ready', overridden:'Risks overridden',
  'awaiting-human-approval':'Your sign-off required'
}[code] ?? code);

async function jsonRequest(path: string, payload?: unknown) {
  const response = await fetch(path, {
    method: payload===undefined ? 'GET' : 'POST',
    credentials:'same-origin',
    headers: payload===undefined ? undefined : {'Content-Type':'application/json'},
    body:payload===undefined ? undefined : JSON.stringify(payload)
  });
  const result = await response.json();
  if(!response.ok) throw new Error(result.error ?? 'Review request failed.');
  return result;
}
export const fetchReadiness = async (): Promise<ReadinessView> => jsonRequest('/api/readiness');

const para = (value: string) => '<p>' + escape(value) + '</p>';
const detail = (value: string, heading: string) => '<p class="rd-detail"><b>' + escape(heading) + '</b> ' + escape(value) + '</p>';
function reviewMarkup(view: ReadinessView, isOwner: boolean): string {
  const { status, record, findings } = view;
  const risks = [...status.blockers, ...status.risks];
  const risksHtml = risks.length ? '<section class="rd-alert" role="alert"><h2>Delivery requirements</h2><ul>' +
    risks.map(x=>'<li>'+escape(x)+'</li>').join('') + '</ul></section>' : '';
  const cards = record ? Object.keys(labels).map(key=>{
    const item = record.checks[key];
    if(!item)return '';
    return '<article class="rd-check"><header><h3>'+escape(labels[key])+'</h3><strong class="rd-'+escape(item.status)+'">'+escape(item.status.toUpperCase())+'</strong></header>' +
      para(item.assessment)+detail(item.evidence_or_gap,'Evidence or missing information:')+
      detail(item.presenter_action,'Presenter action:')+'</article>';
  }).join('') : '';
  const findingCards = findings.map(f=>{
    const canDecide = isOwner && ['proposed','discussing','blocked','unresolved','accepted','deferred','stalled'].includes(f.status);
    const decisions=canDecide?'<label>Decision note<textarea data-rd-note="'+escape(f.id)+'" rows="2" maxlength="2000" placeholder="Optional clarification; required when asking for an alternative"></textarea></label><div class="rd-decisions">'+
      ['accept','reject','defer','request-alternative'].map(decision=>'<button type="button" data-rd-finding="'+escape(f.id)+'" data-rd-decision="'+decision+'">'+escape(decision.replaceAll('-',' '))+'</button>').join('')+'</div>':'';
    return '<details class="rd-finding" '+(['critical','major'].includes(f.severity)?'open':'')+'><summary><strong>'+escape(f.id+' · '+f.severity.toUpperCase())+'</strong> '+
      escape(f.title)+' <small>'+escape(f.status)+' · '+escape(f.slide_ids.join(', ')||'deck')+'</small></summary>'+
      para(f.observation)+detail(f.rationale,'Why it matters:')+detail(f.recommendation,'Proposed correction:')+
      detail(f.basis+' · '+f.evidence_status,'Review basis:')+
      (f.slide_ids.length?'<button type="button" data-rd-slide="'+escape(f.slide_ids[0])+'">Open slide and comments</button>':'')+
      decisions+'</details>';
  }).join('');
  const alt = (record?.alternatives??[]).map(a=>
    '<div class="rd-finding"><strong>'+escape(a.approach)+'</strong> <small>'+escape(a.relevance)+'</small>'+
    para(a.comparison)+detail(a.evidence_or_gap,'Evidence or gap:')+'</div>').join('');
  const actual = (record?.capabilities??[]).map(a=>
    '<div class="rd-finding"><strong>'+escape(a.status.toUpperCase())+'</strong> '+escape(a.claim)+para(a.evidence_or_limit)+'</div>').join('');
  const qa = (record?.expert_questions??[]).map(q=>
    '<div class="rd-finding"><strong>Question: '+escape(q.question)+'</strong>'+
      detail(q.defensible_answer_or_gap,'Answer ('+q.answer_status+'):')+'</div>').join('');
  const approved = status.human_approval ? '<section class="rd-approved"><h2>Human sign-off recorded</h2>' +
    '<p>'+escape(status.human_approval.approved_by)+' approved the reviewed revision on '+
    escape(status.human_approval.approved_at)+'. Changing the deck invalidates this approval.</p></section>' : '';
  const override = isOwner && record && status.risks.length>0 && !status.override && status.blockers.length===0
    ? '<section class="rd-override"><h2>NOT READY — explicit risk acceptance</h2>'+
      '<p>Correct the issues and obtain a new assessment where possible. To proceed despite the remaining scientific risks, provide a reason. This is not proof of scientific correctness.</p>'+
      '<form id="rd-override"><label>Reason for proceeding<textarea name="reason" minlength="20" maxlength="2000" rows="3" required></textarea></label>'+
      '<label class="rd-checkbox"><input type="checkbox" name="confirmed" required> I understand and explicitly accept the unresolved scientific risks.</label>'+
      '<button class="rd-danger" type="submit">Record an explicit risk override</button></form></section>' : '';
  const approval = isOwner && record && status.status==='awaiting-human-approval'
    ? '<section class="rd-signoff"><h2>Your final scientific sign-off</h2>'+
      '<p>Review the complete assessment, findings, comparisons and questions. Only sign the version you intend to present.</p>'+
      '<form id="rd-approval">'+[
        ['scientific_positioning_read','I have read the scientific contribution and methodological alternatives.'],
        ['methods_and_limitations_understood','I understand what is implemented, what is proposed and the limitations.'],
        ['expert_questions_reviewed','I have reviewed the difficult expert questions and any missing answers.'],
        ['unresolved_findings_reviewed','I have considered unresolved findings and any necessary disclosures.']
      ].map(([key,label])=>'<label class="rd-checkbox"><input type="checkbox" name="'+key+'" required> '+escape(label)+'</label>').join('')+
      '<label>Optional note<textarea name="note" maxlength="2000" rows="2" placeholder="Limits to disclose, outstanding issues or decisions"></textarea></label>'+
      '<button class="rd-primary" type="submit">Approve this presentation revision</button></form></section>' : '';
  const recordIntro = record
    ? '<section class="rd-intro"><small>Independent reviewer: '+escape(record.reviewer.name)+' ('+escape(record.reviewer.model)+')</small>'+
        '<h2>'+escape(record.contribution_in_one_sentence)+'</h2>'+
        detail(record.what_is_not_demonstrated,'What is NOT demonstrated:')+
        detail(record.intended_audience,'Intended audience:')+'</section>'
    : '<section class="rd-alert"><h2>No independent readiness assessment yet</h2><p>The studio can display findings and collect human decisions, but it does not yet execute the scientific reviewer agent itself. An assessment must be generated using the configured reviewer workflow before a final presentation can be approved.</p></section>';
  return '<div class="rd-shell"><header class="rd-header"><div><small>Scientific Positioning & Readiness Gate</small><h1>Is this presentation ready?</h1>'+
    '<p>Understand what the work shows, what it does not show, where it fits, and what experts may challenge.</p></div>'+
    '<div class="rd-header-actions"><strong class="rd-verdict '+(status.can_deliver?'rd-approved-state':'rd-blocked-state')+'">'+
      escape(readinessLabel(status.status))+'</strong><button type="button" data-rd-close>Close ×</button></div></header>'+
    '<div class="rd-content">'+risksHtml+recordIntro+
    (record?'<section class="rd-section"><h2>Scientific review gates</h2><div class="rd-grid">'+cards+'</div></section>':'')+
    '<section class="rd-section"><h2>Reviewer findings <span class="rd-count">'+findings.length+'</span></h2>'+
      (findingCards || '<p>No findings recorded. An empty findings list alone does not establish scientific validity.</p>')+'</section>'+
    (record?'<section class="rd-section"><h2>Relevant alternative approaches</h2>'+alt+'</section>'+
      '<section class="rd-section"><h2>Implemented versus planned capabilities</h2>'+actual+'</section>'+
      '<section class="rd-section"><h2>Anticipated expert questions</h2>'+qa+'</section>'+
      '<section class="rd-section"><h2>Review limitations</h2>'+para(record.reviewer.uninspected_material)+'</section>':'')+
    approved+override+approval+
    (!isOwner && status.required?'<p>Only the presentation owner can sign off; editors and reviewers can inspect the findings.</p>':'')+
    '</div><footer class="rd-footer"><span>'+escape(status.can_deliver?'Delivery authorized for this exact revision.':'Final delivery is blocked until all required scientific and human approvals are current.')+
      '</span><button type="button" data-rd-refresh>Refresh</button></footer></div>';
}

export async function openReadinessStudio(options: {
  isOwner: boolean;
  onOpenSlide: (id: string) => void;
  onUpdate: (data: ReadinessView) => void;
  onFeedback: (message: string, isError?: boolean) => void;
}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'readiness-dialog';
  dialog.innerHTML = '<p>Loading review…</p>';
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  let current: ReadinessView | undefined;
  const refresh = async () => {
    current=await fetchReadiness();
    options.onUpdate(current);
    dialog.innerHTML = reviewMarkup(current, options.isOwner);
  };
  const guard = async (work: () => Promise<unknown>, message: string) => {
    try {await work();await refresh();options.onFeedback(message);}
    catch(e) {options.onFeedback(e instanceof Error?e.message:String(e),true);}
  };
  dialog.addEventListener('click',event=>{
    const btn=(event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if(!btn)return;
    if(btn.hasAttribute('data-rd-close')){dialog.close();return;}
    if(btn.hasAttribute('data-rd-refresh')){void guard(refresh,'Readiness information refreshed.');return;}
    if(btn.dataset.rdSlide){dialog.close();options.onOpenSlide(btn.dataset.rdSlide);return;}
    if(btn.dataset.rdFinding && current){
      const id=btn.dataset.rdFinding, note=dialog.querySelector<HTMLTextAreaElement>('[data-rd-note="'+id+'"]')?.value??'';
      if(btn.dataset.rdDecision==='request-alternative'&&!note.trim()) {
        options.onFeedback('Explain the alternative you want.',true);return;
      }
      void guard(()=>jsonRequest('/api/readiness/finding',{id,decision:btn.dataset.rdDecision,note}),
        'Scientific finding decision recorded.');return;
    }
  });
  dialog.addEventListener('submit',event=>{
    event.preventDefault();
    const form=event.target as HTMLFormElement, status=current?.status;
    if(!status?.revision||!status.record_sha256)return;
    const values=new FormData(form);
    if(form.id==='rd-approval'){
      const fields=['scientific_positioning_read','methods_and_limitations_understood',
        'expert_questions_reviewed','unresolved_findings_reviewed'];
      const acknowledgement=Object.fromEntries(fields.map(key=>[key,values.has(key)]));
      if(Object.values(acknowledgement).some(value=>!value)) {
        options.onFeedback('Read and acknowledge every scientific sign-off statement.',true);return;
      }
      void guard(()=>jsonRequest('/api/readiness/approve',{
        revision:status.revision,record_sha256:status.record_sha256,acknowledgement,
        note:String(values.get('note')??'')
      }),'Presenter sign-off recorded for this exact presentation revision.');
    }
    if(form.id==='rd-override'){
      if(!values.has('confirmed')) {options.onFeedback('You must explicitly acknowledge the unresolved scientific risks.',true);return;}
      void guard(()=>jsonRequest('/api/readiness/override',{
        revision:status.revision,record_sha256:status.record_sha256,
        reason:String(values.get('reason')??''),confirmed:true
      }),'Risk override recorded. A separate final presenter sign-off is still required.');
    }
  });
  try {await refresh();}
  catch(e) {options.onFeedback(e instanceof Error?e.message:String(e),true);dialog.close();}
}
