[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$readmePath = Join-Path $repositoryRoot 'README.md'
$docsPath = Join-Path $repositoryRoot 'docs'
$superpowersDocsPath = Join-Path $docsPath 'superpowers'

if (-not (Test-Path -LiteralPath $readmePath -PathType Leaf)) {
    throw 'README.md is required for documentation validation.'
}

$documents = @(
    Get-Item -LiteralPath $readmePath
    if (Test-Path -LiteralPath $docsPath -PathType Container) {
        Get-ChildItem -LiteralPath $docsPath -Recurse -File -Filter '*.md' |
            Where-Object { -not $_.FullName.StartsWith($superpowersDocsPath, [StringComparison]::OrdinalIgnoreCase) }
    }
)

$missingLinks = @()
$linkPattern = '\[[^\]]*\]\((?<target>[^)\s]+)(?:\s+"[^"]*")?\)'

foreach ($document in $documents) {
    $documentDirectory = Split-Path -Parent $document.FullName
    foreach ($match in [regex]::Matches((Get-Content -LiteralPath $document.FullName -Raw), $linkPattern)) {
        $target = $match.Groups['target'].Value.Trim('<', '>')
        if (
            [string]::IsNullOrWhiteSpace($target) -or
            $target.StartsWith('#') -or
            $target -match '^(https?|mailto|tel):'
        ) {
            continue
        }

        $targetPath = ($target -split '#', 2)[0]
        if ($targetPath.StartsWith('/')) {
            $resolvedPath = Join-Path $repositoryRoot $targetPath.TrimStart('/')
        }
        else {
            $resolvedPath = Join-Path $documentDirectory $targetPath
        }

        if (-not (Test-Path -LiteralPath $resolvedPath)) {
            $missingLinks += "$($document.FullName): $targetPath"
        }
    }
}

if ($missingLinks.Count -gt 0) {
    throw ("Documentation links are missing:`n" + ($missingLinks -join "`n"))
}

Write-Host "Documentation links validated in $($documents.Count) file(s); docs/superpowers was skipped."
