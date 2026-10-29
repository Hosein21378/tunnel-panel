const $ = s => document.querySelector(s);
let token = localStorage.getItem('tp_token') || '';
let myRole = '';
let nodesCache = [];

function fmtBytes(b){ if(!b) return '0 B'; const u=['B','KB','MB','GB','TB']; const i=Math.min(u.length-1,Math.floor(Math.log(b)/Math.log(1024))); return (b/Math.pow(1024,i)).toFixed(i?1:0)+' '+u[i]; }
function fmtDate(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleString('fa-IR'); }
function toast(msg, err=false){ const t=$('#toast'); t.textContent=msg; t.className='toast'+(err?' err':''); setTimeout(()=>t.classList.add('hidden'),3200); }

async function api(method, path, body){
  const r = await fetch(path, {method, headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body: body?JSON.stringify(body):undefined});
  const data = await r.json().catch(()=>({}));
  if(r.status===401){ logout(); throw new Error(data.detail||'خطای ورود'); }
  if(!r.ok) throw new Error(data.detail||('خطا '+r.status));
  return data;
}

// ---------- ورود ----------
$('#loginForm').addEventListener('submit', async e=>{
  e.preventDefault(); $('#loginError').textContent='';
  try{
    const r = await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#loginUser').value,password:$('#loginPass').value})});
    const d = await r.json();
    if(!r.ok) throw new Error(d.detail||'خطا');
    token = d.token; localStorage.setItem('tp_token', token); myRole = d.role;
    enterApp(d.username, d.role);
  }catch(err){ $('#loginError').textContent = err.message; }
});
function logout(){ token=''; localStorage.removeItem('tp_token'); $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); }
$('#logoutBtn').addEventListener('click', logout);

function enterApp(username, role){
  myRole = role;
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#whoami').textContent = '👤 '+username+' ('+(role==='admin'?'ادمین':'کاربر')+')';
  document.querySelectorAll('.admin-only').forEach(el=> el.style.display = role==='admin'?'':'none');
  refreshAll();
}
if(token){ api('GET','/api/auth/me').then(m=>enterApp(m.username,m.role)).catch(()=>{}); }

// ---------- تب‌ها ----------
document.querySelectorAll('.navbtn').forEach(b=> b.addEventListener('click', ()=>{
  document.querySelectorAll('.navbtn').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  $('#tab-'+b.dataset.tab).classList.add('active');
  refreshAll();
}));

async function refreshAll(){
  if(!token) return;
  const active = document.querySelector('.tab.active')?.id || '';
  try{
    if(active==='tab-dashboard') await loadDashboard();
    if(active==='tab-nodes' || active==='tab-tunnels') await loadNodes();
    if(active==='tab-tunnels') await loadTunnels();
    if(active==='tab-users' && myRole==='admin') await loadUsers();
  }catch(e){ console.warn(e); }
}
setInterval(refreshAll, 10000);

// ---------- داشبورد ----------
async function loadDashboard(){
  const d = await api('GET','/api/dashboard');
  $('#stNodes').textContent = d.nodes_online+' / '+d.nodes_total;
  $('#stTunnels').textContent = d.tunnels_active+' / '+d.tunnels_total;
  $('#stIn').textContent = fmtBytes(d.bytes_in);
  $('#stOut').textContent = fmtBytes(d.bytes_out);
  $('#stConn').textContent = d.connections.toLocaleString('fa-IR');
  drawChart(d.chart||[]);
}
function drawChart(chart){
  const c = $('#chart'), ctx = c.getContext('2d');
  const W = c.width = c.clientWidth||600, H = c.height = 150;
  ctx.clearRect(0,0,W,H);
  $('#chartEmpty').style.display = chart.length? 'none':'';
  if(!chart.length) return;
  const max = Math.max(1, ...chart.map(p=>Math.max(p.in,p.out)));
  const bw = Math.max(4, (W-20)/(chart.length*2) - 4);
  chart.forEach((p,i)=>{
    const x = 10 + i*(W-20)/chart.length;
    ctx.fillStyle = '#3fb950'; ctx.fillRect(x, H-22-(p.in/max)*(H-45), bw, Math.max(1,(p.in/max)*(H-45)));
    ctx.fillStyle = '#2f81f7'; ctx.fillRect(x+bw+2, H-22-(p.out/max)*(H-45), bw, Math.max(1,(p.out/max)*(H-45)));
    ctx.fillStyle = '#8b98a5'; ctx.font='9px Tahoma'; ctx.fillText(p.time, x, H-8);
  });
  ctx.fillStyle='#3fb950'; ctx.fillText('■ ورودی', 12, 14);
  ctx.fillStyle='#2f81f7'; ctx.fillText('■ خروجی', 70, 14);
  ctx.fillStyle='#8b98a5'; ctx.fillText('بیشینه: '+fmtBytes(max), 135, 14);
}

