export interface Chunk {
    embedText: string;
    content: string;
    startLine: number;
    endLine: number;
    heading: string | null;
}

export interface HeadingInfo {
    hierarchy: string;
    mostRecent: string | null;
}

export class MarkdownChunker {
    public static stripWikilinks(text: string): string {
        let stripped = text.replace(/!\[\[(.*?)\]\]/g, '$1');
        stripped = stripped.replace(/\[\[(.*?)\]\]/g, (_match, p1) => {
            const parts = p1.split('|');
            return parts.length > 1 ? parts[1] : parts[0];
        });
        return stripped;
    }

    public static getFrontmatterLineCount(content: string): number {
        const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        return m ? m[0].split(/\r?\n/).length - 1 : 0;
    }

    public static buildHeadingMap(
        lines: string[],
        rawExcludeSet?: Set<string>,
        headingExcludeSet?: Set<string>
    ): Record<number, HeadingInfo> {
        const headingMap: Record<number, HeadingInfo> = {};
        const headingStack: { level: number, text: string }[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i] || '';
            const match = line.match(/^(#{1,6})\s+(.+)$/);
            if (match && match[1] && match[2]) {
                const level = match[1].length;
                const text = match[2].trim();
                const strippedText = this.stripWikilinks(text).trim();
                while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
                    headingStack.pop();
                }

                const headingTitle = text.toLowerCase();
                const strippedHeadingTitle = strippedText.toLowerCase();
                const trimmedLine = line.trim().toLowerCase();
                const strippedTrimmedLine = this.stripWikilinks(line).trim().toLowerCase();

                const isExcluded = (headingExcludeSet && (headingExcludeSet.has(headingTitle) || headingExcludeSet.has(strippedHeadingTitle))) ||
                                   (rawExcludeSet && (rawExcludeSet.has(trimmedLine) || rawExcludeSet.has(strippedTrimmedLine)));

                if (!isExcluded) {
                    headingStack.push({ level, text: strippedText });
                }
            }
            headingMap[i] = {
                hierarchy: headingStack.length > 0 ? 'Hierarchy: ' + headingStack.map(h => h.text).join(' > ') : '',
                mostRecent: headingStack.length > 0 ? headingStack[headingStack.length - 1]!.text : null
            };
        }
        return headingMap;
    }

    public static recursiveSplit(text: string, maxLen: number): string[] {
        if (text.length <= maxLen) return [text];
        const res: string[] = [];
        const lines = text.split('\n');
        let current = '';
        for (const line of lines) {
            if ((current.length + line.length + 1) > maxLen && current.length > 0) {
                res.push(current.trim());
                current = line + '\n';
            } else {
                current += line + '\n';
            }
        }
        if (current.trim().length > 0) {
            res.push(current.trim());
        }
        return res;
    }

    private static splitCodeBlock(codeBlockStr: string, maxChunkSize: number): string[] {
        const cbLines = codeBlockStr.split('\n');
        if (codeBlockStr.length <= maxChunkSize || cbLines.length <= 2) {
            return [codeBlockStr];
        }

        const pieces: string[] = [];
        const delimiter = codeBlockStr.startsWith('~~~') ? '~~~' : '```';
        let curCbChunk = cbLines[0] + '\n';

        for (let i = 1; i < cbLines.length - 1; i++) {
            const lineStr = cbLines[i] + '\n';
            if ((curCbChunk.length + lineStr.length + delimiter.length) > maxChunkSize && curCbChunk.split('\n').length > 2) {
                curCbChunk += delimiter;
                pieces.push(curCbChunk);
                curCbChunk = delimiter + '\n' + lineStr;
            } else {
                curCbChunk += lineStr;
            }
        }
        curCbChunk += cbLines[cbLines.length - 1];
        pieces.push(curCbChunk);
        return pieces;
    }

    public static splitBodyText(bodyText: string, maxChunkSize: number): string[] {
        const pieces: string[] = [];
        const codeBlockRegex = /(?:```|~~~)[\s\S]*?(?:```|~~~)/g;
        let lastIndex = 0;
        let matchCb: RegExpExecArray | null;

        while ((matchCb = codeBlockRegex.exec(bodyText)) !== null) {
            const textBefore = bodyText.substring(lastIndex, matchCb.index).trim();
            if (textBefore) {
                pieces.push(...this.recursiveSplit(textBefore, maxChunkSize));
            }
            pieces.push(...this.splitCodeBlock(matchCb[0], maxChunkSize));
            lastIndex = codeBlockRegex.lastIndex;
        }

        const textAfter = bodyText.substring(lastIndex).trim();
        if (textAfter) {
            pieces.push(...this.recursiveSplit(textAfter, maxChunkSize));
        }

        return pieces;
    }

