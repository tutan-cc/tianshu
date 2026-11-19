/* Original-character composition: one continuous painted mesh, weighted bones.
   The integrated artwork joins shoulders, sleeves and arms BEFORE animation.
   This is a front-facing 2.5D relief, not a complete 360-degree reconstruction. */
(function(root){
  'use strict';
  function smooth(a,b,x){var v=Math.max(0,Math.min(1,(x-a)/(b-a)));return v*v*(3-2*v);}
  function createCharacter(T,image){return root.createConnectedStudent(T,image);}
  var source='art/characters/student/student-integrated.png',image=null,portrait=null,unavailable=false;
  function configure(options){if(options&&options.characterSource){source=options.characterSource;image=null;}}
  function draw(g,unused,box,opts){
    if(unavailable||!root.THREE||!root.document)return false;
    if(!image){image=new root.Image();image.src=source;}if(!image.naturalWidth)return false;
    var T=root.THREE;opts=opts||{};
    try{
      if(!portrait){
        var renderer=new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setSize(280,280);renderer.outputEncoding=T.sRGBEncoding;
        var scene=new T.Scene(),camera=new T.OrthographicCamera(-1.45,1.45,3.15,.25,.1,20),character=createCharacter(T,image);
        camera.position.set(0,0,5);scene.add(character.group);portrait={renderer:renderer,scene:scene,camera:camera,character:character};
      }
      var since=opts.sinceFood,receiving=since>=0&&since<1.1;
      portrait.character.animate(opts.time||0,receiving?'receive':opts.mood==='urgent'?'urgent':'idle',receiving?since/1.1:0,!!opts.reduced);
      portrait.renderer.render(portrait.scene,portrait.camera);g.drawImage(portrait.renderer.domElement,box.x,box.y,box.w,box.h);return true;
    }catch(e){unavailable=true;if(portrait){portrait.character.dispose();portrait.renderer.dispose();portrait=null;}return false;}
  }
  function disposePortrait(){if(portrait){portrait.character.dispose();portrait.renderer.dispose();portrait.renderer.forceContextLoss();portrait=null;}unavailable=false;}
  root.Breakfast3D={kind:'integrated-original-relief',createCharacter:createCharacter,draw:draw,configure:configure,dispose:disposePortrait};
})(typeof window!=='undefined'?window:globalThis);
