import { DatabaseManager } from './db';
import EmbeddingViewerPlugin from './main';

export interface QueryResult {
    path: string;
    content: string;
    heading: string | null;
    startLine: number;
    endLine: number;
    similarity: number;
    rawSimilarity: number;
    timePenalty: number;
    linkPenalty: number;
}

export interface ChunkMatchGroup {
    sourceContent: string;
    sourceHeading: string | null;
    matches: QueryResult[];
}

export class QueryService {
    constructor(private dbManager: DatabaseManager, private plugin: EmbeddingViewerPlugin) {}

    async findSimilarPerChunk(filePath: string, topKPerChunk: number = 3, maxChunks: number = 8): Promise<ChunkMatchGroup[]> {
        const db = await this.dbManager.getDb();
        if (!db) return [];

        try {
            const { rows: sourceRows } = await db.query(
                `SELECT content, embedding, metadata->>'heading' AS heading FROM embeddings WHERE path = $1 ORDER BY id ASC`,
                [filePath]
            );
            if (sourceRows.length === 0) return [];

            let selectedRows = sourceRows;
            if (sourceRows.length > maxChunks) {
                selectedRows = [...sourceRows].sort((a: any, b: any) => b.content.length - a.content.length).slice(0, maxChunks);
            }

            // Fetch sequentially to avoid overwhelming PGLite WASM
            const FETCH_K = 10;
            const resultsArrays = [];
            for (const r of selectedRows as any[]) {
                const vec = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
                const matches = await this.findSimilarForVector(vec, filePath, FETCH_K);
                resultsArrays.push(matches.map(m => ({ sourceContent: String(r.content), sourceHeading: r.heading || null, match: m })));
            }
            const allCandidates = resultsArrays.flat();

            // Sort all candidates globally by similarity descending
            allCandidates.sort((a, b) => b.match.similarity - a.match.similarity);

            const usedPaths = new Set<string>();
            const chunksMap = new Map<string, { heading: string | null, matches: QueryResult[] }>();

            for (const cand of allCandidates) {
                if (usedPaths.has(cand.match.path)) {
                    continue; // Target note already assigned to another chunk
                }

                const chunkData = chunksMap.get(cand.sourceContent) || { heading: cand.sourceHeading, matches: [] as QueryResult[] };
                const matchesForChunk = chunkData.matches;

                if (matchesForChunk.length >= topKPerChunk) {
                    continue; // Chunk has reached its match quota
                }

                if (!chunksMap.has(cand.sourceContent) && chunksMap.size >= maxChunks) {
                    continue; // Reached maximum allowed chunks
                }

                matchesForChunk.push(cand.match);
                chunksMap.set(cand.sourceContent, { heading: cand.sourceHeading, matches: matchesForChunk });
                usedPaths.add(cand.match.path);
            }

            const results: ChunkMatchGroup[] = [];
            for (const [sourceContent, data] of chunksMap.entries()) {
                results.push({ sourceContent, sourceHeading: data.heading, matches: data.matches });
            }

            // Sort chunks by their best match's similarity score
            results.sort((a, b) => (b.matches[0]?.similarity || 0) - (a.matches[0]?.similarity || 0));

            return results;
        } catch (err) {
            console.error('findSimilarPerChunk failed:', err);
            return [];
        }
    }



    /**
     * Finds similar chunks for a given raw embedding vector.
     */
    async findSimilarForVector(vector: number[], excludePath?: string, topK: number = 5): Promise<QueryResult[]> {
        const db = await this.dbManager.getDb();
        if (!db) return [];

        try {
            const nowMs = Date.now();
            const msPerMonth = 1000 * 60 * 60 * 24 * 30;

            const vectorStr = `[${vector.join(',')}]`;
            const maxSim = this.plugin.settings.maximumSimilarity ?? 0.95;

            let queryStr = `
                SELECT path, content, metadata->>'heading' AS heading, (metadata->>'startLine')::int AS "startLine", (metadata->>'endLine')::int AS "endLine", mtime,
                (1 - (embedding <=> $1::vector)) as "rawSimilarity"
                FROM embeddings
                ORDER BY embedding <=> $1::vector LIMIT 300
            `;
            const params: any[] = [vectorStr];

            const { rows } = await db.query(queryStr, params);

            let linkedPaths = new Set<string>();
            if (excludePath) {
                const resolvedLinks = this.plugin.app.metadataCache.resolvedLinks || {};
                const outlinks = (resolvedLinks as any)[excludePath] || {};
                linkedPaths = new Set<string>(Object.keys(outlinks));
                for (const [src, tgts] of Object.entries(resolvedLinks)) {
                    if ((tgts as any)[excludePath]) linkedPaths.add(src);
                }
            }

            const seenPaths = new Set<string>();
            const results: QueryResult[] = [];
            for (const row of rows as any[]) {
                if (excludePath && row.path === excludePath) continue;
                if (seenPaths.has(row.path)) continue;
                if (row.rawSimilarity >= maxSim) continue; // Filter out exact matches/duplicates
                
                seenPaths.add(row.path);

                const timePenalty = (((nowMs - row.mtime) / msPerMonth) * (this.plugin.settings.penaltyPerMonth / 100.0));
                const linkPenalty = linkedPaths.has(row.path) ? 0.30 : 0;
                const similarity = row.rawSimilarity - timePenalty - linkPenalty;
                
                if (similarity >= this.plugin.settings.minimumSimilarity) {
                    results.push({
                        path: row.path,
                        content: row.content,
                        heading: row.heading,
                        startLine: row.startLine,
                        endLine: row.endLine,
                        similarity,
                        rawSimilarity: row.rawSimilarity,
                        timePenalty,
                        linkPenalty
                    });
                }
            }
            results.sort((a, b) => b.similarity - a.similarity);
            return results.slice(0, topK);
        } catch (err) {
            console.error('Query failed:', err);
            return [];
        }
    }
}
