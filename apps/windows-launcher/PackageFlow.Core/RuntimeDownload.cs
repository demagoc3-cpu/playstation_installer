using System.Net;
using System.Security.Cryptography;
namespace PackageFlow.Core;
public sealed record RuntimeDownloadPin(string FileName, string Url, long Size, string Sha256);
public static class RuntimeDownload
{
    public static bool Allowed(Uri url) => url.Scheme == "https" && url.IsDefaultPort && url.UserInfo.Length == 0 && url.Host == "msedge.sf.dl.delivery.mp.microsoft.com";
    public static async Task Fetch(HttpClient http, RuntimeDownloadPin pin, string destination, IProgress<long>? progress, CancellationToken ct)
    {
        if (pin.Size is < 1024 or > 4 * 1024 * 1024 || !System.Text.RegularExpressions.Regex.IsMatch(pin.Sha256, "^[a-f0-9]{64}$")) throw new InvalidDataException("Некорректный закреплённый bootstrapper Runtime.");
        var url = new Uri(pin.Url);var part = destination + ".part-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        try {
            for (var attempt = 0; attempt < 4; attempt++) {
                if (!Allowed(url)) throw new InvalidDataException("Загрузка Runtime разрешена только по HTTPS с закреплённого сервера Microsoft.");
                using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
                // The supplied HttpClient must disable automatic redirects; reject any silent redirect as well.
                if (response.RequestMessage?.RequestUri is {} actual && actual != url) throw new InvalidDataException("Неожиданный автоматический redirect Runtime.");
                if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308) {
                    url = response.Headers.Location is {} location ? new Uri(url, location) : throw new InvalidDataException("Microsoft вернул redirect без адреса.");continue;
                }
                if (!response.IsSuccessStatusCode) throw new HttpRequestException($"Microsoft download: HTTP {(int)response.StatusCode}. Проверьте доступ к серверам Microsoft.");
                if (response.Content.Headers.ContentLength is long length && length != pin.Size) throw new InvalidDataException("Размер bootstrapper Microsoft не совпадает с закреплённым файлом.");
                await using (var output = new FileStream(part, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true)) {
                    await using var input = await response.Content.ReadAsStreamAsync(ct);
                    var buffer = new byte[65536];long total = 0;int count;
                    while ((count = await input.ReadAsync(buffer, ct)) > 0) { total += count;if(total > pin.Size)throw new InvalidDataException("Bootstrapper Microsoft превышает допустимый размер.");await output.WriteAsync(buffer.AsMemory(0, count), ct);progress?.Report(total); }
                    if(total != pin.Size)throw new InvalidDataException("Загрузка bootstrapper Microsoft неполная.");
                }
                await using (var check = File.OpenRead(part)) if (Convert.ToHexString(await SHA256.HashDataAsync(check, ct)).ToLowerInvariant() != pin.Sha256) throw new InvalidDataException("SHA256 bootstrapper Microsoft не совпал. Файл не запускается.");
                File.Move(part, destination, true);return;
            }
            throw new InvalidDataException("Слишком много redirect от Microsoft.");
        } finally { if(File.Exists(part))File.Delete(part); }
    }
}
