import { Extension, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { App, editorInfoField, TFile } from 'obsidian';
import { Indexer, Chunk } from './indexer';
import EmbeddingViewerPlugin from './main';

export const toggleVisualizerEffect = StateEffect.define<boolean>();

class ChunkVisualizerPlugin {
    decorations: DecorationSet;

    constructor(view: EditorView, private indexer: Indexer, private plugin: EmbeddingViewerPlugin) {
        this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.transactions.some(tr => tr.effects.some(e => e.is(toggleVisualizerEffect)))) {
            this.decorations = this.buildDecorations(update.view);
        }
    }

    buildDecorations(view: EditorView): DecorationSet {
        if (!this.plugin.visualizerActive) {
            return Decoration.none;
        }

        const fileInfo = view.state.field(editorInfoField, false);
        const file = fileInfo?.file;
        if (!file || !(file instanceof TFile)) {
            return Decoration.none;
        }

        const content = view.state.doc.toString();
        
        let chunks: Chunk[] = [];
        try {
            chunks = this.indexer.extractChunks(content, file, this.plugin.settings.lastExcludedPhrases);
        } catch (e) {
            console.error("Failed to extract chunks for visualization", e);
            return Decoration.none;
        }

        const builder = new RangeSetBuilder<Decoration>();
        const lines = content.split(/\r?\n/);
        
        // Collect decorations to ensure they are added in strictly ascending order without duplicates
        const decorations: { pos: number, dec: Decoration }[] = [];
        const addedPositions = new Set<number>();

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            const className = i % 2 === 0 ? 'embedding-chunk-highlight-1' : 'embedding-chunk-highlight-2';
            
            const dec = Decoration.line({
                attributes: { class: className },
            });

            // Ensure we don't go out of bounds if chunk.startLine / endLine is weird
            const start = Math.max(0, chunk.startLine);
            const end = Math.min(lines.length - 1, chunk.endLine);

            for (let lineNum = start; lineNum <= end; lineNum++) {
                // Line numbers in CodeMirror are 1-indexed
                const cmLineNum = lineNum + 1;
                if (cmLineNum <= view.state.doc.lines) {
                    const line = view.state.doc.line(cmLineNum);
                    if (!addedPositions.has(line.from)) {
                        decorations.push({ pos: line.from, dec });
                        addedPositions.add(line.from);
                    }
                }
            }
        }

        decorations.sort((a, b) => a.pos - b.pos);
        for (const item of decorations) {
            builder.add(item.pos, item.pos, item.dec);
        }

        return builder.finish();
    }
}

