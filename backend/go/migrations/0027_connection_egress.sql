-- A credential seen from hundreds of /128s in a minute looks like a shared
-- account, unlike the anonymous providers whose measured ~3 concurrent-request
-- per-IP ceilings motivated rotation (internal/sourceip/sourceip.go). Make that
-- distinction operator policy, not an inference from the secret's shape.
--
-- Existing rows stay ipv6_rotate: opting into sticky/pool/direct must not be a
-- side effect of applying the migration. The router preserves the historical
-- keyed/keyless dispatch within that default mode.
--
-- One hour spans sixty of the current 60s IP-throttle windows without keeping a
-- deleted credential's affinity forever. Expiry is absolute, not refreshed by
-- hits; the 24h bound also bounds dormant cache state. Neither field changes a
-- credential's own quota/cooldown. proxy_url holds only an endpoint: credentials
-- come from the operator's environment, never a plaintext database column.
BEGIN;

ALTER TABLE "connection"
    ADD COLUMN "egress_mode" text NOT NULL DEFAULT 'ipv6_rotate',
    ADD COLUMN "sticky_ttl_seconds" integer NOT NULL DEFAULT 3600,
    ADD COLUMN "proxy_url" text;

ALTER TABLE "connection"
    ADD CONSTRAINT "connection_egress_mode_check"
        CHECK ("egress_mode" IN ('direct', 'ipv6_rotate', 'sticky_own', 'pool')),
    ADD CONSTRAINT "connection_sticky_ttl_seconds_check"
        CHECK ("sticky_ttl_seconds" BETWEEN 1 AND 86400),
    ADD CONSTRAINT "connection_proxy_url_check"
        CHECK ("proxy_url" IS NULL OR (
            "egress_mode" = 'pool'
            AND "proxy_url" ~ '^(http|socks5)://[^/@?#]+:[0-9]+/?$'
        ));

COMMIT;
