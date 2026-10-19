<#
.SYNOPSIS
  End-to-end smoke test for ModelWard's multi-organization build (Windows PowerShell 5.1 or PowerShell 7).

.DESCRIPTION
  Drives the real HTTP API and prints one PASS / FAIL / SKIP line per check, then a summary.
  Exit code is 1 if any check failed, otherwise 0.

  What it does, in order:
    1. signs in as the platform owner (super admin) and creates TWO organizations
       (POST /orgs), reading the join codes and the one-time setup link from the response;
    2. completes both org admins' setup (POST /auth/setup-password);
    3. signs up an ML engineer and a compliance officer per org with the join codes
       (POST /auth/signup -> POST /auth/verify-email), approves them through the org admin
       (or through the org's auto-approve setting) and signs them in;
    4. runs the governance scenarios (models, versions, review, deploy, monitoring, comments,
       trash, users, thresholds, audit) inside org 1;
    5. attacks org 1's data from org 2 (and the other way round) and checks the super admin's
       X-Org-Id behaviour, join-code rules, and suspended-organization behaviour.

  Safe to re-run: every run creates uniquely named organizations, users and models. It never
  deletes anything; it restores the thresholds it temporarily changes. The two organizations it
  creates stay in the database (suspend them from the Organizations tab if you want them gone).

  It needs a server that returns the verification link in the signup response (devVerifyUrl),
  which only happens outside production with EMAIL_PROVIDER=console (the development default).
  It therefore cannot run against a production deployment that sends real email.

  Start the local server with the platform owner configured, for example:
      $env:SUPER_ADMIN_EMAIL = "owner@modelward.test"
      $env:SUPER_ADMIN_PASSWORD = "OwnerPass!123"
      cd server; npm run dev
  (on a fresh database the account is created at startup; an existing account with that email is
  promoted), then run:
      $env:SUPER_ADMIN_EMAIL = "owner@modelward.test"
      $env:SUPER_ADMIN_PASSWORD = "OwnerPass!123"
      .\smoke_test.ps1
  or pass -SuperAdminEmail / -SuperAdminPassword.

  Rate limits (per IP, in-memory): a run makes about 13 signup calls (SIGNUP_MAX_PER_HOUR=20),
  8 rejected join-code attempts (JOIN_CODE_MAX_FAILURES=10 per 15 min), 6 failed logins
  (LOGIN_MAX_FAILURES=10 per 15 min) and about 14 link-token calls (fixed 30 per 15 min).
  So expect one run per window with the defaults; if you see HTTP 429, wait, restart the local
  server, or raise those variables in server/.env while developing.

  Needs: curl.exe (ships with Windows 10+) for multipart uploads, and a running stack (MongoDB +
  metrics service + API). The metrics service must be running or the upload steps will fail.

.PARAMETER Api
  API base URL including /api. Default http://127.0.0.1:5000/api.

.PARAMETER SuperAdminEmail / SuperAdminPassword
  Credentials of the platform owner. Default to the SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD
  environment variables (the same names the server reads).

.PARAMETER WakeSeconds
  How long to wait for a sleeping API to answer. Default 90.

.EXAMPLE
  $env:SUPER_ADMIN_EMAIL = "owner@modelward.test"; $env:SUPER_ADMIN_PASSWORD = "OwnerPass!123"
  .\smoke_test.ps1

.EXAMPLE
  .\smoke_test.ps1 -Api http://127.0.0.1:5000/api -SuperAdminEmail owner@modelward.test -SuperAdminPassword 'OwnerPass!123'
#>
[CmdletBinding()]
param(
  [string]$Api = "http://127.0.0.1:5000/api",
  [string]$SuperAdminEmail = $env:SUPER_ADMIN_EMAIL,
  [string]$SuperAdminPassword = $env:SUPER_ADMIN_PASSWORD,
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
$GENERIC_DENIAL = "Invalid code or email not eligible"
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
# $extra = additional request headers, e.g. @{ "X-Org-Id" = $orgId } for a super admin.
function Invoke-Api([string]$method, [string]$path, [string]$token = "", $body = $null, $extra = $null) {
  $headers = @{}
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  if ($extra) { foreach ($k in $extra.Keys) { $headers[$k] = $extra[$k] } }
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
# The one-time token inside a link such as http://localhost:5173/verify-email?token=<hex>.
function Get-LinkToken([string]$link) {
  if ($link -match "token=([0-9a-fA-F]+)") { return $Matches[1] }
  return ""
}
# True when a list of items (models, versions, users, ...) contains one with this _id / id.
function Has-Id($items, [string]$id) {
  return (@($items | Where-Object { ([string]$_._id -eq $id) -or ([string]$_.id -eq $id) }).Count -gt 0)
}

# Finishes an admin's account from the one-time setup link; returns the signed-in token or "".
function Complete-Setup([string]$label, [string]$link, [bool]$tryWeak) {
  $tok = Get-LinkToken $link
  if (-not $tok) { Check "${label}: a setup link was returned (server must use EMAIL_PROVIDER=console)" $false "setupLink='$link'"; return "" }
  if ($tryWeak) {
    $r = Invoke-Api POST "/auth/setup-password" "" @{ token = $tok; password = "short" }
    Expect "${label}: a too-short password is refused and the link stays valid" $r @(400)
  }
  $r = Invoke-Api POST "/auth/setup-password" "" @{ token = $tok; password = $pw }
  Expect "${label}: setup link sets the password and signs in" $r @(200)
  if ($r.Status -ne 200 -or -not $r.Data.token) { return "" }
  return [string]$r.Data.token
}

# Signs one employee up with a join code, confirms the email + chooses the password, gets approved
# (by the org admin, or automatically when $auto) and signs in. Returns { Token, Id, Email }.
function New-Member([string]$label, [string]$joinCode, [string]$email, [string]$adminTok, [bool]$auto, [bool]$extra) {
  $res = [pscustomobject]@{ Token = ""; Id = ""; Email = $email }
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke $label"; email = $email; joinCode = $joinCode }
  Expect "${label}: signup with a join code" $r @(201)
  if ($r.Status -ne 201) { return $res }
  Check "${label}: signup is unverified and returns no login token" (($r.Data.status -eq "unverified") -and (-not (Has-Prop $r.Data "token"))) (Short $r)
  $tok = Get-LinkToken ([string]$r.Data.devVerifyUrl)
  if (-not $tok) { Check "${label}: server returned devVerifyUrl (needs EMAIL_PROVIDER=console, not production)" $false (Short $r); return $res }

  if ($extra) {
    $c = Invoke-Api POST "/auth/verify-email/check" "" @{ token = $tok }
    Check "${label}: verification link check shows the address" (($c.Status -eq 200) -and ($c.Data.email -eq $email)) (Short $c)
    $c = Invoke-Api POST "/auth/verify-email" "" @{ token = $tok; password = "short" }
    Expect "${label}: weak password at verification is refused (link stays valid)" $c @(400)
  }
  $wantStatus = "pending"
  if ($auto) { $wantStatus = "active" }
  $r = Invoke-Api POST "/auth/verify-email" "" @{ token = $tok; password = $pw }
  Check "${label}: email confirmed, password chosen, status $wantStatus" (($r.Status -eq 200) -and ($r.Data.status -eq $wantStatus)) (Short $r)
  if ($extra) {
    $c = Invoke-Api POST "/auth/verify-email" "" @{ token = $tok; password = $pw }
    Expect "${label}: a verification link works only once" $c @(400)
  }

  if (-not $auto) {
    if ($extra) {
      $c = Invoke-Api POST "/auth/login" "" @{ email = $email; password = $pw }
      Expect "${label}: pending account cannot sign in" $c @(403)
    }
    $pend = Invoke-Api GET "/users/pending" $adminTok
    $row = @($pend.Data.users | Where-Object { $_.email -eq $email })
    Check "${label}: org admin sees the verified request in Pending" (($pend.Status -eq 200) -and ($row.Count -eq 1)) (Short $pend)
    if ($row.Count -ne 1) { return $res }
    $res.Id = [string]$row[0].id
    $a = Invoke-Api POST "/users/$($res.Id)/approve" $adminTok
    Expect "${label}: org admin approves" $a @(200)
  }

  $l = Invoke-Api POST "/auth/login" "" @{ email = $email; password = $pw }
  Check "${label}: can sign in after approval" (($l.Status -eq 200) -and ($l.Data.token)) (Short $l)
  if ($l.Status -eq 200) {
    $res.Token = [string]$l.Data.token
    $res.Id = [string]$l.Data.user.id
  }
  return $res
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
  Write-Host "  config: allowModelFiles=$allowFiles enableDriftSimulation=$simEnabled storageMode=$storageMode signupEnabled=$($cfg.signupEnabled) minPasswordLength=$($cfg.minPasswordLength)"
  Check "/config reports signupEnabled and no longer lists invite-code roles" (($cfg.signupEnabled -eq $true) -and (-not (Has-Prop $cfg "signupRolesRequiringCode"))) (Short $cfgResp)
  if ($cfg.signupEnabled -ne $true) {
    Write-Host "`nSelf-signup is disabled on this server (production with EMAIL_PROVIDER=console). Use a development server." -ForegroundColor Red
    exit 1
  }

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

  # ------------------------------------------------- platform owner login ---
  Write-Host "`n=== Platform owner (super admin) ===" -ForegroundColor Cyan
  if (-not $SuperAdminEmail -or -not $SuperAdminPassword) {
    Write-Host "No super admin credentials. Set SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD (also on the server, see the script header) or pass -SuperAdminEmail / -SuperAdminPassword." -ForegroundColor Red
    exit 1
  }
  $superTok = Login-Token $SuperAdminEmail $SuperAdminPassword
  if (-not $superTok) {
    Check "Super admin can sign in" $false "login failed for $SuperAdminEmail (is the server started with the same SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD?)"
    exit 1
  }
  Check "Super admin can sign in" $true
  $r = Invoke-Api GET "/auth/me" $superTok
  Check "GET /auth/me works for a super admin without an organization selected" (($r.Status -eq 200) -and ($r.Data.user.role -eq "super_admin") -and ($null -eq $r.Data.user.orgId)) (Short $r)
  $r = Invoke-Api GET "/models" $superTok
  Check "Org-scoped route without X-Org-Id is 400 ORG_REQUIRED" (($r.Status -eq 400) -and ($r.Data.code -eq "ORG_REQUIRED")) (Short $r)
  $r = Invoke-Api GET "/orgs" $superTok
  Expect "Super admin lists organizations" $r @(200)

  # ------------------------------------------------------ create two orgs ---
  Write-Host "`n=== Organizations ===" -ForegroundColor Cyan
  $dom1 = "alpha$stamp.test"
  $dom2 = "beta$stamp.test"
  $org1Name = "Smoke Alpha $stamp"
  $org2Name = "Smoke Beta $stamp"
  $admin1Email = "admin1.$stamp@$dom1"
  $admin2Email = "admin2.$stamp@$dom2"

  $r = Invoke-Api POST "/orgs" $superTok @{ name = "Smoke Free $stamp"; adminEmail = "free.$stamp@gmail.com"; allowedDomains = @("gmail.com"); domainRuleEnabled = $true }
  Expect "A free-mail domain cannot be an allowed domain" $r @(400)

  $r = Invoke-Api POST "/orgs" $superTok @{ name = $org1Name; address = "1 Alpha Street"; adminEmail = $admin1Email; adminName = "Alpha Admin"; allowedDomains = @($dom1); domainRuleEnabled = $true }
  Expect "Super admin creates organization 1" $r @(201)
  if ($r.Status -ne 201) { Write-Host "Cannot continue without organization 1." -ForegroundColor Red; exit 1 }
  $org1 = $r.Data.org
  $org1Id = [string]$org1.id
  $org1MlCode = [string]$org1.codes.ml_engineer.value
  $org1CoCode = [string]$org1.codes.compliance_officer.value
  $admin1Setup = [string]$r.Data.setupLink
  Check "Organization 1 has two different join codes and an admin in 'invited' state" (($org1MlCode -ne "") -and ($org1CoCode -ne "") -and ($org1MlCode -ne $org1CoCode) -and ($r.Data.admin.status -eq "invited") -and ($r.Data.admin.role -eq "admin")) (Short $r)

  $r = Invoke-Api POST "/orgs" $superTok @{ name = $org2Name; address = "2 Beta Road"; adminEmail = $admin2Email; adminName = "Beta Admin"; allowedDomains = @($dom2); domainRuleEnabled = $true }
  Expect "Super admin creates organization 2" $r @(201)
  if ($r.Status -ne 201) { Write-Host "Cannot continue without organization 2." -ForegroundColor Red; exit 1 }
  $org2 = $r.Data.org
  $org2Id = [string]$org2.id
  $org2MlCode = [string]$org2.codes.ml_engineer.value
  $org2CoCode = [string]$org2.codes.compliance_officer.value
  $admin2Setup = [string]$r.Data.setupLink
  Check "The two organizations have different codes" (($org1MlCode -ne $org2MlCode) -and ($org1CoCode -ne $org2CoCode)) "codes collide"

  $r = Invoke-Api POST "/orgs" $superTok @{ name = $org1Name.ToUpper(); adminEmail = "dupname.$stamp@$dom1"; allowedDomains = @($dom1) }
  Expect "Duplicate organization name (case-insensitive) is a 409" $r @(409)
  $r = Invoke-Api POST "/orgs" $superTok @{ name = "Smoke Dup Admin $stamp"; adminEmail = $admin1Email; allowedDomains = @($dom1) }
  Expect "An admin email that already has an account is a 409" $r @(409)
  $r = Invoke-Api GET "/orgs" $superTok
  Check "Organizations list shows both new organizations with codes" (($r.Status -eq 200) -and (Has-Id $r.Data.orgs $org1Id) -and (Has-Id $r.Data.orgs $org2Id)) (Short $r)

  $adTok = Complete-Setup "Org 1 admin" $admin1Setup $true
  $ad2Tok = Complete-Setup "Org 2 admin" $admin2Setup $false
  if (-not $adTok -or -not $ad2Tok) { Write-Host "Cannot continue without both org admins." -ForegroundColor Red; exit 1 }
  $r = Invoke-Api POST "/auth/setup-password" "" @{ token = (Get-LinkToken $admin1Setup); password = $pw }
  Expect "A setup link works only once" $r @(400)
  $r = Invoke-Api GET "/auth/me" $adTok
  Check "Org 1 admin profile carries the organization name" (($r.Status -eq 200) -and ($r.Data.user.role -eq "admin") -and ($r.Data.user.orgName -eq $org1Name)) (Short $r)

  # ------------------------------------------- org admin: codes + settings ---
  Write-Host "`n=== Org admin: join codes and settings ===" -ForegroundColor Cyan
  $r = Invoke-Api GET "/orgs/current" $adTok
  Check "Org admin sees only its own organization and codes" (($r.Status -eq 200) -and ([string]$r.Data.org.id -eq $org1Id) -and ($r.Data.org.codes.ml_engineer.value -eq $org1MlCode)) (Short $r)
  $r = Invoke-Api GET "/orgs" $adTok
  Expect "Org admin cannot list all organizations" $r @(403)
  $r = Invoke-Api PATCH "/orgs/$org1Id" $adTok @{ name = "Renamed by org admin" }
  Expect "Org admin cannot edit organization details (domains, name, status)" $r @(403)
  $r = Invoke-Api PUT "/orgs/current/codes/ml_engineer" $ad2Tok @{ expiresAt = "2020-01-01" }
  Expect "A join-code expiry in the past is refused" $r @(400)

  # ----------------------------------------------------- org 1 sign-ups ---
  Write-Host "`n=== Signup flow: organization 1 ===" -ForegroundColor Cyan
  $mlEmail = "smoke.ml.$stamp@$dom1"
  $coEmail = "smoke.co.$stamp@$dom1"

  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Wrong"; email = "smoke.wrong.$stamp@$dom1"; joinCode = "ZZZZ-ZZZZ-ZZZZ" }
  Check "Wrong join code: generic 403" (($r.Status -eq 403) -and ($r.Data.error -eq $GENERIC_DENIAL)) (Short $r)
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Outsider"; email = "smoke.out.$stamp@elsewhere.test"; joinCode = $org1MlCode }
  Check "Right code, address outside the allowed domain: the same generic 403" (($r.Status -eq 403) -and ($r.Data.error -eq $GENERIC_DENIAL)) (Short $r)
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Sub"; email = "smoke.sub.$stamp@sub.$dom1"; joinCode = $org1MlCode }
  Check "A subdomain is not accepted unless listed" (($r.Status -eq 403) -and ($r.Data.error -eq $GENERIC_DENIAL)) (Short $r)
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Cross"; email = "smoke.cross.$stamp@$dom2"; joinCode = $org1MlCode }
  Check "Org 1's code cannot be used with an address that only org 2 allows: generic 403" (($r.Status -eq 403) -and ($r.Data.error -eq $GENERIC_DENIAL)) (Short $r)

  $ml = New-Member "Org 1 ML engineer" $org1MlCode $mlEmail $adTok $false $true
  $co = New-Member "Org 1 compliance officer" $org1CoCode $coEmail $adTok $false $false
  $mlTok = $ml.Token; $mlId = $ml.Id
  $coTok = $co.Token; $coId = $co.Id
  if (-not $mlTok -or -not $coTok) { Write-Host "Cannot continue without the org 1 ML engineer and compliance officer." -ForegroundColor Red; exit 1 }

  $r = Invoke-Api GET "/auth/me" $mlTok
  Check "Role comes from the code: org 1 ML engineer" (($r.Status -eq 200) -and ($r.Data.user.role -eq "ml_engineer") -and ($r.Data.user.orgName -eq $org1Name)) (Short $r)
  $r = Invoke-Api GET "/auth/me" $coTok
  Check "Role comes from the code: org 1 compliance officer" (($r.Status -eq 200) -and ($r.Data.user.role -eq "compliance_officer")) (Short $r)
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Dup"; email = $mlEmail; joinCode = $org1MlCode }
  Expect "Signing up again with an existing address is a 409" $r @(409)

  # ------------------------------------------------------------ login ---
  Write-Host "`n=== Login and token checks ===" -ForegroundColor Cyan
  $r = Invoke-Api POST "/auth/login" "" @{ email = $mlEmail; password = $pw }
  Expect "Login with correct credentials" $r @(200)
  $r = Invoke-Api POST "/auth/login" "" @{ email = $mlEmail; password = "wrong-password-$stamp" }
  Expect "Login with a wrong password" $r @(401)
  $r = Invoke-Api POST "/auth/login" "" '{"email":{"$gt":""},"password":"password123"}'
  Expect "NoSQL operator in login email is a 400, not a 500" $r @(400)
  $r = Invoke-Api GET "/models"
  Expect "Protected route without a token" $r @(401)
  $r = Invoke-Api GET "/models" "not.a.real.token"
  Expect "Protected route with a garbage token" $r @(401)
  $r = Invoke-Api GET "/no-such-route" $mlTok
  Check "Unknown API route returns JSON 404" (($r.Status -eq 404) -and (Has-Prop $r.Data "error")) (Short $r)

  # ------------------------------------------------------ Add user / admin ---
  Write-Host "`n=== Org admin: Add user with setup link ===" -ForegroundColor Cyan
  $ml2Email = "smoke.ml2.$stamp@$dom1"
  $r = Invoke-Api POST "/users" $adTok @{ name = "Smoke ML Two"; email = "smoke.ext.$stamp@elsewhere.test"; role = "ml_engineer" }
  Check "Add user outside the domain rule is refused without the external-email override" (($r.Status -eq 400) -and ($r.Data.code -eq "EMAIL_DOMAIN_NOT_ALLOWED")) (Short $r)
  $r = Invoke-Api POST "/users" $adTok @{ name = "Smoke ML Two"; email = $ml2Email; role = "ml_engineer" }
  Expect "Org admin adds a second ML engineer (no password typed)" $r @(201)
  $ml2Tok = ""
  if ($r.Status -eq 201) {
    Check "Add user returns status 'invited' and a one-time setup link" (($r.Data.user.status -eq "invited") -and ($r.Data.setupLink)) (Short $r)
    $ml2Tok = Complete-Setup "Added user" ([string]$r.Data.setupLink) $false
  }
  Check "Added user is signed in after setting a password (for the ownership checks)" ($ml2Tok -ne "") "no token"

  # ------------------------------------------------------------- RBAC ---
  Write-Host "`n=== RBAC spot checks (org 1) ===" -ForegroundColor Cyan
  $r = Invoke-Api GET "/users" $mlTok
  Expect "ML engineer cannot list users" $r @(403)
  $r = Invoke-Api GET "/users/pending" $coTok
  Expect "Compliance officer cannot open the Pending list" $r @(403)
  $r = Invoke-Api GET "/orgs/current" $mlTok
  Expect "ML engineer cannot read the organization's join codes" $r @(403)
  $r = Invoke-Api GET "/trash" $mlTok
  Expect "ML engineer cannot open Trash" $r @(403)
  $r = Invoke-Api PUT "/settings" $mlTok @{ lowAccuracy = 0.85; lowFairnessGap = 0.1; mediumAccuracy = 0.7; mediumFairnessGap = 0.2; driftThreshold = 0.1 }
  Expect "ML engineer cannot change settings" $r @(403)
  $r = Invoke-Api GET "/audit-log/verify" $mlTok
  Expect "ML engineer cannot verify the audit chain" $r @(403)
  $r = Invoke-Api GET "/audit-log/export" $mlTok
  Expect "ML engineer cannot export the audit log" $r @(403)
  $r = Invoke-Api POST "/models" $coTok @{ name = "Smoke Forbidden $stamp" }
  Expect "Compliance officer cannot create models" $r @(403)
  $r = Invoke-Api GET "/trash" $coTok
  Expect "Compliance officer cannot open Trash" $r @(403)
  $r = Invoke-Api GET "/audit-log/verify" $coTok
  Expect "Compliance officer cannot verify the audit chain (admin only)" $r @(403)
  $r = Invoke-Api POST "/models/000000000000000000000000/versions" $adTok @{}
  Check "Admin cannot upload versions" ($r.Status -in @(403, 404)) (Short $r)

  # ------------------------------------------------------------- models ---
  Write-Host "`n=== Models (org 1) ===" -ForegroundColor Cyan
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
  Write-Host "`n=== Version uploads (org 1) ===" -ForegroundColor Cyan
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

  if ($allowFiles) {
    $r = Invoke-Upload $upPath $mlTok @("fileType=joblib", "trainingNotes=logistic regression dummy", "file=@$joblib", "datasetFile=@$modelData")
    Expect "Upload joblib model + dataset" $r @(201)
    $jv = Get-Ver $r
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
  Write-Host "`n=== Comments (org 1) ===" -ForegroundColor Cyan
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
    $r = Invoke-Api DELETE "/versions/$tmpVid" $ml2Tok @{ reason = "not mine" }
    Check "Another ML engineer cannot archive it (403/404)" ($r.Status -in @(403, 404)) (Short $r)
    $r = Invoke-Api DELETE "/versions/$tmpVid" $mlTok @{ reason = "smoke test cleanup" }
    Expect "Owner archives the draft" $r @(200)
    $r = Invoke-Api GET "/versions/$tmpVid" $mlTok
    Expect "Archived version is hidden from normal reads" $r @(404)
    $r = Invoke-Api GET "/models/$modelId/versions" $mlTok
    Check "Archived version is absent from the model's list" (-not (Has-Id $r.Data.versions $tmpVid)) (Short $r)
    $r = Invoke-Api GET "/trash" $adTok
    Check "Trash lists the archived version with its reason" (($r.Status -eq 200) -and (@($r.Data.versions | Where-Object { $_._id -eq $tmpVid -and $_.deleteReason -eq "smoke test cleanup" }).Count -eq 1)) (Short $r)
    $r = Invoke-Api POST "/versions/$tmpVid/restore" $mlTok
    Expect "Owner restores the version" $r @(200)
    Check "Restored version is back as draft" ((Get-VersionStatus $tmpVid $mlTok) -eq "draft") "status differs"
  }

  # ---------------------------------------------- review / deploy lifecycle ---
  Write-Host "`n=== Review workflow (org 1) ===" -ForegroundColor Cyan
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

  Write-Host "`n=== Deploy and supersede (org 1) ===" -ForegroundColor Cyan
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
  $r = Invoke-Api DELETE "/models/$modelId" $adTok @{ reason = "should be blocked" }
  Expect "Cannot archive a model with a live version" $r @(409)
  $r = Invoke-Api POST "/versions/$goodId/retire" $coTok @{}
  Expect "Retire without a comment is refused" $r @(400)

  # ------------------------------------------------------------- drift ---
  Write-Host "`n=== Drift and monitoring (org 1) ===" -ForegroundColor Cyan
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

  # ------------------------------------------------ archive / restore: model ---
  Write-Host "`n=== Archive and restore (model) ===" -ForegroundColor Cyan
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

  # --------------------------------------------------------- stats ---
  Write-Host "`n=== Stats (org 1) ===" -ForegroundColor Cyan
  $r = Invoke-Api GET "/stats" $mlTok
  Check "Stats have totals, byStatus and byTier" (($r.Status -eq 200) -and ($r.Data.totals.models -ge 2) -and (Has-Prop $r.Data "byStatus") -and (Has-Prop $r.Data.byTier "unrated")) (Short $r)
  Check "Stats hide user counts from non-admins" (-not (Has-Prop $r.Data "users")) (Short $r)
  $r = Invoke-Api GET "/stats" $adTok
  Check "Stats include user counts for admins" (($r.Status -eq 200) -and ($r.Data.users.total -ge 1)) (Short $r)

  # ---------------------------------------------------------- users ---
  Write-Host "`n=== Admin user management (org 1) ===" -ForegroundColor Cyan
  $newEmail = "smoke.created.$stamp@$dom1"
  $r = Invoke-Api POST "/users" $adTok @{ name = "Smoke Created"; email = $newEmail; role = "ml_engineer" }
  Expect "Admin adds a user" $r @(201)
  $newId = [string]$r.Data.user.id
  $newTok = Complete-Setup "Created user" ([string]$r.Data.setupLink) $false
  $r = Invoke-Api POST "/users" $adTok @{ name = "Smoke Created"; email = $newEmail; role = "ml_engineer" }
  Expect "Adding a duplicate user is a 409" $r @(409)
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
  Expect "Admin cannot change their own role (or leave the org without an admin)" $r @(400)

  # ------------------------------------------------------- settings ---
  Write-Host "`n=== Settings round-trip (per organization) ===" -ForegroundColor Cyan
  $r = Invoke-Api GET "/settings" $mlTok
  Check "Any signed-in user can read thresholds" (($r.Status -eq 200) -and (Has-Prop $r.Data.settings "driftThreshold")) (Short $r)
  $orig = $r.Data.settings
  $o2 = Invoke-Api GET "/settings" $ad2Tok
  $org2Drift = [double]$o2.Data.settings.driftThreshold
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
    $r = Invoke-Api GET "/settings" $ad2Tok
    Check "Org 2's thresholds are unaffected by org 1's change" (($r.Status -eq 200) -and ([math]::Abs([double]$r.Data.settings.driftThreshold - $org2Drift) -lt 0.0001)) (Short $r)
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

  # ------------------------------------------------------ audit log ---
  Write-Host "`n=== Audit log (org 1) ===" -ForegroundColor Cyan
  $r = Invoke-Api GET "/audit-log?page=1&limit=5" $mlTok
  Check "ML engineer sees a scoped, paginated audit log" (($r.Status -eq 200) -and ($r.Data.scoped -eq $true) -and (@($r.Data.logs).Count -le 5) -and ($r.Data.total -ge 1) -and (Has-Prop $r.Data "pages")) (Short $r)
  $r = Invoke-Api GET "/audit-log?action=comment&limit=50" $mlTok
  Check "Audit log filters by action" (($r.Status -eq 200) -and (@($r.Data.logs).Count -ge 1) -and (@($r.Data.logs | Where-Object { $_.action -ne "comment" }).Count -eq 0)) (Short $r)
  $p1 = Invoke-Api GET "/audit-log?page=1&limit=5" $adTok
  Check "Admin sees the unscoped audit log with hashes" (($p1.Status -eq 200) -and ($p1.Data.scoped -ne $true) -and ($p1.Data.total -ge 5) -and (Has-Prop $p1.Data.logs[0] "hash") -and (Has-Prop $p1.Data.logs[0] "seq")) (Short $p1)
  $p2 = Invoke-Api GET "/audit-log?page=2&limit=5" $adTok
  Check "Audit log page 2 differs from page 1" (($p2.Status -eq 200) -and ($p2.Data.logs[0]._id -ne $p1.Data.logs[0]._id)) (Short $p2)
  $r = Invoke-Api GET "/audit-log?action=login_failed&limit=5" $adTok
  Check "Failed logins are audited" (($r.Status -eq 200) -and ($r.Data.total -ge 1)) (Short $r)
  $r = Invoke-Api GET "/audit-log?action=user_approve&limit=50" $adTok
  Check "Approvals are audited" (($r.Status -eq 200) -and ($r.Data.total -ge 2)) (Short $r)
  $r = Invoke-Api GET "/audit-log?action=join_code_failed&limit=50" $adTok
  Check "Rejected join-code attempts are audited (org 1: wrong domain, subdomain, cross-domain)" (($r.Status -eq 200) -and ($r.Data.total -ge 1)) (Short $r)
  $r = Invoke-Api GET "/audit-log/verify" $adTok
  Check "Audit hash chain verifies (org admin view: ok + own entries)" (($r.Status -eq 200) -and ($r.Data.ok -eq $true) -and (Has-Prop $r.Data "entries") -and (-not (Has-Prop $r.Data "head"))) (Short $r)
  $r = Invoke-Api GET "/audit-log/export?limit=50" $adTok
  $ct = ""
  if ($r.Headers) { $ct = [string]$r.Headers["Content-Type"] }
  Check "Admin exports the audit log as CSV" (($r.Status -eq 200) -and ($ct -like "text/csv*")) "HTTP $($r.Status) content-type=$ct"
  $r = Invoke-Api GET "/audit-log?limit=5" $coTok
  Check "Compliance officer sees the unscoped audit log" (($r.Status -eq 200) -and ($r.Data.scoped -ne $true)) (Short $r)
  $r = Invoke-Api GET "/audit-log/export?limit=50" $coTok
  Expect "Compliance officer can export the audit log" $r @(200)

  # ============================================================== org 2 ===
  Write-Host "`n=== Signup flow: organization 2 (auto-approve, reject, seat limit, regenerate) ===" -ForegroundColor Cyan
  $ml2oEmail = "smoke.ml.$stamp@$dom2"
  $co2Email = "smoke.co.$stamp@$dom2"
  $rejEmail = "smoke.reject.$stamp@$dom2"

  $r = Invoke-Api PATCH "/orgs/current" $ad2Tok @{ autoApprove = $true }
  Check "Org 2 admin turns auto-approve on" (($r.Status -eq 200) -and ($r.Data.org.autoApprove -eq $true)) (Short $r)
  $r = Invoke-Api PATCH "/orgs/current" $mlTok @{ autoApprove = $true }
  Expect "ML engineer cannot change organization settings" $r @(403)
  $ml2o = New-Member "Org 2 ML engineer (auto-approved)" $org2MlCode $ml2oEmail $ad2Tok $true $false
  $co2 = New-Member "Org 2 compliance officer (auto-approved)" $org2CoCode $co2Email $ad2Tok $true $false
  $ml2oTok = $ml2o.Token
  $co2Tok = $co2.Token
  if (-not $ml2oTok -or -not $co2Tok) { Write-Host "Cannot continue without the org 2 members." -ForegroundColor Red; exit 1 }

  # Reject path: signup -> verify -> admin rejects -> account is gone and the seat is free again.
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Reject"; email = $rejEmail; joinCode = $org2MlCode }
  $rejTok = Get-LinkToken ([string]$r.Data.devVerifyUrl)
  if ($r.Status -eq 201 -and $rejTok) {
    # auto-approve is on, so turn it off for this one to land in Pending
    [void](Invoke-Api PATCH "/orgs/current" $ad2Tok @{ autoApprove = $false })
    $v = Invoke-Api POST "/auth/verify-email" "" @{ token = $rejTok; password = $pw }
    Check "Org 2: with auto-approve off a verified signup waits in Pending" (($v.Status -eq 200) -and ($v.Data.status -eq "pending")) (Short $v)
    $pend = Invoke-Api GET "/users/pending" $ad2Tok
    $row = @($pend.Data.users | Where-Object { $_.email -eq $rejEmail })
    if ($row.Count -eq 1) {
      $x = Invoke-Api POST "/users/$($row[0].id)/reject" $ad2Tok
      Expect "Org 2 admin rejects the pending request" $x @(200)
      $x = Invoke-Api POST "/auth/login" "" @{ email = $rejEmail; password = $pw }
      Expect "A rejected account cannot sign in" $x @(401)
    } else {
      Check "Org 2: the request to reject is in Pending" $false (Short $pend)
    }
  } else {
    Check "Org 2: signup for the reject scenario" $false (Short $r)
  }

  $r = Invoke-Api PUT "/orgs/current/codes/ml_engineer" $ad2Tok @{ seatLimit = 1 }
  Check "Org 2 admin sets a seat limit of 1 on the ML engineer code (1 seat used)" (($r.Status -eq 200) -and ($r.Data.org.codes.ml_engineer.seatLimit -eq 1) -and ($r.Data.org.codes.ml_engineer.used -eq 1)) (Short $r)
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Full"; email = "smoke.full.$stamp@$dom2"; joinCode = $org2MlCode }
  Check "A full code is refused with the generic 403" (($r.Status -eq 403) -and ($r.Data.error -eq $GENERIC_DENIAL)) (Short $r)
  $r = Invoke-Api PUT "/orgs/current/codes/ml_engineer" $ad2Tok @{ seatLimit = $null }
  Check "Seat limit can be cleared again" (($r.Status -eq 200) -and ($null -eq $r.Data.org.codes.ml_engineer.seatLimit)) (Short $r)

  $r = Invoke-Api POST "/orgs/current/codes/compliance_officer/regenerate" $ad2Tok
  $newCoCode = ""
  if ($r.Status -eq 200) { $newCoCode = [string]$r.Data.org.codes.compliance_officer.value }
  Check "Org 2 admin regenerates the compliance officer code" (($r.Status -eq 200) -and ($newCoCode -ne "") -and ($newCoCode -ne $org2CoCode)) (Short $r)
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Old"; email = "smoke.old.$stamp@$dom2"; joinCode = $org2CoCode }
  Check "The regenerated (old) code stops working: generic 403" (($r.Status -eq 403) -and ($r.Data.error -eq $GENERIC_DENIAL)) (Short $r)

  $r = Invoke-Api PATCH "/orgs/$org2Id" $superTok @{ allowedDomains = @("gmail.com") }
  Expect "Super admin cannot list a free-mail domain while the domain rule is on" $r @(400)

  # org 2 content for the isolation checks (same model name as org 1: names are unique PER organization)
  $r = Invoke-Api POST "/models" $ml2oTok @{ name = $modelName; description = "Same name, other organization" }
  Expect "Org 2 can create a model with the same name as org 1's" $r @(201)
  $org2ModelId = [string](Get-Mod $r)._id

  # ================================================== tenant isolation ===
  Write-Host "`n=== Tenant isolation: org 2 tries to reach org 1 ===" -ForegroundColor Cyan
  # something archived in org 1 to look for in the other org's Trash
  $r = Invoke-Api DELETE "/versions/$tmpVid" $mlTok @{ reason = "isolation probe" }
  Expect "Org 1 archives a draft (so it sits in org 1's Trash)" $r @(200)

  $r = Invoke-Api GET "/models/$modelId" $ml2oTok
  Expect "Org 2 ML engineer cannot read org 1's model (404, not 403)" $r @(404)
  $r = Invoke-Api GET "/models?limit=100" $ml2oTok
  Check "Org 1's model is absent from org 2's model list" (($r.Status -eq 200) -and (-not (Has-Id $r.Data.models $modelId)) -and (Has-Id $r.Data.models $org2ModelId)) (Short $r)
  $r = Invoke-Api GET "/models/$modelId/versions" $ml2oTok
  Expect "Org 1 model's version list is 404 for org 2" $r @(404)
  $r = Invoke-Upload "/models/$modelId/versions" $ml2oTok @("fileType=csv", "latencyMs=5", "file=@$goodCsv")
  Expect "Org 2 cannot upload a version into org 1's model" $r @(404)
  $r = Invoke-Api GET "/versions/$goodId" $ml2oTok
  Expect "Org 2 cannot read org 1's version" $r @(404)
  $r = Invoke-Api GET "/versions/$goodId/file?which=model" $ml2oTok
  Expect "Org 2 cannot download org 1's file" $r @(404)
  $r = Invoke-Api GET "/versions/$goodId/comments" $ml2oTok
  Expect "Org 2 cannot read org 1's comments" $r @(404)
  $r = Invoke-Api POST "/versions/$goodId/comments" $ml2oTok @{ body = "cross-org comment" }
  Expect "Org 2 cannot comment on org 1's version" $r @(404)
  $r = Invoke-Api POST "/versions/$goodId/submit" $ml2oTok
  Expect "Org 2 cannot act on org 1's version (submit)" $r @(404)
  $r = Invoke-Api POST "/versions/$goodId/review" $co2Tok @{ decision = "approve"; comment = "cross-org review" }
  Expect "Org 2 compliance officer cannot review org 1's version" $r @(404)
  $r = Invoke-Api POST "/versions/$goodId/retire" $co2Tok @{ comment = "cross-org" }
  Expect "Org 2 compliance officer cannot retire org 1's version" $r @(404)
  $r = Invoke-Api GET "/versions?status=retired&limit=100" $co2Tok
  Check "Org 1's retired version is absent from org 2's version list" (($r.Status -eq 200) -and (-not (Has-Id $r.Data.versions $goodId))) (Short $r)

  $r = Invoke-Api GET "/users?limit=100" $ad2Tok
  Check "Org 1's users are absent from org 2's user list" (($r.Status -eq 200) -and (-not (Has-Id $r.Data.users $mlId)) -and (@($r.Data.users | Where-Object { $_.email -like "*@$dom1" }).Count -eq 0)) (Short $r)
  $r = Invoke-Api PATCH "/users/$mlId" $ad2Tok @{ isActive = $false }
  Expect "Org 2 admin cannot deactivate an org 1 user (404)" $r @(404)
  $r = Invoke-Api POST "/users/$mlId/approve" $ad2Tok
  Expect "Org 2 admin cannot approve an org 1 user (404)" $r @(404)
  $r = Invoke-Api POST "/users/$mlId/setup-link" $ad2Tok
  Expect "Org 2 admin cannot issue a setup link for an org 1 user (404)" $r @(404)
  $r = Invoke-Api DELETE "/models/$model2Id" $ad2Tok @{ reason = "cross-org" }
  Expect "Org 2 admin cannot archive org 1's model (404)" $r @(404)
  $r = Invoke-Api POST "/models/$model2Id/restore" $ad2Tok
  Expect "Org 2 admin cannot restore org 1's model (404)" $r @(404)
  $r = Invoke-Api GET "/trash" $ad2Tok
  Check "Org 1's archived version is absent from org 2's Trash" (($r.Status -eq 200) -and (-not (Has-Id $r.Data.versions $tmpVid)) -and (-not (Has-Id $r.Data.models $model2Id))) (Short $r)
  $r = Invoke-Api GET "/trash" $adTok
  Check "...and present in org 1's Trash" (($r.Status -eq 200) -and (Has-Id $r.Data.versions $tmpVid)) (Short $r)
  $r = Invoke-Api POST "/versions/$tmpVid/restore" $mlTok
  Expect "Org 1 restores the probe version" $r @(200)

  $r = Invoke-Api GET "/orgs/current" $ad2Tok
  Check "Org 2 admin sees org 2's codes, not org 1's" (($r.Status -eq 200) -and ([string]$r.Data.org.id -eq $org2Id) -and ($r.Data.org.codes.ml_engineer.value -ne $org1MlCode) -and ($r.Data.org.codes.compliance_officer.value -ne $org1CoCode) -and ($r.Raw -notlike "*$org1MlCode*") -and ($r.Raw -notlike "*$org1CoCode*")) (Short $r)
  $r = Invoke-Api PATCH "/orgs/$org1Id" $ad2Tok @{ status = "suspended" }
  Expect "Org 2 admin cannot suspend or edit org 1 (platform route)" $r @(403)
  $r = Invoke-Api GET "/orgs" $ad2Tok
  Expect "Org 2 admin cannot list organizations" $r @(403)
  $r = Invoke-Api GET "/models" $adTok $null @{ "X-Org-Id" = $org2Id }
  Check "An X-Org-Id header does nothing for a non-super-admin (org 1 admin still sees org 1)" (($r.Status -eq 200) -and (Has-Id $r.Data.models $modelId) -and (-not (Has-Id $r.Data.models $org2ModelId))) (Short $r)

  $r = Invoke-Api GET "/stats" $ad2Tok
  Check "Org 2 stats count only org 2 (1 model, no org 1 versions)" (($r.Status -eq 200) -and ($r.Data.totals.models -eq 1) -and ($r.Data.totals.versions -eq 0)) (Short $r)
  $r = Invoke-Api GET "/stats" $adTok
  Check "Org 1 stats still count org 1's models" (($r.Status -eq 200) -and ($r.Data.totals.models -ge 2)) (Short $r)

  $r = Invoke-Api GET "/audit-log?limit=100" $ad2Tok
  $rows2 = @($r.Data.logs)
  Check "Org 2's audit log has no entry of org 1 (by organization id)" (($r.Status -eq 200) -and (@($rows2 | Where-Object { [string]$_.orgId -eq $org1Id }).Count -eq 0)) (Short $r)
  Check "Org 2's audit log never mentions org 1's users or model" ((@($rows2 | Where-Object { ([string]$_.details -like "*$mlEmail*") -or ([string]$_.details -like "*$org1Name*") }).Count -eq 0)) "foreign entries found"
  $r = Invoke-Api GET "/audit-log?action=cross_org_attempt&limit=50" $ad2Tok
  Check "Org 2's probes of org 1's ids were audited as cross_org_attempt" (($r.Status -eq 200) -and ($r.Data.total -ge 1)) (Short $r)
  $r = Invoke-Api GET "/audit-log?limit=100" $adTok
  Check "Org 1's audit log has no entry of org 2" (($r.Status -eq 200) -and (@($r.Data.logs | Where-Object { ([string]$_.orgId -eq $org2Id) -or ([string]$_.details -like "*$ml2oEmail*") -or ([string]$_.details -like "*$org2Name*") }).Count -eq 0)) (Short $r)
  $r = Invoke-Api GET "/audit-log/verify" $ad2Tok
  Check "Org 2 admin's audit verify reports only its own entries" (($r.Status -eq 200) -and ($r.Data.ok -eq $true) -and (-not (Has-Prop $r.Data "head")) -and (-not (Has-Prop $r.Data "brokenSeqs"))) (Short $r)

  # ============================================================ super admin ===
  Write-Host "`n=== Super admin across organizations (X-Org-Id) ===" -ForegroundColor Cyan
  $H1 = @{ "X-Org-Id" = $org1Id }
  $H2 = @{ "X-Org-Id" = $org2Id }
  $r = Invoke-Api GET "/models" $superTok
  Check "No X-Org-Id: 400 ORG_REQUIRED" (($r.Status -eq 400) -and ($r.Data.code -eq "ORG_REQUIRED")) (Short $r)
  $r = Invoke-Api GET "/models?limit=100" $superTok $null $H1
  Check "With org 1 selected the super admin sees org 1's models" (($r.Status -eq 200) -and (Has-Id $r.Data.models $modelId) -and (-not (Has-Id $r.Data.models $org2ModelId))) (Short $r)
  $r = Invoke-Api GET "/models?limit=100" $superTok $null $H2
  Check "With org 2 selected the super admin sees org 2's models" (($r.Status -eq 200) -and (Has-Id $r.Data.models $org2ModelId) -and (-not (Has-Id $r.Data.models $modelId))) (Short $r)
  $r = Invoke-Api GET "/models" $superTok $null @{ "X-Org-Id" = "000000000000000000000000" }
  Check "An unknown X-Org-Id is 400 ORG_REQUIRED" (($r.Status -eq 400) -and ($r.Data.code -eq "ORG_REQUIRED")) (Short $r)
  $r = Invoke-Api GET "/models" $superTok $null @{ "X-Org-Id" = "not-an-id" }
  Check "A malformed X-Org-Id is 400 ORG_REQUIRED" (($r.Status -eq 400) -and ($r.Data.code -eq "ORG_REQUIRED")) (Short $r)
  $r = Invoke-Api GET "/versions/$goodId" $superTok $null $H1
  Expect "Super admin opens org 1's version with org 1 selected" $r @(200)
  $r = Invoke-Api GET "/versions/$goodId" $superTok $null $H2
  Expect "...but not with org 2 selected (404)" $r @(404)
  $r = Invoke-Api POST "/versions/$goodId/review" $superTok @{ decision = "approve"; comment = "super admin is not a reviewer" } $H1
  Expect "Super admin is not a reviewer (403)" $r @(403)
  $r = Invoke-Api GET "/users?limit=100" $superTok $null $H1
  Check "Super admin lists org 1's users with org 1 selected" (($r.Status -eq 200) -and (@($r.Data.users | Where-Object { $_.email -eq $mlEmail }).Count -eq 1)) (Short $r)
  $r = Invoke-Api GET "/orgs" $superTok
  Check "Super admin's organization list shows user and model counts" (($r.Status -eq 200) -and (@($r.Data.orgs | Where-Object { ([string]$_.id -eq $org1Id) -and ($_.counts.models -ge 2) -and ($_.counts.users -ge 4) }).Count -eq 1)) (Short $r)

  $r = Invoke-Api GET "/audit-log?action=org_access&limit=50" $adTok
  Check "Org 1's audit log shows the super admin's access to the organization (org_access)" (($r.Status -eq 200) -and ($r.Data.total -ge 1)) (Short $r)
  $r = Invoke-Api GET "/audit-log?action=org_create&limit=100" $superTok
  Check "Super admin's all-organizations audit view (no org selected) has org_create rows of both orgs, with organization names" (($r.Status -eq 200) -and (@($r.Data.logs | Where-Object { ([string]$_.orgId -eq $org1Id) -and ($_.orgName -eq $org1Name) }).Count -ge 1) -and (@($r.Data.logs | Where-Object { ([string]$_.orgId -eq $org2Id) -and ($_.orgName -eq $org2Name) }).Count -ge 1)) (Short $r)
  $r = Invoke-Api GET "/audit-log?orgId=$org1Id&limit=100" $superTok
  Check "...and can be narrowed to one organization with ?orgId=" (($r.Status -eq 200) -and ($r.Data.total -ge 1) -and (@($r.Data.logs | Where-Object { [string]$_.orgId -ne $org1Id }).Count -eq 0)) (Short $r)
  $r = Invoke-Api GET "/audit-log/verify" $superTok
  Check "Super admin's audit verify returns the full chain result" (($r.Status -eq 200) -and ($r.Data.ok -eq $true)) (Short $r)
  $r = Invoke-Api GET "/audit-log/export?limit=20" $superTok
  Expect "Super admin exports the all-organizations audit log" $r @(200)

  # ====================================================== suspended org ===
  Write-Host "`n=== Suspending an organization ===" -ForegroundColor Cyan
  $r = Invoke-Api GET "/auth/me" $ad2Tok
  Expect "Org 2 admin token works before suspension" $r @(200)
  $r = Invoke-Api PATCH "/orgs/$org2Id" $superTok @{ status = "suspended" }
  Check "Super admin suspends org 2" (($r.Status -eq 200) -and ($r.Data.org.status -eq "suspended")) (Short $r)
  $r = Invoke-Api GET "/auth/me" $ad2Tok
  Expect "Existing org 2 admin session is rejected at once (401)" $r @(401)
  $r = Invoke-Api GET "/models" $ml2oTok
  Expect "Existing org 2 ML engineer session is rejected at once (401)" $r @(401)
  $r = Invoke-Api POST "/auth/login" "" @{ email = $ml2oEmail; password = $pw }
  Expect "Org 2 users cannot sign in while suspended" $r @(403)
  $r = Invoke-Api POST "/auth/signup" "" @{ name = "Smoke Susp"; email = "smoke.susp.$stamp@$dom2"; joinCode = $org2MlCode }
  Check "Org 2's join code is refused while suspended: generic 403" (($r.Status -eq 403) -and ($r.Data.error -eq $GENERIC_DENIAL)) (Short $r)
  $r = Invoke-Api GET "/auth/me" $adTok
  Expect "Org 1 is unaffected by org 2's suspension" $r @(200)
  $r = Invoke-Api PATCH "/orgs/$org2Id" $superTok @{ status = "active" }
  Check "Super admin re-activates org 2" (($r.Status -eq 200) -and ($r.Data.org.status -eq "active")) (Short $r)
  $r = Invoke-Api GET "/auth/me" $ad2Tok
  Expect "Org 2 admin's session works again" $r @(200)
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
