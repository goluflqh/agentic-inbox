$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ScriptsDir = $PSScriptRoot
$ConfigPath = Join-Path $Root "wrangler.jsonc"

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw "ASSERTION FAILED: $Message"
  }
}

function Invoke-ScriptCapture {
  param(
    [string]$ScriptPath,
    [string[]]$Arguments = @()
  )

  $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $Arguments
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & powershell @psArgs 2>&1 | ForEach-Object { $_.ToString() }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevPref
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output   = ($output -join "`n")
  }
}

Write-Host "=== 1. PowerShell Parser Syntax Validation ==="
$psFiles = Get-ChildItem -LiteralPath $ScriptsDir -Filter "*.ps1" | Sort-Object Name
Assert-True ($psFiles.Count -ge 3) "Expected at least 3 PowerShell scripts in $ScriptsDir"

foreach ($file in $psFiles) {
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors -and $parseErrors.Count -gt 0) {
    $errDetails = ($parseErrors | ForEach-Object { "Line $($_.Extent.StartLineNumber): $($_.Message)" }) -join "; "
    throw "Syntax error in $($file.Name): $errDetails"
  }
  Write-Host ("[PASS] Syntax OK: {0}" -f $file.Name)
}

$wranglerBefore = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash
$buildWranglerPath = Join-Path $Root "build\server\wrangler.json"
$buildWranglerBefore = if (Test-Path -LiteralPath $buildWranglerPath) { (Get-FileHash -LiteralPath $buildWranglerPath -Algorithm SHA256).Hash } else { $null }

Write-Host ""
Write-Host "=== 2. Preflight Check (cf-preflight.ps1) ==="
$preflightPath = Join-Path $ScriptsDir "cf-preflight.ps1"
$preflightRes = Invoke-ScriptCapture -ScriptPath $preflightPath
Write-Host $preflightRes.Output
Assert-True ($preflightRes.ExitCode -eq 0) "cf-preflight.ps1 exited with $($preflightRes.ExitCode)"
Assert-True ($preflightRes.Output -match "\[PASS\] cf CLI:") "cf-preflight.ps1 did not report cf CLI PASS"
Assert-True ($preflightRes.Output -match "\[PASS\] Zone Read") "cf-preflight.ps1 did not report Zone Read PASS"
Write-Host "[PASS] cf-preflight.ps1 completed with exit 0"

$addScriptPath = Join-Path $ScriptsDir "add-mail-domain.ps1"

Write-Host ""
Write-Host "=== 3. Active Zone -DryRun (quanghuylee.cyou) ==="
$activeRes = Invoke-ScriptCapture -ScriptPath $addScriptPath -Arguments @(
  "-Domain", "quanghuylee.cyou",
  "-Provider", "resend",
  "-Scenario", "Cloudflare",
  "-ProvisionCloudflare",
  "-VerifyPublicDns",
  "-DryRun"
)
Write-Host $activeRes.Output
Assert-True ($activeRes.ExitCode -eq 0) "add-mail-domain.ps1 -DryRun on quanghuylee.cyou exited with $($activeRes.ExitCode)"
Assert-True ($activeRes.Output -match "\[DRY-RUN\] Would update") "Active zone run missing [DRY-RUN] wrangler.jsonc guard"
Assert-True ($activeRes.Output -match "Zone: quanghuylee\.cyou") "Active zone run did not resolve quanghuylee.cyou"
Assert-True ($activeRes.Output -match "Email Routing catch-all already enabled -> agentic-inbox") "Active zone run did not detect catch-all -> agentic-inbox"
Assert-True ($activeRes.Output -match "DNS OK \(TXT _dmarc\.quanghuylee\.cyou\)") "Active zone run did not verify _dmarc TXT"
Assert-True ($activeRes.Output -match "Public DNS Verification") "Active zone run did not execute -VerifyPublicDns"
Assert-True ($activeRes.Output -match "\[DNS\] SPF \(quanghuylee\.cyou\): .*v=spf1") "Active zone run did not resolve public SPF record"
Assert-True ($activeRes.Output -match "\[DNS\] DMARC \(_dmarc\.quanghuylee\.cyou\): .*v=DMARC1") "Active zone run did not resolve public DMARC record"
Write-Host "[PASS] Active zone dry-run verified"

