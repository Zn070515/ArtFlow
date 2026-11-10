[CmdletBinding()]
param(
  [string[]]$Hosts = @("k8s-control", "k8s-worker-1", "k8s-worker-2")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# `pwsh -File` passes `-Hosts a,b` as one string; split it here.
$targets = @($Hosts | ForEach-Object { $_ -split ',' } | Where-Object { $_ })

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$scriptPath = Join-Path $root "deploy/k8s/bootstrap/enable-lab-sudo.sh"

foreach ($name in $targets) {
  Write-Host "== $name =="
  scp -o ConnectTimeout=10 $scriptPath "$($name):/tmp/enable-lab-sudo.sh"
  if ($LASTEXITCODE -ne 0) { throw "scp failed on $name" }
  # No stdin piping: sudo prompts on the allocated TTY, so CRLF and cached
  # credentials cannot corrupt the script.
  ssh -t -o ConnectTimeout=10 $name "sudo bash /tmp/enable-lab-sudo.sh"
  if ($LASTEXITCODE -ne 0) { throw "failed to enable passwordless sudo on $name" }
}

Write-Host "passwordless sudo enabled on: $($targets -join ', ')"
