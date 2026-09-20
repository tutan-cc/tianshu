<#
  pack-media.ps1 —— 从媒体素材库生成「媒体清单.json」并打出可分发 zip

  用途：素材不入 git。这个脚本把素材库做成一个带版本号、可校验的压缩包，
        放进 dist\素材分发\，由维护者**私下复制**给协作者（不上 GitHub Release：
        包内含授权未核实的第三方素材，公开附件等同于公开分发）。
        对方解压后跑「link-media.ps1」即可完整游玩。

  用法：
    powershell -ExecutionPolicy Bypass -File .\pack-media.ps1
    powershell -ExecutionPolicy Bypass -File .\pack-media.ps1 -Version v1.15 -MediaDir "D:\媒体素材"

  产出：
    <仓库>\媒体清单.json              入库的契约文件（体积小，只记路径/字节/SHA256/来源）
    <仓库>\dist\素材分发\media-<版本>.zip      分发包（复制给协作者，不入库）
    <仓库>\dist\素材分发\media-<版本>.zip.sha256  校验文件
#>
param(
  [string]$Version = "v2.0",
  [string]$MediaDir
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
if (-not $repo) { $repo = (Get-Location).Path }

function Test-MediaLib([string]$d) {
  if (-not $d -or -not (Test-Path $d)) { return $false }
  $v = Join-Path $d "video"
  if (-not (Test-Path $v)) { return $false }
  return @(Get-ChildItem $v -Filter *.mp4 -File -ErrorAction SilentlyContinue).Count -gt 0
}

# ── 1. 定位素材库（与 link-media.ps1 同一套逻辑）────────────────────
if (-not (Test-MediaLib $MediaDir)) {
  if ($MediaDir) { throw "不是有效的媒体素材库（需含 video\*.mp4）：$MediaDir" }
  $parent = Split-Path $repo -Parent
  $cands = @()
  $preferred = Join-Path $parent "Tianshu-Prototype-媒体素材"
  if (Test-MediaLib $preferred) { $cands = @($preferred) }
  else {
    $cands = Get-ChildItem $parent -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -ne $repo -and (Test-MediaLib $_.FullName) } |
             Select-Object -ExpandProperty FullName
  }
  if (@($cands).Count -eq 0) { throw "找不到媒体素材目录，请用 -MediaDir 指定。" }
  $MediaDir = @($cands)[0]
}
$MediaDir = (Resolve-Path $MediaDir).Path
Write-Host "媒体素材库：$MediaDir" -ForegroundColor Cyan

