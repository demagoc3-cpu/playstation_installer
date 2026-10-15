$ErrorActionPreference='Stop'
$pfRoot='C:\Users\gamepad\Downloads\PackageFlow-webview-20261013'
$pfTests=Join-Path $pfRoot 'tests-verified'
$pfInstalled='C:\Users\gamepad\AppData\Local\Programs\PackageFlow'
foreach($pfPart in @('server','console-setup','Desktop')){if(Test-Path (Join-Path $pfTests $pfPart)){Remove-Item (Join-Path $pfTests $pfPart) -Recurse -Force};Copy-Item (Join-Path $pfInstalled $pfPart) (Join-Path $pfTests $pfPart) -Recurse -Force}
New-Item -ItemType Directory -Force (Join-Path $pfTests 'runtime')|Out-Null
Copy-Item (Join-Path $pfInstalled 'runtime\node.exe') (Join-Path $pfTests 'runtime\node.exe') -Force

$pfAction=New-ScheduledTaskAction -Execute (Join-Path $pfTests 'PackageFlow.Windows.Tests.exe') -Argument ('"'+(Join-Path $pfRoot 'web-runtime-final.txt')+'" --web-runtime') -WorkingDirectory $pfTests
$pfPrincipal=New-ScheduledTaskPrincipal -UserId 'GAMEPAD-PC\Shara' -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'PackageFlow-WebView-Runtime-20261013' -Action $pfAction -Principal $pfPrincipal -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3)) -Force|Out-Null
Start-ScheduledTask 'PackageFlow-WebView-Runtime-20261013'

'Installed source copied; isolated packaged WEB runtime checks dispatched'
