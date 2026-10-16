"""Host fixtures only: no WEB build, Windows process, or console connection."""
import copy
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('windows_patch', Path(__file__).parents[1] / 'package-windows-patch.py')
patch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch)


class WindowsPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pf-windows-patch-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = self.root / 'old'
        self.new = self.root / 'new'
        for web, text in ((self.old, b'old backend'), (self.new, b'new backend')):
            (web / 'server').mkdir(parents=True)
            (web / 'public').mkdir()
            (web / 'server/index.mjs').write_bytes(text)
            (web / 'public/style.css').write_bytes(b'preserved library and task geometry')
        self.launcher = self.root / 'PackageFlow.exe'
        self.node = self.root / 'node.exe'
        self.launcher.write_bytes(b'fixture launcher 26 - unchanged')
        self.node.write_bytes(b'fixture Windows Node - unchanged')
        self.base = patch.snapshot(self.old, self.launcher, self.node, '1.10.26.0')
        self.service = self.root / 'service'
        self.service.mkdir()
        self.set_service(8192)

    def set_service(self, size):
        data = bytearray(size)
        data[:6] = bytes.fromhex('7f454c460201')
        data[18:20] = b'\x3e\x00'
        self.elf = {'fileName': patch.ELF_NAME, 'size': size, 'sha256': patch.digest(data),
                    'version': '0.1.99-dev', 'buildId': 'host-fixture-not-a-release', 'firmware': '13.60'}
        self.manifest = {'schemaVersion': 1, 'elf': self.elf}
        directory = self.service / self.elf['sha256']
        directory.mkdir(exist_ok=True)
        (directory / patch.ELF_NAME).write_bytes(data)
        (self.service / 'manifest.json').write_bytes(patch.json_bytes(self.manifest))

    def build(self, archive=None, base=None):
        return patch.package(self.new, base or self.base, self.service, 'a' * 40,
                             archive or self.root / 'patch.zip')

    def test_patch_is_service_only_and_preserves_old_bundle_and_binaries(self):
        # These stand in for data never selected as patch input.
        persistent = self.root / 'data'
        persistent.mkdir()
        for name in ('library.json', 'ps5-service-keys.json', 'ps5-installation-queue.json', 'manifest.json'):
            (persistent / name).write_text('preserved opaque fixture')
        before = {p: p.read_bytes() for p in persistent.iterdir()}
        result = self.build()
        self.assertFalse(result['applied'])
        self.assertFalse(result['launcherReplaced'])
        with zipfile.ZipFile(result['archive']) as archive:
            descriptor = json.loads(archive.read('patch-manifest.json'))
            self.assertEqual(descriptor['base'], self.base)
            self.assertEqual(descriptor['service'], self.manifest)
            expected = {'patch-manifest.json', 'update-installed-windows-web.ps1',
                        'web/server/index.mjs', 'web/public/style.css',
                        'ps5-service-artifacts/manifest.json',
                        f'ps5-service-artifacts/{self.elf["sha256"]}/{patch.ELF_NAME}'}
            self.assertEqual(set(archive.namelist()), expected)
            for record in descriptor['files']:
                data = archive.read(record['path'])
                self.assertEqual(len(data), record['size'])
                self.assertEqual(patch.digest(data), record['sha256'])
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertEqual(self.launcher.read_bytes(), b'fixture launcher 26 - unchanged')
        self.assertEqual(self.node.read_bytes(), b'fixture Windows Node - unchanged')

    def test_entire_web_base_is_bound_including_added_or_removed_files(self):
        original = self.base['web']['treeSha256']
        (self.old / 'public/style.css').write_bytes(b'different')
        changed = patch.snapshot(self.old, self.launcher, self.node, '1.10.26.0')
        self.assertNotEqual(original, changed['web']['treeSha256'])
        (self.old / 'public/added.css').write_bytes(b'extra')
        added = patch.snapshot(self.old, self.launcher, self.node, '1.10.26.0')
        self.assertNotEqual(changed['web']['treeSha256'], added['web']['treeSha256'])

    def test_tampered_base_manifest_is_rejected_before_archive_creation(self):
        base = copy.deepcopy(self.base)
        base['web']['files'][0]['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            self.build(base=base)
        self.assertFalse((self.root / 'patch.zip').exists())

    def test_elf_limit_remains_exactly_four_mib(self):
        self.set_service(patch.MAX_ELF)
        self.build()
        self.set_service(patch.MAX_ELF + 1)
        with self.assertRaises(ValueError):
            self.build(self.root / 'oversized.zip')
        self.assertFalse((self.root / 'oversized.zip').exists())

    def test_corrupt_or_missing_service_never_uses_old_bundle(self):
        elf = self.service / self.elf['sha256'] / patch.ELF_NAME
        elf.write_bytes(b'bad')
        with self.assertRaises(ValueError):
            self.build()
        elf.unlink()
        with self.assertRaises(FileNotFoundError):
            self.build()

    def test_non_x64_elf_rejected_even_with_matching_digest(self):
        data = bytearray(8192)
        data[:6] = bytes.fromhex('7f454c460201')
        self.elf['sha256'] = patch.digest(data)
        directory = self.service / self.elf['sha256']
        directory.mkdir()
        (directory / patch.ELF_NAME).write_bytes(data)
        (self.service / 'manifest.json').write_bytes(patch.json_bytes(self.manifest))
        with self.assertRaises(ValueError):
            self.build()

    def test_filename_firmware_and_unqualified_identity_are_rejected(self):
        for key, value in (('fileName', 'PackageFlowInstaller-PS5.elf'), ('firmware', '12.60'),
                           ('buildId', '../candidate'), ('version', 'latest')):
            with self.subTest(key=key):
                altered = copy.deepcopy(self.manifest)
                altered['elf'][key] = value
                (self.service / 'manifest.json').write_bytes(patch.json_bytes(altered))
                with self.assertRaises(ValueError):
                    self.build()

    def test_json_cannot_override_identity_with_duplicate_keys(self):
        (self.service / 'manifest.json').write_text('{"schemaVersion":1,"SchemaVersion":2,"elf":{}}')
        with self.assertRaises(ValueError):
            self.build()

    def test_windows_traversal_aliases_and_file_directory_conflicts_are_rejected(self):
        for name in ('../evil', '/root', 'C:/root', 'x\\y', 'x/../y', 'x/NUL.json',
                     'x/file:stream', 'x/trailing.', 'x/trailing ', 'x//y'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                patch.safe_path(name)
        for names in (('server/index.mjs', 'SERVER/index.mjs'), ('server/index.mjs', 'server')):
            with self.subTest(names=names), self.assertRaises(ValueError):
                patch.validate_files([patch.file_record(name, b'') for name in names])

    def test_windows_case_collisions_rejected_from_real_build_tree(self):
        (self.new / 'public/STYLE.css').write_bytes(b'ambiguous')
        with self.assertRaises(ValueError):
            self.build()

    def test_internal_nitro_links_are_materialized_and_external_links_rejected(self):
        (self.new / 'server/internal.mjs').symlink_to('index.mjs')
        result = self.build()
        with zipfile.ZipFile(result['archive']) as archive:
            self.assertEqual(archive.read('web/server/internal.mjs'), b'new backend')
        (self.new / 'server/external.mjs').symlink_to(self.node)
        with self.assertRaises(ValueError):
            self.build(self.root / 'external.zip')

    def test_cycle_native_module_and_linked_service_are_rejected(self):
        (self.new / 'server/loop').symlink_to(self.new, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.build()
        (self.new / 'server/loop').unlink()
        (self.new / 'server/native.node').write_bytes(b'platform-dependent')
        with self.assertRaises(ValueError):
            self.build()
        (self.new / 'server/native.node').unlink()
        elf = self.service / self.elf['sha256'] / patch.ELF_NAME
        original = elf.read_bytes()
        elf.unlink()
        self.node.write_bytes(original)
        elf.symlink_to(self.node)
        with self.assertRaises(ValueError):
            self.build()

    def test_existing_archive_is_preserved_and_same_base_is_never_overwritten(self):
        result = self.build()
        before = Path(result['archive']).read_bytes()
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual(Path(result['archive']).read_bytes(), before)

    def test_approved_raw_elf_can_be_staged_independently_without_an_app(self):
        source = self.service / self.elf['sha256'] / patch.ELF_NAME
        destination = self.root / 'independent'
        result = patch.stage_service(source, self.manifest, destination)
        self.assertFalse(result['applied'])
        self.assertEqual(patch.service_artifact(destination)[0], self.manifest)
        with self.assertRaises(ValueError):
            patch.stage_service(source, self.manifest, destination)
        source.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            patch.stage_service(source, self.manifest, self.root / 'unapproved')
        self.assertFalse((self.root / 'unapproved').exists())


if __name__ == '__main__':
    unittest.main()
