# Start the already migrated acceptance copy. Never selects the original database.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$acceptanceDatabase = Join-Path $projectRoot 'artifacts/v7-acceptance-20260928.sqlite'
$pythonExecutable = Join-Path $projectRoot 'artifacts/venv-ce/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $acceptanceDatabase)) { throw 'Acceptance database is missing. See planning/v7/IMPLEMENTATION.md.' }
if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw 'Local Python environment is missing.' }
$env:LOTTERY_ENV = 'development'
$env:LOTTERY_DB = $acceptanceDatabase
$env:LOTTERY_PUBLIC_URL = 'http://127.0.0.1:8901'
$env:V6_SALES_ENABLED = '0'
Set-Location -LiteralPath $projectRoot
Write-Host 'V7: http://127.0.0.1:8901/login.html (sales disabled)'
& $pythonExecutable -m uvicorn server:app --host 127.0.0.1 --port 8901
