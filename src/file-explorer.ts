import { App, TFile, TFolder } from 'obsidian';
import type EmbeddingViewerPlugin from './main';

export class FileExplorerManager {
    private observers: MutationObserver[] = [];
    private updateTimeout: number | null = null;

    constructor(private app: App, private plugin: EmbeddingViewerPlugin) {}

    public attachObservers(): void {
        this.disconnectObservers();

        if (!this.plugin.settings.showExplorerIndicators) {
            return;
        }

        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        for (const leaf of leaves) {
            const container = (leaf.view as any)?.containerEl;
            if (!container) continue;

            const obs = new MutationObserver((mutations) => {
                const hasRelevantMutation = mutations.some((m) => {
                    if (m.type === 'childList') return true;
                    if (m.type === 'attributes' && m.attributeName === 'class') {
                        const target = m.target as HTMLElement;
                        const oldClass = m.oldValue || '';
                        const currentClass = target.className || '';
                        const wasCollapsed = oldClass.includes('is-collapsed');
                        const isCollapsed = currentClass.includes('is-collapsed');
                        if (wasCollapsed !== isCollapsed) return true;
                        const stripOurClasses = (s: string) => s.replace(/embedding-(unindexed|pending|indexed)/g, '').trim();
                        return stripOurClasses(oldClass) !== stripOurClasses(currentClass);
                    }
                    return false;
                });
                if (hasRelevantMutation) {
                    this.updateFileExplorer();
                }
            });

            obs.observe(container, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class'],
                attributeOldValue: true,
            });
            this.observers.push(obs);
        }
    }

    private setIndicatorState(el: HTMLElement, state: 'pending' | 'unindexed' | null): void {
        el.classList.toggle('embedding-pending', state === 'pending');
        el.classList.toggle('embedding-unindexed', state === 'unindexed');
        if (el.classList.contains('embedding-indexed')) {
            el.classList.remove('embedding-indexed');
        }
    }

    public updateFileExplorer(): void {
        if (this.updateTimeout !== null) {
            window.clearTimeout(this.updateTimeout);
        }

        this.updateTimeout = window.setTimeout(() => {
            if (!this.plugin.settings.showExplorerIndicators) {
                this.clearAllIndicators();
                return;
            }

            const indexedPaths = new Map<string, number>();
            const registry = this.plugin.dbManager.state.registry;
            for (const p in registry) {
                indexedPaths.set(p, registry[p]!.mtime);
            }

            const excludedList = this.plugin.getExcludedFolders();
            const foldersWithUnindexed = new Set<string>();
            const foldersWithPending = new Set<string>();

            const mdFiles = this.app.vault.getMarkdownFiles();
            for (const file of mdFiles) {
                if (this.plugin.isFileExcluded(file, excludedList)) continue;

                const isIndexed = indexedPaths.has(file.path);
                let isPending = false;
                let isUnindexed = false;

                if (isIndexed) {
                    const regTime = indexedPaths.get(file.path)!;
                    const fileTime = Math.floor(file.stat.mtime);
                    if (regTime !== fileTime) {
                        isPending = true;
                    }
                } else {
                    isUnindexed = true;
                }

                if (isUnindexed || isPending) {
                    let parent = file.parent;
                    while (parent && !parent.isRoot()) {
                        if (isUnindexed) foldersWithUnindexed.add(parent.path);
                        else foldersWithPending.add(parent.path);
                        parent = parent.parent;
                    }
                }
            }

            const fileExplorerLeaves = this.app.workspace.getLeavesOfType('file-explorer');
            for (const leaf of fileExplorerLeaves) {
                const fileItems = (leaf.view as any)?.fileItems;
                if (!fileItems) continue;

                for (const path in fileItems) {
                    const item = fileItems[path];
                    const file = item?.file;
                    if (!file) continue;

                    const el = (item.selfEl || item.innerEl || item.titleEl || item.el) as HTMLElement | undefined;
                    if (!el) continue;

                    const legacySpan = el.querySelector?.('.embedding-indicator');
                    if (legacySpan) legacySpan.remove();

                    if (file instanceof TFile || 'extension' in file) {
                        const tfile = file as TFile;
                        if (tfile.extension !== 'md' || this.plugin.isFileExcluded(tfile, excludedList)) {
                            this.setIndicatorState(el, null);
                            continue;
                        }

                        const isIndexed = indexedPaths.has(tfile.path);
                        let state: 'pending' | 'unindexed' | null = null;

                        if (isIndexed) {
                            const regTime = indexedPaths.get(tfile.path)!;
                            const fileTime = Math.floor(tfile.stat.mtime);
                            if (regTime !== fileTime) {
                                state = 'pending';
                            }
                        } else {
                            state = 'unindexed';
                        }

                        this.setIndicatorState(el, state);
                    } else if (file instanceof TFolder || 'children' in file) {
                        if (file.path === '/' || (file.isRoot && file.isRoot()) || this.plugin.isPathExcluded(file.path, excludedList)) {
                            this.setIndicatorState(el, null);
                            continue;
                        }

                        const isCollapsed = Boolean(
                            item.collapsed ||
                            item.el?.classList?.contains('is-collapsed') ||
                            item.selfEl?.classList?.contains('is-collapsed')
                        );

                        let state: 'pending' | 'unindexed' | null = null;
                        if (isCollapsed) {
                            if (foldersWithUnindexed.has(file.path)) {
                                state = 'unindexed';
                            } else if (foldersWithPending.has(file.path)) {
                                state = 'pending';
                            }
                        }

                        this.setIndicatorState(el, state);
                    }
                }
            }
        }, 100);
    }

    public clearAllIndicators(): void {
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        for (const leaf of leaves) {
            const fileItems = (leaf.view as any)?.fileItems;
            if (!fileItems) continue;
            for (const path in fileItems) {
                const el = (fileItems[path]?.selfEl || fileItems[path]?.el) as HTMLElement | undefined;
                if (el) {
                    this.setIndicatorState(el, null);
                }
            }
        }
    }

    public disconnectObservers(): void {
        for (const obs of this.observers) {
            obs.disconnect();
        }
        this.observers = [];
    }

    public cleanup(): void {
        if (this.updateTimeout !== null) {
            window.clearTimeout(this.updateTimeout);
            this.updateTimeout = null;
        }
        this.disconnectObservers();
        this.clearAllIndicators();
    }
}
