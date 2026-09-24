[CmdletBinding()]
param(
    [switch]$Lan,
    [ValidateRange(1024, 65535)]
    [int]$Port = 8000,
    [string]$HostAddress
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$eventEnvironmentPath = Join-Path $repositoryRoot '.env.event'
$composePath = Join-Path $repositoryRoot 'deploy/compose.event.yml'
$composeArguments = @('--env-file', $eventEnvironmentPath, '-f', $composePath)
$launcherEnvironmentNames = @(
    'ARTFLOW_EVENT_BIND_ADDRESS',
    'ARTFLOW_EVENT_PORT',
    'ARTFLOW_EVENT_ALLOWED_HOSTS'
)
$previousEnvironment = @{}

function Test-UsableIpv4 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address
    )

    $parsedAddress = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsedAddress)) {
        return $false
    }
    if ($parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        return $false
    }

    $normalizedAddress = $parsedAddress.ToString()
    return (
        $normalizedAddress -ne '0.0.0.0' -and
        $normalizedAddress -ne '127.0.0.1' -and
        $normalizedAddress -notlike '127.*' -and
        $normalizedAddress -notlike '169.254.*'
    )
}

function Get-LocalIpv4 {
    $candidates = @(
        Get-NetIPConfiguration -ErrorAction Stop |
            Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
            ForEach-Object { $_.IPv4Address.IPAddress }
    )

    foreach ($candidate in $candidates) {
        if (Test-UsableIpv4 -Address $candidate) {
            return $candidate
        }
    }

    throw 'No usable LAN IPv4 address was detected. Re-run with -HostAddress <IPv4>.'
}

function Invoke-ComposeStep {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & docker compose @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose step failed: $($Arguments -join ' ')"
    }
    return $output
}

function Assert-CommandSucceeded {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed. Check Docker Desktop and run the launcher again."
    }
}

if (-not (Test-Path -LiteralPath $eventEnvironmentPath -PathType Leaf)) {
    throw "Missing $eventEnvironmentPath. Copy .env.event.example to .env.event and replace its placeholders."
}
if (-not (Test-Path -LiteralPath $composePath -PathType Leaf)) {
    throw "Missing event Compose manifest: $composePath"
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install or start Docker Desktop, then run the launcher again.'
}
if ($HostAddress -and -not $Lan) {
    throw '-HostAddress can only be used together with -Lan.'
}

& docker info *> $null
Assert-CommandSucceeded -Description 'Docker Desktop check'

$selectedLanAddress = $null
if ($Lan) {
    $selectedLanAddress = if ($HostAddress) { $HostAddress } else { Get-LocalIpv4 }
    if (-not (Test-UsableIpv4 -Address $selectedLanAddress)) {
        throw "HostAddress '$selectedLanAddress' must be a usable non-loopback IPv4 address."
    }
    $bindAddress = '0.0.0.0'
    $allowedHosts = "localhost,127.0.0.1,$selectedLanAddress"
} else {
    $bindAddress = '127.0.0.1'
    $allowedHosts = 'localhost,127.0.0.1'
}

foreach ($environmentName in $launcherEnvironmentNames) {
    $environmentVariable = Get-Item -Path "Env:$environmentName" -ErrorAction SilentlyContinue
    if ($environmentVariable) {
        $previousEnvironment[$environmentName] = $environmentVariable.Value
    }
}

try {
    $env:ARTFLOW_EVENT_BIND_ADDRESS = $bindAddress
    $env:ARTFLOW_EVENT_PORT = [string]$Port
    $env:ARTFLOW_EVENT_ALLOWED_HOSTS = $allowedHosts

    $null = Invoke-ComposeStep -Arguments ($composeArguments + @('up', '--build', '--wait'))
    $doctorOutput = Invoke-ComposeStep -Arguments (
        $composeArguments + @('exec', '-T', 'web', 'python', 'manage.py', 'doctor')
    )
    $doctorOutput | ForEach-Object { Write-Host $_ }

    $healthUrl = "http://127.0.0.1:$Port/healthz/"
    try {
        $healthResponse = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
    } catch {
        throw 'The local health endpoint did not respond successfully.'
    }
    if ($healthResponse.status -ne 'ok') {
        throw 'The local health endpoint returned an unexpected response.'
    }

    Write-Host ''
    Write-Host 'ArtFlow event runtime is ready.'
    Write-Host "Mode: $(if ($Lan) { 'LAN' } else { 'local-only' })"
    Write-Host "Staff URL: http://127.0.0.1:$Port/"
    if ($Lan) {
        Write-Host "LAN URL: http://$selectedLanAddress`:$Port/"
        Write-Host 'If Windows Firewall prompts, allow Docker Desktop on Private networks only.'
    }
} finally {
    foreach ($environmentName in $launcherEnvironmentNames) {
        if ($previousEnvironment.ContainsKey($environmentName)) {
            Set-Item -Path "Env:$environmentName" -Value $previousEnvironment[$environmentName]
        } else {
            Remove-Item -Path "Env:$environmentName" -ErrorAction SilentlyContinue
        }
    }
}
