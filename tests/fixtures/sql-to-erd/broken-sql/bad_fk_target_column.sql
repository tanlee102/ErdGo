CREATE TABLE parents (
    id INT PRIMARY KEY,
    code TEXT UNIQUE
);

CREATE TABLE children (
    id INT PRIMARY KEY,
    parent_id INT REFERENCES parents(id),
    bad_parent_id INT REFERENCES parents(missing_code)
);
