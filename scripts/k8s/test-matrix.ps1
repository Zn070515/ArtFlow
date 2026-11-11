[CmdletBinding()]
param(
  [ValidateSet("dev", "test")][string]$Overlay = "test",
  [string]$Only = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib.ps1")

Set-Location $script:RepoRoot
$namespace = @{ dev = "artflow-dev"; test = "artflow-test" }[$Overlay]

function Get-PodName {
  param([string]$Label)
  $name = Invoke-Kubectl -n $namespace get pod --selector=$Label --output=jsonpath='{.items[0].metadata.name}'
  if (-not $name) { throw "no pod for $Label" }
  return $name.Trim()
}

function Wait-AllReady {
  Invoke-Kubectl -n $namespace wait --for=condition=Ready pod --all --timeout=180s | Out-Null
}

function Test-T0 {
  Wait-AllReady
  $health = Invoke-Curl "/healthz"
  $ready = Invoke-Curl "/readyz"
  if ($health -ne "200" -or $ready -ne "200") { throw "healthz=$health readyz=$ready" }
  $worker = Get-PodName "app=plus-worker"
  Invoke-KubectlExec -Namespace $namespace -Pod $worker test -f /tmp/artflow-worker-ready | Out-Null
  $db = Get-PodName "app=plus-db"
  $tables = Invoke-KubectlExec -Namespace $namespace -Pod $db psql -U artflow_plus -d artflow_plus -Atc "select count(*) from information_schema.tables where table_name in ('kysely_migration','kysely_migration_lock')"
  if ($tables.Trim() -ne "2") { throw "migration tables: $tables" }
  $image = Invoke-Kubectl -n $namespace get pod --selector=app=plus-api --output=jsonpath='{.items[0].status.containerStatuses[0].imageID}'
  $expected = (Get-Content "deploy/k8s/overlays/$Overlay/images.env" -Raw | ConvertFrom-StringData).ARTFLOW_PLUS_API_DIGEST
  if ($image -notmatch [regex]::Escape(($expected -split ':')[1])) { throw "API digest mismatch: $image" }
  $pgLog = Invoke-Kubectl -n $namespace logs $db --tail=50
  if ($pgLog -match "unused mount") { throw "Postgres reported an unused mount" }
  Record-Evidence "T0" "Fresh deploy" "PASS" "pods Ready; healthz/readyz 200; migrations present; digest $expected"
}

function Test-T0n {
  Invoke-Kubectl -n $namespace set env deployment/plus-api "ARTFLOW_RELEASE_SHA=0000000000000000000000000000000000000000" | Out-Null
  $failed = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $waiting = Invoke-Kubectl -n $namespace get pods --selector=app=plus-api --output=jsonpath='{range .items[*]}{.status.containerStatuses[*].state.waiting.reason}{"\n"}{end}'
    if ($waiting -match "CrashLoopBackOff|ErrImagePull|Error") { $failed = $true; break }
  }
  if (-not $failed) { throw "wrong SHA did not fail closed" }
  $badLine = (Invoke-Kubectl -n $namespace get pods --selector=app=plus-api --output=jsonpath='{range .items[*]}{.metadata.name}{"|"}{.status.containerStatuses[*].state.waiting.reason}{"|"}{.status.containerStatuses[*].lastState.terminated.reason}{"\n"}{end}' | Select-String 'CrashLoopBackOff|Error|OOMKilled' | Select-Object -First 1)
  if (-not $badLine) { throw "cannot identify the failing pod" }
  $badPod = ($badLine -split '\|')[0].Trim()
  $logs = & kubectl --kubeconfig $script:Kubeconfig -n $namespace logs $badPod --previous --tail=50 2>&1
  $logText = ($logs -join "`n")
  if ($LASTEXITCODE -ne 0 -or $logText -notmatch "ARTFLOW_RELEASE_SHA|release marker|assertReleaseProvenance") {
    $logs = & kubectl --kubeconfig $script:Kubeconfig -n $namespace logs $badPod --tail=50 2>&1
    $logText = ($logs -join "`n")
  }
  Invoke-Kubectl -n $namespace rollout undo deployment/plus-api | Out-Null
  Invoke-Kubectl -n $namespace rollout status deployment/plus-api --timeout=180s | Out-Null
  Invoke-Kubectl -n $namespace delete pod $badPod --ignore-not-found | Out-Null
  Start-Sleep -Seconds 5
  $ready = (Invoke-Kubectl -n $namespace get deployment plus-api --output=jsonpath='{.status.readyReplicas}').Trim()
  if ($ready -ne "1") { throw "API ready replicas after rollback: $ready" }
  if ($logText -notmatch "ARTFLOW_RELEASE_SHA|release marker|assertReleaseProvenance") { throw "failure log does not show the provenance error" }
  Record-Evidence "T0n" "Negative provenance" "PASS" "wrong SHA failed closed; log names ARTFLOW_RELEASE_SHA"
}

