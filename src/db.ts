import { Notice } from 'obsidian';
import { PGlite } from '@electric-sql/pglite';
// @ts-ignore
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { vector } from '@electric-sql/pglite-pgvector';
import EmbeddingViewerPlugin from './main';

export class DatabaseManager {
    private plugin: EmbeddingViewerPlugin;
    private db: PGliteWorker | null = null;

    private initPromise: Promise<PGliteWorker | null> | null = null;

    constructor(plugin: EmbeddingViewerPlugin) {
        this.plugin = plugin;
    }

    async getDb(): Promise<PGliteWorker | null> {
        if (this.db) {
            return this.db;
        }
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            try {
                const workerJs = await this.plugin.app.vault.adapter.read(this.plugin.manifest.dir + '/worker.js');
                
                const resourceBasePath = (this.plugin.app.vault.adapter as any).getResourcePath(this.plugin.manifest.dir + '/').split('?')[0];
                const scriptPrefix = `self.WORKER_BASE_URL = "${resourceBasePath}worker.js";\nself.process = { browser: true };\n`;
                
                const blob = new Blob([scriptPrefix + workerJs], { type: 'application/javascript' });
                const workerUrl = URL.createObjectURL(blob);
                const worker = new Worker(workerUrl);

                // Add error listener to catch worker initialization errors
                worker.onerror = (e) => {
                    console.error("Worker error:", e.message, e.lineno);
                };

                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('PGlite Worker initialization timed out after 5000ms')), 5000)
                );
                
                this.db = await Promise.race([
                    PGliteWorker.create(worker, {
                        dataDir: 'idb://embedding-viewer'
                    }),
                    timeoutPromise
                ]) as PGliteWorker;
                
                await this.initSchema(this.db as any);
                return this.db;
            } catch (error) {
                console.error('Failed to initialize database:', error);
                new Notice('Failed to load Vector DB Worker. See console for details.');
                return null;
            }
        })();
        return this.initPromise;
    }

    async initSchema(db: PGlite) {
        await db.exec(`
            CREATE EXTENSION IF NOT EXISTS vector;
            CREATE TABLE IF NOT EXISTS embeddings (
                id SERIAL PRIMARY KEY,
                path TEXT NOT NULL,
                mtime BIGINT NOT NULL,
                content TEXT NOT NULL,
                model TEXT NOT NULL,
                dimension SMALLINT NOT NULL,
                embedding VECTOR NOT NULL,
                metadata JSONB NOT NULL
            );
            CREATE INDEX IF NOT EXISTS embeddings_path_idx ON embeddings USING btree (path);
            
            CREATE TABLE IF NOT EXISTS file_registry (
                path TEXT PRIMARY KEY,
                mtime BIGINT NOT NULL,
                hash TEXT NOT NULL,
                chunk_size INT NOT NULL,
                prefix TEXT NOT NULL
            );

            INSERT INTO file_registry (path, mtime, hash, chunk_size, prefix)
            SELECT DISTINCT ON (path) 
                path, 
                mtime, 
                metadata->>'fileHash', 
                (metadata->>'chunkSize')::int, 
                metadata->>'prefix'
            FROM embeddings
            WHERE metadata->>'fileHash' IS NOT NULL
            ON CONFLICT (path) DO NOTHING;
        `);

        // HNSW index is created in indexer.ts after the embedding dimension is known.
    }

    async saveDb() {
        // No-op for IndexedDB since it automatically persists
    }

    async resetData() {
        if (!this.db) return;
        // Drop tables which is often faster than TRUNCATE in IDB VFS
        await this.db.exec(`
            DROP TABLE IF EXISTS embeddings CASCADE;
            DROP TABLE IF EXISTS file_registry CASCADE;
        `);
        // Re-initialize the schema immediately
        await this.initSchema(this.db);
    }

    async destroyDb() {
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
    }

    async close() {
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
    }
}
