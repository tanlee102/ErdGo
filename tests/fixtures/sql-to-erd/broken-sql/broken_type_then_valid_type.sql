CREATE TYPE app.bad_status AS ENUM ('open', 'closed';

CREATE TYPE app.good_status AS ENUM ('draft', 'active');

CREATE TABLE app.items (
    id BIGSERIAL PRIMARY KEY,
    status app.good_status NOT NULL DEFAULT 'draft'
);
