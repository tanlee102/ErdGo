CREATE TABLE parent (
    id INT PRIMARY KEY,
    code TEXT UNIQUE
);

CREATE TABLE child (
    id INT PRIMARY KEY,
    parent_id INT,
    code TEXT
);

ALTER TABLE child ADD CONSTRAINT fk_broken
    FOREIGN KEY (parent_id REFERENCES parent(id);

ALTER TABLE child ADD CONSTRAINT fk_valid
    FOREIGN KEY (parent_id) REFERENCES parent(id);
