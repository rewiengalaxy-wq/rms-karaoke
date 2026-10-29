(()=>{
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const ICON_PLAY='<svg width="30" height="30" viewBox="0 0 24 24" fill="#fff"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const ICON_PAUSE='<svg width="28" height="28" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.5"/></svg>';
const DEF={on:true,strength:1,bass:150,keepBass:true,keepHigh:false,vol:1,tempo:1,guide:0};
const fmt=t=>{if(!isFinite(t))t=0;t=Math.max(0,t);return Math.floor(t/60)+':'+String(Math.floor(t%60)).padStart(2,'0')};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(toast.h);toast.h=setTimeout(()=>t.classList.remove('on'),2600)}
function loading(on,txt){$('#loader').classList.toggle('on',on);if(txt)$('#loadTxt').textContent=txt}
function ask(title,text,yes='Verwijderen',no='Annuleren'){return new Promise(r=>{$('#mTitle').textContent=title;$('#mText').textContent=text;$('#mYes').textContent=yes;$('#mNo').textContent=no;$('#modal').classList.add('on');const done=v=>{$('#modal').classList.remove('on');$('#mYes').onclick=$('#mNo').onclick=null;r(v)};$('#mYes').onclick=()=>done(true);$('#mNo').onclick=()=>done(false)})}

/* ---------- Storage ---------- */
const Store={db:null,mem:new Map(),persistent:false,
  async init(){try{this.db=await new Promise((res,rej)=>{const r=indexedDB.open('rm-karaoke',1);r.onupgradeneeded=()=>{r.result.createObjectStore('tracks',{keyPath:'id'})};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});this.persistent=true;try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist()}catch(e){}}catch(e){this.db=null}
    $('#storeBadge').textContent=this.persistent?'● Opgeslagen op toestel':'● Tijdelijk';$('#storeBadge').style.color=this.persistent?'var(--ok)':'var(--warn)'},
  tx(m){return this.db.transaction('tracks',m).objectStore('tracks')},
  async all(){if(!this.db)return[...this.mem.values()];return new Promise((res,rej)=>{const r=this.tx('readonly').getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})},
  async put(t){if(!this.db){this.mem.set(t.id,t);return}return new Promise((res,rej)=>{const r=this.tx('readwrite').put(t);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})},
  async del(id){if(!this.db){this.mem.delete(id);return}return new Promise((res,rej)=>{const r=this.tx('readwrite').delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
};

/* ---------- AI engine ---------- */
const AI={workers:[],conc:1,ready:false,loading:null,backend:'cpu',pend:new Map(),seq:0,
  async fetchBin(url,onp,base,span){const r=await fetch(url);if(!r.ok)throw new Error('Model niet gevonden ('+r.status+')');const len=+r.headers.get('content-length')||0;
    if(!r.body||!len){const b=new Uint8Array(await r.arrayBuffer());onp&&onp(base+span);return b}
    const rd=r.body.getReader(),out=new Uint8Array(len);let got=0;for(;;){const {done,value}=await rd.read();if(done)break;out.set(value,got);got+=value.length;onp&&onp(base+span*got/len)}return out},
  load(onp){if(this.ready)return Promise.resolve();if(this.loading)return this.loading;
    this.loading=(async()=>{
      const map=await (await fetch('model/map.json')).json();
      const g=await this.fetchBin('model/graph.wasm',onp,0,.02),w1=await this.fetchBin('model/w1.wasm',onp,.02,.44),w2=await this.fetchBin('model/w2.wasm',onp,.46,.44);
      const w=new Uint8Array(w1.length+w2.length);w.set(w1);w.set(w2,w1.length);
      const model=RMSep.rebuildModel(g,w,map);onp&&onp(.95);
      const wasmUrl=new URL('model/ort.wasm',location.href).href;let wasmBinary;try{const r=await fetch('model/ort.wasm');if(!r.ok)throw 0;wasmBinary=new Uint8Array(await r.arrayBuffer())}catch(e){throw new Error('AI-rekenmotor ontbreekt nog in de app (model/ort.wasm).')}
      let src;try{src=await (await fetch('worker.js')).text()}catch(e){throw new Error('AI-onderdeel kon niet laden')}
      const url=URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
      const cores=navigator.hardwareConcurrency||2,mem=navigator.deviceMemory||4;
      let n=Math.max(1,Math.min(cores-1,mem>=8?4:mem>=4?3:2));
      const start=()=>{const wk=new Worker(url);wk.busy=0;
        return new Promise((res,rej)=>{const to=setTimeout(()=>rej(new Error('AI start niet (time-out)')),180000);
          wk.onmessage=e=>{const m=e.data;if(m.type==='ready'){clearTimeout(to);res(wk)}else if(m.type==='error'&&m.id===undefined){clearTimeout(to);rej(new Error(m.message))}else if(m.id!==undefined){wk.busy--;const p=this.pend.get(m.id);if(p){this.pend.delete(m.id);m.type==='result'?p.res(m.data):p.rej(new Error(m.message))}}};
          wk.onerror=e=>{clearTimeout(to);rej(new Error(e.message||'AI-worker fout'))};
          const mc=model.slice(),wb=wasmBinary.slice();wk.postMessage({type:'init',model:mc,wasmUrl,wasmBinary:wb},[mc.buffer,wb.buffer])})};
      this.workers=[await start()];
      for(let i=1;i<n;i++){try{this.workers.push(await start())}catch(e){break}}
      this.conc=this.workers.length;
      this.ready=true;onp&&onp(1)})();
    this.loading.catch(()=>{this.loading=null});return this.loading},
  infer(spec){return new Promise((res,rej)=>{const id=++this.seq;this.pend.set(id,{res,rej});const wk=this.workers.reduce((a,b)=>b.busy<a.busy?b:a);wk.busy++;wk.postMessage({type:'run',id,spec},[spec.buffer])})}
};
async function decode44(blob){const ab=await blob.arrayBuffer();const oc=new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(2,1,44100);return await oc.decodeAudioData(ab)}
function chans(buf){const L=buf.getChannelData(0),R=buf.numberOfChannels>1?buf.getChannelData(1):L;return [L,R]}

/* ---------- Native (APK) bridge ---------- */
const NATIVE=!!window.RMNative;
async function blobToNative(blob,fn){const CH=3*262144;for(let o=0;o<blob.size;o+=CH){const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]||'');r.onerror=()=>rej(r.error);r.readAsDataURL(blob.slice(o,o+CH))});fn(b64)}}
async function runAINative(blob,set){
  const job='j'+Date.now().toString(36);set(.02,'Nummer klaarzetten…');
  RMNative.fileBegin(job);await blobToNative(blob,b=>RMNative.fileChunk(job,b));RMNative.fileEnd(job);
  return await new Promise((res,rej)=>{let t0=0;const cancelPoll=setInterval(()=>{if(cancelFlag){RMNative.cancel();clearInterval(cancelPoll)}},300);
    window.__rmn={stage:t=>set(null,t),
      progress:(k,n)=>{if(!t0)t0=performance.now()-1;const el=(performance.now()-t0)/1000,eta=el/k*(n-k);set(.1+.88*k/n,'Zang verwijderen…',`deel ${k}/${n} · nog ~${fmt(eta)}`)},
      chunk:(k,n,url)=>{if(!t0)t0=performance.now();fetch(url).then(r=>r.arrayBuffer()).then(ab=>{const f=new Float32Array(ab),h=f.length/2;Stream.add(k,n,f.subarray(0,h),f.subarray(h));RMNative.deleteOut(url.split('/').pop())}).catch(()=>{})},
      done:async(url,dur)=>{clearInterval(cancelPoll);try{const wav=await (await fetch(url)).blob();RMNative.deleteOut(url.split('/').pop());const b=await decode44(wav);res({inst:wav,duration:b.duration,peaks:computePeaks(chans(b)),backend:'native'})}catch(e){rej(e)}},
      error:m=>{clearInterval(cancelPoll);rej(new Error(m))}};
    if(!RMNative.separate(job)){clearInterval(cancelPoll);rej(new Error('Bestand kon niet worden doorgegeven aan de AI'))}})}
