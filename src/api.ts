import * as http from 'http';
import { Notice } from 'obsidian';
import type EmbeddingViewerPlugin from './main';

export class LocalApi {
    private server: http.Server | null = null;
    private plugin: EmbeddingViewerPlugin;
    private statusBarItem: HTMLElement | null = null;

    constructor(plugin: EmbeddingViewerPlugin) {
        this.plugin = plugin;
    }

    start() {
        if (this.server) return;

        this.server = http.createServer(async (req, res) => {
            // Add CORS headers so external scripts/agents can call it
            res.setHeader('Access-Control-Allow-Origin', '*');
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
                    // We shouldn't block the HTTP response on a long rebuild, 
                    // but for agents it might be useful to wait, or just start it.
                    res.writeHead(202);
                    res.end(JSON.stringify({ status: 'started', force }));
                    
                    this.plugin.indexer.rebuildIndex((msg) => {
                        console.log(`Rebuild index: ${msg}`);
                    }, force).catch(err => console.error('Error rebuilding index:', err));
                    
                    return;
                }

                if (req.method === 'POST' && url.pathname === '/search') {
                    let body = '';
                    req.on('data', chunk => body += chunk.toString());
                    req.on('end', async () => {
                        try {
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
                            const vectors = await this.plugin.indexer.embed([cleanQuery]);
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
                    });
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
                    const vectors = await this.plugin.indexer.embed([cleanQuery]);
                    if (vectors.length === 0) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Failed to generate embedding' }));
                        return;
                    }

                    const vector = vectors[0] as number[];
                    const results = await this.plugin.queryService.findSimilarForVector(vector, undefined, limit);

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
            console.log(`Embedding Viewer API listening on http://127.0.0.1:${port}`);
            if (!this.statusBarItem) {
                this.statusBarItem = this.plugin.addStatusBarItem();
            }
            this.statusBarItem.setText(`Vault Embed API ON`);
        });

        this.server.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                new Notice(`Embedding Viewer: Port ${port} is already in use. API disabled.`);
                if (this.statusBarItem) {
                    this.statusBarItem.setText(`Vault Embed API OFF`);
                }
            } else {
                console.error('API Server error:', err);
            }
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
            if (this.statusBarItem) {
                this.statusBarItem.remove();
                this.statusBarItem = null;
            }
            console.log('Embedding Viewer API stopped.');
        }
    }
}
