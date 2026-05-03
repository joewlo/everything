const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const matter = require('gray-matter');
const cors = require('cors');

const multer = require('multer');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3456;
const NOTES_DIR = path.join(__dirname, 'notes');
const TODOS_FILE = path.join(__dirname, 'todos.json');
const PROMPTS_FILE = path.join(__dirname, 'prompts.json');

// Default prompts
const DEFAULT_PROMPTS = {
  generateTitle: 'Generate a short title (3-6 words) for this note. Return ONLY the title, nothing else. No quotes, no punctuation at the end. Be descriptive.',
  summarize: 'Summarize the following note concisely in 2-3 sentences. Be factual and brief.',
  reflect: 'You are a thoughtful personal coach. Based on the following note, provide a brief reflection. What patterns do you notice? What might the person be feeling? Offer one gentle insight or question to consider. Keep it to 3-4 sentences.',
  extractActions: "Extract all action items, todos, or things that need doing from this note. For each action, if a specific date or deadline is mentioned (e.g., 'by Friday', 'due March 15', 'tomorrow'), include it as a due date in ISO format. Return ONLY a JSON array of objects with 'text' and 'dueDate' fields. dueDate should be null if no date is specified.\n\nExample output:\n[{\"text\":\"Buy milk\",\"dueDate\":null},{\"text\":\"Submit report\",\"dueDate\":\"2026-03-15T00:00:00Z\"},{\"text\":\"Call dentist tomorrow\",\"dueDate\":\"2026-05-03T00:00:00Z\"}]\n\nIf there are no action items, return []. Do not include any other text. Today's date is __TODAY__.",
  askSearch: 'Extract search keywords from this question. Return ONLY a comma-separated list of terms to grep for. No other text. Lowercase. Example: "what did I discuss with Sarah about the budget" → "sarah,budget,discuss,meeting,money,finance,q3,marketing"',
  askAnswer: "Answer based ONLY on the notes below. Cite notes by number (e.g., \"Note 1\"). Be concise. If the answer isn't there, say so.\n\nNOTES:\n__CONTEXT__",
};

async function getPrompts() {
  try {
    const raw = await fs.readFile(PROMPTS_FILE, 'utf-8');
    const user = JSON.parse(raw);
    return { ...DEFAULT_PROMPTS, ...user };
  } catch {
    return { ...DEFAULT_PROMPTS };
  }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Attachments storage
const ATTACH_DIR = path.join(__dirname, 'attachments');
const attachStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(ATTACH_DIR, req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + safe);
  },
});
const uploadAttach = multer({ storage: attachStorage, limits: { fileSize: 100 * 1024 * 1024 } });

const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || 'not-needed';
const AI_API_URL = process.env.AI_API_URL || process.env.OPENAI_BASE_URL || 'http://localhost:8080/v1/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'local-model';
const WHISPER_URL = process.env.WHISPER_API_URL || 'http://localhost:8081/inference';
const WHISPER_KEY = process.env.WHISPER_API_KEY || 'not-needed';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function readNote(id) {
  const filePath = path.join(NOTES_DIR, `${id}.md`);
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = matter(raw);
  return { id, ...parsed.data, content: parsed.content.trim(), raw };
}

async function writeNote(id, data, content) {
  const filePath = path.join(NOTES_DIR, `${id}.md`);
  const fm = {};
  // copy only known metadata keys, not content/raw/id
  for (const k of ['title','date','modified','tags','source','summary','reflection','actions']) {
    if (data[k] !== undefined) fm[k] = data[k];
  }
  const md = matter.stringify(content, fm);
  await fs.writeFile(filePath, md, 'utf-8');
}

