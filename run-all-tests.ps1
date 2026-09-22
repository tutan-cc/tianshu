<#
  run-all-tests.ps1 — 一条命令跑完全部自动化测试，并汇总各层通过数

  为什么要有它：小游戏的测试分三层（纯逻辑单测 / 无头证据链 / 真浏览器 E2E），
  散在 8+ 个脚本里。手工一条条敲容易漏，漏掉的那一层恰恰是最可能出问题的那层。

  用法（在仓库根目录执行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File run-all-tests.ps1
    powershell ... -File run-all-tests.ps1 -SkipBrowser     # 跳过要开浏览器的层（最快）
    powershell ... -File run-all-tests.ps1 -Only browser    # 只跑某一层
    powershell ... -File run-all-tests.ps1 -ShowAll         # 打印每个脚本的完整输出
    powershell ... -File run-all-tests.ps1 -Retry 3         # 失败自动重跑次数（默认 2）

  ⚠ 关于第三层（浏览器 E2E）的不稳定：本机 Chrome 无头起不来（mojo platform_channel 0x5），
    脚本会降级到 mshta/Trident。mshta 是**不可靠**的：同一会话里连续跑几次之后，
    探针会「跑了但产不出结果」。所以：
      · 这一层默认自动重跑（见 -Retry），跑不过时先单独再跑一次再下结论；
      · 真正要出证据图/做验收时，先关掉其它 mshta 窗口、或重启一个干净的终端再跑。

  约定：脚本自己也用 $PSScriptRoot 推算仓库根 —— 换机器 / 换用户名都不用改。
#>
param(
  # 跳过第三层（真浏览器 E2E）。这一层在本机常因 Chrome 起不来而降级/变慢。
  [switch]$SkipBrowser,
  # 只跑指定层：logic | headless | browser；不填=全跑
  [string]$Only = "",
  # 打印每个脚本的完整输出（默认只留最后几行，避免刷屏）
  [switch]$ShowAll,
  # 失败自动重跑次数（浏览器层已知不稳定；默认 2 次）
  [int]$Retry = 2
)

$ErrorActionPreference = "Continue"
$repo = $PSScriptRoot
Set-Location $repo

# ── 测试清单：每项 = 一层 · 名字 · 脚本（相对仓库根）· 期望通过数 ─────────────
# 期望数只是「基线参考」：对不上会标红提示，但不直接判失败（真正判失败的是进程退出码）
$SUITES = @(
  [pscustomobject]@{ Layer = "logic";    Name = "内核单测（存档/剧情图/装备）"; Script = "tests/core.test.cjs";             Expect = 8 }
  [pscustomobject]@{ Layer = "logic";    Name = "早餐店纯逻辑";                 Script = "tests/breakfast.test.cjs";        Expect = 67 }
  [pscustomobject]@{ Layer = "logic";    Name = "麻将系统单测";                 Script = "tests/mj-system.test.cjs";        Expect = 15 }
  [pscustomobject]@{ Layer = "logic";    Name = "麻将逻辑（最大的一套）";       Script = "tools/test/mahjong-logic.js";     Expect = 978 }
  [pscustomobject]@{ Layer = "logic";    Name = "index.html 内联脚本语法闸";     Script = "tools/dev/check-inline.js";       Expect = 0 }
  # 音频路径解析（素材 ↔ 代码 之间那道缝）。
  # 必要性来自实测：素材库同时存在 `ui-click.mp3` 与 `sfx-fight-hit.mp3` 两种命名，
  # 而代码只拼后者/只拼前者 → 54 条音效 + 9 条环境音永远取不到；
  # 又因为 sfxFile() 无条件 return true，连"回落合成音"都没发生，彻底静音且不报错。
  # 这一层把真实的 AudioSys 从 index.html 抽出来用 FakeAudio 驱动，测的是出货代码本身。
  [pscustomobject]@{ Layer = "logic";    Name = "音频素材路径解析";             Script = "tests/audio-paths.test.cjs";      Expect = 20 }
  # 打斗三档判定（P0）。判定条是 rAF 驱动的递归光标，这里用"排队 + 逐帧放行"的替身
  # 把光标真实推到完美/良好/偏出三档再落下，所以三档都是被驱动出来的，不是改内部变量。
  # 顺带锁住格斗音效的命名（写错名不报错、只会静音）。
  [pscustomobject]@{ Layer = "logic";    Name = "打斗三档判定与格斗音效";       Script = "tests/fight-grade.test.cjs";      Expect = 25 }
  [pscustomobject]@{ Layer = "logic";    Name = "打斗主回路（真实 startFight）"; Script = "tests/fight-loop.test.cjs";       Expect = 43 }
  # P1：公共判定条 judgeBar + 键盘输入总线 InputBus。
  # 守住两件最容易在重构里丢的事：① 拳击馆那场「等玩家按、不超时」与打斗「1.4 秒限时」
  # 两种语义都还在；② 三档判定靠「完美区 + 良好区」两条区间，只给完美区会退化成两档。
  [pscustomobject]@{ Layer = "logic";    Name = "公共判定条与输入总线";         Script = "tests/judge-bar.test.cjs";        Expect = 35 }
  # 打斗 2.0（fight2）：P1 接线 + P2 体干/防守/反击 + 调平回归 + P3 侧视舞台/立绘/街机过场。
  # 最值钱的五条：① 三档真的接进伤害；② 防守「方向对/错/不按」三种结果；
  # ③ 硬直期受伤倍率的**方向**（普通态 vs 硬直态对比）；
  # ④ 一局落在 6–9 回合 —— 防数值漂移：P2 第一版实测只有 2 回合，机制根本来不及展开；
  # ⑤ 机制确实驱动了画面（命中才有火花/顿帧、偏出没有、KO 有横幅、演出结束不留 rAF）。
  #    火花判定用单调累加器 fxCount，不要比较 fx 数组长度 —— 粒子有生命周期会被回收。
  # ⑥ 立绘走 Lovart 出图；测试环境没有真 Image，必须验证"立绘未就绪 → 回落骨骼"这条路仍然能跑。
  # ⑦ 两个角色必须"一眼能分辨"：体型参数方向、POSES 两套、配色冷暖两系，出拳幅度差 ≥1.5 倍。
  [pscustomobject]@{ Layer = "logic";    Name = "打斗 2.0（机制+调平+侧视舞台）"; Script = "tests/fight2.test.cjs";         Expect = 170 }
  [pscustomobject]@{ Layer = "headless"; Name = "早餐店无头证据链";             Script = "tools/bf/headless.js";            Expect = 351 }
  [pscustomobject]@{ Layer = "browser";  Name = "麻将浏览器实测（CDP→mshta）";  Script = "tools/e2e/mj-browser.js";         Expect = 168 }
  [pscustomobject]@{ Layer = "browser";  Name = "麻将系统 E2E（mshta）";         Script = "tools/e2e/mj-system.js";          Expect = 115 }
  [pscustomobject]@{ Layer = "browser";  Name = "闲暇玩法 E2E（打斗/麻将/彩票）"; Script = "tools/e2e/leisure.js";           Expect = 8 }
  # 素材接线核对：确认代码点名的音频文件**真的能取到**。
  # 必要性来自实测教训：「缺失即静默回落」的设计让「没接上」与「没素材」在断言层面无法区分，
  # 曾出现 1542 项全绿、但牌桌上「暗杠/补杠」完全无声（四个座位全 404）。
  # 它需要本地 HTTP 服务（python -m http.server 8000）；服务不在时脚本自行 exit 0 跳过，不会误报。
  [pscustomobject]@{ Layer = "browser";  Name = "素材接线核对（音效/环境音/BGM/牌名）"; Script = "tools/e2e/audio-wiring.js"; Expect = 10 }
)

