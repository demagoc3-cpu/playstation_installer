using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed class FirstLaunchWizard : Form
{
    private readonly LauncherSettings settings;
    private readonly Func<Task<string[]>> selectConsoles;
    private readonly PageHost pages = new() { Dock = DockStyle.Fill };
    private readonly CheckBox consoles = new(), torrents = new();
    private readonly TextBox username = new(), password = new();
    private readonly Label selection = new(), summary = new(), consoleReview = new(), torrentReview = new();
    private readonly WizardHeader steps;
    private readonly RoundedButton next = new(), back = new(), skipTorrents = new();
    public bool ManualLoginRequested {get;private set;}
    private bool choosing;
    public bool TorrentSelected => torrents.Checked;
    public string TrackerUsername => username.Text.Trim();
    public string TrackerPassword => password.Text;
    public string[] ConsoleIds { get; private set; } = [];
    private string T(string ru, string en) => settings.Language == "en" ? en : ru;
    public FirstLaunchWizard(LauncherSettings settings, Func<Task<string[]>> selectConsoles)
    {
        this.settings = settings; this.selectConsoles = selectConsoles; Icon = GlassStyle.BrandIcon();
        steps = new WizardHeader(settings.Language) { Dock = DockStyle.Top, Height = 100 };
        Text = T("PackageFlow · Первая настройка", "PackageFlow · First setup");
        Font = new Font("Segoe UI", 11); ForeColor = Color.White; BackColor = Theme.Background;
        AutoScaleMode = AutoScaleMode.Dpi; StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(1040, 680); MinimumSize = new Size(880, 600);
        DoubleBuffered = true;
        var footer = new BufferedFlow { Dock = DockStyle.Bottom, Height = 78, Padding = new Padding(24, 12, 24, 12), FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
        next.Size = new Size(220, 46); next.BackColor = Theme.Accent; next.ForeColor = Color.White;
        back.Size = new Size(140, 46); back.BackColor = Theme.Card; back.ForeColor = Color.White; back.Text = T("Назад", "Back");
        var cancel = new RoundedButton { Text = T("Позже", "Later"), Size = new Size(140, 46), BackColor = Theme.Card, ForeColor = Color.White };
        cancel.Click += (_, _) => { if (!choosing) { DialogResult = DialogResult.Cancel; Close(); } };
        next.Click += (_, _) => Advance(); back.Click += (_, _) => {
            var target = pages.SelectedIndex - 1;
            if (target == 2 && !torrents.Checked) target--;
            if (target == 1 && !consoles.Checked) target--;
            pages.SelectedIndex = target; RenderStep();
        };
        skipTorrents.Text=T("Пропустить торренты","Skip torrents");skipTorrents.Size=new Size(190,46);skipTorrents.BackColor=Theme.Card;skipTorrents.ForeColor=Color.White;
        skipTorrents.Click+=(_,_)=>{torrents.Checked=false;Advance();};
        footer.Controls.Add(next);footer.Controls.Add(skipTorrents);footer.Controls.Add(back);footer.Controls.Add(cancel);
        Controls.Add(pages); Controls.Add(steps); Controls.Add(footer);
        var choices = StepPanel(T("Что настроить?", "What would you like to set up?"), T("Выберите нужные компоненты. Настройки можно изменить позже.", "Select the components you need. You can change these settings later."));
        consoles.Checked = true; torrents.Checked = settings.TorrentSetupSelected;
        var choicesRow = new BufferedTable { Height = 264, ColumnCount = 2, RowCount = 1, Margin = new Padding(0, 0, 0, 10) };
        choicesRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); choicesRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        choicesRow.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        choicesRow.Controls.Add(ChoiceCard(consoles, T("Найти PlayStation", "Find PlayStation"), T("Найти PS4 и PS5 в сети и установить\nслужбу и приложение", "Find PS4 and PS5 and install\nthe service and application"), 1),0,0);
        choicesRow.Controls.Add(ChoiceCard(torrents, T("Торренты и поиск", "Torrents and search"), "RuTracker · qBittorrent\nProwlarr · FlareSolverr", 5),1,0);
        choices.Controls.Add(choicesRow);
        choices.Controls.Add(Note(T("Без выбора торрентов связанные компоненты и Chromium не устанавливаются.", "If you skip torrents, their components and Chromium are not installed.")));
        var ps = StepPanel(T("Выберите ваши приставки", "Select your consoles"), T("Найдите PS4 и PS5, отметьте нужные и нажмите ОК. Установка начнётся после подтверждения мастера.", "Find PS4 and PS5, check the devices you want and click OK. Installation starts after the wizard confirmation."));
        selection.Text = T("Приставки ещё не выбраны", "No consoles selected"); selection.ForeColor = Theme.Muted; selection.Height = 44; selection.Dock = DockStyle.Top;
        var findCard = new RoundedPanel { Height = 190, Width = 930, Padding = new Padding(22) };
        findCard.Controls.Add(selection);
        var find = new RoundedButton { Text = T("Найти и выбрать PS4 / PS5", "Find and select PS4 / PS5"), Glyph = 2, Height = 52, Dock = DockStyle.Bottom, BackColor = Theme.Accent, ForeColor = Color.White };
        find.Click += async (_, _) => {
            if (choosing) return; choosing = true; next.Enabled = back.Enabled = find.Enabled = false;
            try { ConsoleIds = await selectConsoles(); selection.Text = T($"Выбрано приставок: {ConsoleIds.Length}", $"Selected consoles: {ConsoleIds.Length}"); }
            catch (Exception error) { selection.Text = error.Message; }
            finally { choosing = false; if (!IsDisposed) next.Enabled = back.Enabled = find.Enabled = true; }
        };
        findCard.Controls.Add(find); ps.Controls.Add(findCard); findCard.BringToFront();
        var tracker = StepPanel(T("RuTracker и торренты", "RuTracker and torrents"), T("Введите данные RuTracker. Пароль хранится защищённым для вашей учётной записи Windows. Можно оставить поля пустыми и войти позже в «Поиске».", "Enter your RuTracker credentials. The password is protected for your Windows account. You can leave the fields blank and sign in later in Search."));
        username.Text = settings.TrackerUsername; password.Text = LocalSecrets.Read(settings.ProtectedTrackerPassword); password.UseSystemPasswordChar = true;
        InputCard(tracker, T("Логин RuTracker", "RuTracker username"), username);
        InputCard(tracker, T("Пароль RuTracker", "RuTracker password"), password);
        var reveal = new CheckBox { Text = T("Показать пароль", "Show password"), AutoSize = true, ForeColor = Theme.Muted, BackColor = Color.Transparent, Margin = new Padding(4, 14, 4, 14) };
        reveal.CheckedChanged += (_, _) => password.UseSystemPasswordChar = !reveal.Checked; tracker.Controls.Add(reveal);
        var browser=new RoundedButton {Text=T("Войти через браузер","Sign in through browser"),Glyph=0,Height=40,Width=290,BackColor=Theme.Card,ForeColor=Color.White};
        browser.Click+=(_,_)=>{ManualLoginRequested=true;browser.Text=T("Вход откроется после настройки","Sign-in opens after setup");};tracker.Controls.Add(browser);
        tracker.Controls.Add(Note(T("Будут установлены qBittorrent, Prowlarr и FlareSolverr. Если потребуется проверка сайта, ручной вход доступен в разделе «Поиск».", "qBittorrent, Prowlarr and FlareSolverr will be installed. If the site requests verification, manual sign-in is available in Search.")));
        var review = StepPanel(T("Всё готово к настройке", "Ready to set up"), T("Проверьте выбранные компоненты перед установкой.", "Review your selected components before installation."));
        var reviewRow=new BufferedTable {Height=105,ColumnCount=2,RowCount=1,Margin=new Padding(0,0,0,14)};
        reviewRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));reviewRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));reviewRow.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        foreach(var (label,column) in new[]{(consoleReview,0),(torrentReview,1)}) {
            var tile=new RoundedPanel {Dock=DockStyle.Fill,Padding=new Padding(18),Margin=new Padding(5,0,5,0)};
            label.Dock=DockStyle.Fill;label.Font=new Font("Segoe UI",13,FontStyle.Bold);tile.Controls.Add(label);reviewRow.Controls.Add(tile,column,0);
        }
        review.Controls.Add(reviewRow);
        summary.Dock = DockStyle.Fill; summary.Font = new Font("Segoe UI", 13); summary.BackColor = Color.Transparent;
        var reviewCard = new RoundedPanel { Width = 930, Height = 208, Padding = new Padding(22) }; reviewCard.Controls.Add(summary); review.Controls.Add(reviewCard);
        GlassStyle.TransparentLabels(this); RenderStep();
        FormClosing += (_, e) => { if (choosing) e.Cancel = true; };
    }
    private FlowLayoutPanel StepPanel(string title, string description)
    {
        var page = new BufferedPanel { Dock = DockStyle.Fill, Padding = new Padding(28, 12, 28, 12) };
        var header = new BufferedPanel { Dock = DockStyle.Top, Height = 105 };
        header.Controls.Add(new Label { Text = title, Dock = DockStyle.Top, Height = 47, Font = new Font("Segoe UI", 22, FontStyle.Bold), TextAlign = ContentAlignment.MiddleCenter });
        header.Controls.Add(new Label { Text = description, Dock = DockStyle.Bottom, Height = 52, ForeColor = Theme.Muted, TextAlign = ContentAlignment.MiddleCenter });
        var body = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, BackColor = Color.Transparent };
        void Fit() { foreach (Control child in body.Controls) if (child is not CheckBox) {
            var available=Math.Max(300,body.ClientSize.Width-26);
            child.Width=child.Tag as string=="compact"?Math.Min(620,available):available;
            if(child.Tag as string=="compact")child.Margin=new Padding(Math.Max(0,(available-child.Width)/2),child.Margin.Top,0,child.Margin.Bottom);
        } }
        body.SizeChanged += (_, _) => Fit(); body.ControlAdded += (_, _) => Fit();
        page.Controls.Add(body); page.Controls.Add(header); pages.TabPages.Add(page); return body;
    }
    private static Label Note(string text) => new() { Text = text, Height = 78, ForeColor = Theme.Muted, Padding = new Padding(8, 14, 8, 4), BackColor = Color.Transparent };
    private RoundedPanel ChoiceCard(CheckBox choice, string title, string detail, int icon)
    {
        var card = new RoundedPanel { Dock = DockStyle.Fill, Padding = new Padding(18), Margin = new Padding(6, 0, 6, 0), Cursor = Cursors.Hand };
        choice.Text = title; choice.Font = new Font("Segoe UI", 16, FontStyle.Bold); choice.Dock = DockStyle.Bottom; choice.Height = 40; choice.BackColor = Color.Transparent;
        var caption = new Label { Text = detail, Dock = DockStyle.Bottom, Height = 54, ForeColor = Theme.Muted, BackColor = Color.Transparent, TextAlign = ContentAlignment.MiddleCenter };
        var art = new SetupArtwork(icon) { Dock = DockStyle.Fill };
        card.Controls.Add(art); card.Controls.Add(choice); card.Controls.Add(caption);
        void Toggle() { choice.Checked = !choice.Checked; choice.Focus(); card.Invalidate(); }
        card.Click += (_, _) => Toggle(); caption.Click += (_, _) => Toggle(); art.Click += (_, _) => Toggle();
        choice.CheckedChanged += (_, _) => card.Invalidate();
        card.Paint += (_, e) => { if (choice.Checked && card.Width>8 && card.Height>8) { using var pen = new Pen(Color.FromArgb(90,215,255),1.5f); using var path=Theme.Shape(new Rectangle(2,2,card.Width-5,card.Height-5),14); e.Graphics.DrawPath(pen,path); } };
        return card;
    }
    private static void InputCard(Control parent, string text, TextBox input)
    {
        var card = new RoundedPanel { Tag="compact", Height = 78, Padding = new Padding(18, 12, 18, 12), Margin = new Padding(0, 0, 0, 12) };
        card.Controls.Add(new Label { Text = text, Dock = DockStyle.Top, Height = 26, ForeColor = Theme.Muted });
        input.Dock = DockStyle.Bottom; input.BorderStyle = BorderStyle.None; input.BackColor = Theme.Input; input.ForeColor = Color.White; card.Controls.Add(input); parent.Controls.Add(card);
    }
    private void Advance()
    {
        if (choosing) return;
        if (pages.SelectedIndex == 3) { DialogResult = DialogResult.OK; Close(); return; }
        var target = pages.SelectedIndex + 1;
        if (target == 1 && !consoles.Checked) target++;
        if (target == 2 && !torrents.Checked) target++;
        pages.SelectedIndex = target; RenderStep();
    }
    internal void RenderStep()
    {
        var step = pages.SelectedIndex; back.Visible = step > 0; skipTorrents.Visible=step==2;
        steps.Step = step; steps.Invalidate();
        next.Text = step == 3 ? T("Настроить PackageFlow", "Set up PackageFlow") : T("Далее", "Next");
        consoleReview.Text=T($"PlayStation · выбрано {ConsoleIds.Length}",$"PlayStation · {ConsoleIds.Length} selected");
        torrentReview.Text=torrents.Checked?T("Торренты и поиск · включены","Torrents and search · enabled"):T("Торренты · пропустить","Torrents · skipped");
        summary.Text = T("Локальный WEB: установить и запустить", "Local WEB: install and start") + "\n\n" +
            (consoles.Checked ? T($"PS4 / PS5: {ConsoleIds.Length} · установить / обновить", $"PS4 / PS5: {ConsoleIds.Length} · install / update") : T("Приставки: настроить позже", "Consoles: set up later")) + "\n\n" +
            (torrents.Checked ? "qBittorrent · Prowlarr · FlareSolverr" : T("Торренты и Chromium: пропустить", "Torrents and Chromium: skip"));
        if (!consoles.Checked) ConsoleIds = [];
    }
    protected override void OnPaintBackground(PaintEventArgs e) => GlassStyle.Paint(this, e, 110);
}
