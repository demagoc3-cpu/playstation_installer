using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace PackageFlow.Core;

public sealed record DiscoveredConsole(string Ip, string Name, string Platform, bool Service = false,
    bool Loader = false, bool RestMode = false, string? Firmware = null, string? Model = null);

public static class ConsoleDiscovery
{
    // Read-only Sony DDP discovery. Protocol constants are documented by Chiaki.
    public static string SearchMessage(string platform) => platform switch {
        "ps4" => Ps4Discovery.SearchMessage,
        "ps5" => "SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n",
        _ => throw new ArgumentException("Unknown console platform.")
    };
    public static int DiscoveryPort(string platform) => platform == "ps5" ? 9302 : platform == "ps4" ? 987 : throw new ArgumentException("Unknown console platform.");
    private static uint Number(IPAddress ip) => ip.GetAddressBytes().Aggregate(0u, (n, b) => (n << 8) | b);
    private static IPAddress Address(uint n) => new(new byte[] { (byte)(n >> 24), (byte)(n >> 16), (byte)(n >> 8), (byte)n });
    public static DiscoveredConsole? ParseAnnouncement(string ip, int sourcePort, string message)
    {
        if (message.Length > 4096 || !(message.StartsWith("HTTP/1.1 200 ") || message.StartsWith("HTTP/1.1 620 "))) return null;
        var fields = message.Split('\n').Select(line => line.Trim().Split(':', 2)).Where(p => p.Length == 2)
            .GroupBy(p => p[0], StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First()[1].Trim(), StringComparer.OrdinalIgnoreCase);
        var platform = fields.GetValueOrDefault("host-type", "").ToLowerInvariant();
        if (platform is not ("ps4" or "ps5") || sourcePort != DiscoveryPort(platform)) return null;
        var protocol = fields.GetValueOrDefault("device-discovery-protocol-version");
        if (platform == "ps5" && protocol != "00030010" || platform == "ps4" && protocol != null && protocol != "00020020") return null;
        var name = new string(fields.GetValueOrDefault("host-name", platform.ToUpperInvariant()).Where(c => !char.IsControl(c)).Take(80).ToArray());
        // DDP system-version is a Remote Play protocol value, not firmware.
        return new(ip, name, platform, RestMode: message.StartsWith("HTTP/1.1 620 "));
    }
    public static string? Ps5Firmware(JsonNode? health)
    {
        if (health?["firmwareRead"]?.GetValue<bool>() != true) return null;
        var m = Regex.Match(health["firmwareRaw"]?.GetValue<string>() ?? "", "^0x([0-9]{2})([0-9]{2})[0-9a-fA-F]{4}$");
        return m.Success ? $"{int.Parse(m.Groups[1].Value)}.{m.Groups[2].Value}" : null;
    }
    public static bool IsPs5Service(JsonNode? health) => health?["apiVersion"]?.GetValue<string>() == "v1"
        && health["serviceReport"]?["service"]?.GetValue<string>() == "PackageFlowService-PS5"
        && health["serviceReport"]?["platform"]?.GetValue<string>() == "ps5"
        && health["serviceReport"]?["consoleVerified"]?.GetValue<bool>() == true;
    public static DiscoveredConsole? FromServices(string ip, JsonNode? ps4, JsonNode? ps5)
    {
        var four = ps4?["service"]?.GetValue<string>() == "PackegeFlowService" && ps4["environment"]?.GetValue<string>() == "ps4";
        var five = IsPs5Service(ps5);
        if (four && five) throw new InvalidDataException("Conflicting console platform responses.");
        return five ? new(ip, "PS5", "ps5", true, Firmware: Ps5Firmware(ps5)) : four ? new(ip, "PS4", "ps4", true) : null;
    }
    // Detect a manually entered address without guessing from a generic ELF port.
    public static async Task<DiscoveredConsole?> Detect(string ip, CancellationToken ct)
    {
        if (!IPAddress.TryParse(ip, out var address) || address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address) || address.GetAddressBytes()[0] is 0 or >= 224)
            throw new ArgumentException("Invalid console IPv4.");
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false });
        var ps4 = Read(http, ip, 12801, "/system/info", ct); var ps5 = Read(http, ip, 8095, "/health", ct);
        await Task.WhenAll(ps4, ps5);
        var service = FromServices(ip, ps4.Result, ps5.Result);
        if (service != null) return service;
        async Task<DiscoveredConsole?> Announce(string platform) {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(1800);
            try {
                using var udp = new UdpClient(AddressFamily.InterNetwork);
                await udp.SendAsync(Encoding.ASCII.GetBytes(SearchMessage(platform)), new IPEndPoint(address, DiscoveryPort(platform)), timeout.Token);
                while (!timeout.IsCancellationRequested) {
                    var packet = await udp.ReceiveAsync(timeout.Token);
                    if (!packet.RemoteEndPoint.Address.Equals(address)) continue;
                    var row = ParseAnnouncement(ip, packet.RemoteEndPoint.Port, Encoding.UTF8.GetString(packet.Buffer));
                    if (row?.Platform == platform) return row;
                }
            } catch (Exception) when (!ct.IsCancellationRequested) { }
            return null;
        }
        var announcements = await Task.WhenAll(Announce("ps4"), Announce("ps5"));
        if (announcements.Count(row => row != null) > 1) throw new InvalidDataException("Conflicting console discovery responses.");
        var known = announcements.FirstOrDefault(row => row != null);
        if (known != null) return known;
        // PyLoader's own HTTP protocol identifies PS4; port 9021 alone does not identify PS5.
        return (await Read(http, ip, 9090, "/status", ct))?["status"]?.GetValue<string>() == "ready" ? new(ip, "PS4", "ps4", Loader: true) : null;
    }
    private static async Task<JsonNode?> Read(HttpClient http, string ip, int port, string path, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(1200);
        try {
            using var reply = await http.GetAsync($"http://{ip}:{port}{path}", HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!reply.IsSuccessStatusCode) return null;
            using var stream = await reply.Content.ReadAsStreamAsync(timeout.Token);
            var data = new byte[16385]; var size = 0;
            while (size < data.Length) { var n = await stream.ReadAsync(data.AsMemory(size), timeout.Token); if (n == 0) break; size += n; }
            return size < data.Length ? JsonNode.Parse(data.AsSpan(0, size)) : null;
        } catch (Exception) when (!ct.IsCancellationRequested) { return null; }
    }
    private static async Task<bool> Loader(string ip, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(900);
        try { using var socket = new TcpClient(); await socket.ConnectAsync(ip, 9021, timeout.Token); return true; }
        catch (Exception) when (!ct.IsCancellationRequested) { return false; }
    }
    public static async Task<DiscoveredConsole[]> Discover(string host, string mask, IEnumerable<DiscoveredConsole> saved, IProgress<int>? progress, CancellationToken ct, IProgress<DiscoveredConsole>? results = null)
    {
        var candidates = Ps4Discovery.Candidates(host, mask); // Includes private-network and scan-size bounds.
        var own = Number(IPAddress.Parse(host)); var subnet = Number(IPAddress.Parse(mask));
        var found = new ConcurrentDictionary<string, DiscoveredConsole>();
        foreach (var item in saved) if (IPAddress.TryParse(item.Ip, out var address) && address.AddressFamily == AddressFamily.InterNetwork && (Number(address) & subnet) == (own & subnet))
            found[item.Ip] = item with { Service = false, Loader = false, Firmware = null };
        async Task Announce(string platform) {
            try {
                using var udp = new UdpClient(new IPEndPoint(IPAddress.Parse(host), 0)) { EnableBroadcast = true };
                await udp.SendAsync(Encoding.ASCII.GetBytes(SearchMessage(platform)), new IPEndPoint(Address(own | ~subnet), DiscoveryPort(platform)), ct);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(2500);
                while (!timeout.IsCancellationRequested) {
                    var packet = await udp.ReceiveAsync(timeout.Token);
                    if (packet.RemoteEndPoint.Address.AddressFamily != AddressFamily.InterNetwork || (Number(packet.RemoteEndPoint.Address) & subnet) != (own & subnet)) continue;
                    var item = ParseAnnouncement(packet.RemoteEndPoint.Address.ToString(), packet.RemoteEndPoint.Port, Encoding.UTF8.GetString(packet.Buffer));
                    if (item != null && item.Platform == platform) { found[item.Ip] = item; results?.Report(item); }
                }
            } catch (Exception) when (!ct.IsCancellationRequested) { /* Continue with bounded HTTP discovery. */ }
        }
        await Task.WhenAll(Announce("ps4"), Announce("ps5"));
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false });
        var addresses = candidates.Concat(found.Keys).Distinct().ToArray(); var completed = 0;
        await Parallel.ForEachAsync(addresses, new ParallelOptions { MaxDegreeOfParallelism = 24, CancellationToken = ct }, async (ip, token) => {
            var ps4 = Read(http, ip, 12801, "/system/info", token);
            var ps5 = Read(http, ip, 8095, "/health", token);
            await Task.WhenAll(ps4, ps5);
            try {
                if (IsPs5Service(ps5.Result)) {
                    var old = found.GetValueOrDefault(ip);
                    found[ip] = new(ip, old?.Name ?? "PS5", "ps5", true, Firmware: Ps5Firmware(ps5.Result), Model: old?.Model);
                } else if (ps4.Result?["service"]?.GetValue<string>() == "PackegeFlowService" && ps4.Result["environment"]?.GetValue<string>() == "ps4") {
                    found[ip] = new(ip, found.GetValueOrDefault(ip)?.Name ?? "PS4", "ps4", true);
                } else if (found.TryGetValue(ip, out var known) && !known.RestMode) {
                    var loader = known.Platform == "ps5" ? await Loader(ip, token) : (await Read(http, ip, 9090, "/status", token))?["status"]?.GetValue<string>() == "ready";
                    found[ip] = known with { Loader = loader };
                } else {
                    var loader = await Read(http, ip, 9090, "/status", token);
                    if (loader?["status"]?.GetValue<string>() == "ready") found[ip] = new(ip, "PS4", "ps4", Loader: true);
                }
            } catch (Exception) when (!token.IsCancellationRequested) { /* Malformed responses are not proof. */ }
            if (found.TryGetValue(ip, out var result)) results?.Report(result);
            progress?.Report(Interlocked.Increment(ref completed) * 100 / addresses.Length);
        });
        return found.Values.OrderByDescending(x => x.Service).ThenByDescending(x => x.Loader).ThenBy(x => Number(IPAddress.Parse(x.Ip))).ToArray();
    }
}
