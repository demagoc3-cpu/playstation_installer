using System.Security.Cryptography;
using System.Text;

namespace PackageFlow.Core;

public static class QbittorrentBootstrap
{
    public const string Username = "packageflow";
    public const string ConfigurationName = "PackageFlow";
    public static bool IsWindowsAsset(string name) => System.Text.RegularExpressions.Regex.IsMatch(name, @"^qbittorrent_\d+\.\d+\.\d+_x64_setup\.exe$");
    public static string ProfileFile(string root) => Path.Combine(root, "qBittorrent_" + ConfigurationName, "config", "qBittorrent.ini");

    public static string Configuration(int port, string password, string gamesDirectory)
    {
        if (port is < 1024 or > 65535 || password.Length < 16) throw new ArgumentException("Invalid managed qBittorrent configuration.");
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, 100000, HashAlgorithmName.SHA512, 64);
        // Qt stores QByteArray as base64(salt):base64(PBKDF2). Only the isolated
        // PackageFlow profile is bootstrapped; the user's profile is never edited.
        var secret = Convert.ToBase64String(salt) + ":" + Convert.ToBase64String(hash);
        var folder = Path.GetFullPath(gamesDirectory).Replace('\\', '/').Replace("\"", "\\\"");
        return $"""
            [Preferences]
            WebUI\Enabled=true
            WebUI\Address=127.0.0.1
            WebUI\Port={port}
            WebUI\Username={Username}
            WebUI\Password_PBKDF2="@ByteArray({secret})"
            WebUI\LocalHostAuth=true
            WebUI\AuthSubnetWhitelistEnabled=false
            WebUI\UseUPnP=false
            General\MinimizeToTray=true
            Downloads\SavePath="{folder}"

            [BitTorrent]
            Session\DefaultSavePath="{folder}"

            [GUI]
            StartUpWindowState=Hidden
            """;
    }
}
