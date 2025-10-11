// ==UserScript==
// @name         Cytu.be Playlist Manager
// @namespace    cytube-saved-playlists
// @version      3.6.0
// @description  Manage and sync Cytu.be playlists with a sleek glass-style UI and optional Google Drive database. Create multiple saved playlists per channel, edit and reorder tracks, append or replace current lists, auto-dedupe entries, and export/import backups. Includes collapsible panels and offline fallback for smooth management.
// @match        https://cytu.be/r/*
// @match        https://*.cytu.be/r/*
// @match        http://cytu.be/r/*
// @match        http://*.cytu.be/r/*
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      googleusercontent.com
// @connect      google.com
// @connect      *
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/LoopRook/Cytu.be-Playlist-Manager/refs/heads/main/Cytu.be%20Playlist%20Manager.js
// @updateURL    https://raw.githubusercontent.com/LoopRook/Cytu.be-Playlist-Manager/refs/heads/main/Cytu.be%20Playlist%20Manager.js
// ==/UserScript==

(function(){
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const channelName=(window.CHANNEL&&CHANNEL.name)||location.pathname.split('/').filter(Boolean).pop()||'default';

  // ===== CONFIG =====
  const DEFAULT_PULL_MS = 10000; // background pull interval; change here
  const MIN_PULL_MS     = 3000;  // hard floor
  // ==================

  // keys
  const KEY=(n)=>`ct_savedpl:${channelName}:${n}`;
  const LISTKEY=`ct_savedpl_index:${channelName}`;
  const UIKEY_MAIN=`ct_ui_collapsed_main:${channelName}`;
  const UIKEY_DB=`ct_ui_collapsed_db:${channelName}`;
  const AUTOPUSH=`ct_autopush:${channelName}`;
  const AUTOPULL=`ct_autopull:${channelName}`;
  const AUTOPULL_MS_KEY=`ct_autopull_ms:${channelName}`;
  const REV_BROADCAST_KEY=`ct_db_rev:${channelName}`;

  // toast
  function toast(msg){
    try{
      const t=document.createElement('div');
      t.textContent=String(msg);
      t.style.cssText='position:fixed;right:12px;bottom:12px;z-index:999999;background:rgba(20,20,20,.92);color:#fff;padding:8px 10px;border-radius:12px;font:12px/1.2 system-ui;max-width:62ch;box-shadow:0 10px 30px rgba(0,0,0,.35);white-space:pre-wrap;backdrop-filter:blur(12px) saturate(140%);border:1px solid rgba(255,255,255,.12)';
      document.body.appendChild(t); setTimeout(()=>t.remove(),4200);
    }catch{}
  }

  // GM fetch
  function gmFetch(url,{method='GET',headers={},data=null,responseType='text'}={}){
    return new Promise((resolve,reject)=>{
      GM_xmlhttpRequest({url,method,headers,data,responseType,onload:r=>resolve(r),onerror:e=>reject(e),ontimeout:()=>reject(new Error('GM timeout'))});
    });
  }
  async function gmFetchJSON(url,opts={}){
    const r=await gmFetch(url,{...opts,responseType:'text'});
    const text=r.responseText||'';
    try{ return { json: JSON.parse(text), status:r.status, text }; }
    catch{ return { json: null, status:r.status, text }; }
  }

  // local store
  const getIndexLocal=()=>{try{return JSON.parse(localStorage.getItem(LISTKEY)||'[]')}catch{return[]}};
  const setIndexLocal=(arr)=>{const uniq=[...new Set(arr.filter(Boolean))].sort((a,b)=>a.localeCompare(b)); localStorage.setItem(LISTKEY,JSON.stringify(uniq)); return uniq;};
  const readSavedLocal=(name)=>{try{const raw=localStorage.getItem(KEY(name)); return raw?JSON.parse(raw):{savedAt:0,items:[]}}catch{return{savedAt:0,items:[]}}};
  const writeSavedLocal=(name,payload)=>localStorage.setItem(KEY(name),JSON.stringify(payload));

  // url helpers
  function parseYouTubeId(u){try{const url=new URL(u); if(url.hostname==='youtu.be')return url.pathname.slice(1); if(url.hostname.endsWith('youtube.com')){ if(url.pathname==='/watch')return url.searchParams.get('v')||''; if(url.pathname.startsWith('/shorts/'))return url.pathname.split('/')[2]||''; const m=url.pathname.match(/^\/embed\/([^\/?#]+)/); if(m) return m[1]; }}catch{} const m=String(u).match(/^[A-Za-z0-9_-]{8,}$/); return m?m[0]:'';}
  const parseVimeoId=(u)=>{try{const m=String(u).match(/vimeo\.com\/(\d+)/i); return m?m[1]:''}catch{return''}};
  const parseDailymotionId=(u)=>{try{const m=String(u).match(/dailymotion\.com\/video\/([a-z0-9]+)/i); return m?m[1]:''}catch{return''}};
  const normalizeOtherUrl=(u)=>{try{const url=new URL(u); url.search=''; url.hash=''; return url.origin+url.pathname;}catch{return String(u).trim();}};
  const urlToKey=(u)=>{const yt=parseYouTubeId(u); if(yt)return`yt:${yt}`; const vi=parseVimeoId(u); if(vi)return`vi:${vi}`; const dm=parseDailymotionId(u); if(dm)return`dm:${dm}`; return`url:${normalizeOtherUrl(u)}`;};

  const scrapeCurrentQueueKeys=()=>{const keys=[]; for(const el of $$('#queue .queue_entry, .queue_item')){ const svc=(el.dataset?.service||el.getAttribute('data-service')||'').toLowerCase(); const id=el.dataset?.id||el.getAttribute('data-id')||''; if(svc&&id){ if(svc==='yt')keys.push(`yt:${id}`); else if(svc==='vi'||svc==='vimeo')keys.push(`vi:${id}`); else if(svc==='dm')keys.push(`dm:${id}`); else keys.push(`url:${svc}:${id}`); continue;} const a=el.querySelector('a[href]'); if(a&&a.href) keys.push(urlToKey(a.href)); } if(!keys.length){ for(const a of $$('#queue a, #playlist a, .queue a, .qe_title a')){ if(a.href) keys.push(urlToKey(a.href)); } } return keys; };
  const getCurrentKeySet=()=>new Set(scrapeCurrentQueueKeys());

  async function clearPlaylistRobust(){
    try{ if(window.socket&&typeof window.socket.emit==='function'){ window.socket.emit('playlistClear'); for(let i=0;i<15;i++){ if(($$('#queue .queue_entry').length||0)===0) return true; await sleep(100);} } }catch{}
    const clearBtn=$('#btn-clearplaylist')||$$('button, a').find(b=>/clear/i.test(b.textContent||'')||/clear/i.test(b.getAttribute?.('title')||''));
    if(clearBtn){ clearBtn.click(); await sleep(80); const confirmBtn=$$('button, a').find(b=>/confirm|yes|ok/i.test(b.textContent||'')&&b.offsetParent); if(confirmBtn)confirmBtn.click(); for(let i=0;i<80;i++){ if(($$('#queue .queue_entry').length||0)===0) return true; await sleep(100);} }
    return false;
  }

  // remote DB
  const DBSTATE={connected:false,baseUrl:'',dbId:'',token:'',cache:null};
  const saveConnPerChannel=()=>localStorage.setItem(`ct_db_conn:${channelName}`, JSON.stringify({baseUrl:DBSTATE.baseUrl,dbId:DBSTATE.dbId,token:DBSTATE.token}));
  const loadConnPerChannel=()=>{try{const raw=localStorage.getItem(`ct_db_conn:${channelName}`); if(!raw) return false; const {baseUrl,dbId,token}=JSON.parse(raw); if(baseUrl&&dbId){ DBSTATE.baseUrl=baseUrl; DBSTATE.dbId=dbId; DBSTATE.token=token||''; DBSTATE.connected=true; return true; }}catch{} return false; };

  async function driveInit(baseUrl){
    const initPost=baseUrl.replace(/\?.*$/,'')+'?init=1';
    let r=await gmFetchJSON(initPost,{method:'POST',headers:{'Content-Type':'application/json'},data:JSON.stringify({ping:1})});
    if(!r.json||!r.json.dbId){ const initGet=baseUrl.replace(/\?.*$/,'')+'?init=1'; r=await gmFetchJSON(initGet,{method:'GET'}); if(!r.json||!r.json.dbId){ toast(`Create failed. Status ${r.status}`); throw new Error('init failed'); } }
    return r.json.dbId;
  }
  async function drivePull(){
    const url=`${DBSTATE.baseUrl}?db=${encodeURIComponent(DBSTATE.dbId)}`;
    const r=await gmFetchJSON(url,{method:'GET'});
    if(!r.json||r.json.error){ toast(`Pull failed (${r.status})`); throw new Error('pull failed'); }
    DBSTATE.cache=r.json; if(!DBSTATE.cache.playlists) DBSTATE.cache.playlists={}; return DBSTATE.cache;
  }
  async function drivePush(){
    if(!DBSTATE.cache) throw new Error('nothing to push');
    const url=`${DBSTATE.baseUrl}?db=${encodeURIComponent(DBSTATE.dbId)}&op=put${DBSTATE.token?`&token=${encodeURIComponent(DBSTATE.token)}`:''}`;
    const r=await gmFetchJSON(url,{method:'POST',headers:{'Content-Type':'application/json'},data:JSON.stringify(DBSTATE.cache)});
    if(!r.json){ toast(`Push failed (${r.status})`); throw new Error('push failed'); }
    if(r.json.error==='unauthorized') throw new Error('unauthorized (token?)');
    if(r.json.error==='conflict'&&r.json.server){ DBSTATE.cache=mergeServer_(DBSTATE.cache,r.json.server); const r2=await gmFetchJSON(url,{method:'POST',headers:{'Content-Type':'application/json'},data:JSON.stringify(DBSTATE.cache)}); if(!r2.json||r2.json.error) throw new Error('push after merge failed'); try{ localStorage.setItem(REV_BROADCAST_KEY, String(Date.now())); }catch{} return true; }
    if(r.json.error) throw new Error('push failed: '+r.json.error);
    try{ localStorage.setItem(REV_BROADCAST_KEY, String(Date.now())); }catch{}
    return true;
  }
  const mergeServer_=(local,server)=>{ const out=JSON.parse(JSON.stringify(server)); out.playlists=out.playlists||{}; const L=local.playlists||{}; for(const [name,pl] of Object.entries(L)){ const s=out.playlists[name]; if(!s){ out.playlists[name]=pl; continue; } const seen=new Set((s.items||[]).map(urlToKey)); const add=(pl.items||[]).filter(u=>!seen.has(urlToKey(u))); if(add.length) s.items=(s.items||[]).concat(add); s.savedAt=Math.max(+s.savedAt||0,+pl.savedAt||0); } out.version=server.version||local.version||1; out.sync=server.sync||{}; return out; };
  const usingRemote=()=>DBSTATE.connected&&DBSTATE.cache;

  // storage facade
  const _readSaved=readSavedLocal,_writeSavedLocal=writeSavedLocal,_getIndex=getIndexLocal,_setIndex=setIndexLocal;
  function readSaved(n){ return usingRemote()? (DBSTATE.cache.playlists[n]||{savedAt:0,items:[]}) : _readSaved(n); }
  function writeSaved(n,p){ if(!usingRemote()) return _writeSavedLocal(n,p); DBSTATE.cache.playlists[n]={savedAt:p.savedAt||Date.now(),items:p.items||[]}; maybeAutoPush(); }
  function getIndex(){ return usingRemote()? Object.keys(DBSTATE.cache.playlists).sort((a,b)=>a.localeCompare(b)) : _getIndex(); }
  function setIndex(arr){ if(!usingRemote()) return _setIndex(arr); const want=new Set(arr.filter(Boolean)); for(const k of Object.keys(DBSTATE.cache.playlists)) if(!want.has(k)) delete DBSTATE.cache.playlists[k]; maybeAutoPush(); return [...want].sort((a,b)=>a.localeCompare(b)); }

  // actions
  function saveAs(name){ if(!name){toast('Enter a name');return} const urls=scrapeUrlsFromQueue(); if(!urls.length){toast('Playlist is empty');return} writeSaved(name,{savedAt:Date.now(),items:urls}); const idx=setIndex([...getIndex(),name]); refreshList(idx,name); toast(`Saved “${name}” (${urls.length})`); }

  async function loadWhole(name,mode){ if(!name){toast('Pick a name');return} const {items=[]}=readSaved(name); const input=$('#mediaurl')||$('input#mediaurl')||$$('input').find(i=>i.id?.includes('mediaurl')||/url/i.test(i.placeholder||'')); const addEnd=$('#queue_end')||$('#addfromurl button.btn.btn-default:last-child')||$$('button').find(b=>/queue to end|queue|add/i.test(b.textContent||'')); if(!input||!addEnd){toast('Could not find Add controls');return} if(mode==='replace'){ const ok=await clearPlaylistRobust(); toast(ok?'Playlist cleared.':'Could not clear; loading anyway (append).'); } const current=getCurrentKeySet(); const toAdd=[]; for(const u of items){const k=urlToKey(u); if(!current.has(k)){toAdd.push(u); current.add(k);} } if(!toAdd.length){toast('Nothing to add');return} let i=0;(async function step(){ if(i>=toAdd.length){toast(`Loaded “${name}” (+${toAdd.length})`);return} input.value=toAdd[i++]; addEnd.click(); await sleep(180); step(); })(); }

  const shuffle=(a)=>{for(let i=a.length-1;i>0;i--){const j=(Math.random()*(i+1))|0;[a[i],a[j]]=[a[j],a[i]]}return a};
  async function addNFromSaved(name,count,where,rand){ if(!name){toast('Pick a playlist');return} const {items=[]}=readSaved(name); if(!items.length){toast('Saved list is empty');return} const current=getCurrentKeySet(); let pool=items.filter(u=>!current.has(urlToKey(u))); if(!pool.length){toast('Nothing to add');return} if(rand)shuffle(pool); const take=Math.max(1,Math.min(count|0,pool.length)); const sel=pool.slice(0,take); const input=$('#mediaurl')||$('input#mediaurl')||$$('input').find(i=>i.id?.includes('mediaurl')||/url/i.test(i.placeholder||'')); const addEndBtn=$('#queue_end')||$('#addfromurl button.btn.btn-default:last-child')||$$('button').find(b=>/queue to end|queue|add/i.test(b.textContent||'')); const addNextBtn=$('#queue_next')||$$('button').find(b=>/queue next|next/i.test(b.textContent||'')); if(!input||(!addEndBtn&&!addNextBtn)){toast('Could not find Add controls');return} const clicker=(where==='next'&&addNextBtn)?addNextBtn:addEndBtn; if(where==='next'&&!addNextBtn) toast('No “Queue Next”; adding to End.'); let i=0;(async function step(){ if(i>=sel.length){toast(`Added ${sel.length} from “${name}” (${where})`);return} input.value=sel[i++]; clicker.click(); await sleep(160); step(); })(); }

  let addUrlInput=null; // expose for clearing
  function appendUrlToSaved(name,url){ if(!name){toast('Pick a playlist');return} const u=String(url||'').trim(); if(!u){toast('Enter a URL');return} const data=readSaved(name); const keys=new Set((data.items||[]).map(urlToKey)); const k=urlToKey(u); if(keys.has(k)){toast('Already in list');return} data.items=[...(data.items||[]),u]; data.savedAt=Date.now(); writeSaved(name,data); try{ if(addUrlInput) { addUrlInput.value=''; addUrlInput.focus(); } }catch{} toast('Added to saved'); }

  function appendCurrentQueueToSaved(name){ if(!name){toast('Pick a playlist');return} const add=scrapeUrlsFromQueue(); if(!add.length){toast('Current queue is empty');return} const data=readSaved(name); const keys=new Set((data.items||[]).map(urlToKey)); let added=0; for(const u of add){const k=urlToKey(u); if(!keys.has(k)){data.items.push(u); keys.add(k); added++;}} data.savedAt=Date.now(); writeSaved(name,data); toast(added?`Appended ${added}`:'All already present'); }

  function openEditor(name){ if(!name){toast('Pick a playlist');return} const data=readSaved(name); const modal=document.createElement('div'); modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:grid;place-items:center;'; const card=document.createElement('div'); card.style.cssText='width:min(900px,92vw);max-height:86vh;overflow:auto;background:rgba(18,18,18,.6);color:#fff;padding:14px;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.5);font:13px system-ui;backdrop-filter:blur(14px) saturate(140%);border:1px solid rgba(255,255,255,.18)'; const title=document.createElement('div'); title.textContent=`Edit: ${name}`; title.style.cssText='font-weight:700;margin-bottom:8px'; const ta=document.createElement('textarea'); ta.value=(data.items||[]).join('\n'); ta.style.cssText='width:100%;height:48vh;background:rgba(0,0,0,.35);color:#eee;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,.12)'; const row=document.createElement('div'); row.className='ct-row'; const btn=(label,fn)=>{const b=document.createElement('button'); b.textContent=label; b.className='ct-btn'; b.addEventListener('click',fn); return b;}; const dedupeBtn=btn('Dedupe',()=>{const lines=ta.value.split('\n').map(s=>s.trim()).filter(Boolean); const seen=new Set(); const out=[]; for(const u of lines){const k=urlToKey(u); if(!seen.has(k)){seen.add(k); out.push(u);} } ta.value=out.join('\n'); toast(`Deduped to ${out.length}`);}); const saveBtn=btn('Save',()=>{const lines=ta.value.split('\n').map(s=>s.trim()).filter(Boolean); writeSaved(name,{savedAt:Date.now(),items:lines}); toast('Saved'); document.body.removeChild(modal);}); const cancelBtn=btn('Cancel',()=>document.body.removeChild(modal)); row.append(dedupeBtn,saveBtn,cancelBtn); card.append(title,ta,row); modal.append(card); modal.addEventListener('click',(e)=>{if(e.target===modal)document.body.removeChild(modal)}); document.body.appendChild(modal); }

  function deleteName(name){ if(!name){toast('Pick a name');return} localStorage.removeItem(KEY(name)); const idx=setIndex(getIndex().filter(n=>n!==name)); refreshList(idx,idx[0]||''); if(usingRemote()&&DBSTATE.cache&&DBSTATE.cache.playlists){ delete DBSTATE.cache.playlists[name]; } toast(`Deleted “${name}”`); }

  // export/import
  function exportAll(){ let payload; if(DBSTATE.connected&&DBSTATE.cache) payload=DBSTATE.cache; else { const all={}; for(const n of getIndexLocal()){ const raw=localStorage.getItem(KEY(n)); if(raw) all[n]=JSON.parse(raw);} payload={channel:channelName,data:all}; } const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`cytube_saved_playlists_${channelName}.json`; a.click(); URL.revokeObjectURL(a.href); toast('Exported JSON'); }
  function importAll(file){ const fr=new FileReader(); fr.onload=async()=>{ try{ const parsed=JSON.parse(fr.result); if(DBSTATE.connected&&DBSTATE.cache){ if(parsed.playlists) DBSTATE.cache=parsed; else if(parsed.data) DBSTATE.cache.playlists={...DBSTATE.cache.playlists,...parsed.data}; else DBSTATE.cache.playlists={...DBSTATE.cache.playlists,...parsed}; await drivePush().catch(()=>toast('Push failed after import')); refreshList(getIndex(),''); toast('Imported to remote DB'); } else { const data=parsed.data||parsed; let idx=getIndexLocal(); for(const [name,payload] of Object.entries(data)){ localStorage.setItem(KEY(name),JSON.stringify(payload)); idx.push(name);} idx=setIndexLocal(idx); refreshList(idx,idx[0]||''); toast('Imported playlists (local)'); } }catch{ toast('Import failed (bad JSON)'); } }; fr.readAsText(file); }

  // auto sync
  const isAutoPush =()=> localStorage.getItem(AUTOPUSH)==='1';
  const setAutoPush=(v)=> localStorage.setItem(AUTOPUSH, v?'1':'0');
  const isAutoPull =()=> { const v=localStorage.getItem(AUTOPULL); return v==null ? true : v==='1'; };
  const setAutoPull=(v)=> localStorage.setItem(AUTOPULL, v?'1':'0');
  const getPullMs =()=>{ const n=Number(localStorage.getItem(AUTOPULL_MS_KEY)); return Number.isFinite(n)&&n>=MIN_PULL_MS ? n : DEFAULT_PULL_MS; };
  async function maybeAutoPush(){ if(DBSTATE.connected&&DBSTATE.cache&&isAutoPush()){ try{ await drivePush(); }catch(e){ console.error(e); toast('Auto-push failed'); } } }
  let pullTimer=null; const currentRev=()=>String(DBSTATE?.cache?.sync?.rev||'');
  function startAutoPull(){ stopAutoPull(); if(!DBSTATE.connected) return; if(!isAutoPull()) return; let pulling=false; const pullNow=async()=>{ if(pulling) return; pulling=true; try{ const before=currentRev(); await drivePull(); const after=currentRev(); if(before!==after){ refreshList(getIndex(),''); } }catch(e){} finally{ pulling=false; updateStatusChips(); } }; pullTimer=setInterval(pullNow, getPullMs()); pullNow(); document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') pullNow(); }); window.addEventListener('storage', (e)=>{ if(e.key===REV_BROADCAST_KEY) pullNow(); }); }
  function stopAutoPull(){ if(pullTimer){ clearInterval(pullTimer); pullTimer=null; } }

  // CSS
  function injectGlassCSS(){ if($('#ct-savedpl-style')) return; const css=`
#ct-savedpl-panel{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;margin:0;max-width:min(1100px,96vw);backdrop-filter:blur(16px) saturate(160%);-webkit-backdrop-filter:blur(16px) saturate(160%);background:rgba(20,20,22,.55);color:#fff;border-radius:16px;border:1px solid rgba(255,255,255,.18);box-shadow:0 20px 60px rgba(0,0,0,.45);font:12px/1.2 system-ui}
#ct-savedpl-header{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer}
#ct-savedpl-title{font-weight:700;letter-spacing:.2px}
.ct-chip{padding:4px 8px;border-radius:12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)}
#ct-savedpl-body{overflow:hidden;transition:max-height .25s ease, opacity .2s ease;opacity:1}
.ct-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px}
.ct-sep{height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),transparent);margin:4px 0}
.ct-btn{padding:6px 10px;cursor:pointer;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#fff}
.ct-input,.ct-select{padding:6px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(34,34,38,.9);color:#fff;min-height:28px;appearance:none;-webkit-appearance:none;-moz-appearance:none}
.ct-select option{background:#1a1b1e;color:#fff}
.ct-tight{padding:4px 8px}
.ct-caret{user-select:none;font-size:14px;opacity:.9}
#ct-db-section{overflow:hidden;transition:max-height .25s ease, opacity .2s ease;opacity:1}
#ct-db-head{display:flex;align-items:center;gap:10px;padding:6px 12px}
#ct-status{margin-left:auto}
`; const style=document.createElement('style'); style.id='ct-savedpl-style'; style.textContent=css; document.head.appendChild(style);}

  // status chips
  function updateStatusChips(){ const txt=(DBSTATE.connected&&DBSTATE.dbId)?`Connected (${String(DBSTATE.dbId).slice(0,8)}…)`:'Local (offline)'; const header=$('#ct-status'); if(header) header.textContent=txt; const dbchip=$('#ct-db-head .ct-chip'); if(dbchip) dbchip.textContent=txt; }

  // UI globals
  let selectEl,modeEl,whereEl,countEl,nameInput;

  function refreshList(names,selectName){ if(!selectEl) return; selectEl.innerHTML=''; const ph=document.createElement('option'); ph.value=''; ph.textContent='(choose a playlist)'; selectEl.appendChild(ph); for(const n of names){ const o=document.createElement('option'); o.value=n; o.textContent=n; if(n===selectName) o.selected=true; selectEl.appendChild(o);} }
  function button(label,fn){ const b=document.createElement('button'); b.textContent=label; b.className='ct-btn'; b.addEventListener('click',fn); return b; }

  function attachDatabaseUI(container){
    const wrap=document.createElement('div');
    const head=document.createElement('div'); head.id='ct-db-head';
    const caret=document.createElement('span'); caret.className='ct-caret ct-btn ct-tight'; caret.textContent='▾';
    const title=document.createElement('span'); title.textContent='Database';
    const statusChip=document.createElement('span'); statusChip.className='ct-chip';

    // Toggles
    const autoPushChip=document.createElement('label'); autoPushChip.className='ct-chip'; autoPushChip.style.cursor='pointer';
    const autoPushCb=document.createElement('input'); autoPushCb.type='checkbox'; autoPushCb.style.marginRight='6px'; autoPushCb.checked=isAutoPush();
    autoPushChip.append(autoPushCb, document.createTextNode('Auto-Push'));

    const autoPullChip=document.createElement('label'); autoPullChip.className='ct-chip'; autoPullChip.style.cursor='pointer';
    const autoPullCb=document.createElement('input'); autoPullCb.type='checkbox'; autoPullCb.style.marginRight='6px'; autoPullCb.checked=isAutoPull();
    autoPullChip.append(autoPullCb, document.createTextNode('Auto-Sync'));

    head.append(caret,title,statusChip,autoPushChip,autoPullChip);

    const body=document.createElement('div'); body.id='ct-db-section';
    const row=document.createElement('div'); row.className='ct-row';

    autoPushCb.addEventListener('change',()=>{ setAutoPush(autoPushCb.checked); if(autoPushCb.checked) maybeAutoPush(); });
    autoPullCb.addEventListener('change',()=>{ setAutoPull(autoPullCb.checked); if(autoPullCb.checked) startAutoPull(); else stopAutoPull(); });

    const createBtn=button('Create', async()=>{
      const baseUrl=prompt('Paste your Google Apps Script Web App URL (ends with /exec):', DBSTATE.baseUrl||''); if(!baseUrl) return;
      try{ const dbId=await driveInit(baseUrl); DBSTATE.baseUrl=baseUrl; DBSTATE.dbId=dbId; DBSTATE.connected=true; await drivePull(); saveConnPerChannel(); updateStatusChips(); refreshList(getIndex(),''); startAutoPull(); toast('Database created & connected.'); }
      catch(e){ console.error(e); toast('Create failed'); }
    });
    const connectBtn=button('Connect', async()=>{
      const link=prompt('Paste DB link (https://.../exec?db=UUID[&token=SECRET])',''); if(!link) return;
      try{ const u=new URL(link); DBSTATE.baseUrl=link.split('?')[0]; DBSTATE.dbId=u.searchParams.get('db')||''; DBSTATE.token=u.searchParams.get('token')||''; if(!DBSTATE.dbId){ toast('Missing db param'); return; } DBSTATE.connected=true; await drivePull(); saveConnPerChannel(); updateStatusChips(); refreshList(getIndex(),''); startAutoPull(); toast('Connected.'); }
      catch(e){ console.error(e); toast('Connect failed'); }
    });

    const pullBtn=button('Pull now', async()=>{ try{ await drivePull(); refreshList(getIndex(),''); updateStatusChips(); toast('Pulled.'); }catch(e){ toast('Pull failed'); }});
    const pushBtn=button('Push', async()=>{ if(!DBSTATE.connected){toast('Not connected');return} try{ await drivePush(); toast('Pushed.'); }catch(e){ console.error(e); toast(String(e.message||e)); } });
    const copyBtn=button('Copy Link',()=>{ if(!DBSTATE.connected){toast('Not connected');return} const link=`${DBSTATE.baseUrl}?db=${encodeURIComponent(DBSTATE.dbId)}${DBSTATE.token?`&token=${encodeURIComponent(DBSTATE.token)}`:''}`; navigator.clipboard.writeText(link).then(()=>toast('DB link copied')); });
    const debugBtn=button('Debug',()=>{ alert(`[CyTube DB Debug]\nconnected: ${DBSTATE.connected}\nbaseUrl: ${DBSTATE.baseUrl}\ndbId: ${DBSTATE.dbId}\ntokenSet: ${DBSTATE.token?'yes':'no'}\ncache?: ${DBSTATE.cache?'yes':'no'}\nautoPush: ${isAutoPush()?'on':'off'}\nautoPull: ${isAutoPull()?'on':'off'}\npullMs: ${getPullMs()} ms`); });
    const discBtn=button('Disconnect',()=>{ DBSTATE.connected=false; DBSTATE.baseUrl=''; DBSTATE.dbId=''; DBSTATE.token=''; DBSTATE.cache=null; localStorage.removeItem(`ct_db_conn:${channelName}`); updateStatusChips(); refreshList(getIndex(),''); stopAutoPull(); toast('Disconnected (local mode).'); });

    row.append(createBtn,connectBtn,pullBtn,pushBtn,copyBtn,debugBtn,discBtn);
    body.append(row);

    function syncDbCollapsedUI(){ const collapsed=localStorage.getItem(UIKEY_DB)==='1'; caret.textContent=collapsed?'▸':'▾'; if(!collapsed){ body.style.maxHeight='none'; body.style.opacity='1'; body.setAttribute('aria-hidden','false'); } else { body.style.maxHeight=(body.scrollHeight||0)+'px'; requestAnimationFrame(()=>{ body.style.maxHeight='0px'; body.style.opacity='0'; body.setAttribute('aria-hidden','true'); }); } }
    const toggleDb=()=>{
      const now=localStorage.getItem(UIKEY_DB)==='1'?'0':'1';
      localStorage.setItem(UIKEY_DB,now);
      if(now==='0'){
        body.style.maxHeight=body.scrollHeight+'px';
        body.style.opacity='1';
        body.setAttribute('aria-hidden','false');
        setTimeout(()=>{ body.style.maxHeight='none'; },260);
      }
      // also make sure the main panel body can grow when DB expands
      try{
        const mainBody=document.getElementById('ct-savedpl-body');
        if(mainBody){
          if(now==='0'){ // expanding DB
            mainBody.style.maxHeight='none';
            mainBody.style.opacity='1';
          }
        }
      }catch{}
      syncDbCollapsedUI();
    };
    caret.addEventListener('click',toggleDb);
    head.addEventListener('click',(e)=>{ if(e.target!==caret) toggleDb(); });

    wrap.append(head,body); container.append(wrap);
    updateStatusChips(); syncDbCollapsedUI();
  }

  function injectUI(){
    try{
      if($('#ct-savedpl-panel')) return;
      injectGlassCSS();
      const panel=document.createElement('div'); panel.id='ct-savedpl-panel';
      const header=document.createElement('div'); header.id='ct-savedpl-header';
      const caret=document.createElement('span'); caret.className='ct-caret ct-btn ct-tight'; caret.textContent='▾';
      const title=document.createElement('div'); title.id='ct-savedpl-title'; title.textContent='Saved Playlists';
      const chan=document.createElement('span'); chan.className='ct-chip'; chan.textContent=`${channelName}`;
      const status=document.createElement('span'); status.id='ct-status'; status.className='ct-chip'; status.textContent='Local (offline)';
      header.append(caret,title,chan,status); panel.append(header);

      const body=document.createElement('div'); body.id='ct-savedpl-body'; panel.append(body);

      const row1=document.createElement('div'); row1.className='ct-row';
      const row2=document.createElement('div'); row2.className='ct-row';
      const row3=document.createElement('div'); row3.className='ct-row';
      const row4=document.createElement('div'); row4.className='ct-row';
      const row5=document.createElement('div'); row5.className='ct-row';

      // Row 1 — Load/Delete
      const select=document.createElement('select'); select.className='ct-select'; select.style.minWidth='180px'; selectEl=select;
      const mode=document.createElement('select'); mode.className='ct-select'; mode.innerHTML='<option value="replace">Replace</option><option value="append">Append</option>'; modeEl=mode;
      const loadBtn=button('Load (All)',()=>loadWhole(selectEl.value, modeEl.value));
      const delBtn=button('Delete',()=>deleteName(selectEl.value));
      row1.append(selectEl,modeEl,loadBtn,delBtn);

      // Row 2 — Add N
      const whereSel=document.createElement('select'); whereSel.className='ct-select'; whereSel.innerHTML='<option value="next">Next</option><option value="end">End</option>'; whereEl=whereSel;
      const countInput=document.createElement('input'); countInput.type='number'; countInput.min='1'; countInput.value='5'; countInput.className='ct-input'; countInput.style.width='72px'; countEl=countInput;
      const randomWrap=document.createElement('label'); randomWrap.className='ct-chip'; randomWrap.style.cursor='pointer';
      const randomCb=document.createElement('input'); randomCb.type='checkbox'; randomCb.checked=true; randomCb.style.marginRight='6px';
      randomWrap.append(randomCb, document.createTextNode('Random'));
      const addNBtn=button('Add N',()=>{ const n=parseInt(countEl.value,10)||1; const where=whereEl.value; addNFromSaved(selectEl.value,n,where,randomCb.checked); });
      row2.append(whereEl,countEl,randomWrap,addNBtn);

      // Row 3 — Save As
      const nameIn=document.createElement('input'); nameIn.placeholder='Save As… (name)'; nameIn.className='ct-input'; nameIn.style.minWidth='180px'; nameInput=nameIn;
      const saveBtn=button('Save As',()=>saveAs(nameInput.value.trim()));
      row3.append(nameInput,saveBtn);

      // Row 4 — Edit/Append
      const urlIn=document.createElement('input'); urlIn.placeholder='Add URL to saved…'; urlIn.className='ct-input'; urlIn.style.minWidth='260px'; addUrlInput=urlIn;
      const addUrlBtn=button('Add URL',()=>appendUrlToSaved(selectEl.value, addUrlInput.value));
      const addCurrentBtn=button('Add Current',()=>appendCurrentQueueToSaved(selectEl.value));
      const editBtn=button('Edit…',()=>openEditor(selectEl.value));
      row4.append(addUrlInput,addUrlBtn,addCurrentBtn,editBtn);

      // Row 5 — Utilities
      const listBtn=button('List',()=>toast(getIndex().join(', ')||'No saved playlists'));
      const exportBtn=button('Export',exportAll);
      const importInput=document.createElement('input'); importInput.type='file'; importInput.accept='application/json'; importInput.style.display='none';
      importInput.addEventListener('change',()=>{ if(importInput.files?.[0]) importAll(importInput.files[0]); importInput.value=''; });
      const importBtn=button('Import',()=>importInput.click());
      row5.append(listBtn,exportBtn,importBtn,importInput);

      const sep=()=>{ const d=document.createElement('div'); d.className='ct-sep'; return d; };
      body.append(row1,sep(),row2,sep(),row3,sep(),row4,sep(),row5,sep());

      attachDatabaseUI(body);

      document.body.prepend(panel);
      refreshList(getIndex(),'');

      // Collapsible main
      function syncMain(){
        const collapsed=localStorage.getItem(UIKEY_MAIN)==='1';
        caret.textContent=collapsed?'▸':'▾';
        const ensureAuto=()=>{ body.style.maxHeight='none'; body.style.opacity='1'; };
        if(collapsed){
          // collapse with transition
          body.style.maxHeight = (body.scrollHeight||0)+'px';
          requestAnimationFrame(()=>{ body.style.maxHeight='0px'; body.style.opacity='0'; });
        } else {
          // expand and then free the height so inner sections can grow
          body.style.maxHeight = (body.scrollHeight||0)+'px';
          body.style.opacity='1';
                   setTimeout(ensureAuto, 260);
        }
      }
      header.addEventListener('click',()=>{ const now=localStorage.getItem(UIKEY_MAIN)==='1'?'0':'1'; localStorage.setItem(UIKEY_MAIN,now); syncMain(); });
      requestAnimationFrame(syncMain);

      // Auto-connect
      if(loadConnPerChannel()){
        updateStatusChips();
        (async()=>{ try{ await drivePull(); refreshList(getIndex(),''); }catch{} startAutoPull(); })();
      }
    }catch(e){ console.error('[Glass] UI init failed:',e); toast('Glass UI failed: '+(e.message||e)); }
  }

  // build UI
  try{
    if(document.readyState==='complete' || document.readyState==='interactive') injectUI();
    else document.addEventListener('DOMContentLoaded', injectUI);
  }catch(e){ console.error('[Glass] boot error',e); }
})();
