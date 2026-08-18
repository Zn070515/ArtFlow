[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$script:FailureExitCode = 1

function Invoke-Uv {
    param(
        [switch]$Quiet,
        [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    if ($Quiet) {
        & uv @Arguments | Out-Null
    }
    else {
        & uv @Arguments
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $script:FailureExitCode = $exitCode
        throw 'Frozen requirements export failed.'
    }
}

function Get-NormalizedExportContent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-Content -LiteralPath $Path -Raw) -replace '(?m)^#    uv export .+$', '#    uv export --frozen --no-dev --extra production --no-emit-project -o requirements.txt'
}

$temporaryDirectory = [System.IO.Path]::GetTempPath()
$firstExport = Join-Path $temporaryDirectory ("artflow-requirements-$PID-1.txt")
$secondExport = Join-Path $temporaryDirectory ("artflow-requirements-$PID-2.txt")
$requirementsPath = Join-Path $repositoryRoot 'requirements.txt'

Push-Location $repositoryRoot
try {
    Remove-Item -LiteralPath $firstExport, $secondExport -Force -ErrorAction SilentlyContinue
    Invoke-Uv -Quiet export --frozen --no-dev --extra production --no-emit-project --output-file $firstExport
    Invoke-Uv -Quiet export --frozen --no-dev --extra production --no-emit-project --output-file $secondExport

    $firstContent = Get-NormalizedExportContent -Path $firstExport
    $secondContent = Get-NormalizedExportContent -Path $secondExport
    if ($firstContent -cne $secondContent) {
        throw 'Frozen requirements export was not reproducible.'
    }

    Invoke-Uv -Quiet -Arguments @(
        'export',
        '--frozen',
        '--no-dev',
        '--extra',
        'production',
        '--no-emit-project',
        '-o',
        'requirements.txt'
    )
    if ((Get-NormalizedExportContent -Path $requirementsPath) -cne $firstContent) {
        throw 'requirements.txt did not match the frozen export.'
    }

    Write-Host 'Regenerated requirements.txt from uv.lock.'
}
catch {
    Write-Error 'Requirements export failed.'
    exit $script:FailureExitCode
}
finally {
    Remove-Item -LiteralPath $firstExport, $secondExport -Force -ErrorAction SilentlyContinue
    Pop-Location
}
