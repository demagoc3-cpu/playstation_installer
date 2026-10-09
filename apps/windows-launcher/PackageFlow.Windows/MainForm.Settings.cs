using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private async Task ApplyInstallation()
    {
        if (games.Text.Length == 0) games.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "PackageFlow");
        Directory.CreateDirectory(games.Text);
        if (!int.TryParse(port.Text, out var webPort) || !int.TryParse(payloadPort.Text, out var callbackPort)) throw new ArgumentException(T("Укажите номера портов.", "Enter port numbers."));
        var candidate = JsonSerializerClone(settings);
        candidate.Mode = mode.SelectedIndex == 1 ? "compose" : "native";
        candidate.GamesDirectory = Path.GetFullPath(games.Text);
        candidate.HostIp = lan.SelectedItem?.ToString() ?? "";
        candidate.Port = webPort; candidate.PayloadPort = callbackPort;
        candidate.AutoStart = autoStart.Checked;
        candidate.FlareSolverrVisibleBrowser = visibleFlare.Checked;
        if (candidate.Mode == "compose") candidate.ManagedProwlarr = composeProwlarr.Checked;
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
            Report(T("Обновляем адрес WEB на сопряжённой PS4…", "Updating the paired PS4 WEB address…"));
            try {
                var address = await host.Api("/api/desktop/rebind", new { ip = settings.PsIp }, lifetime.Token);
                if (address["updated"]?.GetValue<bool>() == true || address["configured"]?.GetValue<bool>() == false) { settings.PendingWebAddress = false; settings.Save(ServerHost.SettingsPath); }
                if (address["updated"]?.GetValue<bool>() != true && address["configured"]?.GetValue<bool>() == true)
                    addressWarning = T("Адрес WEB на PS4 не обновлён: проверьте подключение и повторно примените настройки.", "PS4 WEB address was not updated: check the connection and apply settings again.");
            } catch { addressWarning = T("Не удалось обновить адрес WEB на PS4. Проверьте подключение и повторите сопряжение.", "Could not update the PS4 WEB address. Check the connection and pair again."); }
        }
        Report(T("Настройки применены. Добавьте папки и сетевые подключения в WEB → Хранилище.", "Settings applied. Add folders and network connections in WEB → Storage."));
        applicationSummary = T("Настройки применены • Хранилище в WEB", "Settings applied • Storage in WEB") + (addressWarning == null ? "" : " • " + addressWarning);
        if (addressWarning != null) Report(addressWarning);
    }
    private string? applicationSummary;
}
