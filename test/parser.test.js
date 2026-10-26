const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProject, sortFiles, isSqlPath, isDownMigration } = require('../js/parser.js');

function parse(...texts) {
  return parseProject(texts.map((text, i) => ({ path: `m${i}.sql`, text })));
}
const table = (model, key) => model.tables.find((t) => t.key === key);
const column = (model, key, name) => table(model, key).columns.find((c) => c.name === name);

test('reads columns, types, keys and defaults', () => {
  const m = parse(`
    CREATE TABLE users (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email varchar(255) NOT NULL UNIQUE,
      price numeric(10, 2) DEFAULT 0,
      tags text[],
      created_at timestamp with time zone DEFAULT now() NOT NULL
    );`);
  const t = table(m, 'users');
  assert.deepEqual(t.columns.map((c) => [c.name, c.type]), [
    ['id', 'bigint'],
    ['email', 'varchar(255)'],
    ['price', 'numeric(10, 2)'],
    ['tags', 'text[]'],
    ['created_at', 'timestamp with time zone'],
  ]);
  assert.equal(column(m, 'users', 'id').pk, true);
  assert.equal(column(m, 'users', 'id').identity, true);
  assert.equal(column(m, 'users', 'email').unique, true);
  assert.equal(column(m, 'users', 'email').notNull, true);
  assert.equal(column(m, 'users', 'price').notNull, false);
  assert.equal(column(m, 'users', 'created_at').default, 'now()');
  assert.equal(column(m, 'users', 'created_at').notNull, true);
  assert.deepEqual(m.warnings, []);
});

test('reads foreign keys from columns, table constraints and ALTER TABLE', () => {
  const m = parse(`
    CREATE TABLE a (id serial PRIMARY KEY);
    CREATE TABLE b (
      id serial PRIMARY KEY,
      a_id int REFERENCES a ON DELETE CASCADE,
      parent_id int,
      CONSTRAINT b_parent_fk FOREIGN KEY (parent_id) REFERENCES b (id)
    );
    CREATE TABLE c (id int, b_id int);
    ALTER TABLE ONLY c ADD CONSTRAINT c_pkey PRIMARY KEY (id);
    ALTER TABLE c ADD CONSTRAINT c_b_fk FOREIGN KEY (b_id) REFERENCES public.b(id);`);
  assert.deepEqual(column(m, 'b', 'a_id').fk, { table: 'a', column: 'id' });
  assert.equal(table(m, 'b').fks[0].onDelete, 'cascade');
  assert.deepEqual(column(m, 'b', 'parent_id').fk, { table: 'b', column: 'id' });
  assert.deepEqual(column(m, 'c', 'b_id').fk, { table: 'b', column: 'id' });
  assert.equal(column(m, 'c', 'id').pk, true);
  assert.deepEqual(table(m, 'b').referencedBy.map((r) => r.table).sort(), ['b', 'c']);
});

test('handles quoted names, schemas and Drizzle migrations', () => {
  const m = parse(`
    CREATE TABLE IF NOT EXISTS "Users" (
    	"id" serial PRIMARY KEY NOT NULL,
    	"Email" text NOT NULL,
    	CONSTRAINT "users_email_unique" UNIQUE("Email")
    );
    --> statement-breakpoint
    CREATE TABLE "audit"."events" ("id" serial PRIMARY KEY, "user_id" integer);
    --> statement-breakpoint
    DO $$ BEGIN
     ALTER TABLE "audit"."events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."Users"("id") ON DELETE no action ON UPDATE no action;
    EXCEPTION
     WHEN duplicate_object THEN null;
    END $$;`);
  assert.ok(table(m, 'Users'));
  assert.equal(column(m, 'Users', 'Email').unique, true);
  assert.equal(table(m, 'audit.events').schema, 'audit');
  assert.deepEqual(column(m, 'audit.events', 'user_id').fk, { table: 'Users', column: 'id' });
  assert.deepEqual(m.warnings, []);
});

