import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import URLError

spec = importlib.util.spec_from_file_location('dependency_audit', Path(__file__).with_name('dependency_audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class DependencyAuditTests(unittest.TestCase):
    def test_all_locked_classes_and_scoped_packages_are_included(self):
        text = "lockfileVersion: '9.0'\npackages:\n  '@scope/tool@1.2.3':\n    resolution: {}\n  build-tool@2.3.4:\n    dev: true\n  optional-tool@3.4.5:\n    optional: true\nsnapshots:\n  ignored@9.9.9: {}\n"
        self.assertEqual(audit.pnpm_inventory(text), {('@scope/tool', '1.2.3'), ('build-tool', '2.3.4'), ('optional-tool', '3.4.5')})

    def test_unsupported_and_non_registry_inputs_fail(self):
        for text in ["lockfileVersion: '6.0'\npackages: {}", "lockfileVersion: '9.0'\npackages:\n  tool@https://example.com/code:"]:
            with self.assertRaises(audit.AuditError):
                audit.pnpm_inventory(text)
        with self.assertRaises(audit.AuditError):
            audit.npm_inventory({'lockfileVersion': 3, 'packages': {'node_modules/tool': {'link': True}}})

    def test_missing_lock_cannot_produce_clean_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'package.json').write_text(json.dumps({'devDependencies': {'build-tool': '1.2.3'}}))
            with self.assertRaises(audit.AuditError):
                audit.inventory(root)

    def test_nested_npm_and_optional_records_are_audited(self):
        self.assertEqual(audit.npm_inventory({'lockfileVersion': 3, 'packages': {'': {}, 'node_modules/@scope/tool': {'version': '1.2.3'}, 'node_modules/a/node_modules/b': {'version': '4.5.6', 'optional': True}}}), {('@scope/tool', '1.2.3'), ('b', '4.5.6')})

    def test_advisory_maps_to_exact_package_without_install(self):
        def opener(request, timeout):
            payload = json.loads(request.data)
            self.assertEqual(payload['queries'][0]['version'], '1.2.3')
            self.assertEqual(timeout, 30)
            return io.BytesIO(json.dumps({'results': [{'vulns': [{'id': 'GHSA-test-test-test'}]}, {}]}).encode())
        findings = audit.query([('a', '1.2.3'), ('b', '2.3.4')], opener)
        self.assertEqual(findings, [{'package': 'a', 'version': '1.2.3', 'advisories': ['GHSA-test-test-test']}])

    def test_paginated_advisories_cannot_produce_clean_result(self):
        for response in [{'results': [{}], 'next_page_token': 'more'}, {'results': [{'next_page_token': 'more'}]}, {'results': [{'page_token': 'more'}]}]:
            def opener(*args, response=response, **kwargs):
                return io.BytesIO(json.dumps(response).encode())
            with self.assertRaises(audit.AuditError):
                audit.query([('a', '1.2.3')], opener)

    def test_network_error_incomplete_result_and_remote_error_fail(self):
        def unavailable(*args, **kwargs):
            raise URLError('offline')
        with self.assertRaises(audit.AuditError):
            audit.query([('a', '1.2.3')], unavailable)
        for response in [{'results': []}, {'results': [{'error': 'unavailable'}]}, []]:
            def opener(*args, response=response, **kwargs):
                return io.BytesIO(json.dumps(response).encode())
            with self.assertRaises(audit.AuditError):
                audit.query([('a', '1.2.3')], opener)


if __name__ == '__main__':
    unittest.main()
