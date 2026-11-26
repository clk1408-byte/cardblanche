/* CardBlanche — best card per purchase, wallet history and pay runs.
   App code only; all personal data lives in a private GitHub repo (default clk1408-byte/card-wallet-data). */
"use strict";

/* ================= small helpers ================= */
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS={get:k=>{try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));return true}catch(e){return false}},del:k=>{try{localStorage.removeItem(k)}catch(e){}}};
const uid=p=>(p||'id')+'-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const clone=o=>o==null?o:JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const today=()=>{const d=new Date();d.setHours(0,0,0,0);return d};
const isoD=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const todayISO=()=>isoD(today());
const parseD=s=>{if(!s)return null;const[y,m,d]=String(s).split('-').map(Number);if(!y)return null;return new Date(y,(m||1)-1,d||1)};
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x};
const daysBetween=(a,b)=>Math.round((b-a)/864e5);
const daysUntil=s=>{const d=typeof s==='string'?parseD(s):s;return d?daysBetween(today(),d):null};
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate=s=>{const d=typeof s==='string'?parseD(s):s;if(!d)return'';return d.toLocaleDateString('en-CA',{month:'short',day:'numeric',year:d.getFullYear()!==new Date().getFullYear()?'numeric':undefined})};
const fmtDateY=s=>{const d=parseD(s);return d?d.toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric'}):''};
const dayWord=n=>n===0?'today':n===1?'tomorrow':n===-1?'yesterday':n<0?`${-n} days ago`:`in ${n} days`;
const money=(n,cur)=>{const v=Number(n||0);return (cur==='USD'?'US$':'$')+v.toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2})};
const moneyR=(n,cur)=>(cur==='USD'?'US$':'$')+Math.round(Number(n||0)).toLocaleString('en-CA');
const fmtPct=p=>(Math.round(p*100)/100).toString()+'%';
const r2=n=>Math.round(Number(n||0)*100)/100;
function toast(t){const el=document.createElement('div');el.className='toast';el.textContent=t;document.body.appendChild(el);setTimeout(()=>el.remove(),2600)}

/* ================= data store + GitHub sync =================
   files[name] = {sha, data}  — what GitHub had the last time we looked (the "base")
   data[name]                 — this device's current copy
   dirty[name] = reason text  — changed here, not yet on GitHub
   On a clash, both sides are merged against the base, record by record. */
const FILES=['cards.json','card-events.json','payruns.json','balances.json','settings.json'];
const KEYF={'cards.json':r=>r.id,'card-events.json':r=>r.id,'payruns.json':r=>r.id,'balances.json':r=>r.runId+'|'+r.cardId};
const EMPTY={'cards.json':[],'card-events.json':[],'payruns.json':[],'balances.json':[],'settings.json':{}};
const ST={cfg:LS.get('cb_cfg'),files:{},data:{},dirty:{},head:null,etag:null,sync:{state:'idle',msg:'',at:LS.get('cb_lastsync')}};
(function load(){const s=LS.get('cb_state');if(s){ST.files=s.files||{};ST.data=s.data||{};ST.dirty=s.dirty||{};ST.head=s.head||null;ST.imgTree=s.imgTree||null;ST.imgIndex=s.imgIndex||{};
    /* saved by a version that didn't know about card images: look at the whole repo again */
    if(!('imgIndex' in s))ST.head=null}
  FILES.forEach(f=>{if(ST.data[f]==null)ST.data[f]=clone(EMPTY[f])})})();
let persistT=null;
function persist(){clearTimeout(persistT);persistT=setTimeout(()=>{if(!LS.set('cb_state',{files:ST.files,data:ST.data,dirty:ST.dirty,head:ST.head,imgTree:ST.imgTree,imgIndex:ST.imgIndex}))toast('Couldn’t save on this device — storage full?')},120)}
const D={get cards(){return ST.data['cards.json']},get events(){return ST.data['card-events.json']},get runs(){return ST.data['payruns.json']},get bals(){return ST.data['balances.json']},get settings(){return ST.data['settings.json']}};
function change(file,why){const cur=ST.dirty[file];why=why||'update';
  /* one commit can carry several changes: list them all in its message */
  if(!cur)ST.dirty[file]=why;else if(!cur.split('; ').includes(why)){const j=cur+'; '+why;ST.dirty[file]=j.length>200?j.slice(0,197)+'…':j}
  persist();queueSync(3500)}
function upsert(file,rec,why){rec.updatedAt=Date.now();const arr=ST.data[file];const k=KEYF[file](rec);const i=arr.findIndex(r=>KEYF[file](r)===k);if(i>=0)arr[i]=rec;else arr.push(rec);change(file,why)}
function removeRec(file,rec,why){const arr=ST.data[file];const k=KEYF[file](rec);const i=arr.findIndex(r=>KEYF[file](r)===k);if(i>=0)arr.splice(i,1);change(file,why)}
function setSetting(key,val,why){const s=D.settings;s[key]=val;s.updatedAt=Date.now();change('settings.json',why||('settings: '+key))}

/* three-way merge: take whichever side changed; if both did, keep the newer record */
function merge3(file,base,local,remote){
  if(file==='settings.json'){const out={};const keys=new Set([...Object.keys(base||{}),...Object.keys(local||{}),...Object.keys(remote||{})]);
    keys.forEach(k=>{if(k==='updatedAt')return;const b=(base||{})[k],l=(local||{})[k],r=(remote||{})[k];
      if(same(l,b))out[k]=r;else if(same(r,b))out[k]=l;else out[k]=((local||{}).updatedAt||0)>=((remote||{}).updatedAt||0)?l:r;if(out[k]===undefined)delete out[k]});
    out.updatedAt=Math.max((local||{}).updatedAt||0,(remote||{}).updatedAt||0);return out}
  const key=KEYF[file];const map=a=>new Map((a||[]).map(r=>[key(r),r]));const B=map(base),L=map(local),R=map(remote);const out=[];
  const keys=[...new Set([...R.keys(),...L.keys()])];
  for(const k of keys){const b=B.get(k),l=L.get(k),r=R.get(k);
    if(l===undefined){if(b!==undefined&&same(r,b))continue;out.push(r);continue}           // deleted here, untouched there
    if(r===undefined){if(b!==undefined&&same(l,b))continue;out.push(l);continue}           // deleted there, untouched here
    if(same(l,b))out.push(r);else if(same(r,b))out.push(l);else out.push((l.updatedAt||0)>=(r.updatedAt||0)?l:r)}
  return out}

const b64enc=str=>{const bytes=new TextEncoder().encode(str);let b='';for(let i=0;i<bytes.length;i+=0x8000)b+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(b)};
const b64dec=s=>{const b=atob(String(s).replace(/\s/g,''));const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new TextDecoder().decode(u)};
async function gh(path,opt={}){const c=ST.cfg;const r=await fetch('https://api.github.com'+path,{method:opt.method||'GET',cache:'no-store',
    headers:Object.assign({'Accept':'application/vnd.github+json','Authorization':'Bearer '+c.token,'X-GitHub-Api-Version':'2022-11-28'},opt.body?{'Content-Type':'application/json'}:{},opt.etag?{'If-None-Match':opt.etag}:{}),
    body:opt.body?JSON.stringify(opt.body):undefined});
  if(r.status===304)return{status:304};let j=null;try{j=await r.json()}catch(e){}
  if(!r.ok){const e=new Error((j&&j.message)||('HTTP '+r.status));e.status=r.status;throw e}return{status:r.status,json:j,etag:r.headers.get('ETag')}}
const REPO=()=>`/repos/${encodeURIComponent(ST.cfg.owner)}/${encodeURIComponent(ST.cfg.repo)}`;
const BR=()=>(ST.cfg&&ST.cfg.branch)||'main';
let syncing=false,syncAgain=false,syncTimer=null;
function queueSync(ms){clearTimeout(syncTimer);syncTimer=setTimeout(()=>sync(),ms)}
function setSync(state,msg){ST.sync.state=state;ST.sync.msg=msg||'';if(state==='ok'){ST.sync.at=Date.now();LS.set('cb_lastsync',ST.sync.at)}drawSync()}
function drawSync(){const d=$('#syncdot'),t=$('#synctxt');if(!d)return;const s=ST.sync,n=Object.keys(ST.dirty).length;
  d.className='dot '+({ok:'ok',busy:'busy',wait:'busy',err:'err',offline:'err'}[s.state]||'');
  t.textContent=!ST.cfg?'Not connected':s.state==='busy'?'Syncing…':s.state==='err'?(s.msg||'Sync problem'):s.state==='offline'?(n?`Offline · ${n} waiting`:'Offline'):n?`${n} change${n>1?'s':''} waiting`:s.at?'Synced':'…'}
async function sync(force){
  if(!ST.cfg||!ST.cfg.token)return;if(syncing){syncAgain=true;return}
  if(navigator.onLine===false){setSync('offline');return}
  syncing=true;setSync('busy');let changed=false;
  try{
    const head=await gh(`${REPO()}/branches/${encodeURIComponent(BR())}`,{etag:force?null:ST.etag});
    if(head.status!==304){ST.etag=head.etag;const sha=head.json.commit.sha;if(sha!==ST.head||force){await pull(head.json.commit.commit.tree.sha);ST.head=sha;changed=true}}
    if(await push())changed=true;
    persist();if(changed)render();if(IMG.dirty||Object.keys(ST.imgIndex).some(k=>IMG.have[k]!==ST.imgIndex[k].sha))loadImages();
    const n=Object.keys(ST.dirty).length;setSync(n?'wait':'ok')}
  catch(e){const s=e.status;setSync(s?'err':'offline',s===401?'Access key rejected or expired':s===404?'Can’t find the data repo — check the key’s access':s===403?('GitHub refused: '+e.message):s===409||s===422?'Conflict — retrying':(e.message||'Sync failed'));if(s===409||s===422)syncAgain=true}
  finally{syncing=false;if(syncAgain){syncAgain=false;queueSync(900)}}}
async function pull(treeSha){
  const t=await gh(`${REPO()}/git/trees/${treeSha}`);const remote={};for(const n of t.json.tree)if(n.type==='blob'&&FILES.includes(n.path))remote[n.path]=n.sha;
  for(const f of FILES){const sha=remote[f];const base=ST.files[f];
    if(!sha){if(base){delete ST.files[f]}continue}
    if(base&&base.sha===sha)continue;
    const b=await gh(`${REPO()}/git/blobs/${sha}`);let rd;try{rd=JSON.parse(b64dec(b.json.content))}catch(e){continue}
    adoptRemote(f,sha,rd)}
  const it=t.json.tree.find(n=>n.type==='tree'&&n.path==='card-images');
  if(!it){ST.imgTree=null;ST.imgIndex={}}
  else if(it.sha!==ST.imgTree){const l=await gh(`${REPO()}/git/trees/${it.sha}`);const idx={};for(const n of l.json.tree)if(n.type==='blob'&&/\.(webp|png|jpe?g)$/i.test(n.path))idx[n.path.replace(/\.\w+$/,'')]={sha:n.sha,file:n.path};ST.imgIndex=idx;ST.imgTree=it.sha;IMG.dirty=true}}
function adoptRemote(f,sha,rd){const base=ST.files[f];
  if(ST.dirty[f]){const m=merge3(f,base?base.data:clone(EMPTY[f]),ST.data[f],rd);ST.data[f]=m;if(same(m,rd))delete ST.dirty[f]}
  else ST.data[f]=clone(rd);
  ST.files[f]={sha,data:clone(rd)}}
async function push(){let did=false;
  for(const f of FILES){if(!ST.dirty[f])continue;
    for(let attempt=0;attempt<4;attempt++){const why=ST.dirty[f];const snap=JSON.stringify(ST.data[f],null,1)+'\n';const base=ST.files[f];
      const body={message:`${deviceName()}: ${why}`,content:b64enc(snap),branch:BR()};if(base&&base.sha)body.sha=base.sha;
      try{const r=await gh(`${REPO()}/contents/${encodeURIComponent(f)}`,{method:'PUT',body});
        ST.files[f]={sha:r.json.content.sha,data:JSON.parse(snap)};if(JSON.stringify(ST.data[f],null,1)+'\n'===snap)delete ST.dirty[f];
        if(r.json.commit&&r.json.commit.sha)ST.head=r.json.commit.sha;did=true;break}
      catch(e){if(e.status!==409&&e.status!==422)throw e;
        /* someone else saved this file first: fetch theirs, merge, try again */
        let cur=null;try{cur=await gh(`${REPO()}/contents/${encodeURIComponent(f)}?ref=${encodeURIComponent(BR())}`)}catch(x){if(x.status!==404)throw x}
        if(cur&&cur.json&&cur.json.sha){let rd;try{rd=JSON.parse(b64dec(cur.json.content))}catch(x){rd=clone(EMPTY[f])}adoptRemote(f,cur.json.sha,rd);ST.dirty[f]=ST.dirty[f]||why}
        else delete ST.files[f];
        if(!ST.dirty[f])break}}}
  return did}
const APP_VERSION='1.1.2';
const deviceName=()=>(ST.cfg&&ST.cfg.device)||'CardBlanche';
window.addEventListener('online',()=>queueSync(300));window.addEventListener('offline',()=>setSync('offline'));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')queueSync(300);else if(Object.keys(ST.dirty).length)sync()});
setInterval(()=>{if(document.visibilityState==='visible')sync()},3*60*1000);

/* ================= card images =================
   card-images/<catalogId>.webp is shared by every card of that product; card-images/card-<cardId>.webp is for one card only.
   Images are downloaded once per device and kept in IndexedDB, so they show offline. */
const IMG={urls:{},have:{},dirty:false,busy:false};
const IDB={db:null,open(){return this.db||(this.db=new Promise((res,rej)=>{const r=indexedDB.open('cardblanche',1);r.onupgradeneeded=()=>r.result.createObjectStore('img');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}))},
  async get(k){const db=await this.open();return new Promise(res=>{const q=db.transaction('img').objectStore('img').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>res(null)})},
  async set(k,v){const db=await this.open();return new Promise(res=>{const tx=db.transaction('img','readwrite');tx.objectStore('img').put(v,k);tx.oncomplete=()=>res(true);tx.onerror=()=>res(false)})}};
