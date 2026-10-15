using System.Net;
using System.Reflection;
using PackageFlow.Core;
using PackageFlow.Windows;
using Microsoft.Web.WebView2.WinForms;

internal static class GlassStopTests
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    public static void Run(MainForm form, Action pump)
    {
        var hostField = typeof(MainForm).GetField("host", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var original = hostField.GetValue(form);
        var folder = Path.Combine(Path.GetTempPath(), "PackageFlow-stop-fixture-" + Guid.NewGuid());
        try {
            foreach (var scenario in new[] { "cancel", "confirm", "late", "torrent" }) {
                var transport = new Fixture(scenario);
                using var http = new HttpClient(transport);
                var settings = new LauncherSettings { TorrentSetupSelected = scenario == "torrent" };
                var host = new ServerHost(settings, http, folder);
                typeof(ServerHost).GetProperty("Started")!.SetValue(host, true);
                hostField.SetValue(form, host);
                using var timer = new System.Windows.Forms.Timer { Interval = 15 };
                timer.Tick += (_, _) => {
                    var desktopReady = (bool)typeof(MainForm).GetField("desktopReady", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(form)!;
                    if (desktopReady) {
                        var view = (WebView2)typeof(MainForm).GetField("desktop", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(form)!;
                        _ = view.CoreWebView2.ExecuteScriptAsync("document.querySelector('.dialog " + (scenario == "cancel" ? ".keep" : ".danger") + "')?.click()");
                        return;
                    }
                    var warning = Application.OpenForms.OfType<StopWarningForm>().FirstOrDefault();
                    if (warning == null) return;
                    warning.DialogResult = scenario == "cancel" ? DialogResult.Cancel : DialogResult.OK;
                    warning.Close(); timer.Stop();
                };
                timer.Start();
                var task = (Task<bool>)typeof(MainForm).GetMethod("ConfirmedStop",BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(form,[true])!;
                while (!task.IsCompleted) pump();
                var result = task.GetAwaiter().GetResult();
                if (scenario == "cancel") Check(!result && host.Started && transport.StopCalls == 0 && transport.PauseCalls == 0, "Declining the warning must not stop WEB or pause tasks.");
                else Check(result && !host.Started && transport.StopCalls > 0, "Explicit confirmation must stop the launcher-owned server despite active jobs.");
                if (scenario == "late") Check(transport.StopCalls == 2, "A task starting during drain needs confirmation before the second stop attempt.");
                if (scenario == "torrent") Check(transport.PauseCalls == 1, "Only the active PackageFlow-tagged torrent should be paused after confirmation.");
            }
        } finally { hostField.SetValue(form, original); if (Directory.Exists(folder)) Directory.Delete(folder,true); }
    }
    private sealed class Fixture(string scenario) : HttpMessageHandler
    {
        public int StopCalls, PauseCalls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            var json = "{}";
            if (path == "/api/desktop/status") json = scenario is "late" or "torrent" ? "{\"busy\":false}" : "{\"busy\":true}";
            else if (path == "/api/torrents/settings") json = scenario == "torrent" ? "{\"configured\":true}" : "{\"configured\":false}";
            else if (path == "/api/torrents") json = "[{\"hash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"progress\":0.2,\"state\":\"downloading\"},{\"hash\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"progress\":0.5,\"state\":\"pausedDL\"}]";
            else if (path == "/api/desktop/prepare-stop") { StopCalls++; json = "{\"busy\":true}"; }
            else if (path == "/api/torrents/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pause") { PauseCalls++; json = "{\"ok\":true}"; }
            else throw new Exception("Unexpected stop request: " + path);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8,"application/json") });
        }
    }
}
