import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const app = import.meta.env.DEV ? (
  <App />
) : (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(app);
