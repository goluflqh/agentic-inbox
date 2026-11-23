param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Domain,

  [ValidatePattern("^(resend(\d+)?|smtp2go|brevo|cloudflare)$")]
  [string]$Provider = "resend",

  [ValidateSet("Cloudflare", "Registrar")]
  [string]$Scenario = "Cloudflare",

  [switch]$ProvisionCloudflare,
  [switch]$CreateZoneIfMissing,
  [switch]$WaitForActive,
  [int]$WaitTimeoutSeconds = 300,
  [int]$PollIntervalSeconds = 8,
  [switch]$ProvisionResend,
  [switch]$VerifyPublicDns,
  [switch]$VerifyInbound,
  [string]$VerifyInboundTo = "",
  [switch]$Deploy,
  [switch]$FastDeploy,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root "wrangler.jsonc"
$RunbookPath = Join-Path $Root "docs\MAIL_DOMAIN_ONBOARDING.md"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$WorkerName = "agentic-inbox"

function Invoke-Step([string]$Command, [string[]]$Arguments) {
  Write-Host "> $Command $($Arguments -join ' ')"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $Command $($Arguments -join ' ')"
  }
}

function Invoke-CfJson([string[]]$Arguments, [switch]$AllowFailure, [switch]$Mutating) {
  $cmdArgs = @($Arguments)
  if ($Mutating -and $DryRun -and ($cmdArgs -notcontains "--dry-run")) {
    $cmdArgs += "--dry-run"
  }
  Write-Host "> cf $($cmdArgs -join ' ')"
  # Capture stdout only; cf writes pagination metadata ('result_info:') to stderr.
  $lines = & cf @cmdArgs
  $exitCode = $LASTEXITCODE
  $raw = if ($null -eq $lines) { "" } else { ($lines -join "`n").Trim() }
  if ($exitCode -ne 0) {
    if ($AllowFailure) { return $null }
    throw "cf command failed (exit $exitCode): cf $($cmdArgs -join ' ')"
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return ($raw | ConvertFrom-Json)
}

function ConvertTo-RecordArray($Value) {
  if ($null -eq $Value) { return @() }
  if ($Value -is [System.Array]) {
    return @($Value | Where-Object { $null -ne $_ })
  }
  return @($Value)
}

function New-TempJsonFile([string]$JsonContent) {
  $path = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($path, $JsonContent, $Utf8NoBom)
  return $path
}

function Get-ConfigValue([string]$Config, [string]$Name) {
  $match = [regex]::Match($Config, '"' + [regex]::Escape($Name) + '"\s*:\s*"([^"]*)"')
  if (-not $match.Success) {
    throw "Could not find $Name in $ConfigPath"
  }
  return $match
}

function Set-ConfigValue([string]$Config, $Match, [string]$Value) {
  return $Config.Substring(0, $Match.Groups[1].Index) +
    $Value +
    $Config.Substring($Match.Groups[1].Index + $Match.Groups[1].Length)
}

function Assert-CfReady() {
  if (-not (Get-Command cf -ErrorAction SilentlyContinue)) {
    throw "Cloudflare CLI ('cf') is not installed. Run: npm install -g cf"
  }
  $who = Invoke-CfJson @("auth", "whoami") -AllowFailure
  if ($who -and $who.authenticated) {
    Write-Host "Authenticated via: $($who.authSource)"
    if ($who.profile -and $who.profile.overridden) {
      Write-Warning "CLOUDFLARE_API_TOKEN env var overrides 'cf auth login' profile '$($who.profile.name)'."
    }
    return
  }
  if ($DryRun) {
    Write-Warning "cf is not authenticated; continuing in -DryRun mode where local/synthetic dry-run steps permit."
    return
  }
  throw "cf is not authenticated. Set CLOUDFLARE_API_TOKEN or run 'cf auth login'."
}

function Find-ParentZoneInAccount([string]$DomainName) {
  $labels = $DomainName.Split(".")
  for ($i = 1; $i -le ($labels.Count - 2); $i++) {
    $candidate = ($labels[$i..($labels.Count - 1)] -join ".")
    $allMatches = ConvertTo-RecordArray (Invoke-CfJson @("zones", "list", "--name", $candidate) -AllowFailure)
    $matches = @($allMatches | Where-Object { $_.name -eq $candidate })
    if ($matches.Count -gt 0) {
      return $matches[0]
    }
  }
  return $null
}

function Resolve-OrCreateZone([string]$ZoneName) {
  $allZones = ConvertTo-RecordArray (Invoke-CfJson @("zones", "list", "--name", $ZoneName))
  $zones = @($allZones | Where-Object { $_.name -eq $ZoneName })
  $zone = $zones | Select-Object -First 1
  if ($zone) {
    return $zone
  }
  if (-not $CreateZoneIfMissing) {
    $parentZone = Find-ParentZoneInAccount $ZoneName
    if ($parentZone) {
      throw "Zone '$ZoneName' was not found as its own Cloudflare zone, though parent zone '$($parentZone.name)' exists. For PSL subdomains (e.g. goluf.loc.cc) or standalone zones, re-run with -CreateZoneIfMissing."
    }
    throw "Cloudflare zone '$ZoneName' not found. Re-run with -CreateZoneIfMissing (requires Zone:Edit token permission) or add it in Cloudflare Dashboard first."
  }
  Write-Host "Zone '$ZoneName' not found. Creating full zone (supports apex domains and PSL subdomains)..."
  if ($DryRun) {
    Invoke-CfJson @("zones", "create", "--name", $ZoneName, "--type", "full") -Mutating | Out-Null
    return [pscustomobject]@{
      id           = "<DRY_RUN_ZONE_ID>"
      name         = $ZoneName
      status       = "pending"
      name_servers = @("<cf-ns-1>", "<cf-ns-2>")
    }
  }
  $created = Invoke-CfJson @("zones", "create", "--name", $ZoneName, "--type", "full") -Mutating
  if (-not $created) {
    throw "Failed to create Cloudflare zone '$ZoneName'."
  }
  return $created
}

function Ensure-DnsRecord([string]$ZoneId, [string]$Type, [string]$Name, [string]$Content, [int]$Priority = -1, $ExistingRecords) {
  $normContent = $Content.Trim().Trim('"')
  $found = $ExistingRecords | Where-Object {
    $null -ne $_ -and
    $_.type -eq $Type -and
    $_.name -eq $Name -and
    ($_.content.Trim().Trim('"') -eq $normContent)
  } | Select-Object -First 1
  if ($found) {
    Write-Host "DNS OK ($Type $Name)"
    return
  }

  $payload = [ordered]@{
    type    = $Type
    name    = $Name
    content = $Content
    ttl     = 1
  }
  if ($Type -in @("A", "AAAA", "CNAME")) {
    $payload["proxied"] = $false
  }
  if ($Priority -ge 0) {
    $payload["priority"] = $Priority
  }

  $tmp = New-TempJsonFile ($payload | ConvertTo-Json -Compress)
  try {
    Invoke-CfJson @("dns", "records", "create", "--zone", $ZoneId, "--body", "@$tmp") -Mutating | Out-Null
    if ($DryRun) {
      Write-Host "[DRY-RUN] Would create DNS ($Type $Name)"
    } else {
      Write-Host "DNS created ($Type $Name)"
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Provision-CloudflareDomain([string]$ZoneName) {
  Assert-CfReady
  $zone = Resolve-OrCreateZone $ZoneName
  $zoneId = $zone.id
  $nsList = if ($zone.name_servers) { ($zone.name_servers -join ", ") } else { "(unknown)" }
  Write-Host "Zone: $ZoneName (id=$zoneId, status=$($zone.status))"
  Write-Host "Assigned Cloudflare NS: [$nsList]"

  if ($zone.status -ne "active" -and $WaitForActive -and -not $DryRun) {
    $pollSec = [Math]::Max(5, $PollIntervalSeconds)
    Invoke-CfJson @("zones", "activation-check", "activate", "--zone", $zoneId) -AllowFailure -Mutating | Out-Null
    $startedAt = Get-Date
    $lastCheckAt = $startedAt
    $deadline = $startedAt.AddSeconds($WaitTimeoutSeconds)
    while ($zone.status -ne "active" -and (Get-Date) -lt $deadline) {
      $elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
      Write-Host ("Waiting {0}s for Cloudflare zone '{1}' to become active (elapsed={2}s)..." -f $pollSec, $ZoneName, $elapsed)
      Start-Sleep -Seconds $pollSec
      if (((Get-Date) - $lastCheckAt).TotalSeconds -ge 45) {
        Invoke-CfJson @("zones", "activation-check", "activate", "--zone", $zoneId) -AllowFailure -Mutating | Out-Null
        $lastCheckAt = Get-Date
      }
      $refreshed = ConvertTo-RecordArray (Invoke-CfJson @("zones", "list", "--name", $ZoneName) -AllowFailure)
      $foundZone = @($refreshed | Where-Object { $_.name -eq $ZoneName }) | Select-Object -First 1
      if ($foundZone) { $zone = $foundZone }
    }
    Write-Host "Zone status after wait: $($zone.status)"
  }

  $records = if ($DryRun -and $zoneId -eq "<DRY_RUN_ZONE_ID>") {
    @()
  } else {
    ConvertTo-RecordArray (Invoke-CfJson @("dns", "records", "list", "--zone", $ZoneId, "--per-page", "100"))
  }

  $websiteRecords = @($records | Where-Object {
    $_.type -in @("A", "AAAA", "CNAME") -and ($_.name -eq $ZoneName -or $_.name -eq "www.$ZoneName")
  })
  if ($websiteRecords.Count -gt 0) {
    $webSummary = ($websiteRecords | ForEach-Object { "$($_.type) $($_.name)->$($_.content)" }) -join "; "
    Write-Host "Preserving existing website records: $webSummary"
  }

  $unrelatedMx = @($records | Where-Object {
    $_.type -eq "MX" -and $_.name -eq $ZoneName -and ($_.content -notmatch "mx\.cloudflare\.net$")
  })
  $existingRootSpf = @($records | Where-Object {
    $_.type -eq "TXT" -and $_.name -eq $ZoneName -and $_.content -match "v=spf1"
  })

  if ($unrelatedMx.Count -gt 0) {
    Write-Warning "Found existing non-Cloudflare MX at apex ($($unrelatedMx.content -join ', ')). Preserving apex MX and skipping automatic Email Routing enable."
  } elseif ($zone.status -ne "active" -and -not $DryRun) {
    Write-Warning "Zone '$ZoneName' is '$($zone.status)'. Point registrar NS to [$nsList] first, wait for Active status, then re-run to enable Email Routing and catch-all."
  } else {
    if ($zone.status -ne "active" -and $DryRun) {
      Write-Host "[DRY-RUN] Note: zone is '$($zone.status)'; point registrar NS to [$nsList] before live Email Routing activation."
    }
    if ($existingRootSpf.Count -gt 0 -and ($existingRootSpf.content -notmatch "_spf\.mx\.cloudflare\.net")) {
      Write-Warning "Existing apex SPF found: $($existingRootSpf.content -join ', '). Preserving existing SPF; verify SPF merge manually instead of adding a second SPF record."
    }

    $hasCfMx = @($records | Where-Object {
      $_.type -eq "MX" -and $_.name -eq $ZoneName -and ($_.content -match "mx\.cloudflare\.net$")
    }).Count -gt 0

    $catchAll = if ($DryRun -and $zoneId -eq "<DRY_RUN_ZONE_ID>") {
      $null
    } else {
      Invoke-CfJson @("email-routing", "rules", "catch-all", "get", "--zone", $ZoneId) -AllowFailure
    }

    if (-not $hasCfMx -or $DryRun) {
      # Apex zones reject --name in cf email-routing enable ([2007]); try zone-only first, then --name for subdomains.
      $enabledResp = Invoke-CfJson @("email-routing", "enable", "--zone", $ZoneId) -AllowFailure -Mutating
      if (-not $enabledResp -and -not $DryRun) {
        Invoke-CfJson @("email-routing", "enable", "--zone", $ZoneId, "--name", $ZoneName) -AllowFailure -Mutating | Out-Null
      }
    }

    $alreadyRouted = $false
    if ($catchAll -and $catchAll.enabled -and $catchAll.actions) {
      $workerAction = $catchAll.actions | Where-Object { $_.type -eq "worker" -and ($_.value -contains $WorkerName) }
      if ($workerAction) { $alreadyRouted = $true }
    }

    if ($alreadyRouted) {
      Write-Host "Email Routing catch-all already enabled -> $WorkerName"
    } else {
      $tmpMatchers = New-TempJsonFile '[{"type":"all"}]'
      $tmpActions = New-TempJsonFile "[{`"type`":`"worker`",`"value`":[`"$WorkerName`"]}]"
      try {
        Invoke-CfJson @(
          "email-routing", "rules", "catch-all", "update",
          "--zone", $ZoneId,
          "--enabled",
          "--name", "Route all to $WorkerName",
          "--matchers", "@$tmpMatchers",
          "--actions", "@$tmpActions"
        ) -Mutating | Out-Null
        if ($DryRun) {
          Write-Host "[DRY-RUN] Would configure Email Routing catch-all -> $WorkerName"
        } else {
          Write-Host "Email Routing catch-all configured -> $WorkerName"
        }
      } finally {
        Remove-Item -LiteralPath $tmpMatchers, $tmpActions -Force -ErrorAction SilentlyContinue
      }
    }
  }

  $hasDmarc = @($records | Where-Object { $_.type -eq "TXT" -and $_.name -eq "_dmarc.$ZoneName" }).Count -gt 0
  if (-not $hasDmarc) {
    Ensure-DnsRecord -ZoneId $zoneId -Type "TXT" -Name "_dmarc.$ZoneName" -Content "v=DMARC1; p=none;" -ExistingRecords $records
  } else {
    Write-Host "DNS OK (TXT _dmarc.$ZoneName)"
  }

  return $zone
}

function Get-ResendSecretName([string]$ProviderName) {
  if ($ProviderName -match "^resend(\d+)$" -and [int]$Matches[1] -gt 1) {
    return "RESEND_API_KEY_$($Matches[1])"
  }
  return "RESEND_API_KEY"
}

function Provision-ResendDomain([string]$ZoneName, $Zone) {
  if ($Provider -notmatch "^resend(\d+)?$") {
    Write-Host "Skipping Resend provisioning because Provider is '$Provider'."
    return
  }
  $secretName = Get-ResendSecretName $Provider
  $apiKey = [Environment]::GetEnvironmentVariable($secretName)
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $apiKey = [Environment]::GetEnvironmentVariable($secretName, "User")
  }
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Warning "$secretName is not set in environment; skipping automated Resend API check/provisioning."
    return
  }
  $apiKey = ($apiKey -replace '[\r\n\s]+', '')

  if (-not $Zone -and -not $DryRun) {
    Assert-CfReady
    $allZones = ConvertTo-RecordArray (Invoke-CfJson @("zones", "list", "--name", $ZoneName) -AllowFailure)
    $Zone = @($allZones | Where-Object { $_.name -eq $ZoneName }) | Select-Object -First 1
  }

  $headers = @{
    Authorization  = "Bearer $apiKey"
    "Content-Type" = "application/json"
  }

  try {
    $listResp = Invoke-RestMethod -Method Get -Uri "https://api.resend.com/domains" -Headers $headers
  } catch {
    throw "Resend API check failed on GET /domains: $($_.Exception.Message)"
  }

  $resendDomain = $listResp.data | Where-Object { $_ -and $_.name -eq $ZoneName } | Select-Object -First 1

  if (-not $resendDomain) {
    if ($DryRun) {
      Write-Host "[DRY-RUN] Would create Resend domain '$ZoneName' via POST https://api.resend.com/domains"
      return
    }
    $body = (@{ name = $ZoneName } | ConvertTo-Json -Compress)
    $resendDomain = Invoke-RestMethod -Method Post -Uri "https://api.resend.com/domains" -Headers $headers -Body $body
    Write-Host "Created Resend domain '$ZoneName' (id=$($resendDomain.id))"
  }

  $detail = Invoke-RestMethod -Method Get -Uri "https://api.resend.com/domains/$($resendDomain.id)" -Headers $headers
  Write-Host "Resend domain status: $($detail.status)"

  if (-not $Zone) { return }
  $records = if ($DryRun -and $Zone.id -eq "<DRY_RUN_ZONE_ID>") {
    @()
  } else {
    ConvertTo-RecordArray (Invoke-CfJson @("dns", "records", "list", "--zone", $Zone.id, "--per-page", "100"))
  }

  foreach ($rec in $detail.records) {
    $recName = if ($null -eq $rec.name) { "" } else { $rec.name.Trim().TrimEnd(".").ToLowerInvariant() }
    $fqdn = if ($recName -eq "@" -or [string]::IsNullOrWhiteSpace($recName)) {
      $ZoneName
    } elseif ($recName.EndsWith(".$ZoneName") -or $recName -eq $ZoneName) {
      $recName
    } else {
      "$recName.$ZoneName"
    }

    if ($fqdn -eq $ZoneName -and $rec.type -in @("MX", "TXT")) {
      Write-Warning "Skipping apex $($rec.type) record from Resend ($fqdn) to protect Cloudflare Email Routing MX/SPF."
      continue
    }

    $prio = if ($null -ne $rec.priority) { [int]$rec.priority } else { -1 }
    Ensure-DnsRecord -ZoneId $Zone.id -Type $rec.type -Name $fqdn -Content $rec.value -Priority $prio -ExistingRecords $records
  }

  if (-not $DryRun -and $detail.status -ne "verified") {
    Invoke-RestMethod -Method Post -Uri "https://api.resend.com/domains/$($resendDomain.id)/verify" -Headers $headers | Out-Null
    Write-Host "Triggered Resend domain verification check."
  }
}

function Resolve-PublicDoh([string]$QueryName, [string]$RecordType, [int]$TypeCode) {
  $url = "https://cloudflare-dns.com/dns-query?name=$([uri]::EscapeDataString($QueryName))&type=$RecordType"
  try {
    $resp = Invoke-RestMethod -Method Get -Uri $url -Headers @{ Accept = "application/dns-json" } -TimeoutSec 8
    if ($resp -and $resp.Answer) {
      return @($resp.Answer | Where-Object { $_.type -eq $TypeCode } | ForEach-Object { [string]$_.data })
    }
    return @()
  } catch {
    try {
      $ggUrl = "https://dns.google/resolve?name=$([uri]::EscapeDataString($QueryName))&type=$RecordType"
      $resp = Invoke-RestMethod -Method Get -Uri $ggUrl -TimeoutSec 8
      if ($resp -and $resp.Answer) {
        return @($resp.Answer | Where-Object { $_.type -eq $TypeCode } | ForEach-Object { [string]$_.data })
      }
    } catch {}
    return @()
  }
}

function Verify-PublicDnsRecords([string]$ZoneName) {
  Write-Host ""
  Write-Host "=== Public DNS Verification (Cloudflare DoH 1.1.1.1) ==="

  $nsHosts = @(Resolve-PublicDoh -QueryName $ZoneName -RecordType "NS" -TypeCode 2 | ForEach-Object { $_.TrimEnd(".") })
  if ($nsHosts.Count -gt 0) {
    $isCfNs = (@($nsHosts | Where-Object { $_ -match "\.ns\.cloudflare\.com$" }).Count -gt 0)
    Write-Host ("[DNS] NS ({0}): {1} (cloudflare={2})" -f $ZoneName, ($nsHosts -join ", "), $isCfNs)
  } else {
    Write-Host ("[DNS] NS ({0}): (none resolved)" -f $ZoneName)
  }

  foreach ($hostName in @($ZoneName, "www.$ZoneName")) {
    $aVals = @(Resolve-PublicDoh -QueryName $hostName -RecordType "A" -TypeCode 1)
    $cnameVals = @(Resolve-PublicDoh -QueryName $hostName -RecordType "A" -TypeCode 5 | ForEach-Object { $_.TrimEnd(".") })
    $webVals = @($aVals + $cnameVals)
    $aaaaVals = @(Resolve-PublicDoh -QueryName $hostName -RecordType "AAAA" -TypeCode 28)
    if ($webVals.Count -gt 0 -or $aaaaVals.Count -gt 0) {
      Write-Host ("[DNS] Web ({0}): A/CNAME=[{1}] AAAA=[{2}]" -f $hostName, ($webVals -join ", "), ($aaaaVals -join ", "))
    } else {
      Write-Host ("[DNS] Web ({0}): (no A/AAAA/CNAME)" -f $hostName)
    }
  }

  $mxVals = @(Resolve-PublicDoh -QueryName $ZoneName -RecordType "MX" -TypeCode 15 | ForEach-Object { $_.TrimEnd(".") })
  if ($mxVals.Count -gt 0) {
    Write-Host ("[DNS] MX ({0}): {1}" -f $ZoneName, ($mxVals -join ", "))
  } else {
    Write-Host ("[DNS] MX ({0}): (none)" -f $ZoneName)
  }

  $txtVals = @(Resolve-PublicDoh -QueryName $ZoneName -RecordType "TXT" -TypeCode 16 | ForEach-Object { $_.Trim().Trim('"') })
  $spfStrings = @($txtVals | Where-Object { $_ -match "v=spf1" })
  if ($spfStrings.Count -gt 0) {
    Write-Host ("[DNS] SPF ({0}): {1}" -f $ZoneName, ($spfStrings -join " | "))
  } else {
    Write-Host ("[DNS] SPF ({0}): (none)" -f $ZoneName)
  }

  $dmarcVals = @(Resolve-PublicDoh -QueryName "_dmarc.$ZoneName" -RecordType "TXT" -TypeCode 16 | ForEach-Object { $_.Trim().Trim('"') })
  if ($dmarcVals.Count -gt 0) {
    Write-Host ("[DNS] DMARC (_dmarc.{0}): {1}" -f $ZoneName, ($dmarcVals -join " | "))
  } else {
    Write-Host ("[DNS] DMARC (_dmarc.{0}): (none)" -f $ZoneName)
  }
}

$normalizedDomain = $Domain.Trim().TrimStart("@").TrimEnd(".").ToLowerInvariant()
if ($normalizedDomain -notmatch "^(?=.{1,253}$)((?!-)[a-z0-9-]{1,63}(?<!-)\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$") {
  throw "Invalid domain: $Domain"
}

Set-Location $Root

$config = Get-Content -LiteralPath $ConfigPath -Raw
$domainsMatch = Get-ConfigValue $config "DOMAINS"
$domains = @(
  $domainsMatch.Groups[1].Value.Split(",") |
    ForEach-Object { $_.Trim().TrimStart("@").ToLowerInvariant() } |
    Where-Object { $_ }
)

if ($domains -notcontains $normalizedDomain) {
  $domains += $normalizedDomain
}
$config = Set-ConfigValue $config $domainsMatch ($domains -join ",")

$providerMatch = Get-ConfigValue $config "OUTBOUND_PROVIDER_BY_DOMAIN"
$providerRules = [ordered]@{}
foreach ($rule in $providerMatch.Groups[1].Value.Split(",")) {
  $parts = $rule.Split(":", 2)
  if ($parts.Count -eq 2 -and $parts[0].Trim()) {
    $providerRules[$parts[0].Trim().TrimStart("@").ToLowerInvariant()] = $parts[1].Trim().ToLowerInvariant()
  }
}
$providerRules[$normalizedDomain] = $Provider.ToLowerInvariant()
$providerValue = (($providerRules.GetEnumerator() | ForEach-Object { "$($_.Key):$($_.Value)" }) -join ",")

$providerMatch = Get-ConfigValue $config "OUTBOUND_PROVIDER_BY_DOMAIN"
$config = Set-ConfigValue $config $providerMatch $providerValue

if ($DryRun) {
  Write-Host "[DRY-RUN] Would update $ConfigPath"
  Write-Host "[DRY-RUN] DOMAINS: $($domains -join ',')"
  Write-Host "[DRY-RUN] OUTBOUND_PROVIDER_BY_DOMAIN: $providerValue"
}

Write-Host ""
Write-Host "Selected onboarding path: $Scenario"

if ($Scenario -eq "Registrar" -and -not $ProvisionCloudflare) {
  Write-Host "STOP GATE - before changing nameservers:"
  Write-Host "1. Snapshot A/AAAA/CNAME/MX/TXT/DKIM/DMARC/CAA/NS and registrar DNSSEC/DS."
  Write-Host "2. Copy required records into Cloudflare; keep the existing website DNS only."
  Write-Host "3. Compare both record sets and obtain explicit approval for the NS change."
  Write-Host "4. After cutover, verify public NS, origin DNS, and website HTTP status."
  Write-Host ""
}

$cfZone = $null
if ($ProvisionCloudflare) {
  Write-Host ""
  Write-Host "=== Cloudflare Automation (cf CLI) ==="
  $cfZone = Provision-CloudflareDomain -ZoneName $normalizedDomain
}

if (-not $DryRun) {
  [System.IO.File]::WriteAllText($ConfigPath, $config, $Utf8NoBom)
  Write-Host "Updated DOMAINS: $($domains -join ',')"
  Write-Host "Updated OUTBOUND_PROVIDER_BY_DOMAIN: $providerValue"
}

if ($ProvisionResend) {
  Write-Host ""
  Write-Host "=== Resend Automation ==="
  Provision-ResendDomain -ZoneName $normalizedDomain -Zone $cfZone
}

if ($VerifyPublicDns) {
  Verify-PublicDnsRecords -ZoneName $normalizedDomain
}

Write-Host ""
Write-Host "Cloudflare and inbox checklist:"
Write-Host "1. Confirm the Cloudflare zone is Active."
Write-Host "2. Enable Email Routing and preserve unrelated MX/SPF records."
Write-Host "3. Set catch-all to Worker $WorkerName and verify it is enabled."
Write-Host "4. Mirror both updated variables to the production Worker, then deploy."
Write-Host "5. Create the requested mailbox and run a real inbound test."
Write-Host "6. Verify $Provider for outbound; keep Resend Receiving disabled."
Write-Host "7. Run a real outbound test and inspect SPF, DKIM, and DMARC."
Write-Host ""
Write-Host "Runbook: $RunbookPath"

function Test-CanFastDeploy() {
  $buildWrangler = Join-Path $Root "build\server\wrangler.json"
  $buildEntry = Join-Path $Root "build\server\index.js"
  if (-not (Test-Path -LiteralPath $buildWrangler) -or -not (Test-Path -LiteralPath $buildEntry)) {
    Write-Host "[FastDeploy] Existing build/server artifacts not found; falling back to full build."
    return $false
  }

  $dirtySrc = & git -C $Root status --porcelain -- app workers 2>$null
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($dirtySrc -join ""))) {
    Write-Host "[FastDeploy] Uncommitted changes detected in app/ or workers/; falling back to full typecheck + build."
    return $false
  }

  $buildTime = (Get-Item -LiteralPath $buildEntry).LastWriteTimeUtc
  foreach ($dir in @("app", "workers")) {
    $fullDir = Join-Path $Root $dir
    if (-not (Test-Path -LiteralPath $fullDir)) { continue }
    $newer = Get-ChildItem -LiteralPath $fullDir -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTimeUtc -gt $buildTime } |
      Select-Object -First 1
    if ($newer) {
      Write-Host "[FastDeploy] Source file '$($newer.Name)' is newer than build/server/index.js; falling back to full build."
      return $false
    }
  }
  return $true
}

function Sync-BuildWranglerVars([string]$DomainsValue, [string]$ProviderValue) {
  $buildWrangler = Join-Path $Root "build\server\wrangler.json"
  $js = 'const fs = require("fs"); const p = process.argv[1]; const d = process.argv[2]; const m = process.argv[3]; const c = JSON.parse(fs.readFileSync(p, "utf8")); c.vars = c.vars || {}; c.vars.DOMAINS = d; c.vars.OUTBOUND_PROVIDER_BY_DOMAIN = m; fs.writeFileSync(p, JSON.stringify(c), "utf8");'
  Invoke-Step "node" @("-e", $js, $buildWrangler, $DomainsValue, $ProviderValue)
  Write-Host "[FastDeploy] Synced DOMAINS and OUTBOUND_PROVIDER_BY_DOMAIN into build/server/wrangler.json"
}

function Invoke-InboundVerification([string]$ZoneName) {
  $recipient = if ([string]::IsNullOrWhiteSpace($VerifyInboundTo)) { "hello@$ZoneName" } else { $VerifyInboundTo.Trim() }
  if ($DryRun) {
    Write-Host "[DRY-RUN] Would send real inbound verification email to $recipient via Resend and poll delivery status."
    return
  }

  $apiKey = [Environment]::GetEnvironmentVariable("RESEND_API_KEY_2")
  $fromAddr = "Agentic Inbox Verify <hello@routerllm.bond>"
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $apiKey = [Environment]::GetEnvironmentVariable("RESEND_API_KEY_2", "User")
  }
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $apiKey = [Environment]::GetEnvironmentVariable("RESEND_API_KEY")
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
      $apiKey = [Environment]::GetEnvironmentVariable("RESEND_API_KEY", "User")
    }
    $fromAddr = "Agentic Inbox Verify <hello@quanghuylee.cyou>"
  }
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Warning "No local RESEND_API_KEY_2 or RESEND_API_KEY found; skipping automated inbound verification."
    return
  }

  $headers = @{
    Authorization  = "Bearer $(($apiKey -replace '[\r\n\s]+', ''))"
    "Content-Type" = "application/json"
  }
  $payload = (@{
    from    = $fromAddr
    to      = @($recipient)
    subject = "Inbound verification for $ZoneName"
    text    = "Automated inbound routing check to $recipient via Cloudflare Email Routing -> $WorkerName."
  } | ConvertTo-Json -Compress)

  Write-Host ""
  Write-Host "=== Inbound Delivery Verification ($recipient) ==="
  $sent = Invoke-RestMethod -Method Post -Uri "https://api.resend.com/emails" -Headers $headers -Body $payload
  Write-Host "Sent inbound test email id=$($sent.id) -> $recipient"

  $lastEvent = "sent"
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 3
    $status = Invoke-RestMethod -Method Get -Uri "https://api.resend.com/emails/$($sent.id)" -Headers $headers
    $lastEvent = [string]$status.last_event
    if ($lastEvent -in @("delivered", "bounced", "complained")) {
      break
    }
  }
  Write-Host "Inbound test result: last_event=$lastEvent (recipient=$recipient)"
  if ($lastEvent -ne "delivered") {
    Write-Warning "Inbound email did not reach 'delivered' within 30s (last_event=$lastEvent). Inspect https://inbox.quanghuylee.cyou/mailbox/$recipient/emails/inbox"
  } else {
    Write-Host "Mailbox URL: https://inbox.quanghuylee.cyou/mailbox/$recipient/emails/inbox"
  }
}

if ($Deploy -or $FastDeploy) {
  $domainsJoined = ($domains -join ",")
  if ($FastDeploy -and (Test-CanFastDeploy)) {
    if ($DryRun) {
      Write-Host "[DRY-RUN] [FastDeploy] Would sync build/server/wrangler.json vars and run: npx wrangler deploy (~15s, skipping Vite rebuild)"
    } else {
      Write-Host ""
      Sync-BuildWranglerVars -DomainsValue $domainsJoined -ProviderValue $providerValue
      Invoke-Step "npx" @("wrangler", "deploy")
    }
  } else {
    if ($DryRun) {
      Write-Host "[DRY-RUN] Would run: npm run typecheck; npm run build; npx wrangler deploy"
    } else {
      Write-Host ""
      Invoke-Step "npm" @("run", "typecheck")
      Invoke-Step "npm" @("run", "build")
      Invoke-Step "npx" @("wrangler", "deploy")
    }
  }
}

if ($VerifyInbound) {
  Invoke-InboundVerification -ZoneName $normalizedDomain
}
