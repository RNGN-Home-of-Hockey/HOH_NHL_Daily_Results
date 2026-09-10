$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$ManualDir = Join-Path $RepoRoot 'local-data\hockeystats\2025-26\teams'
$HistoryDir = Join-Path $RepoRoot 'local-data\nhl-history'
$LogDir = Join-Path $RepoRoot 'local-data\logs'
$LogFile = Join-Path $LogDir ('overnight-history-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

New-Item -ItemType Directory -Force -Path $ManualDir | Out-Null
New-Item -ItemType Directory -Force -Path $HistoryDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host ''
Write-Host 'HOH NHL overnight history download'
Write-Host ('Repo:        ' + $RepoRoot)
Write-Host ('Manual CSV:  ' + $ManualDir)
Write-Host ('NHL archive: ' + $HistoryDir)
Write-Host ('Log:         ' + $LogFile)
Write-Host ''

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    throw 'Python was not found in PATH.'
}

# Keep Windows awake while the unattended downloader is active.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HOHSleepGuard {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
# Windows PowerShell 5.1 parses the hex literal 0x80000000 as a signed Int32
# (-2147483648), which cannot be cast directly to UInt32. Convert from the
# hexadecimal string instead so the script works on both Windows PowerShell
# 5.1 and newer PowerShell versions.
$ES_CONTINUOUS = [Convert]::ToUInt32('80000000', 16)
$ES_SYSTEM_REQUIRED = [Convert]::ToUInt32('00000001', 16)
[void][HOHSleepGuard]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

$exit = 1
try {
    & python tools\bulk_history_download.py --workers 6 2>&1 | Tee-Object -FilePath $LogFile
    $exit = $LASTEXITCODE
}
finally {
    # Restore normal Windows sleep behavior when the script finishes or is interrupted.
    [void][HOHSleepGuard]::SetThreadExecutionState($ES_CONTINUOUS)
}

Write-Host ''
if ($exit -eq 0) {
    Write-Host 'DONE: both seasons are downloaded. You can close this window.'
    Write-Host ('Status: ' + (Join-Path $HistoryDir 'complete.json'))
} else {
    Write-Host ('Downloader exited with code ' + $exit + '. It is resumable: run this same script again.')
    Write-Host ('Failures: ' + (Join-Path $HistoryDir 'failed.json'))
}

exit $exit
