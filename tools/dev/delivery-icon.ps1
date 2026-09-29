# 生成 art/icons/game/delivery.png（128×128）—— 「您好，您的外卖」的侧栏图标
#
# 与仓库里其它小游戏图标（slash / mahjong / breakfast …）同族：同一个圆角方形底盘
# （pad 4、圆角半径 24）、同一套「渐变底 + 顶部玻璃高光 + 两遍描金边（外深内亮）」的
# 画法，保证并排放在侧栏里不显得是外来的。
#
# 为什么用脚本画而不是丢一张图进去：
#   ① 与其它图标同族（同一个描边宽度、圆角半径、高光角度）
#   ② 可复现、可微调（改颜色重跑一次即可，不用重新出图）
#   ③ 不引入新的第三方素材（SOURCES.md 的授权纪律）
#   ④ 全程无随机数，重复运行输出逐字节一致
#
# 画面内容：暖橙/琥珀底（外卖标志色，与现有四枚都不撞色）上，一辆朝右疾行的电动车：
# 奶油色踏板车身 + 后货架上一只大号青色保温箱（箱面印「餐」字标签）+ 坐姿骑手
# （黄头盔、深蓝工装、背后一道反光条），车尾甩出三笔速度线。
#
# 128×128 很小，只留三块大色块——奶油车身 / 青色保温箱 / 深色车轮：
#   * 底色压暗过一档（#FFB03C → #C25808）：原先亮一档时奶油色车身缩到 32px 会和
#     底色糊成一片橙，主体"陷"进背景里；
#   * 保温箱画得又大又宽，它是「外卖」最快被认出来的符号，不能输给车身；
#   * 骑手坐在可见的坐垫上、手臂成一条斜线伸到车把，不然 32px 下会读成"车后面
#     还站着一个人"；
#   * 两个轮子各露出大半圈，车身下缘只压住轮顶一点点，不然车会糊成一块白；
#   * 不画辐条、链条、仪表盘、车身饰条这类缩到 32px 只会变成噪点的细节。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/delivery-icon.ps1
param(
  [string]$Out = ""   # 默认写到仓库的 art/icons/game/delivery.png
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $Out) { $Out = Join-Path $repo "art\icons\game\delivery.png" }
$S = 128
$bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

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

# 圆角多边形：顶点 + 每角切角半径，把车身/骑手的折线轮廓磨圆一点（不要尖角）
function New-RoundedPolyPath($pts, [single]$r) {
  # 先把顶点统一成 PointF：否则 PS 会给 AddBezier 选中 Point 重载，浮点切点无法隐式转换
  $f = @()
  foreach ($q in $pts) { $f += , (New-Object System.Drawing.PointF([single]$q[0], [single]$q[1])) }
  $n = $f.Count
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  for ($i = 0; $i -lt $n; $i++) {
    $prev = $f[($i - 1 + $n) % $n]
    $cur = $f[$i]
    $next = $f[($i + 1) % $n]
    $v1x = $prev.X - $cur.X; $v1y = $prev.Y - $cur.Y
    $l1 = [Math]::Sqrt($v1x * $v1x + $v1y * $v1y)
    if ($l1 -lt 0.001) { $l1 = 0.001 }
    $v2x = $next.X - $cur.X; $v2y = $next.Y - $cur.Y
    $l2 = [Math]::Sqrt($v2x * $v2x + $v2y * $v2y)
    if ($l2 -lt 0.001) { $l2 = 0.001 }
    $rr = [Math]::Min($r, [Math]::Min($l1, $l2) / 2.2)
    $a = New-Object System.Drawing.PointF([single]($cur.X + $v1x / $l1 * $rr), [single]($cur.Y + $v1y / $l1 * $rr))
    $b = New-Object System.Drawing.PointF([single]($cur.X + $v2x / $l2 * $rr), [single]($cur.Y + $v2y / $l2 * $rr))
    $p.AddLine($a, $b)
    $p.AddBezier($a, $cur, $cur, $b)
  }
  $p.CloseFigure()
  return $p
}

function New-Solid([int]$a, [int]$r, [int]$gg, [int]$b) {
  return (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($a, $r, $gg, $b)))
}
function New-VGrad([int]$y0, [int]$y1, [int]$r0, [int]$g0, [int]$b0, [int]$r1, [int]$g1, [int]$b1) {
  return (New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, $y0)), (New-Object System.Drawing.Point(0, $y1)),
    [System.Drawing.Color]::FromArgb(255, $r0, $g0, $b0), [System.Drawing.Color]::FromArgb(255, $r1, $g1, $b1)))
}
function New-Pen2([int]$a, [int]$r, [int]$gg, [int]$b, [single]$w) {
  return (New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($a, $r, $gg, $b), $w))
}
function New-CapPen([int]$a, [int]$r, [int]$gg, [int]$b, [single]$w) {
  $p = New-Pen2 $a $r $gg $b $w
  $p.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $p.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  return $p
}

