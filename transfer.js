import { CHUNK_BYTES, createHash, hex, hashBlob, checkCancelled } from './hash.js';

export const MARKER = 'COPY STATUS.txt';
export const RECEIPT = 'Weidu copy report.json';
const fullHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

async function exists(parent, name) {
  try { return await parent.getDirectoryHandle(name); }
  catch (e) { if (e.name !== 'NotFoundError' && e.name !== 'TypeMismatchError') throw e; }
  try { return await parent.getFileHandle(name); }
  catch (e) { if (e.name !== 'NotFoundError' && e.name !== 'TypeMismatchError') throw e; }
  return null;
}
export async function writeOwnedText(parent, name, content, { signal } = {}) {
  checkCancelled(signal);
  const handle = await parent.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try { await stream.write(content); checkCancelled(signal); await stream.close(); }
  catch (error) { try { await stream.abort(); } catch {} throw error; }
}
function components(path) {
  const parts = path.split('/');
  if (!parts.length || parts.some(p => !p || p === '.' || p === '..' || /[\\\0]/.test(p))) throw new Error('Unsafe copy path.');
  return parts;
}
async function freshFile(record) {
  const file = record.handle ? await record.handle.getFile() : record.file;
  if (!file || file.size !== record.size || file.lastModified !== record.lastModified) {
    throw new Error(`The source changed after scanning: ${record.path}. Scan again.`);
  }
  return file;
}
export async function copyOne(record, entry, job, { signal, onProgress = () => {}, hashFile = hashBlob } = {}) {
  checkCancelled(signal);
  if (!fullHash(record.contentHash)) throw new Error('A complete source contents check is required before copying.');
  const file = await freshFile(record);
  const parts = components(entry.targetPath);
  if (parts[0] !== 'Files' || parts.length < 3) throw new Error('Copied data must stay inside the new Files collection.');
  let folder = job;
  for (const name of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(name, { create: true });
  const name = parts.at(-1);
  if (await exists(folder, name)) throw new Error(`A destination already exists: ${entry.targetPath}. Nothing was replaced.`);
  const handle = await folder.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  const hash = createHash(); let done = 0;
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      checkCancelled(signal);
      const n = Math.min(CHUNK_BYTES, file.size - offset);
      const bytes = new Uint8Array(await file.slice(offset, offset + n).arrayBuffer());
      if (bytes.length !== n) throw new Error('The source could not be fully read.');
      hash.update(bytes); await stream.write(bytes); done += bytes.length;
      onProgress({ phase: 'copying', done, total: file.size });
    }
    checkCancelled(signal);
    const sourceHash = hex(hash.digest());
    if (sourceHash !== record.contentHash.toLowerCase()) throw new Error('The source contents changed since duplicate checking. Scan again.');
    await freshFile(record);
    await stream.close();
    checkCancelled(signal);
    const saved = await handle.getFile();
    if (saved.size !== file.size) throw new Error('The saved file has a different size.');
    const savedHash = await hashFile(saved, { signal, onProgress(n, total) { onProgress({ phase: 'checking', done: n, total }); } });
    if (sourceHash !== savedHash) throw new Error('The saved file did not match. The copy is marked incomplete.');
    return { ...entry, sha256: sourceHash, verified: true };
  } catch (error) { try { await stream.abort(); } catch {} throw error; }
}

