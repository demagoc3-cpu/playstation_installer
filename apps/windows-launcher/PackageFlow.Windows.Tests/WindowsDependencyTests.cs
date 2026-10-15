using System.Net;using System.Net.Sockets;using System.Security.Cryptography;using System.Text;using System.Text.Json;using PackageFlow.Core;using PackageFlow.Windows;
internal static class WindowsDependencyTests {
 static void Check(bool ok,string message){if(!ok)throw new Exception(message);}
 static async Task Reject(Func<Task> action,string label="operation"){try{await action();}catch{return;}throw new Exception("Expected guarded operation to fail: "+label);}
 sealed class Quiet : IProgress<RuntimeProgress>{public void Report(RuntimeProgress value){}}
 sealed class NoNetwork : HttpMessageHandler { public int Calls; protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken ct){Calls++;throw new Exception("Migration made a network request");} }
 public static async Task Run(string report){
  File.WriteAllText(report,"RUNNING: Windows dependency signature + Native migration fixtures; installed Runtime is never removed\n");
  var root=Path.Combine(Path.GetTempPath(),"PackageFlow-11015-native-tests-"+Guid.NewGuid());Directory.CreateDirectory(root);
  var runtime=new WebViewRuntimeHost(Path.Combine(root,"runtime-state"));Check(RuntimePreparation.Supported(runtime.ResolveRuntime()),"Real installed Runtime unavailable: this test environment requires it");await RuntimePreparation.Ensure(runtime,new Quiet(),false,default);Check(runtime.DownloadRequests==0&&runtime.InstallerDispatches==0&&!Directory.Exists(Path.Combine(root,"runtime-state")),"Installed Runtime case touched download/install state");
  File.AppendAllText(report,"PASS: real SDK finds installed Runtime; zero dependency downloads and zero installer dispatches\n");
  using(var artifact=await runtime.PrepareInstaller(new Quiet(),default)) {
   Check(runtime.DownloadRequests==1&&runtime.InstallerDispatches==0,"Signature test unexpectedly installed Runtime");
   var expected=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"runtime","webview2-runtime.json"))).RootElement.GetProperty("sha256").GetString();
   using var stream=File.OpenRead(artifact.Path);Check(Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()==expected,"Real Microsoft bootstrapper hash changed");
  }
  var junk=Path.Combine(root,"not-microsoft.exe");File.WriteAllText(junk,"MZ fixture: never execute");await Reject(()=>WebViewRuntimeHost.VerifyMicrosoftSignature(junk,default));
  File.AppendAllText(report,"PASS: actual HTTPS Microsoft bootstrapper SHA256 + Authenticode Valid/Microsoft verified; unsigned junk rejected; Microsoft installer never executed\n");
  var state=Path.Combine(root,"legacy");Directory.CreateDirectory(state);var data=Path.Combine(root,"export");Directory.CreateDirectory(data);var games=Path.Combine(root,"games");Directory.CreateDirectory(games);
  var settings=new LauncherSettings{GamesDirectory=games,LegacyMigrationRequired=true,WizardComplete=true,SetupComplete=true,TorrentSetupSelected=false,ProtectedTrackerPassword=LocalSecrets.Protect("fixture-native-secret")};
  var callback=new TcpListener(IPAddress.Loopback,0);callback.Start();settings.PayloadPort=((IPEndPoint)callback.LocalEndpoint).Port;callback.Stop();
  using var port=new TcpListener(IPAddress.Loopback,0);port.Start();settings.Port=((IPEndPoint)port.LocalEndpoint).Port;
  var oldProfile=Path.Combine(state,"launcher.json");File.WriteAllText(oldProfile,JsonSerializer.Serialize(settings).Replace("\"Mode\":\"native\"","\"Mode\":\"compose\""));settings=LauncherSettings.Load(oldProfile);
  using var transport=new NoNetwork();using var http=new HttpClient(transport);var host=new ServerHost(settings,http,state);
  await Reject(()=>host.Start(default),"legacy start");await Reject(()=>host.Adopt(default),"legacy adopt");await Reject(()=>host.PrepareUpdate(default),"occupied-port prepare-update");Check(transport.Calls==0,"Legacy guard contacted/adopted an external server");
  using(var client=new TcpClient()){await client.ConnectAsync(IPAddress.Loopback,settings.Port);Check(client.Connected,"Legacy prepare-update stopped another listener");}port.Stop();
  File.WriteAllText(Path.Combine(data,"console-profiles.json"),"{\"activeId\":\"preserved-pair\",\"consoles\":[]}");File.WriteAllText(Path.Combine(data,"ps5-service-keys.json"),"{\"192.168.1.9\":\"fixture-private-pair\"}");
  await host.ConfirmDataMigration(data,false,default);Check(!settings.LegacyMigrationRequired&&settings.Mode=="native"&&settings.GamesDirectory==games&&!settings.TorrentSetupSelected,"Native migration changed user choices");Check(LocalSecrets.Read(LauncherSettings.Load(Path.Combine(state,"launcher.json")).ProtectedTrackerPassword)=="fixture-native-secret","DPAPI credential lost in migration");Check(File.ReadAllText(Path.Combine(host.EffectiveWebDataDirectory,"ps5-service-keys.json"))==File.ReadAllText(Path.Combine(data,"ps5-service-keys.json")),"Pairing keys changed");Check(transport.Calls==0,"Import called external APIs");Check(File.Exists(oldProfile+".pre-native-1.10.15.json"),"Original protected profile was not backed up");
  File.AppendAllText(report,"PASS: old profile cannot start/adopt/stop an external server; occupied-port prepare-update refuses without network/process commands; selected data copied separately, pairs/DPAPI/library/torrent choice preserved\nNOTE: missing Runtime installation branches use Core resolver/transport/process integration fixtures. No clean Windows VM was available; no real missing-Runtime installation is claimed.\n");
 }
}
