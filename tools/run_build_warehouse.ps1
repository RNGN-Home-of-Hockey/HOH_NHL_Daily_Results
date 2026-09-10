$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
$LogDir = Join-Path $RepoRoot 'local-data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ('warehouse-build-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

Write-Host ''
Write-Host 'HOH local analytics warehouse build'
Write-Host ('Repo: ' + $RepoRoot)
Write-Host ('Log:  ' + $LogFile)
Write-Host ''

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw 'Python was not found in PATH.' }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HOHWarehouseSleepGuard {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
$ES_CONTINUOUS = [Convert]::ToUInt32('80000000', 16)
$ES_SYSTEM_REQUIRED = [Convert]::ToUInt32('00000001', 16)
[void][HOHWarehouseSleepGuard]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

$exit = 1
try {
    & python tools\build_local_warehouse.py 2>&1 | Tee-Object -FilePath $LogFile
    $exit = $LASTEXITCODE
}
finally {
    [void][HOHWarehouseSleepGuard]::SetThreadExecutionState($ES_CONTINUOUS)
}

Write-Host ''
if ($exit -eq 0) {
    Write-Host 'DONE: local analytics warehouse is ready.'
    Write-Host ('Summary: ' + (Join-Path $RepoRoot 'local-data\warehouse\summary.json'))
    Write-Host ('SQLite:  ' + (Join-Path $RepoRoot 'local-data\warehouse\hoh_history.sqlite'))
    Write-Host ('D1 SQL:  ' + (Join-Path $RepoRoot 'local-data\warehouse\d1-chunks'))
} else {
    Write-Host ('Warehouse build exited with code ' + $exit + '. Check the log above.')
}
exit $exit
