# Third-party notices

PackageFlow's own source code is licensed under the MIT License (see `LICENSE`).
The components below are separate programs distributed with this repository
under their own licenses.

## DirectPackageInstaller payload

- **Files:** `public/ps4-pkg-installer.bin`, `server/assets/ps4-pkg-installer.bin`
- **Project:** DirectPackageInstaller by marcussacana — https://github.com/marcussacana/DirectPackageInstaller
- **License:** GNU General Public License v3.0 — https://www.gnu.org/licenses/gpl-3.0.html
- **Source code:** available in the project repository above (payload sources are in its `Payload` folder).
- **Credits (per upstream):** payload template by sleirsgoevy.

The binary is included unmodified as a separate program. PackageFlow only sends it
to the console and communicates with it over the network; PackageFlow's own code
is not derived from it.

## npm dependencies

Runtime dependencies (Nuxt, Vue, vue-router, uqr) are installed from npm and keep
their own licenses (MIT). See each package's `LICENSE` in `node_modules`.
