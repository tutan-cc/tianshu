const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../three.min.js');require('../breakfast-connected-rig.js');require('../breakfast-original3d.js');
const image={width:1024,height:1536};
test('upper-body hierarchy connects spine, chest, clavicle, upper arm, forearm and hand',()=>{
 const c=Breakfast3D.createCharacter(T,image),b=c.bones;
 assert.equal(b.chest.parent,b.spine);assert.equal(b.spine.parent,b.body);
 for(const s of ['left','right']){assert.equal(b[s+'Clavicle'].parent,b.chest);assert.equal(b[s+'Shoulder'].parent,b[s+'Clavicle']);assert.equal(b[s+'Elbow'].parent,b[s+'Shoulder']);assert.equal(b[s+'Wrist'].parent,b[s+'Elbow']);assert.equal(b[s+'Hand'].parent,b[s+'Wrist']);}
 assert.ok(c.skeleton.bones.length>30);c.dispose();
});
test('shoulder vertices blend chest and clavicle influences within a single mesh',()=>{
 const c=Breakfast3D.createCharacter(T,image),g=c.portraitMesh.geometry,id=g.getAttribute('skinIndex'),w=g.getAttribute('skinWeight');let connected=false;
 const chest=c.skeleton.bones.indexOf(c.bones.chest),clav=c.skeleton.bones.indexOf(c.bones.rightClavicle);
 for(let i=0;i<id.count;i++){let a=false,b=false,sum=0;for(let k=0;k<4;k++){const x=id.array[i*4+k],v=w.array[i*4+k];a||=x===chest&&v>0;b||=x===clav&&v>0;sum+=v;}assert.ok(Math.abs(sum-1)<1e-6);connected||=a&&b;}
 assert.ok(connected);c.dispose();
});
test('clavicle and upper arm cooperate during a raise; neutral pose removes rotation',()=>{
 const c=Breakfast3D.createCharacter(T,image);c.animate(0,'wave',.5,false);assert.ok(c.bones.rightClavicle.rotation.z>0);assert.ok(c.bones.rightShoulder.rotation.z>0);
 for(let p=0;p<=1;p+=.05){c.animate(p*3,'wave',p,false);for(const b of c.skeleton.bones)assert.ok(b.matrixWorld.elements.every(Number.isFinite));}
 c.animate(0,'original',0,true);assert.equal(c.bones.rightClavicle.rotation.z,0);assert.equal(c.group.getObjectByName('StaticComposition').visible,true);c.dispose();
});