function imgKeyFor(d){if(d.cardId){if(IMG.urls['card-'+d.cardId]||ST.imgIndex['card-'+d.cardId])return 'card-'+d.cardId;return d.catalogId||null}return d.id||null}
const imgUrl=d=>{const k=imgKeyFor(d);return k?IMG.urls[k]||null:null};
async function loadImages(){if(IMG.busy)return;IMG.busy=true;let got=0;
  try{const mine=new Set();D.cards.forEach(c=>{mine.add('card-'+c.id);if(c.catalogId)mine.add(c.catalogId)});
    const keys=Object.keys(ST.imgIndex).sort((a,b)=>(mine.has(b)-mine.has(a)));
    for(const k of keys){const e=ST.imgIndex[k];if(IMG.have[k]===e.sha)continue;
      let rec=null;try{rec=await IDB.get(k)}catch(x){}
      if(!rec||rec.sha!==e.sha){if(!ST.cfg||navigator.onLine===false)continue;
        try{const b=await gh(`${REPO()}/git/blobs/${e.sha}`);const bin=atob(b.json.content.replace(/\s/g,''));const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
          const type=/\.png$/i.test(e.file)?'image/png':/\.jpe?g$/i.test(e.file)?'image/jpeg':'image/webp';rec={sha:e.sha,blob:new Blob([u],{type})};await IDB.set(k,rec)}catch(x){continue}}
      if(IMG.urls[k])URL.revokeObjectURL(IMG.urls[k]);IMG.urls[k]=URL.createObjectURL(rec.blob);IMG.have[k]=e.sha;got++;
      if(got%8===0)render()}
    Object.keys(IMG.urls).forEach(k=>{if(!ST.imgIndex[k]){URL.revokeObjectURL(IMG.urls[k]);delete IMG.urls[k];delete IMG.have[k]}})}
  finally{IMG.busy=false;IMG.dirty=false;if(got)render()}}
async function resizeCardImage(file){const url=URL.createObjectURL(file);try{const im=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error('Can’t read that image'));i.src=url});
  let w=im.naturalWidth,h=im.naturalHeight;const rot=h>w;const W0=rot?h:w,H0=rot?w:h;const sc=Math.min(1,800/W0);const W=Math.round(W0*sc),H=Math.round(H0*sc);
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;const x=cv.getContext('2d');if(rot){x.translate(W,0);x.rotate(Math.PI/2);x.drawImage(im,0,0,H,W)}else x.drawImage(im,0,0,W,H);
  const blob=await new Promise(res=>cv.toBlob(res,'image/webp',0.92));if(!blob||blob.type!=='image/webp')return await new Promise(res=>cv.toBlob(res,'image/png'));return blob}finally{URL.revokeObjectURL(url)}}
