/* Instanced street planting. Plant meshes are authored in relative height units. */
(function (root) {
  "use strict";

  function randomGenerator(seed) {
    return function () {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function buildPlant(T, species, seed) {
    var random = randomGenerator(seed);
    var wood = { pos:[], color:[], uv:[] }, foliage = { pos:[], color:[], uv:[] };
    var leafColors = [0x536b36, 0x607a40, 0x718b4d, 0x4b6232, 0x859452].map(function (hex) { return new T.Color(hex); });
    var bark = new T.Color(species==="palm" ? 0xd2c5b7 : 0x665949);
    var barkMark = new T.Color(0x5d5145);
    function v(x,y,z){return new T.Vector3(x,y,z);}
    function triangle(buffer,a,b,c,color,uv) {
      buffer.pos.push(a.x,a.y,a.z,b.x,b.y,b.z,c.x,c.y,c.z);
      for(var i=0;i<3;i++)buffer.color.push(color.r,color.g,color.b);
      buffer.uv.push.apply(buffer.uv,uv||[0,0,1,0,1,1]);
    }
    function tube(start,end,r0,r1,bands,palmBark) {
      var axis=end.clone().sub(start).normalize();
      var tangent=(Math.abs(axis.y)>.9 ? v(1,0,0) : v(0,1,0)).cross(axis).normalize();
      var other=axis.clone().cross(tangent).normalize();
      var sides=7;
      for(var level=0;level<bands;level++){
        var lo=level/bands, hi=(level+1)/bands;
        var a=start.clone().lerp(end,lo), b=start.clone().lerp(end,hi);
        var ar=r0+(r1-r0)*lo, br=r0+(r1-r0)*hi;
        var tone=palmBark && level%3===0 ? barkMark : bark;
        for(var i=0;i<sides;i++){
          var n0=tangent.clone().multiplyScalar(Math.cos(i*2*Math.PI/sides)).addScaledVector(other,Math.sin(i*2*Math.PI/sides));
          var n1=tangent.clone().multiplyScalar(Math.cos((i+1)*2*Math.PI/sides)).addScaledVector(other,Math.sin((i+1)*2*Math.PI/sides));
          var al=a.clone().addScaledVector(n0,ar), bl=a.clone().addScaledVector(n1,ar);
          var ah=b.clone().addScaledVector(n0,br), bh=b.clone().addScaledVector(n1,br);
          var u=i/sides, u1=(i+1)/sides;
          triangle(wood,al,bl,ah,tone,[u,lo,u1,lo,u,hi]);
          triangle(wood,bl,bh,ah,tone,[u1,lo,u1,hi,u,hi]);
        }
      }
    }
    function blade(base, tip, width, shade, pointed) {
      var delta=tip.clone().sub(base);
      var lateral=v(-delta.z,0,delta.x).normalize().multiplyScalar(width);
      var middle=base.clone().lerp(tip,pointed ? .40 : .50);
      var left=middle.clone().sub(lateral), right=middle.clone().add(lateral);
      middle.y+=width*.42;
      var darker=shade.clone().multiplyScalar(.83);
      triangle(foliage,base,left,middle,darker,[0,.5,.5,0,.5,.5]);
      triangle(foliage,left,tip,middle,darker,[.5,0,1,.5,.5,.5]);
      triangle(foliage,base,middle,right,shade,[0,.5,.5,.5,.5,1]);
      triangle(foliage,middle,tip,right,shade,[.5,.5,1,.5,.5,1]);
    }
    function frond(origin, azimuth, length, rise, droop) {
      var forward=v(Math.cos(azimuth),0,Math.sin(azimuth)), aside=v(-forward.z,0,forward.x);
      var last=origin.clone();
      for(var i=1;i<=11;i++){
        var u=i/11, p=origin.clone().addScaledVector(forward,length*u).addScaledVector(aside,.055*u*u);
        p.y+=rise*Math.sin(u*Math.PI*.75)-droop*u*u;
        tube(last,p,.006*(1-u)+.002,.002,1,false);
        if(u<1){
          var spread=length*(.12+.16*Math.sin(Math.PI*u))*(1-u*.67);
          for(var side=-1;side<=1;side+=2){
            var tip=p.clone().addScaledVector(aside,side*spread*(.82+random()*.3)).addScaledVector(forward,spread*.78);
            tip.y-=spread*(.28+random()*.46);
            blade(p,tip,spread*(.18+random()*.045),leafColors[(random()*leafColors.length)|0],true);
          }
        }
        last=p;
      }
    }
    if(species==="palm"){
      var base=v(0,0,0), stem=v(.015,.48,-.018);
      var crown=v((random()-.5)*.14,.82,(random()-.5)*.13);
      tube(base,stem,.047,.030,13,true); tube(stem,crown,.031,.024,9,true);
      for(var f=0;f<11;f++){
        var angle=f*2.39996+random()*.23;
        var outer=f<8;
        frond(crown,angle,outer ? .33+random()*.13 : .21+random()*.08,outer ? .09 : .19,outer ? .19 : .08);
      }
    }else if(species==="fern"){
      for(var f2=0;f2<7;f2++){
        frond(v(0,.015,0),f2*2.39996+random()*.3,.34+random()*.25,.35+random()*.18,.07+random()*.23);
      }
    }else{
      var trunk=v((random()-.5)*.14,.60,(random()-.5)*.10);
      tube(v(0,0,0),v(trunk.x*.48,.36,trunk.z*.48),.038,.021,5,false);
      tube(v(trunk.x*.48,.36,trunk.z*.48),trunk,.021,.013,3,false);
      for(var branch=0;branch<7;branch++){
        var az=branch*2.39996, reach=branch===0 ? .04 : .16+random()*.19;
        var from=v(trunk.x,.44+random()*.13,trunk.z);
        var joint=v(Math.cos(az)*reach*.56,.66+random()*.085,Math.sin(az)*reach*.56);
        var top=v(trunk.x+Math.cos(az)*reach,.72+random()*.20, trunk.z+Math.sin(az)*reach);
        tube(from,joint,.015,.009,2,false); tube(joint,top,.009,.004,3,false);
        for(var twig=0;twig<4;twig++){
          var a2=az+twig*1.6, tip=top.clone().add(v(Math.cos(a2)*.14,.02+random()*.08,Math.sin(a2)*.14));
          tube(joint.clone().lerp(top,.7),tip,.005,.0018,2,false);
          for(var n=0;n<12;n++){
            var yaw=random()*2*Math.PI, offset=random()*.14;
            var leaf=tip.clone().add(v(Math.cos(yaw)*offset,(random()-.5)*.14,Math.sin(yaw)*offset));
            var bladeLength=.059+random()*.056;
            var end=leaf.clone().add(v(Math.cos(yaw)*bladeLength,(random()-.54)*.071,Math.sin(yaw)*bladeLength));
            blade(leaf,end,bladeLength*.28,leafColors[(random()*leafColors.length)|0],false);
          }
        }
      }
    }
    function geometry(buffer) {
      var geo=new T.BufferGeometry();
      geo.setAttribute("position",new T.Float32BufferAttribute(buffer.pos,3));
      geo.setAttribute("color",new T.Float32BufferAttribute(buffer.color,3));
      geo.setAttribute("uv",new T.Float32BufferAttribute(buffer.uv,2));
      geo.computeVertexNormals();
      geo.computeBoundingBox();
      return geo;
    }
    return { wood:geometry(wood), foliage:geometry(foliage) };
  }

  function fernCards(T, seed) {
    var random=randomGenerator(seed), pos=[], uv=[], indices=[];
    for(var frond=0;frond<8;frond++){
      var a=frond*2.39996+random()*.5, forward=new T.Vector3(Math.cos(a),0,Math.sin(a));
      var side=new T.Vector3(-forward.z,0,forward.x);
      var length=.35+random()*.27, rise=.24+random()*.21, start=pos.length/3;
      for(var i=0;i<=8;i++){
        var t=i/8, p=forward.clone().multiplyScalar(length*t);
        p.y=.017+rise*Math.sin(t*Math.PI*.71)-.15*t*t;
        var left=p.clone().addScaledVector(side,-length*.131), right=p.clone().addScaledVector(side,length*.131);
        right.y+=t*.03;
        pos.push(left.x,left.y,left.z,right.x,right.y,right.z);
        uv.push(0,t,1,t);
        if(i<8){var n=start+i*2; indices.push(n,n+2,n+1,n+1,n+2,n+3);}
      }
    }
    var g=new T.BufferGeometry();
    g.setAttribute("position",new T.Float32BufferAttribute(pos,3));
    g.setAttribute("uv",new T.Float32BufferAttribute(uv,2));
    g.setIndex(indices); g.computeVertexNormals(); g.computeBoundingBox();
    return g;
  }

  function create(T) {
    var plants={}, solid=new T.MeshLambertMaterial({vertexColors:true,side:T.DoubleSide});
    var green=new T.MeshLambertMaterial({vertexColors:true,side:T.DoubleSide});
    var palmWood=solid.clone(), broadLeaf=green.clone(), fernLeaf=new T.MeshLambertMaterial({
      side:T.DoubleSide,alphaTest:.38,color:0xf5f5e5,emissive:0x253513,emissiveIntensity:.22
    });
    var textures=root.CityPlantTextures || {}, loaded={};

    function applyTexture(material, name) {
      if (!textures[name]) return;
      var loader=new T.TextureLoader();
      loader.load(textures[name],function(tex) {
        tex.encoding=T.sRGBEncoding;
        tex.anisotropy=4;
        material.map=tex; material.needsUpdate=true; loaded[name]=true;
      });
    }
    applyTexture(palmWood,"bark");
    applyTexture(broadLeaf,"leaf");
    applyTexture(fernLeaf,"fern");
    ["palm","tree","fern"].forEach(function (species,index) {
      // 近景保留两套棕榈轮廓，其余植物靠实例的朝向和尺度错开。
      plants[species]=(species==="palm"?[0,1]:[0]).map(function (variant) {
        var seed=1943+index*733+variant*193;
        return species==="fern" && textures.fern ? { foliage:fernCards(T,seed) } : buildPlant(T,species,seed);
      });
    });
    return {
      ready:function(){return Object.keys(loaded).length;},
      part:function(emit,parent,species,variant,x,y,z,scale,rotation) {
        var models=plants[species], model=models[variant%models.length];
        if(model.wood)emit(parent,species==="palm"?palmWood:solid,x,y,z,scale,scale,scale,model.wood,rotation);
        var surface=species==="fern"&&textures.fern?fernLeaf:(species==="tree"?broadLeaf:green);
        emit(parent,surface,x,y,z,scale,scale,scale,model.foliage,rotation);
        return model.foliage.boundingBox.max.y*scale;
      }
    };
  }
  root.CityVegetation={create:create};
})(typeof window==="object"?window:globalThis);
