import { App, PluginSettingTab, Setting } from 'obsidian';
import type EmbeddingViewerPlugin from './main';

export interface EmbeddingViewerSettings {
    embeddingEndpoint: string;
    embeddingModel: string;
    embeddingPrefix: string;
    embeddingQueryPrefix: string;
    chunkSize: number;
    debounceTime: number;
    penaltyPerMonth: number;
    linkPenalty: number;
    minimumSimilarity: number;
    maximumSimilarity: number;
    excludedFolders: string;
    apiPort: number;
    enableApi: boolean;
    onLaunchCommand: string;
    lastExcludedPhrases: string[];
    batchSize: number;
    bulkIndexThreshold: number;
    enableHoverTooltip: boolean;
    showExplorerIndicators: boolean;
}

export const DEFAULT_SETTINGS: EmbeddingViewerSettings = {
    embeddingEndpoint: 'http://127.0.0.1:8081',
    embeddingModel: 'qwen3-embedding-0.6b',
    embeddingPrefix: 'passage: ',
    embeddingQueryPrefix: 'query: ',
    chunkSize: 250,
    debounceTime: 15000,
    penaltyPerMonth: 0.25,
    linkPenalty: 30,
    minimumSimilarity: 0.60,
    maximumSimilarity: 0.95,
    excludedFolders: '',
    apiPort: 27123,
    enableApi: false,
    onLaunchCommand: '',
    lastExcludedPhrases: [],
    batchSize: 50,
    bulkIndexThreshold: 20,
    enableHoverTooltip: true,
    showExplorerIndicators: true,
};

export class EmbeddingViewerSettingTab extends PluginSettingTab {
    plugin: EmbeddingViewerPlugin;

