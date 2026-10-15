using System.Net;
using System.Reflection;
using System.Text.Json.Nodes;
using PackageFlow.Core;
using PackageFlow.Windows;

internal static class ConsoleSetupFlowTests
{
    private sealed class Transport : HttpMessageHandler
    {
        public bool Paired;
        public int Installs;
        public int PairRequests;
        public bool AlreadyInstalled;
        public JsonObject Profile => new() { ["id"]="fixture",["ip"]="192.168.50.5",["name"]="PS5",["platform"]="ps5",["online"]=true,["paired"]=Paired };
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken ct)
        {
            JsonNode body;
            var path=r.RequestUri!.AbsolutePath;
            if(path=="/api/consoles/pair") {
                var input=JsonNode.Parse(r.Content!.ReadAsStringAsync(ct).GetAwaiter().GetResult());
                if(input?["id"]?.GetValue<string>()!="fixture"||input?["code"]!=null)throw new Exception("Automatic connection must target the selected console without a code.");
                Paired=true;PairRequests++;
            }
            if(path=="/api/consoles"||path=="/api/consoles/probe"||path=="/api/consoles/pair"||path=="/api/consoles/active")body=new JsonObject{["consoles"]=new JsonArray(Profile)};
            else if(path=="/api/consoles/service-update")body=new JsonObject{["current"]="0.1.25-dev",["release"]=new JsonObject{["version"]="0.1.25-dev"}};
            else if(path=="/api/desktop/console-setup"&&r.Method==HttpMethod.Get)body=new JsonObject{
                ["profile"]=Profile,["release"]=new JsonObject{["app"]=new JsonObject{["sha256"]=new string('a',64)}},
                ["queue"]=new JsonObject{["id"]="queue",["status"]="completed",["items"]=new JsonArray(new JsonObject{["state"]="installed"})}
            };
            else if(path=="/api/desktop/console-setup"&&r.Method==HttpMethod.Post) {
                var request=JsonNode.Parse(r.Content!.ReadAsStringAsync(ct).GetAwaiter().GetResult());
                if(!Paired)throw new Exception("App command before pairing.");
                Installs++;
                body=AlreadyInstalled?new JsonObject{["retry"]="installed"}:new JsonObject{["receipt"]=new JsonObject{["queueId"]="queue"}};
            } else throw new Exception("Unexpected setup request: "+r.RequestUri);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(body.ToJsonString())});
        }
    }
    public static void Run(string folder,Form owner,Action pump)
    {
        using var transport=new Transport();using var http=new HttpClient(transport);
        var settings=new LauncherSettings{ProtectedLauncherKey=LocalSecrets.Protect("fixture-key")};
        var host=new ServerHost(settings,http,folder);
        using var manager=new ConsoleManagerForm(host,settings,(_,_,_)=>Task.CompletedTask,preview:true,settingsPath:Path.Combine(folder,"flow-settings.json"));
        manager.RenderRows(new[]{transport.Profile});manager.Show(owner);pump();
        void Invoke(string method) {
            var t=(Task)typeof(ConsoleManagerForm).GetMethod(method,BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(manager,null)!;
            for(var i=0;i<100&&!t.IsCompleted;i++)pump();
            if(!t.IsCompleted)throw new Exception("Setup UI did not finish.");t.GetAwaiter().GetResult();pump();
        }
        Invoke("Install");
        if(!transport.Paired||transport.PairRequests!=1||transport.Installs!=1||settings.PendingSetupConsoleId!="")throw new Exception("Install must automatically pair and continue exactly once.");
        if(typeof(ConsoleManagerForm).GetField("code",BindingFlags.NonPublic|BindingFlags.Instance)!=null)throw new Exception("Pairing code UI must be absent.");
        transport.AlreadyInstalled=true;Invoke("Install");
        if(transport.Installs!=2)throw new Exception("An installed app must not cause a repeated install request.");
        manager.Close();
    }
}
