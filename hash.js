import { sha256 } from '@noble/hashes/sha2.js';

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const createHash = () => sha256.create();
export function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Stopped at your request.', 'AbortError');
}
export async function hashBlob(file, { signal, onProgress = () => {} } = {}) {
  const hash = createHash();
  let done = 0;
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    checkCancelled(signal);
    const expected = Math.min(CHUNK_BYTES, file.size - offset);
    const bytes = new Uint8Array(await file.slice(offset, offset + expected).arrayBuffer());
    if (bytes.length !== expected) throw new Error('A file changed or could not be fully read. Scan it again.');
    hash.update(bytes); done += bytes.length; onProgress(done, file.size);
  }
  checkCancelled(signal);
  return hex(hash.digest());
}
