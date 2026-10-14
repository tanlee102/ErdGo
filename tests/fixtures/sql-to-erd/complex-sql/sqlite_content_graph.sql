CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('page', 'asset', 'folder')),
    label TEXT NOT NULL,
    label_key TEXT GENERATED ALWAYS AS (lower(label)) STORED,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE edges (
    from_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    edge_kind TEXT NOT NULL DEFAULT 'contains',
    weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
    PRIMARY KEY (from_node_id, to_node_id, edge_kind)
) STRICT, WITHOUT ROWID;

CREATE TABLE tags (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE node_tags (
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    tag_slug TEXT NOT NULL REFERENCES tags(slug) ON DELETE CASCADE,
    PRIMARY KEY (node_id, tag_slug)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_nodes_kind_label
    ON nodes (kind, label_key);

CREATE INDEX idx_edges_kind_weight
    ON edges (edge_kind, weight)
    WHERE weight > 0;
