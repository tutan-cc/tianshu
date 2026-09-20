<#
  link-media.ps1 —— 把「媒体素材」目录挂进本仓库（Windows 目录联接，零拷贝 / 零代码改动）

  为什么需要它：
    实拍视频与配音因版权未核实，不入 git 仓库。clone 完代码后，把媒体素材包解压到仓库
    的同级目录（或仓库内任意目录），再跑一次本脚本，游戏即自动接上素材。

  用法：
    powershell -ExecutionPolicy Bypass -File .\link-media.ps1
    powershell -ExecutionPolicy Bypass -File .\link-media.ps1 -MediaDir "D:\某处\媒体素材"

  做什么：
    把 <媒体素材>\video 与 <媒体素材>\audio 以目录联接的方式挂成仓库根的 video\ 与 audio\。
    联接对 git 不可见（git status 保持干净），也不需要管理员权限。
#>
param(
  [string]$MediaDir
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
if (-not $repo) { $repo = (Get-Location).Path }

function Test-MediaLib([string]$d) {
  if (-not $d -or -not (Test-Path $d)) { return $false }
  # 媒体库的特征：内含 video\ 且有 mp4
  $v = Join-Path $d "video"
  if (-not (Test-Path $v)) { return $false }
  return @(Get-ChildItem $v -Filter *.mp4 -File -ErrorAction SilentlyContinue).Count -gt 0
}

# ── 1. 定位媒体素材目录 ───────────────────────────────────────────────
if (-not (Test-MediaLib $MediaDir)) {
  if ($MediaDir) { throw "指定的目录不是有效的媒体素材库（需含 video\*.mp4）：$MediaDir" }

  # 先按约定名找同级目录，再退化为扫描所有同级目录
  $parent = Split-Path $repo -Parent
  $cands  = @()
  $preferred = Join-Path $parent "Tianshu-Prototype-媒体素材"
  if (Test-MediaLib $preferred) {
    $cands = @($preferred)
  } else {
    $cands = Get-ChildItem $parent -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -ne $repo -and (Test-MediaLib $_.FullName) } |
             Select-Object -ExpandProperty FullName
  }

  if (@($cands).Count -eq 0) {
    throw @"
找不到媒体素材目录。

请把媒体素材包解压到本仓库同级目录，命名为「Tianshu-Prototype-媒体素材」，使其结构为：
  $parent\Tianshu-Prototype-媒体素材\video\  (35 个 mp4 + poster\ 35 张 jpg)
  $parent\Tianshu-Prototype-媒体素材\audio\  (可选：vo_real\ 主配音 / vo\ 备用 / mj\ 牌名播报)

或显式指定路径：
  powershell -ExecutionPolicy Bypass -File .\link-media.ps1 -MediaDir "D:\某处\媒体素材"
"@
  }
  if (@($cands).Count -gt 1) { Write-Host "找到多个候选，取第一个：$($cands[0])" -ForegroundColor Yellow }
  $MediaDir = @($cands)[0]
}
$MediaDir = (Resolve-Path $MediaDir).Path
Write-Host "媒体素材库：$MediaDir" -ForegroundColor Cyan

