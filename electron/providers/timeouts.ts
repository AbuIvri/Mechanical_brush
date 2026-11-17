// How long a request to an engine may take before it is given up on. Without a limit, a
// connection that hangs (it happens: a dropped socket the server never closes) left the
// run "busy" forever with no way out but quitting. When one fires, describeError
// (shared/errors.ts) says so in words and warns that the provider may still have charged.
export const REQUEST_MS = 120_000; // sending a job or an upload, and waiting for its answer
export const POLL_MS = 30_000; // one status check while a job runs
export const DOWNLOAD_MS = 60_000; // fetching the finished image
export const CHAT_MS = 180_000; // one answer from the prompt assistant (reasoning models think first)