$INK  = @(88, 46, 8)     # 车身深棕描边
$TIRE = @(42, 26, 12)    # 轮胎

# ── 底盘：深琥珀/焦糖渐变 + 底部一汪琥珀反光 + 顶部玻璃高光 + 两遍描金边。
#    明度是这枚图标最要紧的一件事，来回试了几轮才定下来：
#      v1 直接用"外卖暖橙" #FFB03C → #C25808 —— 逐像素量下来奶油色车身对底色的
#         亮度对比只有 1.30，缩到 32px 整辆车会"陷"进背景、糊成一片橙；
#      v2 整体压暗 —— 车身出来了，但青色保温箱对底色又掉到 1.3，箱子糊了；
#      现在这一版：底色定成"上深下暖"的焦糖（顶部深、底部亮），
#      让奶油色车身/青色保温箱对底色都还有 ≈1.7～2.2 的对比，主体不糊。
#    色相仍在暖橙/琥珀区间，与现有四枚图标（麻将暗红金 / 早餐粉 / 开窗绿金 / 切果
#    深绿+西瓜红）不撞色 ──
$pad = 4
$basePath = New-RoundedPath $pad $pad ($S - $pad * 2) ($S - $pad * 2) 24
$g.FillPath((New-VGrad 0 $S 96 46 8 190 108 26), $basePath)

# 底部一汪琥珀反光：把色感拉回"暖橙"，同时不抬高主体所在的中间地带
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(-24, 88, 176, 104)
$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(82, 255, 168, 56)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 168, 56))
$g.FillPath($glowBrush, $glowPath)

# 顶部的玻璃高光（与 slash 同一条水平切线：pad → 58）
$g.FillPath((New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, $pad)), (New-Object System.Drawing.Point(0, 58)),
  [System.Drawing.Color]::FromArgb(64, 255, 255, 255), [System.Drawing.Color]::FromArgb(0, 255, 255, 255))), $basePath)
# 金边（两遍：外深内亮，出一点立体感）
$g.DrawPath((New-Pen2 255 122 78 18 5), $basePath)
$g.DrawPath((New-Pen2 255 255 215 110 2.2), $basePath)
# ── 速度线：三笔从车尾往后甩，压在车轮之下，读作「正在路上」 ──
$g.DrawLine((New-CapPen 110 255 250 238 2.6), 20, 58, 34, 58)
$g.DrawLine((New-CapPen 78 255 250 238 2.0), 20, 72, 32, 72)
$g.DrawLine((New-CapPen 78 255 250 238 2.0), 20, 86, 33, 86)

# ── 后货架：从车身向后伸出，把保温箱托住（箱底与车身之间不该悬空）──
$g.DrawLine((New-CapPen 255 $INK[0] $INK[1] $INK[2] 5), 48, 80, 20, 80)

# ── 两个轮子：深色胎 + 高对比奶白轮毂，缩到 32px 时就是两个清楚的「轱辘」──
$penTire = New-Pen2 255 $TIRE[0] $TIRE[1] $TIRE[2] 2.2
foreach ($wx in @(44, 100)) {
  $g.FillEllipse((New-Solid 255 $TIRE[0] $TIRE[1] $TIRE[2]), [single]($wx - 14), 74, 28, 28)
  $g.DrawEllipse($penTire, [single]($wx - 14), 74, 28, 28)
  $g.FillEllipse((New-Solid 255 250 246 236), [single]($wx - 6.5), 81.5, 13, 13)
  $g.FillEllipse((New-Solid 255 $TIRE[0] $TIRE[1] $TIRE[2]), [single]($wx - 2.6), 85.4, 5.2, 5.2)
}

# ── 车身：一整块奶油色踏板车，下缘抬到 y≈85，只压住轮顶一点点 ──
$bodyPts = @(
  @(48, 78), @(36, 72), @(38, 58), @(46, 56), @(56, 58), @(68, 56), @(77, 50),
  @(85, 41), @(92, 36), @(99, 41), @(98, 52), @(96, 58), @(98, 71), @(93, 85),
  @(60, 85), @(50, 82)
)
$bodyShape = New-RoundedPolyPath $bodyPts 4
$g.FillPath((New-VGrad 38 86 255 252 242 218 186 132), $bodyShape)
$g.DrawPath((New-Pen2 255 $INK[0] $INK[1] $INK[2] 3), $bodyShape)

