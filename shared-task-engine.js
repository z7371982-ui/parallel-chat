/**
 * Session task scheduler. This module has no host, DOM, storage, or network access.
 * The adapter remains responsible for complete prompt preparation, postprocessing,
 * revision checks, and durable commit idempotency using taskId.
 *
 * prepare(sessionRef, input, { taskId, signal }) -> JSON snapshot
 * execute(snapshot, { taskId, signal }) -> JSON result (or undefined)
 * commit(snapshot, result, { taskId }) -> completion
 *
 * Preparation and commit share one exclusive host-context queue; execution runs
 * outside it. Cancellation is cooperative until commit starts, then irrevocable.
 * A cancelled adapter must settle before the task releases its session or is idle.
 */
export function createSharedTaskEngine({ prepare, execute, commit, onChange, now = Date.now } = {}) {
    for (const callback of [prepare, execute, commit]) {
        if (typeof callback !== 'function') throw new TypeError('prepare, execute, and commit must be functions');
    }
    if (onChange !== undefined && typeof onChange !== 'function') throw new TypeError('onChange must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    const tasks = new Map();
    const activeSessions = new Map();
    const sessionIds = new Map();
    const idleWaiters = new Set();
    const engineId = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let nextTaskId = 0;
    let nextSessionId = 0;
    let pending = 0;
    let hostWork = 0;
    let hostTail = Promise.resolve();

    function timestamp() {
        try {
            const value = now();
            if (typeof value === 'number' && Number.isFinite(value)) return value;
        } catch { /* A clock is observational and must not stop a task. */ }
        return Date.now();
    }

    function canRetry(record) {
        return record.status === 'failed' && record.phase === 'commit'
            && record.hasResult && !record.running && !activeSessions.has(record.sessionKey);
    }

    // Deliberately omit sessionRef/input/snapshot/result and adapter error text.
    // These may contain credentials, complete prompts, or private message text.
    function describe(record) {
        return Object.freeze({
            taskId: record.taskId,
            sessionId: record.sessionId,
            status: record.status,
            phase: record.phase,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            pending: record.running,
            commitStarted: record.commitStarted,
            commitAttempts: record.commitAttempts,
            hasResult: record.hasResult,
            canRetryCommit: canRetry(record),
            error: record.error ? Object.freeze({ ...record.error }) : null,
        });
    }

    function notify(record) {
        if (!onChange) return;
        try {
            // Async observers are also isolated; do not await or leak rejections.
            Promise.resolve(onChange(describe(record))).catch(() => {});
        } catch { /* An observer cannot change task completion. */ }
    }

    function transition(record, status, phase = record.phase) {
        record.status = status;
        record.phase = phase;
        record.updatedAt = timestamp();
        notify(record);
    }

    function inHostContext(callback) {
        hostWork += 1;
        const work = hostTail.then(callback);
        const settled = work.finally(() => {
            hostWork -= 1;
            resolveIdleWaiters();
        });
        hostTail = settled.catch(() => {});
        return settled;
    }

    function resolveIdleWaiters() {
        if (pending !== 0 || hostWork !== 0) return;
        const waiters = Array.from(idleWaiters);
        idleWaiters.clear();
        for (const resolve of waiters) resolve();
    }

    function aborted(record) {
        return record.controller.signal.aborted;
    }

    async function commitPrepared(record) {
        transition(record, 'commit_queued', 'commit');
        await inHostContext(async () => {
            if (aborted(record)) return;
            // This synchronous boundary is also the cancel() point of no return.
            record.commitStarted = true;
            record.commitAttempts += 1;
            transition(record, 'committing', 'commit');
            await commit(record.snapshot, record.result, { taskId: record.taskId });
        });
    }

    async function runInitial(record) {
        await inHostContext(async () => {
            if (aborted(record)) return;
            transition(record, 'preparing', 'prepare');
            if (aborted(record)) return;
            const prepared = await prepare(record.sessionRef, record.input, {
                taskId: record.taskId,
                signal: record.controller.signal,
            });
            if (aborted(record)) return;
            record.snapshot = cloneFrozenJSON(prepared);
            record.input = undefined;
        });
        if (aborted(record)) return;
        transition(record, 'executing', 'execute');
        if (aborted(record)) return;
        const result = await execute(record.snapshot, {
            taskId: record.taskId,
            signal: record.controller.signal,
        });
        if (aborted(record)) return;
        record.result = result === undefined ? undefined : cloneFrozenJSON(result);
        record.hasResult = true;
        await commitPrepared(record);
    }

    function startWorker(record, work) {
        pending += 1;
        record.running = true;
        activeSessions.set(record.sessionKey, record.taskId);
        notify(record);
        Promise.resolve().then(work).then(
            () => finish(record, aborted(record) ? 'cancelled' : 'succeeded'),
            () => finish(record, aborted(record) ? 'cancelled' : 'failed'),
        );
    }

    function finish(record, status) {
        record.running = false;
        pending -= 1;
        if (activeSessions.get(record.sessionKey) === record.taskId) activeSessions.delete(record.sessionKey);
        record.input = undefined;
        if (status === 'failed') {
            record.error = publicFailure(record.phase);
            if (record.phase !== 'commit') record.snapshot = undefined;
        } else {
            record.snapshot = undefined;
            // Cancelling a queued commit (including a failed commit's retry)
            // must not erase an already generated result. It can be retrieved
            // or explicitly forgotten, but a cancelled task cannot retry.
        }
        transition(record, status);
        // Observers may submit another task synchronously during transition.
        resolveIdleWaiters();
    }

    function submit(sessionRef, input) {
        const fixedSession = cloneFrozenJSON(sessionRef);
        if (!(typeof fixedSession === 'string' && fixedSession.trim())
            && !(fixedSession && !Array.isArray(fixedSession) && typeof fixedSession === 'object'
                && Object.keys(fixedSession).length > 0)) {
            throw new TypeError('sessionRef must be a nonempty string or JSON object');
        }
        const sessionKey = canonicalJSON(fixedSession);
        if (activeSessions.has(sessionKey)) {
            const error = new Error('This session already has a pending task');
            error.code = 'SESSION_BUSY';
            throw error;
        }
        const fixedInput = input === undefined ? undefined : cloneFrozenJSON(input);
        if (!sessionIds.has(sessionKey)) sessionIds.set(sessionKey, `session-${++nextSessionId}`);
        const createdAt = timestamp();
        const record = {
            taskId: `shared-${engineId}-${++nextTaskId}`,
            sessionId: sessionIds.get(sessionKey),
            sessionKey,
            sessionRef: fixedSession,
            input: fixedInput,
            snapshot: undefined,
            result: undefined,
            hasResult: false,
            status: 'queued',
            phase: 'prepare',
            createdAt,
            updatedAt: createdAt,
            controller: new AbortController(),
            running: false,
            commitStarted: false,
            commitAttempts: 0,
            error: null,
        };
        tasks.set(record.taskId, record);
        startWorker(record, () => runInitial(record));
        return record.taskId;
    }

    function cancel(taskId) {
        const record = tasks.get(taskId);
        if (!record || !record.running || record.commitStarted || aborted(record)) return false;
        record.controller.abort();
        transition(record, 'cancelled');
        return true;
    }

    function retryCommit(taskId) {
        const record = tasks.get(taskId);
        if (!record || !canRetry(record)) return false;
        record.controller = new AbortController();
        record.commitStarted = false;
        record.error = null;
        record.status = 'commit_queued';
        record.updatedAt = timestamp();
        startWorker(record, () => commitPrepared(record));
        return true;
    }

    return Object.freeze({
        submit,
        cancel,
        retryCommit,
        getTask: taskId => tasks.has(taskId) ? describe(tasks.get(taskId)) : null,
        listTasks: () => Array.from(tasks.values(), describe),
        // Explicit payload access: keep this out of logs and diagnostics.
        getResult: taskId => tasks.get(taskId)?.hasResult ? structuredClone(tasks.get(taskId).result) : undefined,
        hasPending: () => pending > 0,
        hasHostWork: () => hostWork > 0,
        waitForIdle: () => pending === 0 && hostWork === 0 ? Promise.resolve() : new Promise(resolve => idleWaiters.add(resolve)),
        /**
         * Queue a UI session switch/reload in the same lock as prepare/commit.
         * Return values and rejections are passed to the caller. UI work does
         * not create diagnostic tasks but is included in waitForIdle().
         *
         * Non-reentrant: acquire only at the outermost host operation. Inside
         * callback (or prepare/commit), directly await the underlying host
         * actions; do not await runExclusive() or waitForIdle() again. Observers
         * may enqueue new work without awaiting it inside the locked callback.
         */
        runExclusive(callback) {
            if (typeof callback !== 'function') throw new TypeError('runExclusive requires a function');
            return inHostContext(callback);
        },
        // Call after the UI has consumed a settled result to release large data.
        forgetTask(taskId) {
            const record = tasks.get(taskId);
            if (!record || record.running) return false;
            tasks.delete(taskId);
            if (!Array.from(tasks.values()).some(task => task.sessionKey === record.sessionKey)) {
                sessionIds.delete(record.sessionKey);
            }
            return true;
        },
    });
}

function publicFailure(phase) {
    const messages = {
        prepare: 'Task preparation failed; no reply was committed.',
        execute: 'Task execution failed; no reply was committed.',
        commit: 'Task commit failed; the generated result is retained for a commit retry.',
    };
    return { code: `${phase.toUpperCase()}_FAILED`, phase, message: messages[phase] };
}

function cloneFrozenJSON(value) {
    let cloned;
    try {
        cloned = structuredClone(value);
    } catch {
        throw new TypeError('Task data must be cloneable JSON data');
    }
    const seen = new Set();
    function freeze(item, depth) {
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
        if (typeof item === 'number' && Number.isFinite(item)) return;
        if (typeof item !== 'object' || depth > 200 || seen.has(item)) {
            throw new TypeError('Task data must be acyclic JSON data with depth at most 200');
        }
        const prototype = Object.getPrototypeOf(item);
        if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('Task data must contain only JSON objects and arrays');
        }
        seen.add(item);
        if (Array.isArray(item)) {
            for (let i = 0; i < item.length; i += 1) {
                if (!Object.hasOwn(item, i)) throw new TypeError('Task JSON arrays cannot contain holes');
                freeze(item[i], depth + 1);
            }
            if (Object.keys(item).length !== item.length) throw new TypeError('Task JSON arrays cannot contain named properties');
        } else {
            for (const entry of Object.values(item)) freeze(entry, depth + 1);
        }
        seen.delete(item);
        Object.freeze(item);
    }
    freeze(cloned, 0);
    return cloned;
}

function canonicalJSON(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}
