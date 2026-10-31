# Release security checks

The workflow checks proposed source changes and main-branch updates after an authorised repository update. It does not merge changes or deploy a website. Dependabot can propose weekly dependency updates; those changes still need review. Account settings and live publication remain separate owner decisions.

Before release:

1. Keep a recoverable copy of the current source, deployed artifact, configuration and version identifier. Protect private backups outside public release packages. Test restoration in a separate location and record the result. A copy on the same disk is not an independent backup.
2. Run secret checks, the dependency audit where a lockfile exists, and the project's existing checks. Use synthetic examples. Inspect the complete release file list, including archives and generated files. Automated text scans cannot establish that documents, binary files or archives contain no sensitive information.
3. Review public wording in Australian English and ordinary punctuation. Preserve authorship, consent, privacy notices and service limits. If inline script or stylesheet bytes change, rebuild and verify existing CSP hashes against actual served blocks. Do not broaden the policy to bypass a failure.
4. Test affected controls in a browser and check actual response headers. Follow the shared browser reservation protocol on the owner's computer. An HTTP 200 result is not a functional test.
5. Review the exact source/artifact diff, destination, audience and distribution effects. Obtain the applicable human approval before a live deployment, account setting, credential change, private disclosure, consequential action or public message.
6. After authorised publication, verify the served bytes, security headers and affected controls. Record the release identifier and evidence without credentials or personal information. Retain the previous verified artifact and a tested restoration route. If verification fails, stop further release work and restore the approved previous version when authorised.

## Secret checks

CI checks both the full fetched Git history and current directory with Gitleaks 8.30.1, including archives to a maximum depth of two. Inline allow comments and environment configuration overrides cannot suppress the scan. Each scanner invocation has a two-minute limit. The Linux installer pins the official release archive by SHA-256 before extraction. Checkout has read-only contents permission, complete history and no persisted credential. Scans have no uploaded artifacts and withhold raw findings, including on failure.

For local use, obtain and independently verify the official Gitleaks 8.30.1 binary for your operating system. Then run from the repository root:

```sh
# A shallow clone must first fetch the full public history.
git fetch --unshallow origin
# Omit that command when the clone already has complete history.
bash scripts/security/check-secrets.sh /absolute/path/to/verified/gitleaks
```

A failing scan requires private investigation. Do not paste findings into issues, pull requests, chat or logs. If a credential was published, preserve minimal evidence and prepare containment and rotation with the owner. Removing a file or adding an ignore rule does not revoke a credential or erase Git history.

## Dependency checks

Dependabot proposes GitHub Actions updates. Projects with package dependencies also receive npm update proposals. It does not merge, deploy or grant additional permissions. Review every update and rerun the checks before accepting it.

The dependency audit, where included, reads exact versions from supported lockfiles and queries the public OSV service. It includes build, development, transitive and optional packages recorded in the lock. It installs nothing and sends only package names and versions. A registry outage or unsupported/missing lock fails the check. No reported advisory does not establish that a dependency is safe. Recheck immediately before release, and review updates and provenance separately.

## Repository settings for owner review

Require reviewed changes and successful status checks on the release branch. Keep automatic merging and deployment disabled unless separately reviewed. Private vulnerability reporting, Dependabot alerts, secret scanning and push protection were verified as enabled for this Weidu repository on 31 October 2026. Recheck their actual state before release. Restrict Actions to reviewed actions and read-only defaults. These source files do not change account settings. Keep emergency access and recovery under human control.

To undo this proposal before publication, remove only the added security files and the marked .gitignore additions. Restore a prior reviewed version if it has already been accepted. Do not undo a credential revocation or restore a known exposed secret.
