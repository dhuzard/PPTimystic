import * as Y from 'yjs';
import type { SessionSnapshot, Operation, TextState } from './contracts.js';
import { textKey } from './contracts.js';
import type { SceneObject } from '../core/scene.js';

const app = document.querySelector<HTMLDivElement>('#app')!;
let state: SessionSnapshot;
let slideId = '', objectId = '', tab = 'properties', locale = '', online = false;
let notice = '', error = false, editing = false, exportBusy = false, authorized = false;
let viewMode: 'reference'|'draft' = 'reference';
let downloads:string[] = [], previewLocale='';
let events: EventSource | undefined;
let stateSignature='';
const docs = new Map<string, { doc:Y.Doc; text:Y.Text; generation:string }>();
const drafts = new Map<string,string>();
const jobAuthorizations = new Set<string>();
const escape = (value:unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const color = (value:unknown, fallback = '263430') => /^#?[a-f\d]{6}$/i.test(String(value)) ? `#${String(value).replace('#','')}` : `#${fallback}`;
const selectedSlide = () => state?.slides.find(s => s.id === slideId);
const selectedObject = () => selectedSlide()?.scene?.objects.find(o => o.id === objectId);
const protectedSlide = () => { const s = selectedSlide(); return !!s && (s.locked || s.status === 'approved' || s.status === 'locked' || s.review === 'approved' || s.review === 'locked'); };
const canModify = () => state?.actor.role !== 'reviewer' && (!protectedSlide() || (state.actor.role === 'owner' && authorized));
const canEdit = () => canModify() && !(viewMode==='reference' && selectedSlide()?.reference);
const toBase64 = (data:Uint8Array) => { let s = ''; for (const b of data) s += String.fromCharCode(b); return btoa(s); };
const fromBase64 = (data:string) => Uint8Array.from(atob(data), c => c.charCodeAt(0));

async function request(path:string, body?:unknown, raw?:Blob) {
  const response = await fetch(path, { method:body !== undefined || raw ? 'POST':'GET', credentials:'same-origin', headers:raw ? {'Content-Type':raw.type} : body !== undefined ? {'Content-Type':'application/json'}:undefined, body:raw ?? (body !== undefined ? JSON.stringify(body):undefined) });
  const result = await response.json();
  if (!response.ok) { if (result.state) accept(result.state); throw new Error(result.error ?? result.message ?? `Request failed (${response.status})`); }
  if (result.state) accept(result.state);
  return result;
}
function showError(cause:unknown) { notice = cause instanceof Error ? cause.message : String(cause); error = true; renderNotice(); }
function inform(message:string) { notice = message; error = false; renderNotice(); }
function renderNotice() { const node = document.querySelector('#notice'); if (node) { node.innerHTML = (notice ? `<div class="notice ${error?'error':''}" role="${error?'alert':'status'}"><button data-action="dismiss" aria-label="Dismiss message">×</button>${escape(notice)}${downloads.length?`<div style="margin-top:5px">${downloads.map(file=>`<a href="/api/exports?file=${encodeURIComponent(file)}" download>${escape(file)}</a>`).join(' · ')}${previewLocale?` · <a href="/api/previews?locale=${encodeURIComponent(previewLocale)}&file=contact-sheet.png" target="_blank" rel="noopener">Open rendered contact sheet</a>`:''}</div>`:''}</div>`:'')+[...drafts.keys()].map(key=>`<div class="notice" role="status">A text version changed. Your draft is preserved for ${escape(key.split('|')[2])}. <button data-restore="${escape(key)}">Apply preserved draft</button><button data-discard="${escape(key)}">Use shared text</button></div>`).join(''); } }

function accept(next:SessionSnapshot) {
  const signature=JSON.stringify([next.revision,next.locale,next.actor,next.comments,next.jobs,next.issues,next.slides]);
  const unchanged=signature===stateSignature;stateSignature=signature;
  state = next; locale = next.locale;
  if (!next.slides.some(s => s.id === slideId)) slideId = next.slides[0]?.id ?? '';
  for (const [key, textState] of Object.entries(next.texts)) syncDoc(key,textState);
  if(unchanged){renderPresence();renderNotice();return;}
  if (!editing && !dragging) render(); else { renderCanvas(); renderPresence(); renderNotice(); }
}
function syncDoc(key:string, value:TextState) {
  let entry = docs.get(key);
  if (!entry || entry.generation !== value.generation) {
    const field=document.querySelector<HTMLTextAreaElement>(`textarea[data-text-key="${CSS.escape(key)}"]`);
    if(entry && field && document.activeElement===field) {drafts.set(key,field.value);field.readOnly=true;renderNotice();}
    entry?.doc.destroy();
    const doc = new Y.Doc(); const text = doc.getText('text');
    entry = {doc,text,generation:value.generation}; docs.set(key,entry);
    doc.on('update',(update:Uint8Array, origin:unknown) => {
      if (origin !== 'local') return;
      const [slideId,locale,objectId] = key.split('|');
      void request('/api/text',{slideId,locale,objectId,generation:entry!.generation,update:toBase64(update),authorize:authorized?[slideId]:[]}).catch(cause=>{drafts.set(key,entry!.text.toString());showError(cause);const field=document.querySelector<HTMLTextAreaElement>(`textarea[data-text-key="${CSS.escape(key)}"]`);if(field)field.readOnly=true;});
    });
    text.observe(() => {
      document.querySelectorAll<HTMLTextAreaElement>(`textarea[data-text-key="${CSS.escape(key)}"]`).forEach(field=>{
        if (drafts.has(key) || field.value === text.toString()) return;
        const start = field.selectionStart, end = field.selectionEnd, oldLength = field.value.length;
        field.value = text.toString();
        if (document.activeElement === field) field.setSelectionRange(Math.max(0,start+field.value.length-oldLength),Math.max(0,end+field.value.length-oldLength));
      });
    });
  }
  Y.applyUpdate(entry.doc,fromBase64(value.update),'remote');
}
function editText(field:HTMLTextAreaElement) {
  const key = field.dataset.textKey!; const entry = docs.get(key);
  if (!entry) return;
  const old = entry.text.toString(), value = field.value;
  let start = 0; while (start < old.length && start < value.length && old[start] === value[start]) start++;
  let suffix = 0; while (suffix < old.length-start && suffix < value.length-start && old[old.length-1-suffix] === value[value.length-1-suffix]) suffix++;
  entry.doc.transact(() => { if(old.length-start-suffix) entry.text.delete(start,old.length-start-suffix); if(value.length-start-suffix) entry.text.insert(start,value.slice(start,value.length-suffix)); },'local');
}
async function operate(kind:Operation['kind'], value:unknown, target = objectId, expectedRevision = state.revision) {
  try { await request('/api/operations',{slideId,locale,objectId:target || undefined,expectedRevision,kind,value,authorize:authorized?[slideId]:[]}); }
  catch(cause) { showError(cause); }
}

function objectLabel(object:SceneObject) {
  if(!object.role.startsWith('object-'))return object.role;
  const siblings=selectedSlide()?.scene?.objects.filter(o=>o.role.startsWith('object-')&&o.type===object.type)??[];
  const kind=object.type[0].toUpperCase()+object.type.slice(1),number=siblings.findIndex(o=>o.id===object.id)+1;
  const snippet=object.type==='text'?object.text?.replace(/\s+/g,' ').trim().slice(0,34):undefined;
  return `${kind} ${number}${snippet?` · ${snippet}`:''}`;
}

/** Search authored bounds with a little breathing room; keep the requested size. */
function insertionBox(w:number,h:number) {
  const scene=selectedSlide()!.scene!,gap=.14,margin=.55;
  const boxes=[...scene.geometry.boxes,...scene.objects];
  for(let y=margin;y+h<=scene.height-margin;y+=.2)for(let x=margin;x+w<=scene.width-margin;x+=.2){
    if(boxes.every(b=>x+w+gap<=b.x||x>=b.x+b.w+gap||y+h+gap<=b.y||y>=b.y+b.h+gap))return {x:Number(x.toFixed(2)),y:Number(y.toFixed(2)),w,h};
  }
  inform('No open region fits this object at its requested size. It is centered for editing and may overlap existing content; move or resize it before exporting.');
  return {x:Math.max(0,(scene.width-w)/2),y:Math.max(0,(scene.height-h)/2),w,h};
}

async function addObject(value:{type:'text'|'shape'|'image';w:number;h:number;text?:string;asset?:string;alt?:string;style?:Record<string,unknown>}) {
  const before=new Set(selectedSlide()?.scene?.objects.map(o=>o.id));
  const placement=insertionBox(value.w,value.h);
  await request('/api/operations',{slideId,locale,expectedRevision:state.revision,kind:'add',value:{...value,...placement},authorize:authorized?[slideId]:[]});
  const added=selectedSlide()?.scene?.objects.find(o=>!before.has(o.id));
  if(added){objectId=added.id;editing=false;render();}
}

function render() {
  if (!state) return;
  const focusedObject=(document.activeElement as HTMLElement|null)?.dataset.objectId;
  const slide = selectedSlide();
  app.innerHTML = `<header class="app-header"><div class="brand">PPT<span>imistic</span></div><div class="project-heading"><strong>${escape(state.title)}</strong><br><small>Shared studio · revision ${state.revision}</small></div><div class="header-spacer"></div><div id="presence" class="avatars"></div><div class="connection"><span class="dot ${online?'':'offline'}"></span><span class="connection-label">${online?'Live collaboration':'Reconnecting…'}</span></div><div class="export-menu"><button data-action="export-menu" class="primary" ${exportBusy?'disabled':''}>${exportBusy?'Building…':'Export ↗'}</button><div id="export-options" class="export-options" hidden><button data-action="export">Editable PowerPoint</button><button data-action="export-render">PowerPoint + previews</button></div></div></header><div id="notice"></div>${state.briefReady===false?'<div class="reference-notice" role="alert">Creator brief approval is required before exporting. Run the CLI <code>npm run brief -- --project '+escape(state.project)+'</code> and review the presentation goal with the creator.</div>':''}<div class="workspace"><aside class="slide-sidebar"><div class="section-label">Slides <span>${state.slides.length}</span></div>${state.slides.map((s,i) => `<button class="slide-card ${s.id===slideId?'selected':''}" data-slide="${escape(s.id)}" aria-label="Slide ${i+1}: ${escape(s.id)}" aria-current="${s.id===slideId?'true':'false'}"><div class="slide-mini"><div class="mini-title">${escape(s.scene?.objects.find(o=>o.role==='title')?.text ?? s.id)}</div><div class="mini-line"></div><div class="mini-line" style="width:45%"></div></div><div class="slide-card-footer"><strong>${String(i+1).padStart(2,'0')}</strong><span>${escape(s.id)}</span><span title="${escape(s.status)}">${s.locked||s.status==='locked'?'▣':s.status==='approved'?'✓':'○'}</span></div></button>`).join('')}</aside><main class="editor-main"><div class="toolbar"><span class="slide-name">${escape(slide?.id ?? '')} <span class="badge">${escape(slide?.status ?? '')}</span></span><select id="locale" aria-label="Output language">${state.locales.map(l=>`<option ${l===locale?'selected':''}>${escape(l)}</option>`).join('')}</select><button data-action="undo" ${state.history.some(h=>h.actor.id===state.actor.id&&!h.undone)&&canEdit()?'':'disabled'} title="Undo your latest change">↶ Undo</button><button data-action="add-text" ${canEdit()?'':'disabled'}>+ Text</button><button data-action="add-shape" ${canEdit()?'':'disabled'}>+ Shape</button></div><div class="canvas-space"><div class="canvas-meta"><span>Slide ${state.slides.findIndex(s=>s.id===slideId)+1} / ${state.slides.length}</span><span>${escape(locale)} · native objects</span></div><div id="canvas" class="canvas" role="group" aria-label="Editable slide"></div><div class="canvas-footer"><span>${escape(slide?.scene?.width.toFixed(2) ?? '')} × ${escape(slide?.scene?.height ?? '')} in</span><span>Drag to position · Arrow keys to nudge · Shift for larger steps</span></div></div><section class="notes-panel"><div class="notes-heading"><h3>Speaker notes</h3><small>Shared with collaborators</small></div>${textArea('notes', 'Speaker notes', slide?.scene?.notes ?? '',3)}</section></main><aside class="inspector"><div class="tabs" role="tablist">${[['properties','Design'],['comments','Comments'],['activity','Activity']].map(([id,label])=>`<button data-tab="${id}" role="tab" aria-selected="${tab===id}" class="${tab===id?'active':''}">${label}${id==='comments'&&state.comments.filter(c=>c.slideId===slideId&&!c.resolved).length?` (${state.comments.filter(c=>c.slideId===slideId&&!c.resolved).length})`:''}</button>`).join('')}</div><div class="panel" id="panel">${renderPanel()}</div></aside></div>`;
  const exportButton=app.querySelector<HTMLButtonElement>('[data-action="export-menu"]');
  if(exportButton && state.exportBlocked){exportButton.disabled=true;exportButton.title=state.briefReady===false?'Approve the creator brief before exporting.':'Export is unavailable until this presentation’s custom layout and media are supported.';}
  if(slide?.reference) {
    if(viewMode==='reference') {
      const metadata=app.querySelectorAll('.canvas-meta span');if(metadata[1])metadata[1].textContent=`${locale} · original PowerPoint preview`;
      const footer=app.querySelectorAll('.canvas-footer span');if(footer[1])footer[1].textContent='Select supported text to edit; other original objects are read-only';
      app.querySelector('#canvas')?.setAttribute('aria-label','Original PowerPoint slide preview');
    }
    app.querySelector('.toolbar')?.insertAdjacentHTML('beforeend',`<span class="reference-switch"><button data-action="reference-view" aria-pressed="${viewMode==='reference'}">Original slide</button><button data-action="draft-view" aria-pressed="${viewMode==='draft'}">Edit draft text</button></span>`);
    const nativeStatus=slide.reference.status==='pending'?'Rendering the latest text changes; the image is temporarily out of date.':slide.reference.status==='failed'?`The preview could not be updated: ${escape(slide.reference.error??'renderer unavailable')}.`:'Click a text object to edit it; videos can be played.';
    app.querySelector('.canvas-meta')?.insertAdjacentHTML('afterend',`<div class="reference-notice">${viewMode==='reference'?nativeStatus:'Generic draft editor. Its layout differs from the original; changes are not yet applied to the original PowerPoint.'}${state.exportBlocked?' PowerPoint export is unavailable for this trial.':''}</div>`);
  }
  renderCanvas(); renderPresence(); renderNotice(); enrichControls();
  if(focusedObject)document.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(focusedObject)}"]`)?.focus({preventScroll:true});
}

