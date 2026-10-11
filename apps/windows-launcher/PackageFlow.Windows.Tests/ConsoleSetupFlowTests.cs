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
        public bool AlreadyInstalled;
        public JsonObject Profile => new() { ["id"]="fixture",["ip"]="192.168.50.5",["name"]="PS5",["platform"]="ps5",["online"]=true,["paired"]=Paired };
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken ct)
        {
            JsonNode body;
            var path=r.RequestUri!.AbsolutePath;
            if(path=="/api/consoles/pair")Paired=true;
            if(path=="/api/consoles"||path=="/api/consoles/pair"||path=="/api/consoles/active")body=new JsonObject{["consoles"]=new JsonArray(Profile)};
            else if(path=="/api/desktop/console-setup"&&r.Method==HttpMethod.Get)body=new JsonObject{
                ["profile"]=Profile,["release"]=new JsonObject{["app"]=new JsonObject{["sha256"]=new string('a',64)}},
                ["queue"]=new JsonObject{["id"]="queue",["status"]="completed",["items"]=new JsonArray(new JsonObject{["state"]="installed"})}
            };
            else if(path=="/api/desktop/console-setup"&&r.Method==HttpMethod.Post) {
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
            if(!t.IsCompleted)throw new Exception("Setup UI did not finish.");t.GetAwaiter().GetResult();
        }
        Invoke("Install");
        if(settings.PendingSetupConsoleId!="fixture"||transport.Installs!=0)throw new Exception("Setup must wait for pairing without installing.");
        var code=(TextBox)typeof(ConsoleManagerForm).GetField("code",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(manager)!;code.Text="123456";
        Invoke("Pair");
        if(transport.Installs!=1||settings.PendingSetupConsoleId!=""||code.Text.Length!=0)throw new Exception("Pair must continue the pending setup exactly once and clear the code.");
        transport.AlreadyInstalled=true;Invoke("Install");
        if(transport.Installs!=2)throw new Exception("An installed app must not cause a repeated install request.");
        manager.Close();
    }
}
