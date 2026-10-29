// Planning only. This module never reads, hashes, copies, or deletes a file.
const encoder = new TextEncoder();
const COMPONENT_LIMIT = 240;
const PATH_LIMIT = 900;
const MIN_SHORT_COMPONENT = 16;
const buckets = ['Music', 'Documents', 'Pictures', 'Videos', 'Archives', 'Other files', 'Folders kept together'];
const playlistExtensions = new Set(['m3u', 'm3u8', 'pls', 'cue', 'wpl', 'xspf', 'asx', 'zpl', 'itl']);
const projectExtensions = new Set(['cwp', 'cwb', 'wrk', 'bun', 'cwt', 'cwx', 'logic', 'logicx', 'band', 'rpp', 'rpp-bak', 'als', 'flp', 'ptx', 'pts', 'sesx', 'aup', 'aup3', 'omf', 'aaf', 'veg', 'prproj', 'drp', 'fcpxml', 'fcpbundle']);
const webExtensions = new Set(['html', 'htm', 'xhtml', 'mht', 'mhtml']);
const audioExtensions = new Set(['mp3', 'm4a', 'm4b', 'm4p', 'aac', 'flac', 'wav', 'wave', 'aif', 'aiff', 'ogg', 'opus', 'wma', 'mid', 'midi', 'smf']);
const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'heic', 'heif', 'webp', 'bmp', 'avif', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng']);
const videoExtensions = new Set(['mp4', 'm4v', 'mov', 'avi', 'mkv', 'wmv', 'mpeg', 'mpg', 'mts', 'm2ts', 'webm', '3gp']);
const documentExtensions = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'tsv', 'pages', 'numbers', 'key', 'epub', 'md']);
const archiveExtensions = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg', 'vhd', 'vhdx']);

const bytes = value => encoder.encode(value).length;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fold = value => value.normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
const extension = value => {
  const name = String(value).split('/').pop();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
const sourceId = file => String(file.sourceId ?? '');
const fullHash = file => typeof file.contentHash === 'string' && /^[a-f0-9]{64}$/i.test(file.contentHash) ? file.contentHash.toLowerCase() : null;

export function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = n === 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  const unit = Math.max(0, index);
  return `${(n / 1000 ** unit).toLocaleString('en-US', {maximumFractionDigits: unit ? 2 : 0})} ${units[unit]}`;
}

export function skipReason(path, isDirectory = false) {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].normalize('NFC').toLowerCase();
    const directory = i < parts.length - 1 || isDirectory;
    if (directory && new Set(['.spotlight-v100', '.fseventsd', '.trashes', '.temporaryitems', '.documentrevisions-v100', '.pkinstallsandboxmanager', 'system volume information', '$recycle.bin']).has(part)) {
      return 'Operating-system metadata or recovery folder; leave it in place.';
    }
    if (directory && ['windows', 'program files', 'program files (x86)', '$windows.~bt', '$windows.~ws'].includes(part)) return 'Installed operating-system or application folder; leave it in place.';
    if (directory && (part === 'windowsimagebackup' || part === 'backups.backupdb' || part.endsWith('.backupbundle') || /^com\.apple\.timemachine\./.test(part) || /^\d{4}-\d{2}-\d{2}-\d{6}\.backup$/.test(part))) {
      return 'System backup; use its backup or recovery software rather than reorganizing it.';
    }
    if (directory && /\.(app|framework|appex|plugin|bundle|component|vst|vst3|aaxplugin)$/.test(part)) return 'Mac application package; moving its individual files can break the application.';
    if (directory && /\.(logicx|band|fcpbundle|fcpxbundle|sparsebundle)$/.test(part)) return 'Project or disk package; keep it intact with its original application or backup tools.';
    if (directory && /\.(photoslibrary|photolibrary|migratedphotolibrary|aplibrary)$/.test(part)) return 'Photo-library package; use the photo application to back it up or move it.';
    if (directory && /\.(musiclibrary|migratedmusiclibrary)$/.test(part)) return 'Music-library package; use the music application to back it up or move it.';
    if (!directory && new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'desktop.ini']).has(part)) return 'Operating-system display/cache metadata; not a personal-file collection.';
    if (!directory && part.startsWith('._')) return 'Mac extra-file information; this first version copies ordinary file contents only.';
    if (!directory && /\.(vhd|vhdx|vmdk|qcow|qcow2|sparseimage)$/.test(part)) return 'Disk-backup image; opening and recovering it is outside this first version.';
  }
  return null;
}

