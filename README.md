# Obsidian Embedding Viewer Plugin

A local semantic search and related notes plugin for Obsidian. Uses **PGlite** and **pgvector** (via IndexedDB) to maintain an index of your vault's semantic embeddings and provides inline visualization of similar notes directly within your editor.

## Features

- **Inline Similar Notes**: Automatically view semantically similar notes in a sidebar panel.
- **Semantic Search on Selection**: Highlight any text, right-click, and select "Find similar notes for selection" to see related notes in a modal.
- **Hover Tooltips**: Select text in edit or reading mode to see similar snippets in a tooltip. In edit mode, you can insert a wikilink directly from the tooltip.
- **Local Querying**: Queries a locally bundled PGlite WASM database. You do not need a running embedding server to view similar notes after indexing.
- **Recency Penalty**: Older notes receive a configurable similarity penalty to keep results fresh.
- **Link Penalty**: Notes already linked to/from the active note are penalized to surface new connections.
- **Custom Markdown Chunking**: Splits files by headings and paragraphs for high-quality embeddings.
- **Chunk Visualizer**: Toggle a command to visually highlight how your notes are chunked in the editor.
- **Local HTTP API**: Exposes `/search` and `/rebuild` endpoints on localhost for external tools.
- **Auto-Launch Server**: Configure a terminal command in settings to automatically start your embedding server when Obsidian opens.

## Installation

### From Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/jjjpanda/embedding-viewer/releases).
2. Create a folder at `<your-vault>/.obsidian/plugins/embedding-viewer/`.
3. Copy the downloaded files into that folder.
4. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

### From Source

1. Clone this repository.
2. Create a `.env` file in the project root (see `.env.example`).
3. Run `npm install` then `npm run build`.
4. The build script copies artifacts into your vault's plugin directory automatically.
5. Reload Obsidian and enable the plugin.

## Embedding Server

> **llama.cpp Only (For Now)**
> This plugin requires a local [llama.cpp](https://github.com/ggml-org/llama.cpp) embedding server running an OpenAI-compatible `/v1/embeddings` endpoint (default: `http://127.0.0.1:8081`). The endpoint, model name, and embedding prefix are all configurable in settings.

You can configure an **On-Launch Command** in settings to start the server automatically when Obsidian loads.

## Usage

1. Open the command palette (Cmd/Ctrl + P).
2. Run **Embedding Viewer: Rebuild vault index** to index your vault.
3. Open any indexed note and click the network icon in the ribbon to open the **Similar Notes** panel.
4. **Highlight text** and right-click to search for semantically similar chunks.
5. Use **Toggle Chunk Visualizer** to see how the current note is split into chunks.

## HTTP API

The plugin runs an HTTP server (default port `27123`, localhost only) for external tools.

- **GET** `http://localhost:27123/search?q=your+query&limit=5`
- **POST** `http://localhost:27123/search` — Body: `{ "query": "text", "limit": 5, "excludePath": "path/to/exclude.md" }`
- **POST** `http://localhost:27123/rebuild` — Optionally pass `?force=true`

## How It Works

When you open a note, the plugin queries an IndexedDB-backed PGlite vector database for the pre-calculated embeddings of the active file. It runs a pgvector cosine distance search across the vault's chunks, sorts them by similarity (with recency and link penalties applied), and displays the top results in a sidebar panel.

## Development

- `npm run dev` — start compilation in watch mode.
- `npm run lint` — run ESLint.
- PGlite's WASM dependencies are handled automatically by a custom esbuild configuration.

## License

[MIT](LICENSE)
