using System.IO.Compression;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

// Validate the actual single-file payload, rather than bin/obj files that another
// build may replace. Bundle v6 is the format emitted by the pinned .NET 8 SDK.
try
{
    if (args.Length != 2) throw new ArgumentException("Provide PackageFlow.exe and release version.");
    var expected = Version.Parse(args[1] + ".0");
    var bytes = File.ReadAllBytes(args[0]);
    var signature = Convert.FromHexString("8B1202B96A612038727B930214D7A03213F5B9E6EFAE3318EE3B2DCE24B36AAE");
    var marker = bytes.AsSpan().IndexOf(signature);
    if (marker < 8) throw new InvalidDataException("No .NET single-file bundle header.");
    using var stream = new MemoryStream(bytes, writable: false);
    using var reader = new BinaryReader(stream);
    stream.Position = marker - 8;
    var header = reader.ReadInt64();
    if (header < 0 || header >= bytes.Length) throw new InvalidDataException("Invalid bundle offset.");
    stream.Position = header;
    if (reader.ReadUInt32() != 6 || reader.ReadUInt32() != 0) throw new InvalidDataException("Expected bundle v6.");
    var count = reader.ReadInt32();
    if (count < 1 || count > 4096) throw new InvalidDataException("Invalid bundle entry count.");
    _ = reader.ReadString(); // bundle ID
    stream.Position += 40; // deps/runtimeconfig locations and flags
    var assemblies = new Dictionary<string, (Version Version, List<(string Name, Version Version)> References)>();
    for (var i = 0; i < count; i++)
    {
        var offset = reader.ReadInt64();
        var size = reader.ReadInt64();
        var compressed = reader.ReadInt64();
        _ = reader.ReadByte();
        var name = reader.ReadString();
        if (!name.StartsWith("PackageFlow", StringComparison.Ordinal) || !name.EndsWith(".dll", StringComparison.Ordinal)) continue;
        var length = compressed == 0 ? size : compressed;
        if (offset < 0 || length < 1 || size > 16 * 1024 * 1024 || offset > bytes.Length - length)
            throw new InvalidDataException("Invalid assembly entry: " + name);
        using var content = new MemoryStream(bytes, checked((int)offset), checked((int)length), writable: false);
        using var unpacked = new MemoryStream();
        if (compressed > 0) { using var inflater = new DeflateStream(content, CompressionMode.Decompress); inflater.CopyTo(unpacked); }
        else content.CopyTo(unpacked);
        if (unpacked.Length != size) throw new InvalidDataException("Assembly size mismatch: " + name);
        unpacked.Position = 0;
        using var pe = new PEReader(unpacked);
        var metadata = pe.GetMetadataReader();
        var definition = metadata.GetAssemblyDefinition();
        var references = metadata.AssemblyReferences.Select(handle => metadata.GetAssemblyReference(handle))
            .Where(reference => metadata.GetString(reference.Name).StartsWith("PackageFlow", StringComparison.Ordinal))
            .Select(reference => (metadata.GetString(reference.Name), reference.Version)).ToList();
        assemblies.Add(metadata.GetString(definition.Name), (definition.Version, references));
    }
    foreach (var name in new[] { "PackageFlow", "PackageFlow.Core" })
        if (!assemblies.TryGetValue(name, out var assembly) || assembly.Version != expected)
            throw new InvalidDataException($"Bundled {name} must have version {expected}; found {assembly.Version}.");
    foreach (var assembly in assemblies.Values)
        foreach (var reference in assembly.References)
            if (!assemblies.TryGetValue(reference.Name, out var dependency) || dependency.Version != reference.Version)
                throw new InvalidDataException($"Bundled dependency mismatch: {reference.Name} requires {reference.Version}.");
    Console.WriteLine($"PASS: bundled PackageFlow and Core {expected}; assembly references match.");
    return 0;
}
catch (Exception error) { Console.Error.WriteLine("FAIL: " + error.Message); return 1; }
