-- pg_dump-style schema with extension noise, qualified names, and ALTER constraints.
SET statement_timeout = 0;
SET client_encoding = 'UTF8';
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS public;

CREATE TYPE public.account_state AS ENUM ('trial', 'active', 'locked', 'deleted');
CREATE TYPE public.profile_address AS (
    line1 TEXT,
    city TEXT,
    country_code CHAR(2)
);

CREATE TABLE public.accounts (
    id UUID DEFAULT gen_random_uuid() NOT NULL,
    tenant_key TEXT NOT NULL,
    state public.account_state DEFAULT 'trial' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE TABLE public.profiles (
    id UUID DEFAULT gen_random_uuid() NOT NULL,
    account_id UUID NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    billing_address public.profile_address,
    deleted_at TIMESTAMPTZ
);

CREATE TABLE public.sessions (
    id UUID DEFAULT gen_random_uuid() NOT NULL,
    account_id UUID NOT NULL,
    profile_id UUID,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
ALTER TABLE public.accounts
    ADD CONSTRAINT accounts_tenant_key_key UNIQUE (tenant_key);
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_account_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);
ALTER TABLE public.sessions
    ADD CONSTRAINT sessions_account_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);
ALTER TABLE public.sessions
    ADD CONSTRAINT sessions_profile_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id);

CREATE UNIQUE INDEX profiles_active_email_idx
    ON public.profiles (account_id, email)
    WHERE deleted_at IS NULL;
CREATE INDEX sessions_account_expiry_idx
    ON public.sessions USING btree (account_id, expires_at DESC);
COMMENT ON TABLE public.accounts IS 'tenant accounts from pg_dump';
