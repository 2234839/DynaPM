/**
 * DynaPM Serverless Host - Frontend Application
 * CodeMirror 6 based IDE with function management
 */

const API = '';
let cmEditor = null;
let currentFn = null;
let isDirty = false;
let outputCollapsed = false;

/* ==============================
   Templates
   ============================== */
const templates = {
  hello: `// A simple hello world handler
export default async function(ctx) {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Hello from Serverless!',
      path: ctx.path,
      method: ctx.method,
      timestamp: Date.now()
    }),
  };
}`,

  echo: `// Echo back the request details
export default async function(ctx) {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: ctx.method,
      path: ctx.path,
      query: ctx.query,
      headers: ctx.headers,
      body: ctx.body,
    }, null, 2),
  };
}`,

  headers: `// Inspect request headers and return custom response headers
export default async function(ctx) {
  const respHeaders = { 'Content-Type': 'application/json' };
  if (ctx.method === 'POST') {
    respHeaders['X-Request-Id'] = 'req-' + Date.now();
  }
  return {
    status: 200,
    headers: respHeaders,
    body: JSON.stringify({
      receivedHeaders: ctx.headers,
    }, null, 2),
  };
}`,

  json: `// JSON API with input validation
export default async function(ctx) {
  if (ctx.method !== 'POST') {
    return {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed', hint: 'Send a POST request with JSON body' }),
    };
  }
  try {
    const data = JSON.parse(ctx.body);
    const name = data.name || 'World';
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ greeting: \`Hello, \${name}!\`, received: data }),
    };
  } catch {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }
}`,

  error: `// Simulate different error responses based on path
export default async function(ctx) {
  if (ctx.path === '/not-found') {
    return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not Found' }) };
  }
  if (ctx.path === '/forbidden') {
    return { status: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Forbidden' }) };
  }
  if (ctx.path === '/server-error') {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Internal Server Error' }) };
  }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hint: 'Try /not-found, /forbidden, or /server-error' }) };
}`,

  timer: `// Async timer example - simulates a delayed response
export default async function(ctx) {
  const start = Date.now();
  await new Promise(resolve => setTimeout(resolve, 500));
  const elapsed = Date.now() - start;
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Async work completed',
      elapsed: \`\${elapsed}ms\`,
      requestedAt: start,
      completedAt: Date.now(),
    }),
  };
}`,
};

/* ==============================
   CodeMirror Setup
   ============================== */
async function initEditor() {
  const [
    { EditorView, keymap },
    { EditorState, Compartment },
    { javascript },
    { oneDark },
    { indentWithTab, defaultKeymap, indentMore, indentLess },
    { basicSetup },
  ] = await Promise.all([
    import('https://esm.sh/@codemirror/view@6'),
    import('https://esm.sh/@codemirror/state@6'),
    import('https://esm.sh/@codemirror/lang-javascript@6'),
    import('https://esm.sh/@codemirror/theme-one-dark@6'),
    import('https://esm.sh/@codemirror/commands@6'),
    import('https://esm.sh/codemirror@6'),
  ]);

  const parent = document.getElementById('cmContainer');
  parent.innerHTML = '';
  document.getElementById('emptyState')?.remove();

  cmEditor = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        javascript(),
        oneDark,
        indentWithTab,
        EditorView.lineWrapping,
        keymap.of([
          ...defaultKeymap,
          { key: 'Tab', run: indentMore },
          { key: 'Shift-Tab', run: indentLess },
          { key: 'Mod-s', run: () => { saveCode(); return true; } },
          { key: 'Mod-Enter', run: () => { runCode(); return true; } },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) markDirty();
        }),
      ],
    }),
    parent,
  });

  cmEditor.focus();
}

function getCode() {
  return cmEditor ? cmEditor.state.doc.toString() : '';
}

function setCode(code) {
  if (!cmEditor) return;
  cmEditor.dispatch({
    changes: { from: 0, to: cmEditor.state.doc.length, insert: code },
  });
}

/* ==============================
   Dirty State Tracking
   ============================== */
function markDirty() {
  if (!isDirty && currentFn) {
    isDirty = true;
    const li = document.querySelector(`.fn-list li[data-name="${currentFn}"]`);
    if (li) {
      const icon = li.querySelector('.fn-icon');
      icon.textContent = 'M';
      icon.style.color = 'var(--yellow)';
      icon.style.borderColor = 'var(--yellow)';
    }
    updateTitle();
  }
}

