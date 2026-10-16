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
    Write-Output ('PASS: PowerShell parser/reserved-variable audit and '+$checks+' host checks; no network, Windows or PS5 execution')
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
