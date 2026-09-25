$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:5000/api"
$sample = "D:\Projects\FSD\modelward\sample-data"
$stamp = Get-Date -Format "yyyyMMddHHmmssfff"

function Section($name) { Write-Output "`n=== $name ===" }

Section "Signup: ML Engineer"
$mlBody = @{ name="Alice ML"; email="alice.ml.$stamp@modelward.test"; password="password123"; role="ml_engineer" } | ConvertTo-Json
$mlSignup = Invoke-RestMethod -Uri "$base/auth/signup" -Method Post -Body $mlBody -ContentType "application/json"
$mlToken = $mlSignup.token
Write-Output "ML Engineer token acquired: $($mlToken.Substring(0,20))..."

Section "Signup: Compliance Officer"
$coBody = @{ name="Bob Compliance"; email="bob.co.$stamp@modelward.test"; password="password123"; role="compliance_officer" } | ConvertTo-Json
$coSignup = Invoke-RestMethod -Uri "$base/auth/signup" -Method Post -Body $coBody -ContentType "application/json"
$coToken = $coSignup.token
Write-Output "Compliance Officer token acquired: $($coToken.Substring(0,20))..."

Section "Signup: Admin"
$adminBody = @{ name="Carol Admin"; email="carol.admin.$stamp@modelward.test"; password="password123"; role="admin" } | ConvertTo-Json
$adminSignup = Invoke-RestMethod -Uri "$base/auth/signup" -Method Post -Body $adminBody -ContentType "application/json"
$adminToken = $adminSignup.token
Write-Output "Admin token acquired: $($adminToken.Substring(0,20))..."

Section "Reject client-supplied riskTier on model creation"
try {
  $badBody = @{ name="Should Fail"; riskTier="high" } | ConvertTo-Json
  Invoke-RestMethod -Uri "$base/models" -Method Post -Body $badBody -ContentType "application/json" -Headers @{Authorization="Bearer $mlToken"}
  Write-Output "FAIL: expected 400, request succeeded"
} catch {
  Write-Output "OK: rejected with $($_.Exception.Response.StatusCode.value__)"
}

Section "Create Model (ML Engineer)"
$modelBody = @{ name="Loan Default Predictor"; description="Predicts default risk"; useCase="Credit underwriting" } | ConvertTo-Json
$modelResp = Invoke-RestMethod -Uri "$base/models" -Method Post -Body $modelBody -ContentType "application/json" -Headers @{Authorization="Bearer $mlToken"}
$modelId = $modelResp.model._id
Write-Output "Model created: $modelId, latestRiskTier=$($modelResp.model.latestRiskTier)"

function Upload-Version($modelId, $token, $curlArgs) {
  $uri = "$base/models/$modelId/versions"
  $json = curl.exe -s -X POST $uri -H "Authorization: Bearer $token" @curlArgs
  return $json | ConvertFrom-Json
}

Section "Upload Version 1 (good CSV -> expect low risk)"
$v1 = Upload-Version $modelId $mlToken @(
  "-F", "fileType=csv", "-F", "latencyMs=12", "-F", "datasetNotes=synthetic good predictions",
  "-F", "file=@$sample\good_predictions.csv"
)
$v1Id = $v1.version._id
Write-Output "Version 1: id=$v1Id status=$($v1.version.status) riskTier=$($v1.version.riskTier) accuracy=$($v1.version.metrics.accuracy)"

Section "Upload Version 2 (joblib model + matching dataset -> expect real latency)"
$v2 = Upload-Version $modelId $mlToken @(
  "-F", "fileType=joblib", "-F", "trainingNotes=logistic regression dummy",
  "-F", "file=@$sample\dummy_model.joblib", "-F", "datasetFile=@$sample\model_dataset.csv"
)
$v2Id = $v2.version._id
Write-Output "Version 2: id=$v2Id status=$($v2.version.status) riskTier=$($v2.version.riskTier) latencyMs=$($v2.version.metrics.latencyMs) computedBy=$($v2.version.metrics.computedBy)"

Section "Upload Version 3 (joblib model + MISMATCHED dataset -> expect upload_failed, not a crash)"
$v3 = Upload-Version $modelId $mlToken @(
  "-F", "fileType=joblib",
  "-F", "file=@$sample\dummy_model.joblib", "-F", "datasetFile=@$sample\mismatched_dataset.csv"
)
$v3Id = $v3.version._id
Write-Output "Version 3: id=$v3Id status=$($v3.version.status) uploadError=$($v3.version.uploadError)"