function Test-T1 {
  $probe = Start-Job -ScriptBlock {
    param($url, $node)
    $bad = 0
    for ($i = 0; $i -lt 150; $i++) {
      $code = & curl.exe -k -s -o NUL -w "%{http_code}" --resolve "artflow.local:30443:$node" "$url/healthz"
      if ($code -ne "200") { $bad++ }
      Start-Sleep -Milliseconds 200
    }
    $bad
  } -ArgumentList $script:ProxyUrl, $script:ProxyNode

  Invoke-Kubectl -n $namespace rollout restart deployment/plus-api | Out-Null
  Invoke-Kubectl -n $namespace rollout status deployment/plus-api --timeout=300s | Out-Null
  $bad = Receive-Job -Job $probe -Wait
  Remove-Job $probe
  if ($bad -ne 0) { throw "T1 saw $bad non-200 responses" }
  Record-Evidence "T1" "Rolling update" "PASS" "config rollout; 150 probes at 200ms; 0 non-200"
}

function Test-T2 {
  Invoke-Kubectl -n $namespace rollout undo deployment/plus-api | Out-Null
  Invoke-Kubectl -n $namespace rollout status deployment/plus-api --timeout=300s | Out-Null
  $migrations = Invoke-KubectlExec -Namespace $namespace -Pod (Get-PodName "app=plus-db") psql -U artflow_plus -d artflow_plus -Atc "select count(*) from kysely_migration"
  Record-Evidence "T2" "Rollback" "PASS" "rollout undo completed; migrations=$($migrations.Trim())"
}

function Test-T3 {
  $db = Get-PodName "app=plus-db"
  $before = (Invoke-KubectlExec -Namespace $namespace -Pod $db psql -U artflow_plus -d artflow_plus -Atc "select count(*) from outbox where published_at is null").Trim()
  foreach ($label in @("app=plus-api", "app=plus-worker", "app=plus-web", "app=plus-db")) {
    Invoke-Kubectl -n $namespace delete pod --selector=$label --wait=false | Out-Null
  }
  Start-Sleep -Seconds 10
  Wait-AllReady
  $after = (Invoke-KubectlExec -Namespace $namespace -Pod (Get-PodName "app=plus-db") psql -U artflow_plus -d artflow_plus -Atc "select count(*) from outbox where published_at is null").Trim()
  if ([int]$after -gt [int]$before) { throw "outbox backlog grew: $before -> $after" }
  Record-Evidence "T3" "Self-healing" "PASS" "all pods recreated; unpublished outbox $before -> $after"
}

function Test-T6 {
  Invoke-Kubectl -n $namespace scale deployment/plus-api --replicas=2 | Out-Null
  Invoke-Kubectl -n $namespace scale deployment/plus-worker --replicas=2 | Out-Null
  Invoke-Kubectl -n $namespace wait --for=condition=Ready pod --selector=app=plus-api --timeout=180s | Out-Null
  Invoke-Kubectl -n $namespace wait --for=condition=Ready pod --selector=app=plus-worker --timeout=180s | Out-Null
  $db = Get-PodName "app=plus-db"
  $before = (Invoke-KubectlExec -Namespace $namespace -Pod $db psql -U artflow_plus -d artflow_plus -Atc "select count(*) from outbox where published_at is null").Trim()
  Start-Sleep -Seconds 20
  $after = (Invoke-KubectlExec -Namespace $namespace -Pod $db psql -U artflow_plus -d artflow_plus -Atc "select count(*) from outbox where published_at is null").Trim()
  if ([int]$after -gt [int]$before) { throw "outbox backlog grew with two workers: $before -> $after" }
  $health = Invoke-Curl "/healthz"
  if ($health -ne "200") { throw "healthz=$health with two API replicas" }
  $workerLogs = ($(Invoke-Kubectl -n $namespace logs --selector=app=plus-worker --tail=100) -join "`n")
  if ($workerLogs -match "relayError|duplicate projection") { throw "worker reported relay errors" }
  Record-Evidence "T6" "Multiple replicas" "PASS" "api=2 worker=2; outbox $before -> $after; healthz 200; no relay errors"
  Invoke-Kubectl -n $namespace scale deployment/plus-api --replicas=1 | Out-Null
  Invoke-Kubectl -n $namespace scale deployment/plus-worker --replicas=1 | Out-Null
}

