import { useEffect, useState } from "react";
import type { DashboardApi } from "./api/client.js";
import { MarketsPage } from "./pages/MarketsPage.js";
import { OpportunitiesPage } from "./pages/OpportunitiesPage.js";

type Page = "markets" | "opportunities";
const PAGES: Record<string, Page> = { "#markets": "markets", "#opportunities": "opportunities" };
const TITLES: Record<Page, string> = { markets: "Range — Markets", opportunities: "Range — Opportunities" };

/** Markets is the default page. Only the open page polls or streams; other in-page anchors leave the page as it is. */
export function App({ api }: { api: DashboardApi }) {
  const [page, setPage] = useState<Page>(() => PAGES[window.location.hash] ?? "markets");
  useEffect(() => {
    const onHashChange = () => { const next = PAGES[window.location.hash]; if (next) setPage(next); };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  // The markets page is dark; the body carries the page so the whole viewport follows it.
  useEffect(() => { document.body.dataset.page = page; document.title = TITLES[page]; }, [page]);
  return (
    <>
      <nav className="app-tabs" aria-label="Dashboard pages">
        <a href="#markets" aria-current={page === "markets" ? "page" : undefined}>Markets</a>
        <a href="#opportunities" aria-current={page === "opportunities" ? "page" : undefined}>Opportunities</a>
      </nav>
      {page === "markets" ? <MarketsPage api={api} /> : <OpportunitiesPage api={api} />}
    </>
  );
}
