/**
 * db.js — SQLite via sql.js, multi-tenant + roles + appeasement
 *
 * Tables:
 *   vendors           global
 *   vendor_users      team members per vendor: { vendor_id, user_id, name, email, password_hash, role }
 *                     role = 'owner' | 'admin' | 'readonly'
 *   config            k/v per vendor
 *   tiers             per vendor
 *   multiplier_modes  per vendor
 *   products          per vendor
 *   customers         per vendor — adds status_override TEXT (tier id or null)
 *   transactions      per vendor — type: 'earn' | 'deduct' | 'appeasement'
 *
 * Platform admin: hardcoded admin@loyaltyos.com / admin1234
 * Vendor owner:   created via dbRegisterVendor or adminCreateVendor
 * Vendor admin/readonly: created by owner via dbCreateVendorUser
 *
 * Role permissions:
 *   readonly  — read all data, no writes
 *   admin     — read + write customers/transactions/appeasement, override status; no config/tiers/modes/products
 *   owner     — full access
 */

let _db = null;

async function dbInit() {
  window._ADMIN_PASS_HASH = await _sha256('admin1234');

  const SQL = await initSqlJs({
    locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
  });
  _db = new SQL.Database();

  _db.run(`
    CREATE TABLE IF NOT EXISTS vendors (
      vendor_id     TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      created_at    INT  NOT NULL,
      suspended     INT  NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vendor_users (
      vendor_id     TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'readonly',
      created_at    INT  NOT NULL,
      PRIMARY KEY (vendor_id, user_id),
      UNIQUE (vendor_id, email)
    );
    CREATE TABLE IF NOT EXISTS config (
      vendor_id TEXT NOT NULL,
      key       TEXT NOT NULL,
      value     TEXT NOT NULL,
      PRIMARY KEY (vendor_id, key)
    );
    CREATE TABLE IF NOT EXISTS tiers (
      vendor_id  TEXT NOT NULL,
      id         TEXT NOT NULL,
      name       TEXT NOT NULL,
      min_spend  REAL NOT NULL DEFAULT 0,
      color      TEXT NOT NULL DEFAULT '#1d4ed8',
      bg_color   TEXT NOT NULL DEFAULT '#eff6ff',
      sort_order INT  NOT NULL DEFAULT 0,
      PRIMARY KEY (vendor_id, id)
    );
    CREATE TABLE IF NOT EXISTS multiplier_modes (
      vendor_id   TEXT NOT NULL,
      mode_id     TEXT NOT NULL,
      label       TEXT NOT NULL,
      reg_mult    REAL NOT NULL DEFAULT 1,
      spl_mult    REAL NOT NULL DEFAULT 1,
      is_active   INT  NOT NULL DEFAULT 0,
      sort_order  INT  NOT NULL DEFAULT 0,
      PRIMARY KEY (vendor_id, mode_id)
    );
    CREATE TABLE IF NOT EXISTS products (
      vendor_id    TEXT NOT NULL,
      product_id   TEXT NOT NULL,
      name         TEXT NOT NULL,
      sku          TEXT,
      category     TEXT,
      price        REAL NOT NULL DEFAULT 0,
      pts_override REAL,
      active       INT  NOT NULL DEFAULT 1,
      PRIMARY KEY (vendor_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS customers (
      vendor_id        TEXT NOT NULL,
      customer_id      TEXT NOT NULL,
      first_name       TEXT NOT NULL,
      last_name        TEXT NOT NULL,
      email            TEXT,
      phone            TEXT,
      points_tier      TEXT NOT NULL DEFAULT 'regular',
      points_earned    INT  NOT NULL DEFAULT 0,
      points_deducted  INT  NOT NULL DEFAULT 0,
      registered_at    INT  NOT NULL,
      status_override  TEXT,
      PRIMARY KEY (vendor_id, customer_id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      vendor_id    TEXT NOT NULL,
      txn_id       TEXT NOT NULL,
      date         TEXT NOT NULL,
      ts           INT  NOT NULL,
      customer_id  TEXT,
      cust_name    TEXT,
      points_tier  TEXT,
      order_type   TEXT NOT NULL,
      product_id   TEXT,
      product_name TEXT,
      description  TEXT,
      unit_price   REAL NOT NULL DEFAULT 0,
      quantity     INT  NOT NULL DEFAULT 1,
      amount       REAL NOT NULL DEFAULT 0,
      multiplier   REAL NOT NULL DEFAULT 1,
      points       INT  NOT NULL DEFAULT 0,
      qty_returned INT  NOT NULL DEFAULT 0,
      type         TEXT NOT NULL,
      ref_id       TEXT,
      returned     INT  NOT NULL DEFAULT 0,
      created_by   TEXT,
      PRIMARY KEY (vendor_id, txn_id)
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      vendor_id   TEXT NOT NULL,
      key_id      TEXT NOT NULL,
      api_key     TEXT NOT NULL UNIQUE,
      label       TEXT NOT NULL,
      created_at  INT  NOT NULL,
      last_used   INT,
      active      INT  NOT NULL DEFAULT 1,
      PRIMARY KEY (vendor_id, key_id)
    );
    -- partial unique index: only enforce when sku is non-empty
    CREATE UNIQUE INDEX IF NOT EXISTS uq_product_sku
      ON products (vendor_id, sku)
      WHERE sku IS NOT NULL AND sku != '';
  `);

  // Seed demo data only if no vendors exist yet
  const vendorCount = _scalar(`SELECT COUNT(*) FROM vendors`) || 0;
  if (vendorCount === 0) {
    await _seedDemoData();
  }
}

