using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace PackageFlow.Core;

public sealed record ReleaseAsset(string Version, string Name, Uri Url, long Size, string Sha256);

public static class ReleaseDownloads
{
    // WEB/PS4 release tags and the Windows installer have independent versions.
    // A newer console release may have no EXE, so inspect recent stable releases.
    public static async Task<ReleaseAsset?> LatestWindows(HttpClient http, CancellationToken ct)
    {
        const string repository = "demagoc3-cpu/playstation_installer";
        using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{repository}/releases?per_page=100");
        request.Headers.UserAgent.ParseAdd("PackageFlow-Windows/0.1");
        using var response = await http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        var releases = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct))!.AsArray();
        JsonNode? selected = null; Version? newest = null;
        foreach (var release in releases)
        {
            if (release?["draft"]?.GetValue<bool>() == true || release?["prerelease"]?.GetValue<bool>() == true) continue;
            foreach (var asset in release?["assets"]?.AsArray() ?? [])
            {
                var match = System.Text.RegularExpressions.Regex.Match(asset?["name"]?.GetValue<string>() ?? "", @"^PackageFlowSetup-(\d+\.\d+\.\d+)-x64\.exe$");
                if (!match.Success || !Version.TryParse(match.Groups[1].Value, out var version) || !ValidWindowsVersion(version) || (newest != null && version <= newest)) continue;
                selected = asset; newest = version;
            }
        }
        return selected == null ? null : VerifiedAsset(selected, repository, newest!.ToString());
    }

    // 10.x.x installers were accidentally published instead of 1.x.x. Do not
    // offer that invalid release line again after a user repairs their install.
    private static bool ValidWindowsVersion(Version version) => version.Major != 10;

    public static bool IsNewerWindows(ReleaseAsset release, Version installed)
    {
        if (!Version.TryParse(release.Version, out var target) || !ValidWindowsVersion(target)) return false;
        // Release filenames contain three numbers; assembly versions have four.
        return new Version(target.Major, target.Minor, Math.Max(0, target.Build))
            > new Version(installed.Major, installed.Minor, Math.Max(0, installed.Build));
    }

    public static async Task<ReleaseAsset?> Latest(HttpClient http, string repository, Func<string, bool> select, CancellationToken ct)
    {
        if (repository is not ("demagoc3-cpu/playstation_installer" or "Prowlarr/Prowlarr" or "FlareSolverr/FlareSolverr" or "qbittorrent/qBittorrent")) throw new ArgumentException("Unknown repository.");
        using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{repository}/releases/latest");
        request.Headers.UserAgent.ParseAdd("PackageFlow-Windows/0.1");
        using var response = await http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        var release = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct))!;
        if (release["draft"]?.GetValue<bool>() == true || release["prerelease"]?.GetValue<bool>() == true) return null;
        var asset = release["assets"]!.AsArray().FirstOrDefault(a => select(a!["name"]!.GetValue<string>()));
        if (asset == null) return null;
        return VerifiedAsset(asset, repository, release["tag_name"]!.GetValue<string>());
    }

    private static ReleaseAsset VerifiedAsset(JsonNode asset, string repository, string version)
    {
        var uri = new Uri(asset["browser_download_url"]!.GetValue<string>());
        var prefix = $"https://github.com/{repository}/releases/download/";
        var digest = asset["digest"]?.GetValue<string>() ?? "";
        var size = asset["size"]!.GetValue<long>();
        var name = asset["name"]!.GetValue<string>();
        if (name != Path.GetFileName(name) || name.Contains('\\') || name.Contains('/') || name.Contains(':')) throw new InvalidDataException("Unsafe asset name.");
        if (!uri.AbsoluteUri.StartsWith(prefix, StringComparison.Ordinal) || !System.Text.RegularExpressions.Regex.IsMatch(digest, "^sha256:[0-9a-fA-F]{64}$") || size < 1 || size > 1_000_000_000)
            throw new InvalidDataException("Release has no verifiable SHA-256 asset.");
        return new(version, name, uri, size, digest[7..]);
    }

    public static async Task Download(HttpClient http, ReleaseAsset asset, string destination, IProgress<int>? progress, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = destination + ".part";
        try
        {
            using var response = await http.GetAsync(asset.Url, HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();
            await using var input = await response.Content.ReadAsStreamAsync(ct);
            await using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[128 * 1024]; long total = 0; int length;
                while ((length = await input.ReadAsync(buffer, ct)) > 0)
                {
                    total += length;
                    if (total > asset.Size) throw new InvalidDataException("Download is larger than the release asset.");
                    hash.AppendData(buffer, 0, length);
                    await output.WriteAsync(buffer.AsMemory(0, length), ct);
                    progress?.Report((int)(total * 100 / asset.Size));
                }
                if (total != asset.Size || !Convert.ToHexString(hash.GetHashAndReset()).Equals(asset.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Download size or SHA-256 verification failed.");
            }
            File.Move(temporary, destination, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public static void ExtractZip(string zip, string destination)
    {
        Directory.CreateDirectory(destination);
        var root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
        using var archive = ZipFile.OpenRead(zip);
        long expanded = 0;
        foreach (var entry in archive.Entries)
        {
            var target = Path.GetFullPath(Path.Combine(destination, entry.FullName.Replace('\\', '/')));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Unsafe archive path.");
            expanded += entry.Length;
            if (expanded > 2_000_000_000 || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000) throw new InvalidDataException("Unsafe archive entry.");
            if (entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\')) { Directory.CreateDirectory(target); continue; }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, false);
        }
    }
}
