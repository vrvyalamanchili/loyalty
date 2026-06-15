/**
 * app.js — UI logic
 * Session: currentVendor = { vendorId, name, email, userId, userName, role } | null
 *          currentAdmin  = { role:'platform_admin', ... } | null
 *          adminViewingVendor — when platform admin inspects a vendor
 *
 * Role gates:
 *   canWrite()      — owner or admin (not readonly)
 *   canConfig()     — owner only
 *   isAtLeastAdmin()— owner or admin
 */

let currentVendor      = null;
let currentAdmin       = null;
let adminViewingVendor = null;

/* ─── role helpers ─── */
function activeRole() {
  if (adminViewingVendor) return 'owner'; // platform admin gets full access when inspecting
  return currentVendor?.role || 'readonly';
}
function canWrite()        { return ['owner','admin'].includes(activeRole()); }
function canConfig()       { return activeRole() === 'owner'; }
function isAtLeastAdmin()  { return ['owner','admin'].includes(activeRole()); }

function guardWrite(action) {
  if (!canWrite()) { alert('Your role (readonly) does not have permission to perform this action.'); return false; }
  return true;
}
function guardConfig(action) {
  if (!canConfig()) { alert('Only the account owner can change configuration settings.'); return false; }
  return true;
}

/* ─── bootstrap ─── */
window.addEventListener('DOMContentLoaded', async () => {
  showLoading(true);
  await dbInit();
  showLoading(false);
  showAuthScreen('login');
});

function showLoading(on) { document.getElementById('loading-overlay').style.display = on?'flex':'none'; }
function vid()  { return adminViewingVendor ? adminViewingVendor.vendor_id : currentVendor?.vendorId; }
function fmt(d) { return d.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}); }

/* ══════════════════════════════════════════ AUTH ══════════════════════════════════════════ */
function showAuthScreen(screen) {
  document.getElementById('auth-layer').style.display  = 'flex';
  document.getElementById('app-layer').style.display   = 'none';
  document.getElementById('admin-layer').style.display = 'none';
  clearAuthErrors();
}
function clearAuthErrors() {
  ['login-error','register-error'].forEach(id=>{const e=document.getElementById(id);if(e){e.textContent='';e.style.display='none';}});
}
function showAuthError(id,msg) { const e=document.getElementById(id); e.textContent=msg; e.style.display='block'; }

async function handleLogin() {
  const email=document.getElementById('login-email').value.trim();
  const pw   =document.getElementById('login-password').value;
  if (!email||!pw){showAuthError('login-error','Enter email and password.');return;}
  const btn=document.getElementById('login-btn'); btn.textContent='Signing in…'; btn.disabled=true;

  if (email.toLowerCase()==='admin@loyaltyos.com') {
    const r=await dbAdminLogin({email,password:pw});
    btn.textContent='Sign in'; btn.disabled=false;
    if(r.error){showAuthError('login-error',r.error);return;}
    currentAdmin=r.admin; currentVendor=null;
    document.getElementById('login-password').value='';
    showAdminDashboard(); return;
  }
  const r=await dbLoginVendor({email,password:pw});
  btn.textContent='Sign in'; btn.disabled=false;
  if(r.error){showAuthError('login-error',r.error);return;}
  currentVendor=r.vendor; currentAdmin=null;
  document.getElementById('login-password').value='';
  showVendorApp();
}

function handleLogout() {
  currentVendor=null; currentAdmin=null; adminViewingVendor=null;
  showAuthScreen('login');
}

/* ══════════════════════════════════════════ VENDOR APP ══════════════════════════════════════════ */
function showVendorApp(impersonateVendor=null) {
  adminViewingVendor=impersonateVendor;
  const v=impersonateVendor||currentVendor;
  document.getElementById('auth-layer').style.display  ='none';
  document.getElementById('admin-layer').style.display ='none';
  document.getElementById('app-layer').style.display   ='flex';
  document.getElementById('vendor-name-display').textContent = v.name;
  document.getElementById('vendor-id-display').textContent   = impersonateVendor?v.vendor_id:v.vendorId;
  document.getElementById('vendor-avatar').textContent       = v.name.charAt(0).toUpperCase();

  const backBtn=document.getElementById('admin-back-btn');
  if(backBtn) backBtn.style.display=impersonateVendor?'flex':'none';

  // role badge
  const roleBadge=document.getElementById('role-badge');
  if(roleBadge){
    const role=impersonateVendor?'owner':(v.role||'owner');
    const colors={owner:'#15803d',admin:'#1d4ed8',readonly:'#64748b'};
    const bgs   ={owner:'#f0fdf4',admin:'#eff6ff',readonly:'#f1f5f9'};
    roleBadge.textContent=role; roleBadge.style.color=colors[role]; roleBadge.style.background=bgs[role];
  }

  // show/hide nav items by role
  applyRoleNav();
  buildModeButtons();
  switchToTab('dashboard', document.querySelector('.nav-item'));
}

function applyRoleNav() {
  const configNav=document.getElementById('nav-config');
  if(configNav) configNav.style.display=canConfig()?'':'none';
  const teamNav=document.getElementById('nav-team');
  if(teamNav) teamNav.style.display=canConfig()?'':'none';
  const apiNav=document.getElementById('nav-api');
  if(apiNav) apiNav.style.display=canConfig()?'':'none';
}

function adminBackToPanel() { adminViewingVendor=null; document.getElementById('app-layer').style.display='none'; document.getElementById('admin-layer').style.display='flex'; }

/* ══════════════════════════════════════════ TIER / STATUS HELPERS ══════════════════════════════════════════ */
function resolveStatus(customer) {
  const tiers  = dbGetTiers(vid());
  const cfg    = dbGetConfig(vid());
  const spend  = dbGetQualifyingSpend(vid(), customer.customer_id, cfg.reset_policy || 'calendar');
  const highest = tiers[tiers.length - 1];
  const lowest  = tiers[0];

  // Special users always hold the highest status — spend expiry doesn't affect them
  if (customer.points_tier === 'special') {
    return { tier: highest, spend, overridden: true, reason: 'special' };
  }

  // Manual override takes next precedence (regular users only)
  if (customer.status_override) {
    const t = tiers.find(x => x.id === customer.status_override);
    if (t) return { tier: t, spend, overridden: true, reason: 'manual' };
  }

  // Regular users: if qualifying spend is 0 (expired / not yet spent), drop to lowest tier
  if (spend <= 0) {
    return { tier: lowest, spend, overridden: false, reason: 'expired' };
  }

  // Regular users: resolve by spend thresholds
  let status = lowest;
  for (const t of tiers) { if (spend >= t.min_spend) status = t; }
  return { tier: status, spend, overridden: false, reason: 'spend' };
}
function statusBadgeHtml(tier, overridden=false, reason='') {
  if (!tier) return '';
  let indicator = '';
  if (reason === 'special')  indicator = ` <span title="Special user — permanently holds highest status" style="font-size:9px">⭐</span>`;
  else if (reason === 'manual') indicator = ` <span title="Manually overridden" style="font-size:9px">📌</span>`;
  else if (reason === 'expired') indicator = ` <span title="Points expired — reset to base tier" style="font-size:9px">↩</span>`;
  return `<span class="status-badge" style="background:${tier.bg_color};color:${tier.color}">${tier.name}${indicator}</span>`;
}
function tierProgressHtml(customer) {
  const tiers=dbGetTiers(vid()), cfg=dbGetConfig(vid());
  const spend=dbGetQualifyingSpend(vid(),customer.customer_id,cfg.reset_policy||'calendar');
  const cur=resolveStatus(customer).tier;
  return tiers.map((t,i)=>{
    const next=tiers[i+1], reached=spend>=t.min_spend, active=cur.id===t.id;
    const pct=next?(reached?Math.min(100,Math.round((spend-t.min_spend)/(next.min_spend-t.min_spend)*100)):0):(reached?100:0);
    return `<div class="tier-step" style="${active?`border:1.5px solid ${t.color};background:${t.bg_color}`:''}">
      <div class="tier-step-name" style="color:${reached?t.color:'#94a3b8'}">${t.name}</div>
      <div class="prog-track"><div class="prog-fill" style="width:${pct}%;background:${t.color}"></div></div>
      <div class="tier-step-range">${next?'$'+t.min_spend+'–$'+next.min_spend:'$'+t.min_spend+'+'}</div>
    </div>`;
  }).join('');
}
function getActiveMode() { return dbGetActiveMode(vid()); }
function getMult(pointsTier) { const m=getActiveMode(); if(!m) return 1; return pointsTier==='special'?m.spl_mult:m.reg_mult; }