# ── 2. 计算清单（逐文件 SHA256）─────────────────────────────────────
#
# ⚠ 素材有**两个来源**，授权性质相反，必须分开取：
#     video\  ← 媒体素材库（仓库外）。实拍素材授权未核实 → 不入库 → 带外分发
#     audio\  ← **仓库自己**（audio\ 是真目录，308 个自产音频已入库）
#   为什么这样分：git 会透过 junction 提交里面的文件，
#   所以在同一个 junction 上做不到「自产入库、第三方不入库」。
#   实测后果是同事 clone 下来一条音频都没有 —— 自产素材本就该直接入库。
#   视频那边保留联接（210MB 第三方，不入库），音频这边改为仓库自带。
#
# 来源分类按目录判定，而不是文件名白名单 —— 以后往 video/original/ 加原创素材
# 会被自动标为 original，不必回来改脚本。
#   video/          实拍视频，授权未核实（thirdparty）
#   video/poster/   同上，由实拍视频抽帧
#   video/original/ 原创程序化生成（可自由分发）
#   audio/          全部自产（StepAudio 生成），可自由使用
#
# 下划线开头的目录/文件一律排除：那是加工中间产物（TTS 原始件备份 _seat1_src、
# 处理前素材 _sfx_src 等），不是要给协作者的东西。
# 曾因为没排除，把三份座位原始备份一起打进了分发包（多 3.5MB 且清单被污染）。
# 处理完的原始件统一放在仓库外的 audio-工作区\_原始件备份\。
$repoAudio = Join-Path $repo "audio"
$videoRoot = Join-Path $MediaDir "video"
$mediaFiles = @()
if (Test-Path $repoAudio) {
  # 音频：来自仓库，统一加 audio/ 前缀，与清单里 path 的口径一致
  $mediaFiles += Get-ChildItem $repoAudio -Recurse -File |
                 Where-Object { $_.Name -notlike "_*" } |
                 Where-Object { $_.FullName -notmatch '\\_[^\\]*\\' } |
                 ForEach-Object { [pscustomobject]@{ File = $_; Rel = "audio/" + $_.FullName.Substring($repoAudio.Length).TrimStart('\').Replace('\','/') } }
} else {
  Write-Host "⚠ 仓库里没有 audio\ —— 自产音频未入库？试 git checkout -- audio" -ForegroundColor Yellow
}
if (Test-Path $videoRoot) {
  $mediaFiles += Get-ChildItem $videoRoot -Recurse -File |
                 Where-Object { $_.Name -notlike "_*" } |
                 Where-Object { $_.FullName -notmatch '\\_[^\\]*\\' } |
                 ForEach-Object { [pscustomobject]@{ File = $_; Rel = "video/" + $_.FullName.Substring($videoRoot.Length).TrimStart('\').Replace('\','/') } }
}
$mediaFiles = @($mediaFiles | Sort-Object Rel)

function Get-SourceOf([string]$rel) {
  if ($rel -like "video/original/*")                 { return "original" }
  if ($rel -like "video/fx_*")                       { return "original" }   # 历史位置，兼容
  # audio/ 全部是本项目自产（StepAudio TTS/音效/BGM），可自由使用
  if ($rel -like "audio/*")                          { return "self" }
  return "thirdparty"
}
function Get-LicenseOf([string]$src) {
  switch ($src) {
    "original"   { return "原创-程序化生成" }
    "self"       { return "自产-可自由使用" }
    default      { return "未核实-仅供本地试验" }
  }
}

$sizeMB = [math]::Round((($mediaFiles | ForEach-Object { $_.File.Length } | Measure-Object -Sum).Sum / 1MB), 1)
Write-Host "计算 SHA256（$($mediaFiles.Count) 个文件，约 $sizeMB MB）..." -ForegroundColor Cyan
$entries = @()
$n = 0
foreach ($m in $mediaFiles) {
  $f = $m.File
  $rel = $m.Rel          # 已在收集阶段算好（音频来自仓库、视频来自素材库，前缀口径统一）
  $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
  $src = Get-SourceOf $rel
  $entries += [ordered]@{
    path    = $rel
    bytes   = $f.Length
    sha256  = $h
    source  = $src
    license = Get-LicenseOf $src
  }
  $n++
  if ($n % 40 -eq 0) { Write-Host "  $n / $($mediaFiles.Count)" -ForegroundColor DarkGray }
}

$manifest = [ordered]@{
  package  = "天枢原型-媒体素材"
  version  = $Version
  # 注意：这里**故意不写生成时间**。清单是入库的契约文件，若带时间戳，
  # 每次跑本脚本都会改动它、污染 git status。去掉后清单只随素材内容变化 ——
  # 素材没变则字节完全一致（可反复跑、可复现）。要查生成时间看 git log 即可。
  note     = "audio/ 为自产素材，已随仓库入库，无需额外获取；video/ 因授权未核实不入库，需拿到 media-$Version.zip 解压到仓库同级目录后运行 link-media.ps1 接通。"
  sourceNote = "source 字段：original=原创可自由分发 · self=项目自产（全部 audio/）· thirdparty=授权未核实，仅供本地试验、不得公开分发（全部实拍 video/）。"
  counts   = [ordered]@{
    mp4    = @($entries | Where-Object { $_.path -like "video/*.mp4" }).Count
    poster = @($entries | Where-Object { $_.path -like "video/poster/*" }).Count
    audio  = @($entries | Where-Object { $_.path -like "audio/*" }).Count
    total  = $entries.Count
  }
  files    = $entries
}

$manifestPath = Join-Path $repo "媒体清单.json"
$json = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已写出清单：$manifestPath" -ForegroundColor Green
Write-Host ("  mp4={0} poster={1} audio={2}  共 {3} 个文件" -f `
  $manifest.counts.mp4,$manifest.counts.poster,$manifest.counts.audio,$manifest.counts.total)
# 按来源分组汇总（便于一眼看出还有多少第三方素材待替换）
$nOrig = @($entries | Where-Object { $_.source -eq "original" }).Count
$nSelf = @($entries | Where-Object { $_.source -eq "self" }).Count
$nTp   = @($entries | Where-Object { $_.source -eq "thirdparty" }).Count
Write-Host ("    来源 original=" + $nOrig + " · self=" + $nSelf + " · thirdparty=" + $nTp) -ForegroundColor DarkGray
if ($nTp -gt 0) { Write-Host ("    ⚠ 其中 " + $nTp + " 个授权未核实，仅供本地试验，不得公开分发") -ForegroundColor Yellow }

# ── 3. 打包 ─────────────────────────────────────────────────────────
$dist = Join-Path $repo "dist"
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zip = Join-Path $dist "media-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

Write-Host "打包中..." -ForegroundColor Cyan
# 压到临时目录再 Compress-Archive，保证 zip 内是 video\ 顶层结构（audio\ 已入库，不必再分发）。
# ⚠ video 取**素材库**（仓库外、不入库），不要取仓库里那个 junction —— 虽然内容相同，
#   但明确从素材库取更符合语义：分发包是「给协作者补齐仓库里没有的第三方素材」。
# 同样排除下划线开头的加工中间产物。
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("medstage_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($d in @("video")) {
  $src = Join-Path $MediaDir $d
  if (-not (Test-Path $src)) { continue }
  $dest = Join-Path $stage $d
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Get-ChildItem $src -Force | Where-Object {
    $_.Name -notlike "_*"
  } | ForEach-Object {
    Copy-Item $_.FullName $dest -Recurse -Force
  }
}
# 素材库自己的 README 也带上，方便拿到包的人理解结构
Copy-Item (Join-Path $MediaDir "README.md") (Join-Path $stage "README.md") -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$zmb = [math]::Round((Get-Item $zip).Length/1MB,1)
Write-Host "已打包：$zip  ($zmb MB)" -ForegroundColor Green

# ── 4. 归入本地分发目录并生成校验文件 ────────────────────────────────
# 素材分发走本地文件夹，不上 GitHub Release：包内含授权未核实的第三方素材，
# 公开 Release 附件等同于公开分发。详见 dist\素材分发\README.md
$share = Join-Path $repo "dist\素材分发"
New-Item -ItemType Directory -Path $share -Force | Out-Null
$shareZip = Join-Path $share "media-$Version.zip"
Move-Item $zip $shareZip -Force

$hash = (Get-FileHash $shareZip -Algorithm SHA256).Hash.ToLower()
$shaFile = "$shareZip.sha256"
[System.IO.File]::WriteAllText($shaFile, "$hash *media-$Version.zip`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host "已归入分发目录：$shareZip" -ForegroundColor Green
Write-Host "   SHA256：$hash" -ForegroundColor DarkGray
Write-Host ""
Write-Host "下一步（本地分发，不上 GitHub）：" -ForegroundColor Cyan
Write-Host "  1. 把 媒体清单.json 提交进 git（只有 65KB，是协作者校验素材用的契约文件）"
Write-Host "  2. 把 dist\素材分发\media-$Version.zip 复制给协作者"
Write-Host "     —— 网盘 / 移动硬盘 / 局域网共享都行，注意别放到公开可下载的位置"
Write-Host "  3. 对方解压到仓库同级目录（名字用「Tianshu-Prototype-媒体素材」会被优先识别）"
Write-Host "  4. 对方跑一次 .\link-media.ps1 即可接通，脚本会按清单逐文件校验 SHA256"
Write-Host ""
Write-Host "细节见 dist\素材分发\README.md 与 协作者上手指南.md" -ForegroundColor DarkGray
