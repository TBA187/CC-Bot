'use strict';

// Shares one OCR queue and recycles workers after idle periods, failures, or memory pressure.
const { createOcrProcessWorker } = require('./ocrProcessWorker.js');
const path = require('node:path');
const { runtimeActivity } = require('./runtimeActivity.js');
const { readContainerMemory, memoryPressureSample } = require('./runtimeHealth.js');
const { readProcessRss } = require('./containerMemory.js');

const OCR_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const configuredSharp = new WeakSet();

// Image pipelines otherwise keep libvips' default 50 MiB cache and can use
// every CPU advertised by the host, even in a small shared container.
function configureImageMemory(sharp) {
    if (configuredSharp.has(sharp)) return;
    sharp.cache({ memory: 16, files: 0, items: 32 });
    sharp.concurrency(1);
    configuredSharp.add(sharp);
}

class OcrWorkerPool {
    constructor(options = {}) {
        this.worker = options.worker || null;
        this.workerPromise = null;
        this.workerFactory = options.workerFactory || (() => createOcrProcessWorker({
            cachePath: options.cachePath || path.join(process.cwd(), 'data', 'tesseract-cache')
        }));
        // A directly injected worker cannot be recreated by a custom factory.
        this.idleTimeoutMs = options.idleTimeoutMs ?? (options.worker && !options.workerFactory ? 0 : OCR_IDLE_TIMEOUT_MS);
        this.setTimeout = options.setTimeout || setTimeout;
        this.clearTimeout = options.clearTimeout || clearTimeout;
        this.queue = Promise.resolve();
        this.pending = 0;
        this.idleTimer = null;
        this.completedImages = 0;
        this.containerMemory = options.containerMemory || readContainerMemory;
        this.rssUsage = options.rssUsage || (() => process.memoryUsage.rss());
        this.processRss = options.processRss || readProcessRss;
        this.lastKnownMemoryLimit = null;
        this.pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.log = options.log || (message => console.warn(message));
        this.activity = options.activity || runtimeActivity;
        this.maxBatchImages = options.maxBatchImages ?? 20;
        this.tasksStarted = 0;
        this.tasksCompleted = 0;
        this.tasksFailed = 0;
        this.peakProcessRss = 0;
    }

