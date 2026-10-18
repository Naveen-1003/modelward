<#
.SYNOPSIS
  End-to-end smoke test for ModelWard (Windows PowerShell 5.1 or PowerShell 7).

.DESCRIPTION
  Drives the real HTTP API through the whole governance lifecycle and prints one
  PASS / FAIL / SKIP line per check, then a summary. Exit code is 1 if any check
  failed, otherwise 0.

  Safe to re-run: every run creates uniquely named users and models. It never
  deletes anything; it restores the thresholds it temporarily changes.

  Rate limits: a run makes about 6 signup calls and 3 failed-login calls from
  your IP. The server's per-IP limiters (defaults: SIGNUP_MAX_PER_HOUR=20,
  LOGIN_MAX_FAILURES=10 per 15 min) therefore allow only a few runs in a row.
  If you see HTTP 429, wait for the window to pass, restart the local server,
  or raise those two variables in server/.env while developing.

  Needs: curl.exe (ships with Windows 10+) for multipart uploads, and a running
  stack (MongoDB + metrics service + API). The metrics service must be running
  or the upload steps will fail.

.PARAMETER Api
  API base URL including /api. Default http://127.0.0.1:5000/api. For production
  use https://<your-api>.onrender.com/api (or your Vercel URL + /api if you proxy).

.PARAMETER AdminCode / ComplianceCode
  Invite codes for self-signup of an admin / compliance officer. Default to the
  ADMIN_INVITE_CODE / COMPLIANCE_INVITE_CODE environment variables.

.PARAMETER AdminEmail / AdminPassword / ComplianceEmail / CompliancePassword
  Existing accounts to log in with instead of signing up (use these against
  production where you do not want to hand out invite codes).

.PARAMETER WakeSeconds
  How long to wait for a sleeping (Render free tier) API to answer. Default 90.

.EXAMPLE
  $env:ADMIN_INVITE_CODE = "dev-admin"; $env:COMPLIANCE_INVITE_CODE = "dev-compliance"
  .\smoke_test.ps1

.EXAMPLE
  .\smoke_test.ps1 -Api https://modelward-api.onrender.com/api `
    -AdminEmail admin@example.com -AdminPassword '...' `
    -ComplianceEmail reviewer@example.com -CompliancePassword '...'
#>
[CmdletBinding()]
param(
  [string]$Api = "http://127.0.0.1:5000/api",
  [string]$AdminCode = $env:ADMIN_INVITE_CODE,
  [string]$ComplianceCode = $env:COMPLIANCE_INVITE_CODE,
  [string]$AdminEmail,
  [string]$AdminPassword,
  [string]$ComplianceEmail,
  [string]$CompliancePassword,
  [string]$SampleDir,
  [int]$WakeSeconds = 90
)

$ErrorActionPreference = "Continue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$Api = $Api.TrimEnd("/")
if (-not $SampleDir) {
  if ($PSScriptRoot) { $SampleDir = $PSScriptRoot }
  elseif ($MyInvocation.MyCommand.Path) { $SampleDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
  else { $SampleDir = (Get-Location).Path }
}
$stamp = (Get-Date -Format "yyyyMMddHHmmssfff")
$pw = "SmokeTest!123"
$script:Pass = 0
$script:Fail = 0
$script:Skip = 0

# ---------------------------------------------------------------- helpers ---
function Short($resp) {
  $raw = "$($resp.Raw)"
  if ($raw.Length -gt 160) { $raw = $raw.Substring(0, 160) + "..." }
  return "HTTP $($resp.Status) $raw"
}

function Check([string]$name, [bool]$ok, [string]$detail = "") {
  if ($ok) {
    $script:Pass++
    Write-Host "[PASS] $name" -ForegroundColor Green
  } else {
    $script:Fail++
    Write-Host "[FAIL] $name -- $detail" -ForegroundColor Red
  }
}

function Skip([string]$name, [string]$why) {
  $script:Skip++
  Write-Host "[SKIP] $name -- $why" -ForegroundColor Yellow
}

function Expect([string]$name, $resp, [int[]]$codes) {
  $ok = $codes -contains $resp.Status
  if ($ok) { Check "$name (HTTP $($resp.Status))" $true }
  else { Check $name $false ("expected " + ($codes -join "/") + ", got " + (Short $resp)) }
}

# JSON request; returns { Status, Data, Raw, Headers }. Never throws.
function Invoke-Api([string]$method, [string]$path, [string]$token = "", $body = $null) {
  $headers = @{}
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  $p = @{ Uri = "$Api$path"; Method = $method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 180 }
  if ($null -ne $body) {
    if ($body -is [string]) { $json = $body } else { $json = ($body | ConvertTo-Json -Depth 6 -Compress) }
    $p["Body"] = [System.Text.Encoding]::UTF8.GetBytes($json)
    $p["ContentType"] = "application/json"
  }
  $status = 0; $text = ""; $respHeaders = $null
  try {
    $r = Invoke-WebRequest @p
    $status = [int]$r.StatusCode
    $text = $r.Content
    $respHeaders = $r.Headers
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) {
      return [pscustomobject]@{ Status = 0; Data = $null; Raw = $_.Exception.Message; Headers = $null }
    }
    $status = [int]$resp.StatusCode
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $text = $_.ErrorDetails.Message
    } else {
      try {
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $text = $sr.ReadToEnd()
        $sr.Close()
      } catch {}
    }
  }
  $data = $null
  try { if ($text) { $data = $text | ConvertFrom-Json } } catch {}
  return [pscustomobject]@{ Status = $status; Data = $data; Raw = $text; Headers = $respHeaders }
}

# Multipart POST via curl.exe (PS 5.1 has no Invoke-WebRequest -Form).
function Invoke-Upload([string]$path, [string]$token, [string[]]$fields) {
  $curlArgs = @("-s", "--max-time", "180", "-X", "POST", "-w", "|%{http_code}", "-H", "Authorization: Bearer $token")
  foreach ($f in $fields) { $curlArgs += "-F"; $curlArgs += $f }
  $curlArgs += "$Api$path"
  $out = ((& curl.exe @curlArgs) -join "`n")
  $i = $out.LastIndexOf("|")
  $code = 0; $text = $out
  if ($i -ge 0) {
    $text = $out.Substring(0, $i)
    [void][int]::TryParse($out.Substring($i + 1), [ref]$code)
  }
  $data = $null
  try { if ($text) { $data = $text | ConvertFrom-Json } } catch {}
  return [pscustomobject]@{ Status = $code; Data = $data; Raw = $text; Headers = $null }
}

