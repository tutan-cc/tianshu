#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 测试截图/bf_happy_audition.html（试听页 v2 · bf-10）。

数据全部来自实测 JSON，不手写：
  · A 组（已启用）/ B 组（未启用对照）：tools/bf/measure_audition.py 量的 F0 + 时长
  · C 组（备选 happy_i*）：tools/bf/gen_bf_happy_i.py --report 量的 F0 + omni 盲听转写
页面本身**无外链、无 CDN**：音频走相对路径 ../audio/bf/xxx.mp3，样式/脚本内联。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC_AUDIO = os.path.join(os.path.dirname(REPO), "audio-工作区", "_bf_happy_i_src")
PAGE = os.path.join(REPO, "测试截图", "bf_happy_audition.html")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def f0(row):
    ps = row.get("pitch") or {}
    return ("%+.1f%%" % (ps.get("delta_pct") or 0)), round(row.get("dur") or 0, 2), (ps.get("delta_hz") or 0)


def main():
    ab = load(os.path.join(HERE, "_patch", "bf10_audition_data.json"))
    rep = load(os.path.join(SRC_AUDIO, "_bf_happy_i_report.json"))
    omni = load(os.path.join(SRC_AUDIO, "_bf_happy_i_omni.json"))

    KEEP = ["happy_i10", "happy_i26", "happy_i38", "happy_i45", "happy_i47", "happy_i55"]
    heard = {r["name"]: r["heard"] for r in omni["rows"]}
    irows = {r["name"]: r for r in rep["rows"]}

    def pack(row, extra=None):
        pct, dur, dhz = f0(row)
        ps = row.get("pitch") or {}
        short = row["id"].replace("happy_", "")          # 页面上显示短号（v1 / alt2 / i10）
        d = {"id": row["id"], "short": short,
             "file": row.get("file") or (row["id"] + ".mp3"),
             "text": row["text"], "voice": row["voice"], "dur": dur,
             "pct": pct, "dhz": dhz,
             "f0a": round(ps.get("f0_first") or 0), "f0b": round(ps.get("f0_last") or 0),
             "rise": bool(ps.get("rising"))}
        if extra:
            d.update(extra)
        return d

    A = [pack(r, {"on": True}) for r in ab["A"]]
    B = [pack(r, {"on": False}) for r in ab["B"]]
    C = []
    for nm in KEEP:
        r = irows[nm]
        h = heard.get(nm, [])
        C.append(pack({"id": nm, "file": nm + ".mp3", "text": r["text"], "voice": r["voice"],
                       "dur": r["dur"], "pitch": r["pitch"]},
                      {"on": False, "heard": " ／ ".join(h), "tier": r.get("tier", "t")}))

    data = {"A": A, "B": B, "C": C}
    html = TEMPLATE.replace("__DATA__", json.dumps(data, ensure_ascii=False, indent=1))
    with open(PAGE, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print("→ " + PAGE)
    print("A 组 %d 条 · B 组 %d 条 · C 组 %d 条" % (len(A), len(B), len(C)))
    return 0


TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>早餐店 · 拿到早餐的欢呼（试听 v2 · 已启用 / 对照 / 备选）</title>
<style>
  :root{
    --bg:#1a1220; --card:#2a1b2e; --line:#4a3350;
    --ink:#f6eef8; --dim:#b9a6c2; --gold:#ffd76e; --pink:#ff9ec7; --green:#5dffa0; --red:#ff6b8a;
  }
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,#150e1b,#1f1425 40%,#150e1b);color:var(--ink);
       font:15px/1.7 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;padding:28px 18px 80px}
  .wrap{max-width:1120px;margin:0 auto}
  h1{font-size:23px;margin:0 0 6px}
  h2{font-size:18px;margin:34px 0 6px;padding-left:10px;border-left:4px solid var(--pink)}
  h2 .cnt{color:var(--dim);font-size:14px;font-weight:400;margin-left:8px}
  p.lead{color:var(--dim);margin:8px 0 0}
  .note{background:#241a2c;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:16px 0;color:var(--dim);font-size:14px}
  .note b{color:var(--gold)}
  .key{background:#20303a;border-color:#2f5a6b}
  .key b{color:#9fd7ff}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;margin-top:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
  .card.on{border-color:#3f7a55;background:linear-gradient(180deg,#22342a,#2a1b2e)}
  .chead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .id{font-weight:700;font-size:17px;color:var(--gold)}
  .say{font-size:19px;margin:8px 0 4px}
  .meta{color:var(--dim);font-size:13px}
  .bar{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}
  button.play{background:var(--pink);color:#2a0f1e;border:0;border-radius:999px;padding:9px 18px;
       font-size:15px;font-weight:700;cursor:pointer}
  button.play:hover{filter:brightness(1.08)}
  button.play:active{transform:translateY(1px)}
  .tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
  .rise{color:var(--green);border-color:#2f6b48}
  .fall{color:var(--red);border-color:#6b2f42}
  .on-tag{color:#b8ffcf;border-color:#3f7a55;background:#1d3527}
  .off-tag{color:#d8c6e0;border-color:#4a3350}
  .heard{font-size:13px;color:#9fd7ff;margin-top:8px;min-height:20px}
  audio{display:none}
  code{background:#241a2c;border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px;color:var(--gold)}
  .foot{margin-top:36px;font-size:14px;color:var(--dim)}
  .playall{margin:10px 0 0}
  .playall button{background:#3a2a44;color:var(--ink);border:1px solid var(--line);border-radius:999px;
       padding:7px 15px;font-size:14px;cursor:pointer;margin-right:8px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🍳 早餐店 · 顾客拿到早餐时喊的那一声 —— 试听</h1>
  <p class="lead">页面顶部一句话：<b>挑定后只要告诉编号，我就只保留那一条</b>
     （现在 A 组 6 条都在游戏里随机轮换、不连着重复）。</p>

  <div class="note key">
    <b>当前游戏真正在用的是哪 6 条？</b> —— 看 <b>A 组</b>：卡片是绿边、带
    <span class="tag on-tag">✅ 已启用</span>。B 组 / C 组都标
    <span class="tag off-tag">未启用</span>，只在硬盘上留着做对比，游戏里一句都不会播。<br>
    A 组的顺序 = <code>breakfast.js</code> 里 <code>BF_SFX_FILES.happy</code> 的顺序，
    也就是每次上餐随机取一条的那个池子。
  </div>

  <div class="note">
    <b>这一版怎么来的</b>：用户听完上一版说「使用 A 组，但把 A 组里的 v2 换成 alt2；v4 换成 alt3」——
    所以 A 组 = 原来的 v1 / v3 / v5 / v6 加上被挑中的两条对照件 alt2、alt3，v2 与 v4 出池。<br>
    <b>B 组</b>是最早按建议文本直出、这一轮没被选中的 4 条对照件；
    <b>C 组</b>是本轮额外做的「语气助词」备选（先做了 57 条，按
    <b>F0 上扬 + omni 盲听念对 + 时长合适</b> 三条判据筛到 6 条，其余 51 条已删除）。<br>
    <b>音高走向</b>是自相关逐帧量的基频 F0：前 40% 中位数 → 后 40% 中位数，
    正数 = 往上走（上扬）。
  </div>

  <h2>A 组 · 已启用（游戏里现在轮换的就是这 6 条）<span class="cnt" id="cntA"></span></h2>
  <div class="playall"><button onclick="playAll('A')">▶ 连播本组</button></div>
  <div class="grid" id="gA"></div>

  <h2>B 组 · 对照件（未启用 · 本轮没被挑中的 4 条）<span class="cnt" id="cntB"></span></h2>
  <div class="playall"><button onclick="playAll('B')">▶ 连播本组</button></div>
  <div class="grid" id="gB"></div>

  <h2>C 组 · 备选（未启用 · 本轮新做的语气助词，57 条里筛出的 6 条）<span class="cnt" id="cntC"></span></h2>
  <p class="meta">这一组是「如果哪天还想换」的备选：每条都过了 omni 盲听（转写原话写在卡片上）、
     F0 实测上扬、时长在 0.4~2.6s。想启用哪条，同样一句话就行。</p>
  <div class="playall"><button onclick="playAll('C')">▶ 连播本组</button></div>
  <div class="grid" id="gC"></div>

  <h2>挑定之后怎么「只保留一条」</h2>
  <div class="note">
    现在 6 条都在轮换池（<code>breakfast.js</code> 的 <code>BF_SFX_FILES.happy</code>）。
    例如只说一句「只留 alt3」，就把那一行改成：<br>
    <code>happy: ["happy_alt3.mp3"],</code><br>
    改完：单条时 <code>audio.pick()</code> 恒返回 0 —— 不再随机、不再轮换。
  </div>

  <div class="foot">
    数据来源：<code>tools/bf/measure_audition.py</code>（A/B 组时长 + F0）、
    <code>tools/bf/gen_bf_happy_i.py --report / --listen</code>（C 组时长 + F0 + omni 盲听），
    再用 <code>tools/bf/make_audition_page.py</code> 生成本页 —— 数字全是实测，没有手写。<br>
    本页无外链、无 CDN：音频走相对路径 <code>../audio/bf/*.mp3</code>，离线也能打开。
    密钥只在进程环境变量里用过，没有写进任何文件。
  </div>
</div>

<script>
var DATA = __DATA__;
var els = {};
function card(v, gi){
  var rise = v.rise;
  var d = document.createElement("div");
  d.className = "card" + (v.on ? " on" : "");
  var badge = v.on ? '<span class="tag on-tag">✅ 已启用</span>'
                   : '<span class="tag off-tag">未启用</span>';
  var heard = v.heard ? '<div class="heard">omni 盲听：' + v.heard + '</div>' : '';
  d.innerHTML =
    '<div class="chead"><span class="id">' + v.short + '</span>' + badge +
    '<span class="tag ' + (rise ? "rise" : "fall") + '">' + (rise ? "↗ 上扬 " : "↘ 下降 ") + v.pct + '</span>' +
    '<span class="tag">' + v.voice + '</span>' +
    '<span class="tag">' + v.dur.toFixed(2) + 's</span></div>' +
    '<div class="say">「' + v.text + '」</div>' +
    '<div class="meta">F0 前→后：' + v.f0a + ' → ' + v.f0b + ' Hz（' + (v.dhz > 0 ? "+" : "") + v.dhz.toFixed(1) + ' Hz）　·　文件 <code>' + v.file + '</code></div>' +
    heard +
    '<div class="bar"><button class="play">▶ 播放 ' + v.short + '</button></div>';
  var au = document.createElement("audio");
  au.preload = "none";
  au.src = "../audio/bf/" + v.file;
  var b = d.querySelector("button.play");
  au.addEventListener("play", function(){
    Object.keys(els).forEach(function(k){ if (els[k] !== au) { try { els[k].pause(); } catch(e){} } });
    b.textContent = "⏸ 播放中…";
  });
  au.addEventListener("ended", function(){ b.textContent = "▶ 播放 " + v.short; });
  b.onclick = function(){
    if (!au.paused) { au.pause(); au.currentTime = 0; b.textContent = "▶ 播放 " + v.short; return; }
    au.currentTime = 0;
    au.play().catch(function(e){ b.textContent = "播放失败：" + e.message; });
  };
  els[gi + ":" + v.id] = au;
  d.appendChild(au);
  return d;
}
function render(key, host, gi){
  var list = DATA[key];
  list.forEach(function(v){ host.appendChild(card(v, gi)); });
  document.getElementById("cnt" + key).textContent = "（" + list.length + " 条）";
}
render("A", document.getElementById("gA"), "A");
render("B", document.getElementById("gB"), "B");
render("C", document.getElementById("gC"), "C");
/* 连播本组：一条播完接一条（用户想"整组感受一下"时不用手点六次）*/
var playing = null;
function playAll(key){
  if (playing) { playing.stop = true; playing = null; }
  var list = DATA[key].slice();
  var state = { stop: false };
  playing = state;
  (function next(i){
    if (state.stop || i >= list.length) { playing = null; return; }
    var au = els[key + ":" + list[i].id];
    var done = function(){
      au.removeEventListener("ended", done);
      setTimeout(function(){ next(i + 1); }, 450);
    };
    au.addEventListener("ended", done);
    au.currentTime = 0;
    au.play().catch(function(){ playing = null; });
  })(0);
}
</script>
</body>
</html>
"""


if __name__ == "__main__":
    sys.exit(main())
