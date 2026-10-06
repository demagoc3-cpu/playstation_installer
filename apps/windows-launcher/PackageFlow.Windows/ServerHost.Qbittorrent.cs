using System.Diagnostics;
using System.Net;
using Microsoft.Win32;
using PackageFlow.Core;

namespace PackageFlow.Windows;

internal sealed partial class ServerHost
{
    private string QbittorrentProfile => Path.Combine(HostDataDirectory, "qbittorrent");

    private static string? FindQbittorrent()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\qBittorrent");
        var candidates = new[] {
            key?.GetValue("InstallLocation") as string,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "qBittorrent"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "qBittorrent")
        };
        return candidates.Where(p => !string.IsNullOrWhiteSpace(p)).Select(p => Path.Combine(p!, "qbittorrent.exe")).FirstOrDefault(File.Exists);
    }

    public async Task InstallQbittorrent(IProgress<int>? progress, CancellationToken ct)
    {
        if (settings.Mode != "native") throw new InvalidOperationException("Automatic qBittorrent setup is available in Windows mode. Connect your download client in Downloads for Compose.");
        Status?.Invoke("Checking qBittorrent…");
        var saved = await Api("/api/torrents/settings", ct: ct);
        if (saved["configured"]?.GetValue<bool>() == true)
        {
            if (settings.ManagedQbittorrent) await StartQbittorrent(ct);
            saved = await Api("/api/torrents/settings", ct: ct);
            if (saved["ready"]?.GetValue<bool>() != true) throw new InvalidOperationException("The saved qBittorrent connection is unavailable. Check its settings in Downloads.");
            Status?.Invoke("qBittorrent ready"); return;
        }
        var executable = FindQbittorrent();
        if (executable == null)
        {
            Status?.Invoke("Downloading qBittorrent…");
            var asset = await ReleaseDownloads.Latest(http, "qbittorrent/qBittorrent", QbittorrentBootstrap.IsWindowsAsset, ct)
                ?? throw new InvalidOperationException("No verified Windows x64 qBittorrent release.");
            var setup = Path.Combine(UserDirectory, "downloads", asset.Name);
            await ReleaseDownloads.Download(http, asset, setup, Progress(progress), ct);
            Status?.Invoke("Installing qBittorrent: approve the Windows administrator prompt…");
            using var installer = Process.Start(new ProcessStartInfo(setup) { UseShellExecute = true, Verb = "runas", Arguments = "/S" })
                ?? throw new InvalidOperationException("Could not start the qBittorrent installer.");
            // Cancellation must not terminate another application's installer.
            await installer.WaitForExitAsync(ct);
            if (installer.ExitCode != 0) throw new InvalidOperationException("qBittorrent installation did not complete. Retry automatic setup.");
            executable = FindQbittorrent() ?? throw new FileNotFoundException("qBittorrent was not found after installation.");
        }
        settings.QbittorrentExecutable = executable;
        if (!settings.ManagedQbittorrent) {
            var port = Enumerable.Range(8090, 30).FirstOrDefault(p => p != settings.Port && p != settings.PayloadPort && PortAvailable(p));
            if (port == 0) throw new InvalidOperationException("No free local port for qBittorrent.");
            settings.QbittorrentPort = port;
            settings.ProtectedQbittorrentPassword = LocalSecrets.Protect(LocalSecrets.Generate());
            var config = QbittorrentBootstrap.ProfileFile(QbittorrentProfile);
            // An interrupted setup resumes this profile using its saved password.
            if (File.Exists(config)) throw new InvalidOperationException("An existing PackageFlow qBittorrent profile needs manual inspection. It was not overwritten.");
            settings.ManagedQbittorrent = true; settings.Save(HostSettingsPath);
        }
        await StartQbittorrent(ct);
        Status?.Invoke("Connecting qBittorrent to WEB…");
        await Api("/api/torrents/settings", new { baseUrl = $"http://127.0.0.1:{settings.QbittorrentPort}", username = QbittorrentBootstrap.Username,
            password = LocalSecrets.Read(settings.ProtectedQbittorrentPassword), downloadPath = settings.GamesDirectory, remotePath = settings.GamesDirectory }, ct);
        var status = await Api("/api/torrents/settings", ct: ct);
        if (status["ready"]?.GetValue<bool>() != true) throw new InvalidOperationException("qBittorrent started but WEB could not connect. Check Downloads.");
        Status?.Invoke("qBittorrent ready");
    }

    private static bool PortAvailable(int port) { try { CheckPort(port); return true; } catch { return false; } }

    private async Task<bool> QbittorrentReady(CancellationToken ct)
    {
        using var client = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer() }) { Timeout = TimeSpan.FromSeconds(3) };
        var address = $"http://127.0.0.1:{settings.QbittorrentPort}";
        try {
            using var login = await client.PostAsync(address + "/api/v2/auth/login", new FormUrlEncodedContent(new Dictionary<string, string> {
                ["username"] = QbittorrentBootstrap.Username, ["password"] = LocalSecrets.Read(settings.ProtectedQbittorrentPassword)
            }), ct);
            if (!login.IsSuccessStatusCode || (await login.Content.ReadAsStringAsync(ct)).Trim().Equals("Fails.", StringComparison.OrdinalIgnoreCase)) return false;
            using var version = await client.GetAsync(address + "/api/v2/app/version", ct);
            return version.IsSuccessStatusCode && (await version.Content.ReadAsStringAsync(ct)).Trim().StartsWith("v");
        } catch (Exception) when (!ct.IsCancellationRequested) { return false; }
    }

    private async Task StartQbittorrent(CancellationToken ct)
    {
        if (await QbittorrentReady(ct)) return;
        CheckPort(settings.QbittorrentPort);
        var config = QbittorrentBootstrap.ProfileFile(QbittorrentProfile);
        if (!File.Exists(config)) {
            Directory.CreateDirectory(Path.GetDirectoryName(config)!);
            File.WriteAllText(config, QbittorrentBootstrap.Configuration(settings.QbittorrentPort, LocalSecrets.Read(settings.ProtectedQbittorrentPassword), settings.GamesDirectory));
        }
        var executable = File.Exists(settings.QbittorrentExecutable) ? settings.QbittorrentExecutable : FindQbittorrent()
            ?? throw new FileNotFoundException("Managed qBittorrent is missing. Retry automatic setup.");
        Status?.Invoke("Starting qBittorrent…");
        var process = StartProcess(ProcessRunner.Info(executable, ["--profile=" + QbittorrentProfile, "--configuration=" + QbittorrentBootstrap.ConfigurationName, "--no-splash", "--confirm-legal-notice"], Path.GetDirectoryName(executable)!));
        for (var attempt = 0; attempt < 45; attempt++) {
            if (await QbittorrentReady(ct)) { Status?.Invoke("qBittorrent ready"); return; }
            if (process.HasExited) throw new InvalidOperationException("qBittorrent stopped during startup.");
            await Task.Delay(1000, ct);
        }
        throw new InvalidOperationException("qBittorrent Web UI did not start. Check the PackageFlow profile.");
    }
}
