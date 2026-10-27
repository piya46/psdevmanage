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
  console.log('Four isolated service databases are ready. Existing data and passwords retained.');
} finally {
  await admin.end();
}
