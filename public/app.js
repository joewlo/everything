// ── THEME ────────────────────────────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  html.classList.toggle('dark');
  localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark') {
    document.documentElement.classList.add('dark');
  } else if (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark');
  }
}

// ── STATE ────────────────────────────────────────────────────────────
const state = {
  notes: [],
  activeId: null,
  todos: [],
  searchQuery: '',
  isRecording: false,
  mediaRecorder: null,
  dirty: false,
  saveTimer: null,
};

// ── UTILS ────────────────────────────────────────────────────────────
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (hrs < 48) return 'yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  setTimeout(() => el.className = '', 2500);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ── API ──────────────────────────────────────────────────────────────
const API = {
  listNotes:      ()                => api('GET', '/api/notes'),
  getNote:        (id)              => api('GET', `/api/notes/${id}`),
  createNote:     (data)            => api('POST', '/api/notes', data),
  updateNote:     (id, data)        => api('PUT', `/api/notes/${id}`, data),
  deleteNote:     (id)              => api('DELETE', `/api/notes/${id}`),
  searchNotes:    (q)               => api('GET', `/api/search?q=${encodeURIComponent(q)}`),
  getTodos:       ()                => api('GET', '/api/todos'),
  saveTodos:      (todos)           => api('PUT', '/api/todos', { todos }),
  summarizeNote:  (id)              => api('POST', `/api/notes/${id}/summarize`),
  reflectNote:    (id)              => api('POST', `/api/notes/${id}/reflect`),
  extractActions: (id)              => api('POST', `/api/notes/${id}/actions`),
};

// ── RENDER: NOTE LIST ────────────────────────────────────────────────
function renderNoteList() {
  const container = $('#notes-list-inner');
  const q = state.searchQuery.toLowerCase();
  const filtered = q
    ? state.notes.filter(n => (n.title || '').toLowerCase().includes(q) || (n.contentPreview || '').toLowerCase().includes(q))
    : state.notes;

  $('#notes-count').textContent = `${state.notes.length} note${state.notes.length !== 1 ? 's' : ''}`;

  if (!state.notes.length) {
    container.innerHTML = '<div id="notes-list-empty">No notes yet. Create your first one!</div>';
    return;
  }
  if (q && !filtered.length) {
    container.innerHTML = `<div id="notes-list-empty">No results for "${escapeHtml(q)}"</div>`;
    return;
  }

  container.innerHTML = filtered.map(n => `
    <div class="note-item${n.id === state.activeId ? ' active' : ''}" data-id="${n.id}">
      <div class="note-item-title">${escapeHtml(n.title || 'Untitled')}</div>
      <div class="note-item-meta">
        <span>${formatDate(n.modified || n.date)}</span>
        ${n.source === 'voice' ? '<span class="note-item-tag">🎤 voice</span>' : ''}
        ${n.source === 'file' ? '<span class="note-item-tag">📎 file</span>' : ''}
      </div>
      ${n.summary ? `<div class="note-item-preview">${escapeHtml(n.summary)}</div>` : ''}
    </div>
  `).join('');

  container.querySelectorAll('.note-item').forEach(el => {
    el.addEventListener('click', () => loadNote(el.dataset.id));
  });
}

// ── RENDER: NOTE EDITOR ──────────────────────────────────────────────
let currentNote = null;

async function loadNote(id) {
  // Auto-save previous if dirty
  if (state.dirty && state.activeId) {
    await autoSave(true);
  }

  try {
    currentNote = await API.getNote(id);
    state.activeId = id;
    state.dirty = false;

    $('#empty-state').style.display = 'none';
    $('#editor').style.display = 'flex';
    $('#note-title').value = currentNote.title || '';
    $('#note-content').value = currentNote.content || '';
    $('#note-meta').textContent = `Updated ${formatDate(currentNote.modified || currentNote.date)}`;
    updateWordCount();
    updatePreview();
    renderNoteList();
    renderAIResults();
    updateAIActionButtons();
  } catch (err) {
    toast('Failed to load note: ' + err.message, 'error');
  }
}