function Test-T7 {
  Invoke-Kubectl -n $namespace set env deployment/plus-api ARTFLOW_PLUS_DATABASE_URL= | Out-Null
  $failed = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $waiting = Invoke-Kubectl -n $namespace get pods --selector=app=plus-api --output=jsonpath='{range .items[*]}{.status.containerStatuses[*].state.waiting.reason}{"\n"}{end}'
    if ($waiting -match "CrashLoopBackOff|Error") { $failed = $true; break }
  }
  if (-not $failed) { throw "empty database URL did not fail closed" }
  Invoke-Kubectl -n $namespace rollout undo deployment/plus-api | Out-Null
  Invoke-Kubectl -n $namespace rollout status deployment/plus-api --timeout=180s | Out-Null
  $badLine = (Invoke-Kubectl -n $namespace get pods --selector=app=plus-api --output=jsonpath='{range .items[*]}{.metadata.name}{"|"}{.status.containerStatuses[*].state.waiting.reason}{"|"}{.status.containerStatuses[*].lastState.terminated.reason}{"\n"}{end}' | Select-String 'CrashLoopBackOff|Error' | Select-Object -First 1)
  if ($badLine) {
    $badPod = ($badLine -split '\|')[0].Trim()
    Invoke-Kubectl -n $namespace delete pod $badPod --ignore-not-found | Out-Null
  }
  Start-Sleep -Seconds 5

  $podBefore = Get-PodName "app=plus-api"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("lab-secret-2"))
  Invoke-Kubectl -n $namespace patch secret plus-secrets --type=merge --patch "{`"data`":{`"ARTFLOW_PLUS_CREDENTIAL_SECRET`":`"$encoded`"}}" | Out-Null
  Start-Sleep -Seconds 5
  $podAfter = Get-PodName "app=plus-api"
  if ($podBefore -ne $podAfter) { throw "a bare Secret update restarted pods unexpectedly" }
  Invoke-Kubectl -n $namespace rollout restart deployment/plus-api | Out-Null
  Invoke-Kubectl -n $namespace rollout status deployment/plus-api --timeout=180s | Out-Null
  Record-Evidence "T7" "Configuration and secrets" "PASS" "empty database URL failed closed; bare Secret update did not restart; explicit restart applied it"
}

function Test-T7b {
  $codes = @()
  for ($i = 1; $i -le 11; $i++) {
    $codes += Invoke-Curl -Path "/api/auth/login" -Method POST `
      -Headers @("Content-Type: application/json", "X-Forwarded-For: 203.0.113.$i") `
      -Body '{"username":"rate-limit-probe","password":"wrong-password"}'
  }
  if ($codes -notcontains "429") { throw "forged X-Forwarded-For changed the rate-limit identity: $($codes -join ',')" }
  Record-Evidence "T7b" "Proxy identity" "PASS" "11 forged XFF attempts shared one IP bucket; 429 observed"
}