async function uploadCardImage(c,file,onlyThis){const key=onlyThis||!c.catalogId?'card-'+c.id:c.catalogId;const blob=await resizeCardImage(file);const ext=blob.type==='image/png'?'png':'webp';
  const buf=new Uint8Array(await blob.arrayBuffer());let b='';for(let i=0;i<buf.length;i+=0x8000)b+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));
  const path=`card-images/${key}.${ext}`;const old=ST.imgIndex[key];
  if(old&&old.file!==`${key}.${ext}`){try{await gh(`${REPO()}/contents/card-images/${encodeURIComponent(old.file)}`,{method:'DELETE',body:{message:`${deviceName()}: replace image ${key}`,sha:old.sha,branch:BR()}})}catch(x){}}
  const body={message:`${deviceName()}: card image ${cardLabel(c)}`,content:btoa(b),branch:BR()};const same=ST.imgIndex[key]&&ST.imgIndex[key].file===`${key}.${ext}`;if(same)body.sha=ST.imgIndex[key].sha;
  const r=await gh(`${REPO()}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,{method:'PUT',body});
  const sha=r.json.content.sha;ST.imgIndex[key]={sha,file:`${key}.${ext}`};await IDB.set(key,{sha,blob});if(IMG.urls[key])URL.revokeObjectURL(IMG.urls[key]);IMG.urls[key]=URL.createObjectURL(blob);IMG.have[key]=sha;persist()}

/* ================= cards & rewards ================= */
const ISS2=Object.assign({},ISSUERS,{amexus:'American Express (US)'});
const NW_SHORT={visa:'VISA',mc:'mastercard',amex:'AMEX'};
const S=()=>D.settings;
const cpp=p=>{const o=(S().cpp||{})[p];return o!=null?o:(PROGRAMS[p]?PROGRAMS[p].cpp:1)};
function cardDef(c){
  const base=c.catalogId?CATALOG_BY[c.catalogId]:null;
  const d=Object.assign({rates:{},other:1,caps:[],storeRates:{},color:['#5b6b82','#2a3240'],program:'cash',network:'visa',issuer:'other',fee:0},clone(base)||{},clone(c.custom)||{});
  d.rates=Object.assign({},base?base.rates:{},(c.custom||{}).rates||{});
  const o=c.overrides||{};if(o.rates)Object.assign(d.rates,o.rates);['other','program','noFx'].forEach(k=>{if(o[k]!=null)d[k]=o[k]});
  if(c.network)d.network=c.network;if(c.annualFee!=null)d.fee=c.annualFee;
  if(c.fxFee!=null){d.fxFee=c.fxFee;if(c.fxFee===0)d.noFx=true}
  d.usd=c.currency==='USD'||!!d.usd;d.catalogName=base?base.name:(c.custom&&c.custom.name)||'';
  d.name=c.nickname||c.product||d.catalogName||'Card';d.last4=c.last4||'';d.id=c.id;d.cardId=c.id;d.catalogId=c.catalogId;
  if(!d.color&&ISSUER_COLORS)d.color=ISSUER_COLORS[d.issuer]||ISSUER_COLORS.other;
  return d}
const cardById=id=>D.cards.find(c=>c.id===id);
const cardName=id=>{const c=cardById(id);return c?cardDef(c).name:'Card'};
const cardLabel=c=>{const d=cardDef(c);return d.name+(c.last4?' ·· '+c.last4:'')};
const activeCards=()=>D.cards.filter(c=>c.status!=='closed');
const closedCards=()=>D.cards.filter(c=>c.status==='closed');
function multFor(def,cat,store){if(store&&def.storeRates&&def.storeRates[store]!=null)return def.storeRates[store];if(def.rates[cat]!=null)return def.rates[cat];return def.other}
function returnPct(def,cat,store){
  if(cat==='foreign'){const m=def.rates.foreign!=null?def.rates.foreign:def.other;return m*cpp(def.program)-(def.noFx?0:(def.fxFee!=null?def.fxFee:2.5))}
  return multFor(def,cat,store)*cpp(def.program)}
function capNote(def,cat){const c=(def.caps||[]).find(c=>c.cats.includes(cat));return c?`up to ${moneyR(c.amount)}/${c.period==='month'?'mo':'yr'}`:''}
function multLabel(def,cat,store){if(PROGRAMS[def.program]&&PROGRAMS[def.program].cash)return'';const m=cat==='foreign'?(def.rates.foreign!=null?def.rates.foreign:def.other):multFor(def,cat,store);return m+'x'}
function rank(cat,store){
  const st=store?STORE_BY[store]:null;
  let list=activeCards().map(c=>({c,def:cardDef(c)})).filter(x=>!x.def.usd||cat==='foreign').map(({c,def})=>({c,def,pct:returnPct(def,cat,store),ok:!st||!st.accepts||st.accepts.includes(def.network)}));
  list.sort((a,b)=>(b.ok-a.ok)||(b.pct-a.pct));
  const pins=S().pins||{cat:{},store:{}};const pinId=store?(pins.store||{})[store]:(pins.cat||{})[cat];
  if(pinId){const i=list.findIndex(x=>x.c.id===pinId&&x.ok);if(i>0){const[p]=list.splice(i,1);list.unshift(p)}if(i>=0)list[0].pinned=true}
  return list}
const grad=def=>`linear-gradient(135deg,${def.color[0]},${def.color[1]})`;
function miniCard(def,thumb){const u=imgUrl(def);if(u)return `<div class="mini img${thumb?' thumb':''}" style="background-image:url(${u})"></div>`;return `<div class="mini${thumb?' thumb':''}" style="background:${grad(def)}"><span class="is">${esc((ISS2[def.issuer]||'').replace('American Express','Amex'))}</span><span class="ch"></span><span class="nw">${NW_SHORT[def.network]||''}</span></div>`}
function earnSummary(def,mult){
  const cash=PROGRAMS[def.program]&&PROGRAMS[def.program].cash;
  const lab=(cat,p)=>mult&&!cash?((cat==='other'?def.other:(def.rates[cat]??def.other))+'x'):fmtPct(p);
  const top=CATS.filter(c=>c.id!=='other'&&c.id!=='foreign').map(c=>({c,p:returnPct(def,c.id)})).filter(t=>t.p>returnPct(def,'other')).sort((a,b)=>b.p-a.p).slice(0,mult?4:3);
  const st=mult?Object.entries(def.storeRates||{}).filter(([k,v])=>STORE_BY[k]&&v>((def.rates[STORE_BY[k].cat]??def.other))).slice(0,2).map(([k,v])=>`${STORE_BY[k].name.split(' (')[0]} ${cash?v+'%':v+'x'}`):[];
  return [...st,...top.map(t=>`${t.c.icon} ${lab(t.c.id,t.p)}`),'else '+lab('other',returnPct(def,'other'))].join(' · ')}
function feeText(def){return def.fee?(def.feeNote||moneyR(def.fee,def.usd?'USD':'CAD')+'/yr')+(def.waiver?' · '+def.waiver:''):'No fee'}
/* plain-language earn list written into cards.json so other Claude chats can read it without the catalog */
function earnRecord(c){const d=cardDef(c);const P=PROGRAMS[d.program]||{name:d.program};const out=[];
  CATS.forEach(k=>{if(k.id==='other')return;const m=k.id==='foreign'?(d.rates.foreign!=null?d.rates.foreign:d.other):(d.rates[k.id]!=null?d.rates[k.id]:null);if(m!=null&&m!==d.other)out.push({category:k.id,rate:m,unit:P.name})});
  Object.entries(d.storeRates||{}).forEach(([s,m])=>{if(STORE_BY[s])out.push({category:'store:'+s,rate:m,unit:P.name})});
  out.push({category:'base',rate:d.other,unit:P.name});return out}
function saveCard(c,why){c.earn=earnRecord(c);upsert('cards.json',c,why)}
const EV_ORDER={opened:0,product_switch:2,bonus_spend_started:1,bonus_spend_met:3,closed:9,reopened:8};
function eventsFor(id){return D.events.filter(e=>e.cardId===id).sort((a,b)=>(b.date||'0000').localeCompare(a.date||'0000')||(EV_ORDER[b.type]??5)-(EV_ORDER[a.type]??5)||(b.updatedAt||0)-(a.updatedAt||0))}
function addEvent(e,why){const ev=Object.assign({id:uid('evt'),cardId:null,date:todayISO(),type:'note',fromProduct:null,toProduct:null,amount:null,target:null,deadline:null,note:''},e);upsert('card-events.json',ev,why||`${cardName(ev.cardId)}: ${EV_LABEL[ev.type]||ev.type}`);return ev}
const EV_LABEL={opened:'Opened',product_switch:'Product switch',closed:'Closed',reopened:'Reopened',bonus_spend_started:'Bonus spend started',bonus_spend_met:'Bonus spend met',fee_charged:'Annual fee charged',retention_offer:'Retention offer',note:'Note'};
const EV_ICON={opened:'🟢',product_switch:'🔁',closed:'⛔',reopened:'↩️',bonus_spend_started:'🎯',bonus_spend_met:'🏁',fee_charged:'💸',retention_offer:'🤝',note:'📝'};
/* open welcome-bonus spend: the latest "started" with no "met" after it */
function openBonus(cardId){const ev=eventsFor(cardId).slice().reverse();let open=null;ev.forEach(e=>{if(e.type==='bonus_spend_started')open=e;if(e.type==='bonus_spend_met')open=null});return open}
function bonusSpent(cardId,b){if(b.spentManual!=null)return{amt:b.spentManual,manual:true};
  const start=b.date||'0000';const runs=new Map(D.runs.filter(r=>r.status!=='discarded').map(r=>[r.id,r]));
  const amt=D.bals.filter(x=>x.cardId===cardId&&x.balance!=null&&runs.has(x.runId)&&runs.get(x.runId).date>=start).reduce((a,x)=>a+Math.max(0,x.balance),0);return{amt,manual:false}}
function nextDue(c,from){if(!c.dueDay)return null;const f=from?new Date(from):today();const mk=(y,m)=>{const dim=new Date(y,m+1,0).getDate();return new Date(y,m,Math.min(c.dueDay,dim))};let d=mk(f.getFullYear(),f.getMonth());if(d<f)d=mk(f.getFullYear(),f.getMonth()+1);return d}
function nextFee(c){if(!c.feeRenewalMonth||!(c.annualFee>0))return null;const t=today();let d=new Date(t.getFullYear(),c.feeRenewalMonth-1,1);if(d<new Date(t.getFullYear(),t.getMonth(),1))d=new Date(t.getFullYear()+1,c.feeRenewalMonth-1,1);return d}

/* ================= sheets & router ================= */
function sheet(html,bind,wide){const L=$('#layer');L.innerHTML=`<div class="sheet-bg"><div class="sheet${wide?' wide':''}" role="dialog"><div class="grab"></div>${html}</div></div>`;
  const bg=L.firstChild;bg.addEventListener('click',e=>{if(e.target===bg||e.target.closest('[data-close]'))closeSheet()});if(bind)bind(bg.querySelector('.sheet'))}
function closeSheet(){$('#layer').innerHTML=''}
function confirmSheet(msg,label,cb){sheet(`<h3>Are you sure?</h3><p class="muted">${esc(msg)}</p><div class="btns"><button class="danger" id="x-yes" style="flex:1">${esc(label)}</button><button data-close style="flex:1">Cancel</button></div>`,el=>{el.querySelector('#x-yes').onclick=()=>{closeSheet();cb()}})}
const VIEWS=['best','wallet','pay','points','more'];
let view='best';
function route(){const h=location.hash.replace('#','');view=VIEWS.includes(h)?h:'best';closeSheet();render()}
window.addEventListener('hashchange',route);
function render(){
  document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('on',a.dataset.v===view));
  const app=$('#app');app.className=view==='pay'?'':'narrow';
  if(!ST.cfg||setupReplace){app.innerHTML=vSetup(setupReplace);bindSetup();drawSync();return}
  /* keep the field being typed in (and what's typed) across a redraw, e.g. when a sync lands mid-entry */
  const ae=document.activeElement;const keep=ae&&ae.dataset&&ae.dataset.keep;const kv=keep?ae.value:null;
  app.innerHTML=({best:vBest,wallet:vWallet,pay:vPay,points:vPoints,more:vMore}[view])();
  bindView();drawSync();
  if(keep){const el=document.querySelector(`[data-keep="${keep}"]`);if(el){if(el.value!==kv)el.value=kv;el.focus();try{el.setSelectionRange(kv.length,kv.length)}catch(e){}}}}

/* ================= Best ================= */
let bestMode='cats',storeQ='';
function signals(){const out=[];const t=today();
  activeCards().forEach(c=>{const d=cardDef(c);
    const nf=nextFee(c);if(nf){const n=daysBetween(t,nf);if(n<=45)out.push({lvl:n<=14?'bad':'warn',icon:'💸',t:`${d.name} annual fee ${moneyR(c.annualFee,c.currency)} posts in ${MONTHS[nf.getMonth()]}`,s:'Keep, downgrade or cancel before it posts.',card:c.id})}
    const due=nextDue(c);if(due&&c.inPayRun){const n=daysBetween(t,due);const last=lastRunDate();if(n<=7&&(!last||daysBetween(parseD(last),t)>10))out.push({lvl:n<=2?'bad':'warn',icon:'📅',t:`${d.name} payment due ${dayWord(n)}`,s:last?`Last pay run ${fmtDate(last)}`:'No pay run recorded yet',go:'pay'})}
    const b=openBonus(c.id);if(b&&b.deadline){const n=daysUntil(b.deadline);const sp=bonusSpent(c.id,b);const left=(b.target||0)-sp.amt;if(n!=null&&n>=0&&n<=45&&left>0)out.push({lvl:n<=14?'bad':'warn',icon:'🎯',t:`${moneyR(left)} to go on ${d.name} bonus`,s:`${dayWord(n)} · ${moneyR(Math.ceil(left/Math.max(1,n)))}/day`,card:c.id})}});
  (S().credits||[]).forEach(c=>{const left=c.amount-(c.used||0);const n=daysUntil(c.expires);if(left>0&&n!=null&&n>=0&&n<=14)out.push({lvl:n<=3?'bad':'warn',icon:'🎟️',t:`${money(left)} left on ${c.name}`,s:`${cardName(c.cardId)} · expires ${dayWord(n)}`,card:c.cardId})});
  (S().nights||[]).filter(f=>!f.used).forEach(f=>{const n=daysUntil(f.expires);if(n!=null&&n>=0&&n<=60)out.push({lvl:n<=14?'bad':'warn',icon:'🏨',t:`${f.name} free night expires ${dayWord(n)}`,s:fmtDate(f.expires)})});
  const flags=openFlags();if(flags.length)out.push({lvl:'warn',icon:'🚩',t:`${flags.length} open pay-run flag${flags.length>1?'s':''}`,s:flags.slice(0,2).map(f=>cardName(f.cardId)+': '+f.flagNote).join(' · '),go:'pay'});
  const dr=draftRun();if(dr)out.unshift({lvl:'warn',icon:'🧾',t:`Pay run in progress (${fmtDate(dr.date)})`,s:'Tap to continue',go:'pay'});
  return out}
function vBest(){
  if(!activeCards().length)return `<div class="card hero"><div class="big">No cards yet</div><p class="muted">Add your cards in Wallet.</p><a class="btn" href="#wallet">Go to Wallet</a></div>`;
  const sig=signals();let h='';
  if(sig.length)h+=`<h2>Signals</h2><div class="card list">`+sig.map(s=>`<div class="item" ${s.card?`data-act="opencard" data-id="${esc(s.card)}"`:s.go?`data-act="go" data-v="${s.go}"`:''} style="${s.card||s.go?'cursor:pointer':''}"><div class="icon">${s.icon}</div><div class="grow"><div>${esc(s.t)}</div><div class="small" style="color:${s.lvl==='bad'?'var(--bad)':'var(--muted)'}">${esc(s.s)}</div></div></div>`).join('')+`</div>`;
  h+=`<h2>Best card for…</h2><div class="seg"><button data-act="mode" data-m="cats" class="${bestMode==='cats'?'on':''}">Categories</button><button data-act="mode" data-m="stores" class="${bestMode==='stores'?'on':''}">Stores</button></div>`;
  if(bestMode==='cats')h+=`<div class="card list">`+CATS.map(c=>{const r=rank(c.id)[0];if(!r)return'';const cap=capNote(r.def,c.id);
      return `<div class="item" data-act="cat" data-id="${c.id}" style="cursor:pointer"><div class="icon">${c.icon}</div><div class="grow"><div class="ellipsis">${c.name}</div><div class="small muted ellipsis">${r.pinned?'<span class="pin">📌 </span>':''}${esc(r.def.name)}${r.c.last4?' ·· '+esc(r.c.last4):''}${cap?' · '+cap:''}</div></div><div style="text-align:right"><div class="pct">${fmtPct(r.pct)}</div><div class="tiny muted">${multLabel(r.def,c.id)}</div></div></div>`}).join('')+`</div>`;
  else h+=`<button class="primary" style="width:100%;margin-bottom:10px" data-act="shopmode">🛍️ Start shopping mode</button><div class="searchwrap"><input id="storeq" placeholder="Search stores…" value="${esc(storeQ)}"></div><div class="card list" id="storelist">${storeRows()}</div>`;
  return h}
function storeRows(){const q=storeQ.trim().toLowerCase();
  return STORES.filter(s=>!q||s.name.toLowerCase().includes(q)).map(s=>{const r=rank(s.cat,s.id)[0];if(!r)return'';
    return `<div class="item" data-act="store" data-id="${s.id}" style="cursor:pointer"><div class="icon">${CAT[s.cat].icon}</div><div class="grow"><div class="ellipsis">${esc(s.name)}</div><div class="small muted ellipsis">${r.pinned?'<span class="pin">📌 </span>':''}${r.ok?esc(r.def.name):'<span style="color:var(--bad)">No accepted card in wallet</span>'}</div></div><div class="pct">${r.ok?fmtPct(r.pct):'—'}</div></div>`}).join('')||'<div class="empty">No matching stores</div>'}
function showRanking(cat,store){const st=store?STORE_BY[store]:null;const list=rank(cat,store);
  let h=`<h3>${CAT[cat].icon} ${esc(st?st.name:CAT[cat].name)}</h3>`;if(st)h+=`<div class="small muted">Codes as ${CAT[cat].name}${st.note?' · '+esc(st.note):''}</div>`;
  h+=`<div class="list" style="margin-top:8px">`+list.map((r,i)=>{const cap=capNote(r.def,cat);const ml=multLabel(r.def,cat,store);return `<div class="item"><div class="tiny muted" style="width:14px">${i+1}</div>${miniCard(r.def)}<div class="grow"><div class="ellipsis">${esc(r.def.name)}${r.c.last4?' <span class="muted small">·· '+esc(r.c.last4)+'</span>':''}</div><div class="small muted">${r.ok?(ml+(ml?' · ':'')+(PROGRAMS[r.def.program]||{name:''}).name+(cap?' · '+cap:'')):'Not accepted here'}${r.pinned?' · <span class="pin">📌 pinned</span>':''}</div></div><div class="pct" style="${r.ok?'':'color:var(--muted)'}">${fmtPct(r.pct)}</div></div>`}).join('')+`</div>`;
  const pins=S().pins||{cat:{},store:{}};const pinned=store?(pins.store||{})[store]:(pins.cat||{})[cat];
  h+=`<label>Pin a card here (overrides the ranking)</label><select id="pinsel"><option value="">— No pin (use best) —</option>${activeCards().map(c=>`<option value="${c.id}" ${pinned===c.id?'selected':''}>${esc(cardLabel(c))}</option>`).join('')}</select><div class="btns" style="margin-top:14px"><button class="primary" data-close style="flex:1">Done</button></div>`;
  sheet(h,el=>{el.querySelector('#pinsel').onchange=e=>{const v=e.target.value;const p=clone(S().pins||{cat:{},store:{}});p.cat=p.cat||{};p.store=p.store||{};const tgt=store?p.store:p.cat;const k=store||cat;if(v)tgt[k]=v;else delete tgt[k];setSetting('pins',p,'pin '+(store?STORE_BY[store].name:CAT[cat].name));closeSheet();render();toast(v?'Pinned':'Pin removed')}})}
function shopMode(storeId){const pick=storeId||LS.get('cb_shop')||'loblaws';const st=STORE_BY[pick];const ranked=rank(st.cat,st.id);const r=ranked[0];
  let h=`<div class="shopbig"><div class="muted small">Shopping mode</div><select id="shopsel" style="margin:10px 0">${STORES.map(s=>`<option value="${s.id}" ${s.id===pick?'selected':''}>${esc(s.name)}</option>`).join('')}</select>`;
  if(r&&r.ok&&imgUrl(r.def))h+=`<div class="ccard img" style="background-image:url(${imgUrl(r.def)})"></div><div style="font-size:30px;font-weight:800;color:var(--accent)">${fmtPct(r.pct)}</div><div class="small muted">${esc(r.def.name)}${r.c.last4?' ·· '+esc(r.c.last4):''} · ${multLabel(r.def,st.cat,st.id)} ${(PROGRAMS[r.def.program]||{name:''}).name}${r.pinned?' · 📌 pinned':''}</div>`;
  else if(r&&r.ok)h+=`<div class="ccard" style="background:${grad(r.def)}"><div class="row"><div class="iss grow">${esc(ISS2[r.def.issuer]||'')}</div><div class="face-l4">${r.c.last4?'•••• '+esc(r.c.last4):''}</div></div><div class="chipg"></div><div><div class="nm">${esc(r.def.name)}</div><div style="font-size:30px;font-weight:800">${fmtPct(r.pct)}</div><div class="meta">${multLabel(r.def,st.cat,st.id)} ${(PROGRAMS[r.def.program]||{name:''}).name}${r.pinned?' · 📌 pinned':''}</div></div></div>`;
  else h+=`<div class="card" style="color:var(--bad)">No card in your wallet is accepted here.</div>`;
  if(st.note)h+=`<div class="small muted">${esc(st.note)}</div>`;const s2=ranked[1];if(s2&&s2.ok)h+=`<div class="small muted" style="margin-top:8px">Backup: ${esc(s2.def.name)} · ${fmtPct(s2.pct)}</div>`;
  h+=`<button class="primary" data-close style="margin-top:18px;width:100%">Done shopping</button></div>`;
  sheet(h,el=>{el.querySelector('#shopsel').onchange=e=>{LS.set('cb_shop',e.target.value);closeSheet();shopMode(e.target.value)}})}

/* ================= Wallet ================= */
let walletTab='active';
function faceHTML(c){const d=cardDef(c);const u=imgUrl(d);const tags0=[c.dormant?'dormant':'',c.currency==='USD'?'USD':'',!c.inPayRun&&c.status!=='closed'?'not in pay runs':''].filter(Boolean);
  if(u)return `<div class="cface" data-act="opencard" data-id="${esc(c.id)}"><div class="ccard img" style="background-image:url(${u});${c.status==='closed'?'filter:grayscale(.75) brightness(.8)':''}">${c.last4?`<span class="l4tag">•••• ${esc(c.last4)}</span>`:''}</div><div class="capt"><div class="row"><div class="grow ellipsis" style="font-weight:600">${esc(d.name)}</div><div class="small muted">${esc((PROGRAMS[d.program]||{name:''}).name)}</div></div><div class="small muted">${earnSummary(d)}</div><div class="small muted">${c.status==='closed'?'Closed'+(c.closedDate?' '+fmtDateY(c.closedDate):''):feeText(d)}${tags0.length?' · '+tags0.join(' · '):''}</div></div></div>`;
  const tags=[c.dormant?'dormant':'',c.currency==='USD'?'USD':'',!c.inPayRun&&c.status!=='closed'?'not in pay runs':''].filter(Boolean);
  return `<div class="ccard" style="background:${grad(d)};${c.status==='closed'?'filter:grayscale(.75) brightness(.8)':''}" data-act="opencard" data-id="${esc(c.id)}"><div class="row"><div class="iss grow">${esc(ISS2[d.issuer]||'')}</div><div class="meta">${esc((PROGRAMS[d.program]||{name:''}).name)}</div></div><div class="row"><div class="chipg"></div><div class="grow"></div><div class="face-l4">${c.last4?'•••• '+esc(c.last4):''}</div></div><div><div class="nm">${esc(d.name)}</div><div class="meta">${earnSummary(d)}</div><div class="row"><div class="meta grow">${c.status==='closed'?'Closed'+(c.closedDate?' '+fmtDateY(c.closedDate):''):feeText(d)}${tags.length?' · '+tags.join(' · '):''}</div><div class="nwm">${NW_SHORT[d.network]||''}</div></div></div></div>`}
function vWallet(){const act=activeCards().sort((a,b)=>(a.payeeOrder||99)-(b.payeeOrder||99)),cl=closedCards();
  let h=`<div class="seg"><button data-act="wtab" data-t="active" class="${walletTab==='active'?'on':''}">Active · ${act.length}</button><button data-act="wtab" data-t="closed" class="${walletTab==='closed'?'on':''}">Closed · ${cl.length}</button></div>`;
  if(walletTab==='active'){h+=`<button class="primary" style="width:100%;margin-bottom:12px" data-act="addcard">+ Add card</button><div class="wgrid">`+act.map(faceHTML).join('')+`</div>`}
  else h+=cl.length?`<div class="wgrid">${cl.map(faceHTML).join('')}</div>`:`<div class="empty">No closed cards.</div>`;
  return h}
function cardDetail(id){const c=cardById(id);if(!c)return;const d=cardDef(c);const ev=eventsFor(id);const b=openBonus(id);
  const due=nextDue(c),fee=nextFee(c);
  let h=`<div style="max-width:360px;margin:0 auto">${faceHTML(c).replace('data-act="opencard"','')}</div>`;
  h+=`<div class="actions"><button data-a="edit">✏️ Edit details</button><button data-a="switch">🔁 Product switch</button>${c.status==='closed'?'<button data-a="reopen">↩️ Reopen</button>':'<button data-a="close">⛔ Close card</button>'}<button data-a="event">＋ Log event</button><button data-a="image">🖼️ Card image</button></div>`;
  h+=`<div class="card"><div class="kvs"><span>Last 4</span><span>${esc(c.last4||'—')}</span><span>Opened</span><span>${c.openedDate?fmtDateY(c.openedDate):'—'}</span>${c.status==='closed'?`<span>Closed</span><span>${c.closedDate?fmtDateY(c.closedDate):'date unknown'}</span>`:''}<span>Annual fee</span><span>${c.annualFee?moneyR(c.annualFee,c.currency)+(c.feeRenewalMonth?' · posts in '+MONTHS[c.feeRenewalMonth-1]:' · month not set'):'None'}</span><span>Payment due</span><span>${due?'Day '+c.dueDay+' · next '+fmtDate(due):'Due day not set'}${c.statementDay?' · statement day '+c.statementDay:''}</span><span>Autopay minimum</span><span>${c.autopayMinimum?'Yes':'No'}</span><span>Pay runs</span><span>${c.inPayRun?'Included (#'+(c.payeeOrder||'—')+')':'Not included'}${c.dormant?' · dormant':''}</span><span>Earns</span><span>${esc(earnSummary(d,true))}</span></div>${c.notes?`<div class="small muted" style="margin-top:8px">${esc(c.notes)}</div>`:''}</div>`;
  if(b){const sp=bonusSpent(id,b);const pct=b.target?Math.min(100,sp.amt/b.target*100):0;const n=b.deadline?daysUntil(b.deadline):null;
    h+=`<h2>Welcome bonus spend</h2><div class="card"><div class="row"><div class="grow">${esc(b.note||'Bonus spend')}</div><div class="pct">${b.target?Math.round(pct)+'%':''}</div></div>${b.target?`<div class="bar"><i style="width:${pct}%"></i></div><div class="small muted">${moneyR(sp.amt)} of ${moneyR(b.target)} ${sp.manual?'(entered)':'(estimated from pay-run balances since '+(b.date?fmtDate(b.date):'start')+')'}${n!=null?' · deadline '+fmtDate(b.deadline)+' ('+dayWord(n)+')':''}</div>`:'<div class="small muted">No target recorded.</div>'}<div class="btns" style="margin-top:8px"><button class="sm" data-a="bspent">Set spent so far</button><button class="sm" data-a="bmet">🏁 Mark met</button></div></div>`}
  const cr=(S().credits||[]).filter(x=>x.cardId===id),ni=(S().nights||[]).filter(x=>x.cardId===id);
  h+=`<h2>Statement credits & free nights</h2><div class="card">${cr.map(x=>{const left=Math.max(0,x.amount-(x.used||0));const n=daysUntil(x.expires);return `<div class="row" style="padding:6px 0" data-a="credit" data-x="${x.id}"><div class="icon">🎟️</div><div class="grow"><div>${esc(x.name)}</div><div class="small muted">${money(left)} left of ${money(x.amount)}${x.expires?' · last day '+fmtDate(x.expires)+(n!=null?' ('+dayWord(n)+')':''):''}${x.repeat&&x.repeat!=='none'?' · resets '+x.repeat:''}</div></div></div>`}).join('')}${ni.map(x=>`<div class="row" style="padding:6px 0;${x.used?'opacity:.5':''}" data-a="night" data-x="${x.id}"><div class="icon">🏨</div><div class="grow"><div>${esc(x.name)}</div><div class="small muted">${x.used?'Used':x.expires?'Expires '+fmtDate(x.expires):''}${x.note?' · '+esc(x.note):''}</div></div></div>`).join('')}${!cr.length&&!ni.length?'<div class="small muted">None tracked.</div>':''}<div class="btns" style="margin-top:8px"><button class="sm" data-a="addcredit">+ Credit</button><button class="sm" data-a="addnight">+ Free night</button></div></div>`;
  const hist=balanceHistory(id);
  if(hist.length){const mx=Math.max(...hist.map(x=>x.balance),1);h+=`<h2>Balance history</h2><div class="card"><div class="bars">${hist.slice(-18).map(x=>`<i title="${fmtDate(x.date)}: ${money(x.balance,c.currency)}" style="height:${Math.max(2,x.balance/mx*100)}%"></i>`).join('')}</div><div class="list">${hist.slice().reverse().slice(0,8).map(x=>`<div class="item" style="padding:6px 2px"><div class="grow small">${fmtDateY(x.date)}${x.flag?' · 🚩 '+esc(x.flagNote):''}</div><div class="small" style="font-variant-numeric:tabular-nums">${money(x.balance,c.currency)}</div><div class="tiny" style="width:50px;text-align:right;color:${x.paid?'var(--accent)':'var(--muted)'}">${x.paid?'paid':''}</div></div>`).join('')}</div></div>`}
  h+=`<h2>History</h2><div class="card tl">${ev.length?ev.map(e=>`<div class="ev k-${e.type}" data-a="editev" data-x="${e.id}" style="cursor:pointer"><div><b>${EV_ICON[e.type]||'•'} ${EV_LABEL[e.type]||e.type}</b> <span class="muted small">${e.date?fmtDateY(e.date):'date unknown'}</span></div>${e.type==='product_switch'?`<div class="small">${esc(e.fromProduct||'?')} → ${esc(e.toProduct||'?')}</div>`:''}${e.target?`<div class="small muted">Target ${moneyR(e.target)}${e.deadline?' by '+fmtDate(e.deadline):''}</div>`:''}${e.amount?`<div class="small muted">${money(e.amount,c.currency)}</div>`:''}${e.note?`<div class="small muted">${esc(e.note)}</div>`:''}</div>`).join(''):'<div class="small muted">No history yet.</div>'}</div>`;
  sheet(h,el=>{el.addEventListener('click',e=>{const a=e.target.closest('[data-a]');if(!a)return;const x=a.dataset.x;
    ({edit:()=>editCard(c,false),switch:()=>productSwitch(c),close:()=>closeCard(c),reopen:()=>reopenCard(c),event:()=>eventSheet({cardId:id},true),
      bspent:()=>numberSheet('Spent so far on the bonus','Amount ($)',b&&b.spentManual,v=>{b.spentManual=v;upsert('card-events.json',b,`${d.name}: bonus spend so far ${moneyR(v)}`);cardDetail(id)}),
      bmet:()=>{addEvent({cardId:id,type:'bonus_spend_met',note:''});toast('Bonus spend marked met');cardDetail(id)},
      credit:()=>creditSheet((S().credits||[]).find(z=>z.id===x),false),night:()=>nightSheet((S().nights||[]).find(z=>z.id===x),false),
      image:()=>imageSheet(c),
      addcredit:()=>creditSheet({id:uid('cr'),cardId:id,repeat:'annual',used:0},true),addnight:()=>nightSheet({id:uid('fn'),cardId:id,used:false},true),
      editev:()=>eventSheet(clone(D.events.find(z=>z.id===x)),false)}[a.dataset.a]||(()=>{}))()})},true)}
function balanceHistory(cardId){const runs=new Map(D.runs.filter(r=>r.status!=='discarded').map(r=>[r.id,r]));
  return D.bals.filter(b=>b.cardId===cardId&&b.balance!=null&&runs.has(b.runId)).map(b=>Object.assign({date:runs.get(b.runId).date},b)).sort((a,b)=>a.date.localeCompare(b.date))}
function catalogPicker(title,onPick,opts){let q='',biz=false;const cur=opts&&opts.current;
  const draw=()=>{const list=CATALOG.filter(c=>!!c.biz===biz).filter(c=>!q||(c.name+' '+(ISSUERS[c.issuer]||'')+' '+PROGRAMS[c.program].name).toLowerCase().includes(q));
    if(!list.length)return '<div class="empty">No cards match.</div>';const groups={};list.forEach(c=>{(groups[c.issuer]=groups[c.issuer]||[]).push(c)});
    return Object.keys(groups).sort((a,b)=>(ISSUERS[a]||a).localeCompare(ISSUERS[b]||b)).map(k=>`<div class="grouph">${esc(ISSUERS[k]||k)}</div>`+groups[k].map(c=>`<div class="item" data-pick="${c.id}" style="cursor:pointer">${miniCard(c,true)}<div class="grow"><div class="ellipsis">${esc(c.name)}</div><div class="tiny muted ellipsis">${earnSummary(c,true)}</div><div class="tiny muted">${PROGRAMS[c.program].name} · ${feeText(c)}</div></div>${cur===c.id?'<span class="chip ok">current</span>':'<div class="muted">›</div>'}</div>`).join('')).join('')};
  sheet(`<h3>${esc(title)}</h3><div class="seg"><button data-b="0" class="on">Personal</button><button data-b="1">Business</button></div><input id="cq" placeholder="Search cards, banks or programs…"><div class="list" id="clist" style="margin-top:6px">${draw()}</div>${opts&&opts.custom?'<button style="width:100%;margin-top:10px" id="custom">Card not listed? Add a custom card</button>':''}`,el=>{
    const refresh=()=>{el.querySelector('#clist').innerHTML=draw()};
    el.querySelectorAll('[data-b]').forEach(b=>b.onclick=()=>{biz=b.dataset.b==='1';el.querySelectorAll('[data-b]').forEach(x=>x.classList.toggle('on',x===b));refresh()});
    el.querySelector('#cq').oninput=e=>{q=e.target.value.toLowerCase();refresh()};
    el.querySelector('#clist').onclick=e=>{const it=e.target.closest('[data-pick]');if(it)onPick(it.dataset.pick)};
    const cu=el.querySelector('#custom');if(cu)cu.onclick=()=>onPick(null)})}
function addCard(){catalogPicker('Add a card',pick=>{const base=pick?CATALOG_BY[pick]:null;const order=Math.max(0,...activeCards().filter(c=>c.inPayRun).map(c=>c.payeeOrder||0))+1;
  const c={id:null,catalogId:pick,product:base?base.name:'',nickname:'',issuer:base?base.issuer:'other',network:base?base.network:'visa',last4:'',status:'active',dormant:false,currency:'CAD',inPayRun:!(base&&base.prepaid),openedDate:todayISO(),closedDate:null,annualFee:base?base.fee:0,feeRenewalMonth:new Date().getMonth()+1,statementDay:null,dueDay:null,autopayMinimum:false,fxFee:base?(base.noFx?0:(base.fxFee!=null?base.fxFee:2.5)):2.5,payeeOrder:order,overrides:null,custom:base?null:{name:'',issuer:'other',network:'visa',program:'cash',fee:0,rates:{},other:1},notes:''};
  editCard(c,true)},{custom:true})}
function editCard(c,isNew){const d=cardDef(c);const base=c.catalogId?CATALOG_BY[c.catalogId]:null;
  const progOpts=Object.entries(PROGRAMS).map(([k,p])=>`<option value="${k}" ${d.program===k?'selected':''}>${p.name}</option>`).join('');
  const h=`<h3>${isNew?'Add':'Edit'} card</h3>${base?`<div class="small muted">${esc(base.name)}${base.note?' · '+esc(base.note):''}</div>`:''}
  <label>Name</label><input id="f-name" value="${esc(c.nickname||c.product||'')}" placeholder="Card name">
  <div class="grid2"><div><label>Last 4 digits</label><input id="f-l4" inputmode="numeric" maxlength="4" value="${esc(c.last4||'')}" placeholder="1234"></div><div><label>Currency</label><select id="f-cur"><option ${c.currency!=='USD'?'selected':''}>CAD</option><option ${c.currency==='USD'?'selected':''}>USD</option></select></div></div>
  <div class="grid2"><div><label>Network</label><select id="f-net">${Object.entries(NETWORKS).map(([k,v])=>`<option value="${k}" ${d.network===k?'selected':''}>${v}</option>`).join('')}</select></div><div><label>Opened</label><input id="f-open" type="date" value="${esc(c.openedDate||'')}"></div></div>
  <div class="grid2"><div><label>Annual fee</label><input id="f-fee" type="number" step="0.01" inputmode="decimal" value="${c.annualFee??''}"></div><div><label>Fee posts in</label><select id="f-feem"><option value="">—</option>${MONTHS.map((m,i)=>`<option value="${i+1}" ${c.feeRenewalMonth===i+1?'selected':''}>${m}</option>`).join('')}</select></div></div>
  <div class="grid2"><div><label>Payment due day (1–31)</label><input id="f-due" type="number" min="1" max="31" inputmode="numeric" value="${c.dueDay??''}"></div><div><label>Statement day (1–31)</label><input id="f-stmt" type="number" min="1" max="31" inputmode="numeric" value="${c.statementDay??''}"></div></div>
  <div class="grid2"><div><label>Pay-run order</label><input id="f-order" type="number" inputmode="numeric" value="${c.payeeOrder??''}"></div><div><label>FX fee (%)</label><input id="f-fx" type="number" step="0.1" inputmode="decimal" value="${c.fxFee??2.5}"></div></div>
  <label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" id="f-pay" style="width:auto" ${c.inPayRun?'checked':''}> Include in pay runs</label>
  <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="f-auto" style="width:auto" ${c.autopayMinimum?'checked':''}> Automatic minimum payment set up</label>
  <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="f-dorm" style="width:auto" ${c.dormant?'checked':''}> Dormant (rarely used)</label>
  <label>Notes</label><textarea id="f-notes" style="min-height:60px;font-family:inherit;font-size:14px">${esc(c.notes||'')}</textarea>
  <details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">Earn rates${base?' (blank = catalog rate)':''}</summary>
  <label>Rewards program</label><select id="f-prog">${progOpts}</select>
  <div class="grid2">${CATS.map(k=>`<div><label class="tiny">${k.icon} ${k.name}</label><input type="number" step="0.01" inputmode="decimal" data-rate="${k.id}" value="${k.id==='other'?d.other:(d.rates[k.id]??'')}" placeholder="${d.other}"></div>`).join('')}</div></details>
  <div class="btns" style="margin-top:16px"><button class="primary" id="f-save" style="flex:1">${isNew?'Add to wallet':'Save'}</button><button data-close>Cancel</button></div>`;
  sheet(h,el=>{el.querySelector('#f-save').onclick=()=>{
    const v=s=>el.querySelector(s).value.trim();const num=s=>{const x=v(s);return x===''?null:Number(x)};
    const l4=v('#f-l4');if(l4&&!/^\d{4}$/.test(l4)){toast('Last 4 must be 4 digits');return}
    const name=v('#f-name');
    if(base){c.product=c.product||base.name;c.nickname=name&&name!==c.product?name:''}else{c.product=name||'Custom card';c.nickname=''}
    c.last4=l4;c.currency=v('#f-cur');c.network=v('#f-net');c.openedDate=v('#f-open')||null;c.annualFee=num('#f-fee');c.feeRenewalMonth=num('#f-feem');
    c.dueDay=num('#f-due');c.statementDay=num('#f-stmt');c.payeeOrder=num('#f-order');c.fxFee=num('#f-fx');
    c.inPayRun=el.querySelector('#f-pay').checked;c.autopayMinimum=el.querySelector('#f-auto').checked;c.dormant=el.querySelector('#f-dorm').checked;c.notes=v('#f-notes');
    const rates={};let other=d.other;el.querySelectorAll('[data-rate]').forEach(i=>{const x=i.value.trim();if(i.dataset.rate==='other'){if(x!=='')other=Number(x)}else if(x!=='')rates[i.dataset.rate]=Number(x)});
    const prog=v('#f-prog');
    if(base){const o={};const rd={};CATS.forEach(k=>{if(k.id==='other')return;const be=base.rates[k.id]!=null?base.rates[k.id]:base.other;const ne=rates[k.id]!=null?rates[k.id]:other;if(ne!==be)rd[k.id]=ne});if(Object.keys(rd).length)o.rates=rd;if(other!==base.other)o.other=other;if(prog!==base.program)o.program=prog;c.overrides=Object.keys(o).length?o:null}
    else c.custom=Object.assign({},c.custom||{},{name:c.product,program:prog,network:c.network,rates,other,usd:c.currency==='USD'});
    if(isNew){c.id=(c.issuer||'card')+'-'+(l4||uid('').slice(-5));if(cardById(c.id))c.id+= '-'+Date.now().toString(36).slice(-3);saveCard(c,`add ${cardLabel(c)}`);addEvent({cardId:c.id,type:'opened',date:c.openedDate,note:''})}
    else saveCard(c,`edit ${cardLabel(c)}`);
    closeSheet();render();toast(isNew?'Card added':'Saved');if(!isNew)cardDetail(c.id)}},true)}
function productSwitch(c){catalogPicker('Switch to which card?',pick=>{const nb=CATALOG_BY[pick];const from=cardDef(c).name;
  sheet(`<h3>Product switch</h3><p class="small muted">${esc(from)}${c.last4?' ·· '+esc(c.last4):''} → <b>${esc(nb.name)}</b>. Same card, same history and balances; earn rates and fee switch to the new product.</p><div class="grid2"><div><label>Switch date</label><input id="x-d" type="date" value="${todayISO()}"></div><div><label>New last 4 (if it changed)</label><input id="x-l4" inputmode="numeric" maxlength="4" value="${esc(c.last4||'')}"></div></div><label>Note</label><input id="x-n" placeholder="e.g. retention call, fee avoided"><div class="btns" style="margin-top:14px"><button class="primary" id="x-ok" style="flex:1">Log switch</button><button data-close>Cancel</button></div>`,el=>{
    el.querySelector('#x-ok').onclick=()=>{const l4=el.querySelector('#x-l4').value.trim();if(l4&&!/^\d{4}$/.test(l4)){toast('Last 4 must be 4 digits');return}
      addEvent({cardId:c.id,type:'product_switch',date:el.querySelector('#x-d').value||null,fromProduct:from,toProduct:nb.name,note:el.querySelector('#x-n').value.trim()+(l4&&l4!==c.last4?` (card number now ends ${l4}, was ${c.last4||'?'})`:'')});
      c.catalogId=pick;c.product=nb.name;c.nickname='';c.overrides=null;c.custom=null;c.annualFee=nb.fee;c.network=nb.network;c.issuer=nb.issuer;c.fxFee=nb.noFx?0:(nb.fxFee!=null?nb.fxFee:2.5);if(l4)c.last4=l4;
      saveCard(c,`product switch ${from} → ${nb.name}`);closeSheet();render();toast('Switch logged');cardDetail(c.id)}})},{current:c.catalogId})}
function closeCard(c){sheet(`<h3>Close ${esc(cardLabel(c))}</h3><p class="small muted">The card moves to Closed with all its history. It stays in your next pay run so you can pay off the last balance.</p><label>Closed on</label><input id="x-d" type="date" value="${todayISO()}"><label>Note</label><input id="x-n" placeholder="e.g. fee due, bonus earned"><div class="btns" style="margin-top:14px"><button class="danger" id="x-ok" style="flex:1">Close card</button><button data-close>Cancel</button></div>`,el=>{
  el.querySelector('#x-ok').onclick=()=>{const dt=el.querySelector('#x-d').value||todayISO();addEvent({cardId:c.id,type:'closed',date:dt,note:el.querySelector('#x-n').value.trim()});c.status='closed';c.closedDate=dt;saveCard(c,`close ${cardLabel(c)}`);
    const p=clone(S().pins||{cat:{},store:{}});let ch=false;['cat','store'].forEach(t=>Object.keys(p[t]||{}).forEach(k=>{if(p[t][k]===c.id){delete p[t][k];ch=true}}));if(ch)setSetting('pins',p,'unpin closed card');
    closeSheet();render();toast('Card closed — history kept')}})}
function reopenCard(c){addEvent({cardId:c.id,type:'reopened',note:''});c.status='active';c.closedDate=null;saveCard(c,`reopen ${cardLabel(c)}`);render();cardDetail(c.id)}
function eventSheet(e,isNew){const types=Object.keys(EV_LABEL).filter(t=>isNew?!['closed','reopened','product_switch'].includes(t):true);
  sheet(`<h3>${isNew?'Log event':'Edit event'} · ${esc(cardName(e.cardId))}</h3><label>Type</label><select id="x-t">${types.map(t=>`<option value="${t}" ${e.type===t?'selected':''}>${EV_ICON[t]} ${EV_LABEL[t]}</option>`).join('')}</select>
  <label>Date</label><input id="x-d" type="date" value="${esc(e.date||(isNew?todayISO():''))}">
  <div id="x-extra"></div><label>Note</label><textarea id="x-n" style="min-height:60px;font-family:inherit;font-size:14px">${esc(e.note||'')}</textarea>
  <div class="btns" style="margin-top:14px"><button class="primary" id="x-ok" style="flex:1">Save</button>${isNew?'':'<button class="danger" id="x-del">Delete</button>'}</div>`,el=>{
    const extra=()=>{const t=el.querySelector('#x-t').value;el.querySelector('#x-extra').innerHTML=t==='bonus_spend_started'?`<div class="grid2"><div><label>Spend target ($)</label><input id="x-tg" type="number" inputmode="decimal" value="${e.target??''}"></div><div><label>Deadline</label><input id="x-dl" type="date" value="${esc(e.deadline||'')}"></div></div>`:t==='fee_charged'||t==='retention_offer'?`<label>Amount ($)</label><input id="x-am" type="number" step="0.01" inputmode="decimal" value="${e.amount??''}">`:t==='product_switch'?`<div class="grid2"><div><label>From</label><input id="x-fr" value="${esc(e.fromProduct||'')}"></div><div><label>To</label><input id="x-to" value="${esc(e.toProduct||'')}"></div></div>`:''};
    extra();el.querySelector('#x-t').onchange=extra;
    el.querySelector('#x-ok').onclick=()=>{const g=s=>{const i=el.querySelector(s);return i?i.value.trim():''};e.type=g('#x-t');e.date=g('#x-d')||null;e.note=g('#x-n');
      if(e.type==='bonus_spend_started'){e.target=g('#x-tg')?Number(g('#x-tg')):null;e.deadline=g('#x-dl')||null}if(g('#x-am'))e.amount=Number(g('#x-am'));if(el.querySelector('#x-fr')){e.fromProduct=g('#x-fr');e.toProduct=g('#x-to')}
      if(isNew)addEvent(e);else upsert('card-events.json',e,`${cardName(e.cardId)}: edit ${EV_LABEL[e.type]}`);closeSheet();render();cardDetail(e.cardId)};
    const del=el.querySelector('#x-del');if(del)del.onclick=()=>confirmSheet('Delete this event from the card’s history?','Delete',()=>{removeRec('card-events.json',e,`${cardName(e.cardId)}: delete event`);render();cardDetail(e.cardId)})})}
function listSave(key,item,isNew,why){const arr=clone(S()[key]||[]);item.updatedAt=Date.now();const i=arr.findIndex(x=>x.id===item.id);if(i>=0)arr[i]=item;else arr.push(item);setSetting(key,arr,why)}
function listDel(key,id,why){setSetting(key,(S()[key]||[]).filter(x=>x.id!==id),why)}
function creditSheet(c,isNew){c=clone(c);sheet(`<h3>${isNew?'Add':'Edit'} statement credit</h3><label>Card</label><select id="x-card">${D.cards.map(w=>`<option value="${w.id}" ${c.cardId===w.id?'selected':''}>${esc(cardLabel(w))}</option>`).join('')}</select>
  <label>Credit name</label><input id="x-name" value="${esc(c.name||'')}" placeholder="e.g. Annual travel credit"><div class="grid2"><div><label>Amount ($)</label><input id="x-amt" type="number" inputmode="decimal" value="${c.amount??''}"></div><div><label>Used so far ($)</label><input id="x-used" type="number" inputmode="decimal" value="${c.used??0}"></div></div>
  <div class="grid2"><div><label>Last day to use</label><input id="x-exp" type="date" value="${esc(c.expires||'')}"></div><div><label>Resets</label><select id="x-rep">${['none','monthly','quarterly','semiannual','annual'].map(r=>`<option ${c.repeat===r?'selected':''}>${r}</option>`).join('')}</select></div></div>
  <div class="btns" style="margin-top:16px"><button class="primary" id="x-save" style="flex:1">Save</button>${isNew?'':'<button id="x-useall">Mark used</button><button class="danger" id="x-del">Delete</button>'}</div>`,el=>{
    const read=()=>{c.cardId=el.querySelector('#x-card').value;c.name=el.querySelector('#x-name').value.trim()||'Credit';c.amount=Number(el.querySelector('#x-amt').value||0);c.used=Number(el.querySelector('#x-used').value||0);c.expires=el.querySelector('#x-exp').value;c.repeat=el.querySelector('#x-rep').value};
    el.querySelector('#x-save').onclick=()=>{read();listSave('credits',c,isNew,`credit: ${c.name}`);closeSheet();render();cardDetail(c.cardId)};
    if(!isNew){el.querySelector('#x-useall').onclick=()=>{read();c.used=c.amount;listSave('credits',c,false,`credit used: ${c.name}`);closeSheet();render();cardDetail(c.cardId)};el.querySelector('#x-del').onclick=()=>{listDel('credits',c.id,`delete credit ${c.name}`);closeSheet();render();cardDetail(c.cardId)}}})}
function nightSheet(f,isNew){f=clone(f);sheet(`<h3>${isNew?'Add':'Edit'} free night</h3><label>Name</label><input id="x-name" value="${esc(f.name||'')}" placeholder="e.g. Marriott 35k certificate"><label>Note</label><input id="x-note" value="${esc(f.note||'')}"><label>From card</label><select id="x-card"><option value="">—</option>${D.cards.map(w=>`<option value="${w.id}" ${f.cardId===w.id?'selected':''}>${esc(cardLabel(w))}</option>`).join('')}</select><label>Expires</label><input id="x-exp" type="date" value="${esc(f.expires||'')}"><label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" id="x-used" style="width:auto" ${f.used?'checked':''}> Used</label>
  <div class="btns" style="margin-top:16px"><button class="primary" id="x-save" style="flex:1">Save</button>${isNew?'':'<button class="danger" id="x-del">Delete</button>'}</div>`,el=>{
    el.querySelector('#x-save').onclick=()=>{f.name=el.querySelector('#x-name').value.trim()||'Free night';f.note=el.querySelector('#x-note').value.trim();f.cardId=el.querySelector('#x-card').value;f.expires=el.querySelector('#x-exp').value;f.used=el.querySelector('#x-used').checked;listSave('nights',f,isNew,`free night: ${f.name}`);closeSheet();render();if(f.cardId)cardDetail(f.cardId)};
    if(!isNew)el.querySelector('#x-del').onclick=()=>{listDel('nights',f.id,`delete free night ${f.name}`);closeSheet();render()}})}
function numberSheet(title,label,val,cb){sheet(`<h3>${esc(title)}</h3><label>${esc(label)}</label><input id="x-n" type="number" step="0.01" inputmode="decimal" value="${val??''}"><div class="btns" style="margin-top:14px"><button class="primary" id="x-ok" style="flex:1">Save</button><button data-close>Cancel</button></div>`,el=>{const i=el.querySelector('#x-n');setTimeout(()=>i.focus(),50);el.querySelector('#x-ok').onclick=()=>{const v=i.value.trim();closeSheet();cb(v===''?null:Number(v))}})}
function rollCredits(){const t=today();let changed=false;const arr=clone(S().credits||[]);
  arr.forEach(c=>{if(!c.repeat||c.repeat==='none')return;let e=parseD(c.expires),g=0,rolled=false;while(e&&e<t&&g++<60){const n=new Date(e);if(c.repeat==='monthly')n.setMonth(n.getMonth()+1);else if(c.repeat==='quarterly')n.setMonth(n.getMonth()+3);else if(c.repeat==='semiannual')n.setMonth(n.getMonth()+6);else n.setFullYear(n.getFullYear()+1);e=n;c.used=0;rolled=true}if(rolled){c.expires=isoD(e);changed=true}});
  if(changed)setSetting('credits',arr,'reset recurring credits')}

function imageSheet(c){const d=cardDef(c);const u=imgUrl(d);
  sheet(`<h3>Card image · ${esc(cardLabel(c))}</h3>${u?`<div class="ccard img" style="background-image:url(${u});max-width:340px;margin:8px auto"></div>`:'<p class="small muted">No image yet — the app draws this card.</p>'}
  <p class="small muted">Use the front of the card, cropped to its edges (PNG, JPG or WebP). Never a photo showing your full card number. It’s saved to your private data repo${c.catalogId?' and shared with every card of this product':''}.</p>
  <input type="file" id="x-f" accept="image/*">${c.catalogId?'<label style="display:flex;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" id="x-only" style="width:auto"> Only for this card (••'+esc(c.last4||'')+')</label>':''}
  <div class="btns" style="margin-top:14px"><button class="primary" id="x-ok" style="flex:1">Upload</button><button data-close>Cancel</button></div><div class="small" id="x-msg" style="margin-top:8px"></div>`,el=>{
    el.querySelector('#x-ok').onclick=async()=>{const f=el.querySelector('#x-f').files[0];const m=el.querySelector('#x-msg');if(!f){m.textContent='Choose an image first.';return}
      m.textContent='Uploading…';try{await uploadCardImage(c,f,!!(el.querySelector('#x-only')&&el.querySelector('#x-only').checked));closeSheet();render();toast('Card image saved');cardDetail(c.id)}catch(e){m.innerHTML=`<span style="color:var(--bad)">${esc(e.status===401?'Access key rejected':e.message||'Upload failed')}</span>`}}})}

/* ================= Pay ================= */
let payMode='run',reorder=false;
const draftRun=()=>D.runs.find(r=>r.status==='draft');
const completedRuns=()=>D.runs.filter(r=>r.status==='complete').sort((a,b)=>b.date.localeCompare(a.date)||(b.updatedAt||0)-(a.updatedAt||0));
const lastRunDate=()=>{const r=completedRuns()[0];return r?r.date:null};
const runBals=runId=>D.bals.filter(b=>b.runId===runId);
const getBal=(runId,cardId)=>D.bals.find(b=>b.runId===runId&&b.cardId===cardId);
const openFlags=()=>{const ok=new Set(D.runs.filter(r=>r.status!=='discarded').map(r=>r.id));return D.bals.filter(b=>b.flag&&!b.flagResolved&&ok.has(b.runId))};
const accounts=()=>S().fundingAccounts||[];
function cardsForNewRun(){const last=lastRunDate();return D.cards.filter(c=>c.inPayRun&&(c.status!=='closed'||(c.closedDate&&(!last||c.closedDate>=last)))).sort((a,b)=>(a.currency==='USD')-(b.currency==='USD')||(a.payeeOrder||99)-(b.payeeOrder||99))}
function startRun(){sheet(`<h3>Start a pay run</h3><p class="small muted">Lists every card in pay-run order. Log into each bank, type the balance, then fund and pay.</p><label>Run date</label><input id="x-d" type="date" value="${todayISO()}"><div class="btns" style="margin-top:14px"><button class="primary" id="x-ok" style="flex:1">Start</button><button data-close>Cancel</button></div>`,el=>{
  el.querySelector('#x-ok').onclick=()=>{const date=el.querySelector('#x-d').value||todayISO();let id='run-'+date;let n=2;while(D.runs.some(r=>r.id===id))id='run-'+date+'-'+(n++);
    const cards=cardsForNewRun();const run={id,date,status:'draft',totals:{CAD:0,USD:0},funding:accounts().map(a=>({accountId:a.id,account:a.name,currency:a.currency,amount:0})),notes:'',createdAt:Date.now()};
    upsert('payruns.json',run,`pay run ${date}: start`);
    cards.forEach(c=>upsert('balances.json',{runId:id,cardId:c.id,currency:c.currency||'CAD',balance:null,paid:false,paidDate:null,flag:false,flagNote:''},`pay run ${date}: start`));
    closeSheet();payMode='run';render()}})}
function runTotals(run){const t={CAD:0,USD:0};runBals(run.id).forEach(b=>{if(b.balance!=null)t[b.currency||'CAD']=r2(t[b.currency||'CAD']+b.balance)});return t}
function fundTotals(run){const t={CAD:0,USD:0};(run.funding||[]).forEach(f=>t[f.currency||'CAD']=r2(t[f.currency||'CAD']+(Number(f.amount)||0)));return t}
function runBlockers(run){const bs=runBals(run.id);const out=[];const miss=bs.filter(b=>b.balance==null).length;if(miss)out.push(`${miss} balance${miss>1?'s':''} not entered`);
  const unpaid=bs.filter(b=>b.balance!=null&&b.balance>0&&!b.paid&&!b.flag).length;if(unpaid)out.push(`${unpaid} card${unpaid>1?'s':''} not marked Paid or Flagged`);return out}
function dueChip(c,run){const due=nextDue(c,parseD(run.date));if(!due)return `<span class="chip" style="cursor:pointer" data-act="setdue" data-id="${c.id}" title="Set this card's payment due day">due day ?</span>`;
  const gap=Number(S().roundGapDays||25);const before=due<=addDays(parseD(run.date),gap);return `<span class="chip ${before?'warn':''}" title="${before?'Due before your next expected pay run':''}">due ${fmtDate(due)}${before?' · before next run':''}</span>`}
function vPay(){
  const dr=draftRun();
  let h=`<div class="seg" style="max-width:520px"><button data-act="pmode" data-m="run" class="${payMode==='run'?'on':''}">${dr?'Current run':'Pay run'}</button><button data-act="pmode" data-m="history" class="${payMode==='history'?'on':''}">History${openFlags().length?' · 🚩'+openFlags().length:''}</button></div>`;
  if(payMode==='history')return h+vPayHistory();
  if(!dr){const last=completedRuns()[0];const cards=cardsForNewRun();
    const dueSoon=cards.map(c=>({c,d:nextDue(c)})).filter(x=>x.d&&daysBetween(today(),x.d)<=10).sort((a,b)=>a.d-b.d);
    return h+`<div class="card hero" style="max-width:640px"><div class="big">Ready for a pay run</div><p class="muted">${cards.length} cards to check${last?` · last run ${fmtDateY(last.date)} (${dayWord(daysBetween(today(),parseD(last.date)))})`:' · no runs yet'}.</p>${dueSoon.length?`<p class="small" style="color:var(--warn)">Due soon: ${dueSoon.map(x=>esc(cardDef(x.c).name)+' '+fmtDate(x.d)).join(' · ')}</p>`:''}<button class="primary" data-act="startrun">Start pay run</button></div>`}
  const run=dr;const bs=runBals(run.id);const byCard=new Map(bs.map(b=>[b.cardId,b]));
  const cards=bs.map(b=>cardById(b.cardId)).filter(Boolean).sort((a,b)=>(a.currency==='USD')-(b.currency==='USD')||(a.payeeOrder||99)-(b.payeeOrder||99));
  const entered=bs.filter(b=>b.balance!=null).length,paid=bs.filter(b=>b.paid).length,flags=bs.filter(b=>b.flag).length;
  const tot=runTotals(run),fun=fundTotals(run),block=runBlockers(run);const missing=cardsForNewRun().filter(c=>!byCard.has(c.id));
  const row=(c,i)=>{const b=byCard.get(c.id);const d=cardDef(c);const zero=b.balance===0;
    return `<div class="prow ${b.flag?'flag':''} ${!b.paid&&!b.flag&&nextDue(c,parseD(run.date))&&nextDue(c,parseD(run.date))<=addDays(parseD(run.date),Number(S().roundGapDays||25))?'due':''}">
      <div class="o">${reorder?`<div class="ord"><button data-act="mv" data-id="${c.id}" data-d="-1" tabindex="-1">▲</button><button data-act="mv" data-id="${c.id}" data-d="1" tabindex="-1">▼</button></div>`:(c.payeeOrder||'')}</div>
      <div class="f">${miniCard(d)}</div>
      <div class="n"><div class="ellipsis" style="cursor:pointer" data-act="opencard" data-id="${c.id}">${esc(d.name)}</div><div class="tiny muted">${c.last4?'·· '+esc(c.last4):''}${c.dormant?' · dormant':''}${c.status==='closed'?' · closed — final balance':''}${c.autopayMinimum?' · autopay min':''}</div></div>
      <div class="d">${b.flag?`<span class="chip bad" style="cursor:pointer" data-act="flag" data-id="${c.id}">🚩 ${esc(b.flagNote)}</span>`:dueChip(c,run)}</div>
      <div class="b"><input type="text" inputmode="decimal" autocomplete="off" class="${b.balance==null?'missing':''}" data-bal="${c.id}" data-keep="bal-${c.id}" value="${b.balance!=null?b.balance.toFixed(2):''}" placeholder="${c.currency==='USD'?'US$':'$'} balance" aria-label="Balance for ${esc(d.name)}"></div>
      <div class="a">${zero?'<span class="chip ok">nothing to pay</span>':`<button class="pbtn ${b.paid?'on':''}" data-act="paid" data-id="${c.id}" tabindex="-1" ${b.balance==null?'disabled':''}>${b.paid?'✓ Paid':'Paid'}</button>`}<button class="pbtn ${b.flag?'flagon':''}" data-act="flag" data-id="${c.id}" tabindex="-1">🚩</button></div></div>`};
  const cad=cards.filter(c=>c.currency!=='USD'),usd=cards.filter(c=>c.currency==='USD');
  h+=`<div class="payhead"><div class="grow"><div class="big">Pay run · <span style="cursor:pointer" data-act="rundate">${fmtDateY(run.date)}</span></div><div class="small muted">Enter every balance (0 is fine), then fund it and mark each card Paid. Enter moves to the next card.</div></div>
    <span class="chip ${entered===bs.length?'ok':''}">Balances ${entered}/${bs.length}</span><span class="chip ${paid+flags===bs.length?'ok':''}">Paid ${paid}/${bs.length}</span>${flags?`<span class="chip bad">🚩 ${flags}</span>`:''}<button class="sm ${reorder?'primary':''}" data-act="reorder">${reorder?'Done reordering':'Reorder'}</button></div>`;
  if(missing.length)h+=`<div class="card small" style="border-color:#5b4723">Not in this run: ${missing.map(c=>esc(cardLabel(c))).join(', ')} <button class="sm" data-act="addmissing">Add to run</button></div>`;
  h+=`<div class="paygrid"><div><div class="card" style="padding:4px 10px">${cad.map(row).join('')}</div>${usd.length?`<h2>US cards (US$)</h2><div class="card" style="padding:4px 10px">${usd.map(row).join('')}</div>`:''}</div>
    <div class="side"><div class="card"><div class="tot"><span class="muted">Total to pay</span><b>${money(tot.CAD)}</b></div>${usd.length?`<div class="tot"><span class="muted">US cards</span><b>${money(tot.USD,'USD')}</b></div>`:''}</div>
    <div class="card"><div style="font-weight:600;margin-bottom:4px">Funding</div>${(run.funding||[]).map((f,i)=>`<div class="frow"><div><div>${esc(f.account)}</div><div class="tiny muted">${f.currency}</div></div><input type="text" inputmode="decimal" autocomplete="off" data-fund="${i}" data-keep="fund-${i}" value="${f.amount?Number(f.amount).toFixed(2):''}" placeholder="0.00"><button class="sm" data-act="rest" data-i="${i}" title="Put the remaining amount here" tabindex="-1">Rest</button></div>`).join('')}
      ${['CAD','USD'].filter(cu=>cu==='CAD'||usd.length).map(cu=>{const rem=r2(tot[cu]-fun[cu]);return `<div class="tot small"><span class="muted">Left to allocate ${cu}</span><span class="rem ${Math.abs(rem)<0.005?'ok':'bad'}">${money(rem,cu)}</span></div>`}).join('')}</div>
    <div class="card"><label style="margin-top:0">Notes</label><textarea id="runnotes" style="min-height:60px;font-family:inherit;font-size:14px">${esc(run.notes||'')}</textarea>
      ${block.length?`<div class="small" style="color:var(--warn);margin-top:8px">To finish: ${block.join(' · ')}</div>`:'<div class="small" style="color:var(--accent);margin-top:8px">Every card is entered and paid or flagged.</div>'}
      <div class="btns" style="margin-top:10px"><button class="primary" data-act="complete" style="flex:1" ${block.length?'disabled':''}>Complete run</button><button class="danger sm" data-act="discard">Discard</button></div></div></div></div>`;
  return h}
function vPayHistory(){const flags=openFlags();const runs=completedRuns();let h='';
  if(flags.length){h+=`<h2>Open flags</h2><div class="card list">`+flags.map(b=>{const r=D.runs.find(x=>x.id===b.runId);return `<div class="item"><div class="icon">🚩</div><div class="grow"><div>${esc(cardName(b.cardId))}</div><div class="small muted">${esc(b.flagNote)} · run ${r?fmtDate(r.date):''} · ${money(b.balance,b.currency)}</div></div><button class="sm" data-act="resolve" data-run="${b.runId}" data-id="${b.cardId}">Resolve</button></div>`}).join('')+`</div>`}
  h+=`<h2>Past runs</h2>`;if(!runs.length)return h+`<div class="empty">No completed pay runs yet.</div>`;
  h+=`<div class="card list">`+runs.map(r=>{const t=runTotals(r);const bs=runBals(r.id);const fl=bs.filter(b=>b.flag).length;
    return `<div class="item" data-act="openrun" data-id="${r.id}" style="cursor:pointer"><div class="icon">🧾</div><div class="grow"><div>${fmtDateY(r.date)}</div><div class="small muted ellipsis">${(r.funding||[]).filter(f=>f.amount>0).map(f=>esc(f.account)+' '+moneyR(f.amount,f.currency)).join(' · ')||'funding not recorded'}${fl?' · 🚩'+fl:''}</div></div><div style="text-align:right"><div style="font-variant-numeric:tabular-nums">${money(t.CAD)}</div>${t.USD?`<div class="tiny muted">${money(t.USD,'USD')}</div>`:''}</div></div>`}).join('')+`</div>`;
  return h}
function runDetail(id){const r=D.runs.find(x=>x.id===id);if(!r)return;const bs=runBals(id).map(b=>({b,c:cardById(b.cardId)})).filter(x=>x.c).sort((a,b)=>(a.c.currency==='USD')-(b.c.currency==='USD')||(a.c.payeeOrder||99)-(b.c.payeeOrder||99));const t=runTotals(r);
  sheet(`<h3>Pay run · ${fmtDateY(r.date)}</h3><div class="small muted">${(r.funding||[]).filter(f=>f.amount>0).map(f=>esc(f.account)+' '+money(f.amount,f.currency)).join(' · ')}</div>
    <div class="list" style="margin-top:8px">${bs.map(({b,c})=>`<div class="item" style="padding:8px 2px">${miniCard(cardDef(c))}<div class="grow"><div class="small ellipsis">${esc(cardLabel(c))}</div>${b.flag?`<div class="tiny" style="color:${b.flagResolved?'var(--muted)':'var(--bad)'}">🚩 ${esc(b.flagNote)}${b.flagResolved?' (resolved)':''}</div>`:''}</div><div class="small" style="font-variant-numeric:tabular-nums">${b.balance==null?'—':money(b.balance,b.currency)}</div><div class="tiny" style="width:44px;text-align:right;color:${b.paid?'var(--accent)':'var(--muted)'}">${b.paid?'paid':b.balance===0?'—':''}</div></div>`).join('')}</div>
    <div class="tot"><span class="muted">Total</span><b>${money(t.CAD)}</b></div>${t.USD?`<div class="tot"><span class="muted">US cards</span><b>${money(t.USD,'USD')}</b></div>`:''}${r.notes?`<p class="small muted">${esc(r.notes)}</p>`:''}
    <div class="btns" style="margin-top:12px"><button id="x-edit">Reopen to edit</button><button class="primary" data-close style="flex:1">Close</button></div>`,el=>{el.querySelector('#x-edit').onclick=()=>{if(draftRun()){toast('Finish or discard the current run first');return}r.status='draft';upsert('payruns.json',r,`pay run ${r.date}: reopen`);closeSheet();payMode='run';render()}},true)}
function flagSheet(run,cardId){const b=getBal(run.id,cardId);sheet(`<h3>🚩 Flag · ${esc(cardName(cardId))}</h3><p class="small muted">What needs follow-up? (Replaces the orange cell — the note is required.)</p><input id="x-n" value="${esc(b.flagNote||'')}" placeholder="e.g. unknown charge, payment didn’t go through"><div class="btns" style="margin-top:14px"><button class="primary" id="x-ok" style="flex:1">Flag</button>${b.flag?'<button id="x-un">Remove flag</button>':''}<button data-close>Cancel</button></div>`,el=>{
  const i=el.querySelector('#x-n');setTimeout(()=>i.focus(),50);
  el.querySelector('#x-ok').onclick=()=>{const n=i.value.trim();if(!n){toast('Add a note for the flag');return}b.flag=true;b.flagNote=n;b.flagResolved=false;upsert('balances.json',b,`pay run ${run.date}: flag ${cardName(cardId)}`);closeSheet();render()};
  const un=el.querySelector('#x-un');if(un)un.onclick=()=>{b.flag=false;b.flagNote='';upsert('balances.json',b,`pay run ${run.date}: unflag ${cardName(cardId)}`);closeSheet();render()}})}
function movePayee(cardId,dir){const run=draftRun();const ids=runBals(run.id).map(b=>cardById(b.cardId)).filter(Boolean).filter(c=>c.currency===(cardById(cardId).currency||'CAD')).sort((a,b)=>(a.payeeOrder||99)-(b.payeeOrder||99));
  const i=ids.findIndex(c=>c.id===cardId),j=i+dir;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];
  const base=Math.min(...ids.map(c=>c.payeeOrder||99));ids.forEach((c,k)=>{if(c.payeeOrder!==base+k){c.payeeOrder=base+k;saveCard(c,'reorder pay-run list')}});render()}

/* ================= Points ================= */
const fmtBal=(p,b)=>PROGRAMS[p]&&PROGRAMS[p].dollars?money(b):Number(b||0).toLocaleString('en-CA');
function vPoints(){const bal=S().pointsBalances||{};
  const progs=[...new Set([...activeCards().map(c=>cardDef(c).program),...Object.keys(bal)])].filter(p=>PROGRAMS[p]&&!PROGRAMS[p].cash)
    .sort((a,b)=>((bal[b]||0)*cpp(b))-((bal[a]||0)*cpp(a))||PROGRAMS[a].name.localeCompare(PROGRAMS[b].name));
  const total=progs.reduce((a,p)=>a+(bal[p]||0)*cpp(p)/100,0);
  let h=`<div class="card hero"><div class="small muted">Estimated value of your points</div><div class="big">${moneyR(total)}</div><div class="tiny muted">Prince of Travel valuations where available${S().pointsBalancesAsOf?' · balances as of '+fmtDateY(S().pointsBalancesAsOf):''}</div></div>`;
  h+=`<div class="row" style="margin:16px 4px 8px;gap:8px"><h2 class="grow" style="margin:0">Balances · ${progs.length}</h2><button class="sm" data-act="pastebal">Paste balances</button><button class="sm" data-act="addprog">+ Program</button></div>`;
  h+=`<div class="card list">`+progs.map(p=>{const P=PROGRAMS[p];const b=bal[p]||0;const ov=(S().cpp||{})[p]!=null;return `<div class="item" data-act="editbal" data-id="${p}" style="cursor:pointer"><div class="icon">${P.dollars?'$':'✦'}</div><div class="grow"><div class="ellipsis">${P.name}</div><div class="small muted">${P.dollars?'Cash balance':cpp(p)+'¢ / pt'+(ov?' · your value':P.pot?' · Prince of Travel':' · estimate')}${P.partners.length?' · '+P.partners.length+' transfer partners':''}</div></div><div style="text-align:right"><div style="font-variant-numeric:tabular-nums">${fmtBal(p,b)}</div><div class="tiny muted">≈ ${moneyR(b*cpp(p)/100)}</div></div></div>`}).join('')+`</div>`;
  const tp=progs.filter(p=>PROGRAMS[p].partners.length);
  if(tp.length)h+=`<h2>Transfer partners</h2>`+tp.map(p=>`<div class="card"><div style="font-weight:600;margin-bottom:6px">${PROGRAMS[p].name}</div><div class="list">${PROGRAMS[p].partners.map(([to,r,m])=>`<div class="item" style="padding:7px 2px"><div class="grow">→ ${to}</div><div class="small">${r}</div><div class="small muted" style="width:76px;text-align:right">min ${m}</div></div>`).join('')}</div></div>`).join('');
  return h}
function balSheet(p){const P=PROGRAMS[p];const bal=S().pointsBalances||{};
  sheet(`<h3>${P.name}</h3><label>Balance${P.dollars?' ($)':''}</label><input id="x-b" type="number" inputmode="decimal" value="${bal[p]??''}">${P.dollars?'':`<label>Value (cents per point)</label><input id="x-c" type="number" step="0.01" inputmode="decimal" value="${cpp(p)}"><div class="tiny muted" style="margin-top:4px">Used for every “best card” calculation. Default ${P.cpp}¢${P.pot?' (Prince of Travel'+(P.note?', '+P.note:'')+')':' (estimate)'}.</div>`}<div class="btns" style="margin-top:14px"><button class="primary" id="x-ok" style="flex:1">Save</button>${p in bal?'<button class="danger" id="x-rm">Remove</button>':''}</div>`,el=>{
    el.querySelector('#x-ok').onclick=()=>{const nb=Object.assign({},bal,{[p]:Number(el.querySelector('#x-b').value||0)});setSetting('pointsBalances',nb,`points: ${P.name}`);setSetting('pointsBalancesAsOf',todayISO());
      const ci=el.querySelector('#x-c');if(ci){const c=Number(ci.value);const o=Object.assign({},S().cpp||{});if(c&&c!==P.cpp)o[p]=c;else delete o[p];if(!same(o,S().cpp||{}))setSetting('cpp',o,`point value: ${P.name}`)}closeSheet();render()};
    const rm=el.querySelector('#x-rm');if(rm)rm.onclick=()=>{const nb=Object.assign({},bal);delete nb[p];setSetting('pointsBalances',nb,`remove ${P.name}`);closeSheet();render()}})}
const PROG_ALIASES={aeroplan:'aeroplan',united:'united',unitedmileageplus:'united',mileageplus:'united',atmos:'atmos',atmosrewards:'atmos',alaska:'atmos',mileageplan:'atmos',flyingblue:'flyingblue',baavios:'avios',baavois:'avios',avios:'avios',britishairways:'avios',etihad:'etihad',etihadguest:'etihad',aegean:'aegean',westjet:'wsd',westjetrewards:'wsd',porter:'viporter',viporter:'viporter',americanairlines:'aadvantage',aadvantage:'aadvantage',bonvoy:'bonvoy',marriott:'bonvoy',marriottbonvoy:'bonvoy',hotelscom:'onekey',onekey:'onekey',onekeycash:'onekey',hilton:'hilton',hiltonhonors:'hilton',bestwestern:'bestwestern',morerewards:'morerewards',pcoptimum:'pc',bluerewards:'bmoblue',bmoblue:'bmoblue',bmorewards:'bmo',scene:'scene',sceneplus:'scene',triangle:'ctmoney',ctmoney:'ctmoney',amex:'amexmr',membershiprewards:'amexmr',avion:'avion',tdrewards:'tdr',aventura:'aventura',mbna:'mbna',asiamiles:'asiamiles',hyatt:'hyatt',ihg:'ihg',accor:'accor',delta:'delta',emirates:'emirates',krisflyer:'krisflyer',qatar:'qatar',turkish:'turkish',virgin:'virgin',lifemiles:'lifemiles',ana:'ana',jal:'jal',korean:'korean',finnair:'finnair',iberia:'iberia'};
function progFor(name){const k=name.toLowerCase().replace(/\+/g,'plus').replace(/[^a-z]/g,'');if(PROG_ALIASES[k])return PROG_ALIASES[k];const hit=Object.entries(PROGRAMS).find(([id,P])=>!P.cash&&k.length>=4&&P.name.toLowerCase().replace(/[^a-z]/g,'').startsWith(k));return hit?hit[0]:null}
function parseBalances(text){const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);const isNum=l=>/^\$?\s*\d[\d,\s]*(\.\d+)?$/.test(l);const num=l=>Number(l.replace(/[$,\s]/g,''));const out=[],miss=[];
  for(let i=0;i<lines.length;i++){let name=null,val=null;const l=lines[i];const m=l.match(/^(.*?[A-Za-z+].*?)[\s:=\-–]+\$?\s*(\d[\d,]*(?:\.\d+)?)\s*$/);
    if(m){name=m[1];val=num(m[2])}else if(!isNum(l)&&i+1<lines.length&&isNum(lines[i+1])){name=l;val=num(lines[i+1]);i++}else{if(!isNum(l))miss.push(l);continue}
    const p=progFor(name);if(p)out.push({p,val,name});else miss.push(name)}return{out,miss}}
function pasteBalSheet(){sheet(`<h3>Paste balances</h3><p class="small muted">One program per line with its balance, or the name on one line and the number below.</p><textarea id="x-t"></textarea><div id="x-prev" class="list" style="margin-top:8px"></div><div class="btns" style="margin-top:10px"><button class="primary" id="x-ok" style="flex:1" disabled>Save balances</button><button data-close>Cancel</button></div>`,el=>{
  const ta=el.querySelector('#x-t'),pv=el.querySelector('#x-prev'),ok=el.querySelector('#x-ok');let res={out:[],miss:[]};
  ta.oninput=()=>{res=parseBalances(ta.value);ok.disabled=!res.out.length;ok.textContent=res.out.length?`Save ${res.out.length} balance${res.out.length>1?'s':''}`:'Save balances';
    pv.innerHTML=res.out.map(r=>`<div class="item" style="padding:7px 2px"><div class="grow small">${esc(PROGRAMS[r.p].name)}<div class="tiny muted">from “${esc(r.name)}”</div></div><div class="small">${fmtBal(r.p,r.val)}</div></div>`).join('')+(res.miss.length?`<div class="tiny" style="color:var(--warn);padding-top:6px">Not recognised: ${res.miss.map(esc).join(', ')}</div>`:'')};
  ok.onclick=()=>{const nb=Object.assign({},S().pointsBalances||{});res.out.forEach(r=>nb[r.p]=r.val);setSetting('pointsBalances',nb,`points: ${res.out.length} balances`);setSetting('pointsBalancesAsOf',todayISO());closeSheet();render();toast(`Saved ${res.out.length} balances`)}})}

/* ================= More ================= */
let moreTab='next';
function vMore(){const tabs=[['next','Best next card'],['rules','Eligibility'],['settings','Settings']];
  let h=`<div class="seg">${tabs.map(([k,v])=>`<button data-act="mtab" data-t="${k}" class="${moreTab===k?'on':''}">${v}</button>`).join('')}</div>`;
  return h+(moreTab==='next'?vNext():moreTab==='rules'?vRules():vSettings())}
function annualEarn(defs,spend){let total=0;
  CATS.forEach(c=>{const yr=(spend[c.id]||0)*12;if(!yr)return;let best=0;defs.forEach(d=>{let p=returnPct(d,c.id);const cap=(d.caps||[]).find(x=>x.cats.includes(c.id));if(cap){const capYr=cap.period==='month'?cap.amount*12:cap.amount;const share=cap.cats.reduce((a,k)=>a+(spend[k]||0)*12,0)||1;const myCap=capYr*yr/share;if(yr>myCap){const fb=cap.fallback*cpp(d.program);p=(myCap*p+(yr-myCap)*fb)/yr}}if(p>best)best=p});total+=yr*best/100});return total}
function vNext(){const mine=activeCards().map(cardDef).filter(d=>!d.usd);const owned=new Set(activeCards().map(c=>c.catalogId));const spend=S().spend||{};const base=annualEarn(mine,spend);
  const cands=CATALOG.filter(c=>!c.biz&&!owned.has(c.id)).map(c=>{const gain=annualEarn([...mine,c],spend)-base;return{c,gain,net:gain-c.fee,elig:eligibility(c)}}).sort((a,b)=>b.net-a.net);
  return `<div class="card"><div class="small muted">With your current wallet and spending you earn about</div><div class="big">${moneyR(base)}/yr</div><div class="small muted">Edit your monthly spending in Settings.</div></div><h2>Cards that add the most</h2><div class="card list">`+cands.slice(0,10).map(x=>`<div class="item">${miniCard(x.c,true)}<div class="grow"><div class="ellipsis">${esc(x.c.name)}</div><div class="small muted">+${moneyR(x.gain)} earn − ${moneyR(x.c.fee)} fee${x.c.waiver?' · '+x.c.waiver:''}</div><div class="tiny" style="color:${x.elig.s==='no'?'var(--bad)':x.elig.s==='ok'?'var(--accent)':'var(--warn)'}">${esc(x.elig.t)}</div></div><div class="pct" style="${x.net<0?'color:var(--muted)':''}">${x.net>=0?'+':''}${moneyR(x.net)}</div></div>`).join('')+`</div><div class="small muted" style="margin:0 6px">Ongoing yearly value before welcome bonuses.</div>`}
const monthsAgo=s=>{if(!s)return null;const[y,m]=s.split('-').map(Number);const t=new Date();return(t.getFullYear()-y)*12+(t.getMonth()+1-m)};
function eligibility(c){if(c.prepaid)return{s:'ok',t:'Prepaid — no credit check'};
  const hist=D.cards.filter(w=>w.catalogId===c.id||D.events.some(e=>e.cardId===w.id&&e.type==='product_switch'&&(e.fromProduct===c.name||e.toProduct===c.name)));
  const opens=hist.map(w=>monthsAgo(w.openedDate)).filter(x=>x!=null);const recentOpen=opens.length?Math.min(...opens):null;
  const holdingNow=hist.some(w=>w.status!=='closed');const closes=hist.map(w=>w.closedDate?monthsAgo(w.closedDate):null).filter(x=>x!=null);const recent=holdingNow?0:Math.min(recentOpen??99,...(closes.length?closes:[99]));
  if(c.issuer==='amex'&&hist.length)return{s:'no',t:'Amex: welcome bonus is once per card — you’ve had this one'};
  if(c.issuer==='scotia'&&hist.length&&recent<24)return{s:'no',t:'Scotiabank: no bonus if you’ve had this card in the last 2 years'};
  if((c.issuer==='td'||c.issuer==='cibc')&&hist.length&&recent<12)return{s:'no',t:`${ISSUERS[c.issuer]}: you’ve had this card in the last 12 months`};
  if(c.aeroplanType){const got=D.cards.some(w=>{const d=cardDef(w);return d.aeroplanType===c.aeroplanType&&D.events.some(e=>e.cardId===w.id&&e.type==='bonus_spend_met'&&monthsAgo((e.date||'').slice(0,7))!=null&&monthsAgo(e.date.slice(0,7))<12)});if(got)return{s:'no',t:'Aeroplan: bonus on this card type already received in the last 12 months'}}
  if(hist.length)return{s:'warn',t:'You’ve held this card — check the issuer’s terms'};return{s:'ok',t:'Likely eligible'}}
function vRules(){const rules=[['American Express','Welcome bonus once per card per lifetime (you’re ineligible if you have or have had that card).'],['Scotiabank','No welcome bonus if you’ve held the same card in the last 2 years.'],['Aeroplan co-brands','Aeroplan bonus points once per card type (e.g. Visa Infinite) per 12 months, across TD, CIBC and Amex.'],['TD & CIBC','Generally no bonus if you’ve had the same card in the past 12 months.'],['Product switches','Switching usually forfeits a new-card bonus.']];
  return `<h2>Am I eligible?</h2><div class="small muted" style="margin:0 6px 8px">Checked against your wallet history, including closed cards and product switches.</div><div class="card list">`+CATALOG.filter(c=>!c.biz).map(c=>{const e=eligibility(c);return `<div class="item">${miniCard(c)}<div class="grow"><div class="ellipsis small">${esc(c.name)}</div><div class="tiny" style="color:${e.s==='no'?'var(--bad)':e.s==='ok'?'var(--accent)':'var(--warn)'}">${esc(e.t)}</div></div></div>`}).join('')+`</div><h2>Issuer rules</h2>`+rules.map(([t,d])=>`<div class="card"><div style="font-weight:600">${t}</div><div class="small muted">${d}</div></div>`).join('')}
function vSettings(){const sp=S().spend||{};const c=ST.cfg||{};const n=Object.keys(ST.dirty).length;
  let h=`<h2>Sync</h2><div class="card"><div class="kvs"><span>Data repo</span><span>${esc(c.owner)}/${esc(c.repo)} (${esc(BR())})</span><span>This device</span><span>${esc(c.device||'—')}</span><span>App version</span><span>${APP_VERSION} · ${Object.keys(IMG.urls).length}/${Object.keys(ST.imgIndex).length} card images on this device</span><span>Status</span><span>${esc($('#synctxt')?$('#synctxt').textContent:'')}${ST.sync.at?' · last sync '+new Date(ST.sync.at).toLocaleString('en-CA',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):''}</span></div>${n?`<div class="small" style="color:var(--warn);margin-top:6px">Waiting to upload: ${Object.entries(ST.dirty).map(([f,w])=>esc(f)).join(', ')}</div>`:''}
    <div class="btns" style="margin-top:10px"><button class="sm" data-act="syncnow">Sync now</button><button class="sm" data-act="setup">Change key or repo</button><a class="btn sm" href="https://github.com/${encodeURIComponent(c.owner||'')}/${encodeURIComponent(c.repo||'')}/commits" target="_blank" rel="noopener">Change history on GitHub</a></div></div>`;
  h+=`<h2>Pay runs</h2><div class="card"><label style="margin-top:0">Days between pay runs (used to warn about due dates)</label><input type="number" min="7" max="60" id="gap" value="${S().roundGapDays||25}"><div style="font-weight:600;margin:14px 0 4px">Funding accounts</div>${accounts().map((a,i)=>`<div class="frow" style="grid-template-columns:1fr 80px auto"><input data-acc="${i}" data-f="name" value="${esc(a.name)}"><select data-acc="${i}" data-f="currency"><option ${a.currency==='CAD'?'selected':''}>CAD</option><option ${a.currency==='USD'?'selected':''}>USD</option></select><button class="sm danger" data-act="delacc" data-i="${i}">✕</button></div>`).join('')}<button class="sm" data-act="addacc" style="margin-top:6px">+ Account</button></div>`;
  h+=`<h2>Monthly spending</h2><div class="card"><div class="small muted">Used for “Best next card”.</div><div class="grid2">${CATS.map(k=>`<div><label class="tiny">${k.icon} ${k.name}</label><input type="number" inputmode="numeric" data-spend="${k.id}" value="${sp[k.id]||0}"></div>`).join('')}</div></div>`;
  h+=`<h2>Bring over data from the old Card Signals</h2><div class="card small muted">In the old app: More → Settings → Copy backup, then paste here. Points balances, point values, spending, credits and free nights come across; cards don’t (your wallet here is the source of truth).<div class="btns" style="margin-top:8px"><button class="sm" data-act="importold">Paste backup</button></div></div>`;
  h+=`<h2>Install</h2><div class="card small muted">Phone: open this page in Chrome → ⋮ → <b>Install app</b> (or Add to Home screen). Laptop: Chrome/Edge address bar → install icon. Each device asks for the access key once.</div>`;
  h+=`<button class="danger" style="width:100%;margin-top:6px" data-act="forget">Remove key and data from this device</button>`;
  return h}
function importOld(){sheet(`<h3>Paste old Card Signals backup</h3><textarea id="x-t"></textarea><div class="btns" style="margin-top:10px"><button class="primary" id="x-ok" style="flex:1">Import</button><button data-close>Cancel</button></div>`,el=>{el.querySelector('#x-ok').onclick=()=>{let o;try{o=JSON.parse(el.querySelector('#x-t').value)}catch(e){toast('That doesn’t look like a backup');return}
  let n=0;if(o.balances&&Object.keys(o.balances).length){setSetting('pointsBalances',Object.assign({},S().pointsBalances||{},o.balances),'import old points balances');n++}
  if(o.cpp&&Object.keys(o.cpp).length){setSetting('cpp',Object.assign({},S().cpp||{},o.cpp),'import old point values');n++}
  if(o.spend){setSetting('spend',o.spend,'import old spending');n++}
  if(Array.isArray(o.credits)&&o.credits.length){setSetting('credits',[...(S().credits||[]),...o.credits.map(c=>Object.assign({},c,{id:uid('cr'),cardId:'',updatedAt:Date.now()}))],'import old credits');n++}
  if(Array.isArray(o.nights)&&o.nights.length){setSetting('nights',[...(S().nights||[]),...o.nights.map(c=>Object.assign({},c,{id:uid('fn'),cardId:'',updatedAt:Date.now()}))],'import old free nights');n++}
  closeSheet();render();toast(n?'Imported — assign any credits to their cards in Wallet':'Nothing to import')}})}

/* ================= first-run setup ================= */
function vSetup(replace){const c=ST.cfg||{};return `<div class="setup"><div class="card hero"><div class="big">Connect your card data</div><p class="muted">CardBlanche keeps your cards, history and pay runs in your <b>private</b> GitHub repo. Paste a fine-grained access key that can read and write only that repo.</p></div>
  <div class="card"><div class="grid2"><div><label style="margin-top:0">GitHub owner</label><input id="sO" value="${esc(c.owner||'clk1408-byte')}"></div><div><label style="margin-top:0">Data repo</label><input id="sR" value="${esc(c.repo||'card-wallet-data')}"></div></div>
  <label>Access key (fine-grained token)</label><input id="sT" type="password" autocomplete="off" placeholder="${replace&&c.token?'Leave blank to keep the current key':'github_pat_…'}">
  <label>Name for this device</label><input id="sD" value="${esc(c.device||(/Android|iPhone/i.test(navigator.userAgent)?'Pixel':'Laptop'))}">
  <div class="btns" style="margin-top:14px"><button class="primary" id="sGo" style="flex:1">Connect</button>${replace?'<button data-act="cancelsetup">Cancel</button>':''}</div><div class="small" id="sMsg" style="margin-top:8px"></div>
  <details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">How to make the key</summary><ol class="small muted" style="padding-left:18px"><li>GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token.</li><li>Repository access: <b>Only select repositories</b> → your data repo.</li><li>Permissions → Repository → <b>Contents: Read and write</b>. Nothing else.</li><li>Generate, copy, paste above. The key stays on this device only.</li></ol></details></div></div>`}
let setupReplace=false;
function bindSetup(){const go=$('#sGo');if(!go)return;go.onclick=async()=>{const old=ST.cfg||{};const cfg={owner:$('#sO').value.trim(),repo:$('#sR').value.trim(),branch:old.branch||'main',token:$('#sT').value.trim()||(setupReplace?old.token:''),device:$('#sD').value.trim()||'Device'};
  const msg=$('#sMsg');if(!cfg.token){msg.textContent='Paste the access key first.';return}msg.textContent='Checking…';
  const prev=ST.cfg;ST.cfg=cfg;
  try{const r=await gh(`${REPO()}`);if(r.json&&r.json.private===false){msg.innerHTML='<span style="color:var(--warn)">That repo is public — anyone could read your card data. Make it private first.</span>';ST.cfg=prev;return}
    if(r.json&&r.json.default_branch)cfg.branch=r.json.default_branch;
    const switched=!prev||prev.owner!==cfg.owner||prev.repo!==cfg.repo;if(switched){ST.files={};ST.dirty={};ST.head=null;ST.etag=null;FILES.forEach(f=>ST.data[f]=clone(EMPTY[f]))}
    LS.set('cb_cfg',cfg);setupReplace=false;persist();msg.textContent='Connected — loading…';await sync(true);ensureEarn();rollCredits();route();if(Object.keys(ST.dirty).length)queueSync(1500)}
  catch(e){ST.cfg=prev;msg.innerHTML=`<span style="color:var(--bad)">${e.status===401?'GitHub rejected that key.':e.status===404?'Can’t see that repo with this key — check the repo name and that the key includes it.':esc(e.message||'Couldn’t reach GitHub.')}</span>`}}}

/* ================= events ================= */
function bindView(){const sq=$('#storeq');if(sq)sq.oninput=e=>{storeQ=e.target.value;$('#storelist').innerHTML=storeRows()}}
$('#app').addEventListener('click',e=>{const t=e.target.closest('[data-act]');if(!t)return;const a=t.dataset.act,id=t.dataset.id;const run=draftRun();
  switch(a){
    case 'go':location.hash='#'+t.dataset.v;break;
    case 'mode':bestMode=t.dataset.m;render();break;
    case 'cat':showRanking(id);break;
    case 'store':showRanking(STORE_BY[id].cat,id);break;
    case 'shopmode':shopMode();break;
    case 'wtab':walletTab=t.dataset.t;render();break;
    case 'opencard':cardDetail(id);break;
    case 'addcard':addCard();break;
    case 'pmode':payMode=t.dataset.m;render();break;
    case 'startrun':startRun();break;
    case 'reorder':reorder=!reorder;render();break;
    case 'mv':movePayee(id,Number(t.dataset.d));break;
    case 'paid':{const b=getBal(run.id,id);if(b.balance==null)return;b.paid=!b.paid;b.paidDate=b.paid?todayISO():null;upsert('balances.json',b,`pay run ${run.date}: ${b.paid?'paid':'unpaid'} ${cardName(id)}`);render();break}
    case 'flag':flagSheet(run,id);break;
    case 'setdue':{const c=cardById(id);numberSheet(`Payment due day · ${cardLabel(c)}`,'Day of the month the payment is due (1–31)',c.dueDay,v=>{if(v!=null&&(v<1||v>31)){toast('Use a day from 1 to 31');return}c.dueDay=v;saveCard(c,`due day ${cardLabel(c)}`);render()});break}
    case 'rest':{const i=Number(t.dataset.i);const f=run.funding[i];const tot=runTotals(run),fun=fundTotals(run);f.amount=r2((Number(f.amount)||0)+tot[f.currency]-fun[f.currency]);if(f.amount<0)f.amount=0;upsert('payruns.json',run,`pay run ${run.date}: funding`);render();break}
    case 'rundate':numberLikeDate(run);break;
    case 'addmissing':{const have=new Set(runBals(run.id).map(b=>b.cardId));cardsForNewRun().filter(c=>!have.has(c.id)).forEach(c=>upsert('balances.json',{runId:run.id,cardId:c.id,currency:c.currency||'CAD',balance:null,paid:false,paidDate:null,flag:false,flagNote:''},`pay run ${run.date}: add cards`));render();break}
    case 'complete':{if(runBlockers(run).length)return;const tot=runTotals(run),fun=fundTotals(run);const off=['CAD','USD'].filter(c=>Math.abs(tot[c]-fun[c])>0.005);
      const finish=()=>{run.status='complete';run.totals=tot;run.completedAt=Date.now();run.total=tot.CAD;upsert('payruns.json',run,`pay run ${run.date}: complete (${money(tot.CAD)}${tot.USD?' + '+money(tot.USD,'USD'):''})`);payMode='history';render();toast('Pay run complete');sync()};
      if(off.length)confirmSheet(`Funding doesn’t add up to the total (${off.map(c=>money(r2(tot[c]-fun[c]),c)+' '+c+' left').join(', ')}). Complete anyway?`,'Complete anyway',finish);else finish();break}
    case 'discard':confirmSheet('Discard this pay run? Its balances are kept in the data file but won’t count anywhere.','Discard run',()=>{run.status='discarded';upsert('payruns.json',run,`pay run ${run.date}: discard`);render()});break;
    case 'openrun':runDetail(id);break;
    case 'resolve':{const b=getBal(t.dataset.run,id);sheet(`<h3>Resolve flag · ${esc(cardName(id))}</h3><p class="small muted">${esc(b.flagNote)}</p><label>How was it resolved?</label><input id="x-n" placeholder="e.g. refund posted"><label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" id="x-p" style="width:auto" ${b.paid?'checked':''}> Paid</label><div class="btns" style="margin-top:14px"><button class="primary" id="x-ok" style="flex:1">Resolve</button><button data-close>Cancel</button></div>`,el=>{el.querySelector('#x-ok').onclick=()=>{b.flagResolved=true;b.resolvedNote=el.querySelector('#x-n').value.trim();b.resolvedDate=todayISO();if(el.querySelector('#x-p').checked&&!b.paid){b.paid=true;b.paidDate=todayISO()}upsert('balances.json',b,`resolve flag ${cardName(id)}`);closeSheet();render()}});break}
    case 'editbal':balSheet(id);break;
    case 'pastebal':pasteBalSheet();break;
    case 'addprog':sheet(`<h3>Add a program</h3><div class="list">${Object.entries(PROGRAMS).filter(([k,p])=>!p.cash).sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([k,p])=>`<div class="item" data-p="${k}" style="cursor:pointer"><div class="icon">✦</div><div class="grow">${p.name}</div></div>`).join('')}</div>`,el=>{el.onclick=ev=>{const it=ev.target.closest('[data-p]');if(it){closeSheet();balSheet(it.dataset.p)}}});break;
    case 'mtab':moreTab=t.dataset.t;render();break;
    case 'syncnow':sync(true);break;
    case 'setup':setupReplace=true;render();break;
    case 'cancelsetup':setupReplace=false;render();break;
    case 'addacc':{const a=clone(accounts());a.push({id:uid('acct'),name:'New account',currency:'CAD',note:''});setSetting('fundingAccounts',a,'add funding account');render();break}
    case 'delacc':{const a=clone(accounts());a.splice(Number(t.dataset.i),1);setSetting('fundingAccounts',a,'remove funding account');render();break}
    case 'importold':importOld();break;
    case 'forget':confirmSheet('Remove the access key and the cached data from this device? Your data on GitHub is untouched.','Remove',()=>{LS.del('cb_cfg');LS.del('cb_state');LS.del('cb_lastsync');location.reload()});break;
  }});
function numberLikeDate(run){sheet(`<h3>Run date</h3><input id="x-d" type="date" value="${run.date}"><div class="btns" style="margin-top:14px"><button class="primary" id="x-ok" style="flex:1">Save</button><button data-close>Cancel</button></div>`,el=>{el.querySelector('#x-ok').onclick=()=>{const v=el.querySelector('#x-d').value;if(v){run.date=v;upsert('payruns.json',run,`pay run: date ${v}`)}closeSheet();render()}})}
$('#app').addEventListener('change',e=>{const t=e.target;const run=draftRun();
  if(t.dataset.bal&&run){const b=getBal(run.id,t.dataset.bal);const v=t.value.trim();const nv=v===''?null:r2(Number(v.replace(/[$,\s]/g,'')));if(nv!=null&&isNaN(nv)){toast('Not a number');return}
    if(b.balance===nv)return;b.balance=nv;if(nv===0){b.paid=true;b.paidDate=null}else if(b.paid&&!b.paidDate)b.paid=false;upsert('balances.json',b,`pay run ${run.date}: balances`);setTimeout(render,0);return}
  if(t.dataset.fund!=null&&run){const f=run.funding[Number(t.dataset.fund)];const fv=Number(String(t.value||0).replace(/[$,\s]/g,''));if(isNaN(fv)){toast('Not a number');return}f.amount=r2(fv);upsert('payruns.json',run,`pay run ${run.date}: funding`);setTimeout(render,0);return}
  if(t.id==='runnotes'&&run){run.notes=t.value;upsert('payruns.json',run,`pay run ${run.date}: notes`);return}
  if(t.dataset.spend){const sp=Object.assign({},S().spend||{});sp[t.dataset.spend]=Number(t.value||0);setSetting('spend',sp,'monthly spending');return}
  if(t.id==='gap'){setSetting('roundGapDays',Math.max(7,Math.min(60,Number(t.value)||25)),'pay-run gap');return}
  if(t.dataset.acc!=null){const a=clone(accounts());a[Number(t.dataset.acc)][t.dataset.f]=t.value;setSetting('fundingAccounts',a,'edit funding account');const dr=draftRun();if(dr){/* keep the open run's account names in step */}return}});
$('#app').addEventListener('keydown',e=>{const t=e.target;if(e.key==='Enter'&&(t.dataset.bal||t.dataset.fund!=null)){e.preventDefault();const all=[...document.querySelectorAll(t.dataset.bal?'[data-bal]':'[data-fund]')];const i=all.indexOf(t);const next=all[i+1];
  t.blur();/* blur fires change → re-render; then focus the next field */setTimeout(()=>{const id=next&&(next.dataset.bal?'bal-'+next.dataset.bal:'fund-'+next.dataset.fund);const el=id&&document.querySelector(`[data-keep="${id}"]`);if(el){el.focus();el.select&&el.select()}},0)}});
$('#sync').addEventListener('click',()=>{if(ST.cfg)sync(true)});

/* ================= boot ================= */
function ensureEarn(){D.cards.forEach(c=>{const e=earnRecord(c);if(!same(e,c.earn)){c.earn=e;c.updatedAt=Date.now();ST.dirty['cards.json']=ST.dirty['cards.json']||'add earn summaries'}});persist()}
async function boot(){route();if(ST.cfg){await sync(true);ensureEarn();rollCredits();render();if(Object.keys(ST.dirty).length)queueSync(1500)}}
boot();
