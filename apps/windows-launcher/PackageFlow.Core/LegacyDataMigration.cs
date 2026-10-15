using System.Text.Json.Nodes;

namespace PackageFlow.Core;

public sealed record LegacyDataReview(string Kind, string SuggestedDirectory, string Message, bool EmptyBindAllowed);

/// <summary>Reads former launcher metadata only. Never invokes a container engine or touches its volumes.</summary>
public static class LegacyDataMigration
{
    public static LegacyDataReview Inspect(string userDirectory)
    {
        try {
            var file = Path.Combine(userDirectory, "data", "compose.json");
            if (!File.Exists(file)) return new("unknown", "", "Прежний источник данных не определён. Экспортируйте /app/.data старого WEB через Docker Desktop в папку Windows, включая скрытые файлы и ключи, затем выберите эту папку. Ничего из контейнеров не удаляется.", false);
            var config = JsonNode.Parse(File.ReadAllText(file))!;
            var mounts = config["services"]?["packageflow"]?["volumes"]?.AsArray() ?? throw new InvalidDataException();
            var mount = mounts.FirstOrDefault(m => m is JsonObject && m["target"]?.GetValue<string>() == "/app/.data");
            if (mount?["type"]?.GetValue<string>() == "bind" && mount["source"]?.GetValue<string>() is { Length: > 0 } source) {
                source = source.Replace("$$", "$");
                if (!Path.IsPathFullyQualified(source)) throw new InvalidDataException();
                source = Path.GetFullPath(source);
                var empty = Directory.Exists(source) && !Directory.EnumerateFileSystemEntries(source).Any();
                return new("bind", source, "Найден прежний bind-каталог WEB. Завершите задания и остановите старый WEB самостоятельно. После подтверждения будет создана отдельная копия данных для Windows; исходный каталог останется неизменным.", empty);
            }
            return new("volume", "", "Данные находятся во внешнем volume либо нестандартном mount. Через Docker Desktop экспортируйте содержимое /app/.data (с ключами и скрытыми файлами) в папку Windows. Выберите экспорт ниже. Контейнеры и volume программа не останавливает и не удаляет.", false);
        } catch { return new("unknown", "", "Прежний конфиг недоступен или непонятен. Выберите полный экспорт /app/.data старого WEB в папку Windows. Исходные данные не изменены.", false); }
    }

