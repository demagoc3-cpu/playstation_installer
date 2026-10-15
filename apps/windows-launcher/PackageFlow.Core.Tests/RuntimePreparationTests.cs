using System.Net;
using System.Security.Cryptography;
using PackageFlow.Core;
internal static class RuntimePreparationTests
{
    private static void Check(bool condition,string message){if(!condition)throw new Exception(message);}
    private static async Task Reject(Func<Task> run){try{await run();}catch{return;}throw new Exception("Expected Runtime preparation failure");}
    private sealed class Host : IRuntimePreparationHost {
        public string? Version;public RuntimeAttempt? Attempt;public int Downloads,Installs;public int? Exit=0;public bool ReadyAfterInstall;public Exception? DownloadError;
        public string? ResolveRuntime()=>Version;public RuntimeAttempt? ReadAttempt()=>Attempt;public void WriteAttempt(RuntimeAttempt value)=>Attempt=value;
        public Task<RuntimeInstallerFile> PrepareInstaller(IProgress<RuntimeProgress> progress,CancellationToken ct){Downloads++;if(DownloadError!=null)throw DownloadError;return Task.FromResult(new RuntimeInstallerFile("fixture-only-never-executed.exe"));}
        public Task<int?> RunInstaller(RuntimeInstallerFile file,CancellationToken ct){Installs++;if(ReadyAfterInstall)Version="155.0.1.0";return Task.FromResult(Exit);}
        public Task Delay(CancellationToken ct)=>Task.CompletedTask;
    }
    private sealed class Progress : IProgress<RuntimeProgress> {public List<string> Stages=[];public void Report(RuntimeProgress value)=>Stages.Add(value.Stage);}
    private sealed class Transport(Func<HttpRequestMessage,HttpResponseMessage> send) : HttpMessageHandler {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>Task.FromResult(send(request));}
    public static async Task Run(string folder) {
        var ready=new Host{Version="155.0.4283.45"};await RuntimePreparation.Ensure(ready,new Progress(),false,default);Check(ready.Downloads==0&&ready.Installs==0,"Installed Runtime caused a download or installation");
        Check(!RuntimePreparation.Supported("119.0.0.0")&&!RuntimePreparation.Supported("155.0.1.0 beta"),"Unsupported/preview channel accepted as supported Runtime");
        var missing=new Host{ReadyAfterInstall=true};var progress=new Progress();await RuntimePreparation.Ensure(missing,progress,false,default);Check(missing.Installs==1&&missing.Attempt?.State=="complete"&&progress.Stages.Contains("verify")&&progress.Stages.Last()=="ready","Missing Runtime installation was not reverified");
        foreach(var error in new Exception[]{new HttpRequestException("network unavailable"),new InvalidDataException("SHA256 mismatch"),new InvalidDataException("Microsoft signature invalid")}) {
            var host=new Host{DownloadError=error};var p=new Progress();await Reject(()=>RuntimePreparation.Ensure(host,p,false,default));Check(host.Installs==0&&!p.Stages.Contains("ready"),"Unsafe download/signature executed or false ready");
            await Reject(()=>RuntimePreparation.Ensure(host,p,false,default));Check(host.Downloads==1,"Automatic failed download retry");
        }
        var failed=new Host{Exit=123};var failProgress=new Progress();await Reject(()=>RuntimePreparation.Ensure(failed,failProgress,false,default));Check(failed.Attempt?.State=="failed"&&!failProgress.Stages.Contains("ready"),"Nonzero installer exit accepted");
        failed.Exit=0;failed.ReadyAfterInstall=true;await RuntimePreparation.Ensure(failed,new Progress(),true,default);Check(failed.Installs==2,"Explicit retry after known installer failure did not work");
        foreach(var exit in new int?[]{null,0}) {
            var pending=new Host{Exit=exit};var p=new Progress();await Reject(()=>RuntimePreparation.Ensure(pending,p,false,default));await Reject(()=>RuntimePreparation.Ensure(pending,p,true,default));Check(pending.Installs==1&&pending.Attempt?.State=="unconfirmed"&&!p.Stages.Contains("ready"),"Unconfirmed installer was replayed or accepted");
            pending.Version="155.0.1.0";await RuntimePreparation.Ensure(pending,new Progress(),true,default);Check(pending.Installs==1,"Reconciliation reinstalled Runtime");
        }
        var launching=new Host{Attempt=new("launching")};await Reject(()=>RuntimePreparation.Ensure(launching,new Progress(),true,default));Check(launching.Installs==0,"Crash between dispatch and pid journal replayed installer");
        var bytes=Enumerable.Range(0,4096).Select(n=>(byte)n).ToArray();var hash=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();var pin=new RuntimeDownloadPin("MicrosoftEdgeWebview2Setup.exe","https://msedge.sf.dl.delivery.mp.microsoft.com/fixture.exe",bytes.Length,hash);var target=Path.Combine(folder,"runtime-download.exe");
        using(var http=new HttpClient(new Transport(_=>new(HttpStatusCode.OK){Content=new ByteArrayContent(bytes)})))await RuntimeDownload.Fetch(http,pin,target,null,default);
        Check(File.ReadAllBytes(target).SequenceEqual(bytes),"Verified bootstrapper transport differs");
        using(var bad=new HttpClient(new Transport(_=>new(HttpStatusCode.OK){Content=new ByteArrayContent(bytes)})))await Reject(()=>RuntimeDownload.Fetch(bad,pin with{Sha256=new string('0',64)},target,null,default));
        Check(File.ReadAllBytes(target).SequenceEqual(bytes),"Bad hash replaced verified file");
        foreach(var url in new[]{"http://msedge.sf.dl.delivery.mp.microsoft.com/a","https://attacker.test/a","https://msedge.sf.dl.delivery.mp.microsoft.com:444/a","https://user@msedge.sf.dl.delivery.mp.microsoft.com/a"}) {
            int calls=0;using var http=new HttpClient(new Transport(_=>{calls++;var response=new HttpResponseMessage(HttpStatusCode.Redirect);response.Headers.Location=new Uri(url);return response;}));await Reject(()=>RuntimeDownload.Fetch(http,pin,target,null,default));Check(calls==1,"Untrusted redirect followed");
        }
        using(var http=new HttpClient(new Transport(_=>new(HttpStatusCode.ServiceUnavailable))))await Reject(()=>RuntimeDownload.Fetch(http,pin,target,null,default));
        using(var http=new HttpClient(new Transport(_=>new(HttpStatusCode.OK){Content=new ByteArrayContent(bytes[..100])})))await Reject(()=>RuntimeDownload.Fetch(http,pin,target,null,default));
        Check(!Directory.GetFiles(folder,"*.part-*").Any(),"Failed Runtime download left staging files");
    }
}
