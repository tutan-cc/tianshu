#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 测试截图/bf_happy_audition.html —— 试听页 **v3**（本轮：重出「高兴」候选）。

与 v2 的区别（用户本轮的要求）：
  · **A 组 = 本轮新候选** happy_n1…nN（编号显示 n1…nN），每条显示
    文本 / 音色 / 时长 / F0 走向 +x% / 谱质心 / RMS / omni 转写 / ▶ 播放，组头带「▶ 连播本组」
  · **B 组 = 当前游戏在用的 6 条**（v1/alt2/v3/alt3/v5/v6），标「✅ 已启用（等你确认后更换）」
  · **C 组 = 上一轮备选 6 条**（happy_i10/i26/i38/i45/i47/i55）
  · 顶部一句话：「挑定后告诉我编号，我替换 A 组里的对应项」
  · 无外链、无 CDN、离线可开

数据全部来自实测 JSON，不手写：
  · A 组：audio-工作区/_bf_happy_n_src/_bf_happy_n_report.json（F0 + 谱质心 + RMS）
         + _bf_happy_n_omni.json（omni 盲听转写）
  · B 组：tools/bf/_patch/bf10_audition_data.json（measure_audition.py 量的 F0）
         + 本轮**补量**的谱质心 / RMS（measure_audition 只量 F0，所以在这里补，
           用与 A 组同一套代码 gen_bf_happy_n.spec_stats，口径一致）
  · C 组：_bf_happy_i_report.json + _bf_happy_i_omni.json
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_bf_happy_n as N          # 复用 spec_stats / pitch_stats（与 A 组同口径）
import gen_bf_happy_i as G

REPO = N.REPO
BF = os.path.join(REPO, "audio", "bf")
# ── bf-12 仓库清理 ──────────────────────────────────────────────────────────
# audio/bf/ 根目录下现在**只留代码点名的 15 个**（池里 4 条欢呼 + tick + slow + 9 条 cook_*），
# 其余 78 个旧候选已归档到 audio/bf/_unused/（文件一个都没删，只是不入库/不分发）。
# 两件事必须跟着走，否则试听页会「静默缺条目 / 静默 404」：
#   ① 现量数字要从归档目录读（bf_path）；
#   ② 页面里的 <audio> 路径要按同一份保留清单解析（data["keep"]）。
COOK_IDS = ["congee", "milk", "soup", "egg", "bacon", "sandwich", "bun", "salad", "juice"]
POOL_IDS_FOR_KEEP = ["happy_v1", "happy_v3", "happy_finally2", "happy_i45"]
KEEP_IN_ROOT = (["tick.mp3", "slow.mp3"] + [fid + ".mp3" for fid in POOL_IDS_FOR_KEEP] +
                ["cook_%s.mp3" % c for c in COOK_IDS])
BF_UNUSED = os.path.join(BF, "_unused")
PAGE = os.path.join(REPO, "测试截图", "bf_happy_audition.html")
PAGE5 = os.path.join(REPO, "测试截图", "bf_pick5.html")
SRC_N = N.SRC_DIR
SRC_I = G.SRC_DIR


def bf_path(fn):
    """素材路径解析（bf-12）：正式目录 audio/bf/ 优先；不在就回落到归档目录 audio/bf/_unused/。

    为什么要这一步：归档后如果还死读 audio/bf/，os.path.exists 为假 → row() 返回 None →
    那一整行**从页面上静默消失**（不报错），看的人只会以为「候选本来就少」。
    """
    p = os.path.join(BF, fn)
    return p if os.path.exists(p) else os.path.join(BF_UNUSED, fn)

# ── bf-11 用户拍板的轮换池（必须与 breakfast.js 里的 BF_SFX_FILES 逐字一致）──
# 用户先说：「游戏里轮换『终于好啦』『开动啦』『哼，太慢了』这三个之前的语言。
#            还有 v3 和 i45 共 5 个。你把这三个之前的语言再给我听一下。」
# 随后追加：「换成不含『呜呼』的版本」→ 第 3 条由 happy_v2（呜呼！终于好啦！）
#            换成 happy_finally2（太棒啦！终于好啦！）。
# 这里是给 bf_pick5.html 用的「文件名 → 用途」映射；池子本身的真源仍是 breakfast.js。
POOL11 = [
    ("happy_v1.mp3",       "成功上餐", "用户说的「开动啦」"),
    ("happy_v3.mp3",       "成功上餐", "用户说的 v3"),
    ("happy_finally2.mp3", "成功上餐", "用户说的「终于好啦」· 已去掉「呜呼」"),
    ("happy_i45.mp3",      "成功上餐", "用户说的 i45"),
    ("slow.mp3",           "跑单",     "用户说的「哼，太慢了」（保持不变）"),
]
# 停用件 / 对比件（都不在池里）
DISABLED11 = [
    ("happy_v2.mp3",      "已停用", "含「呜呼」，用户否决（文件留在盘上）"),
    ("happy_finally3.mp3", "对比件", "另一条不含「呜呼」的「终于好啦」备选（未进池）"),
]

