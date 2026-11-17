import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./fonts.css";
import "./styles.css";
import "./ink.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Errors outside React (an async handler, a timer) do not reach the boundary. They are
// logged — console.error goes to the main process's log file — and not shown: a toast for
// every stray rejection would cry wolf. The browser's ResizeObserver notice is not an error.
window.addEventListener("error", (e) => {
  if (/ResizeObserver loop/.test(e.message)) return;
  console.error(`[unhandled] ${e.error?.stack || e.message}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason as { stack?: string } | undefined;
  console.error(`[unhandled rejection] ${r?.stack || String(e.reason)}`);
});
