using System.Text.Json;
using System.Text.Json.Nodes;
using System.Reflection;
using System.Net;
using System.Net.Sockets;
using System.Net.NetworkInformation;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using PackageFlow.Core;

namespace PackageFlow.Windows;
internal sealed partial class MainForm
{
    private WebView2? desktop;
    private bool desktopReady;
    private bool preparingDesktop;
    private WebViewRuntimeHost? runtimePreparationHost;
    private readonly Dictionary<string, Func<Task>> desktopActions = [];
    private readonly Dictionary<string, object> desktopComponents = [];
    private readonly Dictionary<string, DiscoveredConsole> desktopFound = [];
    private JsonNode? desktopConsoles;
    private readonly Dictionary<string, object> desktopUpdates = [];
    private string desktopWindowsUpdate = "";
    private CancellationTokenSource? desktopDiscovery;
    private TaskCompletionSource<bool>? desktopDialog;
    private string? desktopDialogId;
    private readonly Dictionary<string,string> desktopCommands = new() {
        ["apply"]="Применить|Apply", ["storage"]="Хранилище в WEB|Storage in WEB", ["firewall"]="Разрешить доступ приставкам|Allow console access",
        ["prowlarr.install"]="Установить Prowlarr|Install Prowlarr",
        ["prowlarr.connect"]="Подключить существующий|Connect existing", ["prowlarr.open"]="Открыть Prowlarr|Open Prowlarr", ["flare.install"]="FlareSolverr|FlareSolverr",
        ["tracker.test"]="Добавить RuTracker и проверить|Add and test RuTracker", ["tracker.manual"]="Войти вручную|Sign in manually",
        ["indexer.apply"]="Применить к WEB|Apply to WEB", ["torrent.connect"]="Подключить qBittorrent|Connect qBittorrent", ["torrent.setup"]="Настроить торренты|Set up torrents",
        ["setup.complete"]="Завершить настройку|Finish setup", ["windows.check"]="Проверить обновления|Check updates", ["windows.install"]="Обновить Windows-приложение|Update Windows app"
    };
    private async Task CaptureDesktop(string directory)
    {
        try {
            if(!Path.IsPathFullyQualified(directory))throw new ArgumentException("Capture directory must be absolute");
            Directory.CreateDirectory(directory);ShowWindow();WindowState=FormWindowState.Normal;ClientSize=new Size(1280,800);
            for(var i=0;i<100&&!desktopReady;i++)await Task.Delay(100,lifetime.Token);
            if(!desktopReady)throw new InvalidOperationException("Desktop renderer unavailable");
            await DesktopRefresh();PushDesktopState();await Task.Delay(500,lifetime.Token);
            var names=new[]{"home","consoles","search","updates","support"};
            for(var i=0;i<names.Length;i++) {
                await desktop!.CoreWebView2.ExecuteScriptAsync($"document.querySelectorAll('aside>button')[{i}]?.click()");
                await Task.Delay(700,lifetime.Token);
                using var file=File.Create(Path.Combine(directory,names[i]+".png"));
                await desktop.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,file);
            }
            await desktop!.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('aside>button')[0]?.click()");
            File.WriteAllText(Path.Combine(directory,"capture.txt"),"Installed PackageFlow "+CurrentVersion().ToString(3)+"; Windows WebView2 "+desktop.CoreWebView2.Environment.BrowserVersionString+"; real launcher state, read-only page capture; Runtime downloads="+runtimePreparationHost?.DownloadRequests+"; installer dispatches="+runtimePreparationHost?.InstallerDispatches+".\n");
        }catch(Exception error){Report("Capture: "+FriendlyError(error));}
    }
    private async Task<bool> InitializeDesktop()
    {
        foreach(Control control in Controls)control.Visible=false;
        preparingDesktop=true;
        using var preparation=new RuntimePreparationPanel();Controls.Add(preparation);preparation.BringToFront();
        runtimePreparationHost=new WebViewRuntimeHost(preview?Path.Combine(settings.GamesDirectory,"runtime-dependency"):Program.UserDirectory);
        bool manualRetry=false;
        try {
            while(!lifetime.IsCancellationRequested) {
                try {
                    await RuntimePreparation.Ensure(runtimePreparationHost,new Progress<RuntimeProgress>(preparation.ShowProgress),manualRetry,lifetime.Token);
                    preparation.ShowProgress(new("ui","Запускаем локальный интерфейс…"));
                    desktop?.Dispose();desktop=new WebView2 {Dock=DockStyle.Fill,DefaultBackgroundColor=Color.FromArgb(3,13,31)};Controls.Add(desktop);desktop.CreateControl();preparation.BringToFront();
                    var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(preview?settings.GamesDirectory:Program.UserDirectory,"webview2"));
                    await desktop.EnsureCoreWebView2Async(environment);
                    var core=desktop.CoreWebView2;
                    core.Settings.AreDevToolsEnabled=false;core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.AreHostObjectsAllowed=false;core.Settings.IsStatusBarEnabled=false;
                    core.SetVirtualHostNameToFolderMapping("packageflow.local",Path.Combine(AppContext.BaseDirectory,"Desktop"),CoreWebView2HostResourceAccessKind.DenyCors);
                    core.NavigationStarting+=(_,e)=>{if(!TrustedDesktopOrigin(e.Uri))e.Cancel=true;};
                    core.NewWindowRequested+=(_,e)=>e.Handled=true;
                    core.PermissionRequested+=(_,e)=>e.State=CoreWebView2PermissionState.Deny;
                    core.WebMessageReceived+=DesktopMessage;
                    core.ProcessFailed+=(_,_)=>{desktopReady=false;MessageBox.Show(this,"WebView2 завершил работу. Перезапустите управление PackageFlow. WEB и задания продолжают работу.","PackageFlow");};
                    desktopReady=false;core.Navigate("https://packageflow.local/index.html?v="+CurrentVersion().ToString(3));
                    for(var i=0;i<100&&!desktopReady;i++)await Task.Delay(100,lifetime.Token);
                    if(!desktopReady)throw new InvalidOperationException("Локальный интерфейс не ответил. Проверьте комплект Desktop или восстановите установку PackageFlow.");
                    desktop.BringToFront();return true;
                }catch(OperationCanceledException)when(lifetime.IsCancellationRequested){return false;}
                catch(Exception error) {
                    if(lifetime.IsCancellationRequested||IsDisposed)return false;
                    desktopReady=false;preparation.BringToFront();
                    if(!await preparation.ShowError(error,lifetime.Token)){exiting=true;Close();return false;}
                    manualRetry=true;
                }
            }
            return false;
        }catch(OperationCanceledException)when(lifetime.IsCancellationRequested){return false;}
        finally{preparingDesktop=false;}
    }
    internal static bool TrustedDesktopOrigin(string uri) => DesktopBridgeProtocol.TrustedOrigin(uri);
    private void SendDesktop(object value) { if(desktopReady&&!IsDisposed)desktop?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(value)); }
    private object DesktopState() => new { type="state",language=settings.Language,version=CurrentVersion().ToString(3),wizard=!settings.WizardComplete,busy,progress=progress.Value,status=status.Text,
        log=events.Items.Cast<object>().Take(15).Select(x=>x.ToString()).ToArray(),components=desktopComponents,
        updates=desktopUpdates,windowsUpdate=desktopWindowsUpdate,migration=new{required=settings.LegacyMigrationRequired,review=settings.LegacyMigrationRequired?host.MigrationReview():null,dataDirectory=host.EffectiveWebDataDirectory},config=new { consoleId=settings.ConsoleId,hostIp=settings.HostIp,port=settings.Port,payloadPort=settings.PayloadPort,autoStart=settings.AutoStart,visibleBrowser=settings.FlareSolverrVisibleBrowser,torrents=settings.TorrentSetupSelected,automaticSetupPending=settings.AutomaticSetupPending,
            prowlarrUrl=settings.ProwlarrUrl,trackerUsername=settings.TrackerUsername,trackerPasswordSaved=settings.ProtectedTrackerPassword.Length>0,prowlarrKeySaved=settings.ProtectedProwlarrKey.Length>0,
            torrentAddress=torrentAddress.Text,torrentUser=torrentUser.Text,torrentFolder=torrentFolder.Text },
        lan=ServerHost.LanAddresses(),consoles=desktopConsoles,found=desktopFound.Values,indexers=indexers.Items.Cast<Indexer>().Select(x=>new {id=x.Id,name=x.Name}),webUrl=host.WebUrl,started=host.Started };
    private void PushDesktopState() { if(InvokeRequired){BeginInvoke(PushDesktopState);return;}SendDesktop(DesktopState()); }
    private async void DesktopMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if(!TrustedDesktopOrigin(e.Source))return;
        string? requestId=null;
        try {
            var request=DesktopBridgeProtocol.Parse(e.Source,e.WebMessageAsJson);
            requestId=request.Id;var command=request.Command;var payload=request.Payload;
            if(command=="ready") { StrictKeys(payload,[]);desktopReady=true;PushDesktopState();SendDesktop(new{type="result",id=requestId,ok=true});return; }
            if(command=="dialog.reply") { StrictKeys(payload,["dialogId","confirmed"]);if(TextValue(payload,"dialogId",80)==desktopDialogId)desktopDialog?.TrySetResult(payload.GetProperty("confirmed").GetBoolean());SendDesktop(new{type="result",id=requestId,ok=true});return; }
            if(command=="discovery.cancel") { StrictKeys(payload,[]);desktopDiscovery?.Cancel();SendDesktop(new{type="result",id=requestId,ok=true});return; }
            if(command=="refresh") { StrictKeys(payload,[]);await DesktopRefresh();PushDesktopState();SendDesktop(new{type="result",id=requestId,ok=true});return; }
            if(busy)throw new InvalidOperationException(T("Дождитесь завершения текущей операции.","Wait for the current operation."));
            busy=true;applicationSummary=null;PushDesktopState();
            try { await DesktopCommand(command,payload);if(applicationSummary!=null)Report(applicationSummary); }
            finally { busy=false;PushDesktopState();await DesktopRefresh();PushDesktopState(); }
            SendDesktop(new {type="result",id=requestId,ok=true});
        } catch(OperationCanceledException) { Report(T("Операция отменена","Operation cancelled"));SendDesktop(new{type="result",id=requestId,ok=false,error=T("Отменено","Cancelled")}); }
        catch(Exception error) { Report(T("Ошибка: ","Error: ")+FriendlyError(error));SendDesktop(new{type="result",id=requestId,ok=false,error=FriendlyError(error)}); }
    }
    private static void StrictKeys(JsonElement element,string[] allowed) { if(element.ValueKind!=JsonValueKind.Object||element.EnumerateObject().Any(x=>!allowed.Contains(x.Name))||element.EnumerateObject().GroupBy(x=>x.Name).Any(g=>g.Count()>1))throw new ArgumentException("Invalid command payload"); }
    private static string TextValue(JsonElement p,string key,int limit=4096) { var s=p.GetProperty(key).GetString()??throw new ArgumentException("Missing "+key);if(s.Length>limit||s.Contains('\0'))throw new ArgumentException("Invalid "+key);return s; }
    private void DesktopFields(JsonElement p)
    {
        StrictKeys(p,["hostIp","port","payloadPort","autoStart","visibleBrowser","prowlarrUrl","prowlarrKey","trackerUsername","trackerPassword","torrentAddress","torrentUser","torrentPassword","torrentFolder","installFlare","indexerId"]);
        foreach(var x in p.EnumerateObject()) switch(x.Name) {
            case "hostIp":var ip=x.Value.GetString();if(!ServerHost.LanAddresses().Contains(ip))throw new ArgumentException("Invalid LAN address");lan.SelectedIndex=Array.IndexOf(ServerHost.LanAddresses(),ip);break;
            case "port":case "payloadPort":var n=x.Value.GetInt32();if(n<1024||n>65535)throw new ArgumentException("Invalid port");(x.Name=="port"?port:payloadPort).Text=n.ToString();break;
            case "autoStart":autoStart.Checked=x.Value.GetBoolean();break;case "visibleBrowser":visibleFlare.Checked=x.Value.GetBoolean();break;case "installFlare":installFlare.Checked=x.Value.GetBoolean();break;
            case "indexerId":var id=x.Value.GetInt32();indexers.SelectedIndex=Array.FindIndex(indexers.Items.Cast<Indexer>().ToArray(),i=>i.Id==id);break;
            default:var field=x.Name switch {"prowlarrUrl"=>prowlarrUrl,"prowlarrKey"=>prowlarrKey,"trackerUsername"=>trackerUser,"trackerPassword"=>trackerPassword,"torrentAddress"=>torrentAddress,"torrentUser"=>torrentUser,"torrentPassword"=>torrentPassword,"torrentFolder"=>torrentFolder,_=>throw new ArgumentException("Unknown field")};if(x.Name=="trackerUsername"&&field.Text!=TextValue(p,x.Name)&&!p.TryGetProperty("trackerPassword",out _))trackerPassword.Text="";field.Text=TextValue(p,x.Name);break;
        }
    }
    private Task DesktopAction(string ru,string en)=>desktopActions[desktopActions.ContainsKey(ru)?ru:en]();
    private async Task DesktopCommand(string command,JsonElement p)
    {
        if(settings.LegacyMigrationRequired && command is not ("migration.inspect" or "migration.confirm" or "language" or "link" or "wallet.copy" or "updates.check"))host.EnsureDataMigrationReady();
        if(desktopCommands.TryGetValue(command,out var labels)) { DesktopFields(p);if(command is "prowlarr.install" or "flare.install" or "torrent.setup"){settings.TorrentSetupSelected=true;settings.Save(ServerHost.SettingsPath);}var parts=labels.Split('|');await desktopActions[desktopActions.ContainsKey(parts[0])?parts[0]:parts[1]]();return; }
        switch(command) {
            case "migration.inspect":StrictKeys(p,[]);break;
            case "migration.confirm":StrictKeys(p,["path","allowEmpty"]);if(!await DesktopConfirm(T("Перенести данные в Windows?","Import data for Windows?"),T("Старый WEB должен быть остановлен вручную. Будет создана отдельная копия выбранного каталога. Исходные файлы, контейнеры и volume остаются нетронутыми. Сетевые хранилища проверьте после запуска.","Stop the former WEB manually first. A separate copy of the selected data is created. Original files, containers and volumes remain untouched. Review network sources after startup.")))return;await host.ConfirmDataMigration(TextValue(p,"path"),p.GetProperty("allowEmpty").GetBoolean(),lifetime.Token);Report(T("Данные подготовлены. Нажмите «Применить и запустить».","Data prepared. Click Apply and start."));break;
            case "language":StrictKeys(p,["language"]);var lang=TextValue(p,"language");if(lang is not("ru" or "en"))throw new ArgumentException("Invalid language");settings.Language=lang;SaveLanguage();break;
            case "web.open":StrictKeys(p,[]);OpenWeb();break;
            case "server.start":StrictKeys(p,[]);await host.Start(lifetime.Token);break;
            case "server.stop":StrictKeys(p,[]);await StopFromTray();break;
            case "discovery.start":StrictKeys(p,[]);await DesktopDiscover();break;
            case "discovery.manual":StrictKeys(p,["ip"]);var found=await ConsoleDiscovery.Detect(TextValue(p,"ip",64),lifetime.Token)??throw new InvalidOperationException(T("Платформа не обнаружена. Запустите службу или выполните поиск.","Platform not detected. Start the console service or run discovery."));desktopFound[found.Ip]=found;break;
            case "console.connect":StrictKeys(p,["ip","name","platform"]);await DesktopConnect(p);break;
            case "console.select":case "console.check":case "console.forget":case "console.remove-app":StrictKeys(p,["id"]);await DesktopConsoleAction(command,TextValue(p,"id",128));break;
            case "console.install":StrictKeys(p,["ids"]);await DesktopInstall(Ids(p));break;
            case "updates.check":StrictKeys(p,[]);await DesktopCheckUpdates();break;
            case "updates.install":StrictKeys(p,["ids","windows"]);if(p.GetProperty("windows").GetBoolean())await DesktopAction("Обновить Windows-приложение","Update Windows app");var ids=Ids(p);if(ids.Length>0)await DesktopInstall(ids);break;
            case "wizard.finish":StrictKeys(p,["torrents","consoles","trackerUsername","trackerPassword","manual"]);await DesktopFinishWizard(p);break;
            case "wallet.copy":StrictKeys(p,["index"]);using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("PackageFlow.Assets.donations.json")){var wallets=JsonSerializer.Deserialize<List<DonationWallet>>(stream!)!;var index=p.GetProperty("index").GetInt32();if(index<0||index>=wallets.Count)throw new ArgumentException("Invalid wallet");Clipboard.SetText(wallets[index].Address);}Report(T("Адрес скопирован","Address copied"));break;
            case "link":StrictKeys(p,["target"]);ProcessRunner.Open(TextValue(p,"target") switch {"github"=>"https://github.com/"+GithubProject.Repository,"4pda"=>"https://4pda.to/forum/index.php?showtopic=1127073","discord"=>"https://discord.gg/eZDydyvGf",_=>throw new ArgumentException("Invalid link")});break;
            default:throw new ArgumentException("Unknown desktop command");
        }
    }
    private static string[] Ids(JsonElement p) { var a=p.GetProperty("ids");if(a.ValueKind!=JsonValueKind.Array||a.GetArrayLength()>64)throw new ArgumentException("Invalid selection");return a.EnumerateArray().Select(x=>x.GetString() is {Length:>0 and <=128} s?s:throw new ArgumentException("Invalid id")).Distinct().ToArray(); }
    private async Task DesktopRefresh(bool probe=false) {
        if(!host.Started)return;
        try { using var timeout=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);timeout.CancelAfter(TimeSpan.FromSeconds(10));desktopConsoles=await host.Api("/api/consoles",ct:timeout.Token);if(probe)foreach(var p in desktopConsoles["consoles"]!.AsArray())await host.Api("/api/consoles/probe",new{id=p!["id"]!.GetValue<string>()},timeout.Token); }
        catch(Exception error){Report(FriendlyError(error));}
    }
    private async Task DesktopDiscover() {
        using var ct=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);ct.CancelAfter(TimeSpan.FromSeconds(40));desktopDiscovery=ct;
        try {var local=NetworkInterface.GetAllNetworkInterfaces().Where(n=>n.OperationalStatus==OperationalStatus.Up).SelectMany(n=>n.GetIPProperties().UnicastAddresses).First(a=>a.Address.AddressFamily==AddressFamily.InterNetwork&&a.Address.ToString()==(settings.HostIp.Length>0?settings.HostIp:ServerHost.LanAddresses().First()));
            await ConsoleDiscovery.Discover(local.Address.ToString(),local.IPv4Mask.ToString(),desktopFound.Values.ToArray(),new Progress<int>(n=>{progress.Value=n;PushDesktopState();}),ct.Token,new Progress<DiscoveredConsole>(d=>{desktopFound[d.Ip]=d;PushDesktopState();}));
        }finally{desktopDiscovery=null;}
    }
    private async Task DesktopConnect(JsonElement p) {
        if(!host.Started)await ApplyInstallation();var ip=TextValue(p,"ip",64);
        var d=desktopFound.GetValueOrDefault(ip)??await ConsoleDiscovery.Detect(ip,lifetime.Token);
        var platform=TextValue(p,"platform",8);if(platform is not("ps4" or "ps5"))throw new ArgumentException("Invalid platform");
        if(d!=null&&d.Platform!=platform)throw new ArgumentException("Console platform mismatch");
        if(!IPAddress.TryParse(ip,out var address)||address.AddressFamily!=AddressFamily.InterNetwork||IPAddress.IsLoopback(address)||address.GetAddressBytes()[0] is 0 or >=224)throw new ArgumentException("Invalid console IPv4");
        var savedProfile=new JsonObject { ["ip"]=address.ToString(),["name"]=TextValue(p,"name",80),["platform"]=platform,["transport"]="service" };
        if(!string.IsNullOrWhiteSpace(d?.Model))savedProfile["model"]=d.Model;
        await host.Api("/api/consoles",savedProfile,lifetime.Token);
        await DesktopRefresh();var profile=desktopConsoles!["consoles"]!.AsArray().First(x=>x!["ip"]!.GetValue<string>()==address.ToString()&&x["platform"]!.GetValue<string>()==platform)!;
        Report(T("Профиль сохранён. Проверяем подключение…","Profile saved. Checking connection…"));
        await DesktopConsoleAction("console.select",profile["id"]!.GetValue<string>());
        await host.Api("/api/consoles/pair",new{id=settings.ConsoleId},lifetime.Token);Report(T("Подключение подтверждено","Connection verified"));
    }
    private async Task DesktopConsoleAction(string command,string id) {
        EnsureStarted();await DesktopRefresh();var p=desktopConsoles?["consoles"]?.AsArray().FirstOrDefault(x=>x?["id"]?.GetValue<string>()==id)??throw new ArgumentException("Unknown console");
        switch(command){
            case "console.select":await host.Api("/api/consoles/active",new{id},lifetime.Token);settings.ConsoleId=id;settings.PsIp=p["ip"]!.GetValue<string>();settings.ConsolePlatform=p["platform"]!.GetValue<string>();settings.Save(ServerHost.SettingsPath);break;
            case "console.check":await DesktopCheckConsole(p);break;
            case "console.forget":if(!await DesktopConfirm(T("Удалить профиль?","Remove profile?"),T("Ключ сопряжения будет удалён из Windows. Файлы на приставке сохранятся.","The pairing key will be removed from Windows. Console files will remain.")))return;await host.Api("/api/desktop/console-forget",new{consoleId=id,confirmed=true},lifetime.Token);settings.ConsoleSetupRequests.Remove(id);if(settings.ConsoleId==id){settings.ConsoleId="";settings.PsIp="";}settings.Save(ServerHost.SettingsPath);break;
            case "console.remove-app":if(p["platform"]!.GetValue<string>()!="ps5")throw new InvalidOperationException(T("Удаление PS4 доступно в WEB → На консоли","PS4 removal is available in WEB → On console"));if(!await DesktopConfirm(T("Удалить приложение PS5?","Remove PS5 application?"),T("Закройте приложение. Исходный образ будет удалён; ELF и сохранения останутся.","Close the application. Its source image will be removed; ELF and saves remain.")))return;
                if(settings.SetupRemoveAppConsoleId!=id||settings.SetupRemoveAppRequestId.Length!=32){settings.SetupRemoveAppConsoleId=id;settings.SetupRemoveAppRequestId=Guid.NewGuid().ToString("N");settings.Save(ServerHost.SettingsPath);}var result=await host.Api("/api/desktop/console-setup",new{consoleId=id,action="remove-app",requestId=settings.SetupRemoveAppRequestId,confirmed=true},lifetime.Token);if(result["state"]?.GetValue<string>()!="accepted")throw new InvalidOperationException("Removal not confirmed; observe WEB before retrying");Report(T("PS5 приняла команду удаления","PS5 accepted removal command"));break;
        }
    }
    private async Task DesktopInstall(string[] ids) {
        EnsureStarted();await DesktopRefresh();var known=desktopConsoles!["consoles"]!.AsArray().Select(p=>p!["id"]!.GetValue<string>()).ToHashSet();if(ids.Any(id=>!known.Contains(id)))throw new ArgumentException("Unknown console");
        var coordinator=new ConsoleSetupCoordinator((path,body,ct)=>host.Api(path,body,ct),InstallPs4ConsoleService,settings,()=>settings.Save(ServerHost.SettingsPath));
        var results=await coordinator.Run(ids,new Progress<string>(Report),lifetime.Token);settings.FirstSetupConsoleIds.RemoveAll(id=>results.Any(r=>r.Id==id&&r.Complete));if(settings.FirstSetupConsoleIds.Count>0)settings.AutomaticSetupPending=true;settings.Save(ServerHost.SettingsPath);foreach(var r in results)Report(r.Name+": "+r.Message);if(results.Any(r=>!r.Complete))throw new InvalidOperationException(T("Подготовка завершена не для всех приставок. Проверьте результаты.","Some consoles require attention. Check results."));
    }
    private async Task DesktopResumePreparation() {
        await PrepareFirstRun();
        if(settings.AutomaticSetupPending)throw new InvalidOperationException(T("Подготовка требует внимания. Повторите компоненты в Поиске.","Preparation needs attention. Retry components in Search."));
        if(settings.FirstSetupConsoleIds.Count>0)await DesktopInstall(settings.FirstSetupConsoleIds.ToArray());
    }
    private async Task DesktopCheckUpdates() {
        try { await DesktopAction("Проверить обновления","Check updates");desktopWindowsUpdate=applicationSummary??""; }
        catch(Exception error){desktopWindowsUpdate=FriendlyError(error);Report(desktopWindowsUpdate);}
        if(!host.Started){Report(desktopWindowsUpdate+" • "+T("Запустите WEB для проверки приставок","Start WEB to check consoles"));return;}
        await DesktopRefresh();
        foreach(var profile in desktopConsoles?["consoles"]?.AsArray()??new JsonArray())if(profile!=null)await DesktopCheckConsole(profile);
        applicationSummary=T("Проверка завершена. Результаты указаны у каждого устройства.","Check finished. See each device's results.");
    }
    private async Task DesktopCheckConsole(JsonNode profile) {
        var id=profile["id"]!.GetValue<string>();
        try {
            using var timeout=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);timeout.CancelAfter(TimeSpan.FromSeconds(30));
            if(profile["platform"]!.GetValue<string>()=="ps5") {
                var info=await host.Api("/api/desktop/console-setup?consoleId="+Uri.EscapeDataString(id),ct:timeout.Token);
                var update=await host.Api("/api/consoles/service-update?consoleId="+Uri.EscapeDataString(id),ct:timeout.Token);
                // Read the installed app metadata only on an explicit check. A bundled release is never an installed version.
                string appCurrent="",appMessage="";bool? appInstalled=null;long? appCheckedAt=null;
                if(info["profile"]?["online"]?.GetValue<bool>()==true && info["profile"]?["paired"]?.GetValue<bool>()==true && info["release"]?["app"]?["titleId"]?.GetValue<string>() is string appTitleId) {
                    try {
                        var app=await host.Api("/api/ps5/management/game-info",new{consoleId=id,titleId=appTitleId},timeout.Token);
                        appInstalled=app["installed"]?.GetValue<bool>();
                        if(appInstalled==true)appCurrent=app["version"]?.GetValue<string>()??"";
                        appCheckedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    } catch(Exception) { appMessage=T("Установленную версию приложения подтвердить не удалось.","The installed application version could not be confirmed."); }
                }
                desktopUpdates[id]=new { appCurrent,appInstalled,appCheckedAt,appMessage,current=info["profile"]?["version"]?.GetValue<string>()??"",target=info["release"]?["elf"]?["version"]?.GetValue<string>()??"",appTarget=info["release"]?["app"]?["version"]?.GetValue<string>()??"",message=info["flow"]?["message"]?.GetValue<string>()??info["artifactMessage"]?.GetValue<string>()??"",online=info["profile"]?["online"]?.GetValue<bool>()==true,loader=info["loader"]?.GetValue<bool>(),ready=info["installReady"]?.GetValue<bool>()==true,flow=update["flow"]?["message"]?.GetValue<string>()??"" };
            } else {
                var list=await host.Api("/api/consoles/probe",new{id},timeout.Token);var current=list["consoles"]!.AsArray().First(p=>p!["id"]!.GetValue<string>()==id)!;
                var release=await host.Api("/api/ps4/service-update/check?current="+Uri.EscapeDataString(current["pkgVersion"]?.GetValue<string>()??"0.00"),ct:timeout.Token);
                desktopUpdates[id]=new {current=current["pkgVersion"]?.GetValue<string>()??"",target=release["version"]?.GetValue<string>()??"",appTarget="",message=release["message"]?.GetValue<string>()??"",online=current["online"]?.GetValue<bool>()==true};
            }
        }catch(Exception error){desktopUpdates[id]=new{message=FriendlyError(error),online=false};Report(profile["name"]+": "+FriendlyError(error));}
        PushDesktopState();
    }
    private void DesktopWizardCredentials(string username,string password) {
        if(!string.Equals(settings.TrackerUsername,username,StringComparison.Ordinal))settings.ProtectedTrackerPassword="";
        settings.TrackerUsername=username;
        if(password.Length>0)settings.ProtectedTrackerPassword=LocalSecrets.Protect(password);
        trackerUser.Text=username;trackerPassword.Text=LocalSecrets.Read(settings.ProtectedTrackerPassword);
    }
    private async Task DesktopFinishWizard(JsonElement p) {
        var chosen=p.GetProperty("consoles");if(chosen.EnumerateArray().Any(x=>!desktopFound.ContainsKey(x.GetString()!)))throw new ArgumentException("Unknown discovery selection");
        settings.TorrentSetupSelected=p.GetProperty("torrents").GetBoolean();settings.FirstSetupConsoleIds.Clear();DesktopWizardCredentials(TextValue(p,"trackerUsername",256),TextValue(p,"trackerPassword"));settings.WizardComplete=true;settings.AutomaticSetupPending=true;settings.Save(ServerHost.SettingsPath);
        if(settings.TorrentSetupSelected&&p.GetProperty("manual").GetBoolean()){settings.FlareSolverrVisibleBrowser=true;visibleFlare.Checked=true;}
        await ApplyInstallation();
        foreach(var ip in chosen.EnumerateArray().Select(x=>x.GetString()!)) { var d=desktopFound.GetValueOrDefault(ip)??throw new ArgumentException("Unknown discovery");await host.Api("/api/consoles",new{ip=d.Ip,name=d.Name,platform=d.Platform,transport="service"},lifetime.Token);await DesktopRefresh();settings.FirstSetupConsoleIds.Add(desktopConsoles!["consoles"]!.AsArray().First(x=>x!["ip"]!.GetValue<string>()==ip)!["id"]!.GetValue<string>()); }
        settings.Save(ServerHost.SettingsPath);await DesktopResumePreparation();
        if(settings.TorrentSetupSelected&&!settings.AutomaticSetupPending) {if(p.GetProperty("manual").GetBoolean())await ManualTrackerLogin();else if(trackerUser.Text.Length>0&&trackerPassword.Text.Length>0)await DesktopAction("Добавить RuTracker и проверить","Add and test RuTracker");}
        Report(applicationSummary??T("Подготовка завершена","Preparation complete"));
    }
    private async Task<bool> DesktopConfirm(string title,string message,bool notice=false) {
        if(!desktopReady)return MessageBox.Show(this,message,title,notice?MessageBoxButtons.OK:MessageBoxButtons.OKCancel)==DialogResult.OK;
        ShowWindow();desktopDialog=new(TaskCreationOptions.RunContinuationsAsynchronously);desktopDialogId=Guid.NewGuid().ToString("N");SendDesktop(new{type="dialog",id=desktopDialogId,title,message,notice});try{return await desktopDialog.Task.WaitAsync(lifetime.Token);}finally{desktopDialog=null;desktopDialogId=null;}
    }
    private async Task DesktopNotice(string text) => _=await DesktopConfirm("PackageFlow",text,true);
}
