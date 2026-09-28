# 生成 art/icons/game/slash.png（128×128）—— 「一刀两断」的侧栏图标
#
# 为什么用脚本画而不是丢一张图进去：项目里所有小游戏图标都是同一族「圆角方形应用图标」
# （描金边 + 渐变底 + 光泽 + 一点高光），用 .NET System.Drawing 逐笔绘制可以：
#   ① 与其它图标同族（同一个描边宽度、圆角半径、高光角度）
#   ② 可复现、可微调（改颜色重跑一次即可，不用重新出图）
#   ③ 不引入新的第三方素材（SOURCES.md 的授权纪律）
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/slash-icon.ps1
param(
  [string]$Out = ""   # 默认写到仓库的 art/icons/game/slash.png
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $Out) { $Out = Join-Path $repo "art\icons\game\slash.png" }
$S = 128
$bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# ── 底盘：深绿渐变（西瓜瓤的互补色，在一排图标里一眼可辨）+ 金边 ──
$pad = 4
$body = New-RoundedPath $pad $pad ($S - $pad * 2) ($S - $pad * 2) 24
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point(0, $S)),
  [System.Drawing.Color]::FromArgb(255, 34, 122, 62), [System.Drawing.Color]::FromArgb(255, 11, 58, 28))
$g.FillPath($bg, $body)
# 顶部的玻璃高光
$hi = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, $pad)), (New-Object System.Drawing.Point(0, 58)),
  [System.Drawing.Color]::FromArgb(90, 255, 255, 255), [System.Drawing.Color]::FromArgb(0, 255, 255, 255))
$g.FillPath($hi, $body)
# 金边（两遍：外深内亮，出一点立体感）
$penOut = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 122, 78, 18), 5)
$g.DrawPath($penOut, $body)
$penIn = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 215, 110), 2.2)
$g.DrawPath($penIn, $body)

# ── 西瓜切片：半圆（绿皮 / 白瓤 / 红肉 / 籽），略微旋转 ──
$cx = 60.0; $cy = 84.0; $R = 46.0
$g.TranslateTransform([single]$cx, [single]$cy)
$g.RotateTransform(-14)
$g.TranslateTransform([single](-$cx), [single](-$cy))
function New-HalfPie([single]$cx, [single]$cy, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($cx - $r, $cy - $r, $r * 2, $r * 2, 180, 180)
  $p.CloseFigure()
  return $p
}
$rind = New-HalfPie $cx $cy $R
$g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 96, 38))), $rind)
$pith = New-HalfPie $cx $cy ($R - 7)
$g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 240, 246, 214))), $pith)
$flesh = New-HalfPie $cx $cy ($R - 12)
$fg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, [int]($cy - $R))), (New-Object System.Drawing.Point(0, [int]$cy)),
  [System.Drawing.Color]::FromArgb(255, 255, 92, 100), [System.Drawing.Color]::FromArgb(255, 196, 22, 40))
$g.FillPath($fg, $flesh)

# 籽（沿扇形排布，越靠外越大）
$seedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 16, 10))
foreach ($t in @(0.30, 0.46, 0.62, 0.78)) {
  $rr = ($R - 16) * $t
  foreach ($a in @(28, 62, 96, 130, 152)) {
    if ($t -lt 0.4 -and ($a -eq 28 -or $a -eq 152)) { continue }
    $rad = $a * [Math]::PI / 180.0
    $px = $cx + [Math]::Cos($rad) * $rr
    $py = $cy - [Math]::Sin($rad) * $rr
    $g.FillEllipse($seedBrush, [single]($px - 1.5), [single]($py - 2.2), 3.0, 4.4)
  }
}
$g.ResetTransform()

# ── 刀：斜插进切片的一把厨刀（银刃 + 木柄 + 刃口高光）──
$blade = New-Object System.Drawing.Drawing2D.GraphicsPath
$blade.AddPolygon(@(
  (New-Object System.Drawing.Point(38, 18)),
  (New-Object System.Drawing.Point(107, 63)),
  (New-Object System.Drawing.Point(94, 75)),
  (New-Object System.Drawing.Point(34, 30))
))
$bg2 = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(34, 20)), (New-Object System.Drawing.Point(104, 70)),
  [System.Drawing.Color]::FromArgb(255, 245, 248, 255), [System.Drawing.Color]::FromArgb(255, 138, 146, 168))
$g.FillPath($bg2, $blade)
$g.DrawPath((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 84, 90, 110), 1.4)), $blade)
# 刃口白高光
$g.DrawLine((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 255, 255, 255), 2)),
  42, 26, 99, 66)
# 刀柄
$g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 92, 56, 26))), 16, 10, 26, 12)
$g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 140, 92, 44))), 16, 10, 26, 5)

# ── 飞溅的果汁：让图标有"刚切开"的动态 ──
$juice = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 86, 104))
foreach ($d in @(@(96, 26, 5.2), @(108, 40, 3.2), @(88, 16, 3.0), @(114, 24, 2.2))) {
  $g.FillEllipse($juice, [single]($d[0] - $d[2]), [single]($d[1] - $d[2]), [single]($d[2] * 2), [single]($d[2] * 2))
}

$g.Dispose()
$dir = Split-Path $Out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host ("已生成 " + $Out + "（" + [math]::Round((Get-Item $Out).Length / 1KB, 1) + " KB）")
