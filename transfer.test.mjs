import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash as nodeHash, randomBytes, randomInt } from 'node:crypto';
import { copyPlan, copyOne, MARKER, RECEIPT } from './transfer.js';
import { CHUNK_BYTES, createHash, hashBlob, hex } from './hash.js';
import { fakeRoot, fsError } from './fake-fs.mjs';

const sha = data => nodeHash('sha256').update(data).digest('hex');
function fixture(data = 'Precious original document', { target = 'Files/Documents/original.txt', name = 'New copy', contentHash } = {}) {
  const source = fakeRoot();
  const handle = source.seedFile('Originals/original.txt', data, { lastModified: 123456 });
  const record = { id: 'source-1', path: 'Originals/original.txt', handle, size: handle.size,
    lastModified: handle.lastModified, contentHash: contentHash === undefined ? sha(handle.bytes) : contentHash };
  const entry = { fileId: record.id, targetPath: target, size: record.size,
    sourceLabel: 'Old drive', sourcePath: record.path, lastModified: record.lastModified };
  const destination = fakeRoot();
  return { source, handle, record, entry, destination, jobName: name,
    plan: { entries: [entry] }, files: [record] };
}
const journal = (destination, name) => JSON.parse(destination.lookup(`${name}/${RECEIPT}`).text);
const statusFile = (destination, name) => destination.lookup(`${name}/${MARKER}`);
const assertIncompleteStatus = f => assert.match(statusFile(f.destination, f.jobName).text, /^INCOMPLETE\b/);
const commitStatuses = (destination, name) => destination.fs.events
  .filter(e => e.type === 'commit' && e.path === `${name}/${RECEIPT}`)
  .map(e => JSON.parse(e.text).status);

test('fake writable commits on close; abort discards pending writes and cannot undo a close', async () => {
  const root = fakeRoot(); const file = root.seedFile('kept.txt', 'original');
  let stream = await file.createWritable();
  await stream.write('pending');
  assert.equal(file.text, 'original');
  await stream.abort(); assert.equal(file.text, 'original');
  stream = await file.createWritable(); await stream.write('committed'); await stream.close();
  await stream.abort(); assert.equal(file.text, 'committed');
});

test('copy commits, reads back and finishes only its own persistent status file as the last durable write', async () => {
  const f = fixture(randomBytes(CHUNK_BYTES + 37));
  const untouched = f.destination.seedDirectory('Existing collection');
  const otherMarker = untouched.seedFile(MARKER, 'Keep this marker');
  const events = [];
  const result = await copyPlan({ ...f, onProgress: p => events.push(p) });
  const saved = f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`);
  assert.deepEqual(saved.bytes, f.handle.bytes);
  assert.equal(result.receipt.status, 'complete');
  assert.equal(journal(f.destination, f.jobName).status, 'files-verified');
  assert.match(journal(f.destination, f.jobName).completionNote, /COPY STATUS\.txt/);
  assert.equal(result.receipt.files[0].sha256, sha(f.handle.bytes));
  assert.equal(result.receipt.files[0].verified, true);
  assert.ok(saved.metrics.getFileCalls > 0, 'saved bytes must actually be read back');
  assert.equal(MARKER, 'COPY STATUS.txt');
  assert.match(statusFile(f.destination, f.jobName).text, /^COMPLETE\b/);
  assert.equal(otherMarker.text, 'Keep this marker');
  assert.deepEqual(f.destination.fs.events.filter(e => e.type === 'removeEntry'), []);
  assert.equal(f.destination.fs.events.at(-1).type, 'commit');
  assert.equal(f.destination.fs.events.at(-1).path, `${f.jobName}/${MARKER}`);
  assert.match(f.destination.fs.events.at(-1).text, /^COMPLETE\b/);
  assert.ok(!commitStatuses(f.destination, f.jobName).includes('complete'));
  assert.ok(events.some(e => e.phase === 'checking'));
  assert.ok(events.some(e => e.phase === 'verified' && e.verifiedFiles === 1));
  assert.equal(f.source.fs.events.length, 0, 'source handle receives no writes or removal');
});

test('same-size corruption after commit is detected by readback; abort does not erase the evidence', async () => {
  const f = fixture('a complete original');
  f.destination.fs.hooks.transformCommit = ({ path, bytes }) => {
    if (path === `${f.jobName}/${f.entry.targetPath}`) { const b = bytes.slice(); b[0] ^= 1; return b; }
  };
  await assert.rejects(copyPlan(f), /saved file did not match/i);
  const file = f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`);
  assert.equal(file.size, f.handle.size);
  assert.notDeepEqual(file.bytes, f.handle.bytes);
  assert.equal(file.metrics.commits, 1);
  assert.ok(file.metrics.abortCalls > 0);
  assertIncompleteStatus(f);
  assert.equal(journal(f.destination, f.jobName).status, 'incomplete');
  assert.equal(journal(f.destination, f.jobName).files.length, 0);
  assert.equal(f.handle.text, 'a complete original');
});

