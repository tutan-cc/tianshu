/* Connected shoulder skinning. The cropped portrait needs an upper-body rig;
   no shader cuts or circular seam covers are used at the shoulders. */
(function(root){'use strict';
root.createConnectedStudent=function(T,image){
  var group=new T.Group(),bones={},all=[],resources=[];group.name='ConnectedStudent';
  function bone(n,p,x,y,z){var b=new T.Bone();b.name=n;b.position.set(x||0,y||0,z||0);p.add(b);bones[n]=b;all.push(b);return b;}
  var hips=bone('body',group,0,.55),spine=bone('spine',hips,0,.45),chest=bone('chest',spine,0,.65),neck=bone('neck',chest,0,.36),head=bone('head',neck,0,.08),arms={};
  [-1,1].forEach(function(s){var n=s<0?'left':'right',cl=bone(n+'Clavicle',chest,s*.18,.09),sh=bone(n+'Shoulder',cl,s*.27,.03),el=bone(n+'Elbow',sh,s*.15,-.72),wr=bone(n+'Wrist',el,s*.06,-.55),hand=bone(n+'Hand',wr,s*.015,-.10);
    for(var f=0;f<5;f++){var finger=bone(n+'Finger'+f,hand,(f-2)*.025,-.07);bone(n+'FingerTip'+f,finger,0,-.085);}
    arms[n]={clavicle:cl,shoulder:sh,elbow:el,wrist:wr,hand:hand};
  });
  group.updateMatrixWorld(true);var skeleton=new T.Skeleton(all),texture=new T.Texture(image);texture.encoding=T.sRGBEncoding;texture.needsUpdate=true;
  var pixels=null,iw=image.naturalWidth||image.width||1024,ih=image.naturalHeight||image.height||1536;
  try{if(root.document){var cv=root.document.createElement('canvas');cv.width=iw;cv.height=ih;var ctx=cv.getContext('2d');ctx.drawImage(image,0,0);pixels=ctx.getImageData(0,0,iw,ih).data;}}catch(e){}
  function smooth(a,b,v){v=Math.max(0,Math.min(1,(v-a)/(b-a)));return v*v*(3-2*v);}
  function skinAt(u,v){if(!pixels)return null;var x=Math.max(0,Math.min(iw-1,Math.round(u*(iw-1)))),y=Math.max(0,Math.min(ih-1,Math.round(v*(ih-1)))),i=(y*iw+x)*4;
    return {alpha:pixels[i+3]/255,skin:pixels[i]>pixels[i+1]*1.18&&pixels[i]>pixels[i+2]*1.30};}
  var cols=160,rows=240,w=3*iw/ih,pos=[],uv=[],ids=[],weights=[],index=[],region=[];
  function assign(items){var a=[0,0,0,0],b=[0,0,0,0],sum=0;items.forEach(function(it,k){a[k]=all.indexOf(it[0]);b[k]=it[1];sum+=it[1];});for(var k=0;k<4;k++)b[k]/=sum||1;ids.push.apply(ids,a);weights.push.apply(weights,b);}
  for(var r=0;r<=rows;r++)for(var c=0;c<=cols;c++){
    var u=c/cols,v=r/rows,y=(1-v)*3,side=u<.5?'left':'right',arm=arms[side],rgba=skinAt(u,v);
    var boundary=side==='left'?.325-.085*smooth(.46,.8,v):.675+.035*smooth(.46,.8,v);
    var aw=(side==='left'?1-smooth(boundary-.025,boundary+.025,u):smooth(boundary-.025,boundary+.025,u))*smooth(.34,.48,v);
    if(v>.53&&rgba){
      if(u>.30&&u<.70)aw=0;
      else if(rgba.alpha>.04)aw=rgba.skin?1:0;
      else {
        var nearest=null;
        for(var radius=2;radius<=8&&!nearest;radius*=2)for(var oy=-1;oy<=1&&!nearest;oy++)for(var ox=-1;ox<=1;ox++){
          var near=skinAt(u+ox*radius/iw,v+oy*radius/ih);if(near.alpha>.25){nearest=near;break;}
        }
        if(nearest)aw=nearest.skin?1:0;
      }
    }
    var hw=1-smooth(.28,.35,v),cw=smooth(.54,.76,y),part=aw>.5?(side==='left'?1:2):0;region.push(part);
    if(aw>.001){
      var blend=smooth(.55,.69,v),first=arm.shoulder,second=arm.elbow;
      if(v>.74){first=arm.elbow;second=arm.wrist;blend=smooth(.78,.88,v);}
      var collar=(1-smooth(.39,.52,v))*.55;
      assign([[chest,1-aw],[arm.clavicle,aw*collar],[first,aw*(1-collar)*(1-blend)],[second,aw*(1-collar)*blend]]);
    }else if(hw>0)assign([[chest,1-hw],[head,hw]]);
    else assign([[hips,1-cw],[chest,cw]]);
    pos.push((u-.5)*w,y,.025+aw*.025);uv.push(u,1-v);
  }
  function triangle(a,b,c){
    // Below the armpit only, split the naturally occluded skin/cloth boundary.
    // Shoulder vertices stay shared and blend chest/clavicle/upper-arm weights.
    var v=Math.min(Math.floor(a/(cols+1)),Math.floor(b/(cols+1)),Math.floor(c/(cols+1)))/rows;
    if(v>.53&&(region[a]!==region[b]||region[a]!==region[c]))return;
    if(v>.53&&pixels){
      var cu=(uv[a*2]+uv[b*2]+uv[c*2])/3,cv=1-(uv[a*2+1]+uv[b*2+1]+uv[c*2+1])/3;
      var sample=skinAt(cu,cv);
      if(sample.alpha<.03)return;
      if(region[a]>0&&sample.alpha>.02&&!sample.skin)return;
      if(region[a]===0&&(cu<.265||cu>.755))return;
    }
    index.push(a,b,c);
  }
  for(r=0;r<rows;r++)for(c=0;c<cols;c++){var i=r*(cols+1)+c;triangle(i,i+cols+1,i+1);triangle(i+1,i+cols+1,i+cols+2);}
  var geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geo.setAttribute('skinIndex',new T.Uint16BufferAttribute(ids,4));geo.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));geo.setIndex(index);geo.computeVertexNormals();
  var mat=new T.MeshBasicMaterial({map:texture,transparent:true,alphaTest:.045,side:T.DoubleSide}),mesh=new T.SkinnedMesh(geo,mat);mesh.frustumCulled=false;mesh.name='ConnectedShoulderMesh';group.add(mesh);group.updateMatrixWorld(true);mesh.bind(skeleton);
  var fullGeo=geo.clone(),fullIndex=[];for(r=0;r<rows;r++)for(c=0;c<cols;c++){var fi=r*(cols+1)+c;fullIndex.push(fi,fi+cols+1,fi+1,fi+1,fi+cols+1,fi+cols+2);}fullGeo.setIndex(fullIndex);
  var poster=new T.Mesh(fullGeo,new T.MeshBasicMaterial({map:texture,transparent:true,alphaTest:.045,side:T.DoubleSide}));poster.name='StaticComposition';group.add(poster);
  var fillMat=new T.MeshBasicMaterial({map:texture,transparent:true,alphaTest:.045,side:T.DoubleSide});
  fillMat.onBeforeCompile=function(s){s.vertexShader='varying vec2 clothUV;\n'+s.vertexShader;s.vertexShader=s.vertexShader.replace('#include <uv_vertex>','#include <uv_vertex>\nclothUV=uv;');s.fragmentShader='varying vec2 clothUV;\n'+s.fragmentShader;s.fragmentShader=s.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\nfloat v=1.0-clothUV.y;if(v<.50||clothUV.x<.26||clothUV.x>.76)discard;if(diffuseColor.r>diffuseColor.g*1.18&&diffuseColor.r>diffuseColor.b*1.30)discard;');};
  var cloth=new T.Mesh(fullGeo,fillMat);cloth.position.z=-.012;group.add(cloth);
  var helper=new T.SkeletonHelper(group);helper.material.depthTest=false;helper.renderOrder=20;helper.visible=false;
  function animate(t,action,p,reduced){all.forEach(function(b){b.rotation.set(0,0,0);});hips.position.y=.55;var still=reduced||action==='original';poster.visible=!!still;mesh.visible=!still;
    if(!still){p=Math.max(0,Math.min(1,p||0));var e=Math.sin(p*Math.PI);chest.rotation.z=Math.sin(t*1.2)*.006;head.rotation.y=Math.sin(t*.9)*.045;
      if(action==='wave'){arms.right.clavicle.rotation.z=.20*e;arms.right.shoulder.rotation.z=1.03*e;arms.right.elbow.rotation.z=.34*e;arms.right.wrist.rotation.z=Math.sin(p*Math.PI*8)*.12*e;}
      if(action==='receive'){arms.left.elbow.rotation.z=.55*e;arms.right.elbow.rotation.z=-.55*e;head.rotation.x=.10*e;}
      if(action==='urgent'){head.rotation.z=Math.sin(t*3)*.035;arms.left.elbow.rotation.z=.2;}
    }group.updateMatrixWorld(true);skeleton.update();helper.updateMatrixWorld(true);
  }
  function dispose(){geo.dispose();fullGeo.dispose();mat.dispose();fillMat.dispose();poster.material.dispose();texture.dispose();helper.geometry.dispose();helper.material.dispose();skeleton.dispose();}
  animate(0,'original',0,true);return {group:group,bones:bones,skeleton:skeleton,helper:helper,portraitMesh:mesh,armMeshes:[mesh],animate:animate,setPortrait:function(){},dispose:dispose};
};})(typeof window!=='undefined'?window:globalThis);
