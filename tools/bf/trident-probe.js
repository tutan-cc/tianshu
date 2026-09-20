/* ═══════════════════════════════════════════════════════════════════════════
   tools/bf/trident-probe.js — Trident / IE11（mshta）兼容性探针

   为什么要单独有一个（而不是只用 tools/e2e/bf.js 的模式 B）：
     用户实测被那个探针**弹到脸上**：窗口可见 + IE 弹模态「脚本发生错误」
       （breakfast.js 用了 IE11 没有的 Canvas2D.ellipse）。
     现在 breakfast.js 已经补了 ellipse 的 polyfill，需要一个**能自己说清楚跑到哪一步**的
     最小探针来证明「Trident 里不再报错、而且真的画出来了」。
     bf.js 的 HTA 模板给不出中间过程：它只在最后写一次结果，失败时只留一句"未产出结果"。

   三条纪律（对应用户要求，也是本脚本存在的意义）：
     ① 不弹窗：脚本一解析就把窗口移到屏幕外 + 缩到最小；
     ② 不弹错：window.onerror 里 return true（抑制 IE 的模态报错框），
        同时把错误写进结果文件并关窗 —— 异步失败也能被验收看见；
     ③ 跑完自关 + 不留中间文件：跑完/看门狗超时都会 finish() → window.close()，
        Node 侧无论成败都删掉 _bf_trident_probe.* 临时文件。

   证据口径：
     nativeEllipseBefore  —— 加载 breakfast.js **之前** Trident 有没有原生 ellipse（IE11：没有）
     ellipseAfter         —— start() 之后拿到的 ctx 有没有 ellipse（有 = polyfill 装上了）
     errors               —— window.onerror 捕获到的脚本错误（目标：空数组）
     pixels               —— 画布非空白像素占比（目标：> 0.5，证明真的画出来了）

   用法：node tools/bf/trident-probe.js
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "..");
const MSHTA = process.env.MSHTA_PATH || "C:\\Windows\\System32\\mshta.exe";
const HTA = path.join(OUT, "_bf_trident_probe.hta");
const LOG = path.join(OUT, "_bf_trident_probe.log");
const RES = path.join(OUT, "_bf_trident_probe.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* HTA 脚本刻意只用 ES3/ES5 基础语法（不用 JSON / map / filter）：
   mshta 默认可能是老文档模式，宁可用最笨的写法也不赌。

   ⚠⚠ 编码这条是实测踩出来的（也是"探针一直不产出结果"的真凶）：
     mshta/IE 读 .hta **默认按 ANSI(GBK)** 解码，不看 BOM 之外的任何东西 ——
     仓库路径里有中文（…\重生2-原型\），脚本里的 `DIR = "C:\...\重生2-原型\"`
     在 UTF-8 无 BOM 文件里被当 GBK 读 → 路径变乱码 → FSO 建文件抛异常 →
     结果文件与日志**一个都写不出来**，看起来就像"探针没跑"。
     两道一起上：① 文件写成 **UTF-8 + BOM**；② head 里加 charset=utf-8 的 meta。 */
