const $ = s => document.querySelector(s);
window.addEventListener('error', e => {
  try{ toast('خطای صفحه: ' + (e.message||'نامشخص') + ' — جزئیات در کنسول مرورگر', true); }catch(_){}
  console.error('[tp] global error', e.error || e.message);
});
window.addEventListener('unhandledrejection', e => {
  try{ toast('خطای درخواست: ' + ((e.reason && e.reason.message) || 'نامشخص'), true); }catch(_){}
  console.error('[tp] unhandled rejection', e.reason);
});
document.documentElement.dataset.theme = localStorage.getItem('tp_theme') || 'night';
function toggleTheme(){
  const next = document.documentElement.dataset.theme === 'dawn' ? 'night' : 'dawn';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('tp_theme', next);
  syncThemeBtn(); drawChart(lastChart);
  toast(next==='dawn' ? 'تم سپیده‌دم ☀️' : 'تم شب 🌙');
}
function syncThemeBtn(){ const b=$('#themeBtn'); if(b) b.textContent = document.documentElement.dataset.theme==='dawn' ? '☀️ سپیده‌دم' : '🌙 شب'; }
let lastChart = [];
let token = localStorage.getItem('tp_token') || '';
let myRole = '';
let nodesCache = [], tunnelsCache = [];
const TITLES = {dashboard:['داشبورد','نمای کلی سرورها و تونل‌ها'],nodes:['سرورها','سرورهای متصل به پنل و وضعیت آن‌ها'],tunnels:['تونل‌ها','تونل‌های بین سرورها؛ زنده، سریع، امن'],users:['کاربران','مدیریت دسترسی به پنل'],help:['راهنما','هر چیزی برای شروع لازم داری'],update:['آپدیت سیستم','به‌روز نگه داشتن پنل و ایجنت‌ها']};

function fmtBytes(b){ if(!b) return '0 B'; const u=['B','KB','MB','GB','TB']; const i=Math.min(u.length-1,Math.floor(Math.log(b)/Math.log(1024))); return (b/Math.pow(1024,i)).toFixed(i?1:0)+' '+u[i]; }
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtDate(iso){ if(!iso) return '—'; return new Date(iso).toLocaleString('fa-IR'); }
function relTime(iso){
  if(!iso) return 'هرگز';
  const sec = Math.max(0,(Date.now()-new Date(iso))/1000|0);
  if(sec<8) return 'همین الان';
  if(sec<60) return sec+' ثانیه پیش';
  if(sec<3600) return (sec/60|0)+' دقیقه پیش';
  if(sec<86400) return (sec/3600|0)+' ساعت پیش';
  return (sec/86400|0)+' روز پیش';
}
function toast(msg, err=false){ const t=$('#toast'); t.textContent=msg; t.className='toast'+(err?' err':''); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.add('hidden'),3400); }
function copyText(txt, msg='کپی شد ✅'){ navigator.clipboard.writeText(txt).then(()=>toast(msg)).catch(()=>toast('کپی نشد', true)); }

async function api(method, path, body){
  const r = await fetch(path, {method, headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body: body?JSON.stringify(body):undefined});
  const data = await r.json().catch(()=>({}));
  if(r.status===401){ logout(); throw new Error(data.detail||'خطای ورود'); }
  if(!r.ok) throw new Error(data.detail||('خطا '+r.status));
  return data;
}

/* ---------- ورود ---------- */
$('#loginForm').addEventListener('submit', async e=>{
  e.preventDefault(); $('#loginError').textContent='';
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled=true; btn.textContent='در حال بررسی...';
  try{
    const r = await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#loginUser').value,password:$('#loginPass').value})});
    const d = await r.json();
    if(!r.ok) throw new Error(d.detail||'خطا');
    token = d.token; localStorage.setItem('tp_token', token);
    enterApp(d.username, d.role);
    toast('خوش آمدی 👋');
  }catch(err){ $('#loginError').textContent = err.message; }
  finally{ btn.disabled=false; btn.textContent='ورود به پنل ←'; }
});
function logout(){ token=''; localStorage.removeItem('tp_token'); $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); }
$('#logoutBtn').addEventListener('click', logout);

function enterApp(username, role){
  myRole = role;
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#whoami').textContent = username;
  $('#whoRole').textContent = role==='admin' ? 'ادمین سیستم' : 'کاربر';
  $('#avatarLetter').textContent = (username||'ا').slice(0,1);
  document.querySelectorAll('.admin-only').forEach(el=> el.style.display = role==='admin'?'':'none');
  refreshAll();
}
syncThemeBtn();
if(token){ api('GET','/api/auth/me').then(m=>enterApp(m.username,m.role)).catch(()=>{}); }

/* ---------- تب‌ها ---------- */
function gotoTab(name){
  document.querySelectorAll('.navbtn').forEach(x=>x.classList.toggle('active', x.dataset.tab===name));
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  $('#tab-'+name).classList.add('active');
  const t = TITLES[name]||[]; $('#pageTitle').textContent=t[0]||''; $('#pageSubtitle').textContent=t[1]||'';
  refreshAll();
}
document.querySelectorAll('.navbtn').forEach(b=> b.addEventListener('click', ()=>gotoTab(b.dataset.tab)));

async function refreshAll(manual){
  if(!token) return;
  // اگر فرمی باز است (ساخت/ویرایش تونل یا سرور)، تازه‌سازی خودکار صبر کند
  if(!manual && document.querySelector('.modal:not(.hidden)')) return;
  const active = document.querySelector('.tab.active')?.id || '';
  try{
    if(active==='tab-dashboard'){ await loadNodes(false); await loadTunnels(false); await loadDashboard(); }
    if(active==='tab-nodes') await loadNodes();
    if(active==='tab-tunnels'){ await loadNodes(false); await loadTunnels(); }
    if(active==='tab-users' && myRole==='admin') await loadUsers();
    if(active==='tab-update' && myRole==='admin'){ await loadNodes(false); loadAgentVersions(); const h = await (await fetch('/health')).json().catch(()=>({})); if(h.version) $('#curVersion').textContent = 'v'+h.version; }
    if(manual) toast('تازه‌سازی شد ↻');
  }catch(e){ console.warn(e); }
}
setInterval(refreshAll, 7000);

