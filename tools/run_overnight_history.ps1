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
Write-Host ('Repo:       ' + $RepoRoot)
Write-Host ('Manual CSV: ' + $ManualDir)
Write-Host ('NHL archive:' + $HistoryDir)
Write-Host ('Log:        ' + $LogFile)
Write-Host ''

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    throw 'Python was not found in PATH.'
}

& python tools\bulk_history_download.py --workers 6 2>&1 | Tee-Object -FilePath $LogFile
$exit = $LASTEXITCODE

Write-Host ''
if ($exit -eq 0) {
    Write-Host 'DONE: both seasons are downloaded. You can close this window.'
    Write-Host ('Status: ' + (Join-Path $HistoryDir 'complete.json'))
} else {
    Write-Host ('Downloader exited with code ' + $exit + '. It is resumable: run this same script again.')
    Write-Host ('Failures: ' + (Join-Path $HistoryDir 'failed.json'))
}

exit $exit