// ---------- سرورها ----------
async function loadNodes(){
  nodesCache = await api('GET','/api/nodes');
  $('#nodesBody').innerHTML = nodesCache.map(n=>`<tr>
    <td><b>${esc(n.name)}</b><br><span class="muted small">${esc(n.description||'')}</span></td>
    <td><span class="badge ${n.online?'on':'off'}">${n.online?'● آنلاین':'● آفلاین'}</span></td>
    <td class="mono">${esc(n.host||'—')}</td><td class="mono">${esc(n.reported_ip||'—')}</td>
    <td>${esc(n.agent_version||'—')}<br><span class="muted small">${esc(n.os_info||'')}</span></td>
    <td>${fmtDate(n.last_seen)}</td>
    <td><button class="btn sm" onclick="openNodeModal(${n.id})">✏️ ویرایش/نصب</button>
    <button class="btn sm danger" onclick="delNode(${n.id})">حذف</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">هنوز سروری اضافه نشده</td></tr>';
  const opts = nodesCache.map(n=>`<option value="${n.id}">${esc(n.name)}${n.online?' (آنلاین)':''}</option>`).join('');
  $('#tSource').innerHTML = opts; $('#tDest').innerHTML = opts;
}
function openNodeModal(id){
  const f = $('#nodeForm'); f.reset(); $('#installBox').classList.add('hidden'); $('#nodeId').value='';
  $('#nodeModalTitle').textContent = 'افزودن سرور';
  if(id){
    const n = nodesCache.find(x=>x.id===id);
    $('#nodeModalTitle').textContent = 'سرور: '+n.name;
    $('#nodeId').value=n.id; $('#nodeName').value=n.name; $('#nodeHost').value=n.host||''; $('#nodeDesc').value=n.description||'';
    showInstall(n.token);
  }
  $('#nodeModal').classList.remove('hidden');
}
function showInstall(tok){
  const url = location.origin;
  $('#installCmd').textContent = `bash <(curl -Ls ${url}/install-agent.sh) --panel ${url} --token ${tok}`;
  $('#installBox').classList.remove('hidden');
}
function copyInstall(){ navigator.clipboard.writeText($('#installCmd').textContent).then(()=>toast('دستور نصب کپی شد ✅')); }
$('#nodeForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const id = $('#nodeId').value;
  const body = {name:$('#nodeName').value, host:$('#nodeHost').value, description:$('#nodeDesc').value};
  try{
    if(id){ await api('PUT','/api/nodes/'+id, body); toast('سرور به‌روزرسانی شد ✅'); closeModal('nodeModal'); }
    else{
      const n = await api('POST','/api/nodes', body);
      $('#nodeId').value = n.id; $('#nodeModalTitle').textContent='سرور ساخته شد — حالا ایجنت را نصب کنید';
      showInstall(n.token); toast('سرور ساخته شد ✅ دستور نصب را روی سرور اجرا کنید');
    }
    loadNodes();
  }catch(err){ toast(err.message, true); }
});
async function delNode(id){ if(!confirm('این سرور حذف شود؟')) return; try{ await api('DELETE','/api/nodes/'+id); toast('حذف شد'); loadNodes(); loadTunnels(); }catch(e){ toast(e.message,true); } }

// ---------- تونل‌ها ----------
function nodeName(id){ const n=nodesCache.find(x=>x.id===id); return n? esc(n.name):'#'+id; }
async function loadTunnels(){
  const ts = await api('GET','/api/tunnels');
  $('#tunnelsBody').innerHTML = ts.map(t=>{
    const route = t.type==='reverse'
      ? `${nodeName(t.source_node_id)} <span class="mono">:${t.listen_port}</span> ⟵ ${nodeName(t.dest_node_id)} ⟶ <span class="mono">${esc(t.target_host)}:${t.target_port}</span>`
      : `${nodeName(t.source_node_id)} <span class="mono">:${t.listen_port}</span> ⟶ <span class="mono">${esc(t.target_host)}:${t.target_port}</span>`;
    const st = !t.enabled? '<span class="badge off">غیرفعال</span>' : t.expired? '<span class="badge warn">منقضی</span>' : t.over_limit? '<span class="badge warn">اتمام ترافیک</span>' : '<span class="badge on">فعال</span>';
    const lim = [t.traffic_limit_bytes? 'سقف '+fmtBytes(t.traffic_limit_bytes):'بدون سقف', t.expires_at? 'انقضا: '+fmtDate(t.expires_at):''].filter(Boolean).join('<br>');
    return `<tr><td><b>${esc(t.name)}</b><br><span class="muted small">${t.type==='reverse'?'Reverse':'Forward'} / ${t.protocol.toUpperCase()}</span></td>
    <td>${t.type==='reverse'?'ریورس':'فوروارد'}</td><td>${route}</td><td>${st}</td>
    <td class="mono">↓${fmtBytes(t.bytes_in)}<br>↑${fmtBytes(t.bytes_out)}</td><td>${(t.connections||0).toLocaleString('fa-IR')}</td><td class="small">${lim||'—'}</td>
    <td><button class="btn sm" onclick="toggleTunnel(${t.id})">${t.enabled?'⏸ توقف':'▶️ فعال'}</button>
    <button class="btn sm" onclick="openTunnelModal(${t.id})">✏️</button>
    <button class="btn sm" onclick="resetTraffic(${t.id})">♻️ ترافیک</button>
    <button class="btn sm danger" onclick="delTunnel(${t.id})">حذف</button></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">هنوز تونلی ساخته نشده</td></tr>';
}
function onTypeChange(){
  const rev = $('#tType').value==='reverse';
  $('#destWrap').classList.toggle('hidden', !rev);
  if(rev){ $('#tProtocol').value='tcp'; $('#tProtocol').disabled=true; } else { $('#tProtocol').disabled=false; }
}
function openTunnelModal(id){
  $('#tunnelForm').reset(); $('#tunnelId').value=''; $('#tTargetHost').value='127.0.0.1';
  $('#tunnelModalTitle').textContent='ساخت تونل';
  if(!nodesCache.length){ toast('اول حداقل یک سرور اضافه کنید', true); return; }
  if(id){
    api('GET','/api/tunnels').then(ts=>{
      const t = ts.find(x=>x.id===id); if(!t) return;
      $('#tunnelModalTitle').textContent='ویرایش تونل: '+t.name;
      $('#tunnelId').value=t.id; $('#tName').value=t.name; $('#tType').value=t.type; $('#tType').disabled=true;
      $('#tProtocol').value=t.protocol; $('#tSource').value=t.source_node_id; $('#tSource').disabled=true;
      $('#tDest').value=t.dest_node_id||''; $('#tListen').value=t.listen_port;
      $('#tTargetHost').value=t.target_host; $('#tTargetPort').value=t.target_port;
      $('#tLimit').value = t.traffic_limit_bytes? (t.traffic_limit_bytes/1073741824):'';
      if(t.expires_at) $('#tExpire').value = t.expires_at.slice(0,16);
      onTypeChange();
    });
  } else { $('#tType').disabled=false; $('#tSource').disabled=false; onTypeChange(); }
  $('#tunnelModal').classList.remove('hidden');
}
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
    toast('تونل ذخیره شد ✅'); closeModal('tunnelModal'); loadTunnels();
  }catch(err){ toast(err.message, true); }
});
async function toggleTunnel(id){ try{ await api('POST',`/api/tunnels/${id}/toggle`); loadTunnels(); }catch(e){ toast(e.message,true); } }
async function resetTraffic(id){ if(!confirm('آمار ترافیک این تونل صفر شود؟')) return; try{ await api('POST',`/api/tunnels/${id}/reset-traffic`); loadTunnels(); }catch(e){ toast(e.message,true); } }
async function delTunnel(id){ if(!confirm('این تونل حذف شود؟')) return; try{ await api('DELETE','/api/tunnels/'+id); toast('حذف شد'); loadTunnels(); }catch(e){ toast(e.message,true); } }