/* ---------- داشبورد ---------- */
async function loadDashboard(){
  const d = await api('GET','/api/dashboard');
  $('#stNodes').textContent = d.nodes_online+' / '+d.nodes_total;
  $('#stTunnels').textContent = d.tunnels_active+' / '+d.tunnels_total;
  $('#stIn').textContent = fmtBytes(d.bytes_in);
  $('#stOut').textContent = fmtBytes(d.bytes_out);
  $('#stConn').textContent = (d.connections||0).toLocaleString('fa-IR');
  lastChart = d.chart||[];
  drawChart(lastChart);
  const nr = $('#nodesRatio'); if(nr) nr.style.width = (d.nodes_total? Math.round(d.nodes_online/d.nodes_total*100):0)+'%';
  const tr = $('#tunRatio'); if(tr) tr.style.width = (d.tunnels_total? Math.round(d.tunnels_active/d.tunnels_total*100):0)+'%';
  renderMap(); renderAttention();
  $('#dashTunnels').innerHTML = tunnelsCache.slice(-5).reverse().map(t=>
    `<div class="mini-row"><span class="type-badge ${t.type}">${t.type==='reverse'?'Reverse':'Forward'}</span><div class="grow"><b>${esc(t.name)}</b><small>↓ ${fmtBytes(t.bytes_in)} · ↑ ${fmtBytes(t.bytes_out)}</small></div><span class="badge ${t.active?'on':'off'}">${t.active?'فعال':(t.enabled?'متوقف':'غیرفعال')}</span></div>`
  ).join('') || '<div class="empty-mini">هنوز تونلی ساخته نشده 🔀</div>';
}
function drawChart(chart){
  const c = $('#chart'); if(!c.clientWidth) return;
  const ctx = c.getContext('2d');
  const W = c.width = c.clientWidth, H = c.height = 150;
  ctx.clearRect(0,0,W,H);
  $('#chartEmpty').style.display = chart.length? 'none':'';
  if(!chart.length) return;
  const max = Math.max(1, ...chart.map(p=>Math.max(p.in,p.out)));
  const slot = (W-24)/chart.length, bw = Math.max(4, slot/2-5);
  ctx.strokeStyle='rgba(120,160,200,.14)'; ctx.beginPath();
  for(let g=0; g<4; g++){ const y=14+g*(H-48)/3; ctx.moveTo(10,y); ctx.lineTo(W-10,y); }
  ctx.stroke();
  chart.forEach((p,i)=>{
    const x = 14 + i*slot, base=H-24, hgt=v=>Math.max(2,(v/max)*(H-52));
    ctx.fillStyle='#2dd4bf'; roundBar(ctx,x,base-hgt(p.in),bw,hgt(p.in));
    ctx.fillStyle='#38bdf8'; roundBar(ctx,x+bw+3,base-hgt(p.out),bw,hgt(p.out));
    ctx.fillStyle='#8fa3b8'; ctx.font='9px Tahoma'; ctx.fillText(p.time, x, H-9);
  });
}
function roundBar(ctx,x,y,w,h){ const r=Math.min(3,w/2,h); ctx.beginPath(); ctx.moveTo(x,y+r); ctx.arcTo(x,y,x+r,y,r); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r); ctx.lineTo(x+w,y+h); ctx.lineTo(x,y+h); ctx.closePath(); ctx.fill(); }

/* ---------- سرورها ---------- */
async function loadNodes(render=true){
  nodesCache = await api('GET','/api/nodes');
  if(render) renderNodes();
}
function renderNodes(){
  const q = ($('#nodeSearch').value||'').trim().toLowerCase();
  const list = nodesCache.filter(n=> !q || (n.name+' '+(n.host||'')+' '+(n.reported_ip||'')).toLowerCase().includes(q));
  $('#nodeCount').textContent = nodesCache.length ? nodesCache.filter(n=>n.online).length+' آنلاین از '+nodesCache.length+' سرور' : '';
  $('#nodesGrid').innerHTML = list.map((n,i)=>`
  <div class="node-card" style="animation-delay:${Math.min(i*0.05,0.3)}s">
    <div class="nc-head"><div class="modal-ic teal-bg" style="margin:0">🖥️</div>
      <div><h4>${esc(n.name)}</h4><small>${esc(n.description||'بدون توضیح')}</small></div>
      <span class="status-pill ${n.online?'on':'off'}"><i class="dot ${n.online?'on':'off'}"></i>${n.online?'آنلاین':'آفلاین'}</span></div>
    <div class="kv-rows">
      ${resBars(n)}
      <div><span>آدرس عمومی</span><b class="ltr copyable" title="کلیک برای کپی" onclick="copyText('${esc(n.host||'')}','آدرس کپی شد ✅')">${esc(n.host||'—')}</b></div>
      <div><span>IP گزارش‌شده</span><b class="ltr">${esc(n.reported_ip||'—')}</b></div>
      <div><span>ایجنت / سیستم</span><b>${esc(n.agent_version||'—')} · ${esc(n.os_info||'')}</b></div>
      <div><span>آخرین ارتباط</span><b>${n.online?'همین الان':relTime(n.last_seen)}</b></div>
    </div>
    <div class="card-actions">
      <button class="btn sm primary" onclick="openNodeModal(${n.id})">📥 دستور نصب</button>
      <span class="grow"></span>
      <button class="icon-btn" title="ویرایش" onclick="openNodeModal(${n.id})">✏️</button>
      <button class="icon-btn danger" title="حذف" onclick="delNode(${n.id})">🗑️</button>
    </div></div>`).join('') ||
  `<div class="empty-state"><div class="big">🖥️</div><b>${q?'سروری با این اسم پیدا نشد':'هنوز سروری اضافه نکردی'}</b>با دکمه «افزودن سرور» اولین سرورت را وصل کن؛ فقط یک دستور لازم دارد.</div>`;
}
function openNodeModal(id){
  $('#nodeForm').reset(); $('#installBox').classList.add('hidden'); $('#nodeId').value='';
  $('#nodeModalTitle').textContent = 'افزودن سرور';
  if(id){
    const n = nodesCache.find(x=>x.id===id); if(!n) return;
    $('#nodeModalTitle').textContent = n.name;
    $('#nodeId').value=n.id; $('#nodeName').value=n.name; $('#nodeHost').value=n.host||''; $('#nodeDesc').value=n.description||'';
    showInstall(n.token, n.relay_port);
  }
  $('#nodeModal').classList.remove('hidden');
}
function showInstall(tok, relay){
  installTokenVal = tok; installRelayVal = relay || 10000;
  $('#panelAddr').value = location.origin;
  refreshInstall();
  $('#installBox').classList.remove('hidden');
}
function copyInstall(){ copyText($('#installCmd').textContent, 'دستور نصب کپی شد ✅ حالا روی سرور اجراش کن'); }
$('#nodeForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const id = $('#nodeId').value;
  const body = {name:$('#nodeName').value, host:$('#nodeHost').value, description:$('#nodeDesc').value};
  try{
    if(id){ await api('PUT','/api/nodes/'+id, body); toast('سرور به‌روزرسانی شد ✅'); closeModal('nodeModal'); }
    else{
      const n = await api('POST','/api/nodes', body);
      $('#nodeId').value = n.id; $('#nodeModalTitle').textContent='🎉 سرور ساخته شد';
      showInstall(n.token, n.relay_port); toast('سرور ساخته شد — دستور نصب را روی سرور اجرا کن');
    }
    loadNodes();
  }catch(err){ toast(err.message, true); }
});
async function delNode(id){ if(!confirm('این سرور حذف شود؟')) return; try{ await api('DELETE','/api/nodes/'+id); toast('سرور حذف شد'); loadNodes(); loadTunnels(); }catch(e){ toast(e.message,true); } }

