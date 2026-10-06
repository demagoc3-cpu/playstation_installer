using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using PackageFlow.Core;

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
static async Task Reject(Func<Task> action) { try { await action(); } catch { return; } throw new Exception("Expected failure."); }
if (args.Length == 5 && args[0] == "--compose-fixture")
{
    var root = Path.GetFullPath(args[1]);
    Directory.CreateDirectory(Path.Combine(root, "web")); Directory.CreateDirectory(Path.Combine(root, "games"));
    var fixture = new LauncherSettings { Mode = "compose", HostIp = "192.168.50.2", GamesDirectory = Path.Combine(root, "games"), Port = int.Parse(args[3]), PayloadPort = int.Parse(args[4]) };
    File.WriteAllText(Path.Combine(root, "compose.json"), ComposeConfiguration.Generate(fixture, root, "fixture-launcher-key", "packageflow/installer-smoke:local", args[2]));
    return;
}
var directory = Path.Combine(Path.GetTempPath(), "pf-windows-test-" + Guid.NewGuid()); Directory.CreateDirectory(directory);
try
{
    var settings = new LauncherSettings { Mode = "compose", HostIp = "10.1.10.47", GamesDirectory = directory };
    var legacyPath = Path.Combine(directory, "legacy-launcher.json");
    File.WriteAllText(legacyPath, "{\"Schema\":1,\"Mode\":\"native\",\"FlareSolverr\":true}");
    var migrated = LauncherSettings.Load(legacyPath);
    Check(!migrated.AutomaticSetupPending && !migrated.ManagedQbittorrent, "Updating an existing installation must not enable automatic setup or replace its torrent client.");
    migrated.AutomaticSetupPending = true; migrated.Save(legacyPath);
    Check(LauncherSettings.Load(legacyPath).AutomaticSetupPending, "Interrupted first setup must resume on next launch.");
    var nearby = Ps4Discovery.Candidates("10.1.10.31", "255.255.255.0");
    Check(nearby.Length == 253 && !nearby.Contains("10.1.10.31") && !nearby.Contains("10.1.10.0") && !nearby.Contains("10.1.10.255"), "Discovery must omit this PC and network/broadcast addresses.");
    Check(Ps4Discovery.Candidates("10.1.10.31", "255.255.0.0").SequenceEqual(nearby), "HTTP fallback on large LANs must be bounded to the nearest /24.");
    Check(Ps4Discovery.Candidates("192.168.1.9", "255.255.255.248").SequenceEqual(new[] { "192.168.1.10", "192.168.1.11", "192.168.1.12", "192.168.1.13", "192.168.1.14" }), "Honor small actual subnets.");
    foreach (var invalid in new[] { ("127.0.0.1", "255.255.255.0"), ("8.8.8.8", "255.255.255.0"), ("10.1.10.31", "255.0.255.0"), ("10.1.10.31", "0.0.0.0") })
        await Reject(() => Task.Run(() => Ps4Discovery.Candidates(invalid.Item1, invalid.Item2)));
    var announcement = "HTTP/1.1 200 Ok\nhost-type:PS4\nhost-name:Living room\ndevice-discovery-protocol-version:00020020\n";
    Check(Ps4Discovery.ParseAnnouncement("10.1.10.32", announcement) is { Name: "Living room", RestMode: false, Service: false, PyLoader: false }, "PS4 discovery alone must not claim service or loader readiness.");
    Check(Ps4Discovery.ParseAnnouncement("10.1.10.32", announcement.Replace("200 Ok", "620 Server Standby"))?.RestMode == true, "Show rest mode without waking the console.");
    Check(Ps4Discovery.ParseAnnouncement("10.1.10.32", announcement.Replace("host-type:PS4", "host-type:PS5")) == null && Ps4Discovery.ParseAnnouncement("10.1.10.32", "HTTP/1.1 200 Ok\nhost-name:Not a console") == null, "Do not misidentify other devices as PS4.");
    var qbitSecret = "fixture-generated-password-not-default";
    var qbitConfig = QbittorrentBootstrap.Configuration(8090, qbitSecret, directory);
    Check(qbitConfig.Contains("WebUI\\Address=127.0.0.1") && qbitConfig.Contains("WebUI\\LocalHostAuth=true") && !qbitConfig.Contains(qbitSecret), "Managed Web UI must be authenticated on loopback and contain no plaintext password.");
    var qbitHash = System.Text.RegularExpressions.Regex.Match(qbitConfig, @"@ByteArray\(([^:]+):([^\)]+)\)");
    var qbitSalt = Convert.FromBase64String(qbitHash.Groups[1].Value);
    var qbitDerived = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(qbitSecret), qbitSalt, 100000, HashAlgorithmName.SHA512, 64);
    Check(Convert.ToBase64String(qbitDerived) == qbitHash.Groups[2].Value, "qBittorrent's PBKDF2 format must authenticate the generated password.");
    Check(QbittorrentBootstrap.ProfileFile(directory).Contains("qBittorrent_PackageFlow") && QbittorrentBootstrap.IsWindowsAsset("qbittorrent_5.2.4_x64_setup.exe") && !QbittorrentBootstrap.IsWindowsAsset("qbittorrent_5.2.4_x86_setup.exe"), "Use the isolated profile and the official x64 installer.");
    Check(migrated.FlareSolverrVisibleBrowser, "Existing installations must enable the Windows Cloudflare compatibility mode.");
    migrated.FlareSolverrVisibleBrowser = false; migrated.Save(legacyPath);
    Check(!LauncherSettings.Load(legacyPath).FlareSolverrVisibleBrowser, "The user's hidden-browser choice must survive a restart.");
    var native = new LauncherSettings { Mode = "native", HostIp = "10.1.10.47", GamesDirectory = directory };
    var next = new LauncherSettings { Mode = "native", HostIp = native.HostIp, GamesDirectory = directory + "-next", AutoStart = true };
    Check(!native.RequiresRestart(next), "Native folder and autostart edits must apply while WEB stays running.");
    next.Port = 3002; Check(native.RequiresRestart(next), "Port edits require a guarded restart."); next.Port = 3000;
    next.Mode = "compose"; Check(native.RequiresRestart(next), "Mode changes require a guarded restart.");
    native.Mode = "compose"; Check(native.RequiresRestart(next), "A Compose folder edit must update its bind mount through a restart.");
    using var githubHttp = new HttpClient(new MockHandler(request => {
        Check(request.RequestUri!.Host == "api.github.com" && request.Headers.UserAgent.Any(), "GitHub metadata needs the official API and a User-Agent.");
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(request.RequestUri.AbsolutePath.EndsWith("/tags") ? "[{\"name\":\"v1.9.0\"},{\"name\":\"v1.10.2\"},{\"name\":\"v1.11.0-beta\"},{\"name\":\"scratch\"}]" : "{\"stargazers_count\":17}") });
    }));
    var stats = await GithubProject.Read(githubHttp, default);
    Check(stats.Version == "v1.10.2" && stats.Stars == 17, "Header metadata must use semantic tag order and real repository stars.");
    var windowsAssets = new JsonArray();
    foreach (var entry in new[] { (Tag: "v2.00", Version: "0.1.9", Preview: true), (Tag: "v1.99", Version: "", Preview: false), (Tag: "v1.98", Version: "0.1.7", Preview: false), (Tag: "v1.97", Version: "0.1.6", Preview: false) }) {
        var assets = new JsonArray();
        if (entry.Version.Length > 0) assets.Add(new JsonObject { ["name"] = $"PackageFlowSetup-{entry.Version}-x64.exe", ["size"] = 100, ["digest"] = "sha256:" + new string('a', 64), ["browser_download_url"] = $"https://github.com/demagoc3-cpu/playstation_installer/releases/download/{entry.Tag}/PackageFlowSetup-{entry.Version}-x64.exe" });
        windowsAssets.Add(new JsonObject { ["tag_name"] = entry.Tag, ["draft"] = false, ["prerelease"] = entry.Preview, ["assets"] = assets });
    }
    using var windowsHttp = new HttpClient(new MockHandler(request => {
        Check(request.RequestUri!.AbsolutePath.EndsWith("/releases") && request.RequestUri.Query == "?per_page=100", "A PS4-only latest release must not hide the Windows update.");
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(windowsAssets.ToJsonString()) });
    }));
    var windowsRelease = await ReleaseDownloads.LatestWindows(windowsHttp, default);
    Check(windowsRelease?.Version == "0.1.7" && windowsRelease.Name == "PackageFlowSetup-0.1.7-x64.exe", "Compare the stable installer version, not the unrelated release tag, and ignore preview EXEs.");
    windowsAssets[2]!["assets"]![0]!["digest"] = "";
    await Reject(() => ReleaseDownloads.LatestWindows(windowsHttp, default));
    var compose = JsonNode.Parse(ComposeConfiguration.Generate(settings, directory, "test-token", "test/image:1"))!;
    Check(compose["services"]!["packageflow"]!["environment"]!["PACKAGEFLOW_HOST_IP"]!.GetValue<string>() == "10.1.10.47", "LAN address missing.");
    Check(compose["services"]!["packageflow"]!["ports"]!.AsArray().Count == 2, "Callback port must be published.");
    Check(compose["services"]!["packageflow"]!["volumes"]![1]!["read_only"]!.GetValue<bool>(), "Games must stay read-only.");
    settings.ManagedProwlarr = true;
    var withSearch = JsonNode.Parse(ComposeConfiguration.Generate(settings, directory, "token", "image"))!;
    Check(withSearch["services"]!["prowlarr"]!["ports"]![0]!["host_ip"]!.GetValue<string>() == "127.0.0.1", "Prowlarr must not expose credentials to LAN.");
    var quoted = Path.Combine(directory, "games $test"); Directory.CreateDirectory(quoted); settings.GamesDirectory = quoted;
    Check(ComposeConfiguration.Generate(settings, directory, "token", "image").Contains("$$test"), "Compose dollar interpolation must be escaped.");
    settings.HostIp = "999.1.1.1";
    await Reject(() => { settings.Validate(); return Task.CompletedTask; });

    var template = JsonNode.Parse("""{"definitionName":"rutracker","fields":[{"name":"username","value":""},{"name":"password","value":""}],"presets":[],"id":0}""")!;
    var candidate = ProwlarrClient.PrepareRuTracker(template, " user ", "secret-password", 3);
    Check(candidate["fields"]![0]!["value"]!.GetValue<string>() == "user", "Username field not set.");
    Check(template["fields"]![1]!["value"]!.GetValue<string>() == "", "Schema was mutated.");
    Check(candidate["appProfileId"]!.GetValue<int>() == 3 && candidate["id"] == null, "Invalid indexer payload.");
    using var credentialHttp = new HttpClient(new MockHandler(request => {
        var id = request.RequestUri!.Segments.Last();
        var payload = id == "9" ? "{\"name\":\"Another tracker\"}" : "{\"name\":\"RuTracker.org\",\"fields\":[{\"name\":\"username\",\"value\":\"saved-user\"},{\"name\":\"password\",\"value\":\"" + (id == "7" ? "********" : "saved-password") + "\"}]}";
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(payload, Encoding.UTF8, "application/json") });
    }));
    var credentialClient = new ProwlarrClient(credentialHttp, "http://localhost:9696", "fixture-key");
    var maskedCredentials = await credentialClient.RuTrackerCredentials(7, default);
    Check(maskedCredentials.Username == "saved-user" && maskedCredentials.PasswordSaved && maskedCredentials.Password == "", "Upstream password masks must never become real credentials.");
    var fullCredentials = await credentialClient.RuTrackerCredentials(8, default);
    Check(fullCredentials.Username == "saved-user" && fullCredentials.Password == "saved-password", "Existing RuTracker fields must be available for restoration.");
    Check(await credentialClient.RuTrackerCredentials(9, default) == ("", "", false), "Do not restore another tracker's credentials into RuTracker fields.");
    var editedMethods = new List<HttpMethod>();
    using var editHttp = new HttpClient(new MockHandler(async request => {
        editedMethods.Add(request.Method);
        if (request.Method == HttpMethod.Get) return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"id\":7,\"name\":\"RuTracker.org\",\"tags\":[12],\"fields\":[{\"name\":\"username\",\"value\":\"old-user\"},{\"name\":\"password\",\"value\":\"********\"}]}") };
        var data = JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
        Check(data["id"]!.GetValue<int>() == 7 && data["tags"]![0]!.GetValue<int>() == 12, "Applying credentials must preserve proxy assignment and indexer identity.");
        Check(data["fields"]![0]!["value"]!.GetValue<string>() == "new-user" && data["fields"]![1]!["value"]!.GetValue<string>() == "new-password", "Edited RuTracker credentials were ignored.");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") };
    }));
    Check(await new ProwlarrClient(editHttp, "http://127.0.0.1:9696", "fixture-key").ApplyRuTrackerCredentials(7, "new-user", "new-password", default), "Existing RuTracker must accept edited settings.");
    Check(editedMethods.SequenceEqual(new[] { HttpMethod.Get, HttpMethod.Post, HttpMethod.Put }), "Edited settings must be tested before replacing a working indexer.");
    var calls = new List<string>();
    using var prowlarrHttp = new HttpClient(new MockHandler(async request =>
    {
        Check(request.Headers.GetValues("X-Api-Key").Single() == "private-key", "API key missing.");
        calls.Add(request.Method + " " + request.RequestUri!.AbsolutePath);
        var result = request.RequestUri!.AbsolutePath switch
        {
            "/base/api/v1/indexer" when request.Method == HttpMethod.Get => "[]",
            "/base/api/v1/indexer/schema" => "[{\"presets\":[" + template.ToJsonString() + "]}]",
            "/base/api/v1/appprofile" => "[{\"id\":3}]",
            "/base/api/v1/indexer/test" => "{}",
            "/base/api/v1/indexer" => "{\"id\":2}",
            _ => throw new Exception("Unexpected API path.")
        };
        if (request.Content != null) Check((await request.Content.ReadAsStringAsync()).Contains("secret-password"), "Credentials not sent to Prowlarr.");
        return new(HttpStatusCode.OK) { Content = new StringContent(result, Encoding.UTF8, "application/json") };
    }));
    var client = new ProwlarrClient(prowlarrHttp, "http://localhost:9696/base", "private-key");
    Check(await client.AddRuTracker("user", "secret-password", default) == 2, "Returned indexer ID.");
    Check(calls.IndexOf("POST /base/api/v1/indexer/test") < calls.IndexOf("POST /base/api/v1/indexer"), "Must test before saving.");
    var connection = client.Connection(2, "http://prowlarr:9696/base");
    Check(connection.Endpoint == "http://prowlarr:9696/base/2/api" && !connection.Endpoint.Contains("private-key"), "Server address mapping or secret leakage.");
    using var failing = new HttpClient(new MockHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("secret-password") })));
    try { await new ProwlarrClient(failing, "http://localhost", "key").Indexers(default); }
    catch (Exception error) { Check(!error.Message.Contains("secret-password"), "Upstream validation leaked credentials."); }

    settings.HostIp = "10.1.10.47"; settings.FlareSolverr = true; settings.Port = 4444;
    var flareCompose = JsonNode.Parse(ComposeConfiguration.Generate(settings, directory, "token", "image"))!;
    Check(flareCompose["services"]!["flaresolverr"]!["ports"]![0]!["host_ip"]!.GetValue<string>() == "127.0.0.1", "FlareSolverr must be local-only.");
    Check(flareCompose["services"]!["packageflow"]!["environment"]!["PACKAGEFLOW_PUBLIC_PORT"]!.GetValue<string>() == "4444", "PS4 must receive the published WEB port.");
    var proxyCalls = new List<string>();
    using var proxyHttp = new HttpClient(new MockHandler(async request => {
        var route = request.RequestUri!.AbsolutePath; proxyCalls.Add(request.Method + " " + route);
        var content = request.Content == null ? null : JsonNode.Parse(await request.Content.ReadAsStringAsync());
        if (route == "/api/v1/indexerproxy/test" || route == "/api/v1/indexerproxy") {
            if (content != null) {
                Check(content["tags"]!.AsArray().Count == 1 && content["tags"]![0]!.GetValue<int>() == 9, "Proxy must target only our RuTracker tag.");
                Check(content["fields"]![0]!["value"]!.GetValue<string>() == "http://flaresolverr:8191/", "Compose proxy address incorrect.");
            }
        }
        if (request.Method == HttpMethod.Put && route == "/api/v1/indexer/2") {
            Check(content!["tags"]!.AsArray().Select(t => t!.GetValue<int>()).SequenceEqual(new[] { 7, 9 }), "Existing tracker tags were removed.");
        }
        var result = route switch {
            "/api/v1/tag" => "[{\"id\":9,\"label\":\"packageflow-rutracker\"}]",
            "/api/v1/indexerproxy" when request.Method == HttpMethod.Get => "[]",
            "/api/v1/indexerproxy/schema" => "[{\"implementation\":\"FlareSolverr\",\"fields\":[{\"name\":\"host\"}]}]",
            "/api/v1/indexer/2" when request.Method == HttpMethod.Get => "{\"id\":2,\"name\":\"RuTracker.org\",\"tags\":[7]}",
            _ => ""
        };
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(result, Encoding.UTF8, "application/json") };
    }));
    var proxyClient = new ProwlarrClient(proxyHttp, "http://localhost:9696", "private-key");
    var proxyTag = await proxyClient.ConfigureFlareSolverr("http://flaresolverr:8191/", default);
    await proxyClient.AttachRuTrackerProxy(2, proxyTag, default);
    Check(proxyCalls.IndexOf("POST /api/v1/indexerproxy/test") < proxyCalls.IndexOf("POST /api/v1/indexerproxy"), "Proxy must be tested before saving.");
    proxyCalls.Clear();
    await proxyClient.TestIndexer(2, default);
    Check(proxyCalls.SequenceEqual(new[] { "GET /api/v1/indexer/2", "POST /api/v1/indexer/test" }), "Connecting an existing indexer must not reconfigure its proxy or tags.");

    var failedProxyCalls = new List<string>();
    using var failedProxyHttp = new HttpClient(new MockHandler(request => {
        var route = request.RequestUri!.AbsolutePath;
        failedProxyCalls.Add(request.Method + " " + route);
        Check(request.RequestUri.Query.Length == 0, "Failed proxy validation must not be bypassed with forceSave.");
        var result = route switch {
            "/api/v1/tag" => "[{\"id\":9,\"label\":\"packageflow-rutracker\"}]",
            "/api/v1/indexerproxy" when request.Method == HttpMethod.Get => "[]",
            "/api/v1/indexerproxy/schema" => "[{\"implementation\":\"FlareSolverr\",\"fields\":[{\"name\":\"host\"}]}]",
            "/api/v1/indexerproxy/test" => "secret-password private-key",
            "/v1" => "{\"status\":\"error\",\"message\":\"Browser crashed\"}",
            _ => throw new Exception("A failed proxy test must prevent saving.")
        };
        return Task.FromResult(new HttpResponseMessage(route.EndsWith("/test") ? HttpStatusCode.BadRequest : HttpStatusCode.OK) { Content = new StringContent(result, Encoding.UTF8, "application/json") });
    }));
    ProwlarrRequestException? proxyError = null;
    try { await new ProwlarrClient(failedProxyHttp, "http://localhost:9696", "private-key").ConfigureFlareSolverr("http://127.0.0.1:8191/", default); }
    catch (ProwlarrRequestException error) { proxyError = error; }
    Check(proxyError is { StatusCode: 400, RequestPath: "api/v1/indexerproxy/test" }, "Proxy failure must retain safe operation context.");
    Check(!proxyError!.Message.Contains("secret-password") && !proxyError.Message.Contains("private-key"), "Proxy diagnostics leaked upstream secrets.");
    Check(!failedProxyCalls.Contains("POST /api/v1/indexerproxy"), "Failed proxy was saved.");

    using var captchaHttp = new HttpClient(new MockHandler(request => Task.FromResult(new HttpResponseMessage(
        request.Method == HttpMethod.Get ? HttpStatusCode.OK : HttpStatusCode.BadRequest) {
        Content = new StringContent(request.Method == HttpMethod.Get ? "{\"id\":1,\"name\":\"RuTracker.org\"}" :
            """[{"errorMessage":"Credentials appears to be invalid. Response: Введите код подтверждения (символы, изображенные на картинке)","attemptedValue":"private-password private-cookie private-key"}]""", Encoding.UTF8, "application/json")
    })));
    try { await new ProwlarrClient(captchaHttp, "http://127.0.0.1:9696", "private-key").TestIndexer(1, default); throw new Exception("CAPTCHA must fail the indexer test."); }
    catch (ProwlarrRequestException error) {
        Check(error.TrackerCaptchaRequired && !error.ToString().Contains("private-password") && !error.ToString().Contains("private-cookie") && !error.ToString().Contains("private-key"), "CAPTCHA classification must preserve no upstream secrets.");
    }
    using var existingProxyHttp = new HttpClient(new MockHandler(request => {
        Check(request.Method == HttpMethod.Get, "Looking up a prepared proxy must not retest it or open browsers.");
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(request.RequestUri!.AbsolutePath.EndsWith("/tag")
            ? """[{"id":9,"label":"packageflow-rutracker"}]"""
            : """[{"name":"PackageFlow FlareSolverr","implementation":"FlareSolverr","tags":[9],"fields":[{"name":"host","value":"http://127.0.0.1:8191/"}]}]""") });
    }));
    var preparedProxy = new ProwlarrClient(existingProxyHttp, "http://127.0.0.1:9696", "fixture-key");
    Check(await preparedProxy.ExistingFlareSolverrTag("http://127.0.0.1:8191/", default) == 9, "A prepared matching proxy must be reused.");
    Check(await preparedProxy.ExistingFlareSolverrTag("http://flaresolverr:8191/", default) == null, "A proxy for another runtime must not be reused.");
    var manualCalls = new List<string>(); string? manualSession = null;
    using var manualHttp = new HttpClient(new MockHandler(async request => {
        Check(request.RequestUri!.ToString() == "http://127.0.0.1:8191/v1", "Manual login must use the local solver.");
        var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
        var cmd = body["cmd"]!.GetValue<string>(); manualCalls.Add(cmd);
        var name = body["session"]!.GetValue<string>();
        if (cmd == "sessions.create") manualSession = name;
        Check(name == manualSession, "All manual requests must keep the same private session.");
        var result = cmd == "sessions.create" ? new JsonObject { ["status"] = "ok", ["session"] = name }
            : cmd == "sessions.destroy" ? new JsonObject { ["status"] = "ok" }
            : new JsonObject { ["status"] = "ok", ["solution"] = new JsonObject { ["status"] = 200,
                ["url"] = "https://rutracker.org/forum/index.php", ["response"] = "<span id=\"logged-in-username\">account</span>" } };
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(result.ToJsonString()) };
    }));
    await using (var manual = new RuTrackerManualLogin(manualHttp)) {
        await manual.Open(default);
        Check(manualCalls.SequenceEqual(new[] { "sessions.create", "request.get" }), "Manual window must remain open after its initial request.");
        Check(await manual.Authenticated(default), "Confirm the logged-in page before accepting manual login.");
    }
    Check(manualCalls.Last() == "sessions.destroy", "Only close the manual session when the human completes or cancels the flow.");
    foreach (var page in new[] {
        """{"status":"ok","solution":{"status":200,"url":"https://rutracker.org/forum/login.php","response":"<form name=\"login\"></form>"}}""",
        """{"status":"ok","solution":{"status":200,"url":"https://another.example/forum/index.php","response":"<span id=\"logged-in-username\">account</span>"}}""",
        """{"status":"error","message":"private-cookie private-password"}"""
    }) {
        using var unverifiedHttp = new HttpClient(new MockHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(page) })));
        await using var unverified = new RuTrackerManualLogin(unverifiedHttp);
        Check(!await unverified.Authenticated(default), "A login form, foreign redirect or solver error must not count as an authenticated RuTracker page.");
    }

    async Task TrackerFallbackScenario(string pingResult, string trackerResult, bool succeeds, bool existing = false, bool activationFailure = false)
    {
        var events = new List<string>();
        using var fallbackHttp = new HttpClient(new MockHandler(async request => {
            var route = request.RequestUri!.AbsolutePath;
            var responseStatus = HttpStatusCode.OK;
            var content = request.Content == null ? null : JsonNode.Parse(await request.Content.ReadAsStringAsync());
            events.Add(request.Method + " " + route);
            string result;
            if (route == "/v1") {
                Check(request.RequestUri.Host == "127.0.0.1" && !request.Headers.Contains("X-Api-Key"), "Probe must use the published local FlareSolverr without Prowlarr credentials.");
                var target = content!["url"]!.GetValue<string>();
                events.Add(target);
                result = target.Contains("prowlarr.servarr.com") ? pingResult : trackerResult;
                if (JsonNode.Parse(result)?["status"]?.GetValue<string>() == "error") responseStatus = HttpStatusCode.InternalServerError;
            } else if (request.Method == HttpMethod.Post && route == "/api/v1/indexerproxy") {
                Check(!existing && (succeeds || activationFailure) && request.RequestUri.Query.Length == 0, "Unexpected creation of fallback proxy.");
                Check(content!["tags"]!.AsArray().Count == 0, "New fallback proxy must first be created unassigned, because Prowlarr still tests enabled proxies on creation.");
                Check(events.Contains("https://rutracker.org/forum/index.php"), "Tracker must be probed before creating a fallback proxy.");
                result = "{\"id\":4}";
            } else if (request.Method == HttpMethod.Put && route == "/api/v1/indexerproxy/4") {
                Check((succeeds || activationFailure) && request.RequestUri.Query == "?forceSave=true", "Only a confirmed Cloudflare ping block plus tracker success permits forceSave.");
                Check(content!["tags"]!.AsArray().Count == 1 && content["tags"]![0]!.GetValue<int>() == 9, "Fallback activation must assign our tracker tag.");
                Check(content!["fields"]![0]!["value"]!.GetValue<string>() == "http://flaresolverr:8191/", "Compose saved address must remain distinct from the Windows probe address.");
                result = activationFailure ? "private-key secret-password" : "{\"id\":4}";
                if (activationFailure) responseStatus = HttpStatusCode.BadRequest;
            } else if (request.Method == HttpMethod.Delete && route == "/api/v1/indexerproxy/4") {
                Check(activationFailure && !existing, "Must not remove an existing proxy after update failure.");
                result = "{}";
            } else {
                result = route switch {
                    "/api/v1/tag" => "[{\"id\":9,\"label\":\"packageflow-rutracker\"}]",
                    "/api/v1/indexerproxy" => existing ? "[{\"id\":4,\"name\":\"PackageFlow FlareSolverr\",\"fields\":[{\"name\":\"host\"}]}]" : "[]",
                    "/api/v1/indexerproxy/schema" => "[{\"implementation\":\"FlareSolverr\",\"fields\":[{\"name\":\"host\"}]}]",
                    "/api/v1/indexerproxy/test" => "private-key secret-password",
                    _ => throw new Exception("Unexpected fallback path.")
                };
                if (route.EndsWith("/test")) responseStatus = HttpStatusCode.BadRequest;
            }
            return new HttpResponseMessage(responseStatus) { Content = new StringContent(result, Encoding.UTF8, "application/json") };
        }));
        var fallbackClient = new ProwlarrClient(fallbackHttp, "http://localhost:9696", "private-key");
        var completed = false;
        try { Check(await fallbackClient.ConfigureFlareSolverr("http://flaresolverr:8191/", default, "http://127.0.0.1:8191/") == 9, "Fallback tag incorrect."); completed = true; }
        catch (ProwlarrRequestException error) { Check(!error.Message.Contains("private-key") && !error.Message.Contains("secret-password"), "Fallback error leaked secrets."); }
        Check(completed == succeeds && fallbackClient.UsedTrackerFallback == succeeds, "Incorrect fallback outcome.");
        var save = "PUT /api/v1/indexerproxy/4";
        Check(events.Contains(save) == (succeeds || activationFailure), "Fallback attempted activation without verified tracker access.");
        Check(events.Contains("DELETE /api/v1/indexerproxy/4") == (activationFailure && !existing), "Failed new proxy activation must be rolled back without deleting an existing proxy.");
        if (succeeds) Check(events.IndexOf("https://rutracker.org/forum/index.php") < events.IndexOf(save), "Tracker must be verified before saving.");
    }
    const string blocked = """{"status":"error","message":"Error: Cloudflare has blocked this request. Probably your IP is banned."}""";
    const string accessible = """{"status":"ok","solution":{"status":200,"url":"https://rutracker.org/forum/index.php","response":"<html><title>RuTracker.org</title></html>","cookies":[{"name":"bb_guid","value":"private-cookie"}]}}""";
    await TrackerFallbackScenario(blocked, accessible, true);
    await TrackerFallbackScenario(blocked, accessible, true, existing: true);
    await TrackerFallbackScenario(blocked, accessible, false, activationFailure: true);
    await TrackerFallbackScenario(blocked, accessible, false, existing: true, activationFailure: true);
    await TrackerFallbackScenario("""{"status":"error","message":"Browser crashed"}""", accessible, false);
    await TrackerFallbackScenario("""{"status":"ok"}""", accessible, false);
    await TrackerFallbackScenario(blocked, blocked, false);
    await TrackerFallbackScenario(blocked, """{"status":"ok","solution":{"status":403,"url":"https://rutracker.org/forum/index.php"}}""", false);
    await TrackerFallbackScenario(blocked, """{"status":"ok","solution":{"status":200,"url":"https://other.example/"}}""", false);
    await TrackerFallbackScenario(blocked, """{"status":"ok","solution":{"status":200,"url":"https://rutracker.org/forum/index.php","response":"<html><title>Один момент…</title><script>_cf_chl_opt={}</script></html>","cookies":[{"name":"bb_guid","value":"private-cookie"}]}}""", false);
    await TrackerFallbackScenario(blocked, """{"status":"ok","solution":{"status":200,"url":"https://rutracker.org/forum/index.php","response":"<html><title>RuTracker.org</title></html>","cookies":[]}}""", false);

    var bytes = Encoding.UTF8.GetBytes("verified release payload");
    var hash = Convert.ToHexString(SHA256.HashData(bytes));
    using var downloads = new HttpClient(new MockHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) })));
    var asset = new ReleaseAsset("1.0", "release.zip", new Uri("https://github.com/Prowlarr/Prowlarr/releases/download/v1/release.zip"), bytes.Length, hash);
    var destination = Path.Combine(directory, "download.bin");
    await ReleaseDownloads.Download(downloads, asset, destination, null, default);
    Check(File.ReadAllBytes(destination).SequenceEqual(bytes), "Verified download differs.");
    await Reject(() => ReleaseDownloads.Download(downloads, asset with { Sha256 = new string('0', 64) }, destination, null, default));
    Check(File.ReadAllBytes(destination).SequenceEqual(bytes) && !File.Exists(destination + ".part"), "Failed download replaced the good file.");
    var zip = Path.Combine(directory, "bad.zip");
    using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create)) { using var writer = new StreamWriter(archive.CreateEntry("../escape.txt").Open()); writer.Write("unsafe"); }
    await Reject(() => { ReleaseDownloads.ExtractZip(zip, Path.Combine(directory, "extract")); return Task.CompletedTask; });
    Check(!File.Exists(Path.Combine(directory, "escape.txt")), "Zip traversal escaped destination.");
    Console.WriteLine("Windows core tests passed: Compose mapping, Prowlarr onboarding, credential handling, verified downloads and archive safety.");
}
finally { Directory.Delete(directory, true); }

sealed class MockHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> callback) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => callback(request);
}