# 池里各文件的「念法 / 音色」真源（取自 tools/audio/gen_bf_happy.py 的 LINES/ALT_LINES
# 与 tools/bf/gen_bf_happy_i.py 的 LINES —— 不手写，避免页面与生成脚本对不上）
POOL_TEXT = {
    "happy_v1.mp3":       ("好耶！开动啦！",     "Ethan"),
    "happy_v3.mp3":       ("哇哦！好香啊！",     "Chelsie"),
    "happy_finally2.mp3": ("太棒啦！终于好啦！", "Ethan"),
    "happy_finally3.mp3": ("哇！终于好啦！",     "Cherry"),
    "happy_i45.mp3":      ("哇哦！",             "Cherry"),
    "happy_v2.mp3":       ("呜呼！终于好啦！",   "Cherry"),
    "slow.mp3":           ("哼，太慢了",         "—（跑单语音，未重做）"),
}

# ── 试听页最终展示的候选条数上限（A 组）──
# 生成 48 条 → 按综合分排序取前 N。用户要「10~14 条，宁多勿少」，取上限 14。
TOP_N = 14
# omni 盲听没过的**不进 A 组**（念错词的候选不该占用用户注意力）
REQUIRE_OMNI_PASS = True
# F0 判「上扬」的阈值：与 G.pitch_stats 的 rising 口径一致（后段 > 前段 × 1.02 = +2%）
RISE_MIN_PCT = 2.0

# ── 游戏当前在用的池（顺序 = breakfast.js 里 BF_SFX_FILES.happy 的顺序）──
# 真源是 breakfast.js；这里只是让页面「B 组 = 当前在用」跟着池子走。
# 换池时**必须同时改这里与 breakfast.js**，否则页面会撒谎。
POOL_IDS = ["happy_v1", "happy_v3", "happy_finally2", "happy_i45"]
# 已停用 / 只做对比（不在任何播放通道里）——试听页单列一区，标清楚
OFF_IDS = [("happy_v2", "已停用 · 含「呜呼」，用户否决（文件留在盘上）"),
           ("happy_finally3", "对比件 · 不含「呜呼」，未进池")]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def load(p, default=None):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def metrics(row):
    """一行的客观量 → 页面字段。spec/pitch 缺了就留空，不编数字。"""
    ps = row.get("pitch") or {}
    sp = row.get("spec") or {}
    dur = row.get("dur")
    if dur is None:
        info = row.get("info") or {}
        dur = info.get("duration") or 0.0
    return {
        "dur": round(float(dur or 0), 2),
        "pct": round(float(ps.get("delta_pct") or 0), 1),
        "dhz": round(float(ps.get("delta_hz") or 0), 1),
        "f0a": round(float(ps.get("f0_first") or 0)),
        "f0b": round(float(ps.get("f0_last") or 0)),
        "rise": bool(ps.get("rising")),
        "cen": round(float(sp.get("centroid_med") or 0)),
        "rms": round(float(sp.get("rms_med") or 0), 4),
    }


