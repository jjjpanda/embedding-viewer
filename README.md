# Obsidian Embedding Viewer Plugin

A powerful, entirely local semantic search and related notes plugin for Obsidian. It uses **PGlite** and **pgvector** to maintain an index of your vault's semantic embeddings and provides inline visualization of similar notes directly within your editor.

## Features

- **Inline Similar Notes**: Automatically view semantically similar notes at the bottom of the active note.
- **Semantic Search on Selection**: Highlight any text in your editor, right-click, and select "Find similar notes for selection" to instantly see related notes in a modal.
- **Lightning Fast Local Querying**: When viewing notes, it queries a locally bundled `PGlite` WASM database for the active note's existing vector. **You do not need to run an embedding server to view similar notes.**
- **Smart Age Penalization**: Older notes have a slight penalty applied to their similarity scores, keeping your results fresh and relevant.
- **Custom Markdown Chunking**: Intelligently splits your files by frontmatter, headings, and paragraphs for high-quality embedding indexing.
- **Chunk Visualizer**: Toggle a command to visually highlight how your notes are being chunked in the editor.
- **Local HTTP API**: The plugin runs a lightweight HTTP server inside Obsidian, exposing `/search` and `/rebuild` endpoints so external tools or scripts can semantically search your vault.
- **Auto-Launch Server**: Configure a terminal command in settings to automatically start your embedding server when Obsidian opens.

## Setup & Requirements

### 1. The Embedding Server (For Indexing & Selection Search)
> [!WARNING] **llama.cpp Only (For Now)**
> Currently, this plugin **only** supports the local `llama.cpp` embedding API. It assumes you are running a [llama.cpp embedding server](https://github.com/jjjpanda/llama-cpp-scripts) at `http://127.0.0.1:8081` (configurable in settings). Support for other APIs (like OpenAI or Ollama) may be added in the future.

**Note:** You can configure the **On-Launch Command** in the plugin settings to automatically start this server in the background when Obsidian launches.

### 2. Installation
*This plugin is not yet published to the community directory.* To install manually:

1. Clone this repository anywhere on your computer.
2. Create a `.env` file in the root of the project with your vault path:
   ```env
   OBSIDIAN_VAULT_PATH=/path/to/your/vault
   ```
3. Ensure you have Node.js (v18+) installed.
4. Run `npm install` to install dependencies.
5. Run `npm run build` to compile the plugin. The build script will automatically copy the generated files directly into your specified vault's `.obsidian/plugins/embedding-viewer/` directory.
6. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Usage

1. Open the Obsidian command palette (Cmd/Ctrl + P).
2. Run **Embedding Viewer: Rebuild Vault Index**.
   - This will read all new and modified markdown files, chunk them, embed them using the local server, and save the vectors to a `PGlite` database at `.smtcmp_skill_index.tar.gz` in your vault root.
3. Open any indexed note to see a **Similar Notes** section at the bottom.
4. **Highlight text** and right-click to search the vault for semantically similar chunks.
5. Use the **Toggle Chunk Visualizer** command to see how your current note is split.

## HTTP API

The plugin runs an HTTP server (default port `27123`) to allow external applications to search your vault.
- **GET** `http://localhost:27123/search?q=your+query&limit=5`
- **POST** `http://localhost:27123/search` (Body: `{ "query": "text", "limit": 5, "excludePath": "path/to/exclude.md" }`)
- **POST** `http://localhost:27123/rebuild` (Optionally pass `?force=true`)

## How it works

When you open a note, the plugin queries the `.smtcmp_skill_index.tar.gz` vector database for the pre-calculated embedding of the active file. It averages the vectors for the document, runs a `pgvector` cosine distance search across the rest of the vault's chunks, sorts them by similarity (with an age penalty applied), and injects the top results directly into the CodeMirror editor view.

## Development

- `npm run dev` to start compilation in watch mode.
- PGlite's WASM dependencies are handled automatically by a custom `esbuild` configuration that modifies Node module resolution to work seamlessly within Obsidian's environment.
