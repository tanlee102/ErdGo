-- PostgreSQL schema for a media-sharing app

CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(120),
    photo_url TEXT,
    role VARCHAR(20) NOT NULL DEFAULT 'USER',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_users_role
        CHECK (role IN ('USER', 'MOD', 'ADMIN'))
);

CREATE TABLE folders (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    slug VARCHAR(140) NOT NULL UNIQUE,
    description TEXT,
    total_videos INTEGER NOT NULL DEFAULT 0,
    total_views BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE posts (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    title VARCHAR(255) NOT NULL,
    subtitle VARCHAR(255),
    body TEXT,
    view_count BIGINT NOT NULL DEFAULT 0,
    like_count BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_posts_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE TABLE post_media (
    id BIGSERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL,
    media_type VARCHAR(20) NOT NULL,
    file_id VARCHAR(255) NOT NULL,
    thumbnail_file_id VARCHAR(255),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_post_media_post
        FOREIGN KEY (post_id)
        REFERENCES posts(id)
        ON DELETE CASCADE,

    CONSTRAINT chk_post_media_type
        CHECK (media_type IN ('IMAGE', 'VIDEO', 'FILE'))
);

CREATE TABLE videos (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    folder_id BIGINT,
    video_key VARCHAR(120) NOT NULL UNIQUE,
    title VARCHAR(255) NOT NULL,
    vi_title VARCHAR(255),
    description TEXT,
    file_id VARCHAR(255) NOT NULL,
    thumbnail_file_id VARCHAR(255),
    size_bytes BIGINT,
    duration_seconds INTEGER,
    view_count BIGINT NOT NULL DEFAULT 0,
    state VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_videos_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_videos_folder
        FOREIGN KEY (folder_id)
        REFERENCES folders(id)
        ON DELETE SET NULL,

    CONSTRAINT chk_videos_state
        CHECK (state IN ('PROCESSING', 'ACTIVE', 'HIDDEN', 'DELETED'))
);

CREATE TABLE comments (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    post_id BIGINT,
    video_id BIGINT,
    parent_comment_id BIGINT,
    content TEXT NOT NULL,
    like_count BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_comments_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_comments_post
        FOREIGN KEY (post_id)
        REFERENCES posts(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_comments_video
        FOREIGN KEY (video_id)
        REFERENCES videos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_comments_parent
        FOREIGN KEY (parent_comment_id)
        REFERENCES comments(id)
        ON DELETE CASCADE,

    CONSTRAINT chk_comment_target
        CHECK (
            (post_id IS NOT NULL AND video_id IS NULL)
            OR
            (post_id IS NULL AND video_id IS NOT NULL)
        )
);

CREATE TABLE tags (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE,
    slug VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE post_tags (
    post_id BIGINT NOT NULL,
    tag_id BIGINT NOT NULL,

    PRIMARY KEY (post_id, tag_id),

    CONSTRAINT fk_post_tags_post
        FOREIGN KEY (post_id)
        REFERENCES posts(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_post_tags_tag
        FOREIGN KEY (tag_id)
        REFERENCES tags(id)
        ON DELETE CASCADE
);

CREATE TABLE video_tags (
    video_id BIGINT NOT NULL,
    tag_id BIGINT NOT NULL,

    PRIMARY KEY (video_id, tag_id),

    CONSTRAINT fk_video_tags_video
        FOREIGN KEY (video_id)
        REFERENCES videos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_video_tags_tag
        FOREIGN KEY (tag_id)
        REFERENCES tags(id)
        ON DELETE CASCADE
);

CREATE INDEX idx_posts_user_id
    ON posts(user_id);

CREATE INDEX idx_posts_created_at
    ON posts(created_at DESC);

CREATE INDEX idx_post_media_post_id
    ON post_media(post_id);

CREATE INDEX idx_videos_user_id
    ON videos(user_id);

CREATE INDEX idx_videos_folder_id
    ON videos(folder_id);

CREATE INDEX idx_videos_created_at
    ON videos(created_at DESC);

CREATE INDEX idx_comments_user_id
    ON comments(user_id);

CREATE INDEX idx_comments_post_id
    ON comments(post_id);

CREATE INDEX idx_comments_video_id
    ON comments(video_id);

CREATE INDEX idx_comments_parent_id
    ON comments(parent_comment_id);