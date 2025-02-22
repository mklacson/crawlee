import type { Dictionary } from '@crawlee/types';

import { checkStorageAccess } from './access_checking';
import type { RequestQueueOperationInfo, RequestProviderOptions } from './request_provider';
import { RequestProvider } from './request_provider';
import {
    STORAGE_CONSISTENCY_DELAY_MILLIS,
    getRequestId,
} from './utils';
import { Configuration } from '../configuration';
import { EventType } from '../events';
import type { Request } from '../request';

// Double the limit of RequestQueue v1 (1_000_000) as we also store keyed by request.id, not just from uniqueKey
const MAX_CACHED_REQUESTS = 2_000_000;

/**
 * This number must be large enough so that processing of all these requests cannot be done in
 * a time lower than expected maximum latency of DynamoDB, but low enough not to waste too much memory.
 * @internal
 */
const RECENTLY_HANDLED_CACHE_SIZE = 1000;

class RequestQueue extends RequestProvider {
    private _listHeadAndLockPromise: Promise<void> | null = null;

    constructor(options: RequestProviderOptions, config = Configuration.getGlobalConfig()) {
        super({
            ...options,
            logPrefix: 'RequestQueue2',
            recentlyHandledRequestsMaxSize: RECENTLY_HANDLED_CACHE_SIZE,
            requestCacheMaxSize: MAX_CACHED_REQUESTS,
        }, config);

        const eventManager = config.getEventManager();

        eventManager.on(EventType.MIGRATING, async () => {
            await this._clearPossibleLocks();
        });

        eventManager.on(EventType.ABORTING, async () => {
            await this._clearPossibleLocks();
        });
    }

    /**
     * Caches information about request to beware of unneeded addRequest() calls.
     */
    protected override _cacheRequest(cacheKey: string, queueOperationInfo: RequestQueueOperationInfo): void {
        checkStorageAccess();

        super._cacheRequest(cacheKey, queueOperationInfo);

        this.requestCache.remove(queueOperationInfo.requestId);

        this.requestCache.add(queueOperationInfo.requestId, {
            id: queueOperationInfo.requestId,
            isHandled: queueOperationInfo.wasAlreadyHandled,
            uniqueKey: queueOperationInfo.uniqueKey,
            hydrated: null,
            lockExpiresAt: null,
        });
    }

    /**
     * Returns a next request in the queue to be processed, or `null` if there are no more pending requests.
     *
     * Once you successfully finish processing of the request, you need to call
     * {@apilink RequestQueue.markRequestHandled}
     * to mark the request as handled in the queue. If there was some error in processing the request,
     * call {@apilink RequestQueue.reclaimRequest} instead,
     * so that the queue will give the request to some other consumer in another call to the `fetchNextRequest` function.
     *
     * Note that the `null` return value doesn't mean the queue processing finished,
     * it means there are currently no pending requests.
     * To check whether all requests in queue were finished,
     * use {@apilink RequestQueue.isFinished} instead.
     *
     * @returns
     *   Returns the request object or `null` if there are no more pending requests.
     */
    override async fetchNextRequest<T extends Dictionary = Dictionary>(): Promise<Request<T> | null> {
        checkStorageAccess();

        await this.ensureHeadIsNonEmpty();

        const nextRequestId = this.queueHeadIds.removeFirst();

        // We are likely done at this point.
        if (!nextRequestId) {
            return null;
        }

        // This should never happen, but...
        if (this.inProgress.has(nextRequestId) || this.recentlyHandledRequestsCache.get(nextRequestId)) {
            this.log.warning('Queue head returned a request that is already in progress?!', {
                nextRequestId,
                inProgress: this.inProgress.has(nextRequestId),
                recentlyHandled: !!this.recentlyHandledRequestsCache.get(nextRequestId),
            });
            return null;
        }

        this.inProgress.add(nextRequestId);

        let request: Request | null;

        try {
            request = await this.getOrHydrateRequest(nextRequestId);
        } catch (e) {
            // On error, remove the request from in progress, otherwise it would be there forever
            this.inProgress.delete(nextRequestId);
            throw e;
        }

        // NOTE: It can happen that the queue head index is inconsistent with the main queue table. This can occur in two situations:

        // 1) Queue head index is ahead of the main table and the request is not present in the main table yet (i.e. getRequest() returned null).
        //    In this case, keep the request marked as in progress for a short while,
        //    so that isFinished() doesn't return true and _ensureHeadIsNonEmpty() doesn't not load the request
        //    into the queueHeadDict straight again. After the interval expires, fetchNextRequest()
        //    will try to fetch this request again, until it eventually appears in the main table.
        if (!request) {
            this.log.debug('Cannot find a request from the beginning of queue or lost lock, will be retried later', { nextRequestId });

            setTimeout(() => {
                this.inProgress.delete(nextRequestId);
            }, STORAGE_CONSISTENCY_DELAY_MILLIS);

            return null;
        }

        // 2) Queue head index is behind the main table and the underlying request was already handled
        //    (by some other client, since we keep the track of handled requests in recentlyHandled dictionary).
        //    We just add the request to the recentlyHandled dictionary so that next call to _ensureHeadIsNonEmpty()
        //    will not put the request again to queueHeadDict.
        if (request.handledAt) {
            this.log.debug('Request fetched from the beginning of queue was already handled', { nextRequestId });
            this.recentlyHandledRequestsCache.add(nextRequestId, true);
            return null;
        }

        return request;
    }

