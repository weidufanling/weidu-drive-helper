# Weidu Drive Helper

A free browser tool for understanding ordinary folders, reviewing files with identical contents and making a checked copy. Original files stay in place.

[Use Drive Helper at Weidu](https://weidufanling.au/drive-helper/).

## Use it

Start with **Try an example first**, which uses eight small, invented files. For your own folders, scan, check contents, review the complete plan, then explicitly approve a new destination. The tool copies into a new collection and reads back the saved files. Keep your originals and existing backups.

Direct folder saving needs a supporting desktop browser such as Chrome, Edge or Opera. Other browsers may offer scanning and downloadable reports. This is not deleted-file recovery, drive repair or a replacement for whole-computer backup software. Finder tags, permissions, empty folders and some other filesystem information are not reproduced.

The app has no server-side file handling, analytics, account or remote AI service. Source folders and reports stay in the browser until you choose to save them. Hosting still involves ordinary page requests.

## Offline copy

Download `Drive Helper.html` and open it in a supporting browser. It is the same self-contained application as the current live edition. Keep the adjacent hashing licence when sharing an authorised copy.

## Develop and check

Use Node.js 24 or later and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

Open `dist/index.html` in a supporting browser. The source separates path planning, scanning, chunked hashing, checked copying and the interface. The test files use synthetic files and fake filesystems to exercise collisions, source changes, corrupt readbacks, failed destinations, cancellation and completion ordering.

The build creates its output and verification directories in a fresh checkout. Historical browser checks are described in `VERIFICATION.md`; they do not replace testing a later change.

See [the detailed usage and limits](USAGE.md) before working with real folders.

## Files and permission

This repository includes only application source, synthetic tests, build files, release documentation and selected public downloads. It contains no personal drive inventory or private recovery conversation.

Incremental SHA-256 uses @noble/hashes 2.4.0 by Paul Miller and contributors. Keep its included MIT licence and attribution. The original Weidu source is shared for inspection; this release adds no blanket reuse licence to it. See `REUSE.md` and `CONTRIBUTING.md`.

Weidu Fanling. First application edition: 26 October 2026. Source packaging reviewed 29 October 2026.