function htaSource(jsDir) {
  return [
    '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
    '<script>',
    'var fso = new ActiveXObject("Scripting.FileSystemObject");',
    'var DIR = ' + JSON.stringify(jsDir) + ';',
    'var NAME = "_bf_trident_probe";',
    'var __done = false;',
    'function log(s){ try{ var f=fso.OpenTextFile(DIR+NAME+".log", 8, true, -1); f.WriteLine(s); f.Close(); }catch(e){} }',
    '/* 第三个参数 true = Unicode(UTF-16LE)：默认 ANSI 写出来 Node 按 UTF-8 读会全是乱码 */',
    'function w(name, txt){ var f=fso.CreateTextFile(DIR+name, true, true); f.Write(txt); f.Close(); }',
    'function finish(json){',
    '  if(__done) return true;',
    '  __done = true;',
    '  try{ w(NAME+".json", json); }catch(e){}',
    '  try{ log("finish"); }catch(e){}',
    '  try{ window.close(); }catch(e){}',
    '  return true;',
    '}',
    'function fail(msg, where){',
    '  var m = String(msg).replace(/"/g, "\'").replace(/[\\r\\n]/g, " ");',
    '  log("ERROR " + m + " @" + where);',
    '  return finish(\'{"ok":false,"error":"\' + m + \'","where":"\' + where + \'"}\');',
    '}',
    'window.onerror = function(m, u, l){ return fail(m, "line " + l); };',
    'try{ window.moveTo(-4000,-4000); window.resizeTo(260,180); }catch(e){}',
    'var nativeBefore = false;',
    'try{ nativeBefore = (typeof CanvasRenderingContext2D !== "undefined" && CanvasRenderingContext2D.prototype && typeof CanvasRenderingContext2D.prototype.ellipse === "function"); }catch(e){}',
    'log("boot nativeEllipseBefore=" + nativeBefore);',
    'function boot(){',
    '  log("onload");',
    '  try{',
    '    document.body.innerHTML = \'<div id="host" style="width:1080px;height:620px"></div>\';',
    '    var s = document.createElement("script");',
    '    s.src = "breakfast.js";',
    '    s.onload = function(){ try{ step1(); }catch(e){ fail(e.message, "step1"); } };',
    '    s.onerror = function(){ fail("breakfast.js 加载失败", "script.onerror"); };',
    '    document.body.appendChild(s);',
    '    setTimeout(function(){ if(!__done){ fail("看门狗超时", "watchdog"); } }, 40000);',
    '  }catch(e){ fail(e.message, "boot"); }',
    '}',
    'function step1(){',
    '  log("breakfast.js loaded, Breakfast=" + (typeof window.Breakfast));',
    '  var B = window.Breakfast;',
    '  if(!B || !B.start){ return fail("window.Breakfast 未暴露", "step1"); }',
    '  var host = document.getElementById("host");',
    '  var ok = B.start(host, { target:{ id:"su", name:"Su", bond:40 }, duration:999, goal:99, onFinish:function(){} });',
    '  log("start()=" + ok);',
    '  if(ok !== true) return fail("start() 返回非 true", "step1");',
    '  var d = B.debug;',
    '  log("running=" + d.state().running);',
    '  /* 把 9 列都下上料、放两位顾客 → 让所有绘制分支（含 ellipse 那几处）都跑到 */',
    '  var foods = B.FOOD_IDS;',
    '  for(var i=0;i<foods.length;i++){ try{ d.drop(foods[i], null); }catch(e){ log("drop " + foods[i] + " -> " + e.message); } }',
    '  try{ d.pushCustomer(); d.pushCustomer(); }catch(e){ log("pushCustomer -> " + e.message); }',
    '  for(var t=0;t<240;t++) d.tick(1/60);            // 逻辑推进（绘制由 rAF 循环做）',
    '  log("ticked, plates=" + d.plates().length + " burnt=" + d.state().burnt);',
    '  setTimeout(step2, 900);                          // 留时间让 rAF 真的画几帧',
    '}',
    'function step2(){',
    '  try{',
    '    var host = document.getElementById("host");',
    '    var cv = host.getElementsByTagName("canvas")[0];',
    '    if(!cv) return fail("找不到 canvas", "step2");',
    '    var g = cv.getContext("2d");',
    '    var ellipseAfter = (typeof g.ellipse === "function");',
    '    var img = g.getImageData(0,0,cv.width,cv.height).data;',
    '    var nonBlack=0, samples=0, seen={}, colors=0;',
    '    for(var y=0;y<cv.height;y+=8){',
    '      for(var x=0;x<cv.width;x+=8){',
    '        var k=(y*cv.width+x)*4; samples++;',
    '        if(img[k]+img[k+1]+img[k+2] > 36) nonBlack++;',
    '        seen[(img[k]>>5)+"_"+(img[k+1]>>5)+"_"+(img[k+2]>>5)] = 1;',
    '      }',
    '    }',
    '    for(var key in seen){ if(seen.hasOwnProperty(key)) colors++; }',
    '    var B = window.Breakfast;',
    '    var st = B.debug.state();',
    '    log("pixels " + nonBlack + "/" + samples + " colors=" + colors + " ellipseAfter=" + ellipseAfter);',
    '    finish(\'{"ok":true,"nativeEllipseBefore":\' + nativeBefore +',
    '           \',"ellipseAfter":\' + ellipseAfter +',
    '           \',"canvas":{"w":\' + cv.width + \',"h":\' + cv.height + \'}\' +',
    '           \',"pixels":{"samples":\' + samples + \',"nonBlack":\' + nonBlack + \',"colors":\' + colors + \'}\' +',
    '           \',"state":{"running":\' + st.running + \',"plates":\' + B.debug.plates().length + \',"burnt":\' + st.burnt + \'}\' +',
    '           \',"errors":[]}\');',
    '  }catch(e){ return fail(e.message, "step2"); }',
    '}',
    'window.onload = boot;',
    '</script></head><body></body></html>'
  ].join("\r\n");
}

