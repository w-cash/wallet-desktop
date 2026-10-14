import React from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import APP_VERSION from "../version";

export const WCASH_ROUTES = Object.freeze({
  dashboard: "/dashboard",
  send: "/send",
  receive: "/receive",
  history: "/history",
});

type WcashRoutesProps = {
  productName: string;
  network: string;
  ticker: string;
  endpoint: string;
  localRegtest: boolean;
  syncing: boolean;
  exactTipHeight: number | null;
  syncNote: string;
  onSync: () => void;
  onStopSync: () => void;
  notice?: React.ReactNode;
  dashboard: React.ReactNode;
  send: React.ReactNode;
  receive: React.ReactNode;
  history: React.ReactNode;
};

const NAVIGATION = [
  { to: WCASH_ROUTES.dashboard, label: "Dashboard", icon: "fa-home" },
  { to: WCASH_ROUTES.send, label: "Send", icon: "fa-paper-plane" },
  { to: WCASH_ROUTES.receive, label: "Receive", icon: "fa-download" },
  { to: WCASH_ROUTES.history, label: "History", icon: "fa-list" },
] as const;

const PAGE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  [WCASH_ROUTES.dashboard]: "Dashboard",
  [WCASH_ROUTES.send]: "Send",
  [WCASH_ROUTES.receive]: "Receive",
  [WCASH_ROUTES.history]: "History",
});

/**
 * Zingo's familiar desktop information architecture, backed exclusively by the
 * small controller callback surface. This component intentionally has no
 * access to the inherited RPC, IPC, filesystem, or wallet implementations.
 */
const WcashRoutes = ({
  productName,
  network,
  ticker,
  endpoint,
  localRegtest,
  syncing,
  exactTipHeight,
  syncNote,
  onSync,
  onStopSync,
  notice,
  dashboard,
  send,
  receive,
  history,
}: WcashRoutesProps) => {
  const location = useLocation();
  const title = PAGE_TITLES[location.pathname] ?? "Dashboard";

  return (
    <div className="wcash-zingo-app">
      <aside className="wcash-zingo-sidebar">
        <div className="wcash-zingo-brand" aria-label="Wcash Warden">
          <span className="wcash-zingo-logo" aria-hidden="true">
            W
          </span>
          <div>
            <strong>Wcash Warden</strong>
            <span>v{APP_VERSION}</span>
          </div>
        </div>

        <nav className="wcash-zingo-nav" aria-label="Wallet navigation">
          {NAVIGATION.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "wcash-zingo-nav-link is-active" : "wcash-zingo-nav-link")}
            >
              <i className={`fas ${item.icon}`} aria-hidden="true" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="wcash-zingo-status" data-exact-tip={exactTipHeight === null ? "false" : "true"}>
          <span aria-hidden="true" />
          <div>
            <strong>{syncing ? "Syncing" : exactTipHeight === null ? "Balance locked" : "Connected"}</strong>
            <small>{exactTipHeight === null ? network : `Block ${exactTipHeight.toLocaleString()}`}</small>
          </div>
        </div>
      </aside>

      <main className="wcash-zingo-content">
        <header className="wcash-zingo-topbar">
          <div>
            <span>{productName}</span>
            <h1>{title}</h1>
          </div>
          <div className="wcash-zingo-top-actions">
            <span className="wcash-zingo-network">
              {network} · {ticker}
            </span>
            {syncing ? (
              <button className="warden-button warden-button--danger" type="button" onClick={onStopSync}>
                Stop sync
              </button>
            ) : (
              <button className="warden-button" type="button" onClick={onSync}>
                Synchronize
              </button>
            )}
          </div>
        </header>

        <div className="wcash-zingo-route-scroll">
          <div className="wcash-zingo-runtime-note" role="note">
            {localRegtest ? (
              <>
                Local Regtest funds have no monetary value. Fixed endpoint: <code>{endpoint}</code>.
              </>
            ) : (
              <>Testnet funds have no monetary value. This build connects only to Wcash Testnet.</>
            )}
          </div>
          {notice}
          <div className="wcash-zingo-sync-summary" data-exact-tip={exactTipHeight === null ? "false" : "true"}>
            <i className={`fas ${syncing ? "fa-sync fa-spin" : exactTipHeight === null ? "fa-lock" : "fa-check"}`} />
            <span>{syncNote}</span>
          </div>

          <Routes>
            <Route path={WCASH_ROUTES.dashboard} element={dashboard} />
            <Route path={WCASH_ROUTES.send} element={send} />
            <Route path={WCASH_ROUTES.receive} element={receive} />
            <Route path={WCASH_ROUTES.history} element={history} />
            <Route path="*" element={<Navigate replace to={WCASH_ROUTES.dashboard} />} />
          </Routes>
        </div>
      </main>
    </div>
  );
};

export default WcashRoutes;
