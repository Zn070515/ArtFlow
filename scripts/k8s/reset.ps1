[CmdletBinding()]
param(
  [ValidateSet("dev", "test", "restore")][string]$Overlay = "test"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib.ps1")

Set-Location $script:RepoRoot
$namespace = @{ dev = "artflow-dev"; test = "artflow-test"; restore = "artflow-restore" }[$Overlay]
Invoke-Kubectl -n $namespace delete deployment,statefulset,service,configmap,secret,networkpolicy,pod,persistentvolumeclaim,cronjob,job,hpa --all --ignore-not-found
Write-Host "reset $namespace"
