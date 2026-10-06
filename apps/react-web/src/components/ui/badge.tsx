import * as React from "react";

export type Tone = "default" | "ok" | "warn" | "info" | "danger";

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: Tone;
}

function Badge({ className, tone = "default", ...props }: BadgeProps) {
  const cls = `badge badge-${tone}`;
  return (
    <div
      className={className ? `${cls} ${className}` : cls}
      {...props}
    />
  );
}

export { Badge };
