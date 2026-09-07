import { Notice, TFile, App } from 'obsidian';
import { DatabaseManager } from './db';
import EmbeddingViewerPlugin from './main';
import { Chunk, MarkdownChunker } from './chunker';

export type { Chunk };

export class Indexer {
    private isIndexing = false;
    private maxChunkSize: number;
    private prefix: string;
    private endpoint: string;
    private model: string;
    
    private fileIndexQueue: TFile[] = [];
    private forceIndexPaths = new Set<string>();
    private isProcessingQueue = false;
    private activeQueuePromise: Promise<void> | null = null;

    constructor(private app: App, private dbManager: DatabaseManager, private plugin: EmbeddingViewerPlugin) {
        this.maxChunkSize = this.plugin.settings.chunkSize || 500;
        this.prefix = this.plugin.settings.embeddingPrefix || '';
        this.endpoint = this.plugin.settings.embeddingEndpoint || 'http://localhost:11434';
        this.model = this.plugin.settings.embeddingModel || 'nomic-embed-text';
    }

    public updateSettings() {
        this.maxChunkSize = this.plugin.settings.chunkSize || 500;
        this.prefix = this.plugin.settings.embeddingPrefix || '';
        this.endpoint = this.plugin.settings.embeddingEndpoint || 'http://localhost:11434';
        this.model = this.plugin.settings.embeddingModel || 'nomic-embed-text';
    }