/* ─── highest tier ─── */
function getHighestTier() {
  const tiers=dbGetTiers(vid());
  return tiers[tiers.length-1]||null;
}

/* ══════════════════════════════════════════ NAVIGATION ══════════════════════════════════════════ */
function switchToTab(t,el) {
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  if(el) el.classList.add('active');
  document.getElementById('tab-'+t).classList.add('active');
  if(t==='dashboard')   renderDashboard();
  if(t==='customers')   renderCustomers();
  if(t==='products')    renderProducts();
  if(t==='transaction') { populateCustSelect(); populateProductSelect(); }
  if(t==='ledger')      { populateLedgerFilter(); renderLedger(); }
  if(t==='team')        renderTeam();
  if(t==='api')         renderApiKeys();
  if(t==='config')      renderConfig();
}

/* ══════════════════════════════════════════ DASHBOARD ══════════════════════════════════════════ */
function renderDashboard() {
  const customers=dbGetCustomers(vid()), txns=dbGetTransactions(vid()), tiers=dbGetTiers(vid());
  document.getElementById('m-total').textContent  =customers.length;
  document.getElementById('m-txns').textContent   =txns.length;
  const issued  =customers.reduce((s,c)=>s+c.points_earned,0);
  const deducted=customers.reduce((s,c)=>s+c.points_deducted,0);
  document.getElementById('m-issued').textContent =issued.toLocaleString();
  document.getElementById('m-net').textContent    =(issued-deducted).toLocaleString();
  const dist={};
  tiers.forEach(t=>dist[t.id]=0);
  customers.forEach(c=>{const s=resolveStatus(c).tier;if(s) dist[s.id]=(dist[s.id]||0)+1;});
  document.getElementById('status-dist').innerHTML=tiers.map(t=>`
    <div class="dist-row">
      <div style="min-width:76px">${statusBadgeHtml(t)}</div>
      <div class="dist-bar-wrap"><div class="dist-bar" style="width:${customers.length?Math.round((dist[t.id]||0)/customers.length*100):0}%;background:${t.color}"></div></div>
      <div class="dist-count">${dist[t.id]||0}</div>
    </div>`).join('');
  document.getElementById('tier-overview').innerHTML=tiers.map((t,i)=>{
    const next=tiers[i+1];
    return `<div class="tier-ov-card">${statusBadgeHtml(t)}
      <div class="range">${next?'$'+t.min_spend+' – $'+(next.min_spend-1):'$'+t.min_spend+'+'}</div>
      <div class="count">${dist[t.id]||0}</div></div>`;
  }).join('');
  const m=getActiveMode(), mEl=document.getElementById('active-mode-display');
  if(mEl) mEl.innerHTML=m?`Active: <strong>${m.label}</strong> &nbsp; Reg <strong>${m.reg_mult}×</strong> &nbsp; Spl <strong>${m.spl_mult}×</strong>`:'No active mode';
}

/* ─── mode buttons ─── */
function buildModeButtons() {
  const modes=dbGetModes(vid());
  document.querySelectorAll('.mode-btn-wrap').forEach(wrap=>{
    wrap.innerHTML=modes.map(m=>`
      <button class="mode-btn${m.is_active?' active':''}" onclick="activateMode('${m.mode_id}')">${m.label}</button>`).join('');
  });
}
function activateMode(modeId) {
  if(!guardConfig()) return;
  dbActivateMode(vid(),modeId); buildModeButtons(); renderDashboard(); updatePreview();
}

/* ══════════════════════════════════════════ CUSTOMERS ══════════════════════════════════════════ */
function openModal(name)  { document.getElementById('modal-'+name).classList.add('open'); }
function closeModal(name) { document.getElementById('modal-'+name).classList.remove('open'); }

function addCustomer() {
  if(!guardWrite()) return;
  const fn=document.getElementById('fn').value.trim(), ln=document.getElementById('ln').value.trim();
  if(!fn||!ln){alert('Please enter first and last name.');return;}
  const ptier=document.getElementById('ptier').value;
  // special users get highest tier override by default
  const statusOverride = ptier==='special' ? (getHighestTier()?.id||null) : null;
  const id=dbGenCustId(vid());
  dbInsertCustomer(vid(),{
    customer_id:id, first_name:fn, last_name:ln,
    email:document.getElementById('em').value.trim(),
    phone:document.getElementById('ph').value.trim(),
    points_tier:ptier, registered_at:Date.now(), status_override:statusOverride
  });
  ['fn','ln','em','ph'].forEach(x=>document.getElementById(x).value='');
  closeModal('add-customer');
  renderDashboard();
  const highest=getHighestTier();
  const msg=statusOverride
    ? `Customer registered!\nID: ${id}\nName: ${fn} ${ln}\nPoints tier: Special\nStatus: ${highest?.name||'Icon'} (auto-assigned for special users)`
    : `Customer registered!\nID: ${id}\nName: ${fn} ${ln}\nStatus: ${dbGetTiers(vid())[0]?.name||'Basic'}`;
  alert(msg);
}

function renderCustomers() {
  const customers=dbGetCustomers(vid());
  const empty=document.getElementById('cust-empty'), table=document.getElementById('cust-table');
  if(!customers.length){empty.style.display='flex';table.style.display='none';return;}
  empty.style.display='none'; table.style.display='table';
  document.getElementById('cust-tbody').innerHTML=customers.map(c=>{
    const {tier,spend,overridden,reason}=resolveStatus(c), net=c.points_earned-c.points_deducted;
    const canEditStatus=isAtLeastAdmin();
    return `<tr>
      <td><span class="cid-pill clickable" onclick="openDrawer('${c.customer_id}')">${c.customer_id}</span></td>
      <td style="font-weight:500">${c.first_name} ${c.last_name}</td>
      <td class="hide-mobile" style="color:#64748b">${c.email||'—'}</td>
      <td class="hide-mobile"><span class="pts-tier-badge ${c.points_tier}">${c.points_tier}</span></td>
      <td>${statusBadgeHtml(tier,overridden,reason)} ${canEditStatus?`<button class="btn-icon" title="Override status" onclick="openStatusOverride('${c.customer_id}')">✎</button>`:''}</td>
      <td class="hide-mobile">$${spend.toFixed(2)}</td>
      <td style="font-weight:600">${net.toLocaleString()} pts</td>
      <td style="display:flex;gap:4px">
        <button class="btn-view" onclick="openDrawer('${c.customer_id}')">View</button>
        ${canWrite()?`<button class="btn-pts" onclick="openAppeasement('${c.customer_id}')">+ Pts</button>`:''}
      </td>
    </tr>`;
  }).join('');
}