Write-Host ""
Write-Host "=== 4. New PSL Subdomain Zone -DryRun (goluf.loc.cc) ==="
$newRes = Invoke-ScriptCapture -ScriptPath $addScriptPath -Arguments @(
  "-Domain", "goluf.loc.cc",
  "-Provider", "resend",
  "-Scenario", "Cloudflare",
  "-ProvisionCloudflare",
  "-CreateZoneIfMissing",
  "-ProvisionResend",
  "-VerifyPublicDns",
  "-DryRun"
)
Write-Host $newRes.Output
Assert-True ($newRes.ExitCode -eq 0) "add-mail-domain.ps1 -DryRun on goluf.loc.cc exited with $($newRes.ExitCode)"
Assert-True ($newRes.Output -match "\[DRY-RUN\] Would update") "New zone run missing [DRY-RUN] wrangler.jsonc guard"
Assert-True ($newRes.Output -match "cf zones create --name goluf\.loc\.cc --type full --dry-run") "New zone run did not invoke cf zones create --dry-run"
Assert-True ($newRes.Output -match "Assigned Cloudflare NS:") "New zone run did not print Assigned Cloudflare NS"
Assert-True ($newRes.Output -match "cf email-routing rules catch-all update .*--dry-run") "New zone run did not invoke catch-all update --dry-run"
Assert-True ($newRes.Output -match "_dmarc\.goluf\.loc\.cc") "New zone run did not plan _dmarc.goluf.loc.cc TXT"
Assert-True ($newRes.Output -match "Public DNS Verification") "New zone run did not execute -VerifyPublicDns"
Write-Host "[PASS] New PSL subdomain zone dry-run verified"

Write-Host ""
Write-Host "=== 5. FastDeploy & VerifyInbound -DryRun (quanghuylee.cyou) ==="
$fastRes = Invoke-ScriptCapture -ScriptPath $addScriptPath -Arguments @(
  "-Domain", "quanghuylee.cyou",
  "-Provider", "resend",
  "-Scenario", "Cloudflare",
  "-FastDeploy",
  "-VerifyInbound",
  "-DryRun"
)
Write-Host $fastRes.Output
Assert-True ($fastRes.ExitCode -eq 0) "add-mail-domain.ps1 -FastDeploy -VerifyInbound -DryRun exited with $($fastRes.ExitCode)"
Assert-True ($fastRes.Output -match "\[DRY-RUN\] (\[FastDeploy\] Would sync build/server/wrangler\.json|Would run: npm run typecheck)") "FastDeploy dry-run missing deploy plan output"
Assert-True ($fastRes.Output -match "\[DRY-RUN\] Would send real inbound verification email to hello@quanghuylee\.cyou") "VerifyInbound dry-run missing expected message"
Write-Host "[PASS] FastDeploy + VerifyInbound dry-run verified"

Write-Host ""
Write-Host "=== 6. Verify wrangler.jsonc & build/server/wrangler.json Unchanged ==="
$wranglerAfter = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash
Assert-True ($wranglerBefore -eq $wranglerAfter) "wrangler.jsonc was modified during dry-run tests! Before=$wranglerBefore After=$wranglerAfter"
Write-Host ("[PASS] wrangler.jsonc SHA-256 unchanged: {0}" -f $wranglerAfter)
if ($null -ne $buildWranglerBefore) {
  $buildWranglerAfter = (Get-FileHash -LiteralPath $buildWranglerPath -Algorithm SHA256).Hash
  Assert-True ($buildWranglerBefore -eq $buildWranglerAfter) "build/server/wrangler.json was modified during dry-run tests!"
  Write-Host ("[PASS] build/server/wrangler.json SHA-256 unchanged: {0}" -f $buildWranglerAfter)
}

Write-Host ""
Write-Host "ALL DOMAIN AUTOMATION TESTS PASSED."
exit 0
