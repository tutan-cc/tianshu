/* Street movement, walking animation and follow camera for the city map. */
(function (root) {
  "use strict";

  var BOUNDS = { minX:-17.5, maxX:17.5, minZ:-14, maxZ:16.8 };
  var CELL = 0.35, RADIUS = 0.15, SPEED = 2.9;
  var KEYS = {
    KeyW:[0,-1], ArrowUp:[0,-1], KeyS:[0,1], ArrowDown:[0,1],
    KeyA:[-1,0], ArrowLeft:[-1,0], KeyD:[1,0], ArrowRight:[1,0]
  };

  function isFree(x, z, obstacles) {
    if (x < BOUNDS.minX || x > BOUNDS.maxX || z < BOUNDS.minZ || z > BOUNDS.maxZ) return false;
    return !obstacles.some(function (b) {
      return Math.abs(x-b.x) < b.w/2+RADIUS && Math.abs(z-b.z) < b.d/2+RADIUS;
    });
  }

  function navigation(obstacles) {
    var width = Math.floor((BOUNDS.maxX-BOUNDS.minX)/CELL)+1;
    var height = Math.floor((BOUNDS.maxZ-BOUNDS.minZ)/CELL)+1;
    var size = width*height, open = new Uint8Array(size);
    var previous = new Int32Array(size), queue = new Int32Array(size);
    function point(i) {
      return {x:BOUNDS.minX+(i%width)*CELL, z:BOUNDS.minZ+Math.floor(i/width)*CELL};
    }
    for (var i=0; i<size; i++) {
      var p = point(i);
      open[i] = isFree(p.x,p.z,obstacles);
    }
    function validLine(a,b) {
      var steps = Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/(RADIUS*0.6));
      for (var i=1; i<=steps; i++) {
        if (!isFree(a.x+(b.x-a.x)*i/steps, a.z+(b.z-a.z)*i/steps, obstacles)) return false;
      }
      return true;
    }
    function nearest(x,z,from) {
      var col = Math.round((x-BOUNDS.minX)/CELL), row = Math.round((z-BOUNDS.minZ)/CELL);
      var best = -1, distance = Infinity;
      for (var r=Math.max(0,row-8); r<Math.min(height,row+9); r++) {
        for (var c=Math.max(0,col-8); c<Math.min(width,col+9); c++) {
          var n = r*width+c, d = (c-col)*(c-col)+(r-row)*(r-row);
          if (open[n] && d<distance && (!from || validLine(from,point(n)))) {
            distance=d; best=n;
          }
        }
      }
      return best;
    }
    return function find(start,target) {
      if (validLine(start,target)) return [target];
      var a=nearest(start.x,start.z,start), b=nearest(target.x,target.z);
      if (a<0 || b<0) return [];
      previous.fill(-1); previous[a]=a; queue[0]=a;
      var end=1;
      for (var q=0; q<end && previous[b]===-1; q++) {
        var current=queue[q], x=current%width, z=Math.floor(current/width);
        var candidates=[x>0?current-1:-1, x<width-1?current+1:-1, z>0?current-width:-1, z<height-1?current+width:-1];
        for (var k=0; k<candidates.length; k++) {
          var next=candidates[k];
          if (open[next] && previous[next]===-1 && validLine(point(current),point(next))) {
            previous[next]=current; queue[end++]=next;
          }
        }
      }
      if (previous[b]<0) return [];
      var reversed=[];
      for (var n=b; n!==a; n=previous[n]) reversed.push(point(n));
      reversed.push(point(a));
      var route=[], anchor=start;
      while (reversed.length) {
        var far=reversed.length-1;
        for (var j=0; j<far; j++) if (validLine(anchor,reversed[j])) { far=j; break; }
        anchor=reversed[far]; route.push(anchor); reversed.length=far;
      }
      if (validLine(anchor,target)) route.push(target);
      return route;
    };
  }

  function makeActor(T, coatColor, main) {
    var group=new T.Group(), rig=new T.Group(), box=new T.BoxGeometry(1,1,1), round=new T.SphereGeometry(1,8,6);
    var shapes={box:[],round:[]};
    group.add(rig);
    var coat=new T.MeshLambertMaterial({color:coatColor});
    var fabric=new T.MeshLambertMaterial({color:0x26363f});
    var shoe=new T.MeshLambertMaterial({color:main?0xffe4ad:0x373d3a});
    var skin=new T.MeshLambertMaterial({color:0xbf8768});
    var hair=new T.MeshLambertMaterial({color:0x342c29});
    var pack=new T.MeshLambertMaterial({color:0xcb632e});
    function part(parent, material, geometry,x,y,z,w,h,d) {
      var mesh=new T.Mesh(geometry,material);
      mesh.position.set(x,y,z); mesh.scale.set(w,h,d);
      mesh.layers.set(3);
      (geometry===box?shapes.box:shapes.round).push(mesh);
      parent.add(mesh); return mesh;
    }
    part(rig,coat,box,0,0.52,0,0.27,0.29,0.16);
    part(rig,skin,round,0,0.745,0.012,0.103,0.112,0.096);
    part(rig,hair,round,0,0.804,-0.013,0.108,0.070,0.098);
    if (main) {
      part(rig,pack,box,0,0.53,-0.124,0.21,0.23,0.10);
      part(rig,shoe,box,0,0.509,-0.18,0.13,0.025,0.016);
    }
    var legs=[], arms=[];
    [-1,1].forEach(function(side) {
      var leg=new T.Group(), arm=new T.Group();
      leg.position.set(side*0.072,0.385,0); arm.position.set(side*0.16,0.635,0);
      rig.add(leg,arm); legs.push(leg); arms.push(arm);
      part(leg,fabric,box,0,-0.16,0,0.105,0.31,0.103);
      part(leg,shoe,box,0,-0.32,0.032,0.107,0.06,0.16);
      part(arm,coat,box,0,-0.096,0,0.075,0.204,0.092);
      part(arm,skin,round,0,-0.219,0,0.04,0.05,0.043);
    });
    return {group:group,rig:rig,legs:legs,arms:arms,phase:0,blend:0,shapes:shapes};
  }

  function pose(actor, dx, dz, dt) {
    var moving=Math.abs(dx)+Math.abs(dz)>0.0001;
    actor.blend += ((moving?1:0)-actor.blend)*(1-Math.exp(-dt*13));
    actor.phase += Math.hypot(dx,dz)*7.5;
    var swing=Math.sin(actor.phase)*0.62*actor.blend;
    actor.legs[0].rotation.x=swing; actor.legs[1].rotation.x=-swing;
    actor.arms[0].rotation.x=-swing*0.72; actor.arms[1].rotation.x=swing*0.72;
    actor.rig.position.y=Math.abs(Math.sin(actor.phase))*0.021*actor.blend;
    if (moving) {
      var heading=Math.atan2(dx,dz), current=actor.rig.rotation.y;
      var turn=Math.atan2(Math.sin(heading-current),Math.cos(heading-current));
      actor.rig.rotation.y+=turn*(1-Math.exp(-dt*17));
    }
  }

  function create(inst, obstacles) {
    var T=inst.T, actor=makeActor(T,0x1f8e82,true), find=navigation(obstacles);
    var at=actor.group.position, following=new T.Vector3();
    at.set(0.04,0.083,3.05);
    actor.rig.rotation.y=2.2;
    var ring=new T.Mesh(new T.RingGeometry(0.28,0.318,40),
      new T.MeshBasicMaterial({color:0x7ef7db,side:T.DoubleSide,depthWrite:false}));
    ring.rotation.x=-Math.PI/2; ring.position.y=0.052; actor.group.add(ring);
    var marker=new T.Mesh(new T.CircleGeometry(0.62,20),
      new T.MeshBasicMaterial({color:0x90ffda,depthTest:false}));
    marker.rotation.x=-Math.PI/2; marker.position.y=1.0; marker.renderOrder=10; marker.visible=false;
    actor.group.add(marker); inst.scene.add(actor.group); actor.group.visible=false;

    var tagCanvas=root.document.createElement("canvas");
    tagCanvas.width=128; tagCanvas.height=42;
    var label=tagCanvas.getContext("2d");
    label.fillStyle="#142f2cf2"; label.fillRect(6,4,116,34);
    label.fillStyle="#7ef7db"; label.fillRect(6,4,4,34);
    label.fillStyle="#e3fff5"; label.font="bold 23px Microsoft YaHei, sans-serif";
    label.textAlign="center"; label.textBaseline="middle"; label.fillText("陈默",65,22);
    var nameTag=new T.Sprite(new T.SpriteMaterial({map:new T.CanvasTexture(tagCanvas),depthTest:false}));
    nameTag.position.y=1.13; nameTag.scale.set(0.90,0.30,1); nameTag.renderOrder=12;
    actor.group.add(nameTag);

    var pedestrians=[
      [-5.0,3.76,-1.1,3.76,0xa18269], [1.20,2.27,5.12,2.27,0xc6ae78],
      [5.24,-2.1,5.24,2.0,0x777197], [-0.73,-2.0,-0.73,2.3,0x7e9f8c],
      [6.77,3.7,10.94,3.7,0xa36f56]
    ].map(function (p,i) {
      var person=makeActor(T,p[4],false);
      person.group.scale.setScalar(0.89); inst.scene.add(person.group);
      person.group.visible=false;
      return {actor:person,road:p,phase:i*1.67};
    });

    var actors=[actor].concat(pedestrians.map(function(p){return p.actor;}));
    var unified=new T.MeshLambertMaterial({color:0xffffff});
    var actorBatches=["box","round"].map(function(kind){
      var parts=[];
      actors.forEach(function(person){parts=parts.concat(person.shapes[kind]);});
      var mesh=new T.InstancedMesh(parts[0].geometry,unified,parts.length);
      parts.forEach(function(part,index){mesh.setColorAt(index,part.material.color);});
      mesh.frustumCulled=false;
      mesh.castShadow=kind==="box";
      mesh.visible=false;
      inst.scene.add(mesh);
      return {mesh:mesh,parts:parts};
    });
    function syncActors() {
      actors.forEach(function(person){person.group.updateMatrixWorld(true);});
      actorBatches.forEach(function(batch){
        batch.parts.forEach(function(part,index){batch.mesh.setMatrixAt(index,part.matrixWorld);});
        batch.mesh.instanceMatrix.needsUpdate=true;
      });
    }
    var route=[], target=null, onArrive=null, keys={}, lastStatus="";
    var camera=new T.PerspectiveCamera(43,1,0.1,260);
    var plane=new T.Plane(new T.Vector3(0,1,0),-0.07), hit=new T.Vector3();
    var yaw=0.20, distance=14.6;
    var state={camera:camera, actor:actor, mapPin:marker, nameTag:nameTag, moving:false};
    function inform(text) {
      if (text===lastStatus) return;
      lastStatus=text;
      if (inst.opts.onWalkStatus) inst.opts.onWalkStatus(text);
    }
    function nearestPlace() {
      var nearest=null, best=1.2;
      for (var i=0; i<inst.order.length; i++) {
        var p=inst.places[inst.order[i]];
        if (p.state!=="avail") continue;
        var distance=Math.hypot(at.x-p.wx,at.z-(p.wz+2.62));
        if (distance<best) { nearest=p; best=distance; }
      }
      return nearest;
    }
    function resetView() {
      yaw=0.20; distance=14.6; following.set(at.x,0,at.z);
      positionCamera();
    }
    function positionCamera() {
      var pitch=1.01, horizontal=distance*Math.cos(pitch);
      camera.position.set(following.x+horizontal*Math.sin(yaw),distance*Math.sin(pitch),following.z+horizontal*Math.cos(yaw));
      camera.lookAt(following.x-0.08,0.28,following.z-0.68);
      camera.updateMatrixWorld();
    }
    function cancel() { route=[]; target=null; onArrive=null; }
    function step(dt,t) {
      var x=0,z=0, oldX=at.x,oldZ=at.z;
      Object.keys(keys).forEach(function(code){x+=KEYS[code][0];z+=KEYS[code][1];});
      if (x || z) {
        cancel();
        var length=Math.hypot(x,z), scale=dt*SPEED/length, c=Math.cos(yaw), s=Math.sin(yaw);
        var pieces=Math.max(1,Math.ceil(dt/0.045));
        var moveX=(x*c+z*s)*scale/pieces, moveZ=(-x*s+z*c)*scale/pieces;
        for (var n=0;n<pieces;n++) {
          if (isFree(at.x+moveX,at.z,obstacles)) at.x+=moveX;
          if (isFree(at.x,at.z+moveZ,obstacles)) at.z+=moveZ;
        }
      } else if (route.length) {
        var budget=dt*SPEED;
        while (route.length && budget>0) {
          var next=route[0], dx=next.x-at.x,dz=next.z-at.z, dist=Math.hypot(dx,dz);
          if (dist<=budget) { at.x=next.x; at.z=next.z; budget-=dist; route.shift(); }
          else { at.x+=dx/dist*budget; at.z+=dz/dist*budget; budget=0; }
        }
        if (!route.length) {
          var arrive=onArrive;
          cancel();
          if (arrive) arrive();
        }
      }
      if(inst.streetHeight)at.y=inst.streetHeight(at.x,at.z);
      state.moving=Math.hypot(at.x-oldX,at.z-oldZ)>0.0001;
      pose(actor,at.x-oldX,at.z-oldZ,dt);
      var k=1-Math.exp(-dt*6.5);
      following.x+=(at.x-following.x)*k; following.z+=(at.z-following.z)*k;
      positionCamera();

      pedestrians.forEach(function(p) {
        var r=p.road, distance=Math.hypot(r[2]-r[0],r[3]-r[1]), v=(t*0.82+p.phase)%(distance*2);
        var u=(v<distance?v:distance*2-v)/distance, pp=p.actor.group.position;
        var px=r[0]+(r[2]-r[0])*u, pz=r[1]+(r[3]-r[1])*u;
        if (Math.hypot(px-pp.x,pz-pp.z)<0.5) pose(p.actor,px-pp.x,pz-pp.z,dt);
        pp.set(px,inst.streetHeight?inst.streetHeight(px,pz):.097,pz);
      });
      syncActors();
      state.x=at.x; state.z=at.z;
      var nearby=nearestPlace();
      inform(target ? "步行前往 · "+target.name : (nearby ? "E · 进入"+nearby.name : ""));
    }
    function go(x,z,place,arrive) {
      var goal={x:Math.max(BOUNDS.minX,Math.min(BOUNDS.maxX,x)),z:Math.max(BOUNDS.minZ,Math.min(BOUNDS.maxZ,z))};
      var path=find(at,goal);
      if (!path.length) return false;
      route=path; target=place; onArrive=arrive;
      return true;
    }
    state.setEnabled=function(on) {
      actor.group.visible=on;
      pedestrians.forEach(function(p){p.actor.group.visible=on;});
      actorBatches.forEach(function(batch){batch.mesh.visible=on;});
      keys={};
      if (on) resetView(); else { cancel(); inform(""); }
    };
    state.release=function(){keys={};};
    state.resize=function(aspect){camera.aspect=aspect; camera.updateProjectionMatrix();};
    state.tick=step;
    state.resetView=resetView;
    state.rotate=function(dx){yaw-=dx*0.005;};
    state.zoom=function(delta){distance=Math.max(10,Math.min(23,distance*Math.exp(delta*0.0012)));};
    state.key=function(code,down,repeat) {
      if (code==="KeyE" && down && !repeat) {
        var p=nearestPlace();
        if (p && inst.opts.onPick) { cancel(); inst.opts.onPick(p.id,p.nodeId); }
        return true;
      }
      if (!Object.prototype.hasOwnProperty.call(KEYS,code)) return false;
      if (down) keys[code]=true; else delete keys[code];
      return true;
    };
    state.goTo=function(place,arrive){return go(place.wx,place.wz+2.62,place,arrive);};
    state.click=function(ray){return ray.intersectPlane(plane,hit) ? go(hit.x,hit.z,null,null) : false;};
    state.info=function(){return {x:+at.x.toFixed(3),z:+at.z.toFixed(3),moving:state.moving,route:route.length};};
    return state;
  }

  var api={create:create,navigation:navigation,isFree:isFree};
  if (typeof module==="object" && module.exports) module.exports=api;
  else root.CityWalk=api;
})(typeof window==="object"?window:globalThis);
