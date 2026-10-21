param([int]$Port = 8908, [switch]$Admin, [switch]$Check, [string]$MailConfig)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localPython = Join-Path $projectRoot '.venv/Scripts/python.exe'
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath $localPython)) {
    if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv .venv }
    elseif (Get-Command python -ErrorAction SilentlyContinue) { & python -m venv .venv }
    else { throw 'Install Python 3.11 or later, then run this script again.' }
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
    & $localPython -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Dependencies could not be installed. Retry: .venv/Scripts/python.exe -m pip install -r requirements.txt' }
}
$launchArgs = @('scripts/start_local.py', '--port', "$Port")
if ($Admin) { $launchArgs += '--admin' }
if ($Check) { $launchArgs += '--check' }
if ($MailConfig) { $launchArgs += @('--mail-config', $MailConfig) }
& $localPython @launchArgs
exit $LASTEXITCODE
