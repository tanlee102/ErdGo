-- Rails schema-ish dump with framework metadata tables plus application FKs.
CREATE TABLE "schema_migrations" (
    "version" character varying NOT NULL,
    CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("version")
);

CREATE TABLE "ar_internal_metadata" (
    "key" character varying NOT NULL,
    "value" character varying,
    "created_at" timestamp(6) NOT NULL,
    "updated_at" timestamp(6) NOT NULL,
    CONSTRAINT "ar_internal_metadata_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "users" (
    "id" bigserial NOT NULL,
    "email" character varying NOT NULL,
    "role" character varying DEFAULT 'member' NOT NULL,
    "preferences" jsonb DEFAULT '{}' NOT NULL,
    "created_at" timestamp(6) NOT NULL,
    "updated_at" timestamp(6) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "posts" (
    "id" bigserial NOT NULL,
    "user_id" bigint NOT NULL,
    "slug" character varying NOT NULL,
    "title" character varying NOT NULL,
    "published_at" timestamp(6),
    "created_at" timestamp(6) NOT NULL,
    "updated_at" timestamp(6) NOT NULL,
    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "comments" (
    "id" bigserial NOT NULL,
    "post_id" bigint NOT NULL,
    "author_id" bigint,
    "body" text NOT NULL,
    "created_at" timestamp(6) NOT NULL,
    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "index_users_on_email" ON "users" ("email");
CREATE UNIQUE INDEX "index_posts_on_user_id_and_slug" ON "posts" ("user_id", "slug");
CREATE INDEX "index_comments_on_post_id_and_created_at" ON "comments" ("post_id", "created_at");

ALTER TABLE "posts"
    ADD CONSTRAINT "fk_rails_posts_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id");
ALTER TABLE "comments"
    ADD CONSTRAINT "fk_rails_comments_posts" FOREIGN KEY ("post_id") REFERENCES "posts" ("id");
ALTER TABLE "comments"
    ADD CONSTRAINT "fk_rails_comments_authors" FOREIGN KEY ("author_id") REFERENCES "users" ("id");