window.__rmBack=()=>{if($('#modal').classList.contains('on')){$('#mNo').click();return true}if(busy)return true;const on=$$('.screen').find(s=>s.classList.contains('on'));if(on&&on.id!=='s-lib'){go('lib');return true}return false};

/* Processing UI (renders into a host element) */
let cancelFlag=false,wakeLock=null;
async function runAI(blob,host){
  cancelFlag=false;
  host.innerHTML=`<div class="proc"><div class="eq" style="justify-content:center;margin:0 auto"><i></i><i></i><i></i><i></i><i></i></div><b id="prT">AI-model laden…</b><div class="prog"><i id="prB"></i></div><div class="pinfo"><span id="prL">0%</span><span id="prR"></span></div><div id="stBox" style="margin:16px 0 4px"><button class="btn pri full" id="stBtn" disabled>Even geduld… eerste stukjes worden gemaakt</button><div id="stInfo" style="color:var(--mut);font-size:13px;margin-top:8px;font-variant-numeric:tabular-nums"></div></div><p style="color:var(--mut);font-size:13px;margin:8px 0">Je kunt al zingen terwijl de AI verder werkt. Houd het scherm aan en blijf in de app.</p><button class="btn ghost" id="prC">Annuleren</button></div>`;
  Stream.reset();$('#stBtn').onclick=()=>{Stream.on?Stream.stop():Stream.start();Stream.ui()};
  $('#prC').onclick=()=>{cancelFlag=true};
  const set=(p,t,r)=>{if(p!=null){$('#prB').style.width=(p*100).toFixed(1)+'%';$('#prL').textContent=Math.round(p*100)+'%'}if(t)$('#prT').textContent=t;$('#prR').textContent=r||''};
  try{wakeLock=await navigator.wakeLock?.request('screen')}catch(e){}
  try{
    if(NATIVE){const r=await runAINative(blob,set);return r}
    await AI.load(p=>set(p*.1,'AI-model laden…'));
    if(cancelFlag)throw new Error('cancelled');
    set(.1,'Nummer voorbereiden…',AI.conc>1?AI.conc+' AI-kernen actief':'');
    const buf=await decode44(blob);const [L,R]=chans(buf);Stream.dur=buf.duration;
    const t0=performance.now();
    const [iL,iR]=await RMSep.separateParallel(L,R,s=>AI.infer(s),AI.conc,(k,n)=>{const el=(performance.now()-t0)/1000,eta=el/k*(n-k);set(.1+.88*k/n,'Zang verwijderen…',`deel ${k}/${n} · ${AI.conc}× parallel · nog ~${fmt(eta)}`)},()=>cancelFlag,(k,n,a,b)=>Stream.add(k,n,a,b));
    set(.99,'Opslaan…');
    const wav=encodeWav([iL,iR],44100);
    return {inst:wav,duration:buf.duration,peaks:computePeaks([iL,iR]),backend:AI.backend};
  }catch(e){Stream.stop();throw e}finally{try{wakeLock&&wakeLock.release()}catch(e){}wakeLock=null}
}