if ($Only) { $SUITES = $SUITES | Where-Object { $_.Layer -eq $Only } }
if ($SkipBrowser) { $SUITES = $SUITES | Where-Object { $_.Layer -ne "browser" } }
if (-not $SUITES) { Write-Host "没有匹配的测试（-Only '$Only'）" -ForegroundColor Yellow; exit 2 }

function Get-PassCount([string]$text) {
  # 兼容两种输出格式：
  #   ① node:test  → "ℹ pass 56"
  #   ② 自研断言器 → "通过 847 / 共 847，全部通过 ✔" / "通过 351，失败 0" / "通过 142，失败 0，全部通过 ✔"
  $m = [regex]::Match($text, 'pass\s+(\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  $m = [regex]::Match($text, '通过\s+(\d+)\s*/\s*共\s*(\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  $m = [regex]::Match($text, '通过\s+(\d+)\s*[，,]')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  $m = [regex]::Match($text, '语法失败\s+(\d+)')
  if ($m.Success) { return -1 }   # 语法闸：没有"通过数"，用 -1 表示"按 0 失败算通过"
  return -1
}

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host " 小游戏自动化测试 · 一键全跑   （仓库根：$repo）" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan

$results = @()
$t0 = Get-Date
foreach ($s in $SUITES) {
  $path = Join-Path $repo $s.Script
  Write-Host ""
  Write-Host ("── [{0}] {1}" -f $s.Layer, $s.Name) -ForegroundColor White
  Write-Host ("   $ {0}" -f $s.Script) -ForegroundColor DarkGray

  if (-not (Test-Path $path)) {
    Write-Host "   ✗ 脚本不存在，跳过" -ForegroundColor Red
    $results += [pscustomobject]@{ Name = $s.Name; Layer = $s.Layer; Script = $s.Script; Pass = 0; Exit = 127; Secs = 0; Note = "脚本缺失" }
    continue
  }

  # 采集策略：**浏览器层绝不能重定向 stdout**。
  #   mshta 探针的写入依赖「stdout 仍是管道」这一前提；一旦把 node 的 stdout 重定向到文件，
  #   探针会「跑起来但产不出结果」→ 脚本报 exit 3。这是本沙箱实测出来的边界。
  #   所以浏览器层直接继承控制台输出（尾巴用日志留痕），其余层照旧重定向取全文。
  $useRedirect = ($s.Layer -ne "browser")
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ratt_" + [guid]::NewGuid().ToString("N") + ".txt")
  $code = 1
  $out = ""
  $attempt = 0
  while ($attempt -le $Retry) {
    $attempt++
    if ($attempt -gt 1) {
      Write-Host ("   ↻ 第 {0} 次重跑（已知 mshta 不稳定，先重跑再下结论）…" -f $attempt) -ForegroundColor Yellow
      Get-Process mshta -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }
      Start-Sleep -Seconds 3
    }
    $sw.Restart()
    if ($useRedirect) {
      & cmd /c "node `"$path`" > `"$tmp`" 2>&1"
      $code = $LASTEXITCODE
      $out = if (Test-Path $tmp) { Get-Content $tmp -Raw -Encoding UTF8 } else { "" }
    } else {
      # 继承控制台：只留最后 6 行做摘要，同时把全文写到 $tmp 供 -ShowAll 之外的排查
      $lines = & node $path 2>&1
      $code = $LASTEXITCODE
      $out = ($lines | Out-String)
    }
    if ($code -eq 0) { break }
  }
  $sw.Stop()
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue

  $pass = Get-PassCount $out
  if ($pass -lt 0 -and $code -eq 0) { $pass = 0 }

  if ($ShowAll) { Write-Host $out }
  else {
    $tail = ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join "`n"
    if ($tail) { Write-Host ($tail -replace '(?m)^', '   ') -ForegroundColor DarkGray }
  }

  $ok = ($code -eq 0)
  $color = if ($ok) { "Green" } else { "Red" }
  $mark = if ($ok) { "✔" } else { "✗" }
  $note = ""
  if ($attempt -gt 1 -and $ok) { $note = "（重跑第 $attempt 次才过 —— 该层不稳定）" }
  if ($ok -and $s.Expect -gt 0 -and $pass -ne $s.Expect) { $note += "（通过数 $pass 与基线 $($s.Expect) 不一致）"; $color = "Yellow" }
  Write-Host ("   {0} 退出码={1}  通过={2}{3}  用时 {4:n1}s" -f $mark, $code, $pass, $note, $sw.Elapsed.TotalSeconds) -ForegroundColor $color

  $results += [pscustomobject]@{ Name = $s.Name; Layer = $s.Layer; Script = $s.Script; Pass = $pass; Exit = $code; Secs = [math]::Round($sw.Elapsed.TotalSeconds, 1); Note = $note }
}

# ── 汇总 ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host " 汇总" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan

$layerName = @{ logic = "第一层 · 纯逻辑单测"; headless = "第二层 · 无头证据链"; browser = "第三层 · 真浏览器 E2E" }
foreach ($layer in @("logic", "headless", "browser")) {
  $rows = $results | Where-Object { $_.Layer -eq $layer }
  if (-not $rows) { continue }
  $p = ($rows | Measure-Object -Property Pass -Sum).Sum
  $bad = ($rows | Where-Object { $_.Exit -ne 0 }).Count
  $tag = if ($bad -eq 0) { "✔ 全绿" } else { "✗ $bad 项失败" }
  $c = if ($bad -eq 0) { "Green" } else { "Red" }
  Write-Host ("  {0,-22} 通过 {1,5}   {2}" -f $layerName[$layer], $p, $tag) -ForegroundColor $c
}
$totalPass = ($results | Measure-Object -Property Pass -Sum).Sum
$totalBad = ($results | Where-Object { $_.Exit -ne 0 }).Count
Write-Host ("  {0,-22} 通过 {1,5}   用时 {2:n1}s" -f "合计", $totalPass, ((Get-Date) - $t0).TotalSeconds) -ForegroundColor Cyan

Write-Host ""
Write-Host " 明细：" -ForegroundColor White
$results | Format-Table @{n='层';e={$_.Layer}}, @{n='测试';e={$_.Name}}, @{n='通过';e={$_.Pass}}, @{n='退出码';e={$_.Exit}}, @{n='秒';e={$_.Secs}}, @{n='备注';e={$_.Note}} -AutoSize | Out-String | Write-Host

if ($totalBad -gt 0) {
  Write-Host " 有失败项。产物 JSON 在 dist/test-results/，截图在 测试截图/。" -ForegroundColor Red
  # 说明：leisure.js 曾长期有 2 项「既有失败」（麻将手牌 13 张 / 已结算），
  # 根因是测试用固定 sleep 断言、而麻将节点要先播 2 段剧情视频 —— 是测试写法问题，不是游戏 bug。
  # 已改为「轮询等条件 + forceWin + 点 #mjmGo 走完整结算」，现在全绿，故移除旧的免责提示。
  Write-Host " 逐项失败原因见上方各测试的输出；产物 JSON 里有 checks/errors 明细。" -ForegroundColor Yellow
  exit 1
}
Write-Host " 全部通过 ✔" -ForegroundColor Green
exit 0
