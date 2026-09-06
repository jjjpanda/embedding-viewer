import { App, PluginSettingTab, Setting } from 'obsidian';
import EmbeddingViewerPlugin from './main';

export interface EmbeddingViewerSettings {
    embeddingEndpoint: string;
    embeddingModel: string;
    embeddingPrefix: string;
    chunkSize: number;
    debounceTime: number;
    penaltyPerMonth: number;
    minimumSimilarity: number;
    maximumSimilarity: number;
    excludedFolders: string;
    apiPort: number;
    onLaunchCommand: string;
    lastExcludedPhrases: string[];
    batchSize: number;
    bulkIndexThreshold: number;
}

export const DEFAULT_SETTINGS: EmbeddingViewerSettings = {
    embeddingEndpoint: 'http://127.0.0.1:8081',
    embeddingModel: 'qwen3-embedding-0.6b',
    embeddingPrefix: 'passage: ',
    chunkSize: 250,
    debounceTime: 15000,
    penaltyPerMonth: 0.25,
    minimumSimilarity: 0.60,
    maximumSimilarity: 0.95,
    excludedFolders: '',
    apiPort: 27123,
    onLaunchCommand: '',
    lastExcludedPhrases: [],
    batchSize: 50,
    bulkIndexThreshold: 20,
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

        new Setting(containerEl).setName("Model Configuration").setHeading();

        new Setting(containerEl)
            .setName('Embedding Endpoint')
            .setDesc('URL of the embedding API endpoint.')
            .addText(text => text
                .setPlaceholder('http://127.0.0.1:8081')
                .setValue(this.plugin.settings.embeddingEndpoint)
                .onChange(async (value) => {
                    this.plugin.settings.embeddingEndpoint = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Embedding Model')
            .setDesc('Name of the model to use for embeddings.')
            .addText(text => text
                .setPlaceholder('qwen3-embedding-0.6b')
                .setValue(this.plugin.settings.embeddingModel)
                .onChange(async (value) => {
                    this.plugin.settings.embeddingModel = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Embedding Prefix')
            .setDesc('Prefix to append to text chunks before embedding (e.g. "passage: " or "search_document: ").')
            .addText(text => text
                .setPlaceholder('passage: ')
                .setValue(this.plugin.settings.embeddingPrefix)
                .onChange(async (value) => {
                    this.plugin.settings.embeddingPrefix = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName("Chunking & Searching").setHeading();

        new Setting(containerEl)
            .setName('Chunk Size')
            .setDesc('Maximum number of characters per text chunk.')
            .addText(text => text
                .setPlaceholder('1500')
                .setValue(this.plugin.settings.chunkSize.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.chunkSize = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Batch Size')
            .setDesc('Number of text chunks to embed in a single request. (Default 50)')
            .addText(text => text
                .setPlaceholder('50')
                .setValue(this.plugin.settings.batchSize.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed) && parsed > 0) {
                        this.plugin.settings.batchSize = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Bulk Index Threshold')
            .setDesc('If more than this many files are queued for indexing, trigger a fast multi-file rebuild instead. (Default 20)')
            .addText(text => text
                .setPlaceholder('20')
                .setValue(this.plugin.settings.bulkIndexThreshold.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed) && parsed > 0) {
                        this.plugin.settings.bulkIndexThreshold = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Indexing Debounce Time (ms)')
            .setDesc('Milliseconds to wait after you stop typing before indexing a file. Increase this if indexing feels laggy while you edit (default 15000).')
            .addText(text => text
                .setPlaceholder('15000')
                .setValue(this.plugin.settings.debounceTime.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.debounceTime = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Recency Penalty (%)')
            .setDesc('Percentage score penalty applied per month of note age (e.g., 1.0 for a 1% penalty per month).')
            .addText(text => text
                .setPlaceholder('1.0')
                .setValue(this.plugin.settings.penaltyPerMonth.toString())
                .onChange(async (value) => {
                    const parsed = parseFloat(value);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.penaltyPerMonth = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Minimum Similarity Threshold')
            .setDesc('Hide results that fall below this similarity score (e.g. 0.70). Prevents garbage results.')
            .addText(text => text
                .setPlaceholder('0.70')
                .setValue(this.plugin.settings.minimumSimilarity.toString())
                .onChange(async (value) => {
                    const parsed = parseFloat(value);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.minimumSimilarity = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Maximum Similarity Threshold')
            .setDesc('Hide results that are too similar (e.g., > 0.95) to filter out exact duplicate text and boilerplate.')
            .addText(text => text
                .setPlaceholder('0.95')
                .setValue(this.plugin.settings.maximumSimilarity.toString())
                .onChange(async (value) => {
                    const parsed = parseFloat(value);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.maximumSimilarity = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl).setName("Advanced").setHeading();

        new Setting(containerEl)
            .setName('Excluded Folders')
            .setDesc('Folders to ignore during indexing. One per line (e.g. "templates/").')
            .addTextArea(text => text
                .setPlaceholder('templates/\njournal/')
                .setValue(this.plugin.settings.excludedFolders)
                .onChange(async (value) => {
                    this.plugin.settings.excludedFolders = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateFileExplorer();
                    const activeFile = this.plugin.app.workspace.getActiveFile();
                    if (activeFile) {
                        this.plugin.updateFileStatus(activeFile);
                    }
                }));

        new Setting(containerEl)
            .setName('API Port')
            .setDesc('Port number for the local HTTP API that agents can use to query the plugin. Restart plugin to apply.')
            .addText(text => text
                .setPlaceholder('27123')
                .setValue(this.plugin.settings.apiPort.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
                        this.plugin.settings.apiPort = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('On-Launch Command')
            .setDesc('A terminal command to execute when the plugin loads (e.g., to start the local embedding server).')
            .addText(text => text
                .setPlaceholder('cd /path/to/server && ./server.sh')
                .setValue(this.plugin.settings.onLaunchCommand)
                .onChange(async (value) => {
                    this.plugin.settings.onLaunchCommand = value;
                    await this.plugin.saveSettings();
                }));
    }
}
