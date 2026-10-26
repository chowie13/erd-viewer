/* A small example project (an online shop) for the "Try the sample" button. */
(function (root) {
  const files = [
    {
      path: 'db/migrations/0001_init.sql',
      text: `-- Accounts
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE roles (
  id smallint PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text
);

CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  display_name varchar(50) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)
);
COMMENT ON TABLE users IS 'Everyone who can sign in.';

CREATE TABLE user_roles (
  user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id smallint NOT NULL REFERENCES roles (id),
  PRIMARY KEY (user_id, role_id)
);

-- Catalog
CREATE TABLE categories (
  id serial PRIMARY KEY,
  parent_id integer REFERENCES categories (id),
  slug text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE products (
  id bigserial PRIMARY KEY,
  category_id integer NOT NULL REFERENCES categories,
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Orders
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  status order_status NOT NULL DEFAULT 'pending',
  placed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id bigint NOT NULL,
  product_id bigint NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  price_cents integer NOT NULL,
  CONSTRAINT order_items_pkey PRIMARY KEY (order_id, product_id),
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products (id)
);
CREATE INDEX orders_user_id_idx ON orders (user_id, placed_at DESC);
`,
    },
    {
      path: 'db/migrations/0002_reviews.sql',
      text: `CREATE TABLE reviews (
  id bigserial PRIMARY KEY,
  product_id bigint NOT NULL,
  user_id bigint NOT NULL,
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE reviews ADD CONSTRAINT reviews_product_fk FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE;
ALTER TABLE reviews ADD CONSTRAINT reviews_user_fk FOREIGN KEY (user_id) REFERENCES users (id);
CREATE UNIQUE INDEX reviews_one_per_user ON reviews (product_id, user_id);

ALTER TABLE products ADD COLUMN review_count integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN products.review_count IS 'Stored count, updated when a review is added or removed.';

CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL
);
`,
    },
    {
      path: 'db/migrations/0003_seed.sql',
      text: `-- System rows the app expects to exist
INSERT INTO roles (id, name, description) VALUES
  (1, 'member', 'Default role for new accounts'),
  (2, 'moderator', 'Can hide reviews'),
  (3, 'admin', 'Full access');

INSERT INTO categories (id, parent_id, slug, name) VALUES
  (1, NULL, 'garden', 'Garden'),
  (2, 1, 'seeds', 'Seeds'),
  (3, 1, 'tools', 'Tools'),
  (4, NULL, 'kitchen', 'Kitchen');

INSERT INTO settings (key, value) VALUES
  ('site_name', 'Example Shop'),
  ('currency', 'USD'),
  ('reviews_enabled', 'true');
`,
    },
  ];
  root.ErdSample = { name: 'Sample shop', files };
})(typeof globalThis !== 'undefined' ? globalThis : this);
