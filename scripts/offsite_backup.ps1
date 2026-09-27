[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BackupSet,
    [string]$Bucket = $env:ARTFLOW_OFFSITE_BUCKET,
    [string]$Prefix = $env:ARTFLOW_OFFSITE_PREFIX,
    [string]$Tool = 'ossutil'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not [string]::IsNullOrWhiteSpace($env:ARTFLOW_OFFSITE_TOOL)) {
    $Tool = $env:ARTFLOW_OFFSITE_TOOL
}

function Assert-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Expected -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Manifest field $Label is not a SHA-256 digest."
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "$Label does not match the local backup set."
    }
}

if ([string]::IsNullOrWhiteSpace($Bucket) -or $Bucket -notmatch '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$') {
    throw 'ARTFLOW_OFFSITE_BUCKET must be a valid OSS bucket name.'
}
$Prefix = ([string]$Prefix).Trim('/')
if ($Prefix -match '\.\.' -or $Prefix -match '\\') {
    throw 'ARTFLOW_OFFSITE_PREFIX contains an unsafe path segment.'
}

$backupSetResolved = [IO.Path]::GetFullPath($BackupSet)
if (-not (Test-Path -LiteralPath $backupSetResolved -PathType Container)) {
    throw "Backup set not found: $backupSetResolved"
}
$manifestPath = Join-Path $backupSetResolved 'manifest.json'
$databasePath = Join-Path $backupSetResolved 'database.dump'
$mediaPath = Join-Path $backupSetResolved 'media.tar.gz'
foreach ($path in @($manifestPath, $databasePath, $mediaPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Backup set is missing $(Split-Path -Leaf $path)."
    }
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
Assert-Sha256 -Path $databasePath -Expected ([string]$manifest.database_sha256) -Label 'database_sha256'
Assert-Sha256 -Path $mediaPath -Expected ([string]$manifest.media_sha256) -Label 'media_sha256'

$toolCommand = Get-Command $Tool -CommandType Application -ErrorAction Stop | Select-Object -First 1
$leaf = Split-Path -Leaf $backupSetResolved
$destination = "oss://$Bucket/"
if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
    $destination += "$Prefix/"
}
$destination += $leaf

& $toolCommand.Source cp -r $backupSetResolved $destination
if ($LASTEXITCODE -ne 0) {
    throw "Off-site backup upload failed for $leaf."
}
& $toolCommand.Source stat "$destination/manifest.json" *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Off-site backup manifest verification failed for $leaf."
}

Write-Output $destination
