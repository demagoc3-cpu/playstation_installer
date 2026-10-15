using System.Reflection;
using PackageFlow.Core;
using PackageFlow.Windows;

internal static class GlassWizardTests
{
    static T Field<T>(object value, string name) => (T)value.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(value)!;
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    public static void Run(MainForm main, Action pump, string report)
    {
        var nav = Field<FlowLayoutPanel>(main, "navigation");
        Check(nav.Controls.OfType<Button>().Select(b => b.Text).SequenceEqual(new[] { "Главная", "Приставки", "Поиск", "Обновления", "Поддержать проект" }), "Launcher must expose the five approved sections without Downloads.");
        var tray = Field<NotifyIcon>(main, "tray");
        Check(tray.ContextMenuStrip!.Items.OfType<ToolStripMenuItem>().Any(i => i.Text == "Автозапуск с Windows"), "Tray needs the Windows autostart checkbox.");
        using (var warning = new StopWarningForm("ru")) {
            Check(warning.AcceptButton == warning.CancelButton && warning.CancelButton!.DialogResult == DialogResult.Cancel, "Enter and Escape must both preserve active tasks by default.");
            File.AppendAllText(report,"RUNNING: showing stop warning\n");
            warning.Show(main); pump(); File.AppendAllText(report,"RUNNING: drawing stop warning\n"); Save(warning, Path.ChangeExtension(report, "stop-warning.png")); warning.Close();
        }
        var calls = 0;
        var settings = new LauncherSettings();
        using (var wizard = new FirstLaunchWizard(settings, () => { calls++; return Task.FromResult(Array.Empty<string>()); })) {
            File.AppendAllText(report,"RUNNING: showing first-run wizard\n");
            wizard.Show(main); pump();
            var pages = Field<PageHost>(wizard, "pages");
            var next = Field<RoundedButton>(wizard, "next");
            Check(!wizard.TorrentSelected && Field<TextBox>(wizard,"password").UseSystemPasswordChar, "First setup must make torrents opt-in and mask the password.");
            Save(wizard, Path.ChangeExtension(report,"wizard-choice.png"));
            next.PerformClick(); pump(); Check(pages.SelectedIndex == 1, "Consoles step must precede credentials.");
            next.PerformClick(); pump(); Check(pages.SelectedIndex == 3 && calls == 0, "Skipping torrents must reach review without any component or discovery calls.");
            Check(Field<Label>(wizard,"summary").Text.Contains("пропустить"), "Review must explicitly state that torrents and Chromium are skipped.");
            Field<RoundedButton>(wizard,"back").PerformClick(); pump(); Check(pages.SelectedIndex == 1, "Back must skip the disabled torrents step too.");
            pages.SelectedIndex = 0;
            Field<CheckBox>(wizard,"torrents").Checked = true;
            Field<TextBox>(wizard,"username").Text = "fixture-user";
            Field<TextBox>(wizard,"password").Text = "fixture-secret";
            next.PerformClick(); next.PerformClick(); pump(); Check(pages.SelectedIndex == 2 && wizard.TrackerUsername == "fixture-user", "Selected torrents must show credentials and preserve input.");
            Save(wizard, Path.ChangeExtension(report,"wizard-tracker.png"));
            next.PerformClick(); pump(); Save(wizard, Path.ChangeExtension(report,"wizard-review.png"));
            next.PerformClick(); pump(); Check(wizard.DialogResult == DialogResult.OK && wizard.TorrentSelected, "Confirmation must return the explicit selected setup plan.");
        }
    }
    internal static void Save(Form form, string path)
    {
        using var bitmap = new Bitmap(form.Width, form.Height);
        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size)); bitmap.Save(path);
    }
}