# 车把：一根深色弧管从前叉顶端往右上收，缩略后读作「把手」
$g.DrawBezier((New-CapPen 255 $INK[0] $INK[1] $INK[2] 3.4), 95, 42, 98, 36, 102, 34, 105, 35)

# ── 保温箱：整枚图标最大最跳的一块，驮在后货架上。箱盖 / 箱体 / 「餐」字标签三层，
#    缩到 32px 时这三层并成「一只外卖箱」的整体印象 ──
$boxShape = New-RoundedPolyPath @(@(16, 36), @(44, 36), @(46, 41), @(46, 73), @(24, 73), @(21, 69), @(21, 41)) 3
$g.FillPath((New-VGrad 36 74 150 250 242 10 152 144), $boxShape)
$g.DrawPath((New-Pen2 255 7 56 56 3), $boxShape)
$g.FillRectangle((New-Solid 255 7 84 82), 17, 36, 26, 7)               # 箱盖
$penLidHi = New-Pen2 130 235 255 252 1.6
$g.DrawLine($penLidHi, 20, 38.5, 43, 38.5)
$g.DrawLine($penLidHi, 21, 43.5, 43, 43.5)
$g.DrawLine($penLidHi, 21, 48, 43, 48)
# 标签：奶油方块 + 拆成大块笔画的「餐」字（细笔画缩到 32px 会糊成噪点）
$tag = New-RoundedPath 24 51 18 15 2.5
$g.FillPath((New-Solid 255 255 248 232), $tag)
$g.DrawPath((New-Pen2 255 7 56 56 1.6), $tag)
$ink = New-Solid 255 8 100 96
$g.FillRectangle($ink, 33.4, 53.2, 2, 2.4)
$g.FillRectangle($ink, 28.2, 55.8, 12.2, 1.8)
$g.FillRectangle($ink, 28.6, 58.8, 1.8, 5.4)
$g.FillRectangle($ink, 38.2, 58.8, 1.8, 5.4)
$g.FillRectangle($ink, 28.6, 58.8, 11.4, 1.7)
$g.FillRectangle($ink, 28.6, 62.5, 11.4, 1.7)

# ── 骑手：直接坐在车身上（不另画坐垫，避免"车后面站着一个人"的误读）。
#    橙色工装 + 背后一道奶油反光条 + 亮黄头盔 + 深色面罩。
#    工装用橙色而不是深蓝：深蓝在奶油车身上会糊成一块突兀的深色补丁，
#    橙色既跟车身分得开，又和"外卖"的暖色调同一族 ──
$torsoPts = @(@(61, 74), @(65, 55), @(72, 44), @(81, 43), @(87, 49), @(88, 59), @(85, 69), @(76, 75), @(64, 76))
$torsoShape = New-RoundedPolyPath $torsoPts 4
$g.FillPath((New-VGrad 42 76 58 104 116 16 38 48), $torsoShape)
$g.DrawPath((New-Pen2 255 8 22 28 3), $torsoShape)
# 背后一道奶油反光条：缩略后把「人」从车身里分出来，不然会糊成一块深色
$g.FillPolygon((New-Solid 255 250 244 224), @(
  (New-Object System.Drawing.Point(61, 67)),
  (New-Object System.Drawing.Point(65, 54)),
  (New-Object System.Drawing.Point(70, 56)),
  (New-Object System.Drawing.Point(66, 69))
))
# 伸向车把的手臂：一条斜线读作「扶着把手」，不要在肚子前堆成一团
$g.DrawLine((New-CapPen 255 40 76 86 6.5), 81, 48, 96, 47)
# 头盔 + 面罩（面罩只是一片深色，不描细线，缩略后仍能看出脑袋朝向）
$headPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$headPath.AddEllipse(79, 24, 20, 20)
$g.FillPath((New-VGrad 21 43 255 210 82 224 130 6), $headPath)
$g.DrawPath((New-Pen2 255 18 24 50 2.9), $headPath)
$g.FillEllipse((New-Solid 255 38 30 44), 90, 31.5, 7.4, 6)
$g.FillEllipse((New-Solid 200 255 255 255), 83.5, 28.5, 4.8, 3.2)

$g.Dispose()
$dir = Split-Path $Out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host ("已生成 " + $Out + "（" + [math]::Round((Get-Item $Out).Length / 1KB, 1) + " KB）")
