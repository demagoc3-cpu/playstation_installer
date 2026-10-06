using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed class ServerHost(LauncherSettings settings, HttpClient http)
{
    public static string DataDirectory => Path.Combine(Program.UserDirectory, "data");
    public static string SettingsPath => Path.Combine(Program.UserDirectory, "launcher.json");
    public static string ComposePath => Path.Combine(DataDirectory, "compose.json");
    private static string InstallDirectory => AppContext.BaseDirectory;
    private Process? server;
    private Process? prowlarr;
    private Process? flareSolverr;
    public string WebUrl => $"http://127.0.0.1:{settings.Port}";
    public bool Started { get; private set; }
    public Action<string>? Status { get; set; }
    public Action<int>? DownloadPercent { get; set; }
    private IProgress<int> Progress(IProgress<int>? target) => target ?? new Progress<int>(p => DownloadPercent?.Invoke(p));
    private static CancellationTokenSource ProbeTimeout(CancellationToken ct) { var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(4)); return timeout; }

    public static string[] LanAddresses() => NetworkInterface.GetAllNetworkInterfaces()
        .Where(i => i.OperationalStatus == OperationalStatus.Up && i.NetworkInterfaceType != NetworkInterfaceType.Loopback)
        .SelectMany(i => i.GetIPProperties().UnicastAddresses)
        .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a.Address) && !a.Address.ToString().StartsWith("169.254."))
        .Select(a => a.Address.ToString()).Distinct().ToArray();

    public async Task<JsonNode> Api(string path, object? body = null, CancellationToken ct = default)
    {
        using var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, WebUrl + path);
        request.Headers.Add("X-PackageFlow-Launcher-Key", LocalSecrets.Read(settings.ProtectedLauncherKey));
        if (body != null) request.Content = JsonContent.Create(body);
        using var response = await http.SendAsync(request, ct);
        var json = await response.Content.ReadFromJsonAsync<JsonNode>(cancellationToken: ct) ?? new JsonObject();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(json["message"]?.GetValue<string>() ?? $"PackageFlow HTTP {(int)response.StatusCode}");
        return json;
    }

    private static void CheckPort(int port)
    {
        var listener = new TcpListener(IPAddress.Any, port);
        try { listener.Start(); }
        catch { throw new InvalidOperationException($"Port {port} is in use. Stop the other server or choose another port."); }
        finally { listener.Stop(); }
    }

    public async Task Start(CancellationToken ct)
    {
        if (Started) { using var probe = ProbeTimeout(ct); try { await Api("/api/desktop/status", ct: probe.Token); return; } catch (Exception) when (!ct.IsCancellationRequested) { Started = false; } }
        Status?.Invoke("Checking the WEB server…");
        settings.Validate();
        if (await Adopt(ct)) {
            if (settings.ManagedProwlarr && settings.Mode == "native") await InstallProwlarr(null, ct);
            if (settings.FlareSolverr && settings.Mode == "native") await InstallFlareSolverr(null, ct);
            Status?.Invoke("PackageFlow ready"); return;
        }
        if (string.IsNullOrEmpty(settings.ProtectedLauncherKey)) settings.ProtectedLauncherKey = LocalSecrets.Protect(LocalSecrets.Generate());
        settings.Save(SettingsPath);
        // An unrelated development server must never be adopted or stopped.
        CheckPort(settings.Port); CheckPort(settings.PayloadPort);
        Directory.CreateDirectory(Path.Combine(DataDirectory, "web"));
        if (settings.Mode == "compose")
        {
            Status?.Invoke("Checking Docker Desktop…");
            await ProcessRunner.Run("docker", ["info", "--format", "{{.OSType}}"], DataDirectory, ct);
            await ProcessRunner.Run("docker", ["compose", "version"], DataDirectory, ct);
            if (settings.ManagedProwlarr) BootstrapProwlarr(true);
            var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(InstallDirectory, "release.json")))!;
            File.WriteAllText(ComposePath, ComposeConfiguration.Generate(settings, DataDirectory, LocalSecrets.Read(settings.ProtectedLauncherKey), manifest["dockerImage"]!.GetValue<string>(), InstallDirectory));
            Status?.Invoke("Downloading and starting containers…");
            // The installer already contains WEB: no Git, npm or unpublished image is needed.
            await Compose(["build", "packageflow"], ct);
            await Compose(["up", "-d", "--no-build", "--pull", "missing"], ct);
        }
        else
        {
            var executable = Path.Combine(InstallDirectory, "runtime", "node.exe");
            var directory = Path.Combine(InstallDirectory, "server");
            if (!File.Exists(executable) || !File.Exists(Path.Combine(directory, ".output", "server", "index.mjs")))
                throw new FileNotFoundException("Install the complete PackageFlow distribution.");
            var info = ProcessRunner.Info(executable, [Path.Combine(directory, ".output", "server", "index.mjs")], directory);
            info.Environment["NODE_ENV"] = "production"; info.Environment["HOST"] = "0.0.0.0"; info.Environment["PORT"] = settings.Port.ToString();
            info.Environment["PACKAGEFLOW_DATA_DIR"] = Path.Combine(DataDirectory, "web");
            info.Environment["PACKAGEFLOW_PAYLOAD_PORT"] = settings.PayloadPort.ToString();
            info.Environment["PACKAGEFLOW_PUBLIC_PORT"] = settings.Port.ToString();
            info.Environment["PACKAGEFLOW_LAUNCHER_KEY"] = LocalSecrets.Read(settings.ProtectedLauncherKey);
            if (settings.HostIp.Length > 0) info.Environment["PACKAGEFLOW_HOST_IP"] = settings.HostIp;
            Status?.Invoke("Starting the WEB server…");
            server = StartProcess(info);
        }
        try
        {
            for (var attempt = 0; attempt < 90; attempt++)
            {
                ct.ThrowIfCancellationRequested();
                try
                {
                    using var probe = ProbeTimeout(ct);
                    var status = await Api("/api/desktop/status", ct: probe.Token);
                    if (status["application"]?.GetValue<string>() == "PackageFlow") {
                        Started = true; Status?.Invoke("WEB ready");
                        break;
                    }
                }
                catch (Exception) when (!ct.IsCancellationRequested) { }
                if (server?.HasExited == true) throw new InvalidOperationException("The WEB server stopped during startup.");
                await Task.Delay(1000, ct);
            }
            if (!Started) throw new InvalidOperationException("PackageFlow did not start. The Compose image must match this Windows release.");
            if (settings.Mode == "native") {
                if (settings.ManagedProwlarr) await InstallProwlarr(null, ct);
                if (settings.FlareSolverr) await InstallFlareSolverr(null, ct);
            }
            Status?.Invoke("PackageFlow ready");
        }
        catch {
            // Once ready, WEB may already have accepted a job; leave it available.
            if (!Started && server is { HasExited: false }) server.Kill(true);
            throw;
        }
    }

    public async Task<bool> Adopt(CancellationToken ct)
    {
        if (settings.ProtectedLauncherKey.Length == 0) return false;
        JsonNode response;
        using var probe = ProbeTimeout(ct);
        try { response = await Api("/api/desktop/status", ct: probe.Token); }
        catch (Exception) when (!ct.IsCancellationRequested) { return false; }
        if (response["application"]?.GetValue<string>() != "PackageFlow") return false;
        if (settings.Mode == "native")
        {
            var process = Process.GetProcessById(response["processId"]!.GetValue<int>());
            if (!string.Equals(process.MainModule?.FileName, Path.Combine(InstallDirectory, "runtime", "node.exe"), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The running server belongs to another installation.");
            server = process;
        }
        Started = true;
        return true;
    }

    public async Task PrepareUpdate(CancellationToken ct)
    {
        if (await Adopt(ct)) await Stop(ct);
        else CheckPort(settings.Port); // An unknown server must never be overwritten.
    }

    public async Task Stop(CancellationToken ct)
    {
        if (!Started) return;
        Status?.Invoke("Checking active jobs before stopping…");
        var status = await Api("/api/desktop/prepare-stop", new { }, ct);
        if (status["busy"]?.GetValue<bool>() != false)
            throw new InvalidOperationException("Active or unverified jobs prevent stopping. Check the WEB queue and PS4 operations.");
        if (settings.Mode == "compose") await Compose(["stop"], ct);
        else if (server is { HasExited: false }) { server.Kill(true); await server.WaitForExitAsync(ct); }
        // Native managed Prowlarr may be adopted after a launcher crash.
        if (settings.ManagedProwlarr && settings.Mode == "native" && prowlarr == null)
        {
            var folder = Path.Combine(Program.UserDirectory, "components", "prowlarr") + Path.DirectorySeparatorChar;
            foreach (var process in Process.GetProcessesByName("Prowlarr"))
            {
                try { if (process.MainModule?.FileName?.StartsWith(folder, StringComparison.OrdinalIgnoreCase) == true) { prowlarr = process; break; } } catch { process.Dispose(); }
            }
        }
        if (prowlarr is { HasExited: false }) { prowlarr.Kill(true); await prowlarr.WaitForExitAsync(ct); }
        if (settings.Mode == "native") {
            var folder = Path.Combine(Program.UserDirectory, "components", "flaresolverr") + Path.DirectorySeparatorChar;
            foreach (var process in Process.GetProcessesByName("flaresolverr")) {
                try {
                    if (process.MainModule?.FileName?.StartsWith(folder, StringComparison.OrdinalIgnoreCase) == true) {
                        process.Kill(true); await process.WaitForExitAsync(ct);
                    }
                } catch (InvalidOperationException) { } finally { process.Dispose(); }
            }
        }
        Started = false; Status?.Invoke("PackageFlow stopped");
    }

    private Process StartProcess(ProcessStartInfo info)
    {
        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        // WEB's own logs remain in the WEB interface. Do not duplicate secrets from child output.
        process.OutputDataReceived += (_, _) => { };
        process.ErrorDataReceived += (_, _) => { };
        process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
        return process;
    }

    public Task<string> Compose(IEnumerable<string> arguments, CancellationToken ct) => ProcessRunner.Run("docker", new[] { "compose", "--file", ComposePath, "--project-name", "packageflow-desktop" }.Concat(arguments), DataDirectory, ct);

    private void BootstrapProwlarr(bool container)
    {
        var folder = Path.Combine(DataDirectory, "prowlarr"); Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "config.xml");
        if (File.Exists(path))
        {
            var document = XDocument.Load(path);
            var existing = document.Root?.Element("ApiKey")?.Value;
            if (!string.IsNullOrEmpty(existing)) settings.ProtectedProwlarrKey = LocalSecrets.Protect(existing);
            document.Root?.SetElementValue("BindAddress", container ? "*" : "127.0.0.1");
            document.Save(path);
        }
        else
        {
            var key = LocalSecrets.Generate(); settings.ProtectedProwlarrKey = LocalSecrets.Protect(key);
            // Only a loopback-published instance is managed without an additional GUI login.
            new XDocument(new XElement("Config", new XElement("BindAddress", container ? "*" : "127.0.0.1"), new XElement("Port", 9696),
                new XElement("ApiKey", key), new XElement("LaunchBrowser", false), new XElement("AuthenticationMethod", "External"),
                new XElement("AuthenticationRequired", "Enabled"), new XElement("UrlBase", ""))).Save(path);
        }
        settings.ProwlarrUrl = "http://127.0.0.1:9696";
        settings.Save(SettingsPath);
    }

    public async Task InstallProwlarr(IProgress<int>? progress, CancellationToken ct)
    {
        Status?.Invoke("Checking Prowlarr…");
        if (settings.ProtectedProwlarrKey.Length > 0 && settings.ManagedProwlarr)
        {
            try { using var probe = ProbeTimeout(ct); await new ProwlarrClient(http, settings.ProwlarrUrl, LocalSecrets.Read(settings.ProtectedProwlarrKey)).Indexers(probe.Token); Status?.Invoke("Prowlarr ready"); return; }
            catch (Exception) when (!ct.IsCancellationRequested) { }
        }
        var components = Path.Combine(Program.UserDirectory, "components", "prowlarr");
        var executable = File.Exists(Path.Combine(components, "Prowlarr.exe")) ? Path.Combine(components, "Prowlarr.exe") : Path.Combine(components, "Prowlarr", "Prowlarr.exe");
        if (!File.Exists(executable))
        {
            Status?.Invoke("Downloading Prowlarr…");
            var asset = await ReleaseDownloads.Latest(http, "Prowlarr/Prowlarr", name => name.EndsWith("windows-core-x64.zip"), ct)
                ?? throw new InvalidOperationException("No Windows x64 Prowlarr release.");
            var zip = Path.Combine(Program.UserDirectory, "downloads", "prowlarr.zip");
            await ReleaseDownloads.Download(http, asset, zip, Progress(progress), ct);
            var staging = components + ".staging-" + Guid.NewGuid().ToString("N");
            try
            {
                Status?.Invoke("Extracting Prowlarr…");
                await Task.Run(() => ReleaseDownloads.ExtractZip(zip, staging), ct);
                var found = Directory.GetFiles(staging, "Prowlarr.exe", SearchOption.AllDirectories).Single();
                if (Directory.Exists(components)) throw new InvalidOperationException("Incomplete Prowlarr installation; inspect its components folder.");
                Directory.CreateDirectory(Path.GetDirectoryName(components)!);
                Directory.Move(staging, components);
                executable = Path.Combine(components, Path.GetRelativePath(staging, found));
            }
            finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
        }
        CheckPort(9696);
        BootstrapProwlarr(false);
        Status?.Invoke("Starting Prowlarr…");
        prowlarr = StartProcess(ProcessRunner.Info(executable, ["-nobrowser", "-data=" + Path.Combine(DataDirectory, "prowlarr")], Path.GetDirectoryName(executable)!));
        settings.ManagedProwlarr = true; settings.Save(SettingsPath);
        var client = new ProwlarrClient(http, settings.ProwlarrUrl, LocalSecrets.Read(settings.ProtectedProwlarrKey));
        for (var attempt = 0; attempt < 90; attempt++)
        {
            try { using var probe = ProbeTimeout(ct); await client.Indexers(probe.Token); Status?.Invoke("Prowlarr ready"); return; } catch (Exception) when (!ct.IsCancellationRequested) { }
            if (prowlarr.HasExited) throw new InvalidOperationException("Prowlarr stopped during startup.");
            await Task.Delay(1000, ct);
        }
        throw new InvalidOperationException("Prowlarr did not start. Open its log in the data folder.");
    }
    private async Task<bool> FlareReady(CancellationToken ct)
    {
        try {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));
            var result = await http.GetFromJsonAsync<JsonNode>("http://127.0.0.1:8191/", timeout.Token);
            return result?["msg"]?.GetValue<string>() == "FlareSolverr is ready!";
        } catch (Exception) when (!ct.IsCancellationRequested) { return false; }
    }

    public async Task InstallFlareSolverr(IProgress<int>? progress, CancellationToken ct)
    {
        Status?.Invoke("Checking FlareSolverr…");
        if (settings.Mode == "compose") {
            settings.FlareSolverr = true; settings.Save(SettingsPath);
            var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(InstallDirectory, "release.json")))!;
            File.WriteAllText(ComposePath, ComposeConfiguration.Generate(settings, DataDirectory, LocalSecrets.Read(settings.ProtectedLauncherKey), manifest["dockerImage"]!.GetValue<string>(), InstallDirectory));
            await Compose(["up", "-d", "--no-build", "--pull", "missing", "flaresolverr"], ct);
        } else if (!await FlareReady(ct)) {
            CheckPort(8191);
            var components = Path.Combine(Program.UserDirectory, "components", "flaresolverr");
            var executable = Directory.Exists(components) ? Directory.GetFiles(components, "flaresolverr.exe", SearchOption.AllDirectories).SingleOrDefault() : null;
            if (executable == null) {
                Status?.Invoke("Downloading FlareSolverr…");
                var asset = await ReleaseDownloads.Latest(http, "FlareSolverr/FlareSolverr", name => name == "flaresolverr_windows_x64.zip", ct)
                    ?? throw new InvalidOperationException("No Windows x64 FlareSolverr release.");
                var zip = Path.Combine(Program.UserDirectory, "downloads", "flaresolverr.zip");
                await ReleaseDownloads.Download(http, asset, zip, Progress(progress), ct);
                var staging = components + ".staging-" + Guid.NewGuid().ToString("N");
                try {
                    Status?.Invoke("Extracting FlareSolverr…");
                    await Task.Run(() => ReleaseDownloads.ExtractZip(zip, staging), ct);
                    var found = Directory.GetFiles(staging, "flaresolverr.exe", SearchOption.AllDirectories).Single();
                    if (Directory.Exists(components)) throw new InvalidOperationException("Incomplete FlareSolverr installation; inspect its components folder.");
                    Directory.CreateDirectory(Path.GetDirectoryName(components)!); Directory.Move(staging, components);
                    executable = Path.Combine(components, Path.GetRelativePath(staging, found));
                } finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
            }
            var info = ProcessRunner.Info(executable, [], Path.GetDirectoryName(executable)!);
            info.Environment["HOST"] = "127.0.0.1"; info.Environment["PORT"] = "8191";
            info.Environment["LOG_LEVEL"] = "info"; info.Environment["LOG_HTML"] = "false";
            // English challenge titles are recognized by FlareSolverr 3.5.2.
            // Windows' hidden browser failed RuTracker verification in live tests;
            // the visible browser solved it and produced cookies accepted over HTTP.
            info.Environment["LANG"] = "en-US";
            info.Environment["HEADLESS"] = settings.FlareSolverrVisibleBrowser ? "false" : "true";
            Status?.Invoke("Starting FlareSolverr and Chromium…");
            flareSolverr = StartProcess(info);
        }
        for (var attempt = 0; attempt < 90; attempt++) {
            if (await FlareReady(ct)) { settings.FlareSolverr = true; settings.Save(SettingsPath); Status?.Invoke("FlareSolverr ready"); return; }
            if (flareSolverr?.HasExited == true) throw new InvalidOperationException("FlareSolverr stopped during startup.");
            await Task.Delay(1000, ct);
        }
        throw new InvalidOperationException("FlareSolverr did not start. Check port 8191 and the component folder.");
    }

}
