# Everything

A personal diary app that captures everything you do — voice transcriptions, typed notes, drag-and-drop files. All saved as plain markdown files you can grep and search with any tool.

With a local LLM (llama.cpp) and whisper.cpp running, it auto-generates titles, summaries, reflections, and extracts action items from your notes.

## Features

- **Write notes** — markdown editor with live preview (split view)
- **Voice transcription** — record audio, whisper.cpp transcribes it directly into your note
- **Drag & drop** — drop text files to import, drop images/files to attach inline
- **Smart search** — ask natural language questions, LLM finds relevant notes and answers
- **AI pipeline** — press Save to auto-generate title, summary, reflection, and extract todo items
- **Global todo list** — AI-extracted actions automatically added
- **Plain markdown files** — every note is `{uuid}.md` with YAML frontmatter, grep-able
- **Export** — download all notes as a zip

## Setup

### macOS / Linux

```bash
npm install
brew install llama.cpp          # or build from source
npm run setup                   # downloads models from Hugging Face
```

### Windows

```powershell
npm install
npm run setup:win               # downloads llama.cpp, whisper.cpp & models
```

> `setup:win` fetches the latest Windows binaries from llama.cpp/whisper.cpp releases automatically.

### Custom model

```bash
# Override the default model:
LLM_REPO=unsloth/gemma-4-E4B-it-GGUF LLM_FILE=gemma-4-e4b-it-Q4_K_M.gguf npm run setup
```

## Running

### macOS / Linux

```bash
# Terminal 1: Start LLM + whisper servers
npm run serve

# Terminal 2: Start the app
npm start
```

### Windows

```powershell
# Terminal 1: Start servers
npm run serve:win

# Terminal 2: Start the app
npm start
```

Open **http://localhost:3456**

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | App port |
| `AI_API_URL` | `http://localhost:8080/v1/chat/completions` | LLM endpoint |
| `AI_API_KEY` | `not-needed` | LLM API key |
| `AI_MODEL` | `local-model` | Model name |
| `WHISPER_API_URL` | `http://localhost:8081/inference` | Whisper endpoint |
| `WHISPER_API_KEY` | `not-needed` | Whisper API key |

## Storage

```
notes/               # Markdown notes with YAML frontmatter
attachments/         # Uploaded files organized by note ID
todos.json           # Global todo list with dates
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘N` | New note |
| `⌘S` | Save + run AI pipeline |
| `⌘K` | Focus search |

## License

MIT
