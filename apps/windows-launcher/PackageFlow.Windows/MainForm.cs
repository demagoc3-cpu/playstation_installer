using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.Win32;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm : Form
{
    private readonly LauncherSettings settings;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(10) };
    private readonly CancellationTokenSource lifetime = new();
    private readonly NotifyIcon tray = new() { Icon = SystemIcons.Application, Text = "PackageFlow", Visible = true };
    private readonly Label status = new() { Dock = DockStyle.Bottom, Height = 42, Padding = new Padding(18, 8, 18, 8) };
    private readonly PageHost tabs = new() { Dock = DockStyle.Fill };
    private readonly ServerHost host;
    private readonly bool background;
    private bool exiting, busy;
    private readonly List<Control> actionButtons = [];
    private DarkChoice language = null!, mode = null!, lan = null!;
    private TextBox games = null!, port = null!, payloadPort = null!, psIp = null!, pairCode = null!;
    private TextBox prowlarrUrl = null!, prowlarrKey = null!, trackerUser = null!, trackerPassword = null!;
    private DarkChoice indexers = null!;
    private CheckBox autoStart = null!, composeProwlarr = null!, installFlare = null!, visibleFlare = null!;
    private FlowLayoutPanel navigation = null!;
    private readonly List<TextBox> formFields = [];
    private readonly List<CheckBox> formChecks = [];
    private readonly List<DarkChoice> formChoices = [];
    private TextBox torrentAddress = null!, torrentUser = null!, torrentPassword = null!, torrentFolder = null!;
    private readonly bool preview;

    private string T(string ru, string en) => settings.Language == "en" ? en : ru;
    public MainForm(bool background, LauncherSettings? previewSettings = null)
    {
        preview = previewSettings != null;
        settings = previewSettings ?? LauncherSettings.Load(ServerHost.SettingsPath);
        this.background = background;
        Text = "PackageFlow for Windows";
        DoubleBuffered = true;
        SetStyle(ControlStyles.ResizeRedraw | ControlStyles.AllPaintingInWmPaint, true);
        Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? SystemIcons.Application;
        tray.Icon = Icon;
        ClientSize = new Size(1180, 780); MinimumSize = new Size(980, 760);
        WindowState = FormWindowState.Maximized;
        StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 10);
        BackColor = Color.FromArgb(19, 19, 31); ForeColor = Color.FromArgb(239, 239, 249);
        host = new(settings, http) { Status = message => { Report(TranslateStatus(message)); if (message.EndsWith("ready")) _ = RefreshHealth(); } };
        host.DownloadPercent = percent => { progress.Value = percent; progress.Invalidate(); status.Text = T($"Загрузка компонента: {percent}%", $"Downloading component: {percent}%"); };
        Build();
        if (preview) { tray.Visible = false; return; }
        tray.DoubleClick += (_, _) => ShowWindow();
        FormClosing += (_, e) => { if (!exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
        Shown += async (_, _) =>
        {
            _ = Listen(); _ = RefreshGithub();
            if (background && settings.SetupComplete) Hide();
            await RefreshHealth();
            healthTimer.Start();
            if (settings.AutomaticSetupPending && settings.Mode == "native") await Act(PrepareFirstRun, T("Первая настройка: подготавливаем компоненты", "First setup: preparing components"));
            else if (settings.SetupComplete || settings.ManagedQbittorrent) await Act(() => host.Start(lifetime.Token), T("Запуск PackageFlow", "Starting PackageFlow"));
        };
    }

    private void Build()
    {
        var selectedPage = tabs.SelectedIndex;
        var drafts = formFields.Select(f => f.Text).ToArray();
        var checks = formChecks.Select(c => c.Checked).ToArray();
        var choices = formChoices.Select(c => (Items: c.Items.ToArray(), c.SelectedIndex)).ToArray();
        var oldPages = tabs.TabPages.Cast<Control>().ToArray();
        var oldSurfaces = Controls.Cast<Control>().Where(c => c != tabs).ToArray();
        events.Parent?.Controls.Remove(events); status.Parent?.Controls.Remove(status); progress.Parent?.Controls.Remove(progress);
        actionButtons.Clear(); formFields.Clear(); formChecks.Clear(); formChoices.Clear(); Controls.Clear(); tabs.TabPages.Clear();
        foreach (var page in oldPages) page.Dispose();
        foreach (var surface in oldSurfaces) surface.Dispose();
        tabs.BackColor = BackColor;
        navigation = new BufferedFlow { Dock = DockStyle.Left, Width = 205, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(14, 22, 14, 0), BackColor = Color.FromArgb(23, 23, 38) };
        var header = BuildHeader();
        Controls.Add(tabs); Controls.Add(navigation); Controls.Add(BuildHealthStrip()); Controls.Add(header); Controls.Add(BuildActivity());
        InstallationPage(); ConnectionPage(); SearchPage(); TorrentPage(); UpdatePage();
        for (var i = 0; i < Math.Min(drafts.Length, formFields.Count); i++) formFields[i].Text = drafts[i];
        for (var i = 0; i < Math.Min(checks.Length, formChecks.Count); i++) formChecks[i].Checked = checks[i];
        for (var i = 0; i < Math.Min(choices.Length, formChoices.Count); i++) {
            formChoices[i].Items.Clear(); formChoices[i].Items.AddRange(choices[i].Items); formChoices[i].SelectedIndex = choices[i].SelectedIndex;
        }
        tabs.SelectedIndex = Math.Max(0, selectedPage);
        tabs.SelectedIndexChanged -= HighlightNavigation; tabs.SelectedIndexChanged += HighlightNavigation;
        HighlightNavigation(null, EventArgs.Empty);
        var menu = new ContextMenuStrip();
        menu.Items.Add(T("Открыть PackageFlow", "Open PackageFlow"), null, (_, _) => OpenWeb());
        menu.Items.Add(T("Управление и настройка", "Manage and configure"), null, (_, _) => ShowWindow());
        menu.Items.Add(T("Запустить сервер", "Start server"), null, async (_, _) => await Act(() => host.Start(lifetime.Token)));
        menu.Items.Add(T("Остановить сервер", "Stop server"), null, async (_, _) => await Act(() => host.Stop(lifetime.Token)));
        menu.Items.Add(T("Открыть папку данных", "Open data folder"), null, (_, _) => { Directory.CreateDirectory(ServerHost.DataDirectory); ProcessRunner.Open(ServerHost.DataDirectory); });
        menu.Items.Add(T("Выйти и остановить", "Exit and stop"), null, async (_, _) => await Act(Exit));
        var previous = tray.ContextMenuStrip; tray.ContextMenuStrip = menu; previous?.Dispose();
        Report(T("Мастер готов. Проверяем подключения компонентов…", "Setup ready. Checking component connections…"));
        if (Visible && !preview) _ = RefreshHealth();
    }

    private void SaveLanguage()
    {
        // An unconfigured Compose selection can lack a LAN IP; save language without
        // applying half-completed form fields.
        settings.Save(ServerHost.SettingsPath);
    }

    private void HighlightNavigation(object? sender, EventArgs e)
    {
        foreach (Button button in navigation.Controls)
            button.BackColor = (int)button.Tag! == tabs.SelectedIndex ? Color.FromArgb(75, 58, 113) : Color.FromArgb(23, 23, 38);
    }
    private sealed record PageLayout(TableLayoutPanel Footer, int Columns);
    private FlowLayoutPanel Page(string name, string description, int columns = 2)
    {
        var index = tabs.TabPages.Count;
        var nav = new RoundedButton { Glyph = index, Text = index == 2 ? T("3. Поиск", "3. Search") : name, Tag = index, Width = 175, Height = 52, FlatStyle = FlatStyle.Flat, ForeColor = ForeColor,
            TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 0, 0), Margin = new Padding(0, 0, 0, 8) };
        nav.FlatAppearance.BorderSize = 0; nav.Click += (_, _) => tabs.SelectedIndex = index; navigation.Controls.Add(nav);
        var page = new BufferedPanel { Dock = DockStyle.Fill, BackColor = BackColor, ForeColor = ForeColor, Padding = new Padding(18, 10, 18, 12) };
        var heading = new BufferedTable { Dock = DockStyle.Top, Height = 87, ColumnCount = 1, RowCount = 2 };
        heading.RowStyles.Add(new RowStyle(SizeType.Absolute, 41)); heading.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        heading.Controls.Add(new Label { Text = name, Dock = DockStyle.Fill, Font = new Font("Segoe UI", 22, FontStyle.Bold) });
        var subtitle = new Label { Text = description, Dock = DockStyle.Fill, ForeColor = Theme.Muted, Padding = new Padding(0, 5, 0, 0) };
        heading.Controls.Add(subtitle);
        heading.SizeChanged += (_, _) => {
            if (heading.ClientSize.Width < 200) return;
            var desired = 45 + subtitle.GetPreferredSize(new Size(heading.ClientSize.Width - 8, 0)).Height;
            if (heading.Height != desired) heading.Height = desired;
        };
        var footer = new BufferedTable { Dock = DockStyle.Bottom, Height = 70, RowCount = 1, ColumnCount = 0, Padding = new Padding(4, 8, 4, 4), BackColor = Color.FromArgb(23, 23, 38) };
        footer.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var flow = new CardFlow { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = true, AutoScroll = true, Tag = new PageLayout(footer, columns) };
        void ResizeFields() {
            var width = Math.Max(120, (flow.ClientSize.Width - 14) / columns - 10);
            foreach (Control item in flow.Controls) item.Width = width;
        }
        flow.SizeChanged += (_, _) => ResizeFields(); page.SizeChanged += (_, _) => ResizeFields();
        page.Controls.Add(flow); page.Controls.Add(heading); page.Controls.Add(footer); tabs.TabPages.Add(page);
        return flow;
    }
    private Panel FieldCard(FlowLayoutPanel parent, string label)
    {
        var card = new RoundedPanel { Width = Math.Max(120, (parent.ClientSize.Width - 14) / ((PageLayout)parent.Tag!).Columns - 10), Height = 80, Padding = new Padding(12, 8, 12, 8), Margin = new Padding(0, 0, 10, 8), BackColor = Color.FromArgb(30, 29, 46) };
        card.Controls.Add(new Label { Text = label, Dock = DockStyle.Top, Height = 32, Font = new Font("Segoe UI", 9), ForeColor = Color.FromArgb(180, 179, 201) });
        parent.Controls.Add(card); return card;
    }
    private TextBox Field(FlowLayoutPanel parent, string label, string value = "", bool secret = false)
    {
        var card = FieldCard(parent, label);
        var field = new TextBox { Text = value, UseSystemPasswordChar = secret, BorderStyle = BorderStyle.None, Dock = DockStyle.Bottom, BackColor = Color.FromArgb(37, 36, 55), ForeColor = Color.White };
        card.Controls.Add(field); formFields.Add(field);
        if (secret) {
            var title = card.Controls.OfType<Label>().Single(); card.Controls.Remove(title);
            var heading = new BufferedPanel { Dock = DockStyle.Top, Height = 32 };
            title.Dock = DockStyle.Fill;
            var reveal = new CheckBox { Text = T("Показать", "Show"), AccessibleName = T("Показать пароль", "Show password"), Dock = DockStyle.Right, Width = 88, Font = new Font("Segoe UI", 9) };
            reveal.CheckedChanged += (_, _) => field.UseSystemPasswordChar = !reveal.Checked;
            heading.Controls.Add(title); heading.Controls.Add(reveal); card.Controls.Add(heading);
        }
        return field;
    }
    private DarkChoice Choice(FlowLayoutPanel parent, string label, IEnumerable<string> values, int selected)
    {
        var card = FieldCard(parent, label);
        var choice = new DarkChoice { Dock = DockStyle.Bottom, BackColor = Color.FromArgb(37, 36, 55), ForeColor = Color.White };
        choice.Items.AddRange(values.Cast<object>().ToArray()); choice.SelectedIndex = selected;
        card.Controls.Add(choice); formChoices.Add(choice); return choice;
    }
    private CheckBox Check(FlowLayoutPanel parent, string label, bool value)
    {
        var card = FieldCard(parent, "");
        foreach (Control child in card.Controls.Cast<Control>().ToArray()) { card.Controls.Remove(child); child.Dispose(); }
        var control = new CheckBox { Text = "", AccessibleName = label, Checked = value, Dock = DockStyle.Left, Width = 24 };
        var text = new Label { Text = label, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Cursor = Cursors.Hand };
        text.Click += (_, _) => { if (control.Enabled) { control.Checked = !control.Checked; control.Focus(); } };
        card.Controls.Add(text); card.Controls.Add(control); formChecks.Add(control); return control;
    }

    private void Buttons(FlowLayoutPanel parent, params (string Label, Func<Task> Action)[] items)
    {
        var footer = ((PageLayout)parent.Tag!).Footer;
        foreach (var item in items)
        {
            var button = new RoundedButton { WrapText = true, Text = item.Label, Dock = DockStyle.Fill, Font = new Font("Segoe UI", 9), FlatStyle = FlatStyle.Flat, BackColor = Theme.Accent, ForeColor = Color.White, Padding = new Padding(4), Margin = new Padding(4) };
            button.FlatAppearance.BorderSize = 0;
            button.Click += async (_, _) => await Act(item.Action, item.Label);
            footer.ColumnCount++; footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 1));
            footer.Controls.Add(button, footer.ColumnCount - 1, 0); actionButtons.Add(button);
        }
    }

    private TextBox FolderField(FlowLayoutPanel parent, string label, string value)
    {
        var field = Field(parent, label, value); var card = field.Parent!;
        var line = new BufferedPanel { Dock = DockStyle.Bottom, Height = 29 };
        card.Controls.Remove(field); field.Dock = DockStyle.Fill; field.Margin = Padding.Empty;
        var choose = new RoundedButton { Text = T("Выбрать…", "Browse…"), Width = 95, Dock = DockStyle.Right, BackColor = Theme.Accent, ForeColor = Color.White, Font = new Font("Segoe UI", 9), FlatStyle = FlatStyle.Flat };
        choose.FlatAppearance.BorderSize = 0;
        choose.Click += (_, _) => { using var picker = new FolderBrowserDialog { SelectedPath = Directory.Exists(field.Text) ? field.Text : settings.GamesDirectory, ShowNewFolderButton = true }; if (picker.ShowDialog(this) == DialogResult.OK) field.Text = picker.SelectedPath; };
        line.Controls.Add(field); line.Controls.Add(choose); card.Controls.Add(line); actionButtons.Add(choose);
        return field;
    }

    private async Task Act(Func<Task> action, string? operation = null)
    {
        if (busy) return;
        busy = true; UseWaitCursor = true;
        foreach (var button in actionButtons) button.Enabled = false;
        foreach (Control input in formFields.Cast<Control>().Concat(formChoices).Concat(formChecks)) input.Enabled = false;
        language.Enabled = false;
        try { applicationSummary = null; Report(operation ?? T("Выполняем действие…", "Running action…")); progress.Value = 0; progress.Invalidate(); await healthWork; await action(); Report(applicationSummary ?? T("Готово: ", "Completed: ") + (operation ?? "PackageFlow")); progress.Value = 100; progress.Invalidate(); }
        catch (OperationCanceledException) { Report(T("Операция отменена", "Operation cancelled")); }
        catch (Exception error)
        {
            Report(T("Действие не завершено: ", "Action did not complete: ") + operation);
            MessageBox.Show(this, FriendlyError(error), "PackageFlow", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            busy = false; UseWaitCursor = false;
            if (!IsDisposed) { foreach (var button in actionButtons) button.Enabled = true; foreach (Control input in formFields.Cast<Control>().Concat(formChoices).Concat(formChecks)) input.Enabled = true; language.Enabled = true; await healthWork; await RefreshHealth(); }
        }
    }

    private string TranslateStatus(string message) => settings.Language != "ru" ? message : message switch
    {
        "Checking the WEB server…" => "Проверяем запущенный WEB…",
        "Starting the WEB server…" => "Запускаем WEB, ожидаем готовности API…",
        "Checking active jobs before stopping…" => "Проверяем активные задачи перед остановкой…",
        "Checking Prowlarr…" => "Проверяем Prowlarr…",
        "Downloading Prowlarr…" => "Загружаем Prowlarr…",
        "Extracting Prowlarr…" => "Распаковываем Prowlarr…",
        "Starting Prowlarr…" => "Запускаем Prowlarr, ожидаем готовности API…",
        "Prowlarr ready" => "Prowlarr работает",
        "Checking FlareSolverr…" => "Проверяем FlareSolverr…",
        "Extracting FlareSolverr…" => "Распаковываем FlareSolverr…",
        "Starting FlareSolverr and Chromium…" => "Запускаем FlareSolverr и Chromium…",
        "FlareSolverr ready" => "FlareSolverr работает",
        "Downloading FlareSolverr…" => "Загружаем FlareSolverr…",
        "Checking qBittorrent…" => "Проверяем qBittorrent…",
        "Downloading qBittorrent…" => "Загружаем qBittorrent…",
        "Installing qBittorrent: approve the Windows administrator prompt…" => "Устанавливаем qBittorrent: подтвердите запрос администратора Windows…",
        "Starting qBittorrent…" => "Запускаем qBittorrent и ожидаем Web UI…",
        "Connecting qBittorrent to WEB…" => "Подключаем qBittorrent к WEB…",
        "qBittorrent ready" => "qBittorrent подключён",
        "Checking Docker Desktop…" => "Проверяем Docker Desktop…",
        "Downloading and starting containers…" => "Подготавливаем и запускаем контейнеры…",
        "WEB ready" => "WEB работает, запускаем дополнительные компоненты…",
        "PackageFlow ready" => "PackageFlow работает",
        "PackageFlow stopped" => "PackageFlow остановлен",
        _ => message
    };
    private string FriendlyError(Exception error)
    {
        if (error is ProwlarrRequestException requestError)
        {
            if (requestError.TrackerCaptchaRequired)
                return T("RuTracker просит ввести код с картинки. Это отдельная проверка входа, а не сообщение о неверном пароле. Нажмите «Войти вручную»: окно останется открытым до вашего подтверждения. После входа мастер отдельно проверит Prowlarr один раз. Если капча потребуется повторно, текущий индексатор Prowlarr не сможет передать ответ на неё — не повторяйте попытки подряд.", "RuTracker requires a login CAPTCHA, which does not necessarily mean the password is wrong. Click ‘Sign in manually’: the window stays open until you confirm. The wizard then tests Prowlarr once. If CAPTCHA is still required, the current Prowlarr indexer cannot submit its answer; avoid repeated retries.");
            if (requestError.StatusCode is 401 or 403)
                return T("Prowlarr отклонил доступ. Проверьте API-ключ Prowlarr.", "Prowlarr denied access. Check the Prowlarr API key.");
            if (requestError.RequestPath.StartsWith("api/v1/indexerproxy"))
                return T("Не удалось проверить или сохранить FlareSolverr в Prowlarr. Проверка прокси обращается к https://prowlarr.servarr.com/v1/ping, а не к RuTracker. Посмотрите журнал FlareSolverr: там будет причина, например блокировка Cloudflare. Запуск FlareSolverr сам по себе не подтверждает доступ к этому сайту. Уже настроенный индексатор можно отдельно проверить и подключить кнопкой «Подключить выбранный к WEB».", "Prowlarr could not test or save FlareSolverr. The proxy test requests https://prowlarr.servarr.com/v1/ping, not RuTracker. Check the FlareSolverr log for the cause, such as a Cloudflare block. Starting FlareSolverr alone does not prove access to that site. An existing indexer can be tested and connected separately with ‘Connect selected to WEB’.");
            if (requestError.RequestPath == "api/v1/indexer/test")
                return T("Индексатор не прошёл проверку Prowlarr. Откройте Prowlarr → индексатор → Test и журнал: проверьте доступ к трекеру, авторизацию и назначенный прокси. Настройки поиска WEB не изменены.", "The indexer failed the Prowlarr test. Open Prowlarr → indexer → Test and its log: check tracker access, authentication and the assigned proxy. WEB search settings were not changed.");
        }
        if (settings.Language != "ru") return error.Message;
        if (error is System.ComponentModel.Win32Exception && settings.Mode == "compose") return "Не удалось запустить Docker. Установите Docker Desktop, включите Linux-контейнеры и запустите его.";
        if (error is System.ComponentModel.Win32Exception { NativeErrorCode: 1223 }) return "Запрос администратора Windows отменён. Нажмите «Подготовить компоненты», чтобы повторить установку qBittorrent.";
        if (error.Message.StartsWith("Prowlarr (")) return "Prowlarr не принял запрос. Проверьте API-ключ, логин и пароль трекера. Подробности доступны через «Открыть Prowlarr» → тест индексатора.";
        return error.Message switch
        {
            "Active or unverified jobs prevent stopping. Check the WEB queue and PS4 operations." => "Остановка заблокирована активными или непроверенными заданиями. Проверьте очередь WEB и операции PS4.",
            "RuTracker is already configured. Select the existing indexer to preserve its settings." => "RuTracker уже настроен. Выберите его в списке существующих индексаторов и подключите к WEB.",
            "Enter the RuTracker username and password." => "Введите логин и пароль RuTracker.",
            "Choose the computer's LAN IPv4 address." => "Выберите LAN IPv4 компьютера.",
            "Docker Compose requires the computer's LAN IPv4 address." => "Для Compose выберите LAN IPv4 компьютера.",
            "Invalid server ports." => "Укажите разные порты WEB и обратного подключения в диапазоне 1024–65535.",
            "Choose different WEB, PS4 and qBittorrent ports." => "Порты WEB, обратного подключения PS4 и qBittorrent должны различаться.",
            "The saved qBittorrent connection is unavailable. Check its settings in Downloads." => "Сохранённое подключение qBittorrent недоступно. Проверьте его настройки в «Загрузках».",
            "qBittorrent installation did not complete. Retry automatic setup." => "Установка qBittorrent не завершена. Повторите подготовку компонентов.",
            "No verified Windows x64 qBittorrent release." => "В официальном релизе qBittorrent не найден проверяемый установщик Windows x64.",
            "qBittorrent Web UI did not start. Check the PackageFlow profile." => "Web UI qBittorrent не запустился. Проверьте профиль PackageFlow и повторите подготовку.",
            "qBittorrent stopped during startup." => "qBittorrent завершился при запуске. Повторите подготовку компонентов.",
            "Release has no verifiable SHA-256 asset." => "В релизе нет проверяемой контрольной суммы SHA-256. Обновление не запущено.",
            "Download size or SHA-256 verification failed." => "Размер или SHA-256 загруженного файла не совпадает с релизом. Файл не запущен.",
            "This RuTracker definition requires manual authentication in Prowlarr." => "Этот индексатор требует дополнительной авторизации. Откройте Prowlarr и выполните её там.",
            _ => error.Message
        };
    }
    private void InstallationPage()
    {
        var page = Page(T("1. Установка", "1. Installation"), T("Выберите способ запуска и папку с PKG. Закрытие этого окна оставляет сервер работающим. Для Compose сначала установите и запустите Docker Desktop.", "Choose a launch mode and PKG folder. Closing this window keeps the server running. For Compose, install and start Docker Desktop first."), columns: 3);
        mode = Choice(page, T("Способ запуска", "Launch mode"), ["Windows", "Docker Compose"], settings.Mode == "compose" ? 1 : 0);
        games = FolderField(page, T("Папка с играми", "Games folder"), settings.GamesDirectory);
        var addresses = ServerHost.LanAddresses();
        var selected = Array.IndexOf(addresses, settings.HostIp);
        lan = Choice(page, T("IPv4 компьютера (для PS4)", "Computer LAN IPv4 (for PS4)"), addresses, selected >= 0 ? selected : addresses.Length > 0 ? 0 : -1);
        port = Field(page, T("Порт WEB", "WEB port"), settings.Port.ToString());
        payloadPort = Field(page, T("Порт PS4 → WEB", "PS4 callback port"), settings.PayloadPort.ToString());
        autoStart = Check(page, T("Запускать при входе в Windows", "Start at Windows sign-in"), settings.AutoStart);
        composeProwlarr = Check(page, T("В Compose добавить Prowlarr для поиска", "Include Prowlarr search in Compose"), settings.ManagedProwlarr);
        visibleFlare = Check(page, T("Cloudflare: видимый браузер (Windows)", "Cloudflare: visible FlareSolverr browser (Windows)"), settings.FlareSolverrVisibleBrowser);
        Buttons(page,
            (T("Применить", "Apply"), ApplyInstallation),
            (T("Открыть WEB", "Open WEB"), () => { OpenWeb(); return Task.CompletedTask; }),
            (T("Остановить", "Stop"), () => host.Stop(lifetime.Token)),
            (T("Разрешить доступ PS4", "Allow PS4 access"), Firewall));
        Buttons(page, (T("Скачать Docker Desktop", "Download Docker Desktop"), () => { ProcessRunner.Open("https://docs.docker.com/desktop/setup/install/windows-install/"); return Task.CompletedTask; }));
        Buttons(page, (T("Подготовить компоненты", "Prepare components"), PrepareFirstRun));
    }
    private LauncherSettings JsonSerializerClone(LauncherSettings source) => System.Text.Json.JsonSerializer.Deserialize<LauncherSettings>(System.Text.Json.JsonSerializer.Serialize(source))!;
    private void Restore(LauncherSettings previous)
    {
        foreach (var property in typeof(LauncherSettings).GetProperties()) property.SetValue(settings, property.GetValue(previous));
    }
    private static void SetAutoStart(bool enabled)
    {
        using var run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (enabled) run.SetValue("PackageFlow", $"\"{Environment.ProcessPath}\" --background"); else run.DeleteValue("PackageFlow", false);
    }
    private Task Firewall()
    {
        // Only fixed TCP ports, only the private profile and local subnet; UAC is explicit.
        var script = Path.Combine(AppContext.BaseDirectory, "configure-firewall.ps1");
        var info = new ProcessStartInfo("powershell.exe") { UseShellExecute = true, Verb = "runas" };
        foreach (var argument in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-WebPort", settings.Port.ToString(), "-PayloadPort", settings.PayloadPort.ToString() }) info.ArgumentList.Add(argument);
        Process.Start(info); return Task.CompletedTask;
    }
    private void OpenWeb()
    {
        if (!host.Started) { ShowWindow(); return; }
        ProcessRunner.Open(host.WebUrl);
    }

    private void ConnectionPage()
    {
        var page = Page(T("2. PS4", "2. PS4"), T("Запустите PackageFlow на PS4, откройте «Подключения» и получите код. Этот мастер использует то же сопряжение, что и WEB.", "Start PackageFlow on PS4, open Connections and get a code. This wizard uses the same pairing as WEB."));
        psIp = Field(page, T("IP приставки", "Console IP"), settings.PsIp);
        pairCode = Field(page, T("Код сопряжения", "Pairing code"), secret: true);
        Buttons(page,
            (T("Проверить службу", "Check service"), async () =>
            {
                EnsureStarted();
                var result = await host.Api("/api/ps4/service-installer?ip=" + Uri.EscapeDataString(psIp.Text.Trim()), ct: lifetime.Token);
                MessageBox.Show(this, result["message"]?.GetValue<string>() ?? result.ToJsonString(), "PackageFlow");
            }),
            (T("Сопряжение", "Pairing"), async () =>
            {
                EnsureStarted();
                await host.Api("/api/ps4/service-key", new { ip = psIp.Text.Trim(), code = pairCode.Text.Trim() }, lifetime.Token);
                await host.Api("/api/ps4/status", new { ip = psIp.Text.Trim() }, lifetime.Token);
                settings.PsIp = psIp.Text.Trim(); settings.Save(ServerHost.SettingsPath); pairCode.Clear();
                tabs.SelectedIndex = 2;
            }),
            (T("Позже / к поиску", "Later / search"), () => { tabs.SelectedIndex = 2; return Task.CompletedTask; }));
        Buttons(page, (T("Добавить PKG из папки", "Index PKG folder"), async () =>
        {
            EnsureStarted();
            await host.Api("/api/packages/scan", new { directory = settings.Mode == "compose" ? "/games" : settings.GamesDirectory, psIp = settings.PsIp.Length > 0 ? settings.PsIp : settings.HostIp }, lifetime.Token);
        }));
    }

    private void SearchPage()
    {
        var page = Page(T("3. Поиск RuTracker", "3. RuTracker search"), T("Можно установить Prowlarr или подключить существующий. Логин и пароль передаются в Prowlarr; сохранённый пароль защищён вашей учётной записью Windows. Этот шаг можно пропустить.", "Install Prowlarr or connect an existing instance. Credentials go to Prowlarr; the saved password is protected by your Windows account. You can skip this step."));
        installFlare = Check(page, T("Установить FlareSolverr при настройке нового RuTracker", "Install FlareSolverr when setting up a new RuTracker indexer"), true);
        prowlarrUrl = Field(page, T("Адрес Prowlarr", "Prowlarr address"), settings.ProwlarrUrl);
        prowlarrKey = Field(page, T("API-ключ Prowlarr", "Prowlarr API key"), LocalSecrets.Read(settings.ProtectedProwlarrKey), secret: true);
        Buttons(page,
            (T("Установить Prowlarr", "Install Prowlarr"), async () =>
            {
                EnsureStarted();
                if (settings.Mode == "compose")
                {
                    if (!settings.ManagedProwlarr) throw new InvalidOperationException(T("Включите Prowlarr на вкладке установки и перезапустите Compose.", "Enable Prowlarr on the installation tab and restart Compose."));
                }
                else await host.InstallProwlarr(DownloadProgress("Prowlarr"), lifetime.Token);
                prowlarrUrl.Text = settings.ProwlarrUrl; await LoadIndexers();
                if (installFlare.Checked) await SetupFlareSolverr(Client());
            }),
            (T("Подключить существующий", "Connect existing"), LoadIndexers),
            ("FlareSolverr", async () => {
                EnsureStarted(); var client = Client(); var tag = await SetupFlareSolverr(client);
                foreach (var item in await client.Indexers(lifetime.Token))
                    if (item.Name.Contains("rutracker", StringComparison.OrdinalIgnoreCase)) await client.AttachRuTrackerProxy(item.Id, tag, lifetime.Token);
                await LoadIndexers();
            }),
            (T("Открыть Prowlarr", "Open Prowlarr"), () => { ProcessRunner.Open(ProwlarrClient.ValidateAddress(prowlarrUrl.Text).ToString()); return Task.CompletedTask; }),
            (T("Войти вручную", "Sign in manually"), ManualTrackerLogin));
        trackerUser = Field(page, T("Логин RuTracker", "RuTracker username"), settings.TrackerUsername);
        trackerPassword = Field(page, T("Пароль RuTracker", "RuTracker password"), LocalSecrets.Read(settings.ProtectedTrackerPassword), secret: true);
        Buttons(page, (T("Добавить RuTracker и проверить", "Add and test RuTracker"), async () =>
        {
            EnsureStarted();
            var client = Client();
            int id;
            // Reuse the proxy prepared on first launch. Re-testing the proxy here
            // opens unrelated challenge browsers before every login attempt.
            var address = settings.Mode == "compose" && settings.ManagedProwlarr ? "http://flaresolverr:8191/" : "http://127.0.0.1:8191/";
            int? tag = null;
            if (installFlare.Checked)
            {
                tag = await client.ExistingFlareSolverrTag(address, lifetime.Token);
                if (tag == null) tag = await SetupFlareSolverr(client);
                else await host.InstallFlareSolverr(DownloadProgress("FlareSolverr"), lifetime.Token);
            }
            Report(T("RuTracker: проверяем авторизацию и индексатор…", "RuTracker: checking authentication and indexer…"));
            id = await client.AddRuTracker(trackerUser.Text, trackerPassword.Text, lifetime.Token, tag);
            settings.TrackerUsername = trackerUser.Text.Trim();
            settings.ProtectedTrackerPassword = LocalSecrets.Protect(trackerPassword.Text);
            SaveProwlarr();
            await ConnectIndexer(client, id);
            await LoadIndexers();
        }));
        indexers = Choice(page, T("Или уже настроенный индексатор", "Or an existing indexer"), [], -1);
        Buttons(page,
            (T("Применить к WEB", "Apply to WEB"), async () =>
            {
                EnsureStarted();
                if (indexers.SelectedItem is not Indexer item) throw new InvalidOperationException(T("Выберите индексатор.", "Select an indexer."));
                var client = Client();
                // Connecting an existing indexer preserves its proxy and tags.
                Report(T("RuTracker: проверяем выбранный индексатор…", "RuTracker: testing selected indexer…"));
                if (await client.ApplyRuTrackerCredentials(item.Id, trackerUser.Text, trackerPassword.Text, lifetime.Token)) {
                    if (trackerUser.Text.Trim().Length > 0 && trackerUser.Text.Trim() != settings.TrackerUsername) { settings.TrackerUsername = trackerUser.Text.Trim(); settings.ProtectedTrackerPassword = ""; }
                    if (trackerPassword.Text.Length > 0) settings.ProtectedTrackerPassword = LocalSecrets.Protect(trackerPassword.Text);
                }
                SaveProwlarr();
                await ConnectIndexer(client, item.Id);
            }),
            (T("Настроить позже", "Set up later"), () => { tabs.SelectedIndex = 3; return Task.CompletedTask; }));
    }
    private async Task<int> SetupFlareSolverr(ProwlarrClient client, bool showNotice = true)
    {
        if (!new Uri(prowlarrUrl.Text).IsLoopback)
            throw new InvalidOperationException(T("Для удалённого Prowlarr настройте адрес FlareSolverr в его интерфейсе. Автоматическая установка предназначена для этого компьютера.", "For remote Prowlarr configure the FlareSolverr address in its interface. Automatic setup is for this computer."));
        await host.InstallFlareSolverr(DownloadProgress("FlareSolverr"), lifetime.Token);
        var address = settings.Mode == "compose" && settings.ManagedProwlarr ? "http://flaresolverr:8191/" : "http://127.0.0.1:8191/";
        Report(T("FlareSolverr: проверяем доступ к RuTracker и сохраняем прокси…", "FlareSolverr: checking RuTracker access and saving proxy…"));
        var tag = await client.ConfigureFlareSolverr(address, lifetime.Token, "http://127.0.0.1:8191/");
        if (client.UsedTrackerFallback && showNotice)
            MessageBox.Show(this, T("Cloudflare блокирует проверочный сайт Prowlarr. Главная страница RuTracker открывается через FlareSolverr, прокси сохранён. Далее требуется проверка входа и поиска: на этих страницах может появиться отдельная проверка Cloudflare.", "Cloudflare blocks the Prowlarr test site. The RuTracker homepage opens through FlareSolverr and the proxy has been saved. Authentication and search still need to be tested: those pages may require a separate Cloudflare challenge."), "PackageFlow", MessageBoxButtons.OK, MessageBoxIcon.Information);
        else if (client.UsedTrackerFallback) Report(T("FlareSolverr: RuTracker доступен, прокси сохранён; проверочный сайт Prowlarr заблокирован.", "FlareSolverr: RuTracker is reachable and the proxy is saved; Prowlarr's test site is blocked."));
        return tag;
    }
    private sealed record Indexer(int Id, string Name) { public override string ToString() => Name; }
    private ProwlarrClient Client()
    {
        var key = prowlarrKey.Text.Trim();
        if (key.Length == 0) key = LocalSecrets.Read(settings.ProtectedProwlarrKey);
        if (key.Length == 0) throw new ArgumentException(T("Укажите API-ключ из Settings → General в Prowlarr.", "Enter the API key from Settings → General in Prowlarr."));
        return new(http, prowlarrUrl.Text, key);
    }
    private async Task LoadIndexers()
    {
        Report(T("Prowlarr: проверяем API и получаем индексаторы…", "Prowlarr: checking API and loading indexers…"));
        var items = await Client().Indexers(lifetime.Token);
        SaveProwlarr();
        indexers.Items.Clear(); foreach (var item in items) indexers.Items.Add(new Indexer(item.Id, item.Name));
        if (indexers.Items.Count > 0) indexers.SelectedIndex = 0;
        var tracker = items.FirstOrDefault(i => i.Name.Contains("rutracker", StringComparison.OrdinalIgnoreCase));
        if (tracker.Id > 0) await RestoreTracker(Client(), tracker.Id, lifetime.Token);
    }
    private void SaveProwlarr()
    {
        settings.ProwlarrUrl = ProwlarrClient.ValidateAddress(prowlarrUrl.Text).ToString().TrimEnd('/');
        if (prowlarrKey.Text.Trim().Length > 0) settings.ProtectedProwlarrKey = LocalSecrets.Protect(prowlarrKey.Text.Trim());
        settings.Save(ServerHost.SettingsPath);
        if (prowlarrKey.Text.Length == 0) prowlarrKey.Text = LocalSecrets.Read(settings.ProtectedProwlarrKey);
    }
    private async Task ConnectIndexer(ProwlarrClient client, int id)
    {
        var uri = new Uri(settings.ProwlarrUrl);
        var serverAddress = settings.Mode == "compose" && settings.ManagedProwlarr && uri.IsLoopback ? "http://prowlarr:9696" : settings.Mode == "compose" && uri.IsLoopback ? new UriBuilder(uri) { Host = "host.docker.internal" }.Uri.ToString() : settings.ProwlarrUrl;
        var connection = client.Connection(id, serverAddress);
        await host.Api("/api/search/settings", new { name = "RuTracker / Torznab", endpoint = connection.Endpoint, apiKey = connection.ApiKey, categories = "1180" }, lifetime.Token);
        Report(T("Поиск: проверяем результаты через WEB…", "Search: checking results through WEB…"));
        await host.Api("/api/search?q=PS4&offset=0&limit=1", ct: lifetime.Token);
        MessageBox.Show(this, T("Поиск подключён. Результаты доступны в PackageFlow.", "Search connected. Results are available in PackageFlow."), "PackageFlow");
    }

    private void TorrentPage()
    {
        var page = Page(T("4. Загрузки", "4. Downloads"), T("Подключите qBittorrent с включённым Web UI. Можно использовать уже установленный клиент или установить его с официального сайта. Для первого теста загрузки необязательны.", "Connect qBittorrent with Web UI enabled. Use your existing client or install it from the official website. Downloads are optional for the first test."));
        var address = torrentAddress = Field(page, T("Адрес Web UI", "Web UI address"), "http://127.0.0.1:8080");
        var user = torrentUser = Field(page, T("Логин Web UI", "Web UI username"));
        var password = torrentPassword = Field(page, T("Пароль Web UI", "Web UI password"), secret: true);
        var remote = torrentFolder = FolderField(page, T("Папка загрузок, как её видит qBittorrent", "Download folder as seen by qBittorrent"), settings.GamesDirectory);
        Buttons(page,
            (T("Применить", "Apply"), async () =>
            {
                EnsureStarted();
                var baseUrl = ProwlarrClient.ValidateAddress(address.Text).ToString().TrimEnd('/');
                if (settings.Mode == "compose" && new Uri(baseUrl).IsLoopback) baseUrl = new UriBuilder(baseUrl) { Host = "host.docker.internal" }.Uri.ToString().TrimEnd('/');
                await host.Api("/api/torrents/settings", new { baseUrl, username = user.Text.Trim(), password = password.Text, downloadPath = settings.Mode == "compose" ? "/games" : settings.GamesDirectory, remotePath = remote.Text }, lifetime.Token);
            }),
            (T("Скачать qBittorrent", "Download qBittorrent"), () => { ProcessRunner.Open("https://www.qbittorrent.org/download"); return Task.CompletedTask; }),
            (T("Завершить настройку", "Finish setup"), () =>
            {
                EnsureStarted(); settings.SetupComplete = true; settings.Save(ServerHost.SettingsPath); OpenWeb(); Hide(); return Task.CompletedTask;
            }));
    }

    private void UpdatePage()
    {
        var page = Page(T("Обновление", "Updates"), T("Обновление Windows-приложения проверяется в GitHub Releases. Настройки и библиотека сохраняются. Активные или непроверенные операции блокируют остановку. Обновление службы PS4 остаётся в WEB и на приставке.", "Windows updates are checked in GitHub Releases. Settings and library are preserved. Active or unverified operations prevent stopping. PS4 service updates remain in WEB and on the console."));
        page.Controls.Add(new Label { Text = T("Версия Windows-приложения: ", "Windows application version: ") + CurrentVersion(), AutoSize = true });
        Buttons(page,
            (T("Проверить обновления", "Check updates"), async () =>
            {
                var release = await ReleaseDownloads.LatestWindows(http, lifetime.Token);
                if (release == null) { MessageBox.Show(this, T("Windows-установщик пока не опубликован в стабильных релизах.", "Stable releases do not contain a Windows installer yet."), "PackageFlow"); return; }
                if (!Version.TryParse(release.Version.TrimStart('v'), out var target) || target <= CurrentVersion())
                { MessageBox.Show(this, T("Новая версия не найдена.", "No newer version available."), "PackageFlow"); return; }
                if (MessageBox.Show(this, T($"Доступна {release.Version}. Скачать и установить?", $"{release.Version} is available. Download and install?"), "PackageFlow", MessageBoxButtons.YesNo) != DialogResult.Yes) return;
                var destination = Path.Combine(Program.UserDirectory, "downloads", release.Name);
                await ReleaseDownloads.Download(http, release, destination, DownloadProgress(T("Обновление", "Update")), lifetime.Token);
                await host.Stop(lifetime.Token);
                ProcessRunner.Open(destination);
                // The installer requests shutdown through the local pipe before replacing files.
            }),
            (T("Открыть папку данных", "Open data folder"), () => { Directory.CreateDirectory(ServerHost.DataDirectory); ProcessRunner.Open(ServerHost.DataDirectory); return Task.CompletedTask; }));
    }
    private Version CurrentVersion() => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 1, 0);
    private void EnsureStarted() { if (!host.Started) throw new InvalidOperationException(T("Сначала запустите PackageFlow на вкладке установки.", "Start PackageFlow on the installation tab first.")); }
    private async Task Exit() { await host.Stop(lifetime.Token); exiting = true; lifetime.Cancel(); tray.Visible = false; Close(); }
    private void ShowWindow() { Show(); if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Maximized; Activate(); }

    private async Task Listen()
    {
        while (!lifetime.IsCancellationRequested)
        {
            try
            {
                await using var pipe = new NamedPipeServerStream(Program.PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(lifetime.Token);
                using var reader = new StreamReader(pipe, leaveOpen: true);
                using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
                var command = await reader.ReadLineAsync(lifetime.Token);
                if (command == "show") { ShowWindow(); await writer.WriteLineAsync("ok"); }
                else if (command == "prepare-update" && !busy)
                {
                    try { await healthWork; await host.Stop(lifetime.Token); await writer.WriteLineAsync("ok"); exiting = true; BeginInvoke(() => { tray.Visible = false; Close(); }); return; }
                    catch { await writer.WriteLineAsync("busy"); }
                }
                else await writer.WriteLineAsync("busy");
            }
            catch (OperationCanceledException) { return; }
            catch { if (!lifetime.IsCancellationRequested) await Task.Delay(500); }
        }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { healthTimer.Dispose(); lifetime.Cancel(); tray.Dispose(); tips.Dispose(); http.Dispose(); lifetime.Dispose(); }
        base.Dispose(disposing);
    }
}
