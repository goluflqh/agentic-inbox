param(
  [string]$Zone,
  [switch]$Strict
)

$ErrorActionPreference = "Stop"

$script:PassCount = 0
$script:WarnCount = 0
$script:FailCount = 0
$script:Findings = New-Object System.Collections.Generic.List[string]

function Write-Check {
  param(
    [ValidateSet("PASS", "WARN", "FAIL", "INFO")]
    [string]$Status,
    [string]$Label,
    [string]$Detail
  )

  switch ($Status) {
    "PASS" { $script:PassCount++ }
    "WARN" {
      $script:WarnCount++
      $script:Findings.Add("WARN: $Label - $Detail")
    }
    "FAIL" {
      $script:FailCount++
      $script:Findings.Add("FAIL: $Label - $Detail")
    }
  }

  Write-Host ("[{0}] {1}: {2}" -f $Status, $Label, $Detail)
}

function Invoke-NativeCapture {
  param(
    [string]$Command,
    [string[]]$Arguments
  )

  $errFile = [System.IO.Path]::GetTempFileName()
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $stdoutLines = & $Command @Arguments 2>$errFile
    $exitCode = $LASTEXITCODE
    $stderrRaw = Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue
    if ($null -eq $stderrRaw) { $stderrRaw = "" }
    $stdoutRaw = if ($null -eq $stdoutLines) { "" } else { ($stdoutLines -join "`n").Trim() }
    return [pscustomobject]@{
      ExitCode = $exitCode
      StdOut   = $stdoutRaw
      StdErr   = $stderrRaw.Trim()
    }
  } finally {
    $ErrorActionPreference = $prevPref
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
  }
}

function Format-CfError {
  param([string]$StdErr, [string]$StdOut)

  $combined = ($StdErr + "`n" + $StdOut) -split "`r?`n" |
    ForEach-Object { $_.Trim() } |
    Where-Object {
      $_ -and
      $_ -notmatch "^node\.exe\s*:" -and
      $_ -notmatch "^At\s+" -and
      $_ -notmatch "^\+\s+" -and
      $_ -notmatch "^CategoryInfo" -and
      $_ -notmatch "^FullyQualifiedErrorId"
    }

  $interesting = @($combined | Where-Object { $_ -match "(\[\d+\]|403|401|Forbidden|Unauthorized|Authentication|APIError|Check your API token)" })
  if ($interesting.Count -gt 0) {
    return ($interesting -join " | ")
  }
  if ($combined.Count -gt 0) {
    return (($combined | Select-Object -First 3) -join " | ")
  }
  return "Unknown error"
}

function Get-EnvPresence {
  param([string]$Name)

  $procSet = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name, "Process"))
  $userSet = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name, "User"))
  $machSet = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name, "Machine"))

  $scopes = New-Object System.Collections.Generic.List[string]
  if ($procSet) { $scopes.Add("Process") }
  if ($userSet) { $scopes.Add("User") }
  if ($machSet) { $scopes.Add("Machine") }

  return [pscustomobject]@{
    IsSet  = ($procSet -or $userSet -or $machSet)
    Scopes = $scopes
  }
}

function ConvertTo-RecordArray($Value) {
  if ($null -eq $Value) { return @() }
  if ($Value -is [System.Array]) {
    return @($Value | Where-Object { $null -ne $_ })
  }
  return @($Value)
}

Write-Host "=== Cloudflare & Mail Domain Preflight (Read-Only) ==="

# 1. Check cf CLI
$cfCmd = Get-Command cf -ErrorAction SilentlyContinue
if (-not $cfCmd) {
  Write-Check -Status "FAIL" -Label "cf CLI" -Detail "Not installed. Install with: npm install -g cf"
} else {
  $cfVer = Invoke-NativeCapture -Command "cf" -Arguments @("--version")
  if ($cfVer.ExitCode -eq 0 -and $cfVer.StdOut) {
    Write-Check -Status "PASS" -Label "cf CLI" -Detail "v$($cfVer.StdOut)"
  } else {
    Write-Check -Status "WARN" -Label "cf CLI" -Detail "Found at $($cfCmd.Source) (version check exited $($cfVer.ExitCode))"
  }
}

