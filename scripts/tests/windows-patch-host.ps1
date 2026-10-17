# Pure host tests. Load ONLY function definitions from the updater AST.
# Never invoke the updater entry point, Windows process control, or networking.
param(
    [string]$Updater = (Join-Path $PSScriptRoot '../update-installed-windows-web.ps1'),
    [string]$BaseSnapshot = ''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Updater,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors.Message -join '; ') }
$assignments=$ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst]},$true)
foreach ($assignment in $assignments) {
    $variables=$assignment.Left.FindAll({param($node) $node -is [Management.Automation.Language.VariableExpressionAst]},$true)
    foreach ($variable in $variables) {
        if ($variable.VariablePath.UserPath -imatch '^(home|codex_home|pid|host|args|input|PSItem|_|Error|Matches|LastExitCode|MyInvocation)$') { throw 'Assignment to an automatic/reserved variable' }
    }
}
foreach ($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}
$checks=0
function Check([bool]$Condition,[string]$Message) { if (!$Condition) { throw $Message }; $script:checks++ }
function Must-Reject([scriptblock]$Action,[string]$Message) {
    $rejected=$false
    try { $null=& $Action } catch { $rejected=$true }
    Check $rejected $Message
}
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('pf-patch-host-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($fixture)
try {
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        # Exercise the production constructor and real filesystem ACE roundtrip
        # before the updater can stop a process. No Windows application is run.
        $acl=New-PrivateDirectoryAcl
        $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
        $rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))
        Check ($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $identity.Value) 'Private ACL must contain the current typed SID, not a string account lookup'
        $aclFixture=Join-Path $fixture 'acl-roundtrip'
        $null=[IO.Directory]::CreateDirectory($aclFixture)
        Set-Acl -LiteralPath $aclFixture -AclObject $acl
        $roundtrip=Get-Acl -LiteralPath $aclFixture
        $roundtripRules=@($roundtrip.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))
        Check ($roundtrip.AreAccessRulesProtected -and $roundtripRules.Count -eq 1 -and $roundtripRules[0].IdentityReference.Value -eq $identity.Value -and $roundtripRules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($roundtripRules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) 'Real Windows private ACE did not survive Set-Acl/Get-Acl'
    }
    if ($BaseSnapshot) {
        $base=Get-Content -LiteralPath $BaseSnapshot -Raw | ConvertFrom-Json
        Validate-Records $base.web.files -Web
        Check ((Tree-Hash $base.web.files) -ceq $base.web.treeSha256) 'Real captured base differs from the Python/PowerShell tree hash contract'
    }
    foreach ($name in @('../escape','/root','C:/escape','x\y','x/NUL.json','x/COM1','x/end.','x/end ','a//b')) {
        Must-Reject { Safe-Relative $name } ('Accepted unsafe path: '+$name)
    }
    $web=Join-Path $fixture 'web'; $null=[IO.Directory]::CreateDirectory((Join-Path $web 'server'))
    $file=Join-Path $web 'server/index.mjs'; [IO.File]::WriteAllText($file,'fixture web')
    $record=@{path='server/index.mjs';size=(Get-Item $file).Length;sha256=(File-Hash $file)}
    Validate-Records @($record) -Web
    $identity=@{files=@($record);treeSha256=(Tree-Hash @($record))}
    Assert-Tree $web $identity
    Check (Paths-Overlap $web (Join-Path $web 'nested')) 'Nested data/WEB overlap not recognized'
    Check (!(Paths-Overlap $web (Join-Path $fixture 'web-other'))) 'Sibling data was incorrectly rejected'
    $expected=Text-Hash ('server/index.mjs'+"`t"+$record.size+"`t"+$record.sha256+"`n")
    Check ($identity.treeSha256 -ceq $expected) 'Tree hash contract differs'
    Must-Reject { Validate-Records @($record,@{path='SERVER/index.mjs';size=1;sha256=('a'*64)}) -Web } 'Accepted Windows case collision'
    Must-Reject { Validate-Records @($record,@{path='server';size=1;sha256=('a'*64)}) -Web } 'Accepted file/directory conflict'
    [IO.File]::WriteAllText((Join-Path $web 'extra'),'unexpected')
    Must-Reject { Assert-Tree $web $identity } 'Accepted an extra installed file'
    Remove-Item -LiteralPath (Join-Path $web 'extra')
    [IO.File]::WriteAllText($file,'tampered web')
    Must-Reject { Assert-Tree $web $identity } 'Accepted altered installed bytes'
    [IO.File]::WriteAllText($file,'fixture web')
    Assert-Tree $web $identity

    $artifactDirectory=Join-Path $fixture 'artifacts'; $null=[IO.Directory]::CreateDirectory($artifactDirectory)
    $activeManifest=Join-Path $artifactDirectory 'manifest.json'
    $old=Join-Path $fixture 'manifest.before'; $next=Join-Path $fixture 'manifest.next'
    [IO.File]::WriteAllText($old,'old manifest exact bytes')
    [IO.File]::WriteAllText($next,'new manifest exact bytes')
    Set-ServiceManifest $next
    Check ((File-Hash $activeManifest) -ceq (File-Hash $next)) 'Manifest switch failed'
    Set-ServiceManifest $old
    Check ((File-Hash $activeManifest) -ceq (File-Hash $old)) 'Previous manifest bytes were not restored'
    Set-ServiceManifest ''
    Check (!(Test-Path $activeManifest)) 'Originally absent manifest not restored to absence'

    $journalPath=Join-Path $fixture 'journal.json'
    $journal=@{state='prepared';updatedUtc='';patchId='fixture'}
    Save-Journal 'stopping'
    $saved=Get-Content -Raw -LiteralPath $journalPath | ConvertFrom-Json
    Check ($saved.state -eq 'stopping' -and !(Test-Path ($journalPath+'.tmp'))) 'Write-ahead journal not atomically replaced'

    # Exercise the actual stop policy, replacing all OS/network interactions.
    # Busy rejection must happen BEFORE even attempting a process identity/kill.
    $identityCalled=$false
    function Desktop-Request($Method,$Route) {
        if ($Route -eq '/api/desktop/status') { return @{status=200;body=@{application='PackageFlow';processId=12345}} }
        return @{status=200;body=@{busy=$true;reasons=@('storage-indexing')}}
    }
    function Owned-Node { $script:identityCalled=$true; throw 'No OS process may be consulted by this fixture' }
    $fakeProcess=[pscustomobject]@{ProcessId=12345;CreationDate=[DateTime]::UtcNow}
    Must-Reject { Stop-OwnedNode $fakeProcess } 'Busy stop was accepted'
    Check (!$identityCalled) 'Busy guard did not precede process control'
    function Desktop-Request { throw 'Lost loopback response' }
    Must-Reject { Stop-OwnedNode $fakeProcess } 'Unknown status allowed a stop'
    Check (!$identityCalled) 'Unknown status reached process control'

    # Test the real retry/lease/kill policy with a fake monotonic clock,
    # transport and process handle. No fixture can open or kill a real process.
    function Stop-ClockMs { return $script:stopClock }
    function Owned-Node($NodeId,$Creation) {
        $script:identityCalls++
        if ($script:rejectIdentity) { throw 'Fixture process identity changed' }
        if ($NodeId -ne 12345 -or $Creation -cne $fakeProcess.CreationDate.ToUniversalTime().ToString('o')) { throw 'Missing exact process creation identity' }
        $script:stopClock+=$script:identityDelay
        return $fakeProcess
    }
    function Open-NodeProcess($NodeId) {
        $script:openCalls++
        if ($NodeId -ne 12345) { throw 'Wrong process handle requested' }
        $script:stopClock+=$script:openDelay
        return $script:fakeHandle
    }
    function Desktop-Request($Method,$Route,$TimeoutMs=5000) {
        if ($Method -eq 'GET' -and $Route -eq '/api/desktop/status') { return $script:statusReply }
        if ($Method -ne 'POST' -or $Route -ne '/api/desktop/prepare-stop') { throw 'Unexpected fixture route' }
        $script:postCalls++
        $script:postTimeouts+=@($TimeoutMs)
        if ($script:postCalls -gt $script:stopSteps.Count) { throw 'Unexpected retry after terminal reply' }
        $step=$script:stopSteps[$script:postCalls-1]
        $script:stopClock+=$step.ms
        if ($step.ContainsKey('error')) { throw $step.error }
        return $step.reply
    }
    function Set-StopFixture($Steps) {
        $script:stopSteps=@($Steps); $script:stopClock=1000.0
        $script:postCalls=0; $script:postTimeouts=@(); $script:identityCalls=0; $script:openCalls=0
        $script:killCalls=0; $script:waitCalls=0; $script:killAttempted=$false
        $script:identityDelay=0; $script:openDelay=0; $script:rejectIdentity=$false
        $script:statusReply=@{status=200;body=@{application='PackageFlow';processId=12345}}
        $script:fakeHandle=New-Object PSObject
        $script:fakeHandle | Add-Member ScriptMethod Kill { $script:killCalls++ }
        $script:fakeHandle | Add-Member ScriptMethod WaitForExit { param($Timeout); $script:waitCalls++; return $Timeout -eq 5000 }
    }
    $requestBusy=@{status=200;body=@{busy=$true;reasons=@('request')}}
    $idleReply=@{status=200;body=@{busy=$false;reasons=@()}}
    $busyStep=@{ms=1500;reply=$requestBusy}
    $idleStep=@{ms=1500;reply=$idleReply}
    foreach ($busyCount in @(0,1,10,11)) {
        Set-StopFixture (@($busyStep)*$busyCount+@($idleStep))
        Stop-OwnedNode $fakeProcess
        Check ($postCalls -eq $busyCount+1 -and $killCalls -eq 1 -and $killAttempted -and $waitCalls -eq 1) 'Acknowledged request-only drain must stop once at first idle reply'
        Check ($identityCalls -eq 1 -and $openCalls -eq 1) 'Successful drain must preserve exact identity/handle guard'
    }
    $badReplies=@(
        @{status=503;body=@{busy=$true;reasons=@('request')}},
        @{status=302;body=@{busy=$true;reasons=@('request')}},
        @{status='200';body=@{busy=$true;reasons=@('request')}},
        @{status=200;body=@{busy='true';reasons=@('request')}},
        @{status=200;body=@{busy=1;reasons=@('request')}},
        @{status=200;body=@{busy=$true;reasons='request'}},
        @{status=200;body=@{busy=$true;reasons=@()}},
        @{status=200;body=@{busy=$true;reasons=@('REQUEST')}},
        @{status=200;body=@{busy=$true;reasons=@('request','request')}},
        @{status=200;body=@{busy=$true;reasons=@('request','transfer')}},
        @{status=200;body=@{busy=$false;reasons=@('request')}},
        @{status=200;body=@{busy=$false;reasons=''}},
        @{status=200;body=@{busy=$true}},
        @{status=200;body=@{reasons=@('request')}},
        @{status=200;body=$null},
        @{status=200;body=@()},
        @{body=@{busy=$false;reasons=@()}}
    )
    foreach ($reason in @('installation','transfer','storage-indexing','maintenance','removal','local-installation','command','ps5-installation','ps5-bootstrap','unknown')) {
        $badReplies+=@{status=200;body=@{busy=$true;reasons=@($reason)}}
    }
    foreach ($badReply in $badReplies) {
        foreach ($prefix in @(0,1)) {
            Set-StopFixture (@($busyStep)*$prefix+@(@{ms=1500;reply=$badReply},$idleStep))
            Must-Reject { Stop-OwnedNode $fakeProcess } 'Malformed or real-work drain allowed a stop'
            Check ($postCalls -eq $prefix+1 -and $identityCalls -eq 0 -and $openCalls -eq 0 -and $killCalls -eq 0 -and !$killAttempted) 'Rejected drain retried or reached process control'
        }
    }
    foreach ($prefix in @(0,1)) {
        Set-StopFixture (@($busyStep)*$prefix+@(@{ms=5000;error='Timed out after an unknown drain result'},$idleStep))
        Must-Reject { Stop-OwnedNode $fakeProcess } 'Lost drain response allowed a stop'
        Check ($postCalls -eq $prefix+1 -and $identityCalls -eq 0 -and $killCalls -eq 0) 'Lost drain response was retried'
    }
    Set-StopFixture (@($busyStep)*12+@($idleStep))
    Must-Reject { Stop-OwnedNode $fakeProcess } 'Thirteenth POST allowed'
    Check ($postCalls -eq 12 -and $identityCalls -eq 0 -and $killCalls -eq 0) 'Twelve-POST bound failed'
    Set-StopFixture (@(@{ms=5000;reply=$requestBusy})*4+@($idleStep))
    Must-Reject { Stop-OwnedNode $fakeProcess } 'Twenty-second budget allowed another POST'
    Check ($postCalls -eq 4 -and $identityCalls -eq 0 -and $killCalls -eq 0) 'Monotonic budget failed'
    Set-StopFixture @(@{ms=19001;reply=$requestBusy},@{ms=1000;reply=$idleReply})
    Must-Reject { Stop-OwnedNode $fakeProcess } 'Late idle reply exceeded total budget'
    Check ($postCalls -eq 2 -and $postTimeouts[1] -eq 999 -and $killCalls -eq 0) 'Remaining budget was not passed to transport'
    Set-StopFixture @(@{ms=-1;reply=$idleReply})
    Must-Reject { Stop-OwnedNode $fakeProcess } 'Backward clock accepted'
    Check ($postCalls -eq 1 -and $killCalls -eq 0) 'Invalid clock reached kill'
    foreach ($delayTarget in @('identity','handle')) {
        Set-StopFixture @(@{ms=5000;reply=$idleReply},$idleStep)
        if ($delayTarget -eq 'identity') { $script:identityDelay=5000 } else { $script:openDelay=5000 }
        Must-Reject { Stop-OwnedNode $fakeProcess } 'Expired stop lease accepted'
        Check ($postCalls -eq 1 -and $killCalls -eq 0 -and !$killAttempted) 'Lease renewed after idle or kill attempted at ten seconds'
    }
    Set-StopFixture @(@{ms=5000;reply=$idleReply})
    $script:identityDelay=4999
    Stop-OwnedNode $fakeProcess
    Check ($postCalls -eq 1 -and $killCalls -eq 1) 'Valid lease below ten seconds rejected'
    Set-StopFixture @($idleStep)
    $script:rejectIdentity=$true
    Must-Reject { Stop-OwnedNode $fakeProcess } 'Changed process identity accepted'
    Check ($postCalls -eq 1 -and $openCalls -eq 0 -and $killCalls -eq 0) 'Changed identity reached process handle'
    foreach ($badStatus in @(@{status=503;body=@{application='PackageFlow';processId=12345}},@{status=200;body=@{application='Other';processId=12345}},@{status=200;body=@{application='PackageFlow';processId=54321}})) {
        Set-StopFixture @($idleStep)
        $script:statusReply=$badStatus
        Must-Reject { Stop-OwnedNode $fakeProcess } 'Unowned initial WEB status accepted'
        Check ($postCalls -eq 0 -and $killCalls -eq 0) 'Unowned initial WEB status sent a drain'
    }

    # Start failure must restore the calling process environment, including key.
    $settings=[pscustomobject]@{Port=3000;PayloadPort=3001;HostIp='192.168.1.2'}
    $dataDirectory=Join-Path $fixture 'data'; $backupDirectory=$fixture
    $InstallDirectory=$fixture; $nodeExe='not-executed-node'; $entry='not-executed-entry'
    $ProbePath=@(); $launcherKey='fixture-only-not-a-secret'
    $previousKey=[Environment]::GetEnvironmentVariable('PACKAGEFLOW_LAUNCHER_KEY','Process')
    $previousPort=[Environment]::GetEnvironmentVariable('PORT','Process')
    function Start-Process { throw 'Host fixture never starts a child' }
    Must-Reject { Start-Web } 'Start fixture unexpectedly succeeded'
    Check ([Environment]::GetEnvironmentVariable('PACKAGEFLOW_LAUNCHER_KEY','Process') -ceq $previousKey) 'Launcher key leaked into parent environment'
    Check ([Environment]::GetEnvironmentVariable('PORT','Process') -ceq $previousPort) 'Parent port environment was changed'
    Write-Output ('PASS: PowerShell parser/reserved-variable audit and '+$checks+' host checks; no network, application process or PS5 control')
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
