# Weidu Drive Helper 0.1.0

A free, local browser tool for understanding ordinary folders, finding files with identical contents and making an organised, verified copy. Source files stay in place.

## Use it

Open the published HTML page, or unzip the offline download and open **Drive Helper.html** in a recent desktop Chrome, Edge or Opera browser. Choose **Try an example first** for eight small synthetic files.

1. Add ordinary folders from one or more drives. Give each collection a recognisable name.
2. Scan the folders and read the skipped-items list.
3. Run the contents check. Every eligible file is hashed locally, in bounded chunks.
4. Review matching-content groups. Choose which copies to include in the new collection. All are included by default; related project/page/playlist contexts stay together.
5. Review the folder layout and complete original-to-new file list.
6. Choose a writable destination and explicitly approve the reviewed plan. The helper creates a new unique folder, copies the planned files and reads them back to compare their contents.

When finished, open **START HERE.html** in the new folder to browse the saved files. **COPY STATUS.txt** says COMPLETE only after files, reports and the index have been saved. The JSON report records original locations, dates, selected omissions, skipped items and SHA-256 values. Its `files-verified` state records checked data; COPY STATUS.txt is the separate overall completion authority.

Browsers without folder-saving support can scan selections and download reports. Capability is detected at runtime. A browser's inability to select a whole protected drive can be handled by choosing ordinary folders inside it.

## First-version limits

- Up to 50,000 eligible files and 100,000 visited directory entries per scan. No whole-file buffering; hash/copy reads use at most 4 MiB slices.
- Ordinary readable files on working drives. App/photo/music-library packages, installed system folders, selected project packages, OS metadata and known virtual-disk backup images are skipped and reported.
- A matching file means matching full SHA-256 and byte length. Similar pictures, changed documents and different song mixes remain separate. File contents alone do not establish that an intentional backup is expendable.
- Files are copied into a new collection. Original sources are never moved, renamed or deleted. Omitting a matching entry affects only the new copy.
- Content and directory names are preserved where portable. Unsafe names, platform collisions and overlong names receive explicit mapped names shown in the plan. Internal links can need relinking after a name adjustment.
- Original modification dates are recorded in reports. The browser cannot reproduce all filesystem dates, permissions, Finder tags, alternate streams or resource forks. Empty directories are not copied. This is not a replacement for native whole-computer backup software.
- Keep the tab open. A stopped or failed job stays marked INCOMPLETE and retains its evidence. Retrying starts a new folder; automatic resume is outside 0.1.0.
- No deleted-file recovery, failing-drive repair, or Windows backup-image import in this version.
- Reported repeated-content bytes are not a promise of physical space reclaimed from snapshots, clones or other filesystem features.

## Privacy

The app has no server-side file handling, account, analytics, API key or remote AI service. Source files and reports are held in this tab until the person explicitly saves a report or makes a copy. There is no application database or service worker. The self-contained page bundles its hashing code; `connect-src 'none'` blocks runtime network connections. The two optional navigation links lead back to Weidu and carry no file data. The website host receives the ordinary initial page/download request.

Only generated examples were used for development and public screenshots. No personal inventory from the drive-recovery conversation is included in the application or downloads.

## Development

Use Node.js 24+ and pnpm. Install the pinned dependencies, run `pnpm test` and `pnpm build`. The build produces two identical self-contained HTML pages under `dist/`. Open the page through a local HTTP server for browser development. `engine.js` plans paths without file access; `scan.js` reads selected collections; `hash.js` and its worker perform incremental SHA-256; `transfer.js` implements the checked-copy transaction; `app.js` manages review and consent.

The local core tests exercise path collisions, source changes, corrupt readbacks, full/blocked destinations, cancellation and completion ordering. Browser evidence includes a real selected-folder copy in Opera, independent readback, origin-private filesystem fault tests, and two 520 MiB file inputs. See the retained release verification records for test evidence. Temporary test fixtures are outside the public release packages.

## Acknowledgements

Incremental SHA-256 uses **@noble/hashes 2.4.0**, by Paul Miller and contributors, under the MIT License. Its full licence is distributed with both downloads and acknowledged in the app. esbuild is a build-time dependency. See the pinned lockfile.

First release: 26 October 2026. Weidu Fanling.