    public static filterExcludedLines(
        text: string,
        rawExcludeSet: Set<string>,
        headingExcludeSet: Set<string>
    ): string {
        if (rawExcludeSet.size === 0 && headingExcludeSet.size === 0) return text;
        return text.split(/\r?\n/)
            .filter(line => {
                const trimmed = line.trim().toLowerCase();
                if (!trimmed) return true;
                const match = trimmed.match(/^#{1,6}\s+(.+)$/);
                if (match && match[1]) {
                    const headingTitle = match[1].trim();
                    if (headingExcludeSet.has(headingTitle) || rawExcludeSet.has(trimmed)) {
                        return false;
                    }
                }
                return !rawExcludeSet.has(trimmed);
            })
            .join('\n');
    }

    public static extractChunks(
        content: string,
        maxChunkSize: number,
        excludedPhrases: string[] = [],
        isExcludedFromFrontmatter = false
    ): Chunk[] {
        if (isExcludedFromFrontmatter) return [];

        const lines = content.split(/\r?\n/);
        const fmLineCount = this.getFrontmatterLineCount(content);

        const rawExcludeSet = new Set<string>();
        const headingExcludeSet = new Set<string>();

        for (const p of excludedPhrases) {
            const trimmed = p.trim().toLowerCase();
            if (!trimmed) continue;

            const headingMatch = trimmed.match(/^#{1,6}\s*(.+)$/);
            if (headingMatch && headingMatch[1]) {
                rawExcludeSet.add(trimmed);
                headingExcludeSet.add(headingMatch[1].trim());
            } else {
                rawExcludeSet.add(trimmed);
                headingExcludeSet.add(trimmed);
            }
        }

        const headingMap = this.buildHeadingMap(lines, rawExcludeSet, headingExcludeSet);

        const bodyText = lines.slice(fmLineCount).join('\n').trim();
        if (!bodyText) return [];

        const pieces = this.splitBodyText(bodyText, maxChunkSize);
        const chunks: Chunk[] = [];
        let currentSearchPos = 0;
        const searchContent = content.replace(/\r\n/g, '\n');

        for (const piece of pieces) {
            const trimmedPiece = piece.trim();
            if (!trimmedPiece) continue;

            const isCodeBlock = (trimmedPiece.startsWith('```') && trimmedPiece.endsWith('```')) ||
                                (trimmedPiece.startsWith('~~~') && trimmedPiece.endsWith('~~~'));
            if (!isCodeBlock) {
                const wordCount = trimmedPiece.split(/\s+/).filter(w => w.length > 0).length;
                if (wordCount < 8) continue;
            }

            let searchTarget = piece;
            let lineDelta = 0;
            if (isCodeBlock) {
                const pLines = piece.split('\n');
                const firstLine = pLines[0]?.trim();
                if ((firstLine === '```' || firstLine === '~~~') && pLines.length > 1) {
                    let targetIdx = 1;
                    while (targetIdx < pLines.length - 1 && !pLines[targetIdx]?.trim()) {
                        targetIdx++;
                    }
                    if (pLines[targetIdx]?.trim()) {
                        searchTarget = pLines[targetIdx]!;
                        lineDelta = targetIdx;
                    } else {
                        searchTarget = piece;
                    }
                } else if (pLines.length > 0 && pLines[0]) {
                    searchTarget = pLines[0];
                }
            }

            const chunkIndex = searchContent.indexOf(searchTarget, currentSearchPos);
            let startLine = chunks.length > 0 ? chunks[chunks.length - 1]!.endLine + 1 : fmLineCount;
            if (chunkIndex !== -1) {
                const textBefore = searchContent.substring(0, chunkIndex);
                startLine = Math.max(0, textBefore.split('\n').length - 1 - lineDelta);
                currentSearchPos = chunkIndex + searchTarget.length;
            }

            const headingInfo = headingMap[startLine] || { hierarchy: '', mostRecent: null };
            let finalPieceText = this.stripWikilinks(piece);

            if (!isCodeBlock) {
                finalPieceText = this.filterExcludedLines(finalPieceText, rawExcludeSet, headingExcludeSet);
            }

            const trimmedContent = finalPieceText.trim();
            if (!trimmedContent) continue;

            if (!isCodeBlock) {
                const postFilterWordCount = trimmedContent.split(/\s+/).filter(w => w.length > 0).length;
                if (postFilterWordCount < 8) continue;
            }

            const filteredHierarchy = this.stripWikilinks(headingInfo.hierarchy);
            const embedText = (filteredHierarchy ? `${filteredHierarchy}\n\n` : '') + finalPieceText;

            chunks.push({
                embedText,
                content: trimmedContent,
                startLine,
                endLine: startLine + piece.split('\n').length - 1,
                heading: headingInfo.mostRecent
            });
        }

        return chunks;
    }
}
