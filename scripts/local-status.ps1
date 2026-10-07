$ErrorActionPreference = "Stop"
$Port = 4173
$Url = "http://127.0.0.1:$Port/"
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if ($listeners) {
  Write-Host "Agentic Inbox is running: $Url"
  foreach ($listener in $listeners) {
    Write-Host "PID $($listener.OwningProcess) listening on $($listener.LocalAddress):$($listener.LocalPort)"
  }
  exit 0
}

Write-Host "Agentic Inbox is not running on port $Port."
exit 1
