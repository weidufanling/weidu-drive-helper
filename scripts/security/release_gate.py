#!/usr/bin/env python3
"""Offline release checks. No uploads, code execution, credential reads or deployment."""
import argparse
import base64
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import sys


class InlinePolicy(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.policies = []
        self.blocks = []
        self.active = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'meta' and a.get('http-equiv', '').lower() == 'content-security-policy':
            self.policies.append(a.get('content', ''))
        if tag in ('script', 'style'):
            kind = a.get('type', '').strip().lower()
            # Conservatively include legacy JavaScript types, import maps and
            # unfamiliar types. Only known inert JSON data blocks are exempt.
            executable = tag == 'style' or kind not in ('application/json', 'application/ld+json')
            if executable and (tag == 'style' or 'src' not in a):
                self.active = [tag, '']

    def handle_data(self, data):
        if self.active is not None:
            self.active[1] += data

    def handle_entityref(self, name):
        self.handle_data('&' + name + ';')

    def handle_charref(self, name):
        self.handle_data('&#' + name + ';')

    def handle_endtag(self, tag):
        if self.active is not None and tag == self.active[0]:
            self.blocks.append(tuple(self.active))
            self.active = None


def csp_findings(html):
    parser = InlinePolicy()
    parser.feed(html)
    findings = []
    for policy in parser.policies:
        directives = {}
        for part in policy.split(';'):
            words = part.split()
            if words and words[0] not in directives:
                directives[words[0]] = words[1:]
        for kind, block in parser.blocks:
            values = directives.get(kind + '-src-elem', directives.get(kind + '-src', directives.get('default-src', [])))
            # Only validate existing pins. Unpinned legacy policies require a reviewed change.
            if any(re.fullmatch(r"'sha(?:256|384|512)-[^']+'", v) for v in values):
                matches = ["'sha" + alg + '-' + base64.b64encode(hashlib.new('sha' + alg, block.encode('utf-8')).digest()).decode() + "'" for alg in ('256', '384', '512')]
                if not any(value in values for value in matches):
                    findings.append('inline-' + kind + '-hash-mismatch')
    return findings


def tracked_files(root):
    result = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], capture_output=True, check=True)
    return [p.decode('utf-8') for p in result.stdout.split(b'\0') if p]


def check(root):
    root = root.resolve()
    findings = []
    checked = 0
    for relative in tracked_files(root):
        path = root / relative
        if not path.exists() and not path.is_symlink():
            findings.append({'file': relative, 'rule': 'tracked-file-missing'})
            continue
        if path.is_symlink():
            findings.append({'file': relative, 'rule': 'symlink-in-release-source'})
            continue
        checked += 1
        name = path.name.lower()
        if (name == '.env' or (name.startswith('.env.') and not name.endswith(('.example', '.sample', '.template')))
                or name in ('credentials.json', 'id_rsa', 'id_ed25519', '.npmrc')
                or path.suffix.lower() in ('.p12', '.pfx', '.sqlite', '.sqlite3', '.db')):
            findings.append({'file': relative, 'rule': 'private-artifact-in-release-source'})
        if path.suffix.lower() in ('.html', '.htm'):
            findings.extend({'file': relative, 'rule': rule} for rule in csp_findings(path.read_text(encoding='utf-8')))
        if name == 'package.json':
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
                has_dependencies = any(data.get(k) for k in ('dependencies', 'devDependencies', 'optionalDependencies'))
                if has_dependencies and not any((path.parent / lock).exists() for lock in ('pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock')):
                    findings.append({'file': relative, 'rule': 'dependency-lock-missing'})
            except (ValueError, UnicodeError):
                findings.append({'file': relative, 'rule': 'manifest-invalid'})
    return {'schema_version': 1, 'tracked_files_checked': checked, 'findings': findings,
            'scope': 'tracked and unignored candidate source files; existing HTML meta CSP pins only',
            'limits': 'Not a secret scanner, penetration test, live-header check or deployment approval.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path, nargs='?', default=Path.cwd())
    args = parser.parse_args()
    try:
        result = check(args.root)
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        print(json.dumps({'error': 'Source could not be checked. Release is blocked.'}))
        return 2
    print(json.dumps(result, indent=2))
    return 1 if result['findings'] else 0


if __name__ == '__main__':
    sys.exit(main())
