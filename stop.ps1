# Stops the dashboard backend started by start.ps1.

$pidFile = Join-Path $PSScriptRoot 'backend\.server.pid'

if (-not (Test-Path $pidFile)) {
    Write-Host 'Dashboard is not running (no PID file found).'
    exit 0
}

$proc = Get-Process -Id (Get-Content $pidFile) -ErrorAction SilentlyContinue
# Only kill it if the PID still belongs to node — Windows reuses PIDs.
if ($proc -and $proc.ProcessName -eq 'node') {
    Stop-Process -Id $proc.Id -Force
    Write-Host "Dashboard stopped (PID $($proc.Id))."
} else {
    Write-Host 'Dashboard was not running (stale PID file).'
}

Remove-Item $pidFile