/* ---------- تونل‌ها ---------- */
let tunnelFilter = 'all';
function setTunnelFilter(f){
  tunnelFilter = f;
  document.querySelectorAll('#tunnelChips .chip').forEach(c=>c.classList.toggle('active', c.dataset.f===f));
  renderTunnels();
}
function tunnelState(t){
  if(!t.enabled) return 'off';
  if(t.expired || t.over_limit) return 'problem';
  return 'active';
}
async function loadTunnels(render=true){ tunnelsCache = await api('GET','/api/tunnels'); if(render) renderTunnels(); }
function nodeName(id){ const n=nodesCache.find(x=>x.id===id); return n? esc(n.name):'#'+id; }
function renderTunnels(){
  const q = ($('#tunnelSearch').value||'').trim().toLowerCase();
  const list = tunnelsCache.filter(t=> (!q || (t.name+' '+t.source_node_name+' '+(t.dest_node_name||'')).toLowerCase().includes(q)) && (tunnelFilter==='all' || tunnelState(t)===tunnelFilter));
  $('#tunnelCount').textContent = tunnelsCache.length ? tunnelsCache.filter(t=>t.active).length+' فعال از '+tunnelsCache.length+' تونل' : '';
  $('#tunnelsGrid').innerHTML = list.map((t,i)=>{
    const pct = t.traffic_limit_bytes ? Math.min(100, Math.round((t.bytes_in+t.bytes_out)/t.traffic_limit_bytes*100)) : null;
    const status = !t.enabled ? ['off','غیرفعال'] : t.expired ? ['warn','منقضی شده'] : t.over_limit ? ['warn','ترافیک تمام شد'] : ['on','در حال کار'];
    return `<div class="tunnel-card" style="animation-delay:${Math.min(i*0.05,0.3)}s">
    <div class="tc-head"><span class="type-badge ${t.type}">${t.type==='reverse'?'🔁 REVERSE':'➡️ FORWARD'}</span>
      <div><h4>${esc(t.name)}</h4><small>${t.protocol.toUpperCase()}${t.dest_node_id?' · لینک '+({tcp:'TCP',tcpmux:'TCPMux',ws:'WebSocket',wss:'WSS',auto:'Auto'}[t.transport||'tcp']):''} · ${ {balanced:'متعادل',gaming:'گیمینگ',ultraspeed:'سرعت بالا'}[t.profile||'balanced'] } · ساخته‌شده ${fmtDate(t.created_at)}</small></div>
      <span class="status-pill ${status[0]}">${status[1]}</span></div>
    <div class="route"><span class="node-chip">${nodeName(t.source_node_id)}</span><span class="port">:${t.listen_port}</span>${(t.ports&&t.ports.length>1)?`<span class="port-chip">+${(t.ports.length-1).toLocaleString('fa-IR')} پورت</span>`:''}<span class="arrow">──▶</span>${t.dest_node_id?`<span class="node-chip">${nodeName(t.dest_node_id)}</span><span class="arrow">──▶</span>`:''}<span class="target">${esc(t.target_host)}:${t.target_port}</span></div>
    <div class="linkline">${linkBadge(t)}</div>
    <div class="traf">
      <div><span>ورودی ↓</span><b>${fmtBytes(t.bytes_in)}</b></div>
      <div><span>خروجی ↑</span><b>${fmtBytes(t.bytes_out)}</b></div>
      <div><span>کانکشن</span><b>${(t.connections||0).toLocaleString('fa-IR')}</b></div>
    </div>
    ${pct!==null?`<div class="limitbar"><i style="width:${pct}%"></i></div><div class="muted small">مصرف سقف ترافیک: ${pct}٪ از ${fmtBytes(t.traffic_limit_bytes)}${t.expires_at?' · انقضا: '+fmtDate(t.expires_at):''}</div>`: (t.expires_at?`<div class="muted small">انقضا: ${fmtDate(t.expires_at)}</div>`:'')}
    <div class="card-actions">
      <span class="switch-wrap"><label class="switch"><input type="checkbox" ${t.enabled?'checked':''} onchange="toggleTunnel(${t.id})"><i></i></label>${t.enabled?'روشن':'خاموش'}</span>
      <span class="grow"></span>
      <button class="icon-btn" title="محک لینک" onclick="openProbe(${t.id})">📡</button>
      <button class="icon-btn" title="ویرایش" onclick="openTunnelModal(${t.id})">✏️</button>
      <button class="icon-btn" title="صفر کردن آمار" onclick="resetTraffic(${t.id})">♻️</button>
      <button class="icon-btn danger" title="حذف" onclick="delTunnel(${t.id})">🗑️</button>
    </div></div>`;
  }).join('') ||
  `<div class="empty-state"><div class="big">🔀</div><b>${q?'تونلی با این اسم پیدا نشد':'هنوز تونلی نساختی'}</b>با دکمه «ساخت تونل» دو سرورت را به هم وصل کن — کمتر از یک دقیقه طول می‌کشد.</div>`;
}
const TRANS_FA = {tcp:'TCP', tcpmux:'TCPMux', ws:'WebSocket', wss:'WSS', quic:'QUIC', kcp:'KCP', auto:'Auto', direct:'مستقیم'};
function linkBadge(t){
  const L = t.link || {};
  const act = (L.active_transports||[]).map(x=>TRANS_FA[x]||x).join(' + ');
  const rtt = L.rtt_ms ? ' · ' + Number(L.rtt_ms).toLocaleString('fa-IR') + 'ms' : '';
  switch(L.status){
    case 'connected': return `<span class="lbadge on">🟢 لینک برقرار${act?' · '+act:''}${rtt}</span>`;
    case 'ready': return `<span class="lbadge mid">🔵 آماده${t.dest_node_id?' · با اولین اتصال برقرار می‌شود':' · مستقیم'}</span>`;
    case 'entry_offline': return `<span class="lbadge off">🔴 ایجنت ورودی آفلاین</span>`;
    case 'exit_offline': return `<span class="lbadge off">🔴 ایجنت خروجی آفلاین</span>`;
    default: return `<span class="lbadge warn">🟡 در انتظار اتصال خروجی…</span>`;
  }
}
let linkTestBusy = false;
async function runLinkTest(){
  if(linkTestBusy) return;
  const srcId = wiz.srcId, dstId = wiz.dstId;
  const box = $('#linkTestResult');
  const btn = $('#linkTestBtn');
  try{
    if(!box || !btn) throw new Error('المان‌های تست در صفحه پیدا نشد؛ صفحه را رفرش کن.');
    if(!srcId || !dstId){ box.innerHTML = '<p class="hint">اول سرور ورودی و خروجی را انتخاب کن.</p>'; return; }
    if(srcId === dstId){ box.innerHTML = '<p class="hint">سرور ورودی و خروجی نمی‌توانند یکی باشند.</p>'; return; }
    const srcN = nodesCache.find(n=>n.id===srcId), dstN = nodesCache.find(n=>n.id===dstId);
    if((srcN && !srcN.online) || (dstN && !dstN.online)){ box.innerHTML = '<p class="hint">⚠️ یکی از دو سرور الان آفلاین است؛ ایجنتش را بررسی کن بعد تست بگیر.</p>'; return; }
    linkTestBusy = true; btn.disabled = true;
    box.innerHTML = '<p class="muted">⏳ در حال تست... ایجنت خروجی با هر ۶ روش به سرور ورودی وصل می‌شود (حدود ۳۰ ثانیه).</p>';
    let probeId = null;
    try{
      const r = await api('POST','/api/linktest', { source_node_id: srcId, dest_node_id: dstId });
      probeId = r.probe_id;
    }catch(e){
      box.innerHTML = '<p class="hint">❌ تست شروع نشد: '+esc(e.message)+'</p>';
      linkTestBusy = false; btn.disabled = false; return;
    }
    const render = (st)=>{
      const rows = (st.results||[]).map(r=>`<tr${st.suggested===r.transport?' class="suggested"':''}>
        <td>${TRANS_FA[r.transport]||r.transport}${st.suggested===r.transport?' ⭐':''}</td>
        <td>${r.ok?'🟢 وصل شد':'🔴 نشد'}</td>
        <td>${r.ok? Number(r.rtt_ms||0).toLocaleString('fa-IR')+'ms' : '<span class="muted">'+esc(r.error||'—')+'</span>'}</td></tr>`).join('');
      box.innerHTML = `<table class="probe-table"><thead><tr><th>ترنسپورت</th><th>نتیجه</th><th>تأخیر / علت</th></tr></thead><tbody>${rows||'<tr><td colspan="3" class="muted">هنوز پاسخی نرسیده...</td></tr>'}</tbody></table>
        ${st.done ? (st.suggested
          ? `<p class="hint">💡 پیشنهاد: <b>${TRANS_FA[st.suggested]||st.suggested}</b> — بهترین مسیر بین این دو سرور همین است.
             <button type="button" class="btn ghost" onclick="applyTransport('${st.suggested}')">استفاده از ${TRANS_FA[st.suggested]||st.suggested}</button></p>`
          : '<p class="hint">⚠️ هیچ روشی وصل نشد. علت را از ستون «علت» بخوان: اگر همه «مهلت تمام شد» یا «پاسخ نداد» است، پورت رله سرور ورودی از سرور خروجی بسته است (TCP پیش‌فرض ۱۰۰۰۰ و UDP ۱۰۱۰۰/۱۰۲۰۰).</p>')
        : '<p class="muted">⏳ هنوز در حال تست بقیه روش‌ها...</p>'}`;
    };
    const started = Date.now();
    let last = {done:false, results:[]};
    while(Date.now() - started < 100000){
      await new Promise(r=>setTimeout(r, 1800));
      let st;
      try{ st = await api('GET','/api/linktest/' + probeId); }
      catch(e){ box.innerHTML = '<p class="hint">❌ خطا در دریافت نتیجه: '+esc(e.message)+'</p>'; break; }
      last = st;
      render(st);
      if(st.done) break;
    }
    if(!last.done) render({done:true, results:last.results||[], suggested:''});
  }catch(e){
    if(box) box.innerHTML = '<p class="hint">❌ خطای غیرمنتظره: '+esc(e && e.message ? e.message : String(e))+'</p>';
    console.error('runLinkTest', e);
  }
  linkTestBusy = false;
  const b2 = $('#linkTestBtn'); if(b2) b2.disabled = false;
}
function applyTransport(tr){
  wizSetTrans(tr);
  toast('ترنسپورت روی ' + (TRANS_FA[tr]||tr) + ' تنظیم شد ✅');
}
let probeTunnelId = null;
async function openProbe(id){
  probeTunnelId = id;
  const t = tunnelsCache.find(x=>x.id===id);
  $('#probeTitle').textContent = 'محک لینک: ' + (t? t.name : '');
  $('#probeBody').innerHTML = '<p class="muted">در حال بررسی لینک بین دو سرور...</p>';
  $('#probeModal').classList.remove('hidden');
  $('#probeRetry').onclick = ()=> openProbe(probeTunnelId);
  try{
    const r = await api('POST','/api/tunnels/'+id+'/probe', {});
    const L = r.link || {};
    const rows = [];
    const sideRows = (rep, label)=>{
      if(!rep) return `<tr><td>${label}</td><td colspan="3" class="muted">گزارشی نرسیده</td></tr>`;
      const trs = (rep.transports||[]);
      if(!trs.length) return `<tr><td>${label}</td><td colspan="3" class="muted">ترنسپورتی گزارش نشده</td></tr>`;
      return trs.map(tr=>`<tr><td>${label}</td><td>${TRANS_FA[tr.name]||tr.name}</td>
        <td>${tr.up? '🟢 وصل' : (tr.listening? '🔵 گوش‌به‌زنگ' : (tr.ondemand? '⚪ عنداللزوم' : '🔴 قطع'))}</td>
        <td>${tr.up? (tr.rtt_ms? Number(tr.rtt_ms).toLocaleString('fa-IR')+'ms' : (tr.pooled? tr.pooled.toLocaleString('fa-IR')+' کانکشن آماده' : (tr.streams? tr.streams.toLocaleString('fa-IR')+' استریم' : '🟢'))) : (tr.last_err? '<span class="muted">'+esc(tr.last_err)+'</span>' : '—')}</td></tr>`).join('');
    };
    rows.push(sideRows(L.entry, 'ورودی · ' + (t? esc(t.source_node_name||'') : '')));
    if(t && t.dest_node_id) rows.push(sideRows(L.exit, 'خروجی · ' + esc(t.dest_node_name||'')));
    $('#probeBody').innerHTML = `
      <div class="linkline" style="margin-bottom:10px">${linkBadge({...t, link:L})}</div>
      <table class="probe-table"><thead><tr><th>سمت</th><th>ترنسپورت</th><th>وضعیت</th><th>تأخیر/جزئیات</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>
      <div class="kv-rows" style="margin-top:10px">
        <div><span>ترنسپورت تنظیم‌شده</span><b>${TRANS_FA[r.transport]||r.transport} · ${r.type==='reverse'?'Reverse':'Direct'}</b></div>
        <div><span>نسخه ایجنت ورودی / خروجی</span><b class="ltr">${esc(L.entry_version||'—')}${t&&t.dest_node_id?' / '+esc(L.exit_version||'—'):''}</b></div>
        ${L.entry_report_at?`<div><span>آخرین گزارش ورودی</span><b>${relTime(L.entry_report_at)}</b></div>`:''}
        ${L.exit_report_at?`<div><span>آخرین گزارش خروجی</span><b>${relTime(L.exit_report_at)}</b></div>`:''}
      </div>
      ${(r.hints||[]).map(h=>`<p class="hint">💡 ${esc(h)}</p>`).join('')}`;
  }catch(e){ $('#probeBody').innerHTML = '<p class="hint">خطا: '+esc(e.message)+'</p>'; }
}
let customHost = false;
function toggleCustomHost(ev){
  if(ev) ev.preventDefault();
  customHost = !customHost;
  wizSyncAddr();
  if(customHost) $('#tTargetHost').focus();
}
/* ================= ویزارد ساخت تونل (مدل کاریز) ================= */
const wiz = { step: 1, editingId: null, direction: 'reverse', transport: 'auto', profile: 'balanced',
  srcId: null, dstId: null, nameEdited: false };
