$ErrorActionPreference = "Stop"
$Port = 4173
$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -eq $Port }

if (-not $listeners) {
  Write-Host "Agentic Inbox is not running on port $Port."
  exit 0
}

$processIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $processIds) {
  try {
    Stop-Process -Id $processId -Force
    Write-Host "Stopped process $processId on port $Port."
  } catch {
    Write-Host "Could not stop process ${processId}: $($_.Exception.Message)"
  }
}