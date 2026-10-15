using System.Reflection;
using System.Runtime.InteropServices;
using PackageFlow.Core;
using PackageFlow.Windows;

internal static class Smoke
{
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static T Field<T>(object owner, string name) => (T)owner.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(owner)!;
    private static void Pump() { for (var i = 0; i < 5; i++) { Application.DoEvents(); Thread.Sleep(15); } }
    private static void Select(DarkChoice choice, int index)
    {
        typeof(DarkChoice).GetMethod("OnClick", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(choice, [EventArgs.Empty]);
        Pump();
        var menu = Field<ContextMenuStrip>(choice, "menu");
        Check(menu.Visible && !menu.IsDisposed, "Dropdown must open.");
        var bounds = menu.Items[index].Bounds;
        var point = (bounds.Top + bounds.Height / 2) << 16 | (bounds.Left + bounds.Width / 2);
        SendMessage(menu.Handle, 0x201, (IntPtr)1, (IntPtr)point);
        SendMessage(menu.Handle, 0x202, IntPtr.Zero, (IntPtr)point);
        Pump();
    }
    private static IEnumerable<Control> Descendants(Control root) {
        foreach (Control child in root.Controls) { yield return child; foreach (var nested in Descendants(child)) yield return nested; }
    }
    [STAThread] private static int Main(string[] args)
    {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var report = args.FirstOrDefault() ?? Path.Combine(Path.GetTempPath(), "PackageFlow-ui-tests.txt");
        if(args.Contains("--background-probes")){try{BackgroundProbeTests.Run(report);return 0;}catch(Exception error){File.WriteAllText(report,"FAIL: "+error);return 1;}}
        if(args.Contains("--windows-native")){try{WindowsDependencyTests.Run(report).GetAwaiter().GetResult();return 0;}catch(Exception error){File.AppendAllText(report,"\nFAIL: "+error);return 1;}}
        if(args.Contains("--desktop-ui")) { try { DesktopUiTests.Run(report);return 0; }catch(Exception error){File.AppendAllText(report,"\nFAIL: "+error);return 1;} }
        if(args.Contains("--components")) {
            try { ConsoleComponentsTests.Run(report,args.Skip(Array.IndexOf(args,"--components")+1).ToArray()).GetAwaiter().GetResult();return 0; }
            catch(Exception error){File.AppendAllText(report,"\nFAIL: "+error.Message);return 1;}
        }
        if(args.Contains("--web-runtime")) {
            try { WebRuntimeTests.Run(report).GetAwaiter().GetResult();return 0; }
            catch(Exception error){File.WriteAllText(report,"FAIL: "+error);return 1;}
        }
        if (args.Contains("--discover")) {
            try {
                var flag = Array.IndexOf(args, "--discover");
                var computerIp = args.ElementAtOrDefault(flag + 1) ?? throw new ArgumentException("Provide the test computer's LAN IP.");
                var consoleIp = args.ElementAtOrDefault(flag + 2) ?? throw new ArgumentException("Provide the test console's IP.");
                var local = System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces().SelectMany(network => network.GetIPProperties().UnicastAddresses)
                    .First(address => address.Address.ToString() == computerIp);
                var found = Ps4Discovery.Discover(local.Address.ToString(), local.IPv4Mask.ToString(), null, CancellationToken.None).GetAwaiter().GetResult();
                Check(found.Any(device => device.Ip == consoleIp && device.Service), "The test PS4 service must be discovered on the Windows LAN.");
                File.WriteAllLines(report, found.Select(device => $"PASS: PS4 {device.Ip}; service={device.Service}; PyLoader={device.PyLoader}; rest={device.RestMode}")); return 0;
            } catch (Exception error) { File.WriteAllText(report, "FAIL: " + error); return 1; }
        }
        if (args.Contains("--qbittorrent")) {
            try { QbittorrentTests.Run(report).GetAwaiter().GetResult(); return 0; }
            catch (Exception error) { File.WriteAllText(report, "FAIL: " + error); return 1; }
        }
        var lines = new List<string>();
        File.WriteAllText(report,"RUNNING: Windows glass UI tests\n");
        var testFolder = Path.Combine(Path.GetTempPath(), "PackageFlow-ui-" + Guid.NewGuid());
        Directory.CreateDirectory(testFolder);
        try {
            var settings = new LauncherSettings { Language = "ru", GamesDirectory = testFolder, TrackerUsername = "fixture-user", ProtectedTrackerPassword = LocalSecrets.Protect("fixture-password") };
            using var form = new MainForm(false, settings) { WindowState = FormWindowState.Normal };
            form.Show(); Pump();
            GlassWizardTests.Run(form, Pump, report);
            GlassStopTests.Run(form, Pump);
            File.AppendAllText(report,"PASS: wizard and stop confirmation scenarios\n");
            lines.Add("PASS: opt-in setup wizard, original glass sections, tray autostart and default-safe stop dialog.");
            using (var surface = new Bitmap(80, 80)) {
                using var graphics = Graphics.FromImage(surface); graphics.Clear(Color.Magenta);
                Theme.Clear(new PaintEventArgs(graphics, new Rectangle(20, 20, 10, 10)), Theme.Background);
                Check(surface.GetPixel(5, 5).ToArgb() == Color.Magenta.ToArgb() && surface.GetPixel(25, 25).ToArgb() == Theme.Background.ToArgb(), "Partial repaint must not erase pixels outside the invalid region.");
            }
            lines.Add("PASS: partial repaint respects the invalid region.");
            var homeOpen=Descendants(Field<PageHost>(form,"tabs").TabPages[0]).OfType<Button>().Single(b=>b.Text=="Открыть PackageFlow");
            Check(homeOpen.Visible&&homeOpen.Width>300&&homeOpen.Parent!.ClientRectangle.Contains(homeOpen.Bounds),"Home must expose an unobstructed Open PackageFlow button.");
            var savedGrid=Field<DataGridView>(form,"consoleGrid");
            var savedFixtures=System.Text.Json.Nodes.JsonNode.Parse("""
                {"consoles":[{"id":"fixture-ps4","ip":"192.168.50.4","name":"PS4 Living room","model":"Pro","platform":"ps4","online":true,"paired":true,"firmware":"9.00","version":"0.10.2","pkgVersion":"2.05","freeBytes":107374182400,"checkedAt":0,"capabilities":{"formats":["pkg"]}},
                {"id":"fixture-ps5","ip":"192.168.50.5","name":"PS5 Bedroom","model":"Slim","platform":"ps5","online":false,"paired":false,"firmware":"13.60","capabilities":{"formats":[]}}]}
                """)!;
            savedFixtures["consoles"]![0]!["checkedAt"]=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            SavedConsoleGrid.Render(savedGrid,savedFixtures,"fixture-ps4","ru");
            var savedTabs=Field<PageHost>(form,"tabs");savedTabs.SelectedIndex=1;Pump();
            Check(savedGrid.Rows.Count==2&&savedGrid.Columns.Count==11,"Main Consoles page must list every saved console with metadata and batch selection.");
            savedGrid.Rows[0].Cells["batch"].Value=true;
            SavedConsoleGrid.Render(savedGrid,savedFixtures,"fixture-ps4","ru");
            Check(SavedConsoleGrid.CheckedIds(savedGrid).SequenceEqual(new[]{"fixture-ps4"}),"Refreshing profiles must preserve batch selection.");
            Check(savedGrid.Rows[1].Cells["firmware"].Value?.ToString()=="Не проверено","Offline firmware must not be presented as current.");
            Check(savedGrid.Rows[0].Cells["version"].Value?.ToString()=="2.05","Service package version is missing.");
            foreach(var size in new[]{new Size(980,700),new Size(1840,850)}) {
                form.ClientSize=size;Pump();
                Check(savedGrid.Width>600&&savedGrid.Height>=200&&savedGrid.Parent!.ClientRectangle.Contains(savedGrid.Bounds),$"Main console table must fit the page at {size}: grid={savedGrid.Bounds}; parent={savedGrid.Parent!.ClientSize}; form={form.ClientSize}.");
            }
            form.ClientSize=new Size(1440,740);form.Location=new Point(10,10);Pump();
            using(var shot=new Bitmap(form.ClientSize.Width,form.ClientSize.Height)) {
                form.DrawToBitmap(shot,new Rectangle(Point.Empty,form.ClientSize));
                shot.Save(Path.ChangeExtension(report,"saved-consoles.png"));
            }
            lines.Add("PASS: main Consoles page lists saved PS4/PS5, current status and metadata, fits narrow/wide windows.");
            using (var manager = new ConsoleManagerForm(Field<ServerHost>(form,"host"), settings, (_, _, _) => Task.CompletedTask, preview:true)) {
                manager.RenderRows(new[] {
                    System.Text.Json.Nodes.JsonNode.Parse("{\"id\":\"fixture-ps4\",\"ip\":\"192.168.50.4\",\"name\":\"PS4 Living room\",\"platform\":\"ps4\",\"online\":true,\"paired\":true,\"checkedAt\":1,\"firmware\":\"9.00\"}")!,
                    System.Text.Json.Nodes.JsonNode.Parse("{\"id\":\"fixture-ps5\",\"ip\":\"192.168.50.5\",\"name\":\"PS5 Bedroom\",\"platform\":\"ps5\",\"online\":false,\"paired\":false,\"firmware\":\"13.60\"}")!
                },new[]{new DiscoveredConsole("192.168.50.6","Unpaired PS5","ps5",Loader:true)});
                manager.Show(form);Pump();
                var deviceGrid=Field<DataGridView>(manager,"grid");Check(deviceGrid.Rows.Count==3,"Discovery must show saved, offline and unpaired devices together.");
                Check(deviceGrid.Rows[1].Cells["firmware"].Value?.ToString()=="Не проверено","Offline profile firmware must not be shown as live evidence.");
                foreach(var size in new[]{new Size(1000,700),new Size(1120,740)}){
                    manager.ClientSize=size;Pump();
                    Check(deviceGrid.Width>900&&deviceGrid.Height>100,"Console list must remain usable at minimum window size.");
                    foreach(var button in Descendants(manager).OfType<Button>())Check(button.Right<=button.Parent!.ClientSize.Width&&button.Bottom<=button.Parent.ClientSize.Height,"Console modal buttons are clipped.");
                    Check(!Descendants(manager).OfType<DarkChoice>().Any(),"Platform must be detected, not selected manually.");
                    Check(typeof(ConsoleManagerForm).GetField("firmware",BindingFlags.NonPublic|BindingFlags.Instance)==null,"Firmware must be read through the ELF, not entered manually.");
                    Check(Descendants(manager).OfType<Button>().Any(b=>b.Text=="Удалить приложение")&&Descendants(manager).OfType<Button>().Any(b=>b.Text=="Удалить устройство"),"Removal controls are missing.");
                    foreach(var input in Descendants(manager).OfType<TextBox>())Check(input.Visible&&input.Height>=input.PreferredHeight&&input.Top>=0&&input.Bottom<=input.Parent!.ClientSize.Height,$"Console modal input is clipped or hidden: bounds={input.Bounds}; preferredHeight={input.PreferredHeight}; visible={input.Visible}; parent={input.Parent!.ClientSize}.");
                    foreach(var input in Descendants(manager).Where(c=>c is TextBox or DarkChoice))Check(input.Width>100&&manager.RectangleToScreen(manager.ClientRectangle).Contains(new Rectangle(input.PointToScreen(Point.Empty),input.Size)), $"Console modal field falls outside the window: bounds={input.Bounds}; parent={input.Parent!.ClientSize}; screen={input.PointToScreen(Point.Empty)}.");
                    foreach(var input in Descendants(manager).Where(c=>c is TextBox or DarkChoice))Check(input.Parent!.ClientRectangle.Contains(input.Bounds),$"Console modal field is clipped by its parent: bounds={input.Bounds}; parent={input.Parent.ClientSize}.");
                }
                manager.Size=new Size(1120,700);manager.Location=new Point(5,5);Pump();
                using var shot=new Bitmap(manager.ClientSize.Width,manager.ClientSize.Height);manager.DrawToBitmap(shot,new Rectangle(Point.Empty,shot.Size));shot.Save(Path.ChangeExtension(report,"consoles.png"));
                manager.Close();lines.Add("PASS: PS4/PS5 modal renders saved/offline/unpaired rows at two sizes; unknown FW preserved.");
            }
            using (var manager = new ConsoleManagerForm(Field<ServerHost>(form,"host"), settings, (_, _, _) => Task.CompletedTask, preview:true)) {
                manager.Show(form);Pump();
                var running=(Task)typeof(ConsoleManagerForm).GetMethod("RunSearch",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(manager,new object[]{(Func<CancellationToken,Task>)(ct=>Task.Delay(Timeout.Infinite,ct))})!;
                Pump();
                Check(Field<DataGridView>(manager,"grid").Enabled && Field<TextBox>(manager,"ip").Enabled,"Discovery must leave console selection and manual input usable.");
                Check(!manager.UseWaitCursor,"Discovery must not inherit an interface-wide wait cursor.");
                var stop=Descendants(manager).OfType<Button>().Single(button=>button.Text=="Остановить поиск");
                Check(stop.Enabled,"Search cancellation must remain available for an unreachable console.");
                stop.PerformClick();
                for(var i=0;i<20&&!running.IsCompleted;i++)Pump();
                Check(running.IsCompleted,"Cancelled discovery must release the window promptly.");running.GetAwaiter().GetResult();
                Check(stop.Text=="Найти" && Field<DataGridView>(manager,"grid").Enabled,"Cancelled discovery must restore Find and leave the list usable.");
                manager.Close();lines.Add("PASS: stalled discovery keeps selection/input responsive; Stop search cancels and restores controls.");
            }
            using (var manager = new ConsoleManagerForm(Field<ServerHost>(form,"host"), settings, (_, _, _) => Task.CompletedTask, preview:true)) {
                manager.Show(form);Pump();
                var completion=new TaskCompletionSource();
                var running=(Task)typeof(ConsoleManagerForm).GetMethod("Run",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(manager,new object[]{(Func<Task>)(()=>completion.Task)})!;
                Pump();
                var close=Descendants(manager).OfType<Button>().Single(button=>button.Text=="Закрыть");
                Check(close.Enabled,"A pending console operation must leave Close enabled.");
                close.PerformClick();Pump();
                Check(!manager.Visible,"Console modal must close while observing an accepted operation.");
                Check(Field<CancellationTokenSource>(manager,"lifetime").IsCancellationRequested,"Closing must stop polling.");
                completion.SetResult();Pump();running.GetAwaiter().GetResult();
                lines.Add("PASS: pending operation leaves Close available and closes without replaying a command.");
            }
            ConsoleSetupFlowTests.Run(testFolder,form,Pump);
            lines.Add("PASS: Install connects without a code and continues once; installed app is not resent.");
            var waiting=new TaskCompletionSource();
            var pending=(Task)typeof(MainForm).GetMethod("Act",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(form,new object?[]{(Func<Task>)(()=>waiting.Task),"Browser fixture"})!;
            var ticks=0;using(var timer=new System.Windows.Forms.Timer{Interval=10}) {
                timer.Tick+=(_,_)=>ticks++;timer.Start();Pump();
                var nav=Field<FlowLayoutPanel>(form,"navigation");nav.Controls.OfType<Button>().First().PerformClick();Pump();
                Check(ticks>0&&nav.Enabled&&!form.UseWaitCursor,"Waiting for a browser must preserve the message loop and navigation without a global wait cursor.");
            }
            waiting.SetResult();Pump();pending.GetAwaiter().GetResult();
            lines.Add("PASS: browser wait keeps window messages and navigation responsive.");
            var trackerUser = Field<TextBox>(form, "trackerUser");
            var password = Field<TextBox>(form, "trackerPassword");
            Check(trackerUser.Text == "fixture-user" && password.Text == "fixture-password" && password.UseSystemPasswordChar, "Saved tracker fields must load masked.");
            trackerUser.Text = "edited-user"; password.Text = "edited-password";
            for (var i = 0; i < 4; i++) {
                Select(Field<DarkChoice>(form, "language"), i % 2);
                Check(Field<TextBox>(form, "trackerUser").Text == "edited-user", "Language rebuild lost username.");
                Check(Field<TextBox>(form, "trackerPassword").Text == "edited-password", "Language rebuild lost password.");
            }
            lines.Add("PASS: language menu rebuild preserves entered tracker fields.");
            Select(Field<DarkChoice>(form, "language"), 0);
            var tabs = Field<PageHost>(form, "tabs"); tabs.SelectedIndex = 2; Pump();
            password = Field<TextBox>(form, "trackerPassword");
            var reveal = password.Parent!.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<CheckBox>()).Single();
            reveal.Checked = true; Check(!password.UseSystemPasswordChar, "Show password did not reveal input.");
            reveal.Checked = false; Check(password.UseSystemPasswordChar, "Show password did not remask input.");
            lines.Add("PASS: password reveal/remask.");
            var clippedText = new List<string>();
            foreach (var size in new[] { new Size(964, 721), new Size(964, 820), new Size(1280, 760), new Size(1880, 940) }) {
                form.ClientSize = size; tabs.SelectedIndex = 0; Pump();
                var page = tabs.TabPages[0];
                var flow = page.Controls.OfType<CardFlow>().Single();
                Check(flow.Controls.Cast<Control>().Where(c => c.Visible).All(c => c.Right <= flow.ClientSize.Width), "Home cards must fit horizontally at " + size);
                foreach (Control eachPage in tabs.TabPages) {
                    tabs.SelectedIndex = tabs.TabPages.IndexOf(eachPage); Pump();
                    foreach (var label in Descendants(eachPage).OfType<Label>().Where(l => l.Visible && l.Text.Length > 0)) {
                        var needed = label.GetPreferredSize(new Size(label.ClientSize.Width, 0));
                        if(needed.Height > label.ClientSize.Height)clippedText.Add(label.Text + " at " + size + " needs " + needed.Height + " has " + label.ClientSize.Height);
                    }
                    var footer = eachPage.Controls.OfType<TableLayoutPanel>().Single(p => p.Dock == DockStyle.Bottom);
                    var buttons = footer.Controls.OfType<Button>().ToArray();
                    Check(buttons.All(b => b.Bottom <= footer.ClientSize.Height && b.Right <= footer.ClientSize.Width && b.Width >= 100), "Action buttons must wrap into readable rows inside the footer.");
                }
                foreach (var card in Field<Dictionary<string, StatusCard>>(form, "healthCards").Values) {
                    Check(card.Left >= 0 && card.Right <= card.Parent!.ClientSize.Width && card.Bottom <= card.Parent.ClientSize.Height, "Status cards must fit after shrinking the window.");
                }
                lines.Add("PASS: cards fit and actions wrap inside the footer at " + size.Width + "x" + size.Height + ".");
            }
            Check(clippedText.Count==0,"Clipped text: "+string.Join("; ",clippedText));
            var cards = Field<Dictionary<string, StatusCard>>(form, "healthCards");
            Check(cards.Values.All(c => c.Controls.Cast<Control>().All(label => label.Top >= 0 && label.Bottom <= c.ClientSize.Height)), "Status card text must fit inside the card.");
            Check(cards.Keys.SequenceEqual(new[] { "WEB", "qBittorrent", "Prowlarr", "FlareSolverr" }), "Multi-console status belongs in the Consoles table.");
            Check(Field<TextBox>(form, "torrentFolder").Text==testFolder, "qBittorrent download-path mapping field missing.");
            Check(Descendants(form).OfType<LogoButton>().Count() == 2, "Both header links need logos.");
            var actions = tabs.TabPages[0].Controls.OfType<TableLayoutPanel>().Single(p => p.Dock == DockStyle.Bottom);
            Check(actions.Controls.OfType<Button>().Any(b => b.Text == "Применить"), "Settings need an Apply button.");
            lines.Add("PASS: multi-console header, logos, Apply button and qBittorrent path mapping.");
            form.ClientSize = new Size(1100, 780); form.Location = new Point(25, 25); Pump();
            foreach (var pageIndex in new[] { 0, 1, 2 }) {
                tabs.SelectedIndex = pageIndex; Pump();
                for (var i = 0; i < 12; i++) { form.Location = new Point(25 + i % 3 * 30, 25 + i % 2 * 18); Pump(); }
                form.Location = new Point(25, 25); Pump();
                using var moved = new Bitmap(form.ClientSize.Width, form.ClientSize.Height);
                form.DrawToBitmap(moved, new Rectangle(Point.Empty,form.ClientSize));
                form.Invalidate(true); form.Update(); Pump();
                using var repainted = new Bitmap(moved.Width, moved.Height);
                form.DrawToBitmap(repainted, new Rectangle(Point.Empty,form.ClientSize));
                var different = 0;
                for (var y = 0; y < moved.Height; y += 3) for (var x = 0; x < moved.Width; x += 3) if (moved.GetPixel(x, y) != repainted.GetPixel(x, y)) different++;
                Check(different < 30, "Window movement left stale pixels on page " + pageIndex + ": " + different);
            }
            lines.Add("PASS: moved windows match a full repaint on Installation, PS4 and Search.");
            settings.Save(Path.Combine(testFolder, "settings.json"));
            var stored = LauncherSettings.Load(Path.Combine(testFolder, "settings.json"));
            Check(!File.ReadAllText(Path.Combine(testFolder, "settings.json")).Contains("fixture-password") && LocalSecrets.Read(stored.ProtectedTrackerPassword) == "fixture-password", "Saved password must use Windows account protection.");
            lines.Add("PASS: saved password survives restart with Windows protection.");
            form.ClientSize = new Size(1440, 900); form.Location = new Point(20,20); Pump();
            for (int i=0; i<tabs.TabPages.Count; i++) {
                tabs.SelectedIndex=i; Pump(); GlassWizardTests.Save(form, Path.ChangeExtension(report,$"section-{i}.png"));
            }
            tabs.SelectedIndex = 0; form.ClientSize = new Size(1280, 720); Pump();
            using var bitmap = new Bitmap(form.Width, form.Height); form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
            bitmap.Save(Path.ChangeExtension(report, ".png"));
            File.WriteAllLines(report, lines); return 0;
        } catch (Exception error) { lines.Add("FAIL: " + error); File.WriteAllLines(report, lines); return 1; }
        finally { Directory.Delete(testFolder, true); }
    }
}
