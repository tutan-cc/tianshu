/* Three.js r149. Procedural student with a real Bone hierarchy and rigid parts.
   No remote assets. Shared between the turntable preview and Canvas game portrait. */
(function(root){
  'use strict';
  function createCharacter(T){
    var group=new T.Group();group.name='BreakfastStudent3D';
    var bones={},materials={},geometries=[];
    function mat(name,color,roughness){
      var m=new T.MeshStandardMaterial({color:color,roughness:roughness===undefined?.72:roughness,metalness:0});
      // r149 uses legacy color management; convert these sRGB art colors locally.
      m.color.convertSRGBToLinear();return materials[name]=m;
    }
    var skin=mat('skin',0xf0b788),ear=mat('ear',0xd38d73),hair=mat('hair',0x31231f),cap=mat('cap',0xb93b32),capEdge=mat('capEdge',0x792a25);
    var shirt=mat('shirt',0x6e7b7e),seam=mat('seam',0x4b595e),pants=mat('pants',0x283c48),shoe=mat('shoe',0xe7d8b5),sole=mat('sole',0xeee5d3);
    var pack=mat('backpack',0x303d3c),strap=mat('strap',0x263130),white=mat('eyeWhite',0xfff9ec,.35),iris=mat('iris',0x674331,.3),black=mat('pupil',0x161719,.24);
    var gold=mat('brass',0xc4a164,.4),plateMat=mat('ceramic',0xf0e6cd,.25),bunMat=mat('bun',0xe8bf72);
    function bone(name,parent,x,y,z){var b=new T.Bone();b.name=name;b.position.set(x||0,y||0,z||0);parent.add(b);bones[name]=b;return b;}
    function mesh(parent,geo,material,x,y,z,sx,sy,sz){geometries.push(geo);var m=new T.Mesh(geo,material);m.position.set(x||0,y||0,z||0);if(sx)m.scale.set(sx,sy,sz);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
    function ball(parent,material,x,y,z,sx,sy,sz){return mesh(parent,new T.SphereGeometry(1,28,20),material,x,y,z,sx,sy,sz);}
    function capsule(parent,material,x,y,z,r,length){return mesh(parent,new T.CapsuleGeometry(r,length,6,16),material,x,y,z);}
    function tube(parent,material,points,r){var curve=new T.CatmullRomCurve3(points.map(function(v){return new T.Vector3(v[0],v[1],v[2]);}));return mesh(parent,new T.TubeGeometry(curve,22,r,8,false),material);}
    var pelvis=bone('hips',group,0,.95,0),spine=bone('spine',pelvis,0,.12,0),chest=bone('chest',spine,0,.34,0);
    ball(spine,shirt,0,.18,0,.345,.43,.235);
    ball(pelvis,pants,0,-.025,0,.31,.21,.21);
    mesh(spine,new T.TorusGeometry(.13,.022,8,40),seam,0,.55,.025).rotation.x=Math.PI/2;
    // Shoulder seams, backpack straps, buckles, and a small stitched chest patch.
    [-1,1].forEach(function(s){
      tube(chest,strap,[[s*.24,.20,-.17],[s*.28,.21,.06],[s*.27,.08,.22],[s*.23,-.26,.22]],.038);
      mesh(chest,new T.BoxGeometry(.067,.055,.024),gold,s*.245,-.13,.257);
    });
    mesh(chest,new T.BoxGeometry(.11,.055,.018),sole,-.105,-.025,.228);
    ball(chest,pack,0,-.08,-.27,.31,.38,.15);
    ball(chest,seam,0,-.19,-.405,.23,.19,.045);
    tube(chest,gold,[[-.16,-.06,-.447],[0,-.075,-.456],[.16,-.06,-.447]],.009);
    var neck=bone('neck',chest,0,.34,0);
    capsule(neck,skin,0,.055,0,.11,.13);
    var head=bone('head',neck,0,.12,0);
    ball(head,skin,0,.30,0,.385,.43,.34);
    ball(head,skin,0,.095,.07,.255,.19,.245);
    [-1,1].forEach(function(s){
      ball(head,skin,s*.385,.28,0,.081,.115,.063);
      ball(head,ear,s*.423,.28,.033,.028,.064,.028);
      ball(head,white,s*.143,.33,.301,.088,.062,.034);
      ball(head,iris,s*.141,.328,.329,.043,.048,.016);
      ball(head,black,s*.139,.33,.342,.025,.035,.009);
      ball(head,white,s*.139-.009,.35,.350,.010,.012,.006);
      tube(head,hair,[[s*.065,.432,.303],[s*.14,.45,.315],[s*.222,.429,.27]],.024);
      ball(head,ear,s*.245,.195,.282,.052,.023,.009);
    });
    ball(head,skin,0,.242,.338,.061,.069,.07);
    ball(head,ear,-.029,.215,.391,.012,.009,.006);
    ball(head,ear,.029,.215,.391,.012,.009,.006);
    var smile=tube(head,hair,[[-.103,.13,.302],[-.05,.107,.333],[0,.102,.341],[.06,.115,.326],[.101,.138,.30]],.011);
    // Dark hair ring and individually sculpted swept locks below a backward cap.
    ball(head,hair,0,.472,-.045,.386,.28,.318);
    [-1,1].forEach(function(s){ball(head,hair,s*.322,.36,-.015,.066,.16,.13);});
    for(var i=0;i<6;i++){
      var lock=ball(head,hair,-.25+i*.092,.466+(i%2)*.027,.26,.095,.11,.085);
      lock.rotation.z=-.45;
    }
    var crown=mesh(head,new T.SphereGeometry(.407,40,22,0,Math.PI*2,0,Math.PI/2),cap,0,.49,-.025);
    crown.scale.set(1, .81, .96);
    mesh(head,new T.TorusGeometry(.398,.026,10,48),capEdge,0,.49,-.025).rotation.x=Math.PI/2;
    var visor=ball(head,cap,-.015,.477,-.397,.34,.036,.265);visor.rotation.x=-.09;
    ball(head,capEdge,0,.817,-.025,.035,.022,.035);
    mesh(head,new T.BoxGeometry(.22,.075,.024),pack,0,.505,.37);
    for(i=0;i<4;i++)ball(head,gold,-.07+i*.046,.506,.386,.008,.008,.004);
    tube(head,capEdge,[[0,.51,.366],[0,.73,.26],[0,.815,-.025],[0,.73,-.29],[0,.51,-.42]],.006);
    var arms={};
    [-1,1].forEach(function(s){
      var side=s<0?'left':'right',upper=bone(side+'Shoulder',chest,s*.365,.14,0);
      ball(upper,shirt,0,-.075,0,.15,.19,.16);
      capsule(upper,skin,0,-.215,0,.091,.19);
      var elbow=bone(side+'Elbow',upper,0,-.35,0);
      ball(elbow,skin,0,0,0,.094,.094,.094);
      capsule(elbow,skin,0,-.135,0,.079,.18);
      var wrist=bone(side+'Wrist',elbow,0,-.30,0);
      ball(wrist,skin,0,-.065,0,.091,.12,.048);
      for(var f=0;f<4;f++){
        var finger=bone(side+'Finger'+f,wrist,(f-1.5)*.042,-.14,.004);
        capsule(finger,skin,0,-.034,.004,.022,.055-(f===0||f===3?.01:0));
        var tip=bone(side+'FingerTip'+f,finger,0,-.063,0);
        capsule(tip,skin,0,-.022,.005,.020,.025);tip.rotation.x=-.19;
      }
      var thumb=bone(side+'Thumb',wrist,s*.081,-.053,.016);thumb.rotation.z=s*.65;
      capsule(thumb,skin,0,-.038,0,.029,.055);
      arms[side]={upper:upper,elbow:elbow,wrist:wrist};
    });
    var legs={};
    [-1,1].forEach(function(s){
      var side=s<0?'left':'right',hip=bone(side+'Hip',pelvis,s*.165,-.13,0);
      capsule(hip,pants,0,-.17,0,.135,.23);
      var knee=bone(side+'Knee',hip,0,-.35,0);capsule(knee,pants,0,-.16,0,.115,.23);
      var ankle=bone(side+'Ankle',knee,0,-.32,0);
      ball(ankle,shoe,0,-.04,.068,.14,.10,.23);
      ball(ankle,sole,0,-.10,.07,.147,.045,.235);
      for(var k=0;k<3;k++)tube(ankle,sole,[[-.075,.028,.09+k*.033],[0,.042,.10+k*.033],[.075,.028,.09+k*.033]],.008);
      legs[side]={hip:hip,knee:knee};
    });
    // Plate follows the right wrist; it becomes visible during the receive action.
    var food=new T.Group();food.name='BreakfastPlate';arms.right.wrist.add(food);food.position.set(-.12,-.05,.10);
    mesh(food,new T.CylinderGeometry(.27,.22,.035,40),plateMat,0,0,0);
    mesh(food,new T.TorusGeometry(.241,.018,8,40),plateMat,0,.022,0).rotation.x=Math.PI/2;
    ball(food,bunMat,0,.085,0,.13,.095,.13);
    for(i=0;i<5;i++){var angle=i*Math.PI*2/5;tube(food,plateMat,[[0,.175,0],[Math.cos(angle)*.05,.163,Math.sin(angle)*.05],[Math.cos(angle)*.095,.123,Math.sin(angle)*.095]],.006);}
    var skeleton=new T.Skeleton(Object.keys(bones).map(function(k){return bones[k];}));
    var helper=new T.SkeletonHelper(group);helper.material.depthTest=false;helper.material.transparent=true;helper.material.opacity=.8;helper.renderOrder=100;helper.visible=false;
    function animate(time,action,progress,reduced){
      var t=reduced?0:time,sway=Math.sin(t*1.7),breath=Math.sin(t*2.2);
      Object.keys(bones).forEach(function(k){bones[k].rotation.set(0,0,0);});
      pelvis.position.y=.95+(reduced?0:breath*.022);
      spine.rotation.z=sway*.025;chest.rotation.x=breath*.025;
      head.rotation.y=Math.sin(t*.9)*.12;head.rotation.x=Math.sin(t*1.4)*.045;
      arms.left.upper.rotation.z=-.13;arms.right.upper.rotation.z=.13;
      arms.left.elbow.rotation.x=-.14;arms.right.elbow.rotation.x=-.14;
      arms.left.upper.rotation.x=Math.sin(t*1.7)*.07;arms.right.upper.rotation.x=-Math.sin(t*1.7)*.07;
      food.visible=false;food.rotation.set(0,0,0);
      var p=Math.max(0,Math.min(1,progress||0)),envelope=Math.sin(Math.PI*p);
      if(action==='urgent'){
        head.rotation.y=Math.sin(t*4)*.22;head.rotation.z=Math.sin(t*3)*.05;
        arms.left.upper.rotation.z=-.28;arms.left.elbow.rotation.x=-.65;
        arms.right.elbow.rotation.x=-.5;legs.right.hip.rotation.x=Math.max(0,Math.sin(t*6))*.13;
        pelvis.position.y+=Math.abs(Math.sin(t*6))*.013;
      }
      if(action==='wave'){
        arms.right.upper.rotation.z=1.95*envelope+.13;
        arms.right.upper.rotation.x=-.15*envelope;
        arms.right.elbow.rotation.z=.5*envelope;
        arms.right.wrist.rotation.z=Math.sin(p*Math.PI*10)*.4*envelope;
        head.rotation.z=-.13*envelope;
      }
      if(action==='receive'){
        var lift=Math.sin(Math.PI*Math.min(1,p/.85));lift=Math.max(0,lift);
        arms.left.upper.rotation.x=-.83*lift;arms.right.upper.rotation.x=-.83*lift;
        arms.left.upper.rotation.z=-.13+.38*lift;arms.right.upper.rotation.z=.13-.38*lift;
        arms.left.elbow.rotation.x=-.85*lift;arms.right.elbow.rotation.x=-.85*lift;
        arms.left.wrist.rotation.x=.2*lift;arms.right.wrist.rotation.x=.2*lift;
        head.rotation.x=Math.sin(Math.PI*Math.max(0,(p-.23)/.65))*.32;
        spine.rotation.x=.07*lift;
        food.visible=p>.16&&p<.88;
      }
      if(reduced){Object.keys(bones).forEach(function(k){bones[k].rotation.set(0,0,0);});food.visible=false;}
      group.updateMatrixWorld(true);
      if(food.visible){
        var leftHand=arms.left.wrist.getWorldPosition(new T.Vector3()),rightHand=arms.right.wrist.getWorldPosition(new T.Vector3());
        var center=leftHand.add(rightHand).multiplyScalar(.5);center.y+=.025;center.z+=.075;
        food.position.copy(arms.right.wrist.worldToLocal(center));
        food.quaternion.copy(arms.right.wrist.getWorldQuaternion(new T.Quaternion()).invert());
      }
      group.updateMatrixWorld(true);helper.updateMatrixWorld(true);
    }
    function dispose(){geometries.forEach(function(g){g.dispose();});Object.keys(materials).forEach(function(k){materials[k].dispose();});helper.geometry.dispose();helper.material.dispose();skeleton.dispose();}
    animate(0,'idle',0,false);
    return {group:group,bones:bones,skeleton:skeleton,helper:helper,arms:arms,food:food,animate:animate,dispose:dispose};
  }
  function lights(T,scene,shadows){
    scene.add(new T.HemisphereLight(0xfff0d6,0x63716b,1.5));
    var key=new T.DirectionalLight(0xffead0,2.8);key.position.set(-3,5,5);key.castShadow=!!shadows;
    if(shadows){key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=-3;key.shadow.camera.right=3;key.shadow.camera.top=4;key.shadow.camera.bottom=-2;key.shadow.normalBias=.025;}
    scene.add(key);var rim=new T.DirectionalLight(0xb8d7d5,.9);rim.position.set(3,3,-3);scene.add(rim);
  }
  var portrait=null,unavailable=false;
  function draw(g,img,box,opts){
    if(unavailable||!root.THREE||!root.document)return false;
    var T=root.THREE;opts=opts||{};
    try{
      if(!portrait){
        var renderer=new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setSize(240,260);renderer.setPixelRatio(1);
        renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;renderer.physicallyCorrectLights=true;
        var scene=new T.Scene(),camera=new T.PerspectiveCamera(32,240/260,.1,20),character=createCharacter(T);
        camera.position.set(0,1.78,3.3);camera.lookAt(0,1.73,0);scene.add(character.group);lights(T,scene,false);
        portrait={renderer:renderer,scene:scene,camera:camera,character:character};
      }
      var since=opts.sinceFood,receiving=since>=0&&since<1.1;
      portrait.character.animate(opts.time||0,receiving?'receive':opts.mood==='urgent'?'urgent':'idle',receiving?since/1.1:0,!!opts.reduced);
      portrait.character.group.rotation.y=-.13;
      portrait.renderer.render(portrait.scene,portrait.camera);
      g.drawImage(portrait.renderer.domElement,box.x,box.y,box.w,box.h);return true;
    }catch(e){unavailable=true;if(portrait){portrait.character.dispose();portrait.renderer.dispose();portrait=null;}return false;}
  }
  function disposePortrait(){if(portrait){portrait.character.dispose();portrait.renderer.dispose();portrait.renderer.forceContextLoss();portrait=null;}unavailable=false;}
  root.Breakfast3D={createCharacter:createCharacter,lights:lights,draw:draw,dispose:disposePortrait};
})(typeof window!=='undefined'?window:globalThis);