# 2. Check npx wrangler
$npxCmd = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npxCmd) {
  Write-Check -Status "FAIL" -Label "npx wrangler" -Detail "'npx' not found in PATH"
} else {
  $wrVer = Invoke-NativeCapture -Command "npx" -Arguments @("wrangler", "--version")
  if ($wrVer.ExitCode -eq 0 -and $wrVer.StdOut) {
    Write-Check -Status "PASS" -Label "npx wrangler" -Detail $wrVer.StdOut
  } else {
    Write-Check -Status "FAIL" -Label "npx wrangler" -Detail "Failed to run 'npx wrangler --version' (exit $($wrVer.ExitCode))"
  }
}

# 3. Check environment variable presence (NEVER print secret/token values)
$resendEnv = Get-EnvPresence -Name "RESEND_API_KEY"
if ($resendEnv.IsSet) {
  Write-Check -Status "PASS" -Label "RESEND_API_KEY" -Detail ("Present (scopes: {0})" -f ($resendEnv.Scopes -join ", "))
} else {
  Write-Check -Status "WARN" -Label "RESEND_API_KEY" -Detail "Not set in Process/User/Machine env (required for -ProvisionResend)"
}

$cfTokenEnv = Get-EnvPresence -Name "CLOUDFLARE_API_TOKEN"
if ($cfTokenEnv.IsSet) {
  Write-Check -Status "WARN" -Label "CLOUDFLARE_API_TOKEN" -Detail ("Present (scopes: {0}); env var overrides 'cf auth login' OAuth profile" -f ($cfTokenEnv.Scopes -join ", "))
} else {
  Write-Check -Status "INFO" -Label "CLOUDFLARE_API_TOKEN" -Detail "Not set; cf CLI will use 'cf auth login' profile if configured"
}

if (-not $cfCmd) {
  Write-Host ""
  Write-Host ("Summary: {0} PASS, {1} WARN, {2} FAIL" -f $script:PassCount, $script:WarnCount, $script:FailCount)
  exit 1
}

# 4. Auth source (cf auth whoami)
$whoRes = Invoke-NativeCapture -Command "cf" -Arguments @("auth", "whoami")
$who = $null
if ($whoRes.ExitCode -eq 0 -and $whoRes.StdOut) {
  try {
    $who = $whoRes.StdOut | ConvertFrom-Json
  } catch {
    $who = $null
  }
}

if (-not $who -or -not $who.authenticated) {
  Write-Check -Status "FAIL" -Label "cf auth whoami" -Detail ("Not authenticated ({0})" -f (Format-CfError -StdErr $whoRes.StdErr -StdOut $whoRes.StdOut))
  Write-Host ""
  Write-Host ("Summary: {0} PASS, {1} WARN, {2} FAIL" -f $script:PassCount, $script:WarnCount, $script:FailCount)
  exit 1
}

$accountSummary = if ($who.accounts) {
  (@($who.accounts | ForEach-Object { "$($_.name) [$($_.id)]" }) -join ", ")
} else {
  "(none)"
}
Write-Check -Status "PASS" -Label "cf auth whoami" -Detail ("authenticated={0}; tokenValid={1}; authSource={2}; accounts={3}" -f $who.authenticated, $who.tokenValid, $who.authSource, $accountSummary)

if ($who.profile -and $who.profile.overridden) {
  Write-Check -Status "WARN" -Label "Auth Override" -Detail "CLOUDFLARE_API_TOKEN overrides stored cf auth profile '$($who.profile.name)' (clear env var or use a scoped token to rely on OAuth login)"
}

$authListRes = Invoke-NativeCapture -Command "cf" -Arguments @("auth", "list")
if ($authListRes.ExitCode -eq 0 -and $authListRes.StdOut) {
  try {
    $profiles = ConvertTo-RecordArray ($authListRes.StdOut | ConvertFrom-Json)
    Write-Check -Status "INFO" -Label "cf auth profiles" -Detail ("{0} stored OAuth profile(s)" -f $profiles.Count)
  } catch {
    Write-Check -Status "INFO" -Label "cf auth profiles" -Detail "Unable to parse 'cf auth list' output"
  }
}