function showSaved() {
  const el = $('#saved-indicator');
  el.classList.add('visible');
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => el.classList.remove('visible'), 2000);
}

function markDirty() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (state.dirty) autoSave(true).then(() => showSaved());
  }, 10000);
}

async function autoSave(silent) {
  if (!state.activeId) return;
  const title = $('#note-title').value.trim();
  const content = $('#note-content').value;

  try {
    await API.updateNote(state.activeId, { title, content });
    state.dirty = false;
    await refreshNotesSilent();
  } catch (err) {
    if (!silent) toast('Save failed: ' + err.message, 'error');
  }
}

async function generateTitle() {
  if (!state.activeId) return;
  const spinner = $('#title-spinner');
  spinner.style.display = 'inline';
  try {
    const res = await fetch(`/api/notes/${state.activeId}/generate-title`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.title) {
        $('#note-title').value = data.title;
        await refreshNotesSilent();
        renderNoteList();
      }
    }
  } catch (err) {
    // LLM not available — that's fine, user can type a title
  }
  spinner.style.display = 'none';
}

async function refreshNotesSilent() {
  try {
    state.notes = await API.listNotes();
  } catch (err) {
    // silently fail
  }
}

async function createNewNote() {
  // Fire-and-forget save previous note (don't block on AI pipeline)
  if (state.dirty && state.activeId) autoSave(true);

  try {
    const note = await API.createNote({ title: '', content: '', source: 'typed' });
    state.activeId = note.id;
    state.dirty = false;
    await refreshNotes();
    $('#empty-state').style.display = 'none';
    $('#editor').style.display = 'flex';
    $('#note-title').value = '';
    $('#note-content').value = '';
    $('#note-meta').textContent = 'New note';
    updateWordCount();
    renderAIResults();
    updateAIActionButtons();
    renderNoteList();
    $('#note-content').focus();
  } catch (err) {
    toast('Failed to create note: ' + err.message, 'error');
  }
}

async function deleteCurrentNote() {
  if (!state.activeId) return;
  if (!confirm('Delete this note?')) return;

  try {
    await API.deleteNote(state.activeId);
    state.activeId = null;
    state.dirty = false;
    currentNote = null;
    await refreshNotes();

    if (state.notes.length) {
      loadNote(state.notes[0].id);
    } else {
      showEmpty();
    }
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
  }
}

function showEmpty() {
  $('#empty-state').style.display = 'flex';
  $('#editor').style.display = 'none';
  state.activeId = null;
  currentNote = null;
  updateAIActionButtons();
  renderAIResults();
  renderNoteList();
}

function updatePreview() {
  $('#note-preview').innerHTML = marked.parse($('#note-content').value);
}

function updateWordCount() {
  const words = $('#note-content').value.trim().split(/\s+/).filter(Boolean).length;
  $('#word-count').textContent = `${words} word${words !== 1 ? 's' : ''}`;
}

async function refreshNotes() {
  state.notes = await API.listNotes();
  renderNoteList();
}

