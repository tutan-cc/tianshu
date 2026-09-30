# 生成 art/icons/game/clockout.png（128×128）—— 「准点下班」的侧栏图标
#
# 与仓库里其它小游戏图标（slash / mahjong / breakfast / delivery …）同族：同一个圆角方形
# 底盘（pad 4、圆角半径 24）、同一套「竖向渐变底 + 顶部玻璃高光 + 两遍描金边（外深内亮）」
# 的画法，保证并排放在侧栏里不显得是外来的。
#
# 为什么用脚本画而不是丢一张图进去：
#   ① 与其它图标同族（同一个描边宽度、圆角半径、高光角度）
#   ② 可复现、可微调（改颜色重跑一次即可，不用重新出图）
#   ③ 不引入新的第三方素材（SOURCES.md 的授权纪律）
#   ④ 全程无随机数，重复运行输出逐字节一致
#
# 画面内容：冷靛蓝的深夜办公室底色上，一道从左上角（画面外的主管）斜切下来的黄色视野锥
# （这个玩法的标志），锥里一个弓着腰、蹑手蹑脚往前摸的打工人剪影，右侧一扇透着绿光的安全
# 出口门，门前地上淌着一汪绿光。
#
# 128×128 很小，只留三块大色块——黄色视野锥 / 墨蓝人影 / 亮绿出口门：
#   * 底色走冷靛蓝（#24306A → #090C1E，夜晚办公室的日光灯），与现有四枚（暖琥珀 /
#     深绿 / 粉 / 暗红）都不撞色；底压得够暗，黄锥和绿门才跳得出来（并排看时另外四枚
#     都是"深底 + 亮主体"，底色一浅这枚就显白、显外来）；
#   * 视野锥是这枚图标第一眼要被认出来的东西，占掉三分之一以上的面积，够大够亮；
#     锥尖那端亮、远端暗（光从左上角打过来），锥尖再点一小团白黄光晕当光源；
#   * 人影整个泡在黄锥里 —— 墨蓝压亮黄是整枚图标对比度最高的一处；不让它一半在暗底上、
#     一半在黄锥上，否则缩到 32px 会糊成灰疙瘩（锥的张角、半径和人的位置是按这个反推的：
#     锥的下边界是那根 80° 射线、外边界是圆弧，人必须落在两者之内）；
#   * 出口门做成「亮着的门洞」而不是「一块绿板子」：深色门框只在左/右/上三边露出来、
#     绿门板底边直接落到地面，门缝一道更亮的绿，门前地上再淌一汪绿光 —— 试过在绿门上
#     加横向推杆 / 竖向把手，缩到 32px 都读成"手机屏 + 按键"，所以一个都不留；
#   * 不画地砖、隔板、咖啡机、文件夹、主管这类缩到 32px 只会变成噪点的细节。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/clockout-icon.ps1
param(
  [string]$Out = ""   # 默认写到仓库的 art/icons/game/clockout.png
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $Out) { $Out = Join-Path $repo "art\icons\game\clockout.png" }
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

# 圆角多边形：顶点 + 每角切角半径，把人影/门板这类折线轮廓磨圆一点（不要尖角）
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
  $p.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  return $p
}
# 径向光晕：中心一个色、四周透明，用来画"漏出来的光"（门前的绿光、底部的冷光）
function New-Blob($x, $y, $w, $h, [int]$a, [int]$r, [int]$gg, [int]$b) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse([single]$x, [single]$y, [single]$w, [single]$h)
  $br = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
  $br.CenterColor = [System.Drawing.Color]::FromArgb($a, $r, $gg, $b)
  $br.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $r, $gg, $b))
  return @($br, $path)
}

$INK   = @(13, 17, 38)    # 人影：墨蓝近黑，压在亮黄上对比度最高
$FRAME = @(9, 13, 28)     # 门框：深色隔离带，把绿门从黄锥里"切"出来

