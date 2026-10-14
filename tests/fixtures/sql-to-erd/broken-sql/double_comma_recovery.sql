CREATE TABLE ok_parent (
    id INT PRIMARY KEY
);

CREATE TABLE typo_child (
    id INT PRIMARY KEY,,
    parent_id INT NOT NULL REFERENCES ok_parent(id),
    payload TEXT
);

CREATE TABLE tail_ok (
    id INT PRIMARY KEY,
    child_id INT REFERENCES typo_child(id)
);