test('changed precomputed source hash aborts before committing source bytes', async () => {
  const f = fixture('new bytes', { contentHash: sha('old bytes') });
  await assert.rejects(copyPlan(f), /source contents changed/i);
  const file = f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`);
  assert.equal(file.size, 0);
  assert.equal(file.metrics.commits, 0);
  assert.equal(file.metrics.abortCalls, 1);
  assert.equal(journal(f.destination, f.jobName).status, 'incomplete');
  assertIncompleteStatus(f);
});

for (const baseline of [undefined, null, '', 'a'.repeat(63), '0'.repeat(65), 'g'.repeat(64), 123]) {
  test(`missing or malformed full-scan SHA256 ${JSON.stringify(baseline)} rejects before any copy write`, async () => {
    const f = fixture('baseline required', { contentHash: baseline });
    if (baseline === undefined) delete f.record.contentHash;
    await assert.rejects(copyPlan(f));
    assert.deepEqual(f.destination.fs.events, []);
    const job = f.destination.seedDirectory('direct copy');
    await assert.rejects(copyOne(f.record, f.entry, job));
    assert.deepEqual(f.destination.fs.events, []);
  });
}

for (const field of ['size', 'mtime']) {
  test(`source ${field} changed since scan rejects before creating the data file`, async () => {
    const f = fixture('old');
    f.handle.replace(field === 'size' ? 'longer' : 'old', { lastModified: field === 'mtime' ? f.record.lastModified + 1 : f.record.lastModified });
    await assert.rejects(copyPlan(f), /source changed after scanning/i);
    assert.equal(f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`), undefined);
    assert.equal(journal(f.destination, f.jobName).status, 'incomplete');
    assertIncompleteStatus(f);
  });
}

test('source modification during copy is caught by the final source guard before close', async () => {
  const f = fixture(new Uint8Array(CHUNK_BYTES + 1).fill(7)); let changed = false;
  await assert.rejects(copyPlan({ ...f, onProgress(p) {
    if (p.phase === 'copying' && !changed) { changed = true; f.handle.lastModified++; }
  } }), /source changed after scanning/i);
  const saved = f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`);
  assert.equal(saved.size, 0); assert.equal(saved.metrics.commits, 0);
  assert.equal(saved.metrics.abortCalls, 1);
  assert.equal(journal(f.destination, f.jobName).status, 'incomplete');
});

test('unavailable source leaves a durable incomplete journal and its persistent INCOMPLETE status', async () => {
  const f = fixture(); f.handle.available = false;
  await assert.rejects(copyPlan(f), e => e.name === 'NotFoundError');
  assert.equal(f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`), undefined);
  assert.equal(journal(f.destination, f.jobName).status, 'incomplete');
  assert.equal(journal(f.destination, f.jobName).files.length, 0);
  assertIncompleteStatus(f);
});