if ($cfTokenEnv.IsSet) {
  $verifyRes = Invoke-NativeCapture -Command "cf" -Arguments @("user", "tokens", "verify")
  if ($verifyRes.ExitCode -eq 0 -and $verifyRes.StdOut) {
    try {
      $tv = $verifyRes.StdOut | ConvertFrom-Json
      Write-Check -Status "PASS" -Label "Token Verify" -Detail ("Token status={0}" -f $tv.status)
    } catch {
      Write-Check -Status "PASS" -Label "Token Verify" -Detail "Token verified"
    }
  } else {
    Write-Check -Status "WARN" -Label "Token Verify" -Detail (Format-CfError -StdErr $verifyRes.StdErr -StdOut $verifyRes.StdOut)
  }
}

# 5. Accessible zones
$zonesRes = Invoke-NativeCapture -Command "cf" -Arguments @("zones", "list")
$zones = @()
if ($zonesRes.ExitCode -eq 0 -and $zonesRes.StdOut) {
  try {
    $zones = ConvertTo-RecordArray ($zonesRes.StdOut | ConvertFrom-Json)
    Write-Check -Status "PASS" -Label "Zone Read (zones.list)" -Detail ("Accessible zones: {0}" -f $zones.Count)
    foreach ($z in $zones) {
      $ns = if ($z.name_servers) { ($z.name_servers -join ", ") } else { "(none)" }
      Write-Host ("       - {0} (id={1}, status={2}, ns=[{3}])" -f $z.name, $z.id, $z.status, $ns)
    }
  } catch {
    Write-Check -Status "FAIL" -Label "Zone Read (zones.list)" -Detail "Failed to parse JSON output"
  }
} else {
  Write-Check -Status "FAIL" -Label "Zone Read (zones.list)" -Detail (Format-CfError -StdErr $zonesRes.StdErr -StdOut $zonesRes.StdOut)
}

# Pick probe zone (requested -Zone, or first active zone, or first accessible zone)
$probeZone = $null
if ($Zone) {
  $normZone = $Zone.Trim().ToLowerInvariant()
  $probeZone = $zones | Where-Object { $_.name -eq $normZone -or $_.id -eq $Zone.Trim() } | Select-Object -First 1
  if (-not $probeZone) {
    Write-Check -Status "WARN" -Label "Target Zone" -Detail "Requested zone '$Zone' not found in accessible zones; skipping zone-scoped capability checks"
  }
} else {
  $probeZone = $zones | Where-Object { $_.status -eq "active" } | Select-Object -First 1
  if (-not $probeZone) {
    $probeZone = $zones | Select-Object -First 1
  }
}

