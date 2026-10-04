# Console files and trash

[← Contents](index.md) · [Русский](../ru/files.md)

## Files in the PS4 app (1.72)

The **Files** section requires the updated WEB server and confirmed pairing. Browse folders, create a folder, copy a file or folder, rename, permanently delete, edit text and install a local PKG. These actions use the same service and operation history as WEB.

- **Cross** opens a folder or focuses the actions for a file. **Right** focuses the buttons; **Down** returns to the list.
- **Circle** opens the parent folder, or focuses the sidebar at the root. **L1 / R1** switch directory pages; L1 opens the parent on the first page. **Square** refreshes; **Triangle** opens path input.
- Select an item → **Copy**, open the destination folder → **Paste**. One selected item is copied, including folder contents.
- New folder and Rename use the native PS4 keyboard.
- **Delete** requires a separate confirmation: Options deletes, Circle cancels. Trash and previous versions are managed in WEB. If a folder contains a protected previous version, purge that backup in WEB first.
- **Edit** opens UTF-8 text up to 128 KiB. Select a line and press Cross to edit it with the native keyboard. Square inserts a line; Triangle deletes a line in the editor. Options asks to save, then Cross confirms. Discarding unsaved changes also requires confirmation. Edit very long lines in WEB.
- **Install** checks the PKG, firmware and free space before confirmation with Cross. The source remains in its folder. Results and cancellation are also available in WEB → Files.

Writes are limited to `/data` and USB; system areas are read-only. A lost reply is resolved using the previous job ID; mutations are never automatically resubmitted. WEB must remain running during file operations. PC preview permits reading and PKG inspection, while mutations and installation remain disabled.

WEB → Files browses PS4 directories through PackageFlowService. System areas are read-only. Mutations are limited to permitted data/USB paths; service files, credentials, links and a currently installed local PKG are protected.

## Transfers

Download supports resume. Upload to `/data` or USB supports Pause. Selecting the same file again resumes from its saved position, including after a service restart. Uploading a PKG alone does not install it. Service 1.55+ uses chunks up to 4 MiB; older services use 256 KiB.

## Manage files

Create a folder, rename, select several items, copy or move. Choose the destination and Paste here. Copy/move operations can pause/resume and survive interrupted WEB sessions. The WEB server must run during transfers.

Move to trash preserves a recoverable copy. Restore requires the original name to be available; for USB copies reconnect the same drive. Cross-disk movement copies first and retains the source in trash; same-disk movement uses renaming.

Trash/previous versions stay **on PS4 and consume disk space**. Their index and operation history are stored in WEB's `.data/console-files`; preserve it during updates. Permanent Delete and Empty trash require confirmation and cannot be undone. Partially deleted trash cannot be restored.

Replacing an existing upload stores a previous version after confirmation. The text editor supports UTF-8 text up to 128 KiB (TXT, JSON, INI, CFG, CONF, XML, YAML, LOG, CSV, MD). Save verifies that the source has not changed and retains its previous version.

## Install a PKG already on PS4

Service 1.54+ supports local PKGs in `/data`, `/user/data` and USB. Click Install beside the file, review its metadata and select Install on PS4. WEB checks firmware, file identity/size and space; installation happens on PS4 without retransferring the package from the computer. The source remains in its folder and is protected during installation. Status/cancellation are on the page; the result is in operation history.

Version 1.57 fixes combined base/update packages and recovers a valid backup of the installation journal. Corrupt primary and backup journals block installation. Completed operation notifications hide automatically; use History for details.

Manage installed games through On console and save slots through Saves rather than deleting those folders manually.

Since 1.69, installation from Files also supports `PS4GDE` applications.
