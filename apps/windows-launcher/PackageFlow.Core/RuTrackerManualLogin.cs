using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace PackageFlow.Core;

/// <summary>A separate, user-operated browser. It does not import cookies into Prowlarr.</summary>
public sealed class RuTrackerManualLogin(HttpClient http) : IAsyncDisposable
{
    private readonly string session = "packageflow-manual-login-" + Guid.NewGuid().ToString("N");
    private bool created;
    private async Task<JsonNode> Command(JsonObject body, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(80));
        using var response = await http.PostAsJsonAsync("http://127.0.0.1:8191/v1", body, timeout.Token);
        // Never surface browser HTML, cookies or upstream errors as diagnostics.
        return await response.Content.ReadFromJsonAsync<JsonNode>(cancellationToken: timeout.Token)
            ?? throw new InvalidOperationException("Manual RuTracker browser is unavailable.");
    }
    public async Task Open(CancellationToken ct)
    {
        var result = await Command(new() { ["cmd"] = "sessions.create", ["session"] = session }, ct);
        if (result["status"]?.GetValue<string>() != "ok" || result["session"]?.GetValue<string>() != session)
            throw new InvalidOperationException("Manual RuTracker browser is unavailable.");
        created = true;
        // A challenge can outlast the API call. Keep the persistent window open
        // for the human; only the later authenticated-page check accepts login.
        try { await Page("login.php", ct); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
    }
    private Task<JsonNode> Page(string path, CancellationToken ct) => Command(new()
    {
        ["cmd"] = "request.get", ["session"] = session,
        ["url"] = "https://rutracker.org/forum/" + path, ["maxTimeout"] = 60000
    }, ct);
    public async Task<bool> Authenticated(CancellationToken ct)
    {
        var result = await Page("index.php", ct);
        return result["status"]?.GetValue<string>() == "ok"
            && result["solution"]?["status"]?.GetValue<int>() == 200
            && Uri.TryCreate(result["solution"]?["url"]?.GetValue<string>(), UriKind.Absolute, out var url)
            && url.Scheme == "https" && url.Host == "rutracker.org" && url.AbsolutePath.StartsWith("/forum/", StringComparison.Ordinal)
            && (result["solution"]?["response"]?.GetValue<string>() ?? "").Contains("id=\"logged-in-username\"", StringComparison.Ordinal);
    }
    public async ValueTask DisposeAsync()
    {
        if (!created) return;
        created = false;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try { await Command(new() { ["cmd"] = "sessions.destroy", ["session"] = session }, timeout.Token); }
        catch (Exception) { /* Destroy only our own session, never other browser windows. */ }
    }
}