/* ── status override ── */
function openStatusOverride(customerId) {
  if(!isAtLeastAdmin()){alert('Admins and owners can override customer status.');return;}
  const c=dbGetCustomer(vid(),customerId); if(!c) return;
  if(c.points_tier==='special'){
    alert('Special users always hold the highest status — their status cannot be manually overridden.');return;
  }
  const tiers=dbGetTiers(vid());
  document.getElementById('so-cust-name').textContent=`${c.first_name} ${c.last_name} (${c.customer_id})`;
  const sel=document.getElementById('so-tier-sel');
  sel.innerHTML=`<option value="">Auto (based on spend)</option>`
    +tiers.map(t=>`<option value="${t.id}" ${c.status_override===t.id?'selected':''}>${t.name}</option>`).join('');
  document.getElementById('so-customer-id').value=customerId;
  openModal('status-override');
}
function saveStatusOverride() {
  const customerId=document.getElementById('so-customer-id').value;
  const tierId=document.getElementById('so-tier-sel').value||null;
  dbSetStatusOverride(vid(),customerId,tierId);
  closeModal('status-override');
  renderCustomers();
  const label=tierId?dbGetTiers(vid()).find(t=>t.id===tierId)?.name:'auto (spend-based)';
  alert(`Status updated to: ${label}`);
}

/* ── appeasement points ── */
function openAppeasement(customerId) {
  if(!guardWrite()) return;
  const c=dbGetCustomer(vid(),customerId); if(!c) return;
  document.getElementById('ap-cust-name').textContent=`${c.first_name} ${c.last_name} (${c.customer_id})`;
  document.getElementById('ap-cust-id').value=customerId;
  document.getElementById('ap-points').value='';
  document.getElementById('ap-reason').value='';
  openModal('appeasement');
}
function saveAppeasement() {
  if(!guardWrite()) return;
  const customerId=document.getElementById('ap-cust-id').value;
  const pts=parseInt(document.getElementById('ap-points').value);
  const reason=document.getElementById('ap-reason').value.trim();
  if(!pts||pts<=0){alert('Enter a valid number of points.');return;}
  if(!reason){alert('A reason is required for appeasement points.');return;}
  const c=dbGetCustomer(vid(),customerId);
  const id=dbGenTxnId(vid());
  const actor=adminViewingVendor?'platform_admin':(currentVendor?.userName||currentVendor?.email||'admin');
  dbInsertTransaction(vid(),{
    txn_id:id, date:fmt(new Date()), ts:Date.now(),
    customer_id:customerId, cust_name:`${c.first_name} ${c.last_name}`,
    points_tier:c.points_tier, order_type:'appeasement',
    product_id:null, product_name:null,
    description:`Appeasement: ${reason}`, amount:0,
    multiplier:1, points:pts, type:'appeasement',
    ref_id:null, created_by:actor
  });
  dbUpdateCustomerPoints(vid(),customerId,pts,0);
  closeModal('appeasement');
  renderCustomers(); renderDashboard();
  alert(`${pts} appeasement points added to ${c.first_name} ${c.last_name}!\nTxn ID: ${id}\nReason: ${reason}\nAdded by: ${actor}`);
}

