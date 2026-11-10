[CmdletBinding()]
param(
  [string[]]$Hosts = @("k8s-control", "k8s-worker-1", "k8s-worker-2")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$scriptPath = Join-Path $root "deploy/k8s/bootstrap/enable-lab-sudo.sh"
$body = (Get-Content -LiteralPath $scriptPath -Raw) -replace "`r`n", "`n"

$secure = Read-Host -AsSecureString "sudo password for xuxin on $($Hosts -join ', ')"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

foreach ($name in $Hosts) {
  Write-Host "== $name =="
  # sudo -S consumes the first line; bash -s consumes the rest as the script.
  $payload = "$password`n$body"
  $payload | ssh -T -o ConnectTimeout=10 $name "sudo -S bash -s"
  if ($LASTEXITCODE -ne 0) { throw "failed to enable passwordless sudo on $name" }
}

Write-Host "passwordless sudo enabled on: $($Hosts -join ', ')"
