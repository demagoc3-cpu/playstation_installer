using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private DarkChoice detectedConsoles = null!;
    private Label consoleSetupStatus = null!;
    private sealed record ConsoleChoice(DiscoveredPs4 Device, string Description)
    {
        public override string ToString() => $"{Device.Ip} · {Device.Name} · {Description}";
    }
    private async Task FindConsoles()
    {
        var ip = settings.HostIp;
        var addresses = NetworkInterface.GetAllNetworkInterfaces()
            .Where(network => network.OperationalStatus == OperationalStatus.Up && network.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(network => network.GetIPProperties().UnicastAddresses)
            .Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork).ToArray();
        var local = addresses.FirstOrDefault(address => address.Address.ToString() == ip)
            ?? addresses.FirstOrDefault(address => ServerHost.LanAddresses().FirstOrDefault() == address.Address.ToString());
        if (local == null) throw new InvalidOperationException(T("Выберите IPv4 компьютера на вкладке установки.", "Select the computer's IPv4 address in Installation."));
        ip = local.Address.ToString();
        var candidates = Ps4Discovery.Candidates(ip, local.IPv4Mask.ToString());
        Report(T($"Ищем PS4 рядом с {ip}: обнаружение консоли и проверка {candidates.Length} адресов…", $"Finding PS4 near {ip}: console discovery and probing {candidates.Length} addresses…"));
        consoleSetupStatus.Text = T("Ищем приставки в локальной сети…", "Finding consoles on the local network…");
        var progressWork = new Progress<int>(percent => { if (IsDisposed) return; progress.Value = percent; progress.Invalidate(); status.Text = T($"Поиск PS4 в сети: {percent}%", $"PS4 discovery: {percent}%"); });
        var devices = await Ps4Discovery.Discover(ip, local.IPv4Mask.ToString(), progressWork, lifetime.Token);
        detectedConsoles.Items.Clear();
        foreach (var device in devices)
            detectedConsoles.Items.Add(new ConsoleChoice(device, device.Service ? T("Сервис", "Service") : device.PyLoader ? "PyLoader" : device.RestMode ? T("Режим покоя", "Rest mode") : T("Включите PyLoader", "Enable PyLoader")));
        if (devices.Length > 0)
        {
            detectedConsoles.SelectedIndex = 0;
            consoleSetupStatus.Text = T($"Найдено приставок: {devices.Length}. Выберите нужную.", $"Consoles found: {devices.Length}. Select your console.");
            applicationSummary = consoleSetupStatus.Text;
        }
        else
        {
            consoleSetupStatus.Text = T("PS4 не найдена. Проверьте сеть и введите IP вручную.", "No PS4 found. Check the network or enter its IP manually.");
            applicationSummary = consoleSetupStatus.Text;
        }
    }
    private async Task InstallConsoleService()
    {
        EnsureStarted();
        if (!IPAddress.TryParse(psIp.Text.Trim(), out var address) || address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address) || address.GetAddressBytes()[0] is 0 or >= 224)
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
            var queue = await host.Api("/api/ps4/installation", ct: lifetime.Token);
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