Section "Upload Version 4 (bad CSV -> expect high risk)"
$v4 = Upload-Version $modelId $mlToken @(
  "-F", "fileType=csv", "-F", "latencyMs=8", "-F", "file=@$sample\bad_predictions.csv"
)
$v4Id = $v4.version._id
Write-Output "Version 4: id=$v4Id status=$($v4.version.status) riskTier=$($v4.version.riskTier) accuracy=$($v4.version.metrics.accuracy)"

Section "Submit Version 1 for review"
$sub1 = Invoke-RestMethod -Uri "$base/versions/$v1Id/submit" -Method Post -Headers @{Authorization="Bearer $mlToken"}
Write-Output "Version 1 status: $($sub1.version.status)"

Section "Compliance Officer approves Version 1 (low risk, no comment needed)"
$approveBody = @{ decision = "approve" } | ConvertTo-Json
$app1 = Invoke-RestMethod -Uri "$base/versions/$v1Id/review" -Method Post -Body $approveBody -ContentType "application/json" -Headers @{Authorization="Bearer $coToken"}
Write-Output "Version 1 status: $($app1.version.status)"

Section "Submit + try to approve Version 4 (high risk) WITHOUT comment -> expect 400"
Invoke-RestMethod -Uri "$base/versions/$v4Id/submit" -Method Post -Headers @{Authorization="Bearer $mlToken"} | Out-Null
try {
  $noCommentBody = @{ decision = "approve" } | ConvertTo-Json
  Invoke-RestMethod -Uri "$base/versions/$v4Id/review" -Method Post -Body $noCommentBody -ContentType "application/json" -Headers @{Authorization="Bearer $coToken"}
  Write-Output "FAIL: expected 400, request succeeded"
} catch {
  Write-Output "OK: rejected with $($_.Exception.Response.StatusCode.value__)"
}

Section "Approve Version 4 (high risk) WITH comment -> expect success"
$withCommentBody = @{ decision = "approve"; comment = "Reviewed manually, acceptable for pilot use with monitoring." } | ConvertTo-Json
$app4 = Invoke-RestMethod -Uri "$base/versions/$v4Id/review" -Method Post -Body $withCommentBody -ContentType "application/json" -Headers @{Authorization="Bearer $coToken"}
Write-Output "Version 4 status: $($app4.version.status)"

Section "Deploy Version 1"
$dep1 = Invoke-RestMethod -Uri "$base/versions/$v1Id/deploy" -Method Post -Headers @{Authorization="Bearer $coToken"}
Write-Output "Version 1 status: $($dep1.version.status)"

Section "Simulate drift x3 on Version 1"
1..3 | ForEach-Object {
  $snap = Invoke-RestMethod -Uri "$base/versions/$v1Id/simulate-drift" -Method Post -Headers @{Authorization="Bearer $mlToken"}
  Write-Output "  snapshot ${_}: accuracy=$([math]::Round($snap.snapshot.accuracy,4)) drift=$([math]::Round($snap.snapshot.driftDelta,4)) flagged=$($snap.snapshot.flagged)"
}

Section "Get Version 1 detail (compliance score + snapshot history)"
$detail1 = Invoke-RestMethod -Uri "$base/versions/$v1Id" -Method Get -Headers @{Authorization="Bearer $adminToken"}
Write-Output "Compliance score: $($detail1.compliance.score) required=$($detail1.compliance.required -join ',')"
Write-Output "Snapshot count: $($detail1.snapshots.Count)"

Section "List models (annotated with latestRiskTier)"
$models = Invoke-RestMethod -Uri "$base/models" -Method Get -Headers @{Authorization="Bearer $adminToken"}
$models.models | ForEach-Object { Write-Output "  $($_.name): latestRiskTier=$($_.latestRiskTier)" }

Section "Audit log (read-only, any role)"
$logs = Invoke-RestMethod -Uri "$base/audit-log" -Method Get -Headers @{Authorization="Bearer $mlToken"}
Write-Output "Total audit log entries: $($logs.logs.Count)"
$logs.logs | Select-Object -First 5 | ForEach-Object { Write-Output "  [$($_.action)] $($_.actorName) ($($_.actorRole)): $($_.details)" }

Section "RBAC check: ML Engineer tries to review (should 403)"
try {
  Invoke-RestMethod -Uri "$base/versions/$v2Id/review" -Method Post -Body $approveBody -ContentType "application/json" -Headers @{Authorization="Bearer $mlToken"}
  Write-Output "FAIL: expected 403, request succeeded"
} catch {
  Write-Output "OK: rejected with $($_.Exception.Response.StatusCode.value__)"
}

Write-Output "`n=== SMOKE TEST COMPLETE ==="