# 6. Exact capability checks (all read-only)
if ($probeZone) {
  Write-Host ("Using probe zone: {0} ({1})" -f $probeZone.name, $probeZone.id)
  $perms = @()
  if ($probeZone.permissions) { $perms = @($probeZone.permissions) }

  if ($perms -contains "#zone:edit") {
    Write-Check -Status "PASS" -Label "Zone Edit (zone.create)" -Detail "Zone permission '#zone:edit' present"
  } else {
    Write-Check -Status "WARN" -Label "Zone Edit (zone.create)" -Detail "Missing '#zone:edit' in zone permissions (required for 'cf zones create' / -CreateZoneIfMissing)"
  }

  # DNS Read & Edit permission check
  $dnsRes = Invoke-NativeCapture -Command "cf" -Arguments @("dns", "records", "list", "--zone", $probeZone.id, "--per-page", "1")
  if ($dnsRes.ExitCode -eq 0 -and $dnsRes.StdOut) {
    try {
      $dnsRecords = ConvertTo-RecordArray ($dnsRes.StdOut | ConvertFrom-Json)
      $dnsEditNote = if ($perms -contains "#dns_records:edit") { "DNS:Edit present" } else { "DNS:Edit missing in zone permissions" }
      Write-Check -Status "PASS" -Label "DNS Read (dns.records.list)" -Detail ("Readable on {0} (sample={1}; {2})" -f $probeZone.name, @($dnsRecords).Count, $dnsEditNote)
    } catch {
      Write-Check -Status "FAIL" -Label "DNS Read (dns.records.list)" -Detail "Failed to parse JSON output (check stdout/stderr separation)"
    }
  } else {
    Write-Check -Status "FAIL" -Label "DNS Read (dns.records.list)" -Detail (Format-CfError -StdErr $dnsRes.StdErr -StdOut $dnsRes.StdOut)
  }

  # Email Routing Rules Read
  $erRulesRes = Invoke-NativeCapture -Command "cf" -Arguments @("email-routing", "rules", "catch-all", "get", "--zone", $probeZone.id)
  if ($erRulesRes.ExitCode -eq 0 -and $erRulesRes.StdOut) {
    try {
      $ca = $erRulesRes.StdOut | ConvertFrom-Json
      Write-Check -Status "PASS" -Label "Email Routing Rules Read" -Detail ("catch-all enabled={0} on {1}" -f $ca.enabled, $probeZone.name)
    } catch {
      Write-Check -Status "PASS" -Label "Email Routing Rules Read" -Detail ("Readable on {0}" -f $probeZone.name)
    }
  } else {
    Write-Check -Status "WARN" -Label "Email Routing Rules Read" -Detail (Format-CfError -StdErr $erRulesRes.StdErr -StdOut $erRulesRes.StdOut)
  }

  # Email Routing Settings Read
  $erSettingsRes = Invoke-NativeCapture -Command "cf" -Arguments @("email-routing", "settings", "get", "--zone", $probeZone.id)
  if ($erSettingsRes.ExitCode -eq 0) {
    Write-Check -Status "PASS" -Label "Email Routing Settings Read" -Detail ("Readable on {0}" -f $probeZone.name)
  } else {
    Write-Check -Status "WARN" -Label "Email Routing Settings Read" -Detail ("Blocked ({0}) - lacks Email Routing Settings:Read" -f (Format-CfError -StdErr $erSettingsRes.StdErr -StdOut $erSettingsRes.StdOut))
  }
} else {
  Write-Check -Status "WARN" -Label "Zone Capabilities" -Detail "No accessible zone available to probe DNS and Email Routing permissions"
}

# Workers Read
$workersRes = Invoke-NativeCapture -Command "cf" -Arguments @("workers", "list")
if ($workersRes.ExitCode -eq 0) {
  Write-Check -Status "PASS" -Label "Workers Read (workers.list)" -Detail "Account Workers readable"
} else {
  Write-Check -Status "WARN" -Label "Workers Read (workers.list)" -Detail ("Blocked ({0}) - lacks Workers Scripts:Read/Edit" -f (Format-CfError -StdErr $workersRes.StdErr -StdOut $workersRes.StdOut))
}

# User Details Read
$userRes = Invoke-NativeCapture -Command "cf" -Arguments @("user", "get")
if ($userRes.ExitCode -eq 0) {
  Write-Check -Status "PASS" -Label "User Details Read (user.get)" -Detail "User details readable"
} else {
  Write-Check -Status "WARN" -Label "User Details Read (user.get)" -Detail ("Blocked ({0}) - lacks User Details:Read" -f (Format-CfError -StdErr $userRes.StdErr -StdOut $userRes.StdOut))
}

# Wrangler whoami check (non-mutating)
if ($npxCmd) {
  $wWho = Invoke-NativeCapture -Command "npx" -Arguments @("wrangler", "whoami")
  $wCombined = ($wWho.StdOut + "`n" + $wWho.StdErr)
  if ($wWho.ExitCode -eq 0) {
    if ($wCombined -match "User Details->Read") {
      Write-Check -Status "WARN" -Label "npx wrangler whoami" -Detail "Authenticated via CLOUDFLARE_API_TOKEN, missing User->User Details->Read"
    } else {
      Write-Check -Status "PASS" -Label "npx wrangler whoami" -Detail "Authenticated"
    }
  } else {
    Write-Check -Status "WARN" -Label "npx wrangler whoami" -Detail "Exited $($wWho.ExitCode)"
  }
}

Write-Host ""
Write-Host ("Preflight summary: {0} PASS, {1} WARN, {2} FAIL" -f $script:PassCount, $script:WarnCount, $script:FailCount)
if ($script:Findings.Count -gt 0) {
  Write-Host "Findings / Missing Scopes:"
  foreach ($f in $script:Findings) {
    Write-Host ("  - {0}" -f $f)
  }
}

if ($script:FailCount -gt 0) {
  exit 1
}
if ($Strict -and $script:WarnCount -gt 0) {
  exit 1
}
exit 0
