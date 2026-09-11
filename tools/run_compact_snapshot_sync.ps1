$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
$LogDir = Join-Path $RepoRoot 'local-data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ('compact-snapshot-sync-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

# D1 Free row-read quota was exhausted on 2026-09-11. Do all expensive local
# work immediately, then wait until shortly after the next UTC reset before the
# first remote D1 operation. Future reruns naturally skip this wait.
$D1NotBeforeUtc = [DateTimeOffset]::Parse('2026-09-12T00:05:00Z')

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

function Wait-ForD1Reset {
    $now = [DateTimeOffset]::UtcNow
    if ($now -ge $D1NotBeforeUtc) { return }
    $remaining = $D1NotBeforeUtc - $now
    Write-Step ("D1 Free quota reset guard: waiting until {0} UTC ({1:hh\:mm\:ss} remaining). Local build is already complete; no user action is needed." -f `
        $D1NotBeforeUtc.ToString('yyyy-MM-dd HH:mm'), $remaining)
    while ([DateTimeOffset]::UtcNow -lt $D1NotBeforeUtc) {
        $seconds = [Math]::Min(300, [Math]::Ceiling(($D1NotBeforeUtc - [DateTimeOffset]::UtcNow).TotalSeconds))
        if ($seconds -gt 0) { Start-Sleep -Seconds $seconds }
    }
    Write-Step 'D1 quota reset guard elapsed; starting remote operations.'
}

try {
    Write-Host ''
    Write-Host 'HOH COMPACT SNAPSHOT + PLAYER MARKET LAYER + APPS SYNC + DEPLOY'
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

    Write-Step 'Building current 5/10/20 team rankings for Control Center and Telegram Mini App...'
    $currentTeamExit = Invoke-ProcessExitCode -FilePath $python.Source -ArgumentList @((Join-Path $PSScriptRoot 'build_current_team_snapshots.py'))
    if ($currentTeamExit -ne 0) { throw ("Current team snapshot build failed with exit code {0}." -f $currentTeamExit) }

    Write-Step 'Building compact individual market hit rates (assists, shots, hits, blocks, opponent splits)...'
    $playerMarketExit = Invoke-ProcessExitCode -FilePath $python.Source -ArgumentList @((Join-Path $PSScriptRoot 'build_player_market_snapshots.py'))
    if ($playerMarketExit -ne 0) { throw ("Player market snapshot build failed with exit code {0}." -f $playerMarketExit) }

    Write-Step 'Building low-read Data Core metadata chunk...'
    $metaExit = Invoke-ProcessExitCode -FilePath $python.Source -ArgumentList @((Join-Path $PSScriptRoot 'build_data_core_meta.py'))
    if ($metaExit -ne 0) { throw ("Data Core metadata build failed with exit code {0}." -f $metaExit) }

    $summaryPath = Join-Path $RepoRoot 'local-data\warehouse\compact-snapshots-summary.json'
    if (-not (Test-Path $summaryPath)) { throw 'Compact snapshot summary was not produced.' }
    $summary = Get-Content $summaryPath -Raw | ConvertFrom-Json
    if (-not $summary.ok) { throw 'Compact snapshot summary reports ok=false.' }
    if ([int]$summary.validation.official_games -ne 2792) {
        throw ("Expected 2792 official games, found {0}." -f $summary.validation.official_games)
    }

    $currentSummaryPath = Join-Path $RepoRoot 'local-data\warehouse\current-team-snapshots-summary.json'
    if (-not (Test-Path $currentSummaryPath)) { throw 'Current team snapshot summary was not produced.' }
    $currentSummary = Get-Content $currentSummaryPath -Raw | ConvertFrom-Json
    if (-not $currentSummary.ok) { throw 'Current team snapshot summary reports ok=false.' }

    $playerMarketSummaryPath = Join-Path $RepoRoot 'local-data\warehouse\player-market-snapshots-summary.json'
    if (-not (Test-Path $playerMarketSummaryPath)) { throw 'Player market snapshot summary was not produced.' }
    $playerMarketSummary = Get-Content $playerMarketSummaryPath -Raw | ConvertFrom-Json
    if (-not $playerMarketSummary.ok) { throw 'Player market snapshot summary reports ok=false.' }

    # build_data_core_meta.py emits only a few tiny rows. Keep margin so new
    # metadata keys cannot accidentally trip safety math.
    $metaRowsEstimate = 32
    $writes = [int]$summary.supplemental_writes_estimate + [int]$currentSummary.rows + [int]$playerMarketSummary.d1_writes_estimate + $metaRowsEstimate
    Write-Step ("Local build validated: player-game={0}, goalie-game={1}, historical-team-snapshots={2}, current-team-snapshots={3}, player-market-snapshots={4}, supplemental D1 rows<={5}" -f `
        $summary.validation.player_game_rows_local, $summary.validation.goalie_game_rows_local, $summary.local_rows.pregame_team_snapshots, $currentSummary.rows, $playerMarketSummary.rows, $writes)
    if ($writes -gt 85000) {
        throw ("Supplemental package is approximately {0} rows, above the 85k safety ceiling for D1 Free. Do not upload until split into multiple days." -f $writes)
    }

    # New compact chunks changed, so reset only the supplemental checkpoint.
    $stateFile = Join-Path $RepoRoot 'local-data\warehouse\d1-compact-supplement-upload-state.json'
    if (Test-Path $stateFile) { Remove-Item $stateFile -Force }

    Wait-ForD1Reset

    $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
    Write-Step 'Applying all pending D1 migrations (compact/player/app/notification/meta/market layers)...'
    $migrationExit = Invoke-ProcessExitCode -FilePath $npx -ArgumentList @('wrangler','d1','migrations','apply','hoh-data-core','--remote')
    if ($migrationExit -ne 0) { throw ("D1 migration failed with exit code {0}." -f $migrationExit) }

    Write-Step 'Uploading supplemental compact chunks only (070-135; historical 010-060 will NOT replay)...'
    $uploadScript = Join-Path $PSScriptRoot 'upload_compact_snapshots_d1.ps1'
    $uploadExit = Invoke-ProcessExitCode -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $uploadScript))
    if ($uploadExit -ne 0) {
        throw ("Compact D1 upload failed with exit code {0}. Rerun the same command; completed chunks are checkpointed." -f $uploadExit)
    }

    Write-Step 'Deploying Worker with Control Center + Matchup Lab + Broadcast Operator + Telegram Mini App...'
    $deployExit = Invoke-ProcessExitCode -FilePath $npx -ArgumentList @('wrangler','deploy')
    if ($deployExit -ne 0) { throw ("Worker deploy failed with exit code {0}. Compact D1 data is already safe; rerun the same command." -f $deployExit) }

    Write-Step 'DONE: compact data, player markets, current rankings, low-read metadata, web and Telegram products deployed.'
    Write-Host ''
    Write-Host 'Telegram live notifications remain OFF until an explicit dry-run validation enables them.'
}
finally {
    if ($SleepGuardEnabled) {
        try {
            $ES_CONTINUOUS = [Convert]::ToUInt32('80000000', 16)
            [void][HOHCompactExecutionState]::SetThreadExecutionState($ES_CONTINUOUS)
        } catch {}
    }
}
