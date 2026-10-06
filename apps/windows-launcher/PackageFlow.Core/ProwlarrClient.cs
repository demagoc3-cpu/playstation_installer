using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace PackageFlow.Core;

public sealed record TorznabConnection(string Endpoint, string ApiKey, int IndexerId);

public sealed class ProwlarrRequestException(int statusCode, string requestPath, bool trackerCaptchaRequired = false)
    : InvalidOperationException($"Prowlarr ({statusCode}). Check the corresponding test and logs in Prowlarr.")
{
    public int StatusCode { get; } = statusCode;
    public string RequestPath { get; } = requestPath;
    public bool TrackerCaptchaRequired { get; } = trackerCaptchaRequired;
}

public sealed class ProwlarrClient(HttpClient http, string address, string apiKey)
{
    private readonly Uri root = ValidateAddress(address);
    public bool UsedTrackerFallback { get; private set; }
    public static Uri ValidateAddress(string address)
    {
        if (!Uri.TryCreate(address.TrimEnd('/') + "/", UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0)
            throw new ArgumentException("Use a Prowlarr HTTP(S) address without credentials or a query.");
        return uri;
    }

    private async Task<JsonNode> Request(string path, HttpMethod method, JsonNode? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, new Uri(root, path));
        request.Headers.Add("X-Api-Key", apiKey);
        if (body != null) request.Content = JsonContent.Create(body);
        using var response = await http.SendAsync(request, ct);
        // Classify only known validation messages. Never retain or expose the body:
        // Prowlarr may echo passwords, API keys and cookies in validation fields.
        if (!response.IsSuccessStatusCode)
        {
            var captcha = false;
            if (response.StatusCode == System.Net.HttpStatusCode.BadRequest && path.StartsWith("api/v1/indexer", StringComparison.Ordinal)
                && !path.StartsWith("api/v1/indexerproxy", StringComparison.Ordinal))
            {
                try
                {
                    using var stream = await response.Content.ReadAsStreamAsync(ct);
                    var buffer = new byte[65537];
                    var length = 0;
                    while (length < buffer.Length)
                    {
                        var read = await stream.ReadAsync(buffer.AsMemory(length), ct);
                        if (read == 0) break;
                        length += read;
                    }
                    if (length < buffer.Length && JsonNode.Parse(buffer.AsSpan(0, length)) is JsonArray errors)
                        captcha = errors.Any(error => error?["errorMessage"]?.GetValue<string>()
                            .Contains("Введите код подтверждения", StringComparison.OrdinalIgnoreCase) == true);
                }
                catch (System.Text.Json.JsonException) { }
                catch (InvalidOperationException) { }
            }
            throw new ProwlarrRequestException((int)response.StatusCode, path, captcha);
        }
        var content = await response.Content.ReadAsStringAsync(ct);
        return string.IsNullOrWhiteSpace(content) ? new JsonObject() : JsonNode.Parse(content) ?? new JsonObject();
    }

    public async Task<List<(int Id, string Name)>> Indexers(CancellationToken ct)
    {
        var items = (await Request("api/v1/indexer", HttpMethod.Get, null, ct)).AsArray();
        return items.Select(i => (i!["id"]!.GetValue<int>(), i["name"]?.GetValue<string>() ?? "Indexer")).ToList();
    }

    public async Task<(string Username, string Password, bool PasswordSaved)> RuTrackerCredentials(int id, CancellationToken ct)
    {
        if (id < 1) throw new ArgumentException("Select an indexer.");
        var item = await Request($"api/v1/indexer/{id}", HttpMethod.Get, null, ct);
        if (!IsRuTracker(item)) return ("", "", false);
        var fields = item["fields"]?.AsArray();
        var username = fields?.FirstOrDefault(f => f?["name"]?.GetValue<string>() is "username" or "userName")?["value"]?.GetValue<string>() ?? "";
        var password = fields?.FirstOrDefault(f => f?["name"]?.GetValue<string>() == "password")?["value"]?.GetValue<string>() ?? "";
        // Prowlarr can return a mask instead of a secret. Never treat that mask
        // as an actual password or overwrite the locally protected password.
        var masked = password.Length > 0 && password.All(c => c is '*' or '•');
        return (username, masked ? "" : password, password.Length > 0);
    }

