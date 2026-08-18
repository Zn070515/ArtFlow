[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$script:FailureExitCode = 1

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $script:FailureExitCode = $exitCode
        throw 'A required command failed.'
    }
}

function Invoke-Uv {
    param(
        [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    Invoke-CheckedCommand uv @Arguments
}

function Invoke-PowerShellScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath
    )

    Invoke-CheckedCommand -FilePath pwsh -Arguments @('-NoProfile', '-File', $ScriptPath)
}

function Assert-ContentMatch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content,
        [Parameter(Mandatory = $true)]
        [string]$Pattern,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if ($Content -notmatch $Pattern) {
        throw "Container contract violation: $Description."
    }
}

function Assert-ContainerContracts {
    $composePath = Join-Path $repositoryRoot 'docker-compose.yml'
    $dockerfilePath = Join-Path $repositoryRoot 'Dockerfile'
    $dockerignorePath = Join-Path $repositoryRoot '.dockerignore'
    $entrypointPath = Join-Path $repositoryRoot 'scripts/docker-entrypoint.sh'
    $waitScriptPath = Join-Path $repositoryRoot 'scripts/wait-for-postgres.sh'

    foreach ($path in @($composePath, $dockerfilePath, $dockerignorePath, $entrypointPath, $waitScriptPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Container contract violation: missing $path."
        }
    }

    $compose = Get-Content -LiteralPath $composePath -Raw
    $dockerfile = Get-Content -LiteralPath $dockerfilePath -Raw
    $dockerignore = Get-Content -LiteralPath $dockerignorePath -Raw
    $entrypoint = Get-Content -LiteralPath $entrypointPath -Raw
    $waitScript = Get-Content -LiteralPath $waitScriptPath -Raw

    Assert-ContentMatch $compose '(?m)^  db:\s*$' 'a db service'
    Assert-ContentMatch $compose '(?m)^  web:\s*$' 'a web service'
    if ([regex]::Matches($compose, '(?m)^    healthcheck:\s*$').Count -lt 2) {
        throw 'Container contract violation: db and web healthchecks are required.'
    }
    Assert-ContentMatch $compose '(?m)^volumes:\s*$' 'named volumes'
    Assert-ContentMatch $compose '(?m)^  postgres_data:\s*$' 'a named PostgreSQL volume'
    Assert-ContentMatch $compose '(?m)^  static_data:\s*$' 'a named static volume'
    Assert-ContentMatch $compose '(?m)^  media_data:\s*$' 'a named media volume'
    Assert-ContentMatch $compose 'DATABASE_ENGINE:\s*postgresql' 'an explicit PostgreSQL database engine'
    Assert-ContentMatch $compose 'POSTGRES_HOST:\s*db' 'an explicit db hostname'
    Assert-ContentMatch $compose 'POSTGRES_(DB|USER|PASSWORD):\s*artflow' 'explicit PostgreSQL credentials'
    Assert-ContentMatch $compose '(?m)^  artflow_internal:\s*$' 'an internal network'
    Assert-ContentMatch $compose 'internal:\s*true' 'an internal-only network'

    $dbService = [regex]::Match($compose, '(?ms)^  db:\s*$.*?(?=^  [A-Za-z0-9_-]+:\s*$|\z)').Value
    if ($dbService -match '(?m)^    ports:\s*$') {
        $dbPortBindings = [regex]::Matches($dbService, '(?m)^      -\s*["'']?(?<binding>[^"''\r\n]+)')
        foreach ($binding in $dbPortBindings) {
            if (-not $binding.Groups['binding'].Value.Trim().StartsWith('127.0.0.1:')) {
                throw 'Container contract violation: PostgreSQL host ports must bind to 127.0.0.1.'
            }
        }
    }

    Assert-ContentMatch $dockerfile '(?m)^FROM python:3\.12-slim$' 'a Python 3.12 slim base image'
    Assert-ContentMatch $dockerfile 'postgresql-client' 'the PostgreSQL client package'
    Assert-ContentMatch $dockerfile 'uv sync --frozen --no-dev --extra production' 'production dependencies'
    Assert-ContentMatch $dockerfile '(?m)^USER artflow$' 'a non-root runtime user'
    Assert-ContentMatch $dockerfile '(?m)^ENTRYPOINT \[' 'an entrypoint'
    if ($dockerfile -match '(?m)^COPY\s+\.\s+\.$') {
        throw 'Container contract violation: Dockerfile must not copy the complete build context.'
    }
    Assert-ContentMatch $dockerignore '(?m)^\.env$' '.env excluded from the image context'
    Assert-ContentMatch $dockerignore '(?m)^\.git/$' '.git excluded from the image context'
    Assert-ContentMatch $entrypoint '(?m)^set -Eeuo pipefail$' 'strict entrypoint error handling'
    Assert-ContentMatch $entrypoint 'python manage\.py migrate --noinput' 'migration before startup'
    Assert-ContentMatch $entrypoint 'python manage\.py collectstatic --noinput' 'static collection before startup'
    Assert-ContentMatch $entrypoint 'exec "\$@"' 'exec-based application startup'
    Assert-ContentMatch $entrypoint 'if \(\( \$# == 0 \)\); then' 'entrypoint argument validation'
    Assert-ContentMatch $waitScript '(?m)^set -Eeuo pipefail$' 'strict PostgreSQL wait error handling'
    Assert-ContentMatch $waitScript 'pg_isready' 'PostgreSQL readiness checks'
    Assert-ContentMatch $waitScript 'max_attempts > 60' 'bounded PostgreSQL readiness retries'
    Assert-ContentMatch $waitScript 'if \(\( \$# != 0 \)\); then' 'wait-script argument validation'
}

