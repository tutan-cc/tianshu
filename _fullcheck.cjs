const fs = require("fs"), path = require("path");
const spoken = [];
/* ── DOM 桩 ── */
function ctx2d() {
  return new Proxy({}, {
    get: function (t, k) {
      if (k === "canvas") return { width: 300, height: 150 };
      if (k === "measureText") return function () { return { width: 10 }; };
      if (k === "getImageData") return function () { return { data: new Uint8ClampedArray(4) }; };
      if (k === "createLinearGradient" || k === "createPattern" || k === "createRadialGradient")
        return function () { return { addColorStop: function () {} }; };
      return function () {};
    }
  });
}
function fakeEl() { return { style:{}, dataset:{}, classList:{add(){},remove(){},toggle(){}},
  appendChild(){}, removeChild(){}, setAttribute(){}, getAttribute:()=>null,
  addEventListener(){}, removeEventListener(){}, querySelector:()=>fakeEl(), querySelectorAll:()=>[],
  getBoundingClientRect:()=>({left:0,top:0,width:1240,height:860}), getContext:()=>ctx2d(),
  width:1240, height:860, innerHTML:"", textContent:"", children:[], clientWidth:1240, clientHeight:860 }; }
global.window = global;
global.document = { getElementById: ()=>null, createElement: ()=>fakeEl(), querySelector:()=>null,
  querySelectorAll:()=>[], body:fakeEl(), addEventListener(){}, head:fakeEl(), documentElement:fakeEl() };
global.devicePixelRatio=1; global.innerWidth=1240; global.innerHeight=860;
global.addEventListener=()=>{}; global.removeEventListener=()=>{};
global.Image = function(){ this.onload=null; this.src=""; };
global.requestAnimationFrame=()=>0; global.cancelAnimationFrame=()=>{};
global.performance={now:()=>Date.now()};
global.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
global.navigator={userAgent:"node",language:"zh-CN"};
global.Audio=function(){ this.play=()=>{}; this.pause=()=>{}; };
global.speechSynthesis={ speak(u){spoken.push(u.text);}, cancel(){} };
global.SpeechSynthesisUtterance=function(t){ this.text=t; };

/* ── 假 THREE ── */
function Vec3(x,y,z){ this.x=x||0; this.y=y||0; this.z=z||0;
  this.set=()=>this; this.add=()=>this; this.sub=()=>this; this.copy=()=>this; this.normalize=()=>this; }
function deep(){ const o=function(){return deep();};
  return new Proxy(o,{ get(t,k){
    if(k==="children") return [];
    if(k==="position"||k==="rotation"||k==="scale"||k==="target") return new Vec3();
    if(k==="userData") return {};
    if(k==="shadow"||k==="capabilities") return { mapSize:{set(){}}, camera:{} };
    if(k==="color") return { getHexString:()=>"14514a" };
    if(k==="domElement") return fakeEl();
    if(["setSize","setPixelRatio","setClearColor","render","setAnimationLoop","add","remove","lookAt",
        "updateProjectionMatrix","setFromCamera"].includes(k)) return ()=>undefined;
    if(k==="load") return ()=>deep();
    if(k==="intersectObjects") return ()=>[];
    return deep();
  }, apply(){return deep();}, construct(){return deep();}}); }
global.THREE=deep();
global.THREE.REVISION="149"; global.THREE.SRGBColorSpace="srgb";
global.THREE.ACESFilmicToneMapping=4; global.THREE.PCFSoftShadowMap=2;
global.THREE.Vector3=Vec3; global.THREE.Vector2=Vec3;
global.THREE.Color=function(){ return { getHexString:()=>"14514a" }; };

/* ── 按页面顺序加载 ── */
try { new Function("window", fs.readFileSync(path.join(__dirname,"mahjong.js"),"utf8"))(global); }
catch(e){ console.log("mahjong.js 失败:", e.message); }
console.log("Engine:", !!global.Mahjong?.test?.Engine);

try { new Function("window", fs.readFileSync(path.join(__dirname,"mahjong.gl3d.js"),"utf8"))(global); }
catch(e){ console.log("gl3d 加载失败:", e.message); process.exit(1); }

const MJ = global.MJ3D;
console.log("hasEngine:", MJ.hasEngine());
try { MJ.init(fakeEl()); console.log("init OK"); } catch(e){ console.log("init 失败:", e.message); process.exit(1); }
try { MJ.reset(); const s = MJ.state();
  console.log("reset OK  手牌", s.hands[0].length, "墙", s.wallArr.length, "turn", s.turn, "over", s.over);
var sorted = s.hands[0].slice(0, s.hands[0].length - 1);
var okSort = true;
for (var i = 1; i < sorted.length; i++) if (sorted[i] < sorted[i - 1]) okSort = false;
console.log("手牌(前12):", sorted.slice(0, 12).join(","), "| 有序:", okSort);
} catch(e){ console.log("reset 失败:", e.message, "\n", e.stack.split("\n").slice(0,3).join("\n")); process.exit(1); }
/* 打一张，观察三家是否推进 */
try { MJ.debug.discard(0); } catch (e) { console.log("discard 失败:", e.message); }
setTimeout(function () {
  const s = MJ.state();
  console.log("3秒后 河:", s.disc.map(function (d) { return d.length; }).join("/"),
              "手牌:", s.hands[0].length, "墙:", s.wallArr.length, "turn:", s.turn, "over:", s.over);
  console.log("播报:", spoken.slice(0, 6).join(" / "));
  console.log("FULLTEST OK");
  process.exit(0);
}, 3000);