// ── RENDER: AI RESULTS ───────────────────────────────────────────────
function renderAIResults() {
  const container = $('#ai-results');
  if (!currentNote) { container.innerHTML = ''; return; }

  let html = '';
  const data = currentNote;

  if (data.summary) {
    html += `<div class="ai-result">
      <div class="ai-result-label summarize">📝 Summary</div>
      <div class="ai-result-content">${escapeHtml(data.summary)}</div>
    </div>`;
  }
  if (data.reflection) {
    html += `<div class="ai-result">
      <div class="ai-result-label reflect">💭 Reflection</div>
      <div class="ai-result-content">${escapeHtml(data.reflection)}</div>
    </div>`;
  }
  if (data.actions && data.actions.length) {
    html += `<div class="ai-result">
      <div class="ai-result-label actions">✅ Actions</div>
      <div class="ai-result-content"><ul style="padding-left:16px;margin:0">${data.actions.map(a => {
        const text = typeof a === 'string' ? a : a.text;
        const due = typeof a === 'object' && a.dueDate ? ` <span style="color:var(--text-dim);font-size:11px">due ${new Date(a.dueDate).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>` : '';
        return `<li>${escapeHtml(text)}${due}</li>`;
      }).join('')}</ul></div>
    </div>`;
  }

  if (!html) {
    html = '<div style="color:var(--text-dim);font-size:12px;padding:8px 0">Press Save to generate summary, reflection &amp; actions.</div>';
  }

  container.innerHTML = html;
}

function updateAIActionButtons() {
  const hasNote = !!state.activeId;
  $('#btn-summarize').disabled = !hasNote;
  $('#btn-reflect').disabled = !hasNote;
  $('#btn-extract-actions').disabled = !hasNote;
}

async function runAIAction(action) {
  if (!state.activeId) return;
  const btn = $(`#btn-${action}`);
  const origText = btn.textContent;
  btn.textContent = 'Working…';
  btn.disabled = true;

  try {
    let result;
    if (action === 'summarize') {
      const r = await API.summarizeNote(state.activeId);
      result = r.summary;
    } else if (action === 'reflect') {
      const r = await API.reflectNote(state.activeId);
      result = r.reflection;
    } else if (action === 'extract-actions') {
      const r = await API.extractActions(state.activeId);
      result = r.actions;
    }

    currentNote = await API.getNote(state.activeId);
    showAIResult(action, result);
    await refreshNotes();
    await loadTodos();
    renderNoteList();
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
      toast('LLM server not running. Start it with: npm run serve', 'error');
    } else {
      toast(`${action} failed: ${msg}`, 'error');
    }
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

// Run full pipeline: title → summarize → reflect → actions (called by save button)
async function runFullPipeline() {
  if (!state.activeId) return;
  const content = $('#note-content').value.trim();
  const title = $('#note-title').value.trim();
  if (!content) return;

  if (!title) await generateTitle();
  await runAIActionAuto('summarize');
  await runAIActionAuto('reflect');
  await runAIActionAuto('extract-actions');
}

// Silent auto-run (no button changes, no toasts, used by autoSave)
async function runAIActionAuto(action) {
  if (!state.activeId) return;
  try {
    if (action === 'summarize') {
      const r = await API.summarizeNote(state.activeId);
      showAIResult(action, r.summary);
    } else if (action === 'reflect') {
      const r = await API.reflectNote(state.activeId);
      showAIResult(action, r.reflection);
    } else if (action === 'extract-actions') {
      const r = await API.extractActions(state.activeId);
      showAIResult(action, r.actions);
      await loadTodos();
    }
    currentNote = await API.getNote(state.activeId);
    await refreshNotesSilent();
    renderNoteList();
  } catch (err) {
    // Silently fail — LLM server may not be running
  }
}

function showAIResult(action, result) {
  const container = $('#ai-results');
  const labels = {
    summarize: { class: 'summarize', icon: '📝', text: 'Summary' },
    reflect: { class: 'reflect', icon: '💭', text: 'Reflection' },
    'extract-actions': { class: 'actions', icon: '✅', text: 'Actions' },
  };
  const meta = labels[action === 'extract-actions' ? 'extract-actions' : action];

  let content = '';
  if (Array.isArray(result)) {
    content = result.length
      ? '<ul style="padding-left:16px;margin:0">' + result.map(a => {
          const text = typeof a === 'string' ? a : a.text;
          const due = typeof a === 'object' && a.dueDate ? ` <span style="font-size:10px;color:var(--text-dim)">due ${new Date(a.dueDate).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>` : '';
          return `<li>${escapeHtml(text)}${due}</li>`;
        }).join('') + '</ul>'
      : 'No action items found.';
  } else {
    content = escapeHtml(result || '');
  }

  const html = `
    <div class="ai-result">
      <div class="ai-result-label ${meta.class}">${meta.icon} ${meta.text}</div>
      <div class="ai-result-content">${content}</div>
    </div>
  `;

  // Replace existing result of same type or prepend
  const existing = container.querySelector(`.ai-result-label.${meta.class}`);
  if (existing) {
    existing.parentElement.outerHTML = html;
  } else {
    container.insertAdjacentHTML('afterbegin', html);
  }
}

// ── RENDER: TODOS ────────────────────────────────────────────────────
async function loadTodos() {
  try {
    state.todos = await API.getTodos();
    renderTodos();
  } catch (err) {
    console.error('Failed to load todos:', err);
  }
}

function renderTodos() {
  const list = $('#todos-list');
  if (!state.todos.length) {
    list.innerHTML = '<li id="todos-empty">No todos yet. Press Save or extract actions from a note.</li>';
    return;
  }

  list.innerHTML = state.todos.map((t, i) => {
    const created = t.createdAt ? new Date(t.createdAt) : null;
    const due = t.dueDate ? new Date(t.dueDate) : null;
    const createdStr = created ? created.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const dueStr = due ? due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const isOverdue = due && !t.done && due < new Date();

    return `<li class="todo-item${t.done ? ' done' : ''}${isOverdue ? ' overdue' : ''}" data-index="${i}">
      <div class="todo-check"></div>
      <div class="todo-body">
        <span class="todo-text">${escapeHtml(t.text)}</span>
        <div class="todo-dates">
          ${createdStr ? `<span class="todo-date">Created ${createdStr}</span>` : ''}
          ${dueStr ? `<span class="todo-date todo-due${isOverdue ? ' overdue' : ''}">Due ${dueStr}</span>` : ''}
          <span class="todo-set-due" data-index="${i}">${dueStr ? 'Change due' : 'Set due'}</span>
        </div>
      </div>
      <button class="todo-delete" title="Remove">&times;</button>
    </li>`;
  }).join('');

  list.querySelectorAll('.todo-item').forEach(el => {
    const i = parseInt(el.dataset.index);
    el.querySelector('.todo-check').addEventListener('click', () => toggleTodo(i));
    el.querySelector('.todo-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      removeTodo(i);
    });
  });

  list.querySelectorAll('.todo-set-due').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = parseInt(el.dataset.index);
      setDueDate(i);
    });
  });
}

