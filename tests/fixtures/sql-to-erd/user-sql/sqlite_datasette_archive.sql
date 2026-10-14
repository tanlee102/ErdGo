-- SQLite archive export with bracket identifiers, WITHOUT ROWID, and many-to-many joins.
BEGIN TRANSACTION;

CREATE TABLE [artists] (
    [artist_id] INTEGER NOT NULL PRIMARY KEY,
    [name] TEXT NOT NULL UNIQUE,
    [sort_name] TEXT GENERATED ALWAYS AS (lower([name])) STORED
);

CREATE TABLE [albums] (
    [album_id] INTEGER NOT NULL PRIMARY KEY,
    [artist_id] INTEGER NOT NULL,
    [title] TEXT NOT NULL,
    [release_year] INTEGER,
    FOREIGN KEY ([artist_id]) REFERENCES [artists]([artist_id])
);

CREATE TABLE [tracks] (
    [track_id] INTEGER NOT NULL PRIMARY KEY,
    [album_id] INTEGER NOT NULL,
    [title] TEXT NOT NULL,
    [duration_ms] INTEGER NOT NULL CHECK ([duration_ms] >= 0),
    FOREIGN KEY ([album_id]) REFERENCES [albums]([album_id])
);

CREATE TABLE [playlists] (
    [playlist_id] INTEGER NOT NULL PRIMARY KEY,
    [name] TEXT NOT NULL UNIQUE
);

CREATE TABLE [playlist_track] (
    [playlist_id] INTEGER NOT NULL,
    [track_id] INTEGER NOT NULL,
    [position] INTEGER NOT NULL,
    PRIMARY KEY ([playlist_id], [track_id]),
    FOREIGN KEY ([playlist_id]) REFERENCES [playlists]([playlist_id]),
    FOREIGN KEY ([track_id]) REFERENCES [tracks]([track_id])
) WITHOUT ROWID;

CREATE INDEX [idx_albums_artist_year] ON [albums] ([artist_id], [release_year]);
CREATE INDEX [idx_tracks_album_title] ON [tracks] ([album_id], [title]);
CREATE INDEX [idx_playlist_track_position] ON [playlist_track] ([playlist_id], [position]);
COMMIT;
