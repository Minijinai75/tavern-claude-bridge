<#
.SYNOPSIS
    Claude Bridge 後端安裝腳本
.DESCRIPTION
    把 server plugin 裝到 SillyTavern 的 plugins 資料夾。
    全程在你電腦上跑，不連網下載任何東西。
    腳本開源，跑之前歡迎打開看它做什麼。
.PARAMETER Verify
    驗證模式：不安裝，只檢查 bridge 是否已在運作。
#>
param([switch]$Verify)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [ERR] $msg" -ForegroundColor Red }
function Write-Step($n, $msg) { Write-Host "`n[$n/7] $msg" -ForegroundColor Cyan }

# ========== Verify 模式 ==========

if ($Verify) {
    Write-Host "`n=== Claude Bridge 驗證 ===" -ForegroundColor Cyan
    Write-Host "  檢查 bridge 是否在運作中...`n"
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:5199/v1/models" -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -eq 200) {
            Write-OK "Bridge 運作中"
            $data = ($r.Content | ConvertFrom-Json).data
            $names = @()
            foreach ($m in $data) { $names += $m.id }
            Write-Host "  可用模型: $($names -join ', ')"
        }
    } catch {
        Write-Err "無法連到 Bridge (http://127.0.0.1:5199)"
        Write-Host "    -> 確認酒館已啟動，並且啟動視窗裡有 'Bridge running' 的字樣"
    }
    exit
}

# ========== 安裝模式 ==========

Write-Host "`n=== Claude Bridge 後端安裝 ===" -ForegroundColor Cyan
Write-Host "這個腳本會幫你把 server plugin 裝好。"
Write-Host "全程在你電腦上跑，不連網下載任何東西。`n"

# --- Step 1: 環境檢查 ---

Write-Step 1 "環境檢查"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Err "找不到 Node.js"
    Write-Host "    -> 到 https://nodejs.org/ 下載 LTS 版本"
    Write-Host "    -> 安裝後重開 PowerShell 再跑一次這個腳本"
    exit 1
}
$nodeVer = & node --version 2>$null
Write-OK "Node.js $nodeVer"

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    Write-Err "找不到 npm"
    Write-Host "    -> Node.js 裝好應該自帶 npm，重新安裝 Node.js 試試"
    exit 1
}
$npmVer = & npm --version 2>$null
Write-OK "npm v$npmVer"

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCmd) {
    Write-Err "找不到 Claude Code CLI"
    Write-Host "    -> 打開 PowerShell 執行: npm install -g @anthropic-ai/claude-code"
    Write-Host "    -> 裝完後執行: claude login (照畫面指示登入你的 Claude 帳號)"
    Write-Host "    -> 登入完畢後重開 PowerShell，再跑一次這個腳本"
    exit 1
}
$claudeVer = & claude --version 2>$null
Write-OK "Claude Code $claudeVer"

# --- Step 2: 定位 ST 目錄 ---

Write-Step 2 "定位 SillyTavern 目錄"

$stDir = $null
if (Test-Path (Join-Path $PWD.Path "server.js")) {
    $stDir = $PWD.Path
    Write-OK "就在目前目錄: $stDir"
} else {
    Write-Host "  目前所在的目錄不是 SillyTavern (找不到 server.js)"
    Write-Host "  請把你的 SillyTavern 資料夾拖進這個視窗，然後按 Enter:"
    $userPath = Read-Host "  路徑"
    $userPath = $userPath.Trim('"').Trim("'").Trim()
    if (-not $userPath -or -not (Test-Path (Join-Path $userPath "server.js"))) {
        Write-Err "指定的路徑裡沒有 server.js，確定是 SillyTavern 的資料夾嗎?"
        exit 1
    }
    $stDir = $userPath
    Write-OK "SillyTavern 目錄: $stDir"
}

# --- Step 3: 檢查前端擴充 ---

Write-Step 3 "檢查前端擴充"

$frontendDir = Join-Path $stDir "data\default-user\extensions\tavern-claude-bridge"
if (-not (Test-Path $frontendDir)) {
    Write-Err "前端擴充還沒裝"
    Write-Host "    -> 先打開酒館，到左下角擴充 (積木圖示)"
    Write-Host "    -> 在 Install Extension 貼上: https://github.com/Minijinai75/tavern-claude-bridge"
    Write-Host "    -> 裝好後再跑一次這個腳本"
    exit 1
}
Write-OK "前端擴充已安裝"

# --- Step 4: 複製 Server Plugin (防呆核心) ---

Write-Step 4 "複製 Server Plugin"

$sourceDir = Join-Path $frontendDir "server\tavern-claude-bridge"
if (-not (Test-Path (Join-Path $sourceDir "index.mjs"))) {
    Write-Err "找不到 server plugin 的來源檔案"
    Write-Host "    -> $sourceDir 裡沒有 index.mjs"
    Write-Host "    -> 可能是擴充版本太舊，到酒館擴充面板更新 Claude Bridge 後再試"
    exit 1
}

