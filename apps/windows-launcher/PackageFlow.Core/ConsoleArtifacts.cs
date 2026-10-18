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
        var elfEntry=json["elf"];
        // Optional since 030b: the firmware list the ELF was checked on, never a gate.
        if(!(elfEntry?["firmware"] is null || Regex.IsMatch(elfEntry!["firmware"]!.GetValue<string>(),@"^\d{1,2}\.\d{2}(?:,\d{1,2}\.\d{2}){0,15}$")) || !Regex.IsMatch(elfEntry?["version"]?.GetValue<string>() ?? "",@"^\d+\.\d+\.\d+(?:-dev)?$") || !Regex.IsMatch(elfEntry?["buildId"]?.GetValue<string>() ?? "", "^[a-z0-9-]{1,64}$"))throw new InvalidDataException("Invalid ELF release identity.");
        var files = new List<(string Source, string Target)>();
        foreach (var role in json["ps4"] == null ? new[] { "elf", "app" } : new[] { "elf", "app", "ps4" }) {
            var entry = json[role] ?? throw new InvalidDataException("Incomplete PS5 release bundle.");
            var name = entry["fileName"]?.GetValue<string>() ?? "";
            var size = entry["size"]?.GetValue<long>() ?? 0;
            var hash = entry["sha256"]?.GetValue<string>() ?? "";
            if (!Regex.IsMatch(name, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") || name.Contains("..") || !Regex.IsMatch(hash, "^[a-f0-9]{64}$") || size <= 0 || size > (role == "elf" ? 4 * 1024 * 1024 : role == "ps4" ? 25 * 1024 * 1024 : 256 * 1024 * 1024))
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
        // A running ELF uses the same verified bundled candidate as first setup.
        var elf=json["elf"]!;
        var updates=Path.Combine(Path.GetDirectoryName(destination)!,"ps5-service-updates");Directory.CreateDirectory(updates);
        var elfTarget=Path.Combine(updates,"PackageFlowService-PS5.elf");
        File.Copy(Path.Combine(bundle,elf["fileName"]!.GetValue<string>()),elfTarget+".tmp",true);File.Move(elfTarget+".tmp",elfTarget,true);
        var release=new JsonObject {
            ["service"]="PackageFlowService-PS5",["fileName"]="PackageFlowService-PS5.elf",
            ["version"]=elf["version"]!.DeepClone(),["buildId"]=elf["buildId"]!.DeepClone(),
            ["sha256"]=elf["sha256"]!.DeepClone(),["firmware"]=elf["firmware"]?.DeepClone() ?? (JsonNode)""
        };
        File.WriteAllText(Path.Combine(updates,"release.json.tmp"),release.ToJsonString());
        File.Move(Path.Combine(updates,"release.json.tmp"),Path.Combine(updates,"release.json"),true);
    }
}