test('source drive disappearing after its bytes were read prevents destination commit', async () => {
  const f = fixture();
  f.source.fs.hooks.onGetFile = ({ calls }) => { if (calls === 2) f.handle.available = false; };
  await assert.rejects(copyPlan(f), e => e.name === 'NotFoundError');
  const saved = f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`);
  assert.equal(saved.metrics.commits, 0); assert.equal(saved.metrics.abortCalls, 1);
  assert.equal(saved.size, 0); assert.equal(journal(f.destination, f.jobName).status, 'incomplete');
  assertIncompleteStatus(f);
});

test('copying from a Blob fallback reads and writes only bounded chunks', async () => {
  const f = fixture(randomBytes(CHUNK_BYTES * 2 + 31));
  const blob = new Blob([f.handle.bytes]); const slices = []; const writes = [];
  f.record.file = { size: blob.size, lastModified: f.record.lastModified,
    arrayBuffer() { throw new Error('Whole-source allocation is forbidden'); },
    slice(start, end) { slices.push([start, end]); assert.ok(end - start <= CHUNK_BYTES); return blob.slice(start, end); } };
  delete f.record.handle;
  f.destination.fs.hooks.onWrite = ({ path, bytes }) => {
    if (path === `${f.jobName}/${f.entry.targetPath}`) writes.push(bytes.length);
  };
  const result = await copyPlan(f);
  assert.deepEqual(slices, [[0, CHUNK_BYTES], [CHUNK_BYTES, CHUNK_BYTES * 2], [CHUNK_BYTES * 2, blob.size]]);
  assert.deepEqual(writes, [CHUNK_BYTES, CHUNK_BYTES, 31]);
  assert.equal(result.receipt.files[0].sha256, sha(f.handle.bytes));
});

test('an existing destination file is never opened for writing or truncated', async () => {
  const f = fixture('incoming'); const job = f.destination.seedDirectory(f.jobName);
  const existing = job.seedFile(f.entry.targetPath, 'irreplaceable existing data');
  await assert.rejects(copyOne(f.record, f.entry, job), /destination already exists/i);
  assert.equal(existing.text, 'irreplaceable existing data');
  assert.equal(existing.metrics.createWritableCalls, 0);
  assert.equal(existing.metrics.commits, 0);
});

for (const kind of ['file', 'directory']) {
  test(`a duplicate job name occupied by a ${kind} causes no writes or marker removals`, async () => {
    const f = fixture();
    const existing = kind === 'directory' ? f.destination.seedDirectory(f.jobName) : f.destination.seedFile(f.jobName, 'not a job');
    const oldMarker = kind === 'directory' ? existing.seedFile(MARKER, 'previous unfinished job') : null;
    await assert.rejects(copyPlan(f), /folder already exists/i);
    assert.deepEqual(f.destination.fs.events, []);
    if (oldMarker) assert.equal(oldMarker.text, 'previous unfinished job');
    else assert.equal(existing.text, 'not a job');
  });
}

test('cancel mid-copy aborts the uncommitted stream, keeps originals and keeps an INCOMPLETE status after stopping', async () => {
  const f = fixture(new Uint8Array(CHUNK_BYTES + 19).fill(3)); const controller = new AbortController();
  await assert.rejects(copyPlan({ ...f, signal: controller.signal, onProgress(p) {
    if (p.phase === 'copying') controller.abort();
  } }), e => e.name === 'AbortError');
  const saved = f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`);
  assert.equal(saved.metrics.commits, 0); assert.equal(saved.size, 0);
  assert.equal(saved.metrics.abortCalls, 1);
  assert.equal(journal(f.destination, f.jobName).status, 'stopped');
  assertIncompleteStatus(f);
  assert.equal(f.handle.size, CHUNK_BYTES + 19);
  assert.deepEqual(f.destination.fs.events.filter(e => e.type === 'removeEntry'), []);
});

test('pre-cancelled copy creates no job or status files', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(copyPlan({ ...f, signal: controller.signal }), e => e.name === 'AbortError');
  assert.deepEqual(f.destination.fs.events, []);
});