/* ---------- Live stream: sing while the AI is still working ---------- */
const Stream={ctx:null,ready:new Map(),total:0,next:0,startAt:0,on:false,stalled:false,timer:null,dur:0,gain:null,
  reset(){this.stop();this.ready=new Map();this.total=0;this.next=0},
  add(k,n,a,b){this.total=n;const c=new Float32Array(a),d=new Float32Array(b);this.ready.set(k,[c,d]);this.ui()},
  avail(){let k=this.next;while(this.ready.has(k))k++;return k},
  start(){if(this.on)return;try{this.ctx=new AudioContext({sampleRate:44100})}catch(e){this.ctx=new AudioContext()}
    this.gain=this.ctx.createGain();this.gain.connect(this.ctx.destination);this.startAt=this.ctx.currentTime+.2;this.next=0;this.on=true;this.stalled=false;
    this.timer=setInterval(()=>this.tick(),100);this.tick();this.ui()},
  tick(){if(!this.on)return;const c=this.ctx,G=RMSep.GEN/44100;
    while(this.ready.has(this.next)&&this.startAt+this.next*G<c.currentTime+1.5){const [l,r]=this.ready.get(this.next);const buf=c.createBuffer(2,l.length,44100);buf.copyToChannel(l,0);buf.copyToChannel(r,1);const s=c.createBufferSource();s.buffer=buf;s.connect(this.gain);s.start(Math.max(c.currentTime,this.startAt+this.next*G));this.next++}
    const due=this.startAt+this.next*G;
    if(this.total&&this.next>=this.total){if(!this.stalled&&c.currentTime>Math.min(due,this.startAt+this.dur)+.3){this.stop();this.ui();return}}
    else if(!this.ready.has(this.next)&&c.currentTime>due-.25&&!this.stalled){this.stalled=true;c.suspend()}
    if(this.stalled&&(this.ready.has(this.next)||(this.total&&this.next>=this.total))){this.stalled=false;c.resume()}
    this.ui()},
  stop(){clearInterval(this.timer);this.timer=null;if(this.ctx){try{this.ctx.close()}catch(e){}}this.ctx=null;this.on=false;this.stalled=false},
  pos(){if(!this.ctx)return 0;return Math.max(0,this.ctx.currentTime-this.startAt)},
  ui(){const box=document.getElementById('stBox');if(!box)return;const G=RMSep.GEN/44100,av=this.avail(),ahead=av*G;
    const btn=document.getElementById('stBtn'),info=document.getElementById('stInfo');if(!btn)return;
    if(!this.on){const ok=av>=2||(this.total&&av>=this.total);btn.disabled=!ok;btn.innerHTML=ok?'▶&nbsp; Begin nu met zingen':'Even geduld… eerste stukjes worden gemaakt';info.textContent=ok?`${fmt(ahead)} klaar om te zingen`:''}
    else{btn.disabled=false;btn.innerHTML='■&nbsp; Stop';info.textContent=this.stalled?'⏳ Even wachten op de AI…':`${fmt(this.pos())} / ${fmt(this.dur)} · ${fmt(Math.max(0,ahead-this.pos()))} vooruit klaar`}}
};

/* ---------- Audio playback ---------- */
let ctx=null;
function getCtx(){if(!ctx){ctx=new (window.AudioContext||window.webkitAudioContext)()}if(ctx.state==='suspended')ctx.resume();return ctx}
// classic centre-cancel graph (fallback for tracks without AI version)
function buildClassic(c){
  const input=c.createGain(),split=c.createChannelSplitter(2),merge=c.createChannelMerger(2),out=c.createGain();input.connect(split);
  const sL=c.createGain(),sR=c.createGain(),side=c.createGain();sL.gain.value=.5;sR.gain.value=-.5;split.connect(sL,0);split.connect(sR,1);sL.connect(side);sR.connect(side);
  const inv=c.createGain();inv.gain.value=-1;side.connect(inv);
  const mL=c.createGain(),mR=c.createGain(),mid=c.createGain();mL.gain.value=mR.gain.value=.5;split.connect(mL,0);split.connect(mR,1);mL.connect(mid);mR.connect(mid);
  const lp=c.createBiquadFilter();lp.type='lowpass';lp.frequency.value=150;mid.connect(lp);const bassG=c.createGain();lp.connect(bassG);
  const kL=c.createGain(),kR=c.createGain();side.connect(kL);inv.connect(kR);bassG.connect(kL);bassG.connect(kR);
  const dL=c.createGain(),dR=c.createGain();split.connect(dL,0);split.connect(dR,1);
  kL.connect(merge,0,0);dL.connect(merge,0,0);kR.connect(merge,0,1);dR.connect(merge,0,1);merge.connect(out);
  return {input,output:out,set(k){kL.gain.value=kR.gain.value=k*1.6;bassG.gain.value=1/1.6;dL.gain.value=dR.gain.value=1-k}}}
