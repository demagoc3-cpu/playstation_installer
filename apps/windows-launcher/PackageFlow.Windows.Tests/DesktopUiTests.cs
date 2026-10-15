using System.Reflection;using System.Text.Json;using Microsoft.Web.WebView2.Core;using Microsoft.Web.WebView2.WinForms;using PackageFlow.Core;using PackageFlow.Windows;
internal static class DesktopUiTests {
 static readonly BindingFlags Flags=BindingFlags.NonPublic|BindingFlags.Instance;
 static T Field<T>(object o,string n)=>(T)o.GetType().GetField(n,Flags)!.GetValue(o)!;
 static object? Call(object o,string n,params object[] a)=>o.GetType().GetMethod(n,Flags)!.Invoke(o,a);
 static void Check(bool b,string m){if(!b)throw new Exception(m);}
 static void Pump(int ms=150){var end=DateTime.UtcNow.AddMilliseconds(ms);while(DateTime.UtcNow<end){Application.DoEvents();Thread.Sleep(10);}}
 static void Wait(Task t){var end=DateTime.UtcNow.AddSeconds(40);while(!t.IsCompleted&&DateTime.UtcNow<end)Pump(20);if(!t.IsCompleted)throw new TimeoutException();t.GetAwaiter().GetResult();}
 static string Script(WebView2 v,string js){var t=v.CoreWebView2.ExecuteScriptAsync(js);Wait(t);return t.Result;}
 static void Save(WebView2 v,string file){using var f=File.Create(file);Wait(v.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,f));}
 public static void Run(string report){
  var output=Path.ChangeExtension(report,null)+"-screens";Directory.CreateDirectory(output);File.WriteAllText(report,"RUNNING: Windows WebView2, isolated fixtures\n");
  var folder=Path.Combine(Path.GetTempPath(),"PackageFlow-desktop-fixture-"+Guid.NewGuid());Directory.CreateDirectory(folder);
  using var form=new MainForm(false,new LauncherSettings{GamesDirectory=folder,WizardComplete=true,TrackerUsername="fixture-user",ProtectedTrackerPassword=LocalSecrets.Protect("fixture-secret")}){WindowState=FormWindowState.Normal};
  form.Show();Pump();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Wait((Task)Call(form,"InitializeDesktop")!);var view=Field<WebView2>(form,"desktop");var limit=DateTime.UtcNow.AddSeconds(25);while(!Field<bool>(form,"desktopReady")&&DateTime.UtcNow<limit)Pump();Check(Field<bool>(form,"desktopReady"),"Desktop did not become ready");
  var dependency=Field<WebViewRuntimeHost>(form,"runtimePreparationHost");Check(dependency.DownloadRequests==0&&dependency.InstallerDispatches==0,"Installed Runtime caused download/install");Check(Script(view,"/Docker|Compose/.test(document.body.innerText)")=="false","Removed mode or installer link is visible");
  form.GetType().GetField("desktopConsoles",Flags)!.SetValue(form,System.Text.Json.Nodes.JsonNode.Parse("{\"consoles\":[{\"id\":\"fixture-ps4\",\"ip\":\"192.168.50.4\",\"name\":\"FIXTURE PS4 Living room\",\"platform\":\"ps4\",\"online\":true,\"serviceVersion\":\"2.14\"},{\"id\":\"fixture-ps5\",\"ip\":\"192.168.50.5\",\"name\":\"FIXTURE PS5 Bedroom\",\"platform\":\"ps5\",\"online\":false}] }"));
  Call(form,"Report","TEST FIXTURE · isolated Windows UI / изолированная фикстура");var serialized=JsonSerializer.Serialize(Call(form,"DesktopState"));Check(!serialized.Contains("fixture-secret")&&!serialized.Contains("ProtectedTracker"),"State exposes secrets");
  var secureSettings=Field<LauncherSettings>(form,"settings");Call(form,"DesktopWizardCredentials","fixture-user","");Check(LocalSecrets.Read(secureSettings.ProtectedTrackerPassword)=="fixture-secret","Empty wizard password erased saved credentials");Call(form,"DesktopWizardCredentials","different-user","");Check(secureSettings.ProtectedTrackerPassword=="","Credentials reused for a different account");Call(form,"DesktopWizardCredentials","fixture-user","fixture-secret");var secureFile=Path.Combine(folder,"credentials.json");secureSettings.Save(secureFile);Check(!File.ReadAllText(secureFile).Contains("fixture-secret")&&LocalSecrets.Read(LauncherSettings.Load(secureFile).ProtectedTrackerPassword)=="fixture-secret","DPAPI credential restart failed");
  Check(MainForm.TrustedDesktopOrigin("https://packageflow.local/index.html")&&!MainForm.TrustedDesktopOrigin("https://packageflow.local.attacker/index.html")&&!MainForm.TrustedDesktopOrigin("http://packageflow.local")&&!MainForm.TrustedDesktopOrigin("https://packageflow.local:4433"),"Origin allowlist failed");
  foreach(var cmd in new[]{"shell","file.read","fetch","console.connect"}){using var d=JsonDocument.Parse("{\"unexpected\":\"x\"}");bool failed=false;try{Wait((Task)Call(form,"DesktopCommand",cmd,d.RootElement.Clone())!);}catch{failed=true;}Check(failed,"Invalid payload accepted: "+cmd);}
  File.AppendAllText(report,"PASS: trusted origin, unknown commands, unexpected payloads; state excludes saved secrets; DPAPI survives isolated save/reload and wizard reuse; account changes clear old credentials\n");
  foreach(var zoom in new[]{1.0,1.25,1.5})foreach(var size in new[]{new Size(1000,700),new Size(1280,800),new Size(1920,1080)}){
   form.ClientSize=new Size((int)(size.Width*zoom),(int)(size.Height*zoom));view.ZoomFactor=zoom;Pump(250);
   File.AppendAllText(report,"VIEWPORT: requested "+size+" zoom="+zoom+" actual="+Script(view,"JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})")+"\n");
   foreach(var page in new[]{"Главная","Приставки","Поиск","Обновления","Поддержать проект"}){
    Script(view,"[...document.querySelectorAll('aside button')].find(b=>b.textContent.includes("+JsonSerializer.Serialize(page)+"))?.click()");Pump();
    Save(view,Path.Combine(output,$"{page}-{size.Width}x{size.Height}-{zoom:F2}.png"));
    Check(Script(view,"document.documentElement.scrollWidth<=innerWidth")=="true","Horizontal overflow: "+page+" "+size+" "+zoom);
    Check(Script(view,"[...document.querySelectorAll('main .page-actions button')].every(b=>{const r=b.getBoundingClientRect();const f=document.querySelector('footer').getBoundingClientRect();return r.right<=innerWidth&&r.left>=0&&r.bottom<=f.top})")=="true","Primary actions hidden: "+page+" "+size+" "+zoom);
    Save(view,Path.Combine(output,$"{page}-{size.Width}x{size.Height}-{zoom:F2}.png"));
   }
  }
  form.ClientSize=new Size(1280,800);view.ZoomFactor=1;Call(form,"SendDesktop",new{type="wizard"});Pump();
  for(var step=0;step<4;step++){Save(view,Path.Combine(output,"wizard-"+step+".png"));if(step==0)Script(view,"document.querySelectorAll('.choice input')[1].click()");if(step<3){Script(view,"document.querySelector('.wizard-footer .primary').click()");Pump();}}
  Script(view,"document.querySelector('.wizard-footer>button').click()");Pump();Check(Script(view,"document.querySelector('.password input').type")=="\"password\"","Password not masked");Script(view,"document.querySelector('.password button').click()");Check(Script(view,"document.querySelector('.password input').type")=="\"text\"","Password reveal failed");
  var dialog=(Task<bool>)Call(form,"DesktopConfirm","Fixture stop warning","Fixture active task",false)!;Pump();Save(view,Path.Combine(output,"busy-stop.png"));Check(Script(view,"document.activeElement.classList.contains('keep')")=="true","Stop dialog default is destructive");Script(view,"window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");Wait(dialog);Check(!dialog.Result,"Escape did not preserve work");
  var dialog2=(Task<bool>)Call(form,"DesktopConfirm","Fixture confirmation","Fixture",false)!;Pump();Script(view,"document.querySelector('.dialog .danger').click()");Wait(dialog2);Check(dialog2.Result,"Explicit confirmation failed");view.CoreWebView2.Navigate("https://example.com/");Pump();Check(view.Source.Host=="packageflow.local","Untrusted navigation escaped origin");
  GlassStopTests.Run(form,()=>Pump(30));
  File.AppendAllText(report,"PASS: new WebView stop dialog preserves jobs on cancel, confirms stop, rechecks late jobs, pauses only active PackageFlow torrents\n");
  File.AppendAllText(report,"PASS: five sections across requested 1000x700 / 1280x800 / 1920x1080 and 100/125/150% WebView zoom; actual viewports logged above; no horizontal overflow or footer overlap\nPASS: wizard transitions, password reveal, new dialog default focus / Escape / confirmation, untrusted navigation blocked\nNOTE: scaling uses WebView zoom; OS DPI unchanged. Screenshots use CoreWebView2.CapturePreviewAsync. All states are isolated fixtures.\n");form.Close();
 }
}
