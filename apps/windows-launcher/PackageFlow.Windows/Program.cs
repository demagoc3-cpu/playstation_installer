using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace PackageFlow.Windows;

internal static class Program
{
    internal static readonly string UserDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PackageFlow");
    internal static readonly string PipeName = "PackageFlow-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(UserDirectory)))[..20];
    internal static readonly string MutexName = @"Local\" + PipeName;

    [STAThread]
    private static void Main(string[] args)
    {
        using var mutex = new Mutex(true, MutexName, out var first);
        if (!first)
        {
            try
            {
                using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut);
                pipe.Connect(5000); pipe.ReadMode = PipeTransmissionMode.Byte;
                using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
                using var reader = new StreamReader(pipe, leaveOpen: true);
                writer.WriteLine(args.Contains("--prepare-update") ? "prepare-update" : "show");
                var result = reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
                Environment.ExitCode = result == "ok" ? 0 : 2;
            }
            catch { Environment.ExitCode = 2; }
            return;
        }
        if (args.Contains("--prepare-update"))
        {
            try {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
                var host = new ServerHost(PackageFlow.Core.LauncherSettings.Load(ServerHost.SettingsPath), http);
                host.PrepareUpdate(CancellationToken.None).GetAwaiter().GetResult();
                Environment.ExitCode = 0;
            } catch { Environment.ExitCode = 2; }
            return;
        }
        ApplicationConfiguration.Initialize();
        try
        {
            Directory.CreateDirectory(UserDirectory);
            if (!File.Exists(ServerHost.SettingsPath))
            {
                var language = args.FirstOrDefault(arg => arg.StartsWith("--language="))?.Split('=')[1];
                if (language is "ru" or "en") new PackageFlow.Core.LauncherSettings { Language = language }.Save(ServerHost.SettingsPath);
            }
            Application.Run(new MainForm(args.Contains("--background")));
        }
        catch (Exception exception)
        {
            MessageBox.Show(exception.Message, "PackageFlow", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.ExitCode = 1;
        }
    }
}
