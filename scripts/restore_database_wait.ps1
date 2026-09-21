function Assert-RestoreDatabaseIdentifier {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($Value -notmatch '^[A-Za-z_][A-Za-z0-9_-]*$') {
        throw "$Name contains unsupported characters."
    }
}

function Write-RestoreContainerDiagnostics {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DockerExecutable,
        [Parameter(Mandatory = $true)]
        [string]$ContainerName
    )

    Write-Host "Restore container status: $ContainerName"
    $status = @(& $DockerExecutable inspect --format '{{.State.Status}}' $ContainerName 2>&1)
    foreach ($line in $status) {
        Write-Host $line
    }

    Write-Host 'Restore container logs (last 80 lines):'
    # docker logs is intentionally limited to the tail and never inspects env/config values.
    $logs = @(& $DockerExecutable logs --tail 80 $ContainerName 2>&1)
    foreach ($line in $logs) {
        Write-Host $line
    }
}

function Wait-ForStableRestoreDatabase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DockerExecutable,
        [Parameter(Mandatory = $true)]
        [string]$ContainerName,
        [Parameter(Mandatory = $true)]
        [string]$DatabaseName,
        [int]$TimeoutSeconds = 90
    )

    Assert-RestoreDatabaseIdentifier -Value $ContainerName -Name 'ContainerName'
    Assert-RestoreDatabaseIdentifier -Value $DatabaseName -Name 'DatabaseName'
    if ($TimeoutSeconds -lt 1) {
        throw 'TimeoutSeconds must be positive.'
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $initCompleteMarker = 'PostgreSQL init process complete; ready for start up.'

    while ([DateTime]::UtcNow -lt $deadline) {
        $state = (@(& $DockerExecutable inspect --format '{{.State.Status}}' $ContainerName 2>$null) -join '').Trim()
        $inspectExitCode = $LASTEXITCODE
        if ($inspectExitCode -eq 0 -and $state -in @('exited', 'dead')) {
            Write-RestoreContainerDiagnostics -DockerExecutable $DockerExecutable -ContainerName $ContainerName
            throw 'The isolated restore database container stopped before becoming stable.'
        }
        if ($inspectExitCode -ne 0 -or $state -ne 'running') {
            Start-Sleep -Seconds 1
            continue
        }

        $logs = (@(& $DockerExecutable logs --tail 80 $ContainerName 2>$null) -join "`n")
        if ($logs -notlike "*$initCompleteMarker*") {
            Start-Sleep -Seconds 1
            continue
        }

        $probeArguments = @(
            'exec', $ContainerName, 'psql',
            '--username', 'postgres',
            '--dbname', $DatabaseName,
            '--tuples-only',
            '--no-align',
            '--command', 'SELECT 1;'
        )
        & $DockerExecutable @probeArguments *> $null
        $firstProbeExitCode = $LASTEXITCODE
        if ($firstProbeExitCode -ne 0) {
            Start-Sleep -Seconds 1
            continue
        }

        Start-Sleep -Seconds 1
        & $DockerExecutable @probeArguments *> $null
        $secondProbeExitCode = $LASTEXITCODE
        if ($secondProbeExitCode -eq 0) {
            return
        }

        Start-Sleep -Seconds 1
    }

    Write-RestoreContainerDiagnostics -DockerExecutable $DockerExecutable -ContainerName $ContainerName
    throw "The isolated restore database did not become stable within $TimeoutSeconds seconds."
}
