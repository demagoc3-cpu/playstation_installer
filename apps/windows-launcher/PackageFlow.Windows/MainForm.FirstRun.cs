using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private async Task PrepareFirstRun()
    {
        if (mode.SelectedIndex == 1) throw new InvalidOperationException(T("Автонастройка предназначена для режима Windows. В Compose используйте шаги мастера для подключения компонентов.", "Automatic setup is for Windows mode. In Compose use the wizard steps to connect components."));
        settings.AutomaticSetupPending = true;
        if (games.Text.Length == 0) games.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "PackageFlow");
        Directory.CreateDirectory(games.Text);
        settings.Save(ServerHost.SettingsPath);
        Report(T("Шаг 1/4 • Запускаем WEB и готовим библиотеку…", "Step 1/4 • Starting WEB and preparing the library…"));
        await ApplyInstallation();
        applicationSummary = null;
        var failures = new List<string>();
        async Task Step(string name, Func<Task> run) {
            Component(name, T("Подготавливаем…", "Preparing…"), T("Первая настройка", "First setup"), null);
            progress.Value = 0; progress.Invalidate();
            try { await run(); }
            catch (OperationCanceledException) { throw; }
            catch (Exception error) { failures.Add(name); Component(name, T("Нужна проверка", "Needs attention"), T("Подробности в журнале", "See activity log"), false); Report(name + ": " + FriendlyError(error)); }
        }
        await Step("Prowlarr", async () => {
            Report(T("Шаг 2/4 • Подготавливаем Prowlarr…", "Step 2/4 • Preparing Prowlarr…"));
            if (settings.ProtectedProwlarrKey.Length == 0 || settings.ManagedProwlarr) await host.InstallProwlarr(DownloadProgress("Prowlarr"), lifetime.Token);
            else await new ProwlarrClient(http, settings.ProwlarrUrl, LocalSecrets.Read(settings.ProtectedProwlarrKey)).Indexers(lifetime.Token);
            prowlarrUrl.Text = settings.ProwlarrUrl; prowlarrKey.Text = LocalSecrets.Read(settings.ProtectedProwlarrKey);
            await LoadIndexers();
        });
        await Step("FlareSolverr", async () => {
            Report(T("Шаг 3/4 • Подготавливаем FlareSolverr…", "Step 3/4 • Preparing FlareSolverr…"));
            await host.InstallFlareSolverr(DownloadProgress("FlareSolverr"), lifetime.Token);
            if (!failures.Contains("Prowlarr")) await SetupFlareSolverr(Client(), showNotice: false);
        });
        await Step("qBittorrent", async () => {
            Report(T("Шаг 4/4 • Подготавливаем qBittorrent и подключаем его к WEB…", "Step 4/4 • Preparing qBittorrent and connecting it to WEB…"));
            await host.InstallQbittorrent(DownloadProgress("qBittorrent"), lifetime.Token);
            restoredTorrent = false;
        });
        settings.AutomaticSetupPending = failures.Count > 0;
        settings.Save(ServerHost.SettingsPath);
        tabs.SelectedIndex = 2;
        applicationSummary = failures.Count == 0
            ? T("Компоненты готовы. Введите логин и пароль RuTracker и нажмите «Добавить RuTracker и проверить».", "Components are ready. Enter your RuTracker credentials and click Add and test RuTracker.")
            : T("Требуется повторить подготовку: ", "Retry setup for: ") + string.Join(", ", failures) + T(". Причины указаны в журнале ниже.", ". See the activity log below for details.");
    }
}