function clearDirty() {
  if (isDirty && currentFn) {
    isDirty = false;
    const li = document.querySelector(`.fn-list li[data-name="${currentFn}"]`);
    if (li) {
      const icon = li.querySelector('.fn-icon');
      icon.textContent = 'TS';
      icon.style.color = '';
      icon.style.borderColor = '';
    }
    updateTitle();
  }
}

function updateTitle() {
  const name = document.getElementById('fnName').value.trim() || 'Untitled';
  document.title = isDirty ? `● ${name} — DynaPM Serverless` : `${name} — DynaPM Serverless`;
}

/* ==============================
   Function List
   ============================== */
async function loadFnList() {
  const r = await fetch(API + '/_fn/list');
  const data = await r.json();
  const list = document.getElementById('fnList');
  const count = document.getElementById('fnCount');
  const empty = document.getElementById('fnListEmpty');
  count.textContent = data.functions.length;

  if (data.functions.length === 0) {
    list.innerHTML = '<li class="fn-list-empty" id="fnListEmpty">No functions yet</li>';
    return;
  }

  list.innerHTML = data.functions.map(fn => `
    <li data-name="${escapeAttr(fn.name)}" onclick="selectFn('${escapeAttr(fn.name)}')">
      <div class="fn-icon">TS</div>
      <span class="fn-name">${escapeHtml(fn.name)}</span>
      <span class="fn-delete" onclick="event.stopPropagation();deleteFn('${escapeAttr(fn.name)}')" title="Delete">&times;</span>
    </li>
  `).join('');
}

async function selectFn(name) {
  if (isDirty && currentFn) {
    await saveCode();
  }

  currentFn = name;
  isDirty = false;

  document.getElementById('fnName').value = name;
  updateFnUrl(name);
  updateTitle();

  document.querySelectorAll('.fn-list li').forEach(li => li.classList.toggle('active', li.dataset.name === name));

  try {
    const r = await fetch(API + '/_fn/' + encodeURIComponent(name));
    if (!r.ok) { setCode(''); return; }
    const data = await r.json();
    setCode(data.code || '');
  } catch (e) {
    console.error('Failed to load function:', e);
  }

  if (!cmEditor) await initEditor();
}

function createNew() {
  currentFn = null;
  isDirty = false;
  document.getElementById('fnName').value = '';
  updateFnUrl('unnamed');
  updateTitle();
  document.querySelectorAll('.fn-list li').forEach(li => li.classList.remove('active'));

  if (!cmEditor) {
    initEditor().then(() => { document.getElementById('emptyState')?.remove(); });
  } else {
    document.getElementById('emptyState')?.remove();
    setCode(templates.hello);
    document.getElementById('fnName').focus();
    cmEditor.focus();
  }
}

async function deleteFn(name) {
  const r = await fetch(API + '/_fn/' + encodeURIComponent(name), { method: 'DELETE' });
  const data = await r.json();
  if (data.success) {
    if (currentFn === name) { currentFn = null; isDirty = false; createNew(); }
    await loadFnList();
    showToast('Deleted /' + name, 'success');
  }
}

/* ==============================
   Save & Run
   ============================== */
async function saveCode() {
  const name = document.getElementById('fnName').value.trim();
  const code = getCode();
  if (!name || !code) {
    showToast('Enter a function name and code', 'error');
    return;
  }

  try {
    const r = await fetch(API + '/_fn/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code }),
    });
    const data = await r.json();
    if (data.success) {
      clearDirty();
      currentFn = name;
      updateFnUrl(name);
      await loadFnList();
      highlightActiveFn(name);
      showToast('Saved /' + name, 'success');
    } else {
      showToast('Save failed: ' + data.error, 'error');
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
}

async function runCode() {
  const name = document.getElementById('fnName').value.trim();
  const code = getCode();
  if (!name) { showToast('Enter a function name before running', 'error'); return; }
  if (!code) { showToast('Cannot run empty code', 'error'); return; }

  /* Save first */
  try {
    await fetch(API + '/_fn/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code }),
    });
  } catch { /* ignore save errors */ }

  const runBtn = document.getElementById('runBtn');
  runBtn.classList.add('running');
  const startTime = performance.now();

  try {
    const method = document.getElementById('methodSelect').value;
    const path = document.getElementById('pathInput').value || '/';
    const opts = { method };
    if (method !== 'GET' && method !== 'HEAD') {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = document.getElementById('requestBody').value;
    }

    const r = await fetch(API + '/' + encodeURIComponent(name) + path, opts);
    const duration = (performance.now() - startTime) | 0;
    const text = await r.text();

    showRunOutput(r.status, r.statusText, r.headers, text, duration);
  } catch (e) {
    const duration = (performance.now() - startTime) | 0;
    showOutput('error', 'Request failed: ' + e.message, duration);
  } finally {
    runBtn.classList.remove('running');
  }
}