async function setDueDate(index) {
  const todo = state.todos[index];
  const current = todo.dueDate ? new Date(todo.dueDate).toISOString().slice(0, 10) : '';
  const input = prompt('Set due date (YYYY-MM-DD):', current);
  if (input === null) return;
  if (input === '') {
    todo.dueDate = null;
  } else {
    const d = new Date(input + 'T00:00:00');
    if (isNaN(d.getTime())) { toast('Invalid date format.', 'error'); return; }
    todo.dueDate = d.toISOString();
  }
  await saveTodos();
}

async function addTodo() {
  const input = $('#todo-input');
  const text = input.value.trim();
  if (!text) return;

  state.todos.push({
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
    text,
    done: false,
    createdAt: new Date().toISOString(),
    dueDate: null,
  });
  input.value = '';
  await saveTodos();
}

async function saveTodos() {
  try {
    await API.saveTodos(state.todos);
    renderTodos();
  } catch (err) {
    toast('Failed to save todos: ' + err.message, 'error');
  }
}

// ── VOICE RECORDING ──────────────────────────────────────────────────
function isVoiceSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

let audioContext = null;
let audioStream = null;
let audioProcessor = null;
let audioChunks = [];
let totalSamples = 0;

async function startRecording() {
  if (!isVoiceSupported()) {
    toast('Voice recording not supported in this browser.', 'error');
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(audioStream);

    // Use AudioWorklet if available, otherwise ScriptProcessor fallback
    if (audioContext.audioWorklet) {
      await audioContext.audioWorklet.addModule(URL.createObjectURL(
        new Blob([`
          class RecorderProcessor extends AudioWorkletProcessor {
            process(inputs) {
              const input = inputs[0];
              if (input && input.length > 0) {
                this.port.postMessage(input[0]);
              }
              return true;
            }
          }
          registerProcessor('recorder-processor', RecorderProcessor);
        `], { type: 'application/javascript' })
      ));

      const worklet = new AudioWorkletNode(audioContext, 'recorder-processor');
      worklet.port.onmessage = (e) => {
        audioChunks.push(new Float32Array(e.data));
        totalSamples += e.data.length;
      };
      audioProcessor = worklet;
      source.connect(worklet);
      worklet.connect(audioContext.destination);
    } else {
      // Fallback: ScriptProcessor (deprecated but widely supported)
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        audioChunks.push(data);
        totalSamples += data.length;
      };
      audioProcessor = processor;
      source.connect(processor);
      processor.connect(audioContext.destination);
    }

    state.isRecording = true;
    $('#btn-record').style.display = 'none';
    $('#btn-stop').style.display = 'flex';
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      toast('Microphone access denied.', 'error');
    } else {
      toast('Microphone error: ' + err.message, 'error');
    }
  }
}

