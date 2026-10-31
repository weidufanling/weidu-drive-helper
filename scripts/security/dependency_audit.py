#!/usr/bin/env python3
"""Audit exact npm lock versions through OSV without installing or running packages."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ENDPOINT = 'https://api.osv.dev/v1/querybatch'
NAME = re.compile(r'^(?:@[a-z0-9._~-]+/)?[a-z0-9._~-]+$')
VERSION = re.compile(r'^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')
SKIP = {'.git', 'node_modules', 'dist', 'build', 'coverage', 'private', 'security-reports', '.venv', 'venv'}


class AuditError(Exception):
    pass


def exact(name, version):
    if not isinstance(name, str) or not isinstance(version, str) or not NAME.fullmatch(name) or not VERSION.fullmatch(version):
        raise AuditError('Unsupported dependency identity. Review the lockfile privately.')
    return name, version


def pnpm_inventory(text):
    if not re.search(r"(?m)^lockfileVersion:\s*['\"]?9\.0['\"]?\s*$", text):
        raise AuditError('Only the reviewed pnpm lockfile v9 format is supported.')
    found = False
    in_packages = False
    result = set()
    for line in text.splitlines():
        if line == 'packages:':
            found = True
            in_packages = True
            continue
        if in_packages and line and not line[0].isspace() and not line.startswith('#'):
            in_packages = False
        if in_packages and re.match(r'^  \S', line):
            key = line[2:]
            if not key.endswith(':'):
                raise AuditError('An unsupported pnpm package entry needs review.')
            key = key[:-1]
            if len(key) > 1 and key[0] in "'\"" and key[-1] == key[0]:
                key = key[1:-1]
            if '@' not in key:
                raise AuditError('An unsupported pnpm package entry needs review.')
            name, version = key.rsplit('@', 1)
            result.add(exact(name, version))
    if not found:
        # pnpm writes an empty mapping when no packages are recorded.
        if not re.search(r'(?m)^packages:\s*\{\}\s*$', text):
            raise AuditError('A complete pnpm packages inventory was not found.')
    return result


def npm_inventory(data):
    if not isinstance(data, dict) or data.get('lockfileVersion') not in [2, 3] or not isinstance(data.get('packages'), dict):
        raise AuditError('Only npm package-lock v2 and v3 are supported.')
    result = set()
    for location, record in data['packages'].items():
        if not location:
            continue
        if not isinstance(record, dict) or record.get('link'):
            raise AuditError('Linked/workspace packages require a separate inventory.')
        if 'node_modules/' not in location:
            raise AuditError('An unsupported npm package location needs review.')
        name = record.get('name') or location.rsplit('node_modules/', 1)[1]
        result.add(exact(name, record.get('version')))
    return result


def manifest_roots(root, recursive):
    if not recursive:
        return [root]
    found = []
    for path in root.rglob('package.json'):
        if not any(part in SKIP for part in path.relative_to(root).parts[:-1]):
            found.append(path.parent)
    return sorted(set(found)) or [root]


def inventory(root, recursive=False):
    packages = set()
    locks = []
    manifests = []
    for folder in manifest_roots(root, recursive):
        manifest = folder / 'package.json'
        if manifest.is_symlink() and not manifest.resolve().is_relative_to(root):
            raise AuditError('A manifest points outside the selected project.')
        data = json.loads(manifest.read_text()) if manifest.is_file() else {}
        if not isinstance(data, dict):
            raise AuditError('A package manifest must be an object.')
        if manifest.is_file():
            manifests.append(str(manifest.relative_to(root)))
        declared = any(data.get(key) for key in ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
        candidates = [folder / name for name in ['pnpm-lock.yaml', 'package-lock.json'] if (folder / name).is_file()]
        if len(candidates) > 1:
            raise AuditError('Multiple lock formats found. Select one reviewed package-manager workflow.')
        if not candidates and declared:
            raise AuditError('A manifest declares dependencies without a supported exact lockfile.')
        for lock in candidates:
            if lock.is_symlink() and not lock.resolve().is_relative_to(root):
                raise AuditError('A lockfile points outside the selected project.')
            locks.append(str(lock.relative_to(root)))
            items = pnpm_inventory(lock.read_text()) if lock.name == 'pnpm-lock.yaml' else npm_inventory(json.loads(lock.read_text()))
            if declared and not items:
                raise AuditError('The dependency manifest and empty lock inventory need review.')
            packages.update(items)
    if len(packages) > 2000:
        raise AuditError('The inventory exceeds the reviewed query budget.')
    return sorted(packages), locks, manifests


def query(packages, opener=urlopen):
    findings = []
    for offset in range(0, len(packages), 100):
        batch = packages[offset:offset + 100]
        body = {'queries': [{'package': {'ecosystem': 'npm', 'name': name}, 'version': version} for name, version in batch]}
        request = Request(ENDPOINT, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'User-Agent': 'Weidu-lock-audit/1.0'}, method='POST')
        try:
            with opener(request, timeout=30) as response:
                content = response.read(4_000_001)
            if len(content) > 4_000_000:
                raise AuditError('The advisory response exceeds the reviewed size limit.')
            data = json.loads(content)
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
            raise AuditError('The advisory service could not be checked. No clean result is available.') from error
        if not isinstance(data, dict) or 'error' in data:
            raise AuditError('The advisory service returned an error.')
        if data.get('next_page_token') or data.get('page_token'):
            raise AuditError('The advisory response is paginated. A complete result is required.')
        results = data.get('results')
        if not isinstance(results, list) or len(results) != len(batch):
            raise AuditError('The advisory service returned an incomplete result.')
        for (name, version), result in zip(batch, results):
            if not isinstance(result, dict):
                raise AuditError('An unsupported advisory result needs review.')
            if 'error' in result:
                raise AuditError('A dependency could not be checked by the advisory service.')
            if result.get('next_page_token') or result.get('page_token'):
                raise AuditError('A dependency advisory response is paginated. A complete result is required.')
            vulnerabilities = result.get('vulns', [])
            if not isinstance(vulnerabilities, list):
                raise AuditError('An unsupported advisory result needs review.')
            identifiers = []
            for vulnerability in vulnerabilities:
                identifier = vulnerability.get('id') if isinstance(vulnerability, dict) else None
                if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', identifier):
                    raise AuditError('An unsupported advisory identifier needs review.')
                identifiers.append(identifier)
            if identifiers:
                findings.append({'package': name, 'version': version, 'advisories': sorted(set(identifiers))})
    return findings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('.'), help='A single project root')
    parser.add_argument('--recursive', action='store_true', help='Also inspect nested package manifests, excluding generated/private directories')
    args = parser.parse_args(argv)
    try:
        packages, locks, manifests = inventory(args.root.resolve(), args.recursive)
        findings = query(packages)
    except (AuditError, OSError, ValueError) as error:
        # Do not echo untrusted lockfile or network contents in exception messages.
        message = str(error) if isinstance(error, AuditError) else 'A local manifest or lockfile could not be read.'
        print(json.dumps({'schema_version': 1, 'status': 'incomplete', 'message': message}))
        return 2
    print(json.dumps({'schema_version': 1, 'status': 'findings' if findings else 'no_known_advisories', 'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'ecosystem': 'npm', 'packages_checked': len(packages), 'lockfiles': locks, 'manifests': manifests, 'includes': ['production', 'development', 'build', 'transitive', 'optional packages in the lock'], 'findings': findings, 'limits': 'Advisory lookup only. No package install, integrity audit, supply-chain guarantee or manifest-lock synchronisation check.'}, indent=2))
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