function enrichControls() {
  const toolbar=document.querySelector('.toolbar');
  const undo=toolbar?.querySelector<HTMLButtonElement>('[data-action="undo"]');if(undo)undo.disabled=!canModify()||!state.history.some(h=>h.actor.id===state.actor.id&&h.slideId===slideId&&!h.undone);
  const add=document.createElement('button');add.textContent='+ Image';add.dataset.action='add-image';add.disabled=!canEdit();toolbar?.append(add);
  const o=selectedObject(),panel=document.querySelector('#panel');
  panel?.querySelectorAll<HTMLButtonElement>('[data-object-select]').forEach(button=>{const item=selectedSlide()?.scene?.objects.find(o=>o.id===button.dataset.objectSelect);if(item){button.textContent=objectLabel(item);button.title=item.id;}});
  if(tab==='properties'&&state.actor.role==='owner'&&panel){
    const group=document.createElement('div');group.className='field-group';
    for(const [kind,title,current] of [['status','Slide status',selectedSlide()?.status],['translation-review',`Review · ${locale}`,selectedSlide()?.review]] as const){
      const label=document.createElement('label');label.textContent=title;const select=document.createElement('select');select.dataset.reviewKind=kind;select.disabled=!canEdit();
      for(const value of ['draft','review','approved','locked']){const option=document.createElement('option');option.value=value;option.textContent=value;option.selected=value===current;select.append(option);}label.append(select);group.append(label);
    }panel.append(group);
  }
  if(tab==='activity'&&panel){for(const h of state.history.filter(h=>h.slideId===slideId&&!h.undone&&(h.actor.id===state.actor.id||state.actor.role==='owner')).slice(-6).reverse()){
    const button=document.createElement('button');button.dataset.historyUndo=h.id;button.textContent=`Undo revision ${h.revision} · ${h.kind}`;button.className='wide';button.style.marginTop='7px';button.disabled=!canModify();panel.append(button);
  }}
  if(tab==='activity'&&state.actor.role==='owner')panel?.querySelectorAll<HTMLButtonElement>('[data-job-apply]').forEach(button=>{
    const job=state.jobs.find(j=>j.id===button.dataset.jobApply)!;
    const label=document.createElement('label');label.className='check-label';label.style.marginTop='10px';
    const check=document.createElement('input');check.type='checkbox';check.dataset.jobAuthorization=job.id;check.checked=jobAuthorizations.has(job.id);
    label.append(check,document.createTextNode(`I explicitly authorize protected changes to ${job.slideId}.`));button.parentElement?.before(label);
  });
  if(tab!=='properties'||!o||!panel)return;
  if(o.role.startsWith('object-')){const title=panel.querySelector('h2');if(title){title.textContent=objectLabel(o);title.title=o.id;}}
  const colorInput=panel.querySelector<HTMLInputElement>('[data-style="color"]'),fillInput=panel.querySelector<HTMLInputElement>('[data-style="fill"]');
  if(o.type==='image'){colorInput?.closest('.field-group')?.remove();}
  if(o.type==='connector')fillInput?.closest('label')?.remove();
  if(o.type==='chart'&&colorInput){colorInput.value=color(o.options.chartColors?.[0]);if(fillInput)fillInput.value=color(o.options.chartArea?.fill?.color,'FFFFFF');const label=colorInput.closest('label');if(label?.firstChild)label.firstChild.textContent='Primary series color';const hint=document.createElement('p');hint.className='panel-intro';hint.textContent='Chart preview — verify exported PowerPoint.';panel.prepend(hint);}
  if(o.missingTranslation){const warning=document.createElement('div');warning.className='notice';warning.textContent='Translation missing. Add text in this language before exporting.';panel.prepend(warning);}
  if(o.type==='image') {
    const group=document.createElement('div');group.className='field-group';
    const label=document.createElement('label');label.textContent='Alt description · this language';
    const field=document.createElement('textarea');field.rows=3;field.dataset.alt='true';field.value=o.options.altText??'';field.disabled=!canEdit();
    label.append(field);group.append(label);panel.append(group);
  }
  const remove=panel.querySelector<HTMLButtonElement>('[data-action="delete-object"]');
  if(remove&&!o.role.startsWith('object-')) {remove.disabled=true;remove.title='Layout objects are retained. Only added objects can be removed.';}
}

