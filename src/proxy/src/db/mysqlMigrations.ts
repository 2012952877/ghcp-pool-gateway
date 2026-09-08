import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

const MIGRATION_LOCK = 'ghcp_proxy_schema_migrations';
const INITIAL_SCHEMA_MIGRATION = '2026-08-27-proxy-mysql-initial';
const TOKEN_COLLATION_MIGRATION = '2026-08-27-proxy-token-binary-collation';

export async function runMysqlMigrations(pool: Pool): Promise<void> {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [lockRows] = await connection.query<Array<RowDataPacket & { acquired: number | null }>>(
      'SELECT GET_LOCK(?, 30) AS acquired',
      [MIGRATION_LOCK],
    );
    locked = lockRows[0]?.acquired === 1;
    if (!locked) throw new Error('Timed out waiting for the Proxy MySQL schema migration lock.');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(191) COLLATE utf8mb4_bin PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS proxy_accounts (
        identity VARCHAR(255) COLLATE utf8mb4_bin PRIMARY KEY,
        sso_user VARCHAR(255) NOT NULL,
        gh_login VARCHAR(255),
        copilot_oauth_token TEXT COLLATE utf8mb4_bin,
        copilot_oauth_status VARCHAR(32) NOT NULL DEFAULT 'missing',
        copilot_oauth_updated_at DATETIME(3),
        copilot_oauth_attempt_id CHAR(36) COLLATE ascii_bin,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        INDEX idx_proxy_accounts_sso_user (sso_user),
        INDEX idx_proxy_accounts_updated_at (updated_at)
      ) ENGINE=InnoDB
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS proxy_request_stats (
        id VARCHAR(64) COLLATE ascii_bin PRIMARY KEY,
        identity VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
        gh_login VARCHAR(255),
        requested_at DATETIME(3) NOT NULL,
        path VARCHAR(128) NOT NULL,
        model VARCHAR(255),
        success TINYINT(1) NOT NULL,
        failure_reason TEXT,
        input_tokens BIGINT,
        output_tokens BIGINT,
        cache_tokens BIGINT,
        cache_input_tokens BIGINT,
        cache_write_tokens BIGINT,
        INDEX idx_proxy_request_stats_identity_time (identity, requested_at DESC, id DESC),
        INDEX idx_proxy_request_stats_time (requested_at DESC, id DESC)
      ) ENGINE=InnoDB
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS proxy_identity_initializations (
        identity VARCHAR(255) COLLATE utf8mb4_bin PRIMARY KEY,
        claim_id CHAR(36) COLLATE ascii_bin NOT NULL,
        lease_expires_at DATETIME(3) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        INDEX idx_proxy_identity_initializations_lease (lease_expires_at)
      ) ENGINE=InnoDB
    `);
    // ── 账号池（Account Pool）—— 纯新增，不改动 proxy_accounts ──
    // 设计：pool 是叠在 identity 之上的一层。1:1 模式的表和行为完全不受影响。
    await connection.query(`
      CREATE TABLE IF NOT EXISTS proxy_pools (
        pool_id VARCHAR(255) COLLATE utf8mb4_bin PRIMARY KEY,
        strategy VARCHAR(32) NOT NULL DEFAULT 'sticky-affinity',
        session_ttl_seconds INT NOT NULL DEFAULT 1800,
        cooldown_seconds INT NOT NULL DEFAULT 300,
        failure_threshold INT NOT NULL DEFAULT 3,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS proxy_pool_members (
        pool_id VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
        identity VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
        weight INT NOT NULL DEFAULT 1,
        state VARCHAR(32) NOT NULL DEFAULT 'active',
        cooling_until DATETIME(3),
        consecutive_failures INT NOT NULL DEFAULT 0,
        last_used_at DATETIME(3),
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY (pool_id, identity),
        INDEX idx_proxy_pool_members_state (pool_id, state),
        INDEX idx_proxy_pool_members_identity (identity)
      ) ENGINE=InnoDB
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS proxy_session_affinity (
        session_key CHAR(64) COLLATE ascii_bin NOT NULL,
        pool_id VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
        identity VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
        created_at DATETIME(3) NOT NULL,
        last_used_at DATETIME(3) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        PRIMARY KEY (session_key, pool_id),
        INDEX idx_proxy_session_affinity_expires (expires_at),
        INDEX idx_proxy_session_affinity_member (pool_id, identity)
      ) ENGINE=InnoDB
    `);
    // 请求统计加 pool_id：池模式下要能看出「哪个账号承担了多少」
    await addColumnIfMissing(connection, 'proxy_request_stats', 'pool_id', 'VARCHAR(255) COLLATE utf8mb4_bin');
    await connection.execute(
      `INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))`,
      [INITIAL_SCHEMA_MIGRATION],
    );
    const [tokenMigrationRows] = await connection.execute<RowDataPacket[]>(
      'SELECT 1 FROM schema_migrations WHERE id = ?',
      [TOKEN_COLLATION_MIGRATION],
    );
    if (tokenMigrationRows.length === 0) {
      await connection.query(`
        ALTER TABLE proxy_accounts
        MODIFY copilot_oauth_token TEXT COLLATE utf8mb4_bin
      `);
      await connection.execute(
        'INSERT INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))',
        [TOKEN_COLLATION_MIGRATION],
      );
    }
  } finally {
    if (locked) {
      await connection.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK]);
    }
    connection.release();
  }
}

/**
 * 幂等地补列。用 information_schema 判断而不是 catch 异常，
 * 避免把真正的错误吞掉。
 */
async function addColumnIfMissing(
  connection: PoolConnection,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (rows.length > 0) return;
  await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}
