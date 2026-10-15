$ErrorActionPreference='Stop'
$pfRoot='C:\Users\gamepad\Downloads\PackageFlow-webview-20261013'
$pfInstaller=Join-Path $pfRoot 'PackageFlowSetup-1.10.14-x64.exe'
$pfProgram='C:\Users\gamepad\AppData\Local\Programs\PackageFlow'
$pfSettings='C:\Users\gamepad\AppData\Local\PackageFlow\launcher.json'
$pfReport=Join-Path $pfRoot 'install-report.json'
try {
 if((Get-FileHash $pfInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne '2b389c08ee3ad9cd7dd971315d21db0a08ec0430fb4c25f8b8cfe9c338252779'){throw 'Installer SHA256 mismatch'}
 Copy-Item $pfSettings (Join-Path $pfRoot 'launcher-before-private.json') -Force
 $pfBefore=Get-Content $pfSettings -Raw|ConvertFrom-Json
 $pfProcess=Start-Process $pfInstaller -ArgumentList '/S' -PassThru
 if(!$pfProcess.WaitForExit(300000)){throw 'Installer is still running; no forced termination performed'}
 if($pfProcess.ExitCode -ne 0){throw ('Installer returned '+$pfProcess.ExitCode+'; safe update guard refused or setup failed')}
 $pfExe=Join-Path $pfProgram 'PackageFlow.exe'
 $pfAfter=Get-Content $pfSettings -Raw|ConvertFrom-Json
 $pfChecks=@{}
 foreach($pfField in @('Language','Mode','Port','PayloadPort','HostIp','GamesDirectory','AutoStart','SetupComplete','WizardComplete','TorrentSetupSelected','AutomaticSetupPending','ProtectedTrackerPassword','ProtectedProwlarrKey','ProtectedQbittorrentPassword','ProtectedLauncherKey','ConsoleId','PsIp','ConsolePlatform')){$pfChecks[$pfField]=($pfBefore.$pfField -eq $pfAfter.$pfField)}
 $pfManifest=Get-Content (Join-Path $pfProgram 'desktop-manifest.json') -Raw|ConvertFrom-Json
 foreach($pfFile in $pfManifest.files){if((Get-FileHash (Join-Path (Join-Path $pfProgram 'Desktop') $pfFile.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pfFile.sha256){throw ('Desktop file changed: '+$pfFile.path)}}
 $pfRuntime=Join-Path $pfProgram 'runtime\MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
 if((Get-FileHash $pfRuntime -Algorithm SHA256).Hash.ToLowerInvariant() -ne '2a6add76c37bfa872eb8c2b22d45b3216b8e2a1f193e0774006340ff62ac5fa0'){throw 'Offline runtime SHA256 mismatch'}
 $pfBundle=Get-Content (Join-Path $pfProgram 'console-setup\manifest.json') -Raw|ConvertFrom-Json
 foreach($pfPart in @('elf','app','ps4')){if((Get-FileHash (Join-Path (Join-Path $pfProgram 'console-setup') $pfBundle.$pfPart.fileName) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pfBundle.$pfPart.sha256){throw ('Console bundle changed: '+$pfPart)}}
 $pfSignature=Get-AuthenticodeSignature -LiteralPath $pfRuntime
 if($pfSignature.Status -ne 'Valid' -or $pfSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'Offline Microsoft runtime signature is invalid'}
 $pfResult=[pscustomobject]@{InstallerExitCode=$pfProcess.ExitCode;InstallerSha256=(Get-FileHash $pfInstaller -Algorithm SHA256).Hash.ToLowerInvariant();InstalledVersion=(Get-Item $pfExe).VersionInfo.FileVersion;InstalledSha256=(Get-FileHash $pfExe -Algorithm SHA256).Hash.ToLowerInvariant();RegistryVersion=(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PackageFlow').DisplayVersion;SettingsPreserved=$pfChecks;DesktopFilesVerified=$pfManifest.files.Count;RuntimeSignature=$pfSignature.Status.ToString();RuntimeSigner=$pfSignature.SignerCertificate.Subject;ConsoleBundle=(Get-Content (Join-Path $pfProgram 'console-setup\manifest.json') -Raw|ConvertFrom-Json);CaptureDirectory=(Join-Path $pfRoot 'installed-ui')}
 $pfResult|ConvertTo-Json -Depth 8|Set-Content $pfReport -Encoding UTF8
 if($pfResult.InstalledSha256 -ne 'e631b96cf7348c598d69b15a7a4d2c88d83d89b6b5f43a0bb0b74713e599a4a0'){throw 'Installed launcher differs from built payload'}
 if($pfChecks.Values -contains $false){throw 'A saved setting changed unexpectedly'}
 Start-Process $pfExe -ArgumentList ('--capture-ui="'+(Join-Path $pfRoot 'installed-ui')+'"')
} catch { [pscustomobject]@{Error=$_.Exception.Message}|ConvertTo-Json|Set-Content (Join-Path $pfRoot 'install-error.json') -Encoding UTF8;exit 1 }
