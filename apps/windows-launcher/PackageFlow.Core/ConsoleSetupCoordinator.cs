using System.Text.Json.Nodes;

namespace PackageFlow.Core;

public sealed record ConsoleSetupResult(string Id, string Name, bool Complete, string Message);

/// <summary>One explicit setup action, with fixed targets and read-only reconciliation after dispatch.</summary>
public sealed class ConsoleSetupCoordinator(
    Func<string, object?, CancellationToken, Task<JsonNode>> api,
    Func<string, CancellationToken, IProgress<string>, Task> bootstrapPs4,
    LauncherSettings settings, Action save,
    Func<CancellationToken, Task>? delay = null)
{
    private string T(string ru, string en) => settings.Language == "en" ? en : ru;
    private Task Pause(CancellationToken ct) => delay?.Invoke(ct) ?? Task.Delay(1500, ct);
    private Task<JsonNode> Get(string path, CancellationToken ct) => api(path, null, ct);
    private Task<JsonNode> Post(string path, object body, CancellationToken ct) => api(path, body, ct);
    private static string Value(JsonNode? n, string key) => n?[key]?.GetValue<string>() ?? "";
    private static bool Flag(JsonNode? n, string key) => n?[key]?.GetValue<bool>() == true;
    private static JsonNode Profile(JsonNode list, string id) => list["consoles"]!.AsArray().FirstOrDefault(p => Value(p, "id") == id)
        ?? throw new InvalidOperationException("Console profile no longer exists.");
    private static int Compare(string a, string b)
    {
        if (!Version.TryParse(a.Replace("-dev", ""), out var x) || !Version.TryParse(b.Replace("-dev", ""), out var y)) throw new InvalidDataException("Console release version is invalid.");
        return x.CompareTo(y);
    }
    private void CheckPs5ServiceTarget(JsonNode? flow, JsonNode target, string flowId)
    {
        // A completed journal belongs to one exact ELF, including same-version revisions.
        if (flowId.Length > 0 && Value(flow, "id") != flowId ||
            new[] { "version", "buildId", "sha256" }.Any(key => Value(target, key).Length > 0 && Value(flow, key) != Value(target, key)))
            throw new InvalidOperationException(T("На PS5 выполняется другое обновление нагрузки. Проверьте его результат.", "A different payload update is running on this PS5. Verify its result."));
    }
    public async Task<IReadOnlyList<ConsoleSetupResult>> Run(IEnumerable<string> ids, IProgress<string> progress, CancellationToken ct)
    {
        var results = new List<ConsoleSetupResult>();
        foreach (var id in ids.Distinct().ToArray()) {
            ct.ThrowIfCancellationRequested();
            var name = id;
            try {
                var p = Profile(await Get("/api/consoles", ct), id); name = Value(p, "name");
                var tagged = new InlineProgress(message => progress.Report(name + ": " + message));
                tagged.Report(T("Проверяем компоненты…", "Checking components…"));
                if (Value(p, "platform") == "ps4") await Ps4(id, Value(p, "ip"), tagged, ct);
                else if (Value(p, "platform") == "ps5") await Ps5(id, tagged, ct);
                else throw new InvalidDataException("Unknown console platform.");
                var message = T("Компоненты PackageFlow актуальны", "PackageFlow components are up to date");
                tagged.Report(message); results.Add(new(id, name, true, message));
            } catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception error) { progress.Report(name + ": " + error.Message); results.Add(new(id, name, false, error.Message)); }
        }
        return results;
    }
    private async Task Pair(string id, CancellationToken ct)
    {
        var p = Profile(await Post("/api/consoles/probe", new { id }, ct), id);
        if (!Flag(p, "online")) throw new InvalidOperationException(T("Служба недоступна. Включите приставку и запустите PackageFlow.", "Service unavailable. Turn on the console and start PackageFlow."));
        if (!Flag(p, "paired")) await Post("/api/consoles/pair", new { id }, ct);
    }
    private async Task Ps4(string id, string ip, IProgress<string> progress, CancellationToken ct)
    {
        var p = Profile(await Post("/api/consoles/probe", new { id }, ct), id);
        if (!Flag(p, "online")) {
            await bootstrapPs4(ip, ct, progress);
            // PyLoader acceptance does not prove installation or daemon startup.
            await Pair(id, ct);
        } else await Pair(id, ct);
        var artifact = await Post("/api/desktop/ps4-setup-artifact", new { }, ct);
        p = Profile(await Post("/api/consoles/probe", new { id }, ct), id);
        var flow = await Get("/api/ps4/maintenance?ip=" + Uri.EscapeDataString(ip), ct);
        if (Compare(Value(p, "pkgVersion"), Value(artifact, "version")) >= 0) {
            var presence = await Post("/api/desktop/ps4-app-check", new { consoleId = id, artifactId = Value(artifact, "id") }, ct);
            if (Flag(presence, "installed")) return;
            flow = presence["flow"] ?? throw new InvalidDataException("App restoration receipt missing.");
        }
        if (Value(flow, "kind") != "update" || Value(flow, "state") is "completed" or "failed" or "")
            flow = await Post("/api/ps4/service-update/install", new { ip, artifactId = Value(artifact, "id") }, ct);
        if (Value(flow, "targetVersion") != Value(artifact, "version"))
            throw new InvalidOperationException(T("На PS4 выполняется другое обновление. Дождитесь его результата.", "Another update is running on this PS4. Wait for its result."));
        for (var i = 0; i < 200; i++) {
            progress.Report(Value(flow, "message"));
            var state = Value(flow, "state");
            if (state == "completed") {
                await Pair(id, ct);
                var presence = await Post("/api/desktop/ps4-app-check", new { consoleId = id, artifactId = Value(artifact, "id"), observeOnly = true }, ct);
                if (!Flag(presence, "installed")) throw new InvalidOperationException(T("Установка завершилась, но приложение пока не найдено. Повтор не отправлен.", "Installation finished, but the app has not been found. No duplicate was sent."));
                return;
            }
            if (state is "failed" or "uncertain") throw new InvalidOperationException(Value(flow, "message"));
            if (state == "restart_ready") flow = await Post("/api/ps4/service-update/restart", new { ip }, ct);
            await Pause(ct); flow = await Get("/api/ps4/maintenance?ip=" + Uri.EscapeDataString(ip), ct);
        }
        throw new InvalidOperationException(T("Обновление отправлено, результат пока не подтверждён. Повтор не отправлен.", "Update sent; its result is not yet confirmed. No duplicate was sent."));
    }
    private async Task<JsonNode> Ps5Info(string id, CancellationToken ct) => await Get("/api/desktop/console-setup?consoleId=" + Uri.EscapeDataString(id), ct);
    private async Task Ps5(string id, IProgress<string> progress, CancellationToken ct)
    {
        var info = await Ps5Info(id, ct);
        var release = info["release"] ?? throw new InvalidOperationException(Value(info, "artifactMessage"));
        if (!Flag(info["profile"], "online")) {
            await Post("/api/desktop/console-setup", new { consoleId = id, action = "bootstrap", confirmedServiceStopped = true }, ct);
            for (var i = 0; i < 30; i++) {
                await Pause(ct); info = await Ps5Info(id, ct); progress.Report(Value(info["flow"], "message"));
                if (Value(info["flow"], "state") is "completed" or "failed" or "unconfirmed") break;
            }
            if (Value(info["flow"], "state") != "completed") throw new InvalidOperationException(Value(info["flow"], "message"));
        }
        await Pair(id, ct);
        var update = await Get("/api/consoles/service-update?consoleId=" + Uri.EscapeDataString(id), ct);
        if (update["currentConfirmed"]?.GetValue<bool>() == false)
            throw new InvalidOperationException(T("Не удалось подтвердить текущую нагрузку PS5. Восстановите связь и проверьте снова.", "The current PS5 payload could not be confirmed. Restore the connection and check again."));
        var serviceState = Value(update["flow"], "state");
        if (serviceState == "unconfirmed") throw new InvalidOperationException(Value(update["flow"], "message"));
        // New WEBs compare the verified live build as well as the version. Older WEBs
        // retain their numeric-version behavior; an absent build is never guessed.
        if (update["release"] is JsonNode target &&
            ((update["updateAvailable"]?.GetValue<bool>() ?? Compare(Value(update, "current"), Value(target, "version")) < 0) ||
             serviceState is "preparing" or "stopping" or "sending" or "verifying")) {
            target = target.DeepClone();
            if (Value(update["flow"], "state") is "" or "completed" or "failed")
                update = await Post("/api/consoles/service-update", new { consoleId = id }, ct);
            var flowId = Value(update["flow"], "id");
            for (var i = 0; i < 45; i++) {
                CheckPs5ServiceTarget(update["flow"], target, flowId);
                progress.Report(Value(update["flow"], "message"));
                if (Value(update["flow"], "state") == "completed") break;
                if (Value(update["flow"], "state") is "failed" or "unconfirmed") throw new InvalidOperationException(Value(update["flow"], "message"));
                await Pause(ct); update = await Get("/api/consoles/service-update?consoleId=" + Uri.EscapeDataString(id), ct);
            }
            if (Value(update["flow"], "state") != "completed") throw new InvalidOperationException(T("Запуск новой нагрузки пока не подтверждён", "The new payload has not confirmed startup"));
            await Pair(id, ct);
        }
        var sha = Value(release["app"], "sha256");
        if (!System.Text.RegularExpressions.Regex.IsMatch(sha, "^[a-f0-9]{64}$")) throw new InvalidDataException("App release hash is invalid.");
        if (!settings.ConsoleSetupRequests.TryGetValue(id, out var request) || request.Sha256 != sha) {
            request = new() { Sha256 = sha, RequestId = Guid.NewGuid().ToString("N") };
            settings.ConsoleSetupRequests[id] = request; save();
        }
        if (request == null || !System.Text.RegularExpressions.Regex.IsMatch(request.RequestId, "^[a-f0-9]{32}$")) throw new InvalidDataException("Saved setup receipt is invalid; verify the previous installation before retrying.");
        var started = await Post("/api/desktop/console-setup", new { consoleId = id, action = "install-app", requestId = request.RequestId, updateApp = true }, ct);
        if (Value(started, "retry") == "installed") return;
        if (Value(started, "retry") is "absent" or "different-version" or "different-build") {
            request.RequestId = Guid.NewGuid().ToString("N"); save();
            started = await Post("/api/desktop/console-setup", new { consoleId = id, action = "install-app", requestId = request.RequestId, updateApp = true }, ct);
        }
        if (Value(started, "retry") is "unconfirmed" or "unavailable") throw new InvalidOperationException(T("Прежняя установка не подтверждена; повтор не отправлен", "The previous installation is unconfirmed; no duplicate was sent"));
        var queueId = Value(started["receipt"], "queueId");
        for (var i = 0; i < 150; i++) {
            info = await Ps5Info(id, ct); var q = info["queue"];
            if (Value(q, "id") != queueId || queueId.Length == 0) throw new InvalidOperationException(T("Очередь изменилась; проверьте результат установки", "The queue changed; verify installation status"));
            var item = q?["items"]?.AsArray().FirstOrDefault(); progress.Report(Value(item, "detail"));
            if (Value(q, "status") is "completed" or "failed" or "cancelled") {
                if (Value(item, "state") == "installed") return;
                throw new InvalidOperationException(Value(item, "detail"));
            }
            await Pause(ct);
        }
        throw new InvalidOperationException(T("Регистрация приложения пока не подтверждена; повтор не отправлен", "App registration is unconfirmed; no duplicate was sent"));
    }
    private sealed class InlineProgress(Action<string> report) : IProgress<string> { public void Report(string value) => report(value); }
}
