[CmdletBinding()]
param(
    [switch]$StartCompose,
    [switch]$VerifyResetSafety
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot

function Invoke-DockerCompose {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $script:dockerExecutable compose @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose command failed: compose $($Arguments -join ' ')"
    }
}

function Invoke-WebCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command
    )

    Invoke-DockerCompose -Arguments @('exec', '-T', 'web', 'sh', '-lc', $Command)
}

Push-Location $repositoryRoot
try {
    $dockerCommand = Get-Command docker -CommandType Application -ErrorAction Stop |
        Select-Object -First 1
    $script:dockerExecutable = $dockerCommand.Path

    if ($StartCompose) {
        Invoke-DockerCompose -Arguments @('up', '--build', '--wait')
    }

    Write-Host 'Running the PostgreSQL acceptance contract against the Compose web service.'
    Invoke-WebCommand 'python manage.py migrate --noinput'
    Invoke-WebCommand 'python manage.py doctor'
    Invoke-WebCommand 'python -c "from urllib.request import urlopen; response = urlopen(''http://127.0.0.1:8000/healthz/'', timeout=3); raise SystemExit(0 if response.status == 200 else response.status)"'
    Invoke-WebCommand 'python manage.py seed_demo_data'
    Invoke-WebCommand 'python manage.py seed_demo_data'

    if ($VerifyResetSafety) {
        Invoke-WebCommand 'python manage.py seed_demo_data --reset'
        Invoke-WebCommand 'python manage.py seed_demo_data'
    }

    Invoke-WebCommand 'python manage.py test'
    Write-Host 'PostgreSQL acceptance contract completed. Services and volumes were left intact.'
}
finally {
    Pop-Location
}
