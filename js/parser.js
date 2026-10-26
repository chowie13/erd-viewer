/* Reads Postgres .sql files (CREATE/ALTER/DROP TABLE, indexes, enums, comments,
   INSERT and COPY seed rows) into a schema model for the ERD.
   Works in the browser (window.ErdParser) and in Node (require). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ErdParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- Tokens ----------

  function readQuoted(sql, i, backslashEscapes) {
    let v = '';
    i++; // opening quote
    while (i < sql.length) {
      const c = sql[i];
      if (c === "'") {
        if (sql[i + 1] === "'") { v += "'"; i += 2; continue; }
        return { value: v, end: i + 1 };
      }
      if (backslashEscapes && c === '\\' && i + 1 < sql.length) {
        const e = sql[i + 1];
        v += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
        i += 2;
        continue;
      }
      v += c;
      i++;
    }
    return { value: v, end: i };
  }

  function tokenize(sql) {
    const tokens = [];
    const n = sql.length;
    let i = 0;
    while (i < n) {
      const c = sql[i];
      const d = sql[i + 1];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '-' && d === '-') {
        const end = sql.indexOf('\n', i);
        i = end === -1 ? n : end + 1;
        continue;
      }
      if (c === '/' && d === '*') {
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
          else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
          else i++;
        }
        continue;
      }
      if ((c === 'E' || c === 'e') && d === "'") {
        const r = readQuoted(sql, i + 1, true);
        tokens.push({ t: 'string', v: r.value });
        i = r.end;
        continue;
      }
      if (c === "'") {
        const r = readQuoted(sql, i, false);
        tokens.push({ t: 'string', v: r.value });
        i = r.end;
        continue;
      }
      if (c === '"') {
        let v = '';
        i++;
        while (i < n) {
          if (sql[i] === '"') {
            if (sql[i + 1] === '"') { v += '"'; i += 2; continue; }
            i++;
            break;
          }
          v += sql[i++];
        }
        tokens.push({ t: 'ident', v });
        continue;
      }
      if (c === '$') {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
        if (m) {
          const tag = m[0];
          const end = sql.indexOf(tag, i + tag.length);
          tokens.push({ t: 'string', v: sql.slice(i + tag.length, end === -1 ? n : end), dollar: true });
          i = end === -1 ? n : end + tag.length;
          continue;
        }
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
        const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(sql.slice(i, i + 80));
        tokens.push({ t: 'number', v: m[0] });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_À-￿]/.test(c)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_$À-￿]/.test(sql[j])) j++;
        const v = sql.slice(i, j);
        tokens.push({ t: 'word', v, u: v.toUpperCase() });
        i = j;
        continue;
      }
      if (c === ':' && d === ':') { tokens.push({ t: 'punct', v: '::' }); i += 2; continue; }
      tokens.push({ t: 'punct', v: c });
      i++;
    }
    return tokens;
  }

  function splitStatements(tokens) {
    const out = [];
    let cur = [];
    for (const tk of tokens) {
      if (tk.t === 'punct' && tk.v === ';') {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push(tk);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  class Cursor {
    constructor(tokens) { this.toks = tokens; this.i = 0; }
    peek(o = 0) { return this.toks[this.i + o]; }
    done() { return this.i >= this.toks.length; }
    next() { return this.toks[this.i++]; }
    rest() { return this.toks.slice(this.i); }
    isWord(...words) {
      const t = this.peek();
      return !!t && t.t === 'word' && words.includes(t.u);
    }
    // Accepts a sequence of keywords, all or nothing.
    accept(...seq) {
      for (let k = 0; k < seq.length; k++) {
        const t = this.peek(k);
        if (!t || t.t !== 'word' || t.u !== seq[k]) return false;
      }
      this.i += seq.length;
      return true;
    }
    isPunct(v) {
      const t = this.peek();
      return !!t && t.t === 'punct' && t.v === v;
    }
    acceptPunct(v) {
      if (!this.isPunct(v)) return false;
      this.i++;
      return true;
    }
  }

  // Unquoted names fold to lower case in Postgres; quoted names keep their case.
  function identValue(t) {
    if (!t) return '';
    if (t.t === 'word') return t.v.toLowerCase();
    return t.v;
  }

  function readNameParts(cur) {
    const parts = [identValue(cur.next())];
    while (cur.isPunct('.')) {
      cur.next();
      parts.push(identValue(cur.next()));
    }
    return parts;
  }

  function readName(cur) {
    const parts = readNameParts(cur);
    return { schema: parts.length > 1 ? parts[parts.length - 2] : null, name: parts[parts.length - 1] };
  }

  function tableKey(name) {
    return name.schema && name.schema !== 'public' ? name.schema + '.' + name.name : name.name;
  }

  function readParenGroup(cur) {
    if (!cur.acceptPunct('(')) return [];
    const out = [];
    let depth = 1;
    while (!cur.done()) {
      const t = cur.next();
      if (t.t === 'punct' && t.v === '(') depth++;
      if (t.t === 'punct' && t.v === ')' && --depth === 0) break;
      out.push(t);
    }
    return out;
  }

  function splitTopLevel(tokens) {
    const parts = [[]];
    let depth = 0;
    for (const t of tokens) {
      if (t.t === 'punct' && (t.v === '(' || t.v === '[')) depth++;
      if (t.t === 'punct' && (t.v === ')' || t.v === ']')) depth--;
      if (depth === 0 && t.t === 'punct' && t.v === ',') parts.push([]);
      else parts[parts.length - 1].push(t);
    }
    return parts.filter((p) => p.length);
  }

  // Reads tokens until a keyword in `stops` at paren depth 0.
  function readUntil(cur, stops, minOne) {
    const out = [];
    let depth = 0;
    while (!cur.done()) {
      const t = cur.peek();
      if (depth === 0 && t.t === 'word' && stops.has(t.u) && (!minOne || out.length)) break;
      if (t.t === 'punct' && t.v === '(') depth++;
      if (t.t === 'punct' && t.v === ')') depth--;
      out.push(cur.next());
    }
    return out;
  }

  const SORT_WORDS = new Set(['ASC', 'DESC', 'NULLS', 'FIRST', 'LAST']);

  function readIdentList(cur) {
    return splitTopLevel(readParenGroup(cur)).map((el) => {
      if ((el[0].t === 'word' || el[0].t === 'ident') && el.slice(1).every((t) => t.t === 'word' && SORT_WORDS.has(t.u))) {
        return identValue(el[0]);
      }
      return render(el);
    });
  }

  function render(tokens, lowerWords) {
    let s = '';
    let prev = null;
    for (const t of tokens) {
      let text;
      if (t.t === 'string') text = "'" + t.v.replace(/'/g, "''") + "'";
      else if (t.t === 'ident') text = /^[a-z_][a-z0-9_]*$/.test(t.v) ? t.v : '"' + t.v.replace(/"/g, '""') + '"';
      else if (t.t === 'word' && lowerWords) text = t.v.toLowerCase();
      else text = t.v;
      const tightBefore = t.t === 'punct' && ([')', ',', '.', '::', '[', ']'].includes(t.v) || (t.v === '(' && prev && prev.t !== 'punct'));
      const tightAfterPrev = prev && prev.t === 'punct' && ['(', '.', '::', '['].includes(prev.v);
      if (s && !tightBefore && !tightAfterPrev) s += ' ';
      s += text;
      prev = t;
    }
    return s;
  }

  // ---------- Schema statements ----------

  function newTable(name, file) {
    return {
      key: tableKey(name),
      schema: name.schema || 'public',
      name: name.name,
      file,
      comment: null,
      columns: [],
      primaryKey: [],
      pkName: null,
      fks: [],
      uniques: [],
      indexes: [],
      rows: [],
      queryInserts: 0,
    };
  }

  const COLUMN_STOP = new Set(['CONSTRAINT', 'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'DEFAULT', 'CHECK', 'GENERATED', 'COLLATE']);
  const DEFAULT_STOP = new Set([...COLUMN_STOP, 'DEFERRABLE', 'INITIALLY']);

  function readAction(cur) {
    if (cur.accept('NO', 'ACTION')) return 'no action';
    if (cur.accept('SET', 'NULL')) { readParenGroup(cur); return 'set null'; }
    if (cur.accept('SET', 'DEFAULT')) { readParenGroup(cur); return 'set default'; }
    const t = cur.next();
    return t ? t.v.toLowerCase() : null;
  }

  function parseReferences(cur) {
    const ref = readName(cur);
    const out = { refTable: tableKey(ref), refColumns: cur.isPunct('(') ? readIdentList(cur) : null, onDelete: null, onUpdate: null };
    for (;;) {
      if (cur.accept('MATCH')) { cur.next(); continue; }
      if (cur.accept('ON', 'DELETE')) { out.onDelete = readAction(cur); continue; }
      if (cur.accept('ON', 'UPDATE')) { out.onUpdate = readAction(cur); continue; }
      break;
    }
    return out;
  }

  function parseColumnDef(cur, table) {
    const name = identValue(cur.next());
    const col = { name, type: render(readUntil(cur, COLUMN_STOP, false), true), notNull: false, unique: false, default: null, identity: false, generated: null, comment: null };
    if (/^(small|big)?serial$/.test(col.type)) col.identity = true;
    while (!cur.done()) {
      let cname = null;
      if (cur.accept('CONSTRAINT')) cname = identValue(cur.next());
      if (cur.accept('NOT', 'NULL')) col.notNull = true;
      else if (cur.accept('NULL')) col.notNull = false;
      else if (cur.accept('PRIMARY', 'KEY')) {
        table.primaryKey = [name];
        table.pkName = cname || table.name + '_pkey';
      } else if (cur.accept('UNIQUE')) {
        if (!cur.accept('NULLS', 'NOT', 'DISTINCT')) cur.accept('NULLS', 'DISTINCT');
        table.uniques.push({ name: cname || `${table.name}_${name}_key`, columns: [name] });
      } else if (cur.accept('REFERENCES')) {
        table.fks.push({ name: cname || `${table.name}_${name}_fkey`, columns: [name], ...parseReferences(cur) });
      } else if (cur.accept('DEFAULT')) {
        col.default = render(readUntil(cur, DEFAULT_STOP, true));
      } else if (cur.accept('CHECK')) {
        readParenGroup(cur);
        cur.accept('NO', 'INHERIT');
      } else if (cur.accept('GENERATED')) {
        if (!cur.accept('ALWAYS')) cur.accept('BY', 'DEFAULT');
        if (cur.accept('AS', 'IDENTITY')) {
          col.identity = true;
          readParenGroup(cur);
        } else if (cur.accept('AS')) {
          col.generated = render(readParenGroup(cur));
          if (!cur.accept('STORED')) cur.accept('VIRTUAL');
        }
      } else if (cur.accept('COLLATE')) {
        readName(cur);
      } else {
        cur.next(); // DEFERRABLE, INITIALLY ..., or anything we don't show
      }
    }
    return col;
  }

  // Returns true if the cursor held a table constraint (and it was applied).
  function parseTableConstraint(cur, table, cname) {
    if (cur.accept('PRIMARY', 'KEY')) {
      table.primaryKey = readIdentList(cur);
      table.pkName = cname || table.name + '_pkey';
      return true;
    }
    if (cur.accept('UNIQUE')) {
      if (!cur.accept('NULLS', 'NOT', 'DISTINCT')) cur.accept('NULLS', 'DISTINCT');
      if (cur.isPunct('(')) {
        const columns = readIdentList(cur);
        table.uniques.push({ name: cname || `${table.name}_${columns.join('_')}_key`, columns });
      }
      return true;
    }
    if (cur.accept('FOREIGN', 'KEY')) {
      const columns = readIdentList(cur);
      cur.accept('REFERENCES');
      table.fks.push({ name: cname || `${table.name}_${columns.join('_')}_fkey`, columns, ...parseReferences(cur) });
      return true;
    }
    return cur.accept('CHECK') || cur.accept('EXCLUDE');
  }

  function parseCreateTable(cur, ctx) {
    const ifNotExists = cur.accept('IF', 'NOT', 'EXISTS');
    const name = readName(cur);
    const key = tableKey(name);
    if (!cur.isPunct('(')) {
      ctx.warn(`Skipped CREATE TABLE ${key}: only tables with a column list are shown`);
      return;
    }
    if (ctx.tables.has(key)) {
      if (ifNotExists) return;
      ctx.warn(`Table ${key} is created again; the later definition is shown`);
    }
    const table = newTable(name, ctx.file);
    for (const el of splitTopLevel(readParenGroup(cur))) {
      const c = new Cursor(el);
      let cname = null;
      if (c.accept('CONSTRAINT')) cname = identValue(c.next());
      if (parseTableConstraint(c, table, cname)) continue;
      if (c.isWord('LIKE')) {
        ctx.warn(`Table ${key}: LIKE ... is not supported, so some columns may be missing`);
        continue;
      }
      table.columns.push(parseColumnDef(c, table));
    }
    ctx.tables.set(key, table);
  }

  function renameColumn(ctx, table, from, to) {
    const col = table.columns.find((c) => c.name === from);
    if (!col) return ctx.warn(`Rename in ${table.key}: column ${from} not found`);
    col.name = to;
    const swap = (list) => list.map((c) => (c === from ? to : c));
    table.primaryKey = swap(table.primaryKey);
    for (const fk of table.fks) fk.columns = swap(fk.columns);
    for (const u of table.uniques) u.columns = swap(u.columns);
    for (const ix of table.indexes) ix.columns = swap(ix.columns);
    for (const other of ctx.tables.values()) {
      for (const fk of other.fks) if (fk.refTable === table.key && fk.refColumns) fk.refColumns = swap(fk.refColumns);
    }
  }

  function renameTable(ctx, table, newName) {
    const oldKey = table.key;
    table.name = newName;
    table.key = tableKey({ schema: table.schema, name: newName });
    ctx.tables.delete(oldKey);
    ctx.tables.set(table.key, table);
    for (const other of ctx.tables.values()) {
      for (const fk of other.fks) if (fk.refTable === oldKey) fk.refTable = table.key;
    }
  }

  function dropColumn(table, name) {
    table.columns = table.columns.filter((c) => c.name !== name);
    table.primaryKey = table.primaryKey.filter((c) => c !== name);
    table.fks = table.fks.filter((fk) => !fk.columns.includes(name));
    table.uniques = table.uniques.filter((u) => !u.columns.includes(name));
    table.indexes = table.indexes.filter((ix) => !ix.columns.includes(name));
  }

  function dropConstraint(table, name) {
    table.fks = table.fks.filter((fk) => fk.name !== name);
    table.uniques = table.uniques.filter((u) => u.name !== name);
    if (table.pkName === name) {
      table.primaryKey = [];
      table.pkName = null;
    }
  }

  function parseAlterTable(cur, ctx) {
    cur.accept('IF', 'EXISTS');
    cur.accept('ONLY');
    const key = tableKey(readName(cur));
    cur.acceptPunct('*');
    const table = ctx.tables.get(key);
    if (!table) return ctx.warn(`ALTER TABLE ${key}: table not found`);

    if (cur.accept('RENAME', 'TO')) return renameTable(ctx, table, identValue(cur.next()));
    if (cur.accept('RENAME', 'CONSTRAINT')) {
      const from = identValue(cur.next());
      cur.accept('TO');
      const to = identValue(cur.next());
      for (const c of [...table.fks, ...table.uniques]) if (c.name === from) c.name = to;
      if (table.pkName === from) table.pkName = to;
      return;
    }
    if (cur.accept('RENAME')) {
      cur.accept('COLUMN');
      const from = identValue(cur.next());
      cur.accept('TO');
      return renameColumn(ctx, table, from, identValue(cur.next()));
    }

    for (const action of splitTopLevel(cur.rest())) {
      const c = new Cursor(action);
      if (c.accept('ADD')) {
        let cname = null;
        if (c.accept('CONSTRAINT')) cname = identValue(c.next());
        if (parseTableConstraint(c, table, cname)) continue;
        c.accept('COLUMN');
        const ifNotExists = c.accept('IF', 'NOT', 'EXISTS');
        const col = parseColumnDef(c, table);
        if (table.columns.some((x) => x.name === col.name)) {
          if (!ifNotExists) ctx.warn(`ALTER TABLE ${key}: column ${col.name} already exists`);
          continue;
        }
        table.columns.push(col);
      } else if (c.accept('DROP')) {
        if (c.accept('CONSTRAINT')) {
          c.accept('IF', 'EXISTS');
          dropConstraint(table, identValue(c.next()));
        } else {
          c.accept('COLUMN');
          c.accept('IF', 'EXISTS');
          dropColumn(table, identValue(c.next()));
        }
      } else if (c.accept('ALTER')) {
        c.accept('COLUMN');
        const colName = identValue(c.next());
        const col = table.columns.find((x) => x.name === colName);
        if (!col) continue;
        if (c.accept('SET', 'NOT', 'NULL')) col.notNull = true;
        else if (c.accept('DROP', 'NOT', 'NULL')) col.notNull = false;
        else if (c.accept('SET', 'DEFAULT')) col.default = render(c.rest());
        else if (c.accept('DROP', 'DEFAULT')) col.default = null;
        else if (c.accept('SET', 'DATA', 'TYPE') || c.accept('TYPE')) col.type = render(readUntil(c, new Set(['USING', 'COLLATE']), false), true);
        else if (c.accept('ADD', 'GENERATED')) col.identity = true;
        else if (c.accept('DROP', 'IDENTITY')) col.identity = false;
      }
      // OWNER TO, ENABLE ROW LEVEL SECURITY and the like don't change the diagram.
    }
  }

  function parseDropTable(cur, ctx) {
    cur.accept('IF', 'EXISTS');
    for (const part of splitTopLevel(cur.rest())) {
      const key = tableKey(readName(new Cursor(part)));
      ctx.tables.delete(key);
      for (const t of ctx.tables.values()) t.fks = t.fks.filter((fk) => fk.refTable !== key);
    }
  }

  function parseCreateIndex(cur, ctx, unique) {
    cur.accept('CONCURRENTLY');
    cur.accept('IF', 'NOT', 'EXISTS');
    const name = cur.isWord('ON') ? null : readName(cur).name;
    if (!cur.accept('ON')) return;
    cur.accept('ONLY');
    const key = tableKey(readName(cur));
    const table = ctx.tables.get(key);
    if (!table) return ctx.warn(`CREATE INDEX ${name || ''} ON ${key}: table not found`);
    if (cur.accept('USING')) cur.next();
    const columns = readIdentList(cur);
    const rest = cur.rest();
    const whereAt = rest.findIndex((t) => t.t === 'word' && t.u === 'WHERE');
    table.indexes.push({ name: name || `${table.name}_${columns.join('_')}_idx`, columns, unique, where: whereAt === -1 ? null : render(rest.slice(whereAt + 1)) });
  }

  function parseDropIndex(cur, ctx) {
    cur.accept('CONCURRENTLY');
    cur.accept('IF', 'EXISTS');
    for (const part of splitTopLevel(cur.rest())) {
      const name = readName(new Cursor(part)).name;
      for (const t of ctx.tables.values()) t.indexes = t.indexes.filter((ix) => ix.name !== name);
    }
  }

  function parseCreateType(cur, ctx) {
    const key = tableKey(readName(cur));
    if (!cur.accept('AS', 'ENUM')) return;
    ctx.enums.set(key, readParenGroup(cur).filter((t) => t.t === 'string').map((t) => t.v));
  }

  function parseAlterType(cur, ctx) {
    const key = tableKey(readName(cur));
    const values = ctx.enums.get(key);
    if (!values) return;
    if (cur.accept('ADD', 'VALUE')) {
      cur.accept('IF', 'NOT', 'EXISTS');
      const v = cur.next();
      if (!v || v.t !== 'string' || values.includes(v.v)) return;
      if (cur.accept('BEFORE') || cur.accept('AFTER')) {
        const before = cur.toks[cur.i - 1].u === 'BEFORE';
        const at = values.indexOf((cur.next() || {}).v);
        if (at !== -1) return values.splice(before ? at : at + 1, 0, v.v);
      }
      values.push(v.v);
    } else if (cur.accept('RENAME', 'VALUE')) {
      const from = cur.next();
      cur.accept('TO');
      const to = cur.next();
      const at = values.indexOf(from && from.v);
      if (at !== -1 && to) values[at] = to.v;
    }
  }

  function parseComment(cur, ctx) {
    let table = null;
    let column = null;
    if (cur.accept('TABLE')) {
      table = ctx.tables.get(tableKey(readName(cur)));
    } else if (cur.accept('COLUMN')) {
      const parts = readNameParts(cur);
      const colName = parts.pop();
      table = ctx.tables.get(tableKey({ schema: parts.length > 1 ? parts[parts.length - 2] : null, name: parts[parts.length - 1] }));
      column = table && table.columns.find((c) => c.name === colName);
      if (!column) return;
    } else return;
    if (!table || !cur.accept('IS')) return;
    const v = cur.next();
    const text = v && v.t === 'string' ? v.v : null;
    if (column) column.comment = text;
    else table.comment = text;
  }

  // ---------- Seed rows ----------

  function literalValue(tokens) {
    const castAt = tokens.findIndex((t) => t.t === 'punct' && t.v === '::');
    const base = castAt > 0 ? tokens.slice(0, castAt) : tokens;
    if (base.length === 1) {
      const b = base[0];
      if (b.t === 'string') return b.v;
      if (b.t === 'number') return b.v.length > 15 ? b.v : Number(b.v);
      if (b.t === 'word' && b.u === 'NULL') return null;
      if (b.t === 'word' && b.u === 'TRUE') return true;
      if (b.t === 'word' && b.u === 'FALSE') return false;
    }
    if (base.length === 2 && base[0].t === 'punct' && base[0].v === '-' && base[1].t === 'number') return -Number(base[1].v);
    return { expr: render(tokens) };
  }

  function parseInsert(cur, ctx) {
    const key = tableKey(readName(cur));
    if (cur.accept('AS')) cur.next();
    const table = ctx.tables.get(key);
    let columns = cur.isPunct('(') ? readIdentList(cur) : null;
    if (!table) return ctx.warn(`INSERT INTO ${key}: table not found`);
    if (!columns) columns = table.columns.map((c) => c.name);
    if (cur.accept('OVERRIDING')) { cur.next(); cur.accept('VALUE'); }
    if (cur.accept('DEFAULT', 'VALUES')) {
      table.rows.push({ file: ctx.file, values: {} });
      return;
    }
    if (!cur.accept('VALUES')) {
      table.queryInserts++;
      return ctx.warn(`INSERT INTO ${key} copies rows from a query, so they can't be listed`);
    }
    while (cur.isPunct('(')) {
      const values = splitTopLevel(readParenGroup(cur)).map(literalValue);
      const row = {};
      columns.forEach((c, i) => { if (i < values.length) row[c] = values[i]; });
      table.rows.push({ file: ctx.file, values: row });
      if (!cur.acceptPunct(',')) break;
    }
  }

  // pg_dump writes data as COPY ... FROM stdin; followed by tab-separated lines and "\.".
  // Those lines aren't SQL, so they are taken out before tokenizing.
  function extractCopyBlocks(text) {
    const lines = text.split(/\r?\n/);
    const kept = [];
    const copies = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*COPY\s+([^\s(]+)\s*(?:\(([^)]*)\))?\s*FROM\s+stdin\b[^;]*;\s*$/i.exec(lines[i]);
      if (!m) { kept.push(lines[i]); continue; }
      const rows = [];
      while (++i < lines.length && lines[i] !== '\\.') {
        rows.push(lines[i].split('\t').map((v) => (v === '\\N' ? null : v.replace(/\\(.)/g, (_, e) => (e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e)))));
      }
      copies.push({ target: m[1], columns: m[2] || null, rows });
    }
    return { text: kept.join('\n'), copies };
  }

  function applyCopy(copy, ctx) {
    const key = tableKey(readName(new Cursor(tokenize(copy.target))));
    const table = ctx.tables.get(key);
    if (!table) return ctx.warn(`COPY ${key}: table not found`);
    const columns = copy.columns ? splitTopLevel(tokenize(copy.columns)).map((p) => identValue(p[0])) : table.columns.map((c) => c.name);
    for (const values of copy.rows) {
      const row = {};
      columns.forEach((c, i) => { if (i < values.length) row[c] = values[i]; });
      table.rows.push({ file: ctx.file, values: row });
    }
  }

  // ---------- Project ----------

  function handleStatement(toks, ctx) {
    const cur = new Cursor(toks);
    while (cur.accept('BEGIN')); // statements inside DO $$ BEGIN ... END $$ blocks
    if (cur.isWord('INSERT')) {
      ctx.deferred.push({ file: ctx.file, toks: cur.rest() });
      return;
    }
    if (cur.accept('DO')) {
      const body = cur.rest().find((t) => t.t === 'string');
      if (body) for (const st of splitStatements(tokenize(body.v))) handleStatement(st, ctx);
      return;
    }
    if (cur.accept('CREATE')) {
      cur.accept('OR', 'REPLACE');
      if (!cur.accept('GLOBAL')) cur.accept('LOCAL');
      if (!cur.accept('TEMPORARY') && !cur.accept('TEMP')) cur.accept('UNLOGGED');
      if (cur.accept('TABLE')) return parseCreateTable(cur, ctx);
      if (cur.accept('UNIQUE', 'INDEX')) return parseCreateIndex(cur, ctx, true);
      if (cur.accept('INDEX')) return parseCreateIndex(cur, ctx, false);
      if (cur.accept('TYPE')) return parseCreateType(cur, ctx);
      return;
    }
    if (cur.accept('ALTER', 'TABLE')) return parseAlterTable(cur, ctx);
    if (cur.accept('ALTER', 'TYPE')) return parseAlterType(cur, ctx);
    if (cur.accept('DROP', 'TABLE')) return parseDropTable(cur, ctx);
    if (cur.accept('DROP', 'INDEX')) return parseDropIndex(cur, ctx);
    if (cur.accept('DROP', 'TYPE')) {
      cur.accept('IF', 'EXISTS');
      for (const part of splitTopLevel(cur.rest())) ctx.enums.delete(tableKey(readName(new Cursor(part))));
      return;
    }
    if (cur.accept('COMMENT', 'ON')) return parseComment(cur, ctx);
  }

  function safely(ctx, toks, fn) {
    try {
      fn();
    } catch (e) {
      ctx.warn('Could not read: ' + render(toks.slice(0, 8)) + ' …');
    }
  }

  function finalize(ctx) {
    const tables = [...ctx.tables.values()];
    for (const t of tables) t.referencedBy = [];
    for (const t of tables) {
      for (const col of t.columns) {
        col.type = col.type.replace(/^public\./, '');
        col.pk = t.primaryKey.includes(col.name);
        if (col.pk) col.notNull = true;
        col.unique =
          t.uniques.some((u) => u.columns.length === 1 && u.columns[0] === col.name) ||
          t.indexes.some((ix) => ix.unique && !ix.where && ix.columns.length === 1 && ix.columns[0] === col.name);
        const values = ctx.enums.get(col.type.replace(/\[\]$/, ''));
        col.enumValues = values ? values.slice() : null;
        col.fk = null;
      }
      for (const fk of t.fks) {
        const parent = ctx.tables.get(fk.refTable);
        fk.missing = !parent;
        if (!fk.refColumns) fk.refColumns = parent ? parent.primaryKey.slice() : [];
        if (parent) parent.referencedBy.push({ table: t.key, name: fk.name, columns: fk.columns, refColumns: fk.refColumns });
        fk.columns.forEach((name, i) => {
          const col = t.columns.find((c) => c.name === name);
          if (col && !col.fk) col.fk = { table: fk.refTable, column: fk.refColumns[i] || null };
        });
      }
    }
    return { tables, enums: Object.fromEntries(ctx.enums), warnings: ctx.warnings };
  }

  // files: [{ path, text }] in the order they should run (see sortFiles).
  // Schema statements run first, file by file. Seed rows (INSERT, COPY) are read
  // afterwards against the finished schema, so a seed folder that sorts before the
  // migrations still works.
  function parseProject(files) {
    const ctx = {
      tables: new Map(),
      enums: new Map(),
      warnings: [],
      deferred: [],
      file: null,
      warn(message) { this.warnings.push({ file: this.file, message }); },
    };
    const copies = [];
    for (const f of files) {
      ctx.file = f.path;
      const extracted = extractCopyBlocks(f.text);
      for (const cp of extracted.copies) copies.push({ file: f.path, copy: cp });
      for (const st of splitStatements(tokenize(extracted.text))) safely(ctx, st, () => handleStatement(st, ctx));
    }
    for (const d of ctx.deferred) {
      ctx.file = d.file;
      safely(ctx, d.toks, () => {
        const cur = new Cursor(d.toks);
        cur.accept('INSERT', 'INTO');
        parseInsert(cur, ctx);
      });
    }
    for (const c of copies) {
      ctx.file = c.file;
      safely(ctx, [], () => applyCopy(c.copy, ctx));
    }
    return finalize(ctx);
  }

  function isSqlPath(path) {
    return /\.sql$/i.test(path) && !/(^|\/)(node_modules|\.git)\//.test(path);
  }

  // Down/rollback migrations would undo the schema, so they start switched off.
  function isDownMigration(path) {
    return /(^|[/._-])down\.sql$/i.test(path) || /(^|\/)(down|rollback)\//i.test(path) || /rollback/i.test(path.split('/').pop());
  }

  function sortFiles(files) {
    return files.slice().sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  }

  return { parseProject, sortFiles, isSqlPath, isDownMigration, tokenize };
});