    clearIdleTimer() {
        if (this.idleTimer !== null) this.clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    scheduleIdleRelease() {
        this.clearIdleTimer();
        if (this.pending || !this.worker || this.idleTimeoutMs <= 0) return;
        this.idleTimer = this.setTimeout(() => {
            this.idleTimer = null;
            this.close().catch(error => {
                console.warn('[CC LOG] Could not release the idle OCR worker:', error?.message || error);
            });
        }, this.idleTimeoutMs);
        this.idleTimer?.unref?.();
    }

    // Serialize complete tasks, including their multiple recognize calls. All
    // production OCR users share this queue, so Gold, Silver and forum scans
    // never each allocate a Tesseract runtime at the same time.
    // A label names the feature in memory reports while its task runs (for example "PvP Scout Gold").
    run(task, { maintenance = false, label = null } = {}) {
        this.pending++;
        if (!maintenance) this.tasksStarted++;
        this.clearIdleTimer();
        const result = this.queue.then(async () => {
            const finishActivity = label ? this.activity.begin(`OCR: ${label}`) : null;
            try {
                const value = await task();
                if (!maintenance) this.tasksCompleted++;
                return value;
            } catch (error) {
                if (!maintenance) this.tasksFailed++;
                throw error;
            } finally {
                finishActivity?.();
            }
        });
        const settled = result.finally(() => {
            this.pending--;
            this.scheduleIdleRelease();
        });
        // Store a promise with no result to avoid retaining the last OCR output.
        this.queue = settled.then(() => undefined, () => undefined);
        return settled;
    }

    async getWorker() {
        if (this.worker) return this.worker;
        if (!this.workerPromise) this.workerPromise = Promise.resolve().then(this.workerFactory);
        const creating = this.workerPromise;
        try {
            this.worker = await creating;
            this.recordWorkerMemory(this.worker);
            this.scheduleIdleRelease();
            return this.worker;
        } finally {
            if (this.workerPromise === creating) this.workerPromise = null;
        }
    }

    async recognize(...args) {
        const worker = await this.getWorker();
        try {
            return await worker.recognize(...args);
        } catch (error) {
            // Tesseract restores per-call parameters only after a successful
            // scan. A failed scan must not leak its whitelist/PSM to another
            // feature, or leave a damaged runtime alive in the shared pool.
            if (this.worker === worker) this.worker = null;
            try {
                if (worker?.terminate) await worker.terminate();
            } catch (releaseError) {
                console.warn('[CC LOG] Could not release the failed OCR worker:', releaseError?.message || releaseError);
            }
            throw error instanceof Error ? error : new Error(String(error));
        } finally {
            this.recordWorkerMemory(worker);
        }
    }

    recordWorkerMemory(worker) {
        try {
            const memory = worker?.memorySnapshot?.();
            if (Number.isFinite(memory?.peakRss)) this.peakProcessRss = Math.max(this.peakProcessRss, memory.peakRss);
        } catch { /* Diagnostics must not interrupt recognition or worker cleanup. */ }
    }

    async releaseWorker() {
        const worker = this.worker || (this.workerPromise ? await this.workerPromise.catch(() => null) : null);
        this.recordWorkerMemory(worker);
        this.worker = null;
        this.workerPromise = null;
        this.completedImages = 0;
        if (worker?.terminate) await worker.terminate();
    }

    async memoryPressure() {
        try {
            const memory = await this.containerMemory().catch(() => null);
            const ocrRss = !memory && this.worker?.processId
                ? await this.processRss(this.worker.processId).catch(() => null) : null;
            // Use the same cache-adjusted usage and capped budget as runtime alerts.
            const { used, limit } = memoryPressureSample(memory, memory ? 0 : this.rssUsage(), ocrRss, this.lastKnownMemoryLimit);
            if (memory?.limit) this.lastKnownMemoryLimit = limit;
            return used >= limit * 0.85;
        } catch { return false; }
    }

    // Called inside run(), so recycling never interrupts a scan or lets another
    // feature start a second image pipeline. This is a soft guard, not a quota.
    async processImage(action, ...args) {
        if (this.completedImages >= this.maxBatchImages) await this.releaseWorker();
        if (await this.memoryPressure()) {
            await this.releaseWorker();
            if (await this.memoryPressure()) {
                this.log('[CC LOG] OCR memory pressure: briefly delaying the next image (up to 5 seconds).');
                for (let attempt = 0; attempt < 5; attempt++) {
                    await this.pause(1000);
                    if (!await this.memoryPressure()) break;
                }
            }
        }
        const worker = await this.getWorker();
        try {
            const result = await worker[action](...args);
            this.completedImages++;
            // Release large native allocations promptly, even during a burst.
            if (await this.memoryPressure()) await this.releaseWorker();
            return result;
        } catch (error) {
            await this.releaseWorker();
            throw error;
        } finally {
            this.recordWorkerMemory(worker);
        }
    }

    close() {
        return this.run(() => this.releaseWorker(), { maintenance: true });
    }

    snapshot() {
        return { workers: this.worker ? 1 : 0, creating: Boolean(this.workerPromise), pending: this.pending,
            ...(this.worker?.processId ? { processId: this.worker.processId } : {}) };
    }

    healthSnapshot() {
        this.recordWorkerMemory(this.worker);
        return { ...this.snapshot(), tasksStarted: this.tasksStarted, tasksCompleted: this.tasksCompleted,
            tasksFailed: this.tasksFailed, peakProcessRss: this.peakProcessRss };
    }
}

const sharedOcrWorkerPool = new OcrWorkerPool();

function ocrWorkerPoolFor(options = {}) {
    if (options.workerPool) return options.workerPool;
    // Tests and callers supplying a custom factory/cache keep an isolated pool.
    if (options.worker || options.workerFactory || options.cachePath || options.idleTimeoutMs !== undefined) {
        return new OcrWorkerPool(options);
    }
    return sharedOcrWorkerPool;
}

module.exports = { OCR_IDLE_TIMEOUT_MS, OcrWorkerPool, sharedOcrWorkerPool, ocrWorkerPoolFor, configureImageMemory };
