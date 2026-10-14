CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL UNIQUE,
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE forms (
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    form_id TEXT NOT NULL,
    title TEXT NOT NULL,
    title_key TEXT GENERATED ALWAYS AS (lower(title)) STORED,
    PRIMARY KEY (device_id, form_id),
    CHECK (length(title) > 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE form_versions (
    device_id TEXT NOT NULL,
    form_id TEXT NOT NULL,
    version_no INTEGER NOT NULL,
    schema_json TEXT NOT NULL,
    is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
    PRIMARY KEY (device_id, form_id, version_no),
    FOREIGN KEY (device_id, form_id)
        REFERENCES forms(device_id, form_id)
        ON DELETE CASCADE
) STRICT;

CREATE TABLE submissions (
    device_id TEXT NOT NULL,
    form_id TEXT NOT NULL,
    version_no INTEGER NOT NULL,
    submission_id TEXT NOT NULL,
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, form_id, version_no, submission_id),
    FOREIGN KEY (device_id, form_id, version_no)
        REFERENCES form_versions(device_id, form_id, version_no)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_form_versions_published
    ON form_versions (device_id, form_id, is_published)
    WHERE is_published = 1;

CREATE INDEX idx_submissions_time
    ON submissions (submitted_at);
