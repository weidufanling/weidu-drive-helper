/** In-memory File System Access handles. Nothing here accesses a real filesystem. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function fsError(name, message = name) {
  return new DOMException(message, name);
}

function bytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new TypeError('Unsupported fake writable payload');
}

function nameCheck(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\/\0]/.test(name)) {
    throw new TypeError('Invalid File System Access entry name');
  }
}

class FakeWritable {
  constructor(handle, { keepExistingData = false } = {}) {
    this.handle = handle;
    this.state = 'writable';
    this.chunks = keepExistingData ? [handle.bytes] : [];
    this.allStrings = !keepExistingData;
  }

  async write(value) {
    if (this.state !== 'writable') throw fsError('InvalidStateError');
    const block = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : bytes(value);
    this.handle.metrics.writeCalls++;
    this.handle.fs.events.push({ type: 'write', path: this.handle.path, bytes: block.length,
      text: typeof value === 'string' ? value : undefined });
    await this.handle.fs.hooks.onWrite?.({ handle: this.handle, stream: this, value,
      bytes: block, writeCalls: this.handle.metrics.writeCalls, path: this.handle.path });
    this.chunks.push(block);
    this.allStrings &&= typeof value === 'string';
  }

  async close() {
    if (this.state !== 'writable') throw fsError('InvalidStateError');
    this.handle.metrics.closeCalls++;
    const data = new Uint8Array(this.chunks.reduce((n, b) => n + b.length, 0));
    let offset = 0;
    for (const block of this.chunks) { data.set(block, offset); offset += block.length; }
    await this.handle.fs.hooks.onClose?.({ handle: this.handle, stream: this, bytes: data,
      path: this.handle.path });
    const transformed = await this.handle.fs.hooks.transformCommit?.({ handle: this.handle,
      bytes: data, path: this.handle.path });
    this.handle._bytes = bytes(transformed ?? data);
    this.handle.lastModified = this.handle.fs.tick();
    this.handle.metrics.commits++;
    this.handle.fs.events.push({ type: 'commit', path: this.handle.path,
      bytes: this.handle._bytes.length, text: this.allStrings ? decoder.decode(this.handle._bytes) : undefined });
    this.chunks = [];
    this.state = 'closed';
  }

  async abort() {
    this.handle.metrics.abortCalls++;
    this.handle.fs.events.push({ type: 'abort', path: this.handle.path, state: this.state });
    // Like a writable stream, abort cannot undo a close which already committed.
    if (this.state === 'closed' || this.state === 'aborted') return;
    this.chunks = [];
    this.state = 'aborted';
  }
}

export class FakeFileHandle {
  kind = 'file';
  constructor(name, parent, data = new Uint8Array(), lastModified = 1000) {
    this.name = name;
    this.parent = parent;
    this.fs = parent.fs;
    this._bytes = bytes(data);
    this.lastModified = lastModified;
    this.available = true;
    this.metrics = { getFileCalls: 0, createWritableCalls: 0, writeCalls: 0, closeCalls: 0, commits: 0, abortCalls: 0 };
  }
  get path() { return this.parent.path ? `${this.parent.path}/${this.name}` : this.name; }
  get size() { return this._bytes.length; }
  get bytes() { return this._bytes.slice(); }
  get text() { return decoder.decode(this._bytes); }
  replace(data, { lastModified = this.lastModified + 1 } = {}) {
    this._bytes = bytes(data);
    this.lastModified = lastModified;
  }
  async getFile() {
    this.metrics.getFileCalls++;
    if (!this.available) throw fsError('NotFoundError', 'The source drive is unavailable.');
    await this.fs.hooks.onGetFile?.({ handle: this, path: this.path, calls: this.metrics.getFileCalls });
    if (!this.available) throw fsError('NotFoundError', 'The source drive is unavailable.');
    return new File([this._bytes], this.name, { lastModified: this.lastModified });
  }
  async createWritable(options) {
    this.metrics.createWritableCalls++;
    this.fs.events.push({ type: 'createWritable', path: this.path });
    await this.fs.hooks.onCreateWritable?.({ handle: this, path: this.path });
    return new FakeWritable(this, options);
  }
}

export class FakeDirectoryHandle {
  kind = 'directory';
  constructor(name = '', parent = null, fs = null) {
    this.name = name;
    this.parent = parent;
    this.fs = fs ?? parent?.fs ?? { hooks: {}, events: [], clock: 10_000, tick() { return ++this.clock; } };
    this.children = new Map();
  }
  get path() { return this.parent?.path ? `${this.parent.path}/${this.name}` : this.name; }
  seedDirectory(path) {
    const parts = path.split('/');
    let parent = this;
    for (const name of parts) {
      nameCheck(name);
      if (!parent.children.has(name)) parent.children.set(name, new FakeDirectoryHandle(name, parent));
      parent = parent.children.get(name);
      if (parent.kind !== 'directory') throw fsError('TypeMismatchError');
    }
    return parent;
  }
  seedFile(path, data = '', { lastModified = 1000 } = {}) {
    const parts = path.split('/');
    const name = parts.pop(); nameCheck(name);
    const parent = parts.length ? this.seedDirectory(parts.join('/')) : this;
    if (parent.children.has(name)) throw new Error('Seed collision');
    const file = new FakeFileHandle(name, parent, data, lastModified);
    parent.children.set(name, file);
    return file;
  }
  lookup(path) {
    let entry = this;
    for (const part of path.split('/')) entry = entry?.children?.get(part);
    return entry;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    nameCheck(name);
    let entry = this.children.get(name);
    if (entry && entry.kind !== 'directory') throw fsError('TypeMismatchError');
    if (!entry && !create) throw fsError('NotFoundError');
    if (!entry) {
      await this.fs.hooks.onCreateDirectory?.({ parent: this, name, path: this.path ? `${this.path}/${name}` : name });
      entry = this.children.get(name) ?? new FakeDirectoryHandle(name, this);
      this.children.set(name, entry);
      this.fs.events.push({ type: 'createDirectory', path: entry.path });
    }
    return entry;
  }
  async getFileHandle(name, { create = false } = {}) {
    nameCheck(name);
    let entry = this.children.get(name);
    if (entry && entry.kind !== 'file') throw fsError('TypeMismatchError');
    if (!entry && !create) throw fsError('NotFoundError');
    if (!entry) {
      await this.fs.hooks.onCreateFile?.({ parent: this, name, path: this.path ? `${this.path}/${name}` : name });
      entry = this.children.get(name) ?? new FakeFileHandle(name, this, new Uint8Array(), this.fs.tick());
      this.children.set(name, entry);
      this.fs.events.push({ type: 'createFile', path: entry.path });
    }
    return entry;
  }
  async removeEntry(name, { recursive = false } = {}) {
    nameCheck(name);
    const entry = this.children.get(name);
    if (!entry) throw fsError('NotFoundError');
    if (entry.kind === 'directory' && entry.children.size && !recursive) throw fsError('InvalidModificationError');
    await this.fs.hooks.onRemove?.({ parent: this, entry, name, path: entry.path });
    this.fs.events.push({ type: 'removeEntry', path: entry.path, recursive });
    this.children.delete(name);
  }
  async *entries() { yield* this.children.entries(); }
  async *values() { yield* this.children.values(); }
  async isSameEntry(other) { return this === other; }
}

export function fakeRoot({ hooks = {} } = {}) {
  const root = new FakeDirectoryHandle();
  root.fs.hooks = hooks;
  return root;
}
