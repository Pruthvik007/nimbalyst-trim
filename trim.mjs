import { PGlite } from '@electric-sql/pglite';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const TRIM_BACKUPS_KEPT = 2;
const DEFAULT_DATA_DIR = join(homedir(), 'Library/Application Support/nimbalyst-trim');

const USAGE = `usage: node trim.mjs <command>

  trim [keep]        the whole pass, for every run: one backup, hide, archive,
                     vacuum, then the after-care below
  hide [keep]        hide every message older than the last <keep> user prompts
                     of each session (default 20); ids added to hidden-ids.json
  restore            unhide exactly the messages listed in hidden-ids.json
  archive            move the messages hidden by hide into trim_archived_messages, so
                     opening a session no longer reads them
  unarchive          move every row in trim_archived_messages back, still hidden
  vacuum             VACUUM FULL ai_sessions and ai_agent_messages to shrink the file
  sizes              print database and table sizes
  rollback [backup]  put a backup back in place of the database (default: latest
                     in backups/); the current database is kept beside it
  pin                keep Nimbalyst on PGlite: stop its automatic move to SQLite

Every command that writes first copies the database into backups/ and checks the copy.
After trim: older *-before-trim backups beyond the newest ${TRIM_BACKUPS_KEPT} are deleted, and Nimbalyst's
own backups are reset when the database fell under half their size (Nimbalyst rejects
such a backup forever otherwise).

Quit Nimbalyst first. NIMBALYST_DB overrides the database folder. hidden-ids.json and
backups/ live in NIMBALYST_TRIM_DATA (default: ${DEFAULT_DATA_DIR}).`;

const NIMBALYST_DIR = join(homedir(), 'Library/Application Support/@nimbalyst/electron');
const LIVE_DB = join(NIMBALYST_DIR, 'pglite-db');
const NIMBALYST_LICENSES = '/Applications/Nimbalyst.app/Contents/Resources/legal/THIRD_PARTY_LICENSES.json';
const dbPath = process.env.NIMBALYST_DB || LIVE_DB;
const appDataDir = dirname(dbPath);
const dataDir = process.env.NIMBALYST_TRIM_DATA || DEFAULT_DATA_DIR;
const idsFile = join(dataDir, 'hidden-ids.json');
const ARCHIVE_TABLE = 'trim_archived_messages';
const backupsDir = join(dataDir, 'backups');
const REQUIRED_COLUMNS = {
  ai_agent_messages: ['id', 'session_id', 'direction', 'hidden', 'content'],
  ai_tool_call_file_edits: ['message_id'],
  ai_sessions: ['id'],
};
const [command, arg] = process.argv.slice(2);

if (!command || command === '-h' || command === '--help') {
  console.log(USAGE);
  process.exit(0);
}
if (dbPath === LIVE_DB && isNimbalystRunning()) {
  console.error('Nimbalyst is running. Quit it first: PGlite allows one process at a time.');
  process.exit(1);
}

// pgrep cannot see other processes in a sandboxed shell, so read Nimbalyst's own lock file.
function isNimbalystRunning() {
  const lockFile = join(NIMBALYST_DIR, 'nimbalyst-db.pid');
  if (!existsSync(lockFile)) return false;
  const pid = Number(readFileSync(lockFile, 'utf8').split('\n')[0]);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// A database folder written by one PGlite version may not open cleanly in another.
function checkPgliteMatchesNimbalyst() {
  if (!existsSync(NIMBALYST_LICENSES)) {
    console.warn(`warning: ${NIMBALYST_LICENSES} not found; cannot check the PGlite version Nimbalyst ships`);
    return;
  }
  const shipped = readFileSync(NIMBALYST_LICENSES, 'utf8').match(/"@electric-sql\/pglite@([^"]+)"/)?.[1];
  // The package does not export package.json, so read the copy npm installed beside this script.
  const installedPackage = new URL('./node_modules/@electric-sql/pglite/package.json', import.meta.url);
  const installed = JSON.parse(readFileSync(installedPackage, 'utf8')).version;
  if (!shipped) {
    console.warn(`warning: no PGlite version in ${NIMBALYST_LICENSES}; cannot check it`);
  } else if (shipped !== installed) {
    console.error(`Nimbalyst ships PGlite ${shipped}, this folder has ${installed}. Run: npm i @electric-sql/pglite@${shipped}`);
    process.exit(1);
  }
}

