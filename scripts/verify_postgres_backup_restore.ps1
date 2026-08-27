[CmdletBinding()]
param(
    [string]$BackupPath,
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
    [string]$ComposeProjectName = 'artflow',
    [string]$RestoreDatabase = 'artflow_restore'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$composeNetwork = "${ComposeProjectName}_artflow_internal"
$remoteDumpPath = '/tmp/artflow-backup.dump'
$restoreContainer = "${ComposeProjectName}-backup-restore-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"

function Assert-SafeIdentifier {
    param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Name)
    if ($Value -notmatch '^[A-Za-z_][A-Za-z0-9_-]*$') {
        throw "$Name contains unsupported characters."
    }
}

function Test-IsWithinDirectory {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Directory)
    $relative = [IO.Path]::GetRelativePath($Directory, $Path)
    return $relative -ne '..' -and -not $relative.StartsWith("..$([IO.Path]::DirectorySeparatorChar)") -and -not [IO.Path]::IsPathRooted($relative)
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
    Assert-SafeIdentifier -Value $RestoreDatabase -Name 'RestoreDatabase'

    if ([string]::IsNullOrWhiteSpace($BackupPath)) {
        $BackupPath = Join-Path $outputRoot ("artflow-{0:yyyyMMdd-HHmmss}.dump" -f (Get-Date))
    }
    $backupFile = [IO.Path]::GetFullPath($BackupPath)
    if (-not (Test-IsWithinDirectory -Path $backupFile -Directory $outputRoot)) {
        throw "BackupPath must remain inside OutputDirectory."
    }
    New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
    if (Test-Path -LiteralPath $backupFile -PathType Container) {
        throw 'BackupPath must be a file path.'
    }

    $sourceContainer = (& $script:dockerExecutable compose -p $ComposeProjectName ps -q db).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourceContainer)) {
        throw 'The source Compose db service is not running.'
    }

    Write-Host "Creating custom-format dump at $backupFile"
    Invoke-Compose -Arguments @('exec', '-T', 'db', 'sh', '-lc', "pg_dump --format=custom --file=$remoteDumpPath")
    Invoke-Docker -Arguments @('cp', "${sourceContainer}:$remoteDumpPath", $backupFile)
    Invoke-Compose -Arguments @('exec', '-T', 'db', 'rm', '-f', $remoteDumpPath)

    if (-not (Test-Path -LiteralPath $backupFile -PathType Leaf) -or (Get-Item -LiteralPath $backupFile).Length -eq 0) {
        throw 'The created backup is missing or empty.'
    }
    Invoke-Docker -Arguments @('run', '--rm', '--network', $composeNetwork, '--name', $restoreContainer, '-d', '-e', 'POSTGRES_PASSWORD=restore-only', '-e', "POSTGRES_DB=$RestoreDatabase", 'postgres:16-alpine')
    try {
        $ready = $false
        for ($attempt = 1; $attempt -le 30; $attempt++) {
            & $script:dockerExecutable exec $restoreContainer pg_isready -U postgres -d $RestoreDatabase *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'The isolated restore database did not become ready.' }
        Invoke-Docker -Arguments @('cp', $backupFile, "${restoreContainer}:/tmp/artflow-backup.dump")
        Invoke-Docker -Arguments @('exec', $restoreContainer, 'pg_restore', '--list', '/tmp/artflow-backup.dump')
        Invoke-Docker -Arguments @('exec', $restoreContainer, 'pg_restore', '--exit-on-error', '--no-owner', '--dbname', $RestoreDatabase, '/tmp/artflow-backup.dump')
        Invoke-Docker -Arguments @('exec', $restoreContainer, 'psql', '--dbname', $RestoreDatabase, '--tuples-only', '--no-align', '--command', 'SELECT 1 FROM django_migrations LIMIT 1;')

        Write-Host 'Running Django checks against the isolated restored database.'
        Invoke-Compose -Arguments @('run', '--rm', '--no-deps', '-T', '-e', 'APP_ENV=development', '-e', 'DEBUG=False', '-e', 'DATABASE_ENGINE=postgresql', '-e', "POSTGRES_DB=$RestoreDatabase", '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=restore-only', '-e', "POSTGRES_HOST=$restoreContainer", '-e', 'POSTGRES_PORT=5432', 'web', 'python', 'manage.py', 'check')
        Write-Host 'PostgreSQL backup restore verification passed. The source database and volumes were not reset.'
    }
    finally {
        & $script:dockerExecutable rm -f $restoreContainer *> $null
    }
}
finally {
    Pop-Location
}
