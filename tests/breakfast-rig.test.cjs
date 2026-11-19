const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'breakfast-rig.js'), 'utf8'), ctx);
const rig = ctx.BreakfastRig;
test('reduced motion is an identity transform across the entire portrait', () => {
  const p = rig.pose(4, 'urgent', 0.5, true);
  for (let y = 0; y <= 1; y += 0.05) for (let x = 0; x <= 1; x += 0.1) {
    const q = rig.deform(x, y, p);
    assert.ok(Math.abs(q.x-x) < 1e-12 && Math.abs(q.y-y) < 1e-12);
  }
});
test('receipt nod acts on the head while the body root stays anchored', () => {
  const idle = rig.pose(0, 'calm', -1, false);
  const nod = rig.pose(0, 'happy', 0.55, false);
  const a = rig.deform(0.5, 0.2, idle), b = rig.deform(0.5, 0.2, nod);
  assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>0.02);
  const hip = rig.deform(0.5, 0.98, nod);
  assert.equal(hip.x, 0.5); assert.equal(hip.y, 0.98);
  assert.equal(rig.pose(0, 'calm', 1.2, false).nod, 0);
});
test('neck skinning keeps triangles finite and facing forward through all moods', () => {
  for (const mood of ['calm','urgent','happy']) for (let t=0;t<8;t+=0.07) {
    const p=rig.pose(t,mood,t%1.3,false);
    for (let row=0;row<16;row++) for (let col=0;col<6;col++) {
      const a=rig.deform(col/6,row/16,p),b=rig.deform((col+1)/6,row/16,p);
      const c=rig.deform(col/6,(row+1)/16,p),d=rig.deform((col+1)/6,(row+1)/16,p);
      const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y);
      assert.ok(cross(a,b,d)>0 && cross(a,d,c)>0, 'skinning must not fold triangles');
    }
  }
});
test('only successful servings emit the receipt animation timestamp', () => {
  vm.runInContext(fs.readFileSync(path.join(root, 'breakfast.js'), 'utf8'), ctx);
  const r=ctx.Breakfast.rules, st=r.newState({duration:75,goal:8});
  const customer=r.spawnCustomer(st,['egg','milk']);
  st.elapsed=4;
  r.serveFoodToCustomer(st,customer,'soup','perfect','hot',2);
  assert.equal(customer.lastFoodAt,undefined);
  r.serveFoodToCustomer(st,customer,'egg','perfect','hot',2);
  assert.equal(customer.lastFoodAt,4);
  st.elapsed=6;
  r.serveFoodToCustomer(st,customer,'milk','perfect','hot',2);
  assert.equal(customer.lastFoodAt,6);
  assert.equal(customer.left,true);
  assert.equal(customer.servedAt,6);
  const burnt=r.spawnCustomer(st,['egg']);
  r.serveFoodToCustomer(st,burnt,'egg','burnt','cold',2);
  assert.equal(burnt.lastFoodAt,undefined);
});
