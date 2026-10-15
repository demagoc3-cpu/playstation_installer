using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private async Task ManualTrackerLogin()
    {
        if (!ProwlarrClient.ValidateAddress(prowlarrUrl.Text).IsLoopback)
            throw new InvalidOperationException(T("Ручное окно входа доступно для Prowlarr и FlareSolverr на этом компьютере в режиме Windows.", "The manual login window requires local Prowlarr and FlareSolverr in Windows mode."));
        if (!settings.FlareSolverrVisibleBrowser)
            throw new InvalidOperationException(T("Включите «Cloudflare: видимый браузер» в установке и перезапустите FlareSolverr для ручного входа.", "Enable the visible Cloudflare browser in Installation and restart FlareSolverr for manual login."));
        EnsureStarted();
        await host.InstallFlareSolverr(DownloadProgress("FlareSolverr"), lifetime.Token);
        Report(T("RuTracker: открываем окно для ручного входа…", "RuTracker: opening the manual login window…"));
        await using var login = new RuTrackerManualLogin(http);
        await login.Open(lifetime.Token);
        UseWaitCursor = false;
        if (!await DesktopConfirm(T("Ручной вход RuTracker", "Manual RuTracker login"), T("В открытом Chromium войдите в аккаунт и решите CAPTCHA. Нажмите подтверждение только после входа: браузер и Prowlarr будут проверены отдельно.", "Sign in in Chromium and solve CAPTCHA. Confirm after signing in: browser authentication and Prowlarr will be checked separately."))) throw new OperationCanceledException();
        UseWaitCursor = false;
        if (!await login.Authenticated(lifetime.Token))
            throw new InvalidOperationException(T("Вход в браузере ещё не завершён. Нажмите «Войти вручную» и дождитесь появления вашего аккаунта на RuTracker.", "Browser login is not complete. Click ‘Sign in manually’ and wait until your account is visible on RuTracker."));
        var client = Client();
        var tracker = (await client.Indexers(lifetime.Token)).FirstOrDefault(i => i.Name.Contains("rutracker", StringComparison.OrdinalIgnoreCase));
        if (tracker.Id > 0)
        {
            Report(T("RuTracker: ручной вход выполнен, проверяем Prowlarr один раз…", "RuTracker: browser login complete, testing Prowlarr once…"));
            await client.TestIndexer(tracker.Id, lifetime.Token);
            SaveProwlarr(); await ConnectIndexer(client, tracker.Id); await LoadIndexers();
            applicationSummary = T("RuTracker: вход выполнен, индексатор проверен и подключён к WEB.", "RuTracker: signed in, indexer tested and connected to WEB.");
        }
        else applicationSummary = T("Ручной вход выполнен. Теперь введите логин и пароль в мастере и нажмите «Добавить RuTracker и проверить».", "Browser login complete. Enter your credentials in the wizard, then click ‘Add and test RuTracker’.");
    }
}