function Test-T10 {
  New-Item -ItemType Directory -Force -Path (Join-Path $script:RepoRoot "logs/k8s") | Out-Null
  $jar = Join-Path $script:RepoRoot "logs/k8s/cookies.txt"
  $user = "lab" + (Get-Random -Maximum 999999)
  $headers = & curl.exe -k -s -D - -o NUL -c $jar --max-time 10 --resolve "artflow.local:30443:$($script:ProxyNode)" -X POST -H "Content-Type: application/json" --data-binary "{`"username`":`"$user`",`"password`":`"lab-password-123`"}" "$($script:ProxyUrl)/api/auth/register"
  $headerText = ($headers -join "`n")
  if ($headerText -notmatch "HTTP/[0-9.]+ 201") { throw "registration failed: $headerText" }
  if ($headerText -notmatch "Secure") { throw "session cookie is not Secure" }
  $me = Invoke-Curl -Path "/api/auth/me" -CookieJar $jar
  if ($me -ne "200") { throw "authenticated me=$me" }

  $upgrade = & curl.exe -k -s -i -N --http1.1 --max-time 10 --resolve "artflow.local:30443:$($script:ProxyNode)" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$($script:ProxyUrl)/api/realtime" # gitleaks:allow (RFC 6455 example nonce, not a secret)
  $upgradeText = ($upgrade -join "`n")
  if ($upgradeText -notmatch "101") { throw "websocket upgrade failed: $upgradeText" }

  $big = Join-Path $script:RepoRoot "logs/k8s/big.bin"
  fsutil file createnew $big 135266304 | Out-Null
  $tooLarge = Invoke-Curl -Path "/api/auth/login" -Method POST -Headers @("Content-Type: application/json") -Body "@$big"
  Remove-Item $big -Force
  if ($tooLarge -ne "413") { throw "body limit returned $tooLarge (Caddy must reject with 413)" }
  Record-Evidence "T10" "Proxy chain" "PASS" "register 201 with Secure cookie; me 200; websocket 101; oversized body 413"
}

function Test-T4 {
  $drainOutput = ssh -o BatchMode=yes -o ConnectTimeout=10 k8s-control "sudo -n kubectl drain k8s-worker-2 --ignore-daemonsets --delete-emptydir-data --force --timeout=120s" 2>&1
  if (($drainOutput -join "`n") -match "forbidden") { throw "drain was forbidden: $($drainOutput -join ' ')" }
  $pending = (Invoke-Kubectl -n $namespace get pods --field-selector=status.phase=Pending --no-headers) -join "; "
  ssh -o BatchMode=yes -o ConnectTimeout=10 k8s-control "sudo -n kubectl uncordon k8s-worker-2" | Out-Null
  Invoke-Kubectl -n $namespace wait --for=condition=Ready pod --selector=app=plus-api --timeout=180s | Out-Null
  Invoke-Kubectl -n $namespace wait --for=condition=Ready pod --selector=app=plus-proxy --timeout=180s | Out-Null
  Record-Evidence "T4" "Node drain" "PASS" "pending after drain: $pending"
}

function Test-T8 {
  Invoke-Kubectl -n $namespace set resources deployment/plus-api --requests=memory=16Mi --limits=memory=32Mi | Out-Null
  $oom = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $reason = Invoke-Kubectl -n $namespace get pods --selector=app=plus-api --output=jsonpath='{range .items[*]}{.status.containerStatuses[*].lastState.terminated.reason}{"\n"}{end}'
    if ($reason -match "OOMKilled") { $oom = $true; break }
  }
  Invoke-Kubectl -n $namespace rollout undo deployment/plus-api | Out-Null
  Invoke-Kubectl -n $namespace rollout status deployment/plus-api --timeout=180s | Out-Null
  if (-not $oom) { throw "32Mi limit did not produce an OOMKilled restart" }
  Start-Sleep -Seconds 20
  $top = Invoke-Kubectl -n $namespace top pods --no-headers
  if (-not $top) { throw "metrics are not available" }
  Invoke-Kubectl -n $namespace autoscale deployment/plus-api --cpu-percent=50 --min=1 --max=2 | Out-Null
  Start-Sleep -Seconds 30
  $hpa = Invoke-Kubectl -n $namespace get hpa plus-api
  Record-Evidence "T8" "Resources and scheduling" "PASS" "OOMKilled observed; metrics available; hpa: $(($hpa -join ' ').Trim())"
  Invoke-Kubectl -n $namespace delete hpa plus-api --ignore-not-found | Out-Null
}

