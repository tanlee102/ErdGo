-- Supabase-like schemas with auth/storage namespaces and ignored RLS policy DDL.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE auth.users (
    id UUID NOT NULL,
    email TEXT NOT NULL,
    encrypted_password TEXT,
    role TEXT NOT NULL DEFAULT 'authenticated',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TABLE storage.buckets (
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    owner UUID,
    public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT buckets_pkey PRIMARY KEY (id),
    CONSTRAINT buckets_owner_fk FOREIGN KEY (owner) REFERENCES auth.users(id)
);

CREATE TABLE storage.objects (
    id UUID NOT NULL,
    bucket_id TEXT NOT NULL,
    owner UUID,
    name TEXT NOT NULL,
    path_tokens TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT objects_pkey PRIMARY KEY (id),
    CONSTRAINT objects_bucket_fk FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id),
    CONSTRAINT objects_owner_fk FOREIGN KEY (owner) REFERENCES auth.users(id)
);

CREATE INDEX objects_bucket_name_idx ON storage.objects (bucket_id, name);
CREATE INDEX objects_owner_bucket_idx ON storage.objects (owner, bucket_id);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY objects_owner_read ON storage.objects FOR SELECT USING (owner IS NOT NULL);
