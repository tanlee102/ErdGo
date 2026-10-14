CREATE TABLE sqlite_parent (
    id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE TABLE `mysql_bad` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,,
    `parent_id` BIGINT
);

GO

CREATE TABLE [dbo].[Orders] (
    [OrderID] BIGINT IDENTITY(1,1) PRIMARY KEY,
    [ParentID] INT REFERENCES sqlite_parent(id)
);

CREATE TYPE app.state AS ENUM ('open', 'closed');

CREATE TABLE app.pg_child (
    id BIGSERIAL PRIMARY KEY,
    state app.state NOT NULL DEFAULT 'open'
);
