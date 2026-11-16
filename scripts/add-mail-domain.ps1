param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Domain,

  [ValidateSet("resend", "smtp2go", "brevo", "cloudflare")]
  [string]$Provider = "resend",

  [ValidateSet("Cloudflare", "Registrar")]
  [string]$Scenario = "Cloudflare",

  [switch]$ProvisionCloudflare,
  [switch]$CreateZoneIfMissing,
  [switch]$ProvisionResend,
  [switch]$VerifyPublicDns,
  [switch]$Deploy,
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

    $catchAll = if ($DryRun -and $zoneId -eq "<DRY_RUN_ZONE_ID>") {
      $null
    } else {
      Invoke-CfJson @("email-routing", "rules", "catch-all", "get", "--zone", $ZoneId) -AllowFailure
    }

    if (-not $catchAll -or $DryRun) {
      Invoke-CfJson @("email-routing", "enable", "--zone", $ZoneId, "--name", $ZoneName) -AllowFailure -Mutating | Out-Null
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

function Provision-ResendDomain([string]$ZoneName, $Zone) {
  if ($Provider -ne "resend") {
    Write-Host "Skipping Resend provisioning because Provider is '$Provider'."
    return
  }
  $apiKey = $env:RESEND_API_KEY
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Warning "RESEND_API_KEY is not set in environment; skipping automated Resend API check/provisioning."
    return
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
    $resp = Invoke-RestMethod -Method Get -Uri $url -Headers @{ Accept = "application/dns-json" } -TimeoutSec 10
    if ($resp -and $resp.Answer) {
      return @($resp.Answer | Where-Object { $_.type -eq $TypeCode } | ForEach-Object { [string]$_.data })
    }
    return @()
  } catch {
    if (Get-Command Resolve-DnsName -ErrorAction SilentlyContinue) {
      $rows = @(Resolve-DnsName -Name $QueryName -Type $RecordType -Server 1.1.1.1 -DnsOnly -ErrorAction SilentlyContinue)
      switch ($RecordType) {
        "NS" { return @($rows | Where-Object { $_.Type -eq "NS" } | ForEach-Object { $_.NameHost }) }
        "A" { return @($rows | Where-Object { $_.Type -in @("A", "CNAME") } | ForEach-Object { if ($_.IPAddress) { $_.IPAddress } else { $_.NameHost } }) }
        "AAAA" { return @($rows | Where-Object { $_.Type -eq "AAAA" } | ForEach-Object { $_.IPAddress }) }
        "MX" { return @($rows | Where-Object { $_.Type -eq "MX" } | ForEach-Object { "$($_.Preference) $($_.NameExchange)" }) }
        "TXT" { return @($rows | Where-Object { $_.Type -eq "TXT" } | ForEach-Object { ($_.Strings -join "") }) }
      }
    }
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

if ($Deploy) {
  if ($DryRun) {
    Write-Host "[DRY-RUN] Would run: npm run typecheck; npm run build; npx wrangler deploy"
  } else {
    Write-Host ""
    Invoke-Step "npm" @("run", "typecheck")
    Invoke-Step "npm" @("run", "build")
    Invoke-Step "npx" @("wrangler", "deploy")
  }
}