test('applies later migrations: add, rename, alter and drop', () => {
  const m = parse(
    `CREATE TABLE posts (id int PRIMARY KEY, title text, old text);
     CREATE TABLE temp_stuff (id int);
     CREATE TABLE comments (id int, post_id int REFERENCES posts);`,
    `ALTER TABLE posts ADD COLUMN body text NOT NULL, DROP COLUMN old;
     ALTER TABLE posts RENAME COLUMN title TO headline;
     ALTER TABLE posts ALTER COLUMN headline SET NOT NULL, ALTER COLUMN body TYPE varchar(500);
     ALTER TABLE posts RENAME TO articles;
     DROP TABLE IF EXISTS temp_stuff CASCADE;`
  );
  assert.equal(table(m, 'posts'), undefined);
  assert.equal(table(m, 'temp_stuff'), undefined);
  assert.deepEqual(table(m, 'articles').columns.map((c) => c.name), ['id', 'headline', 'body']);
  assert.equal(column(m, 'articles', 'headline').notNull, true);
  assert.equal(column(m, 'articles', 'body').type, 'varchar(500)');
  assert.deepEqual(column(m, 'comments', 'post_id').fk, { table: 'articles', column: 'id' });
});

test('reads enums, comments and indexes', () => {
  const m = parse(`
    CREATE TYPE mood AS ENUM ('sad', 'ok');
    ALTER TYPE mood ADD VALUE 'happy';
    CREATE TABLE people (id int PRIMARY KEY, feeling mood, nick text);
    COMMENT ON TABLE people IS 'All the people';
    COMMENT ON COLUMN people.nick IS 'Optional';
    CREATE UNIQUE INDEX people_nick_idx ON people USING btree (nick);
    CREATE INDEX ON people (lower(nick)) WHERE nick IS NOT NULL;`);
  assert.deepEqual(column(m, 'people', 'feeling').enumValues, ['sad', 'ok', 'happy']);
  assert.equal(table(m, 'people').comment, 'All the people');
  assert.equal(column(m, 'people', 'nick').comment, 'Optional');
  assert.equal(column(m, 'people', 'nick').unique, true);
  assert.equal(table(m, 'people').indexes.length, 2);
  assert.equal(table(m, 'people').indexes[1].where, 'nick IS NOT NULL');
});

test('collects seed rows from INSERT, including seed files that sort first', () => {
  const m = parseProject([
    { path: 'a_seed.sql', text: `INSERT INTO roles (id, name, note) VALUES (1, 'admin', NULL), (2, E'it''s\\tme', 'x'::text); INSERT INTO roles VALUES (3, 'guest', now());` },
    { path: 'b_schema.sql', text: 'CREATE TABLE roles (id int PRIMARY KEY, name text, note text);' },
  ]);
  const rows = table(m, 'roles').rows;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].values, { id: 1, name: 'admin', note: null });
  assert.deepEqual(rows[1].values, { id: 2, name: "it's\tme", note: 'x' });
  assert.deepEqual(rows[2].values, { id: 3, name: 'guest', note: { expr: 'now()' } });
  assert.equal(rows[0].file, 'a_seed.sql');
  assert.deepEqual(m.warnings, []);
});

test('collects seed rows from pg_dump COPY blocks', () => {
  const m = parse(`CREATE TABLE public.settings (key text PRIMARY KEY, value text);

COPY public.settings (key, value) FROM stdin;
site_name\tMy site
empty\t\\N
\\.

ALTER TABLE public.settings OWNER TO app;`);
  assert.deepEqual(table(m, 'settings').rows.map((r) => r.values), [
    { key: 'site_name', value: 'My site' },
    { key: 'empty', value: null },
  ]);
});

