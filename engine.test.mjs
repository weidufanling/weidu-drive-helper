import test from 'node:test';
import assert from 'node:assert/strict';
import {formatBytes, skipReason, getDuplicateGroups, getContextWarnings, buildPlan} from './engine.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const file = (id, path, extra = {}) => ({id, sourceId: 'drive', sourceLabel: 'My drive', path, name: path.split('/').at(-1), size: 10, lastModified: 1000, contentHash: A, error: null, ...extra});
const targets = plan => Object.fromEntries(plan.entries.map(entry => [entry.fileId, entry.targetPath]));
const key = path => path.normalize('NFKC').toLowerCase();

test('byte formatting distinguishes zero, ordinary sizes and invalid metadata', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1000), '1 KB');
  assert.equal(formatBytes(1_234_567), '1.23 MB');
  assert.equal(formatBytes(-1), 'Unknown size');
  assert.equal(formatBytes(NaN), 'Unknown size');
});

test('only known protected paths are skipped; ordinary hidden data stays eligible', () => {
  for (const path of ['.DS_Store', 'album/Thumbs.db', 'WindowsImageBackup/PC/disk.vhd', 'Backups.backupdb/Mac/a', 'App.app/Contents/main', 'Photos.photoslibrary/database/a', 'Library.musiclibrary/a']) assert.equal(typeof skipReason(path, false), 'string');
  assert.equal(typeof skipReason('Some.app', true), 'string');
  assert.equal(skipReason('.env', false), null);
  assert.equal(skipReason('.git/config', false), null);
  assert.equal(skipReason('.private/photos/a.jpg', false), null);
  assert.equal(skipReason('music/library.mp3', false), null);
  assert.ok(skipReason('Project.logicx/Alternatives/ProjectData', false));
});

test('same names or sizes never establish a duplicate; errors and partial hashes do not qualify', () => {
  const files = [file('one', 'same.txt'), file('two', 'same.txt', {sourceId: 'other', contentHash: B}), file('bad', 'copy.txt', {error: 'read failed'}), file('partial', 'part.txt', {contentHash: 'a'.repeat(12)})];
  assert.deepEqual(getDuplicateGroups(files), []);
});

test('full hashes group equal content, including zero-byte files, only at equal size', () => {
  const files = [file('a', 'a'), file('b', 'b'), file('wrong-size', 'c', {size: 11}), file('zero1', 'zero', {size: 0, contentHash: emptyHash}), file('zero2', 'zero-copy', {size: 0, contentHash: emptyHash})];
  const groups = getDuplicateGroups(files);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].files.map(f => f.id), ['a', 'b']);
  assert.equal(groups[1].size, 0);
  assert.equal(groups[1].files.length, 2);
  assert.equal(buildPlan(files).entries.length, files.length, 'duplicates are never automatically excluded');
});

test('keep layout preserves safe relative paths below the fixed Files namespace', () => {
  const result = buildPlan([file('song', 'Albums/Artist/song.mp3')]);
  assert.equal(result.entries[0].targetPath, 'Files/My drive/Albums/Artist/song.mp3');
  assert.equal(result.entries[0].sourcePath, 'Albums/Artist/song.mp3');
});

test('duplicate source labels get stable distinct namespaces irrespective of scan order', () => {
  const files = [file('a', 'same.txt', {sourceId: 'one', sourceLabel: 'Documents'}), file('b', 'same.txt', {sourceId: 'two', sourceLabel: 'Documents', contentHash: B})];
  const result = buildPlan(files);
  assert.notEqual(result.entries[0].sourceLabel, result.entries[1].sourceLabel);
  assert.equal(new Set(result.entries.map(e => key(e.targetPath))).size, 2);
  assert.deepEqual(targets(result), targets(buildPlan([...files].reverse())));
});

