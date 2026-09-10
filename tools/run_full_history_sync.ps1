$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$LogDir = Join-Path $RepoRoot 'local-data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ('full-history-sync-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

$SleepGuardEnabled = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HOHExecutionState {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@ -ErrorAction SilentlyContinue
    $ES_CONTINUOUS = [Convert]::ToUInt32('80000000', 16)
    $ES_SYSTEM_REQUIRED = [uint32]0x00000001
    [void][HOHExecutionState]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
    $SleepGuardEnabled = $true
} catch {
    Write-Host 'WARNING: could not enable Windows sleep guard. Keep the PC awake manually.'
}

function Write-Step([string]$Text) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Text)
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Invoke-ChildPowerShell([string]$ScriptPath) {
    $process = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $ScriptPath)) `
        -NoNewWindow -Wait -PassThru
    return [int]$process.ExitCode
}

try {
    Write-Host ''
    Write-Host 'HOH FULL HISTORY SYNC -> CLOUDFLARE D1'
    Write-Host ('Repo: ' + $RepoRoot)
    Write-Host ('Log:  ' + $LogFile)
    Write-Host ''

    $seasonFolders = @(
        @{ Name = '2024-25'; Path = (Join-Path $RepoRoot 'local-data\hockeystats\2024-25\teams') },
        @{ Name = '2025-26'; Path = (Join-Path $RepoRoot 'local-data\hockeystats\2025-26\teams') }
    )

    foreach ($season in $seasonFolders) {
        if (-not (Test-Path $season.Path)) {
            throw ("Missing HockeyStats folder for {0}: {1}" -f $season.Name, $season.Path)
        }
        $count = @(Get-ChildItem $season.Path -Filter '*.csv' -File).Count
        Write-Step ("HockeyStats {0}: {1} CSV files" -f $season.Name, $count)
        if ($count -ne 32) {
            throw ("Expected exactly 32 CSV files for {0}, found {1}. Copy all team files before running." -f $season.Name, $count)
        }
    }

    $completeFile = Join-Path $RepoRoot 'local-data\nhl-history\complete.json'
    if (-not (Test-Path $completeFile)) {
        throw 'Missing NHL history complete.json. Run the overnight downloader first.'
    }

    Write-Step 'Rebuilding local analytics warehouse from official NHL archive + both HockeyStats seasons...'
    $buildExit = Invoke-ChildPowerShell (Join-Path $PSScriptRoot 'run_build_warehouse.ps1')
    Write-Step ("Warehouse child process exit code: {0}" -f $buildExit)
    if ($buildExit -ne 0) {
        throw ("Warehouse build failed with exit code {0}." -f $buildExit)
    }

    $summaryPath = Join-Path $RepoRoot 'local-data\warehouse\summary.json'
    if (-not (Test-Path $summaryPath)) {
        throw 'Warehouse summary.json was not produced.'
    }
    $summary = Get-Content $summaryPath -Raw | ConvertFrom-Json

    if (-not $summary.ok) { throw 'Warehouse summary reports ok=false.' }
    if ([int]$summary.official_games -ne 2792) {
        throw ("Expected 2792 official games, got {0}." -f $summary.official_games)
    }
    if (@($summary.official_errors).Count -ne 0) {
        throw ("Warehouse has {0} official parse errors." -f @($summary.official_errors).Count)
    }
    if ([int]$summary.manual_advanced.files -ne 64 -or [int]$summary.manual_advanced.matched_files -ne 64) {
        throw ("Expected 64/64 HockeyStats files matched, got {0}/{1}." -f $summary.manual_advanced.matched_files, $summary.manual_advanced.files)
    }
    if (@($summary.manual_advanced.unmatched).Count -ne 0) {
        throw ("Warehouse has {0} unmatched HockeyStats files." -f @($summary.manual_advanced.unmatched).Count)
    }

    Write-Step ("Warehouse validated: games={0}, team_features={1}, advanced_features={2}" -f `
        $summary.d1_rows.games, $summary.d1_rows.team_game_features, $summary.d1_rows.team_game_advanced_features)

    # Rebuilding changes SQL chunk contents, so start a fresh upload checkpoint.
    $stateFile = Join-Path $RepoRoot 'local-data\warehouse\d1-upload-state.json'
    if (Test-Path $stateFile) {
        Remove-Item $stateFile -Force
        Write-Step 'Old D1 upload checkpoint removed because the warehouse was rebuilt.'
    }

    $uploadScript = Join-Path $PSScriptRoot 'upload_warehouse_d1.ps1'
    $maxAttempts = 5
    $success = $false
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt += 1) {
        Write-Step ("D1 upload attempt {0}/{1}..." -f $attempt, $maxAttempts)
        $uploadExit = Invoke-ChildPowerShell $uploadScript
        Write-Step ("D1 uploader child process exit code: {0}" -f $uploadExit)
        if ($uploadExit -eq 0) {
            $success = $true
            break
        }

        if ($attempt -lt $maxAttempts) {
            $delay = 30 * $attempt
            Write-Step ("Upload attempt failed with exit code {0}; retrying in {1}s. Completed chunks will be skipped." -f $uploadExit, $delay)
            Start-Sleep -Seconds $delay
        }
    }

    if (-not $success) {
        throw ("D1 upload failed after {0} attempts. The checkpoint is preserved for a later resume." -f $maxAttempts)
    }

    Write-Step 'DONE: both seasons are rebuilt and uploaded to Cloudflare D1.'
    Write-Host ''
    Write-Host 'You can leave this window open; no further action is required.'
}
finally {
    if ($SleepGuardEnabled) {
        try {
            $ES_CONTINUOUS = [Convert]::ToUInt32('80000000', 16)
            [void][HOHExecutionState]::SetThreadExecutionState($ES_CONTINUOUS)
        } catch {}
    }
}