    constructor(app: App, plugin: EmbeddingViewerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // 1. Model & Endpoint Configuration
        new Setting(containerEl).setName('Model & Endpoint').setHeading();

        new Setting(containerEl)
            .setName('Embedding Endpoint')
            .setDesc('URL of the OpenAI-compatible embedding API endpoint (e.g., llama.cpp or Ollama).')
            .addText(text => text
                .setPlaceholder('http://127.0.0.1:8081')
                .setValue(this.plugin.settings.embeddingEndpoint)
                .onChange(async (value) => {
                    this.plugin.settings.embeddingEndpoint = value.trim();
                    this.plugin.indexer.updateSettings();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Embedding Model')
            .setDesc('Name of the model to use for embeddings.')
            .addText(text => text
                .setPlaceholder('qwen3-embedding-0.6b')
                .setValue(this.plugin.settings.embeddingModel)
                .onChange(async (value) => {
                    this.plugin.settings.embeddingModel = value.trim();
                    this.plugin.indexer.updateSettings();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Passage Prefix')
            .setDesc('Prefix prepended to chunks when indexing documents (e.g., "passage: ").')
            .addText(text => text
                .setPlaceholder('passage: ')
                .setValue(this.plugin.settings.embeddingPrefix)
                .onChange(async (value) => {
                    this.plugin.settings.embeddingPrefix = value;
                    this.plugin.indexer.updateSettings();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Query Prefix')
            .setDesc('Prefix prepended to search queries for asymmetric retrieval models (e.g., "query: ").')
            .addText(text => text
                .setPlaceholder('query: ')
                .setValue(this.plugin.settings.embeddingQueryPrefix)
                .onChange(async (value) => {
                    this.plugin.settings.embeddingQueryPrefix = value;
                    await this.plugin.saveSettings();
                }));

        // 2. Chunking & Indexing
        new Setting(containerEl).setName('Chunking & Indexing').setHeading();

        new Setting(containerEl)
            .setName('Chunk Size')
            .setDesc('Maximum number of characters per text chunk (50 to 5,000).')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '50';
                text.inputEl.max = '5000';
                text.inputEl.step = '50';
                text.setValue(this.plugin.settings.chunkSize.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 50 && parsed <= 5000) {
                            this.plugin.settings.chunkSize = parsed;
                            this.plugin.indexer.updateSettings();
                            await this.plugin.saveSettings();
                        }
                    });
            });

        new Setting(containerEl)
            .setName('Batch Size')
            .setDesc('Number of text chunks sent in a single embedding request (1 to 200).')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.max = '200';
                text.setValue(this.plugin.settings.batchSize.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 1 && parsed <= 200) {
                            this.plugin.settings.batchSize = parsed;
                            await this.plugin.saveSettings();
                        }
                    });
            });

        new Setting(containerEl)
            .setName('Bulk Index Threshold')
            .setDesc('Queue size threshold to switch from single-file updates to a full vault pass.')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '5';
                text.inputEl.max = '100';
                text.setValue(this.plugin.settings.bulkIndexThreshold.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 5 && parsed <= 100) {
                            this.plugin.settings.bulkIndexThreshold = parsed;
                            await this.plugin.saveSettings();
                        }
                    });
            });

        new Setting(containerEl)
            .setName('Indexing Debounce Time (ms)')
            .setDesc('Milliseconds to wait after typing stops before queuing a file for reindexing (default 15,000ms).')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1000';
                text.inputEl.step = '1000';
                text.setValue(this.plugin.settings.debounceTime.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 1000) {
                            this.plugin.settings.debounceTime = parsed;
                            await this.plugin.saveSettings();
                        }
                    });
            });

        new Setting(containerEl)
            .setName('Excluded Folders')
            .setDesc('Folders to exclude from indexing. One path per line (e.g., "templates/" or "archive/").')
            .addTextArea(text => text
                .setPlaceholder('templates/\njournal/')
                .setValue(this.plugin.settings.excludedFolders)
                .onChange(async (value) => {
                    this.plugin.settings.excludedFolders = value;
                    await this.plugin.saveSettings();
                    this.plugin.fileExplorerManager.updateFileExplorer();
                    const activeFile = this.plugin.app.workspace.getActiveFile();
                    if (activeFile) {
                        this.plugin.updateFileStatus(activeFile);
                    }
                }));

        new Setting(containerEl)
            .setName('Excluded Phrases / Boilerplate')
            .setDesc('Lines or headings to strip from chunk text and hierarchy (e.g. daily note headers like "## Habits" or "## Tasks"). One phrase per line. Run "Rebuild vault index" to re-process notes with the updated exclusions.')
            .addTextArea(text => text
                .setPlaceholder('## Habits\n## Daily Log\n## Tasks')
                .setValue((this.plugin.settings.lastExcludedPhrases || []).join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.lastExcludedPhrases = value
                        .split('\n')
                        .map(p => p.trim())
                        .filter(p => p.length > 0);
                    await this.plugin.saveSettings();
                }));

        // 3. Similarity & Penalties
        new Setting(containerEl).setName('Similarity & Ranking Penalties').setHeading();

        new Setting(containerEl)
            .setName('Minimum Similarity Threshold')
            .setDesc('Cutoff score below which chunks are excluded from results.')
            .addSlider(slider => slider
                .setLimits(10, 90, 1)
                .setValue(Math.round(this.plugin.settings.minimumSimilarity * 100))
                .onChange(async (value) => {
                    this.plugin.settings.minimumSimilarity = value / 100;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Maximum Similarity Threshold')
            .setDesc('Filter out near-identical duplicate text (above this score).')
            .addSlider(slider => slider
                .setLimits(70, 100, 1)
                .setValue(Math.round(this.plugin.settings.maximumSimilarity * 100))
                .onChange(async (value) => {
                    this.plugin.settings.maximumSimilarity = value / 100;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Recency Penalty (% / month)')
            .setDesc('Score deduction applied per month of note age to favor fresher notes.')
            .addSlider(slider => slider
                .setLimits(0, 50, 1)
                .setValue(Math.round(this.plugin.settings.penaltyPerMonth * 10))
                .onChange(async (value) => {
                    this.plugin.settings.penaltyPerMonth = value / 10;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Existing Link Penalty (%)')
            .setDesc('Score penalty applied when the candidate note is already linked to or from the active note.')
            .addSlider(slider => slider
                .setLimits(0, 60, 5)
                .setValue(this.plugin.settings.linkPenalty ?? 30)
                .onChange(async (value) => {
                    this.plugin.settings.linkPenalty = value;
                    await this.plugin.saveSettings();
                }));

        // 4. Editor & Interface
        new Setting(containerEl).setName('Editor & Interface').setHeading();

        new Setting(containerEl)
            .setName('Selection Hover Tooltips')
            .setDesc('Show similar snippets popup when selecting text in edit or reading mode.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableHoverTooltip)
                .onChange(async (value) => {
                    this.plugin.settings.enableHoverTooltip = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('File Explorer Status Indicators')
            .setDesc('Display unindexed and pending update indicator dots in the file explorer.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showExplorerIndicators)
                .onChange(async (value) => {
                    this.plugin.settings.showExplorerIndicators = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        this.plugin.fileExplorerManager.attachObservers();
                        this.plugin.fileExplorerManager.updateFileExplorer();
                    } else {
                        this.plugin.fileExplorerManager.cleanup();
                    }
                }));

        // 5. Local API & Automation
        new Setting(containerEl).setName('Local API & Automation').setHeading();

        new Setting(containerEl)
            .setName('Enable Local HTTP API')
            .setDesc('Expose /search and /rebuild on localhost (127.0.0.1) for external tools and scripts. Disabled by default for security.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableApi)
                .onChange(async (value) => {
                    this.plugin.settings.enableApi = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        this.plugin.api.start();
                    } else {
                        this.plugin.api.stop();
                    }
                }));

        new Setting(containerEl)
            .setName('API Port')
            .setDesc('Port number for the local HTTP API (1024 to 65535).')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1024';
                text.inputEl.max = '65535';
                text.setValue(this.plugin.settings.apiPort.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 1024 && parsed <= 65535) {
                            this.plugin.settings.apiPort = parsed;
                            await this.plugin.saveSettings();
                            if (this.plugin.settings.enableApi) {
                                this.plugin.api.stop();
                                this.plugin.api.start();
                            }
                        }
                    });
            });

        new Setting(containerEl)
            .setName('On-Launch Server Command')
            .setDesc('Optional terminal command to start the embedding server on plugin load. Caution: executes with your system user privileges.')
            .addText(text => text
                .setPlaceholder('/usr/local/bin/llama-server -m ...')
                .setValue(this.plugin.settings.onLaunchCommand)
                .onChange(async (value) => {
                    this.plugin.settings.onLaunchCommand = value;
                    await this.plugin.saveSettings();
                }));
    }
}
