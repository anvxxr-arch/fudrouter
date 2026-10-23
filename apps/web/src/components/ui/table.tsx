import * as React from "react";

type LegacyTableProps = {
  head?: React.ReactNode[];
  rows?: React.ReactNode[][];
  /** Column indexes that hold figures. Both the header and the body cells get
   *  `fr-num` (right-aligned): aligning only the body leaves the header hanging
   *  off the opposite edge, which reads worse than not aligning at all. */
  numeric?: number[];
};

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & LegacyTableProps
>(({ className, head, rows, numeric, children, ...props }, ref) => (
  // `.table-scroll` deliberately does NOT scroll: its comment in styles.css
  // explains that a scrollport there pins the sticky `th` to the wrong box. The
  // scrollport is `.table-wrap` -- and this component never rendered one, so
  // every console table overflowed invisibly: measured at 390px, table 585px
  // inside a 342px column, `overflow-x: visible` the whole way up, 0 ancestors
  // able to scroll, and `html/body { overflow-x: clip }` cutting the Cost and
  // Status columns off with no way to reach them. Public pages wrapped their
  // tables by hand; the console relies on this component, so the wrap belongs
  // here. `.table-wrap:has(.table-scroll)` then also gets the 70vh cap.
  <div className="table-wrap">
  <div className="table-scroll">
    <table
      ref={ref}
      className={className ? `fr ${className}` : "fr"}
      {...props}
    >
      {head ? (
        <TableHeader>
          <TableRow>
            {head.map((h, i) => (
              <TableHead key={i} className={numeric?.includes(i) ? "fr-num" : undefined}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
      ) : null}
      {rows ? (
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((c, j) => (
                <TableCell key={j} className={numeric?.includes(j) ? "fr-num" : undefined}>{c}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      ) : null}
      {children}
    </table>
  </div>
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={className ? `fr-thead ${className}` : "fr-thead"}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={className ? `fr-tbody ${className}` : "fr-tbody"}
    {...props}
  />
));
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={className ? `fr-tr ${className}` : "fr-tr"}
    {...props}
  />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={className ? `fr-th ${className}` : "fr-th"}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={className ? `fr-td ${className}` : "fr-td"}
    {...props}
  />
));
TableCell.displayName = "TableCell";

export {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
};
