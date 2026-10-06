using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using PackageFlow.Core;
using PackageFlow.Windows;

internal static class QbittorrentTests
{
    public static async Task Run(string report)
    {
        var root = Path.Combine(Path.GetTempPath(), "PackageFlow-qbit-test-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        var settings = new LauncherSettings { GamesDirectory = root, AutomaticSetupPending = true };
        var handler = new WebStub(settings);
        using var http = new HttpClient(handler);
        using var ct = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var host = new ServerHost(settings, http, root);
        try {
            await host.InstallQbittorrent(null, ct.Token);
            using (var client = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer() })) {
                var address = $"http://127.0.0.1:{settings.QbittorrentPort}";
                using var login = await client.PostAsync(address + "/api/v2/auth/login", new FormUrlEncodedContent(new Dictionary<string, string> { ["username"] = QbittorrentBootstrap.Username, ["password"] = LocalSecrets.Read(settings.ProtectedQbittorrentPassword) }));
                var preferences = await client.GetFromJsonAsync<JsonNode>(address + "/api/v2/app/preferences");
                var savePath = preferences?["save_path"]?.GetValue<string>() ?? "";
                if (!string.Equals(Path.GetFullPath(savePath).TrimEnd('/', '\\'), Path.GetFullPath(root).TrimEnd('/', '\\'), StringComparison.OrdinalIgnoreCase)) throw new Exception("qBittorrent download folder was not configured.");
            }
            var path = QbittorrentBootstrap.ProfileFile(Path.Combine(root, "data", "qbittorrent"));
            var original = File.ReadAllBytes(path);
            await host.InstallQbittorrent(null, ct.Token);
            if (!handler.Connected || handler.Saves != 1 || !original.SequenceEqual(File.ReadAllBytes(path))) throw new Exception("Retry overwrote the profile or disconnected WEB.");
            var stored = LauncherSettings.Load(Path.Combine(root, "launcher.json"));
            if (!stored.ManagedQbittorrent || LocalSecrets.Read(stored.ProtectedQbittorrentPassword).Length < 16) throw new Exception("Managed client did not persist its credentials.");
            File.WriteAllText(report, "PASS: real qBittorrent authenticated with the generated password; WEB connected; retry preserved profile and credentials.");
        } finally {
            if (settings.ManagedQbittorrent) {
                // Only the isolated client whose random credentials were created
                // by this fixture is shut down. The user's client is not touched.
                using var client = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer() });
                var address = $"http://127.0.0.1:{settings.QbittorrentPort}";
                using var login = await client.PostAsync(address + "/api/v2/auth/login", new FormUrlEncodedContent(new Dictionary<string, string> { ["username"] = QbittorrentBootstrap.Username, ["password"] = LocalSecrets.Read(settings.ProtectedQbittorrentPassword) }));
                using var shutdown = await client.PostAsync(address + "/api/v2/app/shutdown", new StringContent(""));
                shutdown.EnsureSuccessStatusCode();
                await Task.Delay(3000);
            }
            Directory.Delete(root, true);
        }
    }
    private sealed class WebStub(LauncherSettings settings) : HttpMessageHandler
    {
        public bool Connected; public int Saves;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath != "/api/torrents/settings") throw new Exception("Unexpected WEB call.");
            if (request.Method == HttpMethod.Post) {
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!;
                if (body["password"]!.GetValue<string>() != LocalSecrets.Read(settings.ProtectedQbittorrentPassword) || body["downloadPath"]!.GetValue<string>() != settings.GamesDirectory) throw new Exception("Incorrect WEB credentials or path.");
                Connected = true; Saves++;
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new { configured = Connected, ready = Connected }) };
        }
    }
}
