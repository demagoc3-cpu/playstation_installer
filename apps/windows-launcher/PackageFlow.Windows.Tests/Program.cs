using System.Reflection;
using System.Runtime.InteropServices;
using PackageFlow.Core;
using PackageFlow.Windows;

internal static class Smoke
{
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static T Field<T>(object owner, string name) => (T)owner.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(owner)!;
    private static void Pump() { for (var i = 0; i < 5; i++) { Application.DoEvents(); Thread.Sleep(15); } }
    private static void Select(DarkChoice choice, int index)
    {
        typeof(DarkChoice).GetMethod("OnClick", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(choice, [EventArgs.Empty]);
        Pump();
        var menu = Field<ContextMenuStrip>(choice, "menu");
        Check(menu.Visible && !menu.IsDisposed, "Dropdown must open.");
        var bounds = menu.Items[index].Bounds;
        var point = (bounds.Top + bounds.Height / 2) << 16 | (bounds.Left + bounds.Width / 2);
        SendMessage(menu.Handle, 0x201, (IntPtr)1, (IntPtr)point);
        SendMessage(menu.Handle, 0x202, IntPtr.Zero, (IntPtr)point);
        Pump();
    }
    private static IEnumerable<Control> Descendants(Control root) {
        foreach (Control child in root.Controls) { yield return child; foreach (var nested in Descendants(child)) yield return nested; }
    }
    [STAThread] private static int Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var report = args.FirstOrDefault() ?? Path.Combine(Path.GetTempPath(), "PackageFlow-ui-tests.txt");
        if (args.Contains("--qbittorrent")) {
            try { QbittorrentTests.Run(report).GetAwaiter().GetResult(); return 0; }
            catch (Exception error) { File.WriteAllText(report, "FAIL: " + error); return 1; }
        }
        var lines = new List<string>();
        var testFolder = Path.Combine(Path.GetTempPath(), "PackageFlow-ui-" + Guid.NewGuid());
        Directory.CreateDirectory(testFolder);
        try {
            var settings = new LauncherSettings { Language = "ru", GamesDirectory = testFolder, TrackerUsername = "fixture-user", ProtectedTrackerPassword = LocalSecrets.Protect("fixture-password") };
            using var form = new MainForm(false, settings) { WindowState = FormWindowState.Normal };
            form.Show(); Pump();
            using (var surface = new Bitmap(80, 80)) {
                using var graphics = Graphics.FromImage(surface); graphics.Clear(Color.Magenta);
                Theme.Clear(new PaintEventArgs(graphics, new Rectangle(20, 20, 10, 10)), Theme.Background);
                Check(surface.GetPixel(5, 5).ToArgb() == Color.Magenta.ToArgb() && surface.GetPixel(25, 25).ToArgb() == Theme.Background.ToArgb(), "Partial repaint must not erase pixels outside the invalid region.");
            }
            lines.Add("PASS: partial repaint respects the invalid region.");
            for (var i = 0; i < 20; i++) {
                var choice = Field<DarkChoice>(form, "mode"); Select(choice, i % 2);
                Check(choice.SelectedIndex == i % 2, "Dropdown selection must survive its close event.");
            }
            lines.Add("PASS: 20 dropdown selections through native mouse messages.");
            var trackerUser = Field<TextBox>(form, "trackerUser");
            var password = Field<TextBox>(form, "trackerPassword");
            Check(trackerUser.Text == "fixture-user" && password.Text == "fixture-password" && password.UseSystemPasswordChar, "Saved tracker fields must load masked.");
            trackerUser.Text = "edited-user"; password.Text = "edited-password";
            for (var i = 0; i < 4; i++) {
                Select(Field<DarkChoice>(form, "language"), i % 2);
                Check(Field<TextBox>(form, "trackerUser").Text == "edited-user", "Language rebuild lost username.");
                Check(Field<TextBox>(form, "trackerPassword").Text == "edited-password", "Language rebuild lost password.");
            }
            lines.Add("PASS: language menu rebuild preserves entered tracker fields.");
            Select(Field<DarkChoice>(form, "language"), 0);
            var tabs = Field<PageHost>(form, "tabs"); tabs.SelectedIndex = 2; Pump();
            password = Field<TextBox>(form, "trackerPassword");
            var reveal = password.Parent!.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<CheckBox>()).Single();
            reveal.Checked = true; Check(!password.UseSystemPasswordChar, "Show password did not reveal input.");
            reveal.Checked = false; Check(password.UseSystemPasswordChar, "Show password did not remask input.");
            lines.Add("PASS: password reveal/remask.");
            foreach (var size in new[] { new Size(964, 721), new Size(964, 820), new Size(1280, 760), new Size(1880, 940) }) {
                form.ClientSize = size; tabs.SelectedIndex = 0; Pump();
                var page = tabs.TabPages[0];
                var flow = page.Controls.OfType<CardFlow>().Single();
                Check(flow.Controls.Cast<Control>().All(c => c.Top >= 0 && c.Bottom + c.Margin.Bottom <= flow.ClientSize.Height && c.Right <= flow.ClientSize.Width), "Installation requires scrolling at " + size);
                foreach (Control eachPage in tabs.TabPages) {
                    tabs.SelectedIndex = tabs.TabPages.IndexOf(eachPage); Pump();
                    foreach (var label in Descendants(eachPage).OfType<Label>().Where(l => l.Visible && l.Text.Length > 0)) {
                        var needed = label.GetPreferredSize(new Size(label.ClientSize.Width, 0));
                        Check(needed.Height <= label.ClientSize.Height, "Text is clipped: " + label.Text + " at " + size + " needs " + needed.Height + " has " + label.ClientSize.Height);
                    }
                    var footer = eachPage.Controls.OfType<TableLayoutPanel>().Single(p => p.Dock == DockStyle.Bottom);
                    var buttons = footer.Controls.OfType<Button>().ToArray();
                    Check(buttons.Select(b => b.Top).Distinct().Count() <= 1 && buttons.All(b => b.Bottom <= footer.ClientSize.Height && b.Right <= footer.ClientSize.Width), "Buttons must fit one row.");
                }
                foreach (var card in Field<Dictionary<string, StatusCard>>(form, "healthCards").Values) {
                    Check(card.Left >= 0 && card.Right <= card.Parent!.ClientSize.Width && card.Bottom <= card.Parent.ClientSize.Height, "Status cards must fit after shrinking the window.");
                }
                lines.Add("PASS: installation fits and actions stay in one row at " + size.Width + "x" + size.Height + ".");
            }
            var cards = Field<Dictionary<string, StatusCard>>(form, "healthCards");
            Check(cards.Values.All(c => c.Controls.Cast<Control>().All(label => label.Top >= 0 && label.Bottom <= c.ClientSize.Height)), "Status card text must fit inside the card.");
            Check(cards.Keys.SequenceEqual(new[] { "WEB", "Pairing", "qBittorrent", "Prowlarr", "FlareSolverr" }), "Pairing card must follow WEB.");
            Check(Field<TextBox>(form, "torrentFolder").Parent!.Controls.OfType<Button>().Any(), "qBittorrent folder picker missing.");
            Check(Descendants(form).OfType<LogoButton>().Count() == 2, "Both header links need logos.");
            var actions = tabs.TabPages[0].Controls.OfType<TableLayoutPanel>().Single(p => p.Dock == DockStyle.Bottom);
            Check(actions.Controls.OfType<Button>().Any(b => b.Text == "Применить"), "Settings need an Apply button.");
            lines.Add("PASS: pairing card ordering, header logos, Apply button and folder picker.");
            form.ClientSize = new Size(1100, 780); form.Location = new Point(25, 25); Pump();
            foreach (var pageIndex in new[] { 0, 1, 2 }) {
                tabs.SelectedIndex = pageIndex; Pump();
                for (var i = 0; i < 12; i++) { form.Location = new Point(25 + i % 3 * 30, 25 + i % 2 * 18); Pump(); }
                form.Location = new Point(25, 25); Pump();
                using var moved = new Bitmap(form.ClientSize.Width, form.ClientSize.Height);
                using (var graphics = Graphics.FromImage(moved)) graphics.CopyFromScreen(form.PointToScreen(Point.Empty), Point.Empty, moved.Size);
                form.Invalidate(true); form.Update(); Pump();
                using var repainted = new Bitmap(moved.Width, moved.Height);
                using (var graphics = Graphics.FromImage(repainted)) graphics.CopyFromScreen(form.PointToScreen(Point.Empty), Point.Empty, repainted.Size);
                var different = 0;
                for (var y = 0; y < moved.Height; y += 3) for (var x = 0; x < moved.Width; x += 3) if (moved.GetPixel(x, y) != repainted.GetPixel(x, y)) different++;
                Check(different < 30, "Window movement left stale pixels on page " + pageIndex + ": " + different);
            }
            lines.Add("PASS: moved windows match a full repaint on Installation, PS4 and Search.");
            settings.Save(Path.Combine(testFolder, "settings.json"));
            var stored = LauncherSettings.Load(Path.Combine(testFolder, "settings.json"));
            Check(!File.ReadAllText(Path.Combine(testFolder, "settings.json")).Contains("fixture-password") && LocalSecrets.Read(stored.ProtectedTrackerPassword) == "fixture-password", "Saved password must use Windows account protection.");
            lines.Add("PASS: saved password survives restart with Windows protection.");
            tabs.SelectedIndex = 0; form.ClientSize = new Size(1280, 720); Pump();
            using var bitmap = new Bitmap(form.Width, form.Height); form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
            bitmap.Save(Path.ChangeExtension(report, ".png"));
            File.WriteAllLines(report, lines); return 0;
        } catch (Exception error) { lines.Add("FAIL: " + error); File.WriteAllLines(report, lines); return 1; }
        finally { Directory.Delete(testFolder, true); }
    }
}
