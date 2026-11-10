[CmdletBinding()]
param(
  [string[]]$Hosts = @("k8s-control", "k8s-worker-1", "k8s-worker-2")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$scriptPath = Join-Path $root "deploy/k8s/bootstrap/disable-lab-sudo.sh"
$body = (Get-Content -LiteralPath $scriptPath -Raw) -replace "`r`n", "`n"

foreach ($name in $Hosts) {
  Write-Host "== $name =="
  $body | ssh -T -o ConnectTimeout=10 $name "sudo -n bash -s"
  if ($LASTEXITCODE -ne 0) { throw "failed to remove passwordless sudo on $name" }
}

Write-Host "passwordless sudo removed from: $($Hosts -join ', ')"
