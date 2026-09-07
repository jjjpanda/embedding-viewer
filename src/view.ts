import { ItemView, WorkspaceLeaf, MarkdownView, TFile } from 'obsidian';
import EmbeddingViewerPlugin from './main';
import { ChunkMatchGroup, QueryResult } from './query';

export const SIMILAR_NOTES_VIEW_TYPE = 'similar-notes-view';

export class SimilarNotesView extends ItemView {
    plugin: EmbeddingViewerPlugin;
    activeFile: string | null = null;
    animationId: number | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: EmbeddingViewerPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return SIMILAR_NOTES_VIEW_TYPE;
    }

    getDisplayText() {
        return 'Similar Notes';
    }

    getIcon() {
        return 'network';
    }

    async onOpen() {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            this.activeFile = activeFile.path;
        }
        
        this.updateView();
        
        let debounceTimer: any = null;

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (debounceTimer) {
                    window.clearTimeout(debounceTimer);
                }
                
                debounceTimer = window.setTimeout(() => {
                    if (file && file.extension === 'md') {
                        if (file.path !== this.activeFile) {
                            this.activeFile = file.path;
                            this.updateView();
                        }
                    } else {
                        if (this.activeFile !== null) {
                            this.activeFile = null;
                            this.updateView();
                        }
                    }
                }, 400);
            })
        );
    }

    async onClose() {
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    async updateView() {
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        const container = this.contentEl;
        container.empty();

        if (!this.activeFile) {
            const p = container.createEl('p', { text: 'Open a markdown file to see similar notes.' });
            p.style.color = 'var(--text-muted)';
            return;
        }

        try {
            const path = this.activeFile;
            
            const tfile = this.app.vault.getAbstractFileByPath(path);
            if (tfile instanceof TFile && this.plugin.isFileExcluded(tfile)) {
                const p = container.createEl('p', { text: 'This note is excluded from embeddings.' });
                p.style.color = 'var(--text-muted)';
                return;
            }

            if (!this.plugin.dbManager.state.registry[path]) {
                const p = container.createEl('p', { text: 'This note has not been indexed yet.' });
                p.style.color = 'var(--text-muted)';
                if (tfile instanceof TFile) {
                    const btn = container.createEl('button', { text: 'Index this note now' });
                    btn.style.marginTop = '8px';
                    btn.onclick = async () => {
                        btn.disabled = true;
                        btn.setText('Indexing...');
                        try {
                            await this.plugin.indexer.queueFileForIndex(tfile, true);
                        } catch (e) {
                            console.error('Failed to index file from view:', e);
                        } finally {
                            this.updateView();
                        }
                    };
                }
                return;
            }

            container.createEl('h3', { text: 'Loading similar notes...' });

            // Fetch chunk-level matches
            const chunkGroups = await this.plugin.queryService.findSimilarPerChunk(path, 3, 4);
            
            if (this.activeFile !== path) return; // Leaf changed while fetching
            
            container.empty();

            if (!chunkGroups || chunkGroups.length === 0) {
                const minScore = Math.round((this.plugin.settings.minimumSimilarity ?? 0.6) * 100);
                const p = container.createEl('p', { text: `No similar snippets found above ${minScore}% similarity.` });
                p.style.color = 'var(--text-muted)';
                return;
            }

            // Render Chunk-Level Matches
            container.createEl('h3', { text: 'Similar Snippets' });
            
            const activeBasename = this.activeFile.split('/').pop()?.replace(/\.md$/, '') || this.activeFile;
            const subtitle = container.createDiv({ text: activeBasename });
            subtitle.style.fontSize = '0.9em';
            subtitle.style.color = 'var(--text-muted)';
            subtitle.style.marginBottom = '16px';
            
            for (const group of chunkGroups) {
                const groupDiv = container.createDiv();
                groupDiv.style.marginBottom = '12px';
                groupDiv.style.fontSize = '0.9em';
                
                const rationaleLabel = groupDiv.createDiv();
                rationaleLabel.style.fontSize = '0.85em';
                rationaleLabel.style.color = 'var(--text-muted)';
                rationaleLabel.style.marginBottom = '2px';
                rationaleLabel.textContent = 'Matches your snippet:';
                
                const sourceDiv = groupDiv.createDiv();
                sourceDiv.style.borderLeft = '2px solid var(--interactive-accent)';
                sourceDiv.style.paddingLeft = '8px';
                sourceDiv.style.color = 'var(--text-faint)';
                sourceDiv.style.opacity = '0.8';
                sourceDiv.style.marginBottom = '8px';
                sourceDiv.style.whiteSpace = 'nowrap';
                sourceDiv.style.overflow = 'hidden';
                sourceDiv.style.textOverflow = 'ellipsis';
                sourceDiv.style.fontStyle = 'italic';
                
                const sourceText = group.sourceHeading 
                    ? `[${group.sourceHeading}] ${String(group.sourceContent).replace(/\r?\n/g, ' ')}`
                    : String(group.sourceContent).replace(/\r?\n/g, ' ');
                sourceDiv.textContent = `"${sourceText}"`;
                
                for (const res of group.matches) {
                    const matchDiv = groupDiv.createDiv();
                    matchDiv.style.paddingLeft = '12px';
                    matchDiv.style.whiteSpace = 'nowrap';
                    matchDiv.style.overflow = 'hidden';
                    matchDiv.style.textOverflow = 'ellipsis';
                    matchDiv.style.marginBottom = '2px';
                    
                    const parts = res.path.split('/');
                    const basename = (parts.pop() || '').replace(/\.md$/, '');
                    const score = Math.round(res.similarity * 100);
                    
                    const link = matchDiv.createEl('a', { text: basename, href: '#' });
                    link.style.fontWeight = '500';
                    link.style.textDecoration = 'none';
                    link.onclick = async (e) => {
                        e.preventDefault();
                        const file = this.app.vault.getAbstractFileByPath(res.path);
                        const isMod = e.ctrlKey || e.metaKey;
                        if (file instanceof TFile) {
                            let leaf = this.app.workspace.getLeaf(isMod ? 'tab' : false);
                            if (leaf.getRoot() !== this.app.workspace.rootSplit) {
                                const rootLeaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
                                leaf = isMod ? this.app.workspace.getLeaf('tab') : (rootLeaf || this.app.workspace.getLeaf('tab'));
                            }
                            await leaf.openFile(file, { eState: { line: res.startLine } });
                        } else {
                            await this.app.workspace.openLinkText(res.path, '', isMod);
                        }
                    };

                    let scoreText = ` (${score}%) `;
                    if (res.linkPenalty > 0) {
                        scoreText += '🔗↓ ';
                    }
                    const scoreSpan = matchDiv.createSpan({ text: scoreText });
                    scoreSpan.style.color = 'var(--text-faint)';
                    scoreSpan.style.fontSize = '0.9em';
                    
                    if (res.linkPenalty > 0) {
                        scoreSpan.title = `Penalized by -${Math.round(res.linkPenalty * 100)}% because it is already linked.`;
                    }
                    
                    const resText = res.heading
                        ? `[${res.heading}] ${String(res.content).replace(/\r?\n/g, ' ')}`
                        : String(res.content).replace(/\r?\n/g, ' ');
                    const textSpan = matchDiv.createSpan({ text: `- ${resText}` });
                    textSpan.style.color = 'var(--text-normal)';
                    textSpan.style.opacity = '0.9';
                }
            }
        } catch (err) {
            console.error('Failed to load similar notes view:', err);
            container.empty();
            container.createEl('p', { text: 'Error loading similar notes.' });
        }
    }
}
