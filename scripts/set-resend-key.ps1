param(
  [int]$Slot = 2,
  [string]$Domain = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$secretName = if ($Slot -le 1) { "RESEND_API_KEY" } else { "RESEND_API_KEY_$Slot" }
$providerName = if ($Slot -le 1) { "resend" } else { "resend$Slot" }

$secure = Read-Host "Paste Resend API key ($secretName, starts with re_) and press Enter" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$cleanKey = ($plain -replace '[\r\n\s]+', '')
if (-not $cleanKey.StartsWith("re_") -or $cleanKey.Length -lt 20) {
  throw "Invalid Resend API key format (expected re_..., length >= 20; got length $($cleanKey.Length)). Please copy the Resend API key again and retry."
}

Set-Location $Root

# 1. Save persistently in Windows User env so future domain onboardings need zero re-entry
[Environment]::SetEnvironmentVariable($secretName, $cleanKey, "User")
[Environment]::SetEnvironmentVariable($secretName, $cleanKey, "Process")
Write-Host "[OK] Saved $secretName to Windows User environment."

# 2. Upload cleanly to Cloudflare Worker secret without trailing CR/LF
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = "/c npx wrangler secret put $secretName"
$psi.WorkingDirectory = $Root
$psi.RedirectStandardInput = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.Write($cleanKey)
$proc.StandardInput.Close()
$proc.WaitForExit()
if ($proc.ExitCode -ne 0) {
  throw "npx wrangler secret put $secretName failed with exit code $($proc.ExitCode)"
}

# 3. Optionally provision the domain in Resend + sync DNS to Cloudflare
if (-not [string]::IsNullOrWhiteSpace($Domain)) {
  powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "add-mail-domain.ps1") -Domain $Domain -Provider $providerName -ProvisionResend -VerifyPublicDns
  if ($LASTEXITCODE -ne 0) {
    throw "add-mail-domain.ps1 failed with exit code $LASTEXITCODE"
  }
}