test('empty files close and verify with the standard empty SHA256', async () => {
  const f = fixture(new Uint8Array());
  const { receipt } = await copyPlan(f);
  const saved = f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`);
  assert.equal(saved.size, 0); assert.equal(saved.metrics.commits, 1);
  assert.ok(saved.metrics.getFileCalls > 0);
  assert.equal(receipt.files[0].sha256, sha(new Uint8Array()));
  assert.equal(receipt.plannedBytes, 0); assert.equal(receipt.status, 'complete');
});

test('blocked destination data writer does not claim success or remove any status file', async () => {
  const f = fixture();
  f.destination.fs.hooks.onCreateWritable = ({ path }) => {
    if (path === `${f.jobName}/${f.entry.targetPath}`) throw fsError('NotAllowedError', 'Read-only destination');
  };
  await assert.rejects(copyPlan(f), e => e.name === 'NotAllowedError');
  assertIncompleteStatus(f);
  assert.equal(journal(f.destination, f.jobName).status, 'incomplete');
  assert.ok(!commitStatuses(f.destination, f.jobName).includes('complete'));
  assert.deepEqual(f.destination.fs.events.filter(e => e.type === 'removeEntry'), []);
});

test('destination filling mid-stream aborts pending data and leaves the journal incomplete', async () => {
  const f = fixture(new Uint8Array(CHUNK_BYTES + 9).fill(9));
  f.destination.fs.hooks.onWrite = ({ path, writeCalls }) => {
    if (path === `${f.jobName}/${f.entry.targetPath}` && writeCalls === 2) throw fsError('QuotaExceededError', 'Drive full');
  };
  await assert.rejects(copyPlan(f), e => e.name === 'QuotaExceededError');
  const saved = f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`);
  assert.equal(saved.metrics.abortCalls, 1); assert.equal(saved.metrics.commits, 0);
  assert.equal(saved.size, 0);
  assert.equal(journal(f.destination, f.jobName).status, 'incomplete');
  assertIncompleteStatus(f);
});

test('close failure does not commit data or report the file as verified', async () => {
  const f = fixture();
  f.destination.fs.hooks.onClose = ({ path }) => {
    if (path === `${f.jobName}/${f.entry.targetPath}`) throw fsError('QuotaExceededError', 'Could not commit file');
  };
  await assert.rejects(copyPlan(f), e => e.name === 'QuotaExceededError');
  const saved = f.destination.lookup(`${f.jobName}/${f.entry.targetPath}`);
  assert.equal(saved.metrics.commits, 0); assert.equal(saved.metrics.abortCalls, 1); assert.equal(saved.size, 0);
  assert.equal(journal(f.destination, f.jobName).files.length, 0);
  assertIncompleteStatus(f);
});

test('a later failed readback keeps only previously verified files in the incomplete journal', async () => {
  const f = fixture('first'); const second = f.source.seedFile('Originals/second.txt', 'second', { lastModified: 98765 });
  const record = { id: 'source-2', path: 'Originals/second.txt', handle: second, size: second.size, lastModified: second.lastModified, contentHash: sha(second.bytes) };
  f.files.push(record);
  f.plan.entries.push({ fileId: record.id, targetPath: 'Files/Documents/second.txt', size: record.size, sourceLabel: 'Old drive', sourcePath: record.path });
  f.destination.fs.hooks.transformCommit = ({ path, bytes }) => {
    if (path.endsWith('/second.txt')) { const b = bytes.slice(); b[0] ^= 1; return b; }
  };
  await assert.rejects(copyPlan(f), /saved file did not match/i);
  const r = journal(f.destination, f.jobName);
  assert.equal(r.status, 'incomplete'); assert.equal(r.files.length, 1);
  assert.equal(r.files[0].fileId, 'source-1'); assert.equal(r.files[0].sha256, sha('first'));
  assertIncompleteStatus(f);
});

test('a late navigation failure plus journal rollback failure never persists a complete journal', async () => {
  const f = fixture(); let finalWriteFailed = false;
  f.destination.fs.hooks.onWrite = ({ path }) => {
    if (path === `${f.jobName}/START HERE.html`) { finalWriteFailed = true; throw fsError('QuotaExceededError', 'Full during index write'); }
    if (finalWriteFailed && path === `${f.jobName}/${RECEIPT}`) throw fsError('QuotaExceededError', 'Still full during rollback');
  };
  await assert.rejects(copyPlan(f), e => e.name === 'QuotaExceededError');
  assertIncompleteStatus(f);
  assert.notEqual(journal(f.destination, f.jobName).status, 'complete');
  assert.ok(!commitStatuses(f.destination, f.jobName).includes('complete'));
});

