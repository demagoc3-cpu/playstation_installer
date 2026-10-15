using System.Net;using System.Net.Sockets;using System.Text.Json;
namespace PackageFlow.Core;
public sealed record DesktopRequest(string Id,string Command,JsonElement Payload);
public static class DesktopBridgeProtocol {
 static readonly HashSet<string> Actions=new(["apply","storage","firewall","prowlarr.install","prowlarr.connect","prowlarr.open","flare.install","tracker.test","tracker.manual","indexer.apply","torrent.connect","torrent.setup","setup.complete","windows.check","windows.install"]);
 static readonly HashSet<string> Fields=new(["hostIp","port","payloadPort","autoStart","visibleBrowser","prowlarrUrl","prowlarrKey","trackerUsername","trackerPassword","torrentAddress","torrentUser","torrentPassword","torrentFolder","installFlare","indexerId"]);
 public static bool TrustedOrigin(string source)=>Uri.TryCreate(source,UriKind.Absolute,out var u)&&u.Scheme=="https"&&u.Host=="packageflow.local"&&u.IsDefaultPort&&u.UserInfo.Length==0;
 static void Keys(JsonElement p,IEnumerable<string> allowed,IEnumerable<string>? required=null){if(p.ValueKind!=JsonValueKind.Object)throw new ArgumentException("Invalid desktop payload");var keys=p.EnumerateObject().Select(x=>x.Name).ToArray();if(keys.Distinct().Count()!=keys.Length||keys.Any(k=>!allowed.Contains(k))||(required??[]).Any(k=>!keys.Contains(k)))throw new ArgumentException("Invalid desktop payload");}
 static string Text(JsonElement p,string key,int max=4096){var v=p.GetProperty(key);if(v.ValueKind!=JsonValueKind.String)throw new ArgumentException("Invalid desktop field");var s=v.GetString()!;if(s.Length>max||s.Contains('\0'))throw new ArgumentException("Invalid desktop field");return s;}
 static bool Bool(JsonElement p,string k){var v=p.GetProperty(k);if(v.ValueKind is not(JsonValueKind.True or JsonValueKind.False))throw new ArgumentException("Invalid desktop flag");return v.GetBoolean();}
 static int Number(JsonElement p,string k,int min,int max){var v=p.GetProperty(k);if(v.ValueKind!=JsonValueKind.Number||!v.TryGetInt32(out var n)||n<min||n>max)throw new ArgumentException("Invalid desktop number");return n;}
 static void Array(JsonElement p,string key,bool ip=false){var a=p.GetProperty(key);if(a.ValueKind!=JsonValueKind.Array||a.GetArrayLength()>64)throw new ArgumentException("Invalid desktop selection");foreach(var v in a.EnumerateArray()){if(v.ValueKind!=JsonValueKind.String||v.GetString() is not {Length:>0 and <=128} s)throw new ArgumentException("Invalid desktop selection");if(ip)Ip(s);}}
 static void Ip(string s){if(!IPAddress.TryParse(s,out var a)||a.AddressFamily!=AddressFamily.InterNetwork||IPAddress.IsLoopback(a)||a.GetAddressBytes()[0] is 0 or >=224)throw new ArgumentException("Invalid console IPv4");}
 public static DesktopRequest Parse(string source,string json){
  if(!TrustedOrigin(source)||json.Length>32768)throw new ArgumentException("Untrusted desktop message");using var d=JsonDocument.Parse(json,new JsonDocumentOptions{MaxDepth=10});var r=d.RootElement;Keys(r,["id","command","payload"],["id","command","payload"]);var id=Text(r,"id",80);var cmd=Text(r,"command",80);if(id.Length==0)throw new ArgumentException("Invalid request id");var p=r.GetProperty("payload");
  if(Actions.Contains(cmd)){Keys(p,Fields);foreach(var x in p.EnumerateObject())switch(x.Name){
   case "hostIp":Ip(Text(p,x.Name,64));break;
   case "port":case "payloadPort":Number(p,x.Name,1024,65535);break;
   case "indexerId":Number(p,x.Name,0,int.MaxValue);break;
   case "autoStart":case "visibleBrowser":case "installFlare":Bool(p,x.Name);break;
   default:Text(p,x.Name,x.Name=="trackerUsername"?256:4096);break;
  }}else switch(cmd){
   case "ready":case "refresh":case "discovery.start":case "discovery.cancel":case "updates.check":case "web.open":case "server.start":case "server.stop":case "migration.inspect":Keys(p,[]);break;
   case "dialog.reply":Keys(p,["dialogId","confirmed"],["dialogId","confirmed"]);Text(p,"dialogId",80);Bool(p,"confirmed");break;
   case "migration.confirm":Keys(p,["path","allowEmpty"],["path","allowEmpty"]);Text(p,"path",4096);Bool(p,"allowEmpty");break;
   case "language":Keys(p,["language"],["language"]);if(Text(p,"language",2) is not("ru" or "en"))throw new ArgumentException("Invalid language");break;
   case "link":Keys(p,["target"],["target"]);if(Text(p,"target",16) is not("github" or "4pda" or "discord"))throw new ArgumentException("Invalid link");break;
   case "wallet.copy":Keys(p,["index"],["index"]);Number(p,"index",0,1);break;
   case "discovery.manual":Keys(p,["ip"],["ip"]);Ip(Text(p,"ip",64));break;
   case "console.connect":Keys(p,["ip","name","platform"],["ip","name","platform"]);Ip(Text(p,"ip",64));Text(p,"name",80);if(Text(p,"platform",8) is not("ps4" or "ps5"))throw new ArgumentException("Invalid platform");break;
   case "console.select":case "console.check":case "console.forget":case "console.remove-app":Keys(p,["id"],["id"]);if(Text(p,"id",128).Length==0)throw new ArgumentException("Invalid console");break;
   case "console.install":Keys(p,["ids"],["ids"]);Array(p,"ids");break;
   case "updates.install":Keys(p,["ids","windows"],["ids","windows"]);Array(p,"ids");Bool(p,"windows");break;
   case "wizard.finish":Keys(p,["torrents","consoles","trackerUsername","trackerPassword","manual"],["torrents","consoles","trackerUsername","trackerPassword","manual"]);Bool(p,"torrents");Bool(p,"manual");Array(p,"consoles",true);Text(p,"trackerUsername",256);Text(p,"trackerPassword");break;
   default:throw new ArgumentException("Unknown desktop command");
  }
  return new(id,cmd,p.Clone());
 }
}
