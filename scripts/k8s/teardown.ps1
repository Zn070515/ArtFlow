[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib.ps1")

Set-Location $script:RepoRoot
foreach ($namespace in @("artflow-dev", "artflow-test", "artflow-restore")) {
  Invoke-Kubectl -n $namespace delete deployment,statefulset,service,configmap,secret,networkpolicy,pod,persistentvolumeclaim,cronjob,job,hpa --all --ignore-not-found
}
Write-Host "application workloads removed; bootstrap components and namespaces kept"