(async () => {
  const checks = [], errors = [];
  const A = (ok, name, detail) => {
    const line = name + (detail === undefined ? "" : "  [" + detail + "]");
    ok ? checks.push(line) : errors.push(line);
  };
  if (!fs.existsSync(MSHTA)) {
    console.log("[跳过] 没有 mshta.exe：" + MSHTA);
    process.exit(0);
  }
  for (const f of [HTA, LOG, RES]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }

  /* ⚠ 必须带 UTF-8 BOM：mshta 按 ANSI 读 .hta，仓库路径里的中文会变乱码（见文件头注释） */
  fs.writeFileSync(HTA, "\ufeff" + htaSource(OUT + "\\"), "utf8");
  const p = spawn(MSHTA, [HTA], { stdio: "ignore", cwd: OUT });

  let res = null;
  for (let i = 0; i < 90; i++) {                 // 最多等 45 秒（HTA 内部 40 秒看门狗）
    await sleep(500);
    if (fs.existsSync(RES)) {
      const raw = fs.readFileSync(RES, "utf16le").replace(/^\ufeff/, "");   // HTA 写的是 UTF-16LE
      if (raw.trim().endsWith("}")) { try { res = JSON.parse(raw); break; } catch (e) {} }
    }
    if (p.exitCode !== null) break;
  }
  await sleep(400);
  try { p.kill(); } catch (e) {}
  const logTxt = fs.existsSync(LOG)
    ? fs.readFileSync(LOG, "utf16le").replace(/^\ufeff/, "").trim().split(/\r?\n/) : [];

  /* ── 断言 ── */
  A(!!res, "HTA 探针产出了结果文件（跑完就自关，不留窗口）",
    res ? "ok=" + res.ok : "无结果；进度日志：" + JSON.stringify(logTxt.slice(-6)));
  if (res) {
    A(res.ok === true, "Trident 里加载 breakfast.js + 开局 + 推进 240 帧，全程没有脚本错误",
      res.ok === true ? "errors=[]" : ("error=" + res.error + " @" + res.where));
    A(res.nativeEllipseBefore === false,
      "IE11/Trident 确实**没有**原生 Canvas2D.ellipse（这就是当初弹错的原因）",
      String(res.nativeEllipseBefore));
    A(res.ellipseAfter === true, "ellipse polyfill 在 Trident 里装上了（start() 之后 ctx.ellipse 可用）",
      String(res.ellipseAfter));
    const px = res.pixels || {};
    A(px.samples > 0 && px.nonBlack / px.samples > 0.5,
      "画布真的画出来了（非空白像素占比 > 50%）",
      px.nonBlack + "/" + px.samples + " = " + (px.samples ? (px.nonBlack / px.samples * 100).toFixed(1) : 0) + "%");
    A(px.colors >= 8, "画面色彩丰富（色块数 ≥ 8）", String(px.colors));
    A(res.state && res.state.running === true, "一整段推进后游戏仍在运行（没被兼容问题打断）",
      JSON.stringify(res.state));
  }
  A(fs.existsSync(LOG), "探针写了进度日志（失败时可定位到哪一步）", logTxt.slice(-4).join(" | "));

  /* ── 清理：临时文件一个都不留（HTA 自己删不了文件，由 Node 侧统一删）── */
  const before = [HTA, LOG, RES].filter(f => fs.existsSync(f)).map(f => path.basename(f));
  for (const f of [HTA, LOG, RES]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  const stillThere = fs.readdirSync(OUT).filter(f => /^_bf_trident/.test(f));
  A(stillThere.length === 0, "跑完工作区无 _bf_trident* 残留（HTA / 日志 / 结果都由 Node 侧删除）",
    before.length ? ("删掉：" + before.join(",")) : "本来就没留下");

  console.log("── Trident(mshta/IE11) 兼容探针 ──");
  checks.forEach(c => console.log("  ✔ " + c));
  errors.forEach(e => console.log("  ✗ " + e));
  if (logTxt.length) console.log("  进度日志：" + logTxt.join(" → "));
  console.log("[结果] 通过 " + checks.length + "，失败 " + errors.length +
    (errors.length ? " | " + errors.join(" | ") : ""));
  process.exit(errors.length ? 1 : 0);
})();