/* ─── helpers ─── */
function _exec(sql, p=[]) { _db.run(sql, p); }
function _query(sql, p=[]) {
  const s=_db.prepare(sql), rows=[];
  s.bind(p); while(s.step()) rows.push(s.getAsObject()); s.free();
  return rows;
}
function _scalar(sql, p=[]) {
  const r=_query(sql,p); return r.length ? Object.values(r[0])[0] : null;
}
async function _sha256(plain) {
  const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function _setConfig(v,k,val) {
  _exec(`INSERT INTO config(vendor_id,key,value) VALUES(?,?,?)
         ON CONFLICT(vendor_id,key) DO UPDATE SET value=excluded.value`, [v,k,String(val)]);
}

/* ─── demo seed data ─── */
async function _seedDemoData() {
  const now = Date.now();
  const jun14 = new Date('2026-06-14').getTime();

  // passwords: tcp1@yopmail.com → "tcp1234", gym1@yopmail.com → "gym1234"
  const tcpHash = await _sha256('tcp1234');
  const gymHash = await _sha256('gym1234');

  // ── Vendor 1: TCP ──
  const V1 = 'VND-0001';
  _exec(`INSERT INTO vendors VALUES (?,?,?,?,0)`, [V1, 'TCP', 'tcp1@yopmail.com', jun14]);
  _exec(`INSERT INTO vendor_users VALUES (?,?,?,?,?,?,?)`,
    [V1, 'USR-0001', 'TCP', 'tcp1@yopmail.com', tcpHash, 'owner', jun14]);
  _seedVendorDefaults(V1);
  _setConfig(V1, 'cust_counter', '3');
  _setConfig(V1, 'prod_counter', '4');

  // TCP customers
  // CUST-0001 — regular, Basic (no override)
  _exec(`INSERT INTO customers VALUES (?,?,?,?,?,?,?,0,0,?,?)`,
    [V1,'CUST-0001','Test','User1','testuser1@yopmail.com','','regular',jun14,null]);
  // CUST-0002 — special, Icon (override = icon tier)
  _exec(`INSERT INTO customers VALUES (?,?,?,?,?,?,?,0,0,?,?)`,
    [V1,'CUST-0002','Test','User2','testuser2@yopmail.com','','special',jun14,'icon']);
  // CUST-0003 — regular, Basic
  _exec(`INSERT INTO customers VALUES (?,?,?,?,?,?,?,0,0,?,?)`,
    [V1,'CUST-0003','Test','User3','testuser3@yopmail.com','','regular',jun14,null]);

  // TCP products
  [
    [V1,'PROD-0001','Boys Shorts',  'SKU-001','Boys', 3.99, null, 1],
    [V1,'PROD-0002','Boys T-shirts','SKU-002','Boys', 5.99, null, 1],
    [V1,'PROD-0003','Girls Shorts', 'SKU-003','Girls',4.99, null, 1],
    [V1,'PROD-0004','Girls T-shirts','SKU-004','Girls',6.99,null, 1],
  ].forEach(r => _exec(
    `INSERT INTO products(vendor_id,product_id,name,sku,category,price,pts_override,active) VALUES(?,?,?,?,?,?,?,?)`, r));

  // ── Vendor 2: GYM ──
  const V2 = 'VND-0002';
  _exec(`INSERT INTO vendors VALUES (?,?,?,?,0)`, [V2, 'GYM', 'gym1@yopmail.com', jun14]);
  _exec(`INSERT INTO vendor_users VALUES (?,?,?,?,?,?,?)`,
    [V2, 'USR-0001', 'GYM', 'gym1@yopmail.com', gymHash, 'owner', jun14]);
  _seedVendorDefaults(V2);

  // bump vendor counter so next admin-created vendor starts at VND-0003
  // (vendors table COUNT is used at registration time, so insert a placeholder config)
}


async function dbAdminLogin({ email, password }) {
  if (email.toLowerCase() !== 'admin@loyaltyos.com') return { error: 'Not an admin account.' };
  const hash = await _sha256(password);
  if (hash !== window._ADMIN_PASS_HASH) return { error: 'Incorrect admin password.' };
  return { ok:true, admin:{ role:'platform_admin', email:'admin@loyaltyos.com', name:'Platform Admin' } };
}

/* ─── vendor registration (creates owner user) ─── */
async function dbRegisterVendor({ name, email, password }) {
  if (email.toLowerCase()==='admin@loyaltyos.com') return { error:'This email is reserved.' };
  if (_scalar(`SELECT vendor_id FROM vendor_users WHERE email=?`,[email.toLowerCase()]))
    return { error:'An account with this email already exists.' };

  const hash     = await _sha256(password);
  const count    = _scalar(`SELECT COUNT(*) FROM vendors`)||0;
  const vendorId = 'VND-'+String(count+1).padStart(4,'0');
  const userId   = 'USR-'+String(1).padStart(4,'0');

  _exec(`INSERT INTO vendors VALUES (?,?,?,?,0)`, [vendorId, name, email.toLowerCase(), Date.now()]);
  _exec(`INSERT INTO vendor_users VALUES (?,?,?,?,?,?,?)`,
    [vendorId, userId, name, email.toLowerCase(), hash, 'owner', Date.now()]);

  _seedVendorDefaults(vendorId);
  return { ok:true, vendorId };
}

function _seedVendorDefaults(vendorId) {
  [['reset_policy','calendar'],['cust_counter','0'],['txn_counter','0'],
   ['prod_counter','0'],['mode_counter','0'],['user_counter','1']]
    .forEach(([k,v]) => _setConfig(vendorId, k, v));
  [[vendorId,'basic','Basic',0,'#1d4ed8','#eff6ff',1],
   [vendorId,'star','Star',75,'#b45309','#fffbeb',2],
   [vendorId,'icon','Icon',300,'#5b21b6','#f5f3ff',3]]
    .forEach(r => _exec(`INSERT INTO tiers VALUES (?,?,?,?,?,?,?)`, r));
  [[vendorId,'mode_std','Standard (1×)',1,1,1,1],
   [vendorId,'mode_dbl','Double Points (2×)',2,2,0,2],
   [vendorId,'mode_spl','Reg 1× / Spl 2×',1,2,0,3]]
    .forEach(r => _exec(`INSERT INTO multiplier_modes VALUES (?,?,?,?,?,?,?)`, r));
}

/* ─── vendor user login ─── */
async function dbLoginVendor({ email, password }) {
  const row = _query(`SELECT vu.*, v.name as vendor_name, v.suspended
    FROM vendor_users vu JOIN vendors v ON v.vendor_id=vu.vendor_id
    WHERE vu.email=?`, [email.toLowerCase()])[0];
  if (!row) return { error:'No account found with that email.' };
  if (row.suspended) return { error:'This vendor account has been suspended.' };
  const hash = await _sha256(password);
  if (hash !== row.password_hash) return { error:'Incorrect password.' };
  return { ok:true, vendor:{
    vendorId: row.vendor_id, name: row.vendor_name, email: row.email,
    userId: row.user_id, userName: row.name, role: row.role
  }};
}

/* ─── vendor user management ─── */
function dbGetVendorUsers(vendorId) {
  return _query(`SELECT * FROM vendor_users WHERE vendor_id=? ORDER BY created_at`,[vendorId]);
}
async function dbCreateVendorUser(vendorId, { name, email, password, role }) {
  if (_scalar(`SELECT user_id FROM vendor_users WHERE vendor_id=? AND email=?`,[vendorId,email.toLowerCase()]))
    return { error:'A user with this email already exists for this vendor.' };
  const n = parseInt(_scalar(`SELECT value FROM config WHERE vendor_id=? AND key='user_counter'`,[vendorId])||'1')+1;
  _setConfig(vendorId,'user_counter',n);
  const userId = 'USR-'+String(n).padStart(4,'0');
  const hash   = await _sha256(password);
  _exec(`INSERT INTO vendor_users VALUES (?,?,?,?,?,?,?)`,
    [vendorId, userId, name, email.toLowerCase(), hash, role, Date.now()]);
  return { ok:true, userId };
}
function dbUpdateVendorUserRole(vendorId, userId, role) {
  _exec(`UPDATE vendor_users SET role=? WHERE vendor_id=? AND user_id=?`,[role,vendorId,userId]);
}
function dbDeleteVendorUser(vendorId, userId) {
  // can't delete the owner
  const u=_query(`SELECT role FROM vendor_users WHERE vendor_id=? AND user_id=?`,[vendorId,userId])[0];
  if (!u) return {error:'User not found.'};
  if (u.role==='owner') return {error:'Cannot remove the owner account.'};
  _exec(`DELETE FROM vendor_users WHERE vendor_id=? AND user_id=?`,[vendorId,userId]);
  return {ok:true};
}

/* ─── ID generators ─── */
function _nextId(v,counter,prefix,pad) {
  const n=parseInt(_scalar(`SELECT value FROM config WHERE vendor_id=? AND key=?`,[v,counter])||'0')+1;
  _setConfig(v,counter,n);
  return prefix+String(n).padStart(pad,'0');
}
function dbGenCustId(v)  { return _nextId(v,'cust_counter','CUST-',4); }
function dbGenTxnId(v)   { return _nextId(v,'txn_counter','TXN-',5); }
function dbGenProdId(v)  { return _nextId(v,'prod_counter','PROD-',4); }
function dbGenModeId(v)  { return _nextId(v,'mode_counter','MODE-',3); }

/* ─── config ─── */
function dbGetConfig(v) {
  return Object.fromEntries(_query(`SELECT key,value FROM config WHERE vendor_id=?`,[v]).map(r=>[r.key,r.value]));
}
function dbSetConfig(v,k,val) { _setConfig(v,k,val); }

/* ─── tiers ─── */
function dbGetTiers(v) { return _query(`SELECT * FROM tiers WHERE vendor_id=? ORDER BY sort_order,min_spend`,[v]); }
function dbUpsertTier(v,t) {
  _exec(`INSERT INTO tiers(vendor_id,id,name,min_spend,color,bg_color,sort_order) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(vendor_id,id) DO UPDATE SET name=excluded.name,min_spend=excluded.min_spend,
         color=excluded.color,bg_color=excluded.bg_color,sort_order=excluded.sort_order`,
    [v,t.id,t.name,t.min_spend,t.color,t.bg_color,t.sort_order]);
}
function dbDeleteTier(v,id) {
  if(_scalar(`SELECT COUNT(*) FROM tiers WHERE vendor_id=?`,[v])<=1) return {error:'Cannot delete the last tier.'};
  _exec(`DELETE FROM tiers WHERE vendor_id=? AND id=?`,[v,id]);
  return {ok:true};
}

/* ─── multiplier modes ─── */
function dbGetModes(v) { return _query(`SELECT * FROM multiplier_modes WHERE vendor_id=? ORDER BY sort_order`,[v]); }
function dbGetActiveMode(v) { return _query(`SELECT * FROM multiplier_modes WHERE vendor_id=? AND is_active=1`,[v])[0]||null; }
function dbUpsertMode(v,m) {
  _exec(`INSERT INTO multiplier_modes(vendor_id,mode_id,label,reg_mult,spl_mult,is_active,sort_order) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(vendor_id,mode_id) DO UPDATE SET label=excluded.label,reg_mult=excluded.reg_mult,
         spl_mult=excluded.spl_mult,is_active=excluded.is_active,sort_order=excluded.sort_order`,
    [v,m.mode_id,m.label,m.reg_mult,m.spl_mult,m.is_active?1:0,m.sort_order]);
}
function dbActivateMode(v,modeId) {
  _exec(`UPDATE multiplier_modes SET is_active=0 WHERE vendor_id=?`,[v]);
  _exec(`UPDATE multiplier_modes SET is_active=1 WHERE vendor_id=? AND mode_id=?`,[v,modeId]);
}
function dbDeleteMode(v,id) {
  if(_scalar(`SELECT COUNT(*) FROM multiplier_modes WHERE vendor_id=?`,[v])<=1) return {error:'Cannot delete the last mode.'};
  _exec(`DELETE FROM multiplier_modes WHERE vendor_id=? AND mode_id=?`,[v,id]);
  if(!dbGetActiveMode(v)){
    const f=_query(`SELECT mode_id FROM multiplier_modes WHERE vendor_id=? ORDER BY sort_order LIMIT 1`,[v])[0];
    if(f) _exec(`UPDATE multiplier_modes SET is_active=1 WHERE vendor_id=? AND mode_id=?`,[v,f.mode_id]);
  }
  return {ok:true};
}

/* ─── products ─── */
function dbGetProducts(v,activeOnly=false) {
  return _query(`SELECT * FROM products WHERE vendor_id=? ${activeOnly?'AND active=1':''} ORDER BY category,name`,[v]);
}
function dbGetProduct(v,id) { return _query(`SELECT * FROM products WHERE vendor_id=? AND product_id=?`,[v,id])[0]||null; }
function dbUpsertProduct(v,p) {
  // SKU uniqueness check (skip if SKU is blank)
  if (p.sku && p.sku.trim() !== '') {
    const conflict = _scalar(
      `SELECT product_id FROM products WHERE vendor_id=? AND sku=? AND product_id!=?`,
      [v, p.sku.trim(), p.product_id || '']
    );
    if (conflict) return { error: `SKU "${p.sku}" is already used by another product.` };
  }
  _exec(`INSERT INTO products(vendor_id,product_id,name,sku,category,price,pts_override,active) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(vendor_id,product_id) DO UPDATE SET name=excluded.name,sku=excluded.sku,category=excluded.category,
         price=excluded.price,pts_override=excluded.pts_override,active=excluded.active`,
    [v,p.product_id,p.name,p.sku||'',p.category||'',p.price,p.pts_override??null,p.active??1]);
  return { ok: true };
}
function dbDeleteProduct(v,id) { _exec(`DELETE FROM products WHERE vendor_id=? AND product_id=?`,[v,id]); }

/* ─── customers ─── */
function dbInsertCustomer(v,c) {
  _exec(`INSERT INTO customers(vendor_id,customer_id,first_name,last_name,email,phone,points_tier,
         points_earned,points_deducted,registered_at,status_override) VALUES(?,?,?,?,?,?,?,0,0,?,?)`,
    [v,c.customer_id,c.first_name,c.last_name,c.email||'',c.phone||'',c.points_tier,c.registered_at,c.status_override||null]);
}
function dbGetCustomers(v) { return _query(`SELECT * FROM customers WHERE vendor_id=? ORDER BY registered_at DESC`,[v]); }
function dbGetCustomer(v,id) { return _query(`SELECT * FROM customers WHERE vendor_id=? AND customer_id=?`,[v,id])[0]||null; }
function dbUpdateCustomerPoints(v,id,earn,deduct) {
  _exec(`UPDATE customers SET points_earned=points_earned+?,points_deducted=points_deducted+? WHERE vendor_id=? AND customer_id=?`,
    [earn,deduct,v,id]);
}
function dbSetStatusOverride(v,customerId,tierId) {
  // tierId=null clears override (back to spend-based)
  _exec(`UPDATE customers SET status_override=? WHERE vendor_id=? AND customer_id=?`,[tierId||null,v,customerId]);
}

/* ─── transactions ─── */
function dbInsertTransaction(v,t) {
  _exec(`INSERT INTO transactions(vendor_id,txn_id,date,ts,customer_id,cust_name,points_tier,order_type,
         product_id,product_name,description,unit_price,quantity,amount,multiplier,points,qty_returned,type,ref_id,returned,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    [v,t.txn_id,t.date,t.ts,t.customer_id||null,t.cust_name,t.points_tier,t.order_type,
     t.product_id||null,t.product_name||null,t.description,
     t.unit_price||t.amount||0, t.quantity||1, t.amount||0,
     t.multiplier||1,t.points||0, 0,
     t.type,t.ref_id||null,t.created_by||null]);
}
function dbGetTransactions(v,customerId=null) {
  return customerId
    ? _query(`SELECT * FROM transactions WHERE vendor_id=? AND customer_id=? ORDER BY ts DESC`,[v,customerId])
    : _query(`SELECT * FROM transactions WHERE vendor_id=? ORDER BY ts DESC`,[v]);
}
function dbMarkReturned(v,txnId) { _exec(`UPDATE transactions SET returned=1 WHERE vendor_id=? AND txn_id=?`,[v,txnId]); }
function dbMarkPartialReturn(v,txnId,qtyReturned) {
  const t=_query(`SELECT quantity,qty_returned FROM transactions WHERE vendor_id=? AND txn_id=?`,[v,txnId])[0];
  if(!t) return;
  const newQtyReturned=t.qty_returned+qtyReturned;
  const fullyReturned=newQtyReturned>=t.quantity?1:0;
  _exec(`UPDATE transactions SET qty_returned=?,returned=? WHERE vendor_id=? AND txn_id=?`,
    [newQtyReturned,fullyReturned,v,txnId]);
}

/* ─── qualifying spend ─── */
function dbGetQualifyingSpend(v,customerId,resetPolicy) {
  const now=Date.now(), yearStart=new Date(new Date().getFullYear(),0,1).getTime();
  const cutoff=resetPolicy==='calendar'?yearStart:now-365*24*60*60*1000;
  const earned=_scalar(`SELECT COALESCE(SUM(amount),0) FROM transactions
    WHERE vendor_id=? AND customer_id=? AND type='earn' AND order_type='registered' AND ts>=?`,[v,customerId,cutoff])||0;
  const returned=_query(`SELECT orig.amount FROM transactions t
    JOIN transactions orig ON orig.vendor_id=t.vendor_id AND orig.txn_id=t.ref_id
    WHERE t.vendor_id=? AND t.customer_id=? AND t.type='deduct' AND orig.ts>=?`,[v,customerId,cutoff])
    .reduce((s,r)=>s+(r.amount||0),0);
  return Math.max(0, earned-returned);
}

/* ─── admin: cross-vendor ─── */
function dbAdminGetVendors() { return _query(`SELECT * FROM vendors ORDER BY created_at DESC`); }
function dbAdminGetVendorStats(v) {
  return {
    customers:    _scalar(`SELECT COUNT(*) FROM customers WHERE vendor_id=?`,[v])||0,
    transactions: _scalar(`SELECT COUNT(*) FROM transactions WHERE vendor_id=?`,[v])||0,
    pointsIssued: _scalar(`SELECT COALESCE(SUM(points),0) FROM transactions WHERE vendor_id=? AND type IN ('earn','appeasement')`,[v])||0,
    revenue:      _scalar(`SELECT COALESCE(SUM(amount),0) FROM transactions WHERE vendor_id=? AND order_type='registered' AND type='earn'`,[v])||0,
  };
}
function dbAdminSuspendVendor(v,suspended) { _exec(`UPDATE vendors SET suspended=? WHERE vendor_id=?`,[suspended?1:0,v]); }

/* ─── export ─── */
function dbExport(vendorName) {
  const data=_db.export(), blob=new Blob([data],{type:'application/octet-stream'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=`loyaltyos_${(vendorName||'export').replace(/\s+/g,'_').toLowerCase()}.sqlite`;
  a.click(); URL.revokeObjectURL(url);
}

/* ══════════════════════════════════════════
   API KEY MANAGEMENT
══════════════════════════════════════════ */
function dbGetApiKeys(v) {
  return _query(`SELECT key_id,label,api_key,created_at,last_used,active FROM api_keys WHERE vendor_id=? ORDER BY created_at DESC`,[v]);
}
function dbCreateApiKey(v, label) {
  const count=_scalar(`SELECT COUNT(*) FROM api_keys WHERE vendor_id=?`,[v])||0;
  const keyId='KEY-'+String(count+1).padStart(3,'0');
  // generate a random key: loy_ + 32 hex chars
  const raw=Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const apiKey=`loy_${raw}`;
  _exec(`INSERT INTO api_keys(vendor_id,key_id,api_key,label,created_at,last_used,active) VALUES(?,?,?,?,?,null,1)`,
    [v,keyId,apiKey,label||'API Key',Date.now()]);
  return {ok:true, keyId, apiKey};
}
function dbRevokeApiKey(v, keyId) {
  _exec(`UPDATE api_keys SET active=0 WHERE vendor_id=? AND key_id=?`,[v,keyId]);
}
function dbDeleteApiKey(v, keyId) {
  _exec(`DELETE FROM api_keys WHERE vendor_id=? AND key_id=?`,[v,keyId]);
}
function _resolveApiKey(apiKey) {
  // returns vendorId if key is valid and active, else null
  const row=_query(`SELECT vendor_id FROM api_keys WHERE api_key=? AND active=1`,[apiKey])[0];
  if(!row) return null;
  _exec(`UPDATE api_keys SET last_used=? WHERE api_key=?`,[Date.now(),apiKey]);
  return row.vendor_id;
}

/* ══════════════════════════════════════════
   REST API HANDLER
   Call: loyaltyApi(method, path, body, apiKey)
   Returns: { status, body }
══════════════════════════════════════════ */
function loyaltyApi(method, path, body={}, apiKey='') {
  // auth
  const vendorId=_resolveApiKey(apiKey);
  if(!vendorId) return {status:401, body:{error:'Invalid or missing API key.'}};

  const segments=path.replace(/^\/+|\/+$/g,'').split('/');
  // segments[0] = resource e.g. 'customers'
  const resource=segments[0], id=segments[1];

  try {
    /* ── GET /customers ── */
    if(resource==='customers' && method==='GET' && !id) {
      const customers=dbGetCustomers(vendorId).map(c=>_customerView(vendorId,c));
      return {status:200, body:{data:customers, count:customers.length}};
    }
    /* ── GET /customers/:id ── */
    if(resource==='customers' && method==='GET' && id) {
      const c=dbGetCustomer(vendorId,id);
      if(!c) return {status:404, body:{error:'Customer not found.'}};
      return {status:200, body:{data:_customerView(vendorId,c)}};
    }
    /* ── POST /customers ── */
    if(resource==='customers' && method==='POST') {
      const {first_name,last_name,email,phone,points_tier}=body;
      if(!first_name||!last_name) return {status:400, body:{error:'first_name and last_name are required.'}};
      const custId=dbGenCustId(vendorId);
      const ptier=(points_tier==='special')?'special':'regular';
      const statusOverride=ptier==='special'?(dbGetTiers(vendorId).slice(-1)[0]?.id||null):null;
      dbInsertCustomer(vendorId,{
        customer_id:custId, first_name, last_name,
        email:email||'', phone:phone||'', points_tier:ptier,
        registered_at:Date.now(), status_override:statusOverride
      });
      return {status:201, body:{data:_customerView(vendorId,dbGetCustomer(vendorId,custId))}};
    }
    /* ── PATCH /customers/:id ── */
    if(resource==='customers' && method==='PATCH' && id) {
      const c=dbGetCustomer(vendorId,id);
      if(!c) return {status:404, body:{error:'Customer not found.'}};
      const allowed=['first_name','last_name','email','phone','points_tier'];
      const sets=[], vals=[];
      allowed.forEach(f=>{
        if(body[f]!==undefined){ sets.push(`${f}=?`); vals.push(body[f]); }
      });
      if(body.status_override!==undefined){
        sets.push('status_override=?');
        vals.push(body.status_override||null);
      }
      if(!sets.length) return {status:400, body:{error:'No updatable fields provided.'}};
      vals.push(vendorId,id);
      _exec(`UPDATE customers SET ${sets.join(',')} WHERE vendor_id=? AND customer_id=?`,vals);
      return {status:200, body:{data:_customerView(vendorId,dbGetCustomer(vendorId,id))}};
    }
    /* ── GET /transactions ── */
    if(resource==='transactions' && method==='GET' && !id) {
      const custFilter=body.customer_id||null;
      const txns=dbGetTransactions(vendorId,custFilter).map(_txnView);
      return {status:200, body:{data:txns, count:txns.length}};
    }
    /* ── GET /transactions/:id ── */
    if(resource==='transactions' && method==='GET' && id) {
      const txn=dbGetTransactions(vendorId).find(t=>t.txn_id===id);
      if(!txn) return {status:404, body:{error:'Transaction not found.'}};
      return {status:200, body:{data:_txnView(txn)}};
    }
    /* ── POST /transactions ── */
    if(resource==='transactions' && method==='POST') {
      const {customer_id,amount,description,product_id,quantity,order_type}=body;
      if(!customer_id) return {status:400, body:{error:'customer_id is required.'}};
      if(!amount||amount<=0) return {status:400, body:{error:'amount must be a positive number.'}};
      const c=dbGetCustomer(vendorId,customer_id);
      if(!c) return {status:404, body:{error:'Customer not found.'}};
      const qty=Math.max(1,parseInt(quantity)||1);
      let mult=c.points_tier==='special'
        ?(dbGetActiveMode(vendorId)?.spl_mult||1)
        :(dbGetActiveMode(vendorId)?.reg_mult||1);
      let prodId=null, prodName=null;
      if(product_id){
        const p=dbGetProduct(vendorId,product_id);
        if(!p) return {status:404, body:{error:'Product not found.'}};
        prodId=p.product_id; prodName=p.name;
        if(p.pts_override!=null) mult=p.pts_override;
      }
      const unitPrice=parseFloat(amount);
      const totalAmt=parseFloat((unitPrice*qty).toFixed(2));
      const pts=Math.round(totalAmt*mult);
      const txnId=dbGenTxnId(vendorId);
      dbInsertTransaction(vendorId,{
        txn_id:txnId, date:new Date().toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}),
        ts:Date.now(), customer_id, cust_name:`${c.first_name} ${c.last_name}`,
        points_tier:c.points_tier, order_type:order_type||'registered',
        product_id:prodId, product_name:prodName,
        description:description||(prodName||'Purchase')+(qty>1?` (qty:${qty})`:''),
        unit_price:unitPrice, quantity:qty, amount:totalAmt,
        multiplier:mult, points:pts, type:'earn', ref_id:null, created_by:'api'
      });
      dbUpdateCustomerPoints(vendorId,customer_id,pts,0);
      return {status:201, body:{data:_txnView(dbGetTransactions(vendorId).find(t=>t.txn_id===txnId)), points_earned:pts}};
    }
    /* ── GET /points/:customer_id ── */
    if(resource==='points' && method==='GET' && id) {
      const c=dbGetCustomer(vendorId,id);
      if(!c) return {status:404, body:{error:'Customer not found.'}};
      const cfg=dbGetConfig(vendorId);
      const spend=dbGetQualifyingSpend(vendorId,id,cfg.reset_policy||'calendar');
      const tiers=dbGetTiers(vendorId); let tier=tiers[0];
      if(c.status_override) tier=tiers.find(t=>t.id===c.status_override)||tier;
      else for(const t of tiers){if(spend>=t.min_spend) tier=t;}
      return {status:200, body:{
        customer_id:id,
        points_earned:c.points_earned,
        points_deducted:c.points_deducted,
        net_points:c.points_earned-c.points_deducted,
        qualifying_spend:spend,
        status:tier?.name||'Basic'
      }};
    }
    return {status:404, body:{error:`Unknown endpoint: ${method} /${resource}`}};
  } catch(e) {
    return {status:500, body:{error:e.message||'Internal error'}};
  }
}

function _customerView(vendorId, c) {
  const cfg=dbGetConfig(vendorId);
  const spend=dbGetQualifyingSpend(vendorId,c.customer_id,cfg.reset_policy||'calendar');
  const tiers=dbGetTiers(vendorId);
  const highest=tiers[tiers.length-1], lowest=tiers[0];
  let tier=lowest, statusReason='spend';
  if(c.points_tier==='special'){
    tier=highest; statusReason='special';
  } else if(c.status_override){
    tier=tiers.find(t=>t.id===c.status_override)||lowest; statusReason='manual';
  } else if(spend<=0){
    tier=lowest; statusReason='expired';
  } else {
    for(const t of tiers){if(spend>=t.min_spend) tier=t;}
  }
  return {
    customer_id:c.customer_id, first_name:c.first_name, last_name:c.last_name,
    email:c.email, phone:c.phone, points_tier:c.points_tier,
    points_earned:c.points_earned, points_deducted:c.points_deducted,
    net_points:c.points_earned-c.points_deducted,
    qualifying_spend:spend, status:tier?.name||'Basic',
    status_reason:statusReason,
    status_overridden:c.points_tier==='special'||!!c.status_override,
    registered_at:c.registered_at
  };
}
function _txnView(t) {
  return {
    txn_id:t.txn_id, date:t.date, customer_id:t.customer_id,
    customer_name:t.cust_name, product_id:t.product_id, product_name:t.product_name,
    description:t.description, unit_price:t.unit_price||t.amount,
    quantity:t.quantity||1, amount:t.amount, multiplier:t.multiplier,
    points:t.points, type:t.type, order_type:t.order_type,
    qty_returned:t.qty_returned||0, returned:!!t.returned, ref_id:t.ref_id,
    created_by:t.created_by, ts:t.ts
  };
}
