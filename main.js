import React from "react";
import { createRoot } from "react-dom/client";
import FamilyBudgetApp from "./app.js";

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(FamilyBudgetApp));

// Register the service worker for offline support once the app has mounted.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(err => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