function Assert-WorkflowContracts {
    $workflowDirectory = Join-Path $repositoryRoot '.github/workflows'
    $expectedWorkflowNames = @('ci.yml', 'integration.yml', 'security.yml', 'workflow-lint.yml')

    if (-not (Test-Path -LiteralPath $workflowDirectory -PathType Container)) {
        throw 'Workflow contract violation: missing .github/workflows directory.'
    }

    foreach ($workflowName in $expectedWorkflowNames) {
        $workflowPath = Join-Path $workflowDirectory $workflowName
        if (-not (Test-Path -LiteralPath $workflowPath -PathType Leaf)) {
            throw "Workflow contract violation: missing $workflowName."
        }
    }

    $workflowPaths = @(
        Get-ChildItem -LiteralPath $workflowDirectory -File |
            Where-Object { $_.Extension -in @('.yml', '.yaml') }
    )
    if ($workflowPaths.Count -eq 0) {
        throw 'Workflow contract violation: no workflow files found.'
    }

    foreach ($workflowPath in $workflowPaths) {
        $workflow = Get-Content -LiteralPath $workflowPath.FullName -Raw

        Assert-ContentMatch $workflow '(?m)^permissions:\s*(?:\r?$|\S)' "$($workflowPath.Name) workflow permissions"
        Assert-ContentMatch $workflow '(?m)^jobs:\s*$' "$($workflowPath.Name) jobs section"

        $jobsSection = [regex]::Match($workflow, '(?ms)^jobs:\s*$\r?\n(?<jobs>.*)$').Groups['jobs'].Value
        $jobBlocks = [regex]::Matches(
            $jobsSection,
            '(?ms)^  (?<name>[A-Za-z0-9_-]+):\s*$.*?(?=^  [A-Za-z0-9_-]+:\s*$|\z)'
        )
        if ($jobBlocks.Count -eq 0) {
            throw "Workflow contract violation: $($workflowPath.Name) has no jobs."
        }
        foreach ($jobBlock in $jobBlocks) {
            if ($jobBlock.Value -notmatch '(?m)^    timeout-minutes:\s*\d+\s*$') {
                throw "Workflow contract violation: $($workflowPath.Name) job $($jobBlock.Groups['name'].Value) needs timeout-minutes."
            }
        }

        $usesLines = [regex]::Matches($workflow, '(?m)^\s*uses:\s*(?<reference>\S+)(?:\s+#.*)?\s*$')
        foreach ($usesLine in $usesLines) {
            $reference = $usesLine.Groups['reference'].Value
            if ($reference -notmatch '@[0-9a-f]{40}$') {
                throw "Workflow contract violation: $($workflowPath.Name) must pin $reference to an exact commit SHA."
            }
        }

        if ($workflow -match 'POSTGRES_') {
            Assert-ContentMatch $workflow '(?m)^\s*POSTGRES_HOST:\s*127\.0\.0\.1\s*$' "$($workflowPath.Name) PostgreSQL localhost host"
            $postgresService = [regex]::Match(
                $workflow,
                '(?ms)^      postgres:\s*$.*?(?=^    (?:env|steps):\s*$|\z)'
            ).Value
            $postgresPorts = [regex]::Match(
                $postgresService,
                '(?ms)^        ports:\s*$\r?\n(?<ports>.*?)(?=^    (?:env|steps):\s*$|\z)'
            )
            $postgresPortBindings = [regex]::Matches(
                $postgresPorts.Groups['ports'].Value,
                '(?m)^          -\s*["'']?(?<binding>[^"''\r\n]+)'
            )
            if ($postgresPortBindings.Count -eq 0) {
                throw "Workflow contract violation: $($workflowPath.Name) must map PostgreSQL to localhost."
            }
            foreach ($postgresPortBinding in $postgresPortBindings) {
                $binding = $postgresPortBinding.Groups['binding'].Value.Trim()
                if ($binding -notmatch '^127\.0\.0\.1:\d+:\d+(?:/(?:tcp|udp))?$') {
                    throw "Workflow contract violation: $($workflowPath.Name) PostgreSQL port $binding must bind to 127.0.0.1."
                }
            }
        }
    }

    $workflowLint = Get-Content -LiteralPath (Join-Path $workflowDirectory 'workflow-lint.yml') -Raw
    Assert-ContentMatch $workflowLint 'actionlint' 'an actionlint workflow gate'
}