const DIR_FA = { reverse: 'معکوس (Reverse)', forward: 'مستقیم (Direct)' };
const PROF_FA = { balanced: 'متعادل', gaming: 'گیمینگ', ultraspeed: 'حداکثر سرعت' };

function wizNodeCard(n, selected, role){
  const old = n.agent_version && typeof compareVer === 'function' ? '' : '';
  return `<button type="button" class="srv-card ${selected?'sel':''}" onclick="wizPickServer('${role}', ${n.id})">
    <span class="dot ${n.online?'on':'off'}"></span>
    <span class="srv-main"><b>${esc(n.name)}</b><small class="ltr">${esc(n.host||n.reported_ip||'بدون آدرس')}</small></span>
    <span class="srv-meta">${n.online?'آنلاین':'آفلاین'}${n.agent_version?' · v'+esc(n.agent_version):''}</span>
  </button>`;
}
function renderWizServers(){
  $('#wEntryList').innerHTML = nodesCache.map(n=>wizNodeCard(n, wiz.srcId===n.id, 'src')).join('') || '<p class="muted">هنوز سروری نیست</p>';
  $('#wExitList').innerHTML = nodesCache.map(n=>wizNodeCard(n, wiz.dstId===n.id, 'dst')).join('') || '<p class="muted">هنوز سروری نیست</p>';
}
function wizPickServer(role, id){
  if(role==='src') wiz.srcId = id; else wiz.dstId = id;
  renderWizServers(); wizSyncName(); wizSyncAddr();
}
function wizSyncName(){
  if(wiz.nameEdited) return;
  const a = nodesCache.find(n=>n.id===wiz.srcId), b = nodesCache.find(n=>n.id===wiz.dstId);
  if(a && b) $('#wName').value = a.name + ' → ' + b.name;
}
function wizSetDir(d){
  wiz.direction = d;
  document.querySelectorAll('#wDirSeg .seg-btn').forEach(b=>b.classList.toggle('active', b.dataset.dir===d));
  wizSyncProto(); wizSyncAddr();
}
function wizSetTrans(tr){
  wiz.transport = tr;
  document.querySelectorAll('#wTransGrid .trans-card').forEach(b=>b.classList.toggle('active', b.dataset.tr===tr));
  wizSyncAddr();
}
function wizSetProfile(pr){
  wiz.profile = pr;
  document.querySelectorAll('#wProfileSeg .seg-btn').forEach(b=>b.classList.toggle('active', b.dataset.prof===pr));
}
function wizSyncProto(){
  const rev = wiz.direction==='reverse';
  $('#wProtocol').disabled = rev;
  if(rev) $('#wProtocol').value = 'tcp';
}
function nodeAddr(n){ return n ? (n.host || n.reported_ip || '') : ''; }
function wizSyncAddr(){
  const a = nodesCache.find(n=>n.id===wiz.srcId), b = nodesCache.find(n=>n.id===wiz.dstId);
  const firstPort = (parsePortsSpec($('#wPorts').value).ports[0]||{}).listen;
  $('#wAddrPreview').textContent = a ? (nodeAddr(a)||a.name) + ':' + (firstPort||'····') : '—';
  $('#wAddrEntry').textContent = a ? a.name : '—';
  $('#wAddrHost').textContent = a ? (nodeAddr(a)||'—') : '—';
  $('#wAddrMode').textContent = (DIR_FA[wiz.direction]||'') + ' · ' + (TRANS_FA[wiz.transport]||wiz.transport) + ' · ' + (PROF_FA[wiz.profile]||'');
  const hasExit = !!wiz.dstId;
  $('#targetHostWrap').style.display = (hasExit && !customHost) ? 'none' : '';
  $('#customHostRow').classList.toggle('hidden', !hasExit);
  $('#targetHostLabel').textContent = hasExit ? 'هاست سرویس روی خروجی' : 'هاست مقصد';
  if(b){ /* مقصد برای نمایش مسیر */ }
}

