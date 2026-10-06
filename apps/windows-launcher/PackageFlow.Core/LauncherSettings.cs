using System.Net;
using System.Text.Json;

namespace PackageFlow.Core;

public sealed class LauncherSettings
{
    public int Schema { get; set; } = 1;
    public string Language { get; set; } = "ru";
    public string Mode { get; set; } = "native";
    public int Port { get; set; } = 3000;
    public int PayloadPort { get; set; } = 3001;
    public string HostIp { get; set; } = "";
    public string GamesDirectory { get; set; } = "";
    public bool AutoStart { get; set; }
    public bool SetupComplete { get; set; }
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

    public bool RequiresRestart(LauncherSettings next) => Mode != next.Mode || Port != next.Port || PayloadPort != next.PayloadPort || HostIp != next.HostIp ||
        FlareSolverrVisibleBrowser != next.FlareSolverrVisibleBrowser ||
        (next.Mode == "compose" && (GamesDirectory != next.GamesDirectory || ManagedProwlarr != next.ManagedProwlarr));

    public void Validate()
    {
        if (Schema != 1 || Language is not ("ru" or "en") || Mode is not ("native" or "compose"))
            throw new InvalidOperationException("Unsupported launcher settings.");
        if (Port is < 1024 or > 65535 || PayloadPort is < 1024 or > 65535 || Port == PayloadPort)
            throw new InvalidOperationException("Invalid server ports.");
        if (QbittorrentPort is < 1024 or > 65535 || (ManagedQbittorrent && (QbittorrentPort == Port || QbittorrentPort == PayloadPort)))
            throw new InvalidOperationException("Choose different WEB, PS4 and qBittorrent ports.");
        if (HostIp.Length > 0 && (!IPAddress.TryParse(HostIp, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork || ip.Equals(IPAddress.Any) || IPAddress.IsLoopback(ip)))
            throw new InvalidOperationException("Choose the computer's LAN IPv4 address.");
        if (Mode == "compose" && HostIp.Length == 0) throw new InvalidOperationException("Docker Compose requires the computer's LAN IPv4 address.");
    }

    public static LauncherSettings Load(string path)
    {
        if (!File.Exists(path)) return new();
        return JsonSerializer.Deserialize<LauncherSettings>(File.ReadAllText(path)) ?? throw new InvalidDataException("Invalid settings file.");
    }

    public void Save(string path)
    {
        Validate();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temp, path, true);
    }
}
