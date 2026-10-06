# Building the PackageFlow Windows installer locally

[Русский](README.md) · **English**

Build WEB and the Windows launcher into one installer on your own computer. Run all commands from the repository root containing `package.json` and `packaging`.

Local builds use your current files, including uncommitted changes. GitHub Actions builds use the files pushed to the selected branch or tag.

## Requirements

| Tool | Purpose |
| --- | --- |
| Node.js 22 and npm | WEB build |
| .NET SDK 8 | Core checks and Windows launcher build |
| NSIS 3 | Installer packaging |
| Internet access | Dependencies and the official Windows Node.js runtime |

Linux also requires Python 3, `curl`, `unzip`, `awk`, and `sha256sum`. The script checks tools before building and locates their local installations. Docker is needed for the optional Compose runtime check.

## Build on Windows

Open PowerShell in the repository root. Install NSIS in its standard `Program Files (x86)/NSIS` directory or make `makensis.exe` available in PATH.

```powershell
./packaging/windows/build.ps1 -Version 0.1.7

$setup = Get-Item './dist/windows/PackageFlowSetup-0.1.7-x64.exe'
$hash = (Get-FileHash $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $($setup.Name)" | Set-Content './dist/windows/SHA256SUMS.txt' -Encoding ascii
```

The script installs WEB dependencies, builds WEB, runs the core checks, publishes `PackageFlow.exe`, downloads and verifies Windows Node.js, and packages the installer.

### Build options

```powershell
# Reuse the current WEB build in .output
./packaging/windows/build.ps1 -Version 0.1.7 -SkipWebBuild

# Prepare the complete application directory without Setup.exe
./packaging/windows/build.ps1 -Version 0.1.7 -SkipInstaller

# Name the local image built for Compose mode
./packaging/windows/build.ps1 -Version 0.1.7 -DockerImage packageflow:local
```

Use `-SkipWebBuild` after successfully building the current WEB sources. `-DockerImage` names the image the launcher builds from bundled WEB when starting Compose; it does not publish an image to a registry.

## Build Windows EXE on Linux

The Windows project enables `EnableWindowsTargeting`, allowing .NET to compile it on Linux. Test the WinForms interface on Windows. `build.ps1` targets Windows. On Linux use `packaging/windows/build.sh`, which locates the repository and prepares the complete installer.

Check the tools and then start the build:

```bash
bash packaging/windows/build.sh --check
bash packaging/windows/build.sh --version 0.1.7
```

The repository root also provides `bash build-local.sh`. It works from an IDE because the script resolves its working directory automatically.

Use `--skip-install` with existing dependencies, `--skip-web-build` with the current built WEB, or `--skip-installer` to prepare the application without Setup.exe.

```bash
bash build-local.sh --skip-install
```

The script locates npm in PATH, pnpm, nvm, and fnm directories. It locates .NET in PATH, `.toolchains/dotnet`, `~/.dotnet`, and the temporary test SDK folder. NSIS is found in PATH, `.toolchains/nsis`, or the temporary test compiler folder. Temporary folders may disappear after reboot; install tools or put them in `.toolchains` for persistent use.

Override paths with `PF_NPM_CLI` (the `npm-cli.js` file), `PF_DOTNET`, `PF_MAKENSIS`, and optionally `NSISDIR`. Set `PF_NODE_VERSION` to change the Windows runtime; the default **22.23.3** was used in our test build. `PF_DOCKER_IMAGE` sets the local Compose image name.

The script waits for the build to finish before packaging, downloads official Windows Node.js, and verifies SHA-256. See [build.sh](build.sh) for the complete implementation.

## Output

| Path | Contents |
| --- | --- |
| `dist/windows/PackageFlowSetup-0.1.7-x64.exe` | Installer for users |
| `dist/windows/SHA256SUMS.txt` | Installer checksum |
| `dist/windows/payload/PackageFlow.exe` | Windows launcher and setup UI |
| `dist/windows/payload/server/.output/` | Built WEB |
| `dist/windows/payload/runtime/` | Windows Node.js |
| `dist/windows/payload/compose/` | Compose build files |

To run the unpacked distribution on Windows, open `PackageFlow.exe` inside the complete `payload` directory. Distribute `PackageFlowSetup-…-x64.exe` to users.

The wizard downloads Prowlarr and FlareSolverr during search setup. Users install Docker Desktop and qBittorrent separately. The PS4 PKG is built in the PackageFlowService repository.

## Checks

The build runs the Windows core checks. Test pairing address publication separately:

```bash
node --test server/tests/service-pairing.test.mjs server/tests/service-web-address.test.mjs
```

With Docker and Compose available, check the bundled WEB and persistent container data:

```bash
python3 packaging/compose/smoke.py --dotnet dotnet
```

This test requires the prepared `payload` directory, starts a separate temporary Compose project, and removes its containers afterward.

On Windows, test upgrading an existing installation, startup and tray behavior, PS4 pairing, FlareSolverr search, and your chosen launch mode. Successfully compiling an EXE does not verify the UI on real Windows.

## Troubleshooting

- **Missing tools:** check `node --version`, `npm --version`, `dotnet --info`, and NSIS availability in PATH.
- **Dependency download failure:** check connectivity and npm/.NET messages; retry after resolving the cause.
- **Node.js SHA-256 mismatch:** stop packaging and download the official archive and checksum list again.
- **Native `.node` modules found:** build those modules separately for Windows and Linux/Compose; packaging stops to prevent incompatible modules from entering the distribution.
- **Invalid version:** use three numbers, such as `0.1.1`.

The `dist` directory is excluded from Git. Attach the installer and its checksum to a GitHub Release manually when publishing.

## Cloudflare verification on Windows

The installation tab includes **“Cloudflare: visible FlareSolverr browser (Windows)”**. It defaults to enabled, including when upgrading older settings. Chromium may open during tracker checks; if a verification checkbox appears, you can click it. The diagnostic browser uses English; PackageFlow keeps the selected interface language.

On the test Windows machine, FlareSolverr 3.5.2's hidden browser failed RuTracker verification and returned empty cookies or a Cloudflare page. The visible browser with `LANG=en-US` obtained the login form and cookies accepted by an HTTP request with status `200`. Prowlarr still tests authentication and search separately; homepage access does not confirm login.

To change this mode in a running launcher, stop the server, change the checkbox, and choose **“Save and start”**. The setting applies to managed FlareSolverr in native Windows mode. It does not reconfigure external FlareSolverr instances or the Compose container.