/* پارس سینتکس پورت کاریز: 443, 8080-8090, 2053=53 */
function parsePortsSpec(spec){
  spec = (spec||'').trim();
  if(!spec) return { ports: [], error: '' };
  const out = []; const seen = new Set();
  for(const partRaw of spec.split(',')){
    const part = partRaw.trim(); if(!part) continue;
    let listenExpr = part, targetExpr = null;
    if(part.includes('=')){ const sp = part.split('='); listenExpr = sp[0].trim(); targetExpr = sp[1].trim(); }
    const parseExpr = (x)=>{
      if(x.includes('-')){ const [a,b] = x.split('-').map(v=>parseInt(v.trim(),10)); return [a,b]; }
      const v = parseInt(x,10); return [v,v];
    };
    const [l1,l2] = parseExpr(listenExpr);
    const [t1] = targetExpr!==null ? parseExpr(targetExpr) : [l1];
    if(!(l1>=1 && l2<=65535 && l2>=l1)) return { ports: [], error: 'بازه پورت نامعتبر: ' + part };
    if(l2-l1 > 100) return { ports: [], error: 'هر بازه حداکثر ۱۰۰ پورت' };
    for(let lp=l1; lp<=l2; lp++){
      const tp = t1 + (lp - l1);
      if(!(tp>=1 && tp<=65535)) return { ports: [], error: 'پورت مقصد نامعتبر: ' + part };
      if(seen.has(lp)) return { ports: [], error: 'پورت تکراری: ' + lp };
      seen.add(lp); out.push({ listen: lp, target: tp });
    }
  }
  if(out.length > 200) return { ports: [], error: 'حداکثر ۲۰۰ پورت در یک تونل' };
  return { ports: out, error: '' };
}
function renderPortsPreview(){
  const { ports, error } = parsePortsSpec($('#wPorts').value);
  const box = $('#wPortsPreview');
  if(error){ box.innerHTML = '<p class="hint">⚠️ ' + esc(error) + '</p>'; return ports; }
  if(!ports.length){ box.innerHTML = '<p class="muted small">خالی بگذاری، یک پورت آزاد خودکار انتخاب می‌شود.</p>'; wizSyncAddr(); return ports; }
  box.innerHTML = ports.slice(0, 24).map(pm=>`<span class="port-chip ltr">:${pm.listen} ← :${pm.target}</span>`).join('')
    + (ports.length>24 ? `<span class="port-chip">+${(ports.length-24).toLocaleString('fa-IR')} پورت دیگر</span>` : '');
  wizSyncAddr();
  return ports;
}
function suggestPort(){
  const used = new Set();
  tunnelsCache.forEach(t=>{ if(t.source_node_id===wiz.srcId) (t.ports||[{listen:t.listen_port}]).forEach(pm=>used.add(pm.listen)); });
  parsePortsSpec($('#wPorts').value).ports.forEach(pm=>used.add(pm.listen));
  let p = 3080; while(used.has(p)) p++;
  return p;
}
function wizError(msg){
  const e = $('#wizError');
  e.textContent = msg || ''; e.classList.toggle('hidden', !msg);
}
function wizShowStep(){
  document.querySelectorAll('#wizSteps .wstep').forEach(el=>{
    const st = +el.dataset.step;
    el.classList.toggle('active', st===wiz.step);
    el.classList.toggle('done', st<wiz.step);
  });
  document.querySelectorAll('.wiz-pane').forEach(pn=>pn.classList.toggle('hidden', +pn.dataset.pane!==wiz.step));
  $('#wizBack').classList.toggle('hidden', wiz.step===1);
  $('#wizNext').classList.toggle('hidden', wiz.step===5);
  $('#wizBuild').classList.toggle('hidden', wiz.step!==5);
  $('#wizBuild').textContent = wiz.editingId ? '💾 ذخیره تغییرات' : '🚀 ساخت تونل';
  if(wiz.step===3) wizSyncAddr();
  if(wiz.step===5) renderWizReview();
}
function wizValidateStep(){
  if(wiz.step===1){
    if(!wiz.srcId) return 'سرور ورودی (Entry) را انتخاب کن';
    if(!wiz.dstId) return 'سرور خروجی (Exit) را انتخاب کن';
    if(wiz.srcId===wiz.dstId) return 'سرور ورودی و خروجی نمی‌توانند یکی باشند';
  }
  if(wiz.step===4){
    const { error } = parsePortsSpec($('#wPorts').value);
    if(error) return error;
  }
  return '';
}
function wizNav(dir){
  wizError('');
  if(dir>0){
    const err = wizValidateStep();
    if(err){ wizError(err); return; }
    if(wiz.step===3 && !$('#wPorts').value.trim()) $('#wPorts').value = String(suggestPort());
    if(wiz.step===4) renderPortsPreview();
    wiz.step = Math.min(5, wiz.step+1);
  } else wiz.step = Math.max(1, wiz.step-1);
  wizShowStep();
}
function renderWizReview(){
  const a = nodesCache.find(n=>n.id===wiz.srcId), b = nodesCache.find(n=>n.id===wiz.dstId);
  const { ports } = parsePortsSpec($('#wPorts').value);
  const host = (wiz.dstId && !customHost) ? '127.0.0.1' : ($('#tTargetHost').value||'127.0.0.1');
  $('#wReview').innerHTML = `
    <div><span>نام</span><b>${esc($('#wName').value||'—')}</b></div>
    <div><span>ورودی (Entry)</span><b>${a?esc(a.name):'—'}</b></div>
    <div><span>خروجی (Exit)</span><b>${b?esc(b.name):'—'}</b></div>
    <div><span>جهت</span><b>${DIR_FA[wiz.direction]}</b></div>
    <div><span>ترنسپورت / پروفایل</span><b>${TRANS_FA[wiz.transport]||wiz.transport} · ${PROF_FA[wiz.profile]}</b></div>
    <div><span>پروتکل / سرویس</span><b>${$('#wProtocol').value.toUpperCase()} · <span class="ltr">${esc(host)}</span></b></div>
    <div><span>پورت‌ها</span><b class="ltr">${ports.map(pm=>pm.listen+'→'+pm.target).join(', ')||'—'}</b></div>`;
}
function openTunnelModal(id){
  wiz.step = 1; wiz.editingId = id||null; wiz.nameEdited = false;
  wiz.direction = 'reverse'; wiz.transport = 'auto'; wiz.profile = 'balanced';
  wiz.srcId = null; wiz.dstId = null; customHost = false;
  $('#wName').value=''; $('#wPorts').value=''; $('#tTargetHost').value='127.0.0.1';
  $('#tLimit').value=''; $('#tExpire').value=''; $('#linkTestResult').innerHTML='';
  $('#tunnelModalTitle').textContent = 'ساخت تونل';
  if(!nodesCache.length){ toast('اول حداقل یک سرور اضافه کن', true); return; }
  if(nodesCache[0]) wiz.srcId = nodesCache[0].id;
  if(nodesCache[1]) wiz.dstId = nodesCache[1].id;
  if(id){
    const t = tunnelsCache.find(x=>x.id===id); if(!t) return;
    wiz.editingId = t.id;
    $('#tunnelModalTitle').textContent = 'ویرایش: ' + t.name;
    $('#wName').value = t.name; wiz.nameEdited = true;
    wiz.direction = t.type; wiz.transport = t.transport||'auto'; wiz.profile = t.profile||'balanced';
    wiz.srcId = t.source_node_id; wiz.dstId = t.dest_node_id||null;
    const ports = (t.ports && t.ports.length ? t.ports : [{listen:t.listen_port, target:t.target_port}]);
    $('#wPorts').value = ports.map(pm=> pm.listen===pm.target ? String(pm.listen) : pm.listen+'='+pm.target).join(', ');
    $('#wProtocol').value = t.protocol||'tcp';
    $('#tTargetHost').value = t.target_host||'127.0.0.1';
    customHost = !['127.0.0.1','localhost',''].includes(t.target_host||'127.0.0.1');
    $('#tLimit').value = t.traffic_limit_bytes ? (t.traffic_limit_bytes/1073741824) : '';
    if(t.expires_at) $('#tExpire').value = t.expires_at.slice(0,16);
  }
  document.querySelectorAll('#wDirSeg .seg-btn').forEach(b=> b.disabled = !!id);
  wizSetDir(wiz.direction); wizSetTrans(wiz.transport); wizSetProfile(wiz.profile);
  renderWizServers(); wizSyncName(); wizSyncProto(); renderPortsPreview(); wizError('');
  wizShowStep();
  $('#tunnelModal').classList.remove('hidden');
}
async function wizSubmit(){
  wizError('');
  let { ports, error } = parsePortsSpec($('#wPorts').value);
  if(error){ wizError(error); wiz.step = 4; wizShowStep(); return; }
  if(!ports.length) ports = [{ listen: suggestPort(), target: suggestPort() }];
  if(ports.length===1 && !$('#wPorts').value.trim()){
    // پورت خودکار: همان پورت روی خروجی هم باز می‌شود
    const sp = ports[0].listen; ports = [{ listen: sp, target: sp }];
  }
  const exp = $('#tExpire').value;
  const name = $('#wName').value.trim();
  if(!name){ wizError('نام تونل را وارد کن'); wiz.step = 1; wizShowStep(); return; }
  const payload = {
    name, type: wiz.direction, protocol: $('#wProtocol').value,
    transport: wiz.transport, profile: wiz.profile,
    source_node_id: wiz.srcId, dest_node_id: wiz.dstId,
    ports,
    target_host: (wiz.dstId && !customHost) ? '127.0.0.1' : ($('#tTargetHost').value||'127.0.0.1'),
    traffic_limit_gb: $('#tLimit').value ? parseFloat($('#tLimit').value) : null,
    expires_at: exp ? new Date(exp).toISOString() : null,
  };
  try{
    if(wiz.editingId) await api('PUT','/api/tunnels/'+wiz.editingId, payload);
    else await api('POST','/api/tunnels', payload);
    toast(wiz.editingId ? 'تغییرات ذخیره شد 💾' : 'تونل ساخته شد 🚀');
    closeModal('tunnelModal'); loadTunnels();
  }catch(err){ wizError(err.message); }
}
async function toggleTunnel(id){ try{ await api('POST',`/api/tunnels/${id}/toggle`); loadTunnels(); }catch(e){ toast(e.message,true); } }
async function resetTraffic(id){ if(!confirm('آمار ترافیک این تونل صفر شود؟')) return; try{ await api('POST',`/api/tunnels/${id}/reset-traffic`); loadTunnels(); toast('آمار صفر شد'); }catch(e){ toast(e.message,true); } }
async function delTunnel(id){ if(!confirm('این تونل حذف شود؟')) return; try{ await api('DELETE','/api/tunnels/'+id); toast('تونل حذف شد'); loadTunnels(); }catch(e){ toast(e.message,true); } }