async function listNotes() {
  try {
    const files = await fs.readdir(NOTES_DIR);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    const notes = [];
    for (const file of mdFiles) {
      try {
        const id = file.replace('.md', '');
        const note = await readNote(id);
        notes.push({
          id: note.id,
          title: note.title || 'Untitled',
          date: note.date || null,
          modified: note.modified || null,
          tags: note.tags || [],
          source: note.source || 'typed',
          summary: note.summary || null,
          contentPreview: note.content.substring(0, 150),
        });
      } catch (err) {
        console.error(`Error reading note ${file}:`, err.message);
      }
    }
    notes.sort((a, b) => new Date(b.modified || b.date) - new Date(a.modified || a.date));
    return notes;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// ── NOTE API ──────────────────────────────────────────────────────────

app.get('/api/notes', async (_req, res) => {
  try {
    res.json(await listNotes());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notes/:id', async (req, res) => {
  try {
    res.json(await readNote(req.params.id));
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : 500;
    res.status(code).json({ error: err.message });
  }
});

app.post('/api/notes', async (req, res) => {
  try {
    const { title, content, tags, source } = req.body;
    const id = uuidv4();
    const now = new Date().toISOString();
    const noteTitle = title || (content ? content.split('\n')[0].substring(0, 80) : 'Untitled');

    await writeNote(id, {
      title: noteTitle,
      date: now,
      modified: now,
      tags: tags || [],
      source: source || 'typed',
    }, content || '');

    res.json({ id, title: noteTitle, date: now, modified: now, tags: tags || [], content, source: source || 'typed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/notes/:id', async (req, res) => {
  try {
    const existing = await readNote(req.params.id);
    const { title, content, tags } = req.body;
    const now = new Date().toISOString();

    await writeNote(req.params.id, {
      title: title || existing.title,
      date: existing.date,
      modified: now,
      tags: tags || existing.tags || [],
      source: existing.source,
      summary: existing.summary,
      reflection: existing.reflection,
      actions: existing.actions,
    }, content !== undefined ? content : existing.content);

    res.json({ id: req.params.id, title: title || existing.title, modified: now });
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : 500;
    res.status(code).json({ error: err.message });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  try {
    await fs.unlink(path.join(NOTES_DIR, `${req.params.id}.md`));
    res.json({ deleted: true });
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : 500;
    res.status(code).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.json([]);

    const files = await fs.readdir(NOTES_DIR);
    const results = [];

    for (const file of files.filter(f => f.endsWith('.md'))) {
      const id = file.replace('.md', '');
      const raw = await fs.readFile(path.join(NOTES_DIR, file), 'utf-8');
      const lc = raw.toLowerCase();
      if (!lc.includes(q)) continue;

      const note = await readNote(id);
      const idx = lc.indexOf(q);
      const start = Math.max(0, idx - 50);
      const end = Math.min(raw.length, idx + q.length + 80);
      let snippet = raw.substring(start, end);
      if (start > 0) snippet = '…' + snippet;
      if (end < raw.length) snippet += '…';

      results.push({
        id: note.id,
        title: note.title || 'Untitled',
        date: note.date,
        snippet,
      });
    }

    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TODO API ──────────────────────────────────────────────────────────

async function readTodos() {
  try {
    const raw = await fs.readFile(TODOS_FILE, 'utf-8');
    return JSON.parse(raw).todos || [];
  } catch (err) {
    return [];
  }
}

async function writeTodos(todos) {
  await fs.writeFile(TODOS_FILE, JSON.stringify({ todos }, null, 2), 'utf-8');
}

app.get('/api/todos', async (_req, res) => {
  try {
    res.json(await readTodos());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/todos', async (req, res) => {
  try {
    await writeTodos(req.body.todos);
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SMART SEARCH (LLM → grep → LLM) ─────────────────────────────────

app.post('/api/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Question required' });

    // Step 1: Ask LLM for grep terms
    const prompts = await getPrompts();
    let grepTerms = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    try {
      const raw = await callAI(
        prompts.askSearch,
        question
      );
      const extraTerms = raw.split(/[,|\n]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
      grepTerms = [...new Set([...grepTerms, ...extraTerms])];
    } catch (err) {
      // LLM not available, just use question words
    }

    // Step 2: Grep notes for each term
    const files = await fs.readdir(NOTES_DIR);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    const results = [];

    for (const file of mdFiles) {
      const id = file.replace('.md', '');
      try {
        const raw = await fs.readFile(path.join(NOTES_DIR, file), 'utf-8');
        const lc = raw.toLowerCase();
        let score = 0;

        for (const term of grepTerms) {
          if (term.length < 3) continue;
          const matches = lc.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
          if (matches) score += matches.length;
        }
        if (lc.includes(question.toLowerCase())) score += 10;

        if (score > 0) {
          const note = await readNote(id);
          results.push({
            id,
            title: note.title || 'Untitled',
            date: note.date,
            content: note.content.substring(0, 2000),
            summary: note.summary || '',
            score,
          });
        }
      } catch (err) {
        // skip unreadable
      }
    }

    results.sort((a, b) => b.score - a.score);
    const topNotes = results.slice(0, 6);

    if (!topNotes.length) {
      return res.json({
        answer: `No notes matched. Tried: ${grepTerms.slice(0, 8).join(', ')}`,
        references: [],
        searchTerms: grepTerms.slice(0, 12),
        matchedCount: 0,
      });
    }

    // Step 3: Send context to LLM for answer
    const context = topNotes.map((n, i) =>
      `[Note ${i + 1}: "${n.title}" (${n.date ? new Date(n.date).toLocaleDateString() : 'unknown'})]\n${n.summary ? 'Summary: ' + n.summary + '\n' : ''}${n.content}`
    ).join('\n\n---\n\n');

    try {
      const answer = await callAI(
        prompts.askAnswer.replace('__CONTEXT__', context),
        question
      );
      res.json({
      answer,
      references: topNotes.map(n => ({ id: n.id, title: n.title, date: n.date })),
      searchTerms: grepTerms.slice(0, 12),
      matchedCount: results.length,
    });
    } catch (err) {
      // LLM not available — return raw grep results
      res.json({
        answer: `Found ${results.length} matching notes. Keywords: ${grepTerms.slice(0, 8).join(', ')}`,
        references: topNotes.map(n => ({ id: n.id, title: n.title, date: n.date })),
        searchTerms: grepTerms.slice(0, 12),
        matchedCount: results.length,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROMPTS API ──────────────────────────────────────────────────────

app.get('/api/prompts', async (_req, res) => {
  try {
    res.json(await getPrompts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/prompts', async (req, res) => {
  try {
    // Only save keys that differ from defaults
    const incoming = req.body || {};
    const custom = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (value && value !== DEFAULT_PROMPTS[key]) {
        custom[key] = value;
      }
    }
    await fs.writeFile(PROMPTS_FILE, JSON.stringify(custom, null, 2), 'utf-8');
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TRANSCRIPTION (whisper.cpp) ──────────────────────────────────────

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), 'recording.wav');
    formData.append('response_format', 'json');

    const headers = {};
    if (WHISPER_KEY && WHISPER_KEY !== 'not-needed') {
      headers['Authorization'] = `Bearer ${WHISPER_KEY}`;
    }

    const r = await fetch(WHISPER_URL, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Whisper error ${r.status}: ${err}`);
    }

    const data = await r.json();
    const text = data.text || '';

    // Also fallback: if it's an OpenAI-format response
    if (!text && data.choices?.[0]?.text) {
      res.json({ text: data.choices[0].text.trim() });
    } else {
      res.json({ text: text.trim() });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notes/:id/generate-title', async (req, res) => {
  try {
    const note = await readNote(req.params.id);
    if (!note.content.trim()) {
      return res.json({ title: '' });
    }

    const prompts = await getPrompts();
    const title = await callAI(
      req.body.systemPrompt || prompts.generateTitle,
      note.content.substring(0, 2000)
    );

    const cleanTitle = title.replace(/^["']|["']$/g, '').replace(/[.!]$/, '').trim().substring(0, 80);

    note.title = cleanTitle;
    note.modified = new Date().toISOString();
    await writeNote(req.params.id, note, note.content);

    res.json({ title: cleanTitle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI API ────────────────────────────────────────────────────────────

async function callAI(systemPrompt, userContent) {
  const headers = { 'Content-Type': 'application/json' };
  if (AI_API_KEY && AI_API_KEY !== 'not-needed') {
    headers['Authorization'] = `Bearer ${AI_API_KEY}`;
  }

  const res = await fetch(AI_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

app.post('/api/notes/:id/summarize', async (req, res) => {
  try {
    const note = await readNote(req.params.id);
    const prompts = await getPrompts();
    const summary = await callAI(
      req.body.systemPrompt || prompts.summarize,
      note.content
    );
    note.summary = summary;
    note.modified = new Date().toISOString();
    await writeNote(req.params.id, note, note.content);
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notes/:id/reflect', async (req, res) => {
  try {
    const note = await readNote(req.params.id);
    const prompts = await getPrompts();
    const reflection = await callAI(
      req.body.systemPrompt || prompts.reflect,
      note.content
    );
    note.reflection = reflection;
    note.modified = new Date().toISOString();
    await writeNote(req.params.id, note, note.content);
    res.json({ reflection });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notes/:id/actions', async (req, res) => {
  try {
    const note = await readNote(req.params.id);
    const prompts = await getPrompts();
    const text = await callAI(
      (req.body.systemPrompt || prompts.extractActions).replace('__TODAY__', new Date().toISOString().slice(0, 10)),
      note.content
    );

    let actions;
    try {
      actions = JSON.parse(text);
      if (!Array.isArray(actions)) actions = [];
      // Normalize: ensure each item has text field
      actions = actions.map(a => {
        if (typeof a === 'string') return { text: a, dueDate: null };
        return { text: a.text || a.action || '', dueDate: a.dueDate || a.due_date || a.due || null };
      }).filter(a => a.text);
    } catch {
      // Fallback: treat as plain list of strings
      actions = text.split('\n').map(l => l.replace(/^[\s\-*\d.]+/, '').trim()).filter(Boolean)
        .map(t => ({ text: t, dueDate: null }));
    }

    note.actions = actions;
    note.modified = new Date().toISOString();
    await writeNote(req.params.id, note, note.content);

    // Save actions to note metadata
    note.actions = actions;
    note.modified = new Date().toISOString();
    await writeNote(req.params.id, note, note.content);

    // Add new ones to global todos
    const existingTodos = await readTodos();
    const existingTexts = new Set(existingTodos.map(t => t.text.toLowerCase()));
    const now = new Date().toISOString();
    const newItems = actions.filter(a => !existingTexts.has(a.text.toLowerCase()));

    if (newItems.length > 0) {
      const newTodos = newItems.map(a => ({
        id: uuidv4(),
        text: a.text,
        done: false,
        createdAt: now,
        dueDate: a.dueDate || null,
        sourceNoteId: req.params.id,
        sourceNoteTitle: note.title || 'Untitled',
      }));
      await writeTodos([...existingTodos, ...newTodos]);
    }

    res.json({ actions, addedToTodos: newItems.map(a => a.text) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/attachments', express.static(ATTACH_DIR));

// ── ATTACHMENTS ──────────────────────────────────────────────────────

app.post('/api/notes/:id/attachments', uploadAttach.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const url = `/attachments/${req.params.id}/${req.file.filename}`;
  res.json({ url, filename: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype });
});

// ── EXPORT ───────────────────────────────────────────────────────────

app.get('/api/export', async (_req, res) => {
  try {
    const archive = archiver('zip', { zlib: { level: 5 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="everything-notes-${new Date().toISOString().slice(0, 10)}.zip"`);

    archive.on('error', (err) => { res.status(500).end(); throw err; });
    archive.pipe(res);

    // Add notes directory
    try {
      const files = await fs.readdir(NOTES_DIR);
      for (const file of files) {
        if (file.endsWith('.md')) {
          archive.file(path.join(NOTES_DIR, file), { name: `notes/${file}` });
        }
      }
    } catch (err) {
      // No notes yet
    }

    // Add todos
    try {
      await fs.access(TODOS_FILE);
      archive.file(TODOS_FILE, { name: 'todos.json' });
    } catch (err) {
      // No todos yet
    }

    await archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────

ensureDir(NOTES_DIR).then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log(`  ╔══════════════════════════════════════╗`);
    console.log(`  ║   Everything — Personal Diary App    ║`);
    console.log(`  ║   http://localhost:${PORT}              ║`);
    console.log(`  ║   Notes → ./notes/                   ║`);
    console.log(`  ║   LLM → ${AI_API_URL.split('/').slice(0,3).join('/')}                  ${' '.repeat(12)}║`);
    console.log(`  ║   Whisper → ${WHISPER_URL.split('/').slice(0,3).join('/')}               ${' '.repeat(10)}║`);
    console.log(`  ╚══════════════════════════════════════╝`);
    console.log('');
  });
});
