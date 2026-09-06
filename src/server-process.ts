import { spawn, execSync, ChildProcess } from 'child_process';
import { Notice } from 'obsidian';

export class ServerProcessManager {
    private process: ChildProcess | null = null;

    public start(command: string): void {
        if (!command || !command.trim()) return;
        this.stop();

        try {
            console.log(`[Embedding Viewer] Starting server process: ${command}`);
            this.process = spawn(command, { shell: true });

            this.process.stdout?.on('data', (data) => {
                console.log(`[Embedding Viewer Server stdout]: ${data}`);
            });

            this.process.stderr?.on('data', (data) => {
                console.error(`[Embedding Viewer Server stderr]: ${data}`);
            });

            this.process.on('error', (error) => {
                console.error(`[Embedding Viewer Server error]: ${error.message}`);
                new Notice(`Server command failed: ${error.message}`);
            });

            this.process.on('exit', (code) => {
                if (code !== null && code !== 0) {
                    console.error(`[Embedding Viewer Server exited with code]: ${code}`);
                    new Notice(`Server process exited with code ${code}`);
                }
                this.process = null;
            });
        } catch (err) {
            console.error('[Embedding Viewer] Failed to launch server process:', err);
            new Notice(`Failed to launch server: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    public stop(): void {
        if (this.process && this.process.pid) {
            console.log(`[Embedding Viewer] Stopping server process (pid: ${this.process.pid})`);
            if (process.platform === 'win32') {
                try {
                    execSync(`taskkill /pid ${this.process.pid} /T /F`);
                } catch (e) {
                    console.error('[Embedding Viewer] Failed to kill process tree:', e);
                }
            } else {
                this.process.kill();
            }
            this.process = null;
        }
    }

    public isRunning(): boolean {
        return this.process !== null;
    }
}
