Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:Kubeconfig = Join-Path $script:RepoRoot ".kube/artflow-lab.yaml"
$script:ProxyNode = "192.168.47.12"
$script:ProxyUrl = "https://artflow.local:30443"
$script:EvidencePath = Join-Path $script:RepoRoot "docs/artflow-plus/checks/2026-11-10-k8s-deployment-checks.md"

function Invoke-Kubectl {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & kubectl --kubeconfig $script:Kubeconfig @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "kubectl $($Arguments -join ' ') failed:`n$output"
  }
  return $output
}

function Invoke-KubectlExec {
  param(
    [string]$Namespace,
    [string]$Pod,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Command
  )
  $output = & kubectl --kubeconfig $script:Kubeconfig -n $Namespace exec $Pod -- @Command 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "kubectl exec $Pod $($Command -join ' ') failed:`n$output"
  }
  return $output
}

function Wait-Rollout {
  param([string]$Kind, [string]$Name, [string]$Namespace, [int]$Seconds = 300)
  Invoke-Kubectl -n $Namespace rollout status "$Kind/$Name" "--timeout=$($Seconds)s"
}

function Assert-Equal {
  param([string]$Label, [string]$Expected, [string]$Actual)
  if ($Expected -ne $Actual) {
    throw "$Label expected '$Expected' but got '$Actual'"
  }
  Write-Host "PASS $Label = $Actual"
}

function Invoke-Curl {
  param(
    [string]$Path,
    [string]$Method = "GET",
    [string[]]$Headers = @(),
    [string]$Body,
    [string]$CookieJar
  )
  $curlArgs = @(
    "-k", "-s", "-o", "NUL", "-w", "%{http_code}",
    "--resolve", "artflow.local:30443:$($script:ProxyNode)",
    "-X", $Method,
    "$($script:ProxyUrl)$Path"
  )
  foreach ($header in $Headers) { $curlArgs += @("-H", $header) }
  if ($Body) { $curlArgs += @("--data-binary", $Body) }
  if ($CookieJar) { $curlArgs += @("-b", $CookieJar, "-c", $CookieJar) }
  return (& curl.exe @curlArgs)
}

function Invoke-CurlBody {
  param([string]$Path, [string]$Method = "GET", [string[]]$Headers = @(), [string]$Body)
  $curlArgs = @(
    "-k", "-s",
    "--resolve", "artflow.local:30443:$($script:ProxyNode)",
    "-X", $Method,
    "$($script:ProxyUrl)$Path"
  )
  foreach ($header in $Headers) { $curlArgs += @("-H", $header) }
  if ($Body) { $curlArgs += @("--data-binary", $Body) }
  return (& curl.exe @curlArgs)
}

function Record-Evidence {
  param([string]$Id, [string]$Name, [string]$Result, [string]$Detail)
  $line = "| $Id | $Name | $Result | $Detail |"
  Add-Content -LiteralPath $script:EvidencePath -Value $line -Encoding utf8
  Write-Host $line
}