function imageDialog() {
  const dialog=document.createElement('dialog');dialog.className='image-dialog';
  dialog.innerHTML='<form id="add-image-form"><h2>Add an illustration</h2><p class="panel-intro">Keep a separate image asset and describe it for this language.</p><label>Image file<input name="file" type="file" accept="image/png,image/jpeg,image/webp" required></label><label>Alt description<textarea name="alt" rows="3" required maxlength="10000" placeholder="Describe the information this image conveys"></textarea></label><div class="job-actions"><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Add image</button></div><div class="join-error" role="alert"></div></form>';
  document.body.append(dialog);dialog.showModal();
  dialog.querySelector('[data-cancel]')!.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>dialog.remove());
  dialog.querySelector('form')!.addEventListener('submit',event=> {
    event.preventDefault();const file=dialog.querySelector<HTMLInputElement>('[name="file"]')!.files?.[0],alt=dialog.querySelector<HTMLTextAreaElement>('[name="alt"]')!.value;if(!file||!alt.trim())return;
    const button=dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;button.disabled=true;
    void request('/api/uploads',undefined,file).then(result=>addObject({type:'image',asset:result.asset,alt,w:4,h:3})).then(()=>dialog.close()).catch(cause=>{dialog.querySelector('.join-error')!.textContent=cause.message;button.disabled=false;});
  });
}

