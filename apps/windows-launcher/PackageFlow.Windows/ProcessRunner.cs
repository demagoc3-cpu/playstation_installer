using System.Diagnostics;

namespace PackageFlow.Windows;

internal static class ProcessRunner
{
    internal static ProcessStartInfo Info(string executable, IEnumerable<string> arguments, string directory)
    {
        var info = new ProcessStartInfo(executable) { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        return info;
    }

    public static async Task<string> Run(string executable, IEnumerable<string> arguments, string directory, CancellationToken ct)
    {
        using var process = new Process { StartInfo = Info(executable, arguments, directory) };
        process.Start();
        var stdout = process.StandardOutput.ReadToEndAsync(ct);
        var stderr = process.StandardError.ReadToEndAsync(ct);
        try { await process.WaitForExitAsync(ct); }
        catch { try { process.Kill(true); } catch { } throw; }
        var output = await stdout; await stderr;
        if (process.ExitCode != 0) throw new InvalidOperationException($"{Path.GetFileName(executable)} failed ({process.ExitCode}). Check Docker Desktop or the application log.");
        return output;
    }

    public static void Open(string destination) => Process.Start(new ProcessStartInfo(destination) { UseShellExecute = true });
}
