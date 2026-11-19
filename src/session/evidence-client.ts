/** Browser control surface for a goal-bound evidence workbench.
 * It never confuses text extraction with semantic analysis or scientific verification.
 */
type KnowledgeStatus={
  state:string;complete:boolean;revision?:string;
  reason?:string;pending_chunks?:number;unreadable_count?:number;
  goal?:{purpose:string;central_message:string;audience:string};
  files?:{id:string;path:string;kind:string;status:string;error?:string;total:number;reviewed:number}[];
};
type Progress={phase:string;done:number;total:number;source?:string;error?:string};
type EvidenceData={
  status:KnowledgeStatus;agentConfigured:boolean;transmitsExternally:boolean;paidAgent:boolean;
  job:Progress|null;lastError:string
};
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
async function call(url:string,payload?:unknown,raw?:File):Promise<any>{
  const res=await fetch(url,{method:payload===undefined&&!raw?'GET':'POST',credentials:'same-origin',
    headers:raw?{'Content-Type':raw.type||'application/octet-stream'}:payload===undefined?undefined:{'Content-Type':'application/json'},
    body:raw??(payload===undefined?undefined:JSON.stringify(payload))});
  const r=await res.json();
  if(!res.ok)throw new Error(r.error??('Request failed: '+res.status));
  return r;
}
export async function openEvidenceStudio(options:{
  owner:boolean;onMessage:(message:string,failed?:boolean)=>void;
}){
  const dialog=document.createElement('dialog');
  dialog.className='readiness-dialog';
  dialog.innerHTML='<div class="rd-shell"><p class="rd-content">Loading scientific sources…</p></div>';
  document.body.append(dialog);dialog.showModal();
  let state:EvidenceData|undefined,notes='';
  let interval:ReturnType<typeof setInterval>|undefined;
  const notify=options.onMessage;
  const draw=()=>{
    if(!state)return;
    const s=state.status;
    const files=s.files??[];
    const list=files.map(f=>'<tr><td><strong>'+esc(f.path)+'</strong><small>'+esc(f.id)+'</small></td>'+
      '<td>'+esc(f.status)+(f.error?'<small class="kb-error">'+esc(f.error)+'</small>':'')+'</td>'+
      '<td>'+f.reviewed+'/'+f.total+'</td>'+
      '<td><button type="button" data-kb-notes="'+esc(f.id)+'" title="Read the original evidence notes">Notes</button></td></tr>').join('');
    const blocked=!options.owner||state.job&&!['complete','failed','cancelled'].includes(state.job.phase);
    const consent=state.transmitsExternally||state.paidAgent
      ?'<section class="kb-consent"><h3>Data transmission and possible cost</h3>'+
        (state.transmitsExternally?'<label class="rd-checkbox"><input type="checkbox" id="kb-external"> I authorize sending extracted source text to the configured external agent provider.</label>':'')+
        (state.paidAgent?'<label class="rd-checkbox"><input type="checkbox" id="kb-paid"> I authorize the configured provider to incur its disclosed usage charges.</label>':'')+
        '</section>':'';
    const progress=state.job?'<section class="kb-progress"><strong>Agent stage: '+esc(state.job.phase)+
      '</strong><p>'+state.job.done+' / '+state.job.total+' source chunks recorded. '+
      esc(state.job.source??'')+'</p>'+(state.job.error?'<p class="kb-error">'+esc(state.job.error)+'</p>':'')+'</section>':'';
    dialog.innerHTML='<div class="rd-shell"><header class="rd-header"><div><small>PPTimystic · research sources</small>'+
      '<h1>Evidence workbench</h1><p>Read every source against your approved goal; compare claims and counterarguments before writing slides.</p></div>'+
      '<div class="rd-header-actions"><button type="button" data-kb-close>Close ×</button></div></header>'+
      '<div class="rd-content"><section class="rd-intro"><small>Source status: '+esc(s.state)+'</small>'+
      '<h2>'+esc(s.goal?.central_message??'No approved goal or prepared source inventory')+'</h2>'+
      '<p>'+esc(s.goal?.purpose??'Approve your presentation goal and audience in the brief before source analysis.')+'</p>'+
      '<p>Every readable PDF is checked chunk-by-chunk; unavailable text and untouched figures remain explicit gaps.</p></section>'+
      '<section class="rd-section"><h2>Documents '+files.length+'</h2><table class="kb-table"><thead><tr><th>Source</th><th>Extraction</th><th>Analyzed</th><th></th></tr></thead>'+
      '<tbody>'+list+'</tbody></table>'+
      (options.owner?'<div class="kb-actions"><label class="kb-upload">Add PDFs and research documents<input id="kb-files" type="file" multiple accept=".pdf,.docx,.pptx,.md,.txt,.csv"></label>'+
        '<button type="button" data-kb-prepare '+(blocked?'disabled':'')+'>Refresh source inventory</button></div>':'')+
      '<p class="rd-detail">PDF text is extracted locally. Images, figures, tables, and scanned pages need separate visual review.</p></section>'+
      '<section class="rd-section"><h2>Goal-oriented source analysis</h2>'+
      '<p>Source analyst → Cross-document synthesis → Independent skeptical critic. Each stage is a separate invocation of your configured agent adapter; this does not prove model independence or scientific truth.</p>'+
      progress+(state.lastError?'<div class="rd-alert"><b>Last issue:</b> '+esc(state.lastError)+'</div>':'')+
      (s.reason?'<div class="rd-alert"><b>Blocked:</b> '+esc(s.reason)+'</div>':'')+
      (options.owner?consent+'<div class="kb-actions"><button type="button" class="primary" data-kb-run '+
        (!state.agentConfigured||blocked||!files.length?'disabled':'')+'>Run complete source analysis</button>'+
        '<button type="button" data-kb-cancel '+(!state.job||['complete','failed','cancelled'].includes(state.job.phase)?'disabled':'')+'>Stop agents</button></div>':'')+
      (!state.agentConfigured?'<div class="rd-alert">No configured scientific agent. The app will NOT pretend to have read the papers. Provider selection and local-model setup are the next product milestone.</div>':'')+
      '<p><b>Analysis status:</b> '+(s.complete?'All extractable chunks have analyst records. Human scientific checking is still required.':
        esc((s.pending_chunks??0)+' unreviewed chunks and '+(s.unreadable_count??0)+' unavailable text sources.'))+'</p>'+
      '<div class="kb-actions"><button type="button" data-kb-index>Read source inventory</button>'+
      '<button type="button" data-kb-synthesis '+(!s.complete?'disabled':'')+'>Read synthesis and critique</button></div></section>'+
      '<section class="rd-section"><h2>Evidence notes</h2><pre class="kb-notes">'+esc(notes||'Select a paper, the source inventory or the synthesis to inspect the Markdown evidence base.')+'</pre></section>'+
      '</div><footer class="rd-footer"><span>Source analysis is not a READY verdict. Final scientific review and presenter approval remain mandatory.</span>'+
      '<button type="button" data-kb-refresh>Refresh</button></footer></div>';
  };
  const refresh=async()=>{
    state=await call('/api/knowledge') as EvidenceData;draw();
  };
  const guarded=async(work:()=>Promise<void>,message:string)=>{
    try{await work();await refresh();notify(message);}
    catch(error){notify(error instanceof Error?error.message:String(error),true);}
  };
  dialog.addEventListener('change',event=>{
    const input=event.target as HTMLInputElement;
    if(input.id!=='kb-files'||!input.files?.length)return;
    const selected=[...input.files];input.value='';
    void guarded(async()=>{
      for(const file of selected)await call('/api/knowledge/upload?name='+encodeURIComponent(file.name),undefined,file);
      notes='Uploaded '+selected.length+' source file(s). Refresh the goal-bound inventory to include them.';
    },'Source files retained locally. Prepare the inventory before analyzing.');
  });
  dialog.addEventListener('click',event=>{
    const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if(!button)return;
    if(button.hasAttribute('data-kb-close')){dialog.close();return;}
    if(button.hasAttribute('data-kb-refresh')){void guarded(refresh,'Source status refreshed.');return;}
    if(button.hasAttribute('data-kb-prepare')){
      void guarded(async()=>{await call('/api/knowledge/prepare',{});notes='The inventory is prepared. Unreadable sources must be resolved, and the source-agent pipeline must still examine every text chunk.';},
        'Source inventory prepared against the approved brief.');return;
    }
    if(button.hasAttribute('data-kb-index')||button.dataset.kbNotes){
      const source=button.dataset.kbNotes;
      void guarded(async()=>{const result=await call('/api/knowledge/notes'+(source?'?source='+encodeURIComponent(source):''));notes=result.markdown;},
        'Evidence notes opened.');return;
    }
    if(button.hasAttribute('data-kb-synthesis')){
      void guarded(async()=>{const result=await call('/api/knowledge/synthesis');notes=result.markdown;},
        'Synthesis and independent critique opened.');return;
    }
    if(button.hasAttribute('data-kb-run')){
      const confirmExternal=dialog.querySelector<HTMLInputElement>('#kb-external')?.checked===true;
      const confirmPaid=dialog.querySelector<HTMLInputElement>('#kb-paid')?.checked===true;
      void guarded(async()=>{await call('/api/knowledge/run',{confirmExternal,confirmPaid});},
        'Source agents started. Review their grounded outputs before using them in slides.');return;
    }
    if(button.hasAttribute('data-kb-cancel')){
      void guarded(async()=>{await call('/api/knowledge/cancel',{});},'Cancellation requested.');return;
    }
  });
  dialog.addEventListener('close',()=>{if(interval)clearInterval(interval);dialog.remove();});
  try{await refresh();}catch(error){notify(error instanceof Error?error.message:String(error),true);dialog.close();return;}
  interval=setInterval(()=>{void refresh().catch(()=>{});},2500);
}
