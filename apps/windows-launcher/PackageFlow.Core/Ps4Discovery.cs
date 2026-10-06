using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace PackageFlow.Core;

public sealed record DiscoveredPs4(string Ip, string Name, bool Service, bool PyLoader, bool RestMode);

public static class Ps4Discovery
{
    // PS4 Device Discovery Protocol: SRCH is read-only; no wake or launch command.
    public const string SearchMessage = "SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00020020\n";
    private static uint Number(IPAddress ip) => ip.GetAddressBytes().Aggregate(0u, (value, part) => (value << 8) | part);
    private static string Address(uint value) => new IPAddress(new byte[] { (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value }).ToString();
    private static bool Private(IPAddress ip)
    {
        if (ip.AddressFamily != AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        return b[0] == 10 || b[0] == 192 && b[1] == 168 || b[0] == 172 && b[1] >= 16 && b[1] <= 31;
    }
    public static string[] Candidates(string host, string mask)
    {
        if (!IPAddress.TryParse(host, out var ip) || !Private(ip) || !IPAddress.TryParse(mask, out var subnet) || subnet.AddressFamily != AddressFamily.InterNetwork)
            throw new ArgumentException("Choose a local IPv4 network for PS4 discovery.");
        var m = Number(subnet); var inverse = ~m;
        if (m == 0 || (inverse & (inverse + 1)) != 0 || inverse < 3) throw new ArgumentException("Invalid IPv4 subnet mask.");
        // Large LANs retain broadcast discovery. Bound the HTTP fallback to the
        // nearest /24 instead of probing tens of thousands of machines.
        if (inverse > 1023) { m = 0xffffff00; inverse = 255; }
        var start = Number(ip) & m;
        return Enumerable.Range(1, (int)inverse - 1).Select(i => Address(start + (uint)i)).Where(a => a != host).ToArray();
    }
    public static DiscoveredPs4? ParseAnnouncement(string sourceIp, string message)
    {
        if (message.Length > 4096 || !message.StartsWith("HTTP/1.1 ", StringComparison.Ordinal)) return null;
        var fields = message.Split('\n').Select(line => line.Trim().Split(':', 2)).Where(parts => parts.Length == 2)
            .GroupBy(parts => parts[0], StringComparer.OrdinalIgnoreCase).ToDictionary(group => group.Key, group => group.First()[1].Trim(), StringComparer.OrdinalIgnoreCase);
        if (!fields.TryGetValue("host-type", out var type) || type != "PS4") return null;
        var rest = message.StartsWith("HTTP/1.1 620 ", StringComparison.Ordinal);
        if (!rest && !message.StartsWith("HTTP/1.1 200 ", StringComparison.Ordinal)) return null;
        var name = fields.GetValueOrDefault("host-name", "PS4");
        name = new string(name.Where(c => !char.IsControl(c)).Take(80).ToArray());
        return new(sourceIp, name, false, false, rest);
    }
    private static async Task<bool> Probe(HttpClient http, string ip, int port, string path, Func<JsonNode, bool> accept, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromMilliseconds(1200));
        try
        {
            using var response = await http.GetAsync($"http://{ip}:{port}{path}", HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return false;
            using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            var bytes = new byte[4097]; var size = 0;
            while (size < bytes.Length) { var count = await stream.ReadAsync(bytes.AsMemory(size), timeout.Token); if (count == 0) break; size += count; }
            return size < bytes.Length && JsonNode.Parse(bytes.AsSpan(0, size)) is { } json && accept(json);
        }
        catch (Exception) when (!ct.IsCancellationRequested) { return false; }
    }
    public static async Task<DiscoveredPs4[]> Discover(string host, string mask, IProgress<int>? progress, CancellationToken ct)
    {
        var candidates = Candidates(host, mask);
        var found = new ConcurrentDictionary<string, DiscoveredPs4>();
        var own = Number(IPAddress.Parse(host)); var actualMask = Number(IPAddress.Parse(mask));
        try
        {
            using var udp = new UdpClient(new IPEndPoint(IPAddress.Parse(host), 0)) { EnableBroadcast = true };
            await udp.SendAsync(Encoding.ASCII.GetBytes(SearchMessage), new IPEndPoint(IPAddress.Parse(Address(own | ~actualMask)), 987), ct);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(3));
            while (!timeout.IsCancellationRequested)
            {
                var packet = await udp.ReceiveAsync(timeout.Token);
                if (packet.RemoteEndPoint.Port != 987 || (Number(packet.RemoteEndPoint.Address) & actualMask) != (own & actualMask)) continue;
                var device = ParseAnnouncement(packet.RemoteEndPoint.Address.ToString(), Encoding.UTF8.GetString(packet.Buffer));
                if (device != null) found[device.Ip] = device;
            }
        }
        catch (Exception) when (!ct.IsCancellationRequested) { /* HTTP fallback also finds consoles with DDP disabled. */ }
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false });
        var addresses = candidates.Concat(found.Keys).Distinct().ToArray(); var completed = 0;
        await Parallel.ForEachAsync(addresses, new ParallelOptions { MaxDegreeOfParallelism = 32, CancellationToken = ct }, async (ip, token) =>
        {
            var serviceTask = Probe(http, ip, 12801, "/system/info", json => json["service"]?.GetValue<string>() == "PackegeFlowService" && json["environment"]?.GetValue<string>() == "ps4", token);
            var payloadTask = Probe(http, ip, 9090, "/status", json => json["status"]?.GetValue<string>() == "ready", token);
            await Task.WhenAll(serviceTask, payloadTask);
            if (serviceTask.Result || payloadTask.Result)
                found.AddOrUpdate(ip, new DiscoveredPs4(ip, "PS4", serviceTask.Result, payloadTask.Result, false), (_, existing) => existing with { Service = serviceTask.Result, PyLoader = payloadTask.Result });
            progress?.Report(Interlocked.Increment(ref completed) * 100 / addresses.Length);
        });
        return found.Values.OrderByDescending(device => device.Service).ThenByDescending(device => device.PyLoader).ThenBy(device => Number(IPAddress.Parse(device.Ip))).ToArray();
    }
}
