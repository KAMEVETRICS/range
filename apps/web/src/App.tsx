import { useEffect, useState } from "react";
import type { DashboardApi } from "./api/client.js";
import { MarketsPage } from "./pages/MarketsPage.js";
import { OpportunitiesPage } from "./pages/OpportunitiesPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";

type Page = "overview" | "opportunities" | "markets";
const PAGES: Record<string, Page> = { "#overview": "overview", "#opportunities": "opportunities", "#markets": "markets" };
const TITLES: Record<Page, string> = { overview: "Range — Overview", opportunities: "Range — Opportunities", markets: "Range — Markets" };
const LINKS: Array<[Page, string]> = [["overview", "Overview"], ["opportunities", "Opportunities"], ["markets", "Markets"]];

/** A page link, which may name the underlying the page opens on: `#opportunities/equity:NVDA`. Other anchors are not pages. */
export function parseRoute(hash: string): { page: Page; underlying?: string } | undefined {
  const [name = "", ...rest] = hash.split("/");
  const page = PAGES[name];
  if (!page) return undefined;
  const underlying = rest.length ? decodeURIComponent(rest.join("/")) : undefined;
  return underlying ? { page, underlying } : { page };
}

const BrandMark = () => (
  <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="1" y="1" width="22" height="22" rx="5" />
    <path d="M7 7.5h10M7 16.5h10M12 7.5v9" />
  </svg>
);

/** Overview is the default page. Only the open page polls or streams; other in-page anchors leave the page as it is. */
export function App({ api }: { api: DashboardApi }) {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash) ?? { page: "overview" as Page });
  useEffect(() => {
    const onHashChange = () => {
      const next = parseRoute(window.location.hash);
      if (next) { setRoute(next); document.documentElement.scrollTop = 0; }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => { document.body.dataset.page = route.page; document.title = TITLES[route.page]; }, [route.page]);
  return (
    <div className="app-frame">
      <header className="topbar">
        <a className="brand" href="#overview" aria-label="Range overview"><BrandMark /><span>Range</span></a>
        <nav className="nav" aria-label="Dashboard pages">
          {LINKS.map(([page, label]) => (
            <a key={page} href={`#${page}`} aria-current={route.page === page ? "page" : undefined}>{label}</a>
          ))}
        </nav>
        <span className="topbar-chip" title="Range reads public market data only: no keys, no signing, no orders.">Read-only</span>
      </header>
      {route.page === "overview" ? <OverviewPage api={api} />
        : route.page === "markets" ? <MarketsPage api={api} />
        : <OpportunitiesPage key={route.underlying ?? ""} api={api} {...(route.underlying ? { initialUnderlying: route.underlying } : {})} />}
    </div>
  );
}
