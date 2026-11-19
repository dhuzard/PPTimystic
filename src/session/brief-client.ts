/** Goal and audience interview for non-coders. Answers are saved as draft data;
 * approving the goal is a separate authenticated human action.
 */
type BriefResponse={brief:any;status:{required:boolean;approved:boolean;errors:string[]}};
const html=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const parts:{heading:string;key:string;fields:{id:string;label:string;description:string}[]}[]=[
  {heading:'Your presentation objective',key:'goal',fields:[
    {id:'purpose',label:'Why are you presenting?',description:'The actual problem or question'},
    {id:'central_message',label:'What is the main conclusion?',description:'A defensible statement, not a slogan'},
    {id:'audience_action',label:'What should the audience do or understand?',description:'The intended outcome'}]},
  {heading:'Your audience',key:'audience',fields:[
    {id:'description',label:'Who will attend?',description:'Discipline, context and seniority'},
    {id:'prior_knowledge',label:'What do they already know?',description:'Which concepts need no introduction'},
    {id:'needs_and_concerns',label:'What will they challenge?',description:'Critical questions and expectations'}]},
  {heading:'Your evidence and boundaries',key:'content',fields:[
    {id:'scope_and_structure',label:'Scientific scope',description:'Include and exclude important topics'},
    {id:'evidence_and_sources',label:'Evidence that must be used',description:'Studies, experiments, datasets'},
    {id:'uncertainties_and_exclusions',label:'Uncertainties and exclusions',description:'Claims you cannot justify'}]},
  {heading:'Presenter and delivery',key:'creator',fields:[
    {id:'profile',label:'Presenter role',description:'Who is speaking'},
    {id:'expertise',label:'Relevant scientific expertise',description:'What you can defend'},
    {id:'working_preferences',label:'Presentation preferences',description:'Concise, technical, audience-friendly…'}]},
  {heading:'Slide design and constraints',key:'design',fields:[
    {id:'tone',label:'Scientific tone',description:'Exploratory, expert methods, educational…'},
    {id:'visual_preferences',label:'Visual preferences',description:'Graphs, diagrams, figures, editable objects…'}]}
];
async function request(url:string,body?:unknown):Promise<any>{
  const r=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',
    headers:body===undefined?undefined:{'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw new Error(data.error??'Goal interview failed.');return data;
}
export async function openBriefStudio(options:{owner:boolean;notice:(message:string,isError?:boolean)=>void;onApproved?:()=>void}){
  const dialog=document.createElement('dialog');dialog.className='readiness-dialog';
  document.body.append(dialog);dialog.showModal();
  let response:BriefResponse;
  const load=async()=>response=await request('/api/brief');
  const render=()=>{
    const brief=response.brief;
    const editor=parts.map(part=>'<section class="rd-section"><h2>'+html(part.heading)+'</h2><div class="kb-brief-grid">'+
      part.fields.map(field=>'<label>'+html(field.label)+'<small>'+html(field.description)+'</small>'+
      '<textarea rows="2" data-brief-group="'+part.key+'" data-brief-field="'+field.id+'" maxlength="4000" '+
      (options.owner?'':'disabled')+'>'+html(brief?.[part.key]?.[field.id]??'')+'</textarea></label>').join('')+
      '</div></section>').join('');
    const status=response.status;
    dialog.innerHTML='<div class="rd-shell"><header class="rd-header"><div>'+
      '<small>PPTimystic · presentation goal</small><h1>Brief and audience</h1>'+
      '<p>The objective determines how every source is read, how slides are evaluated and what an expert will expect.</p></div>'+
      '<div class="rd-header-actions"><strong class="rd-verdict '+(status.approved?'rd-approved-state':'')+'">'+
      (status.approved?'Goal approved':'Draft — not approved')+'</strong><button type="button" data-brief-close>Close ×</button></div></header>'+
      '<div class="rd-content">'+(!status.approved&&status.errors.length?
        '<section class="rd-alert"><h2>Before scientific review</h2><ul>'+
        status.errors.slice(0,15).map(x=>'<li>'+html(x)+'</li>').join('')+'</ul></section>':'')+
      '<form id="brief-form">'+editor+
      '<section class="rd-section"><h2>Setting and accessibility</h2><div class="kb-brief-grid">'+
      '<label>Presentation format and setting<textarea data-brief-group="delivery" data-brief-field="format_and_setting" rows="2" maxlength="4000" '+
      (options.owner?'':'disabled')+'>'+html(brief?.delivery?.format_and_setting??'')+'</textarea></label>'+
      '<label>Duration (minutes)<input type="number" min="0" max="480" data-brief-group="delivery" data-brief-field="duration_minutes" value="'+
      Number(brief?.delivery?.duration_minutes??0)+'" '+(options.owner?'':'disabled')+'></label>'+
      '<label>Accessibility requirements<textarea data-brief-group="constraints" data-brief-field="accessibility_and_other" rows="2" maxlength="4000" '+
      (options.owner?'':'disabled')+'>'+html(brief?.constraints?.accessibility_and_other??'')+'</textarea></label>'+
      '<label>Other wishes<textarea name="further_wishes" rows="2" maxlength="4000" '+(options.owner?'':'disabled')+'>'+
      html(brief?.further_wishes??'')+'</textarea></label></div></section>'+
      (options.owner?'<section class="kb-actions"><button type="submit">Save draft answers</button>'+
        '<button type="button" class="primary" data-brief-approve>Approve this goal and audience</button></section>':
        '<p>Only the session owner can change and approve the presentation goal.</p>')+
      '</form></div><footer class="rd-footer"><span>Approval is invalidated by changes. Evidence agents must work against the approved brief.</span>'+
      '<button type="button" data-brief-refresh>Refresh</button></footer></div>';
  };
  const collect=()=>{
    const raw=JSON.parse(JSON.stringify(response.brief)) as any;
    delete raw.approval;
    dialog.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-brief-group]').forEach(input=>{
      const group=input.dataset.briefGroup!,key=input.dataset.briefField!;
      raw[group]??={};
      raw[group][key]=key==='duration_minutes'?Number(input.value):input.value;
    });
    raw.further_wishes=dialog.querySelector<HTMLTextAreaElement>('[name="further_wishes"]')?.value??'';
    return raw;
  };
  const save=async()=>{
    const data=await request('/api/brief/save',collect());
    await load();render();return data;
  };
  dialog.addEventListener('submit',event=>{
    event.preventDefault();void save().then(()=>options.notice('Your presentation goal was saved as a draft. Explicitly approve it when complete.'))
      .catch(e=>options.notice(e.message,true));
  });
  dialog.addEventListener('click',event=>{
    const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if(!button)return;
    if(button.hasAttribute('data-brief-close')){dialog.close();return;}
    if(button.hasAttribute('data-brief-refresh')){void load().then(render).catch(e=>options.notice(e.message,true));return;}
    if(button.hasAttribute('data-brief-approve')){
      void (async()=>{
        try{
          await save();
          const result=await request('/api/brief/approve',{});
          response.status=result.status;
          render();
          if(result.status.approved){
            options.notice('Goal approved. Open Sources & evidence to analyze your papers against this objective.');
            options.onApproved?.();
          }else options.notice('Approval blocked: complete the missing fields.',true);
        }catch(e){options.notice(e instanceof Error?e.message:String(e),true);}
      })();
    }
  });
  dialog.addEventListener('close',()=>dialog.remove());
  try{await load();render();}catch(e){options.notice(e instanceof Error?e.message:String(e),true);dialog.close();}
}
