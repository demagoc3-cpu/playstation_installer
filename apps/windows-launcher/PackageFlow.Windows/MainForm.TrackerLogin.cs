using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private async Task ManualTrackerLogin()
    {
        if (settings.Mode != "native" || !ProwlarrClient.ValidateAddress(prowlarrUrl.Text).IsLoopback)
            throw new InvalidOperationException(T("Ручное окно входа доступно для Prowlarr и FlareSolverr на этом компьютере в режиме Windows.", "The manual login window requires local Prowlarr and FlareSolverr in Windows mode."));
        if (!settings.FlareSolverrVisibleBrowser)
            throw new InvalidOperationException(T("Включите «Cloudflare: видимый браузер» в установке и перезапустите FlareSolverr для ручного входа.", "Enable the visible Cloudflare browser in Installation and restart FlareSolverr for manual login."));
        EnsureStarted();
        await host.InstallFlareSolverr(DownloadProgress("FlareSolverr"), lifetime.Token);
        Report(T("RuTracker: открываем окно для ручного входа…", "RuTracker: opening the manual login window…"));
        await using var login = new RuTrackerManualLogin(http);
        await login.Open(lifetime.Token);
        UseWaitCursor = false;
        using var dialog = new Form
        {
            Text = T("Ручной вход RuTracker", "Manual RuTracker login"), ClientSize = new Size(580, 240),
            StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog,
            MinimizeBox = false, MaximizeBox = false, BackColor = Theme.Background, ForeColor = ForeColor, Font = Font
        };
        dialog.Controls.Add(new Label
        {
            Text = T("В открытом Chromium войдите в RuTracker и введите код с картинки, если он появится. Окно останется открытым, пока вы не нажмёте кнопку ниже.\n\nНажимайте «Я вошёл» только когда на странице виден ваш аккаунт. Мастер проверит вход и отдельно проверит Prowlarr.", "Sign in to RuTracker in the open Chromium window and enter the CAPTCHA if shown. The window stays open until you confirm below.\n\nClick ‘I signed in’ only when your account is visible on the page. The wizard will verify browser login, then test Prowlarr separately."),
            Dock = DockStyle.Fill, Padding = new Padding(22)
        });
        var buttons = new BufferedFlow { Dock = DockStyle.Bottom, Height = 62, Padding = new Padding(14, 8, 0, 8) };
        var done = new RoundedButton { Text = T("Я вошёл — проверить", "I signed in — verify"), Width = 270, Height = 42, BackColor = Theme.Accent, ForeColor = Color.White, DialogResult = DialogResult.OK };
        var cancel = new RoundedButton { Text = T("Отмена", "Cancel"), Width = 130, Height = 42, BackColor = Theme.Card, ForeColor = ForeColor, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(done); buttons.Controls.Add(cancel); dialog.Controls.Add(buttons); buttons.BringToFront();
        dialog.AcceptButton = done; dialog.CancelButton = cancel;
        if (dialog.ShowDialog(this) != DialogResult.OK) throw new OperationCanceledException();
        UseWaitCursor = true;
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
