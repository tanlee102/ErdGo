CREATE TABLE valid_before (
    id INT PRIMARY KEY
);

CREATE TABLE broken_parent (
    id INT PRIMARY KEY,
    name TEXT,
CREATE TABLE valid_after (
    id INT PRIMARY KEY,
    before_id INT NOT NULL REFERENCES valid_before(id)
);
