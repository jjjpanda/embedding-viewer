import { Extension, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { App, editorInfoField, TFile } from 'obsidian';
import { Indexer, Chunk } from './indexer';
import EmbeddingViewerPlugin from './main';
import { buildSimilarTooltip, attachDismissHandler } from './hover-widget';

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
            cleanupDismiss: (() => void) | null = null;
            cachedChunks: Chunk[] | null = null;

            constructor(public view: EditorView) {}

            update(update: ViewUpdate) {
                if (update.docChanged) {
                    this.cachedChunks = null;
                }
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
                if (this.cleanupDismiss) {
                    this.cleanupDismiss();
                    this.cleanupDismiss = null;
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

                let chunks = this.cachedChunks;
                if (!chunks) {
                    const content = view.state.doc.toString();
                    try {
                        chunks = indexer.extractChunks(content, file, plugin.settings.lastExcludedPhrases);
                        this.cachedChunks = chunks;
                    } catch (err) {
                        this.clear();
                        return;
                    }
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

                this.timer = window.setTimeout(() => { 
                    this.triggerHover(chunk, text, file, e.clientX, e.clientY).catch(err => {
                        console.error('Hover trigger failed:', err);
                    }); 
                }, 800);
            }

            async triggerHover(_chunk: Chunk, text: string, file: TFile, x: number, y: number) {
                try {
                    const cleanSelection = indexer.stripWikilinks(text);
                    const vectors = await indexer.embed([cleanSelection]);
                    if (vectors.length === 0) return;

                    const vector = vectors[0] as number[];
                    const results = await plugin.queryService.findSimilarForVector(vector, file.path, 3);
                    if (results.length === 0) return;

                    const dom = buildSimilarTooltip(app, results, 'Similar Snippets (Chunk)');
                    dom.classList.add('read-mode-tooltip');
                    dom.style.position = 'absolute';
                    dom.style.left = `${x}px`;
                    dom.style.top = `${y + 20}px`;

                    document.body.appendChild(dom);
                    this.currentTooltip = dom;
                    this.cleanupDismiss = attachDismissHandler(dom, () => this.clear());
                } catch (err) {
                    console.error('Trigger hover failed', err);
                }
            }
        }, {
            eventHandlers: {
                mousemove(e, view) {
                    (this as any).handleMove(e, view);
                },
                mouseleave(e, view) {
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
