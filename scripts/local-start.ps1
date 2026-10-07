param(
  [switch]$Build
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Port = 4173
$Url = "http://127.0.0.1:$Port/"
$LogDir = Join-Path $Root ".codex-logs"
$OutLog = Join-Path $LogDir "preview.out.log"
$ErrLog = Join-Path $LogDir "preview.err.log"

function Get-Listener {
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $Port } |
    Select-Object -First 1
}

Set-Location $Root
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$listener = Get-Listener
if ($listener) {
  Write-Host "Agentic Inbox is already running: $Url"
  Start-Process $Url
  exit 0
}

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
  Write-Host "Installing dependencies..."
  npm install
}

if ($Build -or -not (Test-Path (Join-Path $Root "build\server")) -or -not (Test-Path (Join-Path $Root "build\client"))) {
  Write-Host "Building app..."
  npm run build
}

Remove-Item -LiteralPath $OutLog,$ErrLog -ErrorAction SilentlyContinue

$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
$proc = Start-Process `
  -FilePath $npx `
  -ArgumentList @("vite", "preview", "--host", "127.0.0.1") `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -PassThru

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (Get-Listener) {
    Write-Host "Agentic Inbox started: $Url"
    Write-Host "Process ID: $($proc.Id)"
    Write-Host "Logs: $OutLog"
    Start-Process $Url
    exit 0
  }
}

Write-Host "Failed to start Agentic Inbox. Check logs:"
Write-Host $OutLog
Write-Host $ErrLog
exit 1