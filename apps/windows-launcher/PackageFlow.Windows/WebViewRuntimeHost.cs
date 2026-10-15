using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using PackageFlow.Core;
namespace PackageFlow.Windows;
internal sealed class WebViewRuntimeHost(string root) : IRuntimePreparationHost
{
    private string Ledger => Path.Combine(root,"runtime-setup-attempt.json");
    internal int DownloadRequests { get; private set; }
    internal int InstallerDispatches { get; private set; }
    public string? ResolveRuntime() { try { return CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch(WebView2RuntimeNotFoundException) { return null; } }
    public RuntimeAttempt? ReadAttempt() {
        if(!File.Exists(Ledger))return null;
        if(new FileInfo(Ledger).Length>8192)throw new InvalidDataException("Журнал установки Runtime повреждён; повтор заблокирован.");
        var result=JsonSerializer.Deserialize<RuntimeAttempt>(File.ReadAllText(Ledger));
        if(result?.State is not ("failed" or "launching" or "running" or "unconfirmed" or "complete"))throw new InvalidDataException("Журнал установки Runtime непонятен; повтор установщика заблокирован. Проверьте Runtime через официальный Microsoft Setup вручную.");
        return result;
    }
    public void WriteAttempt(RuntimeAttempt attempt) {
        Directory.CreateDirectory(root);var temp=Ledger+".tmp";File.WriteAllText(temp,JsonSerializer.Serialize(attempt));File.Move(temp,Ledger,true);
    }
    public async Task<RuntimeInstallerFile> PrepareInstaller(IProgress<RuntimeProgress> progress,CancellationToken ct) {
        var document=JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory,"runtime","webview2-runtime.json"),ct));
        using(document) {
            var p=document.RootElement;var pin=new RuntimeDownloadPin(p.GetProperty("fileName").GetString()!,p.GetProperty("url").GetString()!,p.GetProperty("size").GetInt64(),p.GetProperty("sha256").GetString()!);
            if(pin.FileName!="MicrosoftEdgeWebview2Setup.exe")throw new InvalidDataException("Invalid bootstrapper filename.");
            var path=Path.Combine(root,"runtime-downloads",pin.Sha256+"-"+pin.FileName);
            bool cached=false;
            if(File.Exists(path)) {await using var old=File.OpenRead(path);cached=old.Length==pin.Size&&Convert.ToHexString(await SHA256.HashDataAsync(old,ct)).ToLowerInvariant()==pin.Sha256;}
            if(!cached) {
                progress.Report(new("download","Скачиваем небольшой bootstrapper Microsoft; для установки Runtime нужен интернет…",0));
                using var timeout=CancellationTokenSource.CreateLinkedTokenSource(ct);timeout.CancelAfter(TimeSpan.FromSeconds(90));
                using var client=new HttpClient(new HttpClientHandler { AllowAutoRedirect=false });
                client.DefaultRequestHeaders.UserAgent.ParseAdd("PackageFlow/1.10.15");DownloadRequests++;
                await RuntimeDownload.Fetch(client,pin,path,new Progress<long>(bytes=>progress.Report(new("download","Скачиваем bootstrapper Microsoft…",(int)(bytes*100/pin.Size)))),timeout.Token);
            }
            progress.Report(new("signature","Проверяем SHA256 и Authenticode/Microsoft signer…"));
            var lease=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,65536,true);
            try {
                if(lease.Length!=pin.Size || Convert.ToHexString(await SHA256.HashDataAsync(lease,ct)).ToLowerInvariant()!=pin.Sha256)throw new InvalidDataException("SHA256/размер bootstrapper не совпал. Файл не запускался.");
                using var signatureTimeout=CancellationTokenSource.CreateLinkedTokenSource(ct);signatureTimeout.CancelAfter(TimeSpan.FromSeconds(45));
                await VerifyMicrosoftSignature(path,signatureTimeout.Token);
                return new RuntimeInstallerFile(path,lease);
            } catch { lease.Dispose();throw; }
        }
    }
    internal static async Task<string> VerifyMicrosoftSignature(string path,CancellationToken ct) {
        try {return await ProcessRunner.Run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",Path.Combine(AppContext.BaseDirectory,"runtime","verify-webview2-signature.ps1"),"-Installer",path],AppContext.BaseDirectory,ct);}
        catch(OperationCanceledException){throw new TimeoutException("Проверка Authenticode/Microsoft не завершилась вовремя. Файл не запускался; проверьте доступ к сертификатам Microsoft и повторите.");}
        catch(InvalidOperationException){throw new InvalidDataException("Windows не подтвердила Valid Authenticode и Microsoft signer у bootstrapper. Файл не запускался; проверьте подпись, доступ к сертификатам и политики Windows.");}
    }
    public async Task<int?> RunInstaller(RuntimeInstallerFile file,CancellationToken ct) {
        using var process=new Process { StartInfo=new ProcessStartInfo(file.Path) { UseShellExecute=false,CreateNoWindow=true } };
        process.StartInfo.ArgumentList.Add("/silent");process.StartInfo.ArgumentList.Add("/install");
        try { if(!process.Start())throw new InvalidOperationException("Microsoft Setup не запущен."); }
        catch { WriteAttempt(new("failed"));throw new RuntimePreparationException("Windows не разрешила запуск Microsoft Setup. Проверьте права и политики установки; можно повторить вручную."); }
        InstallerDispatches++;WriteAttempt(new("running",process.Id,process.StartTime.ToUniversalTime().Ticks));
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(ct);timeout.CancelAfter(TimeSpan.FromMinutes(3));
        try { await process.WaitForExitAsync(timeout.Token);return process.ExitCode; }
        catch(OperationCanceledException) { WriteAttempt(new("unconfirmed",process.Id,process.StartTime.ToUniversalTime().Ticks));return null; }
        // Disposing the Process handle never terminates Microsoft Setup or shared Edge Update processes.
    }
    public Task Delay(CancellationToken ct)=>Task.Delay(1000,ct);
}