/* ══════════════════════════════════════════ TRANSACTION ══════════════════════════════════════════ */
function onOrderTypeChange() {
  const isGuest=document.getElementById('order-type').value==='guest';
  document.getElementById('cust-field').style.display  =isGuest?'none':'flex';
  document.getElementById('guest-notice').style.display=isGuest?'block':'none';
  document.getElementById('cust-id-row').style.display ='none';
  updatePreview();
}
function populateCustSelect() {
  const sel=document.getElementById('cust-sel'), prev=sel.value;
  sel.innerHTML='<option value="">— select customer —</option>';
  dbGetCustomers(vid()).forEach(c=>{
    const o=document.createElement('option');
    o.value=c.customer_id; o.textContent=`${c.customer_id} — ${c.first_name} ${c.last_name} (${c.points_tier})`;
    sel.appendChild(o);
  });
  if(prev) sel.value=prev; updatePreview();
}
function populateProductSelect() {
  const sel=document.getElementById('prod-sel'); if(!sel) return;
  const prev=sel.value;
  sel.innerHTML='<option value="">— no product / manual amount —</option>';
  dbGetProducts(vid(),true).forEach(p=>{
    const o=document.createElement('option');
    o.value=p.product_id;
    o.textContent=`${p.name} ($${parseFloat(p.price).toFixed(2)})${p.pts_override!=null?' · '+p.pts_override+'× override':''}`;
    sel.appendChild(o);
  });
  if(prev) sel.value=prev; updatePreview();
}
function updatePreview() {
  const isGuest=document.getElementById('order-type').value==='guest';
  const prodSel=document.getElementById('prod-sel'), amtInput=document.getElementById('amt');
  const qtyInput=document.getElementById('qty');
  const el=document.getElementById('txn-preview'), cidRow=document.getElementById('cust-id-row');
  const lineTotalEl=document.getElementById('line-total');

  if(prodSel&&prodSel.value&&!amtInput.dataset.manual){
    const p=dbGetProduct(vid(),prodSel.value); if(p) amtInput.value=parseFloat(p.price).toFixed(2);
  }

  const unitAmt=parseFloat(amtInput?.value)||0;
  const qty=Math.max(1, parseInt(qtyInput?.value)||1);
  const totalAmt=unitAmt*qty;

  // update line total display
  if(lineTotalEl) lineTotalEl.textContent = unitAmt ? `$${totalAmt.toFixed(2)}${qty>1?` (${qty} × $${unitAmt.toFixed(2)})`:''}` : '$0.00';

  if(isGuest){if(cidRow)cidRow.style.display='none'; el.textContent=totalAmt?`Guest order $${totalAmt.toFixed(2)} — no points.`:'Enter amount for guest order.'; return;}
  const cid=document.getElementById('cust-sel')?.value;
  if(!cid){if(cidRow)cidRow.style.display='none'; el.textContent='Select a customer and enter an amount.'; return;}
  const c=dbGetCustomer(vid(),cid);
  document.getElementById('cid-show').textContent=cid;
  const _rs=resolveStatus(c); document.getElementById('status-inline').innerHTML=statusBadgeHtml(_rs.tier,_rs.overridden,_rs.reason);
  if(cidRow) cidRow.style.display='flex';
  if(totalAmt&&c){
    let mult=getMult(c.points_tier);
    if(prodSel&&prodSel.value){const p=dbGetProduct(vid(),prodSel.value);if(p&&p.pts_override!=null) mult=p.pts_override;}
    const pts=Math.round(totalAmt*mult), cfg=dbGetConfig(vid());
    const curSpend=dbGetQualifyingSpend(vid(),cid,cfg.reset_policy||'calendar'), newSpend=curSpend+totalAmt;
    const tiers=dbGetTiers(vid()); let upgrade='';
    for(let i=tiers.length-1;i>=0;i--){if(newSpend>=tiers[i].min_spend&&curSpend<tiers[i].min_spend){upgrade=` 🎉 Will reach ${tiers[i].name}!`;break;}}
    el.textContent=`${c.first_name} earns ${pts} pts (${mult}× on $${totalAmt.toFixed(2)}).  Spend: $${curSpend.toFixed(2)} → $${newSpend.toFixed(2)}.${upgrade}`;
  } else { el.textContent='Enter an amount to preview points.'; }
}
function addTransaction() {
  if(!guardWrite()) return;
  const isGuest=document.getElementById('order-type').value==='guest';
  const amtInput=document.getElementById('amt');
  const qtyInput=document.getElementById('qty');
  const unitAmt=parseFloat(amtInput?.value);
  const qty=Math.max(1, parseInt(qtyInput?.value)||1);
  const totalAmt=parseFloat(((unitAmt||0)*qty).toFixed(2));
  const prodSel=document.getElementById('prod-sel'), descInput=document.getElementById('desc');
  let desc=descInput?.value.trim()||'Purchase';
  if(!unitAmt||unitAmt<=0){alert('Enter a valid unit amount.');return;}
  const actor=adminViewingVendor?'platform_admin':(currentVendor?.userName||currentVendor?.email||'');
  if(isGuest){
    const id=dbGenTxnId(vid());
    dbInsertTransaction(vid(),{txn_id:id,date:fmt(new Date()),ts:Date.now(),customer_id:null,cust_name:'Guest',
      points_tier:'guest',order_type:'guest',product_id:null,product_name:null,
      description:`${desc}${qty>1?` (qty: ${qty})`:''}`,
      unit_price:unitAmt, quantity:qty, amount:totalAmt,
      multiplier:0,points:0,type:'earn',ref_id:null,created_by:actor});
    if(amtInput){amtInput.value='';delete amtInput.dataset.manual;} if(descInput)descInput.value=''; if(qtyInput)qtyInput.value='1';
    renderDashboard(); alert(`Guest order recorded.\nTxn ID: ${id}\nQty: ${qty}\nTotal: $${totalAmt.toFixed(2)}`); return;
  }
  const cid=document.getElementById('cust-sel')?.value; if(!cid){alert('Select a customer.');return;}
  const c=dbGetCustomer(vid(),cid);
  let mult=getMult(c.points_tier), prodId=null, prodName=null;
  if(prodSel&&prodSel.value){const p=dbGetProduct(vid(),prodSel.value);if(p){prodId=p.product_id;prodName=p.name;if(p.pts_override!=null)mult=p.pts_override;}}
  const pts=Math.round(totalAmt*mult), prevTier=resolveStatus(c).tier, id=dbGenTxnId(vid());
  const fullDesc=qty>1?`${desc||prodName||'Purchase'} (qty: ${qty})`:desc||prodName||'Purchase';
  dbInsertTransaction(vid(),{txn_id:id,date:fmt(new Date()),ts:Date.now(),customer_id:cid,
    cust_name:`${c.first_name} ${c.last_name}`,points_tier:c.points_tier,order_type:'registered',
    product_id:prodId,product_name:prodName,description:fullDesc,
    unit_price:unitAmt, quantity:qty, amount:totalAmt,
    multiplier:mult,points:pts,type:'earn',ref_id:null,created_by:actor});
  dbUpdateCustomerPoints(vid(),cid,pts,0);
  const newTier=resolveStatus(c).tier;
  if(amtInput){amtInput.value='';delete amtInput.dataset.manual;} if(descInput)descInput.value=''; if(prodSel)prodSel.value=''; if(qtyInput)qtyInput.value='1';
  updatePreview(); renderDashboard();
  let msg=`Transaction added!\nTxn ID: ${id}\nCustomer: ${cid}\nQty: ${qty}\nUnit price: $${unitAmt.toFixed(2)}\nTotal: $${totalAmt.toFixed(2)}\nPoints: +${pts}`;
  if(newTier.id!==prevTier.id) msg+=`\n\n🎉 Status: ${prevTier.name} → ${newTier.name}!`;
  alert(msg);
}
function returnTransaction(txnId) {
  if(!guardWrite()) return;
  const orig=dbGetTransactions(vid()).find(t=>t.txn_id===txnId);
  if(!orig||orig.returned) return;
  const origQty=orig.quantity||1;
  const alreadyReturned=orig.qty_returned||0;
  const returnable=origQty-alreadyReturned;
  if(returnable<=0){alert('All units for this transaction have already been returned.');return;}

  // open partial return modal
  document.getElementById('pr-txn-id').value=txnId;
  document.getElementById('pr-txn-info').textContent=
    `${orig.txn_id} — ${orig.product_name||orig.description} | Qty: ${origQty} | Unit: $${parseFloat(orig.unit_price||orig.amount).toFixed(2)} | Already returned: ${alreadyReturned}`;
  document.getElementById('pr-qty').max=returnable;
  document.getElementById('pr-qty').value=returnable;
  document.getElementById('pr-qty-max').textContent=`max ${returnable}`;
  updateReturnPreview(orig);
  openModal('partial-return');
}

function updateReturnPreview(orig) {
  if(!orig) {
    const txnId=document.getElementById('pr-txn-id').value;
    orig=dbGetTransactions(vid()).find(t=>t.txn_id===txnId);
  }
  if(!orig) return;
  const qty=Math.max(1,Math.min(parseInt(document.getElementById('pr-qty').value)||1, (orig.quantity||1)-(orig.qty_returned||0)));
  const unitPrice=parseFloat(orig.unit_price||orig.amount)||0;
  const unitPts=orig.quantity>1?Math.round(orig.points/orig.quantity):orig.points;
  const refundAmt=(unitPrice*qty).toFixed(2);
  const refundPts=Math.round(unitPts*qty);
  document.getElementById('pr-preview').textContent=
    `Returning ${qty} unit${qty>1?'s':''} — $${refundAmt} refunded, ${refundPts} pts deducted.`;
}

