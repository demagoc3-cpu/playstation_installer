import { AsyncLocalStorage } from 'node:async_hooks';

/** Marks work done by a console's own installation queue (its console id).
 * While that PS5 receives package data, other WEB work should leave it alone. */
export const ps5QueueContext = new AsyncLocalStorage<string>();
