using System.Net;
using System.Reflection;
using System.Text.Json;
using PackageFlow.Core;
using PackageFlow.Windows;

internal static class BackgroundProbeTests
{
    private const BindingFlags Fields = BindingFlags.Instance | BindingFlags.NonPublic;
    private static void Check(bool value,string message){if(!value)throw new Exception(message);}
    private sealed class Transport : HttpMessageHandler
    {
        public readonly List<JsonElement> Probes=[];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            string json="{}";
            if(request.RequestUri!.AbsolutePath=="/api/consoles/probe") {
                using var body=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));Probes.Add(body.RootElement.Clone());
            }
            if(request.RequestUri.AbsolutePath is "/api/consoles" or "/api/consoles/probe")
                json="{\"activeId\":\"\",\"consoles\":[{\"id\":\"fixture\",\"ip\":\"192.0.2.5\",\"name\":\"Fixture PS5\",\"platform\":\"ps5\",\"online\":false,\"paired\":false}]}";
            else if(request.RequestUri.Port==8191)json="{\"msg\":\"FlareSolverr is ready!\"}";
            else if(request.RequestUri.Host=="api.github.com")json=request.RequestUri.AbsolutePath.EndsWith("/tags")?"[]":"{\"stargazers_count\":0}";
            else if(request.RequestUri.AbsolutePath=="/api/torrents/settings")json="{\"configured\":false,\"ready\":false}";
            return new(HttpStatusCode.OK){Content=new StringContent(json,System.Text.Encoding.UTF8,"application/json")};
        }
    }
    private static void Wait(Task task)
    {
        var end=DateTime.UtcNow.AddSeconds(8);
        while(!task.IsCompleted&&DateTime.UtcNow<end){Application.DoEvents();Thread.Sleep(10);}
        if(!task.IsCompleted)throw new TimeoutException("Fixture refresh did not complete");task.GetAwaiter().GetResult();
    }
    public static void Run(string report)
    {
        var root=Path.Combine(Path.GetTempPath(),"PackageFlow-background-probe-fixture-"+Guid.NewGuid());Directory.CreateDirectory(root);
        using var form=new MainForm(false,new LauncherSettings{GamesDirectory=root,WizardComplete=true});
        using var transport=new Transport();using var http=new HttpClient(transport);
        var settings=(LauncherSettings)typeof(MainForm).GetField("settings",Fields)!.GetValue(form)!;
        typeof(MainForm).GetField("host",Fields)!.SetValue(form,new ServerHost(settings,http,root));
        typeof(MainForm).GetField("http",Fields)!.SetValue(form,http);
        typeof(MainForm).GetField("preview",Fields)!.SetValue(form,false);
        var timer=(System.Windows.Forms.Timer)typeof(MainForm).GetField("healthTimer",Fields)!.GetValue(form)!;
        // Exercise the actual timer callback, not just a payload-construction helper.
        typeof(System.Windows.Forms.Timer).GetMethod("OnTick",Fields)!.Invoke(timer,[EventArgs.Empty]);
        Wait((Task)typeof(MainForm).GetField("healthWork",Fields)!.GetValue(form)!);
        Check(transport.Probes.Count==1&&transport.Probes[0].GetProperty("background").GetBoolean(),"Periodic timer did not send background:true");
        var refresh=typeof(MainForm).GetMethod("RefreshSavedConsoles",Fields)!;
        Wait((Task)refresh.Invoke(form,[true,false])!);
        Check(transport.Probes.Count==2&&!transport.Probes[1].TryGetProperty("background",out _),"Explicit refresh was changed to a background/cached probe");
        File.WriteAllText(report,"PASS: actual health timer sends background:true; explicit refresh omits background; transport is isolated, no real WEB/console requests.\n");
    }
}