function savePartialReturn() {
  if(!guardWrite()) return;
  const txnId=document.getElementById('pr-txn-id').value;
  const orig=dbGetTransactions(vid()).find(t=>t.txn_id===txnId);
  if(!orig) return;
  const origQty=orig.quantity||1;
  const alreadyReturned=orig.qty_returned||0;
  const returnable=origQty-alreadyReturned;
  const qtyToReturn=Math.max(1,Math.min(parseInt(document.getElementById('pr-qty').value)||1, returnable));
  const unitPrice=parseFloat(orig.unit_price||orig.amount)||0;
  const unitPts=origQty>1?Math.round(orig.points/origQty):orig.points;
  const refundAmt=parseFloat((unitPrice*qtyToReturn).toFixed(2));
  const refundPts=Math.round(unitPts*qtyToReturn);
  const actor=adminViewingVendor?'platform_admin':(currentVendor?.userName||currentVendor?.email||'');
  const id=dbGenTxnId(vid());
  const isFullReturn=qtyToReturn>=returnable;

  dbInsertTransaction(vid(),{
    txn_id:id, date:fmt(new Date()), ts:Date.now(),
    customer_id:orig.customer_id, cust_name:orig.cust_name,
    points_tier:orig.points_tier, order_type:orig.order_type,
    product_id:orig.product_id, product_name:orig.product_name,
    description:`Return (${qtyToReturn}/${origQty}): ${orig.description}`,
    unit_price:unitPrice, quantity:qtyToReturn,
    amount:refundAmt, multiplier:orig.multiplier,
    points:refundPts, type:'deduct', ref_id:orig.txn_id, created_by:actor
  });
  dbMarkPartialReturn(vid(), txnId, qtyToReturn);
  if(orig.customer_id) dbUpdateCustomerPoints(vid(),orig.customer_id,0,refundPts);

  closeModal('partial-return');
  renderLedger(); renderDashboard();
  alert(`Return processed!\nReturn Txn: ${id}\nRef: ${orig.txn_id}\nQty returned: ${qtyToReturn}/${origQty}\nAmount refunded: $${refundAmt}\nPoints deducted: ${refundPts}${isFullReturn?'\nFully returned.':'\nPartial — remaining units still eligible for return.'}`);
}