    public TorznabConnection Connection(int id, string? serverAddress = null)
    {
        if (id < 1) throw new ArgumentException("Select an indexer.");
        var server = serverAddress == null ? root : ValidateAddress(serverAddress);
        return new(new Uri(server, $"{id}/api").ToString(), apiKey, id);
    }

    public async Task TestIndexer(int id, CancellationToken ct)
    {
        if (id < 1) throw new ArgumentException("Select an indexer.");
        var indexer = await Request($"api/v1/indexer/{id}", HttpMethod.Get, null, ct);
        await Request("api/v1/indexer/test", HttpMethod.Post, indexer, ct);
    }

    public async Task<bool> ApplyRuTrackerCredentials(int id, string username, string password, CancellationToken ct)
    {
        if (id < 1) throw new ArgumentException("Select an indexer.");
        var item = await Request($"api/v1/indexer/{id}", HttpMethod.Get, null, ct);
        if (!IsRuTracker(item)) { await TestIndexer(id, ct); return false; }
        var fields = item["fields"]?.AsArray() ?? throw new InvalidOperationException("Missing indexer fields.");
        var user = fields.FirstOrDefault(f => f?["name"]?.GetValue<string>() is "username" or "userName");
        var pass = fields.FirstOrDefault(f => f?["name"]?.GetValue<string>() == "password");
        if (user == null || pass == null) throw new InvalidOperationException("This RuTracker definition requires manual authentication in Prowlarr.");
        if (!string.IsNullOrWhiteSpace(username)) user["value"] = username.Trim();
        if (!string.IsNullOrEmpty(password)) pass["value"] = password;
        // Preserve ID, proxy tags and all unrelated options. Validate edits
        // before replacing the working indexer.
        await Request("api/v1/indexer/test", HttpMethod.Post, item, ct);
        await Request($"api/v1/indexer/{id}", HttpMethod.Put, item, ct);
        return true;
    }

