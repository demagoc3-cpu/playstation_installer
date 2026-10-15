$ErrorActionPreference='Stop'
$pfRoot='C:\Users\gamepad\Downloads\PackageFlow-webview-20261013'
Stop-ScheduledTask 'PackageFlow-WebView-Live-20261013' -ErrorAction SilentlyContinue
if(Test-Path (Join-Path $pfRoot 'live-report.json')){Move-Item (Join-Path $pfRoot 'live-report.json') (Join-Path $pfRoot 'previous-harness-report.json') -Force}
$pfAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $pfRoot 'verify-live.ps1')+'"') -WorkingDirectory $pfRoot
$pfPrincipal=New-ScheduledTaskPrincipal -UserId 'GAMEPAD-PC\Shara' -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'PackageFlow-WebView-Window-20261013' -Action $pfAction -Principal $pfPrincipal -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2)) -Force|Out-Null
Start-ScheduledTask 'PackageFlow-WebView-Window-20261013'
'User-close SC_CLOSE / tray / IPC verification dispatched'
