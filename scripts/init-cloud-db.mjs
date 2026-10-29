import { Pool } from 'pg';
import { readFileSync } from 'node:fs';

const passwords = JSON.parse(readFileSync(process.env.PSTON_DB_BOOTSTRAP_FILE, 'utf8'));
const admin = new Pool({
  host: process.env.PGHOST,
  user: 'postgres',
  database: 'postgres',
  password: passwords.postgres,
  max: 1,
});
const identifier = (value) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
try {
  for (const service of ['identity', 'documents', 'signing', 'audit']) {
    const name = 'pston_' + service;
    const password = passwords[service];
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(password)) throw new Error('Invalid bootstrap credential');
    const role = await admin.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [name]);
    if (!role.rows.length)
      await admin.query(
        `CREATE ROLE ${identifier(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD ${literal(password)}`,
      );
    // Managed PostgreSQL's administrator is not a true superuser. PostgreSQL 17
    // requires SET membership to create a database owned by another role, and
    // INHERIT membership lets this bootstrap administrator manage its ACLs.
    // Membership flows from each service role to the administrator, never back.
    await admin.query(`GRANT ${identifier(name)} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
    const db = await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name]);
    if (!db.rows.length)
      await admin.query(`CREATE DATABASE ${identifier(name)} OWNER ${identifier(name)}`);
    await admin.query(`REVOKE CONNECT,TEMPORARY ON DATABASE ${identifier(name)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${identifier(name)} TO ${identifier(name)}`);
    const scoped = new Pool({
      host: process.env.PGHOST,
      user: 'postgres',
      database: name,
      password: passwords.postgres,
      max: 1,
    });
    try {
      await scoped.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await scoped.query(`GRANT USAGE,CREATE ON SCHEMA public TO ${identifier(name)}`);
    } finally {
      await scoped.end();
    }
  }
  const names = ['identity', 'documents', 'signing', 'audit'].map((service) => `pston_${service}`);
  const access = await admin.query(
    `SELECT r.rolname, d.datname, has_database_privilege(r.oid, d.oid, 'CONNECT') AS allowed
     FROM pg_roles r CROSS JOIN pg_database d
     WHERE r.rolname = ANY($1::text[]) AND d.datname = ANY($1::text[])`,
    [names],
  );
  if (
    access.rows.length !== names.length ** 2 ||
    access.rows.some((row) => row.allowed !== (row.rolname === row.datname))
  )
    throw new Error('Service database isolation check failed; review database grants');
  console.log('Four isolated service databases are ready. Existing data and passwords retained.');
} finally {
  await admin.end();
}
