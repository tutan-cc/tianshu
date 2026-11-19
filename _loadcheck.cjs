/* 最小 DOM 桩，检查 mahjong.js 能否在非游戏页面加载并导出 Engine */
const fs = require("fs"), path = require("path");

function ctx2d() {
  return new Proxy({}, { get: (t, k) => {
    if (k === "canvas") return { width: 300, height: 150 };
    if (k === "measureText") return () => ({ width: 10 });
    if (k === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
    if (k === "createLinearGradient" || k === "createPattern" || k === "createRadialGradient")
      return () => ({ addColorStop() {} });
    return () => undefined;
  }});
}
function fakeEl() {
  return { style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, removeChild() {}, setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {}, querySelector: () => fakeEl(),
    querySelectorAll: () => [], getBoundingClientRect: () => ({ left:0, top:0, width:1240, height:860 }),
    getContext: () => ctx2d(), width: 1240, height: 860, innerHTML: "", textContent: "",
    children: [], clientWidth: 1240, clientHeight: 860 };
}
global.window = global;
global.document = { getElementById: () => null, createElement: () => fakeEl(),
  querySelector: () => null, querySelectorAll: () => [], body: fakeEl(),
  addEventListener() {}, head: fakeEl(), documentElement: fakeEl() };
global.devicePixelRatio = 1;
global.innerWidth = 1240; global.innerHeight = 860;
global.addEventListener = () => {}; global.removeEventListener = () => {};
global.Image = function () { this.onload = null; this.onerror = null; this.src = ""; };
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
global.performance = { now: () => Date.now() };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.navigator = { userAgent: "node", language: "zh-CN" };
global.Audio = function () { this.play = () => {}; this.pause = () => {}; this.load = () => {}; };

try {
  new Function("window", fs.readFileSync(path.join(__dirname, "mahjong.js"), "utf8"))(global);
  console.log("mahjong.js 加载 OK");
  console.log("Mahjong 存在:", !!global.Mahjong);
  console.log("Mahjong.test 存在:", !!(global.Mahjong && global.Mahjong.test));
  console.log("Engine 存在:", !!(global.Mahjong && global.Mahjong.test && global.Mahjong.test.Engine));
} catch (e) {
  console.log("mahjong.js 加载失败:", e.message);
  console.log(e.stack.split("\n").slice(0, 4).join("\n"));
}
