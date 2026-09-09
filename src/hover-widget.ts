import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Tooltip, showTooltip, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { App, TFile } from 'obsidian';
import EmbeddingViewerPlugin from './main';
import { QueryResult } from './query';

export const setHoverTooltip = StateEffect.define<Tooltip | null>();

export const hoverTooltipField = StateField.define<Tooltip | null>({
    create() { return null; },
    update(tooltip, tr) {
        for (let e of tr.effects) {
            if (e.is(setHoverTooltip)) return e.value;
        }
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

export interface TooltipAction {
    label: string;
    title: string;
    onClick: (res: QueryResult) => void;
}

export function buildSimilarTooltip(
    app: App,
    results: QueryResult[],
    title: string,
    actions?: (res: QueryResult) => TooltipAction[]
): HTMLElement {
    const dom = createDiv();
    dom.className = 'embedding-hover-tooltip';

    dom.createDiv({ text: title, cls: 'embedding-hover-title' });

    for (const res of results) {
        const item = dom.createDiv({ cls: 'embedding-hover-item' });

        const headerDiv = item.createDiv();
        const pathSpan = headerDiv.createEl('a', { text: res.path, href: '#', cls: 'embedding-hover-link' });

        pathSpan.onclick = async (e) => {
            e.preventDefault();
            const file = app.vault.getAbstractFileByPath(res.path);
            const isMod = e.ctrlKey || e.metaKey;
            if (file instanceof TFile) {
                let leaf = app.workspace.getLeaf(isMod ? 'tab' : false);
                if (leaf.getRoot() !== app.workspace.rootSplit) {
                    const rootLeaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
                    leaf = isMod ? app.workspace.getLeaf('tab') : (rootLeaf || app.workspace.getLeaf('tab'));
                }
                await leaf.openFile(file, { eState: { line: res.startLine } });
            } else {
                await app.workspace.openLinkText(res.path, '', isMod);
            }
        };

        if (actions) {
            for (const action of actions(res)) {
                const btn = headerDiv.createEl('button', { text: action.label, cls: 'embedding-hover-insert-btn' });
                btn.title = action.title;
                btn.onclick = (e) => {
                    e.preventDefault();
                    action.onClick(res);
                };
            }
        }

        let scoreText = ` ${(res.similarity * 100).toFixed(0)}%`;
        if (res.linkPenalty > 0) scoreText += ' 🔗↓';
        const scoreSpan = headerDiv.createSpan({ text: scoreText, cls: 'embedding-hover-score' });
        if (res.linkPenalty > 0) {
            scoreSpan.title = `Penalized by -${Math.round(res.linkPenalty * 100)}% because it is already linked.`;
        }

        item.createDiv({ text: res.content, cls: 'embedding-hover-preview' });
    }

    return dom;
}

export function attachDismissHandler(tooltip: HTMLElement, onDismiss: () => void): () => void {
    const handler = (e: MouseEvent) => {
        if (!tooltip.contains(e.target as Node)) {
            onDismiss();
            document.removeEventListener('mousedown', handler);
        }
    };
    window.setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
}

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

                if (!plugin.settings.enableHoverTooltip) {
                    return;
                }

                const state = update.state;
                const selection = state.selection.main;

                if (!selection.empty) {
                    const text = state.doc.sliceString(selection.from, selection.to).trim();
                    if (text) {
                        this.timer = window.setTimeout(() => this.triggerSearch(text, selection.from, selection.to), 300);
                    }
                }
            }
        }

        async triggerSearch(text: string, from: number, to: number) {
            try {
                if (!plugin.settings.enableHoverTooltip) return;
                const cleanSelection = plugin.indexer.stripWikilinks(text);
                const queryText = `${plugin.settings.embeddingQueryPrefix || ''}${cleanSelection}`;
                const vectors = await plugin.indexer.embed([queryText]);
                if (vectors.length === 0) return;
                const vector = vectors[0] as number[];

                const activeFile = app.workspace.getActiveFile();
                const excludePath = activeFile ? activeFile.path : undefined;

                const results = await plugin.queryService.findSimilarForVector(vector, excludePath, 3);
                if (results.length === 0) return;

                const view = this.view;
                const dom = buildSimilarTooltip(app, results, 'Similar Snippets', (res) => [{
                    label: '🔗',
                    title: 'Insert wikilink',
                    onClick: () => {
                        const file = app.vault.getAbstractFileByPath(res.path);
                        let linkPath = res.path.replace(/\.md$/, '');
                        if (file instanceof TFile) {
                            const active = app.workspace.getActiveFile();
                            linkPath = app.metadataCache.fileToLinktext(file, active ? active.path : '');
                        }
                        view.dispatch({
                            changes: { from, to, insert: `[[${linkPath}|${text}]]` },
                            effects: setHoverTooltip.of(null)
                        });
                    }
                }]);

                this.view.dispatch({
                    effects: setHoverTooltip.of({
                        pos: to,
                        above: false,
                        create() { 
                            let attempts = 0;
                            const checkParent = () => {
                                let parent = dom.parentElement;
                                while (parent && !parent.classList.contains('cm-tooltip')) {
                                    parent = parent.parentElement;
                                }
                                if (parent) {
                                    parent.classList.add('embedding-popup-container');
                                } else if (attempts < 50) {
                                    attempts++;
                                    window.requestAnimationFrame(checkParent);
                                }
                            };
                            checkParent();

                            return { 
                                dom
                            }; 
                        }
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

    let cleanupDismiss: (() => void) | null = null;

    const removeTooltip = () => {
        if (currentTooltip) {
            currentTooltip.remove();
            currentTooltip = null;
        }
        if (cleanupDismiss) {
            cleanupDismiss();
            cleanupDismiss = null;
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

        let isInsideReadingView = false;
        let node = selection.anchorNode;
        while (node) {
            if (node.instanceOf(Element) && node.classList.contains('markdown-reading-view')) {
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
                if (!plugin.settings.enableHoverTooltip) return;
                const cleanSelection = plugin.indexer.stripWikilinks(text);
                const queryText = `${plugin.settings.embeddingQueryPrefix || ''}${cleanSelection}`;
                const vectors = await plugin.indexer.embed([queryText]);
                if (vectors.length === 0) return;
                const vector = vectors[0] as number[];

                const activeFile = app.workspace.getActiveFile();
                const excludePath = activeFile ? activeFile.path : undefined;

                const results = await plugin.queryService.findSimilarForVector(vector, excludePath, 3);
                if (results.length === 0) return;

                removeTooltip();

                const dom = buildSimilarTooltip(app, results, 'Similar Snippets');
                dom.classList.add('read-mode-tooltip', 'embedding-popup-container');
                dom.style.position = 'absolute';

                const tooltipWidth = 360;
                const tooltipHeight = 220;
                let left = rect.left + window.scrollX;
                if (rect.left + tooltipWidth > window.innerWidth - 20) {
                    left = Math.max(10, window.innerWidth - tooltipWidth - 20) + window.scrollX;
                }
                let top = rect.bottom + window.scrollY + 8;
                if (rect.bottom + tooltipHeight > window.innerHeight && rect.top > tooltipHeight) {
                    top = rect.top + window.scrollY - tooltipHeight - 8;
                }

                dom.style.left = `${left}px`;
                dom.style.top = `${top}px`;

                document.body.appendChild(dom);
                currentTooltip = dom;
                cleanupDismiss = attachDismissHandler(dom, removeTooltip);
            } catch (err) {
                console.error('Read mode hover search failed', err);
            }
        }, 300);
    };

    plugin.registerDomEvent(document, 'selectionchange', onSelectionChange);
}
