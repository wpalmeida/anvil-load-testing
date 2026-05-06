CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS specs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_url    TEXT NOT NULL,
    spec_url    TEXT NOT NULL,
    title       TEXT,
    version     TEXT,
    spec        JSONB NOT NULL,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service       TEXT NOT NULL,
    base_url      TEXT NOT NULL,
    profile       TEXT NOT NULL,
    vus           INTEGER,
    duration      TEXT,
    config        JSONB NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',
    triggered_by  TEXT,
    queued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    error         TEXT,
    summary       JSONB
);

CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
CREATE INDEX IF NOT EXISTS runs_queued_at_idx ON runs (queued_at DESC);
