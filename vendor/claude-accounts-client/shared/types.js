/**
 * The wire format between the service and its clients. Shared by both sides
 * and deliberately plain: every app that talks to the service gets these
 * types from the vendored client, which has no dependencies of its own.
 *
 * Times are epoch milliseconds unless a field says otherwise.
 */
export {};
