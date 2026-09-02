import { Plugin, Notice, MarkdownView, WorkspaceLeaf, Menu } from 'obsidian';
import { DatabaseManager } from './db';
import { Indexer } from './indexer';
import { QueryService } from './query';
import { SimilarNotesView, SIMILAR_NOTES_VIEW_TYPE } from './view';
import { createChunkVisualizer, toggleVisualizerEffect } from './visualize-chunks';
import { EmbeddingViewerSettings, DEFAULT_SETTINGS, EmbeddingViewerSettingTab } from './settings';
import { SimilarityModal } from './modal';
import { LocalApi } from './api';
import { spawn, execSync, ChildProcess } from 'child_process';
import { hoverTooltipField, createHoverTooltipPlugin, setupReadModeHover } from './hover-widget';

export default class EmbeddingViewerPlugin extends Plugin {
    settings!: EmbeddingViewerSettings;
    dbManager!: DatabaseManager;
    queryService!: QueryService;
    indexer!: Indexer;
    api!: LocalApi;
    visualizerActive: boolean = false;
    onLaunchProcess: ChildProcess | null = null;
    statusBarItem!: HTMLElement;

    async onload() {
        await this.loadSettings();

        if (this.settings.onLaunchCommand) {
            console.log(`Executing on-launch command: ${this.settings.onLaunchCommand}`);
            this.onLaunchProcess = spawn(this.settings.onLaunchCommand, { shell: true });
            
            this.onLaunchProcess.stdout?.on('data', (data) => {
                console.log(`On-launch command stdout: ${data}`);
            });
            this.onLaunchProcess.stderr?.on('data', (data) => {
                console.error(`On-launch command stderr: ${data}`);
            });
            this.onLaunchProcess.on('error', (error) => {
                console.error(`On-launch command error: ${error.message}`);
                new Notice(`Startup command failed: ${error.message}`);
            });
            this.onLaunchProcess.on('exit', (code) => {
                if (code !== null && code !== 0) {
                    console.error(`On-launch command exited with code ${code}`);
                    new Notice(`Startup command exited with code ${code}`);
                }
            });
        }
        
        this.registerDomEvent(window, 'beforeunload', () => this.cleanupProcess());

        this.dbManager = new DatabaseManager(this);
        
        // Wait for DB to be ready
        await this.dbManager.getDb();

        this.queryService = new QueryService(this.dbManager, this);
        this.indexer = new Indexer(
            this.app,
            this.dbManager,
            this
        );

        const indexDebouncers = new Map<string, any>();
        
        const scheduleIndex = (file: any, eventName: string) => {
            if (file.extension !== 'md') return;

            const excluded = this.settings.excludedFolders
                .split('\n')
                .map((f: string) => f.trim())
                .filter((f: string) => f.length > 0);

            for (const ex of excluded) {
                if (file.path.startsWith(ex)) {
                    this.indexer.deleteFile(file.path);
                    return;
                }
            }

            if (indexDebouncers.has(file.path)) {
                clearTimeout(indexDebouncers.get(file.path)!);
            }
            indexDebouncers.set(file.path, setTimeout(() => {
                indexDebouncers.delete(file.path);
                this.indexer.indexFile(file);
            }, this.settings.debounceTime || 15000));
        };
        
        const eventBatches = {
            create: new Set<string>(),
            modify: new Set<string>(),
            delete: new Set<string>(),
            rename: new Set<string>()
        };
        let batchLogTimeout: any = null;

        const logBatch = () => {
            if (eventBatches.create.size > 0) {
                console.log(`[Embedding Viewer] Files created (${eventBatches.create.size}):`, Array.from(eventBatches.create));
                eventBatches.create.clear();
            }
            if (eventBatches.modify.size > 0) {
                console.log(`[Embedding Viewer] Files modified (${eventBatches.modify.size}):`, Array.from(eventBatches.modify));
                eventBatches.modify.clear();
            }
            if (eventBatches.delete.size > 0) {
                console.log(`[Embedding Viewer] Files deleted (${eventBatches.delete.size}):`, Array.from(eventBatches.delete));
                eventBatches.delete.clear();
            }
            if (eventBatches.rename.size > 0) {
                console.log(`[Embedding Viewer] Files renamed (${eventBatches.rename.size}):`, Array.from(eventBatches.rename));
                eventBatches.rename.clear();
            }
            batchLogTimeout = null;
        };

        const scheduleLog = (type: keyof typeof eventBatches, msg: string) => {
            eventBatches[type].add(msg);
            if (!batchLogTimeout) {
                batchLogTimeout = setTimeout(logBatch, 2000);
            }
        };

        this.registerEvent(this.app.vault.on('modify', (file) => {
            scheduleLog('modify', file.path);
            scheduleIndex(file, 'modify');
        }));
        this.registerEvent(this.app.vault.on('create', (file) => {
            scheduleLog('create', file.path);
            scheduleIndex(file, 'create');
        }));
        
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file.path && file.path.endsWith('.md')) {
                scheduleLog('delete', file.path);
                if (indexDebouncers.has(file.path)) {
                    clearTimeout(indexDebouncers.get(file.path)!);
                    indexDebouncers.delete(file.path);
                }
                this.indexer.deleteFile(file.path);
            }
        }));
        
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file.path && file.path.endsWith('.md')) {
                scheduleLog('rename', `${oldPath} -> ${file.path}`);
                this.indexer.deleteFile(oldPath);
                scheduleIndex(file, 'rename');
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
        this.api.start();

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new EmbeddingViewerSettingTab(this.app, this));

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.setText('');

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
                    if (msg === null) {
                        this.statusBarItem.setText('');
                    } else {
                        this.statusBarItem.setText(`🧠 ${msg}`);
                    }
                });
            },
        });

        this.addCommand({
            id: 'force-rebuild-vault-index',
            name: 'Force rebuild vault index',
            callback: async () => {
                await this.indexer.rebuildIndex((msg) => {
                    if (msg === null) {
                        this.statusBarItem.setText('');
                    } else {
                        this.statusBarItem.setText(`🧠 ${msg}`);
                    }
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
                                    const vectors = await this.indexer.embed([cleanSelection]);
                                    if (vectors.length === 0) {
                                        new Notice('Failed to generate embedding for selection.');
                                        return;
                                    }

                                    const vector = vectors[0] as number[];
                                    let excludePath = view.file ? view.file.path : undefined;
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

    async activateView() {
        const { workspace } = this.app;
        
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(SIMILAR_NOTES_VIEW_TYPE);
        
        if (leaves.length > 0) {
            // A leaf with our view already exists, use that
            leaf = leaves[0]!;
        } else {
            // Our view could not be found in the workspace, create a new leaf
            // as a split
            leaf = workspace.getLeaf('split');
            if (leaf) {
                await leaf.setViewState({ type: SIMILAR_NOTES_VIEW_TYPE, active: true });
            }
        }
        
        if (leaf) {
            // "Reveal" the leaf in case it is in a collapsed sidebar
            workspace.revealLeaf(leaf);
        }
    }

    cleanupProcess() {
        if (this.onLaunchProcess && this.onLaunchProcess.pid) {
            if (process.platform === 'win32') {
                try {
                    execSync(`taskkill /pid ${this.onLaunchProcess.pid} /T /F`);
                } catch (e) {
                    console.error("Failed to kill process tree", e);
                }
            } else {
                this.onLaunchProcess.kill();
            }
            this.onLaunchProcess = null;
        }
    }

    async onunload() {
        this.cleanupProcess();
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