$temporaryProductionEnvironment = [ordered]@{
    APP_ENV = 'production'
    DEBUG = 'False'
    SECRET_KEY = 'artflow-verification-secret-key-for-local-contract-checks-only-2026'
    ADMIN_LOGIN_KEY = 'artflow-verification-admin-login-key'
    ALLOWED_HOSTS = 'artflow.internal'
    CSRF_TRUSTED_ORIGINS = 'https://artflow.internal'
    DATABASE_ENGINE = 'postgresql'
    POSTGRES_DB = 'artflow'
    POSTGRES_USER = 'artflow'
    POSTGRES_PASSWORD = 'artflow-verification-database-password'
    POSTGRES_HOST = 'db.internal'
    POSTGRES_PORT = '5432'
}
$originalProductionEnvironment = @{}
foreach ($name in $temporaryProductionEnvironment.Keys) {
    $originalProductionEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location $repositoryRoot
$failureMessage = $null
try {
    Assert-ContainerContracts
    Assert-WorkflowContracts
    Invoke-CheckedCommand docker compose config --quiet
    Invoke-Uv lock --check
    Invoke-Uv run ruff check .
    Invoke-Uv run ruff format --check .
    Invoke-Uv run mypy
    Invoke-Uv run python manage.py check
    Invoke-Uv run python manage.py makemigrations --check --dry-run
    Invoke-Uv run pytest -q --cov
    Invoke-PowerShellScript -ScriptPath (Join-Path $repositoryRoot 'scripts/check_docs.ps1')
    Invoke-PowerShellScript -ScriptPath (Join-Path $repositoryRoot 'scripts/export-requirements.ps1')

    foreach ($name in $temporaryProductionEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $temporaryProductionEnvironment[$name], 'Process')
    }
    Invoke-Uv run python manage.py check --deploy --fail-level WARNING
}
catch {
    $failureMessage = 'Verification failed.'
}
finally {
    foreach ($name in $temporaryProductionEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $originalProductionEnvironment[$name], 'Process')
    }
    Pop-Location
}

if ($null -ne $failureMessage) {
    Write-Error $failureMessage
    exit $script:FailureExitCode
}

Write-Host 'Verification completed.'
