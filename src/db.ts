import { App, Notice } from 'obsidian';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

export class DatabaseManager {
    private app: App;
    private db: PGlite | null = null;

    constructor(app: App) {
        this.app = app;
    }

    async getDb(): Promise<PGlite | null> {
        if (this.db) {
            return this.db;
        }

        try {
            // Using IndexedDB makes it compatible across platforms and faster
            this.db = await PGlite.create('idb://embedding-viewer', {
                extensions: { vector }
            });
            await this.initSchema(this.db);
            return this.db;
        } catch (error) {
            console.error('Failed to initialize database:', error);
            new Notice('Failed to load Vector DB. See console for details.');
            return null;
        }
    }

    private async initSchema(db: PGlite) {
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
        `);

        try {
            await db.exec(`CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx ON embeddings USING hnsw (embedding vector_cosine_ops)`);
        } catch (e) {
            console.log("Could not create HNSW index yet (might need dimension):", e);
        }
    }

    async saveDb() {
        // No-op for IndexedDB since it automatically persists
    }

    async close() {
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
    }
}
