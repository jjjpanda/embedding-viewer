import { Plugin, Notice, MarkdownView, WorkspaceLeaf, TFile } from 'obsidian';
import { DatabaseManager } from './db';
import { Indexer } from './indexer';
import { QueryService } from './query';
import { SimilarNotesView, SIMILAR_NOTES_VIEW_TYPE } from './view';
import { createChunkVisualizer, toggleVisualizerEffect } from './visualize-chunks';
import { EmbeddingViewerSettings, DEFAULT_SETTINGS, EmbeddingViewerSettingTab } from './settings';
import { SimilarityModal } from './modal';
import { LocalApi } from './api';
import { ServerProcessManager } from './server-process';
import { FileExplorerManager } from './file-explorer';
import { hoverTooltipField, createHoverTooltipPlugin, setupReadModeHover } from './hover-widget';

export default class EmbeddingViewerPlugin extends Plugin {
    settings!: EmbeddingViewerSettings;
    dbManager!: DatabaseManager;
    queryService!: QueryService;
    indexer!: Indexer;
    api!: LocalApi;
    serverProcessManager!: ServerProcessManager;
    fileExplorerManager!: FileExplorerManager;
    visualizerActive: boolean = false;
    statusBarItem!: HTMLElement;
    fileStatusItem!: HTMLElement;

