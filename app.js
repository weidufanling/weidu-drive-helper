import { formatBytes, getDuplicateGroups, getContextWarnings, buildPlan, skipReason } from './engine.js';
import { scanSources, sourceFile } from './scan.js';
import { hashBlob } from './hash.js';
import { copyPlan } from './transfer.js';

const $ = id => document.getElementById(id);
const state = { sources: [], files: [], skipped: [], errors: [], context: {}, excluded: new Set(), stage: 1,
  scanned: false, hashDone: false, busy: false, example: false, filePage: 0, groupPage: 0, planPage: 0,
  plan: null, destination: null, jobName: '', controller: null, result: null };
const canSave = typeof window.showDirectoryPicker === 'function' && window.isSecureContext;
let sourceCounter = 0, hashCounter = 0, worker = null, pending = null;
const workerURL = typeof Worker === 'function' ? URL.createObjectURL(new Blob([__WEIDU_WORKER__], { type: 'text/javascript' })) : null;

function node(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) element[key] = value;
    else if (key in element) element[key] = value;
    else element.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) element.append(child?.nodeType ? child : document.createTextNode(String(child)));
  return element;
}
function replace(id, ...children) { $(id).replaceChildren(...children.flat().filter(child => child !== null && child !== undefined)); }
function notify(message, error = false) {
  $('notice').hidden = !message; $('notice').textContent = message;
  $('notice').className = `notice${error ? ' error' : ''}`;
  $('notice').setAttribute('role', error ? 'alert' : 'status');
}
function setProgress(title, detail = '', fraction = null) {
  $('operation-title').textContent = title; $('progress-detail').textContent = detail;
  if (fraction === null) $('progress').removeAttribute('value');
  else $('progress').value = Math.max(0, Math.min(100, fraction * 100));
}
function newJobName() {
  const date = new Date().toISOString().slice(0, 10);
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), n => n.toString(16).padStart(2, '0')).join('');
  return `Weidu organised files - ${date} - ${random}`;
}
function invalidatePlan() {
  state.plan = null; state.jobName = ''; $('reviewed').checked = false;
}
function invalidateScan() {
  state.files = []; state.skipped = []; state.errors = []; state.context = {};
  state.scanned = false; state.hashDone = false; state.excluded.clear(); state.stage = 1;
  state.destination = null; invalidatePlan();
}
function focusStep() {
  const panel = $(state.stage === 4 ? 'result' : `step-${state.stage}`);
  const heading = panel?.querySelector('h2');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  panel?.scrollIntoView({ behavior: 'auto', block: 'start' });
}
function setStep(stage) { if (state.busy) return; if (state.stage === 4 && stage === 3) { reviewPlan(); return; } state.stage = stage; render(); focusStep(); }
function checkWorker() {
  if (worker) return worker;
  worker = new Worker(workerURL);
  worker.onmessage = ({ data }) => {
    if (!pending || data.id !== pending.id) return;
    if ('progress' in data) pending.onProgress(data.progress, data.total);
    else { const job = pending; pending = null; job.cleanup(); data.error ? job.reject(new Error(data.error)) : job.resolve(data.digest); }
  };
  worker.onerror = event => {
    if (!pending) return;
    const job = pending; pending = null; job.cleanup();
    worker.terminate(); worker = null; job.reject(new Error(event.message || 'The local file check stopped.'));
  };
  return worker;
}
async function hashFile(file, { signal, onProgress = () => {} } = {}) {
  if (!workerURL) return hashBlob(file, { signal, onProgress });
  let local;
  try { local = checkWorker(); } catch { return hashBlob(file, { signal, onProgress }); }
  if (pending) throw new Error('Another file check is already running.');
  if (signal?.aborted) throw new DOMException('Stopped at your request.', 'AbortError');
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (!pending || pending.id !== id) return;
      pending = null; local.terminate(); worker = null; cleanup();
      reject(new DOMException('Stopped at your request.', 'AbortError'));
    };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const id = ++hashCounter;
    pending = { id, resolve, reject, cleanup, onProgress };
    signal?.addEventListener('abort', abort, { once: true });
    try { local.postMessage({ id, file }); }
    catch (error) { pending = null; cleanup(); reject(error); }
  });
}
async function runTask(title, operation) {
  if (state.busy) return;
  const originalStage = state.stage;
  state.busy = true; state.controller = new AbortController(); $('operation').hidden = false;
  setProgress(title); notify('');
  const disabled = new Map();
  document.querySelectorAll('button,input,select').forEach(control => {
    if (control.id !== 'stop' && control.id !== 'dialog-close') { disabled.set(control, control.disabled); control.disabled = true; }
  });
  try { await operation(state.controller.signal); }
  catch (error) { notify(error.name === 'AbortError' ? 'Stopped at your request. Your original files remain available.' : String(error.message || error), error.name !== 'AbortError'); }
  finally {
    state.busy = false; state.controller = null; $('operation').hidden = true;
    disabled.forEach((value, control) => { control.disabled = value; });
    render();
    if (state.stage !== originalStage) focusStep();
  }
}
function sourceLabel(name) {
  let label = name, n = 1;
  while (state.sources.some(s => s.label.toLocaleLowerCase() === label.toLocaleLowerCase())) label = `${name} (${++n})`;
  return label;
}
async function addFolder() {
  if (state.busy) return;
  if (!canSave) { $('folder-input').click(); return; }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read', id: 'weidu-source' });
    for (const source of state.sources) {
      if (!source.handle) continue;
      if (await source.handle.isSameEntry(handle)) { notify('That folder is already selected.'); return; }
      if (await source.handle.resolve(handle) !== null || await handle.resolve(source.handle) !== null) {
        notify('These folders overlap. Choose the larger folder once, or choose separate folders.'); return;
      }
    }
    state.sources.push({ id: `s${++sourceCounter}`, label: sourceLabel(handle.name), originalName: handle.name, handle });
    state.example = false; invalidateScan(); render();
  } catch (error) { if (error.name !== 'AbortError') notify('The browser could not open that folder. Try an ordinary folder inside the drive, or choose individual files.', true); }
}
function addFileSelection(fileList, isFolder) {
  if (state.busy || !fileList.length) return;
  if (fileList.length > 50000) { notify('Choose a smaller folder. This first version handles up to 50,000 files at a time.', true); return; }
  const first = fileList[0];
  const originalName = isFolder ? (first.webkitRelativePath.split('/')[0] || 'Selected folder') : 'Selected files';
  const records = Array.from(fileList, file => ({ path: isFolder ? file.webkitRelativePath.split('/').slice(1).join('/') || file.name : file.name, file }));
  if (new Set(records.map(record => record.path)).size !== records.length) { notify('Some chosen files share the same name and no folder locations were supplied. Choose their folders separately so each keeps its location.', true); return; }
  const signature = records.map(r => `${r.path}\0${r.file.size}\0${r.file.lastModified}`).sort().join('\n');
  const possibleOverlap = state.sources.some(s => s.signature === signature);
  state.sources.push({ id: `s${++sourceCounter}`, label: sourceLabel(originalName), originalName, records, signature });
  state.example = false; invalidateScan(); render();
  if (possibleOverlap) notify('These selections have the same names, sizes and dates. They may overlap, or be separate copies. Review their collection names before treating them as different locations.');
}
function loadExample() {
  if (state.busy) return;
  if (state.sources.length && !window.confirm('Replace the selection with example folders? Your original files will remain available.')) return;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#d8e3d6"/><circle cx="300" cy="65" r="30" fill="#efc67c"/><path d="M0 240 150 80 300 240" fill="#607b67"/><text x="20" y="220" fill="#102331">Synthetic example picture</text></svg>';
  const recipes = [
    ['Old laptop', [['Documents/Soup recipe.txt', 'Tomato soup: tomatoes, onion, water. This is an example.'], ['Photos/Garden.svg', svg], ['Music/Set list.txt', 'Opening tune\nSecond tune\nEncore\n'], ['Letters/Letter.txt', 'First draft of an example letter.']]],
    ['USB drive', [['Documents/Soup recipe copy.txt', 'Tomato soup: tomatoes, onion, water. This is an example.'], ['Pictures/Garden again.svg', svg], ['Music/Set list.txt', 'Opening tune\nSecond tune\nEncore\n'], ['Letters/Letter.txt', 'Other draft of an example letter.']]]
  ];
  state.sources = recipes.map(([label, rows]) => ({ id: `s${++sourceCounter}`, label, originalName: label,
    records: rows.map(([path, text]) => ({ path, file: new File([text], path.split('/').at(-1), { lastModified: Date.UTC(2020, 3, 5), type: path.endsWith('.svg') ? 'image/svg+xml' : 'text/plain' }) })) }));
  invalidateScan(); state.example = true; render(); notify('Example folders loaded. These small synthetic files are safe to scan and try copying.');
}
async function scan() {
  if (!state.sources.length) return;
  await runTask('Looking through the selected folders', async signal => {
    invalidateScan();
    const result = await scanSources(state.sources, { signal, onProgress(count, bytes) { setProgress('Looking through the selected folders', `${count.toLocaleString()} files found · ${formatBytes(bytes)}`); } });
    state.files = result.files; state.skipped = result.skipped; state.errors = result.errors;
    state.context = getContextWarnings(state.files); state.excluded.clear(); state.scanned = true; state.hashDone = false;
    state.stage = 2; state.filePage = state.groupPage = 0; invalidatePlan();
    notify(`${state.files.length.toLocaleString()} files found${state.example ? ' in the example folders' : ''}. Review the list and check for matching contents.`);
  });
}
async function findDuplicates() {
  if (!state.scanned) return;
  await runTask('Checking the selected files', async signal => {
    state.hashDone = false; state.excluded.clear(); invalidatePlan();
    for (const file of state.files) { file.contentHash = null; file.error = null; }
    const targets = state.files.filter(file => !file.error);
    const totalBytes = targets.reduce((n, f) => n + f.size, 0); let completed = 0;
    for (let i = 0; i < targets.length; i++) {
      const record = targets[i];
      try {
        const file = await sourceFile(record);
        const digest = await hashFile(file, { signal, onProgress(done) {
          setProgress(`Checking file ${i + 1} of ${targets.length}`, `${record.sourceLabel}/${record.path}\n${formatBytes(completed + done)} of ${formatBytes(totalBytes)} read`, totalBytes ? (completed + done) / totalBytes : i / targets.length);
        }});
        await sourceFile(record); record.contentHash = digest;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        record.contentHash = null; record.error = String(error.message || error);
      }
      completed += record.size;
    }
    state.hashDone = true; state.groupPage = 0; invalidatePlan();
    const groups = getDuplicateGroups(state.files);
    notify(groups.length ? `${groups.length.toLocaleString()} ${groups.length === 1 ? 'group has' : 'groups have'} identical file contents. Choose what belongs in the new copy; your originals stay available.` : 'No identical file contents were found among the files that could be checked.');
  });
}
function groups() { return getDuplicateGroups(state.files); }
function protectedFile(file) { return Boolean(state.context[file.sourceId]?.length); }
function toggleKeep(file, keep, group) {
  if (state.busy || protectedFile(file)) return;
  if (keep) state.excluded.delete(file.id); else state.excluded.add(file.id);
  if (group.files.every(f => state.excluded.has(f.id))) { state.excluded.delete(file.id); notify('Keep at least one copy from this group in the new collection.'); }
  invalidatePlan(); render();
}
function keepOne(group) {
  if (state.busy || group.files.some(protectedFile)) return;
  const chosen = group.files.find(f => !state.excluded.has(f.id)) || group.files[0];
  for (const file of group.files) file.id === chosen.id ? state.excluded.delete(file.id) : state.excluded.add(file.id);
  invalidatePlan(); render();
}
function reviewPlan() {
  if (!state.scanned || !state.hashDone || state.busy) return;
  try {
    state.plan = buildPlan(state.files.filter(f => !f.error), { layout: $('layout').value, excludedIds: [...state.excluded] });
    state.jobName = newJobName(); state.planPage = 0; $('reviewed').checked = false; state.stage = 3; render(); focusStep();
  } catch (error) { notify(error.message, true); }
}
async function chooseDestination() {
  if (state.busy || !canSave) return;
  try {
    const chosen = await window.showDirectoryPicker({ mode: 'readwrite', id: 'weidu-destination' });
    const reason = skipReason(chosen.name, true);
    if (reason) { notify('Choose an ordinary destination folder outside app libraries and system backups.', true); return; }
    state.destination = chosen; $('reviewed').checked = false; render();
  }
  catch (error) { if (error.name !== 'AbortError') notify('The destination could not be opened for saving. Choose a writable folder on a connected drive.', true); }
}
async function createCopy() {
  if (!state.plan || !state.destination || !$('reviewed').checked || !state.plan.entries.length || state.busy) return;
  const frozenPlan = state.plan, destination = state.destination, jobName = state.jobName;
  await runTask('Creating the checked copy', async signal => {
    let last = 0;
    try {
      const result = await copyPlan({ destination, jobName, plan: frozenPlan, files: state.files,
        context: { layout: $('layout').value, skipped: state.skipped, readErrors: state.errors,
          unreadableFiles: state.files.filter(f => f.error).map(fileRecord), omittedFromCopy: state.files.filter(f => state.excluded.has(f.id)).map(fileRecord), example: state.example },
        signal, hashFile, onProgress(progress) {
          if (performance.now() - last < 100 && progress.phase !== 'verified') return;
          last = performance.now();
          const percent = (progress.completeBytes + (progress.phase === 'copying' ? progress.done / 2 : progress.phase === 'checking' ? progress.total / 2 + progress.done / 2 : 0)) / progress.plannedBytes;
          setProgress(progress.phase === 'checking' ? 'Checking the saved copy' : 'Creating the checked copy',
            `${progress.entry.sourceLabel}/${progress.entry.sourcePath}\n${progress.verifiedFiles.toLocaleString()} of ${progress.plannedFiles.toLocaleString()} files checked · ${formatBytes(progress.completeBytes)} complete`, progress.plannedBytes ? percent : progress.verifiedFiles / progress.plannedFiles);
        }});
      state.result = result.receipt; state.stage = 4;
      $('reviewed').checked = false;
      notify('The new collection is complete. Every saved file passed its contents check.');
    } catch (error) {
      if (error.receipt) { state.result = error.receipt; state.stage = 4; $('reviewed').checked = false; }
      throw error;
    }
  });
}