test('unsafe components, traversal and Windows reserved names cannot escape Files', () => {
  const result = buildPlan([file('unsafe', '../CON.txt'), file('chars', 'folder?/bad:name*.txt'), file('slash', '..\\escape.txt'), file('dot', 'dir./trail. ')], {layout: 'keep'});
  for (const entry of result.entries) {
    assert.ok(entry.targetPath.startsWith('Files/'));
    for (const part of entry.targetPath.split('/')) {
      assert.ok(part && !['.', '..'].includes(part));
      assert.doesNotMatch(part, /[<>:"\\|?*\u0000-\u001f\u007f]/);
      assert.doesNotMatch(part, /[. ]$/);
      assert.doesNotMatch(part, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    }
  }
  assert.ok(result.warnings.some(w => w.includes('mapping')));
});

test('case, Unicode and sanitization collisions are resolved at directory and leaf levels', () => {
  const files = [file('a', 'Album/song.txt'), file('b', 'album/song.txt'), file('c', 'Café/name?.txt'), file('d', 'Cafe\u0301/name*.txt'), file('e', 'same/a?.txt'), file('f', 'same/a*.txt')];
  const plan = buildPlan(files);
  assert.equal(new Set(plan.entries.map(e => key(e.targetPath))).size, files.length);
  assert.notEqual(targets(plan).a.split('/')[2], targets(plan).b.split('/')[2]);
  assert.notEqual(targets(plan).c.split('/')[2], targets(plan).d.split('/')[2]);
  assert.deepEqual(targets(plan), targets(buildPlan([...files].reverse())));
});

test('a file and a differently cased directory never collapse onto one target name', () => {
  const plan = buildPlan([file('leaf', 'Album'), file('child', 'album/song.mp3')]);
  assert.notEqual(targets(plan).leaf, targets(plan).child.split('/').slice(0, -1).join('/'));
});

test('long Unicode names and long trees stay within portable byte budgets without flattening', () => {
  const long = 'é'.repeat(180);
  const files = [file('one', `${long}/${long}/${long}/${long}.txt`), file('two', `${long}/${long}/${long}/${long}different.txt`)];
  const plan = buildPlan(files);
  for (const entry of plan.entries) {
    assert.ok(new TextEncoder().encode(entry.targetPath).length <= 900);
    assert.ok(entry.targetPath.split('/').every(p => new TextEncoder().encode(p).length <= 240));
    assert.equal(entry.targetPath.split('/').length, 6);
  }
  assert.notEqual(targets(plan).one, targets(plan).two);
});

test('collections move entire known roots and top-level collections; unknown trees stay intact', () => {
  const files = [file('cover', 'Music/Artist/cover.jpg'), file('audio', 'Music/Artist/song.mp3'), file('unknown', 'My research/figures/a.png'), file('loose', 'letter.pdf'), file('root-music', 'Artist/track.mp3', {sourceId: 'music-root', sourceLabel: 'Music'})];
  const t = targets(buildPlan(files, {layout: 'collections'}));
  assert.equal(t.cover, 'Files/Music/My drive/Music/Artist/cover.jpg');
  assert.equal(t.audio, 'Files/Music/My drive/Music/Artist/song.mp3');
  assert.equal(t.unknown, 'Files/Folders kept together/My drive/My research/figures/a.png');
  assert.equal(t.loose, 'Files/Documents/My drive/letter.pdf');
  assert.equal(t['root-music'], 'Files/Music/Music/Artist/track.mp3');
});

test('playlists, projects and web companions keep their whole source together', () => {
  for (const special of ['Playlists/list.m3u', 'Projects/song.cwp', 'Pages/saved.html', 'Pages/saved_files/image.png']) {
    const files = [file('special', special), file('audio', 'Elsewhere/audio.wav'), file('photo', 'Pictures/cover.jpg')];
    const warnings = getContextWarnings(files);
    assert.ok(warnings.drive.length > 0);
    const plan = buildPlan(files, {layout: 'collections'});
    const prefixes = plan.entries.map(entry => entry.targetPath.slice(0, -entry.sourcePath.length));
    assert.equal(new Set(prefixes).size, 1);
    assert.ok(plan.warnings.length > 0);
  }
});

test('exclusions affect only exact chosen IDs and do not rename remaining collision targets', () => {
  const files = [file('a', 'A.txt'), file('b', 'a.txt'), file('c', 'other.txt')];
  const all = targets(buildPlan(files));
  const excluded = buildPlan(files, {excludedIds: ['a', 'not-a-file']});
  assert.deepEqual(excluded.entries.map(e => e.fileId).sort(), ['b', 'c']);
  assert.equal(targets(excluded).b, all.b);
  assert.equal(targets(excluded).c, all.c);
});

test('source metadata is never mutated and unsafe or unreadable inputs are explicit', () => {
  const files = [file('normal', '.private/data.txt'), file('bad', 'bad.txt', {error: 'cannot read'}), file('unknown-hash', 'new.txt', {contentHash: null})];
  const before = JSON.stringify(files);
  const result = buildPlan(files);
  assert.equal(JSON.stringify(files), before);
  assert.ok(result.entries.some(e => e.fileId === 'normal'));
  assert.ok(!result.entries.some(e => e.fileId === 'bad'));
  assert.equal(result.entries.find(e => e.fileId === 'unknown-hash').contentHash, null);
  assert.ok(result.warnings.some(w => w.includes('read errors')));
  assert.ok(result.warnings.some(w => /contents.*checked/i.test(w)));
  assert.throws(() => buildPlan([file('same', 'a'), file('same', 'b')]), /unique/);
});
