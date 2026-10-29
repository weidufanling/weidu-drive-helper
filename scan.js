import { skipReason } from './engine.js';
import { checkCancelled } from './hash.js';

const MAX_FILES = 50000;
export async function scanSources(sources, { signal, onProgress = () => {} } = {}) {
  const files = [], skipped = [], errors = [];
  let visits = 0, byteCount = 0;
  function add(source, path, file, handle) {
    const reason = skipReason(path, false);
    if (reason) { skipped.push({ source: source.label, path, reason }); return; }
    if (files.length >= MAX_FILES) throw Object.assign(new Error('This first version handles up to 50,000 files at a time. Choose smaller folders and scan again.'), { name: 'ScanLimitError' });
    files.push({ id: `${source.id}:${path}`, sourceId: source.id, sourceLabel: source.label, sourceRootName: source.originalName,
      path, name: file.name, size: file.size, lastModified: file.lastModified, file, handle, contentHash: null, error: null });
    byteCount += file.size;
  }
  async function walk(source, directory, prefix = '', depth = 0) {
    checkCancelled(signal);
    if (depth > 64) { errors.push({ source: source.label, path: prefix, reason: 'This folder is too deeply nested to inspect.' }); return; }
    try {
      for await (const handle of directory.values()) {
        checkCancelled(signal);
        if (++visits > 100000) throw Object.assign(new Error('This folder has too many entries for the first version. Choose smaller folders.'), { name: 'ScanLimitError' });
        const path = prefix ? `${prefix}/${handle.name}` : handle.name;
        if (!handle.name || handle.name === '.' || handle.name === '..' || /[\/\\\0]/.test(handle.name)) {
          errors.push({ source: source.label, path, reason: 'An unsafe folder or file name was skipped.' }); continue;
        }
        const reason = skipReason(path, handle.kind === 'directory');
        if (reason) { skipped.push({ source: source.label, path, reason }); continue; }
        try {
          if (handle.kind === 'directory') await walk(source, handle, path, depth + 1);
          else if (handle.kind === 'file') add(source, path, await handle.getFile(), handle);
        } catch (error) {
          if (error.name === 'AbortError' || error.name === 'ScanLimitError') throw error;
          errors.push({ source: source.label, path, reason: error.message || 'Could not read this item.' });
        }
        if (visits % 50 === 0) onProgress(files.length, byteCount);
      }
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'ScanLimitError') throw error;
      errors.push({ source: source.label, path: prefix || '/', reason: error.message || 'Could not open this folder.' });
    }
  }
  for (const source of sources) {
    checkCancelled(signal);
    const rootReason = skipReason(source.originalName || source.label, true);
    if (rootReason) { skipped.push({ source: source.label, path: '/', reason: rootReason }); continue; }
    if (source.handle) await walk(source, source.handle);
    else for (const original of source.records) {
      checkCancelled(signal);
      try {
        const parts = original.path.split('/');
        let reason;
        for (let i = 0; i < parts.length - 1; i++) {
          reason = skipReason(parts.slice(0, i + 1).join('/'), true);
          if (reason) break;
        }
        if (reason) { skipped.push({ source: source.label, path: original.path, reason }); continue; }
        add(source, original.path, original.file, null);
      } catch (error) {
        if (error.name === 'ScanLimitError') throw error;
        errors.push({ source: source.label, path: original.path, reason: error.message });
      }
      if (++visits % 50 === 0) onProgress(files.length, byteCount);
    }
  }
  files.sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel) || a.path.localeCompare(b.path));
  return { files, skipped, errors };
}

export async function sourceFile(record) {
  const file = record.handle ? await record.handle.getFile() : record.file;
  if (file.size !== record.size || file.lastModified !== record.lastModified) throw new Error('This file changed after selection. Choose its folder again and rescan.');
  return file;
}
