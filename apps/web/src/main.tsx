import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyPalette, loadPalette } from "./lib/palette.js";
import { migrateLegacyStorage } from "./lib/storageMigration.js";
import "./index.css";

// Before anything reads storage: bring `crc.*` keys over to `renki.*` so the
// rename doesn't log this browser out or drop its drafts.
migrateLegacyStorage();

// Before the first paint: a palette applied after render shows the amber
// default for a frame to someone who chose linen.
applyPalette(loadPalette());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
