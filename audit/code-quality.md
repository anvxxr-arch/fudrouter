# Code Quality & Architecture (weight 15% → 15.0)

All 5/5: tsc 0; 31/31 tests (5 bridge parity); shared-TS convergence (SSRF/creds/admin + _vkSend 4→1, zero raw sockets in admin); 404 contract; boundary guards (req<T>, vitals, playground); balanceStale; dead code removed (apiAction, landingFor, PaletteItem, TableFooter/Caption); benign catches verified by read. Table-copy boundary documented as intentional minimal-column design.
