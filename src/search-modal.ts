import { App, Notice, SuggestModal, TFile } from 'obsidian';
import type EmbeddingViewerPlugin from './main';
import { QueryResult } from './query';

export class SemanticSearchModal extends SuggestModal<QueryResult> {
    private plugin: EmbeddingViewerPlugin;
    private debounceTimer: number | null = null;
    private currentQueryId = 0;
    private resolvePending: ((results: QueryResult[]) => void) | null = null;

    constructor(app: App, plugin: EmbeddingViewerPlugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder('Type to search vault semantically...');
        this.emptyStateText = 'No semantically similar notes found.';
    }

    onClose(): void {
        this.currentQueryId++;
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.resolvePending) {
            this.resolvePending([]);
            this.resolvePending = null;
        }
    }

    async getSuggestions(query: string): Promise<QueryResult[]> {
        const trimmed = query.trim();
        if (!trimmed) return [];

        const queryId = ++this.currentQueryId;
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.resolvePending) {
            this.resolvePending([]);
            this.resolvePending = null;
        }

        return new Promise((resolve) => {
            this.resolvePending = resolve;
            this.debounceTimer = window.setTimeout(async () => {
                try {
                    if (queryId !== this.currentQueryId) {
                        resolve([]);
                        return;
                    }
                    const cleanQuery = this.plugin.indexer.stripWikilinks(trimmed);
                    const queryText = `${this.plugin.settings.embeddingQueryPrefix || ''}${cleanQuery}`;
                    const vectors = await this.plugin.indexer.embed([queryText]);
                    if (queryId !== this.currentQueryId || vectors.length === 0) {
                        resolve([]);
                        return;
                    }
                    const vector = vectors[0] as number[];
                    const results = await this.plugin.queryService.findSimilarForVector(vector, undefined, 10, undefined, false);
                    if (queryId !== this.currentQueryId) {
                        resolve([]);
                        return;
                    }
                    resolve(results);
                } catch (e) {
                    console.error('Semantic search failed:', e);
                    new Notice('Embedding search failed. Check server connection.');
                    resolve([]);
                } finally {
                    if (this.resolvePending === resolve) {
                        this.resolvePending = null;
                    }
                }
            }, 300);
        });
    }

    renderSuggestion(item: QueryResult, el: HTMLElement) {
        el.addClass('embedding-search-suggestion');

        const header = el.createDiv({ cls: 'embedding-search-header' });
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.justifyContent = 'space-between';
        header.style.marginBottom = '4px';

        const titleDiv = header.createDiv();
        const basename = item.path.split('/').pop()?.replace(/\.md$/, '') || item.path;
        const titleSpan = titleDiv.createSpan({ text: basename, cls: 'embedding-search-title' });
        titleSpan.style.fontWeight = '600';
        titleSpan.style.color = 'var(--text-accent)';

        if (item.heading) {
            const headingSpan = titleDiv.createSpan({ text: ` > ${item.heading}` });
            headingSpan.style.opacity = '0.7';
            headingSpan.style.fontSize = '0.9em';
            headingSpan.style.marginLeft = '4px';
        }

        let scoreText = `${Math.round(item.similarity * 100)}%`;
        if (item.linkPenalty > 0) scoreText += ' 🔗↓';
        const scoreSpan = header.createSpan({ text: scoreText, cls: 'embedding-search-score' });
        scoreSpan.style.color = 'var(--text-muted)';
        scoreSpan.style.fontSize = '0.85em';

        const preview = el.createDiv({ cls: 'embedding-search-preview' });
        preview.style.fontSize = '0.85em';
        preview.style.color = 'var(--text-muted)';
        preview.style.display = '-webkit-box';
        preview.style.webkitLineClamp = '2';
        preview.style.setProperty('-webkit-box-orient', 'vertical');
        preview.style.overflow = 'hidden';
        preview.style.borderLeft = '2px solid var(--text-accent)';
        preview.style.paddingLeft = '6px';
        preview.setText(item.content);
    }

    async onChooseSuggestion(item: QueryResult, evt: MouseEvent | KeyboardEvent) {
        const file = this.app.vault.getAbstractFileByPath(item.path);
        const isMod = evt.ctrlKey || evt.metaKey;
        if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(isMod ? 'tab' : false);
            await leaf.openFile(file, { eState: { line: item.startLine } });
        } else {
            await this.app.workspace.openLinkText(item.path, '', isMod);
        }
    }
}
