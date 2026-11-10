[CmdletBinding()]
param(
  [string]$Registry = "192.168.47.10:5000",
  [string]$Control = "k8s-control",
  [string]$RemoteDir = "/tmp/artflow-images"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$imageDir = Join-Path $root "logs/k8s/images"
Set-Location $root

$release = Get-Content -LiteralPath (Join-Path $imageDir "release.env") -Raw | ConvertFrom-StringData
$sha = $release.RELEASE_SHA
if ($sha -notmatch '^[0-9a-f]{40}$') { throw "bad release SHA: $sha" }

ssh -o ConnectTimeout=10 $Control "mkdir -p $RemoteDir"
if ($LASTEXITCODE -ne 0) { throw "cannot create $RemoteDir on $Control" }

foreach ($tar in @("api.tar", "worker.tar", "web.tar", "postgres.tar", "caddy.tar", "busybox.tar")) {
  $local = Join-Path $imageDir $tar
  if (-not (Test-Path -LiteralPath $local)) { throw "missing $local; run build-images.ps1 first" }
  scp -q -o ConnectTimeout=10 $local "$($Control):$RemoteDir/$tar"
  if ($LASTEXITCODE -ne 0) { throw "scp failed for $tar" }
}

ssh -o ConnectTimeout=10 $Control "command -v skopeo >/dev/null 2>&1 || (sudo -n apt-get update -qq && sudo -n apt-get install -y skopeo)"
if ($LASTEXITCODE -ne 0) { throw "skopeo is not available on $Control" }

$images = @(
  @{ Tar = "api.tar"; Dest = "$Registry/artflow-plus-api`:$sha"; Key = "ARTFLOW_PLUS_API_DIGEST" },
  @{ Tar = "worker.tar"; Dest = "$Registry/artflow-plus-worker`:$sha"; Key = "ARTFLOW_PLUS_WORKER_DIGEST" },
  @{ Tar = "web.tar"; Dest = "$Registry/artflow-plus-web`:$sha"; Key = "ARTFLOW_PLUS_WEB_DIGEST" },
  @{ Tar = "postgres.tar"; Dest = "$Registry/library/postgres:18"; Key = "POSTGRES_DIGEST" },
  @{ Tar = "caddy.tar"; Dest = "$Registry/library/caddy:2-alpine"; Key = "CADDY_DIGEST" },
  @{ Tar = "busybox.tar"; Dest = "$Registry/library/busybox:1.36"; Key = "BUSYBOX_DIGEST" }
)

$digests = @{ RELEASE_SHA = $sha }
foreach ($image in $images) {
  Write-Host "== pushing $($image.Tar) -> $($image.Dest) =="
  $source = "docker-archive:$RemoteDir/$($image.Tar)"
  ssh -o ConnectTimeout=30 $Control "skopeo copy --dest-tls-verify=false $source docker://$($image.Dest)"
  if ($LASTEXITCODE -ne 0) { throw "skopeo copy failed for $($image.Tar)" }
  $digest = (ssh -o ConnectTimeout=30 $Control "skopeo inspect --tls-verify=false --format '{{.Digest}}' docker://$($image.Dest)").Trim()
  if ($LASTEXITCODE -ne 0 -or $digest -notmatch '^sha256:[0-9a-f]{64}$') { throw "cannot read digest for $($image.Dest): $digest" }
  $digests[$image.Key] = $digest
  Write-Host "   $digest"
}

$envPath = "deploy/k8s/overlays/dev/images.env"
$digests.Keys | Sort-Object | ForEach-Object { "$_=$($digests[$_])" } |
  Set-Content -LiteralPath $envPath -Encoding utf8
Copy-Item $envPath "deploy/k8s/overlays/test/images.env" -Force
Copy-Item $envPath "deploy/k8s/overlays/restore/images.env" -Force

foreach ($overlay in @("dev", "test", "restore")) {
  $path = "deploy/k8s/overlays/$overlay/kustomization.yaml"
  $text = Get-Content -LiteralPath $path -Raw
  $text = $text.Replace("sha256:REPLACE_WITH_API_DIGEST", $digests.ARTFLOW_PLUS_API_DIGEST)
  $text = $text.Replace("sha256:REPLACE_WITH_WORKER_DIGEST", $digests.ARTFLOW_PLUS_WORKER_DIGEST)
  $text = $text.Replace("sha256:REPLACE_WITH_WEB_DIGEST", $digests.ARTFLOW_PLUS_WEB_DIGEST)
  $text = $text.Replace("sha256:REPLACE_WITH_POSTGRES_DIGEST", $digests.POSTGRES_DIGEST)
  $text = $text.Replace("sha256:REPLACE_WITH_CADDY_DIGEST", $digests.CADDY_DIGEST)
  Set-Content -LiteralPath $path -Value $text -NoNewline
}

Get-Content $envPath