async function checkSchema(db) {
  const { rows } = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_name = ANY($1)`,
    [Object.keys(REQUIRED_COLUMNS)]
  );
  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = Object.entries(REQUIRED_COLUMNS)
    .flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`))
    .filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`Nimbalyst's schema changed, missing: ${missing.join(', ')}. Nothing was changed.`);
  }
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function folderFilesAndBytes(folder) {
  const files = readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  const bytes = files.reduce((sum, entry) => sum + statSync(join(entry.parentPath, entry.name)).size, 0);
  return { files: files.length, bytes };
}

function copyAndCheck(sourceFolder, targetFolder) {
  cpSync(sourceFolder, targetFolder, { recursive: true });
  const source = folderFilesAndBytes(sourceFolder);
  const copy = folderFilesAndBytes(targetFolder);
  if (source.files !== copy.files || source.bytes !== copy.bytes) {
    throw new Error(`copy of ${sourceFolder} does not match: ${JSON.stringify({ source, copy })}`);
  }
  console.log(`copied ${source.files} files, ${(source.bytes / 1024 / 1024).toFixed(0)} MB to ${targetFolder}`);
}

function rollback(backupFolder) {
  const backups = existsSync(backupsDir) ? readdirSync(backupsDir).sort() : [];
  const source = backupFolder ?? (backups.length > 0 ? join(backupsDir, backups.at(-1)) : null);
  if (!source || !existsSync(source)) throw new Error('no backup to roll back to');
  const setAside = `${dbPath}.before-rollback-${timestamp()}`;
  renameSync(dbPath, setAside);
  console.log(`current database moved to ${setAside}`);
  copyAndCheck(source, dbPath);
}

