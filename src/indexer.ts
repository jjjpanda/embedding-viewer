import { App, TFile, Notice } from 'obsidian';
import { DatabaseManager } from './db';
import EmbeddingViewerPlugin from './main';
import { Transaction } from '@electric-sql/pglite';

export interface Chunk {
    embedText: string;
    content: string;
    startLine: number;
    endLine: number;
    heading: string | null;
}

export class Indexer {
    public isIndexing = false;
    private schemaVerified = false;

    constructor(
        private app: App,
        private dbManager: DatabaseManager,
        private plugin: EmbeddingViewerPlugin
    ) {}

    private get model() { return this.plugin.settings.embeddingModel; }
    private get endpoint() { return this.plugin.settings.embeddingEndpoint; }
    private get prefix() { return this.plugin.settings.embeddingPrefix; }
    private get maxChunkSize() { return Number(this.plugin.settings.chunkSize) || 250; }

    public stripWikilinks(text: string) {
        return text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
            if (alias && alias !== target) {
                return `${alias} (${target})`;
            }
            return target;
        });
    }

    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0, len = str.length; i < len; i++) {
            let chr = str.charCodeAt(i);
            hash = (hash << 5) - hash + chr;
            hash |= 0;
        }
        return hash.toString();
    }

    private recursiveSplit(text: string, maxChunkSize: number): string[] {
        if (text.length <= maxChunkSize) return [text];
        
        const separators = ['\n\n\n', '\n\n', '\n', '. ', ' '];
        for (const sep of separators) {
            if (text.includes(sep)) {
                const parts = text.split(sep);
                const chunks: string[] = [];
                let currentChunk = '';
                
                for (const part of parts) {
                    const proposed = currentChunk ? currentChunk + sep + part : part;
                    if (proposed.length <= maxChunkSize) {
                        currentChunk = proposed;
                    } else {
                        if (currentChunk) chunks.push(currentChunk);
                        currentChunk = part;
                    }
                }
                if (currentChunk) chunks.push(currentChunk);
                
                const finalChunks: string[] = [];
                for (const c of chunks) {
                    if (c.length > maxChunkSize && c !== text) {
                        finalChunks.push(...this.recursiveSplit(c, maxChunkSize));
                    } else {
                        finalChunks.push(c);
                    }
                }
                
                if (finalChunks.length > 1 || (finalChunks.length === 1 && finalChunks[0] !== text)) {
                    return finalChunks;
                }
            }
        }
        
        const chunks = [];
        for (let i = 0; i < text.length; i += maxChunkSize) {
            chunks.push(text.slice(i, i + maxChunkSize));
        }
        return chunks;
    }

    private formatMetadataContext(file: TFile): string {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter) return '';
        
        const parts: string[] = [];
        for (const [key, value] of Object.entries(cache.frontmatter)) {
            if (key === 'position') continue;
            
            if (typeof value === 'string') {
                parts.push(`${key.charAt(0).toUpperCase() + key.slice(1)}: ${value}`);
            } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
                parts.push(`${key.charAt(0).toUpperCase() + key.slice(1)}: ${value.join(', ')}`);
            }
        }
        
        if (parts.length === 0) return '';
        return 'Metadata: ' + parts.join('. ') + '.';
    }

    private async analyzeCommonPhrases(files: TFile[], progressCallback?: (msg: string | null) => void): Promise<string[]> {
        if (files.length === 0) return [];
        if (progressCallback) progressCallback('Analyzing common phrases...');
        
        const counts = new Map<string, number>();
        
        // Prevent OOM: sample up to 100 random files
        const maxSamples = Math.min(files.length, 100);
        const shuffled = [...files].sort(() => 0.5 - Math.random());
        const sampleFiles = shuffled.slice(0, maxSamples);

        for (const file of sampleFiles) {
            let content = await this.app.vault.read(file);
            content = this.stripWikilinks(content);
            const lines = content.split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(l => l.length > 0);
            
            const fileLines = new Set<string>(lines);
            for (const line of fileLines) {
                counts.set(line, (counts.get(line) || 0) + 1);
            }
            await new Promise(resolve => window.setTimeout(resolve, 0)); // yield to UI
        }
        
        // Phrases that appear in > 10% of sampled files or at least 5 files
        const threshold = Math.max(5, Math.floor(sampleFiles.length * 0.10));
        
        const common: string[] = [];
        for (const [phrase, count] of counts.entries()) {
            if (count >= threshold) {
                common.push(phrase);
            }
        }
        
        common.sort((a, b) => b.length - a.length);
        return common;
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

    public extractChunks(content: string, file: TFile, excludedPhrases: string[] = []): Chunk[] {
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter?.['exclude_embedding'] === true) return [];

        const chunks: Chunk[] = [];
        const lines = content.split(/\r?\n/);
        
        const fmLineCount = this.getFrontmatterLineCount(content);
        const headingMap = this.buildHeadingMap(lines);

        // 3. Get the body text
        const bodyText = lines.slice(fmLineCount).join('\n').trim();
        if (!bodyText) return [];

        // 4. Split body text handling code blocks separately
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
                // Split large code block by double newlines or single newlines
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

        // 5. Construct chunks, finding their line numbers
        let currentSearchPos = 0;
        const searchContent = content.replace(/\r\n/g, '\n');
        const prefixStr = this.prefix ? this.prefix + '\n' : '';
        
        for (const piece of pieces) {
            const trimmedPiece = piece.trim();
            if (!trimmedPiece) continue;
            
            // Enforce minimum word count to drop semantic noise (unless code block)
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

    async rebuildIndex(progressCallback?: (msg: string | null) => void, force: boolean = false) {
        if (this.isIndexing) return;
        this.isIndexing = true;
        try {
            await this._rebuildIndex(progressCallback, force);
        } finally {
            this.isIndexing = false;
            if (this.fileIndexQueue.length > 0) {
                this.processQueue();
            }
        }
    }

    private async _rebuildIndex(progressCallback?: (msg: string | null) => void, force: boolean = false) {
        const updateProgress = (msg: string | null) => {
            if (progressCallback) progressCallback(msg);
        };

        let db = await this.dbManager.getDb();
        if (!db) return;

        try {
            updateProgress('Starting index rebuild...');
            new Notice('Starting index rebuild...');
            
            let dimension: number;
            try {
                const probeResult = await this.embed(['probe']);
                dimension = probeResult[0]?.length || 0;
            } catch (err) {
                new Notice('Failed to connect to embedding server.');
                console.error(err);
                updateProgress('Failed to connect to embedding server.');
                window.setTimeout(() => updateProgress(null), 3000);
                return;
            }

            if (force) {
                updateProgress(`Force rebuilding index...`);
                new Notice(`Force rebuilding index...`);
                await this.dbManager.resetData();
                db = await this.dbManager.getDb();
                if (!db) return;
            }

            const { rows } = await db.query('SELECT model, dimension, metadata FROM embeddings LIMIT 1');
            const sample = rows[0] as any;
            if (sample) {
                const meta = sample.metadata || {};
                if (sample.model !== this.model || 
                    sample.dimension !== dimension || 
                    meta.chunkSize !== this.maxChunkSize || 
                    meta.prefix !== this.prefix ||
                    meta.excludedFolders !== this.plugin.settings.excludedFolders) {
                    new Notice(`Settings changed. Full rebuild required.`);
                    await this.dbManager.resetData();
                    db = await this.dbManager.getDb();
                    if (!db) return;
                }
            }

            try {
                const { rows: typeRows } = await db.query(`SELECT format_type(atttypid, atttypmod) as type FROM pg_attribute WHERE attrelid = 'embeddings'::regclass AND attname = 'embedding'`);
                const currentType = (typeRows[0] as any)?.type;
                if (currentType !== `vector(${dimension})`) {
                    await db.query(`DROP INDEX IF EXISTS embeddings_hnsw_idx`);
                    await db.query(`ALTER TABLE embeddings ALTER COLUMN embedding TYPE vector(${dimension})`);
                }
                this.schemaVerified = true;
            } catch (e) {
                console.log("Could not alter table dimension:", e);
            }

            const allFiles = this.app.vault.getMarkdownFiles();
            const excluded = this.plugin.settings.excludedFolders
                .split('\n')
                .map(f => f.trim())
                .filter(f => f.length > 0);

            const files = allFiles.filter(f => {
                for (const ex of excluded) {
                    if (f.path.startsWith(ex)) return false;
                }
                return true;
            });

            const { rows: indexed } = await db.query('SELECT path, mtime FROM file_registry');
            const indexedMtimes = new Map(indexed.map((r: any) => [r.path, Number(r.mtime)]));

            const currentPaths = new Set(files.map(f => f.path));
            for (const [p] of indexedMtimes) {
                if (!currentPaths.has(p as string)) {
                    await db.query('DELETE FROM embeddings WHERE path = $1', [p]);
                    await db.query('DELETE FROM file_registry WHERE path = $1', [p]);
                }
            }

            console.log(`[Embedding Viewer] Manual Rebuild Index triggered.`);
            
            const toIndex = files.filter(f => {
                const mtime = Math.floor(f.stat.mtime);
                const storedRaw = indexedMtimes.get(f.path);
                const stored = storedRaw === undefined ? undefined : Math.floor(storedRaw as number);
                const outOfDate = stored === undefined || mtime > stored;
                if (outOfDate) {
                    console.log(`[Embedding Viewer] Rebuild found stale file: ${f.path} (File mtime: ${mtime} > DB stored: ${stored})`);
                }
                return outOfDate;
            });

            if (toIndex.length === 0) {
                new Notice('Index is up to date.');
                updateProgress('Index is up to date.');
                window.setTimeout(() => updateProgress(null), 3000);
                return;
            }

            const dynamicExcludedPhrases = await this.analyzeCommonPhrases(files, updateProgress);
            this.plugin.settings.lastExcludedPhrases = dynamicExcludedPhrases;
            await this.plugin.saveSettings();

            updateProgress(`Indexing 0/${toIndex.length} files...`);
            new Notice(`Indexing ${toIndex.length} files...`);

            let totalChunks = 0;
            
            let allChunks: { file: TFile, chunk: Chunk, contentHash: string }[] = [];
            let fileHashes = new Map<string, string>();
            
            for (let fi = 0; fi < toIndex.length; fi++) {
                if (fi % 10 === 0) {
                    updateProgress(`Preparing ${fi + 1}/${toIndex.length} files...`);
                    await new Promise(r => window.setTimeout(r, 0)); // yield to UI
                }
                const file = toIndex[fi] as TFile;
                const content = await this.app.vault.read(file);
                const contentHash = this.hashString(content);
                fileHashes.set(file.path, contentHash);
                
                const chunks = this.extractChunks(content, file, dynamicExcludedPhrases);
                
                for (const chunk of chunks) {
                    allChunks.push({ file, chunk, contentHash });
                }
            }

            // Optimize Postgres for bulk updates
            await db.exec(`
                SET synchronous_commit = off;
                SET maintenance_work_mem = '256MB';
            `);

            // Only drop the index if we are doing a massive insert (e.g. initial index or >500 files)
            // Incremental inserts are much faster than rebuilding HNSW for the whole table.
            const isBulkUpdate = toIndex.length > 500 || force;
            if (isBulkUpdate) {
                updateProgress('Temporarily dropping index for bulk update...');
                await db.exec('DROP INDEX IF EXISTS embeddings_hnsw_idx');
            }

            // Perform DB registry updates in batches to avoid WASM bridge overhead
            await db.transaction(async (tx: Transaction) => {
                updateProgress('Clearing old embeddings...');
                const allPaths = toIndex.map(f => (f).path);
                
                // Batch DELETE
                for (let i = 0; i < allPaths.length; i += 200) {
                    const batchPaths = allPaths.slice(i, i + 200);
                    const placeholders = batchPaths.map((_, idx) => `$${idx + 1}`).join(',');
                    await tx.query(`DELETE FROM embeddings WHERE path IN (${placeholders})`, batchPaths);
                    await new Promise(r => window.setTimeout(r, 0)); // yield
                }

                // Batch INSERT
                for (let i = 0; i < toIndex.length; i += 200) {
                    updateProgress(`Updating registry ${Math.min(i + 200, toIndex.length)}/${toIndex.length}...`);
                    const batch = toIndex.slice(i, i + 200);
                    let queryValues = [];
                    let queryParams = [];
                    let paramIdx = 1;

                    for (const file of batch) {
                        const contentHash = fileHashes.get((file).path) || '';
                        queryValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
                        queryParams.push((file).path, Math.floor((file).stat.mtime), contentHash, this.maxChunkSize, this.prefix);
                    }

                    if (queryValues.length > 0) {
                        await tx.query(
                            `INSERT INTO file_registry (path, mtime, hash, chunk_size, prefix) 
                             VALUES ${queryValues.join(',')} 
                             ON CONFLICT (path) DO UPDATE SET 
                             mtime = EXCLUDED.mtime, hash = EXCLUDED.hash, chunk_size = EXCLUDED.chunk_size, prefix = EXCLUDED.prefix`,
                            queryParams
                        );
                    }
                    await new Promise(r => window.setTimeout(r, 0)); // yield
                }
                
                updateProgress(`Committing registry updates...`);
            });

            const BATCH_SIZE = Math.max(1, this.plugin.settings.batchSize || 50);
            totalChunks = allChunks.length;
            
            let previousDbTask: Promise<void> | null = null;

            // Pipeline: overlap fetch[N] with dbInsert[N-1].
            // Late iterations stall here because IDB commits slow as the table grows.
            for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
                updateProgress(`Embedding chunk ${i + 1}/${allChunks.length}...`);
                const batch = allChunks.slice(i, i + BATCH_SIZE);

                const fetchPromise = this.embed(batch.map(item => {
                    const text = `${this.prefix}${item.chunk.embedText}`;
                    return text.length > 4000 ? text.substring(0, 4000) : text;
                }), dimension);

                // Bottleneck shifts from fetch to previousDbTask as table grows
                const [embeddings] = await Promise.all([
                    fetchPromise,
                    previousDbTask || Promise.resolve()
                ]);

                await new Promise(r => window.setTimeout(r, 10));

                previousDbTask = (async () => {
                    let queryValues = [];
                    let queryParams = [];
                    let paramIdx = 1;

                    await db.transaction(async (tx: Transaction) => {
                        for (let j = 0; j < batch.length; j++) {
                            const item = batch[j];
                            const emb = embeddings[j];
                            if (!item || !emb) continue;
                            
                            const meta = JSON.stringify({
                                startLine: item.chunk.startLine, 
                                endLine: item.chunk.endLine, 
                                heading: item.chunk.heading,
                                chunkSize: this.maxChunkSize,
                                prefix: this.prefix,
                                excludedFolders: this.plugin.settings.excludedFolders,
                                fileHash: item.contentHash
                            });

                            queryValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::vector, $${paramIdx++})`);
                            queryParams.push(item.file.path, Math.floor(item.file.stat.mtime), item.chunk.content, this.model, dimension, `[${emb.join(',')}]`, meta);
                        }

                        if (queryValues.length > 0) {
                            await tx.query(
                                `INSERT INTO embeddings (path, mtime, content, model, dimension, embedding, metadata)
                                 VALUES ${queryValues.join(',')}`,
                                queryParams
                            );
                        }
                    });
                })();
            }
            if (previousDbTask) {
                // Final DB write 
                updateProgress(`Writing final embeddings...`);
                await previousDbTask;
            }

            updateProgress(`Finalizing index...`);
            
            // HNSW build runs in the Web Worker, keeping the UI fully responsive
            if (dimension <= 2000) {
                await db.exec(`CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx ON embeddings USING hnsw (embedding vector_cosine_ops)`);
            } else if (dimension <= 4000) {
                await db.exec(`CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx ON embeddings USING hnsw ((embedding::halfvec(${dimension})) halfvec_cosine_ops)`);
            }
            await this.dbManager.saveDb();
            await db.exec('SET synchronous_commit = on;');
            
            new Notice(`Indexed ${totalChunks} chunks from ${toIndex.length} files.`);
            updateProgress(`Indexed ${toIndex.length} files.`);
            window.setTimeout(() => updateProgress(null), 3000);

        } catch (err) {
            console.error(err);
            new Notice('Error during index rebuild. See console.');
            updateProgress('Error during index rebuild.');
            window.setTimeout(() => updateProgress(null), 3000);
            try {
                const db = await this.dbManager.getDb();
                if (db) await db.exec('SET synchronous_commit = on;');
            } catch (e) {}
        }
    }

    private fileIndexQueue: TFile[] = [];
    private isProcessingQueue = false;

    async indexFile(file: TFile) {
        const excluded = this.plugin.settings.excludedFolders
            .split('\n')
            .map(f => f.trim())
            .filter(f => f.length > 0);

        for (const ex of excluded) {
            if (file.path.startsWith(ex)) {
                this.deleteFile(file.path);
                return;
            }
        }

        if (!this.fileIndexQueue.some(f => f.path === file.path)) {
            this.fileIndexQueue.push(file);
        }
        
        if (this.isIndexing) return;
        this.processQueue();
    }

    private async processQueue() {
        if (this.isProcessingQueue) return;

        this.isProcessingQueue = true;

        const db = await this.dbManager.getDb();
        if (!db) {
            this.isProcessingQueue = false;
            return;
        }

        let dimension = 0;
        try {
            const probeResult = await this.embed(['probe']);
            dimension = probeResult[0]?.length || 0;
            if (dimension > 0 && !this.schemaVerified) {
                try {
                    const { rows: typeRows } = await db.query(`SELECT format_type(atttypid, atttypmod) as type FROM pg_attribute WHERE attrelid = 'embeddings'::regclass AND attname = 'embedding'`);
                    const currentType = (typeRows[0] as any)?.type;
                    if (currentType !== `vector(${dimension})`) {
                        await db.query(`DROP INDEX IF EXISTS embeddings_hnsw_idx`);
                        await db.query(`ALTER TABLE embeddings ALTER COLUMN embedding TYPE vector(${dimension})`);
                    }
                    if (dimension <= 2000) {
                        await db.exec(`CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx ON embeddings USING hnsw (embedding vector_cosine_ops)`);
                    } else if (dimension <= 4000) {
                        await db.exec(`CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx ON embeddings USING hnsw ((embedding::halfvec(${dimension})) halfvec_cosine_ops)`);
                    }
                    this.schemaVerified = true;
                } catch (e) {
                    console.log("Could not alter table/create index in processQueue:", e);
                }
            }
        } catch (e) {
            console.error("Probe failed in processQueue:", e);
            new Notice("Embedding server disconnected. Background indexing paused.");
            if (this.plugin.statusBarItem) this.plugin.statusBarItem.setText('');
            this.isProcessingQueue = false;
            return;
        }

        let processedCount = 0;
        let cacheHitCount = 0;
        let cacheMissCount = 0;
        let mtimeDriftCount = 0;

        while (this.fileIndexQueue.length > 0) {
            if (this.fileIndexQueue.length > (this.plugin.settings.bulkIndexThreshold || 20)) {
                this.fileIndexQueue = [];
                this.isProcessingQueue = false;
                if (this.plugin.statusBarItem) this.plugin.statusBarItem.setText('');
                this.rebuildIndex((msg) => {
                    if (this.plugin.statusBarItem) {
                        this.plugin.statusBarItem.setText(msg === null ? '' : `🧠 ${msg}`);
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

            const { rows } = await db.query('SELECT mtime, hash, chunk_size, prefix FROM file_registry WHERE path = $1 LIMIT 1', [file.path]);
            if (rows.length > 0) {
                const reg = rows[0] as any;
                if (reg.hash === contentHash && reg.chunk_size === this.maxChunkSize && reg.prefix === this.prefix) {
                    cacheHitCount++;
                    if (Math.floor(Number(reg.mtime)) !== Math.floor(file.stat.mtime)) {
                        mtimeDriftCount++;
                        await db.query('UPDATE file_registry SET mtime = $1 WHERE path = $2', [Math.floor(file.stat.mtime), file.path]);
                    }
                    continue;
                }
                cacheMissCount++;
            } else {
                cacheMissCount++;
            }

            if (this.plugin.statusBarItem) {
                this.plugin.statusBarItem.setText(`🧠 Indexing ${file.basename}...`);
            }

            await db.query('DELETE FROM embeddings WHERE path = $1', [file.path]);

            const chunks = this.extractChunks(content, file, this.plugin.settings.lastExcludedPhrases);
            
            // Insert into file_registry regardless of chunks length
            await db.query(
                `INSERT INTO file_registry (path, mtime, hash, chunk_size, prefix) 
                 VALUES ($1, $2, $3, $4, $5) 
                 ON CONFLICT (path) DO UPDATE SET 
                 mtime = EXCLUDED.mtime, hash = EXCLUDED.hash, chunk_size = EXCLUDED.chunk_size, prefix = EXCLUDED.prefix`,
                [file.path, Math.floor(file.stat.mtime), contentHash, this.maxChunkSize, this.prefix]
            );

            if (chunks.length === 0) continue;

            const BATCH_SIZE = Math.max(1, this.plugin.settings.batchSize || 50);
            let previousDbTask: Promise<void> | null = null;

            // Same pipeline as rebuildIndex — overlap fetch[N] with dbInsert[N-1]
            for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
                const batch = chunks.slice(i, i + BATCH_SIZE);
                const fetchPromise = this.embed(batch.map(p => {
                    const text = `${this.prefix}${p.embedText}`;
                    return text.length > 4000 ? text.substring(0, 4000) : text;
                }), dimension);

                const [embeddings] = await Promise.all([
                    fetchPromise,
                    previousDbTask || Promise.resolve()
                ]);

                // Yield to ensure UI remains responsive
                await new Promise(r => window.setTimeout(r, 10));
                
                previousDbTask = (async () => {
                    let queryValues = [];
                    let queryParams = [];
                    let paramIdx = 1;
                    
                    await db.transaction(async (tx: Transaction) => {
                        for (let j = 0; j < batch.length; j++) {
                            const p = batch[j] as Chunk;
                            const emb = embeddings[j];
                            if (!emb) continue;
                            
                            const meta = JSON.stringify({
                                startLine: p.startLine, 
                                endLine: p.endLine, 
                                heading: p.heading,
                                chunkSize: this.maxChunkSize,
                                prefix: this.prefix,
                                excludedFolders: this.plugin.settings.excludedFolders,
                                fileHash: contentHash
                            });

                            queryValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::vector, $${paramIdx++})`);
                            queryParams.push(file.path, Math.floor(file.stat.mtime), p.content, this.model, dimension, `[${emb.join(',')}]`, meta);
                        }

                        if (queryValues.length > 0) {
                            await tx.query(
                                `INSERT INTO embeddings (path, mtime, content, model, dimension, embedding, metadata)
                                 VALUES ${queryValues.join(',')}`,
                                queryParams
                            );
                        }
                    });
                })();
                
                await new Promise(r => window.setTimeout(r, 0)); // yield to UI
            }
            
            if (previousDbTask) {
                await previousDbTask;
            }
        } catch (err) {
            console.error(`Error indexing file ${file.path}:`, err);
        }
        } // End of while loop
        
        if (processedCount > 0) {
            console.debug(`[Embedding Viewer] Queue processing complete. Processed: ${processedCount}, Cache hits: ${cacheHitCount}, Cache misses: ${cacheMissCount}, Mtime drifts: ${mtimeDriftCount}`);
        }

        this.isProcessingQueue = false;
        
        if (this.plugin.statusBarItem) {
            this.plugin.statusBarItem.setText('');
        }
    }

    async deleteFile(path: string) {
        if (this.isIndexing) return;
        const db = await this.dbManager.getDb();
        if (!db) return;
        try {
            await db.query('DELETE FROM embeddings WHERE path = $1', [path]);
            await db.query('DELETE FROM file_registry WHERE path = $1', [path]);
        } catch (e: any) {
            if (e.message && e.message.includes('closing')) {
                // Ignore if DB is being destroyed
            } else {
                console.error('Error in deleteFile:', e);
            }
        }
    }
}