function encodeWAV(sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataLength = totalSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (const chunk of audioChunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function stopRecording() {
  if (!state.isRecording) return;

  state.isRecording = false;
  $('#btn-record').style.display = 'flex';
  $('#btn-stop').style.display = 'none';

  // Disconnect and close
  audioStream.getTracks().forEach(t => t.stop());
  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  if (totalSamples === 0) {
    toast('No audio captured.', 'error');
    audioChunks = [];
    totalSamples = 0;
    return;
  }

  const wavBlob = encodeWAV(16000);
  audioChunks = [];
  totalSamples = 0;

  // Send to whisper.cpp via server
  try {
    const formData = new FormData();
    formData.append('audio', wavBlob, 'recording.wav');
    const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error || '';
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
        throw new Error('Whisper server not running. Start it with: npm run serve');
      }
      throw new Error(msg || 'Whisper server unreachable');
    }
    const data = await res.json();

    if (data.text) {
      if (!state.activeId) {
        await createNewNote();
      }
      const textarea = $('#note-content');
      const current = textarea.value;
      const separator = current && !current.endsWith('\n') ? '\n\n' : '';
      textarea.value = current + separator + data.text;
      markDirty();
      updateWordCount();
      updatePreview();
      toast('Transcription added', 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
    if (!err.message.includes('Web Speech')) {
      tryBrowserSpeechAPI();
    }
  }
}

// Fallback: browser's built-in Web Speech API
function tryBrowserSpeechAPI() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  const recognition = new SpeechRecognition();
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    const text = event.results[0][0].transcript;
    if (text && state.activeId) {
      const textarea = $('#note-content');
      const current = textarea.value;
      const separator = current && !current.endsWith('\n') ? '\n\n' : '';
      textarea.value = current + separator + text;
      markDirty();
      updateWordCount();
      updatePreview();
    }
  };

  recognition.onerror = () => {
    toast('Speech recognition not available.', 'error');
  };

  recognition.start();
}

