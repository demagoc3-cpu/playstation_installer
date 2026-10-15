namespace PackageFlow.Core;

public sealed record RuntimeAttempt(string State, int? ProcessId = null, long? ProcessStartUtcTicks = null, int? ExitCode = null);
public sealed record RuntimeProgress(string Stage, string Message, int? Percent = null);
public sealed class RuntimePreparationException(string message, bool uncertain = false) : Exception(message) { public bool Uncertain { get; } = uncertain; }
public sealed class RuntimeInstallerFile(string path, IDisposable? lease = null) : IDisposable { public string Path { get; } = path; public void Dispose() => lease?.Dispose(); }
public interface IRuntimePreparationHost
{
    string? ResolveRuntime();
    RuntimeAttempt? ReadAttempt();
    void WriteAttempt(RuntimeAttempt attempt);
    Task<RuntimeInstallerFile> PrepareInstaller(IProgress<RuntimeProgress> progress, CancellationToken ct);
    Task<int?> RunInstaller(RuntimeInstallerFile file, CancellationToken ct);
    Task Delay(CancellationToken ct);
}

/// <summary>Installer dispatch is journalled before execution. Unconfirmed dispatches are reconciled, never replayed.</summary>
public static class RuntimePreparation
{
    public static readonly Version MinimumVersion = new(120, 0, 0, 0);
    public static bool Supported(string? version) => Version.TryParse(version, out var parsed) && parsed >= MinimumVersion;
    public static async Task Ensure(IRuntimePreparationHost host, IProgress<RuntimeProgress> progress, bool manualRetry, CancellationToken ct)
    {
        progress.Report(new("check", "Проверяем установленный Microsoft WebView2 Runtime…"));
        if (Supported(host.ResolveRuntime())) { progress.Report(new("ready", "Microsoft WebView2 Runtime уже установлен")); return; }
        var previous = host.ReadAttempt();
        if (previous?.State is "launching" or "running" or "unconfirmed")
            throw new RuntimePreparationException("Результат прежней установки Microsoft пока не подтверждён. Дождитесь её завершения и нажмите «Проверить снова». Повторно установщик не запускается. При необходимости завершите установку с официального сайта Microsoft вручную.", true);
        if (previous?.State == "failed" && !manualRetry)
            throw new RuntimePreparationException("Предыдущая подготовка Runtime не завершилась. Проверьте интернет/политики Windows и нажмите «Повторить». Runtime нужен для интерфейса независимо от торрентов.");
        try {
            using var installer = await host.PrepareInstaller(progress, ct);
            ct.ThrowIfCancellationRequested();
            host.WriteAttempt(new("launching"));
            progress.Report(new("install", "Microsoft скачивает и устанавливает Runtime. Точный процент недоступен. Не закрывайте установщик Microsoft."));
            int? exit;
            try { exit = await host.RunInstaller(installer, ct); }
            catch (OperationCanceledException) { host.WriteAttempt(new("unconfirmed")); throw; }
            catch (RuntimePreparationException) { throw; }
            catch { host.WriteAttempt(new("unconfirmed")); throw new RuntimePreparationException("Запуск установки Microsoft имеет неопределённый результат. Повтор не отправлен; проверьте наличие Runtime снова.", true); }
            if (exit == null) { host.WriteAttempt(new("unconfirmed")); throw new RuntimePreparationException("Время ожидания Microsoft истекло. Установка может продолжаться; она не остановлена. Нажмите «Проверить снова» после её завершения. Повторный запуск установщика заблокирован.", true); }
            if (exit != 0) {
                host.WriteAttempt(new("failed", ExitCode: exit));
                throw new RuntimePreparationException($"Microsoft WebView2 Setup завершился с кодом {exit} (0x{unchecked((uint)exit.Value):X8}). Runtime не готов. Проверьте интернет, доступ к Microsoft и политики установки Windows; затем повторите вручную.");
            }
            progress.Report(new("verify", "Microsoft Setup завершился. Проверяем Runtime через WebView2 SDK…"));
            for (var i = 0; i < 30; i++) {
                ct.ThrowIfCancellationRequested();
                if (Supported(host.ResolveRuntime())) { host.WriteAttempt(new("complete", ExitCode: 0)); progress.Report(new("ready", "Runtime установлен и подтверждён SDK")); return; }
                await host.Delay(ct);
            }
            host.WriteAttempt(new("unconfirmed", ExitCode: 0));
            throw new RuntimePreparationException("Microsoft Setup вернул 0, но подходящий Runtime через SDK не найден. Успех не подтверждён. Повтор установки не отправлен: проверьте завершение Microsoft Setup или установите Runtime вручную.", true);
        } catch (RuntimePreparationException) { throw; }
        catch (OperationCanceledException) { throw; }
        catch (Exception error) {
            if (host.ReadAttempt()?.State is "launching" or "running" or "unconfirmed") throw new RuntimePreparationException("Установка имеет неопределённый результат; повтор не отправлен. Проверьте Runtime снова.", true);
            host.WriteAttempt(new("failed"));
            throw new RuntimePreparationException("Не удалось подготовить Microsoft WebView2 Runtime. Загруженный файл не запускался. " + error.Message);
        }
    }
}
