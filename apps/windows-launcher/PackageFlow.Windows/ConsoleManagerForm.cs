using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json.Nodes;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed class ConsoleManagerForm : Form
{
    private readonly ServerHost host;
    private readonly LauncherSettings settings;
    private readonly string settingsPath;
    private readonly Func<string, CancellationToken, IProgress<string>, Task> installPs4;
    private readonly CancellationTokenSource lifetime = new();
    private readonly Dictionary<string, DiscoveredConsole> discovered = new();
    private readonly Dictionary<string, JsonNode> profiles = new();
    private readonly List<Button> actions = [];
    private readonly DataGridView grid = new();
    private readonly TextBox ip = new(), name = new();
    private readonly HashSet<string> checkedIps = new();
    private readonly Label details = new(), status = new();
    private readonly Button discoverButton;
    private CancellationTokenSource? searchLifetime;
    private Task searchWork = Task.CompletedTask;
    private bool busy, refreshing, disposed;
    public string[] SelectedConsoleIds { get; private set; } = [];
    public string? SelectedConsoleId { get; private set; }
    private string T(string ru, string en) => settings.Language == "en" ? en : ru;
    private string Unknown => T("Не проверено", "Not checked");
    private string Flag(bool? v) => v == true ? T("Готово", "Ready") : v == false ? T("Недоступно", "Unavailable") : Unknown;
    private string? SelectedIp => grid.SelectedRows.Count > 0 ? grid.SelectedRows[0].Tag as string : null;
    private JsonNode? SelectedProfile => SelectedIp is { } address ? profiles.GetValueOrDefault(address) : null;
    public ConsoleManagerForm(ServerHost host, LauncherSettings settings, Func<string, CancellationToken, IProgress<string>, Task> installPs4, bool preview = false, string? settingsPath = null, bool selectionOnly = false)
    {
        this.host = host; this.settings = settings; this.installPs4 = installPs4; this.settingsPath = settingsPath ?? ServerHost.SettingsPath;
        Icon = GlassStyle.BrandIcon();
        Text = T("Приставки PS4 и PS5", "PS4 and PS5 consoles"); BackColor = Theme.Background; ForeColor = Color.White;
        Font = new Font("Segoe UI", 10); AutoScaleMode = AutoScaleMode.Dpi; StartPosition = FormStartPosition.CenterParent;
        var workArea=Screen.FromPoint(Cursor.Position).WorkingArea;
        ClientSize = new Size(Math.Min(1120,workArea.Width-60),Math.Min(740,workArea.Height-60)); MinimumSize = new Size(1000, 700);
        var layout = new BufferedTable { Dock = DockStyle.Fill, Padding = new Padding(20), ColumnCount = 1, RowCount = 7 };
        foreach (var h in new[] { 38f, 0f, 74f, 58f, 40f, 108f, 62f }) layout.RowStyles.Add(h == 0 ? new RowStyle(SizeType.Percent, 100) : new RowStyle(SizeType.Absolute, h));
        Controls.Add(layout);
        layout.Controls.Add(new Label { Text = T("Приставки — выберите строку или отметьте несколько", "Consoles — select a row or check several"), Dock = DockStyle.Fill, Font = new Font("Segoe UI", 14, FontStyle.Bold) }, 0, 0);
        grid.Dock = DockStyle.Fill; grid.BackgroundColor = Theme.Background; grid.BorderStyle = BorderStyle.None;
        grid.AllowUserToAddRows = grid.AllowUserToDeleteRows = false; grid.ReadOnly = false; grid.MultiSelect = false;
        grid.RowHeadersVisible = false; grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect; grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        grid.EnableHeadersVisualStyles = false; grid.ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Theme.Card, ForeColor = Theme.Muted, Font = Font };
        grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing; grid.ColumnHeadersHeight = 34;
        grid.DefaultCellStyle = new DataGridViewCellStyle { BackColor = Theme.Card, ForeColor = Color.White, SelectionBackColor = Theme.Accent, SelectionForeColor = Color.White, Padding = new Padding(5) };
        grid.AlternatingRowsDefaultCellStyle.BackColor = Color.FromArgb(25, 24, 40); grid.GridColor = Theme.Border; grid.RowTemplate.Height = 44;
        grid.Columns.Add(new DataGridViewCheckBoxColumn { Name = "batch", HeaderText = "✓", Width = 36, MinimumWidth = 36, AutoSizeMode = DataGridViewAutoSizeColumnMode.None });
        grid.CurrentCellDirtyStateChanged += (_,_) => { if(grid.IsCurrentCellDirty)grid.CommitEdit(DataGridViewDataErrorContexts.Commit); };
        grid.CellValueChanged += (_,e) => {
            if(refreshing || e.RowIndex<0 || e.ColumnIndex!=0)return;
            var row=grid.Rows[e.RowIndex];if(row.Tag is not string address)return;
            if(row.Cells[0].Value is true)checkedIps.Add(address);else checkedIps.Remove(address);
        };
        foreach (var (key, title) in new[] { ("name", T("Приставка", "Console")), ("ip", "IP"), ("platform", "PS"), ("firmware", "FW"), ("paired", T("Сопряжение", "Pairing")), ("service", T("Служба", "Service")), ("loader", T("Загрузчик", "Loader")) }) grid.Columns.Add(key, title);
        foreach(var column in grid.Columns.Cast<DataGridViewColumn>()) {
            if(column.Name=="batch")continue; column.ReadOnly=true;
            column.MinimumWidth = column.Name == "platform" ? 50 : column.Name == "name" ? 150 : 110;
            column.FillWeight = column.Name == "name" ? 150 : column.Name == "platform" ? 50 : 110;
        }
        grid.SelectionChanged += (_, _) => { if (!refreshing) ShowSelected(); };
        layout.Controls.Add(grid, 0, 1);
        details.Dock = DockStyle.Fill; details.Padding = new Padding(0, 12, 0, 0); details.ForeColor = Theme.Muted; details.AutoEllipsis = true;
        layout.Controls.Add(details, 0, 2);
        var manual = new BufferedTable { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        manual.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        manual.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); manual.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        AddField(manual, 0, T("IP вручную", "Manual IP"), ip); AddField(manual, 1, T("Название", "Name"), name);
        layout.Controls.Add(manual, 0, 3);
        layout.Controls.Add(new Label { Text = T("PS4: GoldHEN + PyLoader. PS5: выполненный эксплойт + загрузчик ELF. Подключение выполняется автоматически; для приложения нужен ShadowMount+.", "PS4: GoldHEN + PyLoader. PS5: completed exploit + ELF loader. Connection is automatic; the application needs ShadowMount+."), Dock = DockStyle.Fill, ForeColor = Theme.Muted }, 0, 4);
        var buttons = new BufferedFlow { Dock = DockStyle.Fill, WrapContents = true };
        discoverButton = new RoundedButton { Text = T("Найти", "Find"), Size = new Size(120, 40), BackColor = Theme.Card, ForeColor = Color.White, Margin = new Padding(0, 8, 10, 0) };
        discoverButton.Click += async (_, _) => await FindOrCancel(); buttons.Controls.Add(discoverButton);
        AddButton(buttons, T("Добавить", "Add"), AddManual);
        AddButton(buttons, T("Проверить", "Check"), CheckSelected);
        if (selectionOnly) AddButton(buttons, "OK", SelectCheckedConsoles);
        else {
        AddButton(buttons, T("Установить / обновить", "Install / update"), Install);
        AddButton(buttons, T("Найти и установить", "Find and install"), FindAndInstall);
        AddButton(buttons, T("Подключить", "Connect"), Pair);
        AddButton(buttons, T("Удалить приложение", "Remove app"), RemoveApp);
        AddButton(buttons, T("Удалить устройство", "Remove device"), RemoveDevice);
        }
        var close = new RoundedButton { Text = T("Закрыть", "Close"), Size = new Size(100, 40), BackColor = Theme.Card, ForeColor = Color.White, Margin = new Padding(0, 8, 0, 0) };
        close.Click += (_, _) => Close(); buttons.Controls.Add(close);
        layout.Controls.Add(buttons, 0, 5);
        status.Dock = DockStyle.Fill; status.ForeColor = Theme.Muted; status.AutoEllipsis = true; status.Padding = new Padding(0, 8, 0, 0);
        layout.Controls.Add(status, 0, 6);
        ip.Text = settings.PsIp;
        GlassStyle.TransparentLabels(this);
        // Closing stops observation, not an already accepted console command.
        FormClosing += (_, _) => lifetime.Cancel();
        if (!preview) Shown += async (_, _) => await FindOrCancel();
        else ShowSelected();
    }
    private static void AddField(TableLayoutPanel row, int column, string caption, Control field)
    {
        var panel = new BufferedTable { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 12, 0), ColumnCount = 1, RowCount = 2 };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute,23));panel.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        panel.Controls.Add(new Label { Text = caption, Dock = DockStyle.Fill, ForeColor = Theme.Muted, Margin = Padding.Empty },0,0);
        field.Dock = DockStyle.Fill; field.BackColor = Theme.Card; field.ForeColor = Color.White;field.Margin=new Padding(0,0,0,3);
        panel.Controls.Add(field,0,1); row.Controls.Add(panel, column, 0);
    }
    private void AddButton(Control row, string caption, Func<Task> action)
    {
        var button = new RoundedButton { Text = caption, Size = new Size(Math.Max(120, TextRenderer.MeasureText(caption, Font).Width+30), 40), BackColor = Theme.Card, ForeColor = Color.White, Margin = new Padding(0, 8, 10, 0) };
        button.Click += async (_, _) => await Run(action); actions.Add(button); row.Controls.Add(button);
    }
    private async Task Run(Func<Task> action)
    {
        if (busy) return; busy = true; actions.ForEach(b => b.Enabled = false); grid.Enabled = false;
        discoverButton.Enabled = false;
        ip.Enabled = name.Enabled = false;
        try { searchLifetime?.Cancel(); await searchWork; await action(); }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception e) when (!lifetime.IsCancellationRequested) { if (!IsDisposed) status.Text = e.Message; }
        finally { busy = false; if (!IsDisposed) { discoverButton.Enabled = true; actions.ForEach(b => b.Enabled = true); grid.Enabled = true; ip.Enabled = name.Enabled = true; } }
    }
    private async Task<JsonNode> Api(string path, object? body = null, CancellationToken ct = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        try { return await host.Api(path, body, timeout.Token); }
        catch (OperationCanceledException) when (!lifetime.IsCancellationRequested && !ct.IsCancellationRequested) {
            throw new InvalidOperationException(T("Приставка или WEB не ответили вовремя. Проверьте состояние; повторная команда не отправлена.", "The console or WEB did not respond in time. Check its state; no command was repeated."));
        }
    }
    private async Task Reload(CancellationToken ct = default)
    {
        var list = await Api("/api/consoles", ct: ct);
        profiles.Clear(); foreach (var p in list["consoles"]!.AsArray()) if (p != null) profiles[p["ip"]!.GetValue<string>()] = p;
        RenderRows();
    }
    internal void RenderRows(IEnumerable<JsonNode>? fixtureProfiles = null, IEnumerable<DiscoveredConsole>? fixtureDiscovery = null)
    {
        if (fixtureProfiles != null) { profiles.Clear(); foreach (var p in fixtureProfiles) profiles[p["ip"]!.GetValue<string>()] = p; }
        if (fixtureDiscovery != null) { discovered.Clear(); foreach (var d in fixtureDiscovery) discovered[d.Ip] = d; }
        var selected = SelectedIp ?? settings.PsIp; refreshing = true; grid.Rows.Clear();
        foreach (var address in profiles.Keys.Concat(discovered.Keys).Distinct().OrderBy(x => x)) {
            var p = profiles.GetValueOrDefault(address); var d = discovered.GetValueOrDefault(address);
            var online = p?["online"]?.GetValue<bool>() == true; var stale = !online || p?["checkedAt"] == null;
            var fw = online ? p?["firmware"]?.GetValue<string>() : d?.Firmware;
            var n = grid.Rows.Add(checkedIps.Contains(address), p?["name"]?.GetValue<string>() ?? d?.Name, address, (p?["platform"]?.GetValue<string>() ?? d?.Platform)?.ToUpperInvariant(), fw ?? Unknown,
                stale ? p?["pairingConfigured"]?.GetValue<bool>() == true ? T("Ключ сохранён", "Key saved") : Unknown : p?["paired"]?.GetValue<bool>() == true ? T("Сопряжено", "Paired") : p?["pairingConfigured"]?.GetValue<bool>() == true ? T("Ключ сохранён", "Key saved") : T("Не сопряжено", "Not paired"), online || d?.Service == true ? T("Работает", "Running") : Unknown,
                d?.RestMode == true ? T("Режим покоя", "Rest mode") : d?.Loader == true ? T("Доступен", "Available") : Unknown);
            grid.Rows[n].Tag = address; if (address == selected) grid.Rows[n].Selected = true;
        }
        if (grid.Rows.Count > 0 && grid.SelectedRows.Count == 0) grid.Rows[0].Selected = true;
        refreshing = false; ShowSelected();
    }
    private void ShowSelected()
    {
        var address = SelectedIp; var p = SelectedProfile; var d = address == null ? null : discovered.GetValueOrDefault(address);
        if (address == null) { details.Text = T("Нажмите «Найти» или добавьте приставку по IP.", "Click Find or add a console by IP."); return; }
        ip.Text = address; name.Text = p?["name"]?.GetValue<string>() ?? d?.Name ?? "";
        details.Text = T("Модель: ", "Model: ") + (p?["model"]?.GetValue<string>() ?? d?.Model ?? Unknown) + "\n" +
            T("Прошивка читается автоматически. «Установить / обновить» проверит службу и приложение.\nДля нескольких приставок используйте галочки слева.", "Firmware is detected automatically. Install / update checks both service and app.\nUse the checkboxes on the left for several consoles.");
    }
    private Task FindOrCancel() => RunSearch(Discover);
    private async Task RunSearch(Func<CancellationToken, Task> action)
    {
        if (busy) return;
        if (searchLifetime != null) { searchLifetime.Cancel(); return; }
        using var search = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        searchLifetime = search; search.CancelAfter(TimeSpan.FromSeconds(40));
        discoverButton.Text = T("Остановить поиск", "Stop search");
        searchWork = Search(action, search.Token);
        try { await searchWork; }
        finally { searchLifetime = null; if (!IsDisposed) discoverButton.Text = T("Найти", "Find"); }
    }
    private async Task Search(Func<CancellationToken, Task> action, CancellationToken ct)
    {
        try { await action(ct); }
        catch (OperationCanceledException) when (!lifetime.IsCancellationRequested) { if (!IsDisposed) status.Text = T("Поиск остановлен. Найденные и сохранённые приставки остаются в списке.", "Search stopped. Discovered and saved consoles remain listed."); }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception e) { if (!IsDisposed) status.Text = e.Message; }
    }
    private async Task Discover(CancellationToken ct)
    {
        status.Text = T("Ищем PS4 и PS5 в локальной сети…", "Finding PS4 and PS5 on the local network…");
        await Reload(ct);
        var addresses = NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses).Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork).ToArray();
        var local = addresses.FirstOrDefault(a => a.Address.ToString() == settings.HostIp) ?? addresses.FirstOrDefault(a => a.Address.ToString() == ServerHost.LanAddresses().FirstOrDefault())
            ?? throw new InvalidOperationException(T("Выберите IPv4 компьютера на вкладке установки.", "Select the computer IPv4 in Installation."));
        var saved = profiles.Values.Select(p => new DiscoveredConsole(p["ip"]!.GetValue<string>(), p["name"]!.GetValue<string>(), p["platform"]!.GetValue<string>()));
        var found = await ConsoleDiscovery.Discover(local.Address.ToString(), local.IPv4Mask.ToString(), saved,
            new Progress<int>(percent => { if (!IsDisposed && !ct.IsCancellationRequested) status.Text = T($"Поиск приставок: {percent}%", $"Console discovery: {percent}%"); }), ct,
            new Progress<DiscoveredConsole>(item => { if (!IsDisposed && !ct.IsCancellationRequested) { discovered[item.Ip] = item; RenderRows(); } }));
        discovered.Clear(); foreach (var d in found) discovered[d.Ip] = d; RenderRows();
        status.Text = T($"Найдено: {found.Length}. Сохранённые приставки также показаны в списке.", $"Found: {found.Length}. Saved consoles are also listed.");
    }
    private async Task AddManual()
    {
        var value = ip.Text.Trim();
        if (!IPAddress.TryParse(value, out var address) || address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address) || address.GetAddressBytes()[0] is 0 or >= 224) throw new ArgumentException(T("Введите IPv4 приставки.", "Enter the console IPv4."));
        status.Text = T("Определяем платформу приставки…", "Detecting the console platform…");
        var detected = await ConsoleDiscovery.Detect(address.ToString(), lifetime.Token)
            ?? throw new InvalidOperationException(T("Приставка не сообщила платформу. Запустите службу или выполните поиск; один порт загрузчика её не определяет.", "The console did not identify its platform. Start the service or search; a loader port alone cannot identify it."));
        discovered[detected.Ip] = detected;
        await Api("/api/consoles", new { ip = detected.Ip, name = name.Text.Trim().Length > 0 ? name.Text.Trim() : detected.Name, platform = detected.Platform, transport = "service" }, lifetime.Token);
        settings.PsIp = address.ToString(); grid.ClearSelection(); await Reload();
        status.Text = T("Приставка добавлена. Проверьте службу или выполните первоначальную установку.", "Console added. Check the service or perform initial installation.");
    }
    private async Task<string> EnsureProfile()
    {
        if (SelectedIp == null) throw new InvalidOperationException(T("Выберите приставку из списка или добавьте её по IP.", "Select a console or add it by IP."));
        if(discovered.TryGetValue(SelectedIp,out var found) && SelectedProfile is { } existing && existing["platform"]?.GetValue<string>()!=found.Platform)
            throw new InvalidOperationException(T("Ответ устройства не совпадает с сохранённой платформой. Исправьте профиль в WEB перед установкой.","The device does not match the saved platform. Correct the WEB profile before installation."));
        if (SelectedProfile == null) {
            var d = discovered[SelectedIp]; await Api("/api/consoles", new {ip=d.Ip,name=d.Name,platform=d.Platform,transport="service"}, lifetime.Token); await Reload();
        }
        return SelectedProfile?["id"]?.GetValue<string>() ?? throw new InvalidOperationException("Console profile unavailable.");
    }
    private async Task CheckSelected()
    {
        var id = await EnsureProfile(); var p = SelectedProfile!;
        if (p["platform"]?.GetValue<string>() == "ps5") {
            var r = await Api("/api/desktop/console-setup?consoleId=" + Uri.EscapeDataString(id), ct: lifetime.Token); await Reload();
            var info = r["profile"]!;
            details.Text = "PS5 · " + info["ip"]?.GetValue<string>() + " · FW " + (info["online"]?.GetValue<bool>() == true ? info["firmware"]?.GetValue<string>() ?? Unknown : Unknown) + "\n" +
                T("Загрузчик: ", "Loader: ") + Flag(r["loader"]?.GetValue<bool>()) + " · ShadowMount+: " + Flag(r["shadowMount"]?.GetValue<bool>()) + "\n" +
                T("WebKit: не проверено · kstuff: не проверено · Формат приложения: ", "WebKit: not checked · kstuff: not checked · Application format: ") + Flag(r["installReady"]?.GetValue<bool>());
            status.Text = r["flow"]?["message"]?.GetValue<string>() ?? r["artifactMessage"]?.GetValue<string>() ?? "";
        } else { await Api("/api/consoles/probe", new {id}, lifetime.Token); await Reload(); status.Text = T("Состояние PS4 обновлено.", "PS4 status refreshed."); }
    }
    private async Task Pair()
    {
        var id = await EnsureProfile(); await Api("/api/consoles/pair", new {id}, lifetime.Token);
        await Reload(); await SaveSelection(id);
        status.Text = T("Подключение проверено. Приставка выбрана для работы.", "Connection verified. The console is selected.");
        if (settings.PendingSetupConsoleId == id) await Install();
    }
    private async Task SaveSelection(string id)
    {
        await Api("/api/consoles/active",new {id},lifetime.Token);
        var p=SelectedProfile!; settings.ConsoleId=id;settings.PsIp=p["ip"]!.GetValue<string>();settings.ConsolePlatform=p["platform"]!.GetValue<string>();settings.Save(settingsPath);
        SelectedConsoleId=id;
    }
    private async Task SelectConsole() { var id=await EnsureProfile();await SaveSelection(id);busy=false;DialogResult=DialogResult.OK;Close(); }
    private async Task SelectCheckedConsoles()
    {
        var addresses = checkedIps.Count > 0 ? checkedIps.ToArray() : SelectedIp is {} selected ? new[] { selected } : [];
        if (addresses.Length == 0) throw new InvalidOperationException(T("Выберите приставку.", "Select a console."));
        var ids = new List<string>();
        foreach (var address in addresses) {
            if (!profiles.TryGetValue(address, out var profile)) {
                var found = discovered[address];
                await Api("/api/consoles", new { ip = found.Ip, name = found.Name, platform = found.Platform, transport = "service" }, lifetime.Token);
                await Reload(); profile = profiles[address];
            }
            ids.Add(profile["id"]!.GetValue<string>());
        }
        SelectedConsoleIds = ids.ToArray(); busy = false; DialogResult = DialogResult.OK; Close();
    }
    protected override void OnPaintBackground(PaintEventArgs e) => GlassStyle.Paint(this, e, 130);
    private async Task Install()
    {
        var addresses=checkedIps.Count>0?checkedIps.ToArray():SelectedIp is {} selected?new[]{selected}:Array.Empty<string>();
        await InstallAddresses(addresses);
    }
    private async Task FindAndInstall()
    {
        await Discover(lifetime.Token);
        await InstallAddresses(discovered.Values.Where(d=>!d.RestMode).Select(d=>d.Ip).ToArray());
    }
    private async Task InstallAddresses(string[] addresses)
    {
        if(addresses.Length==0)throw new InvalidOperationException(T("Выберите приставки или выполните поиск.","Select consoles or run discovery."));
        var ids=new List<string>();
        foreach(var address in addresses) {
            if(!profiles.TryGetValue(address,out var profile)) {
                var d=discovered[address];
                await Api("/api/consoles",new {ip=d.Ip,name=d.Name,platform=d.Platform,transport="service"},lifetime.Token);
                await Reload();profile=profiles[address];
            }
            ids.Add(profile["id"]!.GetValue<string>());
        }
        var coordinator=new ConsoleSetupCoordinator((path,body,ct)=>Api(path,body,ct),installPs4,settings,()=>settings.Save(settingsPath));
        var results=await coordinator.Run(ids,new Progress<string>(message=>{if(!IsDisposed && !Disposing && !lifetime.IsCancellationRequested)status.Text=message;}),lifetime.Token);
        await Reload();
        status.Text=T($"Готово: {results.Count(r=>r.Complete)} из {results.Count}. ",$"Ready: {results.Count(r=>r.Complete)} of {results.Count}. ")+string.Join("; ",results.Where(r=>!r.Complete).Select(r=>r.Name+": "+r.Message));
    }
    private void AppInstalled(string id) { settings.SetupRemoveAppConsoleId="";settings.SetupRemoveAppRequestId="";SetupFinished(id);settings.Save(settingsPath); }
    private void SetupFinished(string id) { if(settings.PendingSetupConsoleId==id) {settings.PendingSetupConsoleId="";settings.Save(settingsPath);} }
    private async Task RemoveApp()
    {
        var id=await EnsureProfile();
        if(SelectedProfile?["platform"]?.GetValue<string>()!="ps5")throw new InvalidOperationException(T("Удаление приложения PS4 доступно в WEB → На консоли.","Remove the PS4 application in WEB → On console."));
        if(MessageBox.Show(this,T("Удалить PackageFlow с выбранной PS5 вместе с исходным образом? Закройте приложение. Нагрузка ELF и сохранения останутся.","Remove PackageFlow and its source image from the selected PS5? Close the application first. The ELF payload and saves will remain."),"PackageFlow",MessageBoxButtons.YesNo,MessageBoxIcon.Warning)!=DialogResult.Yes)return;
        if(settings.SetupRemoveAppConsoleId!=id||settings.SetupRemoveAppRequestId.Length!=32) {
            settings.SetupRemoveAppConsoleId=id;settings.SetupRemoveAppRequestId=Guid.NewGuid().ToString("N");settings.Save(settingsPath);
        }
        // An uncertain request id remains persisted; a later click observes it.
        var r=await Api("/api/desktop/console-setup",new {consoleId=id,action="remove-app",requestId=settings.SetupRemoveAppRequestId,confirmed=true},lifetime.Token);

        if(r["state"]?.GetValue<string>()!="accepted")throw new InvalidOperationException(T("Удаление не подтверждено. Проверьте состояние в WEB; повторная команда не отправлена.","Removal is not confirmed. Check WEB status; no command was repeated."));
        SetupFinished(id);status.Text=T("PS5 приняла удаление приложения и исходного образа.","PS5 accepted removal of the application and source image.");await Reload();
    }
    private async Task RemoveDevice()
    {
        var id=await EnsureProfile();
        if(MessageBox.Show(this,T("Удалить устройство «"+SelectedProfile?["name"]?.GetValue<string>()+"» ("+SelectedIp+") из этого Windows и стереть его сохранённый ключ сопряжения? Файлы на приставке останутся. Для нового подключения понадобится сопряжение.","Remove device "+SelectedProfile?["name"]?.GetValue<string>()+" ("+SelectedIp+") from this Windows and erase its saved pairing key? Console files will remain. Reconnecting will require pairing."),"PackageFlow",MessageBoxButtons.YesNo,MessageBoxIcon.Warning)!=DialogResult.Yes)return;
        var address=SelectedIp!;
        var result=await Api("/api/desktop/console-forget",new {consoleId=id,confirmed=true},lifetime.Token);
        if(settings.ConsoleId==id){settings.ConsoleId="";settings.PsIp="";SelectedConsoleId=null;}
        settings.ConsoleSetupRequests.Remove(id);checkedIps.Remove(address);
        SetupFinished(id);settings.Save(settingsPath);discovered.Remove(address);await Reload();
        status.Text=result["message"]?.GetValue<string>() ?? T("Устройство удалено из Windows.","Device removed from Windows.");
    }
    protected override void Dispose(bool disposing) { if(disposing && !disposed){disposed=true;lifetime.Cancel();lifetime.Dispose();}base.Dispose(disposing); }
}