/* ══════════════════════════════════════════ LEDGER ══════════════════════════════════════════ */
function populateLedgerFilter() {
  const sel=document.getElementById('ledger-filter'), prev=sel.value;
  sel.innerHTML='<option value="">All customers</option>';
  dbGetCustomers(vid()).forEach(c=>{const o=document.createElement('option');o.value=c.customer_id;o.textContent=`${c.customer_id} — ${c.first_name} ${c.last_name}`;sel.appendChild(o);});
  if(prev) sel.value=prev;
}
function renderLedger() {
  const filter=document.getElementById('ledger-filter').value;
  const txns=dbGetTransactions(vid(),filter||null);
  const empty=document.getElementById('ledger-empty'), table=document.getElementById('ledger-table'), sumBar=document.getElementById('ledger-summary-bar');
  if(!txns.length){empty.style.display='flex';table.style.display='none';sumBar.style.display='none';return;}
  empty.style.display='none'; table.style.display='table'; sumBar.style.display='flex';
  const earnPts =txns.filter(t=>t.type==='earn').reduce((s,t)=>s+t.points,0);
  const apPts   =txns.filter(t=>t.type==='appeasement').reduce((s,t)=>s+t.points,0);
  const deducted=txns.filter(t=>t.type==='deduct').reduce((s,t)=>s+t.points,0);
  sumBar.innerHTML=`
    <span style="color:#15803d;font-weight:500">+${earnPts.toLocaleString()} earned</span>
    ${apPts?`<span style="color:#7c3aed;font-weight:500">+${apPts.toLocaleString()} appeasement</span>`:''}
    <span style="color:#b91c1c;font-weight:500">−${deducted.toLocaleString()} deducted</span>
    <span style="font-weight:600;color:#0f172a">Net: ${(earnPts+apPts-deducted).toLocaleString()}</span>
    <span style="color:#94a3b8;font-size:12px">${txns.length} txn${txns.length!==1?'s':''}</span>`;
  document.getElementById('ledger-tbody').innerHTML=txns.map(t=>{
    const isEarn=t.type==='earn', isAp=t.type==='appeasement', isDeduct=t.type==='deduct', isGuest=t.order_type==='guest';
    const kindCls=isEarn?'earn':isAp?'appeasement':'return';
    const kindLabel=isEarn?'earn':isAp?'appeasement':'return';
    const ptsCls=isDeduct?'ret':isAp?'ap':'earn';
    return `<tr>
      <td class="txn-id">${t.txn_id}</td>
      <td style="color:#64748b;white-space:nowrap">${t.date}</td>
      <td>${t.customer_id?`<span class="cid-pill clickable" onclick="openDrawer('${t.customer_id}')">${t.customer_id}</span>`:'<span style="color:#94a3b8;font-size:11px">guest</span>'}</td>
      <td>${t.cust_name}</td>
      <td class="hide-mobile" style="color:#64748b;font-size:12px">${t.product_name||'—'}</td>
      <td class="hide-mobile" style="color:#64748b">${t.description}</td>
      <td>${t.amount?'$'+parseFloat(t.amount).toFixed(2):'—'}</td>
      <td class="hide-mobile" style="text-align:center">${isGuest||isAp?'—':t.multiplier+'×'}</td>
      <td><span class="pts-pill ${ptsCls}">${isDeduct?'−':'+'}${t.points}</span></td>
      <td><span class="kind-badge ${kindCls}">${kindLabel}</span></td>
      <td class="txn-id hide-mobile" style="color:#64748b">${t.created_by||'—'}</td>
      <td class="txn-id hide-mobile">${t.ref_id||'—'}</td>
      <td>${!isGuest&&!isAp&&isEarn
        ? (t.returned
            ? `<span style="font-size:11px;color:#94a3b8">fully returned</span>`
            : `<button class="btn-return" onclick="returnTransaction('${t.txn_id}')">Return${(t.qty_returned>0)?` (${t.qty_returned}/${t.quantity||1} done)`:''}</button>`)
        : `<span style="font-size:11px;color:#94a3b8">${t.returned?'returned':'—'}</span>`}</td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════ DRAWER ══════════════════════════════════════════ */
function openDrawer(customerId) {
  const c=dbGetCustomer(vid(),customerId); if(!c) return;
  const {tier,spend,overridden,reason}=resolveStatus(c), net=c.points_earned-c.points_deducted;
  document.getElementById('d-name').textContent   =`${c.first_name} ${c.last_name}`;
  document.getElementById('d-sub').textContent    =c.email||'No email on file';
  document.getElementById('d-cid').textContent    =c.customer_id;
  document.getElementById('d-email').textContent  =c.email||'—';
  document.getElementById('d-phone').textContent  =c.phone||'—';
  document.getElementById('d-ptier').innerHTML    =`<span class="pts-tier-badge ${c.points_tier}">${c.points_tier}</span>`;
  document.getElementById('d-status').innerHTML   =statusBadgeHtml(tier,overridden,reason)+(isAtLeastAdmin()?` <button class="btn-icon" onclick="openStatusOverride('${c.customer_id}')">✎</button>`:'');
  document.getElementById('d-qspend').textContent =`$${spend.toFixed(2)}`;
  document.getElementById('d-earned').textContent =`+${c.points_earned.toLocaleString()} pts`;
  document.getElementById('d-deducted').textContent=c.points_deducted>0?`−${c.points_deducted.toLocaleString()} pts`:'—';
  document.getElementById('d-net').textContent    =`${net.toLocaleString()} pts`;
  document.getElementById('d-ladder').innerHTML   =tierProgressHtml(c);
  const txns=dbGetTransactions(vid(),customerId);
  document.getElementById('d-txns').innerHTML=!txns.length
    ?'<div style="font-size:13px;color:#94a3b8">No transactions yet.</div>'
    :txns.map(t=>`<div class="drawer-txn">
        <div class="drawer-txn-top"><span class="txn-id">${t.txn_id}</span><span class="kind-badge ${t.type==='earn'?'earn':t.type==='appeasement'?'appeasement':'return'}">${t.type}</span></div>
        <div class="drawer-txn-mid">${t.date}${t.product_name?' · 📦 '+t.product_name:''} · ${t.description}</div>
        <div class="drawer-txn-bot"><span style="color:#64748b">${t.amount?'$'+parseFloat(t.amount).toFixed(2):''}</span><span class="pts-pill ${t.type==='deduct'?'ret':t.type==='appeasement'?'ap':'earn'}">${t.type==='deduct'?'−':'+'}${t.points} pts</span></div>
        ${t.created_by?`<div class="drawer-txn-ref">By: ${t.created_by}</div>`:''}
        ${t.ref_id?`<div class="drawer-txn-ref">Ref: <span class="txn-id">${t.ref_id}</span></div>`:''}
        ${t.returned?`<div style="font-size:11px;color:#94a3b8;margin-top:4px">⚑ Returned</div>`:''}
      </div>`).join('');
  document.getElementById('customer-drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('open');
}
function closeDrawer() { document.getElementById('customer-drawer').classList.remove('open'); document.getElementById('drawer-overlay').classList.remove('open'); }

/* ══════════════════════════════════════════ PRODUCTS ══════════════════════════════════════════ */
function renderProducts() {
  const products=dbGetProducts(vid());
  const empty=document.getElementById('prod-empty'), table=document.getElementById('prod-table');
  if(!products.length){empty.style.display='flex';table.style.display='none';return;}
  empty.style.display='none'; table.style.display='table';
  document.getElementById('prod-tbody').innerHTML=products.map(p=>`<tr>
    <td class="txn-id">${p.product_id}</td>
    <td style="font-weight:500">${p.name}</td>
    <td style="color:#64748b">${p.sku||'—'}</td>
    <td style="color:#64748b">${p.category||'—'}</td>
    <td>$${parseFloat(p.price).toFixed(2)}</td>
    <td>${p.pts_override!=null?`<span class="pts-pill earn">${p.pts_override}× override</span>`:'<span style="color:#94a3b8;font-size:12px">mode default</span>'}</td>
    <td><span class="status-badge" style="background:${p.active?'#f0fdf4':'#f1f5f9'};color:${p.active?'#15803d':'#64748b'}">${p.active?'Active':'Inactive'}</span></td>
    <td style="display:flex;gap:6px">
      ${canConfig()?`<button class="btn-view" onclick="openProductModal('${p.product_id}')">Edit</button><button class="btn-return" onclick="deleteProduct('${p.product_id}')">Del</button>`:'<span style="color:#94a3b8;font-size:12px">readonly</span>'}
    </td>
  </tr>`).join('');
}
function openProductModal(productId=null) {
  if(!guardConfig()) return;
  const p=productId?dbGetProduct(vid(),productId):null;
  document.getElementById('prod-modal-title').textContent=p?'Edit product':'Add product';
  document.getElementById('prd-id').value=productId||'';
  document.getElementById('prd-name').value=p?.name||'';
  document.getElementById('prd-sku').value=p?.sku||'';
  document.getElementById('prd-cat').value=p?.category||'';
  document.getElementById('prd-price').value=p?parseFloat(p.price).toFixed(2):'';
  document.getElementById('prd-override').value=p?.pts_override!=null?p.pts_override:'';
  document.getElementById('prd-active').value=p?(p.active?'1':'0'):'1';
  openModal('product');
}
function saveProduct() {
  if(!guardConfig()) return;
  const name=document.getElementById('prd-name').value.trim();
  const price=parseFloat(document.getElementById('prd-price').value);
  if(!name){alert('Product name required.');return;}
  if(!price||price<0){alert('Enter a valid price.');return;}
  const overrideVal=document.getElementById('prd-override').value.trim();
  const id=document.getElementById('prd-id').value||dbGenProdId(vid());
  const result = dbUpsertProduct(vid(),{product_id:id,name,sku:document.getElementById('prd-sku').value.trim(),
    category:document.getElementById('prd-cat').value.trim(),price,
    pts_override:overrideVal!==''?parseFloat(overrideVal):null,
    active:document.getElementById('prd-active').value==='1'?1:0});
  if (result.error) { alert(result.error); return; }
  closeModal('product'); renderProducts(); populateProductSelect();
}
function deleteProduct(productId) {
  if(!guardConfig()) return;
  if(!confirm('Delete this product?')) return;
  dbDeleteProduct(vid(),productId); renderProducts(); populateProductSelect();
}

/* ══════════════════════════════════════════ TEAM ══════════════════════════════════════════ */
function renderTeam() {
  const users=dbGetVendorUsers(vid());
  const tbody=document.getElementById('team-tbody'); if(!tbody) return;
  tbody.innerHTML=users.map(u=>{
    const isOwner=u.role==='owner';
    const colors={owner:'#15803d',admin:'#1d4ed8',readonly:'#64748b'};
    const bgs   ={owner:'#f0fdf4',admin:'#eff6ff',readonly:'#f1f5f9'};
    return `<tr>
      <td class="txn-id">${u.user_id}</td>
      <td style="font-weight:500">${u.name}</td>
      <td style="color:#64748b">${u.email}</td>
      <td>
        ${isOwner?`<span class="status-badge" style="background:${bgs.owner};color:${colors.owner}">owner</span>`
          :`<select style="font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid #e2e8f0" onchange="changeUserRole('${u.user_id}',this.value)">
              <option value="admin" ${u.role==='admin'?'selected':''}>admin</option>
              <option value="readonly" ${u.role==='readonly'?'selected':''}>readonly</option>
            </select>`}
      </td>
      <td>${new Date(u.created_at).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'})}</td>
      <td>${!isOwner?`<button class="btn-return" onclick="removeUser('${u.user_id}')">Remove</button>`:'—'}</td>
    </tr>`;
  }).join('');
}
function changeUserRole(userId,role) {
  dbUpdateVendorUserRole(vid(),userId,role);
  renderTeam();
}
async function removeUser(userId) {
  const r=dbDeleteVendorUser(vid(),userId);
  if(r.error){alert(r.error);return;}
  renderTeam();
}
async function inviteUser() {
  if(!guardConfig()) return;
  const name=document.getElementById('inv-name').value.trim();
  const email=document.getElementById('inv-email').value.trim();
  const pw   =document.getElementById('inv-password').value;
  const role =document.getElementById('inv-role').value;
  const errEl=document.getElementById('inv-error'); errEl.style.display='none';
  if(!name||!email||!pw){errEl.textContent='All fields required.';errEl.style.display='block';return;}
  if(pw.length<6){errEl.textContent='Password min 6 characters.';errEl.style.display='block';return;}
  const r=await dbCreateVendorUser(vid(),{name,email,password:pw,role});
  if(r.error){errEl.textContent=r.error;errEl.style.display='block';return;}
  ['inv-name','inv-email','inv-password'].forEach(id=>document.getElementById(id).value='');
  closeModal('invite-user');
  renderTeam();
  alert(`User added!\nID: ${r.userId}\nName: ${name}\nRole: ${role}`);
}

/* ══════════════════════════════════════════ CONFIG ══════════════════════════════════════════ */
function renderConfig() {
  const cfg=dbGetConfig(vid()), tiers=dbGetTiers(vid()), modes=dbGetModes(vid());
  const pol=cfg.reset_policy||'calendar';
  document.getElementById('r-'+pol).checked=true;
  ['calendar','rolling'].forEach(k=>{
    document.getElementById('pol-'+k).classList.toggle('active',k===pol);
    document.getElementById('check-'+k).style.visibility=k===pol?'visible':'hidden';
  });
  renderTiersEditor(tiers); renderModesEditor(modes);
}
function setResetPolicy(p) {
  if(!guardConfig()) return;
  dbSetConfig(vid(),'reset_policy',p);
  document.getElementById('r-'+p).checked=true;
  ['calendar','rolling'].forEach(k=>{document.getElementById('pol-'+k).classList.toggle('active',k===p);document.getElementById('check-'+k).style.visibility=k===p?'visible':'hidden';});
  document.getElementById('policy-notice').innerHTML={calendar:'Active: <strong>Calendar year reset</strong>',rolling:'Active: <strong>Rolling 365-day window</strong>'}[p];
  renderDashboard();
}
function renderTiersEditor(tiers) {
  document.getElementById('tiers-editor').innerHTML=tiers.map((t,i)=>`
    <div class="tier-editor-row" id="tier-row-${t.id}">
      <div class="tier-editor-handle">≡</div>
      <div class="tier-editor-preview"><span class="status-badge" style="background:${t.bg_color};color:${t.color}" id="tier-prev-${t.id}">${t.name}</span></div>
      <div class="tier-editor-fields">
        <div class="tier-field-group"><label>Name</label><input type="text" value="${t.name}" onchange="tierFieldChange('${t.id}','name',this.value)"/></div>
        <div class="tier-field-group"><label>Min spend ($)</label><input type="number" value="${t.min_spend}" min="0" ${i===0?'disabled':''} onchange="tierFieldChange('${t.id}','min_spend',this.value)"/></div>
        <div class="tier-field-group"><label>Text color</label><div class="color-input-wrap">
          <input type="color" value="${t.color}" id="cp-color-${t.id}" onchange="tierColorSync('${t.id}','color',this.value)"/>
          <input type="text"  value="${t.color}" id="ct-color-${t.id}" onchange="tierColorSync('${t.id}','color',this.value)" style="width:76px"/>
        </div></div>
        <div class="tier-field-group"><label>Background</label><div class="color-input-wrap">
          <input type="color" value="${t.bg_color}" id="cp-bg-${t.id}" onchange="tierColorSync('${t.id}','bg_color',this.value)"/>
          <input type="text"  value="${t.bg_color}" id="ct-bg-${t.id}" onchange="tierColorSync('${t.id}','bg_color',this.value)" style="width:76px"/>
        </div></div>
      </div>
      <button class="btn-delete-tier" onclick="deleteTier('${t.id}')">✕</button>
    </div>`).join('');
}
function tierFieldChange(id,field,value) {
  if(!guardConfig()) return;
  const tier=dbGetTiers(vid()).find(t=>t.id===id); if(!tier) return;
  dbUpsertTier(vid(),{...tier,[field]:field==='min_spend'?parseFloat(value)||0:value});
  if(field==='name'){const p=document.getElementById(`tier-prev-${id}`);if(p)p.textContent=value;}
  renderDashboard();
}
function tierColorSync(id,field,value) {
  if(!guardConfig()) return;
  const tier=dbGetTiers(vid()).find(t=>t.id===id); if(!tier) return;
  dbUpsertTier(vid(),{...tier,[field]:value});
  const prev=document.getElementById(`tier-prev-${id}`);
  if(prev){if(field==='color')prev.style.color=value;else prev.style.background=value;}
  document.getElementById(`cp-${field==='color'?'color':'bg'}-${id}`).value=value;
  document.getElementById(`ct-${field==='color'?'color':'bg'}-${id}`).value=value;
  renderDashboard();
}
function addTier() {
  if(!guardConfig()) return;
  const tiers=dbGetTiers(vid());
  dbUpsertTier(vid(),{id:'tier_'+Date.now(),name:'New Tier',min_spend:Math.max(...tiers.map(t=>t.min_spend),0)+100,color:'#1e293b',bg_color:'#f1f5f9',sort_order:Math.max(...tiers.map(t=>t.sort_order),0)+1});
  renderTiersEditor(dbGetTiers(vid())); renderDashboard();
}
function deleteTier(id) {
  if(!guardConfig()) return;
  const r=dbDeleteTier(vid(),id); if(r.error){alert(r.error);return;}
  renderTiersEditor(dbGetTiers(vid())); renderDashboard();
}
function renderModesEditor(modes) {
  const wrap=document.getElementById('modes-editor'); if(!wrap) return;
  wrap.innerHTML=modes.map(m=>`
    <div class="tier-editor-row" style="${m.is_active?'border-color:#4F46E5;background:#eef2ff':''}">
      <div class="tier-editor-preview">${m.is_active?'<span class="pts-pill earn" style="font-size:10px">Active</span>':'<span style="font-size:11px;color:#94a3b8">Inactive</span>'}</div>
      <div class="tier-editor-fields">
        <div class="tier-field-group"><label>Mode name</label><input type="text" value="${m.label}" onchange="modeFieldChange('${m.mode_id}','label',this.value)"/></div>
        <div class="tier-field-group"><label>Regular ×</label><input type="number" value="${m.reg_mult}" min="0.1" step="0.5" style="width:80px" onchange="modeFieldChange('${m.mode_id}','reg_mult',this.value)"/></div>
        <div class="tier-field-group"><label>Special ×</label><input type="number" value="${m.spl_mult}" min="0.1" step="0.5" style="width:80px" onchange="modeFieldChange('${m.mode_id}','spl_mult',this.value)"/></div>
        <div class="tier-field-group"><label>&nbsp;</label><button class="btn-view" style="width:auto;padding:7px 14px" onclick="dbActivateMode(vid(),'${m.mode_id}');renderConfig();buildModeButtons();renderDashboard()">${m.is_active?'✓ Active':'Set active'}</button></div>
      </div>
      <button class="btn-delete-tier" onclick="deleteMode('${m.mode_id}')">✕</button>
    </div>`).join('');
}
function modeFieldChange(id,field,value) {
  if(!guardConfig()) return;
  const m=dbGetModes(vid()).find(x=>x.mode_id===id); if(!m) return;
  dbUpsertMode(vid(),{...m,[field]:field==='label'?value:parseFloat(value)||1});
  buildModeButtons(); renderDashboard();
}
function addMode() {
  if(!guardConfig()) return;
  const modes=dbGetModes(vid()), id=dbGenModeId(vid());
  dbUpsertMode(vid(),{mode_id:id,label:'New Mode',reg_mult:2,spl_mult:3,is_active:0,sort_order:Math.max(...modes.map(m=>m.sort_order),0)+1});
  renderModesEditor(dbGetModes(vid()));
}
function deleteMode(id) {
  if(!guardConfig()) return;
  const r=dbDeleteMode(vid(),id); if(r.error){alert(r.error);return;}
  renderModesEditor(dbGetModes(vid())); buildModeButtons(); renderDashboard();
}

/* ══════════════════════════════════════════
   API KEYS TAB
══════════════════════════════════════════ */
function renderApiKeys() {
  if(!document.getElementById('nav-api')) return;
  const keys=dbGetApiKeys(vid());
  const empty=document.getElementById('api-empty'), table=document.getElementById('api-table');
  if(!keys.length){if(empty)empty.style.display='flex';if(table)table.style.display='none';}
  else{if(empty)empty.style.display='none';if(table)table.style.display='table';}
  const tbody=document.getElementById('api-tbody'); if(!tbody) return;
  tbody.innerHTML=keys.map(k=>`<tr>
    <td class="txn-id">${k.key_id}</td>
    <td style="font-weight:500">${k.label}</td>
    <td><code class="api-key-display" id="key-${k.key_id}">${k.active?'\u2022'.repeat(20):k.api_key}</code>
      ${k.active?`<button class="btn-icon" onclick="toggleKeyReveal('${k.key_id}','${k.api_key}')">👁</button>`:''}
      ${k.active?`<button class="btn-icon" onclick="copyKey('${k.api_key}')" title="Copy">⧉</button>`:''}
    </td>
    <td><span class="status-badge" style="background:${k.active?'#f0fdf4':'#fef2f2'};color:${k.active?'#15803d':'#b91c1c'}">${k.active?'Active':'Revoked'}</span></td>
    <td style="color:#64748b;font-size:12px">${new Date(k.created_at).toLocaleDateString()}</td>
    <td style="color:#64748b;font-size:12px">${k.last_used?new Date(k.last_used).toLocaleDateString():'Never'}</td>
    <td style="display:flex;gap:6px">
      ${k.active?`<button class="btn-return" onclick="revokeKey('${k.key_id}')">Revoke</button>`:''}
      <button class="btn-return" onclick="deleteKey('${k.key_id}')">Delete</button>
    </td>
  </tr>`).join('');
}
function toggleKeyReveal(keyId,apiKey){
  const el=document.getElementById(`key-${keyId}`);
  el.textContent=el.textContent.includes('\u2022')?apiKey:'\u2022'.repeat(20);
}
function copyKey(apiKey){
  navigator.clipboard.writeText(apiKey).then(()=>alert('Copied!')).catch(()=>alert(`Key: ${apiKey}`));
}
function createApiKey(){
  if(!guardConfig()) return;
  const label=document.getElementById('api-key-label').value.trim()||'API Key';
  const result=dbCreateApiKey(vid(),label);
  document.getElementById('api-key-label').value='';
  closeModal('create-api-key');
  renderApiKeys();
  alert(`API key created!\n\nKey: ${result.apiKey}\n\nCopy it now — you can reveal it again from the table.`);
}
function revokeKey(keyId){
  if(!confirm('Revoke this key? Integrations using it will break.')) return;
  dbRevokeApiKey(vid(),keyId); renderApiKeys();
}
function deleteKey(keyId){
  if(!confirm('Delete this key permanently?')) return;
  dbDeleteApiKey(vid(),keyId); renderApiKeys();
}
function runApiPlayground(){
  const apiKey=document.getElementById('pg-key').value.trim();
  const method=document.getElementById('pg-method').value;
  const path=document.getElementById('pg-path').value.trim();
  const bodyRaw=document.getElementById('pg-body').value.trim();
  let body={};
  if(bodyRaw){try{body=JSON.parse(bodyRaw);}catch(e){document.getElementById('pg-result').textContent='Invalid JSON: '+e.message;return;}}
  const result=loyaltyApi(method,path,body,apiKey);
  document.getElementById('pg-result').textContent=JSON.stringify(result,null,2);
}

/* ══════════════════════════════════════════ ADMIN PANEL ══════════════════════════════════════════ */
function showAdminDashboard() {
  document.getElementById('auth-layer').style.display  ='none';
  document.getElementById('app-layer').style.display   ='none';
  document.getElementById('admin-layer').style.display ='flex';
  renderAdminPanel();
}
async function adminCreateVendor() {
  const name=document.getElementById('av-name').value.trim();
  const email=document.getElementById('av-email').value.trim();
  const pw  =document.getElementById('av-password').value;
  const conf=document.getElementById('av-confirm').value;
  const errEl=document.getElementById('av-error'); errEl.style.display='none';
  if(!name||!email||!pw){errEl.textContent='All fields required.';errEl.style.display='block';return;}
  if(pw.length<6){errEl.textContent='Password min 6 chars.';errEl.style.display='block';return;}
  if(pw!==conf){errEl.textContent='Passwords do not match.';errEl.style.display='block';return;}
  const btn=document.getElementById('av-submit-btn'); btn.textContent='Creating…'; btn.disabled=true;
  const r=await dbRegisterVendor({name,email,password:pw});
  btn.textContent='Create vendor'; btn.disabled=false;
  if(r.error){errEl.textContent=r.error;errEl.style.display='block';return;}
  ['av-name','av-email','av-password','av-confirm'].forEach(id=>document.getElementById(id).value='');
  closeModal('create-vendor'); renderAdminPanel();
  alert(`Vendor created!\nVendor ID: ${r.vendorId}\nName: ${name}`);
}
function renderAdminPanel() {
  const vendors=dbAdminGetVendors();
  document.getElementById('admin-vendor-count').textContent=vendors.length;
  let tc=0,tt=0,tr=0;
  vendors.forEach(v=>{const s=dbAdminGetVendorStats(v.vendor_id);tc+=s.customers;tt+=s.transactions;tr+=s.revenue;});
  document.getElementById('admin-total-customers').textContent=tc.toLocaleString();
  document.getElementById('admin-total-txns').textContent=tt.toLocaleString();
  document.getElementById('admin-total-revenue').textContent='$'+tr.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const emptyEl=document.getElementById('admin-vendor-empty'), listEl=document.getElementById('admin-vendor-list');
  if(emptyEl) emptyEl.style.display=vendors.length?'none':'flex';
  if(listEl)  listEl.style.display =vendors.length?'table':'none';
  document.getElementById('admin-vendor-table').innerHTML=vendors.map(v=>{
    const s=dbAdminGetVendorStats(v.vendor_id);
    const date=new Date(v.created_at).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});
    return `<tr>
      <td><span class="cid-pill">${v.vendor_id}</span></td>
      <td style="font-weight:500">${v.name}</td>
      <td style="color:#64748b">${v.email}</td>
      <td>${date}</td>
      <td>${s.customers}</td><td>${s.transactions}</td>
      <td>$${parseFloat(s.revenue).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td>${s.pointsIssued.toLocaleString()}</td>
      <td><span class="status-badge" style="background:${v.suspended?'#fef2f2':'#f0fdf4'};color:${v.suspended?'#b91c1c':'#15803d'}">${v.suspended?'Suspended':'Active'}</span></td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn-view" onclick="adminInspectVendor('${v.vendor_id}')">Inspect →</button>
        <button class="btn-return" onclick="adminToggleSuspend('${v.vendor_id}',${v.suspended})">${v.suspended?'Unsuspend':'Suspend'}</button>
      </td>
    </tr>`;
  }).join('');
}
function adminInspectVendor(vendorId) {
  const v=dbAdminGetVendors().find(x=>x.vendor_id===vendorId); if(!v) return;
  showVendorApp({vendor_id:v.vendor_id,name:v.name,email:v.email});
}
function adminToggleSuspend(vendorId,currently) {
  if(!confirm(`${currently?'Unsuspend':'Suspend'} this vendor?`)) return;
  dbAdminSuspendVendor(vendorId,!currently); renderAdminPanel();
}