function renderSources() {
  replace('sources', state.sources.map(source => node('div', { className: 'source' },
    node('div', {}, node('label', {}, 'A name for this collection', node('input', { value: source.label, maxLength: 70, 'aria-label': `Name for ${source.originalName}`, onchange(event) {
      if (state.busy) return;
      source.label = event.target.value.trim() || source.originalName;
      for (const file of state.files) if (file.sourceId === source.id) file.sourceLabel = source.label;
      invalidatePlan(); render();
    }})), node('p', { className: 'small' }, `${state.example ? 'Example folder' : source.handle ? 'Selected folder' : 'Browser file selection'}: ${source.originalName}`)),
    node('button', { className: 'quiet', disabled: state.busy, 'aria-label': `Remove ${source.label} from selection`, onclick() { state.sources = state.sources.filter(s => s.id !== source.id); invalidateScan(); render(); } }, 'Remove'))));
  $('scan').disabled = !state.sources.length || state.busy;
  $('clear').hidden = !state.sources.length;
}
function stat(value, label) { return node('div', { className: 'stat' }, node('strong', {}, value), node('span', {}, label)); }
function renderMatches() {
  const all = groups(), dataBytes = state.files.reduce((n, f) => n + f.size, 0);
  replace('stats', stat(state.files.length.toLocaleString(), 'files found'), stat(formatBytes(dataBytes), 'file contents'), stat(state.hashDone ? all.length.toLocaleString() : 'To check', 'matching-content groups'));
  $('find-duplicates').disabled = !state.files.length || state.busy;
  $('review-plan').disabled = !state.hashDone || !state.files.some(f => !f.error) || state.busy;
  const issues = [...state.skipped, ...state.errors, ...state.files.filter(f => f.error).map(f => ({ source: f.sourceLabel, path: f.path, reason: f.error }))];
  $('scan-issues').hidden = !issues.length; $('scan-issues-title').textContent = `${issues.length.toLocaleString()} skipped or unavailable items`;
  replace('scan-issues-list', issues.slice(0, 100).map(item => node('p', { className: 'issue' }, `${item.source}/${item.path}`, node('br'), node('span', { className: 'small' }, item.reason))), issues.length > 100 ? node('p', { className: 'small' }, 'The full list is included in the saved scan report.') : null);
  const omitted = state.files.filter(f => state.excluded.has(f.id));
  replace('duplicate-summary', node('p', { className: 'small' }, !state.hashDone ? 'Complete the contents check before reviewing a copy plan. You can save the folder scan as a report at any time.' : all.length ? 'Identical contents can still have a place in separate backups or collections. Review their locations before omitting a copy.' : 'No identical contents found among checked files.'),
    omitted.length ? node('p', { className: 'plan-warning' }, `${omitted.length} duplicate entries will be left out of the new copy, saving ${formatBytes(omitted.reduce((n, f) => n + f.size, 0))} of repeated contents there. Originals stay in place.`) : null);
  const pages = Math.max(1, Math.ceil(all.length / 4)); state.groupPage = Math.min(state.groupPage, pages - 1);
  replace('duplicates', all.slice(state.groupPage * 4, (state.groupPage + 1) * 4).map((group, i) => {
    const card = node('section', { className: 'match-group' });
    const protectedGroup = group.files.some(protectedFile);
    const head = node('div', { className: 'match-head' }, node('div', {}, node('h3', {}, `${group.files.length} files with the same contents`), node('p', { className: 'small' }, `${formatBytes(group.size)} each · Checked all the way through`)), node('button', { disabled: protectedGroup || group.size === 0 || state.busy, onclick: () => keepOne(group) }, 'Use one copy'));
    card.append(head);
    if (protectedGroup) card.append(node('p', { className: 'small' }, 'A playlist, project or saved-page relationship was found. Related files stay together in this first version.'));
    if (!group.size) card.append(node('p', { className: 'small' }, 'These files are empty. They can be useful placeholders and take no file-content space.'));
    let showing = 25;
    const members = node('div');
    const expand = node('button', { className: 'quiet', onclick() { showing += 25; drawMembers(); } }, 'Show more locations');
    function drawMembers() {
      members.replaceChildren(...group.files.slice(0, showing).map(file => {
        const checkbox = node('input', { type: 'checkbox', checked: !state.excluded.has(file.id),
          disabled: protectedFile(file) || !group.size || state.busy,
          onchange(event) { toggleKeep(file, event.target.checked, group); },
          'aria-label': `Include ${file.sourceLabel}/${file.path} in the new copy` });
        const caption = node('p', {}, `${file.sourceLabel}/${file.path}`,
          node('small', {}, protectedFile(file) ? 'Kept with its related folder' : 'Include in the new copy'));
        return node('div', { className: 'match-file' }, node('label', {}, checkbox, caption));
      }));
      expand.hidden = showing >= group.files.length;
    }
    drawMembers(); card.append(members, expand, node('button', { className: 'text-button', onclick() { for (const file of group.files) state.excluded.delete(file.id); invalidatePlan(); render(); } }, 'Keep all these copies'));
    return card;
  }));
  $('duplicate-pager').hidden = all.length <= 4; $('duplicate-page').textContent = `${state.groupPage + 1} of ${pages}`;
  $('duplicate-previous').disabled = state.groupPage === 0 || state.busy; $('duplicate-next').disabled = state.groupPage + 1 >= pages || state.busy;
  const previousFilter = $('source-filter').value;
  replace('source-filter', node('option', { value: '' }, 'All collections'), state.sources.map(s => node('option', { value: s.id }, s.label)));
  $('source-filter').value = previousFilter;
  renderFiles();
}
function renderFiles() {
  const query = $('file-search').value.toLocaleLowerCase(), source = $('source-filter').value;
  const rows = state.files.filter(f => (!source || f.sourceId === source) && `${f.sourceLabel}/${f.path}`.toLocaleLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(rows.length / 100)); state.filePage = Math.min(state.filePage, pages - 1);
  replace('file-rows', rows.slice(state.filePage * 100, (state.filePage + 1) * 100).map(f => node('tr', {}, node('td', {}, f.sourceLabel), node('td', {}, f.path), node('td', {}, formatBytes(f.size)), node('td', {}, f.error ? 'Could not check' : f.contentHash ? 'Contents checked' : state.hashDone ? 'Unique file size' : 'Awaiting check'))));
  $('file-count').textContent = `${rows.length.toLocaleString()} selected files${state.example ? ' · synthetic example' : ''}`;
  $('file-page').textContent = `${state.filePage + 1} of ${pages}`;
  $('file-previous').disabled = state.filePage === 0 || state.busy; $('file-next').disabled = state.filePage + 1 >= pages || state.busy;
}
function renderPlan() {
  if (!state.plan) return;
  const { entries, warnings } = state.plan;
  const bytes = entries.reduce((n, f) => n + f.size, 0), omitted = state.excluded.size, inaccessible = state.errors.length + state.files.filter(f => f.error).length;
  replace('plan-summary', node('p', {}, node('strong', {}, `${entries.length.toLocaleString()} ${entries.length === 1 ? 'file' : 'files'} · ${formatBytes(bytes)}`), ` in the new collection. ${omitted ? `${omitted} matching ${omitted === 1 ? 'entry' : 'entries'} omitted. ` : ''}${state.skipped.length ? `${state.skipped.length} skipped items remain at their original locations. ` : ''}${inaccessible ? `${inaccessible} unavailable items will not be included.` : ''}`));
  replace('plan-warnings', warnings.map(text => node('p', { className: 'plan-warning' }, text)), (inaccessible || state.skipped.length) ? node('p', { className: 'plan-warning' }, 'Review the skipped and unavailable items on the previous step before continuing. Their details will be kept in the copy report.') : null);
  const query = $('plan-search').value.toLocaleLowerCase();
  const filtered = entries.filter(e => `${e.sourceLabel}/${e.sourcePath} ${e.targetPath}`.toLocaleLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(filtered.length / 100)); state.planPage = Math.min(state.planPage, pages - 1);
  replace('plan-rows', filtered.slice(state.planPage * 100, (state.planPage + 1) * 100).map(e => node('tr', {}, node('td', {}, `${e.sourceLabel}/${e.sourcePath}`), node('td', {}, e.targetPath), node('td', {}, formatBytes(e.size)))));
  $('plan-page').textContent = `${state.planPage + 1} of ${pages}`; $('plan-previous').disabled = !state.planPage || state.busy; $('plan-next').disabled = state.planPage + 1 >= pages || state.busy;
  $('choose-destination').disabled = !canSave || state.busy;
  $('destination').textContent = state.destination ? `Destination: ${state.destination.name}` : 'No destination chosen.';
  $('job-name').textContent = `New folder: ${state.jobName}`;
  $('save-capability').textContent = canSave ? 'Only the chosen destination folder needs saving permission.' : 'To save an organised copy, open this page in recent desktop Chrome or Edge. You can save the plan and file report here.';
  $('reviewed').disabled = !state.destination || !entries.length || state.busy;
  $('copy').disabled = !canSave || !state.destination || !entries.length || !$('reviewed').checked || state.busy;
}
function renderResult() {
  if (!state.result) return;
  const receipt = state.result, success = receipt.status === 'complete';
  $('result').classList.toggle('failed', !success);
  $('result-eyebrow').textContent = success ? 'SAVED, CHECKED AND READY TO BROWSE' : 'YOUR ORIGINALS REMAIN AVAILABLE';
  $('result-title').textContent = success ? 'Your new collection is ready.' : receipt.status === 'stopped' ? 'The copy was stopped.' : 'This copy did not finish.';
  $('result-description').textContent = success ? `${receipt.files.length.toLocaleString()} files passed their saved-copy checks. Open the new folder on your drive, then START HERE.html to browse them.` : `${receipt.files.length.toLocaleString()} files passed their checks before copying stopped. The destination is marked unfinished. Keep your originals and read the copy report before trying again.`;
  replace('result-details', node('pre', {}, `${receipt.jobName}\n${receipt.status === 'complete' ? 'All planned files verified' : receipt.error || 'Incomplete copy'}\nReport: Weidu copy report.json`));
}
function render() {
  for (let i = 1; i <= 3; i++) $(`step-${i}`).hidden = state.stage !== i;
  $('result').hidden = state.stage !== 4;
  document.querySelectorAll('[data-step]').forEach(button => {
    const step = Number(button.dataset.step);
    button.disabled = state.busy || (step > 1 && !state.scanned) || (step === 3 && !state.plan);
    if (step === Math.min(state.stage, 3)) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
  renderSources(); if (state.scanned) renderMatches(); renderPlan(); renderResult();
}
function fileRecord(file) {
  return { id: file.id, source: file.sourceLabel, originalFolder: file.sourceRootName, path: file.path, bytes: file.size,
    originalModified: new Date(file.lastModified).toISOString(), sha256: file.contentHash || null, error: file.error || null, includedInCopy: !state.excluded.has(file.id) };
}
function report() {
  return { app: 'Weidu Drive Helper', version: '0.1.0', created: new Date().toISOString(), example: state.example,
    scanFinished: state.scanned, duplicateCheckFinished: state.hashDone, files: state.files.map(fileRecord),
    skipped: state.skipped, readErrors: state.errors,
    duplicateGroups: groups().map(g => ({ sha256: g.contentHash, bytesEach: g.size, files: g.files.map(f => f.id) })),
    copyPlan: state.plan ? { ...state.plan, jobName: state.jobName, destinationName: state.destination?.name || null } : null };
}
function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = node('a', { href: url, download: name }); document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function saveReport() { download('Weidu drive scan and plan.json', JSON.stringify(report(), null, 2)); }
function saveCSV() {
  const cell = value => { let s = String(value ?? ''); if (/^[=+@\-\t\r]/.test(s)) s = "'" + s; return `"${s.replaceAll('"', '""')}"`; };
  const header = ['Collection', 'Original path', 'Bytes', 'Original modified date', 'SHA256 where checked', 'Include in new copy', 'New path'];
  const targets = new Map((state.plan?.entries || []).map(e => [e.fileId, e.targetPath]));
  const rows = state.files.map(f => [f.sourceLabel, f.path, f.size, new Date(f.lastModified).toISOString(), f.contentHash || '', !state.excluded.has(f.id), targets.get(f.id) || '']);
  download('Weidu file list.csv', '\ufeff' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
}
function showInfo(title, paragraphs) {
  $('dialog-title').textContent = title; replace('dialog-body', paragraphs.map(text => node('p', {}, text))); $('info-dialog').showModal();
}

$('add-folder').onclick = addFolder; $('add-files').onclick = () => $('file-input').click();
$('folder-input').onchange = event => { addFileSelection(event.target.files, true); event.target.value = ''; };
$('file-input').onchange = event => { addFileSelection(event.target.files, false); event.target.value = ''; };
$('example').onclick = loadExample; $('scan').onclick = scan;
$('clear').onclick = () => { if (state.busy) return; state.sources = []; state.example = false; invalidateScan(); notify('Selection cleared. Your original files remain available.'); render(); };
$('find-duplicates').onclick = findDuplicates; $('review-plan').onclick = reviewPlan;
$('layout').onchange = reviewPlan; $('choose-destination').onclick = chooseDestination; $('copy').onclick = createCopy;
$('reviewed').onchange = renderPlan;
$('stop').onclick = () => { state.controller?.abort(); notify('Stopping after the current file operation. Keep this tab open until the status updates.'); };
$('file-search').oninput = () => { state.filePage = 0; renderFiles(); };
$('source-filter').onchange = () => { state.filePage = 0; renderFiles(); };
$('plan-search').oninput = () => { state.planPage = 0; renderPlan(); };
for (const [prefix, property, redraw] of [['file', 'filePage', renderFiles], ['duplicate', 'groupPage', renderMatches], ['plan', 'planPage', renderPlan]]) {
  $(`${prefix}-previous`).onclick = () => { if (!state.busy) { state[property]--; redraw(); } };
  $(`${prefix}-next`).onclick = () => { if (!state.busy) { state[property]++; redraw(); } };
}
for (const button of document.querySelectorAll('[data-back],[data-step]')) button.onclick = () => setStep(Number(button.dataset.back || button.dataset.step));
for (const id of ['download-scan', 'download-plan']) $(id).onclick = saveReport;
$('download-csv').onclick = saveCSV;
$('download-result').onclick = () => download('Weidu copy report.json', JSON.stringify(state.result, null, 2));
$('back-plan').onclick = () => { reviewPlan(); };
$('privacy-details').onclick = () => showInfo('Privacy and first-version limits', [
  'This helper runs in your browser. It sends no filenames, file contents or scan reports to Weidu. There are no analytics, remote AI calls, accounts or saved browser databases. Opening links to Weidu is your choice.',
  'Your selection is kept in this tab. Reports are saved only when you choose a download or create a copy on your drive. Clearing the selection or closing the tab releases it.',
  'Use ordinary readable folders of documents, photos, videos and music. App libraries, system folders and backup images are skipped. Deleted-file recovery and damaged-drive repair are outside this version.',
  'Matching contents do not mean every copy is expendable. Copies in backups and related folders can be intentional. This version lets you choose what to include in a new collection; your original files stay in place.',
  'Folder saving requires a supporting desktop browser, such as recent Chrome or Edge. Copied dates, permissions and extra filesystem information may differ; original modification dates are recorded in the report. Interrupted copies are marked unfinished and a retry starts a new folder.'
]);
$('third-party').onclick = () => showInfo('Open-source acknowledgements', [
  'The local SHA-256 implementation is @noble/hashes, version 2.4.0, by Paul Miller and contributors, distributed under the MIT License. Its complete licence is included with the downloadable source package.',
  'Copyright (c) 2022 Paul Miller (https://paulmillr.com). Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the Software), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
  'THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.'
]);
$('dialog-close').onclick = () => $('info-dialog').close();
window.addEventListener('beforeunload', event => { if (state.busy && state.stage === 3) { event.preventDefault(); event.returnValue = ''; } });
$('capability').textContent = canSave ? 'Folder scanning and saving are available here. Start with a small folder to get a feel for it.' : 'You can scan folder selections and save reports here. Use recent desktop Chrome or Edge to save an organised copy directly to a drive.';
render();
