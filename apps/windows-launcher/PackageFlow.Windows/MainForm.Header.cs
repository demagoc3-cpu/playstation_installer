using System.Reflection;
using System.Text.Json;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private GithubProjectStats? githubStats;
    private DateTime githubChecked;
    private bool checkingGithub, loadedGithubCache;
    private RoundedButton githubVersion = null!, githubStars = null!;
    private readonly ToolTip tips = new();
    private static Image Logo(string name) {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PackageFlow.Assets." + name)!;
        using var original = Image.FromStream(stream); return new Bitmap(original);
    }
    private Control BuildHeader()
    {
        var header = new BufferedTable { Dock = DockStyle.Top, Height = 72, Padding = new Padding(20, 6, 20, 6), ColumnCount = 2, RowCount = 1 };
        header.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 530));
        var brand = new BufferedPanel { Dock = DockStyle.Fill, Margin = Padding.Empty };
        brand.Controls.Add(new PictureBox { Image = Icon?.ToBitmap(), SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(48, 48), Location = new Point(0, 5) });
        var title = new Label { Text = "PackageFlow", Font = new Font("Segoe UI", 23, FontStyle.Bold), Location = new Point(65, 0), Height = 40, Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
        var caption = new Label { Text = T("Установка • Подключение • Управление", "Install • Connect • Manage"), Font = new Font("Segoe UI", 9), Location = new Point(68, 40), Height = 20 };
        brand.Controls.Add(title); brand.Controls.Add(caption);
        brand.SizeChanged += (_, _) => { title.Width = Math.Max(1, brand.ClientSize.Width - 65); caption.Width = Math.Max(1, brand.ClientSize.Width - 68); };
        var links = new BufferedFlow { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Padding = new Padding(0, 14, 0, 0), Margin = Padding.Empty };
        void Add(Control control) { control.Margin = new Padding(6, 0, 0, 0); links.Controls.Add(control); }
        foreach (var link in new[] { (Name: "4PDA", Image: "4pda.png", Url: "https://4pda.to/forum/index.php?showtopic=1127073"), (Name: "GitHub", Image: "github.png", Url: "https://github.com/" + GithubProject.Repository) }) {
            var button = new LogoButton { Logo = Logo(link.Image), AccessibleName = link.Name, AccessibleDescription = link.Url, Width = 100, Height = 34, BackColor = link.Name == "4PDA" ? Color.White : Theme.Card, ForeColor = Color.White };
            button.Click += (_, _) => ProcessRunner.Open(link.Url); tips.SetToolTip(button, link.Name); Add(button);
        }
        githubVersion = new RoundedButton { Text = "WEB —", Width = 100, Height = 34, Font = new Font("Segoe UI", 9), BackColor = Theme.Card, ForeColor = Theme.Muted, AccessibleName = T("Версия WEB на GitHub", "WEB version on GitHub") };
        githubVersion.Click += (_, _) => ProcessRunner.Open("https://github.com/" + GithubProject.Repository + "/tags"); Add(githubVersion);
        githubStars = new RoundedButton { Text = "★ —", Width = 70, Height = 34, Font = new Font("Segoe UI", 9), BackColor = Theme.Card, ForeColor = Theme.Muted, AccessibleName = T("Звёзды GitHub", "GitHub stars") };
        githubStars.Click += (_, _) => ProcessRunner.Open("https://github.com/" + GithubProject.Repository + "/stargazers"); Add(githubStars);
        language = new DarkChoice { Width = 125, Height = 34, BackColor = Theme.Card, ForeColor = Color.White, AccessibleName = T("Язык", "Language") };
        language.Items.AddRange(["Русский", "English"]); language.SelectedIndex = settings.Language == "en" ? 1 : 0;
        language.SelectedIndexChanged += (_, _) => { settings.Language = language.SelectedIndex == 1 ? "en" : "ru"; if (!preview) SaveLanguage(); Build(); }; Add(language);
        header.Controls.Add(brand, 0, 0); header.Controls.Add(links, 1, 0);
        if (!loadedGithubCache && !preview) {
            loadedGithubCache = true;
            try { githubStats = JsonSerializer.Deserialize<GithubProjectStats>(File.ReadAllText(Path.Combine(Program.UserDirectory, "github-project.json"))); } catch { }
        }
        ShowGithubStats();
        return header;
    }
    private void ShowGithubStats()
    {
        if (githubVersion.IsDisposed) return;
        githubVersion.Text = "WEB " + (githubStats?.Version ?? "—");
        githubStars.Text = "★ " + (githubStats?.Stars.ToString() ?? "—");
        var note = githubStats == null ? T("GitHub: ожидаем загрузку данных", "GitHub: waiting for data") : T("Данные GitHub • ", "GitHub data • ") + githubStats.UpdatedUtc.ToLocalTime().ToString("g");
        tips.SetToolTip(githubVersion, note); tips.SetToolTip(githubStars, note);
    }
    private async Task RefreshGithub()
    {
        if (preview || checkingGithub || (githubStats != null && DateTime.UtcNow - githubStats.UpdatedUtc < TimeSpan.FromHours(1)) || DateTime.UtcNow - githubChecked < TimeSpan.FromMinutes(5)) return;
        checkingGithub = true; githubChecked = DateTime.UtcNow;
        try {
            using var ct = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); ct.CancelAfter(TimeSpan.FromSeconds(8));
            githubStats = await GithubProject.Read(http, ct.Token);
            if (IsDisposed) return;
            ShowGithubStats();
            try { Directory.CreateDirectory(Program.UserDirectory); File.WriteAllText(Path.Combine(Program.UserDirectory, "github-project.json"), JsonSerializer.Serialize(githubStats)); } catch { }
        } catch { /* Retain cached values while GitHub or the network is unavailable. */ }
        finally { checkingGithub = false; }
    }
}
