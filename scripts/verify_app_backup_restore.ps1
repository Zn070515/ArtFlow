[CmdletBinding()]
param(
    [string]$BackupSet,
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
    [string]$ComposeProjectName = 'artflow',
    [string]$RestoreDatabase = 'artflow_restore'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'restore_database_wait.ps1')

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$composeNetwork = "${ComposeProjectName}_artflow_internal"
$dumpPath = '/tmp/artflow-verify.dump'
$restoreContainer = "${ComposeProjectName}-backup-restore-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
$restoreWebContainer = "${ComposeProjectName}-web-restore-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"

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

function Get-TarExecutable {
    param([Parameter(Mandatory = $true)][string]$ArchivePath)
    # Git-shell tar misreads a Windows drive letter as a remote host (host:path);
    # bsdtar (System32\tar) handles native paths. Linux CI has no drive letters.
    if ($IsWindows -and $ArchivePath -match '^[A-Za-z]:') {
        $candidate = Join-Path $env:SystemRoot 'System32\tar.exe'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return 'tar'
}

function Invoke-RestoreWeb {
    param([Parameter(Mandatory = $true)][string[]]$Command)
    $arguments = @(
        'run', '--rm', '--network', $composeNetwork, '--name', $restoreWebContainer,
        '--entrypoint', 'python',
        '-e', 'APP_ENV=development', '-e', 'DEBUG=False',
        '-e', 'DATABASE_ENGINE=postgresql',
        '-e', "POSTGRES_DB=$RestoreDatabase", '-e', 'POSTGRES_USER=postgres',
        '-e', 'POSTGRES_PASSWORD=restore-only',
        '-e', "POSTGRES_HOST=$restoreContainer", '-e', 'POSTGRES_PORT=5432',
        '-v', "${mediaExtractDir}:/app/media:ro",
        '-v', "${backupSetResolved}:/backup:ro",
        $script:webImage
    ) + $Command
    Invoke-Docker -Arguments $arguments
}

Push-Location $repositoryRoot
try {
    $dockerCommand = Get-Command docker -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $script:dockerExecutable = $dockerCommand.Path
    Assert-SafeIdentifier -Value $ComposeProjectName -Name 'ComposeProjectName'
    Assert-SafeIdentifier -Value $RestoreDatabase -Name 'RestoreDatabase'

    if ([string]::IsNullOrWhiteSpace($BackupSet)) {
        Write-Host 'No backup set supplied; creating one from the running Compose stack.'
        $backupOutput = & (Join-Path $PSScriptRoot 'backup_artflow.ps1') -OutputDirectory $outputRoot -ComposeProjectName $ComposeProjectName
        $BackupSet = (($backupOutput -join "`n") -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim()
    }
    $backupSetResolved = [IO.Path]::GetFullPath($BackupSet)
    foreach ($required in @('database.dump', 'media.tar.gz', 'manifest.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $backupSetResolved $required) -PathType Leaf)) {
            throw "Backup set is missing $required."
        }
    }

    $mediaExtractDir = Join-Path $outputRoot ("media-" + [Guid]::NewGuid().ToString('N').Substring(0, 12))
    New-Item -ItemType Directory -Force -Path $mediaExtractDir | Out-Null
    $mediaArchive = Join-Path $backupSetResolved 'media.tar.gz'
    & (Get-TarExecutable $mediaArchive) -xzf $mediaArchive -C $mediaExtractDir
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to extract the media archive.'
    }

    $webContainer = (& $script:dockerExecutable compose -p $ComposeProjectName ps -q web).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($webContainer)) {
        throw 'The source Compose web service is not running.'
    }
    $script:webImage = (& $script:dockerExecutable inspect -f '{{.Config.Image}}' $webContainer).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($script:webImage)) {
        throw 'Could not resolve the Compose web image.'
    }

    Invoke-Docker -Arguments @('run', '--rm', '--network', $composeNetwork, '--name', $restoreContainer, '-d', '-e', 'POSTGRES_PASSWORD=restore-only', '-e', "POSTGRES_DB=$RestoreDatabase", 'postgres:17-alpine')
    try {
        Wait-ForStableRestoreDatabase -DockerExecutable $script:dockerExecutable -ContainerName $restoreContainer -DatabaseName $RestoreDatabase -TimeoutSeconds 90

        Invoke-Docker -Arguments @('cp', (Join-Path $backupSetResolved 'database.dump'), "${restoreContainer}:$dumpPath")
        Invoke-Docker -Arguments @('exec', $restoreContainer, 'pg_restore', '--list', $dumpPath)
        Invoke-Docker -Arguments @('exec', $restoreContainer, 'pg_restore', '--username', 'postgres', '--exit-on-error', '--no-owner', '--dbname', $RestoreDatabase, $dumpPath)
        Invoke-Docker -Arguments @('exec', $restoreContainer, 'psql', '--username', 'postgres', '--dbname', $RestoreDatabase, '--tuples-only', '--no-align', '--command', 'SELECT 1 FROM django_migrations LIMIT 1;')

        Write-Host 'Running Django checks against the isolated restored environment.'
        Invoke-RestoreWeb -Command @('manage.py', 'check')
        Write-Host 'Verifying restored counts and recovered media against the manifest.'
        Invoke-RestoreWeb -Command @('manage.py', 'verify_app_backup', '--manifest', '/backup/manifest.json')
        Write-Host 'Application backup restore verification passed. The source database and volumes were not reset.'
    }
    finally {
        & $script:dockerExecutable rm -f $restoreContainer *> $null
        if (Test-Path -LiteralPath $mediaExtractDir) {
            Remove-Item -LiteralPath $mediaExtractDir -Recurse -Force -ErrorAction Ignore
        }
    }
}
finally {
    Pop-Location
}
