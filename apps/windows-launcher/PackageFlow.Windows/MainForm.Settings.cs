using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private async Task ApplyInstallation()
    {
        host.EnsureDataMigrationReady();
        if (games.Text.Length == 0) games.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "PackageFlow");
        Directory.CreateDirectory(games.Text);
        if (!int.TryParse(port.Text, out var webPort) || !int.TryParse(payloadPort.Text, out var callbackPort)) throw new ArgumentException(T("Укажите номера портов.", "Enter port numbers."));
        var candidate = JsonSerializerClone(settings);
        candidate.GamesDirectory = Path.GetFullPath(games.Text);
        candidate.HostIp = lan.SelectedItem?.ToString() ?? "";
        candidate.Port = webPort; candidate.PayloadPort = callbackPort;
        candidate.AutoStart = autoStart.Checked;
        candidate.FlareSolverrVisibleBrowser = visibleFlare.Checked;
        candidate.PendingWebAddress = settings.PendingWebAddress || candidate.HostIp != settings.HostIp || candidate.Port != settings.Port;
        candidate.Validate();
        var restart = settings.RequiresRestart(candidate);
        if (host.Started && restart) {
            Report(T("Применяем настройки: ожидаем безопасную остановку WEB…", "Applying settings: waiting for a safe WEB stop…"));
            await host.Stop(lifetime.Token);
        }
        // Stop uses the old settings and refuses to interrupt active jobs. Invalid
        // or blocked changes have not been written when that check fails.
        var previous = JsonSerializerClone(settings);
        try { Restore(candidate); SetAutoStart(settings.AutoStart); settings.Save(ServerHost.SettingsPath); }
        catch { Restore(previous); throw; }
        games.Text = settings.GamesDirectory;
        if (torrentFolder.Text == previous.GamesDirectory) torrentFolder.Text = settings.GamesDirectory;
        if (!host.Started) await host.Start(lifetime.Token);
        string? addressWarning = null;
        if (settings.PendingWebAddress) {
            Report(T("Обновляем адрес WEB на сопряжённых приставках…", "Updating the paired consoles' WEB address…"));
            try {
                var address = await host.Api("/api/desktop/rebind", new { all = true }, lifetime.Token);
                if (address["updated"]?.GetValue<bool>() == true || address["configured"]?.GetValue<bool>() == false) { settings.PendingWebAddress = false; settings.Save(ServerHost.SettingsPath); }
                if (address["updated"]?.GetValue<bool>() != true && address["configured"]?.GetValue<bool>() == true)
                    addressWarning = T("Адрес WEB обновлён не на всех приставках. Проверьте подключение и повторно примените настройки.", "WEB address was not updated on all consoles. Check connections and apply settings again.");
            } catch { addressWarning = T("Не удалось обновить адрес WEB на приставках. Проверьте подключение и повторите сопряжение.", "Could not update console WEB addresses. Check connections and pair again."); }
        }
        Report(T("Настройки применены. Добавьте папки и сетевые подключения в WEB → Хранилище.", "Settings applied. Add folders and network connections in WEB → Storage."));
        applicationSummary = T("Настройки применены • Хранилище в WEB", "Settings applied • Storage in WEB") + (addressWarning == null ? "" : " • " + addressWarning);
        if (addressWarning != null) Report(addressWarning);
    }
    private string? applicationSummary;
}
