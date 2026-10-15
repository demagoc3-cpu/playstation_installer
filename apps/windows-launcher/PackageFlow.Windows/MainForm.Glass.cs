using System.Net.Http.Json;
using System.Text.Json;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private static int? ActionIcon(string label) => label.Contains("обнов", StringComparison.OrdinalIgnoreCase) || label.Contains("update", StringComparison.OrdinalIgnoreCase) ? 3
        : label.Contains("Найти") || label.Contains("Find") || label.Contains("Проверить") || label.Contains("Check") ? 2
        : label.Contains("Остановить") || label.Contains("Stop") ? 8
        : label.Contains("Установить") || label.Contains("Install") || label.Contains("Скачать") || label.Contains("Download") ? 5
        : label.Contains("Применить") || label.Contains("Apply") || label.Contains("Завершить") || label.Contains("Finish") ? 7 : null;
    private void HomeHero(FlowLayoutPanel page)
    {
        var card=new RoundedPanel {Tag="full",Height=174,Padding=new Padding(18),Margin=new Padding(0,0,0,10)};
        var hero=new BufferedTable {Dock=DockStyle.Fill,ColumnCount=1,RowCount=3};hero.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
        hero.RowStyles.Add(new RowStyle(SizeType.Absolute,40));hero.RowStyles.Add(new RowStyle(SizeType.Percent,100));hero.RowStyles.Add(new RowStyle(SizeType.Absolute,50));
        hero.Controls.Add(new Label {Text=T("Всё готово к работе","Ready when you are"),Font=new Font("Segoe UI",20,FontStyle.Bold),Dock=DockStyle.Fill},0,0);
        hero.Controls.Add(new Label {Text=T("Библиотека, пресеты и очереди PS4 / PS5 в одном месте","Library, presets and PS4 / PS5 queues in one place"),Dock=DockStyle.Fill,ForeColor=Theme.Muted},0,1);
        var open = new RoundedButton { Text = T("Открыть PackageFlow", "Open PackageFlow"), Glyph = 13, Dock = DockStyle.Fill, BackColor = Theme.Accent, ForeColor = Color.White, Font=new Font("Segoe UI",12,FontStyle.Bold) };
        open.Click += async (_, _) => await Act(async () => { if (!host.Started) await ApplyInstallation(); OpenWeb(); });
        hero.Controls.Add(open,0,2);card.Controls.Add(hero);page.Controls.Add(card);
        var row = new BufferedTable { Tag="full", Height=160, ColumnCount=2, RowCount=1, Margin=new Padding(0,0,0,12) };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));row.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        foreach(var platform in new[]{"PS5","PS4"}) {
            var tile=new RoundedPanel {Dock=DockStyle.Fill,Padding=new Padding(16),Margin=new Padding(0,0,10,0),Cursor=Cursors.Hand};
            var title=new Label {Text=platform,Font=new Font("Segoe UI",18,FontStyle.Bold),Dock=DockStyle.Top,Height=38};
            var state=new Label {Text=T("Не проверены","Not checked"),ForeColor=Theme.Muted,Dock=DockStyle.Top,Height=44};homeConsoleStates[platform]=state;
            var openConsoles=new RoundedButton {Text=T("Открыть","Open"),AccessibleName=T("Открыть приставки ","Open consoles ")+platform,Glyph=1,Dock=DockStyle.Bottom,Height=40,BackColor=Theme.Card,ForeColor=Color.White};
            openConsoles.Click+=(_,_)=>tabs.SelectedIndex=1;
            var consoleLayout=new BufferedTable {Dock=DockStyle.Fill,ColumnCount=2,RowCount=3};consoleLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,125));consoleLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
            consoleLayout.RowStyles.Add(new RowStyle(SizeType.Absolute,38));consoleLayout.RowStyles.Add(new RowStyle(SizeType.Percent,100));consoleLayout.RowStyles.Add(new RowStyle(SizeType.Absolute,40));
            var picture=new SetupArtwork(platform=="PS5"?15:16) {Dock=DockStyle.Fill};consoleLayout.Controls.Add(picture,0,0);consoleLayout.SetRowSpan(picture,3);
            title.Dock=state.Dock=openConsoles.Dock=DockStyle.Fill;consoleLayout.Controls.Add(title,1,0);consoleLayout.Controls.Add(state,1,1);consoleLayout.Controls.Add(openConsoles,1,2);
            tile.Controls.Add(consoleLayout);row.Controls.Add(tile,platform=="PS5"?0:1,0);
        }
        page.Controls.Add(row);
    }
    private readonly Dictionary<string,Label> homeConsoleStates = [];
    private void RefreshHomeConsoles(System.Text.Json.Nodes.JsonNode list) {
        var consoles=list["consoles"]!.AsArray();
        foreach(var (platform,label) in homeConsoleStates){
            var profiles=consoles.Where(p=>p?["platform"]?.GetValue<string>()==platform.ToLowerInvariant()).ToArray();
            var online=profiles.Count(p=>p?["online"]?.GetValue<bool>()==true);
            label.Text=profiles.Length==0?T("Добавьте через «Приставки»","Add in Consoles"):T($"В сети: {online} из {profiles.Length}",$"Online: {online} of {profiles.Length}");label.ForeColor=online>0?Theme.Green:Theme.Muted;
        }
    }
    private readonly Dictionary<string,Label> searchComponentStates = [];
    private void ArrangeSearchCards(FlowLayoutPanel page)
    {
        searchComponentStates.Clear();
        var technical = new Control[] { prowlarrUrl.Parent!, prowlarrKey.Parent!, installFlare.Parent!, indexers.Parent!, torrentAddress.Parent!, torrentUser.Parent!, torrentPassword.Parent!, torrentFolder.Parent! };
        foreach(var card in technical) card.Visible=false;
        var footer=((PageLayout)page.Tag!).Footer;
        var tracker=FieldCard(page,"RuTracker"); tracker.Tag="full"; tracker.Height=126;
        tracker.Controls.OfType<Label>().Single().Font=new Font("Segoe UI",17,FontStyle.Bold);
        var trackerInfo=new Label { Text=T("Подключите аккаунт, чтобы искать игры и обновления", "Connect your account to search games and updates"),Dock=DockStyle.Top,Height=30,ForeColor=Theme.Muted };
        tracker.Controls.Add(trackerInfo);trackerInfo.BringToFront();
        var actions=new BufferedFlow {Dock=DockStyle.Bottom,Height=52,WrapContents=false};tracker.Controls.Add(actions);actions.BringToFront();
        foreach(var text in new[]{T("Добавить RuTracker и проверить","Add and test RuTracker"),T("Войти вручную","Sign in manually")}) {
            var button=footer.Controls.OfType<Button>().Single(b=>b.Text==text);footer.Controls.Remove(button);button.Dock=DockStyle.None;button.Size=new Size(text.StartsWith("Добавить")||text.StartsWith("Add")?270:195,44); actions.Controls.Add(button);
        }
        page.Controls.SetChildIndex(tracker,0); page.Controls.SetChildIndex(trackerUser.Parent!,1); page.Controls.SetChildIndex(trackerPassword.Parent!,2);
        var row=new BufferedTable {Tag="full",Height=198,ColumnCount=3,RowCount=1,Margin=new Padding(0,10,0,12)};
        for(int i=0;i<3;i++)row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100f/3));row.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        var advancedActions = new RoundedPanel {Tag="full",Height=148,Visible=false,Padding=new Padding(12),Margin=new Padding(0,8,0,12)};
        var advancedFlow=new BufferedFlow {Dock=DockStyle.Fill,WrapContents=true};advancedActions.Controls.Add(advancedFlow);
        foreach(var text in new[]{T("Подключить существующий","Connect existing"),T("Открыть Prowlarr","Open Prowlarr"),T("Применить к WEB","Apply to WEB"),T("Настроить позже","Set up later")}) {
            var button=footer.Controls.OfType<Button>().Single(b=>b.Text==text);footer.Controls.Remove(button);button.Dock=DockStyle.None;button.Size=new Size(210,44);advancedFlow.Controls.Add(button);
        }
        page.Controls.Add(advancedActions);
        var names=new[]{"qBittorrent","Prowlarr","FlareSolverr"};
        for(int i=0;i<3;i++) {
            var name=names[i];var tile=new RoundedPanel {Dock=DockStyle.Fill,Padding=new Padding(16),Margin=new Padding(0,0,10,0)};
            var title=new Label {Text=name,Dock=DockStyle.Top,Height=29,Font=new Font("Segoe UI",12,FontStyle.Bold)};
            var state=new Label {Text=T("Не проверен","Not checked"),Dock=DockStyle.Top,Height=26,ForeColor=Theme.Muted};searchComponentStates[name]=state;
            var configure=new RoundedButton {Text=T("Настроить","Configure"),Glyph=6,Dock=DockStyle.Bottom,Height=38,ForeColor=Color.White,BackColor=Theme.Card};
            var expanded=false;
            configure.Click+=(_,_)=>{
                expanded=!expanded;
                var fields=name=="qBittorrent"?new Control[]{torrentAddress.Parent!,torrentUser.Parent!,torrentPassword.Parent!,torrentFolder.Parent!}:name=="Prowlarr"?new Control[]{prowlarrUrl.Parent!,prowlarrKey.Parent!,indexers.Parent!}:new Control[]{installFlare.Parent!};
                foreach(var card in fields)card.Visible=expanded;
                if(name=="Prowlarr")advancedActions.Visible=expanded;
                configure.Text=expanded?T("Скрыть","Hide"):T("Настроить","Configure");
                if(expanded)page.ScrollControlIntoView(fields[0]);
            };
            var operationText=name=="qBittorrent"?T("Подключить qBittorrent","Connect qBittorrent"):name=="Prowlarr"?T("Установить Prowlarr","Install Prowlarr"):"FlareSolverr";
            var operation=footer.Controls.OfType<Button>().Single(b=>b.Text==operationText);footer.Controls.Remove(operation);operation.Dock=DockStyle.Bottom;operation.Height=40;operation.Margin=new Padding(0,6,0,0);operation.Text=name=="qBittorrent"?T("Подключить","Connect"):T("Установить","Install");
            tile.Controls.Add(state);tile.Controls.Add(title);tile.Controls.Add(operation);tile.Controls.Add(configure);row.Controls.Add(tile,i,0);
        }
        page.Controls.Add(row);page.Controls.SetChildIndex(row,3);
        // Keep every existing operation, with the less common operations folded
        // behind the same component cards instead of a wall of buttons.
        var remaining=footer.Controls.OfType<Button>().ToArray();footer.Controls.Clear();footer.RowStyles.Clear();footer.RowCount=0;
        foreach(var button in remaining){var slot=footer.Controls.Count;var r=slot/4;if(footer.RowStyles.Count<=r)footer.RowStyles.Add(new RowStyle(SizeType.Absolute,48));footer.RowCount=r+1;footer.Controls.Add(button,slot%4,r);}
        footer.Height=footer.RowCount*48+16;
    }
    private async Task RunFirstLaunchWizard()
    {
        if (desktopReady) { SendDesktop(new { type="wizard" }); return; }
        using var wizard = new FirstLaunchWizard(settings, async () => {
            settings.AutomaticSetupPending = true;
            await ApplyInstallation();
            using var select = new ConsoleManagerForm(host, settings, InstallPs4ConsoleService, selectionOnly: true);
            return select.ShowDialog(this) == DialogResult.OK ? select.SelectedConsoleIds : [];
        });
        if (wizard.ShowDialog(this) != DialogResult.OK) return;
        settings.TorrentSetupSelected = wizard.TorrentSelected;
        if(wizard.TorrentSelected && wizard.ManualLoginRequested) { settings.FlareSolverrVisibleBrowser=true;visibleFlare.Checked=true; }
        settings.FirstSetupConsoleIds = wizard.ConsoleIds.ToList();
        settings.TrackerUsername = wizard.TrackerUsername;
        settings.ProtectedTrackerPassword = LocalSecrets.Protect(wizard.TrackerPassword);
        trackerUser.Text = settings.TrackerUsername; trackerPassword.Text = wizard.TrackerPassword;
        settings.WizardComplete = true; settings.AutomaticSetupPending = true;
        settings.Save(ServerHost.SettingsPath);
        async Task Configure() {
            await PrepareFirstRun();
            if (settings.FirstSetupConsoleIds.Count > 0) {
                var coordinator = new ConsoleSetupCoordinator((path, body, ct) => host.Api(path, body, ct), InstallPs4ConsoleService, settings, () => settings.Save(ServerHost.SettingsPath));
                var results = await coordinator.Run(settings.FirstSetupConsoleIds.ToArray(), new Progress<string>(Report), lifetime.Token);
                settings.FirstSetupConsoleIds = results.Where(r => !r.Complete).Select(r => r.Id).ToList();
                settings.Save(ServerHost.SettingsPath);
                await RefreshSavedConsoles(true);
                foreach (var result in results.Where(r => !r.Complete)) Report(result.Name + ": " + result.Message);
            }
            if(settings.TorrentSetupSelected && !settings.AutomaticSetupPending && wizard.ManualLoginRequested) { await ManualTrackerLogin(); return; }
            if (settings.TorrentSetupSelected && !settings.AutomaticSetupPending && trackerUser.Text.Length > 0 && trackerPassword.Text.Length > 0) {
                try {
                    var client = Client();
                    var tag = await client.ExistingFlareSolverrTag("http://127.0.0.1:8191/", lifetime.Token);
                    var id = await client.AddRuTracker(trackerUser.Text, trackerPassword.Text, lifetime.Token, tag);
                    SaveProwlarr(); await ConnectIndexer(client, id); await LoadIndexers();
                    applicationSummary = T("Настройка завершена. RuTracker подключён.", "Setup complete. RuTracker connected.");
                } catch (Exception error) when (error is not OperationCanceledException) {
                    Report(T("RuTracker: ", "RuTracker: ") + FriendlyError(error));
                    applicationSummary = T("Компоненты готовы. Проверьте вход RuTracker в «Поиске».", "Components ready. Check RuTracker sign-in in Search.");
                }
            }
        }
        if (busy) await Configure(); else await Act(Configure, T("Настраиваем PackageFlow", "Setting up PackageFlow"));
    }
    private async Task EnableTorrentSetup()
    {
        settings.TorrentSetupSelected = true; settings.AutomaticSetupPending = true;
        settings.Save(ServerHost.SettingsPath); await DesktopResumePreparation();
    }
    private async Task StopFromTray() { if (!await ConfirmedStop()) applicationSummary = T("Остановка отменена. PackageFlow продолжает работу.", "Stop cancelled. PackageFlow is still running."); }
    private async Task<bool> ConfirmedStop(bool closing = false)
    {
        if (!host.Started) return true;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); timeout.CancelAfter(TimeSpan.FromSeconds(12));
        var activity = await host.Api("/api/desktop/status", ct: timeout.Token);
        var hashes = new List<string>(); var uncheckedTorrents = false;
        try {
            var config = await host.Api("/api/torrents/settings", ct: timeout.Token);
            if (config["configured"]?.GetValue<bool>() == true) {
                var downloads = await host.Api("/api/torrents", ct: timeout.Token);
                foreach (var task in downloads.AsArray()) {
                    var state = task?["state"]?.GetValue<string>() ?? "unknown";
                    if (task?["progress"]?.GetValue<double>() < 1 && state is not ("pausedDL" or "stoppedDL" or "error" or "missingFiles"))
                        if (task?["hash"]?.GetValue<string>() is {} hash && System.Text.RegularExpressions.Regex.IsMatch(hash, "^[a-fA-F0-9]{40}$")) hashes.Add(hash);
                }
            }
        } catch (Exception) when (!lifetime.IsCancellationRequested) { uncheckedTorrents = settings.TorrentSetupSelected; }
        if (activity["busy"]?.GetValue<bool>() != false || hashes.Count > 0 || uncheckedTorrents) {
            if (!await ConfirmInterrupt(closing)) return false;
            // The WEB endpoint lists only torrents tagged packageflow. Other
            // downloads in an existing qBittorrent client remain untouched.
            foreach (var hash in hashes) await host.Api("/api/torrents/" + hash + "/pause", new { }, lifetime.Token);
            await host.StopAfterConfirmation(lifetime.Token); return true;
        }
        try { await host.Stop(lifetime.Token); return true; }
        catch (InvalidOperationException error) when (error.Message == "Active or unverified jobs prevent stopping. Check the WEB queue and PS4 operations.") {
            // A task can begin between the first probe and draining the server.
            if (!await ConfirmInterrupt(closing)) return false;
            await host.StopAfterConfirmation(lifetime.Token); return true;
        }
    }
    private async Task<bool> ConfirmInterrupt(bool closing)
    {
        if (desktopReady) return await DesktopConfirm(T("Есть активные задания", "There are active tasks"), T("Остановка прервёт активные передачи и обработку заданий. Задание, уже принятое приставкой, может продолжиться на ней.", "Stopping interrupts active transfers and task processing. A task already accepted by a console can continue there."));
        using var dialog = new StopWarningForm(settings.Language, closing);
        return dialog.ShowDialog(this) == DialogResult.OK;
    }
    private void SupportPage()
    {
        var page = Page(T("Поддержать проект", "Support the project"), T("PackageFlow — бесплатный проект с открытым кодом. Ваша поддержка помогает развивать приложение и исправлять ошибки.", "PackageFlow is free and open source. Your support helps develop the application and fix bugs."), columns: 1);
        using var stream = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("PackageFlow.Assets.donations.json");
        var wallets = stream == null ? [] : JsonSerializer.Deserialize<List<DonationWallet>>(stream) ?? [];
        foreach (var wallet in wallets.Where(w => w.Address.Length > 0)) {
            var card = FieldCard(page, wallet.Name + " · " + wallet.Network); card.Height = 180;
            var title=card.Controls.OfType<Label>().Single();title.Font=new Font("Segoe UI",14,FontStyle.Bold);title.Height=46;title.Padding=new Padding(62,5,0,0);
            card.Paint+=(_,e)=>{using var brush=new SolidBrush(wallet.Name.StartsWith("Bitcoin")?Color.FromArgb(255,161,35):Color.FromArgb(0,172,141));e.Graphics.FillEllipse(brush,15,12,42,42);LauncherIcons.Draw(e.Graphics,wallet.Name.StartsWith("Bitcoin")?11:12,new Rectangle(23,20,26,26),Color.White);};
            var address = new TextBox { Text = wallet.Address, ReadOnly = true, BorderStyle = BorderStyle.None, Dock = DockStyle.Top, BackColor = Theme.Input, ForeColor = Color.White, Font = new Font("Consolas", 11) };
            card.Controls.Add(address); address.BringToFront();
            var actions = new BufferedFlow { Dock = DockStyle.Bottom, Height = 55 };
            var qr = new RoundedButton { Text = T("Показать QR", "Show QR"), Size = new Size(170, 44), BackColor = Theme.Card, ForeColor = Color.White };
            qr.Click += (_, _) => { using var dialog = new WalletQrForm(wallet, settings.Language); dialog.ShowDialog(this); };
            var copy = new RoundedButton { Text = T("Скопировать адрес", "Copy address"), Size = new Size(200, 44), BackColor = Theme.Accent, ForeColor = Color.White };
            copy.Click += (_, _) => { try { Clipboard.SetText(wallet.Address); Report(T("Адрес скопирован", "Address copied")); } catch { address.Focus(); address.SelectAll(); Report(T("Выделите адрес и скопируйте вручную", "Select the address and copy it manually")); } };
            actions.Controls.Add(qr); actions.Controls.Add(copy); card.Controls.Add(actions); actions.BringToFront();
        }
        Buttons(page, (T("Поддержка в WEB", "Support in WEB"), async () => { if (!host.Started) await ApplyInstallation(); ProcessRunner.Open(host.WebUrl + "/#donate"); }));
    }
}
internal sealed class StopWarningForm : Form
{
    public StopWarningForm(string language, bool closing = true)
    {
        var en = language == "en";
        Text = "PackageFlow"; BackColor = Theme.Background; ForeColor = Color.White; Font = new Font("Segoe UI", 11);
        ClientSize = new Size(650, 310); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        Icon = GlassStyle.BrandIcon();
        var card = new RoundedPanel { Dock = DockStyle.Fill, Padding = new Padding(24) };
        var layout = new BufferedTable { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute,56)); layout.RowStyles.Add(new RowStyle(SizeType.Percent,100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute,64));
        layout.Controls.Add(new Label { Text = en ? "There are active tasks" : "Есть активные задания", Dock = DockStyle.Fill, Font = new Font("Segoe UI", 22, FontStyle.Bold) },0,0);
        layout.Controls.Add(new Label { Text = en ? "Stopping PackageFlow interrupts active transfers and task processing.\n\nA task already accepted by the console can continue on the console." : "Остановка PackageFlow прервёт активные передачи и обработку заданий.\n\nЗадание, уже принятое приставкой, может продолжиться на самой приставке.", Dock = DockStyle.Fill, ForeColor = Theme.Muted },0,1);
        var footer = new BufferedFlow { Dock = DockStyle.Fill };
        var cancel = new RoundedButton { Text = en ? "Continue working" : "Продолжить работу", Size = new Size(270, 48), BackColor = Theme.Accent, ForeColor = Color.White, DialogResult = DialogResult.Cancel };
        var stop = new RoundedButton { Text = closing ? (en ? "Stop and close" : "Закрыть и остановить") : (en ? "Stop server" : "Остановить сервер"), Size = new Size(270, 48), BackColor = Color.FromArgb(116, 38, 65), ForeColor = Color.White, DialogResult = DialogResult.OK };
        footer.Controls.Add(cancel); footer.Controls.Add(stop); layout.Controls.Add(footer,0,2); card.Controls.Add(layout); Controls.Add(card);
        AcceptButton = cancel; CancelButton = cancel; GlassStyle.TransparentLabels(this);
    }
    protected override void OnPaintBackground(PaintEventArgs e) => GlassStyle.Paint(this, e);
}
internal sealed record DonationWallet(string Name, string Network, string Address, bool[][] Qr);
internal sealed class WalletQrForm : Form
{
    public WalletQrForm(DonationWallet wallet, string language)
    {
        Text = wallet.Name + " · " + wallet.Network; ClientSize = new Size(520, 455); StartPosition = FormStartPosition.CenterParent; BackColor = Theme.Background; ForeColor = Color.White; Font = new Font("Segoe UI", 11);
        var qr = new QrImage(wallet.Qr) { Dock = DockStyle.Fill, Margin = new Padding(25) }; Controls.Add(qr);
        Controls.Add(new TextBox { Text = wallet.Address, ReadOnly = true, Dock = DockStyle.Bottom, BackColor = Theme.Input, ForeColor = Color.White, BorderStyle = BorderStyle.None });
    }
}
internal sealed class QrImage(bool[][] cells) : Control
{
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(Color.White); var count = cells.Length;
        if (count == 0) return;
        var unit = Math.Max(1, Math.Min(Width, Height) / (count + 8));
        var x = (Width - count * unit) / 2; var y = (Height - count * unit) / 2;
        for (int row = 0; row < count; row++) for (int col = 0; col < cells[row].Length; col++) if (cells[row][col]) e.Graphics.FillRectangle(Brushes.Black, x + col * unit, y + row * unit, unit, unit);
    }
}

internal sealed class GlassMenuColors : ProfessionalColorTable
{
    public override Color ToolStripDropDownBackground => Theme.Card;
    public override Color MenuBorder => Theme.Border;
    public override Color MenuItemBorder => Theme.Accent;
    public override Color MenuItemSelected => Theme.Accent;
    public override Color MenuItemSelectedGradientBegin => Theme.Accent;
    public override Color MenuItemSelectedGradientEnd => Theme.Accent;
}