test('reads seed rows from INSERT ... SELECT with a VALUES list', () => {
  const m = parse(`
    CREATE TABLE kinds (id serial PRIMARY KEY, name text UNIQUE, created_by int);
    CREATE TABLE fields (id serial PRIMARY KEY, kind_id int REFERENCES kinds, name text, unit text);
    INSERT INTO kinds (name) SELECT 'Feed' ON CONFLICT DO NOTHING;
    INSERT INTO fields (kind_id, name, unit)
    SELECT k.id, f.name, f.unit
    FROM (VALUES
      ('Feed', 'PPM', 'ppm'),
      ('Water', 'Quantity', NULL)
    ) AS f (kind_name, name, unit)
    JOIN kinds k ON k.name = f.kind_name AND k.created_by IS NULL
    ON CONFLICT (kind_id, name) DO NOTHING;`);
  assert.deepEqual(table(m, 'kinds').rows[0].values, { name: 'Feed' });
  assert.deepEqual(table(m, 'fields').rows.map((r) => r.values), [
    { kind_id: { expr: "kinds.id where name = 'Feed'" }, name: 'PPM', unit: 'ppm' },
    { kind_id: { expr: "kinds.id where name = 'Water'" }, name: 'Quantity', unit: null },
  ]);
  assert.deepEqual(m.warnings, []);
});

test('ignores test scripts that roll back, inserts in DO blocks and psql commands', () => {
  const m = parseProject([
    { path: '01_schema.sql', text: '\\set ON_ERROR_STOP on\nCREATE TABLE users (id serial PRIMARY KEY, name text);\nINSERT INTO users (name) VALUES (\'system\');' },
    {
      path: 'checks.sql',
      text: `\\set ON_ERROR_STOP on
BEGIN;
INSERT INTO users (name) VALUES ('test user');
CREATE TABLE scratch (id int);
DO $$
DECLARE sam int;
BEGIN
  INSERT INTO users (name) VALUES ('sam') RETURNING id INTO sam;
END $$;
ROLLBACK;`,
    },
    { path: 'install.sql', text: '\\ir 01_schema.sql\n' },
  ]);
  assert.deepEqual(table(m, 'users').rows.map((r) => r.values.name), ['system']);
  assert.equal(table(m, 'scratch'), undefined);
  assert.deepEqual(m.warnings, []);
});

test('reports problems without stopping', () => {
  const m = parse(`ALTER TABLE ghost ADD COLUMN x int; INSERT INTO nowhere VALUES (1); CREATE TABLE ok (id int);`);
  assert.ok(table(m, 'ok'));
  assert.equal(m.warnings.length, 2);
  assert.equal(m.warnings[0].file, 'm0.sql');
});

test('picks and orders migration files', () => {
  assert.equal(isSqlPath('db/0001_init.sql'), true);
  assert.equal(isSqlPath('node_modules/x/schema.sql'), false);
  assert.equal(isSqlPath('README.md'), false);
  assert.equal(isDownMigration('migrations/0002_users.down.sql'), true);
  assert.equal(isDownMigration('migrations/0002/down.sql'), true);
  assert.equal(isDownMigration('migrations/0002_users.up.sql'), false);
  assert.equal(isDownMigration('migrations/0003_drop_downloads.sql'), false);
  const order = sortFiles([{ path: 'm/10_c.sql' }, { path: 'm/2_b.sql' }, { path: 'm/1_a.sql' }]).map((f) => f.path);
  assert.deepEqual(order, ['m/1_a.sql', 'm/2_b.sql', 'm/10_c.sql']);
});

test('the sample project reads cleanly', () => {
  require('../js/sample.js');
  const m = parseProject(globalThis.ErdSample.files);
  assert.deepEqual(m.warnings, []);
  assert.equal(m.tables.length, 9);
  assert.equal(table(m, 'roles').rows.length, 3);
  assert.deepEqual(column(m, 'orders', 'status').enumValues, ['pending', 'paid', 'shipped', 'cancelled']);
  assert.deepEqual(column(m, 'products', 'category_id').fk, { table: 'categories', column: 'id' });
});
