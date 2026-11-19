const fs = require("fs"), path = require("path");
const spoken = [];
const fakeEl = { clientWidth: 1240, clientHeight: 860, appendChild() {}, addEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1240, height: 860 }) };
function Vec3(x, y, z) { this.x = x||0; this.y = y||0; this.z = z||0;
  this.set = () => this; this.add = () => this; this.sub = () => this; this.copy = () => this; this.normalize = () => this; }
function deep() {
  const o = function () { return deep(); };
  return new Proxy(o, { get(tt, k) {
    if (k === "children") return [];
    if (k === "position" || k === "rotation" || k === "scale" || k === "target") return new Vec3();
    if (k === "userData") return {};
    if (k === "shadow" || k === "capabilities") return { mapSize: { set() {} }, camera: {} };
    if (k === "color") return { getHexString: () => "14514a" };
    if (k === "domElement") return fakeEl;
    if (k === "setSize" || k === "setPixelRatio" || k === "setClearColor" || k === "render" ||
        k === "setAnimationLoop" || k === "add" || k === "remove" || k === "lookAt" ||
        k === "updateProjectionMatrix" || k === "setFromCamera") return () => undefined;
    if (k === "load") return () => deep();
    if (k === "intersectObjects") return () => [];
    return deep();
  }, apply() { return deep(); }, construct() { return deep(); } });
}
global.window = global;
global.document = { getElementById: () => ({ textContent: "" }), createElement: () => fakeEl };
global.devicePixelRatio = 1; global.innerWidth = 1240; global.innerHeight = 860;
global.addEventListener = () => {}; global.removeEventListener = () => {};
global.speechSynthesis = { speak(u) { spoken.push(u.text); }, cancel() {} };
global.SpeechSynthesisUtterance = function (t) { this.text = t; };
global.setTimeout = setTimeout;
global.THREE = deep();
global.THREE.REVISION = "149"; global.THREE.SRGBColorSpace = "srgb";
global.THREE.ACESFilmicToneMapping = 4; global.THREE.PCFSoftShadowMap = 2;
global.THREE.Vector3 = Vec3; global.THREE.Vector2 = Vec3;
global.THREE.Color = function () { return { getHexString: () => "14514a" }; };

new Function("window", fs.readFileSync(path.join(__dirname, "mahjong.gl3d.js"), "utf8"))(global);
const MJ = global.MJ3D;
MJ.init(fakeEl);
const st = MJ.debug.state();

console.log("起始 手牌", st.hands[0].length, "墙", st.wallArr.length, "turn", st.turn);

// 连打 3 张（每张之间等三家走完约 2.8s）
(async () => {
  let ok = 0, total = 0;
  for (let n = 0; n < 2; n++) {
    MJ.debug.discard(0);
    await new Promise(r => setTimeout(r, 4200));
    const s = MJ.debug.state();
    const sum = s.disc[0].length + s.disc[1].length + s.disc[2].length + s.disc[3].length;
    total = sum;
    console.log(`第${n + 1}轮 河: 你${s.disc[0].length} 下${s.disc[1].length} 对${s.disc[2].length} 上${s.disc[3].length} | 手${s.hands[0].length} 墙${s.wallArr.length}`);
  }
  console.log("播报条数", spoken.length, "| 样例", spoken.slice(0, 5).join(" / "));
  if (total === 8) ok++;
  if (spoken.length >= 8) ok++;
  const s2 = MJ.debug.state();
  if (s2.turn === 0) ok++;
  console.log("HEADLESS " + ok + "/3");
  process.exit(0);
})();