export function getDuplicateGroups(files) {
  const groups = new Map();
  const seen = new Set();
  for (const file of files) {
    const hash = fullHash(file);
    if (file.error || !hash || !Number.isSafeInteger(file.size) || file.size < 0) continue;
    const record = JSON.stringify([file.sourceId, file.id ?? file.path]);
    if (seen.has(record)) continue;
    seen.add(record);
    const key = `${file.size}:${hash}`;
    if (!groups.has(key)) groups.set(key, {contentHash: hash, size: file.size, files: []});
    groups.get(key).files.push(file);
  }
  return [...groups.values()].filter(group => group.files.length > 1)
    .map(group => ({...group, files: [...group.files].sort((a, b) => compare(JSON.stringify([a.sourceId, a.id]), JSON.stringify([b.sourceId, b.id])))}))
    .sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1) || compare(a.contentHash, b.contentHash));
}

export function getContextWarnings(files) {
  const found = new Map();
  for (const file of files) {
    const id = sourceId(file);
    if (!id) continue;
    if (!found.has(id)) found.set(id, new Set());
    const reasons = found.get(id);
    const path = String(file.path || file.name || '');
    const parts = [String(file.sourceRootName || file.sourceLabel || ''), ...path.split('/')];
    if (parts.some(part => playlistExtensions.has(extension(part)))) reasons.add('Playlists or cue sheets may refer to other folders. Keep this source together.');
    if (parts.some(part => projectExtensions.has(extension(part)))) reasons.add('Project files may depend on audio, images, or other assets elsewhere in the source. Keep this source together.');
    if (parts.some(part => webExtensions.has(extension(part)) || /(?:_files|\.files)$/i.test(part))) reasons.add('Saved web pages and companion folders may depend on one another. Keep this source together.');
  }
  const result = Object.create(null);
  for (const [id, reasons] of [...found].sort(([a], [b]) => compare(a, b))) if (reasons.size) result[id] = [...reasons].sort(compare);
  return result;
}

// This suffix identifies a name collision, not the contents of a file.
function nameTag(value) {
  let n = 2166136261;
  for (const char of value) {
    n ^= char.codePointAt(0);
    n = Math.imul(n, 16777619);
  }
  return (n >>> 0).toString(16).padStart(8, '0');
}

function takeBytes(value, limit) {
  let out = '';
  for (const char of value) {
    if (bytes(out + char) > limit) break;
    out += char;
  }
  return out;
}

function safeName(raw, limit, suffix = '', file = false) {
  let name = String(raw).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = raw === '..' ? 'Parent folder' : 'Unnamed';
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  let ext = '';
  if (file) {
    const dot = name.lastIndexOf('.');
    if (dot > 0 && bytes(name.slice(dot)) <= 24) {
      ext = name.slice(dot);
      name = name.slice(0, dot);
    }
  }
  const tail = suffix + ext;
  const head = takeBytes(name, Math.max(1, limit - bytes(tail))).replace(/[. ]+$/g, '') || '_';
  return head + tail;
}

function assignNames(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const key = fold(safeName(node.raw, node.limit, '', node.kind === 'file'));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const used = new Set();
  for (const node of [...nodes].sort((a, b) => compare(a.key, b.key))) {
    const base = safeName(node.raw, node.limit, '', node.kind === 'file');
    let suffix = groups.get(fold(base)).length > 1 ? `--${nameTag(node.key)}` : '';
    let name = safeName(node.raw, node.limit, suffix, node.kind === 'file');
    let attempt = 1;
    while (used.has(fold(name))) {
      suffix = `--${nameTag(node.key)}-${++attempt}`;
      name = safeName(node.raw, node.limit, suffix, node.kind === 'file');
    }
    node.name = name;
    used.add(fold(name));
  }
}

