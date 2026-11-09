import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ConsoleLayout } from "../components/ConsoleLayout";

function Page({ title, lede, children }: { title: string; lede: string; children?: ReactNode }) {
  return (<div className="grid gap-6"><h1>{title}</h1><p className="measure text-base text-muted-foreground">{lede}</p>{children}</div>);
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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        <Link key={c.label} className="grid content-start gap-1 rounded-md border border-border bg-[var(--card)] p-4 text-foreground hover:border-border-strong hover:no-underline" to={c.to}>
          <strong>{c.label}</strong>
          <span className="text-muted-foreground">{c.desc}</span>
        </Link>
      ))}
    </div>
  </Page></ConsoleLayout>);
}
