# Starts the dashboard backend in the background and opens it in the browser.
# Stop it with stop.ps1 (or stop.cmd).

$ErrorActionPreference = 'Stop'
$backend = Join-Path $PSScriptRoot 'backend'
$pidFile = Join-Path $backend '.server.pid'

# Already running? Don't start a second copy.
if (Test-Path $pidFile) {
    $existing = Get-Process -Id (Get-Content $pidFile) -ErrorAction SilentlyContinue
    if ($existing -and $existing.ProcessName -eq 'node') {
        Write-Host "Dashboard is already running (PID $($existing.Id)). Run stop.ps1 first."
        exit 0
    }
    Remove-Item $pidFile
}

if (-not (Test-Path (Join-Path $backend 'node_modules'))) {
    Write-Host 'Installing backend dependencies...'
    Push-Location $backend
    try { npm install --no-audit --no-fund } finally { Pop-Location }
}

$envFile = Join-Path $backend '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $backend '.env.example') $envFile
    Write-Host 'Created backend\.env from .env.example - fill in your NinjaOne credentials.'
}

# Read PORT from .env so the health check and browser use the right URL.
$port = 3000
$portLine = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }
$url = "http://localhost:$port"

$proc = Start-Process -FilePath 'node' -ArgumentList '--env-file=.env', 'server.js' -WorkingDirectory $backend `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $backend 'server.log') `
    -RedirectStandardError (Join-Path $backend 'server.err.log')
Set-Content -Path $pidFile -Value $proc.Id

# Wait up to ~10s for the server to answer before opening the browser.
for ($i = 0; $i -lt 20; $i++) {
    if ($proc.HasExited) {
        Write-Host "Server exited during startup. See backend\server.err.log:"
        Get-Content (Join-Path $backend 'server.err.log') -Tail 20
        Remove-Item $pidFile
        exit 1
    }
    try {
        Invoke-RestMethod "$url/api/health" -TimeoutSec 1 | Out-Null
        Write-Host "Dashboard running at $url (PID $($proc.Id)). Logs: backend\server.log"
        Start-Process $url
        exit 0
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

Write-Host "Server started (PID $($proc.Id)) but $url/api/health did not answer yet. Check backend\server.err.log."
