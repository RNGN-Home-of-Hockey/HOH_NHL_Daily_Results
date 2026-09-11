$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
$LogDir = Join-Path $RepoRoot 'local-data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ('compact-snapshot-sync-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

$SleepGuardEnabled = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HOHCompactExecutionState {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@ -ErrorAction SilentlyContinue
    $ES_CONTINUOUS = [Convert]::ToUInt32('80000000', 16)
    $ES_SYSTEM_REQUIRED = [uint32]0x00000001
    [void][HOHCompactExecutionState]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
    $SleepGuardEnabled = $true
} catch {
    Write-Host 'WARNING: could not enable Windows sleep guard.'
}

function Write-Step([string]$Text) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Text)
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Invoke-ProcessExitCode {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $false)][string[]]$ArgumentList = @()
    )
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -NoNewWindow -Wait -PassThru
    return [int]$process.ExitCode
}

try {
    Write-Host ''
    Write-Host 'HOH COMPACT SNAPSHOT + PLAYER LAYER SYNC'
    Write-Host ('Repo: ' + $RepoRoot)
    Write-Host ('Log:  ' + $LogFile)
    Write-Host ''

    $sqlite = Join-Path $RepoRoot 'local-data\warehouse\hoh_history.sqlite'
    if (-not (Test-Path $sqlite)) {
        throw 'Missing local warehouse SQLite. Run the full history build first.'
    }
    $completeFile = Join-Path $RepoRoot 'local-data\nhl-history\complete.json'
    if (-not (Test-Path $completeFile)) {
        throw 'Missing official NHL raw archive complete.json.'
    }

    $python = (Get-Command python.exe -ErrorAction SilentlyContinue)
    if (-not $python) { $python = (Get-Command python -ErrorAction Stop) }
    Write-Step 'Building pregame team snapshots and compact player/goalie aggregates locally...'
    $buildExit = Invoke-ProcessExitCode -FilePath $python.Source -ArgumentList @((Join-Path $PSScriptRoot 'build_compact_snapshots.py'))
    if ($buildExit -ne 0) { throw ("Compact snapshot build failed with exit code {0}." -f $buildExit) }

    $summaryPath = Join-Path $RepoRoot 'local-data\warehouse\compact-snapshots-summary.json'
    if (-not (Test-Path $summaryPath)) { throw 'Compact snapshot summary was not produced.' }
    $summary = Get-Content $summaryPath -Raw | ConvertFrom-Json
    if (-not $summary.ok) { throw 'Compact snapshot summary reports ok=false.' }
    if ([int]$summary.validation.official_games -ne 2792) {
        throw ("Expected 2792 official games, found {0}." -f $summary.validation.official_games)
    }
    $writes = [int]$summary.supplemental_writes_estimate
    Write-Step ("Local build validated: player-game={0}, goalie-game={1}, supplemental D1 rows={2}" -f `
        $summary.validation.player_game_rows_local, $summary.validation.goalie_game_rows_local, $writes)
    if ($writes -gt 85000) {
        throw ("Supplemental package is {0} rows, above the 85k safety ceiling for D1 Free. Do not upload until split into multiple days." -f $writes)
    }

    # New compact chunks changed, so reset only the supplemental checkpoint.
    $stateFile = Join-Path $RepoRoot 'local-data\warehouse\d1-compact-supplement-upload-state.json'
    if (Test-Path $stateFile) { Remove-Item $stateFile -Force }

    $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
    Write-Step 'Applying pending D1 migrations (0006 creates compact snapshot/player tables)...'
    $migrationExit = Invoke-ProcessExitCode -FilePath $npx -ArgumentList @('wrangler','d1','migrations','apply','hoh-data-core','--remote')
    if ($migrationExit -ne 0) { throw ("D1 migration failed with exit code {0}." -f $migrationExit) }

    Write-Step 'Uploading supplemental compact chunks only (070-120; historical 010-060 will NOT replay)...'
    $uploadScript = Join-Path $PSScriptRoot 'upload_compact_snapshots_d1.ps1'
    $uploadExit = Invoke-ProcessExitCode -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $uploadScript))
    if ($uploadExit -ne 0) {
        throw ("Compact D1 upload failed with exit code {0}. Rerun the same command; completed chunks are checkpointed." -f $uploadExit)
    }

    Write-Step 'DONE: compact team snapshots + player/goalie aggregate layer synced to D1.'
}
finally {
    if ($SleepGuardEnabled) {
        try {
            $ES_CONTINUOUS = [Convert]::ToUInt32('80000000', 16)
            [void][HOHCompactExecutionState]::SetThreadExecutionState($ES_CONTINUOUS)
        } catch {}
    }
}