test('final COMPLETE status write failure preserves prior INCOMPLETE even if its rollback also fails', async () => {
  const f = fixture(); let failed = false;
  f.destination.fs.hooks.onWrite = ({ path, value }) => {
    if (path === `${f.jobName}/${MARKER}` && (/^COMPLETE\b/.test(value) || failed)) {
      failed = true; throw fsError('QuotaExceededError', 'Status update cannot commit');
    }
  };
  await assert.rejects(copyPlan(f), e => e.name === 'QuotaExceededError');
  assertIncompleteStatus(f);
  assert.equal(statusFile(f.destination, f.jobName).metrics.commits, 1);
  assert.notEqual(journal(f.destination, f.jobName).status, 'complete');
  assert.ok(!commitStatuses(f.destination, f.jobName).includes('complete'));
  assert.deepEqual(f.destination.fs.events.filter(e => e.type === 'removeEntry'), []);
});

test('final COMPLETE status close failure retains prior INCOMPLETE even if rollback close fails', async () => {
  const f = fixture(); let failed = false;
  f.destination.fs.hooks.onClose = ({ path, bytes }) => {
    if (path === `${f.jobName}/${MARKER}` && (/^COMPLETE\b/.test(new TextDecoder().decode(bytes)) || failed)) {
      failed = true; throw fsError('QuotaExceededError', 'Status close failed');
    }
  };
  await assert.rejects(copyPlan(f), e => e.name === 'QuotaExceededError');
  assertIncompleteStatus(f);
  assert.equal(statusFile(f.destination, f.jobName).metrics.commits, 1);
  assert.notEqual(journal(f.destination, f.jobName).status, 'complete');
  assert.ok(!commitStatuses(f.destination, f.jobName).includes('complete'));
  assert.deepEqual(f.destination.fs.events.filter(e => e.type === 'removeEntry'), []);
});

test('success requires no removeEntry capability and keeps a persistent COMPLETE status', async () => {
  const f = fixture();
  f.destination.fs.hooks.onRemove = () => { throw fsError('NoModificationAllowedError', 'Removal is forbidden'); };
  const { receipt } = await copyPlan(f);
  assert.equal(receipt.status, 'complete');
  assert.match(statusFile(f.destination, f.jobName).text, /^COMPLETE\b/);
  assert.equal(journal(f.destination, f.jobName).status, 'files-verified');
  assert.deepEqual(f.destination.fs.events.filter(e => e.type === 'removeEntry'), []);
});

test('untrusted context cannot override receipt completion, counts or file results', async () => {
  const f = fixture('new bytes', { contentHash: sha('old bytes') });
  const context = { status: 'complete', files: [{ verified: true }], plannedFiles: 0, jobName: 'wrong folder' };
  await assert.rejects(copyPlan({ ...f, context }), /source contents changed/i);
  const r = journal(f.destination, f.jobName);
  assert.equal(r.status, 'incomplete'); assert.equal(r.plannedFiles, 1); assert.equal(r.jobName, f.jobName);
  assert.deepEqual(r.files, []); assert.deepEqual(r.context, context);
});

for (const filename of ['START HERE.html', 'READ ME FIRST.txt', MARKER, RECEIPT]) {
  test(`a source file called ${filename} is retained unchanged inside Files`, async () => {
    const f = fixture('Actual user file, not generated navigation', { target: `Files/Documents/${filename}` });
    const { receipt } = await copyPlan(f);
    assert.equal(f.destination.lookup(`${f.jobName}/Files/Documents/${filename}`).text, f.handle.text);
    assert.equal(receipt.files[0].sha256, sha(f.handle.bytes));
    assert.equal(receipt.status, 'complete');
  });
}

for (const target of ['START HERE.html', RECEIPT, 'outside.txt', 'Files', '../escape.txt', '/Files/a.txt', 'Files/../escape.txt', 'Files/a/../../escape.txt', 'Files//a.txt', 'Files/a\\b.txt', 'Files/a\0b.txt']) {
  test(`unsafe or control-root target ${JSON.stringify(target)} is rejected before any job writes`, async () => {
    const f = fixture('do not write', { target });
    await assert.rejects(copyPlan(f));
    assert.deepEqual(f.destination.fs.events, []);
    assert.equal(f.destination.children.size, 0);
  });
}