function collectionForFolder(raw) {
  const key = fold(raw).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (['music', 'all mp3', 'allmp3', 'music and audio', 'audio', 'songs'].includes(key)) return 'Music';
  if (['documents', 'document', 'my documents', 'docs'].includes(key)) return 'Documents';
  if (['pictures', 'my pictures', 'photos', 'photographs'].includes(key)) return 'Pictures';
  if (['videos', 'my videos', 'movies', 'photos and videos'].includes(key)) return 'Videos';
  if (['archives', 'compressed files'].includes(key)) return 'Archives';
  return null;
}

function collectionForFile(name) {
  const ext = extension(name);
  if (audioExtensions.has(ext)) return 'Music';
  if (imageExtensions.has(ext)) return 'Pictures';
  if (videoExtensions.has(ext)) return 'Videos';
  if (documentExtensions.has(ext)) return 'Documents';
  if (archiveExtensions.has(ext)) return 'Archives';
  return 'Other files';
}

export function buildPlan(files, {layout = 'keep', excludedIds = []} = {}) {
  if (!Array.isArray(files) || !Array.isArray(excludedIds)) throw new TypeError('Files and excluded IDs must be arrays.');
  if (!['keep', 'collections'].includes(layout)) throw new TypeError('Choose keep or collections layout.');
  const excluded = new Set(excludedIds);
  const warnings = [];
  const sources = new Map();
  const ids = new Set();
  const records = [];
  let errors = 0, protectedFiles = 0, missingHashes = 0, pathsAdjusted = false;
  for (const file of files) {
    if (file.id === null || file.id === undefined || file.id === '') throw new TypeError('Every file needs a unique ID.');
    if (ids.has(file.id)) throw new TypeError('File IDs must be unique.');
    ids.add(file.id);
    const id = sourceId(file);
    if (!id) throw new TypeError('Every file needs a source ID.');
    const label = String(file.sourceLabel || 'Source');
    if (!sources.has(id)) sources.set(id, {id, labels: new Set(), kind: 'directory', key: `source:${JSON.stringify(id)}`, limit: COMPONENT_LIMIT});
    sources.get(id).labels.add(label);
    if (file.error || !Number.isSafeInteger(file.size) || file.size < 0) {
      if (!excluded.has(file.id)) errors++;
      continue;
    }
    let path = String(file.path || file.name || 'Unnamed file');
    if (path.endsWith('/') && file.name) path += file.name;
    const parts = path.split('/').filter(part => part !== '');
    if (!parts.length) parts.push(String(file.name || 'Unnamed file'));
    const protectedReason = skipReason(path, false) || skipReason(`${file.sourceRootName || label}/${path}`, false);
    if (protectedReason) {
      if (!excluded.has(file.id)) protectedFiles++;
      continue;
    }
    if (!excluded.has(file.id) && !fullHash(file)) missingHashes++;
    if (path.startsWith('/') || parts.some(part => part === '.' || part === '..')) pathsAdjusted = true;
    records.push({file, id, path, parts});
  }
  const sourceNodes = [...sources.values()];
  for (const source of sourceNodes) source.raw = [...source.labels].sort(compare)[0];
  assignNames(sourceNodes);
  const contexts = getContextWarnings(files);
  const root = {key: 'root', children: new Map(), parent: null};
  function child(parent, localKey, raw, kind = 'directory', role = 'original') {
    if (!parent.children.has(localKey)) parent.children.set(localKey, {key: `${parent.key}\0${localKey}`, raw, kind, role, limit: COMPONENT_LIMIT, parent, children: new Map()});
    return parent.children.get(localKey);
  }
  const prefix = child(root, 'fixed:Files', 'Files', 'directory', 'fixed');
  for (const record of records) {
    const source = sources.get(record.id);
    let parent = prefix;
    if (layout === 'collections') {
      const rootCollection = collectionForFolder(source.raw);
      const bucket = rootCollection || (contexts[record.id] ? 'Folders kept together' : record.parts.length > 1 ? collectionForFolder(record.parts[0]) || 'Folders kept together' : collectionForFile(record.parts[0]));
      parent = child(parent, `bucket:${bucket}`, bucket, 'directory', 'fixed');
    }
    parent = child(parent, `source:${JSON.stringify(record.id)}`, source.name, 'directory', 'source');
    for (let i = 0; i < record.parts.length - 1; i++) parent = child(parent, `dir:${JSON.stringify(record.parts[i])}`, record.parts[i]);
    record.node = child(parent, `file:${JSON.stringify(record.file.id)}`, record.parts.at(-1), 'file');
  }
  function assignTree(node) {
    assignNames([...node.children.values()]);
    for (const next of node.children.values()) assignTree(next);
  }
  function chain(node) {
    const list = [];
    for (let n = node; n.parent; n = n.parent) list.unshift(n);
    return list;
  }
  // Preserve directory levels. Shorten a source wrapper first, then long original names.
  for (let pass = 0; ; pass++) {
    assignTree(root);
    const long = records.filter(record => bytes(chain(record.node).map(n => n.name).join('/')) > PATH_LIMIT);
    if (!long.length) break;
    if (pass > 2000) throw new RangeError('This folder tree is too deep to create a portable copy plan. Choose a shallower source.');
    for (const record of long) {
      const nodes = chain(record.node);
      const excess = bytes(nodes.map(n => n.name).join('/')) - PATH_LIMIT;
      const candidates = nodes.filter(n => n.role !== 'fixed' && bytes(n.name) > MIN_SHORT_COMPONENT)
        .sort((a, b) => (a.role === 'source' ? -1 : 0) - (b.role === 'source' ? -1 : 0) || bytes(b.name) - bytes(a.name) || compare(a.key, b.key));
      if (!candidates.length) throw new RangeError('This folder tree is too deep to preserve safely. Choose a shallower source.');
      const node = candidates[0];
      node.limit = Math.max(MIN_SHORT_COMPONENT, Math.min(node.limit - 1, bytes(node.name) - excess));
    }
  }
  const plannedSources = new Set(records.filter(r => !excluded.has(r.file.id)).map(r => r.id));
  for (const source of sourceNodes) {
    if (!plannedSources.has(source.id)) continue;
    if (contexts[source.id]) {
      for (const reason of contexts[source.id]) warnings.push(`${source.name}: ${reason}`);
      if (records.some(r => r.id === source.id && excluded.has(r.file.id))) warnings.push(`${source.name}: excluded files could leave a project, playlist, or saved web page incomplete.`);
    }
    if (source.labels.size > 1) warnings.push(`${source.name}: inconsistent source labels were resolved to one source folder.`);
  }
  if (errors) warnings.push(`${errors} file(s) with read errors or invalid sizes are not in the plan.`);
  if (protectedFiles) warnings.push(`${protectedFiles} protected system/package file(s) are not in the plan; leave them in place.`);
  if (missingHashes) warnings.push(`${missingHashes} file(s) still need their contents checked before a copy can begin.`);
  for (const record of records) for (const node of chain(record.node)) if (node.role !== 'fixed' && node.name !== node.raw) pathsAdjusted = true;
  if (sourceNodes.some(source => source.name !== source.raw)) pathsAdjusted = true;
  if (pathsAdjusted) warnings.push('Some names were adjusted for portability or collisions. Review the original-to-copy mapping; projects or playlists may need relinking if an internal name changed.');
  const entries = records.filter(record => !excluded.has(record.file.id)).map(record => ({
    fileId: record.file.id, sourceId: record.file.sourceId, sourceLabel: sources.get(record.id).name,
    sourcePath: record.path, targetPath: chain(record.node).map(node => node.name).join('/'),
    size: record.file.size, lastModified: record.file.lastModified, contentHash: fullHash(record.file)
  })).sort((a, b) => compare(fold(a.targetPath), fold(b.targetPath)) || compare(JSON.stringify(a.fileId), JSON.stringify(b.fileId)));
  if (new Set(entries.map(entry => fold(entry.targetPath))).size !== entries.length) throw new Error('Copy paths are not unique.');
  return {entries, warnings: [...new Set(warnings)]};
}
