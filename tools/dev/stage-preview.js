/*
  stage-preview.js —— 把 Fight2Stage 逐帧渲染成 MP4 样片（免开浏览器先看个大概）。

  ⚠ 定位：**近似预览**，不是像素级还原。
     - 用的是从 index.html 抽出来的**真实 Fight2Stage**：构图 / 站位 / 配色 / 镜头 / 节奏都是真的
     - 立绘也是真的：art/fight2/*.png 由 png-read.cjs 解码后喂进 drawImage
     - 但跑在一个"最小 canvas 实现"上（canvas-sink.cjs）：渐变按分段近似、文字用色块占位、无抗锯齿
     - 浏览器里的实际观感明显好于样片。样片用来判断"方向对不对"，不用来判断"好不好看"
     - 最终验收：浏览器打开 index.html → 标题屏「⚑ 跳到打斗 2.0」

  用法：
    node tools/dev/stage-preview.js                # 完美打法一局（含"化身进街机"过场）→ stage-preview.mp4
    node tools/dev/stage-preview.js nosdodge       # 换成"从不闪"，看挨打演出
    node tools/dev/stage-preview.js perfect nointro # 跳过街机过场，直接开打
    node tools/dev/stage-preview.js perfect skeleton # 强制走骨骼回落（看得到"按角色分的配色"）
    node tools/dev/stage-preview.js perfect noframe  # 关掉机内模式，出"干净舞台"样片
    $env:PV_SCALE="0.5"                            # 半分辨率出片（更快）

  ⚠ 为什么需要 skeleton 这个开关：配色表（莽夫暖红 / 陈默冷蓝）**只作用于骨骼回落路径** ——
     立绘就绪时走的是立绘分支，色表不参与绘制。想确认"两个角色配色不同"就必须摘掉立绘。
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const { readHtml, grabFn, grabConst, evalConstIn, serialize } = require("../../tests/lib/extract.cjs");
const { decodePng } = require("./png-read.cjs");
const { makeSink } = require("./canvas-sink.cjs");

const ROOT = path.join(__dirname, "..", "..");
const html = readHtml();
const MODE = process.argv[2] || "perfect";
const NO_INTRO = process.argv.includes("nointro");
const SKELETON = process.argv.includes("skeleton");
const FRAME_OFF = process.argv.includes("noframe");
const OUT = path.join(ROOT,
  FRAME_OFF ? "stage-preview-noframe.mp4" : (SKELETON ? "stage-preview-skeleton.mp4" : "stage-preview.mp4"));
const SCALE = Number(process.env.PV_SCALE || 1);
const W = Math.round(1680 * SCALE), H = Math.round(900 * SCALE), FPS = 30;

/* ── 真实立绘：解成 { w,h,px } 供 drawImage 用。
      skeleton 模式下刻意**不喂**，让 spriteOf() 返回 null → 走骨骼回落 → 才看得到配色。 ── */
const SPRITE_IMGS = {};
if (!SKELETON) {
  for (const slug of ["puncher", "brawler"]) {
    SPRITE_IMGS[slug] = {};
    for (const p of ["idle", "strike", "hit", "ko"]) {
      const f = path.join(ROOT, "art", "fight2", slug + "_" + p + ".png");
      try {
        const im = decodePng(fs.readFileSync(f));
        SPRITE_IMGS[slug][p] = { w: im.w, h: im.h, px: im.px, naturalWidth: im.w, naturalHeight: im.h };
      } catch (e) { /* 缺图就保持空 → spriteOf 返回 null → 骨骼回落 */ }
    }
  }
}

