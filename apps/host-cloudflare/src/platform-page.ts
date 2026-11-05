// The platform admins' page, `/platform`: what new agents start with, which
// tools are hidden company-wide, every agent workspace against every
// connection (and making one ahead for named people), and the company's MCP
// servers. A client of
// `/api/platform/admin/*` and `/api/platform/mcp-servers` only.

const STYLE = `
:root{--brand:#006A9A;--line:#d9dee3;--muted:#5f6b76;--bg:#fff;--fg:#1d2733;--soft:#f3f6f8}
@media (prefers-color-scheme:dark){:root{--line:#33404c;--muted:#9aa7b3;--bg:#11171d;--fg:#e6ebef;--soft:#1a222a}}
*{box-sizing:border-box}body{font:15px/1.45 Montserrat,system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
header{border-bottom:1px solid var(--line);padding:1rem 1.25rem}h1{font-size:1.25rem;margin:0}
main{max-width:72rem;margin:0 auto;padding:1rem 1.25rem}
nav{display:flex;gap:.25rem;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:1rem}
nav button{background:none;border:0;border-bottom:2px solid transparent;padding:.6rem .8rem;font:inherit;color:var(--muted);cursor:pointer}
nav button[aria-selected=true]{color:var(--fg);border-color:var(--brand);font-weight:600}
.hint{color:var(--muted);margin:.25rem 0 1rem}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
.grid{overflow-x:auto}.grid th.col{writing-mode:vertical-rl;transform:rotate(180deg);font-weight:500;white-space:nowrap}
.grid td.tick{text-align:center}
label.row{display:flex;gap:.6rem;align-items:center;padding:.45rem .25rem;border-bottom:1px solid var(--line)}
select,input,button.act{font:inherit;padding:.3rem .5rem;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg)}
button.act{background:var(--brand);color:#fff;border-color:var(--brand);cursor:pointer}
details{border-bottom:1px solid var(--line)}summary{display:flex;justify-content:space-between;align-items:center;padding:.5rem .25rem;cursor:pointer;gap:1rem}
.tool{display:flex;justify-content:space-between;gap:1rem;padding:.35rem .25rem .35rem 1.5rem}.tool small{color:var(--muted);display:block}
.tag{font-size:.75rem;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:0 .45rem;margin-left:.4rem}
small.who{display:block;color:var(--muted);font-size:.8rem}
.filters{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;align-items:center;margin-bottom:.25rem}.filters label{display:flex;gap:.4rem;align-items:center}
#msg{min-height:1.4rem;color:var(--muted)}a{color:var(--brand)}
button.link{background:none;border:0;padding:0;font:inherit;color:var(--brand);cursor:pointer;text-decoration:underline}
#new-box{border:1px solid var(--line);border-radius:6px;padding:.25rem .75rem;margin-bottom:1rem}
`;