function textArea(id:string,label:string,fallback:string,rows=6) {
  if(id==='notes')id=`${slideId}:notes`;
  const key = textKey(slideId,locale,id); const value = drafts.get(key) ?? docs.get(key)?.text.toString() ?? fallback;
  return `<textarea rows="${rows}" data-text-key="${escape(key)}" data-object="${escape(id)}" aria-label="${escape(label)}" ${drafts.has(key)?'readonly':''} ${canEdit()?'':'disabled'}>${escape(value)}</textarea>`;
}
function renderPanel() {
  if(tab==='comments') return renderComments();
  if(tab==='activity') return renderActivity();
  const object = selectedObject(), slide = selectedSlide();
  if(viewMode==='reference' && slide?.reference) {
    const target=slide.reference.shapes?.find(s=>s.id===objectId) as (NonNullable<typeof slide.reference.shapes>[number]&{nativeText?:{runs:{paragraph:number;run:number;text:string}[];editable:boolean;reason?:string}})|undefined;
    if(!target)return '<h2>Original PowerPoint</h2><p class="panel-intro">Select an original slide element to inspect it or attach feedback. Videos remain playable. The original file is retained unchanged.</p>';
    const runs=target.nativeText?.runs;
    const allowed=state.actor.role!=='reviewer' && (!protectedSlide() || state.actor.role==='owner'&&authorized);
    const authorization=protectedSlide() && state.actor.role==='owner'?`<label class="check-label"><input type="checkbox" id="authorize" ${authorized?'checked':''}> I explicitly authorize protected changes to ${escape(slideId)}.</label>`:'';
    const fields=runs?.map((run,index)=>`<label>Paragraph ${run.paragraph+1}${runs.length>1?` · segment ${run.run+1}`:''}<textarea data-native-run="${index}" rows="${Math.min(5,Math.max(2,run.text.split('\n').length+1))}" ${allowed&&target.nativeText?.editable?'':'disabled'}>${escape(run.text)}</textarea></label>`).join('')??'';
    return `<div class="selected-kind">Original ${escape(target.kind)}</div><h2>${escape(target.label)}</h2>${authorization}${runs?.length?`<form id="native-text-form" data-base-revision="${state.revision}"><div class="field-group">${fields}<small>Formatting and paragraph structure are retained.</small></div><button type="submit" class="primary" ${allowed&&target.nativeText?.editable?'':'disabled'}>Save text</button></form>`:`<p class="panel-intro">This element can be reviewed and commented on.</p>`}${target.nativeText&&!target.nativeText.editable?`<p class="notice">${escape(target.nativeText.reason??'This object cannot yet be edited safely.')}</p>`:''}<div class="field-group"><button data-tab="comments" class="wide">Comment on this element</button></div>`;
  }
  const protection = protectedSlide() || state.actor.role==='owner' ? `<div class="protected">${protectedSlide()?'This slide or translation is approved or locked.':'Accepted illustrations and protected content require explicit authorization.'}${state.actor.role==='owner'?`<label class="check-label"><input type="checkbox" id="authorize" ${authorized?'checked':''}> I explicitly authorize protected changes to ${escape(slideId)}.</label>`:' An owner must explicitly authorize changes.'}</div>`:'';
  if(!object) return `${protection}<h2>Make room for your message</h2><p class="panel-intro">Select an object on the slide to edit its text, position and appearance. Changes are shared live.</p><h3>Objects on this slide</h3><div class="object-list">${slide?.scene?.objects.map(o=>`<button data-object-select="${escape(o.id)}">${escape(o.role)} <small>· ${escape(o.type)}</small></button>`).join('')??''}</div>${slide?.error?`<div class="notice error">${escape(slide.error)}</div>`:''}`;
  const lockedBy = state.locks.find(l=>l.key.includes(object.id)&&l.actor.id!==state.actor.id);
  const disabled = !canEdit()||!!lockedBy;
  return `${protection}<div class="selected-kind">${escape(object.type)} object</div><h2>${escape(object.role)}</h2>${lockedBy?`<div class="notice">${escape(lockedBy.actor.name)} is moving this object.</div>`:''}${object.type==='text'?`<div class="field-group"><label>Text ${object.binding?'':'· generated / read only'}</label>${object.binding?textArea(object.id,'Object text',object.text??''):`<p class="panel-intro">${escape(object.text)}</p>`}</div>`:''}<div class="field-group"><h3 style="margin-bottom:12px">Position & size</h3><div class="field-grid">${(['x','y','w','h'] as const).map(k=>`<label>${{x:'X position',y:'Y position',w:'Width',h:'Height'}[k]} · in<input type="number" min="${k==='w'||k==='h'?'0.05':'0'}" step="0.05" data-geometry="${k}" value="${object[k].toFixed(3)}" ${disabled?'disabled':''}></label>`).join('')}</div></div><div class="field-group"><h3 style="margin-bottom:12px">Appearance</h3><div class="field-grid"><label>${object.type==='connector'?'Line':'Text'} color<input data-style="color" type="color" value="${color(object.options.color??object.options.line?.color)}" ${disabled?'disabled':''}></label><label>Fill color<input data-style="fill" type="color" value="${color(object.options.fill?.color,'FFFFFF')}" ${disabled?'disabled':''}></label>${object.type==='text'?`<label>Font size · pt<input data-style="fontSize" type="number" min="8" max="96" value="${object.options.fontSize??18}" ${disabled?'disabled':''}></label><label>Weight<select data-style="bold" ${disabled?'disabled':''}><option value="false" ${!object.options.bold?'selected':''}>Regular</option><option value="true" ${object.options.bold?'selected':''}>Bold</option></select></label>`:''}</div></div>${object.type==='image'?`<div class="field-group"><label>Replace illustration<input id="image-upload" type="file" accept="image/png,image/jpeg,image/webp" ${disabled?'disabled':''}></label><small>Stored locally. Accepted illustrations need explicit authorization.</small></div>`:''}${object.type==='chart'?`<div class="field-group"><h3>Chart data</h3><p class="panel-intro">Source data stays native and editable in PowerPoint. Change values in the authoritative source; source bindings are preserved.</p><pre style="font-size:10px;white-space:pre-wrap;max-height:180px;overflow:auto">${escape(JSON.stringify(object.data,null,2))}</pre></div>`:''}<div class="field-group"><button data-action="delete-object" class="danger wide" ${disabled?'disabled':''}>Remove object</button></div>`;
}
function renderComments() {
  const comments = state.comments.filter(c=>c.slideId===slideId&&c.locale===locale);
  const targetLabel=selectedSlide()?.reference?.shapes?.find(s=>s.id===objectId)?.label ?? selectedObject()?.role ?? objectId;
  return `<h2>Slide conversation</h2><p class="panel-intro">${objectId?`Attached to ${escape(targetLabel)}. `:''}Keep feedback attached to the stable slide ID.</p>${comments.length?comments.map(c=>`<article class="comment"><div class="comment-meta"><strong>${escape(c.actor.name)}</strong><time>${new Date(c.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><span class="badge">${escape(c.category)}${c.resolved?' · resolved':''}</span><p class="comment-body">${escape(c.message)}</p>${c.replies.map(r=>`<div style="border-left:2px solid #dce5db;padding-left:10px;margin-top:10px"><small>${escape(r.actor.name)}</small><p class="comment-body">${escape(r.message)}</p></div>`).join('')}<div class="job-actions"><button data-reply="${escape(c.id)}">Reply</button><button data-resolve="${escape(c.id)}" data-resolved="${!c.resolved}">${c.resolved?'Reopen':'Resolve'}</button></div></article>`).join(''):'<p class="empty">No comments here yet. Leave feedback for your collaborators or ask the agent for a proposed change.</p>'}<form id="comment-form" class="comment-form"><label>Feedback<textarea id="comment-message" rows="4" placeholder="What would you like to change?" required maxlength="10000"></textarea></label><label>Category<select id="comment-category">${['content','layout','typography','illustration','translation','scientific-correction','global-theme'].map(c=>`<option>${c}</option>`).join('')}</select></label><label class="check-label"><input id="ask-agent" type="checkbox"> Ask the agent to propose changes</label><small>${state.agentConfigured?'Agent changes appear as reviewable proposals.':'No agent adapter configured. Requests remain visible for an agent to pick up.'}</small><button type="submit" class="primary">Post feedback</button></form>`;
}
function renderActivity() {
  return `<h2>Agent workspace</h2><p class="panel-intro">Follow requests, inspect proposed changes, and apply them when ready.</p>${state.jobs.length?state.jobs.slice().reverse().map(j=>`<article class="job"><div class="job-title"><strong>${escape(j.slideId)}</strong><span class="badge">${escape(j.status)}</span></div><p>${escape(j.message)}</p>${j.summary?`<p style="margin-top:8px">${escape(j.summary)}</p>`:''}${j.error?`<p style="color:#a04d36;margin-top:8px">${escape(j.error)}</p>`:''}${j.operations?.length?`<details><summary style="margin-top:10px;cursor:pointer">Inspect ${j.operations.length} proposed changes</summary><pre>${escape(JSON.stringify(j.operations,null,2))}</pre></details>`:''}<div class="job-actions">${j.status==='proposed'?`<button class="primary" data-job-apply="${escape(j.id)}" ${state.actor.role==='reviewer'?'disabled':''}>Apply proposal</button>`:''}${['failed','conflict','awaiting-agent'].includes(j.status)?`<button data-job-retry="${escape(j.id)}" ${state.actor.role==='reviewer'?'disabled':''}>Retry</button>`:''}</div></article>`).join(''):'<p class="empty">No requests yet. Use Comments to send feedback to the agent.</p>'}<h3 style="margin-top:24px;margin-bottom:10px">Recent changes</h3>${state.history.slice(-15).reverse().map(h=>`<div class="comment"><strong>${escape(h.actor.name)}</strong> · ${escape(h.kind)}<br><small>${escape(h.slideId)} · revision ${h.revision}${h.undone?' · undone':''}</small></div>`).join('')}<h3 style="margin-top:24px">Validation</h3>${state.issues.length?state.issues.map(i=>`<div class="comment"><span class="badge">${escape(i.severity)}</span> ${escape(i.slide??'')}<p>${escape(i.message)}</p></div>`).join(''):'<p class="panel-intro">No source validation issues reported.</p>'}`;
}

function renderPresence() {
  const node = document.querySelector('#presence'); if (!node) return;
  const people = state.presence.filter(p=>p.actor.id!==state.actor.id);
  node.innerHTML = people.slice(0,5).map(p=>`<span class="avatar" title="${escape(p.actor.name)} · ${escape(p.slideId??'browsing')}">${escape(p.actor.name.slice(0,2).toUpperCase())}</span>`).join('')+`<span class="avatar" title="${escape(state.actor.name)} (${escape(state.actor.role)})">${escape(state.actor.name.slice(0,2).toUpperCase())}</span>`;
}
function renderCanvas() {
  const canvas = document.querySelector<HTMLDivElement>('#canvas'), scene = selectedSlide()?.scene;
  if (!canvas || !scene || dragging || canvas.contains(document.activeElement)&&document.activeElement?.matches('textarea')) return;
  canvas.style.backgroundColor = color(scene.background,'FFFFFF');
  canvas.style.aspectRatio = `${scene.width}/${scene.height}`;
  const reference=selectedSlide()?.reference;
  if(reference && viewMode==='reference') {
    const referenceKey=`${slideId}:${reference.image}`;
    if(canvas.dataset.referenceKey===referenceKey && canvas.querySelector('.reference-slide')) return;
    canvas.dataset.referenceKey=referenceKey;
    const video=reference.video;
    const targets=(reference.shapes??[]).filter(shape=>shape.kind!=='video').map(shape=>`<button class="reference-target" data-reference-object="${escape(shape.id)}" title="Comment on ${escape(shape.label)}" aria-label="Comment on ${escape(shape.label)}" style="left:${shape.x/scene.width*100}%;top:${shape.y/scene.height*100}%;width:${shape.w/scene.width*100}%;height:${shape.h/scene.height*100}%"></button>`).join('');
    canvas.innerHTML=`<img class="reference-slide" src="${escape(reference.image)}" alt="Original PowerPoint slide ${escape(slideId)}">${targets}${video?`<video class="reference-video" controls preload="metadata" src="${escape(video.src)}" poster="${escape(video.poster)}" style="left:${video.x/scene.width*100}%;top:${video.y/scene.height*100}%;width:${video.w/scene.width*100}%;height:${video.h/scene.height*100}%" aria-label="Video on slide ${escape(slideId)}"></video>`:''}`;
    return;
  }
  delete canvas.dataset.referenceKey;
  canvas.innerHTML = scene.objects.map(object => objectMarkup(object,scene.width,scene.height)).join('');
  scene.objects.filter(o=>o.role.startsWith('object-')).forEach(o=>{const node=canvas.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(o.id)}"]`);if(node){node.setAttribute('aria-label',objectLabel(o));node.title=o.id;}});
  scene.objects.filter(o=>o.type==='chart').forEach(o=>{const node=canvas.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(o.id)}"]`);if(node)node.style.backgroundColor=color(o.options.chartArea?.fill?.color,'FFFFFF');});
  scene.objects.filter(o=>o.missingTranslation).forEach(o=>{const node=canvas.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(o.id)}"]`);if(node){node.classList.add('missing-translation');if(o.type==='text'&&!o.text){const placeholder=document.createElement('span');placeholder.textContent='Translation missing';placeholder.className='translation-placeholder';node.prepend(placeholder);}}});
  const width = canvas.getBoundingClientRect().width;
  canvas.querySelectorAll<HTMLElement>('[data-font]').forEach(node=> {node.style.fontSize=`${Number(node.dataset.font)*width/scene.width/72}px`;});
}
function objectMarkup(o:SceneObject,width:number,height:number) {
  const options = o.options;
  const style = `left:${o.x/width*100}%;top:${o.y/height*100}%;width:${o.w/width*100}%;height:${o.h/height*100}%;color:${color(options.color)};font-family:${escape(options.fontFace??'Arial')};font-weight:${options.bold?'700':'400'};text-align:${['left','center','right','justify'].includes(options.align)?options.align:'left'};${options.fill?.color?`background:${color(options.fill.color)};`:''}${o.type==='shape'?`border:${options.line?.width??0}px solid ${color(options.line?.color,'FFFFFF')};border-radius:${/ellipse/i.test(o.shape??'')?'50%':/round/i.test(o.shape??'')?'8px':'0'};`:''}`;
  let inside = '';
  if(o.type==='text') inside = escape(docs.get(textKey(slideId,locale,o.id))?.text.toString()??o.text);
  if(o.type==='image') { const src = options.data??(options.path?(String(options.path).startsWith('/api/assets?')?options.path:`/api/assets?path=${encodeURIComponent(options.path)}`):''); inside = src?`<img src="${escape(src)}" alt="${escape(options.altText??o.role)}" style="object-fit:contain">`:'<span>Image unavailable</span>'; }
  if(o.type==='connector') inside = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="arrow-${escape(o.role)}" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="${color(options.line?.color)}"/></marker></defs><line x1="0" y1="${options.flipV?100:0}" x2="100" y2="${options.flipV?0:100}" stroke="${color(options.line?.color)}" stroke-width="${Math.max(1,options.line?.width??1)}" vector-effect="non-scaling-stroke" ${options.line?.endArrowType?`marker-end="url(#arrow-${escape(o.role)})"`:''}/></svg>`;
  if(o.type==='chart') inside = chartMarkup(o);
  return `<div class="scene-object ${o.type} ${o.id===objectId?'selected':''}" data-object-id="${escape(o.id)}" data-font="${options.fontSize??18}" style="${style}" tabindex="0" role="button" aria-label="${escape(o.role)}: ${escape(o.type==='text'?o.text?.slice(0,100):o.type)}">${inside}${o.id===objectId&&canEdit()?'<span class="resize-handle" data-resize="true" aria-label="Resize object"></span>':''}</div>`;
}
function chartMarkup(o:SceneObject) {
  const series = Array.isArray(o.data)?o.data as {name?:string;labels?:string[];values?:number[]}[]:[];
  const all = series.flatMap(s=>s.values??[]), max=Math.max(...all,0),min=Math.min(...all,0), labels=series[0]?.labels??[];
  const toY=(v:number)=>78-(v-min)/Math.max(max-min,1)*62,baseline=toY(0);
  const n=Math.max(labels.length,...series.map(s=>s.values?.length??0),1), colors:string[]=o.options.chartColors?.length?o.options.chartColors:['39755f','91b49d','c8a965','819fb0'];
  let marks='';
  series.forEach((s,si)=>{ (s.values??[]).forEach((v,i)=> {const x=8+i*84/n+si*70/n/Math.max(series.length,1), w=65/n/Math.max(series.length,1),y=toY(v),h=Math.abs(y-baseline); marks+=`<rect x="${x}" y="${Math.min(y,baseline)}" width="${w}" height="${h}" fill="${color(colors[si%colors.length])}"><title>${escape(s.name)} ${escape(labels[i])}: ${v}</title></rect><text x="${x+w/2}" y="${v>=0?y-2:y+4}" text-anchor="middle" font-size="3" fill="#46594c">${v}</text>`;});if(series.length>1)marks+=`<rect x="${8+si*27}" y="3" width="3" height="2" fill="${color(colors[si%colors.length])}"/><text x="${12+si*27}" y="5" font-size="3" fill="#46594c">${escape(s.name)}</text>`;});
  labels.forEach((l,i)=>{marks+=`<text x="${8+(i+.4)*84/n}" y="91" text-anchor="middle" font-size="3" fill="#5e6d60">${escape(l)}</text>`;});
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Editable chart"><line x1="7" y1="${baseline}" x2="96" y2="${baseline}" stroke="#c4cec4" stroke-width=".4"/>${marks}</svg>`;
}

let dragging: {id:string;node:HTMLElement;startX:number;startY:number;x:number;y:number;w:number;h:number;resize:boolean;changed:boolean;revision:number;ready:boolean}|undefined;
let lastPointer:{id:string;time:number}|undefined;
function inlineEdit(id:string) {
  const o=selectedSlide()?.scene?.objects.find(o=>o.id===id);
  if(!o||o.type!=='text'||!o.binding||!canEdit())return;
  objectId=id;dragging=undefined;
  const node=document.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(id)}"]`);if(!node||node.querySelector('textarea'))return;
  node.innerHTML=textArea(id,'Edit slide text',o.text??'');
  const field=node.querySelector<HTMLTextAreaElement>('textarea')!;field.className='inline-text';field.style.fontSize='inherit';field.style.fontFamily='inherit';field.style.fontWeight='inherit';field.style.color='inherit';
  field.addEventListener('keydown',event=>{if(event.key==='Escape'||event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();field.blur();}});
  field.addEventListener('blur',()=>{renderCanvas();});field.focus();field.select();editing=true;
}
app.addEventListener('dblclick',event=>{if((event.target as HTMLElement).closest('textarea'))return;const node=(event.target as HTMLElement).closest<HTMLElement>('[data-object-id]');if(node){event.preventDefault();inlineEdit(node.dataset.objectId!);}});
app.addEventListener('pointerdown',event=> {
  const target = event.target as HTMLElement, node=target.closest<HTMLElement>('[data-object-id]');
  if(target.closest('textarea'))return;
  if(!node) return;
  const id=node.dataset.objectId!;
  if(lastPointer?.id===id&&performance.now()-lastPointer.time<450&&!target.dataset.resize){event.preventDefault();lastPointer=undefined;inlineEdit(id);return;}
  if(objectId!==id) { objectId=id; render(); }
  if(!canEdit()) return;
  const o=selectedObject(); if(!o) return;
  event.preventDefault();
  const current=document.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(id)}"]`)!;
  current.focus({preventScroll:true});
  const d:NonNullable<typeof dragging>={id,node:current,startX:event.clientX,startY:event.clientY,x:o.x,y:o.y,w:o.w,h:o.h,resize:!!target.dataset.resize,changed:false,revision:state.revision,ready:false};dragging=d;
  void request('/api/locks',{slideId,objectId:id}).then(()=>{if(dragging===d)d.ready=true;}).catch(cause=>{dragging=undefined;showError(cause);renderCanvas();});
  void request('/api/presence',{slideId,objectId:id}).catch(()=>{});
});
window.addEventListener('pointermove',event=> {
  const d=dragging,scene=selectedSlide()?.scene,canvas=document.querySelector('#canvas'); if(!d||!d.ready||!scene||!canvas) return;
  const box=canvas.getBoundingClientRect(), dx=(event.clientX-d.startX)/box.width*scene.width,dy=(event.clientY-d.startY)/box.height*scene.height;
  if(Math.abs(dx)+Math.abs(dy)<.01) return; d.changed=true;
  const x=d.resize?d.x:Math.max(0,Math.min(scene.width-d.w,d.x+dx)), y=d.resize?d.y:Math.max(0,Math.min(scene.height-d.h,d.y+dy));
  const w=d.resize?Math.max(.1,Math.min(scene.width-d.x,d.w+dx)):d.w,h=d.resize?Math.max(.1,Math.min(scene.height-d.y,d.h+dy)):d.h;
  Object.assign(d.node.style,{left:`${x/scene.width*100}%`,top:`${y/scene.height*100}%`,width:`${w/scene.width*100}%`,height:`${h/scene.height*100}%`});
  d.node.dataset.pending=JSON.stringify({x,y,w,h});
});
window.addEventListener('pointerup',()=> {
  const d=dragging;if(!d)return;dragging=undefined;
  if(!d.changed)lastPointer={id:d.id,time:performance.now()};
  if(d.changed) void operate('geometry',JSON.parse(d.node.dataset.pending!),d.id,d.revision);
  void request('/api/locks',{slideId,objectId:d.id,release:true}).catch(()=>{});
  if(!d.changed)d.node.focus({preventScroll:true});
});
app.addEventListener('keydown',event=> {
  const node=(event.target as HTMLElement).closest<HTMLElement>('[data-object-id]');
  if((event.target as HTMLElement).matches('textarea'))return;
  if(node&&event.key==='Enter'){event.preventDefault();inlineEdit(node.dataset.objectId!);return;}
  if(!node||!canEdit()||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
  event.preventDefault();objectId=node.dataset.objectId!;const o=selectedObject()!,scene=selectedSlide()!.scene!,step=event.shiftKey?.1:.01;
  void operate('geometry',{x:Math.max(0,Math.min(scene.width-o.w,o.x+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0))),y:Math.max(0,Math.min(scene.height-o.h,o.y+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0))),w:o.w,h:o.h});
});

app.addEventListener('focusin',event=> { if((event.target as HTMLElement).matches('textarea,input:not([type=checkbox]),select')) editing=true; });
app.addEventListener('focusout',event=> {if(!(event.target as HTMLElement).matches('textarea,input:not([type=checkbox]),select'))return;setTimeout(()=>{if(!app.contains(document.activeElement)||!document.activeElement?.matches('textarea,input:not([type=checkbox]),select')) {editing=false;render();}},0); });
app.addEventListener('input',event=> {const field=event.target as HTMLTextAreaElement;if(field.matches('textarea[data-text-key]')) editText(field);});
app.addEventListener('change',event=> {
  const field=event.target as HTMLInputElement;
  if(field.id==='locale') {locale=field.value;objectId='';authorized=false;editing=false;void load();}
  if(field.id==='authorize') {authorized=field.checked;editing=false;render();}
  if(field.dataset.jobAuthorization){if(field.checked)jobAuthorizations.add(field.dataset.jobAuthorization);else jobAuthorizations.delete(field.dataset.jobAuthorization);}
  if(field.dataset.reviewKind)void operate(field.dataset.reviewKind as Operation['kind'],field.value,'');
  if(field.dataset.geometry) { const o=selectedObject()!;void operate('geometry',{x:o.x,y:o.y,w:o.w,h:o.h,[field.dataset.geometry]:Number(field.value)}); }
  if(field.dataset.style) { const key=field.dataset.style;void operate('style',{[key]:key==='fontSize'?Number(field.value):key==='bold'?field.value==='true':field.value.replace('#','')}); }
  if(field.dataset.alt)void operate('text',field.value);
  if(field.id==='image-upload'&&field.files?.[0]) {const file=field.files[0];void request('/api/uploads',undefined,file).then(result=>operate('image',{asset:result.asset})).catch(showError);}
});
app.addEventListener('submit',event=> {
  const form=event.target as HTMLFormElement;
  if(form.id==='native-text-form'){
    event.preventDefault();
    const shape=selectedSlide()?.reference?.shapes?.find(s=>s.id===objectId) as {nativeText?:{runs:{paragraph:number;run:number;text:string}[]}}|undefined;
    if(!shape?.nativeText)return;
    const fields=[...form.querySelectorAll<HTMLTextAreaElement>('[data-native-run]')];
    const runs=shape.nativeText.runs.map((run,index)=>({...run,text:fields[index]?.value??run.text}));
    const expectedRevision=Number(form.dataset.baseRevision);
    void request('/api/operations',{slideId,locale,objectId,expectedRevision,kind:'native-text',value:{runs},authorize:authorized?[slideId]:[]}).then(()=>{editing=false;render();inform('Text saved. The slide preview updates automatically.');}).catch(showError);
    return;
  }
  if(form.id!=='comment-form')return;event.preventDefault();
  const message=document.querySelector<HTMLTextAreaElement>('#comment-message')!.value;
  const category=document.querySelector<HTMLSelectElement>('#comment-category')!.value;
  const askAgent=document.querySelector<HTMLInputElement>('#ask-agent')!.checked;
  editing=false;void request('/api/comments',{slideId,locale,objectId:objectId||undefined,message,category,askAgent}).then(()=>{if(askAgent){tab='activity';render();}}).catch(showError);
});
app.addEventListener('click',event=> {
  const element=(event.target as HTMLElement).closest<HTMLElement>('button');if(!element)return;
  const data=element.dataset;
  if(data.referenceObject){objectId=data.referenceObject;tab='properties';editing=false;render();void request('/api/presence',{slideId,objectId}).catch(()=>{});return;}
  if(data.discard){const key=data.discard;docs.get(key)?.doc.destroy();docs.delete(key);drafts.delete(key);if(state.texts[key])syncDoc(key,state.texts[key]);editing=false;render();}
  if(data.restore){const key=data.restore,[slideId,locale,objectId]=key.split('|');void request('/api/operations',{slideId,locale,objectId,expectedRevision:state.revision,kind:'text',value:drafts.get(key),authorize:authorized?[slideId]:[]}).then(()=>{drafts.delete(key);editing=false;render();}).catch(showError);}
  if(data.slide){slideId=data.slide;objectId='';authorized=false;editing=false;render();void request('/api/presence',{slideId}).catch(()=>{});}
  if(data.tab){tab=data.tab;editing=false;render();}
  if(data.objectSelect){objectId=data.objectSelect;render();}
  if(data.resolve)void request(`/api/comments/${encodeURIComponent(data.resolve)}/resolve`,{resolved:data.resolved==='true'}).catch(showError);
  if(data.reply){const message=prompt('Reply to this comment');if(message?.trim())void request(`/api/comments/${encodeURIComponent(data.reply)}/reply`,{message}).catch(showError);}
  if(data.jobApply){const job=state.jobs.find(j=>j.id===data.jobApply)!;void request(`/api/jobs/${encodeURIComponent(data.jobApply)}/apply`,{authorize:jobAuthorizations.has(job.id)?[job.slideId]:[]}).catch(showError);}
  if(data.jobRetry)void request(`/api/jobs/${encodeURIComponent(data.jobRetry)}/retry`,{}).catch(showError);
  if(data.historyUndo)void request('/api/undo',{id:data.historyUndo,expectedRevision:state.revision,authorize:authorized?[slideId]:[]}).catch(showError);
  if(data.action==='dismiss'){notice='';renderNotice();}
  if(data.action==='reference-view'||data.action==='draft-view'){viewMode=data.action==='reference-view'?'reference':'draft';objectId='';editing=false;render();}
  if(data.action==='export-menu'){const menu=document.querySelector<HTMLElement>('#export-options')!;menu.hidden=!menu.hidden;}
  if(data.action==='export'||data.action==='export-render')void exportDeck(data.action==='export-render');
  if(data.action==='undo'){const h=state.history.slice().reverse().find(h=>h.actor.id===state.actor.id&&h.slideId===slideId&&!h.undone);if(h)void request('/api/undo',{id:h.id,expectedRevision:state.revision,authorize:authorized?[slideId]:[]}).catch(showError);}
  if(data.action==='delete-object')void operate('delete',null);
  if(data.action==='add-text')void addObject({type:'text',text:'New text',w:4,h:.7,style:{fontSize:24,color:'263430'}}).catch(showError);
  if(data.action==='add-image')imageDialog();
  if(data.action==='add-shape')void addObject({type:'shape',w:2,h:1.2,style:{fill:'DCE9DF',color:'216957'}}).catch(showError);
});
async function exportDeck(renderPreview:boolean) {
  exportBusy=true;render();
  try {const result=await request('/api/export',{locale,render:renderPreview}); downloads=Array.isArray(result.files)?result.files.filter((f:unknown)=>typeof f==='string'):[];previewLocale=result.render?.available?locale:'';inform(`Export complete.${result.render?.message?` ${result.render.message}`:''}`);}
  catch(cause){showError(cause);}finally{exportBusy=false;render();}
}
async function load() {
  events?.close();
  try { const snapshot=await request(`/api/state${locale?`?locale=${encodeURIComponent(locale)}`:''}`);accept(snapshot.state??snapshot);connect(); }
  catch(cause){ if(!state)joinScreen(cause instanceof Error&& !/401|unauthorized|join|authentication/i.test(cause.message)?cause.message:'');else showError(cause); }
}
function connect() {
  events=new EventSource(`/api/events?locale=${encodeURIComponent(locale)}`);
  events.addEventListener('state',event=> {online=true;accept(JSON.parse((event as MessageEvent).data));});
  events.addEventListener('presence',()=>{void request(`/api/state?locale=${encodeURIComponent(locale)}`).then(s=>accept(s.state??s)).catch(()=>{});});
  events.onopen=()=>{online=true;if(!editing&&!dragging)render();};events.onerror=()=>{online=false;if(!editing&&!dragging)render();};
}
function joinScreen(message='') {
  const hash=new URLSearchParams(location.hash.slice(1));
  app.innerHTML=`<main class="join-screen"><form id="join-form" class="join-card"><div class="brand">PPT<span>imistic</span></div><h1>A shared space for<br>your next presentation.</h1><p>Join this local session to work on editable slides, leave feedback, and review agent proposals together.</p><label>Your name<input id="join-name" autocomplete="name" required maxlength="100" placeholder="How should we call you?"></label><label>Session token<input id="join-token" type="password" autocomplete="off" required value="${escape(hash.get('token')??'')}" placeholder="Paste your invitation token"></label><div id="join-error" class="join-error" role="alert">${escape(message)}</div><button type="submit" class="primary">Join the studio →</button><p style="font-size:10px;margin:16px 0 0">Files stay with the local session server. Your role is determined by your invitation.</p></form></main>`;
  document.querySelector('#join-form')!.addEventListener('submit',event=> {event.preventDefault();const name=document.querySelector<HTMLInputElement>('#join-name')!.value,token=document.querySelector<HTMLInputElement>('#join-token')!.value;void request('/api/join',{name,token}).then(()=>{history.replaceState(null,'',location.pathname+location.search);return load();}).catch(cause=>{document.querySelector('#join-error')!.textContent=cause.message;});});
}
new ResizeObserver(()=>renderCanvas()).observe(app);
setInterval(()=>{if(state)void request('/api/presence',{slideId,objectId:objectId||undefined}).catch(()=>{});},10000);
app.innerHTML='<div class="loading">Opening your shared studio…</div>';
void load();
