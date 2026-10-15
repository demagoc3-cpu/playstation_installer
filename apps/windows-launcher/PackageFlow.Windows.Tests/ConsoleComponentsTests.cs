using PackageFlow.Core;
using PackageFlow.Windows;

internal static class ConsoleComponentsTests
{
    public static async Task Run(string report, string[] addresses)
    {
        var lines=new List<string>();
        var settings=LauncherSettings.Load(ServerHost.SettingsPath);
        using var http=new HttpClient {Timeout=TimeSpan.FromSeconds(30)};
        using var lifetime=new CancellationTokenSource(TimeSpan.FromMinutes(15));
        var host=new ServerHost(settings,http);
        if(!await host.Adopt(lifetime.Token))throw new Exception("Start the candidate's WEB before testing components.");
        var list=await host.Api("/api/consoles",ct:lifetime.Token);
        var ids=list["consoles"]!.AsArray().Where(p=>addresses.Contains(p?["ip"]?.GetValue<string>())).Select(p=>p!["id"]!.GetValue<string>()).ToArray();
        if(ids.Length!=addresses.Distinct().Count())throw new Exception("An explicitly selected hardware target is missing from WEB.");
        var progress=new Capture(message=>{lines.Add(message);File.WriteAllLines(report,lines);});
        var coordinator=new ConsoleSetupCoordinator((path,body,ct)=>host.Api(path,body,ct),
            (_,_,_)=>throw new Exception("Initial PyLoader installation requires the Windows setup UI."),settings,()=>settings.Save(ServerHost.SettingsPath));
        var results=await coordinator.Run(ids,progress,lifetime.Token);
        lines.AddRange(results.Select(r=>(r.Complete?"PASS: ":"FAIL: ")+r.Name+"; "+r.Message));
        File.WriteAllLines(report,lines);
        if(results.Any(r=>!r.Complete))throw new Exception("One or more console component checks did not complete; see the report.");
    }
    private sealed class Capture(Action<string> write):IProgress<string> {public void Report(string message)=>write(message);}
}