# Upload responses are { version } (older builds returned the version itself).
function Get-Ver($resp) {
  if ($resp.Data -and $resp.Data.PSObject.Properties.Name -contains "version") { return $resp.Data.version }
  return $resp.Data
}
function Get-Mod($resp) {
  if ($resp.Data -and $resp.Data.PSObject.Properties.Name -contains "model") { return $resp.Data.model }
  return $resp.Data
}
function Get-VersionStatus([string]$id, [string]$token) {
  $r = Invoke-Api GET "/versions/$id" $token
  if ($r.Data -and $r.Data.version) { return [string]$r.Data.version.status }
  return "?"
}
function Has-Prop($obj, [string]$name) {
  return ($null -ne $obj) -and ($obj.PSObject.Properties.Name -contains $name)
}
function Login-Token([string]$email, [string]$password) {
  $r = Invoke-Api POST "/auth/login" "" @{ email = $email; password = $password }
  if ($r.Status -eq 200 -and $r.Data.token) { return [string]$r.Data.token }
  return ""
}

$tmpDir = Join-Path ([IO.Path]::GetTempPath()) "mw_smoke_$stamp"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
  $goodCsv = Join-Path $SampleDir "good_predictions.csv"
  $badCsv = Join-Path $SampleDir "bad_predictions.csv"
  $joblib = Join-Path $SampleDir "dummy_model.joblib"
  $modelData = Join-Path $SampleDir "model_dataset.csv"
  $mismatch = Join-Path $SampleDir "mismatched_dataset.csv"
  foreach ($f in @($goodCsv, $badCsv, $joblib, $modelData, $mismatch)) {
    if (-not (Test-Path $f)) { Write-Host "Missing sample file: $f" -ForegroundColor Red; exit 1 }
  }
  $wrongCsv = Join-Path $tmpDir "wrong_columns.csv"
  Set-Content -Path $wrongCsv -Value "a,b`n1,2`n3,4" -Encoding ASCII

  # ------------------------------------------------------------ preflight ---
  Write-Host "`n=== Preflight: $Api ===" -ForegroundColor Cyan
  $cfgResp = $null
  $deadline = (Get-Date).AddSeconds($WakeSeconds)
  do {
    $cfgResp = Invoke-Api GET "/config"
    if ($cfgResp.Status -eq 200 -and (Has-Prop $cfgResp.Data "maxUploadMb")) { break }
    Write-Host "  waiting for API ($(Short $cfgResp))..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)
  if (-not ($cfgResp.Status -eq 200 -and (Has-Prop $cfgResp.Data "maxUploadMb"))) {
    Check "API reachable and /config answers" $false (Short $cfgResp)
    Write-Host "`nCannot continue without a reachable API." -ForegroundColor Red
    exit 1
  }
  Check "API reachable and /config answers" $true
  $cfg = $cfgResp.Data
  $allowFiles = [bool]$cfg.allowModelFiles
  $simEnabled = [bool]$cfg.enableDriftSimulation
  $storageMode = [string]$cfg.storageMode
  Write-Host "  config: allowModelFiles=$allowFiles enableDriftSimulation=$simEnabled storageMode=$storageMode minPasswordLength=$($cfg.minPasswordLength)"
  Check "/config lists roles that need an invite code" (($cfg.signupRolesRequiringCode -contains "admin") -and ($cfg.signupRolesRequiringCode -contains "compliance_officer")) (Short $cfgResp)

  $origin = $Api -replace "/api$", ""
  # /health lives at the server root, so it is not reachable through a /api-only proxy.
  $healthUrl = "$origin/health"
  try {
    $hr = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 60
    $hj = $hr.Content | ConvertFrom-Json
    Check "GET /health reports db up" ($hj.ok -eq $true) $hr.Content
  } catch {
    Skip "GET /health reports db up" "not reachable at $healthUrl (proxied /api only?)"
  }

  # ------------------------------------------------------ signup / login ---
  Write-Host "`n=== Signup gating and login ===" -ForegroundColor Cyan
  $mlEmail = "smoke.ml.$stamp@modelward.test"
  $ml2Tok = ""   # second ML engineer, created by the admin later (saves signup-limiter budget)

  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Admin"; email = "smoke.nocode.$stamp@modelward.test"; password = $pw; role = "admin" }
  Expect "Admin signup without invite code is refused" $r @(403)
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Admin"; email = "smoke.wrongcode.$stamp@modelward.test"; password = $pw; role = "admin"; inviteCode = "definitely-wrong-$stamp" }
  Expect "Admin signup with wrong invite code is refused" $r @(403)
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Short"; email = "smoke.short.$stamp@modelward.test"; password = "short"; role = "ml_engineer" }
  Expect "Signup with a too-short password is refused" $r @(400)

  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke ML"; email = $mlEmail; password = $pw; role = "ml_engineer" }
  Expect "ML engineer signup" $r @(201)
  $mlTok = ""
  if ($r.Data) { $mlTok = [string]$r.Data.token }
  if (-not $mlTok) { Write-Host "Cannot continue without an ML engineer token." -ForegroundColor Red; exit 1 }
  $mlId = [string]$r.Data.user.id

  $r = Invoke-Api POST "/auth/login" "" @{ email = $mlEmail; password = $pw }
  Expect "Login with correct credentials" $r @(200)
  $r = Invoke-Api POST "/auth/login" "" @{ email = $mlEmail; password = "wrong-password-$stamp" }
  Expect "Login with a wrong password" $r @(401)
  $r = Invoke-Api POST "/auth/login" "" '{"email":{"$gt":""},"password":"password123"}'
  Expect "NoSQL operator in login email is a 400, not a 500" $r @(400)
  $r = Invoke-Api GET "/auth/me" $mlTok
  Check "GET /auth/me returns the ML engineer" (($r.Status -eq 200) -and ($r.Data.user.role -eq "ml_engineer")) (Short $r)
  $r = Invoke-Api GET "/models"
  Expect "Protected route without a token" $r @(401)
  $r = Invoke-Api GET "/models" "not.a.real.token"
  Expect "Protected route with a garbage token" $r @(401)
  $r = Invoke-Api GET "/no-such-route" $mlTok
  Check "Unknown API route returns JSON 404" (($r.Status -eq 404) -and (Has-Prop $r.Data "error")) (Short $r)

  # Compliance officer
  $coTok = ""
  if ($ComplianceEmail -and $CompliancePassword) {
    $coTok = Login-Token $ComplianceEmail $CompliancePassword
    Check "Compliance officer login (existing account)" ($coTok -ne "") "login failed for $ComplianceEmail"
  } elseif ($ComplianceCode) {
    $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Reviewer"; email = "smoke.co.$stamp@modelward.test"; password = $pw; role = "compliance_officer"; inviteCode = $ComplianceCode }
    Expect "Compliance officer signup with invite code" $r @(201)
    if ($r.Data) { $coTok = [string]$r.Data.token }
  } else {
    Skip "Compliance officer account" "no -ComplianceCode / -ComplianceEmail given; review, deploy and monitoring steps will be skipped"
  }
  $haveCo = ($coTok -ne "")

  # Admin
  $adTok = ""
  if ($AdminEmail -and $AdminPassword) {
    $adTok = Login-Token $AdminEmail $AdminPassword
    Check "Admin login (existing account)" ($adTok -ne "") "login failed for $AdminEmail"
  } elseif ($AdminCode) {
    $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Admin"; email = "smoke.admin.$stamp@modelward.test"; password = $pw; role = "admin"; inviteCode = $AdminCode }
    Expect "Admin signup with invite code" $r @(201)
    if ($r.Data) { $adTok = [string]$r.Data.token }
  } else {
    Skip "Admin account" "no -AdminCode / -AdminEmail given; admin-only steps will be skipped"
  }
  $haveAdmin = ($adTok -ne "")
  if ($haveAdmin) {
    $ml2Email = "smoke.ml2.$stamp@modelward.test"
    $r = Invoke-Api POST "/users" $adTok @{ name = "Smoke ML Two"; email = $ml2Email; password = $pw; role = "ml_engineer" }
    if ($r.Status -eq 201) { $ml2Tok = Login-Token $ml2Email $pw }
    Check "Admin creates a second ML engineer (for ownership checks)" ($ml2Tok -ne "") (Short $r)
  }

  # ------------------------------------------------------------- RBAC ---
  Write-Host "`n=== RBAC spot checks ===" -ForegroundColor Cyan
  $r = Invoke-Api GET "/users" $mlTok
  Expect "ML engineer cannot list users" $r @(403)
  $r = Invoke-Api GET "/trash" $mlTok
  Expect "ML engineer cannot open Trash" $r @(403)
  $r = Invoke-Api PUT "/settings" $mlTok @{ lowAccuracy = 0.85; lowFairnessGap = 0.1; mediumAccuracy = 0.7; mediumFairnessGap = 0.2; driftThreshold = 0.1 }
  Expect "ML engineer cannot change settings" $r @(403)
  $r = Invoke-Api GET "/audit-log/verify" $mlTok
  Expect "ML engineer cannot verify the audit chain" $r @(403)
  $r = Invoke-Api GET "/audit-log/export" $mlTok
  Expect "ML engineer cannot export the audit log" $r @(403)
  if ($haveCo) {
    $r = Invoke-Api POST "/models" $coTok @{ name = "Smoke Forbidden $stamp" }
    Expect "Compliance officer cannot create models" $r @(403)
    $r = Invoke-Api GET "/trash" $coTok
    Expect "Compliance officer cannot open Trash" $r @(403)
    $r = Invoke-Api GET "/audit-log/verify" $coTok
    Expect "Compliance officer cannot verify the audit chain (admin only)" $r @(403)
  }
  if ($haveAdmin) {
    $r = Invoke-Api POST "/models/000000000000000000000000/versions" $adTok @{}
    Check "Admin cannot upload versions" ($r.Status -in @(403, 404)) (Short $r)
  }

  # ------------------------------------------------------------- models ---
  Write-Host "`n=== Models ===" -ForegroundColor Cyan
  $modelName = "Smoke Loan Model $stamp"
  $r = Invoke-Api POST "/models" $mlTok @{ name = $modelName; description = "Smoke test model"; useCase = "Credit underwriting" }
  Expect "Create model" $r @(201)
  $model = Get-Mod $r
  $modelId = [string]$model._id
  if (-not $modelId) { Write-Host "Cannot continue without a model." -ForegroundColor Red; exit 1 }
  Check "New model shows displayRiskTier=unrated and no live version" (($model.displayRiskTier -eq "unrated") -and ($null -eq $model.liveVersionNumber)) (Short $r)

  $r = Invoke-Api POST "/models" $mlTok @{ name = $modelName.ToUpper(); description = "dupe" }
  Expect "Duplicate model name (case-insensitive) is a 409" $r @(409)
  $r = Invoke-Api POST "/models" $mlTok @{ name = "Smoke Tier $stamp"; riskTier = "high" }
  Expect "Client-supplied riskTier is refused" $r @(400)
  $r = Invoke-Api POST "/models" $mlTok @{ name = ("x" * 121) }
  Expect "Over-long model name is refused" $r @(400)
  $r = Invoke-Api POST "/models" $mlTok @{ name = "   " }
  Expect "Blank model name is refused" $r @(400)

  $r = Invoke-Api POST "/models" $mlTok @{ name = "Smoke Archive Model $stamp"; description = "Used for archive/restore" }
  Expect "Create second model" $r @(201)
  $model2Id = [string](Get-Mod $r)._id

  $r = Invoke-Api GET "/models?page=1&limit=1" $mlTok
  Check "Models list is paginated" (($r.Status -eq 200) -and (@($r.Data.models).Count -le 1) -and ($r.Data.total -ge 2) -and ($r.Data.pages -ge 2)) (Short $r)
  $r = Invoke-Api GET "/models?q=Smoke%20Loan%20Model%20$stamp" $mlTok
  Check "Models search finds the new model" (($r.Status -eq 200) -and (@($r.Data.models | Where-Object { $_._id -eq $modelId }).Count -eq 1)) (Short $r)
  $r = Invoke-Api GET "/models/$modelId" $mlTok
  Expect "Get model" $r @(200)
  $r = Invoke-Api GET "/models/not-an-object-id" $mlTok
  Expect "Malformed model id is a 400" $r @(400)

  # ----------------------------------------------------------- uploads ---
  Write-Host "`n=== Version uploads ===" -ForegroundColor Cyan
  $upPath = "/models/$modelId/versions"

  $r = Invoke-Upload $upPath $mlTok @("fileType=csv", "latencyMs=12", "datasetNotes=synthetic good predictions", "file=@$goodCsv")
  Expect "Upload good CSV" $r @(201)
  $good = Get-Ver $r
  $goodId = [string]$good._id
  Check "Good CSV lands as draft with low risk" (($good.status -eq "draft") -and ($good.riskTier -eq "low")) (Short $r)
  Check "Good CSV scored by the metrics service (accuracy > 0.9, rows reported)" (($good.metrics.accuracy -gt 0.9) -and ($good.metrics.rows -gt 0)) (Short $r)
  Check "Version JSON hides server file paths" ((-not (Has-Prop $good "filePath")) -and (-not (Has-Prop $good "datasetPath")) -and (Has-Prop $good "hasFile")) (Short $r)
  Check "Version carries initialRiskTier and thresholdsUsed" ((Has-Prop $good "initialRiskTier") -and (Has-Prop $good "thresholdsUsed")) (Short $r)

  $r = Invoke-Upload $upPath $mlTok @("fileType=csv", "latencyMs=-5", "file=@$goodCsv")
  Expect "Negative latency is refused" $r @(400)
  $r = Invoke-Upload $upPath $mlTok @("fileType=csv", "latencyMs=not-a-number", "file=@$goodCsv")
  Expect "Non-numeric latency is refused" $r @(400)
  $r = Invoke-Upload $upPath $mlTok @("fileType=csv", "latencyMs=5", "file=@$joblib")
  Expect "CSV upload with a .joblib file is refused" $r @(400)
  $r = Invoke-Upload $upPath $mlTok @("fileType=csv", "latencyMs=5")
  Expect "Upload without a file is refused" $r @(400)
  $r = Invoke-Upload $upPath $mlTok @("fileType=exe", "latencyMs=5", "file=@$goodCsv")
  Expect "Unknown fileType is refused" $r @(400)
  $r = Invoke-Upload "/models/000000000000000000000000/versions" $mlTok @("fileType=csv", "latencyMs=5", "file=@$goodCsv")
  Expect "Upload to an unknown model is a 404" $r @(404)

  $r = Invoke-Upload $upPath $mlTok @("fileType=csv", "latencyMs=8", "file=@$badCsv")
  Expect "Upload bad CSV" $r @(201)
  $bad = Get-Ver $r
  $badId = [string]$bad._id
  Check "Bad CSV lands as draft with high risk" (($bad.status -eq "draft") -and ($bad.riskTier -eq "high")) (Short $r)
  Check "Version numbers increase" ($bad.versionNumber -gt $good.versionNumber) "v$($good.versionNumber) then v$($bad.versionNumber)"

  $r = Invoke-Upload $upPath $mlTok @("fileType=csv", "latencyMs=8", "file=@$wrongCsv")
  Expect "Upload CSV with wrong columns (saved as failed)" $r @(201)
  $failed = Get-Ver $r
  Check "Wrong-column CSV is upload_failed, not retryable, with an error message" (($failed.status -eq "upload_failed") -and ($failed.retryable -eq $false) -and ($failed.uploadError)) (Short $r)
  $failedId = [string]$failed._id
  if ($failedId) {
    $r = Invoke-Api POST "/versions/$failedId/retry" $mlTok
    Expect "Retry of a non-retryable failure is refused" $r @(400)
    $r = Invoke-Api POST "/versions/$failedId/submit" $mlTok
    Expect "Cannot submit an upload_failed version" $r @(400)
  }

  $joblibId = ""
  if ($allowFiles) {
    $r = Invoke-Upload $upPath $mlTok @("fileType=joblib", "trainingNotes=logistic regression dummy", "file=@$joblib", "datasetFile=@$modelData")
    Expect "Upload joblib model + dataset" $r @(201)
    $jv = Get-Ver $r
    $joblibId = [string]$jv._id
    Check "Joblib version scored with real latency" (($jv.status -eq "draft") -and ($jv.metrics.computedBy -eq "microservice") -and ($null -ne $jv.metrics.latencyMs)) (Short $r)
    $r = Invoke-Upload $upPath $mlTok @("fileType=joblib", "file=@$joblib", "datasetFile=@$mismatch")
    Expect "Upload joblib with mismatched dataset (saved as failed)" $r @(201)
    $mv = Get-Ver $r
    Check "Mismatched dataset is upload_failed with a message" (($mv.status -eq "upload_failed") -and ($mv.uploadError)) (Short $r)
    $r = Invoke-Upload $upPath $mlTok @("fileType=joblib", "file=@$joblib")
    Check "Joblib without a dataset is refused or saved as failed" (($r.Status -eq 400) -or ((Get-Ver $r).status -eq "upload_failed")) (Short $r)
  } else {
    $r = Invoke-Upload $upPath $mlTok @("fileType=joblib", "file=@$joblib", "datasetFile=@$modelData")
    Expect "Joblib upload is refused (model files disabled on this deployment)" $r @(400)
    Skip "Joblib scoring steps" "allowModelFiles=false"
  }

  $r = Invoke-Api GET "/models/$modelId/versions" $mlTok
  Check "Versions list returns newest first" (($r.Status -eq 200) -and (@($r.Data.versions).Count -ge 3) -and ($r.Data.versions[0].versionNumber -gt $r.Data.versions[-1].versionNumber)) (Short $r)

  $r = Invoke-Api GET "/versions/$goodId" $mlTok
  Check "Version detail includes compliance and snapshots" (($r.Status -eq 200) -and (Has-Prop $r.Data "compliance") -and (Has-Prop $r.Data "snapshots") -and ($r.Data.version.modelId.name -eq $modelName)) (Short $r)
  Check "Compliance block has score and checks" (($null -ne $r.Data.compliance.score) -and (@($r.Data.compliance.checks).Count -ge 2)) (Short $r)

  $r = Invoke-Api PATCH "/versions/$goodId/notes" $mlTok @{ datasetNotes = "edited by smoke test"; trainingNotes = "n/a" }
  Expect "Edit notes on a draft" $r @(200)
  $r = Invoke-Api GET "/versions/$goodId/file?which=model" $mlTok
  if ($storageMode -eq "local") { Expect "Download retained model file" $r @(200) }
  else { Expect "Download is 404 when storage discards files" $r @(404) }

  # -------------------------------------------------------- comments ---
  Write-Host "`n=== Comments ===" -ForegroundColor Cyan
  $r = Invoke-Api POST "/versions/$goodId/comments" $mlTok @{ body = "Smoke comment from the ML engineer" }
  Expect "Post a comment" $r @(201)
  $r = Invoke-Api POST "/versions/$goodId/comments" $mlTok @{ body = "" }
  Expect "Empty comment is refused" $r @(400)
  $r = Invoke-Api POST "/versions/$goodId/comments" $mlTok @{ body = ("c" * 2001) }
  Expect "Over-long comment is refused" $r @(400)
  $r = Invoke-Api POST "/versions/$goodId/comments" $mlTok @{ body = 42 }
  Expect "Non-string comment is a 400, not a 500" $r @(400)
  $r = Invoke-Api GET "/versions/$goodId/comments" $mlTok
  Check "Comments list contains the comment with author info" (($r.Status -eq 200) -and (@($r.Data.comments).Count -ge 1) -and ($r.Data.comments[0].authorRole -eq "ml_engineer")) (Short $r)

  # --------------------------------------------- archive / restore: version ---
  Write-Host "`n=== Archive and restore (version) ===" -ForegroundColor Cyan
  $r = Invoke-Upload $upPath $mlTok @("fileType=csv", "latencyMs=9", "file=@$goodCsv")
  $tmpV = Get-Ver $r
  $tmpVid = [string]$tmpV._id
  Check "Upload a throwaway version" (($r.Status -eq 201) -and ($tmpVid)) (Short $r)
  if ($tmpVid) {
    $r = Invoke-Api POST "/versions/$tmpVid/submit" $mlTok
    Expect "Submit throwaway version" $r @(200)
    $r = Invoke-Api POST "/versions/$tmpVid/withdraw" $mlTok
    Expect "Withdraw returns it to draft" $r @(200)
    Check "Status is draft after withdraw" ((Get-VersionStatus $tmpVid $mlTok) -eq "draft") "status differs"
    if ($ml2Tok) {
      $r = Invoke-Api DELETE "/versions/$tmpVid" $ml2Tok @{ reason = "not mine" }
      Check "Another ML engineer cannot archive it (403/404)" ($r.Status -in @(403, 404)) (Short $r)
    } else {
      Skip "Another ML engineer cannot archive it" "needs an admin account to create a second user"
    }
    $r = Invoke-Api DELETE "/versions/$tmpVid" $mlTok @{ reason = "smoke test cleanup" }
    Expect "Owner archives the draft" $r @(200)
    $r = Invoke-Api GET "/versions/$tmpVid" $mlTok
    Expect "Archived version is hidden from normal reads" $r @(404)
    $r = Invoke-Api GET "/models/$modelId/versions" $mlTok
    Check "Archived version is absent from the model's list" (@($r.Data.versions | Where-Object { $_._id -eq $tmpVid }).Count -eq 0) (Short $r)
    if ($haveAdmin) {
      $r = Invoke-Api GET "/trash" $adTok
      Check "Trash lists the archived version with its reason" (($r.Status -eq 200) -and (@($r.Data.versions | Where-Object { $_._id -eq $tmpVid -and $_.deleteReason -eq "smoke test cleanup" }).Count -eq 1)) (Short $r)
    } else {
      Skip "Trash lists the archived version" "no admin account"
    }
    $r = Invoke-Api POST "/versions/$tmpVid/restore" $mlTok
    Expect "Owner restores the version" $r @(200)
    Check "Restored version is back as draft" ((Get-VersionStatus $tmpVid $mlTok) -eq "draft") "status differs"
  }

  # ---------------------------------------------- review / deploy lifecycle ---
  $lifecycleOk = $false
  if (-not $haveCo) {
    Skip "Review, deploy, drift and monitoring lifecycle" "no compliance account"
  } else {
    Write-Host "`n=== Review workflow ===" -ForegroundColor Cyan
    $r = Invoke-Api POST "/versions/$goodId/deploy" $coTok
    Expect "Cannot deploy a draft" $r @(400)
    $r = Invoke-Api POST "/versions/$goodId/review" $coTok @{ decision = "approve" }
    Expect "Cannot review a draft (not submitted)" $r @(400)

    $r = Invoke-Api POST "/versions/$goodId/submit" $mlTok
    Expect "Submit good version" $r @(200)
    $r = Invoke-Api POST "/versions/$goodId/submit" $mlTok
    Expect "Submitting twice is refused" $r @(400)
    $r = Invoke-Api POST "/versions/$badId/submit" $mlTok
    Expect "Submit bad (high-risk) version" $r @(200)

    $r = Invoke-Api GET "/versions?status=submitted&limit=100" $coTok
    Check "Review queue lists both submitted versions with model name" (($r.Status -eq 200) -and (@($r.Data.versions | Where-Object { $_._id -eq $goodId -and $_.modelId.name -eq $modelName }).Count -eq 1) -and (@($r.Data.versions | Where-Object { $_._id -eq $badId }).Count -eq 1)) (Short $r)

    $r = Invoke-Api POST "/versions/$goodId/review" $mlTok @{ decision = "approve" }
    Expect "ML engineer cannot review (RBAC)" $r @(403)
    $r = Invoke-Api POST "/versions/$badId/review" $coTok @{ decision = "approve" }
    Expect "Approve high-risk without a comment is refused" $r @(400)
    $r = Invoke-Api POST "/versions/$badId/review" $coTok @{ decision = "approve"; comment = "   " }
    Expect "Approve high-risk with a blank comment is refused" $r @(400)
    $r = Invoke-Api POST "/versions/$badId/review" $coTok @{ decision = "reject" }
    Expect "Reject without a comment is refused" $r @(400)
    $r = Invoke-Api POST "/versions/$badId/review" $coTok @{ decision = "request_changes" }
    Expect "Request changes without a comment is refused" $r @(400)
    $r = Invoke-Api POST "/versions/$badId/review" $coTok @{ decision = "approve"; comment = 12345 }
    Expect "Non-string review comment is a 400, not a 500" $r @(400)
    $r = Invoke-Api POST "/versions/$badId/review" $coTok @{ decision = "maybe"; comment = "x" }
    Expect "Unknown review decision is refused" $r @(400)

    $r = Invoke-Api POST "/versions/$badId/review" $coTok @{ decision = "request_changes"; comment = "Please document the dataset and retrain." }
    Expect "Request changes with a comment" $r @(200)
    Check "Status is changes_requested" ((Get-VersionStatus $badId $mlTok) -eq "changes_requested") "status differs"
    $r = Invoke-Api PATCH "/versions/$badId/notes" $mlTok @{ datasetNotes = "Documented after review feedback" }
    Expect "ML engineer edits notes while changes are requested" $r @(200)
    $r = Invoke-Api POST "/versions/$badId/submit" $mlTok
    Expect "Resubmit after changes" $r @(200)
    $r = Invoke-Api POST "/versions/$badId/review" $coTok @{ decision = "approve"; comment = "Reviewed manually; acceptable for pilot with monitoring." }
    Expect "Approve high-risk with a comment" $r @(200)
    Check "Bad version is approved" ((Get-VersionStatus $badId $mlTok) -eq "approved") "status differs"

    $r = Invoke-Api POST "/versions/$goodId/review" $coTok @{ decision = "approve" }
    Expect "Approve low-risk without a comment" $r @(200)
    $r = Invoke-Api POST "/versions/$goodId/deploy" $mlTok
    Expect "ML engineer cannot deploy (RBAC)" $r @(403)

    Write-Host "`n=== Deploy and supersede ===" -ForegroundColor Cyan
    $r = Invoke-Api POST "/versions/$badId/deploy" $coTok
    Expect "Deploy the high-risk version first" $r @(200)
    $r = Invoke-Api POST "/versions/$goodId/deploy" $coTok
    Expect "Deploy the good version (supersedes the previous one)" $r @(200)
    Check "Good version is deployed" ((Get-VersionStatus $goodId $mlTok) -eq "deployed") "status differs"
    Check "Previously deployed version is superseded" ((Get-VersionStatus $badId $mlTok) -eq "superseded") "status differs"
    $r = Invoke-Api GET "/models/$modelId" $mlTok
    Check "Model summary reports the live version" (($r.Status -eq 200) -and ($r.Data.model.liveVersionNumber -eq $good.versionNumber) -and ($r.Data.model.liveVersionStatus -eq "deployed")) (Short $r)
    $r = Invoke-Api POST "/versions/$badId/simulate-drift" $mlTok
    Expect "Cannot simulate drift on a superseded version" $r @(400, 403)
    $r = Invoke-Api DELETE "/versions/$goodId" $mlTok @{ reason = "should be blocked" }
    Expect "Cannot archive a deployed version" $r @(409)
    if ($haveAdmin) {
      $r = Invoke-Api DELETE "/models/$modelId" $adTok @{ reason = "should be blocked" }
      Expect "Cannot archive a model with a live version" $r @(409)
    }
    $r = Invoke-Api POST "/versions/$goodId/retire" $coTok @{}
    Expect "Retire without a comment is refused" $r @(400)

    # ------------------------------------------------------------- drift ---
    Write-Host "`n=== Drift and monitoring ===" -ForegroundColor Cyan
    if ($simEnabled) {
      $reached = $false; $tries = 0; $last = $null
      while (($tries -lt 30) -and (-not $reached)) {
        $tries++
        $last = Invoke-Api POST "/versions/$goodId/simulate-drift" $mlTok
        if ($last.Status -ne 201) { break }
        if ($last.Data.version -and ($last.Data.version.status -eq "needs_review")) { $reached = $true }
      }
      Check "Simulated drift flags the version needs_review (after $tries snapshot(s))" $reached (Short $last)
    } else {
      $r = Invoke-Api POST "/versions/$goodId/simulate-drift" $mlTok
      Expect "Simulate-drift is disabled on this deployment" $r @(403)
      Skip "Simulated drift until needs_review" "enableDriftSimulation=false"
    }

    $r = Invoke-Upload "/versions/$goodId/monitoring-batch" $mlTok @("latencyMs=11", "file=@$goodCsv")
    Expect "Monitoring batch with the good CSV" $r @(201)
    Check "Batch snapshot is recorded as source=batch and not flagged" (($r.Data.snapshot.source -eq "batch") -and ($r.Data.snapshot.flagged -eq $false)) (Short $r)
    $r = Invoke-Upload "/versions/$goodId/monitoring-batch" $mlTok @("file=@$wrongCsv")
    Expect "Monitoring batch with wrong columns is refused" $r @(400)
    $r = Invoke-Upload "/versions/$goodId/monitoring-batch" $mlTok @("latencyMs=11", "file=@$badCsv")
    Expect "Monitoring batch with the bad CSV" $r @(201)
    Check "Degraded batch is flagged and the version needs review" (($r.Data.snapshot.flagged -eq $true) -and ((Get-VersionStatus $goodId $mlTok) -eq "needs_review")) (Short $r)

    $r = Invoke-Api GET "/stats" $mlTok
    Check "Stats list the version under needsReview" (($r.Status -eq 200) -and (@($r.Data.needsReview | Where-Object { $_.versionId -eq $goodId }).Count -eq 1) -and ($r.Data.totals.needsReview -ge 1)) (Short $r)
    $r = Invoke-Api GET "/versions?status=needs_review&limit=100" $coTok
    Check "Needs-review list contains the version" (($r.Status -eq 200) -and (@($r.Data.versions | Where-Object { $_._id -eq $goodId }).Count -eq 1)) (Short $r)
    $r = Invoke-Api GET "/versions/$goodId" $mlTok
    Check "Detail shows batch snapshots with riskTier" (($r.Status -eq 200) -and (@($r.Data.snapshots | Where-Object { $_.source -eq "batch" }).Count -ge 2) -and (Has-Prop $r.Data.snapshots[0] "riskTier")) (Short $r)

    $r = Invoke-Api POST "/versions/$goodId/resolve-review" $mlTok @{ decision = "keep"; comment = "nope" }
    Expect "ML engineer cannot resolve a review (RBAC)" $r @(403)
    $r = Invoke-Api POST "/versions/$goodId/resolve-review" $coTok @{ decision = "keep" }
    Expect "Resolve review without a comment is refused" $r @(400)
    $r = Invoke-Api POST "/versions/$goodId/resolve-review" $coTok @{ decision = "keep"; comment = "Drift investigated; traffic mix changed, model still acceptable." }
    Expect "Resolve review: keep" $r @(200)
    Check "Version is deployed again" ((Get-VersionStatus $goodId $mlTok) -eq "deployed") "status differs"
    $r = Invoke-Api POST "/versions/$goodId/resolve-review" $coTok @{ decision = "keep"; comment = "again" }
    Expect "Resolve review on a deployed version is refused" $r @(400)

    $r = Invoke-Api POST "/versions/$goodId/comments" $coTok @{ body = "Reviewer comment: monitoring looks fine." }
    Expect "Compliance officer comments on the version" $r @(201)
    $r = Invoke-Api GET "/versions/$goodId/comments" $mlTok
    Check "Comments are ordered oldest first with both authors" (($r.Status -eq 200) -and (@($r.Data.comments).Count -ge 2) -and ($r.Data.comments[-1].authorRole -eq "compliance_officer")) (Short $r)

    $r = Invoke-Api POST "/versions/$goodId/retire" $coTok @{ comment = "Replaced by a newer model (smoke test)." }
    Expect "Retire the live version" $r @(200)
    Check "Version is retired" ((Get-VersionStatus $goodId $mlTok) -eq "retired") "status differs"
    $r = Invoke-Api GET "/models/$modelId" $mlTok
    Check "Model no longer has a live version" (($r.Status -eq 200) -and ($null -eq $r.Data.model.liveVersionNumber)) (Short $r)
    $r = Invoke-Api POST "/versions/$goodId/simulate-drift" $mlTok
    Check "Cannot simulate drift on a retired version" ($r.Status -in @(400, 403)) (Short $r)
    $lifecycleOk = $true
  }

  # ------------------------------------------------ archive / restore: model ---
  Write-Host "`n=== Archive and restore (model) ===" -ForegroundColor Cyan
  if (-not $haveAdmin) {
    Skip "Model archive / restore / Trash" "no admin account"
  } else {
    $r = Invoke-Upload "/models/$model2Id/versions" $mlTok @("fileType=csv", "latencyMs=7", "file=@$goodCsv")
    $m2v = [string](Get-Ver $r)._id
    Check "Upload a version to the second model" (($r.Status -eq 201) -and $m2v) (Short $r)
    $r = Invoke-Api DELETE "/models/$model2Id" $mlTok @{ reason = "nope" }
    Expect "ML engineer cannot archive a model" $r @(403)
    $r = Invoke-Api DELETE "/models/$model2Id" $adTok @{ reason = "smoke test" }
    Expect "Admin archives the model" $r @(200)
    $r = Invoke-Api GET "/models/$model2Id" $adTok
    Expect "Archived model is hidden from normal reads" $r @(404)
    $r = Invoke-Api GET "/versions/$m2v" $adTok
    Expect "Its versions are archived with it" $r @(404)
    $r = Invoke-Api GET "/trash" $adTok
    Check "Trash lists the model (cascaded version is folded into it)" (($r.Status -eq 200) -and (@($r.Data.models | Where-Object { $_._id -eq $model2Id }).Count -eq 1) -and (@($r.Data.versions | Where-Object { $_._id -eq $m2v }).Count -eq 0)) (Short $r)
    $r = Invoke-Api POST "/models/$model2Id/restore" $adTok
    Expect "Admin restores the model" $r @(200)
    $r = Invoke-Api GET "/versions/$m2v" $adTok
    Expect "Its cascade-archived version came back" $r @(200)
  }

  # --------------------------------------------------------- stats ---
  Write-Host "`n=== Stats ===" -ForegroundColor Cyan
  $r = Invoke-Api GET "/stats" $mlTok
  Check "Stats have totals, byStatus and byTier" (($r.Status -eq 200) -and ($r.Data.totals.models -ge 2) -and (Has-Prop $r.Data "byStatus") -and (Has-Prop $r.Data.byTier "unrated")) (Short $r)
  Check "Stats hide user counts from non-admins" (-not (Has-Prop $r.Data "users")) (Short $r)
  if ($haveAdmin) {
    $r = Invoke-Api GET "/stats" $adTok
    Check "Stats include user counts for admins" (($r.Status -eq 200) -and ($r.Data.users.total -ge 1)) (Short $r)
  }

  # ---------------------------------------------------------- users ---
  Write-Host "`n=== Admin user management ===" -ForegroundColor Cyan
  if (-not $haveAdmin) {
    Skip "User management" "no admin account"
  } else {
    $newEmail = "smoke.created.$stamp@modelward.test"
    $r = Invoke-Api POST "/users" $adTok @{ name = "Smoke Created"; email = $newEmail; password = $pw; role = "ml_engineer" }
    Expect "Admin creates a user" $r @(201)
    $newId = [string]$r.Data.user.id
    $r = Invoke-Api POST "/users" $adTok @{ name = "Smoke Created"; email = $newEmail; password = $pw; role = "ml_engineer" }
    Expect "Creating a duplicate user is a 409" $r @(409)
    $r = Invoke-Api GET "/users?q=smoke.created.$stamp" $adTok
    Check "User search finds the new user" (($r.Status -eq 200) -and (@($r.Data.users | Where-Object { $_.email -eq $newEmail }).Count -eq 1)) (Short $r)
    $r = Invoke-Api PATCH "/users/$newId" $adTok @{ isActive = $false }
    Expect "Admin deactivates the user" $r @(200)
    $r = Invoke-Api POST "/auth/login" "" @{ email = $newEmail; password = $pw }
    Expect "Deactivated user cannot log in" $r @(403)
    $r = Invoke-Api PATCH "/users/$newId" $adTok @{ isActive = $true; role = "compliance_officer" }
    Expect "Admin reactivates the user and changes the role" $r @(200)
    $r = Invoke-Api POST "/auth/login" "" @{ email = $newEmail; password = $pw }
    Check "Reactivated user can log in with the new role" (($r.Status -eq 200) -and ($r.Data.user.role -eq "compliance_officer")) (Short $r)
    $me = Invoke-Api GET "/auth/me" $adTok
    $myAdminId = [string]$me.Data.user.id
    $r = Invoke-Api PATCH "/users/$myAdminId" $adTok @{ isActive = $false }
    Expect "Admin cannot deactivate themselves" $r @(400)
    $r = Invoke-Api PATCH "/users/$myAdminId" $adTok @{ role = "ml_engineer" }
    Expect "Admin cannot change their own role" $r @(400)
  }

  # ------------------------------------------------------- settings ---
  Write-Host "`n=== Settings round-trip ===" -ForegroundColor Cyan
  if (-not $haveAdmin) {
    Skip "Settings round-trip" "no admin account"
  } else {
    $r = Invoke-Api GET "/settings" $mlTok
    Check "Any signed-in user can read thresholds" (($r.Status -eq 200) -and (Has-Prop $r.Data.settings "driftThreshold")) (Short $r)
    $orig = $r.Data.settings
    $restore = @{
      lowAccuracy = [double]$orig.lowAccuracy; lowFairnessGap = [double]$orig.lowFairnessGap
      mediumAccuracy = [double]$orig.mediumAccuracy; mediumFairnessGap = [double]$orig.mediumFairnessGap
      driftThreshold = [double]$orig.driftThreshold
    }
    try {
      $newDrift = [math]::Round($restore.driftThreshold + 0.01, 3)
      if ($newDrift -gt 1) { $newDrift = [math]::Round($restore.driftThreshold - 0.01, 3) }
      $changed = $restore.Clone()
      $changed.driftThreshold = $newDrift
      $r = Invoke-Api PUT "/settings" $adTok $changed
      Expect "Admin updates thresholds" $r @(200)
      $r = Invoke-Api GET "/settings" $mlTok
      Check "Updated threshold is returned" (($r.Status -eq 200) -and ([math]::Abs([double]$r.Data.settings.driftThreshold - $newDrift) -lt 0.0001)) (Short $r)
      $invalid = $restore.Clone()
      $invalid.lowAccuracy = 0.5
      $invalid.mediumAccuracy = 0.9
      $r = Invoke-Api PUT "/settings" $adTok $invalid
      Expect "lowAccuracy below mediumAccuracy is refused" $r @(400)
      $invalid = $restore.Clone()
      $invalid.driftThreshold = 0
      $r = Invoke-Api PUT "/settings" $adTok $invalid
      Expect "Threshold of 0 is refused" $r @(400)
      $invalid = $restore.Clone()
      $invalid.driftThreshold = "abc"
      $r = Invoke-Api PUT "/settings" $adTok $invalid
      Expect "Non-numeric threshold is refused" $r @(400)
    } finally {
      $r = Invoke-Api PUT "/settings" $adTok $restore
      $back = Invoke-Api GET "/settings" $adTok
      Check "Original thresholds restored" (($r.Status -eq 200) -and ([math]::Abs([double]$back.Data.settings.driftThreshold - $restore.driftThreshold) -lt 0.0001)) (Short $r)
    }
  }

  # ------------------------------------------------------ audit log ---
  Write-Host "`n=== Audit log ===" -ForegroundColor Cyan
  $r = Invoke-Api GET "/audit-log?page=1&limit=5" $mlTok
  Check "ML engineer sees a scoped, paginated audit log" (($r.Status -eq 200) -and ($r.Data.scoped -eq $true) -and (@($r.Data.logs).Count -le 5) -and ($r.Data.total -ge 1) -and (Has-Prop $r.Data "pages")) (Short $r)
  $r = Invoke-Api GET "/audit-log?action=comment&limit=50" $mlTok
  Check "Audit log filters by action" (($r.Status -eq 200) -and (@($r.Data.logs).Count -ge 1) -and (@($r.Data.logs | Where-Object { $_.action -ne "comment" }).Count -eq 0)) (Short $r)
  if ($haveAdmin) {
    $p1 = Invoke-Api GET "/audit-log?page=1&limit=5" $adTok
    Check "Admin sees the unscoped audit log with hashes" (($p1.Status -eq 200) -and ($p1.Data.scoped -ne $true) -and ($p1.Data.total -ge 5) -and (Has-Prop $p1.Data.logs[0] "hash") -and (Has-Prop $p1.Data.logs[0] "seq")) (Short $p1)
    $p2 = Invoke-Api GET "/audit-log?page=2&limit=5" $adTok
    Check "Audit log page 2 differs from page 1" (($p2.Status -eq 200) -and ($p2.Data.logs[0]._id -ne $p1.Data.logs[0]._id)) (Short $p2)
    $r = Invoke-Api GET "/audit-log?action=login_failed&limit=5" $adTok
    Check "Failed logins are audited" (($r.Status -eq 200) -and ($r.Data.total -ge 1)) (Short $r)
    $r = Invoke-Api GET "/audit-log/verify" $adTok
    Check "Audit hash chain verifies" (($r.Status -eq 200) -and ($r.Data.ok -eq $true)) (Short $r)
    $r = Invoke-Api GET "/audit-log/export?limit=50" $adTok
    $ct = ""
    if ($r.Headers) { $ct = [string]$r.Headers["Content-Type"] }
    Check "Admin exports the audit log as CSV" (($r.Status -eq 200) -and ($ct -like "text/csv*")) "HTTP $($r.Status) content-type=$ct"
  } else {
    Skip "Audit log admin view, paging, verify" "no admin account"
  }
  if ($haveCo) {
    $r = Invoke-Api GET "/audit-log?limit=5" $coTok
    Check "Compliance officer sees the unscoped audit log" (($r.Status -eq 200) -and ($r.Data.scoped -ne $true)) (Short $r)
    $r = Invoke-Api GET "/audit-log/export?limit=50" $coTok
    Expect "Compliance officer can export the audit log" $r @(200)
  }
}
finally {
  Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- summary ---
Write-Host ""
Write-Host "=== SMOKE TEST SUMMARY ===" -ForegroundColor Cyan
Write-Host "PASS: $($script:Pass)   FAIL: $($script:Fail)   SKIP: $($script:Skip)"
if ($script:Fail -gt 0) {
  Write-Host "RESULT: FAILED" -ForegroundColor Red
  exit 1
}
Write-Host "RESULT: OK" -ForegroundColor Green
exit 0
