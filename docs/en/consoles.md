# Connect PS4 and PS5

[← Contents](index.md) · [README](../../README.en.md) · [Русский](../ru/consoles.md)

One PackageFlow WEB server can work with several PS4 and PS5 consoles. Each console has its own connection, queue and history, with a shared library on your computer or NAS. Console components are available in [Releases](https://github.com/demagoc3-cpu/playstation_installer/releases/latest).

## Before connecting

- Start WEB on your computer or NAS. Open `http://localhost:3000` on that computer or `http://<computer-IP>:3000` from another device. Use your configured port if it differs.
- Connect the computer and console to a local network where they can reach each other. The console needs the computer's **LAN IP**, not `localhost`. Allow the required connections through the firewall and keep WEB running during jobs.
- Prepare a compatible homebrew environment on the console. Installing PackageFlow does not activate GoldHEN, an exploit or an ELF loader.
- Consider reserving the console's IP in your router's DHCP settings: an existing WEB profile's address cannot be edited.

## PS4

1. Activate **GoldHEN**. Install the **PackageFlow for PS4** PKG from the release and launch it on the console. The package includes the interface and the **PackageFlowService** background service.
2. In WEB, open **Devices → Add device**. Enter a name, choose **PlayStation 4**, and enter the console's IP. Set **Installation method** to **PackageFlowService**, then click **Save**.
3. In the PS4 row, choose **Service → Connect**. The current service connects **without entering a code from the console screen**. WEB saves the access key and sends its address to the service; the connection is then paired.
4. Add your games folder to the library and send the selected PKG files to PS4. Review the recipient and the game, patches and DLC in the installation dialog.

If WEB asks you to update the service for connection without a code, install the current PKG and launch it. For an existing PS4 connection, the **Service** menu offers **Check the connection**, **Update service** and **Reconnect**.

**PyLoader is a fallback for PS4**, including the first installation of the service PKG. Activate GoldHEN and PyLoader on TCP `9090`, then select **PyLoader** as the PS4 profile's installation method. The Windows wizard also offers **Install service** through PyLoader. A paired service is not required for this path. Transferring a PKG and completing the system installation are separate stages: check **Notifications → Downloads** on PS4 for the first installation's result, then launch PackageFlow and connect the service.

## PS5

PS5 uses two separate components:

| Component                                                                                            | Purpose                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **ELF service** (`PackageFlowPayload-PS5_….elf` in Releases; `PackageFlowService-PS5.elf` in PLDMGR) | Background API for transfers, installation and management from WEB. Required for WEB to work with PS5.      |
| **Native app** (`PackageFlow-PS5_….ffpkg`)                                                           | Optional library and jobs interface on PS5, controlled with a gamepad. It does not replace the ELF service. |

1. Prepare a compatible homebrew environment that can run ELF payloads. Service management from WEB needs **PLDMGR** running on PS5 (HTTP `8084`). **Folder and image** installation also needs **ShadowMount** installed and running, with an API supported by the service.
2. In WEB, open **Devices → Add device**, choose **PlayStation 5**, enter its name and IP, and click **Save**.
3. Prepare the ELF service from the same PackageFlow release. If WEB includes a console bundle, choose **Service → Install from the WEB bundle** and confirm. If the ELF is already saved in PLDMGR, choose **Service → Launch**. For manual setup, use the ELF from Releases with a compatible loader in your environment.
4. Choose **Service → Check the service**, then **Service → Connect**. The current service connects **without a code**; its API uses TCP `8095`.
5. Add your library sources. The installation dialog checks **PKG**, **Folder** and **UFS2, exFAT, PFS, FFPFSC** images separately for this PS5.

For a service saved in PLDMGR, the menu offers **Add to autoload**, **Check for updates**, launch and stop. **Open** in the PS5 row opens its PLDMGR page. Reading the service status does not install or launch an ELF.

The native PS5 app is optional when using a browser. To use the interface on the console, obtain the FFPKG from Releases and install it through a compatible method in your environment. The app must reach the running WEB server's LAN address; the app's catalog connection and the background service connection are separate settings.

## What determines installation availability

WEB checks the **running service's capabilities**, its readiness, the firmware and the selected content's metadata. A successful connection does not mean that every installation method is ready. An unavailable ShadowMount affects Folder/images and does not by itself disable PKG; PKG failures have their own explanation.

PS5 can receive PS4 and PS5 PKG files and supported Folder/images when the service confirms the corresponding route. **PS4 cannot install PS5 content.** Format support does not guarantee compatibility with every firmware or that a particular game will launch. The complete selection is checked for each recipient before installation.

If a reply is lost, check the existing job in **Tasks** or the operation result before sending another command. Update or restart components after active transfers and installations have finished.

Next: [Library and installation](library.md) · [Data and updates](updates-data.md) · [Troubleshooting](troubleshooting.md).
