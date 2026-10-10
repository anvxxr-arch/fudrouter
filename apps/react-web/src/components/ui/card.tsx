import * as React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  desc?: string;
  /** Heading level for the title. Defaults to h3 (card convention); pages
   * whose outline needs h2 pass titleAs="h2" to avoid an h1->h3 skip. */
  titleAs?: "h2" | "h3" | "p";
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, title, desc, titleAs, children, ...props }, ref) => (
    <div
      ref={ref}
      className={className ? `card ${className}` : "card"}
      {...props}
    >
      {title ? (titleAs === "h2" ? <h2 className="card-title">{title}</h2> : titleAs === "p" ? <p className="card-title">{title}</p> : <h3 className="card-title">{title}</h3>) : null}
      {desc ? <p className="card-desc">{desc}</p> : null}
      {children}
    </div>
  ),
);
Card.displayName = "Card";

export { Card };
