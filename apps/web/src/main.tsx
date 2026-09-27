import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDashboardApi } from "./api/client.js";
import { OpportunitiesPage } from "./pages/OpportunitiesPage.js";
import "./styles.css";

const readToken = document.querySelector<HTMLMetaElement>('meta[name="range-read-token"]')?.content;
const api = createDashboardApi({ readToken });

createRoot(document.getElementById("root")!).render(<StrictMode><OpportunitiesPage api={api} /></StrictMode>);