    public async embed(texts: string[], dimension?: number): Promise<number[][]> {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 30000); // 30 seconds timeout
        try {
            const res = await fetch(`${this.endpoint}/v1/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.model, input: texts, encoding_format: 'float' }),
                signal: controller.signal
            });
            if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
            const { data } = await res.json();
            return data.map((d: any) => d.embedding);
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(16);
    }

    public stripWikilinks(text: string): string {
        return MarkdownChunker.stripWikilinks(text);
    }

    public extractChunks(content: string, file: TFile, excludedPhrases: string[] = []): Chunk[] {
        const cache = this.app.metadataCache.getFileCache(file);
        const isExcluded = cache?.frontmatter?.['exclude_embedding'] === true;
        return MarkdownChunker.extractChunks(content, this.maxChunkSize, excludedPhrases, isExcluded);
    }

    public async deleteFile(path: string) {
        await this.dbManager.waitForLoad();
        if (this.isIndexing) return;
        this.dbManager.state.chunks = this.dbManager.state.chunks.filter(c => c.path !== path);
        delete this.dbManager.state.registry[path];
        await this.dbManager.saveDb();
    }

    public async queueFileForIndex(file: TFile, force: boolean = false): Promise<void> {
        if (file.extension !== 'md') return;
        if (this.plugin.isFileExcluded(file)) return;
        
        if (force) {
            this.forceIndexPaths.add(file.path);
        }

        if (!this.fileIndexQueue.find(f => f.path === file.path)) {
            this.fileIndexQueue.push(file);
        }
        
        if (this.isIndexing) return;
        while (this.fileIndexQueue.length > 0) {
            if (!this.activeQueuePromise) {
                this.activeQueuePromise = this.processQueue().finally(() => {
                    this.activeQueuePromise = null;
                });
            }
            await this.activeQueuePromise;
        }
    }

    private async processQueue() {
        await this.dbManager.waitForLoad();
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        try {
            let dimension = 0;
            try {
                const probeResult = await this.embed(['probe']);
                dimension = probeResult[0]?.length || 0;
            } catch (e) {
                console.error("Probe failed in processQueue:", e);
                new Notice("Embedding server disconnected. Background indexing paused.");
                if (this.plugin.statusBarItem) this.plugin.statusBarItem.setText('');
                this.fileIndexQueue = [];
                return;
            }

            let processedCount = 0;

            while (this.fileIndexQueue.length > 0) {
                if (this.fileIndexQueue.length > (this.plugin.settings.bulkIndexThreshold || 20)) {
                    this.fileIndexQueue = [];
                    if (this.plugin.statusBarItem) this.plugin.statusBarItem.setText('');
                    this.rebuildIndex((msg) => {
                        this.plugin.updateFileStatus(null, msg || undefined);
                    });
                    return;
                }

                const file = this.fileIndexQueue.shift();
                if (!file) continue;

                const isForced = this.forceIndexPaths.has(file.path);
                this.forceIndexPaths.delete(file.path);

                processedCount++;

                try {
                    const content = await this.app.vault.read(file);
                    const contentHash = this.hashString(content);
                    const hasExclusions = (this.plugin.settings.lastExcludedPhrases || []).length > 0;
                    const exclusionHash = this.hashString((this.plugin.settings.lastExcludedPhrases || []).join('\n'));
                    const expectedExclusionHash = hasExclusions ? exclusionHash : '';
                    
                    const reg = this.dbManager.state.registry[file.path];
                    if (reg && !isForced) {
                        const currentExclusionHash = reg.excluded_hash || '';
                        if (reg.hash === contentHash && reg.chunk_size === this.maxChunkSize && reg.prefix === this.prefix && currentExclusionHash === expectedExclusionHash) {
                            if (Math.floor(Number(reg.mtime)) !== Math.floor(file.stat.mtime)) {
                                reg.mtime = Math.floor(file.stat.mtime);
                            }
                            continue;
                        }
                    }

                    if (this.plugin.statusBarItem) {
                        this.plugin.statusBarItem.setText(`🧠 Indexing ${file.basename}...`);
                    }

                    // Delete old embeddings for this file
                    this.dbManager.state.chunks = this.dbManager.state.chunks.filter(c => c.path !== file.path);
                    
                    const chunks = this.extractChunks(content, file, this.plugin.settings.lastExcludedPhrases);
                    
                    this.dbManager.state.registry[file.path] = {
                        path: file.path,
                        mtime: Math.floor(file.stat.mtime),
                        hash: contentHash,
                        chunk_size: this.maxChunkSize,
                        prefix: this.prefix,
                        excluded_hash: expectedExclusionHash
                    };

                    if (chunks.length === 0) continue;

                    const fileChunks = chunks.map(chunk => ({ file, chunk, contentHash }));
                    const BATCH_SIZE = Math.max(1, this.plugin.settings.batchSize || 50);

                    for (let i = 0; i < fileChunks.length; i += BATCH_SIZE) {
                        const batch = fileChunks.slice(i, i + BATCH_SIZE);
                        await this.storeChunkBatch(batch, dimension);
                        await new Promise(r => window.setTimeout(r, 10)); // yield
                    }
                } catch (err) {
                    console.error(`Error indexing file ${file.path}:`, err);
                }
            } // End of while loop
            
            this.dbManager.requestDebouncedSave(10000);

            if (this.plugin.statusBarItem) this.plugin.statusBarItem.setText('');
            
            this.plugin.updateFileExplorer();
            const activeFile = this.app.workspace.getActiveFile();
            this.plugin.updateFileStatus(activeFile ?? null);
            this.plugin.refreshSimilarViews();
        } finally {
            this.isProcessingQueue = false;
        }
    }

    public async storeChunkBatch(
        batch: { file: TFile, chunk: Chunk, contentHash: string }[],
        dimension: number
    ): Promise<number> {
        const embeddings = await this.embed(batch.map(item => {
            const text = `${this.prefix}${item.chunk.embedText}`;
            return text.length > 4000 ? text.substring(0, 4000) : text;
        }), dimension);

        let stored = 0;
        for (let k = 0; k < batch.length; k++) {
            const item = batch[k];
            const emb = embeddings[k];
            if (!item || !emb) continue;

            const vector = this.dbManager.normalizeVector(new Float32Array(emb));
            this.dbManager.state.chunks.push({
                path: item.file.path,
                mtime: Math.floor(item.file.stat.mtime),
                content: item.chunk.content,
                model: this.model,
                dimension: dimension,
                vector,
                metadata: {
                    startLine: item.chunk.startLine,
                    endLine: item.chunk.endLine,
                    heading: item.chunk.heading,
                    chunkSize: this.maxChunkSize,
                    prefix: this.prefix,
                    fileHash: item.contentHash
                }
            });
            stored++;
        }
        return stored;
    }

    public async rebuildIndex(updateProgress: (msg: string | null) => void, force: boolean = false) {
        await this.dbManager.waitForLoad();
        if (this.isIndexing) return;
        this.isIndexing = true;

        try {
            updateProgress('Starting index rebuild...');
            
            if (force) {
                updateProgress(`Force rebuilding index...`);
                new Notice(`Force rebuilding index...`);
                await this.dbManager.resetData();
            }

            const allFiles = this.app.vault.getMarkdownFiles();
            const files = allFiles.filter(f => !this.plugin.isFileExcluded(f));

            const currentPaths = new Set(files.map(f => f.path));
            let pathsToDelete: string[] = [];
            for (const path of Object.keys(this.dbManager.state.registry)) {
                if (!currentPaths.has(path)) {
                    pathsToDelete.push(path);
                }
            }
            if (pathsToDelete.length > 0) {
                this.dbManager.state.chunks = this.dbManager.state.chunks.filter(c => !pathsToDelete.includes(c.path));
                pathsToDelete.forEach(p => delete this.dbManager.state.registry[p]);
            }

            const hasExclusions = (this.plugin.settings.lastExcludedPhrases || []).length > 0;
            const exclusionHash = this.hashString((this.plugin.settings.lastExcludedPhrases || []).join('\n'));
            const expectedExclusionHash = hasExclusions ? exclusionHash : '';
            const toIndex: TFile[] = [];
            for (const file of files) {
                const reg = this.dbManager.state.registry[file.path];
                if (!reg) {
                    toIndex.push(file);
                } else if (reg.chunk_size !== this.maxChunkSize || reg.prefix !== this.prefix) {
                    toIndex.push(file);
                } else if ((reg.excluded_hash || '') !== expectedExclusionHash) {
                    toIndex.push(file);
                } else {
                    const mtime = Math.floor(file.stat.mtime);
                    if (reg.mtime < mtime) {
                        try {
                            const content = await this.app.vault.read(file);
                            const contentHash = this.hashString(content);
                            if (contentHash !== reg.hash) {
                                toIndex.push(file);
                            } else {
                                reg.mtime = mtime;
                            }
                        } catch (e) {
                            console.warn(`[Embedding Viewer] Could not read file ${file.path}:`, e);
                        }
                    }
                }
            }

            if (toIndex.length === 0) {
                new Notice("All files are up to date.");
                updateProgress(null);
                await this.dbManager.saveDb();
                return;
            }

            new Notice(`Found ${toIndex.length} files to index.`);
            
            let dimension = 0;
            try {
                updateProgress('Probing embedding dimension...');
                const probeResult = await this.embed(['probe']);
                dimension = probeResult[0]?.length || 0;
            } catch (e) {
                new Notice("Embedding server disconnected. Start server and try again.");
                throw e;
            }

            let totalChunks = 0;
            const BATCH_SIZE = Math.max(1, this.plugin.settings.batchSize || 50);
            
            const allChunks: { file: TFile, chunk: Chunk, contentHash: string }[] = [];

            for (let i = 0; i < toIndex.length; i++) {
                const file = toIndex[i] as TFile;
                if (i % 50 === 0) {
                    updateProgress(`Parsing file ${i + 1}/${toIndex.length} (${file.basename})...`);
                    await new Promise(r => window.setTimeout(r, 0)); // yield
                }
                
                let content = '';
                try {
                    content = await this.app.vault.read(file);
                } catch (e) {
                    console.warn(`[Embedding Viewer] Could not read file ${file.path} for indexing:`, e);
                    continue;
                }
                const contentHash = this.hashString(content);
                
                // Remove old chunks
                this.dbManager.state.chunks = this.dbManager.state.chunks.filter(c => c.path !== file.path);
                
                const chunks = this.extractChunks(content, file, this.plugin.settings.lastExcludedPhrases);
                
                this.dbManager.state.registry[file.path] = {
                    path: file.path,
                    mtime: Math.floor(file.stat.mtime),
                    hash: contentHash,
                    chunk_size: this.maxChunkSize,
                    prefix: this.prefix,
                    excluded_hash: expectedExclusionHash
                };

                for (const chunk of chunks) {
                    allChunks.push({ file, chunk, contentHash });
                }
            }

            for (let j = 0; j < allChunks.length; j += BATCH_SIZE) {
                updateProgress(`Embedding chunk ${j + 1}/${allChunks.length}...`);
                const batch = allChunks.slice(j, j + BATCH_SIZE);
                const stored = await this.storeChunkBatch(batch, dimension);
                totalChunks += stored;
                
                // Periodically save to avoid losing all progress if user reloads app
                if (j % 2000 === 0 && j > 0) {
                    await this.dbManager.saveDb();
                }
                
                await new Promise(r => window.setTimeout(r, 10)); // yield
            }

            updateProgress(`Saving index...`);
            await this.dbManager.saveDb();
            
            new Notice(`Indexed ${totalChunks} chunks from ${toIndex.length} files.`);
            updateProgress(`Indexed ${toIndex.length} files.`);
            window.setTimeout(() => updateProgress(null), 3000);

        } catch (err) {
            console.error(err);
            new Notice('Error during index rebuild. See console.');
            updateProgress(null);
        } finally {
            this.isIndexing = false;
            if (this.plugin.statusBarItem) {
                this.plugin.statusBarItem.setText('');
            }
            
            this.plugin.updateFileExplorer();
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                this.plugin.updateFileStatus(activeFile);
            }
            this.plugin.refreshSimilarViews();
        }
    }
}
