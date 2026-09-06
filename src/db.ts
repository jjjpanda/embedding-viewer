import { Notice } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import EmbeddingViewerPlugin from './main';

export interface ChunkRecord {
    path: string;
    mtime: number;
    content: string;
    model: string;
    dimension: number;
    vector?: Float32Array; // Stored in separate binary file
    metadata: {
        fileHash: string;
        chunkSize: number;
        prefix: string;
        heading?: string | null;
        startLine?: number;
        endLine?: number;
    };
}

export interface FileRegistryRecord {
    path: string;
    mtime: number;
    hash: string;
    chunk_size: number;
    prefix: string;
}

export interface DatabaseState {
    chunks: ChunkRecord[];
    registry: Record<string, FileRegistryRecord>;
}

export class DatabaseManager {
    private plugin: EmbeddingViewerPlugin;
    
    public state: DatabaseState = {
        chunks: [],
        registry: {}
    };

    private loaded: boolean = false;
    private loadPromiseResolver: (() => void) | null = null;
    private loadPromise: Promise<void>;

    private isSaving: boolean = false;
    private pendingSavePromise: Promise<void> | null = null;
    private needsAnotherSave: boolean = false;

    private dbPath: string;
    private jsonlPath: string;
    private binPath: string;

    constructor(plugin: EmbeddingViewerPlugin) {
        this.plugin = plugin;
        this.dbPath = `${this.plugin.manifest.dir}/embeddings.json`;
        this.jsonlPath = `${this.plugin.manifest.dir}/embeddings.jsonl`;
        this.binPath = `${this.plugin.manifest.dir}/embeddings.bin`;
        
        this.loadPromise = new Promise((resolve) => {
            this.loadPromiseResolver = resolve;
        });
    }

    async waitForLoad() {
        await this.loadPromise;
    }

    private async readBinaryFast(relPath: string): Promise<Uint8Array> {
        try {
            const adapter = this.plugin.app.vault.adapter;
            if ('getBasePath' in adapter && typeof (adapter as any).getBasePath === 'function') {
                const basePath = (adapter as any).getBasePath();
                const fullPath = path.join(basePath, relPath);
                if (fs.existsSync(fullPath)) {
                    const buffer = await fs.promises.readFile(fullPath);
                    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                }
            }
        } catch (e) {
            console.warn("Direct fs read failed, falling back to adapter", e);
        }
        const ab = await this.plugin.app.vault.adapter.readBinary(relPath);
        return new Uint8Array(ab);
    }

