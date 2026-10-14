CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE notebooks (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    notebook_id TEXT NOT NULL,
    title TEXT NOT NULL COLLATE NOCASE,
    normalized_title TEXT GENERATED ALWAYS AS (lower(title)) STORED,
    PRIMARY KEY (account_id, notebook_id),
    CHECK (length(title) > 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    notebook_id TEXT NOT NULL,
    body TEXT,
    is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
    FOREIGN KEY (account_id, notebook_id)
        REFERENCES notebooks(account_id, notebook_id)
        ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_notes_active_notebook
    ON notes (account_id, notebook_id)
    WHERE is_archived = 0;

CREATE INDEX idx_notes_body
    ON notes (body);
