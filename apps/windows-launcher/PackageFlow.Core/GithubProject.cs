using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace PackageFlow.Core;

public sealed record GithubProjectStats(string Version, int Stars, DateTime UpdatedUtc);
public static class GithubProject
{
    public const string Repository = "demagoc3-cpu/playstation_installer";
    public static async Task<GithubProjectStats> Read(HttpClient http, CancellationToken ct)
    {
        async Task<JsonNode> Get(string path) {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repository}{path}");
            request.Headers.UserAgent.ParseAdd("PackageFlow-Windows"); request.Headers.Accept.ParseAdd("application/vnd.github+json");
            using var response = await http.SendAsync(request, ct); response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync<JsonNode>(cancellationToken: ct) ?? throw new InvalidDataException("Empty GitHub response.");
        }
        var repo = Get(""); var tags = Get("/tags?per_page=100");
        await Task.WhenAll(repo, tags);
        var version = (await tags).AsArray().Select(t => t?["name"]?.GetValue<string>() ?? "")
            .Where(t => t.StartsWith('v') && Version.TryParse(t[1..], out _))
            .OrderByDescending(t => Version.Parse(t[1..])).FirstOrDefault() ?? "—";
        return new(version, Math.Max(0, (await repo)["stargazers_count"]?.GetValue<int>() ?? 0), DateTime.UtcNow);
    }
}
