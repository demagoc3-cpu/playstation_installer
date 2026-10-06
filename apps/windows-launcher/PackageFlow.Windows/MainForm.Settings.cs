using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private async Task ApplyInstallation()
    {
        if (!Directory.Exists(games.Text)) throw new DirectoryNotFoundException(T("Выберите существующую папку с играми.", "Choose an existing games folder."));
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
        Report(T("Настройки применены. Индексируем выбранную папку с PKG…", "Settings applied. Indexing the selected PKG folder…"));
        var result = await host.Api("/api/packages/scan", new { directory = settings.Mode == "compose" ? "/games" : settings.GamesDirectory, psIp = psIp.Text.Trim().Length > 0 ? psIp.Text.Trim() : settings.PsIp }, lifetime.Token);
        var count = result["packages"]?.AsArray().Count ?? 0;
        Report(T($"Индексация завершена: {count} пак. Настройки применены.", $"Indexing complete: {count} packages. Settings applied."));
        // Show the summary after Act's generic completion message as well.
        applicationSummary = T($"Применено • найдено PKG: {count}", $"Applied • PKG found: {count}") + (addressWarning == null ? "" : " • " + addressWarning);
        if (addressWarning != null) Report(addressWarning);
    }
    private string? applicationSummary;
}
