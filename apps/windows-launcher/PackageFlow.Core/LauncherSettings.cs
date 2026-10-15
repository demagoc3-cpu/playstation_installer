using System.Net;
using System.Text.Json;

namespace PackageFlow.Core;

public sealed class LauncherSettings
{
    public int Schema { get; set; } = 1;
    public string Language { get; set; } = "ru";
    // Retained only to read old profiles; no alternate runtime is supported.
    public string Mode { get; set; } = "native";
    public bool LegacyMigrationRequired { get; set; }
    public string WebDataDirectory { get; set; } = "";
    public string ImportedLegacyDataFrom { get; set; } = "";
    public int Port { get; set; } = 3000;
    public int PayloadPort { get; set; } = 3001;
    public string HostIp { get; set; } = "";
    public string GamesDirectory { get; set; } = "";
    public bool AutoStart { get; set; }
    public bool SetupComplete { get; set; }
    public bool WizardComplete { get; set; }
    public bool TorrentSetupSelected { get; set; }
    public List<string> FirstSetupConsoleIds { get; set; } = [];
    public bool AutomaticSetupPending { get; set; }
    public bool ManagedQbittorrent { get; set; }
    public int QbittorrentPort { get; set; } = 8090;
    public string QbittorrentExecutable { get; set; } = "";
    public string ProtectedQbittorrentPassword { get; set; } = "";
    public bool ManagedProwlarr { get; set; }
    public bool FlareSolverr { get; set; }
    public bool FlareSolverrVisibleBrowser { get; set; } = true;
    public string ProtectedLauncherKey { get; set; } = "";
    public string ProtectedProwlarrKey { get; set; } = "";
    public string ProwlarrUrl { get; set; } = "http://127.0.0.1:9696";
    public string TrackerUsername { get; set; } = "";
    public string ProtectedTrackerPassword { get; set; } = "";
    public bool PendingWebAddress { get; set; }
    public string PsIp { get; set; } = "";
    public string ConsoleId { get; set; } = "";
    public string ConsolePlatform { get; set; } = "ps4";
    public string SetupRemoveAppConsoleId { get; set; } = "";
    public string SetupRemoveAppRequestId { get; set; } = "";
    public string PendingSetupConsoleId { get; set; } = "";
    public string SetupAppRequestId { get; set; } = "";
    public string SetupAppConsoleId { get; set; } = "";
    public string SetupAppSha256 { get; set; } = "";
    public Dictionary<string, ConsoleSetupRequest> ConsoleSetupRequests { get; set; } = new();

    public bool RequiresRestart(LauncherSettings next) => Port != next.Port || PayloadPort != next.PayloadPort || HostIp != next.HostIp ||
        WebDataDirectory != next.WebDataDirectory || FlareSolverrVisibleBrowser != next.FlareSolverrVisibleBrowser;

    public void Validate()
    {
        if (Schema != 1 || Language is not ("ru" or "en") || Mode != "native" || ConsolePlatform is not ("ps4" or "ps5"))
            throw new InvalidOperationException("Unsupported launcher settings.");
        if (Port is < 1024 or > 65535 || PayloadPort is < 1024 or > 65535 || Port == PayloadPort)
            throw new InvalidOperationException("Invalid server ports.");
        if (QbittorrentPort is < 1024 or > 65535 || (ManagedQbittorrent && (QbittorrentPort == Port || QbittorrentPort == PayloadPort)))
            throw new InvalidOperationException("Choose different WEB, PS4 and qBittorrent ports.");
        if (HostIp.Length > 0 && (!IPAddress.TryParse(HostIp, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork || ip.Equals(IPAddress.Any) || IPAddress.IsLoopback(ip)))
            throw new InvalidOperationException("Choose the computer's LAN IPv4 address.");
        if (WebDataDirectory.Length > 0 && !Path.IsPathFullyQualified(WebDataDirectory)) throw new InvalidOperationException("Choose an absolute Windows WEB data directory.");
    }

    public static LauncherSettings Load(string path)
    {
        if (!File.Exists(path)) return new();
        var json = File.ReadAllText(path);
        using var document = JsonDocument.Parse(json);
        if(document.RootElement.ValueKind!=JsonValueKind.Object || document.RootElement.EnumerateObject().GroupBy(p=>p.Name,StringComparer.OrdinalIgnoreCase).Any(g=>g.Count()>1))throw new InvalidDataException("Ambiguous launcher settings; source preserved.");
        var settings = JsonSerializer.Deserialize<LauncherSettings>(json,new JsonSerializerOptions{PropertyNameCaseInsensitive=true}) ?? throw new InvalidDataException("Invalid settings file.");
        bool Has(string name)=>document.RootElement.EnumerateObject().Any(p=>string.Equals(p.Name,name,StringComparison.OrdinalIgnoreCase));
        // Migrate existing installs without initiating downloads on their behalf.
        if (!Has(nameof(WizardComplete)))
            settings.WizardComplete = settings.SetupComplete || settings.ManagedProwlarr || settings.ManagedQbittorrent || settings.FlareSolverr || settings.ProtectedLauncherKey.Length > 0;
        if (!Has(nameof(TorrentSetupSelected)))
            settings.TorrentSetupSelected = settings.ManagedProwlarr || settings.ManagedQbittorrent || settings.FlareSolverr;
        if(settings.Mode == "compose") { settings.Mode = "native"; settings.LegacyMigrationRequired = true; }
        return settings;
    }

    public void Save(string path)
    {
        Validate();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if(File.Exists(path)) {
            using var original = JsonDocument.Parse(File.ReadAllText(path));
            var oldMode=original.RootElement.EnumerateObject().FirstOrDefault(p=>string.Equals(p.Name,nameof(Mode),StringComparison.OrdinalIgnoreCase)).Value;
            if(oldMode.ValueKind==JsonValueKind.String && oldMode.GetString()=="compose") {
                var backup=path+".pre-native-1.10.15.json";
                if(!File.Exists(backup))File.Copy(path,backup,false);
            }
        }
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temp, path, true);
    }
}

public sealed class ConsoleSetupRequest
{
    public string RequestId { get; set; } = "";
    public string Sha256 { get; set; } = "";
}
