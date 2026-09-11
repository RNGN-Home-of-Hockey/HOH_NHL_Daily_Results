$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
$ChunkDir = Join-Path $RepoRoot 'local-data\warehouse\d1-chunks'
$StateFile = Join-Path $RepoRoot 'local-data\warehouse\d1-compact-supplement-upload-state.json'
$LogDir = Join-Path $RepoRoot 'local-data\logs'
$LogFile = Join-Path $LogDir ('d1-compact-supplement-upload-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$env:NO_COLOR = '1'
$env:FORCE_COLOR = '0'
$NpxPath = (Get-Command npx.cmd -ErrorAction Stop).Source

function Invoke-NpxCaptured {
    param([Parameter(Mandatory = $true)][string]$ArgumentString)
    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $NpxPath -ArgumentList $ArgumentString -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $stdout = if (Test-Path $stdoutFile) { Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue } else { '' }
        $stderr = if (Test-Path $stderrFile) { Get-Content $stderrFile -Raw -ErrorAction SilentlyContinue } else { '' }
        if ($stdout) { Write-Host $stdout.TrimEnd(); Add-Content -Path $LogFile -Value $stdout -Encoding UTF8 }
        if ($stderr) { Write-Host $stderr.TrimEnd(); Add-Content -Path $LogFile -Value $stderr -Encoding UTF8 }
        return [int]$process.ExitCode
    }
    finally {
        Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path $ChunkDir)) { throw "Missing $ChunkDir. Run build_compact_snapshots.py first." }

# Only supplemental compact files. Never replay the 010-060 historical package here.
$files = @(Get-ChildItem $ChunkDir -Filter '*.sql' -File | Where-Object {
    $_.Name -match '^(070_players|080_team_snapshots|090_player_rolling|100_player_opponents|110_goalie_rolling|120_goalie_opponents|125_team_current|130_data_core_meta|135_player_market_snapshots)_'
} | Sort-Object Name)
if ($files.Count -eq 0) { throw 'No compact supplemental D1 chunks were generated.' }

$completed = @{}
if (Test-Path $StateFile) {
    try {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
        foreach ($name in @($state.completed)) { $completed[$name] = $true }
    } catch {
        Write-Host 'WARNING: supplemental upload state could not be read; chunks will be retried safely.'
    }
}

function Save-State {
    $payload = [ordered]@{
        completed = @($completed.Keys | Sort-Object)
        total = $files.Count
        updated_at = (Get-Date).ToUniversalTime().ToString('o')
    }
    $payload | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 $StateFile
}

Write-Host ''
Write-Host 'HOH compact snapshots/player aggregates -> Cloudflare D1'
Write-Host ('Supplemental chunks: ' + $files.Count)
Write-Host ('Already completed: ' + $completed.Count)
Write-Host ('Log: ' + $LogFile)
Write-Host ''

$index = 0
foreach ($file in $files) {
    $index += 1
    if ($completed.ContainsKey($file.Name)) {
        Write-Host ("SKIP [{0}/{1}] {2}" -f $index,$files.Count,$file.Name)
        continue
    }
    Write-Host ("UPLOAD [{0}/{1}] {2}" -f $index,$files.Count,$file.Name)
    $escapedPath = $file.FullName.Replace('"','\"')
    $exitCode = Invoke-NpxCaptured -ArgumentString ('wrangler d1 execute hoh-data-core --remote --file "' + $escapedPath + '"')
    if ($exitCode -ne 0) {
        Save-State
        throw ("Supplemental D1 upload failed on {0} with exit code {1}. Rerun; completed chunks will be skipped." -f $file.Name,$exitCode)
    }
    $completed[$file.Name] = $true
    Save-State
}

Write-Host ''
Write-Host 'DONE: compact snapshots/player aggregates uploaded.'
Write-Host ('State: ' + $StateFile)
Write-Host ''
Write-Host 'Remote compact status (small metadata table; no historical COUNT scans):'
$query = "SELECT meta_key,meta_value,updated_at FROM data_core_meta WHERE meta_key LIKE 'warehouse.%' OR meta_key LIKE 'compact.%' OR meta_key LIKE 'build.%' ORDER BY meta_key;"
$metaExit = Invoke-NpxCaptured -ArgumentString ('wrangler d1 execute hoh-data-core --remote --command "' + $query + '"')
if ($metaExit -ne 0) {
    Write-Host ("WARNING: upload completed but metadata verification failed with exit code {0}." -f $metaExit)
}
