using System.Net.Http.Json;
using System.Text.Json.Nodes;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private readonly System.Windows.Forms.Timer healthTimer = new() { Interval = 15000 };
    private readonly EventHistory events = new() { Dock = DockStyle.Fill, BackColor = Theme.Background, ForeColor = Theme.Muted };
    private readonly ActivityProgress progress = new() { Dock = DockStyle.Top };
    private readonly Dictionary<string, StatusCard> healthCards = [];
    private bool probing;
    private Task healthWork = Task.CompletedTask;
    private bool healthTimerWired, restoredTracker, restoredTorrent, restoredPs;

    private Control BuildHealthStrip()
    {
        healthCards.Clear();
        var strip = new BufferedPanel { Dock = DockStyle.Top, Height = 100, Padding = new Padding(14, 0, 14, 10), BackColor = BackColor };
        foreach (var name in new[] { "WEB", "qBittorrent", "Prowlarr", "FlareSolverr" })
        {
            var card = new StatusCard(name == "Pairing" ? T("Сопряжение", "Pairing") : name);
            card.Set(T("Проверяем…", "Checking…"), T("Проверка подключения", "Connection check"), Theme.Muted);
            healthCards.Add(name, card); strip.Controls.Add(card);
        }
        void FitCards() {
            var usable = strip.ClientSize.Width - strip.Padding.Horizontal;
            var gap = 8; var count = strip.Controls.Count;
            for (var i = 0; i < count; i++) {
                var left = strip.Padding.Left + usable * i / count;
                var right = strip.Padding.Left + usable * (i + 1) / count;
                strip.Controls[i].Bounds = new Rectangle(left + gap / 2, strip.Padding.Top, Math.Max(1, right - left - gap), strip.ClientSize.Height - strip.Padding.Vertical);
            }
        }
        strip.SizeChanged += (_, _) => FitCards(); FitCards();
        if (!healthTimerWired) { healthTimer.Tick += async (_, _) => { if (!busy) { await RefreshHealth(background:true); _ = RefreshGithub(); } }; healthTimerWired = true; }
        return strip;
    }

    private Control BuildActivity()
    {
        var activity = new BufferedPanel { Dock = DockStyle.Bottom, Height = 78, Padding = new Padding(20, 6, 20, 8), BackColor = BackColor };
        status.Dock = DockStyle.Top; status.Height = 31; status.Padding = new Padding(0, 5, 0, 3);
        activity.Controls.Add(events); activity.Controls.Add(status); activity.Controls.Add(progress);
        return activity;
    }

    private void Report(string message)
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(() => Report(message)); return; }
        status.Text = message;
        events.Items.Insert(0, $"{DateTime.Now:HH:mm:ss}  {message}");
        while (events.Items.Count > 80) events.Items.RemoveAt(events.Items.Count - 1);
        events.ResetView(); PushDesktopState();
    }
    private IProgress<int> DownloadProgress(string name)
    {
        var last = -1;
        return new Progress<int>(percent => {
            if (IsDisposed) return;
            progress.Value = percent; progress.Invalidate();
            status.Text = T($"Загружаем {name}: {percent}%", $"Downloading {name}: {percent}%");
            if (percent / 10 != last) { last = percent / 10; Report(status.Text); }
        });
    }

    private void Component(string name, string state, string note, bool? ready)
    {
        desktopComponents[name] = new { state, note, ready }; PushDesktopState();
        if (!healthCards.TryGetValue(name, out var card)) return;
        card.Set(state, note, ready == true ? Theme.Green : ready == false ? Color.FromArgb(250, 133, 156) : Theme.Muted);
        if(searchComponentStates.TryGetValue(name,out var mirror)){mirror.Text="●  "+state;mirror.ForeColor=ready==true?Theme.Green:Theme.Muted;}
    }

    private async Task RestoreTracker(ProwlarrClient client, int id, CancellationToken ct)
    {
        var saved = await client.RuTrackerCredentials(id, ct);
        if (trackerUser.Text.Length == 0) trackerUser.Text = saved.Username;
        if (trackerPassword.Text.Length == 0 && trackerUser.Text == saved.Username) {
            if (saved.Password.Length > 0) {
                trackerPassword.Text = saved.Password;
                settings.TrackerUsername = saved.Username;
                settings.ProtectedTrackerPassword = LocalSecrets.Protect(saved.Password);
                if (!preview) settings.Save(ServerHost.SettingsPath);
            } else if (saved.PasswordSaved) trackerPassword.PlaceholderText = T("Сохранён в Prowlarr", "Saved in Prowlarr");
        }
    }

    private async Task RefreshHealth(bool background = false)
    {
        if (probing || IsDisposed || lifetime.IsCancellationRequested || settings.LegacyMigrationRequired) return;
        probing = true;
        var running = T("Работает", "Running"); var offline = T("Недоступен", "Unavailable"); var absent = T("Не настроен", "Not configured");
        async Task Web()
        {
            try {
                using var ct = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); ct.CancelAfter(TimeSpan.FromSeconds(4));
                var ready = await host.Adopt(ct.Token);
                Component("WEB", ready ? running : T("Остановлен", "Stopped"), host.WebUrl, ready);
            } catch { Component("WEB", offline, host.WebUrl, false); }
        }
        async Task Torrent()
        {
            try {
                using var ct = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); ct.CancelAfter(TimeSpan.FromSeconds(5));
                var info = await host.Api("/api/torrents/settings", ct: ct.Token);
                var configured = info["configured"]?.GetValue<bool>() == true; var ready = info["ready"]?.GetValue<bool>() == true;
                if (!restoredTorrent && configured) {
                    if (torrentAddress.Text == "http://127.0.0.1:8080") torrentAddress.Text = info["baseUrl"]?.GetValue<string>() ?? torrentAddress.Text;
                    if (torrentUser.Text.Length == 0) torrentUser.Text = info["username"]?.GetValue<string>() ?? "";
                    if (torrentFolder.Text == settings.GamesDirectory) torrentFolder.Text = info["remotePath"]?.GetValue<string>() is { Length: > 0 } remote ? remote : info["downloadPath"]?.GetValue<string>() ?? torrentFolder.Text;
                    if (info["hasPassword"]?.GetValue<bool>() == true) torrentPassword.PlaceholderText = T("Сохранён в WEB", "Saved in WEB");
                    restoredTorrent = true;
                }
                Component("qBittorrent", !configured ? absent : ready ? T("Подключён", "Connected") : offline,
                    ready ? info["version"]?.GetValue<string>() ?? "Web UI" : configured ? T("Проверьте Web UI и доступ", "Check Web UI and access") : T("Настройте в «Поиске»", "Set up in Search"), configured ? ready : null);
            } catch { Component("qBittorrent", T("Не проверен", "Not checked"), T("Нужен запущенный WEB", "WEB must be running"), null); }
        }
        async Task Prowlarr()
        {
            if (settings.ProtectedProwlarrKey.Length == 0) { Component("Prowlarr", absent, T("Настройте в «Поиске»", "Set up in Search"), null); return; }
            try {
                using var ct = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); ct.CancelAfter(TimeSpan.FromSeconds(4));
                var list = await new ProwlarrClient(http, settings.ProwlarrUrl, LocalSecrets.Read(settings.ProtectedProwlarrKey)).Indexers(ct.Token);
                Component("Prowlarr", T("Подключён", "Connected"), T($"Индексаторы: {list.Count}", $"Indexers: {list.Count}"), true);
                if (!restoredTracker && !busy) {
                    if (indexers.Items.Count == 0) {
                        foreach (var item in list) indexers.Items.Add(new Indexer(item.Id, item.Name));
                        if (indexers.Items.Count > 0) indexers.SelectedIndex = 0;
                    }
                    var tracker = list.FirstOrDefault(i => i.Name.Contains("rutracker", StringComparison.OrdinalIgnoreCase));
                    if (tracker.Id > 0) await RestoreTracker(new ProwlarrClient(http, settings.ProwlarrUrl, LocalSecrets.Read(settings.ProtectedProwlarrKey)), tracker.Id, ct.Token);
                    restoredTracker = true;
                }
            } catch { Component("Prowlarr", offline, T("Проверьте адрес и API-ключ", "Check address and API key"), false); }
        }
        async Task Consoles()
        {
            await RefreshSavedConsoles(true, background:background);
            if (!restoredPs && settings.PsIp.Length > 0) { psIp.Text = settings.PsIp; restoredPs = true; }
        }
        async Task Flare()
        {
            try {
                using var ct = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); ct.CancelAfter(TimeSpan.FromSeconds(4));
                var info = await http.GetFromJsonAsync<JsonNode>("http://127.0.0.1:8191/", ct.Token);
                var ready = info?["msg"]?.GetValue<string>() == "FlareSolverr is ready!";
                Component("FlareSolverr", ready ? running : offline, ready ? "API • 127.0.0.1:8191" : T("API не готов", "API not ready"), ready);
            } catch { Component("FlareSolverr", settings.FlareSolverr ? offline : absent, "127.0.0.1:8191", settings.FlareSolverr ? false : null); }
        }
        try { healthWork = Task.WhenAll(Web(), Consoles(), Torrent(), Prowlarr(), Flare()); await healthWork; }
        finally { probing = false; }
    }
}
