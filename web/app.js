const $ = s => document.querySelector(s);
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
  const opts = nodesCache.map(n=>`<option value="${n.id}">${esc(n.name)}${n.online?' · آنلاین':''}</option>`).join('');
  $('#tSource').innerHTML = opts; $('#tDest').innerHTML = opts;
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
    showInstall(n.token);
  }
  $('#nodeModal').classList.remove('hidden');
}
function showInstall(tok){
  const url = location.origin;
  $('#installCmd').textContent = `bash <(curl -fsSL ${url}/manager.sh) agent --panel ${url} --token ${tok}`;
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
      showInstall(n.token); toast('سرور ساخته شد — دستور نصب را روی سرور اجرا کن');
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
      <div><h4>${esc(t.name)}</h4><small>${t.protocol.toUpperCase()} · ساخته‌شده ${fmtDate(t.created_at)}</small></div>
      <span class="status-pill ${status[0]}">${status[1]}</span></div>
    <div class="route"><span class="node-chip">${nodeName(t.source_node_id)}</span><span class="port">:${t.listen_port}</span><span class="arrow">──▶</span>${t.type==='reverse'?`<span class="node-chip">${nodeName(t.dest_node_id)}</span><span class="arrow">──▶</span>`:''}<span class="target">${esc(t.target_host)}:${t.target_port}</span></div>
    <div class="traf">
      <div><span>ورودی ↓</span><b>${fmtBytes(t.bytes_in)}</b></div>
      <div><span>خروجی ↑</span><b>${fmtBytes(t.bytes_out)}</b></div>
      <div><span>کانکشن</span><b>${(t.connections||0).toLocaleString('fa-IR')}</b></div>
    </div>
    ${pct!==null?`<div class="limitbar"><i style="width:${pct}%"></i></div><div class="muted small">مصرف سقف ترافیک: ${pct}٪ از ${fmtBytes(t.traffic_limit_bytes)}${t.expires_at?' · انقضا: '+fmtDate(t.expires_at):''}</div>`: (t.expires_at?`<div class="muted small">انقضا: ${fmtDate(t.expires_at)}</div>`:'')}
    <div class="card-actions">
      <span class="switch-wrap"><label class="switch"><input type="checkbox" ${t.enabled?'checked':''} onchange="toggleTunnel(${t.id})"><i></i></label>${t.enabled?'روشن':'خاموش'}</span>
      <span class="grow"></span>
      <button class="icon-btn" title="ویرایش" onclick="openTunnelModal(${t.id})">✏️</button>
      <button class="icon-btn" title="صفر کردن آمار" onclick="resetTraffic(${t.id})">♻️</button>
      <button class="icon-btn danger" title="حذف" onclick="delTunnel(${t.id})">🗑️</button>
    </div></div>`;
  }).join('') ||
  `<div class="empty-state"><div class="big">🔀</div><b>${q?'تونلی با این اسم پیدا نشد':'هنوز تونلی نساختی'}</b>با دکمه «ساخت تونل» دو سرورت را به هم وصل کن — کمتر از یک دقیقه طول می‌کشد.</div>`;
}
function setTunnelType(type){
  $('#tType').value = type;
  document.querySelectorAll('#typeSeg .seg-btn').forEach(b=>b.classList.toggle('active', b.dataset.type===type));
  onTypeChange(); syncRoute();
}
function onTypeChange(){
  const rev = $('#tType').value==='reverse';
  $('#destWrap').classList.toggle('hidden', !rev);
  $('#tProtocol').disabled = rev;
  if(rev) $('#tProtocol').value='tcp';
}
function syncRoute(){
  const srcSel = $('#tSource'), dstSel = $('#tDest');
  const srcName = srcSel.options[srcSel.selectedIndex]?.textContent.split(' ·')[0] || 'سرور مبدا';
  const dstName = dstSel.options[dstSel.selectedIndex]?.textContent.split(' ·')[0] || '';
  const host = $('#tTargetHost').value||'127.0.0.1', port = $('#tTargetPort').value||'؟';
  $('#rpFrom').textContent = srcName;
  $('#rpListen').textContent = $('#tListen').value||'؟';
  $('#rpTo').textContent = ($('#tType').value==='reverse' && dstName ? dstName+' ← ' : '') + host+':'+port;
}
function openTunnelModal(id){
  $('#tunnelForm').reset(); $('#tunnelId').value=''; $('#tTargetHost').value='127.0.0.1';
  $('#tunnelModalTitle').textContent='ساخت تونل';
  $('#tType').disabled=false; $('#tSource').disabled=false;
  setTunnelType('forward');
  if(!nodesCache.length){ toast('اول حداقل یک سرور اضافه کن', true); return; }
  if(id){
    const t = tunnelsCache.find(x=>x.id===id); if(!t) return;
    $('#tunnelModalTitle').textContent='ویرایش: '+t.name;
    $('#tunnelId').value=t.id; $('#tName').value=t.name;
    setTunnelType(t.type); $('#tType').disabled=true;
    $('#tProtocol').value=t.protocol; $('#tSource').value=t.source_node_id; $('#tSource').disabled=true;
    $('#tDest').value=t.dest_node_id||''; $('#tListen').value=t.listen_port;
    $('#tTargetHost').value=t.target_host; $('#tTargetPort').value=t.target_port;
    $('#tLimit').value = t.traffic_limit_bytes? (t.traffic_limit_bytes/1073741824):'';
    if(t.expires_at) $('#tExpire').value = t.expires_at.slice(0,16);
  }
  syncRoute();
  $('#tunnelModal').classList.remove('hidden');
}
['tSource','tDest'].forEach(id=> document.addEventListener('change', e=>{ if(e.target.id===id) syncRoute(); }));
$('#tunnelForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const id = $('#tunnelId').value;
  const exp = $('#tExpire').value;
  const common = {name:$('#tName').value, protocol:$('#tProtocol').value, listen_port:+$('#tListen').value,
    target_host:$('#tTargetHost').value||'127.0.0.1', target_port:+$('#tTargetPort').value,
    traffic_limit_gb: $('#tLimit').value? parseFloat($('#tLimit').value): null,
    expires_at: exp? new Date(exp).toISOString(): null};
  try{
    if(id){ await api('PUT','/api/tunnels/'+id, {...common, dest_node_id: $('#tType').value==='reverse'? +$('#tDest').value : null}); }
    else{ await api('POST','/api/tunnels', {...common, type:$('#tType').value, source_node_id:+$('#tSource').value, dest_node_id: $('#tType').value==='reverse'? +$('#tDest').value : null}); }
    toast('تونل آماده است 🚀'); closeModal('tunnelModal'); loadTunnels();
  }catch(err){ toast(err.message, true); }
});
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