# ── 底盘：冷靛蓝渐变（夜晚办公室的日光灯）+ 底部一汪冷光 + 顶部玻璃高光 + 两遍描金边 ──
$pad = 4
$basePath = New-RoundedPath $pad $pad ($S - $pad * 2) ($S - $pad * 2) 24
$g.FillPath((New-VGrad 0 $S 44 58 120 12 16 40), $basePath)

# 底部一汪冷蓝反光：把色感锁在"夜里开着日光灯的办公室"，
# 但压住亮度不抬高主体所在的中间地带（太亮底色就显白，一排图标里会跳出来）
$blob = New-Blob -24 94 176 96 76 62 102 214
$g.FillPath($blob[0], $blob[1])

# 顶部的玻璃高光（与 slash / delivery 同一条水平切线：pad → 58。
# 注意这个 LinearGradientBrush 不设 WrapMode，默认是 Tile —— 高光会在 y=58 以下
# 按 54px 周期再糊一遍，仓库里 slash / delivery 也是这个样子，属于这一族的既有特征，
# 所以底色的明度要按"会被这道平铺高光再提亮一次"来定，别照渐变原值估）
$g.FillPath((New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, $pad)), (New-Object System.Drawing.Point(0, 58)),
  [System.Drawing.Color]::FromArgb(46, 255, 255, 255), [System.Drawing.Color]::FromArgb(0, 255, 255, 255))), $basePath)
# 金边（两遍：外深内亮，出一点立体感）
$g.DrawPath((New-Pen2 255 122 78 18 5), $basePath)
$g.DrawPath((New-Pen2 255 255 215 110 2.2), $basePath)

# ── 视野锥：从左上角（画面外的主管）斜切下来，张角 67°（13° → 80°）、半径 98 ——
#    这是整枚图标最大的一块（约占画面 1/3），锥尖落在 (24,18)（离金边还有 10px 余量，
#    不会被描边切到）。锥的下边界是那根 80° 的射线、外边界是半径 98 的圆弧，
#    人的脚必须落在两者之内，所以人的位置不是随便摆的：x 必须 ≥ 44、脚底得留在 y ≈ 100 以上 ──
$ax = 24.0; $ay = 18.0; $R = 98.0
$cone = New-Object System.Drawing.Drawing2D.GraphicsPath
$cone.AddPie([single]($ax - $R), [single]($ay - $R), [single]($R * 2), [single]($R * 2), [single]13, [single]67)
$coneBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(24, 18)), (New-Object System.Drawing.Point(112, 118)),
  [System.Drawing.Color]::FromArgb(250, 255, 226, 96), [System.Drawing.Color]::FromArgb(250, 246, 152, 4))
$g.FillPath($coneBrush, $cone)
# 锥口一圈更亮的黄：缩到 32px 时靠它把锥的轮廓从暗底上拎出来
$g.DrawPath((New-Pen2 170 255 250 214 2.4), $cone)

# ── 门前溢出的一汪绿光（压在黄锥之上、门板之下）：缩略后是"那边有出口"的第一眼提示 ──
$blob = New-Blob 56 34 100 112 128 56 255 148
$g.FillPath($blob[0], $blob[1])
# 门前地上更亮的一摊：把"光从门里淌出来"这件事说清楚，顺带给门一个落地感
$blob = New-Blob 58 92 76 34 150 96 255 178
$g.FillPath($blob[0], $blob[1])

