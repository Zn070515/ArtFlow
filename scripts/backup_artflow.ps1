[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
    [string]$ComposeProjectName = 'artflow',
    [string]$GitSha,
    [string]$ContainerBackupBase = '/tmp/artflow-backup'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)

function Assert-SafeIdentifier {
    param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Name)
    if ($Value -notmatch '^[A-Za-z_][A-Za-z0-9_-]*$') {
        throw "$Name contains unsupported characters."
    }
}

function Invoke-Docker {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & $script:dockerExecutable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed: docker $($Arguments -join ' ')"
    }
}

function Invoke-Compose {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    Invoke-Docker -Arguments (@('compose', '-p', $ComposeProjectName) + $Arguments)
}

Push-Location $repositoryRoot
try {
    $dockerCommand = Get-Command docker -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $script:dockerExecutable = $dockerCommand.Path
    Assert-SafeIdentifier -Value $ComposeProjectName -Name 'ComposeProjectName'
    Assert-SafeIdentifier -Value $ContainerBackupBase -Name 'ContainerBackupBase'

    $webContainer = (& $script:dockerExecutable compose -p $ComposeProjectName ps -q web).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($webContainer)) {
        throw 'The source Compose web service is not running.'
    }

    $commandArguments = @(
        'compose', '-p', $ComposeProjectName, 'exec', '-T', 'web',
        'python', 'manage.py', 'backup_artflow', '--output', $ContainerBackupBase
    )
    if ($GitSha) {
        $commandArguments += @('--git-sha', $GitSha)
    } else {
        $detectedSha = (& git rev-parse HEAD 2>$null).Trim()
        if ($LASTEXITCODE -eq 0 -and $detectedSha) {
            $commandArguments += @('--git-sha', $detectedSha)
        }
    }

    Write-Host 'Creating application-level backup set in the web container.'
    $commandOutput = & $script:dockerExecutable @commandArguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "manage.py backup_artflow failed: $($commandOutput -join ' ')"
    }
    $containerBackupDir = (($commandOutput -join "`n") -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim()
    if ($containerBackupDir -notmatch '^/') {
        throw "Unexpected backup_artflow output: $containerBackupDir"
    }

    New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
    Invoke-Docker -Arguments @('cp', "${webContainer}:${containerBackupDir}", $outputRoot)
    $localBackupDir = Join-Path $outputRoot (Split-Path -Leaf $containerBackupDir)
    if (-not (Test-Path -LiteralPath (Join-Path $localBackupDir 'manifest.json') -PathType Leaf)) {
        throw 'The copied backup set is missing manifest.json.'
    }

    Write-Host "Backup set created at $localBackupDir"
    Write-Host $localBackupDir
}
finally {
    Pop-Location
}
