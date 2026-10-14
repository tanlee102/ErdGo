CREATE TABLE parents (
    id INT PRIMARY KEY,
    code TEXT,
    name TEXT
);

CREATE INDEX idx_broken ON parents;

CREATE INDEX idx_valid_parent_code ON parents (code);

CREATE TABLE children (
    id INT PRIMARY KEY,
    parent_id INT NOT NULL REFERENCES parents(id)
);
