using System.Net;
using System.Net.Sockets;
using PackageFlow.Core;
using PackageFlow.Windows;

internal static class WebRuntimeTests
{
    private static int AvailablePort() { var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();try{return ((IPEndPoint)listener.LocalEndpoint).Port;}finally{listener.Stop();} }
    public static async Task Run(string report)
    {
        var folder=Path.Combine(Path.GetTempPath(),"PackageFlow-runtime-"+Guid.NewGuid());
        var settings=new LauncherSettings{Port=AvailablePort(),PayloadPort=AvailablePort(),AutomaticSetupPending=true};
        while(settings.PayloadPort==settings.Port)settings.PayloadPort=AvailablePort();
        using var http=new HttpClient{Timeout=TimeSpan.FromSeconds(10)};
        using var lifetime=new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var host=new ServerHost(settings,http,folder);
        try {
            await host.Start(lifetime.Token);
            var catalog=await host.Api("/api/catalog/v1?platform=all",ct:lifetime.Token);
            if(catalog["platform"]?.GetValue<string>()!="all"||catalog["capabilities"]?["catalogFeatures"]?["platformFilter"]?.GetValue<bool>()!=true)throw new Exception("Packaged WEB does not expose the new console catalog contract.");
            var profiles=await host.Api("/api/consoles",ct:lifetime.Token);
            if(profiles["consoles"]!.AsArray().Count!=0)throw new Exception("Runtime test unexpectedly reused user console profiles.");
            using var anonymous=await http.GetAsync(host.WebUrl+"/api/desktop/console-setup?consoleId=fixture",lifetime.Token);
            if(anonymous.StatusCode!=HttpStatusCode.NotFound)throw new Exception("Windows setup API is available without the launcher key.");
            if(File.Exists(Path.Combine(AppContext.BaseDirectory,"console-setup","manifest.json"))) {
                var manifest=System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(Path.Combine(folder,"data","web","console-setup","manifest.json")))!;
                if(manifest["app"]?["version"]?.GetValue<string>()!="01.000.041")throw new Exception("PS5 application bundle was not staged.");
                var artifact=await host.Api("/api/desktop/ps4-setup-artifact",new{},lifetime.Token);
                if(artifact["version"]?.GetValue<string>()!="2.05"||artifact["sha256"]?.GetValue<string>()!=manifest["ps4"]?["sha256"]?.GetValue<string>())throw new Exception("PS4 bundled package was not verified and staged.");
            }
            await host.Stop(lifetime.Token);
            File.WriteAllText(report,"PASS: packaged Windows Node + WEB starts with isolated data, new PS4/PS5 catalog, launcher authorization and orderly shutdown.\n");
        }
        finally { if(host.Started)await host.Stop(CancellationToken.None);if(Directory.Exists(folder))Directory.Delete(folder,true); }
    }
}
