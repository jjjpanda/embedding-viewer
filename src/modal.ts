import { App, Modal } from 'obsidian';
import { QueryResult } from './query';

export class SimilarityModal extends Modal {
    constructor(app: App, private text: string, private results: QueryResult[]) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Similar Notes for Selection' });
        contentEl.createEl('blockquote', { text: this.text });

        const ul = contentEl.createEl('ul');
        for (const res of this.results) {
            const li = contentEl.createEl('li');
            li.style.marginBottom = '10px';
            
            const headerDiv = li.createDiv();
            headerDiv.style.fontWeight = '500';
            
            const link = headerDiv.createEl('a', { text: res.path, cls: 'internal-link', href: '#' });
            link.dataset.href = res.path;
            link.onclick = async (e) => {
                e.preventDefault();
                const file = this.app.metadataCache.getFirstLinkpathDest(res.path, '');
                if (file) {
                    const leaf = this.app.workspace.getLeaf(e.ctrlKey || e.metaKey || 'split');
                    await leaf.openFile(file, { eState: { line: res.startLine } });
                } else {
                    await this.app.workspace.openLinkText(res.path, '', e.ctrlKey || e.metaKey);
                }
                this.close();
            };
            
            if (res.heading) {
                headerDiv.createSpan({ text: ` > ${res.heading}`, attr: { style: 'opacity: 0.7;' } });
            }
            
            headerDiv.createSpan({ text: `${(res.similarity * 100).toFixed(1)}%`, cls: 'similarity-score', attr: { style: 'float: right;' } });
            
            const explainDiv = li.createDiv({ cls: 'similarity-explanation' });
            explainDiv.style.fontSize = '0.8em';
            explainDiv.style.color = 'var(--text-muted)';
            explainDiv.style.marginBottom = '4px';
            explainDiv.textContent = `Raw similarity: ${(res.rawSimilarity * 100).toFixed(1)}% | Recency penalty: -${(res.timePenalty * 100).toFixed(1)}%` + (res.linkPenalty > 0 ? ` | Link penalty: -${(res.linkPenalty * 100).toFixed(1)}%` : '');
            
            const previewDiv = li.createDiv({ cls: 'similarity-content-preview' });
            previewDiv.style.fontSize = '0.85em';
            previewDiv.style.opacity = '0.8';
            previewDiv.style.borderLeft = '2px solid var(--text-accent)';
            previewDiv.style.paddingLeft = '8px';
            previewDiv.style.maxHeight = '100px';
            previewDiv.style.overflow = 'auto';
            previewDiv.textContent = res.content;
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
