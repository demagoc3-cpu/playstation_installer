using System.Security.Cryptography;
using System.Text.Json.Nodes;
using PackageFlow.Core;

internal static class ConsoleSetupTests
{
    public static void Run(string directory)
    {
        void Check(bool b,string message){if(!b)throw new Exception(message);}
        var packet="HTTP/1.1 200 Ok\nhost-type:PS5\nhost-name:Bedroom\ndevice-discovery-protocol-version:00030010\nsystem-version:8050001\n";
        var d=ConsoleDiscovery.ParseAnnouncement("192.168.1.5",9302,packet);
        Check(d is { Platform:"ps5",Service:false,Loader:false,Firmware:null },"PS5 announcement must not claim firmware or readiness.");
        Check(ConsoleDiscovery.ParseAnnouncement("192.168.1.5",987,packet)==null,"PS5 discovery must validate source port.");
        Check(ConsoleDiscovery.ParseAnnouncement("192.168.1.5",9302,packet.Replace("00030010","00020020"))==null,"PS5 protocol mismatch must be rejected.");
        Check(ConsoleDiscovery.ParseAnnouncement("192.168.1.5",9302,packet.Replace("200 Ok","620 Standby"))?.RestMode==true,"Discovery must preserve rest mode without waking PS5.");
        var health=JsonNode.Parse("{\"apiVersion\":\"v1\",\"firmwareRead\":true,\"firmwareRaw\":\"0x13600000\",\"serviceReport\":{\"service\":\"PackageFlowService-PS5\",\"platform\":\"ps5\",\"consoleVerified\":true}}")!;
        Check(ConsoleDiscovery.IsPs5Service(health)&&ConsoleDiscovery.Ps5Firmware(health)=="13.60","Recognize verified PS5 service and BCD firmware.");
        Check(ConsoleDiscovery.FromServices("192.168.1.5",null,health)?.Platform=="ps5","Platform must come from the verified ELF response.");
        var four=JsonNode.Parse("{\"service\":\"PackegeFlowService\",\"environment\":\"ps4\"}")!;
        Check(ConsoleDiscovery.FromServices("192.168.1.4",four,null)?.Platform=="ps4","Preserve PS4 detection.");
        Check(ConsoleDiscovery.FromServices("192.168.1.4",JsonNode.Parse("{\"service\":\"PackegeFlowService\"}"),null)==null,"A service name without platform verification is insufficient.");
        try {ConsoleDiscovery.FromServices("192.168.1.5",four,health);throw new Exception("Conflicting platforms accepted.");}catch(InvalidDataException){}
        health["firmwareRaw"]="0x13a00000";Check(ConsoleDiscovery.Ps5Firmware(health)==null,"Invalid BCD must not become firmware.");
        health["serviceReport"]!["consoleVerified"]=false;Check(!ConsoleDiscovery.IsPs5Service(health),"Host diagnostics must not be treated as a console.");
        var source=Path.Combine(directory,"console-bundle");var dest=Path.Combine(directory,"console-stage");Directory.CreateDirectory(source);
        JsonObject Artifact(string file,int size){var bytes=new byte[size];File.WriteAllBytes(Path.Combine(source,file),bytes);return new(){["fileName"]=file,["size"]=size,["sha256"]=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()};}
        var manifest=new JsonObject{["schemaVersion"]=1,["elf"]=Artifact("service.elf",4096),["app"]=Artifact("PackageFlow.ffpkg",8192)};
        File.WriteAllText(Path.Combine(source,"manifest.json"),manifest.ToJsonString());ConsoleArtifacts.Stage(source,dest);
        Check(File.Exists(Path.Combine(dest,"manifest.json")),"Both native and Compose must stage the bundle beside WEB data.");
        File.WriteAllBytes(Path.Combine(source,"service.elf"),new byte[]{1});
        try{ConsoleArtifacts.Stage(source,dest);throw new Exception("Changed artifacts accepted.");}catch(InvalidDataException){}
        manifest["elf"]!["fileName"]="../service.elf";File.WriteAllText(Path.Combine(source,"manifest.json"),manifest.ToJsonString());
        try{ConsoleArtifacts.Stage(source,dest);throw new Exception("Path traversal accepted.");}catch(InvalidDataException){}
        var settingsPath=Path.Combine(directory,"multi-console.json");
        var settings=new LauncherSettings{ConsoleId="ps5-test",ConsolePlatform="ps5",PsIp="192.168.1.5"};settings.Save(settingsPath);
        Check(LauncherSettings.Load(settingsPath).ConsolePlatform=="ps5","Selected platform must survive restart without changing legacy PS4 settings.");
    }
}
