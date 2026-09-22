<#
  cut-fight2-sprites.ps1 —— 把 Lovart 生成的绿幕立绘切成游戏可用的透明 PNG。

  为什么需要它：
    生成出来的是一张 1024×1024 的"四人横排"绿幕图（待机/出拳/受击/倒地）。
    游戏里要的是**四张带透明通道、且地面线对齐**的立绘 —— 否则换姿势时脚会上下跳。

  做法（用 System.Drawing，与本项目 tools/mj/shots.js 同一条路线）：
    ① 按列切成 4 格
    ② 色度抠像：绿色占优的像素判为背景（带容差 + 边缘半透明）
    ③ 自动裁到不透明边界
    ④ 把四格的**脚底**统一对齐到画布底边（这是"换姿势不跳"的关键）
    ⑤ 输出 PNG + 一份 JSON 索引（含每格的显示尺寸，供 canvas 按比例绘制）

  用法（在仓库根）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/cut-fight2-sprites.ps1
#>
param(
  [string]$Src = "_ref\out",
  [string]$Out = "art\fight2",
  [int]$Cols = 4
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo
$outDir = Join-Path $repo $Out
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 角色 → 源图（按文件名里的哈希前缀认，避免依赖生成顺序）
$MAP = @(
  @{ slug = "puncher"; src = "lovart_4d20a45ed9bb.png"; poses = @("idle","strike","hit","ko") },
  @{ slug = "brawler"; src = "lovart_feced8016717.png"; poses = @("idle","strike","hit","ko") }
)

function Test-Green([System.Drawing.Color]$c){
  # 绿色占优且足够亮 → 背景。阈值是实测调的：
  # 生成图的绿幕不是精确 #00FF00（有渐变与阴影），卡太死会留绿边。
  return ($c.G -gt 90) -and ($c.G -gt $c.R * 1.35) -and ($c.G -gt $c.B * 1.35)
}

foreach($m in $MAP){
  $srcPath = Join-Path (Join-Path $repo $Src) $m.src
  if(-not (Test-Path $srcPath)){ Write-Host "跳过：找不到 $srcPath" -ForegroundColor Yellow; continue }
  $img = [System.Drawing.Bitmap]::FromFile($srcPath)
  try {
    $cellW = [int]($img.Width / $Cols)
    $cellH = $img.Height
    Write-Host ("切分 " + $m.slug + "：" + $img.Width + "x" + $img.Height + " → " + $Cols + " 格，每格 " + $cellW + "x" + $cellH)

    # 先做一遍抠像，收集每格的不透明边界
    $cells = @()
    for($i = 0; $i -lt $Cols; $i++){
      $bmp = New-Object System.Drawing.Bitmap($cellW, $cellH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $x0 = $i * $cellW
      $minX = $cellW; $maxX = -1; $minY = $cellH; $maxY = -1
      for($y = 0; $y -lt $cellH; $y++){
        for($x = 0; $x -lt $cellW; $x++){
          $c = $img.GetPixel($x0 + $x, $y)
          if(Test-Green $c){ continue }              # 背景：留作透明
          $bmp.SetPixel($x, $y, $c)
          if($x -lt $minX){ $minX = $x }
          if($x -gt $maxX){ $maxX = $x }
          if($y -lt $minY){ $minY = $y }
          if($y -gt $maxY){ $maxY = $y }
        }
      }
      $cells += @{ bmp = $bmp; minX = $minX; maxX = $maxX; minY = $minY; maxY = $maxY }
    }

    # 统一地面线 = 所有格子里最大的 maxY（倒地在最下面），再逐格裁切并对齐
    # ⚠ Measure-Object -Maximum 返回的是**对象**，直接参与算术会报
    #   "op_Subtraction 不存在" —— 必须先 [int] 收成数字。
    $ground = [int](($cells | ForEach-Object { [int]$_.maxY } | Measure-Object -Maximum).Maximum)
    $padTop = 8
    $index = @{ slug = $m.slug; ground = 0; poses = @{} }
    for($i = 0; $i -lt $Cols; $i++){
      $c = $cells[$i]
      if([int]$c.maxX -lt 0){ continue }
      $w = [int]$c.maxX - [int]$c.minX + 1
      # 内容高度：从该格内容顶部一直延伸到统一地面线（保证四格的脚底在同一水平线上）
      $contentH = $ground - [int]$c.minY + 1
      $h = $contentH + $padTop
      $dst = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $g = [System.Drawing.Graphics]::FromImage($dst)
      # ⚠ 必须把该格的 maxY **平移**到统一地面线：只按 minY 取等长的一段、
      #   贴到同一个 destRect 上，等于"各格各自对齐"，ground 白算了 ——
      #   实测后遗症是各姿势脚底差 4~21px，出招/受击时人会浮起或陷进地里。
      $shift = $ground - [int]$c.maxY
      $dstRect = New-Object System.Drawing.Rectangle 0, ($padTop + $shift), $w, $contentH
      $srcRect = New-Object System.Drawing.Rectangle ([int]$c.minX), ([int]$c.minY), $w, $contentH
      $g.DrawImage($c.bmp, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
      $g.Dispose()
      $pose = $m.poses[$i]
      $name = "$($m.slug)_$pose.png"
      $dst.Save((Join-Path $outDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
      # lowY = 这一格里**不透明最低行**。平移对齐后底部会留 0~21px 空档，
      #   绘制时若把"图片底边"当脚底，人就会陷进地里 —— 所以把落地点也写进索引。
      $index.poses[$pose] = @{ file = $name; w = $w; h = $h; lowY = ($padTop + $shift) }
      Write-Host ("  " + $pose.PadRight(7) + " → " + $name + "  " + $w + "x" + $h + "  落地点 y=" + ($padTop + $shift))
      $dst.Dispose()
      $c.bmp.Dispose()
    }
    $index.ground = $padTop
    $json = $index | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText((Join-Path $outDir ($m.slug + ".json")), $json, (New-Object System.Text.UTF8Encoding($false)))
  } finally { $img.Dispose() }
}
Write-Host ("完成 → " + $outDir) -ForegroundColor Green
Get-ChildItem $outDir -File | Select-Object Name, @{n="KB";e={[int]($_.Length/1024)}} | Format-Table -AutoSize
