[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$docsPath = Join-Path $repositoryRoot 'docs'
$superpowersDocsPath = Join-Path $docsPath 'superpowers'
# Root Markdown is opt-in: this list contains the repository's user-facing root
# documents. Other root Markdown is not scanned unless it is added here.
$rootDocumentNames = @('README.md', 'CLAUDE.md', 'AGENTS.md', 'CHANGELOG.md', 'GOAL.md')

function Get-UserFacingDocuments {
    $documents = @()
    foreach ($name in $rootDocumentNames) {
        $path = Join-Path $repositoryRoot $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "$name is required for documentation validation."
        }
        $documents += Get-Item -LiteralPath $path
    }

    if (Test-Path -LiteralPath $docsPath -PathType Container) {
        $documents += Get-ChildItem -LiteralPath $docsPath -Recurse -File -Filter '*.md' |
            Where-Object {
                -not $_.FullName.StartsWith(
                    $superpowersDocsPath + [IO.Path]::DirectorySeparatorChar,
                    [StringComparison]::OrdinalIgnoreCase
                )
            }
    }

    return $documents
}

function Test-IsWithinRepositoryRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $relativePath = [IO.Path]::GetRelativePath($repositoryRoot, $Path)
    return (
        $relativePath -ne '..' -and
        -not $relativePath.StartsWith("..$([IO.Path]::DirectorySeparatorChar)") -and
        -not [IO.Path]::IsPathRooted($relativePath)
    )
}

$documents = Get-UserFacingDocuments
$missingLinks = @()
$escapingLinks = @()
$linkPattern = '\[[^\]]*\]\((?<target><[^>]+>|[^)\s]+)(?:\s+["''][^"'']*["''])?\)'

foreach ($document in $documents) {
    $content = Get-Content -LiteralPath $document.FullName -Raw
    foreach ($match in [regex]::Matches($content, $linkPattern)) {
        $target = $match.Groups['target'].Value.Trim('<', '>')
        if (
            [string]::IsNullOrWhiteSpace($target) -or
            $target.StartsWith('#') -or
            $target.StartsWith('//') -or
            $target -match '^(https?|mailto|tel):'
        ) {
            continue
        }

        $targetPath = (($target -split '#', 2)[0] -split '\?', 2)[0]
        $documentDirectory = Split-Path -Parent $document.FullName
        $resolvedPath = [IO.Path]::GetFullPath((Join-Path $documentDirectory $targetPath))
        if (-not (Test-IsWithinRepositoryRoot -Path $resolvedPath)) {
            $escapingLinks += "$($document.FullName): $target"
            continue
        }

        if (-not (Test-Path -LiteralPath $resolvedPath)) {
            $missingLinks += "$($document.FullName): $target"
        }
    }
}

if ($escapingLinks.Count -gt 0) {
    throw ("A documentation link escapes the repository root:`n" + ($escapingLinks -join "`n"))
}

if ($missingLinks.Count -gt 0) {
    throw ("Documentation links are missing:`n" + ($missingLinks -join "`n"))
}

$forbiddenPatterns = @(
    @{ Description = 'the removed seed_data command'; Pattern = '(?i)(?<![A-Za-z0-9_])seed_data(?![A-Za-z0-9_])' },
    @{ Description = 'the obsolete docker-compose detached startup command'; Pattern = '(?im)^\s*docker-compose\s+up\s+-d(?:\s|$)' },
    @{ Description = 'hardcoded administrator sample credentials'; Pattern = '(?i)admin\s*/\s*admin123' },
    @{ Description = 'aggregate model, view, or route counts'; Pattern = '(?im)(?:\b\d+\s+(?:Django\s+)?(?:models?|views?|routes?)\b|\b(?:models?|views?|routes?)\s*\(\s*\d+\s+(?:total|total\s+models?)\s*\)|\d+\s*(?:个)?\s*(?:模型|视图|路由))' }
)
$violations = @()

foreach ($document in $documents) {
    $content = Get-Content -LiteralPath $document.FullName -Raw
    foreach ($rule in $forbiddenPatterns) {
        if ($content -match $rule.Pattern) {
            $violations += "$($document.FullName): contains $($rule.Description)."
        }
    }
}

if ($violations.Count -gt 0) {
    throw ("Documentation contains stale or unsafe content:`n" + ($violations -join "`n"))
}

Write-Host "Documentation validation passed for $($documents.Count) user-facing Markdown file(s); docs/superpowers was skipped."
