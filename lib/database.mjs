import pg from 'pg';
export class HttpError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export class Database {
  constructor(connectionString) {
    this.pool = new pg.Pool({
      connectionString,
      max: 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    this.pool.on('error', () => {});
  }
  async connect() {
    const result = await this.pool.query(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    if (!result.rowCount || result.rows[0].rolsuper || result.rows[0].rolbypassrls)
      throw new Error(
        'The application database role must not be a superuser or bypass row policies.',
      );
    return this;
  }
  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async session(hash, work) {
    return this.transaction(async (client) => {
      const result = await client.query('SELECT cam.use_session($1) AS principal', [hash]);
      const principal = result.rows[0]?.principal;
      if (!principal)
        throw new HttpError('Sign into this workspace again.', 401, 'viewer-auth-required');
      return work(client, principal);
    });
  }
  close() {
    return this.pool.end();
  }
}