/* ---------- کاربران ---------- */
async function loadUsers(){
  const us = await api('GET','/api/users');
  $('#usersBody').innerHTML = us.map(u=>`<tr>
    <td><div class="user-cell"><div class="avatar">${esc((u.username||'ک').slice(0,1))}</div><b>${esc(u.username)}</b></div></td>
    <td>${u.role==='admin'?'👑 ادمین':'کاربر عادی'}</td>
    <td><span class="badge ${u.is_active?'on':'off'}">${u.is_active?'فعال':'غیرفعال'}</span></td>
    <td><button class="btn sm" onclick="toggleUser(${u.id},${!u.is_active})">${u.is_active?'غیرفعال':'فعال'}</button>
    <button class="btn sm" onclick="changePass(${u.id})">🔑 رمز</button>
    <button class="btn sm danger" onclick="delUser(${u.id})">حذف</button></td></tr>`).join('');
}
function openUserModal(){ $('#userForm').reset(); $('#userModal').classList.remove('hidden'); }
$('#userForm').addEventListener('submit', async e=>{
  e.preventDefault();
  try{ await api('POST','/api/users',{username:$('#uName').value,password:$('#uPass').value,role:$('#uRole').value}); toast('کاربر ساخته شد ✅'); closeModal('userModal'); loadUsers(); }
  catch(err){ toast(err.message,true); }
});
async function toggleUser(id, active){ try{ await api('PUT','/api/users/'+id,{is_active:active}); loadUsers(); }catch(e){ toast(e.message,true); } }
async function changePass(id){ const p = prompt('رمز جدید را وارد کن:'); if(!p) return; try{ await api('PUT','/api/users/'+id,{pwd:p}); toast('رمز عوض شد 🔑'); }catch(e){ toast(e.message,true); } }
async function delUser(id){ if(!confirm('این کاربر حذف شود؟')) return; try{ await api('DELETE','/api/users/'+id); loadUsers(); }catch(e){ toast(e.message,true); } }

