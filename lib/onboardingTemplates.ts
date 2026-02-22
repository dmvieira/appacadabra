/**
 * Onboarding spell templates — pre-built HTML mini-apps.
 * Each factory receives a translation fn and returns { name, code, shortDescription }.
 *
 * Templates showcase Appacadabra native bridges (injected by injectedJS.ts):
 *   - AppacadabraAI          → AI suggestions, workout plans, receipt OCR, audio transcription
 *   - AppacadabraHealth      → Steps, exercise, calories for workout plans
 *   - AppacadabraContacts    → Emergency contact for mood diary
 *   - AppacadabraCamera      → Receipt photo capture for expenses
 *   - AppacadabraAudio       → Voice input for expenses
 *   - AppacadabraNotify      → Reminders and notifications
 *   - AppacadabraShare       → Share content
 *   - AppacadabraScreen      → Print lists
 *   - AppacadabraDevice      → Vibrate, language
 *   - localStorage           → Auto-synced to native DB via bridge
 *
 * Callback pattern: global window functions passed as string names.
 */

type T = (key: string) => string;

/** Escapes single quotes for JS string literals */
function jsEsc(s: string) {
  return s.replace(/'/g, "\\'");
}

/* ─── shared CSS tokens ─── */
const CSS_VARS = `--bg:#0f0f1a;--card:#1a1a2e;--primary:#7c3aed;--accent:#a78bfa;--text:#e2e8f0;--dim:#94a3b8;--green:#22c55e;--red:#ef4444;--border:#2d2d44;--yellow:#eab308`;
const CSS_RESET = `*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}`;
const CSS_HEADER = `header{padding:20px;text-align:center;background:linear-gradient(135deg,#1e1e3a,var(--bg));border-bottom:1px solid var(--border)}header h1{font-size:1.4rem;color:var(--accent)}`;
const CSS_TOOLBAR = `.toolbar{display:flex;gap:8px;padding:8px 12px;justify-content:center;flex-wrap:wrap}.toolbar button{padding:8px 14px;border:none;border-radius:8px;background:var(--card);color:var(--dim);font-size:.8rem;cursor:pointer;border:1px solid var(--border);transition:all .2s}.toolbar button:active{background:var(--primary);color:#fff;transform:scale(.96)}`;
const CSS_EMPTY = `.empty{text-align:center;padding:40px;color:var(--dim);font-size:.9rem}`;
const CSS_TOAST = `.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--primary);color:#fff;padding:10px 24px;border-radius:10px;font-size:.85rem;opacity:0;transition:opacity .3s;pointer-events:none;z-index:99}.toast.show{opacity:1}`;
const CSS_LOADING = `.loading{display:inline-block;width:16px;height:16px;border:2px solid var(--dim);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`;

/* ─── shared JS helpers ─── */
function sharedJS(reminderSetLabel: string): string {
  const label = jsEsc(reminderSetLabel);
  return `
function showToast(msg){var t=document.getElementById('toast');if(!t)return;t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2500)}
window.handleNotifyResult=function(success,id){if(success){showToast(window._notifyPendingMsg||'${label}');if(typeof AppacadabraDevice!=='undefined')AppacadabraDevice.vibrate(50)}};
window.handleShareResult=function(success,result){console.log('Share result:',success,result)};
function vib(ms){if(typeof AppacadabraDevice!=='undefined')AppacadabraDevice.vibrate(ms||30)}
`;
}

/** 🛒 Shopping List — with AI suggestions & Print */
export function shoppingListTemplate(t: T) {
  const title = t('tplShoppingTitle');
  return {
    name: title,
    shortDescription: t('obChipShoppingFull'),
    code: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${title}</title>
<style>
:root{${CSS_VARS}}
${CSS_RESET}
${CSS_HEADER}
${CSS_TOOLBAR}
${CSS_EMPTY}
${CSS_TOAST}
${CSS_LOADING}
.add-bar{display:flex;gap:8px;padding:12px}
.add-bar input{flex:1;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:1rem;outline:none}
.add-bar input:focus{border-color:var(--accent)}
.add-bar button{padding:12px 18px;border:none;border-radius:10px;background:var(--primary);color:#fff;font-weight:bold;font-size:1rem;cursor:pointer}
.add-bar button:active{transform:scale(.96)}
.list{padding:0 12px 80px}
.item{display:flex;align-items:center;gap:12px;padding:14px;margin:6px 0;background:var(--card);border-radius:10px;border:1px solid var(--border);transition:opacity .3s}
.item.done{opacity:.45;text-decoration:line-through}
.item .check{width:24px;height:24px;border-radius:50%;border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
.item.done .check{background:var(--green);border-color:var(--green)}
.item .check::after{content:"✓";color:#fff;font-size:14px;display:none}
.item.done .check::after{display:block}
.item .name{flex:1;font-size:1rem}
.item .del{color:var(--dim);cursor:pointer;font-size:1.2rem;padding:4px 8px}
.suggestions{padding:0 12px}
.suggestions .chip{display:inline-block;padding:8px 14px;margin:3px;border-radius:20px;background:rgba(124,58,237,.15);color:var(--accent);font-size:.85rem;cursor:pointer;border:1px solid rgba(167,139,250,.3);transition:all .2s}
.suggestions .chip:active{background:var(--primary);color:#fff;transform:scale(.95)}
.suggest-label{padding:4px 12px;color:var(--dim);font-size:.8rem;display:flex;align-items:center;gap:6px}
</style>
</head>
<body>
<header><h1>🛒 ${title}</h1></header>
<div class="toolbar">
  <button onclick="shareList()">📤 ${t('tplShareList')}</button>
  <button onclick="printList()">🖨️ ${t('tplPrint')}</button>
  <button onclick="suggestItems()">🤖 ${t('tplAISuggest')}</button>
  <button onclick="setReminder()">🔔 ${t('tplSetReminder')}</button>
</div>
<div class="add-bar">
  <input id="inp" placeholder="${t('tplShoppingPlaceholder')}">
  <button onclick="addItem()">${t('tplAdd')}</button>
</div>
<div class="suggestions" id="suggestions"></div>
<div id="list" class="list"></div>
<div class="toast" id="toast"></div>
<script>
${sharedJS(t('tplReminderSet'))}
console.log('🛒 Shopping List Template Loaded');
console.log('Bridges check: AI:', typeof AppacadabraAI!=='undefined', 'Share:', typeof AppacadabraShare!=='undefined', 'Screen:', typeof AppacadabraScreen!=='undefined');

var items=[];
try {
  items=JSON.parse(localStorage.getItem('shop_items')||'[]');
} catch(e) { console.error('Error parsing shopping items:', e); }

function save(){localStorage.setItem('shop_items',JSON.stringify(items));render()}
function addItem(){var v=document.getElementById('inp').value.trim();if(!v)return;items.unshift({n:v,d:false});document.getElementById('inp').value='';vib(30);save()}
document.getElementById('inp').addEventListener('keydown',function(e){if(e.key==='Enter')addItem()});
function toggle(i){items[i].d=!items[i].d;if(items[i].d)vib([20,30,20]);save()}
function del(i){items.splice(i,1);save()}
function render(){var el=document.getElementById('list');if(!items.length){el.innerHTML='<div class="empty">${jsEsc(t('tplShoppingEmpty'))}</div>';return}
el.innerHTML=items.map(function(it,i){return '<div class="item'+(it.d?' done':'')+'"><div class="check" onclick="toggle('+i+')"></div><span class="name">'+it.n+'</span><span class="del" onclick="del('+i+')">✕</span></div>'}).join('')}
function shareList(){if(typeof AppacadabraShare==='undefined'){ console.warn('Share bridge missing'); return; }var text=items.map(function(it){return (it.d?'✅':'⬜')+' '+it.n}).join('\\n');AppacadabraShare.share('🛒 ${jsEsc(title)}\\n'+text,'','handleShareResult')}
function printList(){if(typeof AppacadabraScreen!=='undefined'){ AppacadabraScreen.print(); } else { console.warn('Screen bridge missing'); }}
function setReminder(){if(typeof AppacadabraNotify==='undefined'){ console.warn('Notify bridge missing'); return; }window._notifyPendingMsg='${jsEsc(t('tplReminder1Hour'))}';AppacadabraNotify.schedule('🛒 ${jsEsc(title)}','${jsEsc(t('tplNotifyShopping'))}',60,'handleNotifyResult')}
function suggestItems(){if(typeof AppacadabraAI==='undefined'){ console.warn('AI bridge missing'); return; }var sg=document.getElementById('suggestions');sg.innerHTML='<div class="suggest-label"><span class="loading"></span> ${jsEsc(t('tplAIThinking'))}</div>';var recent=items.map(function(it){return it.n}).join(', ');var prompt='Given this shopping list: ['+recent+']. Suggest 5 more items the user might need. Reply with a JSON array of strings only, no explanation. Example: ["Milk","Bread","Eggs","Butter","Cheese"]';window.handleAISuggest=function(success,result){console.log('AI Suggest Success:', success);if(!success){sg.innerHTML='';return}try{var arr=JSON.parse(result);sg.innerHTML=arr.map(function(s){return '<span class=\"chip\" onclick=\"addSuggestion(this)\">+ '+s+'</span>'}).join('');localStorage.setItem('shop_ai_cache',result)}catch(e){console.error('AI Suggest Parse Error:', e);sg.innerHTML=''}};var cached=localStorage.getItem('shop_ai_cache');if(cached&&items.length<2){window.handleAISuggest(true,cached);return}AppacadabraAI.withSchema({type:'array',items:{type:'string'}}).generate(prompt,'handleAISuggest')}
function addSuggestion(el){var name=el.textContent.replace('+ ','').trim();items.unshift({n:name,d:false});el.remove();vib(30);save()}
render();
</script>
</body></html>`
  };
}

/** 📓 Mood Diary — with Emergency Contact */
export function moodDiaryTemplate(t: T) {
  const title = t('tplDiaryTitle');
  return {
    name: title,
    shortDescription: t('obChipDiaryFull'),
    code: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${title}</title>
<style>
:root{${CSS_VARS}}
${CSS_RESET}
${CSS_HEADER}
${CSS_TOOLBAR}
${CSS_EMPTY}
${CSS_TOAST}
.moods{display:flex;justify-content:center;gap:12px;padding:20px}
.mood-btn{font-size:2rem;padding:12px;border-radius:14px;border:2px solid var(--border);background:var(--card);cursor:pointer;transition:all .2s}
.mood-btn.sel{border-color:var(--accent);background:rgba(124,58,237,.2);transform:scale(1.1)}
.note-area{padding:0 16px}
.note-area textarea{width:100%;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:1rem;resize:none;height:80px;outline:none}
.note-area textarea:focus{border-color:var(--accent)}
.save-btn{display:block;margin:12px auto;padding:12px 40px;border:none;border-radius:10px;background:var(--primary);color:#fff;font-weight:bold;font-size:1rem;cursor:pointer}
.save-btn:active{transform:scale(.96)}
.save-btn:disabled{opacity:.4}
.history{padding:12px 16px 80px}
.history h2{font-size:1rem;color:var(--dim);margin-bottom:8px}
.entry{display:flex;align-items:center;gap:12px;padding:12px;margin:6px 0;background:var(--card);border-radius:10px;border:1px solid var(--border)}
.entry .emoji{font-size:1.6rem}
.entry .info{flex:1}
.entry .date{font-size:.75rem;color:var(--dim)}
.entry .txt{font-size:.9rem;margin-top:2px}
.sos-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;margin:8px 16px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:12px}
.sos-bar .sos-name{flex:1;font-size:.9rem;color:var(--text)}
.sos-bar .sos-call{padding:8px 16px;border:none;border-radius:8px;background:var(--red);color:#fff;font-weight:bold;font-size:.85rem;cursor:pointer}
.sos-bar .sos-call:active{transform:scale(.96)}
.sos-bar .sos-pick{padding:8px 12px;border:none;border-radius:8px;background:var(--card);color:var(--dim);font-size:.8rem;cursor:pointer;border:1px solid var(--border)}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:1000}
.modal-content{position:absolute;bottom:0;left:0;width:100%;background:var(--bg);border-radius:20px 20px 0 0;padding:20px;max-height:80vh;overflow-y:auto;box-sizing:border-box}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.modal-header h3{margin:0;font-size:1.1rem}
.close-modal{font-size:1.5rem;cursor:pointer;color:var(--dim)}
.search-box{width:100%;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);margin-bottom:16px;box-sizing:border-box;outline:none}
.search-box:focus{border-color:var(--accent)}
.contact-item{padding:12px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .2s}
.contact-item:active{background:var(--card)}
.contact-name{font-weight:bold;font-size:.95rem}
.contact-phone{font-size:.8rem;color:var(--dim)}
.loading{text-align:center;padding:20px;color:var(--dim)}
</style>
</head>
<body>
<header><h1>📓 ${title}</h1></header>
<div class="toolbar">
  <button onclick="shareSummary()">📤 ${t('tplShareSummary')}</button>
  <button onclick="setReminder()">🔔 ${t('tplSetReminder')}</button>
</div>
<div id="sosBar" class="sos-bar" style="display:none">
  <span style="font-size:1.4rem">🆘</span>
  <div class="sos-name" id="sosName"></div>
  <button class="sos-call" id="sosCallBtn" onclick="callEmergency()">${t('tplCall')}</button>
  <button class="sos-pick" onclick="pickContact()">✏️</button>
</div>
<div id="sosSetup" style="padding:10px 16px">
  <button onclick="pickContact()" style="width:100%;padding:14px;border:none;border-radius:12px;background:rgba(239,68,68,.1);color:var(--red);font-size:.9rem;font-weight:bold;cursor:pointer;border:1px dashed rgba(239,68,68,.4);display:flex;align-items:center;justify-content:center;gap:8px"><span>🆘</span> ${t('tplSetEmergency')}</button>
</div>
<div class="moods" id="moods"></div>
<div class="note-area">
  <textarea id="note" placeholder="${t('tplDiaryPlaceholder')}"></textarea>
</div>
<button class="save-btn" id="saveBtn" onclick="saveEntry()" disabled>${t('tplDiarySave')}</button>
<div class="history">
  <h2>${t('tplDiaryHistory')}</h2>
  <div id="entries"></div>
</div>
<div class="toast" id="toast"></div>

<div id="contactModal" class="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h3>${t('tplContactSelectTitle')}</h3>
      <span class="close-modal" onclick="closeContactModal()">✕</span>
    </div>
    <input type="text" id="contactSearch" class="search-box" placeholder="${t('tplContactSearchPlaceholder')}" oninput="onSearchInput()">
    <div id="contactList"></div>
  </div>
</div>

<script>
${sharedJS(t('tplReminderSet'))}
console.log('📓 Mood Diary Template Loaded');

var MOODS=['😄','🙂','😐','😢','😡'];
var sel=null, entries=[], emergencyContact=null, allContacts=[];
try {
  entries=JSON.parse(localStorage.getItem('mood_entries')||'[]');
  emergencyContact=JSON.parse(localStorage.getItem('mood_emergency')||'null');
} catch(e) { console.error('Mood parsing error:', e); }

var md=document.getElementById('moods');
MOODS.forEach(function(m,i){var b=document.createElement('div');b.className='mood-btn';b.textContent=m;b.onclick=function(){sel=i;document.querySelectorAll('.mood-btn').forEach(function(x){x.classList.remove('sel')});b.classList.add('sel');document.getElementById('saveBtn').disabled=false;vib(30)};md.appendChild(b)});

function saveEntry(){if(sel===null)return;entries.unshift({m:MOODS[sel],t:document.getElementById('note').value.trim(),d:Date.now()});localStorage.setItem('mood_entries',JSON.stringify(entries));document.getElementById('note').value='';sel=null;document.querySelectorAll('.mood-btn').forEach(function(x){x.classList.remove('sel')});document.getElementById('saveBtn').disabled=true;vib([20,30,20]);render()}

function render(){var el=document.getElementById('entries');if(!entries.length){el.innerHTML='<div class="empty">${jsEsc(t('tplDiaryEmpty'))}</div>';return}
el.innerHTML=entries.slice(0,30).map(function(e){return '<div class="entry"><span class="emoji">'+e.m+'</span><div class="info"><div class="date">'+new Date(e.d).toLocaleString()+'</div>'+(e.t?'<div class="txt">'+e.t+'</div>':'')+'</div></div>'}).join('')}

function shareSummary(){if(typeof AppacadabraShare==='undefined'||!entries.length){ console.warn('Share missing or no entries'); return; }var last5=entries.slice(0,5).map(function(e){return e.m+' '+new Date(e.d).toLocaleDateString()+(e.t?' — '+e.t:'')}).join('\\n');AppacadabraShare.share('📓 ${jsEsc(title)}\\n'+last5,'','handleShareResult')}

function setReminder(){if(typeof AppacadabraNotify==='undefined'){ console.warn('Notify bridge missing'); return; }window._notifyPendingMsg='${jsEsc(t('tplReminderTomorrow'))}';AppacadabraNotify.schedule('📓 ${jsEsc(title)}','${jsEsc(t('tplNotifyDiary'))}',1440,'handleNotifyResult')}

function renderSOS(){if(emergencyContact&&emergencyContact.phone){document.getElementById('sosBar').style.display='flex';document.getElementById('sosSetup').style.display='none';document.getElementById('sosName').textContent=emergencyContact.name||emergencyContact.phone}else{document.getElementById('sosBar').style.display='none';document.getElementById('sosSetup').style.display='block'}}

function callEmergency(){if(!emergencyContact||!emergencyContact.phone)return;if(typeof AppacadabraDevice!=='undefined'){AppacadabraDevice.vibrate([100,50,100]);AppacadabraDevice.openBrowser('tel:'+emergencyContact.phone)}}

function pickContact(){
  document.getElementById('contactModal').style.display='block';
  document.getElementById('contactSearch').value='';
  document.getElementById('contactSearch').focus();
  doSearch('');
}

function onSearchInput(){
  var q=document.getElementById('contactSearch').value;
  doSearch(q);
}

function doSearch(q){
  if(typeof AppacadabraContacts==='undefined')return;
  document.getElementById('contactList').innerHTML='<div class="loading">${jsEsc(t('tplAIThinking'))}</div>';
  window.handleContactSearch=function(success,result){
    if(!success)return;
    try{
      allContacts=JSON.parse(result);
      renderContacts();
    }catch(e){console.error('Contact parse error:',e)}
  };
  AppacadabraContacts.search(q,'handleContactSearch');
}

function renderContacts(){
  var el=document.getElementById('contactList');
  if(!allContacts.length){
    el.innerHTML='<div class="empty">${jsEsc(t('tplContactEmpty'))}</div>';
    return;
  }
  el.innerHTML=allContacts.slice(0,50).map(function(c,i){
    var n=c.name||c.firstName||'${jsEsc(t('tplContactNoName'))}';
    var p=(c.phoneNumbers&&c.phoneNumbers.length>0)?c.phoneNumbers[0].number:'';
    return '<div class="contact-item" onclick="selectContact('+i+')"><div class="contact-name">'+n+'</div><div class="contact-phone">'+p+'</div></div>';
  }).join('');
}

function selectContact(i){
  var c=allContacts[i];
  if(!c)return;
  emergencyContact={name:c.name||c.firstName||'',phone:(c.phoneNumbers&&c.phoneNumbers.length>0)?c.phoneNumbers[0].number:''};
  localStorage.setItem('mood_emergency',JSON.stringify(emergencyContact));
  renderSOS();
  closeContactModal();
  showToast('${jsEsc(t('tplContactUpdated'))}');
  vib(50);
}

function closeContactModal(){document.getElementById('contactModal').style.display='none'}

renderSOS();
render();
</script>
</body></html>`
  };
}

/** 💪 Workout Tracker — with AI plans & Health data */
export function workoutTemplate(t: T) {
  const title = t('tplWorkoutTitle');
  return {
    name: title,
    shortDescription: t('obChipWorkoutFull'),
    code: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${title}</title>
<style>
:root{${CSS_VARS}}
${CSS_RESET}
${CSS_HEADER}
${CSS_TOOLBAR}
${CSS_TOAST}
${CSS_LOADING}
.timer{text-align:center;padding:20px}
.timer .time{font-size:3rem;font-weight:bold;font-family:monospace;color:var(--accent)}
.timer .btns{display:flex;gap:10px;justify-content:center;margin-top:12px}
.timer .btns button{padding:10px 24px;border:none;border-radius:10px;font-weight:bold;font-size:.9rem;cursor:pointer}
.timer .btns button:active{transform:scale(.96)}
.btn-start{background:var(--green);color:#fff}
.btn-stop{background:#ef4444;color:#fff}
.btn-reset{background:var(--card);color:var(--dim);border:1px solid var(--border)!important}
.health-banner{margin:0 16px;padding:12px;background:var(--card);border-radius:10px;border:1px solid var(--border);display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.health-stat{text-align:center}
.health-stat .val{font-size:1.3rem;font-weight:bold;color:var(--accent)}
.health-stat .lbl{font-size:.7rem;color:var(--dim);margin-top:2px}
.ai-plan{margin:12px 16px;padding:14px;background:rgba(124,58,237,.08);border-radius:12px;border:1px solid rgba(167,139,250,.2)}
.ai-plan h3{font-size:.9rem;color:var(--accent);margin-bottom:8px}
.ai-plan .ex-item{padding:8px 0;border-bottom:1px solid var(--border);font-size:.9rem;color:var(--text);cursor:pointer}
.ai-plan .ex-item:last-child{border-bottom:none}
.ai-plan .ex-item:active{color:var(--accent)}
.exercises{padding:0 16px 80px}
.exercises h2{font-size:1rem;color:var(--dim);margin:16px 0 8px}
.ex{padding:14px;margin:6px 0;background:var(--card);border-radius:10px;border:1px solid var(--border)}
.ex .row{display:flex;justify-content:space-between;align-items:center}
.ex .name{font-weight:bold;font-size:1rem}
.ex .done-btn{padding:6px 16px;border:none;border-radius:8px;background:var(--primary);color:#fff;font-size:.85rem;cursor:pointer}
.ex .done-btn.completed{background:var(--green)}
.add-ex{display:flex;gap:8px;padding:12px 16px}
.add-ex input{flex:1;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:.9rem;outline:none}
.add-ex button{padding:10px 16px;border:none;border-radius:10px;background:var(--primary);color:#fff;font-weight:bold;cursor:pointer}
</style>
</head>
<body>
<header><h1>💪 ${title}</h1></header>
<div class="toolbar">
  <button onclick="generatePlan()">🤖 ${t('tplAIPlan')}</button>
  <button onclick="loadHealth()">❤️ ${t('tplHealthData')}</button>
  <button onclick="shareSummary()">📤 ${t('tplShareSummary')}</button>
  <button onclick="setReminder()">🔔 ${t('tplSetReminder')}</button>
</div>
<div id="healthBanner" class="health-banner" style="display:none"></div>
<div class="timer">
  <div class="time" id="clock">00:00</div>
  <div class="btns">
    <button class="btn-start" id="startBtn" onclick="startTimer()">${t('tplWorkoutStart')}</button>
    <button class="btn-stop" id="stopBtn" onclick="stopTimer()" style="display:none">${t('tplWorkoutStop')}</button>
    <button class="btn-reset" onclick="resetTimer()">${t('tplWorkoutReset')}</button>
  </div>
</div>
<div id="aiPlan"></div>
<div class="add-ex">
  <input id="exInp" placeholder="${t('tplWorkoutPlaceholder')}">
  <button onclick="addEx()">${t('tplAdd')}</button>
</div>
<div class="exercises">
  <h2>${t('tplWorkoutExercises')}</h2>
  <div id="exList"></div>
</div>
<div class="toast" id="toast"></div>
<script>
${sharedJS(t('tplReminderSet'))}
console.log('💪 Workout Template Loaded');
console.log('Bridges check: Health:', typeof AppacadabraHealth!=='undefined', 'AI:', typeof AppacadabraAI!=='undefined', 'Notify:', typeof AppacadabraNotify!=='undefined');

var secs=0,tid=null,exercises=[];
try {
  exercises=JSON.parse(localStorage.getItem('workout_ex')||'[]');
} catch(e) { console.error('Workout parsing error:', e); }

var healthData=null;
function pad(n){return n<10?'0'+n:''+n}
function updateClock(){var m=Math.floor(secs/60),s=secs%60;document.getElementById('clock').textContent=pad(m)+':'+pad(s)}
function startTimer(){if(tid)return;document.getElementById('startBtn').style.display='none';document.getElementById('stopBtn').style.display='';vib(50);tid=setInterval(function(){secs++;updateClock()},1000)}
function stopTimer(){clearInterval(tid);tid=null;document.getElementById('startBtn').style.display='';document.getElementById('stopBtn').style.display='none';vib([50,30,50]);if(secs>0&&typeof AppacadabraNotify!=='undefined'){AppacadabraNotify.showNow('💪 ${jsEsc(title)}',pad(Math.floor(secs/60))+':'+pad(secs%60)+' ✅','handleNotifyResult')}}
function resetTimer(){stopTimer();secs=0;updateClock()}
function addEx(){var v=document.getElementById('exInp').value.trim();if(!v)return;exercises.push({n:v,d:false});document.getElementById('exInp').value='';save()}
function addExFromPlan(name){exercises.push({n:name,d:false});vib(30);save();showToast('+ '+name)}
function toggleEx(i){exercises[i].d=!exercises[i].d;if(exercises[i].d)vib([20,30,20]);save()}
function save(){localStorage.setItem('workout_ex',JSON.stringify(exercises));render()}
function render(){var el=document.getElementById('exList');el.innerHTML=exercises.map(function(e,i){return '<div class="ex"><div class="row"><span class="name">'+e.n+'</span><button class="done-btn'+(e.d?' completed':'')+'" onclick="toggleEx('+i+')">'+(e.d?'✓':'${jsEsc(t('tplWorkoutDone'))}')+'</button></div></div>'}).join('')}
function loadHealth(){if(typeof AppacadabraHealth==='undefined'){showToast('${jsEsc(t('tplHealthUnavailable'))}'); console.warn('Health missing'); return}var now=Date.now();var dayAgo=now-86400000;var banner=document.getElementById('healthBanner');banner.style.display='flex';banner.innerHTML='<span class="loading"></span>';window.handleSteps=function(success,result){console.log('Steps Success:', success);if(!success)return;try{var d=JSON.parse(result);healthData=healthData||{};healthData.steps=d.totalSteps||0;renderHealth()}catch(e){console.error('Steps Parse Error:', e)}};window.handleCalories=function(success,result){console.log('Calories Success:', success);if(!success)return;try{var d=JSON.parse(result);healthData=healthData||{};healthData.calories=Math.round(d.totalCalories||0);renderHealth()}catch(e){console.error('Calories Parse Error:', e)}};AppacadabraHealth.getSteps(dayAgo,now,'handleSteps');AppacadabraHealth.getCalories(dayAgo,now,'handleCalories')}
function renderHealth(){if(!healthData)return;var banner=document.getElementById('healthBanner');var html='';if(healthData.steps!==undefined)html+='<div class="health-stat"><div class="val">🚶 '+healthData.steps.toLocaleString()+'</div><div class="lbl">${jsEsc(t('tplStepsToday'))}</div></div>';if(healthData.calories!==undefined)html+='<div class="health-stat"><div class="val">🔥 '+healthData.calories+'</div><div class="lbl">${jsEsc(t('tplCalToday'))}</div></div>';banner.innerHTML=html;banner.style.display='flex'}
function generatePlan(){if(typeof AppacadabraAI==='undefined'){ console.warn('AI missing'); return; }var plan=document.getElementById('aiPlan');plan.innerHTML='<div class="ai-plan"><div class="suggest-label"><span class="loading"></span> ${jsEsc(t('tplAIThinking'))}</div></div>';var context='Generate a workout plan.';if(healthData){context+=' User health today: '+healthData.steps+' steps, '+healthData.calories+' calories burned.'}context+=' Return JSON array of 6 exercise objects with name and sets fields. Example: [{"name":"Push-ups","sets":"3x15"},{"name":"Squats","sets":"3x20"}]';window.handleAIPlan=function(success,result){console.log('AI Plan Success:', success);if(!success){plan.innerHTML='';return}try{var arr=JSON.parse(result);plan.innerHTML='<div class="ai-plan"><h3>🤖 ${jsEsc(t('tplAIPlan'))}</h3>'+arr.map(function(e){return '<div class=\"ex-item\" onclick=\"addExFromPlan(\\''+e.name.replace(/'/g,"\\\\'")+'\\')\">'+(e.name)+' — '+(e.sets||'')+' <span style=\"color:var(--dim)\">+</span></div>'}).join('')+'</div>';localStorage.setItem('workout_ai_cache',result)}catch(e){console.error('AI Plan Parse Error:', e);plan.innerHTML=''}};var cached=localStorage.getItem('workout_ai_cache');if(cached&&!healthData){window.handleAIPlan(true,cached);return}AppacadabraAI.withSchema({type:'array',items:{type:'object',properties:{name:{type:'string'},sets:{type:'string'}},required:['name','sets']}}).generate(context,'handleAIPlan')}
function shareSummary(){if(typeof AppacadabraShare==='undefined'){ console.warn('Share missing'); return; }var done=exercises.filter(function(e){return e.d}).length;var text='💪 ${jsEsc(title)}\\n⏱ '+pad(Math.floor(secs/60))+':'+pad(secs%60)+'\\n✅ '+done+'/'+exercises.length;if(healthData)text+='\\n🚶 '+healthData.steps+' steps | 🔥 '+healthData.calories+' cal';AppacadabraShare.share(text,'','handleShareResult')}
function setReminder(){if(typeof AppacadabraNotify==='undefined'){ console.warn('Notify bridge missing'); return; }window._notifyPendingMsg='${jsEsc(t('tplReminderTomorrow'))}';AppacadabraNotify.schedule('💪 ${jsEsc(title)}','${jsEsc(t('tplNotifyWorkout'))}',1440,'handleNotifyResult')}
render();
</script>
</body></html>`
  };
}

/** 💰 Expense Tracker — with Camera receipts & Voice input */
export function expenseTemplate(t: T) {
  const title = t('tplExpenseTitle');
  return {
    name: title,
    shortDescription: t('obChipExpensesFull'),
    code: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${title}</title>
<style>
:root{${CSS_VARS}}
${CSS_RESET}
${CSS_HEADER}
${CSS_TOOLBAR}
${CSS_EMPTY}
${CSS_TOAST}
${CSS_LOADING}
.total{text-align:center;padding:20px}
.total .amount{font-size:2.4rem;font-weight:bold;color:var(--red)}
.total .label{font-size:.85rem;color:var(--dim);margin-top:4px}
.form{padding:0 16px;display:flex;flex-direction:column;gap:8px}
.form .row{display:flex;gap:8px}
.form input{flex:1;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:1rem;outline:none}
.form input:focus{border-color:var(--accent)}
.form select{padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:1rem;outline:none}
.form button{padding:12px;border:none;border-radius:10px;background:var(--primary);color:#fff;font-weight:bold;font-size:1rem;cursor:pointer}
.form button:active{transform:scale(.96)}
.smart-btns{display:flex;gap:8px;padding:0 16px;margin-top:4px}
.smart-btns button{flex:1;padding:10px;border:none;border-radius:10px;font-size:.85rem;cursor:pointer;transition:all .2s}
.smart-btns button:active{transform:scale(.96)}
.btn-camera{background:rgba(234,179,8,.12);color:var(--yellow);border:1px solid rgba(234,179,8,.3)!important}
.btn-mic{background:rgba(239,68,68,.1);color:var(--red);border:1px solid rgba(239,68,68,.3)!important}
.btn-mic.recording{animation:pulse 1s infinite;background:rgba(239,68,68,.25)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.expenses{padding:12px 16px 80px}
.expenses h2{font-size:1rem;color:var(--dim);margin-bottom:8px}
.exp{display:flex;justify-content:space-between;align-items:center;padding:14px;margin:6px 0;background:var(--card);border-radius:10px;border:1px solid var(--border)}
.exp .info .cat{font-size:.75rem;color:var(--dim)}
.exp .info .desc{font-size:.95rem;margin-top:2px}
.exp .val{font-weight:bold;color:var(--red);white-space:nowrap}
.exp .del{color:var(--dim);cursor:pointer;padding:4px 8px;margin-left:8px}
</style>
</head>
<body>
<header><h1>💰 ${title}</h1></header>
<div class="toolbar">
  <button onclick="shareReport()">📤 ${t('tplShareSummary')}</button>
  <button onclick="setReminder()">🔔 ${t('tplSetReminder')}</button>
</div>
<div class="total">
  <div class="amount" id="total">0.00</div>
  <div class="label">${t('tplExpenseTotal')}</div>
</div>
<div class="form">
  <div class="row">
    <input id="desc" placeholder="${t('tplExpenseDescPlaceholder')}">
    <input id="val" type="number" step="0.01" placeholder="${t('tplExpenseValPlaceholder')}" style="max-width:120px">
  </div>
  <select id="cat">
    <option value="🍔">${t('tplExpenseCatFood')}</option>
    <option value="🚗">${t('tplExpenseCatTransport')}</option>
    <option value="🏠">${t('tplExpenseCatHome')}</option>
    <option value="🎮">${t('tplExpenseCatLeisure')}</option>
    <option value="🛍️">${t('tplExpenseCatShopping')}</option>
    <option value="📦">${t('tplExpenseCatOther')}</option>
  </select>
  <button onclick="addExpense()">${t('tplAdd')}</button>
</div>
<div class="smart-btns">
  <button class="btn-camera" onclick="scanReceipt()">📸 ${t('tplScanReceipt')}</button>
  <button class="btn-mic" id="micBtn" onclick="toggleVoice()">🎙️ ${t('tplVoiceInput')}</button>
</div>
<div class="expenses">
  <h2>${t('tplExpenseHistory')}</h2>
  <div id="list"></div>
</div>
<div class="toast" id="toast"></div>
<script>
${sharedJS(t('tplReminderSet'))}
console.log('💰 Expense Tracker Template Loaded');
console.log('Bridges check: Camera:', typeof AppacadabraCamera!=='undefined', 'Audio:', typeof AppacadabraAudio!=='undefined', 'AI:', typeof AppacadabraAI!=='undefined');

var expenses=[];
try {
  expenses=JSON.parse(localStorage.getItem('month_expenses')||'[]');
} catch(e) { console.error('Expenses parsing error:', e); }

var isRecording=false;
function addExpense(){var d=document.getElementById('desc').value.trim(),v=parseFloat(document.getElementById('val').value),c=document.getElementById('cat').value;if(!d||isNaN(v)||v<=0)return;expenses.unshift({d:d,v:v,c:c,t:Date.now()});document.getElementById('desc').value='';document.getElementById('val').value='';vib(30);save()}
function addParsedExpense(desc,val,cat){expenses.unshift({d:desc,v:val,c:cat||'📦',t:Date.now()});vib([20,30,20]);save();showToast('+ '+desc)}
function del(i){expenses.splice(i,1);save()}
function save(){localStorage.setItem('month_expenses',JSON.stringify(expenses));render()}
function render(){var total=expenses.reduce(function(s,e){return s+e.v},0);document.getElementById('total').textContent=total.toFixed(2);var el=document.getElementById('list');if(!expenses.length){el.innerHTML='<div class="empty">${jsEsc(t('tplExpenseEmpty'))}</div>';return}
el.innerHTML=expenses.map(function(e,i){return '<div class="exp"><div class="info"><div class="cat">'+e.c+'</div><div class="desc">'+e.d+'</div></div><span class="val">'+e.v.toFixed(2)+'</span><span class="del" onclick="del('+i+')">✕</span></div>'}).join('')}
function shareReport(){if(typeof AppacadabraShare==='undefined'){ console.warn('Share missing'); return; }var total=expenses.reduce(function(s,e){return s+e.v},0);var text='💰 ${jsEsc(title)}\\n${jsEsc(t('tplExpenseTotal'))}: '+total.toFixed(2)+'\\n\\n'+expenses.slice(0,10).map(function(e){return e.c+' '+e.d+': '+e.v.toFixed(2)}).join('\\n');AppacadabraShare.share(text,'','handleShareResult')}
function setReminder(){if(typeof AppacadabraNotify==='undefined'){ console.warn('Notify bridge missing'); return; }window._notifyPendingMsg='${jsEsc(t('tplReminderTomorrow'))}';AppacadabraNotify.schedule('💰 ${jsEsc(title)}','${jsEsc(t('tplNotifyExpense'))}',1440,'handleNotifyResult')}
function scanReceipt(){if(typeof AppacadabraCamera==='undefined'){ console.warn('Camera bridge missing'); return; }window.handleReceiptPhoto=function(success,base64){console.log('Camera Photo Success:', success);if(!success)return;showToast('${jsEsc(t('tplAIThinking'))}');window.handleReceiptAI=function(ok,result){console.log('Receipt AI Success:', ok);if(!ok)return;try{var items=JSON.parse(result);items.forEach(function(it){addParsedExpense(it.description,it.amount,it.category||'📦')})}catch(e){console.error('Receipt parse error:',e)}};AppacadabraAI.fromImage(base64).withSchema({type:'array',items:{type:'object',properties:{description:{type:'string'},amount:{type:'number'},category:{type:'string',enum:['🍔','🚗','🏠','🎮','🛍️','📦']}},required:['description','amount']}}).generate('Extract expense items from this receipt. Return JSON array with description, amount (number), and category emoji.','handleReceiptAI')};AppacadabraCamera.takePhoto('handleReceiptPhoto')}
function toggleVoice(){if(typeof AppacadabraAudio==='undefined'){ console.warn('Audio bridge missing'); return; }var btn=document.getElementById('micBtn');if(!isRecording){isRecording=true;btn.classList.add('recording');btn.textContent='⏹️ ${jsEsc(t('tplStopRecording'))}';window.handleRecordStart=function(success){console.log('Record Start Success:', success);if(!success){isRecording=false;btn.classList.remove('recording');btn.textContent='🎙️ ${jsEsc(t('tplVoiceInput'))}'}};AppacadabraAudio.recordStart('handleRecordStart')}else{isRecording=false;btn.classList.remove('recording');btn.textContent='🎙️ ${jsEsc(t('tplVoiceInput'))}';window.handleAudioRecorded=function(success,base64){console.log('Audio Recorded Success:', success);if(!success)return;showToast('${jsEsc(t('tplAIThinking'))}');window.handleAudioParse=function(ok,result){console.log('Audio Parse Success:', ok);if(!ok)return;try{var items=JSON.parse(result);items.forEach(function(it){addParsedExpense(it.description,it.amount,it.category||'📦')})}catch(e){console.error('Audio parse error:',e)}};AppacadabraAI.fromAudio(base64).withSchema({type:'array',items:{type:'object',properties:{description:{type:'string'},amount:{type:'number'},category:{type:'string',enum:['🍔','🚗','🏠','🎮','🛍️','📦']}},required:['description','amount']}}).generate('The user is dictating expense items. Extract each expense mentioned with description, amount (number), and category emoji. If amounts are unclear, estimate.','handleAudioParse')};AppacadabraAudio.recordStop('handleAudioRecorded')}}
render();
</script>
</body></html>`
  };
}

/** Array of template factories indexed by chip index */
export const onboardingTemplates = [
  shoppingListTemplate,
  moodDiaryTemplate,
  workoutTemplate,
  expenseTemplate,
];