// ---------- کاربران ----------
async function loadUsers(){
  const us = await api('GET','/api/users');
  $('#usersBody').innerHTML = us.map(u=>`<tr><td>${esc(u.username)}</td><td>${u.role==='admin'?'ادمین':'کاربر'}</td>
  <td><span class="badge ${u.is_active?'on':'off'}">${u.is_active?'فعال':'غیرفعال'}</span></td>
  <td><button class="btn sm" onclick="toggleUser(${u.id},${!u.is_active})">${u.is_active?'غیرفعال‌کردن':'فعال‌کردن'}</button>
  <button class="btn sm" onclick="changePass(${u.id})">تغییر رمز</button>
  <button class="btn sm danger" onclick="delUser(${u.id})">حذف</button></td></tr>`).join('');
}
function openUserModal(){ $('#userForm').reset(); $('#userModal').classList.remove('hidden'); }
$('#userForm').addEventListener('submit', async e=>{
  e.preventDefault();
  try{ await api('POST','/api/users',{username:$('#uName').value,password:$('#uPass').value,role:$('#uRole').value}); toast('کاربر ساخته شد ✅'); closeModal('userModal'); loadUsers(); }
  catch(err){ toast(err.message,true); }
});
async function toggleUser(id, active){ try{ await api('PUT','/api/users/'+id,{is_active:active}); loadUsers(); }catch(e){ toast(e.message,true); } }
async function changePass(id){ const p = prompt('رمز جدید:'); if(!p) return; try{ await api('PUT','/api/users/'+id,{pwd:p}); toast('رمز عوض شد ✅'); }catch(e){ toast(e.message,true); } }
async function delUser(id){ if(!confirm('این کاربر حذف شود؟')) return; try{ await api('DELETE','/api/users/'+id); loadUsers(); }catch(e){ toast(e.message,true); } }

// ---------- کمکی ----------
function closeModal(id){ $('#'+id).classList.add('hidden'); }
document.querySelectorAll('.modal').forEach(m=> m.addEventListener('click', e=>{ if(e.target===m) m.classList.add('hidden'); }));
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
