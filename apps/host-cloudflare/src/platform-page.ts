// The platform admins' page, `/platform`: what new agents start with, which
// tools are hidden company-wide, every agent workspace against every
// connection, and the company's MCP servers. A client of
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
#msg{min-height:1.4rem;color:var(--muted)}a{color:var(--brand)}
`;

const SCRIPT = `
const $=(s,r=document)=>r.querySelector(s);const el=(t,p={},...k)=>{const e=document.createElement(t);Object.assign(e,p);e.append(...k);return e};
const say=(t)=>{$('#msg').textContent=t};
async function call(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const out=await r.json().catch(()=>({}));if(!r.ok||out.error){say(out.error||'That did not work.');throw new Error(out.error)}return out}
const tabs=['start','hidden','grid','servers'];
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
async function loadGrid(){const d=await call('/api/platform/admin/workspaces');const t=$('#grid');t.textContent='';
 const head=el('tr',{},el('th',{textContent:'Workspace'}));for(const c of d.connections)head.append(el('th',{className:'col',textContent:c.label}));head.append(el('th',{className:'col',textContent:'Every connection'}));t.append(el('thead',{},head));
 const body=el('tbody');for(const w of d.workspaces){const has=new Set(w.patterns);const name=el('a',{href:d.consolePath+'/'+encodeURIComponent(w.slug),textContent:w.name});const tr=el('tr',{},el('td',{},name,w.startingSet?el('span',{className:'tag',textContent:'starting set'}):''));
  for(const p of [...d.connections.map(c=>c.pattern),'*']){const cb=el('input',{type:'checkbox',checked:has.has(p),title:p});cb.onchange=()=>pick(w.id,p,cb.checked);tr.append(el('td',{className:'tick'},cb))}body.append(tr)}t.append(body)}
const API='/api/platform/mcp-servers';
async function loadServers(){const list=await call(API);const tb=$('#rows');tb.textContent='';for(const s of list.servers){const tr=el('tr',{},el('td',{textContent:s.name}),el('td',{textContent:s.endpoint}));const td=el('td');if(s.removable){const b=el('button',{className:'act',textContent:'Remove'});b.onclick=async()=>{await fetch(API+'/'+encodeURIComponent(s.slug),{method:'DELETE'});loadServers()};td.append(b)}tr.append(td);tb.append(tr)}}
$('#add').onsubmit=async(e)=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const r=await fetch(API,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const out=await r.json();say(r.ok?'Added.':out.error);if(r.ok){e.target.reset();loadServers()}};
function load(tab){say('');({start:loadStart,hidden:loadHidden,grid:loadGrid,servers:loadServers})[tab]().catch(()=>{})}
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
<p class="hint">Each row is an agent's workspace; a tick means it uses that connection. Click a name to open it in the console.</p>
<div class="grid"><table id="grid"></table></div>
</section>
<section id="tab-servers" hidden>
<p class="hint">Every team sees these first when it adds an integration.</p>
<table><thead><tr><th>Name</th><th>Endpoint</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<h2>Add a server</h2><form id="add"><p><input name="name" placeholder="Name" required> <input name="slug" placeholder="slug (a-z, 0-9, -)" required pattern="[a-z0-9][a-z0-9-]*"></p><p><input name="endpoint" placeholder="https://…/mcp" required type="url" size="40"> <input name="summary" placeholder="One line on what it does" size="30"></p><button class="act">Add</button></form>
</section>
</main>
<script>${SCRIPT}</script></body></html>`;
