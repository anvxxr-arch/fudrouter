import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ConsoleLayout } from "../components/ConsoleLayout";

function Page({ title, lede, children }: { title: string; lede: string; children?: ReactNode }) {
  return (<div className="stack"><h1>{title}</h1><p className="lede muted">{lede}</p>{children}</div>);
}

// Hub only: every card links to a surface that already exists.
export function SettingsHub() {
  const cards = [
    { label: "Account", to: "/dashboard/account", desc: "Your name, email and timezone" },
    { label: "Billing", to: "/dashboard/billing", desc: "Balance, thresholds and credits" },
    { label: "Payment methods", to: "/dashboard/billing/payment-methods", desc: "How you intend to pay" },
    { label: "Invoices", to: "/dashboard/billing/invoices", desc: "Generate and settle invoices" },
    { label: "Routing", to: "/dashboard/routing", desc: "Routing policies and strategies" },
    { label: "Limits", to: "/dashboard/limits", desc: "Rate and spend limits" },
    { label: "Aliases", to: "/dashboard/aliases", desc: "Stable model aliases" },
  ];
  return (<ConsoleLayout><Page title="Settings" lede="Account, billing and routing surfaces.">
    <div className="cat-grid">
      {cards.map((c) => (
        <Link key={c.label} className="cat-card" to={c.to}>
          <strong>{c.label}</strong>
          <span className="muted">{c.desc}</span>
        </Link>
      ))}
    </div>
  </Page></ConsoleLayout>);
}