const SCRIPT = `
const $=(s,r=document)=>r.querySelector(s);const el=(t,p={},...k)=>{const e=document.createElement(t);Object.assign(e,p);e.append(...k);return e};
const say=(t)=>{$('#msg').textContent=t};
async function call(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const out=await r.json().catch(()=>({}));if(!r.ok||out.error){say(out.error||'That did not work.');throw new Error(out.error)}return out}
const tabs=['start','hidden','grid','catalog','servers'];
function show(tab){for(const t of tabs){$('#tab-'+t).hidden=t!==tab;$('#nav-'+t).setAttribute('aria-selected',String(t===tab))}history.replaceState(null,'','#'+tab);load(tab)}
async function pick(workspace,pattern,on){say('Saving…');await call('/api/platform/admin/workspaces/connection',{workspace,pattern,on});say('Saved.')}
async function loadStart(){const d=await call('/api/platform/admin/workspaces');const set=d.workspaces.find(w=>w.startingSet);const box=$('#start-list');box.textContent='';
 if(!set){box.append(el('p',{className:'hint',textContent:'The starting set could not be made. Reload to try again.'}));return}
 const has=new Set(set.patterns);
 for(const c of d.connections.filter(c=>!c.team||has.has(c.pattern))){const cb=el('input',{type:'checkbox',checked:has.has(c.pattern)});cb.onchange=()=>pick(set.id,c.pattern,cb.checked);box.append(el('label',{className:'row'},cb,c.label,c.personal?el('span',{className:'tag',textContent:'each person signs in'}):''))}
 const all=el('input',{type:'checkbox',checked:has.has('*')});all.onchange=()=>pick(set.id,'*',all.checked);box.append(el('label',{className:'row'},all,'Every connection',el('span',{className:'tag',textContent:'includes all of the above'})));
 $('#start-rules').href=d.consolePath+'/'+encodeURIComponent(set.slug)}
const SETTINGS=[['show','Show'],['ask','Ask first'],['hide','Hidden']];
function settingSelect(value,inherit,onchange){const s=el('select');if(inherit)s.append(el('option',{value:'inherit',textContent:'Same as server'}));for(const [v,t] of SETTINGS)s.append(el('option',{value:v,textContent:t}));s.value=value??(inherit?'inherit':'show');s.onchange=()=>onchange(s.value);return s}
async function setTool(integration,tool,setting){say('Saving…');await call('/api/platform/admin/tools',{integration,tool,setting});say('Saved. Agents see it on their next session.')}
async function loadHidden(){const d=await call('/api/platform/admin/tools');const box=$('#hidden-list');box.textContent='';
 for(const s of d.servers){const sum=el('summary',{},el('span',{},s.name,el('span',{className:'tag',textContent:s.tools.length+' tools'})));const sel=settingSelect(s.setting,false,v=>setTool(s.integration,null,v));sel.onclick=e=>e.stopPropagation();sum.append(sel);
  const det=el('details',{},sum);for(const t of s.tools){det.append(el('div',{className:'tool'},el('span',{},t.name,el('small',{textContent:t.description})),settingSelect(t.setting,true,v=>setTool(s.integration,t.name,v))))}box.append(det)}}
function fillTeams(){const s=$('#new-team');const keep=s.value;s.textContent='';s.append(el('option',{value:'',textContent:'No team'}));for(const t of gridData.teams)s.append(el('option',{value:t,textContent:t}));s.value=[...s.options].some(o=>o.value===keep)?keep:''}
function forWhom(w){const box=el('small',{className:'who'});const draw=()=>{box.textContent='';box.append('Set up for: '+(w.setUpFor.length?w.setUpFor.join(', '):'nobody named')+' ');const b=el('button',{type:'button',className:'link',textContent:'change'});b.onclick=edit;box.append(b)};
 const edit=()=>{box.textContent='';const i=el('input',{value:w.setUpFor.join(', '),placeholder:'name@company.com, …',size:30});const ok=el('button',{type:'button',className:'act',textContent:'Save'});ok.onclick=async()=>{say('Saving…');const out=await call('/api/platform/admin/workspaces/people',{slug:w.slug,people:i.value.split(/[\\s,;]+/)});w.setUpFor=out.people;say('Saved. Their sign-in page now picks this workspace.');draw()};box.append(i,' ',ok)};draw();return box}
$('#new-ws').onsubmit=async(e)=>{e.preventDefault();const f=e.target;say('Making it…');const out=await call('/api/platform/admin/workspaces',{name:f.name.value,team:f.team.value||null,people:f.people.value.split(/[\\s,;]+/)});f.reset();say('Made. Tick its connections below; the people named get it when they click Connect.');await loadGrid();$('#grid-person').value='';const ws=$('#grid-workspace');fillWorkspaces();const row=gridData.workspaces.find(w=>w.slug===out.slug);if(row)ws.value=row.id;drawGrid()};
const store={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};
let gridData=null;
async function loadGrid(){gridData=await call('/api/platform/admin/workspaces');const people=[...new Set(gridData.workspaces.flatMap(w=>[...w.people,...w.setUpFor]))].sort();fillTeams();
 const ps=$('#grid-person');ps.textContent='';ps.append(el('option',{value:'',textContent:'Everyone'}));for(const p of people)ps.append(el('option',{value:p,textContent:p===gridData.me?p+' (you)':p}));ps.append(el('option',{value:'-',textContent:'Nobody has connected yet'}));
 const saved=store.get('grid-person');ps.value=saved!==null&&[...ps.options].some(o=>o.value===saved)?saved:(people.includes(gridData.me)?gridData.me:'');
 $('#grid-all').checked=store.get('grid-all')==='1';fillWorkspaces();drawGrid()}
function personRows(){const p=$('#grid-person').value;return gridData.workspaces.filter(w=>p===''||(p==='-'?w.people.length===0&&!w.startingSet:w.people.includes(p)||w.setUpFor.includes(p)))}
function fillWorkspaces(){const ws=$('#grid-workspace');const keep=ws.value;ws.textContent='';ws.append(el('option',{value:'',textContent:'All of them'}));for(const w of personRows())ws.append(el('option',{value:w.id,textContent:w.name}));ws.value=[...ws.options].some(o=>o.value===keep)?keep:''}
function drawGrid(){const t=$('#grid');t.textContent='';const d=gridData;const wid=$('#grid-workspace').value;const rows=personRows().filter(w=>!wid||w.id===wid);
 const used=new Set(rows.flatMap(w=>w.patterns));const all=$('#grid-all').checked;const cols=[...d.connections.map(c=>[c.pattern,c.label]),['*','Every connection']].filter(([p])=>all||used.has(p));
 $('#grid-count').textContent=rows.length+' of '+d.workspaces.length+' workspaces'+(all?'':', showing only connections they use');
 if(!rows.length){t.append(el('tbody',{},el('tr',{},el('td',{className:'hint',textContent:'No workspace matches.'}))));return}
 const head=el('tr',{},el('th',{textContent:'Workspace'}));for(const [,label] of cols)head.append(el('th',{className:'col',textContent:label}));t.append(el('thead',{},head));
 const body=el('tbody');for(const w of rows){const has=new Set(w.patterns);const name=el('a',{href:d.consolePath+'/'+encodeURIComponent(w.slug),textContent:w.name});
  const who=el('small',{className:'who',textContent:w.startingSet?'':(w.people.length?w.people.join(', '):'nobody has connected yet')});
  const tr=el('tr',{},el('td',{},name,w.startingSet?el('span',{className:'tag',textContent:'starting set'}):'',who,w.startingSet?'':forWhom(w)));
  for(const [p] of cols){const cb=el('input',{type:'checkbox',checked:has.has(p),title:p});cb.onchange=async()=>{await pick(w.id,p,cb.checked);cb.checked?has.add(p):has.delete(p);w.patterns=[...has]};tr.append(el('td',{className:'tick'},cb))}body.append(tr)}t.append(body)}
$('#grid-person').onchange=()=>{store.set('grid-person',$('#grid-person').value);fillWorkspaces();drawGrid()};
$('#grid-workspace').onchange=()=>drawGrid();
$('#grid-all').onchange=()=>{store.set('grid-all',$('#grid-all').checked?'1':'0');drawGrid()};
let cat=null;
async function loadCatalog(){cat=await call('/api/platform/admin/catalog');drawCatalog()}
function listName(id){return id===cat.everything?'Everything':id===cat.company?'All company integrations':(cat.lists.find(l=>l.id===id)||{name:id}).name}
function listOptions(sel,value,withDefault){sel.textContent='';if(withDefault)sel.append(el('option',{value:'',textContent:'Default ('+listName(cat.defaultList)+')'}));sel.append(el('option',{value:cat.company,textContent:'All company integrations'}));sel.append(el('option',{value:cat.everything,textContent:'Everything, and can add more'}));for(const l of cat.lists)sel.append(el('option',{value:l.id,textContent:l.name}));sel.value=value}
function drawCatalog(){const def=$('#cat-default');listOptions(def,cat.defaultList,false);def.onchange=async()=>{say('Saving…');await call('/api/platform/admin/catalog/default',{list:def.value});cat.defaultList=def.value;say('Saved.');drawPeople()};drawPeople();drawLists()}
function drawPeople(){const tb=$('#cat-people');tb.textContent='';const q=$('#cat-find').value.trim().toLowerCase();
 for(const p of cat.people.filter(p=>!q||p.email.includes(q))){const admin=cat.admins.includes(p.email);let cell;
  if(admin)cell=el('span',{className:'hint',textContent:'Everything (admin)'});else{cell=el('select');listOptions(cell,p.list??'',true);cell.onchange=async()=>{say('Saving…');await call('/api/platform/admin/catalog/person',{email:p.email,list:cell.value||null});p.list=cell.value||null;say('Saved. They see it within a minute.')}}
  tb.append(el('tr',{},el('td',{},p.email,p.seenAt?'':el('span',{className:'tag',textContent:'not signed in yet'})),el('td',{},cell)))}
 if(!tb.children.length)tb.append(el('tr',{},el('td',{className:'hint',textContent:'Nobody matches.'})))}
function listEditor(list){const name=el('input',{value:list.name,placeholder:'List name, such as Sales basics'});const has=new Set(list.integrations);const box=el('div');
 for(const i of cat.integrations){const cb=el('input',{type:'checkbox',checked:has.has(i.slug)});cb.onchange=()=>{cb.checked?has.add(i.slug):has.delete(i.slug)};box.append(el('label',{className:'row'},cb,i.name))}
 if(!cat.integrations.length)box.append(el('p',{className:'hint',textContent:'The company has no integrations yet.'}));
 const save=el('button',{className:'act',textContent:'Save list'});save.onclick=async()=>{say('Saving…');await call('/api/platform/admin/catalog/list',{...(list.id?{id:list.id}:{}),name:name.value,integrations:[...has]});say('Saved.');loadCatalog()};
 const remove=el('button',{className:'act',textContent:'Remove list'});remove.onclick=async()=>{if(!list.id)return loadCatalog();if(!confirm('Remove '+list.name+'? People on it go back to the default.'))return;await call('/api/platform/admin/catalog/list/remove',{id:list.id});say('Removed.');loadCatalog()};
 const users=cat.people.filter(p=>p.list===list.id).length;
 const sum=el('summary',{},el('span',{},list.name||'New list',el('span',{className:'tag',textContent:list.integrations.length+' integrations'}),list.id?el('span',{className:'tag',textContent:users+' people'}):''));
 return el('details',{open:!list.id},sum,el('div',{className:'tool'},el('label',{},'Name ',name)),box,el('p',{},save,' ',remove))}
function drawLists(){const box=$('#cat-lists');box.textContent='';for(const l of cat.lists)box.append(listEditor(l));if(!cat.lists.length)box.append(el('p',{className:'hint',textContent:'No lists yet. Everyone sees everything until you make one and give it to someone.'}))}
$('#cat-find').oninput=()=>drawPeople();
$('#cat-new-list').onclick=()=>{$('#cat-lists').append(listEditor({id:null,name:'',integrations:[]}))};
$('#cat-add').onclick=async()=>{const email=$('#cat-new').value.trim().toLowerCase();if(!email)return;await call('/api/platform/admin/catalog/person',{email,list:cat.defaultList});$('#cat-new').value='';say('Added on '+listName(cat.defaultList)+'.');loadCatalog()};
const API='/api/platform/mcp-servers';
async function loadServers(){const list=await call(API);const tb=$('#rows');tb.textContent='';for(const s of list.servers){const tr=el('tr',{},el('td',{textContent:s.name}),el('td',{textContent:s.endpoint}));const td=el('td');if(s.removable){const b=el('button',{className:'act',textContent:'Remove'});b.onclick=async()=>{await fetch(API+'/'+encodeURIComponent(s.slug),{method:'DELETE'});loadServers()};td.append(b)}tr.append(td);tb.append(tr)}}
$('#add').onsubmit=async(e)=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const r=await fetch(API,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const out=await r.json();say(r.ok?'Added.':out.error);if(r.ok){e.target.reset();loadServers()}};
function load(tab){say('');({start:loadStart,hidden:loadHidden,grid:loadGrid,catalog:loadCatalog,servers:loadServers})[tab]().catch(()=>{})}
for(const t of tabs)$('#nav-'+t).onclick=()=>show(t);
show(tabs.includes(location.hash.slice(1))?location.hash.slice(1):'start');
`;