/* ==============================
   Output Panel
   ============================== */
function showRunOutput(status, statusText, headers, body, duration) {
  const badge = document.getElementById('outputBadge');
  badge.style.display = '';
  badge.textContent = status + ' ' + statusText;
  badge.className = 'output-badge ' + (status < 300 ? 'ok' : status < 500 ? 'info' : 'err');
  document.getElementById('outputTime').textContent = duration + 'ms';

  const headerMap = {};
  headers.forEach((v, k) => { headerMap[k] = v; });

  let formattedBody = escapeHtml(body);
  let bodyClass = '';
  /* Try to format JSON */
  try {
    const parsed = JSON.parse(body);
    formattedBody = syntaxHighlightJSON(JSON.stringify(parsed, null, 2));
    bodyClass = ' json';
  } catch { /* not JSON */ }

  const outputBody = document.getElementById('outputBody');
  outputBody.innerHTML =
    `<div class="output-section">
      <div class="output-label">Status</div>
      <div class="output-content">${status} ${escapeHtml(statusText)}</div>
    </div>` +
    (Object.keys(headerMap).length > 0
      ? `<div class="output-section">
          <div class="output-label">Response Headers</div>
          <div class="output-content">${escapeHtml(JSON.stringify(headerMap, null, 2))}</div>
        </div>`
      : '') +
    `<div class="output-section">
      <div class="output-label">Response Body</div>
      <div class="output-content${bodyClass}">${formattedBody}</div>
    </div>`;

  expandOutput();
}

function showOutput(type, text, duration) {
  const badge = document.getElementById('outputBadge');
  badge.style.display = '';
  badge.textContent = type === 'success' ? 'OK' : 'Error';
  badge.className = 'output-badge ' + (type === 'success' ? 'ok' : 'err');
  document.getElementById('outputTime').textContent = duration ? duration + 'ms' : '';
  document.getElementById('outputBody').innerHTML =
    `<div class="output-section"><div class="output-content">${escapeHtml(text)}</div></div>`;
  expandOutput();
}

function expandOutput() {
  document.getElementById('outputPanel').classList.remove('collapsed');
  outputCollapsed = false;
}

function toggleOutput() {
  outputCollapsed = !outputCollapsed;
  document.getElementById('outputPanel').classList.toggle('collapsed', outputCollapsed);
}

function clearOutput() {
  document.getElementById('outputBody').innerHTML = '';
  const badge = document.getElementById('outputBadge');
  badge.style.display = 'none';
  document.getElementById('outputTime').textContent = '';
}

/* ==============================
   Template Menu
   ============================== */
function applyTemplate(name) {
  const code = templates[name];
  if (!code) return;
  currentFn = null;
  isDirty = false;
  const shortName = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  document.getElementById('fnName').value = shortName;
  updateFnUrl(shortName);
  updateTitle();
  document.querySelectorAll('.fn-list li').forEach(li => li.classList.remove('active'));

  if (!cmEditor) {
    initEditor().then(() => {
      document.getElementById('emptyState')?.remove();
      setCode(code);
      cmEditor.focus();
    });
  } else {
    document.getElementById('emptyState')?.remove();
    setCode(code);
    cmEditor.focus();
  }
}

/* ==============================
   UI Helpers
   ============================== */
function updateFnUrl(name) {
  document.querySelector('#fnUrl .url-text').textContent = '/' + name;
}

function highlightActiveFn(name) {
  document.querySelectorAll('.fn-list li').forEach(li => li.classList.toggle('active', li.dataset.name === name));
}