function makePlayer(){
  const mk=()=>{const a=new Audio();a.preload='auto';try{a.preservesPitch=true}catch(e){}return a};
  const inst=mk(),orig=mk();let built=false,gI,gO,master,an,classic;
  const P={el:inst,orig,settings:{...DEF},hasInst:false,
    build(){if(built)return;built=true;const c=getCtx();const sI=c.createMediaElementSource(inst),sO=c.createMediaElementSource(orig);gI=c.createGain();gO=c.createGain();master=c.createGain();an=c.createAnalyser();an.fftSize=256;an.smoothingTimeConstant=.8;
      classic=buildClassic(c);sI.connect(gI);sO.connect(gO);gO.connect(classic.input);classic.output.connect(master);gI.connect(master);master.connect(an);an.connect(c.destination);P.apply(P.settings)},
    load(origBlob,instBlob){[inst,orig].forEach(a=>{if(a.src)URL.revokeObjectURL(a.src)});P.hasInst=!!instBlob;P.el=instBlob?inst:orig;orig.src=URL.createObjectURL(origBlob);if(instBlob)inst.src=URL.createObjectURL(instBlob);else inst.removeAttribute('src');orig.load();if(instBlob)inst.load()},
    apply(s){P.settings=s;[inst,orig].forEach(a=>a.playbackRate=s.tempo||1);if(!built)return;
      if(P.hasInst){classic.set(0);const g=s.on?s.guide:1;gI.gain.value=(1-g)*s.vol;gO.gain.value=g*s.vol;master.gain.value=1}
      else{gI.gain.value=0;gO.gain.value=s.vol;classic.set(s.on?s.strength:0)}},
    async toggle(){P.build();getCtx();if(P.el.paused){try{if(P.hasInst){orig.currentTime=inst.currentTime;await Promise.all([inst.play(),orig.play()])}else await orig.play()}catch(e){toast('Afspelen lukte niet')}}else{inst.pause();orig.pause()}},
    stop(){inst.pause();orig.pause()},
    seek(t){P.el.currentTime=t;if(P.hasInst)orig.currentTime=t},
    sync(){if(P.hasInst&&!inst.paused&&Math.abs(inst.currentTime-orig.currentTime)>.045)orig.currentTime=inst.currentTime},
    get analyser(){return an}};
  return P;
}
const editP=makePlayer(),mainP=makePlayer();

/* ---------- Helpers ---------- */
function encodeWav(ch,sr){const n=ch[0].length,c=ch.length,ab=new ArrayBuffer(44+n*c*2),v=new DataView(ab);let p=0;const w=s=>{for(const x of s)v.setUint8(p++,x.charCodeAt(0))},u32=x=>{v.setUint32(p,x,true);p+=4},u16=x=>{v.setUint16(p,x,true);p+=2};
  w('RIFF');u32(36+n*c*2);w('WAVE');w('fmt ');u32(16);u16(1);u16(c);u32(sr);u32(sr*c*2);u16(c*2);u16(16);w('data');u32(n*c*2);
  const i16=new Int16Array(ab,44);for(let i=0,k=0;i<n;i++)for(let j=0;j<c;j++,k++){let s=ch[j][i];s=s<-1?-1:s>1?1:s;i16[k]=s<0?s*32768:s*32767}return new Blob([ab],{type:'audio/wav'})}
function computePeaks([L,R],n=600){const step=Math.floor(L.length/n)||1,p=new Array(n);for(let i=0;i<n;i++){let m=0;for(let j=i*step,e=Math.min(L.length,j+step);j<e;j+=4){const v=Math.abs(L[j]+R[j])*.5;if(v>m)m=v}p[i]=m}const mx=Math.max(...p)||1;return p.map(v=>+(v/mx).toFixed(3))}
function drawWave(cv,peaks,pos){const r=window.devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;if(!w)return;if(cv.width!==w*r){cv.width=w*r;cv.height=h*r}const x=cv.getContext('2d');x.setTransform(r,0,0,r,0,0);x.clearRect(0,0,w,h);if(!peaks)return;
  const n=Math.floor(w/3),gr=x.createLinearGradient(0,0,w,0);gr.addColorStop(0,'#ff3d8b');gr.addColorStop(.55,'#8b5cf6');gr.addColorStop(1,'#22d3ee');
  for(let i=0;i<n;i++){const v=peaks[Math.floor(i/n*peaks.length)]||0,bh=Math.max(2,v*(h-16));x.fillStyle=(i/n<=pos)?gr:'rgba(255,255,255,.16)';x.fillRect(i*3,(h-bh)/2,2,bh)}}