// ── DRAG & DROP ──────────────────────────────────────────────────────
function setupDragDrop() {
  const body = document.body;
  const indicator = $('#drop-indicator');

  body.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    indicator.style.display = 'flex';
  });

  body.addEventListener('dragleave', e => {
    e.preventDefault();
    if (e.target === body || e.target === document.documentElement) {
      indicator.style.display = 'none';
    }
  });

  body.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    indicator.style.display = 'none';

    const files = [...e.dataTransfer.files];
    const textFiles = [];
    const binaryFiles = [];

    for (const file of files) {
      const isText = file.type.startsWith('text/') ||
        /\.(md|txt|json|js|ts|py|html|css|yml|yaml|log|csv|xml)$/i.test(file.name);
      const isImage = file.type.startsWith('image/');

      if (isText) {
        textFiles.push(file);
      } else if (state.activeId) {
        // Upload binary as attachment to current note
        try {
          const formData = new FormData();
          formData.append('file', file);
          const res = await fetch(`/api/notes/${state.activeId}/attachments`, {
            method: 'POST', body: formData,
          });
          if (!res.ok) throw new Error('Upload failed');
          const data = await res.json();

          const textarea = $('#note-content');
          const marker = isImage
            ? `![${file.name}](${data.url})`
            : `[${file.name}](${data.url})`;
          const cursor = textarea.selectionStart;
          textarea.value =
            textarea.value.slice(0, cursor) +
            marker + '\n' +
            textarea.value.slice(cursor);
          textarea.selectionStart = textarea.selectionEnd = cursor + marker.length + 1;
          markDirty();
          updateWordCount();
          updatePreview();
          toast(`Attached: ${file.name}`, 'success');
        } catch (err) {
          toast(`Failed to attach ${file.name}: ${err.message}`, 'error');
        }
      } else {
        binaryFiles.push(file);
      }
    }

    // Text files: insert content (or create new note)
    for (const file of textFiles) {
      try {
        const content = await readFileContent(file);
        if (!content) continue;
        if (state.activeId) {
          const textarea = $('#note-content');
          const cursor = textarea.selectionStart;
          const header = `\n## ${file.name}\n\n`;
          textarea.value =
            textarea.value.slice(0, cursor) +
            header + content + '\n' +
            textarea.value.slice(cursor);
          markDirty();
          updateWordCount();
          updatePreview();
          toast(`Imported: ${file.name}`, 'success');
        } else {
          const note = await API.createNote({
            title: file.name.replace(/\.[^.]+$/, ''),
            content,
            source: 'file',
          });
          state.activeId = note.id;
          await refreshNotes();
          await loadNote(note.id);
        }
      } catch (err) {
        toast(`Failed to read ${file.name}: ${err.message}`, 'error');
      }
    }

    // Binary files with no active note — create a note listing them
    if (binaryFiles.length && !state.activeId) {
      const content = binaryFiles.map(f => `- [ ] Attach: ${f.name}\n`).join('');
      const note = await API.createNote({
        title: binaryFiles.map(f => f.name).join(', '),
        content,
        source: 'file',
      });
      state.activeId = note.id;
      await refreshNotes();
      await loadNote(note.id);
      toast('Drag files into an open note to attach them.', 'success');
    } else if (binaryFiles.length) {
      toast('Drop text files to import content, or drop images/files into an open note.', 'error');
    }
  });
}

function readFileContent(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Read error'));
    reader.readAsText(file);
  });
}

// ── SEARCH ───────────────────────────────────────────────────────────
$('#search-input').addEventListener('input', e => {
  state.searchQuery = e.target.value;
  renderNoteList();
});

// ── CHAT MODAL ───────────────────────────────────────────────────────
function openChat() {
  $('#chat-modal').style.display = 'flex';
  $('#chat-input').focus();
}

function closeChat() {
  $('#chat-modal').style.display = 'none';
}

async function sendChatMessage() {
  const input = $('#chat-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';

  const history = $('#chat-history');
  const msgId = 'msg-' + Date.now();

  // Show the question bubble
  history.insertAdjacentHTML('beforeend', `
    <div class="chat-msg" id="${msgId}">
      <div class="chat-question">${escapeHtml(question)}</div>
      <div class="chat-process" id="${msgId}-process"></div>
      <div class="chat-answer" id="${msgId}-answer" style="display:none"></div>
      <div class="chat-refs" id="${msgId}-refs" style="display:none"></div>
    </div>
  `);
  history.scrollTop = history.scrollHeight;

  const processEl = document.getElementById(`${msgId}-process`);
  const answerEl = document.getElementById(`${msgId}-answer`);
  const refsEl = document.getElementById(`${msgId}-refs`);

  // Step 1: Show searching
  processEl.innerHTML = '<div class="chat-process-step">🔍 Thinking of search terms…</div>';

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})).error) || 'Request failed');
    const data = await res.json();

    // Step 2: Show search terms
    if (data.searchTerms && data.searchTerms.length) {
      processEl.innerHTML = `
        <div class="chat-process-step">🔍 Search terms:</div>
        <div class="chat-terms">${data.searchTerms.map(t => `<span class="chat-term">${escapeHtml(t)}</span>`).join('')}</div>
      `;
    }

    // Step 3: Show matched count
    if (data.matchedCount !== undefined) {
      processEl.insertAdjacentHTML('beforeend', `
        <div class="chat-process-step">📄 Grepped ${data.matchedCount} matching notes</div>
      `);
    }

    // Step 4: Show answer
    answerEl.style.display = 'block';
    answerEl.textContent = data.answer;

    // Step 5: Show references
    if (data.references && data.references.length) {
      refsEl.style.display = 'block';
      refsEl.innerHTML = `📎 ${data.references.map(r =>
        `<span class="chat-ref-link" data-id="${r.id}">${escapeHtml(r.title)}</span>`
      ).join(', ')}`;

      refsEl.querySelectorAll('.chat-ref-link').forEach(el => {
        el.addEventListener('click', () => {
          closeChat();
          loadNote(el.dataset.id);
        });
      });
    }
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
      answerEl.style.display = 'block';
      answerEl.textContent = 'LLM server not running. Start it with: npm run serve';
    } else {
      answerEl.style.display = 'block';
      answerEl.innerHTML = `<span style="color:var(--red)">${escapeHtml(msg)}</span>`;
    }
  }

  history.scrollTop = history.scrollHeight;
}

