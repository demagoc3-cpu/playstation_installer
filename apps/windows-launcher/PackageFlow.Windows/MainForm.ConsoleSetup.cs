using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private Label consoleSetupStatus = null!;
    private DataGridView consoleGrid = null!;
    private bool refreshingConsoles;
    private async Task RefreshSavedConsoles(bool probe = false)
    {
        if(refreshingConsoles || preview || IsDisposed)return;
        refreshingConsoles=true;
        try {
            using var ct=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);ct.CancelAfter(TimeSpan.FromSeconds(30));
            var list=await host.Api("/api/consoles",ct:ct.Token);
            SavedConsoleGrid.Render(consoleGrid,list,settings.ConsoleId,settings.Language);
            consoleSetupStatus.Text=list["consoles"]!.AsArray().Count==0?T("Добавленных приставок пока нет. Нажмите «Найти / подключить».","No saved consoles. Click Find / connect."):T("Выберите строку. ● — выбранная приставка. WebKit и kstuff: не проверено.","Select a row. ● marks the selected console. WebKit and kstuff: not checked.");
            if(probe) {
                using var gate=new SemaphoreSlim(2);
                await Task.WhenAll(list["consoles"]!.AsArray().Select(async p=>{
                    await gate.WaitAsync(ct.Token);
                    try{await host.Api("/api/consoles/probe",new{id=p!["id"]!.GetValue<string>()},ct.Token);}
                    catch(OperationCanceledException){}catch(Exception){}finally{gate.Release();}
                }));
                list=await host.Api("/api/consoles",ct:ct.Token);
                SavedConsoleGrid.Render(consoleGrid,list,settings.ConsoleId,settings.Language);
            }
        } catch(Exception error){consoleSetupStatus.Text=T("Не удалось обновить список: ","Unable to refresh consoles: ")+error.Message;}
        finally {refreshingConsoles=false;}
    }
    private async Task SelectSavedConsole()
    {
        EnsureStarted();
        var id=consoleGrid.SelectedRows.Count>0?consoleGrid.SelectedRows[0].Tag as string:null;
        if(id==null)throw new InvalidOperationException(T("Выберите приставку в таблице.","Select a console in the table."));
        var list=await host.Api("/api/consoles/active",new{id},lifetime.Token);
        var selected=list["consoles"]!.AsArray().First(p=>p?["id"]?.GetValue<string>()==id)!;
        settings.ConsoleId=id;settings.PsIp=selected["ip"]!.GetValue<string>();settings.ConsolePlatform=selected["platform"]!.GetValue<string>();
        settings.Save(ServerHost.SettingsPath);psIp.Text=settings.PsIp;
        SavedConsoleGrid.Render(consoleGrid,list,id,settings.Language);
    }
    private async Task FindConsoles()
    {
        EnsureStarted();
        using var dialog = new ConsoleManagerForm(host, settings, InstallPs4ConsoleService);
        dialog.ShowDialog(this);
        psIp.Text = settings.PsIp;
        consoleSetupStatus.Text = settings.PsIp.Length > 0 ? settings.ConsolePlatform.ToUpperInvariant() + " · " + settings.PsIp : T("Приставка ещё не выбрана", "No console selected");
        applicationSummary = consoleSetupStatus.Text;
        await RefreshSavedConsoles(true);
        await RefreshHealth();
    }
    private async Task InstallPs4ConsoleService(string consoleIp, CancellationToken observation, IProgress<string> messages)
    {
        EnsureStarted();
        using var operation=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token,observation);
        operation.CancelAfter(TimeSpan.FromMinutes(5));
        async Task<System.Text.Json.Nodes.JsonNode> Api(string path, object? body=null) {
            using var request=CancellationTokenSource.CreateLinkedTokenSource(operation.Token);
            request.CancelAfter(TimeSpan.FromSeconds(20));
            try { return await host.Api(path,body,request.Token); }
            catch(OperationCanceledException) when (!lifetime.IsCancellationRequested && !observation.IsCancellationRequested) {
                throw new InvalidOperationException(T("Ожидание ответа завершено. Проверьте очередь WEB и загрузки PS4; повторная команда не отправлена.","Waiting for a response timed out. Check the WEB queue and PS4 downloads; no command was repeated."));
            }
        }
        void Update(string message) { consoleSetupStatus.Text=message;status.Text=message;messages.Report(message); }
        if (!IPAddress.TryParse(consoleIp.Trim(), out var address) || address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address) || address.GetAddressBytes()[0] is 0 or >= 224)
            throw new InvalidOperationException(T("Введите IP приставки или найдите её в сети.", "Enter the console's IP or find it on your network."));
        var ip = address.ToString();
        Update(T("Проверяем PyLoader на PS4…", "Checking PyLoader on PS4…"));
        var service = await Api("/api/ps4/service-installer?ip=" + Uri.EscapeDataString(ip));
        if (service["version"]?.GetValue<string>() is { Length: > 0 })
        {
            settings.PsIp = ip; settings.Save(ServerHost.SettingsPath);
            consoleSetupStatus.Text = T("Сервис уже запущен. Получите код в «Подключениях» PS4.", "Service is already running. Get a code in PS4 Connections.");
            applicationSummary = consoleSetupStatus.Text; return;
        }
        var loader = await Api("/api/ps4/status", new { ip });
        if (loader["ready"]?.GetValue<bool>() != true)
            throw new InvalidOperationException(T("Включите GoldHEN и PyLoader на PS4 (порт 9090), затем нажмите «Установить сервис».", "Enable GoldHEN and PyLoader on PS4 (port 9090), then click Install service."));
        Update(T("Подготавливаем проверенный PKG службы PS4…", "Preparing the verified PS4 service package…")); Report(consoleSetupStatus.Text);
        var artifact = await Api("/api/desktop/ps4-setup-artifact", new { });
        var artifactId = artifact["id"]?.GetValue<string>() ?? throw new InvalidOperationException(T("Не удалось получить PKG сервиса.", "The service PKG is unavailable."));
        Update(T("Отправляем сервис через PyLoader…", "Sending the service through PyLoader…")); Report(consoleSetupStatus.Text);
        var started = await Api("/api/ps4/service-bootstrap", new { ip, artifactId });
        var queueId = started["queue"]?["id"]?.GetValue<string>() ?? throw new InvalidOperationException(T("Очередь не вернула номер задания.", "The queue did not return a job ID."));
        settings.PsIp = ip; settings.Save(ServerHost.SettingsPath);
        var version = artifact["version"]?.GetValue<string>() ?? "";
        for (var attempt = 0; attempt < 180; attempt++)
        {
            try { await Task.Delay(1500, operation.Token); }
            catch(OperationCanceledException) when (!lifetime.IsCancellationRequested && !observation.IsCancellationRequested) {
                throw new InvalidOperationException(T("Ожидание передачи завершено. Проверьте очередь WEB и загрузки PS4; повторная команда не отправлена.","Transfer observation timed out. Check the WEB queue and PS4 downloads; no command was repeated."));
            }
            var queue = await Api("/api/ps4/installation?ip=" + Uri.EscapeDataString(ip));
            if (queue["id"]?.GetValue<string>() != queueId) throw new InvalidOperationException(T("Очередь изменилась. Проверьте установку в WEB и на PS4.", "The queue changed. Check installation in WEB and on PS4."));
            var item = queue["items"]?.AsArray().FirstOrDefault();
            var bytes = item?["bytesSent"]?.GetValue<long>() ?? 0;
            var total = artifact["size"]?.GetValue<long>() ?? 1;
            var percent = (int)Math.Clamp(bytes * 100 / Math.Max(1, total), 0, 100);
            progress.Value = percent; progress.Invalidate();
            var state = item?["state"]?.GetValue<string>();
            var detail=item?["detail"]?.GetValue<string>() ?? queue["message"]?.GetValue<string>() ?? "";
            Update(T($"PKG {version}: {bytes / 1048576.0:F1} / {total / 1048576.0:F1} МБ · {percent}% · {detail}", $"PKG {version}: {bytes / 1048576.0:F1} / {total / 1048576.0:F1} MB · {percent}% · {detail}"));
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