    public async Task<int> AddRuTracker(string username, string password, CancellationToken ct, int? proxyTag = null)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrEmpty(password)) throw new ArgumentException("Enter the RuTracker username and password.");
        if ((await Indexers(ct)).Any(i => i.Name.Contains("rutracker", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("RuTracker is already configured. Select the existing indexer to preserve its settings.");
        var schema = (await Request("api/v1/indexer/schema", HttpMethod.Get, null, ct)).AsArray();
        var template = schema.SelectMany(Templates).FirstOrDefault(IsRuTracker)
            ?? throw new InvalidOperationException("RuTracker definition is unavailable. Update Prowlarr or add the indexer in its interface.");
        var profiles = (await Request("api/v1/appprofile", HttpMethod.Get, null, ct)).AsArray();
        var candidate = PrepareRuTracker(template, username, password, profiles.FirstOrDefault()?["id"]?.GetValue<int>() ?? 1);
        if (proxyTag != null) AddTag(candidate, proxyTag.Value);
        await Request("api/v1/indexer/test", HttpMethod.Post, candidate, ct);
        var added = await Request("api/v1/indexer", HttpMethod.Post, candidate, ct);
        return added["id"]?.GetValue<int>() ?? throw new InvalidOperationException("Prowlarr did not return an indexer ID.");
    }

    private static void AddTag(JsonNode item, int id)
    {
        var tags = item["tags"] as JsonArray ?? new JsonArray();
        if (item["tags"] == null) item["tags"] = tags;
        if (!tags.Any(t => t?.GetValue<int>() == id)) tags.Add(id);
    }

    public async Task<int?> ExistingFlareSolverrTag(string address, CancellationToken ct)
    {
        var host = ValidateAddress(address);
        var tags = (await Request("api/v1/tag", HttpMethod.Get, null, ct)).AsArray();
        var tagId = tags.FirstOrDefault(t => t?["label"]?.GetValue<string>() == "packageflow-rutracker")?["id"]?.GetValue<int>();
        if (tagId == null) return null;
        var proxies = (await Request("api/v1/indexerproxy", HttpMethod.Get, null, ct)).AsArray();
        var proxy = proxies.FirstOrDefault(p => p?["name"]?.GetValue<string>() == "PackageFlow FlareSolverr"
            && p?["implementation"]?.GetValue<string>() == "FlareSolverr"
            && p?["tags"] is JsonArray assigned && assigned.Any(t => t?.GetValue<int>() == tagId));
        var saved = proxy?["fields"]?.AsArray().FirstOrDefault(f => f?["name"]?.GetValue<string>() == "host")?["value"]?.GetValue<string>();
        return Uri.TryCreate(saved, UriKind.Absolute, out var uri) && uri == host ? tagId : null;
    }

    public async Task<int> ConfigureFlareSolverr(string address, CancellationToken ct, string? probeAddress = null)
    {
        UsedTrackerFallback = false;
        var host = ValidateAddress(address).ToString();
        var tags = (await Request("api/v1/tag", HttpMethod.Get, null, ct)).AsArray();
        var tag = tags.FirstOrDefault(t => t?["label"]?.GetValue<string>() == "packageflow-rutracker")
            ?? await Request("api/v1/tag", HttpMethod.Post, new JsonObject { ["label"] = "packageflow-rutracker" }, ct);
        var tagId = tag["id"]!.GetValue<int>();
        var proxies = (await Request("api/v1/indexerproxy", HttpMethod.Get, null, ct)).AsArray();
        // Only modify our own proxy; unrelated proxies and tracker settings survive.
        var existing = proxies.FirstOrDefault(p => p?["name"]?.GetValue<string>() == "PackageFlow FlareSolverr");
        var schema = (await Request("api/v1/indexerproxy/schema", HttpMethod.Get, null, ct)).AsArray();
        var proxy = (existing ?? schema.FirstOrDefault(p => p?["implementation"]?.GetValue<string>() == "FlareSolverr")
            ?? throw new InvalidOperationException("FlareSolverr proxy definition is unavailable in Prowlarr.")).DeepClone().AsObject();
        proxy.Remove("presets"); proxy["name"] = "PackageFlow FlareSolverr";
        proxy["tags"] = new JsonArray(tagId);
        var field = proxy["fields"]!.AsArray().First(f => f?["name"]?.GetValue<string>() == "host")!;
        field["value"] = host;
        var trackerFallback = false;
        try { await Request("api/v1/indexerproxy/test", HttpMethod.Post, proxy, ct); }
        catch (ProwlarrRequestException error) when (error.StatusCode == 400)
        {
            // Prowlarr validates its own Cloudflare-protected ping, not the tracker.
            // Use its supported forceSave only for this confirmed failure and after
            // FlareSolverr successfully requests RuTracker. Indexer tests still run.
            var probe = ValidateAddress(probeAddress ?? host);
            if (await ProbeFlareSolverr(probe, "https://prowlarr.servarr.com/v1/ping", ct) != FlareProbe.Blocked
                || await ProbeFlareSolverr(probe, "https://rutracker.org/forum/index.php", ct) != FlareProbe.Success)
                throw;
            trackerFallback = true;
        }
        var savePath = existing == null ? "api/v1/indexerproxy" : $"api/v1/indexerproxy/{existing["id"]!.GetValue<int>()}";
        if (trackerFallback && existing == null)
        {
            // Prowlarr still runs hard-error tests when creating an enabled proxy,
            // even with forceSave. Create unassigned, then activate via its PUT API.
            var unassigned = proxy.DeepClone(); unassigned["tags"] = new JsonArray();
            var created = await Request(savePath, HttpMethod.Post, unassigned, ct);
            var id = created["id"]?.GetValue<int>() ?? throw new InvalidOperationException("Prowlarr did not return a proxy ID.");
            proxy["id"] = id;
            try { await Request($"api/v1/indexerproxy/{id}?forceSave=true", HttpMethod.Put, proxy, ct); }
            catch
            {
                // Remove only the unassigned proxy created by this attempt.
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try { await Request($"api/v1/indexerproxy/{id}", HttpMethod.Delete, null, cleanup.Token); }
                catch (Exception) { }
                throw;
            }
        }
        else await Request(savePath + (trackerFallback ? "?forceSave=true" : ""), existing == null ? HttpMethod.Post : HttpMethod.Put, proxy, ct);
        UsedTrackerFallback = trackerFallback;
        return tagId;
    }

    private enum FlareProbe { Failed, Blocked, Success }
    private async Task<FlareProbe> ProbeFlareSolverr(Uri address, string target, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(75));
        try
        {
            using var response = await http.PostAsJsonAsync(new Uri(address, "v1"), new { cmd = "request.get", url = target, maxTimeout = 60000 }, timeout.Token);
            var result = await response.Content.ReadFromJsonAsync<JsonNode>(cancellationToken: timeout.Token);
            // Do not surface raw messages, page HTML or cookies in launcher errors.
            if ((int)response.StatusCode == 500 && result?["status"]?.GetValue<string>() == "error"
                && (result["message"]?.GetValue<string>() ?? "").Contains("Cloudflare has blocked this request.", StringComparison.OrdinalIgnoreCase))
                return FlareProbe.Blocked;
            if (response.IsSuccessStatusCode && result?["status"]?.GetValue<string>() == "ok"
                && result["solution"]?["status"]?.GetValue<int>() == 200
                && Uri.TryCreate(result["solution"]?["url"]?.GetValue<string>(), UriKind.Absolute, out var final)
                && final.Scheme == "https" && final.Host == new Uri(target).Host
                && IsTrackerPage(result["solution"]!))
                return FlareProbe.Success;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        catch (HttpRequestException) { }
        catch (System.Text.Json.JsonException) { }
        catch (InvalidOperationException) { }
        return FlareProbe.Failed;
    }

    private static bool IsTrackerPage(JsonNode solution)
    {
        // FlareSolverr hardcodes solution.status=200, even for an undetected
        // localized Cloudflare challenge. Inspect the page, not just that status.
        var html = solution["response"]?.GetValue<string>() ?? "";
        if (string.IsNullOrWhiteSpace(html)) return false;
        var challengeMarkers = new[] {
            "_cf_chl_opt", "/cdn-cgi/challenge-platform/", "challenges.cloudflare.com",
            "cf-turnstile-response", "<title>Just a moment", "<title>Один момент"
        };
        return !challengeMarkers.Any(marker => html.Contains(marker, StringComparison.OrdinalIgnoreCase))
            && solution["cookies"] is JsonArray cookies && cookies.Count > 0;
    }

    public async Task AttachRuTrackerProxy(int id, int tag, CancellationToken ct)
    {
        var indexer = await Request($"api/v1/indexer/{id}", HttpMethod.Get, null, ct);
        if (!IsRuTracker(indexer)) return;
        AddTag(indexer, tag);
        await Request($"api/v1/indexer/{id}", HttpMethod.Put, indexer, ct);
        await Request("api/v1/indexer/test", HttpMethod.Post, indexer, ct);
    }

    private static IEnumerable<JsonNode> Templates(JsonNode? node)
    {
        if (node == null) yield break;
        yield return node;
        if (node["presets"] is JsonArray presets) foreach (var preset in presets) if (preset != null) yield return preset;
    }
    private static bool IsRuTracker(JsonNode node) => new[] { "definitionName", "implementationName", "name" }
        .Any(key => (node[key]?.GetValue<string>() ?? "").Contains("rutracker", StringComparison.OrdinalIgnoreCase));

    public static JsonObject PrepareRuTracker(JsonNode template, string username, string password, int profile)
    {
        var candidate = template.DeepClone().AsObject();
        candidate.Remove("id"); candidate.Remove("presets");
        candidate["name"] = "RuTracker.org"; candidate["enable"] = true;
        candidate["appProfileId"] = profile; candidate["priority"] = 25;
        var fields = candidate["fields"]?.AsArray() ?? throw new InvalidOperationException("Missing indexer fields.");
        var user = fields.FirstOrDefault(f => f?["name"]?.GetValue<string>() is "username" or "userName");
        var pass = fields.FirstOrDefault(f => f?["name"]?.GetValue<string>() == "password");
        if (user == null || pass == null) throw new InvalidOperationException("This RuTracker definition requires manual authentication in Prowlarr.");
        user["value"] = username.Trim(); pass["value"] = password;
        return candidate;
    }
}