export async function copyPlan({ destination, jobName, plan, files, context = {}, signal, onProgress = () => {}, hashFile }) {
  components(jobName);
  if (jobName.includes('/')) throw new Error('The job folder needs one name.');
  if (!plan.entries.length) throw new Error('There are no files in this copy plan.');
  const destinations = new Set();
  const records = new Map(files.map(f => [f.id, f]));
  for (const entry of plan.entries) {
    const parts = components(entry.targetPath);
    if (parts[0] !== 'Files' || parts.length < 3) throw new Error('Copied data must stay inside the new Files collection.');
    const key = entry.targetPath.normalize('NFC').toLocaleLowerCase('en-US');
    if (destinations.has(key)) throw new Error('Two planned files would share a destination. Review a new plan.');
    destinations.add(key);
    if (!fullHash(records.get(entry.fileId)?.contentHash)) throw new Error('Check every planned source file before copying.');
  }
  checkCancelled(signal);
  if (await exists(destination, jobName)) throw new Error('That planned folder already exists. Review a new copy plan.');
  const job = await destination.getDirectoryHandle(jobName, { create: true });
  await writeOwnedText(job, MARKER, 'INCOMPLETE\nThis copy has not finished. Keep your original files. Read the Weidu copy report for the files that have passed verification.\n');
  const receipt = { app: 'Weidu Drive Helper', version: '0.1.0', started: new Date().toISOString(), status: 'incomplete',
    jobName, sourceFilesChanged: false, plannedFiles: plan.entries.length, plannedBytes: plan.entries.reduce((n, e) => n + e.size, 0),
    context, completionNote: 'The copy is complete only when COPY STATUS.txt starts with COMPLETE. This report records the files that passed verification.',
    metadataNote: 'File contents and folder names are copied. Original dates are recorded here; copied dates, permissions and other filesystem metadata may differ.', files: [] };
  const saveReceipt = (options = {}) => writeOwnedText(job, RECEIPT, JSON.stringify(receipt, null, 2), options);
  await saveReceipt();
  let completeBytes = 0;
  try {
    for (const entry of plan.entries) {
      checkCancelled(signal);
      const record = records.get(entry.fileId);
      if (!record) throw new Error('A planned source file is missing.');
      const result = await copyOne(record, entry, job, { signal, hashFile, onProgress(progress) {
        onProgress({ ...progress, entry, verifiedFiles: receipt.files.length, completeBytes, plannedFiles: plan.entries.length, plannedBytes: receipt.plannedBytes });
      }});
      receipt.files.push(result); completeBytes += entry.size;
      if (receipt.files.length % 100 === 0) await saveReceipt();
      onProgress({ phase: 'verified', entry, done: entry.size, total: entry.size, verifiedFiles: receipt.files.length,
        completeBytes, plannedFiles: plan.entries.length, plannedBytes: receipt.plannedBytes });
    }
    checkCancelled(signal);
    receipt.status = 'files-verified'; receipt.finished = new Date().toISOString();
    await saveReceipt({ signal });
    await writeOwnedText(job, 'START HERE.html', createIndex(receipt), { signal });
    await writeOwnedText(job, 'READ ME FIRST.txt', `${receipt.files.length} files were copied and checked against the data read from their sources.\nYour original files remain available.\nCheck COPY STATUS.txt: it says COMPLETE only after this job finishes.\nOpen START HERE.html to browse the saved files.\nThe copy report records original dates and content hashes. Copied file dates may show today.\n`, { signal });
    checkCancelled(signal);
    await writeOwnedText(job, MARKER, `COMPLETE\n${receipt.files.length} files copied and checked.\nFinished: ${receipt.finished}\nReport: ${RECEIPT}\nYour original files remain available.\n`, { signal });
    receipt.status = 'complete'; // Only in memory after the final durable status commit.
    return { job, receipt };
  } catch (error) {
    receipt.status = error.name === 'AbortError' ? 'stopped' : 'incomplete';
    receipt.error = String(error.message || error); receipt.finished = new Date().toISOString();
    try { await writeOwnedText(job, MARKER, 'INCOMPLETE\nThis copy did not finish. Keep your originals and read the copy report.\n'); } catch {}
    try { await saveReceipt(); } catch {}
    const wrapped = new Error(receipt.error); wrapped.name = error.name; wrapped.receipt = receipt;
    throw wrapped;
  }
}
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createIndex(receipt) {
  const payload = JSON.stringify(receipt.files.map(f => ({ path: f.targetPath, size: f.size, source: `${f.sourceLabel}/${f.sourcePath}` })))
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your organised files</title><style>body{max-width:1100px;margin:40px auto;padding:0 22px;background:#fffaf0;color:#102331;font:16px/1.5 system-ui}input,button{font:inherit;padding:10px;margin:6px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #d4c5a5;overflow-wrap:anywhere}a{color:#805614}.scroll{overflow:auto}</style><h1>Your organised files</h1><p>${receipt.files.length} files copied and checked. Your originals remain available.</p><p>Folder: ${escape(receipt.jobName)}</p><label>Find a saved file <input id="q" type="search"></label><p id="count"></p><button id="prev">Previous</button><button id="next">Next</button><div class="scroll"><table><thead><tr><th>Saved file</th><th>Original location</th><th>Bytes</th></tr></thead><tbody id="rows"></tbody></table></div><script id="data" type="application/json">${payload}</script><script>const d=JSON.parse(document.getElementById('data').textContent),q=document.getElementById('q'),rows=document.getElementById('rows'),count=document.getElementById('count'),prev=document.getElementById('prev'),next=document.getElementById('next');let page=0;function render(){const a=d.filter(r=>(r.path+' '+r.source).toLowerCase().includes(q.value.toLowerCase())),pages=Math.max(1,Math.ceil(a.length/150));page=Math.max(0,Math.min(page,pages-1));rows.replaceChildren();for(const r of a.slice(page*150,(page+1)*150)){const tr=document.createElement('tr'),td=document.createElement('td'),link=document.createElement('a');link.href=r.path.split('/').map(encodeURIComponent).join('/');link.textContent=r.path;td.append(link);tr.append(td);for(const s of [r.source,r.size.toLocaleString()]){const c=document.createElement('td');c.textContent=s;tr.append(c)}rows.append(tr)}count.textContent=a.length.toLocaleString()+' matches, page '+(page+1)+' of '+pages;prev.disabled=page===0;next.disabled=page+1>=pages}q.oninput=()=>{page=0;render()};prev.onclick=()=>{page--;render()};next.onclick=()=>{page++;render()};render();<\/script></html>`;
}