// ── EVENT BINDINGS ───────────────────────────────────────────────────
function bindEvents() {
  $('#btn-new-note').addEventListener('click', createNewNote);
  $('#btn-save').addEventListener('click', async () => {
    await autoSave(false);
    await runFullPipeline();
    toast('Saved', 'success');
  });
  $('#btn-delete').addEventListener('click', deleteCurrentNote);

  $('#note-title').addEventListener('input', markDirty);
  $('#note-content').addEventListener('input', () => {
    markDirty();
    updateWordCount();
    updatePreview();
  });

  // Preview toggle
  let previewOn = false;
  $('#btn-preview').addEventListener('click', () => {
    previewOn = !previewOn;
    const ta = $('#note-content');
    const pv = $('#note-preview');
    if (previewOn) {
      pv.innerHTML = marked.parse(ta.value);
      ta.style.display = 'none';
      pv.style.display = 'block';
      $('#btn-preview').textContent = 'Edit';
    } else {
      pv.style.display = 'none';
      ta.style.display = 'block';
      $('#btn-preview').textContent = 'Preview';
    }
  });

  // Voice
  $('#btn-record').addEventListener('click', startRecording);
  $('#btn-stop').addEventListener('click', stopRecording);
  $('#btn-empty-record').addEventListener('click', startRecording);

  // AI
  $('#btn-summarize').addEventListener('click', () => runAIAction('summarize'));
  $('#btn-reflect').addEventListener('click', () => runAIAction('reflect'));
  $('#btn-extract-actions').addEventListener('click', () => runAIAction('extract-actions'));

  // Theme toggle
  $('#btn-theme').addEventListener('click', toggleTheme);

  // Chat modal
  $('#btn-ask').addEventListener('click', openChat);
  $('#ask-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); openChat(); }
  });
  $('#btn-close-modal').addEventListener('click', closeChat);
  $('#btn-chat-send').addEventListener('click', sendChatMessage);
  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChatMessage();
  });
  $('#chat-modal').addEventListener('click', e => {
    if (e.target === $('#chat-modal')) closeChat();
  });

  // Todos
  $('#btn-add-todo').addEventListener('click', addTodo);
  $('#todo-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addTodo();
  });

  // Export
  $('#btn-export').addEventListener('click', () => {
    window.open('/api/export', '_blank');
  });
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'n') { e.preventDefault(); createNewNote(); }
    if (mod && e.key === 's') { e.preventDefault(); autoSave(false).then(() => runFullPipeline()).then(() => toast('Saved', 'success')); }
    if (mod && e.key === 'k') { e.preventDefault(); $('#search-input').focus(); }
  });

  setupDragDrop();
}

// ── INIT ─────────────────────────────────────────────────────────────
async function init() {
  initTheme();
  bindEvents();

  try {
    await refreshNotes();
    await loadTodos();

    if (state.notes.length > 0) {
      await loadNote(state.notes[0].id);
    } else {
      showEmpty();
    }
  } catch (err) {
    toast('Failed to connect to server: ' + err.message, 'error');
  }
}

init();
