# ERD Viewer

See a Postgres database as an entity relationship diagram by reading a project's `.sql` files. You don't need a database connection, a server or an install. It's a single web page that works on a computer or a phone.

- **Diagram:** every table with its columns, types, primary keys (PK) and foreign keys (FK). Lines join each foreign key to the table it points to, with a crow's foot on the "many" end. Drag tables to arrange them (the layout is remembered), and drag the background or pinch to pan and zoom.
- **Seed rows:** tables that the project fills with rows of its own (`INSERT` statements or `COPY` blocks in its `.sql` files) get an orange badge. The **Seed rows** filter lists only those tables. Click one to see the rows and the files they come from.
- **Details:** click a table to see its columns, defaults, enum values, comments, relationships, keys and indexes.

Your files are read in the browser and never uploaded.

## Using it

Open `index.html` (or the hosted copy), then:

- **On a computer:** choose **Open → Choose a project folder**. Every `.sql` file in it is read, skipping `node_modules` and hidden folders. In Chrome and Edge, **Reload** re-reads the folder after you change a migration.
- **On a phone:** choose **Open → Choose .sql files** and select them from Files, OneDrive, Google Drive or another app.

The last project you opened is remembered on that device.

### Which files are read, and in what order

Files are read in name order, with numbers sorted naturally (`2_x.sql` before `10_x.sql`), so numbered or timestamped migrations run in sequence. **Files** in the top bar lists them. Untick a file to leave it out. Down and rollback migrations start unticked.

Schema statements run first, file by file. Seed rows are read after that, against the finished schema, so a seed folder that sorts before the migrations still works.

### What it understands

`CREATE TABLE` (column and table constraints), `ALTER TABLE` (add, drop, rename, alter column, add/drop constraint, rename table), `DROP TABLE`, `CREATE [UNIQUE] INDEX`, `DROP INDEX`, `CREATE TYPE … AS ENUM`, `ALTER TYPE … ADD VALUE`, `COMMENT ON`, `INSERT … VALUES`, and `pg_dump`'s `COPY … FROM stdin`. Quoted names, schemas, Drizzle's `--> statement-breakpoint` and `DO $$ … $$` blocks, and Prisma migrations also work.

Anything it can't show (for example an `INSERT … SELECT`, or a table altered before it's created) is listed under **Files**, and the rest of the diagram still loads.

## Development

Requires Node.js 20 or newer, only for the tests and the local server. There are no dependencies.

```bash
npm start   # http://localhost:4000
npm test    # parser tests
```

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | The page (light and dark mode follow the device) |
| `js/parser.js` | Reads `.sql` text into tables, columns, keys, indexes and seed rows. Works in the browser and in Node. |
| `js/app.js` | Opening files, the diagram (SVG), the table list, the details panel |
| `js/sample.js` | The "Try the sample" project |
| `test/parser.test.js` | Parser tests (`node --test`) |
| `scripts/serve.js` | A tiny local server for `npm start` |