    async onload() {
        await this.loadSettings();

        this.serverProcessManager = new ServerProcessManager();
        if (this.settings.onLaunchCommand) {
            this.serverProcessManager.start(this.settings.onLaunchCommand);
        }
        this.registerDomEvent(window, 'beforeunload', () => this.serverProcessManager.stop());

        this.dbManager = new DatabaseManager(this);
        this.queryService = new QueryService(this.dbManager, this);
        this.indexer = new Indexer(this.app, this.dbManager, this);
        this.fileExplorerManager = new FileExplorerManager(this.app, this);

        const indexDebouncers = new Map<string, number>();

        const scheduleIndex = (file: TFile) => {
            if (file.extension !== 'md') return;

            if (this.isFileExcluded(file)) {
                this.indexer.deleteFile(file.path);
                return;
            }

            if (indexDebouncers.has(file.path)) {
                window.clearTimeout(indexDebouncers.get(file.path));
            }
            indexDebouncers.set(file.path, window.setTimeout(() => {
                indexDebouncers.delete(file.path);
                this.indexer.queueFileForIndex(file);
            }, this.settings.debounceTime || 15000));
        };

        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file instanceof TFile) {
                scheduleIndex(file);
                this.fileExplorerManager.updateFileExplorer();
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.path === file.path) {
                    this.updateFileStatus(activeFile);
                }
            }
        }));

        this.registerEvent(this.app.vault.on('create', (file) => {
            if (file instanceof TFile) {
                scheduleIndex(file);
                this.fileExplorerManager.updateFileExplorer();
            }
        }));

        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file.path && file.path.endsWith('.md')) {
                if (indexDebouncers.has(file.path)) {
                    window.clearTimeout(indexDebouncers.get(file.path));
                    indexDebouncers.delete(file.path);
                }
                this.indexer.deleteFile(file.path);
                this.fileExplorerManager.updateFileExplorer();
            }
        }));

        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile && file.path.endsWith('.md')) {
                this.indexer.deleteFile(oldPath);
                scheduleIndex(file);
                this.fileExplorerManager.updateFileExplorer();
            }
        }));

        this.registerEditorExtension([
            createChunkVisualizer(this.app, this.indexer, this),
            hoverTooltipField,
            createHoverTooltipPlugin(this.app, this)
        ]);

        this.registerView(
            SIMILAR_NOTES_VIEW_TYPE,
            (leaf) => new SimilarNotesView(leaf, this)
        );

        this.addRibbonIcon('network', 'Open Similar Notes', () => {
            this.activateView();
        });

        setupReadModeHover(this.app, this);

        this.api = new LocalApi(this);
        if (this.settings.enableApi) {
            this.api.start();
        }

        this.addSettingTab(new EmbeddingViewerSettingTab(this.app, this));

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.setText('');

        this.fileStatusItem = this.addStatusBarItem();
        this.fileStatusItem.setText('🧠 Booting DB...');

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                this.updateFileStatus(file);
            })
        );
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                window.setTimeout(() => {
                    this.updateFileStatus(this.app.workspace.getActiveFile());
                }, 50);
            })
        );
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.fileExplorerManager.attachObservers();
                this.fileExplorerManager.updateFileExplorer();
            })
        );

        this.dbManager.loadDb().then(() => {
            const onReady = () => {
                const activeFile = this.app.workspace.getActiveFile();
                this.updateFileStatus(activeFile);
                this.fileExplorerManager.attachObservers();
                this.fileExplorerManager.updateFileExplorer();
            };

            if (this.app.workspace.layoutReady) {
                onReady();
            } else {
                this.app.workspace.onLayoutReady(onReady);
            }
        });

        this.addCommand({
            id: 'toggle-chunk-visualizer',
            name: 'Toggle Chunk Visualizer',
            callback: () => {
                this.visualizerActive = !this.visualizerActive;
                new Notice(`Chunk Visualizer ${this.visualizerActive ? 'ON' : 'OFF'}`);

                this.app.workspace.iterateAllLeaves((leaf) => {
                    if (leaf.view instanceof MarkdownView && leaf.view.editor) {
                        // @ts-ignore - internal cm property
                        const cm = leaf.view.editor.cm;
                        if (cm) {
                            cm.dispatch({
                                effects: toggleVisualizerEffect.of(this.visualizerActive)
                            });
                        }
                    }
                });
            }
        });

        this.addCommand({
            id: 'rebuild-vault-index',
            name: 'Rebuild vault index',
            callback: async () => {
                await this.indexer.rebuildIndex((msg) => {
                    this.statusBarItem.setText(msg === null ? '' : `🧠 ${msg}`);
                });
            },
        });

        this.addCommand({
            id: 'force-rebuild-vault-index',
            name: 'Force rebuild vault index',
            callback: async () => {
                await this.indexer.rebuildIndex((msg) => {
                    this.statusBarItem.setText(msg === null ? '' : `🧠 ${msg}`);
                }, true);
            },
        });

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                let selection = editor.getSelection().trim();
                if (!selection) {
                    const cursor = editor.getCursor();
                    selection = editor.getLine(cursor.line).trim();
                }
                if (selection) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Find similar notes for selection (Semantic)')
                            .setIcon('search')
                            .onClick(async () => {
                                new Notice('Analyzing selection similarity...');

                                try {
                                    const cleanSelection = this.indexer.stripWikilinks(selection);
                                    const queryText = `${this.settings.embeddingQueryPrefix || ''}${cleanSelection}`;
                                    const vectors = await this.indexer.embed([queryText]);
                                    if (vectors.length === 0) {
                                        new Notice('Failed to generate embedding for selection.');
                                        return;
                                    }

                                    const vector = vectors[0] as number[];
                                    const excludePath = view.file ? view.file.path : undefined;
                                    const results = await this.queryService.findSimilarForVector(vector, excludePath, 5);

                                    if (results.length === 0) {
                                        new Notice('No similar chunks found.');
                                        return;
                                    }

                                    new SimilarityModal(this.app, selection, results).open();
                                } catch (err) {
                                    console.error(err);
                                    new Notice('Error analyzing similarity.');
                                }
                            });
                    });
                }
            })
        );
    }

    updateFileExplorer() {
        this.fileExplorerManager.updateFileExplorer();
    }

    getExcludedFolders(): string[] {
        if (!this.settings.excludedFolders) return [];
        return this.settings.excludedFolders
            .split('\n')
            .map((f: string) => f.trim().replace(/^(\.\/|\/)+/, '').replace(/\/+$/, ''))
            .filter((f: string) => f.length > 0);
    }

    isPathExcluded(path: string, excludedList?: string[]): boolean {
        if (path === 'profiler.md' || path.endsWith('/profiler.md')) {
            return true;
        }

        const excluded = excludedList ?? this.getExcludedFolders();
        if (excluded.length === 0) return false;

        const normalizedPath = path.replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '');

        for (const ex of excluded) {
            if (normalizedPath === ex || normalizedPath.startsWith(ex + '/')) {
                return true;
            }
        }

        return false;
    }

    isFileExcluded(file: TFile, excludedList?: string[]): boolean {
        if (this.isPathExcluded(file.path, excludedList)) {
            return true;
        }

        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter?.['exclude_embedding'] === true) {
            return true;
        }

        return false;
    }

    async updateFileStatus(file: TFile | null) {
        let targetFile = file;
        if (!targetFile) {
            targetFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file || null;
        }

        if (!targetFile || targetFile.extension !== 'md') {
            if (this.fileStatusItem) this.fileStatusItem.setText('');
            return;
        }

        if (this.isFileExcluded(targetFile)) {
            if (this.fileStatusItem) {
                this.fileStatusItem.setText('🧠 Excluded');
                this.fileStatusItem.setAttribute('aria-label', 'This file is excluded from embedding index');
            }
            return;
        }

        try {
            const reg = this.dbManager.state.registry[targetFile.path];

            if (reg) {
                if (Math.floor(Number(reg.mtime)) === Math.floor(targetFile.stat.mtime)) {
                    this.fileStatusItem.setText('🧠 Indexed');
                    this.fileStatusItem.setAttribute('aria-label', 'This file is in the embedding index and up to date');
                } else {
                    this.fileStatusItem.setText('🧠 Pending Update');
                    this.fileStatusItem.setAttribute('aria-label', 'This file has changes waiting to be indexed');
                }
            } else {
                this.fileStatusItem.setText('🧠 Unindexed');
                this.fileStatusItem.setAttribute('aria-label', 'This file is not indexed');
            }
        } catch (error) {
            console.error('[Embedding Viewer] updateFileStatus error:', error);
            this.fileStatusItem.setText('🧠 DB Error');
        }
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(SIMILAR_NOTES_VIEW_TYPE);

        if (leaves.length > 0) {
            leaf = leaves[0]!;
        } else {
            leaf = workspace.getLeaf('split');
            if (leaf) {
                await leaf.setViewState({ type: SIMILAR_NOTES_VIEW_TYPE, active: true });
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    async onunload() {
        this.serverProcessManager.stop();
        this.fileExplorerManager.cleanup();

        if (this.api) {
            this.api.stop();
        }
        if (this.dbManager) {
            await this.dbManager.close();
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