# ── 2. 展示素材清单（优先用 媒体清单.json 的权威计数）─────────────────
$mLibVideo = Join-Path $MediaDir "video"
$mLibAudio = Join-Path $MediaDir "audio"
$manifestPath = Join-Path $repo "媒体清单.json"
$manifest = $null
if (Test-Path $manifestPath) {
  try { $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
    Write-Host "媒体清单.json 解析失败，跳过按清单校验：$($_.Exception.Message)" -ForegroundColor Yellow
    $manifest = $null
  }
}
# 计数助手：缺目录时返回 0，不报错
function Count-In([string]$dir, [string]$filter) {
  if (-not (Test-Path $dir)) { return 0 }
  return @(Get-ChildItem $dir -Filter $filter -File -ErrorAction SilentlyContinue).Count
}
if ($manifest -and $manifest.counts) {
  $c = $manifest.counts
  $extra = if ($c.audio -gt 0) { " · 音频 $($c.audio)" } else { " · 无音频（配音素材库未提供）" }
  Write-Host ("  清单 {0} · 视频 {1} · 剧照 {2}{3}（共 {4}）" -f `
    $manifest.version,$c.mp4,$c.poster,$extra,$c.total) -ForegroundColor Cyan
} else {
  Write-Host ("  无清单 · 视频 {0} · 剧照 {1}" -f (Count-In $mLibVideo "*.mp4"), (Count-In (Join-Path $mLibVideo "poster") "*.jpg")) -ForegroundColor Yellow
}

# ── 3. 挂载 video\（audio\ 不挂！见下）────────────────────────────────
#
# ⚠ 为什么不再挂 audio\：
#   原先 video\ 与 audio\ 都从素材库联接过来。但两者的**授权性质相反**：
#     video\  = 实拍素材（授权未核实）→ 不能入库 → 必须走带外分发 → 需要联接
#     audio\  = 全部自产（StepAudio TTS/音效/BGM）→ **应该入库** → 不该走联接
#   git 会透过 junction 提交里面的文件，所以同一个 junction 上做不到
#   「自产入库、第三方不入库」。实测后果：同事 clone 下来**一条音频都没有**
#   （308 个自产音频全在带外包里），这是真实的协作阻塞。
#   现改为：audio\ 是仓库里的**真目录**（308 个文件约 12MB，直接入库）；
#   video\ 仍为联接（210MB 第三方，不入库）。
#   pack-media.ps1 也相应改为：视频取素材库、音频取仓库。
foreach ($name in @("video")) {
  $link = Join-Path $repo $name
  $target = Join-Path $MediaDir $name

  if (-not (Test-Path $target)) {
    # 素材库里没有这一类 → 若仓库里还留着指向旧位置的悬空联接，清掉，避免残留死链
    if (Test-Path $link) {
      $li = Get-Item $link -Force
      if ($li.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Write-Host "  $name\ 的联接目标已不存在，清除悬空联接" -ForegroundColor Yellow
        cmd /c "rmdir `"$link`"" | Out-Null
      }
    }
    Write-Host "跳过 $name（素材库中不存在，属正常：素材可只含视频）" -ForegroundColor DarkGray
    continue
  }

  if (Test-Path $link) {
    $item = Get-Item $link -Force
    $isLink = $item.Attributes -band [IO.FileAttributes]::ReparsePoint
    if ($isLink) {
      # 已联接：目标正确就跳过，错误就重建
      $cur = @($item.Target)[0]
      if ($cur -eq $target) { Write-Host "  $name\ 已联接（正确），跳过" -ForegroundColor DarkGray; continue }
      Write-Host "  $name\ 联接指向别处，重建" -ForegroundColor Yellow
      cmd /c "rmdir `"$link`"" | Out-Null
    } else {
      # 真目录：先并入素材库（保住仓库自带的原创素材），再删空目录建联接
      Write-Host "  $name\ 是真目录，先并入素材库再联接" -ForegroundColor Yellow
      & robocopy $link $target /E /XC /XN /XO /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
      Remove-Item $link -Recurse -Force
    }
  }
  cmd /c "mklink /J `"$link`" `"$target`"" | Out-Null
  if (Test-Path $link) { Write-Host "  $name\  <-  $target" -ForegroundColor Green }
  else { throw "创建联接失败：$link" }
}

# ── 3b. audio\ 自检：它是仓库自带素材，不该被联接覆盖 ────────────────
$audioLink = Join-Path $repo "audio"
if (Test-Path $audioLink) {
  $ai = Get-Item $audioLink -Force
  if ($ai.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    # 老版本 link-media.ps1 建的联接还在 → 说明是从旧布局升上来的，提示但不自动删
    # （自动删有风险：万一是别人特意挂的。让人自己决定。）
    Write-Host "  ⚠ audio\ 仍是指向素材库的联接 —— 自产音频应当直接入库，不该走联接。" -ForegroundColor Yellow
    Write-Host "     若要把音频改为仓库自带的真目录：先删联接（cmd /c rmdir audio），" -ForegroundColor Yellow
    Write-Host "     再 git checkout -- audio 取回库里那份。" -ForegroundColor Yellow
  } else {
    $an = @(Get-ChildItem $audioLink -File -Recurse -ErrorAction SilentlyContinue).Count
    Write-Host "  audio\ 为仓库自带真目录（$an 个文件），不联接" -ForegroundColor Green
  }
} else {
  Write-Host "  audio\ 不存在（若已 clone 完整仓库，请 git checkout -- audio 取回自产音频）" -ForegroundColor Yellow
}

# ── 4. 自检（只查必有项；配音等可选素材按清单校验，不在此硬性要求）────
Write-Host "`n自检：" -ForegroundColor Cyan
$checks = @(
  @{p="video\fx_market.mp4";            d="原创动画"},
  @{p="video\ktv_boss.mp4";             d="实拍视频"},
  @{p="video\poster\ktv_boss.jpg";      d="剧照"}
)
$fail = 0
foreach ($c in $checks) {
  $ok = Test-Path (Join-Path $repo $c.p)
  if (-not $ok) { $fail++ }
  Write-Host ("  [{0}] {1,-28} {2}" -f $(if($ok){"OK"}else{"!!"}), $c.p, $c.d) -ForegroundColor $(if($ok){"Gray"}else{"Red"})
}
$selfFail = $fail

# ── 5. 按「媒体清单.json」全量校验（存在才做）─────────────────────────
if ($manifest -and $manifest.files) {
  Write-Host "`n按媒体清单.json 校验 $($manifest.files.Count) 个文件……" -ForegroundColor Cyan
  $missing = @(); $badSize = @(); $badHash = @(); $verified = 0
  foreach ($f in $manifest.files) {
    $full = Join-Path $repo ($f.path -replace '/','\')
    if (-not (Test-Path $full)) { $missing += $f.path; continue }
    $item = Get-Item $full -Force
    # 联接目录里的文件也走真实路径，长度可读
    if ($item.Length -ne $f.bytes) { $badSize += ("{0} (期望 {1} 实为 {2})" -f $f.path,$f.bytes,$item.Length); continue }
    $h = (Get-FileHash $full -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $f.sha256) { $badHash += $f.path; continue }
    $verified++
  }
  Write-Host ("  校验通过 {0} / {1}" -f $verified, $manifest.files.Count) -ForegroundColor $(if($verified -eq $manifest.files.Count){"Green"}else{"Yellow"})
  foreach ($m in $missing)  { Write-Host "  [缺失] $m" -ForegroundColor Red }
  foreach ($m in $badSize)  { Write-Host "  [大小不符] $m" -ForegroundColor Red }
  foreach ($m in $badHash)  { Write-Host "  [内容不符] $m" -ForegroundColor Red }
  $badFiles = $missing.Count + $badSize.Count + $badHash.Count
  $fail += $badFiles
  if ($missing.Count) {
    Write-Host "  → 素材包不完整：请重新下载 media-$($manifest.version).zip 完整解压" -ForegroundColor Yellow
  }
  # 素材来源提醒（第三方素材替换清单）
  $tp = @($manifest.files | Where-Object { $_.source -eq "thirdparty" }).Count
  if ($tp -gt 0) {
    Write-Host "  提示：$tp 个文件来源为 thirdparty（授权未核实，仅供本地试验）；换成自拍/AI 生成后，重跑 pack-media.ps1 更新清单即可。" -ForegroundColor DarkGray
  }
}

if ($fail -eq 0) {
  Write-Host "`n素材已接通。起服务：python -m http.server 8000  然后开 http://127.0.0.1:8000/index.html" -ForegroundColor Green
} else {
  Write-Host "`n检查未通过：清单校验有问题文件 $(($fail - $selfFail)) 个，样例自检失败 $selfFail 项。" -ForegroundColor Red
  Write-Host "素材包可能下载不完整 —— 请重新下载 media-$($manifest.version).zip 并完整解压。" -ForegroundColor Yellow
  exit 1
}