function bindSeek(cv,P){const go=e=>{const r=cv.getBoundingClientRect(),cx=e.clientX-r.left;if(P.el.duration)P.seek(Math.max(0,Math.min(1,cx/r.width))*P.el.duration)};let d=false;cv.addEventListener('pointerdown',e=>{d=true;go(e)});addEventListener('pointermove',e=>{if(d)go(e)});addEventListener('pointerup',()=>d=false)}

function settingsUI(host,s,hasInst,onChange){
  host.innerHTML=`
  <div class="seg" style="margin-top:6px"><button data-m="1">Zonder zang</button><button data-m="0">Origineel</button></div>
  ${hasInst?`<div class="sl"><div class="lab"><span>Gidszang (zachtjes meezingen)</span><b data-v="guide"></b></div><input type="range" min="0" max="0.6" step="0.01" data-k="guide"></div>`
  :`<div class="note warn" style="margin:12px 0 0">Deze track gebruikt nog de oude, snelle methode. Ga naar <b>Track</b> en kies <b>Opnieuw: zang verwijderen met AI</b> voor studiokwaliteit.</div>`}
  <div class="sl"><div class="lab"><span>Tempo</span><b data-v="tempo"></b></div><input type="range" min="0.75" max="1.25" step="0.01" data-k="tempo"></div>
  <div class="sl"><div class="lab"><span>Volume</span><b data-v="vol"></b></div><input type="range" min="0" max="1.5" step="0.01" data-k="vol"></div>`;
  const lab={guide:v=>Math.round(v*100)+'%',tempo:v=>Math.round(v*100)+'%',vol:v=>Math.round(v*100)+'%'};
  const render=()=>{host.querySelectorAll('[data-m]').forEach(b=>b.classList.toggle('on',+b.dataset.m===(s.on?1:0)));host.querySelectorAll('[data-k]').forEach(i=>{i.value=s[i.dataset.k];host.querySelector(`[data-v="${i.dataset.k}"]`).textContent=lab[i.dataset.k](+s[i.dataset.k])})};
  host.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{s.on=b.dataset.m==='1';render();onChange(s)});
  host.querySelectorAll('[data-k]').forEach(i=>i.oninput=()=>{s[i.dataset.k]=+i.value;render();onChange(s)});render()}

/* ---------- Navigation ---------- */
function go(name){if(name!=='imp')Stream.stop();$$('.screen').forEach(s=>s.classList.toggle('on',s.id==='s-'+name));$$('nav.bot button').forEach(b=>b.classList.toggle('on',b.dataset.go===name||(name==='play'&&b.dataset.go==='lib')));if(name!=='imp')editP.stop();if(name!=='play')mainP.stop();scrollTo(0,0);if(name==='lib')renderList()}
$$('[data-go]').forEach(b=>b.addEventListener('click',()=>{if(busy&&b.dataset.go!=='imp'){toast('Even wachten: de AI is nog bezig');return}go(b.dataset.go)}));
let busy=false;

/* ---------- Library ---------- */
const COLORS=[['#ff3d8b','#8b5cf6'],['#8b5cf6','#22d3ee'],['#f97316','#ff3d8b'],['#22d3ee','#34d399'],['#6366f1','#ec4899'],['#eab308','#f97316']];
const hash=s=>{let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))|0;return Math.abs(h)};
let tracks=[];
async function renderList(){tracks=(await Store.all()).sort((a,b)=>b.created-a.created);const q=$('#q').value.trim().toLowerCase();const list=tracks.filter(t=>!q||(t.title+' '+t.artist).toLowerCase().includes(q));
  $('#count').textContent=tracks.length+(tracks.length===1?' track':' tracks');
  if(!tracks.length){$('#list').innerHTML=`<div class="empty"><div class="ico"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#ff3d8b" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg></div><b style="color:var(--txt);font-family:Sora">Nog geen tracks</b><p style="margin:6px 0 16px">Importeer je eerste nummer en haal de zang eruit.</p><button class="btn pri" id="emptyImp">Nummer importeren</button></div>`;$('#emptyImp').onclick=()=>go('imp');return}
  if(!list.length){$('#list').innerHTML=`<div class="empty">Geen tracks gevonden voor "${esc(q)}"</div>`;return}
  $('#list').innerHTML=list.map(t=>{const c=COLORS[hash(t.id)%COLORS.length];return `<div class="track" data-id="${t.id}"><div class="cover" style="background:linear-gradient(135deg,${c[0]},${c[1]})">${esc((t.title||'?').trim().slice(0,1).toUpperCase())}</div><div class="tinfo"><b>${esc(t.title)}</b><span>${esc(t.artist||'Onbekende artiest')} · ${fmt(t.duration)}</span></div>${t.inst?'<span class="aibadge">AI</span>':'<span class="badge" style="background:rgba(251,191,36,.12);color:var(--warn)">Oud</span>'}</div>`}).join('');
  $$('#list .track').forEach(el=>el.onclick=()=>openTrack(el.dataset.id))}