async function printSizes(db) {
  const { rows } = await db.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS database,
    pg_size_pretty(pg_total_relation_size('ai_sessions')) AS ai_sessions,
    pg_size_pretty(pg_total_relation_size('ai_agent_messages')) AS ai_agent_messages,
    (SELECT count(*) FROM ai_agent_messages WHERE hidden) AS hidden_messages`);
  console.table([{ ...rows[0], archived_messages: await archivedCount(db) }]);
}

async function archivedCount(db) {
  const { rows } = await db.query(`SELECT to_regclass('${ARCHIVE_TABLE}') IS NOT NULL AS exists`);
  if (!rows[0].exists) return 0;
  return (await db.query(`SELECT count(*)::int AS n FROM ${ARCHIVE_TABLE}`)).rows[0].n;
}

async function archive(db) {
  const hiddenIds = Object.values(JSON.parse(readFileSync(idsFile, 'utf8'))).flat();
  await db.transaction(async (tx) => {
    await tx.exec(`CREATE TABLE IF NOT EXISTS ${ARCHIVE_TABLE} (LIKE ai_agent_messages INCLUDING DEFAULTS)`);
    // Kept in place: rows a file edit points at (the foreign key cascades on delete), and
    // tool results Nimbalyst reads back so it does not store them twice.
    const { rows } = await tx.query(
      `WITH moved AS (
         DELETE FROM ai_agent_messages m
         WHERE m.id = ANY($1::bigint[]) AND m.hidden
           AND NOT EXISTS (SELECT 1 FROM ai_tool_call_file_edits f WHERE f.message_id = m.id)
           AND m.content NOT LIKE '%nimbalyst_tool_result%'
         RETURNING m.*
       )
       INSERT INTO ${ARCHIVE_TABLE} SELECT * FROM moved RETURNING session_id`,
      [hiddenIds]
    );
    const movedBySession = {};
    for (const { session_id } of rows) movedBySession[session_id] = (movedBySession[session_id] ?? 0) + 1;
    for (const [sessionId, n] of Object.entries(movedBySession)) console.log(`${sessionId}: archived ${n}`);
  });
}

async function unarchive(db) {
  await db.transaction(async (tx) => {
    // Archive columns only, in case a Nimbalyst update adds columns to ai_agent_messages.
    const { rows: columns } = await tx.query(
      `SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS list
       FROM information_schema.columns WHERE table_name = $1`,
      [ARCHIVE_TABLE]
    );
    const { affectedRows } = await tx.query(
      `INSERT INTO ai_agent_messages (${columns[0].list}) SELECT ${columns[0].list} FROM ${ARCHIVE_TABLE}`
    );
    await tx.exec(`DROP TABLE ${ARCHIVE_TABLE}`);
    console.log(`moved back ${affectedRows}`);
  });
}

async function hide(db, keepPrompts) {
  // Cut at a user prompt so a tool call is never separated from its result.
  const { rows: cutoffs } = await db.query(
    `SELECT session_id, id AS cutoff_id FROM (
       SELECT session_id, id, row_number() OVER (PARTITION BY session_id ORDER BY id DESC) AS prompt_rank
       FROM ai_agent_messages WHERE direction = 'input' AND hidden = FALSE
     ) prompts WHERE prompt_rank = $1`,
    [keepPrompts]
  );
  // Earlier runs' ids stay in the file, so restore always unhides everything trim ever hid.
  const hiddenIdsBySession = existsSync(idsFile) ? JSON.parse(readFileSync(idsFile, 'utf8')) : {};
  await db.transaction(async (tx) => {
    for (const { session_id, cutoff_id } of cutoffs) {
      const { rows } = await tx.query(
        `UPDATE ai_agent_messages SET hidden = TRUE
         WHERE session_id = $1 AND id < $2 AND hidden = FALSE RETURNING id`,
        [session_id, cutoff_id]
      );
      if (rows.length === 0) continue;
      hiddenIdsBySession[session_id] = [...(hiddenIdsBySession[session_id] ?? []), ...rows.map((r) => r.id)];
      console.log(`${session_id}: hid ${rows.length}`);
    }
    // Written before the commit: a crash after it would leave hidden rows restore cannot find.
    writeFileSync(idsFile, JSON.stringify(hiddenIdsBySession));
  });
}

function pruneTrimBackups() {
  const trimBackups = readdirSync(backupsDir).filter((name) => name.endsWith('-before-trim')).sort();
  for (const name of trimBackups.slice(0, -TRIM_BACKUPS_KEPT)) {
    rmSync(join(backupsDir, name), { recursive: true });
    console.log(`deleted old backup ${name}`);
  }
}

// Nimbalyst rejects a new backup under half the size of its current one, so after a big
// shrink it would keep the old backup forever. Without its metadata it starts fresh.
function resetNimbalystBackupsIfTooLarge() {
  const nimbalystBackupsDir = join(appDataDir, 'db-backups');
  const metadataFile = join(nimbalystBackupsDir, 'backup-metadata.json');
  if (!existsSync(metadataFile)) return;
  const currentBackupBytes = JSON.parse(readFileSync(metadataFile, 'utf8')).currentBackup?.size ?? 0;
  const databaseBytes = folderFilesAndBytes(dbPath).bytes;
  if (databaseBytes >= currentBackupBytes / 2) return;
  for (const name of readdirSync(nimbalystBackupsDir).filter((n) => n.startsWith('pglite-db.backup-'))) {
    rmSync(join(nimbalystBackupsDir, name), { recursive: true });
  }
  rmSync(metadataFile);
  console.log(`reset Nimbalyst's backups (${(currentBackupBytes / 1024 / 1024).toFixed(0)} MB, database now ` +
    `${(databaseBytes / 1024 / 1024).toFixed(0)} MB); it takes a new one after launch`);
}