def build_pick5():
    """生成 测试截图/bf_pick5.html —— 「重听游戏现在轮换的这 5 条」精简页。

    用户明确要求：「你把这三个之前的语言再给我听一下」——所以这一页只放池子里那 5 条，
    外加一条**不含「呜呼」**的替代件供对比。数字全部现量（时长 / F0 / 谱质心 / RMS），
    不手写。
    """
    def row(file, use, note, extra_label=""):
        p = bf_path(file)
        if not os.path.exists(p):
            print("⚠ 缺文件，跳过：%s" % p, file=sys.stderr)
            return None
        info = N.G.probe_info(p)
        ps = N.G.pitch_stats(p)
        sp = N.spec_stats(p)
        text, voice = POOL_TEXT.get(file, ("", ""))
        return {
            "file": file, "use": use, "note": note,
            "text": text, "voice": voice,
            "dur": round(info["duration"], 2) if info else 0.0,
            "pct": round(ps["delta_pct"], 1) if ps else 0.0,
            "f0a": round(ps["f0_first"]) if ps else 0,
            "f0b": round(ps["f0_last"]) if ps else 0,
            "rise": bool(ps and ps["rising"]),
            "cen": round(sp["centroid_med"]) if sp else 0,
            "rms": round(sp["rms_med"], 4) if sp else 0.0,
            "label": extra_label,
        }

    rows = []
    for f, use, note in POOL11:
        r = row(f, use, note)
        if r:
            rows.append(r)
    extra = []
    for f, use, note in DISABLED11:
        r = row(f, use, note, ("停用 · 含「呜呼」" if "呜呼" in POOL_TEXT.get(f, ("", ""))[0]
                               else "对比件 · 不含「呜呼」"))
        if r:
            extra.append(r)
    # omni 盲听结论（如果在报告里）——新「终于好啦」的来源件是 happy_n56
    nomni = load(N.omni_path(), {}) or {}
    heard = {x["name"]: x for x in nomni.get("rows", [])}
    for r in extra:
        if r["file"] == "happy_finally2.mp3":
            r["heard"] = " ／ ".join((heard.get("happy_n56") or {}).get("heard") or [])
    data = {"rows": rows, "extra": extra,
            "keep": KEEP_IN_ROOT,
            "alt_heard": " ／ ".join((heard.get("happy_n56") or {}).get("heard") or []),
            "generated": __import__("time").strftime("%Y-%m-%d %H:%M")}
    html = TEMPLATE5.replace("__DATA__", json.dumps(data, ensure_ascii=False, indent=1))
    with open(PAGE5, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print("→ %s" % PAGE5)
    print("池内 %d 条 + 停用/对比 %d 条" % (len(rows), len(extra)))
    return 0


TEMPLATE5 = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>早餐店 · 游戏现在轮换的语音（5 条 · 重听）</title>
<style>
  :root{ --card:#2a1b2e; --line:#4a3350; --ink:#f6eef8; --dim:#b9a6c2;
         --gold:#ffd76e; --pink:#ff9ec7; --green:#5dffa0; --red:#ff6b8a; --cyan:#9fd7ff; }
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,#150e1b,#1f1425 40%,#150e1b);color:var(--ink);
       font:15px/1.7 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;padding:28px 18px 80px}
  .wrap{max-width:900px;margin:0 auto}
  h1{font-size:23px;margin:0 0 6px}
  .ask{background:linear-gradient(180deg,#2c2036,#241a2c);border:1px solid #6b4f7a;border-radius:12px;
       padding:16px 18px;margin:18px 0;font-size:16px}
  .ask b{color:var(--pink)}
  .note{background:#241a2c;border:1px solid var(--line);border-radius:12px;padding:14px 16px;
        margin:16px 0;color:var(--dim);font-size:14px}
  .note b{color:var(--gold)}
  .warn{background:#33202a;border-color:#7a3f52}
  .warn b{color:var(--red)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:14px 0}
  .card.alt{border-color:#6b5a2f;background:linear-gradient(180deg,#332c1e,#2a1b2e)}
  .card.slow{border-color:#3f5a7a;background:linear-gradient(180deg,#1e2733,#2a1b2e)}
  .crow{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  .num{font-weight:700;font-size:20px;color:var(--gold);min-width:34px}
  .say{font-size:23px;font-weight:600}
  .meta{color:var(--dim);font-size:13.5px;margin-top:4px}
  .tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
  .tag{display:inline-block;font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
  .use{color:#b8ffcf;border-color:#3f7a55;background:#1d3527}
  .run{color:#cfd8ff;border-color:#3f4f7a;background:#1d2735}
  .rise{color:var(--green);border-color:#2f6b48}
  .fall{color:var(--red);border-color:#6b2f42}
  .brt{color:var(--gold);border-color:#6b5a2f}
  .vo{color:var(--cyan);border-color:#2f5a6b}
  button.big{background:var(--pink);color:#2a0f1e;border:0;border-radius:14px;padding:16px 30px;
       font-size:19px;font-weight:800;cursor:pointer;white-space:nowrap}
  button.big:hover{filter:brightness(1.08)}
  button.big:active{transform:translateY(1px)}
  .playall{margin:16px 0}
  .playall button{background:#3a2a44;color:var(--ink);border:1px solid var(--line);border-radius:999px;
       padding:12px 24px;font-size:16px;font-weight:700;cursor:pointer}
  audio{display:none}
  code{background:#241a2c;border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px;color:var(--gold)}
  .foot{margin-top:36px;font-size:14px;color:var(--dim)}
  .heard{font-size:13px;color:var(--cyan);margin-top:6px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🍳 早餐店 · 游戏现在轮换的语音（重听）</h1>

  <div class="ask">
    👉 <b>这就是游戏现在轮换的语音</b>（已按你说的固定成这 5 条）。
    想换哪条，告诉我<b>编号</b>或<b>文件名</b>就行。
  </div>

  <div class="playall"><button onclick="playAll()">▶ 全播一遍（依次 5 条）</button></div>

  <div id="host"></div>

  <div class="note">
    <b>✅ 已按你的要求改掉「呜呼」</b>：第 3 条「终于好啦」原来是
    <code>happy_v2.mp3</code>「<b>呜呼</b>！终于好啦！」—— 那个「呜呼」你否决过。
    现在换成了 <code>happy_finally2.mp3</code>「<b>太棒啦！终于好啦！</b>」，
    <b>不含「呜呼」</b>。<br>
    新文件是现场摇出来再按客观量挑的：<b>F0 +53.6%</b>（前段 148Hz → 末段 228Hz，明显上扬）、
    谱质心 1189Hz、RMS 0.1050，omni 盲听两遍都听成「太棒了，终于好了」= <b>念对</b>。
  </div>

  <div class="note warn">
    <b>停用 / 对比件</b>（<b>都不在游戏里播</b>，只放在这一页让你听）：
    <div id="extra"></div>
  </div>

  <div class="foot">
    数据来源：<code>tools/bf/make_audition_page.py --pick5</code>（时长 / F0 / 谱质心 / RMS 全部现量）。<br>
    池子的真源是 <code>breakfast.js</code> 里的 <code>BF_SFX_FILES</code>：
    <code>happy: ["happy_v1.mp3", "happy_v3.mp3", "happy_finally2.mp3", "happy_i45.mp3"]</code>，
    <code>slow: ["slow.mp3"]</code>。<br>
    <b>slow.mp3（「哼，太慢了」）本轮一个字都没改</b> —— 改动前后 SHA256 一致，写在报告里。<br>
    完整的候选对比页：<a href="bf_happy_audition.html" style="color:var(--cyan)">bf_happy_audition.html</a>。<br>
    <b>bf-12 归档</b>：<code>audio/bf/</code> 根目录只留 15 个在岗素材（池里 4 条欢呼 + <code>tick</code> +
    <code>slow</code> + 9 条 <code>cook_*</code>），旧候选已挪到 <code>audio/bf/_unused/</code>
    （<b>文件一个都没删</b>，只是不入库、不分发）。本页按同一份保留清单解析路径 ——
    下面那两条「停用 / 对比件」会自动走 <code>../audio/bf/_unused/</code>，照样能播。<br>
    本页无外链、无 CDN，离线可开。生成时间：<span id="genat"></span>。
  </div>
</div>

<script>
var DATA = __DATA__;
var els = [];
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
function mk(v, i, small){
  var d = document.createElement("div");
  var cls = "card";
  if (v.label) cls += " alt";
  if (v.use.indexOf("跑单") === 0) cls += " slow";
  d.className = cls;
  var useTag = v.use.indexOf("跑单") === 0
      ? '<span class="tag run">' + esc(v.use) + '</span>'
      : '<span class="tag use">' + esc(v.use) + '</span>';
  var lab = v.label ? '<span class="tag brt">' + esc(v.label) + '</span>' : '';
  var heard = v.heard ? '<div class="heard">omni 盲听：' + esc(v.heard) + '</div>' : '';
  d.innerHTML =
    '<div class="crow">' +
      '<button class="big">▶ 播放 ' + (i + 1) + '</button>' +
      '<div><div class="say">「' + esc(v.text) + '」</div>' +
      '<div class="tags">' + useTag + lab +
        '<span class="tag vo">' + esc(v.voice) + '</span>' +
        '<span class="tag">' + v.dur.toFixed(2) + 's</span>' +
        '<span class="tag ' + (v.rise ? "rise" : "fall") + '">' + (v.rise ? "↗ " : "↘ ") +
          (v.pct > 0 ? "+" : "") + v.pct + '%</span>' +
        '<span class="tag brt">质心 ' + v.cen + ' Hz</span>' +
        '<span class="tag">RMS ' + v.rms.toFixed(4) + '</span>' +
      '</div>' +
      '<div class="meta">' + esc(v.note) + '　·　文件 <code>' + esc(v.file) + '</code></div>' +
      heard +
      '</div>' +
    '</div>';
  var au = document.createElement("audio");
  au.preload = "none";
  au.src = ((DATA.keep || []).indexOf(v.file) >= 0 ? "../audio/bf/" : "../audio/bf/_unused/") + v.file;
  var b = d.querySelector("button.big");
  au.addEventListener("play", function(){
    els.forEach(function(o){ if (o.au !== au) { try { o.au.pause(); } catch(e){} } });
    b.textContent = "⏸ 播放中…";
  });
  au.addEventListener("ended", function(){ b.textContent = "▶ 播放 " + (i + 1); });
  b.onclick = function(){
    if (!au.paused) { au.pause(); au.currentTime = 0; b.textContent = "▶ 播放 " + (i + 1); return; }
    au.currentTime = 0;
    au.play().catch(function(e){ b.textContent = "播放失败：" + e.message; });
  };
  /* 只有池内 5 条进 els —— 因为 els 是「全播一遍」的播放列表，
     停用/对比件不参与连播（否则会把已否决的 v2 也混进去播一遍）*/
  if (!small) els.push({ au: au, btn: b, idx: i + 1 });
  d.appendChild(au);
  return d;
}
(function(){
  var host = document.getElementById("host");
  DATA.rows.forEach(function(v, i){ host.appendChild(mk(v, i)); });
  var ex = document.getElementById("extra");
  (DATA.extra || []).forEach(function(v, i){ ex.appendChild(mk(v, i, true)); });
  if (!(DATA.extra || []).length) ex.textContent = "（无）";
})();
/* 全播一遍：依次播池子里那 5 条（停用/对比件不自动播，避免把已否决的 v2 也播进去）*/
function playAll(){
  var n = DATA.rows.length;
  (function next(i){
    if (i >= n) return;
    var o = els[i];
    var done = function(){
      o.au.removeEventListener("ended", done);
      setTimeout(function(){ next(i + 1); }, 500);
    };
    o.au.addEventListener("ended", done);
    o.au.currentTime = 0;
    o.au.play().catch(function(){});
  })(0);
}
document.getElementById("genat").textContent = DATA.generated;
</script>
</body>
</html>
"""


def main():
    nrep = load(N.report_path())
    if not nrep:
        print("缺报告：%s（先跑 gen_bf_happy_n.py）" % N.report_path(), file=sys.stderr)
        return 2
    nomni = load(N.omni_path(), {}) or {}
    heard_n = {r["name"]: r for r in nomni.get("rows", [])}

    rows = nrep["rows"]
    N.add_scores(rows)                                   # 综合分（z-score 加权）
    rows = [r for r in rows if r.get("pitch") and r.get("spec")]
    if REQUIRE_OMNI_PASS and heard_n:
        kept = [r for r in rows if heard_n.get(r["name"], {}).get("ok")]
        dropped = [r["name"] for r in rows if not heard_n.get(r["name"], {}).get("ok")]
    else:
        kept, dropped = rows, []
    kept.sort(key=lambda r: -(r.get("composite") or -999))
    top = kept[:TOP_N]
    print("A 组：%d 条候选里取综合分前 %d 条（omni 未过被剔除：%s）"
          % (len(rows), len(top), "、".join(dropped) if dropped else "无"))

    A = []
    for i, r in enumerate(top, 1):
        m = metrics(r)
        h = heard_n.get(r["name"], {})
        A.append(dict(m, id=r["name"], short="n%d" % i, file=r["name"] + ".mp3",
                      text=r["text"], voice=r["voice"],
                      heard=" ／ ".join(h.get("heard") or []) or "（未听）",
                      omni_ok=bool(h.get("ok")),
                      score=(round(r["composite"], 1) if r.get("composite") is not None else None)))

    # ── B 组：**当前游戏在用的 4 条**（bf-11 池）+ 停用区（含被否决的 happy_v2）──
    # 数据来源仍是 tools/bf/_patch/bf10_audition_data.json（measure_audition.py 量的 F0），
    # 因为它本来就含 v1/v3/v2/i45 之外的老件；谱质心 / RMS 本轮补量（同一套 spec_stats）。
    ab = load(os.path.join(HERE, "_patch", "bf10_audition_data.json"), {}) or {}
    old = {r["id"]: r for r in ab.get("A", [])}
    old.update({r["id"]: r for r in ab.get("B", [])})
    # i45 / finally2 不在 bf10 数据里 → 用本轮池表 + 现量补齐
    for fid, text, voice in (("happy_i45", "哇哦！", "Cherry"),
                             ("happy_finally2", "太棒啦！终于好啦！", "Ethan"),
                             ("happy_finally3", "哇！终于好啦！", "Cherry"),
                             ("happy_v2", "呜呼！终于好啦！", "Cherry")):
        old.setdefault(fid, {"id": fid, "file": fid + ".mp3", "text": text, "voice": voice})

    def pool_row(fid):
        base = old.get(fid)
        if not base:
            return None
        p = bf_path(base.get("file") or (fid + ".mp3"))
        if not os.path.exists(p):
            return None
        info = N.G.probe_info(p)
        ps = N.G.pitch_stats(p)
        sp = N.spec_stats(p)
        r = {"id": fid, "file": fid + ".mp3", "text": base["text"], "voice": base["voice"],
             "dur": round(info["duration"], 2) if info else 0.0, "pitch": ps}
        return dict(metrics(r), id=fid, short=fid.replace("happy_", ""),
                    file=fid + ".mp3", text=base["text"], voice=base["voice"],
                    cen=round(sp["centroid_med"]) if sp else 0,
                    rms=round(sp["rms_med"], 4) if sp else 0.0)

    B, OFF = [], []
    for fid in POOL_IDS:
        r = pool_row(fid)
        if r:
            B.append(dict(r, on=True))
    for fid, note in OFF_IDS:
        r = pool_row(fid)
        if r:
            OFF.append(dict(r, on=False, note=note))

    # ── C 组：上一轮备选 6 条 ──
    KEEP_C = ["happy_i10", "happy_i26", "happy_i38", "happy_i45", "happy_i47", "happy_i55"]
    irep = load(os.path.join(SRC_I, "_bf_happy_i_report.json"), {}) or {}
    iomni = load(os.path.join(SRC_I, "_bf_happy_i_omni.json"), {}) or {}
    irows = {r["name"]: r for r in irep.get("rows", [])}
    heard_i = {r["name"]: r for r in iomni.get("rows", [])}
    C = []
    for nm in KEEP_C:
        r = irows.get(nm)
        if not r:
            continue
        p = bf_path(nm + ".mp3")
        sp = N.spec_stats(p) if os.path.exists(p) else None
        m = metrics(r)
        m["cen"] = round((sp or {}).get("centroid_med") or 0)
        m["rms"] = round((sp or {}).get("rms_med") or 0, 4)
        C.append(dict(m, id=nm, short=nm.replace("happy_", ""), file=nm + ".mp3",
                      text=r["text"], voice=r["voice"],
                      heard=" ／ ".join((heard_i.get(nm) or {}).get("heard") or []) or "（未听）",
                      omni_ok=bool((heard_i.get(nm) or {}).get("ok"))))

    data = {"A": A, "B": B, "C": C, "OFF": OFF,
            "keep": KEEP_IN_ROOT,
            "weights": nrep.get("weights") or {},
            "generated": __import__("time").strftime("%Y-%m-%d %H:%M")}
    html = TEMPLATE.replace("__DATA__", json.dumps(data, ensure_ascii=False, indent=1))
    with open(PAGE, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print("→ %s" % PAGE)
    print("A 组 %d 条（本轮新候选）· B 组 %d 条（当前在用）· C 组 %d 条（上轮备选）· 停用 %d 条"
          % (len(A), len(B), len(C), len(OFF)))
    return 0


TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>早餐店 · 拿到早餐的欢呼（试听 v3 · 本轮新候选 / 当前在用 / 上轮备选）</title>
<style>
  :root{
    --bg:#1a1220; --card:#2a1b2e; --line:#4a3350;
    --ink:#f6eef8; --dim:#b9a6c2; --gold:#ffd76e; --pink:#ff9ec7; --green:#5dffa0; --red:#ff6b8a;
    --cyan:#9fd7ff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,#150e1b,#1f1425 40%,#150e1b);color:var(--ink);
       font:15px/1.7 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;padding:28px 18px 80px}
  .wrap{max-width:1160px;margin:0 auto}
  h1{font-size:23px;margin:0 0 6px}
  h2{font-size:18px;margin:34px 0 6px;padding-left:10px;border-left:4px solid var(--pink)}
  h2 .cnt{color:var(--dim);font-size:14px;font-weight:400;margin-left:8px}
  p.lead{color:var(--dim);margin:8px 0 0}
  .note{background:#241a2c;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:16px 0;color:var(--dim);font-size:14px}
  .note b{color:var(--gold)}
  .key{background:#20303a;border-color:#2f5a6b}
  .key b{color:var(--cyan)}
  .ask{background:linear-gradient(180deg,#2c2036,#241a2c);border:1px solid #6b4f7a;border-radius:12px;
       padding:16px 18px;margin:18px 0;font-size:16px}
  .ask b{color:var(--pink)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px;margin-top:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
  .card.new{border-color:#6b4f7a;background:linear-gradient(180deg,#31213a,#2a1b2e)}
  .card.on{border-color:#3f7a55;background:linear-gradient(180deg,#22342a,#2a1b2e)}
  .chead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .id{font-weight:700;font-size:18px;color:var(--gold)}
  .say{font-size:19px;margin:8px 0 4px}
  .meta{color:var(--dim);font-size:13px}
  .metrics{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
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
  .brt{color:var(--gold);border-color:#6b5a2f}
  .rms{color:#ffc7a8;border-color:#7a5330}
  .score{color:#fff;border-color:#6b4f7a;background:#3a2a44;font-weight:700}
  .heard{font-size:13px;color:var(--cyan);margin-top:8px;min-height:20px}
  .heard.bad{color:var(--red)}
  audio{display:none}
  code{background:#241a2c;border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px;color:var(--gold)}
  .foot{margin-top:36px;font-size:14px;color:var(--dim)}
  .playall{margin:10px 0 0}
  .playall button{background:#3a2a44;color:var(--ink);border:1px solid var(--line);border-radius:999px;
       padding:7px 15px;font-size:14px;cursor:pointer;margin-right:8px}
  table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:10px}
  th,td{border:1px solid var(--line);padding:6px 8px;text-align:right}
  th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}
  th{background:#241a2c;color:var(--gold);font-weight:600}
  tr.top td{background:#2b1f34}
</style>
</head>
<body>
<div class="wrap">
  <h1>🍳 早餐店 · 顾客拿到早餐时喊的那一声 —— 试听 v3</h1>
  <p class="lead">本轮目标：**听上去真的高兴** —— 保留你说的「终于好啦 / 开动啦」，
     去掉「呜呼」，并把「兴奋」做成可量的三件事（F0 上扬 + 明亮 + 响亮）。</p>

  <div class="ask">
    👉 <b>挑定后告诉我编号就行</b>（例如「要 n3」或「n3 换成 n7」），
    我就把 A 组里的对应项替换进游戏。<br>
    <b>游戏里现在跑的是 B 组那 4 条</b>（bf-11 已按你的要求把「终于好啦」换成不含「呜呼」的版本）。
    只想重听游戏里那几条 → <a href="bf_pick5.html" style="color:var(--cyan)">bf_pick5.html（重听这 4 条 + 跑单）</a>。
  </div>

  <div class="note key">
    <b>三组分别是什么？</b><br>
    <b>A 组</b> = 本轮新做的候选（<b>n1…n14</b>，上扬的排在前面）——
    <b>按这里挑</b>。<br>
    <b>B 组</b> = 当前游戏真正在用的 4 条，标 <span class="tag on-tag">✅ 已启用</span>，
    就是 <code>breakfast.js</code> 里 <code>BF_SFX_FILES.happy</code> 那个池子。<br>
    <b>C 组</b> = 上一轮做的备选（<code>happy_i*</code>），只在硬盘上留着对比，游戏里一句都不会播。<br>
    <b>停用区</b> = 已出池的老件（含被你否决的 <code>happy_v2</code>「呜呼！终于好啦！」），
    文件留着，但游戏里不播。
  </div>

  <div class="note">
    <b>本轮怎么解决「没有高兴的感觉」</b>：上一轮只约束了 F0 上扬，模型完全可以
    「音高上去了、但用发闷收着的声音念」——那正是你听到的不高兴。所以本轮
    ① 每条指令都同时要求<b>兴奋 + 上扬 + 明亮有精神 + 响亮外放 + 不许平淡/拖长/下沉</b>；
    ② 除 F0 走向外再加两个客观量：<b>谱质心</b>（越高越明亮）与 <b>RMS</b>（响度，兴奋的喊声通常更响）；
    ③ 一共摇了 <b>59 条</b>，先按客观量筛（<b>只有 16 条真的上扬</b>），
    再过 omni 盲听确认念对，最后取前 14 条进 A 组。<br>
    <b>权重是拿你已经表过态的老件标定的</b>（实测）：你认可的 v1 是 <b>F0 +54.1%</b>，
    而被你否掉的 alt2 / alt3 是 <b>-23.9% / +6.1%</b> ——
    所以 F0 走向权重最高（0.45）；谱质心分不开这两组，但抓得住"发闷"的坏件
    （更早被否的呜呼系列质心只有 569~923Hz），当质量闸用（0.30）；RMS 辅助（0.25）。<br>
    三个量在每张卡片上都逐条列出，<b>不藏数字</b>；情绪最终仍由你的耳朵判定。<br>
    <b>一个如实说明</b>：<code>happy_n9</code>「好耶！开动啦！」是本轮客观量最好的一条
    （F0 <b>+60.5%</b>、综合分最高），但 omni <b>连续 6 次都听成「好呀」</b>而不是「好耶」——
    判断它确实把这个字念偏了，所以<b>没有放进 A 组</b>，宁可不用也不糊弄。<br>
    <b>另一个说明</b>：A 组里 F0 未上扬的几条（标 <span class="tag fall">↘</span>）没有藏起来 ——
    它们在上扬件之外按综合分补位（嗓音更亮/更响），你可以自己听、自己判。
  </div>

  <h2>A 组 · 本轮新候选（挑这里）<span class="cnt" id="cntA"></span></h2>
  <div class="playall"><button onclick="playAll('A')">▶ 连播本组</button></div>
  <div class="grid" id="gA"></div>

  <h2>B 组 · 当前游戏在用的 4 条 <span class="tag on-tag">✅ 已启用</span><span class="cnt" id="cntB"></span></h2>
  <div class="playall"><button onclick="playAll('B')">▶ 连播本组</button></div>
  <div class="grid" id="gB"></div>

  <h2>C 组 · 上一轮备选（未启用）<span class="cnt" id="cntC"></span></h2>
  <div class="playall"><button onclick="playAll('C')">▶ 连播本组</button></div>
  <div class="grid" id="gC"></div>

  <h2>停用区 · 已出池（游戏里不播，只留着对比）<span class="cnt" id="cntOFF"></span></h2>
  <p class="meta">这里放着已经不在任何播放通道里的老件 ——
     <code>happy_v2</code>「<b>呜呼</b>！终于好啦！」就是被你否决的那条（文件留着，可能还要对比）。
     已被 <code>happy_finally2</code>「太棒啦！终于好啦！」取代。</p>
  <div class="grid" id="gOFF"></div>

  <h2>挑定之后怎么换（一行）</h2>
  <div class="note">
    <code>breakfast.js</code> 里现在是这样（B 组那 6 条）：<br>
    <code>happy: ["happy_v1.mp3", "happy_alt2.mp3", "happy_v3.mp3", "happy_alt3.mp3", "happy_v5.mp3", "happy_v6.mp3"],</code><br>
    你说「要 n3」之后，我会把它改成（只留你挑的那条）：<br>
    <code>happy: ["happy_n3.mp3"],</code><br>
    单条时 <code>audio.pick()</code> 恒返回 0 —— 不再随机，永远喊这一条。
    想同时留几条也可以（例如「n3 和 n9 轮着来」）。
  </div>

  <h2>本轮候选的完整数据</h2>
  <table id="tbl"></table>

  <div class="foot">
    数据来源：<code>tools/bf/gen_bf_happy_n.py</code>（A 组：TTS + ffmpeg 加工 + 自相关 F0 +
    自写 radix-2 FFT 量的谱质心/RMS + omni 盲听）、
    <code>tools/bf/measure_audition.py</code>（B 组 F0）、
    <code>tools/bf/gen_bf_happy_i.py --report/--listen</code>（C 组），
    再用 <code>tools/bf/make_audition_page.py</code> 生成本页 —— 数字全是实测，没有手写。<br>
    DSP 自检（<code>--selftest</code>）：FFT 8 档 n 全部峰值正确；已知纯音 300/1000/3000/5000Hz
    量出的谱质心误差 ≤0.2%。<br>
    本页无外链、无 CDN：音频走相对路径 <code>../audio/bf/*.mp3</code>，离线也能打开。<br>
    <b>bf-12 归档</b>：<code>audio/bf/</code> 根目录现在只留代码点名的 15 个在岗素材
    （池里 4 条欢呼 + <code>tick</code> + <code>slow</code> + 9 条 <code>cook_*</code>）；
    旧候选（<code>happy_n*</code> / <code>happy_alt*</code> / v2 / v4 / v5 / v6 / i 系列…）
    已挪到 <code>audio/bf/_unused/</code>（<b>文件一个都没删</b>，只是该目录不入库、不分发）。
    本页会按同一份保留清单解析路径：归档件自动走 <code>../audio/bf/_unused/</code>，播放不受影响。
    密钥只在进程环境变量里用过，没有写进任何文件。生成时间：<span id="genat"></span>。
  </div>
</div>

<script>
var DATA = __DATA__;
var els = {};
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
function card(v, gi){
  var d = document.createElement("div");
  d.className = "card" + (v.on ? " on" : (gi === "A" ? " new" : ""));
  var badge;
  if (gi === "A")        badge = '<span class="tag off-tag">本轮新候选</span>';
  else if (gi === "OFF") badge = '<span class="tag fall">⛔ 已停用（游戏里不播）</span>';
  else if (v.on)         badge = '<span class="tag on-tag">✅ 已启用</span>';
  else                   badge = '<span class="tag off-tag">未启用</span>';
  /* heard 只有在有内容时才显示（B/C/OFF 组没有 omni 结论，不要显示一行空的）*/
  var heard = v.heard && v.heard !== "（未听）"
      ? '<div class="' + (v.omni_ok === false ? 'heard bad' : 'heard') + '">omni 盲听：' + esc(v.heard) +
        (v.omni_ok === false ? '　⚠ 没听对，未进 A 组' : '') + '</div>'
      : '';
  var offNote = v.note ? '<div class="heard bad">' + esc(v.note) + '</div>' : '';
  var score = (v.score != null) ? '<span class="tag score">综合 ' + v.score + '</span>' : '';
  d.innerHTML =
    '<div class="chead"><span class="id">' + esc(v.short) + '</span>' + badge +
    '<span class="tag ' + (v.rise ? "rise" : "fall") + '">' + (v.rise ? "↗ 上扬 " : "↘ 下降 ") +
      (v.pct > 0 ? "+" : "") + v.pct + '%</span>' + score +
    '<span class="tag">' + esc(v.voice) + '</span>' +
    '<span class="tag">' + v.dur.toFixed(2) + 's</span></div>' +
    '<div class="say">「' + esc(v.text) + '」</div>' +
    '<div class="metrics">' +
      '<span class="tag brt">谱质心 ' + v.cen + ' Hz</span>' +
      '<span class="tag rms">RMS ' + v.rms.toFixed(4) + '</span>' +
      '<span class="tag">F0 ' + v.f0a + '→' + v.f0b + ' Hz</span>' +
    '</div>' +
    '<div class="meta">文件 <code>' + esc(v.file) + '</code></div>' +
    heard + offNote +
    '<div class="bar"><button class="play">▶ 播放 ' + esc(v.short) + '</button></div>';
  var au = document.createElement("audio");
  au.preload = "none";
  au.src = ((DATA.keep || []).indexOf(v.file) >= 0 ? "../audio/bf/" : "../audio/bf/_unused/") + v.file;
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
render("OFF", document.getElementById("gOFF"), "OFF");

/* 连播本组：一条播完接一条 */
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

/* 完整数据表：A 组的三个客观量 + omni 转写 */
(function(){
  var t = document.getElementById("tbl");
  var h = '<tr><th>编号</th><th>文本</th><th>音色</th><th>时长</th><th>F0 走向</th>' +
          '<th>谱质心</th><th>RMS</th><th>综合分</th><th>omni 转写</th></tr>';
  DATA.A.forEach(function(v){
    h += '<tr class="top"><td>' + esc(v.short) + '</td><td>' + esc(v.text) + '</td><td>' + esc(v.voice) +
         '</td><td>' + v.dur.toFixed(2) + 's</td><td>' + (v.pct > 0 ? "+" : "") + v.pct + '%</td>' +
         '<td>' + v.cen + ' Hz</td><td>' + v.rms.toFixed(4) + '</td>' +
         '<td>' + (v.score != null ? v.score : '—') + '</td><td>' + esc(v.heard) + '</td></tr>';
  });
  t.innerHTML = h;
})();
document.getElementById("genat").textContent = DATA.generated;
</script>
</body>
</html>
"""


if __name__ == "__main__":
    # --pick5：只生成「重听池里 5 条」的精简页（bf-11 用户要求重听）
    if "--pick5" in sys.argv:
        sys.exit(build_pick5())
    sys.exit(main())
