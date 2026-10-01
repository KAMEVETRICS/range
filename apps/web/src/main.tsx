import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { createDashboardApi } from "./api/client.js";
import { App } from "./App.js";
import "./styles.css";

const readToken = document.querySelector<HTMLMetaElement>('meta[name="range-read-token"]')?.content;
const api = createDashboardApi({ readToken });

createRoot(document.getElementById("root")!).render(<StrictMode><App api={api} /></StrictMode>);
