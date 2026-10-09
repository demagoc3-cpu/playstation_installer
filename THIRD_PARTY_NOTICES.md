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

## hash-wasm 4.12.0

PS5 source checks use createBLAKE3 from hash-wasm (https://github.com/Daninet/hash-wasm).
Copyright (c) 2020 Dani Biró. MIT license follows below. The embedded BLAKE3
implementation is available under CC0 1.0 or Apache-2.0; CC0 is selected here.
The complete npm package source headers retain the upstream notices.

MIT License

Copyright (c) 2020 Dani Biró

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Embedded C implementations might use other, similarly permissive licenses.
Check the beginning of the files from the /src directory.

Special thank you to the authors of original C algorithms:
- Alexander Peslyak <solar@openwall.com>
- Aleksey Kravchenko <rhash.admin@gmail.com>
- Colin Percival
- Stephan Brumme <create@stephan-brumme.com>
- Steve Reid <steve@edmweb.com>
- Samuel Neves <sneves@dei.uc.pt>
- Solar Designer <solar@openwall.com>
- Project Nayuki
- ARM Limited
- Yanbo Li dreamfly281@gmail.com, goldboar@163.comYanbo Li
- Mark Adler
- Yann Collet
