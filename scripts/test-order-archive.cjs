const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const { retainRecentBlockedOrders } = createLoader()('src/lib/order-archive.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-archive-'));
try {
  const orders = Array.from({length: 105}, (_,i) => ({id:String(i), status:'BLOCKED', blockedReason:'COOLDOWN'}));
  orders.splice(3, 0, {id:'fill',status:'FILLED'});
  orders.splice(5, 0, {id:'unknown',status:'UNKNOWN'});
  orders.splice(7, 0, {id:'reject',status:'REJECTED'});
  const retained = retainRecentBlockedOrders(orders, dir);
  assert.equal(retained.length,103);
  assert.ok(['fill','unknown','reject'].every(id=>retained.some(o=>o.id===id)));
  const archived = fs.readFileSync(path.join(dir,'blocked-orders.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(archived.map(o=>o.id),['100','101','102','103','104']);
  assert.equal(orders.length,108);
  retainRecentBlockedOrders(retained,dir);
  assert.equal(fs.readFileSync(path.join(dir,'blocked-orders.jsonl'),'utf8').trim().split('\n').length,5);
  const invalid = path.join(dir,'not-a-directory'); fs.writeFileSync(invalid,'x');
  assert.throws(()=>retainRecentBlockedOrders(orders,invalid));
  assert.equal(orders.length,108);
  assert.throws(()=>retainRecentBlockedOrders(orders,dir,-1));
  console.log('PASS archive overflow; preserve fills/unknown/rejections; idempotent retained pass; write failure preserves input; invalid limit');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
