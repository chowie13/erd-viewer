# ERD Viewer

See a Postgres database as an entity relationship diagram by reading a project's `.sql` files. You don't need a database connection, a server or an install. It's a single web page that works on a computer or a phone.

- **Diagram:** every table with its columns, types, primary keys (PK) and foreign keys (FK). Lines join each foreign key to the table it points to, with a crow's foot on the "many" end. Drag tables to arrange them (the layout is remembered), and drag the background or pinch to pan and zoom.
- **Seed rows:** tables that the project fills with rows of its own (`INSERT` statements or `COPY` blocks in its `.sql` files) get an orange badge. The **Seed rows** filter lists only those tables. Click one to see the rows and the files they come from.
- **Details:** click a table to see its columns, defaults, enum values, comments, relationships, keys and indexes.

Your files are read in the browser and never uploaded.

**Open it:** https://chowie13.github.io/erd-viewer/ (GitHub Pages, rebuilt from `main` on every push)

## Using it

Open the site link above (or `index.html` locally), then:

- **On a computer:** choose **Open → Choose a project folder**. Every `.sql` file in it is read, skipping `node_modules` and hidden folders. In Chrome and Edge, **Reload** re-reads the folder after you change a migration.
- **On a phone:** choose **Open → Choose .sql files** and select them from Files, OneDrive, Google Drive or another app.
- **From GitHub (any device):** choose **Open → Open from GitHub** and paste a repo link, or a folder link copied from GitHub's address bar, such as `github.com/owner/repo/tree/main/db/migrations`. **Reload** fetches the latest pushed files.

The last project you opened is remembered on that device.

### GitHub repos

- **Public repos** need nothing else.
- **Private repos** need a personal access token. Make a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **Only select repositories** (pick the repos you want to view) and **Contents: Read-only**, then paste it into the Open from GitHub dialog. It's sent only to GitHub. If you tick **Remember it on this device**, it's kept in that browser until you click **Forget it**.
- The address bar then shows a link like `…/erd-viewer/?github=github.com/owner/repo/tree/main/db`. Bookmark it, or add it to your phone's home screen, and it opens that folder with the latest files every time. On a new device, the first visit to a private repo link asks for the token.

A remembered token is stored in the browser for `chowie13.github.io`, which every GitHub Pages site on this account shares. So keep it read-only and limited to the repos you need, and give it an expiry date.

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
npm test    # all tests
```

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | The page (light and dark mode follow the device) |
| `js/parser.js` | Reads `.sql` text into tables, columns, keys, indexes and seed rows. Works in the browser and in Node. |
| `js/github.js` | Fetches a repo folder's `.sql` files from GitHub (public, or private with a token). Works in the browser and in Node. |
| `js/app.js` | Opening files, the diagram (SVG), the table list, the details panel |
| `js/sample.js` | The "Try the sample" project |
| `test/parser.test.js`, `test/github.test.js` | Tests (`node --test`); the GitHub tests use a fake GitHub, so they run offline |
| `scripts/serve.js` | A tiny local server for `npm start` |