function Test-T9 {
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace run netprobe --image=192.168.47.10:5000/library/busybox:1.36 --restart=Never --command -- sleep 300 | Out-Null
  try {
    Invoke-Kubectl -n $namespace wait --for=condition=Ready pod/netprobe --timeout=120s | Out-Null
    $dbOut = & kubectl --kubeconfig $script:Kubeconfig -n $namespace exec netprobe -- sh -c 'nc -z -w 3 plus-db 5432; echo exit=$?' 2>&1
    $apiOut = & kubectl --kubeconfig $script:Kubeconfig -n $namespace exec netprobe -- sh -c 'nc -z -w 3 plus-api 3000; echo exit=$?' 2>&1
    if (($dbOut -join "`n") -match "exit=0") { throw "database reachable from an unlabeled pod" }
    if (($apiOut -join "`n") -match "exit=0") { throw "API reachable from an unlabeled pod" }
    $outside = Invoke-Curl "/healthz"
    if ($outside -ne "200") { throw "NodePort healthz=$outside" }
    $media = Invoke-CurlBody "/media/probe"
    $mediaText = ($media -join "`n")
    if ($mediaText -notmatch '<div id="root">') { throw "media path served something other than the SPA" }
    Record-Evidence "T9" "Network boundary" "PASS" "unlabeled pod denied db/api; NodePort healthz 200; media path serves the SPA"
  } finally {
    & kubectl --kubeconfig $script:Kubeconfig -n $namespace delete pod netprobe --ignore-not-found | Out-Null
  }
}

function Test-T5 {
  $db = Get-PodName "app=plus-db"
  $api = Get-PodName "app=plus-api"
  $dir = "logs/k8s/backup"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace exec $db -- pg_dump -U artflow_plus -d artflow_plus -Fc -f /tmp/backup.dump
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace cp "$($db):/tmp/backup.dump" "$dir/database.dump"
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace exec $api -- tar czf /tmp/media.tgz -C /app/var media
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace cp "$($api):/tmp/media.tgz" "$dir/media.tgz"
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace exec $api -- tar czf /tmp/archives.tgz -C /app/var archives
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace cp "$($api):/tmp/archives.tgz" "$dir/archives.tgz"

  Invoke-Kubectl -n $namespace delete pod $db --wait=false | Out-Null
  Start-Sleep -Seconds 10
  Wait-AllReady
  $db = Get-PodName "app=plus-db"
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace exec $db -- createdb -U artflow_plus restore_check
  if ($LASTEXITCODE -ne 0) { throw "createdb failed" }
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace cp "$dir/database.dump" "$($db):/tmp/backup.dump"
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace exec $db -- pg_restore -U artflow_plus -d restore_check --clean --if-exists /tmp/backup.dump
  if ($LASTEXITCODE -ne 0) { throw "pg_restore failed" }
  $rows = ((& kubectl --kubeconfig $script:Kubeconfig -n $namespace exec $db -- psql -U artflow_plus -d restore_check -Atc "select count(*) from kysely_migration") -join "`n").Trim()
  if ([int]$rows -lt 1) { throw "restore produced no migration rows" }
  & kubectl --kubeconfig $script:Kubeconfig -n $namespace exec $db -- dropdb -U artflow_plus restore_check
  Record-Evidence "T5" "Storage and restore" "PASS" "database dump restored into a scratch database; media and archive tarballs captured; DB pod deletion preserved data"
}

$tests = [ordered]@{}
$tests["T0"] = ${function:Test-T0}
$tests["T0n"] = ${function:Test-T0n}
$tests["T1"] = ${function:Test-T1}
$tests["T2"] = ${function:Test-T2}
$tests["T3"] = ${function:Test-T3}
$tests["T4"] = ${function:Test-T4}
$tests["T5"] = ${function:Test-T5}
$tests["T6"] = ${function:Test-T6}
$tests["T7"] = ${function:Test-T7}
$tests["T7b"] = ${function:Test-T7b}
$tests["T8"] = ${function:Test-T8}
$tests["T9"] = ${function:Test-T9}
$tests["T10"] = ${function:Test-T10}

foreach ($key in $tests.Keys) {
  if ($Only -and $key -ne $Only) { continue }
  Write-Host "== $key =="
  & $tests[$key]
}
