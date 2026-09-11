import React from "react";
import { WCASH_PRODUCT } from "../config/wcashProduct";
import "./WcashRuntimeGate.css";

const futureFlows = [
  {
    title: "Create wallet",
    detail: "Create a new Wcash Testnet wallet after the audited runtime is connected.",
  },
  {
    title: "Restore wallet",
    detail: "Restore Wcash keys only after key derivation and storage are verified.",
  },
  {
    title: "Receive TWC",
    detail: "Show a real Testnet address only when the Wcash runtime supplies it.",
  },
];

const WcashRuntimeGate = () => (
  <main className="runtime-gate">
    <section className="runtime-gate__card" aria-labelledby="product-title">
      <header className="runtime-gate__header">
        <div>
          <p className="runtime-gate__eyebrow">Testnet-only preview</p>
          <h1 id="product-title">Wcash Warden</h1>
        </div>
        <span className="runtime-gate__network">TESTNET</span>
      </header>

      <div className="runtime-gate__notice" role="status">
        <span className="runtime-gate__notice-dot" aria-hidden="true" />
        <div>
          <h2>Wallet runtime not installed</h2>
          <p>
            This safety build does not create, restore, sync, display addresses or balances, sign, or send. It never
            loads the inherited Zcash runtime as Wcash.
          </p>
        </div>
      </div>

      <dl className="runtime-gate__facts">
        <div>
          <dt>Network</dt>
          <dd>{WCASH_PRODUCT.network} only</dd>
        </div>
        <div>
          <dt>Asset</dt>
          <dd>Wcash ({WCASH_PRODUCT.ticker})</dd>
        </div>
        <div>
          <dt>Core status</dt>
          <dd>Awaiting reviewed wallet-core commit</dd>
        </div>
        <div>
          <dt>Local data</dt>
          <dd>Isolated Wcash Warden Testnet namespace</dd>
        </div>
      </dl>

      <section aria-labelledby="planned-flows-title">
        <h2 id="planned-flows-title" className="runtime-gate__section-title">
          Planned wallet flows
        </h2>
        <div className="runtime-gate__flows">
          {futureFlows.map((flow) => (
            <article className="runtime-gate__flow" key={flow.title}>
              <h3>{flow.title}</h3>
              <p>{flow.detail}</p>
              <button type="button" disabled>
                Unavailable before core pin
              </button>
            </article>
          ))}
        </div>
      </section>

      <p className="runtime-gate__footer">Pre-core engineering shell — not a wallet release</p>
    </section>
  </main>
);

export default WcashRuntimeGate;
