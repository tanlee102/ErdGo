CREATE TABLE broken_default (
    id INT PRIMARY KEY,
    note TEXT DEFAULT 'unterminated
);

CREATE TABLE recovered_string (
    id INT PRIMARY KEY
);