    private static readonly string[] Markers = ["package-library.json", "console-profiles.json", "storage-sources.json", "site-library.json", "ps4.json", "qbittorrent.json", "prowlarr.json", "installation-queue.json"];
    private static readonly HashSet<string> PathFields = new(StringComparer.OrdinalIgnoreCase) { "path", "localPath", "downloadPath", "libraryRoot", "coverPath", "sourceRoot", "root", "directory" };
    public static async Task<string> Import(string source, string userDirectory, string gamesDirectory, bool allowEmpty, CancellationToken ct)
    {
        if (!Path.IsPathFullyQualified(source) || !Directory.Exists(source)) throw new InvalidDataException("Выберите существующую папку полного экспорта данных WEB.");
        source = Path.GetFullPath(source);
        var review = Inspect(userDirectory);
        var empty = !Directory.EnumerateFileSystemEntries(source).Any();
        if (empty && !(allowEmpty && review.EmptyBindAllowed && string.Equals(source, review.SuggestedDirectory, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("Выбранная папка пуста. Перенос данных из внешнего volume не выполнен: выберите полный экспорт /app/.data.");
        if (!empty && !Markers.Any(name => File.Exists(Path.Combine(source, name))))
            throw new InvalidDataException("Не найдены файлы состояния WEB. Выберите сам каталог /app/.data, а не папку библиотеки или родительский каталог экспорта.");
        var vault=Path.Combine(source,"storage-secrets.json");
        if(File.Exists(vault) && JsonNode.Parse(File.ReadAllText(vault)) is JsonObject entries && entries.Count>0 && (!File.Exists(Path.Combine(source,"storage-secrets.key")) || new FileInfo(Path.Combine(source,"storage-secrets.key")).Length!=32))
            throw new InvalidDataException("В экспорте отсутствует ключ сохранённых подключений storage-secrets.key. Восстановите полный экспорт с ключами; исходные данные не изменены.");
        var target = Path.Combine(userDirectory, "data", "native-import-" + Guid.NewGuid().ToString("N"));
        if (target.StartsWith(source.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Экспорт не может содержать каталог назначения. Выберите именно папку данных WEB.");
        if (gamesDirectory.Length == 0 || !Path.IsPathFullyQualified(gamesDirectory)) throw new InvalidDataException("Прежний путь библиотеки не является путём Windows. Сначала восстановите исходную библиотеку по прежнему пути Windows.");
        if((File.GetAttributes(source)&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException("Выберите реальный каталог экспорта, а не ссылку.");
        var staging = target + ".staging";
        var enumeration=new EnumerationOptions{RecurseSubdirectories=true,AttributesToSkip=FileAttributes.ReparsePoint,IgnoreInaccessible=false};
        var originalFiles=Directory.EnumerateFiles(source,"*",enumeration).ToDictionary(path=>path,path=>(new FileInfo(path).Length,File.GetLastWriteTimeUtc(path)));

        try {
            async Task Copy(string from, string to) {
                ct.ThrowIfCancellationRequested();
                if ((File.GetAttributes(from) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Экспорт содержит ссылки/mount points. Экспортируйте реальные файлы данных, не подключённую библиотеку.");
                Directory.CreateDirectory(to);
                foreach (var item in Directory.EnumerateFileSystemEntries(from)) {
                    ct.ThrowIfCancellationRequested();
                    var attrs = File.GetAttributes(item);
                    if ((attrs & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Экспорт содержит ссылку/mount point. Исходные данные не изменены.");
                    var dest = Path.Combine(to, Path.GetFileName(item));
                    if ((attrs & FileAttributes.Directory) != 0) await Copy(item, dest);
                    else {
                        await using var input = new FileStream(item, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
                        await using var output = new FileStream(dest, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true);
                        await input.CopyToAsync(output, ct);
                    }
                }
            }
            await Copy(source, staging);
            foreach (var file in Directory.EnumerateFiles(staging, "*.json", SearchOption.AllDirectories)) {
                ct.ThrowIfCancellationRequested();
                JsonNode? json;
                try { json = JsonNode.Parse(await File.ReadAllTextAsync(file, ct)); }
                catch { throw new InvalidDataException("В экспорте есть повреждённый JSON. Исходные файлы не изменены: " + Path.GetFileName(file)); }
                if(Path.GetFileName(file).EndsWith("installation-queue.json",StringComparison.OrdinalIgnoreCase)) {
                    var terminal=new HashSet<string>{"idle","completed","failed","cancelled"};
                    var itemsTerminal=new HashSet<string>{"installed","failed","skipped","cancelled","delivered"};
                    var state=json?["status"]?.GetValue<string>();
                    if(state==null || !terminal.Contains(state) || json?["items"] is not JsonArray queueItems || queueItems.Any(item=>item?["state"]?.GetValue<string>() is not {} itemState || !itemsTerminal.Contains(itemState)))
                        throw new InvalidDataException("В экспорте остались незавершённые/непроверенные задания. Сначала завершите или отмените их в прежнем WEB и проверьте результат на приставке; перенос очереди отложен.");
                }
                bool changed = false;
                void Rewrite(JsonNode? node) {
                    if (node is JsonArray array) { foreach (var value in array) Rewrite(value); }
                    else if (node is JsonObject obj) foreach (var pair in obj.ToArray()) {
                        if (pair.Value is JsonValue v && v.TryGetValue<string>(out var text)) {
                            string? replacement = null;
                            if (PathFields.Contains(pair.Key)) {
                                if (text == "/games" || text.StartsWith("/games/", StringComparison.Ordinal)) replacement = Map(gamesDirectory, text[6..]);
                                else if (text == "/app/.data" || text.StartsWith("/app/.data/", StringComparison.Ordinal)) replacement = Map(target, text[10..]);
                                else if (text.StartsWith('/') && Path.GetFileName(file) is "package-library.json" or "site-library.json" or "storage-sources.json" or "qbittorrent.json") throw new InvalidDataException("В экспорте найден непереносимый контейнерный путь в поле " + pair.Key + ". Восстановите доступ к этому хранилищу в Windows перед импортом.");
                            }
                            if (pair.Key is "baseUrl" or "prowlarrUrl" && Uri.TryCreate(text, UriKind.Absolute, out var url) && url.Host is "prowlarr" or "flaresolverr" or "host.docker.internal")
                                replacement = new UriBuilder(url) { Host = "127.0.0.1" }.Uri.ToString().TrimEnd('/');
                            if (replacement != null) { obj[pair.Key] = replacement; changed = true; }
                        } else Rewrite(pair.Value);
                    }
                }
                Rewrite(json);
                if (changed) await File.WriteAllTextAsync(file, json!.ToJsonString(new() { WriteIndented = true }), ct);
            }
            ct.ThrowIfCancellationRequested();
            var finalFiles=Directory.EnumerateFiles(source,"*",enumeration).ToArray();
            if(finalFiles.Length!=originalFiles.Count || finalFiles.Any(path=>!originalFiles.TryGetValue(path,out var before) || new FileInfo(path).Length!=before.Length || File.GetLastWriteTimeUtc(path)!=before.Item2))
                throw new InvalidDataException("Исходный экспорт менялся во время копирования. Остановите старый WEB/экспорт и повторите; исходные данные не изменены.");
            Directory.Move(staging, target); return target;
        } catch { if (Directory.Exists(staging)) Directory.Delete(staging, true); throw; }
    }
    private static string Map(string root, string suffix) {
        var result = Path.GetFullPath(Path.Combine(root, suffix.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
        var basePath = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        if (!string.Equals(result, basePath, StringComparison.OrdinalIgnoreCase) && !result.StartsWith(basePath + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Путь экспорта выходит за пределы соответствующего mount.");
        return result;
    }
}