function readBackendState() {
  const backendFile = join(appDataDir, 'database-backend.json');
  return existsSync(backendFile) ? JSON.parse(readFileSync(backendFile, 'utf8')) : null;
}

// setBy "rollback" is what Nimbalyst writes after a rollback from SQLite; it then never
// starts the automatic move again.
function pinPglite() {
  const state = readBackendState();
  if (!state) throw new Error(`${join(appDataDir, 'database-backend.json')} not found`);
  if (state.setBy === 'rollback') {
    console.log('already pinned to PGlite');
    return;
  }
  state.backend = 'pglite';
  state.setBy = 'rollback';
  state.setAt = new Date().toISOString();
  writeFileSync(join(appDataDir, 'database-backend.json'), JSON.stringify(state, null, 2));
  console.log('pinned to PGlite in database-backend.json');
}

async function restore(db) {
  const hiddenIdsBySession = JSON.parse(readFileSync(idsFile, 'utf8'));
  await db.transaction(async (tx) => {
    for (const [sessionId, ids] of Object.entries(hiddenIdsBySession)) {
      const { affectedRows } = await tx.query(
        `UPDATE ai_agent_messages SET hidden = FALSE WHERE session_id = $1 AND id = ANY($2::bigint[])`,
        [sessionId, ids]
      );
      console.log(`${sessionId}: unhid ${affectedRows}`);
    }
  });
  rmSync(idsFile);
}

if (command === 'rollback') {
  rollback(arg);
  process.exit(0);
}
if (!['trim', 'hide', 'restore', 'archive', 'unarchive', 'vacuum', 'sizes', 'pin'].includes(command)) {
  console.error(USAGE);
  process.exit(1);
}
const keepPrompts = Number(arg ?? 20);
if (['trim', 'hide'].includes(command) && (!Number.isInteger(keepPrompts) || keepPrompts < 1)) {
  console.error('keep must be a positive integer');
  process.exit(1);
}
if (readBackendState()?.backend === 'sqlite') {
  console.error('Nimbalyst has switched to SQLite; pglite-db is no longer the live database.');
  process.exit(1);
}
if (command === 'pin') {
  pinPglite();
  process.exit(0);
}
if (['restore', 'archive'].includes(command) && !existsSync(idsFile)) {
  console.error(`${idsFile} not found; run hide first`);
  process.exit(1);
}
checkPgliteMatchesNimbalyst();
if (command !== 'sizes') {
  mkdirSync(backupsDir, { recursive: true });
  copyAndCheck(dbPath, join(backupsDir, `pglite-db-${timestamp()}-before-${command}`));
}

const db = new PGlite(dbPath);
try {
  await checkSchema(db);
  const archived = await archivedCount(db);
  if (command === 'trim') {
    await printSizes(db);
    await hide(db, keepPrompts);
    await archive(db);
    await db.exec('VACUUM FULL ai_sessions');
    await db.exec('VACUUM FULL ai_agent_messages');
    await db.exec('CHECKPOINT');
  } else if (command === 'hide') {
    await hide(db, keepPrompts);
  } else if (command === 'restore') {
    if (archived > 0) throw new Error(`${archived} messages are archived; run unarchive first`);
    await restore(db);
  } else if (command === 'archive') {
    await archive(db);
  } else if (command === 'unarchive') {
    if (archived === 0) throw new Error('nothing is archived');
    await unarchive(db);
  } else if (command === 'vacuum') {
    await printSizes(db);
    await db.exec('VACUUM FULL ai_sessions');
    await db.exec('VACUUM FULL ai_agent_messages');
    await db.exec('CHECKPOINT');
  }
  await printSizes(db);
} finally {
  await db.close();
}
if (command === 'trim') {
  pruneTrimBackups();
  resetNimbalystBackupsIfTooLarge();
}