/* ---------- مودال ---------- */
function closeModal(id){ $('#'+id).classList.add('hidden'); }
document.querySelectorAll('.modal').forEach(m=> m.addEventListener('click', e=>{ if(e.target===m) m.classList.add('hidden'); }));
document.addEventListener('keydown', e=>{ if(e.key==='Escape') document.querySelectorAll('.modal').forEach(m=>m.classList.add('hidden')); });


/* ---------- نقشه شبکه (به سبک کاریز) ---------- */
function renderMap(){
  const box = $('#networkMap'); if(!box) return;
  const nodes = nodesCache, tunnels = tunnelsCache;
  if(!nodes.length){ box.innerHTML = '<div class="map-empty">هنوز سروری نیست — اولین سرور را اضافه کن تا نقشه شبکه جانت بگیرد 🗺️</div>'; return; }
  const W = Math.max(640, nodes.length*190), H = 300, baseY = 96, wellBottom = 218;
  const X = i => 80 + i*((W-160)/Math.max(1,nodes.length-1||1)) + (nodes.length===1 ? (W-160)/2 : 0);
  const pos = {}; nodes.forEach((n,i)=>pos[n.ID ?? n.id]=X(i));
  let arcs = '';
  tunnels.forEach((t,idx)=>{
    const sx = pos[t.source_node_id]; if(sx===undefined) return;
    const active = t.active, col = !t.enabled ? '#64748b' : (t.expired||t.over_limit) ? '#fb7185' : '#2dd4bf';
    const traf = fmtBytes((t.bytes_in||0)+(t.bytes_out||0));
    if(t.type==='reverse' && pos[t.dest_node_id]!==undefined){
      const dx = pos[t.dest_node_id], midY = wellBottom + 26 + (idx%3)*20;
      arcs += `<path d="M ${sx} ${wellBottom} C ${sx} ${midY}, ${dx} ${midY}, ${dx} ${wellBottom}" fill="none" stroke="${col}" stroke-width="${active?4:2.5}" stroke-linecap="round" class="${active?'arc-flow':''}" opacity="${active?0.95:0.55}" style="cursor:pointer" onclick="gotoTab('tunnels')"><title>${esc(t.name)}</title></path>`;
      const lx=(sx+dx)/2;
      arcs += `<text x="${lx}" y="${midY+16}" text-anchor="middle" class="tun-label" style="cursor:pointer" onclick="gotoTab('tunnels')">${esc(t.name)}</text><text x="${lx}" y="${midY+30}" text-anchor="middle" class="tun-speed">${traf}</text>`;
    } else {
      const upY = 34 + (idx%2)*14;
      arcs += `<path d="M ${sx} ${baseY-14} C ${sx} ${upY}, ${sx+70} ${upY}, ${sx+78} ${baseY-40}" fill="none" stroke="${col}" stroke-width="${active?3.5:2}" stroke-linecap="round" class="${active?'arc-flow':''}" opacity="${active?0.9:0.5}" style="cursor:pointer" onclick="gotoTab('tunnels')"><title>${esc(t.name)}</title></path>`;
      arcs += `<text x="${sx+84}" y="${baseY-42}" class="tun-label" style="cursor:pointer" onclick="gotoTab('tunnels')">${esc(t.name)}</text><text x="${sx+84}" y="${baseY-29}" class="tun-speed">:${t.listen_port} → ${esc(t.target_host)}:${t.target_port} · ${traf}</text>`;
    }
  });
  let wells = '';
  nodes.forEach((n,i)=>{
    const x = X(i), col = n.online ? '#34d399' : '#fb7185';
    wells += `<g class="map-well" onclick="gotoTab('nodes')">
      <text x="${x}" y="30" text-anchor="middle" class="well-name">${esc(n.name)} <tspan fill="${col}">●</tspan></text>
      <text x="${x}" y="47" text-anchor="middle" class="well-sub">${esc(n.agent_version||'—')} · ${esc(n.reported_ip||n.host||'')}</text>
      <path d="M ${x-26} ${baseY} A 26 10 0 0 1 ${x+26} ${baseY}" fill="#fbbf24" opacity="0.9"/>
      <line x1="${x}" y1="${baseY}" x2="${x}" y2="${wellBottom}" stroke="${n.online?'#fbbf24':'#64748b'}" stroke-width="3" opacity="0.75"/>
      <circle cx="${x}" cy="${wellBottom}" r="4.5" fill="${col}"/></g>`;
  });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">
    <line x1="14" y1="${baseY}" x2="${W-14}" y2="${baseY}" stroke="rgba(251,191,36,.55)" stroke-width="2.5"/>
    ${wells}${arcs}</svg>`;
}

function renderAttention(){
  const box = $('#attentionBox'); if(!box) return;
  const items = [];
  nodesCache.filter(n=>!n.online).forEach(n=>items.push({ic:'🖥️', txt:`سرور «${esc(n.name)}» آفلاین است`, sub:'آخرین ارتباط: '+relTime(n.last_seen), tab:'nodes'}));
  tunnelsCache.filter(t=>tunnelState(t)==='problem').forEach(t=>items.push({ic:'🔀', txt:`تونل «${esc(t.name)}» ${t.expired?'منقضی شده':'به سقف ترافیک رسیده'}`, sub:'', tab:'tunnels'}));
  tunnelsCache.filter(t=>tunnelState(t)==='off').forEach(t=>items.push({ic:'⏸️', txt:`تونل «${esc(t.name)}» خاموش است`, sub:'', tab:'tunnels'}));
  box.innerHTML = items.length ? items.slice(0,6).map(x=>
    `<div class="mini-row" style="cursor:pointer" onclick="gotoTab('${x.tab}')"><span>${x.ic}</span><div class="grow"><b style="font-size:13px">${x.txt}</b>${x.sub?`<small>${x.sub}</small>`:''}</div><span class="badge off">بررسی</span></div>`
  ).join('') : '<div class="empty-mini">همه‌چیز روبه‌راه است 🎉 هیچ سرور آفلاین یا تونل مشکلی نیست.</div>';
}

/* ---------- جستجوی سریع Ctrl+K ---------- */
function openPalette(){ $('#paletteModal').classList.remove('hidden'); $('#paletteInput').value=''; renderPalette(); setTimeout(()=>$('#paletteInput').focus(),30); }
function renderPalette(){
  const q = ($('#paletteInput').value||'').trim().toLowerCase();
  const pages = [['dashboard','📊 داشبورد'],['nodes','🖥️ سرورها'],['tunnels','🔀 تونل‌ها'],['users','👥 کاربران'],['help','❓ راهنما']];
  let out = pages.filter(x=>!q||x[1].includes(q)).map(x=>`<div class="mini-row" onclick="closeModal('paletteModal');gotoTab('${x[0]}')"><span>${x[1]}</span></div>`).join('');
  out += nodesCache.filter(n=>!q||n.name.toLowerCase().includes(q)).map(n=>`<div class="mini-row" onclick="closeModal('paletteModal');gotoTab('nodes')"><i class="dot ${n.online?'on':'off'}"></i><div class="grow"><b>${esc(n.name)}</b><small>سرور</small></div></div>`).join('');
  out += tunnelsCache.filter(t=>!q||t.name.toLowerCase().includes(q)).map(t=>`<div class="mini-row" onclick="closeModal('paletteModal');openTunnelModal(${t.id})"><span class="type-badge ${t.type}">${t.type}</span><div class="grow"><b>${esc(t.name)}</b><small>تونل</small></div></div>`).join('');
  $('#paletteResults').innerHTML = out || '<div class="empty-mini">چیزی پیدا نشد</div>';
}
document.addEventListener('keydown', e=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); if(token) openPalette(); }
});


/* ---------- آپدیت سیستم ---------- */
let latestVersion = '';
async function checkUpdate(manual){
  const st = $('#updStatus'), btn = $('#checkUpdBtn');
  try{
    if(btn){ btn.disabled = true; btn.textContent = 'در حال بررسی...'; }
    st.textContent = 'در حال بررسی نسخه تازه از گیت‌هاب...';
    const d = await api('GET','/api/system/check');
    $('#curVersion').textContent = 'v'+d.current;
    latestVersion = d.latest || '';
    if(d.error){ st.textContent = '⚠️ ' + d.error; if(manual) toast(d.error, true); }
    else if(d.update_available){ st.innerHTML = '🎉 نسخه تازه <b class="ltr">v'+esc(d.latest)+'</b> آماده است!'; $('#updNotes').textContent = d.notes||''; toast('نسخه تازه پیدا شد 🎉'); }
    else { st.textContent = '✅ پنل به‌روز است (آخرین نسخه: v'+d.current+')'; $('#updNotes').textContent = d.notes||''; }
  }catch(e){ st.textContent = '⚠️ بررسی آپدیت ناموفق بود'; if(manual) toast(e.message, true); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='🔎 بررسی آپدیت'; } }
}
async function doUpdate(forceSame){
  if(!forceSame && !latestVersion){ await checkUpdate(false); if(!latestVersion){ toast('اول بررسی آپدیت را بزن', true); return; } }
  if(!confirm(forceSame ? 'باینری همین نسخه دوباره دانلود و پنل ری‌استارت شود؟' : 'پنل به نسخه v'+latestVersion+' آپدیت و ری‌استارت شود؟ (تونل‌ها چند ثانیه قطع می‌شوند)')) return;
  const btn = $('#doUpdBtn');
  try{
    btn.disabled = true; btn.textContent = 'در حال دانلود و نصب...';
    $('#updHint').textContent = 'چند ثانیه صبر کن؛ صفحه به صورت خودکار بعد از آپدیت تازه می‌شود...';
    const d = await api('POST','/api/system/update');
    toast('نصب نسخه '+(d.new_version||'')+' انجام شد؛ در حال ری‌استارت...');
    const target = d.new_version || latestVersion;
    for(let i=0;i<40;i++){
      await new Promise(r=>setTimeout(r,2000));
      try{
        const h = await (await fetch('/health')).json();
        if(h.version && (!target || h.version===target)){ toast('آپدیت کامل شد 🎉 نسخه '+h.version); setTimeout(()=>location.reload(), 900); return; }
      }catch(_){}
    }
    toast('پنل دیر بالا آمد؛ صفحه را دستی رفرش کن', true);
  }catch(e){ toast(e.message, true); }
  finally{ btn.disabled=false; btn.textContent='⬇️ آپدیت پنل به نسخه تازه'; }
}
function loadAgentVersions(){
  const box = $('#agentVersions'); if(!box) return;
  box.innerHTML = nodesCache.map(n=>{
    const v = n.agent_version||'';
    const old = v && latestKnownPanel && compareVersionClient(v, latestKnownPanel) < 0;
    return `<div class="mini-row"><i class="dot ${n.online?'on':'off'}"></i><div class="grow"><b>${esc(n.name)}</b><small>نسخه ایجنت: <span class="ltr">${esc(v||'—')}</span></small></div><span class="badge ${!v?'off':old?'warn':'on'}" style="${old?'background:rgba(251,191,36,.14);color:var(--sand)':''}">${!v?'نامشخص':old?'آپدیت خودکار به زودی':'به‌روز'}</span></div>`;
  }).join('') || '<div class="empty-mini">هنوز سروری نیست</div>';
}
let latestKnownPanel = '';
fetch('/health').then(r=>r.json()).then(h=>{ latestKnownPanel = h.version||''; }).catch(()=>{});
function compareVersionClient(a,b){
  const pa=a.replace(/^v/,'').split('.').map(Number), pb=b.replace(/^v/,'').split('.').map(Number);
  for(let i=0;i<3;i++){ const d=(pa[i]||0)-(pb[i]||0); if(d) return d; } return 0;
}


/* ---------- منابع سرور (CPU/RAM/Disk) ---------- */
function resBar(label, pct, text){
  const p = Math.max(0, Math.min(100, pct||0));
  const col = p>=85 ? 'var(--red)' : p>=65 ? 'var(--sand)' : 'var(--teal)';
  return `<div class="res-row"><span>${label}</span><div class="res-track"><i style="width:${p}%;background:${col}"></i></div><b class="ltr">${text}</b></div>`;
}
function fmtUptime(sec){
  if(!sec) return '';
  const d = Math.floor(sec/86400), h = Math.floor(sec%86400/3600);
  return d? d+' روز و '+h+' ساعت' : h+' ساعت';
}
function resBars(n){
  const r = n.resources||{};
  if(!n.online || !r.mem_total) return '<div class="res-row"><span>منابع</span><b class="muted">در انتظار گزارش ایجنت...</b></div>';
  return resBar('CPU', r.cpu_percent, (r.cpu_percent||0).toFixed(0)+'% · '+(r.num_cpu||'?')+' هسته')
       + resBar('RAM', r.mem_percent, fmtBytes(r.mem_used)+' / '+fmtBytes(r.mem_total))
       + resBar('Disk', r.disk_percent, fmtBytes(r.disk_used)+' / '+fmtBytes(r.disk_total))
       + (r.uptime_seconds? `<div><span>آپتایم</span><b>${fmtUptime(r.uptime_seconds)}</b></div>`:'');
}

/* ---------- روش‌های اتصال سرور ---------- */
let installTokenVal = '', installRelayVal = 10000;
function b64url(str){
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function refreshInstall(){
  const panel = ($('#panelAddr').value||location.origin).replace(/\/$/,'');
  $('#installCmd').textContent = `bash <(curl -fsSL ${panel}/manager.sh) agent --panel ${panel} --token ${installTokenVal}`;
  $('#joinCodeBox').textContent = 'tp1_' + b64url(`${panel}|${installTokenVal}|${installRelayVal}`);
}
function copyJoin(){ copyText($('#joinCodeBox').textContent, 'کد اتصال کپی شد ✅ روی سرور با agent --code استفاده‌اش کن'); }