const prelude = `
  const FIGHT_GRADE_MULT = ${grabConst(html, "FIGHT_GRADE_MULT")};
  const FIGHT2_TUNE = ${grabConst(html, "FIGHT2_TUNE")};
  const FIGHT2_FOE_MOVES = ${grabConst(html, "FIGHT2_FOE_MOVES")};
  const FIGHT2_MOVES = ${grabConst(html, "FIGHT2_MOVES")};
  ${grabFn(html, "judgeGrade")}
  ${grabFn(html, "mashLoop")}
  ${grabFn(html, "judgeBar")}
  const Fight2Stage = ${serialize(evalConstIn(html, "Fight2Stage"))};
  var SFX=[],AFTER=[],RNG=0.5,CLOCK=0,FRAME_MS=1000/60,PENDING=[];
  var M=Object.create(Math); M.random=function(){return RNG;};
  var WIN={_h:{},addEventListener:function(t,f){(this._h[t]=this._h[t]||[]).push(f);},
    removeEventListener:function(t,f){var a=this._h[t]||[];var i=a.indexOf(f);if(i>=0)a.splice(i,1);}};
  var InputBus={owner:null,_kd:null,setOwner(o,h){this.release();this.owner=o;const x=h||{};
    if(x.keydown){this._kd=x.keydown;WIN.addEventListener("keydown",this._kd);}const s=this;
    return function(){if(s.owner===o)s.release();};},
    release(){if(this._kd){WIN.removeEventListener("keydown",this._kd);this._kd=null;}this.owner=null;}};
  var EL={};
  function mkEl(id){ if(EL[id])return EL[id];
    return (EL[id]={id:id,style:{},dataset:{},innerHTML:"",textContent:"",scrollTop:0,scrollHeight:0,onclick:null,
      classList:{_s:{},add:function(c){this._s[c]=1;},remove:function(c){delete this._s[c];},contains:function(c){return !!this._s[c];}},
      addEventListener:function(){},removeEventListener:function(){},
      click:function(){ if(this.onclick) this.onclick({stopPropagation:function(){}}); }}); }
  var document={getElementById:function(id){return mkEl(id);},querySelectorAll:function(s){
    if(s.indexOf("fight2Btns")<0) return [];
    return ["jab","combo","low","guard","read","skip"].map(function(a){var e=mkEl("b-"+a);e.dataset.act=a;return e;});}};
  function $(id){return mkEl(id);}
  var __cs2={};
  var window=WIN; window.__cs2=__cs2;
  var AudioSys={good:function(){},bad:function(){},ding:function(){},blip:function(){},play:function(){return true;}};
  var S={stats:{phy:18},fightWon:false};
  function afterInter(fx,why){ AFTER.push({fx:fx,why:why}); }
  function takeBuff(){return {};}
  function bonus(){return {};}
  function requestAnimationFrame(){ return 1; }
  function cancelAnimationFrame(){}
  var performance={now:function(){return CLOCK;}};
  var setTimeout=function(){return 0;};
  /* 立绘加载：真浏览器里是 Image + onload，这里直接同步填好（样片要的是成品画面）。
     __IMG 由宿主注入（见文末 runInNewContext 的第二个参数）。 */
  function Image(){ this.onload=null; this.onerror=null; this.width=0; this.height=0;
    this.naturalWidth=0; this.naturalHeight=0; }
  Object.defineProperty(Image.prototype,"src",{set:function(v){
    var m=/([a-z]+)_(idle|strike|hit|ko)\\.png$/.exec(String(v));
    var im=m && __IMG[m[1]] && __IMG[m[1]][m[2]];
    if(im){ this.width=this.naturalWidth=im.w; this.height=this.naturalHeight=im.h; this.w=im.w; this.h=im.h; this.px=im.px;
      if(this.onload) this.onload(); }
    else if(this.onerror) this.onerror();
  }});
`;

const api = new vm.Script("(function(){\n" + prelude + "\n" + grabFn(html, "startFight2") + "\n" +
  "return { startFight2:startFight2, EL:EL, Stage:Fight2Stage, AFTER:AFTER,\n" +
  "  step:function(){ var q=PENDING; PENDING=[]; CLOCK+=FRAME_MS; for(var i=0;i<q.length;i++) q[i](CLOCK); return q.length; },\n" +
  "  setRng:function(v){RNG=v;}, cs2:function(){return __cs2;} };\n" +
  "})()").runInNewContext({ console, Math: Object.create(Math), __IMG: SPRITE_IMGS });

const sink = makeSink(W, H, SCALE);
const foeHpOf = (() => {
  const i = html.indexOf("brawl2:{");
  const m = /type:"fight2"[\s\S]{0,120}?hp:(\d+)/.exec(html.slice(i, i + 1500));
  return m ? Number(m[1]) : 320;
})();
const stubCv = { getContext: () => sink.ctx };
api.setRng(0.5);
api.startFight2({ type: "fight2", title: "预览", hp: foeHpOf, perfect: {}, ok: {}, miss: {} });
api.Stage.begin(stubCv);
api.Stage.running = false;
if (NO_INTRO) { api.Stage.arcadeOn = false; api.Stage.arcade = 0; }
/* noframe：关掉机内模式，出"干净画面"的样片。
   为什么要这个开关：机身常驻后世界被缩放进 CRT 屏（kx=0.762），
   想单独看舞台构图/立绘比例时不该被机壳和缩放干扰。 */