function showToast(msg, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.remove(); }, 2500);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function syntaxHighlightJSON(json) {
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      cls = /:$/.test(match) ? 'json-key' : 'json-string';
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return `<span class="${cls}">${escapeHtml(match)}</span>`;
  });
}

/* ==============================
   Sidebar Resizer
   ============================== */
function initSidebarResizer() {
  const resizer = document.getElementById('sidebarResizer');
  const sidebar = document.getElementById('sidebar');
  let startX, startWidth;

  resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    resizer.classList.add('active');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });

  function onMouseMove(e) {
    const width = Math.max(160, Math.min(400, startWidth + e.clientX - startX));
    sidebar.style.width = width + 'px';
  }

  function onMouseUp() {
    resizer.classList.remove('active');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
}

/* ==============================
   Output Resizer
   ============================== */
function initOutputResizer() {
  const resizer = document.getElementById('outputResizer');
  const panel = document.getElementById('outputPanel');
  let startY, startHeight;

  resizer.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startHeight = panel.offsetHeight;
    resizer.classList.add('active');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });

  function onMouseMove(e) {
    const height = Math.max(60, Math.min(600, startHeight - e.clientY + startY));
    panel.style.height = height + 'px';
  }

  function onMouseUp() {
    resizer.classList.remove('active');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
}

/* ==============================
   Event Bindings
   ============================== */
document.getElementById('newBtn').addEventListener('click', createNew);
document.getElementById('runBtn').addEventListener('click', runCode);
document.getElementById('saveBtn').addEventListener('click', saveCode);
document.getElementById('outputHeader').addEventListener('click', (e) => {
  if (e.target.closest('.output-clear')) return;
  toggleOutput();
});
document.getElementById('outputClear').addEventListener('click', (e) => {
  e.stopPropagation();
  clearOutput();
});

/* Template dropdown */
const templateBtn = document.getElementById('templateBtn');
const templateDropdown = document.getElementById('templateDropdown');

templateBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  templateDropdown.classList.toggle('show');
});

templateDropdown.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    applyTemplate(btn.dataset.tpl);
    templateDropdown.classList.remove('show');
  });
});

document.addEventListener('click', () => templateDropdown.classList.remove('show'));

/* Keyboard shortcuts */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runCode();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCode();
  }
  if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
    if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      document.getElementById('shortcutsModal').classList.add('show');
    }
  }
  if (e.key === 'Escape') {
    document.getElementById('shortcutsModal').classList.remove('show');
    document.getElementById('bodyPanel').classList.remove('show');
  }
});

/* Name input change */
document.getElementById('fnName').addEventListener('input', () => {
  const name = document.getElementById('fnName').value.trim();
  if (name) updateFnUrl(name);
  updateTitle();
});

/* Path input: Enter to run */
document.getElementById('pathInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runCode();
});

/* Request body panel */
const bodyPanel = document.getElementById('bodyPanel');
const bodyToggleBtn = document.getElementById('bodyToggleBtn');

bodyToggleBtn.addEventListener('click', () => {
  bodyPanel.classList.toggle('show');
});

document.getElementById('bodyPanelClose').addEventListener('click', () => {
  bodyPanel.classList.remove('show');
});

document.getElementById('requestBody').addEventListener('input', () => {
  const size = new TextEncoder().encode(document.getElementById('requestBody').value).length;
  document.getElementById('bodySize').textContent = size < 1024 ? size + ' B' : (size / 1024).toFixed(1) + ' KB';
});

/* Method change: auto-show body panel for non-GET methods */
document.getElementById('methodSelect').addEventListener('change', (e) => {
  if (e.target.value !== 'GET' && e.target.value !== 'HEAD') {
    bodyPanel.classList.add('show');
  }
});

/* Shortcuts modal */
document.getElementById('shortcutsBtn').addEventListener('click', () => {
  document.getElementById('shortcutsModal').classList.add('show');
});

document.getElementById('shortcutsClose').addEventListener('click', () => {
  document.getElementById('shortcutsModal').classList.remove('show');
});

document.getElementById('shortcutsModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('shortcutsModal').classList.remove('show');
  }
});

/* ==============================
   Init
   ============================== */
initSidebarResizer();
initOutputResizer();
loadFnList();
