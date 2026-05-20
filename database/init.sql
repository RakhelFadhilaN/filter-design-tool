-- skripzi filter designer database
-- stores filter configurations (JSON) instead of rendered images

CREATE TABLE IF NOT EXISTS filter_presets (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(120)  NOT NULL,
    description TEXT,
    -- the full ChainRequest JSON blob — re-run anytime to get fresh plot data
    config      JSONB         NOT NULL,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- fast lookup by name (e.g. autocomplete / search)
CREATE INDEX IF NOT EXISTS idx_presets_name        ON filter_presets (name);
-- fast reverse-chronological listing
CREATE INDEX IF NOT EXISTS idx_presets_created_at  ON filter_presets (created_at DESC);
-- GIN index so Postgres can query inside the JSONB (e.g. filter by filter_type)
CREATE INDEX IF NOT EXISTS idx_presets_config_gin  ON filter_presets USING GIN (config);
