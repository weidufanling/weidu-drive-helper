import base64
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest

from release_gate import check, csp_findings


class ReleaseChecks(unittest.TestCase):
    def test_exact_hash_and_changed_bytes(self):
        block = '\nconst message = "hello";\n'
        pin = base64.b64encode(hashlib.sha256(block.encode()).digest()).decode()
        html = '<meta http-equiv="Content-Security-Policy" content="script-src &apos;sha256-' + pin + '&apos;"><script>' + block + '</script>'
        self.assertEqual(csp_findings(html), [])
        self.assertEqual(csp_findings(html.replace('hello', 'changed')), ['inline-script-hash-mismatch'])

    def test_multiple_policies_and_non_executable_json(self):
        html = '<meta http-equiv="Content-Security-Policy" content="script-src \'sha256-invalid\'"><script type="application/ld+json">{}</script>'
        self.assertEqual(csp_findings(html), [])
        self.assertEqual(csp_findings(html + '<script>run()</script>'), ['inline-script-hash-mismatch'])

    def test_style_pin_and_legacy_scope(self):
        self.assertEqual(csp_findings('<meta http-equiv="Content-Security-Policy" content="style-src \'sha256-invalid\'"><style>body{}</style>'), ['inline-style-hash-mismatch'])
        self.assertEqual(csp_findings('<meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\'"><script>run()</script>'), [])

    def test_private_artifacts_missing_lock_and_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / '.env').write_text('EXAMPLE=yes')
            (root / '.env.example').write_text('EXAMPLE=')
            (root / 'package.json').write_text('{"dependencies":{"example":"1.0.0"}}')
            (root / 'outside').symlink_to(root.parent)
            subprocess.run(['git', '-C', folder, 'add', '.'], check=True)
            result = check(root)
            self.assertEqual({f['rule'] for f in result['findings']}, {'private-artifact-in-release-source', 'dependency-lock-missing', 'symlink-in-release-source'})
            self.assertFalse(any(f['file'] == '.env.example' for f in result['findings']))

    def test_internal_symlinks_cannot_hide_policy_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'synthetic.txt').write_text('EXAMPLE=yes')
            (root / '.env').symlink_to('synthetic.txt')
            (root / 'manifest-data.txt').write_text('{"dependencies":{"example":"1.0.0"}}')
            (root / 'package.json').symlink_to('manifest-data.txt')
            result = check(root)
            self.assertEqual({f['file'] for f in result['findings']}, {'.env', 'package.json'})
            self.assertTrue(all(f['rule'] == 'symlink-in-release-source' for f in result['findings']))

    def test_legacy_script_types_and_style_src(self):
        for kind in ('application/ecmascript', 'text/javascript1.2', 'module', 'importmap'):
            html = '<meta http-equiv="Content-Security-Policy" content="script-src \'sha256-invalid\'"><script type="' + kind + '">run()</script>'
            self.assertEqual(csp_findings(html), ['inline-script-hash-mismatch'])
        html = '<meta http-equiv="Content-Security-Policy" content="style-src \'sha256-invalid\'"><style src="ignored">body{}</style>'
        self.assertEqual(csp_findings(html), ['inline-style-hash-mismatch'])

    def test_repository_fsmonitor_is_not_executed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            marker = root / 'hook-ran'
            hook = root / 'synthetic-hook'
            hook.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\n')
            hook.chmod(0o700)
            subprocess.run(['git', '-C', folder, 'config', 'core.fsmonitor', str(hook)], check=True)
            self.assertEqual(check(root)['findings'], [])
            self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