    async loadDb() {
        const startTime = performance.now();
        const timings: any = {};
        
        try {
            if (await this.plugin.app.vault.adapter.exists(this.jsonlPath)) {
                new Notice("Loading DB: Reading JSONL...", 2000);
                const t0 = performance.now();
                const view = await this.readBinaryFast(this.jsonlPath);
                timings.readJsonl = performance.now() - t0;
                
                new Notice(`Loading DB: Parsing JSONL (${Math.round(view.length/1024/1024)}MB)...`, 2000);
                const t1 = performance.now();
                const decoder = new TextDecoder('utf-8');
                
                let start = 0;
                const CHUNK_SIZE = 1024 * 1024 * 5; // 5MB chunks
                let lastYield = performance.now();
                
                while (start < view.length) {
                    let end = Math.min(start + CHUNK_SIZE, view.length);
                    
                    if (end < view.length) {
                        while (end > start && view[end] !== 10) {
                            end--;
                        }
                    }
                    if (end === start) {
                        end = view.indexOf(10, start);
                        if (end === -1) end = view.length;
                    }
                    
                    const chunkStr = decoder.decode(view.subarray(start, end));
                    const lines = chunkStr.split('\n');
                    for (const lineStr of lines) {
                        if (lineStr.trim().length > 0) {
                            const parsed = JSON.parse(lineStr);
                            if (parsed.type === 'registry') {
                                this.state.registry = parsed.data;
                            } else if (parsed.type === 'chunk') {
                                this.state.chunks.push(parsed.data);
                            }
                        }
                    }
                    
                    start = end + 1; // skip newline
                    if (performance.now() - lastYield > 16) {
                        await new Promise(r => window.setTimeout(r, 0));
                        lastYield = performance.now();
                    }
                }
                timings.parseJsonl = performance.now() - t1;
            } else if (await this.plugin.app.vault.adapter.exists(this.dbPath)) {
                // Fallback to legacy embeddings.json
                const data = await this.plugin.app.vault.adapter.read(this.dbPath);
                if (data.trim() !== '') {
                    this.state = JSON.parse(data);
                }
            }
            
            if (await this.plugin.app.vault.adapter.exists(this.binPath)) {
                new Notice("Loading DB: Reading BIN...", 2000);
                const t2 = performance.now();
                let binView = await this.readBinaryFast(this.binPath);
                timings.readBin = performance.now() - t2;
                
                new Notice(`Loading DB: Parsing BIN (${Math.round(binView.length/1024/1024)}MB)...`, 2000);
                const t3 = performance.now();
                
                if (binView.byteOffset % 4 !== 0) {
                    binView = new Uint8Array(binView.slice().buffer);
                }
                const bin = new Float32Array(binView.buffer as unknown as ArrayBuffer, binView.byteOffset, binView.byteLength / 4);
                
                let offset = 0;
                let lastYield = performance.now();
                for (const c of this.state.chunks) {
                    // Create a view into the array buffer for this chunk's vector
                    c.vector = bin.subarray(offset, offset + c.dimension);
                    offset += c.dimension;
                    if (performance.now() - lastYield > 16) {
                        await new Promise(r => window.setTimeout(r, 0));
                        lastYield = performance.now();
                    }
                }
                timings.parseBin = performance.now() - t3;
            }
            new Notice(`DB Loaded in ${Math.round(performance.now() - startTime)}ms!`, 4000);
        } catch (error) {
            console.error('Failed to load embeddings DB:', error);
            new Notice(`Failed to load DB: ${error instanceof Error ? error.message : error}`, 10000);
        }
        
        timings.total = performance.now() - startTime;
        try {
            await this.plugin.app.vault.adapter.write(
                `${this.plugin.manifest.dir}/profiler.json`, 
                JSON.stringify(timings, null, 2)
            );
            // Clean up any legacy profiler.md in vault root
            if (await this.plugin.app.vault.adapter.exists('profiler.md')) {
                await this.plugin.app.vault.adapter.remove('profiler.md');
            }
        } catch(e) {
            console.warn("Failed to write profiler.json or clean profiler.md:", e);
        }
        
        this.loaded = true;
        if (this.loadPromiseResolver) {
            this.loadPromiseResolver();
        }
    }

    async saveDb(): Promise<void> {
        if (this.isSaving) {
            this.needsAnotherSave = true;
            return this.pendingSavePromise || Promise.resolve();
        }

        this.isSaving = true;
        this.pendingSavePromise = (async () => {
            try {
                do {
                    this.needsAnotherSave = false;
                    await this.performSave();
                } while (this.needsAnotherSave);
            } finally {
                this.isSaving = false;
                this.pendingSavePromise = null;
            }
        })();

        return this.pendingSavePromise;
    }

