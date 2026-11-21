import { createRoot } from "react-dom/client";

import "./styles.css";

/**
 * Temporary UI entry (Task 1 scaffold): renders a bare marker so the vite
 * build has a real entry point. Task 9 replaces this file with the real App
 * mount (per the Task 1 controller ruling, the placeholder lives HERE rather
 * than in the brief's `src/main-placeholder.ts`, so index.html's
 * `/src/ui/main.tsx` script tag stays valid from day one).
 */
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("index.html is missing the #root element");
}
createRoot(rootElement).render(<div>pi-config-gui</div>);