for (const name of ['', '.', '..', '../escape', 'one/two', 'one\\two', 'one\0two']) {
  test(`invalid job name ${JSON.stringify(name)} cannot create any destination entries`, async () => {
    const f = fixture('original', { name });
    await assert.rejects(copyPlan(f));
    assert.deepEqual(f.destination.fs.events, []);
  });
}

test('hashBlob matches node:crypto over chunk boundaries without whole-blob arrayBuffer', async () => {
  const data = randomBytes(CHUNK_BYTES * 2 + 23); const blob = new Blob([data]); const slices = []; const progress = [];
  const wrapper = { size: blob.size, arrayBuffer() { throw new Error('Whole-file allocation is forbidden'); },
    slice(start, end) { slices.push([start, end]); assert.ok(end - start <= CHUNK_BYTES); return blob.slice(start, end); } };
  assert.equal(await hashBlob(wrapper, { onProgress: (done, total) => progress.push([done, total]) }), sha(data));
  assert.deepEqual(slices, [[0, CHUNK_BYTES], [CHUNK_BYTES, CHUNK_BYTES * 2], [CHUNK_BYTES * 2, data.length]]);
  assert.deepEqual(progress.at(-1), [data.length, data.length]);
});

test('incremental SHA256 matches node:crypto with random partitions and compression-block boundaries', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1024, 4097, 65537]) {
    const data = randomBytes(length); const h = createHash(); let offset = 0;
    h.update(new Uint8Array());
    while (offset < length) {
      const size = randomInt(1, Math.min(257, length - offset) + 1);
      h.update(data.subarray(offset, offset + size)); offset += size;
    }
    assert.equal(hex(h.digest()), sha(data), `length ${length}`);
  }
});

test('hashBlob detects a short read instead of returning a misleading digest', async () => {
  const short = { size: 17, slice() { return new Blob([new Uint8Array(16)]); } };
  await assert.rejects(hashBlob(short), /could not be fully read/i);
});

test('hash cancellation makes no extra chunk reads', async () => {
  const controller = new AbortController(); let slices = 0;
  const file = { size: CHUNK_BYTES * 2 + 1, slice(start, end) { slices++; return new Blob([new Uint8Array(end - start)]); } };
  await assert.rejects(hashBlob(file, { signal: controller.signal, onProgress() { controller.abort(); } }), e => e.name === 'AbortError');
  assert.equal(slices, 1);
});

test('a synthetic file larger than 4 GiB preserves total-byte precision using only one bounded chunk', async () => {
  const controller = new AbortController(); const size = 2 ** 32 + 123; const slices = []; const progress = [];
  const synthetic = { size, slice(start, end) {
    slices.push([start, end]); assert.ok(end - start <= CHUNK_BYTES); return new Blob([new Uint8Array(end - start)]);
  } };
  await assert.rejects(hashBlob(synthetic, { signal: controller.signal, onProgress(done, total) {
    progress.push([done, total]); controller.abort();
  } }), e => e.name === 'AbortError');
  assert.deepEqual(progress, [[CHUNK_BYTES, size]]);
  assert.deepEqual(slices, [[0, CHUNK_BYTES]]);
});

test('streamed SHA256 across 512 MiB plus one byte matches node:crypto past the 32-bit bit counter', { timeout: 30_000 }, async () => {
  const size = 512 * 1024 * 1024 + 1;
  const block = new Uint8Array(CHUNK_BYTES);
  for (let i = 0; i < block.length; i++) block[i] = i % 251;
  const expected = nodeHash('sha256'); let readBytes = 0; let requests = 0; let maxSlice = 0;
  const generated = { size, slice(start, end) {
    assert.equal(start, readBytes);
    const length = end - start;
    assert.ok(length <= CHUNK_BYTES); maxSlice = Math.max(maxSlice, length); requests++;
    return { async arrayBuffer() {
      expected.update(block.subarray(0, length)); readBytes += length;
      return length === block.length ? block.buffer : block.buffer.slice(0, length);
    } };
  } };
  const result = await hashBlob(generated);
  assert.equal(result, expected.digest('hex'));
  assert.equal(readBytes, size); assert.equal(requests, 129); assert.equal(maxSlice, CHUNK_BYTES);
});
