const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../three.min.js');require('../breakfast-character3d.js');
test('3D student has connected shoulder, elbow, wrist and finger bones on both arms',()=>{
  const c=Breakfast3D.createCharacter(T);
  for(const side of ['left','right']){
    assert.equal(c.bones[side+'Elbow'].parent,c.bones[side+'Shoulder']);
    assert.equal(c.bones[side+'Wrist'].parent,c.bones[side+'Elbow']);
    for(let i=0;i<4;i++)assert.equal(c.bones[side+'FingerTip'+i].parent,c.bones[side+'Finger'+i]);
  }
  assert.ok(c.skeleton.bones.length>=35);c.dispose();
});
test('receive and wave produce substantial wrist movement and return to idle',()=>{
  const c=Breakfast3D.createCharacter(T),position=()=>c.bones.rightWrist.getWorldPosition(new T.Vector3());
  c.animate(0,'idle',0,false);const idle=position();
  c.animate(0,'receive',.45,false);assert.ok(position().distanceTo(idle)>.35);assert.equal(c.food.visible,true);
  const left=c.bones.leftWrist.getWorldPosition(new T.Vector3()),right=position();
  assert.ok(left.distanceTo(right)<.55,'both hands must fit under the plate');
  const up=new T.Vector3(0,1,0).applyQuaternion(c.food.getWorldQuaternion(new T.Quaternion()));
  assert.ok(up.y>.999,'the plate must remain level as the arms move');
  c.animate(0,'wave',.5,false);assert.ok(position().distanceTo(idle)>.65);assert.equal(c.food.visible,false);
  c.animate(0,'idle',0,false);assert.ok(position().distanceTo(idle)<1e-8);c.dispose();
});
test('all actions keep bones finite and reduced motion removes animated poses',()=>{
  const c=Breakfast3D.createCharacter(T);
  for(const action of ['idle','wave','receive','urgent'])for(let p=0;p<=1;p+=.04){
    c.animate(p*10,action,p,false);
    for(const bone of Object.values(c.bones))assert.ok(bone.matrixWorld.elements.every(Number.isFinite));
  }
  c.animate(3,'receive',.5,true);
  assert.equal(c.food.visible,false);assert.equal(c.bones.head.rotation.x,0);assert.equal(c.bones.rightShoulder.rotation.z,0);
  c.dispose();
});
