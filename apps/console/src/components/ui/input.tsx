import * as React from "react";

const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={className ? `input ${className}` : "input"}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