export const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Executor admin</title>
<link rel="stylesheet" href="/brand.css"><style>${STYLE}</style></head><body>
<header><h1>Executor admin</h1></header>
<main>
<nav role="tablist">
<button id="nav-start" role="tab">New workspaces start with</button>
<button id="nav-hidden" role="tab">Hidden tools</button>
<button id="nav-grid" role="tab">All workspaces</button>
<button id="nav-catalog" role="tab">Who sees which integrations</button>
<button id="nav-servers" role="tab">Company servers</button>
</nav>
<p id="msg" role="status"></p>
<section id="tab-start" hidden>
<p class="hint">Every new agent's workspace gets these connections once, when someone clicks Connect. Changing this list later leaves existing agents alone. A team's own Wiki and Muster are not listed here: the team picked at sign-in adds them.</p>
<div id="start-list"></div>
<p class="hint">To hide or ask first for single tools in new workspaces, <a id="start-rules" href="#">open the starting set's tools</a>.</p>
</section>
<section id="tab-hidden" hidden>
<p class="hint">Applies to every agent. Hidden tools disappear from every agent's list and are refused if called. Ask first pauses for a person before each call. A tool's own setting wins over its server's.</p>
<div id="hidden-list"></div>
</section>
<section id="tab-grid" hidden>
<p class="hint">Each row is an agent's workspace, with the people who connected it; a tick means it uses that connection. Click a name to open it in the console.</p>
<details id="new-box"><summary><b>Set up a workspace for someone</b></summary>
<p class="hint">Make an agent's workspace before anyone connects. It starts with what new workspaces start with, plus the team's Wiki and Muster if you pick a team. The people you name find it already picked when they click Connect in their app, so they join it as you set it up. Everyone else can still see and join it.</p>
<form id="new-ws"><div class="filters"><label>Name <input name="name" required maxlength="63" placeholder="Team Eichten agent"></label><label>Team <select name="team" id="new-team"></select></label><label>For <input name="people" size="34" placeholder="name@company.com, …"></label><button class="act">Make it</button></div></form>
</details>
<div class="filters"><label>Person <select id="grid-person"></select></label><label>Workspace <select id="grid-workspace"></select></label><label><input type="checkbox" id="grid-all"> Show every connection</label></div>
<p class="hint" id="grid-count"></p>
<div class="grid"><table id="grid"></table></div>
</section>
<section id="tab-catalog" hidden>
<p class="hint">Pick which of the company's integrations each person sees in Executor. People on <b>All company integrations</b> see all of them. People on <b>Everything</b> also add new ones from the full catalog. People on one of your lists see only its integrations. Only Everything adds. Admins always see everything. Workspaces are not affected: each workspace keeps the connections picked for it.</p>
<h2>New people get</h2><p><select id="cat-default"></select></p>
<h2>People</h2>
<div class="filters"><label>Find <input id="cat-find" placeholder="name@company.com"></label><label>Add someone <input id="cat-new" placeholder="name@company.com" type="email"></label><button class="act" id="cat-add">Add</button></div>
<table><thead><tr><th>Person</th><th>Sees</th></tr></thead><tbody id="cat-people"></tbody></table>
<h2>Lists</h2>
<div id="cat-lists"></div>
<p><button class="act" id="cat-new-list">New list</button></p>
</section>
<section id="tab-servers" hidden>
<p class="hint">Every team sees these first when it adds an integration.</p>
<table><thead><tr><th>Name</th><th>Endpoint</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<h2>Add a server</h2><form id="add"><p><input name="name" placeholder="Name" required> <input name="slug" placeholder="slug (a-z, 0-9, -)" required pattern="[a-z0-9][a-z0-9-]*"></p><p><input name="endpoint" placeholder="https://…/mcp" required type="url" size="40"> <input name="summary" placeholder="One line on what it does" size="30"></p><button class="act">Add</button></form>
</section>
</main>
<script>${SCRIPT}</script></body></html>`;
