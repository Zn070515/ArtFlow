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

    $normalizedContent = $Content -replace "`r`n", "`n"
    if ($normalizedContent -notmatch $Pattern) {
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
    Assert-ContentMatch $compose '(?m)^  artflow_frontend:\s*$' 'a host-connected web network'
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

function Assert-ProductionComposeContracts {
    $productionComposePath = Join-Path $repositoryRoot 'deploy/compose.production.yml'
    if (-not (Test-Path -LiteralPath $productionComposePath -PathType Leaf)) {
        throw "Production container contract violation: missing $productionComposePath."
    }

    $productionCompose = Get-Content -LiteralPath $productionComposePath -Raw
    Assert-ContentMatch $productionCompose '(?m)^  db:\s*$' 'a production db service'
    Assert-ContentMatch $productionCompose '(?m)^  web:\s*$' 'a production web service'
    Assert-ContentMatch $productionCompose '(?m)^  proxy:\s*$' 'a production reverse-proxy service'
    Assert-ContentMatch $productionCompose 'APP_ENV:\s*production' 'APP_ENV=production'
    Assert-ContentMatch $productionCompose 'SECRET_KEY:\s*\$\{' 'an environment-injected production SECRET_KEY'
    Assert-ContentMatch $productionCompose 'POSTGRES_PASSWORD:\s*\$\{' 'an environment-injected production database password'
    Assert-ContentMatch $productionCompose '(?m)^  postgres_data:\s*$' 'a persistent production PostgreSQL volume'
    Assert-ContentMatch $productionCompose '(?m)^  media_data:\s*$' 'a persistent production media volume'
    Assert-ContentMatch $productionCompose '(?m)^  artflow_internal:\s*$' 'a private production network'
    Assert-ContentMatch $productionCompose 'internal:\s*true' 'an internal-only production network'

    if ($productionCompose -match 'artflow-local-container-password') {
        throw 'Production container contract violation: development database password is present.'
    }

    $webService = [regex]::Match($productionCompose, '(?ms)^  web:\s*$.*?(?=^  [A-Za-z0-9_-]+:\s*$|^volumes:|\z)').Value
    if ($webService -match '(?m)^    ports:\s*$') {
        throw 'Production container contract violation: web must not publish a host port.'
    }

    $dbService = [regex]::Match($productionCompose, '(?ms)^  db:\s*$.*?(?=^  [A-Za-z0-9_-]+:\s*$|^volumes:|\z)').Value
    if ($dbService -match '(?m)^    ports:\s*$') {
        throw 'Production container contract violation: db must not publish a host port.'
    }
}

function Assert-WorkflowContracts {
    $workflowDirectory = Join-Path $repositoryRoot '.github/workflows'
    $workflowVerifierPath = Join-Path $repositoryRoot 'scripts/verify_workflows.py'
    $requiredWorkflowNames = @('ci.yml', 'integration.yml', 'security.yml', 'workflow-lint.yml')

    if (-not (Test-Path -LiteralPath $workflowVerifierPath -PathType Leaf)) {
        throw "Workflow contract violation: missing $workflowVerifierPath."
    }

    $arguments = @('run', 'python', $workflowVerifierPath, $workflowDirectory)
    foreach ($workflowName in $requiredWorkflowNames) {
        $arguments += @('--require', $workflowName)
    }
    Invoke-Uv @arguments
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
    CADDY_SITE_ADDRESS = 'artflow.internal'
}
$originalProductionEnvironment = @{}
foreach ($name in $temporaryProductionEnvironment.Keys) {
    $originalProductionEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location $repositoryRoot
$failureMessage = $null
try {
    Assert-ContainerContracts
    Assert-ProductionComposeContracts
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
    Invoke-CheckedCommand docker compose -f deploy/compose.production.yml config --quiet
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
