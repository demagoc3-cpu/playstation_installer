$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$pfRoot='C:\Users\gamepad\Downloads\PackageFlow-webview-20261013'
$pfProgram='C:\Users\gamepad\AppData\Local\Programs\PackageFlow'
if((Get-Item (Join-Path $pfProgram 'PackageFlow.exe')).VersionInfo.FileVersion -ne '1.10.14.0'){throw 'Expected the verified installed 1.10.14 before live checks'}
$pfSettings=Get-Content 'C:\Users\gamepad\AppData\Local\PackageFlow\launcher.json' -Raw|ConvertFrom-Json
$pfKey=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($pfSettings.ProtectedLauncherKey),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
$pfStatus=Invoke-RestMethod ('http://127.0.0.1:'+$pfSettings.Port+'/api/desktop/status') -Headers @{'X-PackageFlow-Launcher-Key'=$pfKey} -TimeoutSec 10
$pfStatus|Select-Object application,busy|ConvertTo-Json
if(!(Get-Process PackageFlow -ErrorAction SilentlyContinue|Where-Object {$_.SessionId -eq 1 -and $_.Path -eq (Join-Path $pfProgram 'PackageFlow.exe')})){Start-Process (Join-Path $pfProgram 'PackageFlow.exe');Start-Sleep -Seconds 12}
$pfProcess=@(Get-Process PackageFlow -ErrorAction Stop|Where-Object {$_.SessionId -eq 1 -and $_.Path -eq (Join-Path $pfProgram 'PackageFlow.exe')})[0]
$pfBeforeNode=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -eq (Join-Path $pfProgram 'runtime\node.exe')}|ForEach-Object {$_.ProcessId})
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PackageFlowWindowProbe { [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window,uint message,IntPtr command,IntPtr value); }'
$pfClosed=[PackageFlowWindowProbe]::PostMessage($pfProcess.MainWindowHandle,0x112,[IntPtr]0xF060,[IntPtr]0)
Start-Sleep -Milliseconds 800
$pfProcess.Refresh()
$pfHidden=(-not $pfProcess.HasExited -and $pfProcess.MainWindowHandle -eq 0)
$pfShow=Start-Process (Join-Path $pfProgram 'PackageFlow.exe') -PassThru
if(!$pfShow.WaitForExit(20000)){throw 'IPC reopening did not finish in 20 seconds; no forced termination'}
Start-Sleep -Milliseconds 400
$pfProcess.Refresh()
$pfAfterNode=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -eq (Join-Path $pfProgram 'runtime\node.exe')}|ForEach-Object {$_.ProcessId})
$pfBaseline=Get-Content (Join-Path $pfRoot 'launcher-before-private.json') -Raw|ConvertFrom-Json
$pfPreserved=@{}
foreach($pfField in @('Language','Mode','Port','PayloadPort','HostIp','GamesDirectory','AutoStart','WizardComplete','TorrentSetupSelected','ProtectedTrackerPassword','ProtectedProwlarrKey','ProtectedQbittorrentPassword','ProtectedLauncherKey')){$pfPreserved[$pfField]=($pfSettings.$pfField -eq $pfBaseline.$pfField)}
$pfResult=[pscustomobject]@{Version=(Get-Item (Join-Path $pfProgram 'PackageFlow.exe')).VersionInfo.FileVersion;PackageFlowPid=$pfProcess.Id;Session=$pfProcess.SessionId;CloseRequest=$pfClosed;CloseMessage='WM_SYSCOMMAND/SC_CLOSE (user close)';CloseHidesToTray=$pfHidden;ReopenExitCode=$pfShow.ExitCode;WindowRestored=($pfProcess.MainWindowHandle -ne 0);NodePidsPreserved=([string]::Join(',',$pfBeforeNode) -eq [string]::Join(',',$pfAfterNode));NodePids=$pfAfterNode;SettingsAfterStartupPreserved=$pfPreserved;ApiApplication=$pfStatus.application;Busy=$pfStatus.busy;TorrentSetupSelected=$pfSettings.TorrentSetupSelected;AutomaticSetupPending=$pfSettings.AutomaticSetupPending;CapturedPages=@(Get-ChildItem (Join-Path $pfRoot 'installed-ui') -Filter '*.png'|Select-Object Name,Length)}
$pfResult|ConvertTo-Json -Depth 5|Set-Content (Join-Path $pfRoot 'live-report.json') -Encoding UTF8
$pfResult|ConvertTo-Json -Depth 5

if(!$pfResult.CloseRequest -or !$pfResult.CloseHidesToTray -or !$pfResult.WindowRestored -or !$pfResult.NodePidsPreserved -or $pfResult.ReopenExitCode -ne 0){throw 'Window verification did not pass'}
