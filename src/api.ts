import * as http from 'http';
import { Notice } from 'obsidian';
import type EmbeddingViewerPlugin from './main';

const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_ORIGINS = ['http://127.0.0.1', 'http://localhost'];

export class LocalApi {
    private server: http.Server | null = null;
    private isListening: boolean = false;
    private plugin: EmbeddingViewerPlugin;

    constructor(plugin: EmbeddingViewerPlugin) {
        this.plugin = plugin;
    }

    private isOriginAllowed(origin: string | undefined): boolean {
        if (!origin) return true;
        try {
            const parsed = new URL(origin);
            return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
        } catch {
            return false;
        }
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = '';
            let bytes = 0;
            req.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > MAX_BODY_BYTES) {
                    req.destroy();
                    reject(new Error('Request body too large'));
                    return;
                }
                body += chunk.toString();
            });
            req.on('end', () => resolve(body));
            req.on('error', reject);
        });
    }

    start() {
        if (this.server || !this.plugin.settings.enableApi) return;

        this.server = http.createServer(async (req, res) => {
            const origin = req.headers.origin;
            if (!this.isOriginAllowed(origin)) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Origin not allowed' }));
                return;
            }

            if (origin) {
                res.setHeader('Access-Control-Allow-Origin', origin);
            }
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Content-Type', 'application/json');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            try {
                const url = new URL(req.url || '/', `http://localhost:${this.plugin.settings.apiPort || 27123}`);

                if (req.method === 'POST' && url.pathname === '/rebuild') {
                    const force = url.searchParams.get('force') === 'true';
                    res.writeHead(202);
                    res.end(JSON.stringify({ status: 'started', force }));

                    this.plugin.indexer.rebuildIndex((msg) => {
                        console.log(`Rebuild index: ${msg}`);
                    }, force).catch(err => console.error('Error rebuilding index:', err));

                    return;
                }

                if (req.method === 'POST' && url.pathname === '/search') {
                    try {
                        const body = await this.readBody(req);
                        const parsed = JSON.parse(body);
                        const query = parsed.query;
                        const limit = parsed.limit || 5;
                        const excludePath = parsed.excludePath;

                        if (!query) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'Missing query parameter "query" in body' }));
                            return;
                        }

                        const cleanQuery = this.plugin.indexer.stripWikilinks(query);
                        const queryText = `${this.plugin.settings.embeddingQueryPrefix || ''}${cleanQuery}`;
                        const vectors = await this.plugin.indexer.embed([queryText]);
                        if (vectors.length === 0) {
                            res.writeHead(500);
                            res.end(JSON.stringify({ error: 'Failed to generate embedding' }));
                            return;
                        }

                        const vector = vectors[0] as number[];
                        const results = await this.plugin.queryService.findSimilarForVector(vector, excludePath, limit);

                        res.writeHead(200);
                        res.end(JSON.stringify({ results }));
                    } catch (err) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: String(err) }));
                    }
                    return;
                }

                if (req.method === 'GET' && url.pathname === '/search') {
                    const query = url.searchParams.get('q');
                    const limitStr = url.searchParams.get('limit');
                    const limit = limitStr ? parseInt(limitStr, 10) : 5;

                    if (!query) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Missing query parameter "q"' }));
                        return;
                    }

                    const cleanQuery = this.plugin.indexer.stripWikilinks(query);
                    const queryText = `${this.plugin.settings.embeddingQueryPrefix || ''}${cleanQuery}`;
                    const vectors = await this.plugin.indexer.embed([queryText]);
                    if (vectors.length === 0) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Failed to generate embedding' }));
                        return;
                    }

                    const vector = vectors[0] as number[];
                    const results = await this.plugin.queryService.findSimilarForVector(vector, undefined, limit, undefined, false);

                    res.writeHead(200);
                    res.end(JSON.stringify({ results }));
                    return;
                }

                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Not found' }));
            } catch (err) {
                console.error('API Error:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: String(err) }));
            }
        });

        const port = this.plugin.settings.apiPort || 27123;

        this.server.listen(port, '127.0.0.1', () => {
            this.isListening = true;
            console.log(`Embedding Viewer API listening on http://127.0.0.1:${port}`);
            this.plugin.updateFileStatus();
        });

        this.server.on('error', (err: any) => {
            this.isListening = false;
            if (this.server) {
                try {
                    this.server.close();
                } catch {
                    // ignore
                }
                this.server = null;
            }
            if (err.code === 'EADDRINUSE') {
                new Notice(`Embedding Viewer: Port ${port} is already in use. API disabled.`);
            } else {
                console.error('API Server error:', err);
            }
            this.plugin.updateFileStatus();
        });
    }

    public isRunning(): boolean {
        return this.isListening && this.server !== null;
    }

    stop() {
        this.isListening = false;
        if (this.server) {
            this.server.close();
            this.server = null;
            console.log('Embedding Viewer API stopped.');
            this.plugin.updateFileStatus();
        }
    }
}
