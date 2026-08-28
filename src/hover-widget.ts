import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Tooltip, showTooltip, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { App, TFile, MarkdownView } from 'obsidian';
import EmbeddingViewerPlugin from './main';

export const setHoverTooltip = StateEffect.define<Tooltip | null>();

export const hoverTooltipField = StateField.define<Tooltip | null>({
    create() { return null; },
    update(tooltip, tr) {
        for (let e of tr.effects) {
            if (e.is(setHoverTooltip)) return e.value;
        }
        // Hide tooltip if the document changes or selection changes (unless it's just a focus event)
        if (tr.docChanged || (tr.selection && !tr.effects.some(e => e.is(setHoverTooltip)))) {
            return null;
        }
        return tooltip;
    },
    provide: f => showTooltip.computeN([f], state => {
        const t = state.field(f);
        return t ? [t] : [];
    })
});

export function createHoverTooltipPlugin(app: App, plugin: EmbeddingViewerPlugin) {
    return ViewPlugin.fromClass(class {
        timer: number | null = null;
        view: EditorView;

        constructor(view: EditorView) {
            this.view = view;
        }

        update(update: ViewUpdate) {
            if (update.selectionSet || update.docChanged) {
                if (this.timer) window.clearTimeout(this.timer);

                const state = update.state;
                const selection = state.selection.main;

                if (!selection.empty) {
                    const text = state.doc.sliceString(selection.from, selection.to).trim();
                    if (text) {
                        this.timer = window.setTimeout(() => this.triggerSearch(text, selection.from, selection.to), 800);
                    }
                }
            }
        }

        async triggerSearch(text: string, from: number, to: number) {
            try {
                const cleanSelection = plugin.indexer.stripWikilinks(text);
                const vectors = await plugin.indexer.embed([cleanSelection]);
                if (vectors.length === 0) return;
                const vector = vectors[0] as number[];

                const activeFile = app.workspace.getActiveFile();
                const excludePath = activeFile ? activeFile.path : undefined;

                // Query top 3 similar chunks
                const results = await plugin.queryService.findSimilarForVector(vector, excludePath, 3);
                if (results.length === 0) return;

                const dom = document.createElement('div');
                dom.className = 'embedding-hover-tooltip';
                dom.style.padding = '10px';
                dom.style.maxWidth = '350px';
                dom.style.backgroundColor = 'var(--background-primary)';
                dom.style.border = '1px solid var(--background-modifier-border)';
                dom.style.borderRadius = '8px';
                dom.style.boxShadow = '0 8px 16px rgba(0,0,0,0.2)';
                dom.style.zIndex = '1000';
                dom.style.cursor = 'default';

                const title = dom.createEl('div', { text: 'Similar Snippets', cls: 'embedding-hover-title' });
                title.style.fontWeight = 'bold';
                title.style.marginBottom = '8px';
                title.style.fontSize = '0.95em';
                title.style.color = 'var(--text-normal)';
                title.style.borderBottom = '1px solid var(--background-modifier-border)';
                title.style.paddingBottom = '4px';

                for (const res of results) {
                    const item = dom.createEl('div');
                    item.style.marginBottom = '8px';
                    item.style.fontSize = '0.85em';

                    const headerDiv = item.createDiv();
                    const pathSpan = headerDiv.createEl('a', { text: res.path, href: '#' });
                    pathSpan.style.color = 'var(--text-accent)';
                    pathSpan.style.textDecoration = 'none';
                    pathSpan.style.fontWeight = '500';

                    const insertBtn = headerDiv.createEl('button', { text: '🔗' });
                    insertBtn.style.background = 'none';
                    insertBtn.style.border = 'none';
                    insertBtn.style.cursor = 'pointer';
                    insertBtn.style.marginLeft = '4px';
                    insertBtn.style.padding = '0 4px';
                    insertBtn.title = 'Insert wikilink';
                    
                    const scoreSpan = headerDiv.createSpan({ text: ` ${(res.similarity * 100).toFixed(0)}%` });
                    scoreSpan.style.color = 'var(--text-muted)';
                    scoreSpan.style.float = 'right';
                    scoreSpan.style.fontSize = '0.9em';

                    const preview = item.createDiv({ text: res.content });
                    preview.style.opacity = '0.85';
                    preview.style.marginTop = '4px';
                    preview.style.color = 'var(--text-normal)';
                    preview.style.display = '-webkit-box';
                    preview.style.webkitLineClamp = '3';
                    preview.style.webkitBoxOrient = 'vertical';
                    preview.style.overflow = 'hidden';
                    preview.style.borderLeft = '2px solid var(--text-accent)';
                    preview.style.paddingLeft = '6px';

                    pathSpan.onclick = (e) => {
                        e.preventDefault();
                        app.workspace.openLinkText(res.path, '', true);
                    };

                    insertBtn.onclick = (e) => {
                        e.preventDefault();
                        const file = app.vault.getAbstractFileByPath(res.path);
                        let linkPath = res.path.replace(/\.md$/, '');
                        if (file instanceof TFile) {
                            const activeFile = app.workspace.getActiveFile();
                            linkPath = app.metadataCache.fileToLinktext(file, activeFile ? activeFile.path : '');
                        }

                        const alias = `[[${linkPath}|${text}]]`;
                        this.view.dispatch({
                            changes: {
                                from: from,
                                to: to,
                                insert: alias
                            },
                            effects: setHoverTooltip.of(null)
                        });
                    };
                }

                this.view.dispatch({
                    effects: setHoverTooltip.of({
                        pos: to, 
                        above: false,
                        create(view) { return { dom }; }
                    })
                });

            } catch (err) {
                console.error('Hover search failed', err);
            }
        }

        destroy() {
            if (this.timer) window.clearTimeout(this.timer);
        }
    });
}

