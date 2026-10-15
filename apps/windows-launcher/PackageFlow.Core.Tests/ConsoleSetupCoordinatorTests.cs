using System.Text.Json;
using System.Text.Json.Nodes;
using PackageFlow.Core;

internal static class ConsoleSetupCoordinatorTests
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class Fixture
    {
        public readonly LauncherSettings Settings = new();
        public readonly List<(string Path, JsonNode? Body)> Calls = [];
        public bool Paired, Offline, Unconfirmed, AbsentRetry, Ps4, Restoring;
        public int Installs, Bootstraps, Saves, Restarts;
        public int ServiceUpdates;
        public bool? ServiceUpdateAvailable = false;
        public bool ServiceCurrentConfirmed = true;
        public bool ServiceUpdateUnconfirmed, ServiceTargetMismatch, ServiceChangesFlow;
        public string ServiceVersion = "0.1.27-dev", TargetServiceVersion = "0.1.27-dev", ServiceFlowState = "", ServiceDispatchState = "completed", AppRetry = "";
        public Action? BeforePause;
        private readonly string serviceSha = new('e',64);
        private int servicePoll;
        public string FlowVersion = "2.14";
        private int poll;
        private JsonNode Profile(string id="one") => new JsonObject { ["id"]=id,["ip"]="192.168.50.4",["name"]=id,["platform"]=Ps4?"ps4":"ps5",["online"]=!Offline,["paired"]=Paired,["pkgVersion"]=Restoring?"2.14":"2.13" };
        public ConsoleSetupCoordinator Coordinator => new(Api, (_,_,_) => { Bootstraps++; return Task.CompletedTask; }, Settings, () => Saves++, ct => { BeforePause?.Invoke();ct.ThrowIfCancellationRequested();return Task.CompletedTask; });
        public Task<JsonNode> Api(string path, object? input, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();var body = input==null?null:JsonSerializer.SerializeToNode(input);Calls.Add((path,body));
            if(path=="/api/consoles/probe")Check(body?["background"]==null,"Explicit setup/preflight must use a full fresh probe without background.");
            if(body?["id"]?.GetValue<string>()=="bad")throw new IOException("Offline fixture");
            JsonNode reply;
            if(path=="/api/consoles"||path=="/api/consoles/probe"||path=="/api/consoles/pair") {
                if(path.EndsWith("pair")){Paired=true;Check(body?["code"]==null,"Automatic pairing must not use a code.");}
                reply=new JsonObject{["consoles"]=new JsonArray(Profile(),Profile("bad"))};
            } else if(path=="/api/desktop/ps4-setup-artifact")reply=new JsonObject{["id"]="artifact",["version"]="2.14"};
            else if(path.StartsWith("/api/ps4/maintenance"))reply=poll++==0?new JsonObject():new JsonObject{["kind"]="update",["targetVersion"]=FlowVersion,["state"]=Restarts==0?"restart_ready":"completed"};
            else if(path=="/api/ps4/service-update/install"||path=="/api/ps4/service-update/restart") {
                if(path.EndsWith("restart"))Restarts++;else Installs++;
                reply=new JsonObject{["kind"]="update",["targetVersion"]=FlowVersion,["state"]=path.EndsWith("restart")?"restarting":"installing"};
            } else if(path=="/api/desktop/ps4-app-check") {
                if(body?["observeOnly"]?.GetValue<bool>()==true || !Restoring)reply=new JsonObject{["installed"]=true};
                else {Installs++;reply=new JsonObject{["installed"]=false,["flow"]=new JsonObject{["kind"]="update",["targetVersion"]=FlowVersion,["state"]="installing"}};}
            } else if(path.StartsWith("/api/consoles/service-update")) {
                if(input!=null)ServiceUpdates++;
                reply=new JsonObject{["current"]=ServiceVersion,["currentBuildId"]=ServiceUpdateAvailable==true?"old-build":"current-build",["currentConfirmed"]=ServiceCurrentConfirmed,["release"]=new JsonObject{["version"]=TargetServiceVersion,["buildId"]="current-build",["sha256"]=serviceSha}};
                if(ServiceUpdateAvailable is bool available)reply["updateAvailable"]=available;
                if(ServiceUpdates>0||ServiceFlowState.Length>0)reply["flow"]=new JsonObject{["id"]=ServiceChangesFlow&&servicePoll++>0?"different-flow":"service-flow",["version"]=TargetServiceVersion,["buildId"]=ServiceTargetMismatch?"different-build":"current-build",["sha256"]=serviceSha,["state"]=ServiceUpdateUnconfirmed?"unconfirmed":ServiceUpdates>0?ServiceDispatchState:ServiceFlowState,["message"]="Service update fixture"};
            }
            else if(path.StartsWith("/api/desktop/console-setup?") )reply=new JsonObject{
                ["profile"]=Profile(),["release"]=new JsonObject{["app"]=new JsonObject{["sha256"]=new string('a',64)}},
                ["flow"]=new JsonObject{["state"]=Offline?"failed":"completed",["message"]="Unsupported firmware"},
                ["queue"]=new JsonObject{["id"]="queue",["status"]="completed",["items"]=new JsonArray(new JsonObject{["state"]="installed"})}
            };
            else if(path=="/api/desktop/console-setup") {
                if(body?["action"]?.GetValue<string>()=="bootstrap") {Bootstraps++;Check(body?["firmware"]==null,"Bootstrap must not guess firmware.");reply=new JsonObject();}
                else {Installs++;Check(body?["updateApp"]?.GetValue<bool>()==true,"One action must also update the app.");reply=Unconfirmed?new JsonObject{["retry"]="unconfirmed"}:AbsentRetry&&Installs==1?new JsonObject{["retry"]="absent"}:AppRetry.Length>0&&Installs==1?new JsonObject{["retry"]=AppRetry}:new JsonObject{["receipt"]=new JsonObject{["queueId"]="queue"}};}
            } else throw new Exception("Unexpected request: "+path);
            return Task.FromResult(reply);
        }
    }
    public static async Task Run()
    {
        var progress=new Progress<string>();
        var f=new Fixture();var result=await f.Coordinator.Run(new[]{"one","one"},progress,default);
        Check(result.Count==1&&result[0].Complete&&f.Installs==1,"Distinct targets must install once and confirm the queue.");
        var request=f.Settings.ConsoleSetupRequests["one"].RequestId;
        await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(f.Settings.ConsoleSetupRequests["one"].RequestId==request&&f.Saves==1,"Repeated checks must retain the receipt identity.");
        Check(!f.Calls.Any(c=>c.Path=="/api/consoles/active"),"Batch setup must not switch the active console.");
        f=new Fixture{Unconfirmed=true};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(!result[0].Complete&&f.Installs==1&&f.Saves==1,"Lost confirmation must not redispatch with a fresh identity.");
        f=new Fixture{AbsentRetry=true};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(result[0].Complete&&f.Installs==2&&f.Saves==2,"Confirmed removal may create one new installation identity.");
        foreach(var retry in new[]{"different-version","different-build"}) {
            f=new Fixture{AppRetry=retry};result=await f.Coordinator.Run(new[]{"one"},progress,default);
            var requests=f.Calls.Where(c=>c.Path=="/api/desktop/console-setup").Select(c=>c.Body?["requestId"]?.GetValue<string>()).ToArray();
            Check(result[0].Complete&&f.Installs==2&&f.Saves==2&&requests.Distinct().Count()==2,"A confirmed older app revision may create one new SHA-bound installation identity.");
        }
        f=new Fixture{AppRetry="installed"};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(result[0].Complete&&f.Installs==1&&f.Saves==1,"A confirmed exact app build must not be queued again.");
        f=new Fixture{ServiceUpdateAvailable=true};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(result[0].Complete&&f.ServiceUpdates==1&&f.Installs==1,"A same-version ELF with a changed verified build must update before the app.");
        var servicePost=f.Calls.FindIndex(c=>c.Path=="/api/consoles/service-update");
        var appPost=f.Calls.FindIndex(c=>c.Path=="/api/desktop/console-setup");
        Check(servicePost>=0&&appPost>servicePost,"App installation must wait for the target ELF receipt.");
        f=new Fixture();result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(result[0].Complete&&f.ServiceUpdates==0,"A verified current ELF must not be restarted.");
        f=new Fixture{ServiceCurrentConfirmed=false};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(!result[0].Complete&&f.ServiceUpdates==0&&f.Installs==0,"An unavailable authenticated ELF status must never be reported as all components current.");
        f=new Fixture{ServiceVersion="0.1.26-dev",ServiceUpdateAvailable=false};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(result[0].Complete&&f.ServiceUpdates==0,"An explicit WEB update decision must override the numeric fallback.");
        f=new Fixture{ServiceVersion="0.1.26-dev",ServiceUpdateAvailable=null};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(result[0].Complete&&f.ServiceUpdates==1,"An older WEB without the build-aware flag must retain its numeric version behavior.");
        f=new Fixture{ServiceUpdateAvailable=true,ServiceUpdateUnconfirmed=true};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(!result[0].Complete&&f.ServiceUpdates==1&&f.Installs==0,"An unconfirmed ELF command must not be resent or followed by app installation.");
        f=new Fixture{ServiceUpdateAvailable=false,ServiceFlowState="verifying",ServiceUpdateUnconfirmed=true};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(!result[0].Complete&&f.ServiceUpdates==0&&f.Installs==0,"An existing unresolved ELF command must block app dispatch even when updateAvailable is false.");
        f=new Fixture{ServiceUpdateAvailable=true,ServiceTargetMismatch=true};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(!result[0].Complete&&f.ServiceUpdates==1&&f.Installs==0,"A completed journal for another build must never confirm the requested ELF.");
        f=new Fixture{ServiceUpdateAvailable=true,ServiceChangesFlow=true,ServiceFlowState="verifying"};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(!result[0].Complete&&f.ServiceUpdates==0&&f.Installs==0,"A changed ELF flow identity must stop observation without another dispatch.");
        using(var observation=new CancellationTokenSource()) {
            f=new Fixture{ServiceUpdateAvailable=true,ServiceDispatchState="verifying",BeforePause=observation.Cancel};
            try { await f.Coordinator.Run(new[]{"one"},progress,observation.Token);throw new Exception("ELF observation ignored cancellation."); }
            catch(OperationCanceledException) when(observation.IsCancellationRequested) { }
            Check(f.ServiceUpdates==1&&f.Installs==0,"Cancelling after ELF dispatch stops observation without resending or dispatching the app.");
        }
        f=new Fixture();result=await f.Coordinator.Run(new[]{"bad","one"},progress,default);
        Check(result.Count==2&&!result[0].Complete&&result[1].Complete,"An offline target must not prevent another target from updating.");
        f=new Fixture{Offline=true};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(!result[0].Complete&&f.Bootstraps==1&&f.Installs==0,"Unsupported ELF confirmation must block app installation.");
        foreach(var repair in new[]{false,true}) {
            f=new Fixture{Ps4=true,Restoring=repair};result=await f.Coordinator.Run(new[]{"one"},progress,default);
            Check(result[0].Complete&&f.Installs==1&&f.Restarts==1,"PS4 update/restoration must reconcile and verify the launcher.");
        }
        f=new Fixture{Ps4=true,FlowVersion="2.12"};result=await f.Coordinator.Run(new[]{"one"},progress,default);
        Check(!result[0].Complete&&f.Restarts==0,"A different update must not be restarted or reported as the current bundle.");
        using var cancelled=new CancellationTokenSource();cancelled.Cancel();
        try { await f.Coordinator.Run(new[]{"one"},progress,cancelled.Token);throw new Exception("Cancellation ignored."); }
        catch(OperationCanceledException) { }
    }
}