    private async performSave() {
        try {
            // Compute total floats needed safely
            let totalFloats = 0;
            for (const c of this.state.chunks) {
                const dim = c.vector ? c.vector.length : (c.dimension || 0);
                c.dimension = dim;
                totalFloats += dim;
            }
            
            // Build binary array safely
            const bin = new Float32Array(totalFloats);
            let offset = 0;
            for (const c of this.state.chunks) {
                const dim = c.dimension || 0;
                if (c.vector && dim > 0) {
                    const toCopy = Math.min(c.vector.length, dim);
                    bin.set(c.vector.subarray(0, toCopy), offset);
                }
                offset += dim;
            }
            
            // Serialize JSONL chunk by chunk to avoid V8's max string length limit
            const encoder = new TextEncoder();
            const jsonLines: Uint8Array[] = [];
            let totalJsonLength = 0;

            let currentBlock: string[] = [];
            let currentBlockSize = 0;

            let lastYield = performance.now();
            const yieldIfNeeded = async () => {
                if (performance.now() - lastYield > 16) {
                    await new Promise(r => window.setTimeout(r, 0));
                    lastYield = performance.now();
                }
            };

            const pushBlock = async () => {
                if (currentBlock.length === 0) return;
                const encoded = encoder.encode(currentBlock.join(''));
                jsonLines.push(encoded);
                totalJsonLength += encoded.length;
                currentBlock = [];
                currentBlockSize = 0;
                await yieldIfNeeded();
            };

            const addLine = async (line: string) => {
                currentBlock.push(line);
                currentBlockSize += line.length;
                if (currentBlockSize > 1024 * 1024 * 5) { // 5MB block size
                    await pushBlock();
                }
            };

            await addLine(JSON.stringify({ type: 'registry', data: this.state.registry }) + '\n');

            for (const c of this.state.chunks) {
                const { vector, ...rest } = c;
                await addLine(JSON.stringify({ type: 'chunk', data: rest }) + '\n');
                await yieldIfNeeded();
            }
            await pushBlock();

            const finalJsonBuffer = new Uint8Array(totalJsonLength);
            let jsonOffset = 0;
            for (const buf of jsonLines) {
                finalJsonBuffer.set(buf, jsonOffset);
                jsonOffset += buf.length;
                await yieldIfNeeded();
            }

            const writeBinaryFast = async (relPath: string, data: Uint8Array) => {
                let written = false;
                try {
                    const adapter = this.plugin.app.vault.adapter;
                    if ('getBasePath' in adapter && typeof (adapter as any).getBasePath === 'function') {
                        const basePath = (adapter as any).getBasePath();
                        const fullPath = path.join(basePath, relPath);
                        const tmpPath = fullPath + '.tmp';
                        await fs.promises.writeFile(tmpPath, data);
                        try {
                            if (fs.existsSync(fullPath)) {
                                await fs.promises.unlink(fullPath);
                            }
                        } catch (unlinkErr) {
                            // ignore
                        }
                        await fs.promises.rename(tmpPath, fullPath);
                        written = true;
                        return;
                    }
                } catch (e) {
                    console.warn("Direct fs write failed, falling back to adapter", e);
                }

                if (!written) {
                    const ab = (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
                        ? (data.buffer as unknown as ArrayBuffer)
                        : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as unknown as ArrayBuffer);
                    await this.plugin.app.vault.adapter.writeBinary(relPath, ab);
                }
            };

            // Write files asynchronously
            await writeBinaryFast(this.jsonlPath, finalJsonBuffer);
            await writeBinaryFast(this.binPath, new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength));
            
            // Cleanup legacy JSON file if it exists
            if (await this.plugin.app.vault.adapter.exists(this.dbPath)) {
                await this.plugin.app.vault.adapter.remove(this.dbPath);
            }
        } catch (error) {
            console.error(`Failed to save embeddings DB: ${error instanceof Error ? (error.stack || error.message) : String(error)}`, error);
            new Notice(`Failed to save embeddings DB: ${error instanceof Error ? error.message : error}`);
        }
    }

    async resetData() {
        this.state = {
            chunks: [],
            registry: {}
        };
        await this.saveDb();
    }
    
    cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            const a = vecA[i]!;
            const b = vecB[i]!;
            dotProduct += a * b;
            normA += a * a;
            normB += b * b;
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    
    async close() {
        // No-op for file DB
    }
}