export function setupReadModeHover(app: App, plugin: EmbeddingViewerPlugin) {
    let timer: number | null = null;
    let currentTooltip: HTMLElement | null = null;

    const removeTooltip = () => {
        if (currentTooltip) {
            currentTooltip.remove();
            currentTooltip = null;
        }
    };

    const onSelectionChange = () => {
        if (timer) window.clearTimeout(timer);
        
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) {
            removeTooltip();
            return;
        }

        const text = selection.toString().trim();
        if (!text) {
            removeTooltip();
            return;
        }



        // Ensure selection is inside the reading view
        let isInsideReadingView = false;
        let node = selection.anchorNode;
        while (node) {
            if (node instanceof Element && node.classList.contains('markdown-reading-view')) {
                isInsideReadingView = true;
                break;
            }
            node = node.parentNode;
        }
        
        if (!isInsideReadingView) return;

        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        timer = window.setTimeout(async () => {
            try {
                const cleanSelection = plugin.indexer.stripWikilinks(text);
                const vectors = await plugin.indexer.embed([cleanSelection]);
                if (vectors.length === 0) return;
                const vector = vectors[0] as number[];

                const activeFile = app.workspace.getActiveFile();
                const excludePath = activeFile ? activeFile.path : undefined;

                const results = await plugin.queryService.findSimilarForVector(vector, excludePath, 3);
                if (results.length === 0) return;

                removeTooltip();

                const dom = document.createElement('div');
                dom.className = 'embedding-hover-tooltip read-mode-tooltip';
                dom.style.position = 'absolute';
                dom.style.left = `${rect.left}px`;
                dom.style.top = `${rect.bottom + window.scrollY + 10}px`;
                dom.style.padding = '10px';
                dom.style.maxWidth = '350px';
                dom.style.backgroundColor = 'var(--background-primary)';
                dom.style.border = '1px solid var(--background-modifier-border)';
                dom.style.borderRadius = '8px';
                dom.style.boxShadow = '0 8px 16px rgba(0,0,0,0.2)';
                dom.style.zIndex = '1000';
                dom.style.cursor = 'default';

                const title = dom.createEl('div', { text: 'Similar Snippets', cls: 'embedding-hover-title' });
                title.style.fontWeight = 'bold';
                title.style.marginBottom = '8px';
                title.style.fontSize = '0.95em';
                title.style.color = 'var(--text-normal)';
                title.style.borderBottom = '1px solid var(--background-modifier-border)';
                title.style.paddingBottom = '4px';

                for (const res of results) {
                    const item = dom.createEl('div');
                    item.style.marginBottom = '8px';
                    item.style.fontSize = '0.85em';

                    const headerDiv = item.createDiv();
                    const pathSpan = headerDiv.createEl('a', { text: res.path, href: '#' });
                    pathSpan.style.color = 'var(--text-accent)';
                    pathSpan.style.textDecoration = 'none';
                    pathSpan.style.fontWeight = '500';
                    
                    const scoreSpan = headerDiv.createSpan({ text: ` ${(res.similarity * 100).toFixed(0)}%` });
                    scoreSpan.style.color = 'var(--text-muted)';
                    scoreSpan.style.float = 'right';
                    scoreSpan.style.fontSize = '0.9em';

                    const preview = item.createDiv({ text: res.content });
                    preview.style.opacity = '0.85';
                    preview.style.marginTop = '4px';
                    preview.style.color = 'var(--text-normal)';
                    preview.style.display = '-webkit-box';
                    preview.style.webkitLineClamp = '3';
                    preview.style.webkitBoxOrient = 'vertical';
                    preview.style.overflow = 'hidden';
                    preview.style.borderLeft = '2px solid var(--text-accent)';
                    preview.style.paddingLeft = '6px';

                    pathSpan.onclick = async (e) => {
                        e.preventDefault();
                        const file = app.metadataCache.getFirstLinkpathDest(res.path, '');
                        if (file) {
                            const leaf = app.workspace.getLeaf(true);
                            await leaf.openFile(file, { eState: { line: res.startLine } });
                        } else {
                            app.workspace.openLinkText(res.path, '', true);
                        }
                    };
                }

                document.body.appendChild(dom);
                currentTooltip = dom;

                // Close on outside click
                const onClickOutside = (e: MouseEvent) => {
                    if (currentTooltip && !currentTooltip.contains(e.target as Node)) {
                        removeTooltip();
                        document.removeEventListener('mousedown', onClickOutside);
                    }
                };
                setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);

            } catch (err) {
                console.error('Read mode hover search failed', err);
            }
        }, 800);
    };

    plugin.registerDomEvent(document, 'selectionchange', onSelectionChange);
}