    override async reclaimRequest(...args: Parameters<RequestProvider['reclaimRequest']>): ReturnType<RequestProvider['reclaimRequest']> {
        checkStorageAccess();

        const res = await super.reclaimRequest(...args);

        if (res) {
            const [request, options] = args;

            // Mark the request as no longer in progress,
            // as the moment we delete the lock, we could end up also re-fetching the request in a subsequent ensureHeadIsNonEmpty()
            // which could potentially lock the request again
            this.inProgress.delete(request.id!);

            // Try to delete the request lock if possible
            try {
                await this.client.deleteRequestLock(request.id!, { forefront: options?.forefront ?? false });
            } catch (err) {
                this.log.debug(`Failed to delete request lock for request ${request.id}`, { err });
            }
        }

        return res;
    }

    protected async ensureHeadIsNonEmpty() {
        checkStorageAccess();

        // Stop fetching if we are paused for migration
        if (this.queuePausedForMigration) {
            return;
        }

        // We want to fetch ahead of time to minimize dead time
        if (this.queueHeadIds.length() > 1) {
            return;
        }

        this._listHeadAndLockPromise ??= this._listHeadAndLock().finally(() => {
            this._listHeadAndLockPromise = null;
        });

        await this._listHeadAndLockPromise;
    }

    private async _listHeadAndLock(): Promise<void> {
        checkStorageAccess();

        const headData = await this.client.listAndLockHead({ limit: 25, lockSecs: this.requestLockSecs });

        for (const { id, uniqueKey } of headData.items) {
            // Queue head index might be behind the main table, so ensure we don't recycle requests
            if (!id || !uniqueKey || this.inProgress.has(id) || this.recentlyHandledRequestsCache.get(id)) {
                this.log.debug(`Skipping request from queue head, already in progress or recently handled`, {
                    id,
                    uniqueKey,
                    inProgress: this.inProgress.has(id),
                    recentlyHandled: !!this.recentlyHandledRequestsCache.get(id),
                });

                // Remove the lock from the request for now, so that it can be picked up later
                // This may/may not succeed, but that's fine
                try {
                    await this.client.deleteRequestLock(id);
                } catch {
                    // Ignore
                }

                continue;
            }

            this.queueHeadIds.add(id, id, false);
            this._cacheRequest(getRequestId(uniqueKey), {
                requestId: id,
                uniqueKey,
                wasAlreadyPresent: true,
                wasAlreadyHandled: false,
            });
        }
    }

