$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
$ChunkDir = Join-Path $RepoRoot 'local-data\warehouse\d1-chunks'
$StateFile = Join-Path $RepoRoot 'local-data\warehouse\d1-upload-state.json'
$LogDir = Join-Path $RepoRoot 'local-data\logs'
$LogFile = Join-Path $LogDir ('d1-warehouse-upload-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Wrangler writes normal warnings/progress to stderr. Windows PowerShell 5.1 can
# turn redirected native stderr into NativeCommandError when ErrorActionPreference
# is Stop. Run npx through Start-Process and judge success only by the real exit code.
$env:NO_COLOR = '1'
$env:FORCE_COLOR = '0'
$NpxPath = (Get-Command npx.cmd -ErrorAction Stop).Source

function Invoke-NpxCaptured {
    param(
        [Parameter(Mandatory = $true)][string]$ArgumentString,
        [switch]$AppendLog
    )

    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $NpxPath -ArgumentList $ArgumentString -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile

        $stdout = if (Test-Path $stdoutFile) { Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue } else { '' }
        $stderr = if (Test-Path $stderrFile) { Get-Content $stderrFile -Raw -ErrorAction SilentlyContinue } else { '' }

        if ($stdout) {
            Write-Host $stdout.TrimEnd()
            if ($AppendLog) { Add-Content -Path $LogFile -Value $stdout -Encoding UTF8 }
        }
        if ($stderr) {
            Write-Host $stderr.TrimEnd()
            if ($AppendLog) { Add-Content -Path $LogFile -Value $stderr -Encoding UTF8 }
        }

        return $process.ExitCode
    }
    finally {
        Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path $ChunkDir)) { throw "Missing $ChunkDir. Run tools\run_build_warehouse.ps1 first." }
$files = @(Get-ChildItem $ChunkDir -Filter '*.sql' | Sort-Object Name)
if ($files.Count -eq 0) { throw 'No D1 SQL chunks were generated.' }

$completed = @{}
if (Test-Path $StateFile) {
    try {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
        foreach ($name in @($state.completed)) { $completed[$name] = $true }
    } catch {
        Write-Host 'WARNING: existing upload state could not be read; all chunks will be retried safely.'
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
Write-Host 'HOH compact warehouse -> Cloudflare D1'
Write-Host ('Chunks: ' + $files.Count)
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
    $exitCode = Invoke-NpxCaptured -ArgumentString ('wrangler d1 execute hoh-data-core --remote --file "' + $escapedPath + '"') -AppendLog
    if ($exitCode -ne 0) {
        Save-State
        throw ("D1 upload failed on {0} with exit code {1}. Rerun; completed chunks will be skipped." -f $file.Name,$exitCode)
    }

    $completed[$file.Name] = $true
    Save-State
}

Write-Host ''
Write-Host 'DONE: all compact historical warehouse chunks were uploaded.'
Write-Host ('State: ' + $StateFile)
Write-Host ''
Write-Host 'Remote counts:'
$query = 'SELECT (SELECT COUNT(*) FROM games WHERE game_type IN (2,3)) AS games, (SELECT COUNT(*) FROM team_game_features) AS team_features, (SELECT COUNT(*) FROM team_game_advanced_features) AS advanced_features;'
$countExit = Invoke-NpxCaptured -ArgumentString ('wrangler d1 execute hoh-data-core --remote --command "' + $query + '"') -AppendLog
if ($countExit -ne 0) {
    throw ("History upload completed, but remote count verification failed with exit code {0}." -f $countExit)
}