$('#q').oninput=renderList;

/* ---------- Import ---------- */
let pending=null;
function parseName(n){n=n.replace(/\.[^.]+$/,'').replace(/_+/g,' ').replace(/\s*[\(\[][^)\]]*(official|video|audio|lyrics|hd|hq)[^)\]]*[\)\]]/ig,'').trim();n=n.replace(/^\s*\d{1,3}\s*[.)\-_]\s*/,'');const m=n.split(/\s+[-–—]\s+/).map(x=>x.replace(/^\s*\d{1,3}\s*[.)]\s*/,''));return m.length>1?{artist:m[0].trim(),title:m.slice(1).join(' - ').trim()}:{artist:'',title:n}}
function resetImport(){editP.stop();Stream.stop();pending=null;$('#impEdit').style.display='none';$('#impPick').style.display='';$('#ePrev').style.display='none';$('#eSave').disabled=true}
async function handleFile(f){if(!f)return;if(busy)return;if(!/^audio\//.test(f.type)&&!/\.(mp3|m4a|wav|ogg|flac|aac|opus|webm)$/i.test(f.name)){toast('Dit is geen audiobestand');return}
  const nm=parseName(f.name);pending={blob:f,name:f.name,type:f.type||'audio/mpeg',settings:{...DEF}};
  $('#eTitle').value=nm.title;$('#eArtist').value=nm.artist;$('#eLyrics').value='';$('#eMono').innerHTML='';
  $('#impPick').style.display='none';$('#impEdit').style.display='';$('#ePrev').style.display='none';$('#eSave').disabled=true;$('#file').value='';
  busy=true;const me=pending;
  try{const r=await runAI(f,$('#eProc'));if(pending!==me)return;Object.assign(pending,r);
    pending.id='t'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);try{await saveTrack()}catch(e){}
    const live=Stream.on;$('#eProc').innerHTML=`<div class="note info" style="margin-top:0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg><div>Klaar! De zang is eruit gehaald en de track staat in je lijst.${live?' Je nummer speelt gewoon verder.':''}</div></div>`+(live?'<div id="stBox"><button class="btn sec full" id="stBtn"></button><div id="stInfo" style="color:var(--mut);font-size:13px;margin-top:8px"></div></div>':'');
    if(live){$('#stBtn').onclick=()=>{Stream.on?Stream.stop():Stream.start();Stream.ui()};Stream.ui()}
    editP.load(f,r.inst);editP.apply(pending.settings);settingsUI($('#eSettings'),pending.settings,true,s=>editP.apply(s));$('#eDur').textContent=fmt(r.duration);
    $('#ePrev').style.display='';$('#eSave').disabled=false;requestAnimationFrame(()=>drawWave($('#eWave'),pending.peaks,0))}
  catch(e){console.error(e);if(e.message==='cancelled'){toast('Geannuleerd');resetImport()}else aiFailed(e,f)}
  finally{busy=false}}
async function aiFailed(e,f){$('#eProc').innerHTML=`<div class="note warn" style="margin-top:0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg><div><b>De AI kon niet draaien.</b><br>${esc(e.message||e)}</div></div><div class="row"><button class="btn sec" id="aiRetry" style="flex:1">Opnieuw proberen</button><button class="btn ghost" id="aiClassic" style="flex:1">Snelle methode</button></div>`;
  $('#aiRetry').onclick=()=>handleFile(f);
  $('#aiClassic').onclick=async()=>{loading(true,'Voorbereiden…');try{const buf=await decode44(f);pending.duration=buf.duration;pending.peaks=computePeaks(chans(buf));pending.inst=null;editP.load(f,null);editP.apply(pending.settings);settingsUI($('#eSettings'),pending.settings,false,s=>editP.apply(s));$('#eDur').textContent=fmt(buf.duration);$('#ePrev').style.display='';$('#eSave').disabled=false;$('#eProc').innerHTML='';requestAnimationFrame(()=>drawWave($('#eWave'),pending.peaks,0))}catch(err){toast('Dit bestand kan niet worden gelezen')}finally{loading(false)}}}
$('#file').onchange=e=>handleFile(e.target.files[0]);
const drop=$('#drop');['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')}));['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over')}));drop.addEventListener('drop',e=>handleFile(e.dataTransfer.files[0]));
$('#impBack').onclick=()=>{if(busy){cancelFlag=true;return}resetImport()};
$('#ePlay').onclick=()=>{if(Stream.on){Stream.stop();$('#stBox')&&$('#stBox').remove()}editP.toggle()};bindSeek($('#eWave'),editP);
async function saveTrack(){const t={id:pending.id,title:$('#eTitle').value.trim()||parseName(pending.name).title,artist:$('#eArtist').value.trim(),lyrics:$('#eLyrics').value,blob:pending.blob,type:pending.type,fileName:pending.name,inst:pending.inst||null,peaks:pending.peaks,duration:pending.duration,settings:{...pending.settings},created:pending.created||(pending.created=Date.now())};await Store.put(t)}
$('#eSave').onclick=async()=>{if(!pending||!pending.peaks)return;if(!pending.id)pending.id='t'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  loading(true,'Opslaan…');try{await saveTrack();Stream.stop();resetImport();toast('Opgeslagen in je tracks ✓');go('lib')}catch(e){toast('Opslaan mislukt: telefoon vol?')}finally{loading(false)}};
$('#eSave').disabled=true;