$pluginsDir = Join-Path $stDir "plugins"
if (-not (Test-Path $pluginsDir)) {
    New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
}

$targetDir = Join-Path $pluginsDir "tavern-claude-bridge"
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

Copy-Item (Join-Path $sourceDir "index.mjs") (Join-Path $targetDir "index.mjs") -Force
Copy-Item (Join-Path $sourceDir "package.json") (Join-Path $targetDir "package.json") -Force

if (-not (Test-Path (Join-Path $targetDir "index.mjs")) -or -not (Test-Path (Join-Path $targetDir "package.json"))) {
    Write-Err "複製失敗: plugins\tavern-claude-bridge\ 裡缺少 index.mjs 或 package.json"
    exit 1
}

if (Test-Path (Join-Path $targetDir "manifest.json")) {
    Write-Warn "偵測到前端的 manifest.json 殘留在 plugins 裡 (可能是之前手動搬錯層)"
    Write-Host "    -> 已用正確的 server plugin 覆蓋，不影響運作"
}

Write-OK "Server plugin 已複製到 plugins\tavern-claude-bridge\"

# --- Step 5: npm install ---

Write-Step 5 "安裝依賴套件"

Write-Host "  正在安裝 SDK 和依賴套件，請稍等..."
Push-Location $targetDir
try {
    & npm install 2>&1 | Out-Null
} finally {
    Pop-Location
}

$sdkDir = Join-Path $targetDir "node_modules\@anthropic-ai\claude-agent-sdk"
if (-not (Test-Path $sdkDir)) {
    Write-Err "安裝不完整: 找不到 @anthropic-ai/claude-agent-sdk"
    Write-Host "    -> 打開 PowerShell，進到以下目錄手動跑 npm install 看看錯誤訊息:"
    Write-Host "    -> $targetDir"
    exit 1
}

$modulesDir = Join-Path $targetDir "node_modules"
$pkgCount = 0
if (Test-Path $modulesDir) {
    $dirs = Get-ChildItem $modulesDir -Directory -ErrorAction SilentlyContinue
    foreach ($d in $dirs) {
        if ($d.Name.StartsWith('@')) {
            $subDirs = Get-ChildItem $d.FullName -Directory -ErrorAction SilentlyContinue
            if ($subDirs) { $pkgCount += @($subDirs).Count }
        } else {
            $pkgCount++
        }
    }
}

if ($pkgCount -lt 50) {
    Write-Warn "套件數偏低 ($pkgCount 個)，可能安裝不完整"
    Write-Host "    -> 正常應該有 100 個以上。到 $targetDir 手動跑 npm install 試試"
} else {
    Write-OK "依賴套件安裝完成 ($pkgCount 個套件)"
}

# --- Step 6: config.yaml ---

Write-Step 6 "設定 config.yaml"

$configPath = Join-Path $stDir "config.yaml"
if (-not (Test-Path $configPath)) {
    Write-Err "找不到 config.yaml"
    Write-Host "    -> SillyTavern 目錄裡應該要有 config.yaml"
    Write-Host "    -> 如果沒有，先啟動一次酒館讓它自動產生，再跑一次這個腳本"
    exit 1
}

$configContent = [System.IO.File]::ReadAllText($configPath)

if ($configContent -match 'enableServerPlugins:\s*true') {
    Write-OK "enableServerPlugins 已經是 true，跳過"
} elseif ($configContent -match 'enableServerPlugins:\s*false') {
    Copy-Item $configPath "$configPath.bak-install" -Force
    Write-OK "已備份 config.yaml -> config.yaml.bak-install"

    $newContent = $configContent -replace 'enableServerPlugins:\s*false', 'enableServerPlugins: true'
    [System.IO.File]::WriteAllText($configPath, $newContent, (New-Object System.Text.UTF8Encoding $false))
    Write-OK "enableServerPlugins: false -> true"
} else {
    Write-Err "在 config.yaml 裡找不到 enableServerPlugins 這個設定"
    Write-Host "    -> 請手動用記事本打開 config.yaml，加上一行: enableServerPlugins: true"
    exit 1
}

# --- Step 7: 收尾 ---

Write-Step 7 "完成"

$stRunning = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 8000)
    $tcp.Close()
    $stRunning = $true
} catch {}

if ($stRunning) {
    Write-Warn "偵測到酒館正在執行中"
    Write-Host "    -> 請關閉酒館後重新啟動，讓 server plugin 生效"
} else {
    Write-Host "  現在可以啟動酒館了。"
}

Write-Host ""
Write-Host "  啟動後看黑色文字視窗，出現以下三行就代表成功:" -ForegroundColor White
Write-Host ""
Write-Host "    [tavern-claude-bridge] SDK loaded." -ForegroundColor DarkGray
Write-Host "    [tavern-claude-bridge] Bridge running at http://127.0.0.1:5199" -ForegroundColor DarkGray
Write-Host "    [tavern-claude-bridge] Plugin initialized." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  裝好之後跑 install.ps1 -Verify 可以快速檢查 bridge 是否正常。" -ForegroundColor White
Write-Host ""