if (FRAME_OFF) api.Stage.arcadeMode = false;

const F = () => api.cs2().fight2;
const st = () => F().state();
const plain = (s) => String(s).replace(/<[^>]+>/g, "");
function dirFromTell() {
  const t = plain(api.EL.fight2Tell.innerHTML);
  if (/左右晃动/.test(t)) return "down";
  if (/抬腿/.test(t)) return "up";
  return "left";
}
function dirWrong() { const r = dirFromTell(); return r === "left" ? "right" : r === "down" ? "up" : "down"; }
function strikeSelf(grade) {
  F().act("jab");
  const B = F().bars();
  const Lp = parseFloat(B.zone.style.left), Wp = parseFloat(B.zone.style.width);
  const target = grade === "good" ? Lp + Wp * 0.15 : Lp + Wp * 0.5;
  /* ⚠ 帧数按调参表的 BAR_SPEED 算，别写死：这个值被调过一次（2.2 → 1.1，玩家反馈完美区太难瞄），
     写死会让样片里的档位全部失真 —— 推到的位置只有目标的一半，全判成偏出。 */
  const spd = JSON.parse(grabConst(html, "FIGHT2_TUNE")).BAR_SPEED;
  const need = Math.round(target / spd);
  for (let i = 0; i < need; i++) api.step();
  if (B.bar.onclick) B.bar.onclick({ stopPropagation() {} });
}

const ff = spawn(process.env.FFMPEG || "ffmpeg",
  ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", W + "x" + H, "-r", String(FPS),
   "-i", "pipe:0", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", OUT],
  { stdio: ["pipe", "ignore", "inherit"] });

let frames = 0;
const emit = () => { ff.stdin.write(Buffer.from(sink.px)); frames++; };
const advance = (n) => { for (let i = 0; i < n; i++) { api.Stage.frameOnce(); emit(); } };

advance(FPS);
let g = 0;
while (F().alive && g++ < 400) {
  const s = st();
  advance(2);
  if (s.phase === "defend") {
    if (!F().defend(MODE === "nosdodge" ? dirWrong() : dirFromTell())) api.step();
    advance(10);
  } else if (s.stunMine) { F().act("jab"); advance(12); }
  else if (s.ap >= 2) { strikeSelf(MODE === "good" ? "good" : "perfect"); advance(14); }
  else { api.step(); advance(3); }
}
advance(FPS * 2);
ff.stdin.end();
ff.on("close", (code) => {
  const s = api.Stage.debugState();
  const spriteInfo = s.spriteReady ? JSON.stringify(s.spriteReady) : "-";
  console.log("帧数 " + frames + " · 回合 " + st().turn + " · 模式 " + MODE +
    (NO_INTRO ? " · 跳过过场" : "") + (SKELETON ? " · 强制骨骼" : "") + " · 分辨率 " + W + "x" + H);
  console.log("立绘就绪情况 " + spriteInfo + " · 本帧用的是 " +
    (s.spriteMe ? "立绘" : "骨骼回落") + " / " + (s.spriteFoe ? "立绘" : "骨骼回落"));
  if (SKELETON) {
    /* 骨骼模式下把两个角色的配色打出来 —— 这张片子存在的唯一理由就是验收配色。
       ⚠ palOf 是方法，解构出来必须 bind，否则 this 丢了（实测直接抛在 palOf 里）。 */
    const P = api.Stage.palOf.bind(api.Stage);
    for (const [slug, name] of [["player", "陈默"], ["brawler", "莽夫"]]){
      const t = P(slug);
      console.log("  " + name + "（" + slug + "）" + t.label +
        " 本体 " + t.near.main + " · 轮廓光 " + t.near.edge + " · 拳套收口 " + t.cuff);
    }
  }
  console.log(code === 0 ? "已生成 " + OUT : "ffmpeg 退出码 " + code);
  console.log("（近似预览：构图/节奏/立绘为真，渐变与文字做了简化；最终请在浏览器里看）");
});
