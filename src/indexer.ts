import { Notice, TFile, App } from 'obsidian';
import { DatabaseManager, ChunkRecord, FileRegistryRecord } from './db';
import EmbeddingViewerPlugin from './main';

export interface Chunk {
    embedText: string;
    content: string;
    startLine: number;
    endLine: number;
    heading: string | null;
}

export class Indexer {
    private isIndexing = false;
    private maxChunkSize: number;
    private prefix: string;
    private endpoint: string;
    private model: string;
    
    private fileIndexQueue: TFile[] = [];
    private isProcessingQueue = false;

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
        let stripped = text.replace(/!\[\[(.*?)\]\]/g, '$1');
        stripped = stripped.replace(/\[\[(.*?)\]\]/g, (match, p1) => {
            const parts = p1.split('|');
            return parts.length > 1 ? parts[1] : parts[0];
        });
        return stripped;
    }

    private getFrontmatterLineCount(content: string): number {
        const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        return m ? m[0].split(/\r?\n/).length - 1 : 0;
    }

    private buildHeadingMap(lines: string[]): Record<number, { hierarchy: string, mostRecent: string | null }> {
        const headingMap: Record<number, { hierarchy: string, mostRecent: string | null }> = {};
        const headingStack: { level: number, text: string }[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i] || '';
            const match = line.match(/^(#{1,6})\s+(.+)$/);
            if (match && match[1] && match[2]) {
                const level = match[1].length;
                const text = match[2];
                while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
                    headingStack.pop();
                }
                headingStack.push({ level, text });
            }
            headingMap[i] = {
                hierarchy: headingStack.length > 0 ? 'Hierarchy: ' + headingStack.map(h => h.text).join(' > ') : '',
                mostRecent: headingStack.length > 0 ? headingStack[headingStack.length - 1]!.text : null
            };
        }
        return headingMap;
    }

    private recursiveSplit(text: string, maxLen: number): string[] {
        if (text.length <= maxLen) return [text];
        const res: string[] = [];
        const lines = text.split('\n');
        let current = '';
        for (const line of lines) {
            if ((current.length + line.length + 1) > maxLen && current.length > 0) {
                res.push(current.trim());
                current = line + '\n';
            } else {
                current += line + '\n';
            }
        }
        if (current.trim().length > 0) {
            res.push(current.trim());
        }
        return res;
    }

    public extractChunks(content: string, file: TFile, excludedPhrases: string[] = []): Chunk[] {
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter?.['exclude_embedding'] === true) return [];

        const chunks: Chunk[] = [];
        const lines = content.split(/\r?\n/);
        const fmLineCount = this.getFrontmatterLineCount(content);
        const headingMap = this.buildHeadingMap(lines);

        const bodyText = lines.slice(fmLineCount).join('\n').trim();
        if (!bodyText) return [];

        const pieces: string[] = [];
        const codeBlockRegex = /(?:```|~~~)[\s\S]*?(?:```|~~~)/g;
        let lastIndex = 0;
        let matchCb;
        while ((matchCb = codeBlockRegex.exec(bodyText)) !== null) {
            const textBefore = bodyText.substring(lastIndex, matchCb.index).trim();
            if (textBefore) {
                pieces.push(...this.recursiveSplit(textBefore, this.maxChunkSize));
            }
            const codeBlockStr = matchCb[0];
            if (codeBlockStr.length > this.maxChunkSize) {
                const delimiter = codeBlockStr.startsWith('~~~') ? '~~~' : '```';
                const cbLines = codeBlockStr.split('\n');
                let curCbChunk = cbLines[0] + '\n';
                for (let i = 1; i < cbLines.length - 1; i++) {
                    const lineStr = cbLines[i] + '\n';
                    if ((curCbChunk.length + lineStr.length + delimiter.length) > this.maxChunkSize && curCbChunk.split('\n').length > 2) {
                        curCbChunk += delimiter;
                        pieces.push(curCbChunk);
                        curCbChunk = delimiter + '\n' + lineStr;
                    } else {
                        curCbChunk += lineStr;
                    }
                }
                curCbChunk += cbLines[cbLines.length - 1];
                pieces.push(curCbChunk);
            } else {
                pieces.push(codeBlockStr);
            }
            lastIndex = codeBlockRegex.lastIndex;
        }
        const textAfter = bodyText.substring(lastIndex).trim();
        if (textAfter) {
            pieces.push(...this.recursiveSplit(textAfter, this.maxChunkSize));
        }

        let currentSearchPos = 0;
        const searchContent = content.replace(/\r\n/g, '\n');
        
        for (const piece of pieces) {
            const trimmedPiece = piece.trim();
            if (!trimmedPiece) continue;
            
            const isCodeBlock = (trimmedPiece.startsWith('```') && trimmedPiece.endsWith('```')) || 
                                (trimmedPiece.startsWith('~~~') && trimmedPiece.endsWith('~~~'));
            if (!isCodeBlock) {
                const wordCount = trimmedPiece.split(/\s+/).filter(w => w.length > 0).length;
                if (wordCount < 8) continue;
            }
            
            const chunkIndex = searchContent.indexOf(piece, currentSearchPos);
            let startLine = 0;
            if (chunkIndex !== -1) {
                const textBefore = searchContent.substring(0, chunkIndex);
                startLine = textBefore.split('\n').length - 1;
                currentSearchPos = chunkIndex + piece.length;
            } else {
                startLine = fmLineCount;
            }
            
            const headingInfo = headingMap[startLine] || { hierarchy: '', mostRecent: null };
            let finalPieceText = this.stripWikilinks(piece);
            let filteredHierarchy = this.stripWikilinks(headingInfo.hierarchy);
            const excludeSet = new Set(excludedPhrases);
            
            if (!isCodeBlock) {
                finalPieceText = finalPieceText.split(/\r?\n/)
                    .filter(line => !excludeSet.has(line.trim().toLowerCase()))
                    .join('\n');
            }
                
            filteredHierarchy = filteredHierarchy.split(/\r?\n/)
                .filter(line => !excludeSet.has(line.trim().toLowerCase()))
                .join('\n');
            
            const embedText = (filteredHierarchy ? `${filteredHierarchy}\n\n` : '') + finalPieceText;
            
            chunks.push({
                embedText,
                content: finalPieceText.trim(),
                startLine,
                endLine: startLine + piece.split('\n').length - 1,
                heading: headingInfo.mostRecent
            });
        }

        return chunks;
    }

    public async deleteFile(path: string) {
        await this.dbManager.waitForLoad();
        if (this.isIndexing) return;
        this.dbManager.state.chunks = this.dbManager.state.chunks.filter(c => c.path !== path);
        delete this.dbManager.state.registry[path];
        await this.dbManager.saveDb();
    }

    public async queueFileForIndex(file: TFile) {
        if (file.extension !== 'md') return;
        if (this.plugin.settings.excludedFolders) {
            const excluded = this.plugin.settings.excludedFolders.split('\n').map(f => f.trim()).filter(f => f.length > 0);
            for (const ex of excluded) {
                if (file.path.startsWith(ex)) return;
            }
        }
        
        if (!this.fileIndexQueue.find(f => f.path === file.path)) {
            this.fileIndexQueue.push(file);
        }
        
        if (this.isIndexing) return;
        this.processQueue();
    }

    private async processQueue() {
        await this.dbManager.waitForLoad();
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        let dimension = 0;
        try {
            const probeResult = await this.embed(['probe']);
            dimension = probeResult[0]?.length || 0;
        } catch (e) {
            console.error("Probe failed in processQueue:", e);
            new Notice("Embedding server disconnected. Background indexing paused.");
            if (this.plugin.statusBarItem) this.plugin.statusBarItem.setText('');
            this.isProcessingQueue = false;
            return;
        }

        let processedCount = 0;

        while (this.fileIndexQueue.length > 0) {
            if (this.fileIndexQueue.length > (this.plugin.settings.bulkIndexThreshold || 20)) {
                this.fileIndexQueue = [];
                this.isProcessingQueue = false;
                if (this.plugin.statusBarItem) this.plugin.statusBarItem.setText('');
                this.rebuildIndex((msg) => {
                    if (this.plugin.statusBarItem) {
                        this.plugin.statusBarItem.setText(msg === null ? '' : `?? ${msg}`);
                    }
                });
                return;
            }

            const file = this.fileIndexQueue.shift();
            if (!file) continue;

            processedCount++;

            try {
                const content = await this.app.vault.read(file);
                const contentHash = this.hashString(content);
                
                const reg = this.dbManager.state.registry[file.path];
                if (reg) {
                    if (reg.hash === contentHash && reg.chunk_size === this.maxChunkSize && reg.prefix === this.prefix) {
                        if (Math.floor(Number(reg.mtime)) !== Math.floor(file.stat.mtime)) {
                            reg.mtime = Math.floor(file.stat.mtime);
                        }
                        continue;
                    }
                }

                if (this.plugin.statusBarItem) {
                    this.plugin.statusBarItem.setText(`?? Indexing ${file.basename}...`);
                }

                // Delete old embeddings for this file
                this.dbManager.state.chunks = this.dbManager.state.chunks.filter(c => c.path !== file.path);
                
                const chunks = this.extractChunks(content, file, this.plugin.settings.lastExcludedPhrases);
                
                this.dbManager.state.registry[file.path] = {
                    path: file.path,
                    mtime: Math.floor(file.stat.mtime),
                    hash: contentHash,
                    chunk_size: this.maxChunkSize,
                    prefix: this.prefix
                };

                if (chunks.length === 0) continue;

                const BATCH_SIZE = Math.max(1, this.plugin.settings.batchSize || 50);

                for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
                    const batch = chunks.slice(i, i + BATCH_SIZE);
                    const embeddings = await this.embed(batch.map(p => {
                        const text = `${this.prefix}${p.embedText}`;
                        return text.length > 4000 ? text.substring(0, 4000) : text;
                    }), dimension);
                    
                    for (let j = 0; j < batch.length; j++) {
                        const p = batch[j] as Chunk;
                        const emb = embeddings[j];
                        if (!emb) continue;
                        
                        this.dbManager.state.chunks.push({
                            path: file.path,
                            mtime: Math.floor(file.stat.mtime),
                            content: p.content,
                            model: this.model,
                            dimension: dimension,
                            vector: new Float32Array(emb),
                            metadata: {
                                startLine: p.startLine, 
                                endLine: p.endLine, 
                                heading: p.heading,
                                chunkSize: this.maxChunkSize,
                                prefix: this.prefix,
                                fileHash: contentHash
                            }
                        });
                    }
                    await new Promise(r => window.setTimeout(r, 10)); // yield
                }
            } catch (err) {
                console.error(`Error indexing file ${file.path}:`, err);
            }
        } // End of while loop
        
        await this.dbManager.saveDb();

        this.isProcessingQueue = false;
        if (this.plugin.statusBarItem) this.plugin.statusBarItem.setText('');
        
        this.plugin.updateFileExplorer();
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            this.plugin.updateFileStatus(activeFile);
        }
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
            const excluded = this.plugin.settings.excludedFolders
                .split('\n')
                .map(f => f.trim())
                .filter(f => f.length > 0);

            const files = allFiles.filter(f => {
                if (f.name === 'profiler.md' || f.path === 'profiler.md') return false;
                for (const ex of excluded) {
                    if (f.path.startsWith(ex)) return false;
                }
                return true;
            });

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

            const toIndex: TFile[] = [];
            for (const file of files) {
                const reg = this.dbManager.state.registry[file.path];
                if (!reg) {
                    toIndex.push(file);
                } else if (reg.chunk_size !== this.maxChunkSize || reg.prefix !== this.prefix) {
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
                    prefix: this.prefix
                };

                for (const chunk of chunks) {
                    allChunks.push({ file, chunk, contentHash });
                }
            }

            for (let j = 0; j < allChunks.length; j += BATCH_SIZE) {
                updateProgress(`Embedding chunk ${j + 1}/${allChunks.length}...`);
                const batch = allChunks.slice(j, j + BATCH_SIZE);
                
                const embeddings = await this.embed(batch.map(item => {
                    const text = `${this.prefix}${item.chunk.embedText}`;
                    return text.length > 4000 ? text.substring(0, 4000) : text;
                }), dimension);
                
                for (let k = 0; k < batch.length; k++) {
                    const item = batch[k];
                    const emb = embeddings[k];
                    if (!item || !emb) continue;
                    
                    this.dbManager.state.chunks.push({
                        path: item.file.path,
                        mtime: Math.floor(item.file.stat.mtime),
                        content: item.chunk.content,
                        model: this.model,
                        dimension: dimension,
                        vector: new Float32Array(emb),
                        metadata: {
                            startLine: item.chunk.startLine, 
                            endLine: item.chunk.endLine, 
                            heading: item.chunk.heading,
                            chunkSize: this.maxChunkSize,
                            prefix: this.prefix,
                            fileHash: item.contentHash
                        }
                    });
                    totalChunks++;
                }
                
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
        }
    }
}