/* ---------- Player ---------- */
let cur=null,lyrLines=[],fs=26;try{fs=+localStorage.getItem('rmk-fs')||26}catch(e){}
function openTrack(id){cur=tracks.find(t=>t.id===id);if(!cur)return;cur.settings={...DEF,...cur.settings};
  $('#pTitle').textContent=cur.title;$('#pArtist').textContent=cur.artist||'Onbekende artiest';$('#pDur').textContent=fmt(cur.duration);
  mainP.load(cur.blob,cur.inst);mainP.apply(cur.settings);settingsUI($('#pSettings'),cur.settings,!!cur.inst,s=>{mainP.apply(s);updMode();saveSettings()});$('#pMono').innerHTML='';
  $('#pAI').style.display=cur.inst?'none':'';$('#iTitle').value=cur.title;$('#iArtist').value=cur.artist;$('#iLyrics').value=cur.lyrics||'';renderLyrics();updMode();tab('lyr');go('play');requestAnimationFrame(()=>drawWave($('#pWave'),cur.peaks,0))}
let saveT;function saveSettings(){clearTimeout(saveT);saveT=setTimeout(()=>Store.put(cur).catch(()=>{}),500)}
function updMode(){const k=cur.settings.on;$('#modeTag').textContent=k?(cur.inst?'KARAOKE · AI':'KARAOKE'):'ORIGINEEL';$('#modeTag').classList.toggle('k',k)}
function renderLyrics(){lyrLines=(cur.lyrics||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);lastLine=-2;$('#lyr').style.fontSize=fs+'px';
  $('#lyr').innerHTML=lyrLines.length?lyrLines.map((l,i)=>`<p data-i="${i}">${esc(l)}</p>`).join(''):`<p style="color:var(--mut);font-size:15px;font-weight:500;font-family:Inter">Nog geen songtekst.<br>Ga naar <b>Track</b> en plak de tekst om mee te lezen.</p>`}
