using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private Label consoleSetupStatus = null!;
    private async Task FindConsoles()
    {
        EnsureStarted();
        using var dialog = new ConsoleManagerForm(host, settings, InstallPs4ConsoleService);
        dialog.ShowDialog(this);
        psIp.Text = settings.PsIp;
        consoleSetupStatus.Text = settings.PsIp.Length > 0 ? settings.ConsolePlatform.ToUpperInvariant() + " · " + settings.PsIp : T("Приставка ещё не выбрана", "No console selected");
        applicationSummary = consoleSetupStatus.Text;
        await RefreshHealth();
    }
    private async Task InstallPs4ConsoleService(string consoleIp)
    {
        EnsureStarted();
        if (!IPAddress.TryParse(consoleIp.Trim(), out var address) || address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address) || address.GetAddressBytes()[0] is 0 or >= 224)
            throw new InvalidOperationException(T("Введите IP приставки или найдите её в сети.", "Enter the console's IP or find it on your network."));
        var ip = address.ToString();
        consoleSetupStatus.Text = T("Проверяем PyLoader на PS4…", "Checking PyLoader on PS4…");
        var service = await host.Api("/api/ps4/service-installer?ip=" + Uri.EscapeDataString(ip), ct: lifetime.Token);
        if (service["version"]?.GetValue<string>() is { Length: > 0 })
        {
            settings.PsIp = ip; settings.Save(ServerHost.SettingsPath);
            consoleSetupStatus.Text = T("Сервис уже запущен. Получите код в «Подключениях» PS4.", "Service is already running. Get a code in PS4 Connections.");
            applicationSummary = consoleSetupStatus.Text; return;
        }
        var loader = await host.Api("/api/ps4/status", new { ip }, lifetime.Token);
        if (loader["ready"]?.GetValue<bool>() != true)
            throw new InvalidOperationException(T("Включите GoldHEN и PyLoader на PS4 (порт 9090), затем нажмите «Установить сервис».", "Enable GoldHEN and PyLoader on PS4 (port 9090), then click Install service."));
        consoleSetupStatus.Text = T("Загружаем проверенный PKG сервиса с GitHub…", "Downloading the verified service PKG from GitHub…"); Report(consoleSetupStatus.Text);
        var artifact = await host.Api("/api/ps4/service-update/github", new { current = "0.00" }, lifetime.Token);
        var artifactId = artifact["id"]?.GetValue<string>() ?? throw new InvalidOperationException(T("Не удалось получить PKG сервиса.", "The service PKG is unavailable."));
        consoleSetupStatus.Text = T("Отправляем сервис через PyLoader…", "Sending the service through PyLoader…"); Report(consoleSetupStatus.Text);
        var started = await host.Api("/api/ps4/service-bootstrap", new { ip, artifactId }, lifetime.Token);
        var queueId = started["queue"]?["id"]?.GetValue<string>() ?? throw new InvalidOperationException(T("Очередь не вернула номер задания.", "The queue did not return a job ID."));
        settings.PsIp = ip; settings.Save(ServerHost.SettingsPath);
        var version = artifact["version"]?.GetValue<string>() ?? "";
        for (var attempt = 0; attempt < 180; attempt++)
        {
            await Task.Delay(1500, lifetime.Token);
            var queue = await host.Api("/api/ps4/installation?ip=" + Uri.EscapeDataString(ip), ct: lifetime.Token);
            if (queue["id"]?.GetValue<string>() != queueId) throw new InvalidOperationException(T("Очередь изменилась. Проверьте установку в WEB и на PS4.", "The queue changed. Check installation in WEB and on PS4."));
            var item = queue["items"]?.AsArray().FirstOrDefault();
            var bytes = item?["bytesSent"]?.GetValue<long>() ?? 0;
            var total = artifact["size"]?.GetValue<long>() ?? 1;
            var percent = (int)Math.Clamp(bytes * 100 / Math.Max(1, total), 0, 100);
            progress.Value = percent; progress.Invalidate();
            consoleSetupStatus.Text = T($"PKG {version}: передано {percent}%", $"PKG {version}: {percent}% transferred"); status.Text = consoleSetupStatus.Text;
            var state = item?["state"]?.GetValue<string>();
            if (queue["status"]?.GetValue<string>() is "failed" or "cancelled" || state is "failed" or "skipped" or "cancelled")
                throw new InvalidOperationException(item?["detail"]?.GetValue<string>() ?? queue["message"]?.GetValue<string>() ?? T("Установка не завершена.", "Installation did not complete."));
            if (state == "delivered" && percent < 100) break;
            if (state is "delivered" or "installed")
            {
                consoleSetupStatus.Text = T("PKG передан. Дождитесь установки на PS4, запустите сервис.", "PKG transferred. Wait for PS4 installation, then launch the service.");
                applicationSummary = T("PKG сервиса передан через PyLoader. Итог установки виден в «Уведомлениях → Загрузки» PS4. После завершения запустите PackageFlow и введите код сопряжения в мастере.", "The service PKG was transferred via PyLoader. Check Notifications → Downloads on PS4 for the installation result. Once complete, launch PackageFlow and enter its pairing code in the wizard.");
                MessageBox.Show(this, applicationSummary, "PackageFlow", MessageBoxButtons.OK, MessageBoxIcon.Information); return;
            }
            if (state == "unconfirmed") break;
        }
        applicationSummary = T("Задание отправлено, передача не подтверждена. Проверьте очередь WEB и загрузки PS4. Повтор установки автоматически не отправлен.", "The job was sent, but transfer is not confirmed. Check the WEB queue and PS4 downloads. Installation was not automatically repeated.");
        consoleSetupStatus.Text = T("Проверьте очередь WEB и загрузки PS4.", "Check the WEB queue and PS4 downloads.");
        MessageBox.Show(this, applicationSummary, "PackageFlow", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}
