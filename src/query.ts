import { DatabaseManager, ChunkRecord } from './db';
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
        await this.dbManager.waitForLoad();
        try {
            const sourceRows = this.dbManager.state.chunks.filter(c => c.path === filePath);
            if (sourceRows.length === 0) return [];

            let selectedRows = sourceRows;
            if (sourceRows.length > maxChunks) {
                selectedRows = [...sourceRows].sort((a, b) => b.content.length - a.content.length).slice(0, maxChunks);
            }

            const FETCH_K = 10;
            const resultsArrays = [];
            for (const r of selectedRows) {
                if (!r.vector) continue;
                const matches = await this.findSimilarForVector(r.vector, filePath, FETCH_K);
                resultsArrays.push(matches.map(m => ({ sourceContent: r.content, sourceHeading: r.metadata.heading || null, match: m })));
            }
            const allCandidates = resultsArrays.flat();

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

            results.sort((a, b) => (b.matches[0]?.similarity || 0) - (a.matches[0]?.similarity || 0));

            return results;
        } catch (err) {
            console.error('findSimilarPerChunk failed:', err);
            return [];
        }
    }

    async findSimilarForVector(vector: number[] | Float32Array, excludePath?: string, topK: number = 5): Promise<QueryResult[]> {
        await this.dbManager.waitForLoad();
        try {
            const nowMs = Date.now();
            const msPerMonth = 1000 * 60 * 60 * 24 * 30;
            const maxSim = this.plugin.settings.maximumSimilarity ?? 0.95;
            const penaltyRate = (this.plugin.settings.linkPenalty ?? 30) / 100.0;

            let linkedPaths = new Set<string>();
            if (excludePath) {
                const resolvedLinks = this.plugin.app.metadataCache.resolvedLinks || {};
                const outlinks = (resolvedLinks as any)[excludePath] || {};
                linkedPaths = new Set<string>(Object.keys(outlinks));
                for (const [src, tgts] of Object.entries(resolvedLinks)) {
                    if ((tgts as any)[excludePath]) linkedPaths.add(src);
                }
            }

            const queryVector = vector instanceof Float32Array ? vector : new Float32Array(vector);
            
            const scored: QueryResult[] = [];
            for (const chunk of this.dbManager.state.chunks) {
                if (excludePath && chunk.path === excludePath) continue;
                if (!chunk.vector) continue;

                // compute cosine similarity
                const rawSimilarity = this.dbManager.cosineSimilarity(queryVector, chunk.vector);
                
                if (rawSimilarity >= maxSim) continue;

                const timePenalty = (((nowMs - chunk.mtime) / msPerMonth) * (this.plugin.settings.penaltyPerMonth / 100.0));
                const linkPenalty = linkedPaths.has(chunk.path) ? penaltyRate : 0;
                const similarity = rawSimilarity - timePenalty - linkPenalty;
                
                if (similarity >= this.plugin.settings.minimumSimilarity) {
                    scored.push({
                        path: chunk.path,
                        content: chunk.content,
                        heading: chunk.metadata.heading || null,
                        startLine: chunk.metadata.startLine || 0,
                        endLine: chunk.metadata.endLine || 0,
                        similarity,
                        rawSimilarity,
                        timePenalty,
                        linkPenalty
                    });
                }
            }
            
            // Sort by similarity descending
            scored.sort((a, b) => b.similarity - a.similarity);
            
            // Deduplicate by path
            const seenPaths = new Set<string>();
            const results: QueryResult[] = [];
            for (const item of scored) {
                if (seenPaths.has(item.path)) continue;
                seenPaths.add(item.path);
                results.push(item);
                if (results.length >= topK) break;
            }
            
            return results;
        } catch (err) {
            console.error('Query failed:', err);
            return [];
        }
    }
}
