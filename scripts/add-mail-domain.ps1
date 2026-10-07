param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Domain,

  [ValidateSet("resend", "smtp2go", "brevo", "cloudflare")]
  [string]$Provider = "resend",

  [ValidateSet("Cloudflare", "Registrar")]
  [string]$Scenario = "Cloudflare",

  [switch]$Deploy
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root "wrangler.jsonc"
$RunbookPath = Join-Path $Root "docs\MAIL_DOMAIN_ONBOARDING.md"

function Invoke-Step([string]$Command, [string[]]$Arguments) {
  Write-Host "> $Command $($Arguments -join ' ')"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $Command $($Arguments -join ' ')"
  }
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

$normalizedDomain = $Domain.Trim().TrimStart("@").ToLowerInvariant()
if ($normalizedDomain -notmatch "^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$") {
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
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigPath, $config, $utf8WithoutBom)

Write-Host "Updated DOMAINS: $($domains -join ',')"
Write-Host "Updated OUTBOUND_PROVIDER_BY_DOMAIN: $providerValue"
Write-Host ""
Write-Host "Selected onboarding path: $Scenario"

if ($Scenario -eq "Registrar") {
  Write-Host "STOP GATE - before changing nameservers:"
  Write-Host "1. Snapshot A/AAAA/CNAME/MX/TXT/DKIM/DMARC/CAA/NS and registrar DNSSEC/DS."
  Write-Host "2. Copy required records into Cloudflare; keep the existing website DNS only."
  Write-Host "3. Compare both record sets and obtain explicit approval for the NS change."
  Write-Host "4. After cutover, verify public NS, origin DNS, and website HTTP status."
  Write-Host ""
}

Write-Host "Cloudflare and inbox checklist:"
Write-Host "1. Confirm the Cloudflare zone is Active."
Write-Host "2. Enable Email Routing and preserve unrelated MX/SPF records."
Write-Host "3. Set catch-all to Worker agentic-inbox and verify it is enabled."
Write-Host "4. Mirror both updated variables to the production Worker, then deploy."
Write-Host "5. Create the requested mailbox and run a real inbound test."
Write-Host "6. Verify $Provider for outbound; keep Resend Receiving disabled."
Write-Host "7. Run a real outbound test and inspect SPF, DKIM, and DMARC."
Write-Host ""
Write-Host "Runbook: $RunbookPath"

if ($Deploy) {
  Write-Host ""
  Invoke-Step "npm" @("run", "typecheck")
  Invoke-Step "npm" @("run", "build")
  Invoke-Step "npx" @("wrangler", "deploy")
}
