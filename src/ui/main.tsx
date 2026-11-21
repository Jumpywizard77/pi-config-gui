import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

/**
 * Real UI entry (Task 9): replaces the Task 1 placeholder marker. The App
 * shell fetches its own state (`/api/state`) and document text on mount.
 */
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("index.html is missing the #root element");
}
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
