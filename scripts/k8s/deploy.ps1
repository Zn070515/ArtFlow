[CmdletBinding()]
param(
  [ValidateSet("dev", "test", "restore")][string]$Overlay = "dev",
  [switch]$Reset
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib.ps1")

Set-Location $script:RepoRoot

$overlayPath = "deploy/k8s/overlays/$Overlay"
$secretPath = Join-Path $overlayPath "secrets.env"
if (-not (Test-Path -LiteralPath $secretPath)) {
  Copy-Item "deploy/k8s/base/secrets.env.example" $secretPath
  $password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
  $credential = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
  (Get-Content -LiteralPath $secretPath -Raw).
    Replace("replace-with-a-strong-password", $password).
    Replace("replace-with-32-or-more-random-bytes", $credential) |
    Set-Content -LiteralPath $secretPath -Encoding utf8
  throw "Created $secretPath. Set ARTFLOW_RELEASE_SHA from images.env, then rerun."
}

$images = Get-Content -LiteralPath (Join-Path $overlayPath "images.env") -Raw | ConvertFrom-StringData
$releaseSha = $images.RELEASE_SHA
$secrets = Get-Content -LiteralPath $secretPath -Raw | ConvertFrom-StringData
if ($secrets.ARTFLOW_RELEASE_SHA -ne $releaseSha) {
  throw "ARTFLOW_RELEASE_SHA in $secretPath does not match RELEASE_SHA in images.env"
}

if ($Reset) {
  pwsh -File scripts/k8s/reset.ps1 -Overlay $Overlay
}

$namespace = @{ dev = "artflow-dev"; test = "artflow-test"; restore = "artflow-restore" }[$Overlay]
Invoke-Kubectl apply -k $overlayPath
Wait-Rollout -Kind statefulset -Name plus-db -Namespace $namespace
Wait-Rollout -Kind deployment -Name plus-api -Namespace $namespace
Wait-Rollout -Kind deployment -Name plus-worker -Namespace $namespace
Wait-Rollout -Kind deployment -Name plus-web -Namespace $namespace
Wait-Rollout -Kind deployment -Name plus-proxy -Namespace $namespace
Invoke-Kubectl -n $namespace get pods -o wide
