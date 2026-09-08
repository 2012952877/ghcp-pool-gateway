import type Database from 'better-sqlite3';

const COPILOT_OAUTH_MIGRATION = '2026-07-23-copilot-oauth-direct';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  migrateCopilotOauthCredentials(db);
  createProxyAccountsTable(db);
  addColumnIfMissing(db, 'proxy_accounts', 'copilot_oauth_attempt_id', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_request_stats (
      id TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      gh_login TEXT,
      requested_at TEXT NOT NULL,
      path TEXT NOT NULL,
      model TEXT,
      success INTEGER NOT NULL,
      failure_reason TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_tokens INTEGER,
      cache_input_tokens INTEGER,
      cache_write_tokens INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_proxy_request_stats_identity_time
      ON proxy_request_stats(identity, requested_at DESC);
  `);
  addColumnIfMissing(db, 'proxy_request_stats', 'cache_input_tokens', 'INTEGER');
  addColumnIfMissing(db, 'proxy_request_stats', 'cache_write_tokens', 'INTEGER');
  copyLegacyCacheReadTokens(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_identity_initializations (
      identity TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_proxy_identity_initializations_lease
      ON proxy_identity_initializations(lease_expires_at);
  `);
  createPoolTables(db);
}

/**
 * 账号池表 —— 纯新增，proxy_accounts 保持原样。
 * 1:1 模式下这三张表始终为空，行为与改造前完全一致。
 */
function createPoolTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_pools (
      pool_id TEXT PRIMARY KEY,
      strategy TEXT NOT NULL DEFAULT 'sticky-affinity',
      session_ttl_seconds INTEGER NOT NULL DEFAULT 1800,
      cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      failure_threshold INTEGER NOT NULL DEFAULT 3,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proxy_pool_members (
      pool_id TEXT NOT NULL,
      identity TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'active',
      cooling_until TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (pool_id, identity)
    );

    CREATE INDEX IF NOT EXISTS idx_proxy_pool_members_state
      ON proxy_pool_members(pool_id, state);
    CREATE INDEX IF NOT EXISTS idx_proxy_pool_members_identity
      ON proxy_pool_members(identity);

    CREATE TABLE IF NOT EXISTS proxy_session_affinity (
      session_key TEXT NOT NULL,
      pool_id TEXT NOT NULL,
      identity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (session_key, pool_id)
    );

    CREATE INDEX IF NOT EXISTS idx_proxy_session_affinity_expires
      ON proxy_session_affinity(expires_at);
    CREATE INDEX IF NOT EXISTS idx_proxy_session_affinity_member
      ON proxy_session_affinity(pool_id, identity);
  `);
  addColumnIfMissing(db, 'proxy_request_stats', 'pool_id', 'TEXT');
}

function migrateCopilotOauthCredentials(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(COPILOT_OAUTH_MIGRATION);
  const columns = tableColumns(db, 'proxy_accounts');
  const hasFinalSchema = columns.has('copilot_oauth_token')
    && columns.has('copilot_oauth_status')
    && columns.has('copilot_oauth_updated_at');

  if (applied) {
    if (columns.size > 0 && !hasFinalSchema) {
      throw new Error(`Migration "${COPILOT_OAUTH_MIGRATION}" is recorded but proxy_accounts still uses the legacy schema.`);
    }
    return;
  }

  db.transaction(() => {
    if (columns.size === 0) {
      createProxyAccountsTable(db);
    } else if (!hasFinalSchema) {
      const required = ['identity', 'sso_user', 'gh_login', 'created_at', 'updated_at'];
      const missing = required.filter((column) => !columns.has(column));
      if (missing.length > 0) {
        throw new Error(`Cannot migrate proxy_accounts; missing legacy column(s): ${missing.join(', ')}.`);
      }
      db.exec('DROP TABLE IF EXISTS proxy_accounts_oauth_next');
      createProxyAccountsTable(db, 'proxy_accounts_oauth_next');
      db.prepare(`
        INSERT INTO proxy_accounts_oauth_next (
          identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
          copilot_oauth_updated_at, created_at, updated_at
        )
        SELECT identity, sso_user, gh_login, NULL, 'missing', NULL, created_at, ?
        FROM proxy_accounts
      `).run(new Date().toISOString());
      db.exec(`
        DROP TABLE proxy_accounts;
        ALTER TABLE proxy_accounts_oauth_next RENAME TO proxy_accounts;
      `);
    }
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run(COPILOT_OAUTH_MIGRATION, new Date().toISOString());
  })();
}

function createProxyAccountsTable(db: Database.Database, table = 'proxy_accounts'): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      identity TEXT PRIMARY KEY,
      sso_user TEXT NOT NULL,
      gh_login TEXT,
      copilot_oauth_token TEXT,
      copilot_oauth_status TEXT NOT NULL DEFAULT 'missing',
      copilot_oauth_updated_at TEXT,
      copilot_oauth_attempt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  if (tableColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function copyLegacyCacheReadTokens(db: Database.Database): void {
  const names = tableColumns(db, 'proxy_request_stats');
  if (!names.has('cache_read_tokens') || !names.has('cache_input_tokens')) return;
  db.exec(`
    UPDATE proxy_request_stats
    SET cache_input_tokens = cache_read_tokens
    WHERE cache_input_tokens IS NULL
      AND cache_read_tokens IS NOT NULL
  `);
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}
