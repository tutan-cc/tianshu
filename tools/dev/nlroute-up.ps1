<#
  nlroute-up.ps1 — 自然语言影子模式「一键起环境」：本地反代 + 静态服务，并打印下一步

  为什么要有它：影子模式要真的能用，得同时有两样东西在跑 ——
    ① 本地反代（tools/dev/nlroute-proxy.js，127.0.0.1:8010）：页面 → 反代 → TypeSafe，
       **key 只在反代进程里**，浏览器里一个凭据都不用放（也因为 CORS 直连根本过不去）；
    ② 静态服务（127.0.0.1:8000）：游戏页面从 http 起最省心。
  这两条命令记起来烦、端口也容易写错，所以包一层。

  用法（在仓库任意位置都能跑，路径按 $PSScriptRoot 自定位）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/nlroute-up.ps1
    powershell ... -File tools/dev/nlroute-up.ps1 -NoOpen            # 不自动开浏览器
    powershell ... -File tools/dev/nlroute-up.ps1 -ProxyPort 8011 -WebPort 8080
    powershell ... -File tools/dev/nlroute-up.ps1 -Stop              # 停掉上次起的两个进程

  实现备注（踩过的坑）：
    · 子进程用 `cmd /c "... > 日志 2>&1"` 起，**不用** Start-Process 的 -RedirectStandardOutput：
      PowerShell 5.1 会给被重定向的子进程挂一个异步输出泵，只要子进程不退出，
      powershell.exe 就一直不退出（脚本明明跑完了，命令行却挂住）。
    · 记下来的 PID 是 cmd 的，收摊用 `taskkill /T` 连子进程一起收（node/python 都在树里）。
    · 反代**不会**把 key 写进任何文件；它只从环境变量 / Windows 用户级变量读。
      没读到也不会崩：/health 报 hasKey=false，POST /route 返回 503（本脚本会提示怎么设）。
    · 本脚本只往 %TEMP%\nlroute-up\ 写两个日志和一份 PID 记录，不改仓库任何文件。
#>
param(
  [int]$ProxyPort = 8010,
  [int]$WebPort = 8000,
  [switch]$NoOpen,
  [switch]$Stop
)

$ErrorActionPreference = "Continue"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$stateFile = Join-Path $env:TEMP "nlroute-up.json"
$logDir = Join-Path $env:TEMP "nlroute-up"

function Say($s) { Write-Host $s }
function Warn($s) { Write-Host $s -ForegroundColor Yellow }
function Good($s) { Write-Host $s -ForegroundColor Green }

function Kill-Tree($procId) {
  if (-not $procId) { return $false }
  try {
    & taskkill /PID ([int]$procId) /T /F 2>&1 | Out-Null   # /T 连子进程（node / python）一起收
    return $true
  } catch { return $false }
}

# ── -Stop：按上次记下的 PID 收摊（连子树） ───────────────────────────────────
if ($Stop) {
  if (-not (Test-Path $stateFile)) { Warn "没有找到 $stateFile —— 没东西可停。"; exit 0 }
  $st = Get-Content $stateFile -Raw | ConvertFrom-Json
  foreach ($name in @("proxy", "web")) {
    $p = $st.$name
    if ($p) {
      if (Kill-Tree $p) { Good ("已停止 " + $name + "（pid " + $p + " 及其子进程）") }
      else { Warn ($name + "（pid " + $p + "）已经不在") }
    }
  }
  Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
  Good "收摊完成。"
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Warn "找不到 node —— 请先装 Node（>= 18，反代/静态服务都靠它）。"; exit 2 }
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$proxyLog = Join-Path $logDir "proxy.log"
$webLog = Join-Path $logDir "web.log"

Say "仓库：$repo"
Say "日志：$logDir"

# ── ① 本地反代 ──────────────────────────────────────────────────────────────
$proxyCmd = "node tools/dev/nlroute-proxy.js --port=$ProxyPort > $proxyLog 2>&1"
$proxy = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $proxyCmd) `
  -WorkingDirectory $repo -PassThru -WindowStyle Hidden

$health = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ProxyPort/health" -TimeoutSec 3; break } catch { }
}
if (-not $health) {
  Warn "✖ 反代没起来（端口 $ProxyPort 被占？）。日志尾部："
  if (Test-Path $proxyLog) { Get-Content $proxyLog -Tail 12 | ForEach-Object { Say ("   " + $_) } }
  Kill-Tree $proxy.Id | Out-Null
  exit 2
}
Good ("✔ 反代在跑：http://127.0.0.1:$ProxyPort  （GET /health · POST /route）")
if (-not $health.hasKey) {
  Warn "  ⚠ 反代没读到 TYPESAFE_API_KEY —— 页面会拿到 503。设一次（新开终端生效）:"
  Warn '     setx TYPESAFE_API_KEY "apikey_..."     # 或先 $env:TYPESAFE_API_KEY="apikey_..." 再重跑本脚本'
} else {
  Good ("  ✔ 凭据已就绪（来源 " + $health.keySource + "，内容不打印）")
}

# ── ② 静态服务（优先 python，其次用仓库自带的 node 静态服务）────────────────
$py = (Get-Command python -ErrorAction SilentlyContinue)
if ($py) { $webCmd = "python -m http.server $WebPort --bind 127.0.0.1 > $webLog 2>&1" }
else { $webCmd = "node tools/dev/nlroute-browser.js --serve-only > $webLog 2>&1" }

$web = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $webCmd) `
  -WorkingDirectory $repo -PassThru -WindowStyle Hidden

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/index.html" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if (-not $ok) {
  Warn "✖ 静态服务没起来（端口 $WebPort 被占？）。日志尾部："
  if (Test-Path $webLog) { Get-Content $webLog -Tail 12 | ForEach-Object { Say ("   " + $_) } }
  Kill-Tree $web.Id | Out-Null
  Kill-Tree $proxy.Id | Out-Null
  exit 2
}
Good ("✔ 静态服务在跑：http://127.0.0.1:$WebPort/index.html")

@{ proxy = $proxy.Id; web = $web.Id; proxyPort = $ProxyPort; webPort = $WebPort; at = (Get-Date).ToString("s") } |
  ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8

# ── ③ 下一步 ────────────────────────────────────────────────────────────────
$url = "http://127.0.0.1:$WebPort/index.html"
Say ""
Say "下一步："
Say ("  1) 打开页面：" + $url + "   → 点「开 始 重 生」进沙盘")
Say  "  2) 看侧栏「🧠 自然语言 · 影子模式」那个输入框，说一句「我想去打两圈」→ 回车"
Say  "     只会出一行「识别为… · 未跳转」，**不会自动跳转**（这就是影子模式）"
Say  "  3) 想导出语料：侧栏「📤 导出语料」，或控制台 NLRoute.exportJSON()"
Say  "  4) 收摊：powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/nlroute-up.ps1 -Stop"
Say ("     反代日志：" + $proxyLog)
if (-not $NoOpen) {
  Say ""
  Say "正在打开浏览器…"
  Start-Process $url
} else {
  Say ""
  Say "（-NoOpen：没有自动打开浏览器）"
}
