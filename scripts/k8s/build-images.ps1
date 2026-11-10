[CmdletBinding()]
param(
  [string]$Sha = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$kubeconfig = Join-Path $root ".kube/artflow-lab.yaml"
$outDir = Join-Path $root "logs/k8s/images"
$registry = "192.168.47.10:5000"
$proxy = "http://host.docker.internal:12334"

Set-Location $root
$dirty = git status --porcelain --untracked-files=no
if ($dirty) { throw "Refusing to build from a dirty tree:`n$dirty" }
if ([string]::IsNullOrWhiteSpace($Sha)) { $Sha = (git rev-parse HEAD).Trim() }
if ($Sha -notmatch '^[0-9a-f]{40}$') { throw "not a 40-character SHA: $Sha" }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$common = @(
  "--platform", "linux/amd64",
  "--build-arg", "ARTFLOW_BUILD_SHA=$Sha",
  "--build-arg", "HTTP_PROXY=$proxy",
  "--build-arg", "HTTPS_PROXY=$proxy",
  "--build-arg", "NO_PROXY=localhost,127.0.0.1,192.168.47.10",
  "-f", "deploy/plus/Dockerfile"
)

foreach ($target in @("api", "worker", "web")) {
  Write-Host "== building $target =="
  docker build @common --target $target -t "artflow-plus-$target`:$Sha" .
  if ($LASTEXITCODE -ne 0) { throw "docker build failed for $target" }
  docker save -o (Join-Path $outDir "$target.tar") "artflow-plus-$target`:$Sha"
  if ($LASTEXITCODE -ne 0) { throw "docker save failed for $target" }
}

$bases = @(
  @{ Name = "postgres:18.6"; Tar = "postgres.tar" },
  @{ Name = "caddy:2-alpine"; Tar = "caddy.tar" },
  @{ Name = "busybox:1.36"; Tar = "busybox.tar" }
)
foreach ($base in $bases) {
  docker image inspect $base.Name *> $null
  if ($LASTEXITCODE -ne 0) {
    docker pull "docker.m.daocloud.io/library/$($base.Name)"
    if ($LASTEXITCODE -ne 0) { throw "cannot pull $($base.Name)" }
  }
  docker save -o (Join-Path $outDir $base.Tar) $base.Name
  if ($LASTEXITCODE -ne 0) { throw "docker save failed for $($base.Name)" }
}

@("RELEASE_SHA=$Sha") | Set-Content -LiteralPath (Join-Path $outDir "release.env") -Encoding utf8
Write-Host "images saved to $outDir for release $Sha"