export function createChunkVisualizer(app: App, indexer: Indexer, plugin: EmbeddingViewerPlugin): Extension {
    return [
        ViewPlugin.define(
            view => new ChunkVisualizerPlugin(view, indexer, plugin),
            {
                decorations: v => v.decorations
            }
        ),
        ViewPlugin.fromClass(class {
            timer: number | null = null;
            lastHoveredChunkIndex: number | null = null;
            currentTooltip: HTMLElement | null = null;

            constructor(public view: EditorView) {}

            update(update: ViewUpdate) {
                if (update.docChanged || update.selectionSet) {
                    this.clear();
                }
            }

            destroy() {
                this.clear();
            }

            clear() {
                if (this.timer) window.clearTimeout(this.timer);
                this.timer = null;
                this.lastHoveredChunkIndex = null;
                if (this.currentTooltip) {
                    this.currentTooltip.remove();
                    this.currentTooltip = null;
                }
            }

            handleMove(e: MouseEvent, view: EditorView) {
                // If selection exists, do not show chunk tooltip
                if (!view.state.selection.main.empty) {
                    this.clear();
                    return;
                }

                if (!plugin.visualizerActive) {
                    this.clear();
                    return;
                }

                // Don't clear if moving inside the tooltip
                if (this.currentTooltip && this.currentTooltip.contains(e.target as Node)) {
                    return;
                }

                const posInfo = view.posAtCoords({ x: e.clientX, y: e.clientY });
                if (posInfo === null) {
                    this.clear();
                    return;
                }

                const fileInfo = view.state.field(editorInfoField, false);
                const file = fileInfo?.file;
                if (!file || !(file instanceof TFile)) return;

                const content = view.state.doc.toString();
                let chunks: Chunk[] = [];
                try {
                    chunks = indexer.extractChunks(content, file, plugin.settings.lastExcludedPhrases);
                } catch (err) {
                    this.clear();
                    return;
                }

                const lineNum = view.state.doc.lineAt(posInfo).number - 1;
                const chunkIndex = chunks.findIndex(c => lineNum >= c.startLine && lineNum <= c.endLine);

                if (chunkIndex === -1) {
                    this.clear();
                    return;
                }

                if (this.lastHoveredChunkIndex === chunkIndex) {
                    return; // Still hovering the same chunk
                }

                this.clear(); // Clears timer and tooltip
                this.lastHoveredChunkIndex = chunkIndex;

                const chunk = chunks[chunkIndex]!;
                const text = chunk.content.trim();
                if (!text) return;

                this.timer = window.setTimeout(() => this.triggerHover(chunk, text, file, e.clientX, e.clientY), 800);
            }

            async triggerHover(chunk: Chunk, text: string, file: TFile, x: number, y: number) {
                try {
                    const cleanSelection = indexer.stripWikilinks(text);
                    const vectors = await indexer.embed([cleanSelection]);
                    if (vectors.length === 0) return;
                    
                    const vector = vectors[0] as number[];
                    const excludePath = file.path;
                    
                    const results = await plugin.queryService.findSimilarForVector(vector, excludePath, 3);
                    if (results.length === 0) return;

                    const dom = document.createElement('div');
                    dom.className = 'embedding-hover-tooltip';
                    dom.style.position = 'absolute';
                    dom.style.left = `${x}px`;
                    dom.style.top = `${y + 20}px`;
                    dom.style.padding = '10px';
                    dom.style.maxWidth = '350px';
                    dom.style.backgroundColor = 'var(--background-primary)';
                    dom.style.border = '1px solid var(--background-modifier-border)';
                    dom.style.borderRadius = '8px';
                    dom.style.boxShadow = '0 8px 16px rgba(0,0,0,0.2)';
                    dom.style.zIndex = '1000';
                    dom.style.cursor = 'default';

                    const title = dom.createEl('div', { text: 'Similar Snippets (Chunk)', cls: 'embedding-hover-title' });
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
                        
                        let scoreText = ` ${(res.similarity * 100).toFixed(0)}%`;
                        if (res.linkPenalty > 0) {
                            scoreText += ' 🔗↓';
                        }
                        const scoreSpan = headerDiv.createSpan({ text: scoreText });
                        scoreSpan.style.color = 'var(--text-muted)';
                        scoreSpan.style.float = 'right';
                        scoreSpan.style.fontSize = '0.9em';
                        if (res.linkPenalty > 0) {
                            scoreSpan.title = `Penalized by -${Math.round(res.linkPenalty * 100)}% because it is already linked.`;
                        }

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
                    }
                    
                    document.body.appendChild(dom);
                    this.currentTooltip = dom;

                    const onClickOutside = (e: MouseEvent) => {
                        if (!this.currentTooltip || !this.currentTooltip.contains(e.target as Node)) {
                            this.clear();
                            document.removeEventListener('mousedown', onClickOutside);
                        }
                    };
                    setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
                } catch (err) {
                    console.error(err);
                }
            }
        }, {
            eventHandlers: {
                mousemove(e, view) {
                    (this as any).handleMove(e, view);
                },
                mouseleave(e, view) {
                    // Do not clear immediately on mouseleave if they are moving to the tooltip
                    // Actually, the tooltip is appended to body, so moving to tooltip might trigger mouseleave on editor.
                    // We can handle this by checking relatedTarget.
                    const target = e.relatedTarget as Node;
                    if ((this as any).currentTooltip && (this as any).currentTooltip.contains(target)) {
                        return;
                    }
                    (this as any).clear();
                }
            }
        })
    ];
}
