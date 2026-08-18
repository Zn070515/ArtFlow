[CmdletBinding()]
param(
    [switch]$StartCompose,
    [switch]$VerifyResetSafety
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-WebCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command
    )

    & docker compose exec -T web sh -lc $Command
    if ($LASTEXITCODE -ne 0) {
        throw "PostgreSQL acceptance command failed: $Command"
    }
}

if ($StartCompose) {
    & docker compose up --build --wait
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Compose did not reach a healthy state.'
    }
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
