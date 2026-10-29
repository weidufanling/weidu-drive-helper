import { hashBlob } from './hash.js';
self.onmessage = async ({ data }) => {
  const { id, file } = data;
  try {
    let last = 0;
    const digest = await hashBlob(file, { onProgress(done, total) {
      if (performance.now() - last > 100 || done === total) {
        self.postMessage({ id, progress: done, total }); last = performance.now();
      }
    }});
    self.postMessage({ id, digest });
  } catch (error) { self.postMessage({ id, error: String(error.message || error) }); }
};
