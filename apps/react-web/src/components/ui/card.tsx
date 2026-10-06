import * as React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  desc?: string;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, title, desc, children, ...props }, ref) => (
    <div
      ref={ref}
      className={className ? `card ${className}` : "card"}
      {...props}
    >
      {title ? <h3 className="card-title">{title}</h3> : null}
      {desc ? <p className="card-desc">{desc}</p> : null}
      {children}
    </div>
  ),
);
Card.displayName = "Card";

export { Card };
