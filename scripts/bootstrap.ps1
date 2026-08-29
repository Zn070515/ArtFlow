[CmdletBinding()]
param(
    [switch]$SeedDemoData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$script:FailureExitCode = 1

function Invoke-Uv {
    param(
        [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & uv @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $script:FailureExitCode = $exitCode
        throw 'A uv command failed.'
    }
}

function Get-EnvironmentKeys {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $keys = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=') {
            $keys[$Matches[1]] = $true
        }
    }
    return $keys
}

function Initialize-LocalEnvironment {
    $examplePath = Join-Path $repositoryRoot '.env.example'
    $environmentPath = Join-Path $repositoryRoot '.env'

    if (-not (Test-Path -LiteralPath $examplePath -PathType Leaf)) {
        throw '.env.example is required to prepare the local environment.'
    }

    if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
        Copy-Item -LiteralPath $examplePath -Destination $environmentPath
        Write-Host 'Created .env from .env.example.'
        return
    }

    $existingKeys = Get-EnvironmentKeys -Path $environmentPath
    $missingLines = @()
    foreach ($line in Get-Content -LiteralPath $examplePath) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=') {
            if (-not $existingKeys.ContainsKey($Matches[1])) {
                $missingLines += $line
            }
        }
    }

    if ($missingLines.Count -gt 0) {
        Add-Content -LiteralPath $environmentPath -Value ''
        Add-Content -LiteralPath $environmentPath -Value $missingLines
        Write-Host 'Added missing .env entries from .env.example.'
    }
}

Push-Location $repositoryRoot
try {
    Initialize-LocalEnvironment
    Invoke-Uv sync --locked --extra dev
    Invoke-Uv run python manage.py migrate --noinput
    Invoke-Uv run python manage.py seed_ruleset_templates
    New-Item -ItemType Directory -Force -Path media | Out-Null
    Invoke-Uv run python manage.py collectstatic --noinput
    Invoke-Uv run python manage.py check
    Invoke-Uv run python manage.py doctor
    Invoke-Uv run python -c "from django.test import Client; response = Client().get('/healthz/'); raise SystemExit(0 if response.status_code == 200 and response.json() == {'status': 'ok'} else 1)"

    if ($SeedDemoData) {
        Invoke-Uv run python manage.py seed_demo_data
    }
}
catch {
    Write-Error 'Bootstrap failed.'
    exit $script:FailureExitCode
}
finally {
    Pop-Location
}