function tab(n){$$('.tabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===n));['lyr','mix','info'].forEach(k=>$('#t-'+k).style.display=k===n?'':'none')}
$$('.tabs button').forEach(b=>b.onclick=()=>tab(b.dataset.tab));
const setFs=v=>{fs=v;try{localStorage.setItem('rmk-fs',fs)}catch(e){}$('#lyr').style.fontSize=fs+'px'};
$('#fsMinus').onclick=()=>setFs(Math.max(16,fs-2));$('#fsPlus').onclick=()=>setFs(Math.min(44,fs+2));
$('#pPlay').onclick=()=>mainP.toggle();
$('#pBack10').onclick=()=>mainP.seek(Math.max(0,mainP.el.currentTime-10));
$('#pFwd10').onclick=()=>mainP.seek(Math.min(mainP.el.duration||0,mainP.el.currentTime+10));
bindSeek($('#pWave'),mainP);
$('#iSave').onclick=async()=>{cur.title=$('#iTitle').value.trim()||cur.title;cur.artist=$('#iArtist').value.trim();cur.lyrics=$('#iLyrics').value;await Store.put(cur);$('#pTitle').textContent=cur.title;$('#pArtist').textContent=cur.artist||'Onbekende artiest';renderLyrics();toast('Wijzigingen opgeslagen ✓')};
$('#pDel').onclick=async()=>{if(await ask('Track verwijderen?',`"${cur.title}" wordt definitief uit je tracks verwijderd.`)){mainP.stop();await Store.del(cur.id);toast('Track verwijderd');go('lib')}};
$('#pAI').onclick=async()=>{if(busy)return;mainP.stop();const host=$('#pAIhost')||(()=>{const d=document.createElement('div');d.id='pAIhost';d.className='card';$('#pAI').after(d);return d})();$('#pAI').style.display='none';busy=true;
  try{const r=await runAI(cur.blob,host);cur.inst=r.inst;cur.peaks=r.peaks;cur.duration=r.duration;cur.settings.on=true;await Store.put(cur);host.remove();toast('Klaar! Zang verwijderd met AI ✓');openTrack(cur.id)}
  catch(e){if(e.message==='cancelled'){host.remove();$('#pAI').style.display='';toast('Geannuleerd')}else{host.innerHTML=`<div class="note warn" style="margin:0">De AI kon niet draaien: ${esc(e.message||e)}</div>`;$('#pAI').style.display=''}}finally{busy=false}};

let downloads=null;
$('#pExport').onclick=async()=>{try{let wav=cur.inst;if(!wav){toast('Verwerk de track eerst met AI');return}
  const name=((cur.artist?cur.artist+' - ':'')+cur.title+' (zonder zang).wav').replace(/[\\/:*?"<>|]/g,'');
  if(!NATIVE&&!downloads&&window.claude&&claude.use){try{downloads=await claude.use('downloads')}catch(e){}}
  if(NATIVE){loading(true,'Opslaan in Downloads…');try{if(!RMNative.saveBegin(name,'audio/wav'))throw 0;await blobToNative(wav,b=>RMNative.saveChunk(b));if(!RMNative.saveEnd())throw 0;toast('Opgeslagen in Downloads/RM Karaoke ✓')}finally{loading(false)}}
  else if(downloads){await downloads.save({filename:name,data:wav});toast('Download gestart ✓')}
  else{const a=document.createElement('a');a.href=URL.createObjectURL(wav);a.download=name;document.body.appendChild(a);a.click();a.remove();toast('Download gestart ✓')}
}catch(e){console.error(e);toast('Download geannuleerd of niet gelukt')}};

/* ---------- Frame loop ---------- */
[[editP,'#ePlay'],[mainP,'#pPlay']].forEach(([P,sel])=>{const b=$(sel);const u=()=>b.innerHTML=(P.el.paused?ICON_PLAY:ICON_PAUSE);[P.el,P.orig].forEach(a=>['play','pause','ended'].forEach(ev=>a.addEventListener(ev,u)));P.el.addEventListener('ended',()=>P.stop());P.u=u;u()});
let lastLine=-2;const viz=$('#viz');const fd=new Uint8Array(128);let vt=0;
function frame(){requestAnimationFrame(frame);editP.sync();mainP.sync();
  if($('#s-imp').classList.contains('on')&&pending&&pending.peaks){const e=editP.el;drawWave($('#eWave'),pending.peaks,e.duration?e.currentTime/e.duration:0);$('#eCur').textContent=fmt(e.currentTime);editP.u()}
  if($('#s-play').classList.contains('on')&&cur){const e=mainP.el,d=e.duration||cur.duration,pos=d?e.currentTime/d:0;drawWave($('#pWave'),cur.peaks,pos);$('#pCur').textContent=fmt(e.currentTime);mainP.u();
    const r=devicePixelRatio||1,w=viz.clientWidth,h=viz.clientHeight;if(viz.width!==w*r){viz.width=w*r;viz.height=h*r}const x=viz.getContext('2d');x.setTransform(r,0,0,r,0,0);x.clearRect(0,0,w,h);
    const an=mainP.analyser;vt+=.02;if(an&&!e.paused)an.getByteFrequencyData(fd);else for(let i=0;i<fd.length;i++)fd[i]=fd[i]*.92;
    const bars=48,bw=w/bars,gr=x.createLinearGradient(0,h,0,0);gr.addColorStop(0,'rgba(255,61,139,.9)');gr.addColorStop(.6,'rgba(139,92,246,.7)');gr.addColorStop(1,'rgba(34,211,238,.5)');x.fillStyle=gr;
    for(let i=0;i<bars;i++){const v=(fd[Math.floor(i*1.6)]||0)/255,idle=e.paused?(.06+.04*Math.sin(vt*2+i*.4)):0,bh=Math.max(3,(v+idle)*h*.85);x.fillRect(i*bw+1,h-bh,bw-2,bh)}
    if(lyrLines.length){const n=lyrLines.length,f=(pos-.06)/.88,li=pos<.06?-1:Math.min(n-1,Math.floor(f*n));
      if(li!==lastLine){lastLine=li;const box=$('#lyr');box.querySelectorAll('p.cur').forEach(p=>p.classList.remove('cur'));const p=box.querySelector(`p[data-i="${li}"]`);if(p){p.classList.add('cur');box.scrollTo({top:p.offsetTop-box.clientHeight/2+p.clientHeight/2,behavior:'smooth'})}else box.scrollTo({top:0})}}}}
$('#lyr').addEventListener('click',e=>{const p=e.target.closest('p[data-i]');if(!p||!lyrLines.length)return;const d=mainP.el.duration||cur.duration;mainP.seek(d*(.06+.88*(+p.dataset.i+.02)/lyrLines.length))});

/* ---------- YouTube ---------- */
function ytId(u){const m=u.match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);return m?m[1]:null}
function ytUpd(){const u=$('#ytUrl').value.trim(),id=ytId(u),a=$('#ytOpen');if(id){a.href='https://www.youtube.com/watch?v='+id;a.style.display='';$('#ytInfo').innerHTML=`<div class="note info" style="margin-bottom:0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg><div>Geldige YouTube-link herkend (video-ID <b>${id}</b>).</div></div>`}else{a.style.display='none';$('#ytInfo').innerHTML=u?`<div class="note warn" style="margin-bottom:0">Dit lijkt geen YouTube-link.</div>`:''}}
$('#ytUrl').oninput=ytUpd;
$('#ytPaste').onclick=async()=>{try{$('#ytUrl').value=await navigator.clipboard.readText();ytUpd()}catch(e){$('#ytUrl').focus();toast('Houd het veld ingedrukt en kies Plakken')}};
const ytS=()=>{$('#ytSearch').href='https://www.youtube.com/results?search_query='+encodeURIComponent(($('#ytQ').value.trim()||'')+' karaoke')};$('#ytQ').oninput=ytS;ytS();

(async()=>{await Store.init();renderList();frame()})();
})();
