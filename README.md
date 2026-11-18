# nimbalyst-trim

Shrinks [Nimbalyst](https://github.com/nimbalyst/nimbalyst)'s chat database on macOS. It hides old messages, moves them to an archive table Nimbalyst never reads, and runs `VACUUM FULL`, so long sessions open fast again. Everything it does can be undone.

Not affiliated with Nimbalyst. It edits Nimbalyst's internal database, which can change in any release; read [Compatibility](#compatibility) first.

## Why

Nimbalyst keeps every chat message in a PGlite (Postgres compiled to WebAssembly) database at `~/Library/Application Support/@nimbalyst/electron/pglite-db`.

- PGlite never vacuums on its own. Each update of a session row leaves the old copy behind, so `ai_sessions` grows far beyond its live data. The plain `VACUUM` behind Nimbalyst's "Reclaim raw log space" button marks that space reusable but does not shrink the file. `VACUUM FULL` does.
- Opening a session reads every one of its rows from `ai_agent_messages`, hidden ones included. A session with tens of thousands of messages takes seconds to open.
- Hidden messages never reach the AI. Claude Code sessions resume from Claude's own session id (`ai_sessions.provider_session_id`); no path replays stored rows into a prompt. Hiding old messages only removes them from the transcript.

One run on a database with about 95,000 messages:

| | Before | After |
|---|---|---|
| `pglite-db` folder | 3.6 GB | 802 MB |
| Opening the largest sessions | 13 s and 5 s | under 1 s |
| Nimbalyst memory, large sessions open after a fresh launch | 1,481 MB | 1,050 MB |
| Main process memory peak at startup | 1,407 MB | 591 MB |

## Requirements

- macOS, with Nimbalyst installed in `/Applications`
- Node.js 20.12 or later
- Nimbalyst still on its PGlite database (see [Staying on PGlite](#staying-on-pglite))

## Install

```
git clone https://github.com/Pruthvik007/nimbalyst-trim.git
cd nimbalyst-trim
npm install
```

`npm install` brings in the PGlite version Nimbalyst ships. If Nimbalyst moves to another version, the script stops and prints the `npm i` command that matches it.

## Run

Quit Nimbalyst first: PGlite allows one process at a time, and the script refuses to run while Nimbalyst's lock file names a live process.

```
node trim.mjs trim       # keeps the last 20 user prompts of each session; trim 30 keeps 30
```

In order, `trim`:

1. stops if Nimbalyst is running or has moved to SQLite;
2. copies the database to `backups/pglite-db-<time>-before-trim` and checks the copy;
3. checks that the tables and columns it uses still exist, and stops without changing anything if not;
4. hides every message older than the last 20 user prompts of each session, cutting only at a user prompt so a tool call is never split from its result, and adds the ids to `hidden-ids.json`;
5. moves every hidden message listed in `hidden-ids.json` into `trim_archived_messages`, except two kinds that stay in place, hidden:
   - messages a file edit points at (`ai_tool_call_file_edits.message_id` deletes the file edit along with the message);
   - messages containing `nimbalyst_tool_result`, which Nimbalyst reads back so it does not store a tool result twice;
6. runs `VACUUM FULL` on `ai_sessions` and `ai_agent_messages`, then `CHECKPOINT`;
7. deletes `-before-trim` backups beyond the newest two (other backups are never touched);
8. resets Nimbalyst's own backups if the database is now under half their size (see below).

Running it twice in a row changes nothing the second time. If it stops with an error, do not open Nimbalyst: run `node trim.mjs sizes`, and roll back (below) if that fails too.

Then open Nimbalyst. After a few minutes, `lastSuccessfulBackup` in `~/Library/Application Support/@nimbalyst/electron/db-backups/backup-metadata.json` should be the current time.

### Why Nimbalyst's backups get reset

Nimbalyst rejects a new backup under half the size of its current one ("New backup is suspiciously smaller than current - rejecting rotation" in its log) and keeps the old one, so after a big shrink it would never take a new backup again. Without `db-backups/backup-metadata.json` it starts fresh and takes a backup soon after launch, so `trim` deletes the `pglite-db.backup-*` folders and that file. The backup taken in step 2 covers the gap.

## Commands

```
node trim.mjs -h
```

| Command | What it does |
|---|---|
| `trim [keep]` | the whole pass above |
| `hide [keep]` | hide messages older than the last `keep` user prompts of each session |
| `archive` | move the hidden messages into `trim_archived_messages` |
| `vacuum` | `VACUUM FULL` the two large tables |
| `unarchive` | move every archived message back, still hidden |
| `restore` | unhide exactly the messages in `hidden-ids.json`; refuses while anything is archived |
| `rollback [backup]` | put a backup back (default: the newest); the current database is renamed beside it, not deleted |
| `sizes` | print database and table sizes, without writing |
| `pin` | keep Nimbalyst on PGlite (below) |

Every command that writes first copies the whole database into `backups/`.

## Files

The script writes nothing into this folder. Its state lives in `~/Library/Application Support/nimbalyst-trim/` (override with `NIMBALYST_TRIM_DATA`):

| Path | What it is |
|---|---|
| `backups/pglite-db-<time>-before-<command>/` | full copy of the database taken before every command that writes |
| `hidden-ids.json` | every message id `hide` has hidden, per session, across all runs; `archive` and `restore` read it |
| `usage.csv` | rows written by `usage.sh` |

The archived messages stay inside the database, in `trim_archived_messages`, with the same columns as `ai_agent_messages`. `unarchive` drops that table.

`NIMBALYST_DB` points the script at another database folder, for example a copy to try it on first:

```
cp -R ~/Library/Application\ Support/@nimbalyst/electron/db-backups/pglite-db.backup-current /tmp/try/pglite-db
NIMBALYST_DB=/tmp/try/pglite-db NIMBALYST_TRIM_DATA=/tmp/try/data node trim.mjs trim
```

## Measuring the effect

```
./usage.sh before
```

Samples the CPU of Nimbalyst's processes for 30 seconds, reads their memory footprint and appends a row to `usage.csv`. Run it with the large sessions open after a fresh launch, once before the trim and once after: a long-running Nimbalyst grows on its own, so only fresh launches compare.

## Staying on PGlite

Nimbalyst moves itself to a SQLite database on launch when the `pglite-db` folder is under a size limit it fetches from its servers (256 MB at the time of writing). A trim can bring the database under that limit. Nimbalyst then moves the data to SQLite, this script no longer applies, and `trim_archived_messages` stays behind in the old PGlite folder. Run `unarchive` first if you want those messages moved too.

To stay on PGlite instead, with Nimbalyst closed:

```
node trim.mjs pin
```

It sets `"backend": "pglite"` and `"setBy": "rollback"` in `~/Library/Application Support/@nimbalyst/electron/database-backend.json`, the state Nimbalyst writes itself after a rollback from SQLite; Nimbalyst then reports no move due. A move started by hand inside Nimbalyst still switches. Check it after a Nimbalyst update:

```
grep setBy ~/Library/Application\ Support/@nimbalyst/electron/database-backend.json
```

If a `sqlite-db/` folder appears beside `pglite-db/`, Nimbalyst has switched; `pglite-db/` still holds the old data.

## Restore

All with Nimbalyst closed.

Move archived messages back, then unhide them:

```
node trim.mjs unarchive
node trim.mjs restore
```

Put the newest backup back:

```
node trim.mjs rollback
```

Or a specific one:

```
ls ~/Library/Application\ Support/nimbalyst-trim/backups/
node trim.mjs rollback ~/Library/Application\ Support/nimbalyst-trim/backups/<backup folder>
```

Without the script:

```
cd ~/Library/Application\ Support/@nimbalyst/electron
mv pglite-db pglite-db.broken-$(date +%s)
cp -R ~/Library/Application\ Support/nimbalyst-trim/backups/<backup folder> pglite-db
```

## Compatibility

Written against Nimbalyst 0.83 with PGlite 0.3.14. It depends on Nimbalyst internals that can change in any release:

- the tables `ai_agent_messages`, `ai_sessions` and `ai_tool_call_file_edits`, and the columns listed in `REQUIRED_COLUMNS` in `trim.mjs`; the script checks these before changing anything;
- the PGlite version Nimbalyst ships, read from `/Applications/Nimbalyst.app/Contents/Resources/legal/THIRD_PARTY_LICENSES.json`; the script stops on a mismatch;
- the `nimbalyst_tool_result` marker, the half-size backup rule and the `setBy` values in `database-backend.json`; these are not checked.

## License

MIT
