using System.Text.Json.Nodes;

namespace PackageFlow.Core;

public static class ComposeConfiguration
{
    // JSON is a YAML subset accepted by Docker Compose; no shell/env interpolation.
    public static string Generate(LauncherSettings settings, string dataDirectory, string launcherKey, string image, string? buildDirectory = null)
    {
        settings.Validate();
        if (!Directory.Exists(settings.GamesDirectory)) throw new DirectoryNotFoundException("Choose an existing games folder.");
        string Literal(string value) => value.Replace("$", "$$");
        JsonObject Mount(string source, string target, bool readOnly = false) => new()
        { ["type"] = "bind", ["source"] = Literal(Path.GetFullPath(source).Replace('\\', '/')), ["target"] = target, ["read_only"] = readOnly };
        JsonObject Port(int published, int target, string address) => new()
        { ["target"] = target, ["published"] = published.ToString(), ["host_ip"] = address, ["protocol"] = "tcp" };
        var services = new JsonObject
        {
            ["packageflow"] = new JsonObject
            {
                ["image"] = image, ["restart"] = "unless-stopped", ["init"] = true,
                ["environment"] = new JsonObject
                {
                    ["PACKAGEFLOW_HOST_IP"] = settings.HostIp,
                    ["PACKAGEFLOW_PUBLIC_PORT"] = settings.Port.ToString(),
                    ["PACKAGEFLOW_PAYLOAD_PORT"] = settings.PayloadPort.ToString(),
                    ["PACKAGEFLOW_LAUNCHER_KEY"] = launcherKey,
                    ["PACKAGEFLOW_DATA_DIR"] = "/app/.data"
                },
                ["ports"] = new JsonArray(Port(settings.Port, 3000, "0.0.0.0"), Port(settings.PayloadPort, settings.PayloadPort, "0.0.0.0")),
                ["volumes"] = new JsonArray(Mount(Path.Combine(dataDirectory, "web"), "/app/.data"), Mount(settings.GamesDirectory, "/games", true))
            }
        };
        if (buildDirectory != null)
        {
            services["packageflow"]!["build"] = new JsonObject
            {
                ["context"] = Literal(Path.GetFullPath(buildDirectory).Replace('\\', '/')),
                ["dockerfile"] = "compose/Dockerfile"
            };
        }
        if (settings.ManagedProwlarr)
        {
            services["prowlarr"] = new JsonObject
            {
                ["image"] = "lscr.io/linuxserver/prowlarr:latest", ["restart"] = "unless-stopped",
                ["ports"] = new JsonArray(Port(9696, 9696, "127.0.0.1")),
                ["volumes"] = new JsonArray(Mount(Path.Combine(dataDirectory, "prowlarr"), "/config"))
            };
        }
        if (settings.FlareSolverr)
        {
            services["flaresolverr"] = new JsonObject
            {
                ["image"] = "ghcr.io/flaresolverr/flaresolverr:latest", ["restart"] = "unless-stopped",
                ["ports"] = new JsonArray(Port(8191, 8191, "127.0.0.1"))
            };
        }
        return new JsonObject { ["name"] = "packageflow-desktop", ["services"] = services }.ToJsonString(new() { WriteIndented = true });
    }
}