    private async getOrHydrateRequest<T extends Dictionary = Dictionary>(requestId: string): Promise<Request<T> | null> {
        checkStorageAccess();

        const cachedEntry = this.requestCache.get(requestId);

        if (!cachedEntry) {
            // 2.1. Attempt to prolong the request lock to see if we still own the request
            const prolongResult = await this._prolongRequestLock(requestId);

            if (!prolongResult) {
                return null;
            }

            // 2.1.1. If successful, hydrate the request and return it
            const hydratedRequest = await this.getRequest(requestId);

            // Queue head index is ahead of the main table and the request is not present in the main table yet (i.e. getRequest() returned null).
            if (!hydratedRequest) {
                // Remove the lock from the request for now, so that it can be picked up later
                // This may/may not succeed, but that's fine
                try {
                    await this.client.deleteRequestLock(requestId);
                } catch {
                    // Ignore
                }

                return null;
            }

            this.requestCache.add(requestId, {
                id: requestId,
                uniqueKey: hydratedRequest.uniqueKey,
                hydrated: hydratedRequest,
                isHandled: hydratedRequest.handledAt !== null,
                lockExpiresAt: prolongResult.getTime(),
            });

            return hydratedRequest;
        }

        // 1.1. If hydrated, prolong the lock more and return it
        if (cachedEntry.hydrated) {
            // 1.1.1. If the lock expired on the hydrated requests, try to prolong. If we fail, we lost the request (or it was handled already)
            if (cachedEntry.lockExpiresAt && cachedEntry.lockExpiresAt < Date.now()) {
                const prolonged = await this._prolongRequestLock(cachedEntry.id);

                if (!prolonged) {
                    return null;
                }

                cachedEntry.lockExpiresAt = prolonged.getTime();
            }

            return cachedEntry.hydrated;
        }

        // 1.2. If not hydrated, try to prolong the lock first (to ensure we keep it in our queue), hydrate and return it
        const prolonged = await this._prolongRequestLock(cachedEntry.id);

        if (!prolonged) {
            return null;
        }

        // This might still return null if the queue head is inconsistent with the main queue table.
        const hydratedRequest = await this.getRequest(cachedEntry.id);

        cachedEntry.hydrated = hydratedRequest;

        // Queue head index is ahead of the main table and the request is not present in the main table yet (i.e. getRequest() returned null).
        if (!hydratedRequest) {
            // Remove the lock from the request for now, so that it can be picked up later
            // This may/may not succeed, but that's fine
            try {
                await this.client.deleteRequestLock(cachedEntry.id);
            } catch {
                // Ignore
            }

            return null;
        }

        return hydratedRequest;
    }

    private async _prolongRequestLock(requestId: string): Promise<Date | null> {
        checkStorageAccess();

        try {
            const res = await this.client.prolongRequestLock(requestId, { lockSecs: this.requestLockSecs });
            return res.lockExpiresAt;
        } catch (err: any) {
            // Most likely we do not own the lock anymore
            this.log.warning(`Failed to prolong lock for cached request ${requestId}, either lost the lock or the request was already handled\n`, {
                err,
            });

            return null;
        }
    }

    protected override _reset() {
        checkStorageAccess();

        super._reset();
        this._listHeadAndLockPromise = null;
    }

    protected override _maybeAddRequestToQueueHead() {
        // Do nothing for request queue v2, as we are only able to lock requests when listing the head
    }

    protected async _clearPossibleLocks() {
        checkStorageAccess();

        this.queuePausedForMigration = true;
        let requestId: string | null;

        // eslint-disable-next-line no-cond-assign
        while ((requestId = this.queueHeadIds.removeFirst()) !== null) {
            try {
                await this.client.deleteRequestLock(requestId);
            } catch {
                // We don't have the lock, or the request was never locked. Either way it's fine
            }
        }
    }

    static override async open(...args: Parameters<typeof RequestProvider.open>): Promise<RequestQueue> {
        return super.open(...args) as Promise<RequestQueue>;
    }
}

export { RequestQueue as RequestQueueV2 };
