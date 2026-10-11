using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace PackageFlow.Core;

public static class ConsoleArtifacts
{
    // The installer carries a release manifest, never a private GitHub token.
    // Only explicit, verified release binaries may become bootstrap artifacts.
    public static void Stage(string bundle, string destination)
    {
        var manifest = Path.Combine(bundle, "manifest.json");
        if (!File.Exists(manifest)) return; // PS4 installations still work without PS5 binaries.
        var json = JsonNode.Parse(File.ReadAllText(manifest)) ?? throw new InvalidDataException("Invalid console manifest.");
        if (json["schemaVersion"]?.GetValue<int>() != 1) throw new InvalidDataException("Unsupported console manifest.");
        var files = new List<(string Source, string Target)>();
        foreach (var role in new[] { "elf", "app" }) {
            var entry = json[role] ?? throw new InvalidDataException("Incomplete PS5 release bundle.");
            var name = entry["fileName"]?.GetValue<string>() ?? "";
            var size = entry["size"]?.GetValue<long>() ?? 0;
            var hash = entry["sha256"]?.GetValue<string>() ?? "";
            if (!Regex.IsMatch(name, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") || name.Contains("..") || !Regex.IsMatch(hash, "^[a-f0-9]{64}$") || size <= 0 || size > (role == "elf" ? 4 * 1024 * 1024 : 256 * 1024 * 1024))
                throw new InvalidDataException("Invalid console artifact.");
            var source = Path.Combine(bundle, name);
            var info = new FileInfo(source);
            if (!info.Exists || info.LinkTarget != null || info.Length != size) throw new InvalidDataException("Console artifact size changed.");
            using var stream = File.OpenRead(source);
            if (Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant() != hash) throw new InvalidDataException("Console artifact checksum mismatch.");
            files.Add((source, Path.Combine(destination, name)));
        }
        Directory.CreateDirectory(destination);
        foreach (var (source, target) in files) {
            File.Copy(source, target + ".tmp", true); File.Move(target + ".tmp", target, true);
        }
        File.WriteAllText(Path.Combine(destination, "manifest.json.tmp"), json.ToJsonString());
        File.Move(Path.Combine(destination, "manifest.json.tmp"), Path.Combine(destination, "manifest.json"), true);
    }
}