# ── 安全出口门：亮着的门洞 —— 深色门框只在左/右/上三边露，绿门板底边落到地面 ──
$doorFrame = New-RoundedPath 88 37 31 69 3.5
$g.FillPath((New-Solid 255 $FRAME[0] $FRAME[1] $FRAME[2]), $doorFrame)
$doorLeaf = New-RoundedPath 90.5 40.5 26 65.5 2.5
# 门板的绿定成中深绿而不是薄荷绿：门板有一半压在黄锥上，薄荷绿和亮黄的相对亮度几乎一样
# （实测 1.07），并排看时门的上半截会"溶"进黄锥里；压深到 (34,186,106)→(10,124,68) 之后
# 门板对黄锥有 ≈1.7、对暗底有 ≈3 的亮度差，同时"亮"这件事交给门缝那条亮绿和门前那汪绿光，
# 门整体还是"亮着的门洞" ──
$g.FillPath((New-VGrad 41 106 34 186 106 10 124 68), $doorLeaf)
# 门缝：门没关严的那一道亮绿（不是白的 —— 白色竖条会读成屏幕反光，整扇门就变手机了）
$g.FillPath((New-Solid 232 196 255 218), (New-RoundedPath 90.5 40.5 4.5 65.5 2))

# ── 打工人：弓着腰、蹑手蹑脚往前（右）摸的剪影，整个人泡在黄锥里 ──
#    人形要"竖着"：头在上、身子窄而高、两条腿在下。三个坑都是看缩略图踩出来的：
#      ① 头和背连成一块 → 缩到 32px 只剩一团黑，所以头单独画、脖子两侧各留一道黄豁口；
#      ② 腿用四段 DrawLine 拼 → 圆头线帽把每一段都画成独立的小粗腿，读成"四条腿的羊"，
#         改成 DrawLines 折线（圆角接头），一条腿一笔；
#      ③ 躯干画得比头还宽还扁（横着的一大坨 + 前头一个脑袋 + 底下四条腿）
#         → 整枚图标读成"一条狗"。现在躯干 24 宽 × 32 高，是竖着的，
#         再配上"弓背 + 前伸的手"，才同时读出"人"和"偷偷摸摸"。
#    手臂停在门框左边留一道黄缝，别和门框糊成一条黑边 ──
$torsoPts = @(
  @(54, 86), @(52, 70), @(58, 58), @(68, 57), @(75, 65), @(76, 76), @(70, 86), @(62, 89)
)
$g.FillPath((New-Solid 255 $INK[0] $INK[1] $INK[2]), (New-RoundedPolyPath $torsoPts 5))
$g.FillRectangle((New-Solid 255 $INK[0] $INK[1] $INK[2]), 64, 46, 12, 16)   # 脖子
# 手臂：一条斜线伸到门前，缩略后读作"正要去够那扇门"
$g.DrawLine((New-CapPen 255 $INK[0] $INK[1] $INK[2] 6.5), 72, 66, 84, 76)
# 两条腿：一前一后（对称下蹲会读成"扎马步"），脚落在 y≈96，再低就掉出锥外
$g.DrawLines((New-CapPen 255 $INK[0] $INK[1] $INK[2] 8.5), [System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF(68, 84)), (New-Object System.Drawing.PointF(77, 90)), (New-Object System.Drawing.PointF(73, 96))))
$g.DrawLines((New-CapPen 255 $INK[0] $INK[1] $INK[2] 8.5), [System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF(58, 84)), (New-Object System.Drawing.PointF(50, 90)), (New-Object System.Drawing.PointF(54, 96))))
# 头：比躯干亮一圈的圆脑袋，压在脖子上；往右探出去一点 —— "探头探脑往前蹭"全靠这一下
$g.FillEllipse((New-Solid 255 $INK[0] $INK[1] $INK[2]), 62, 34, 20, 20)
# 后脑勺/弓起的背一道暖色轮廓光（锥光打在人身上），只做 128px 的质感，缩略后自然消失
$g.DrawLine((New-CapPen 150 255 246 206 2.2), 53, 80, 54, 66)
$g.DrawLine((New-CapPen 150 255 246 206 2.2), 54, 66, 61, 58)

$g.Dispose()
$dir = Split-Path $Out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host ("已生成 " + $Out + "（" + [math]::Round((Get-Item $Out).Length / 1KB, 1) + " KB）")
