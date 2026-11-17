import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  closeSync,
  openSync,
  readFileSync,
  realpathSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { CommandClient, CommandStore, TeamTimeError } from './api.mjs';
import { knowledgeLedger, KnowledgeError } from './knowledge/ledger.mjs';
import { gone, localTasks } from './local-tasks.mjs';

const operations = [
  'listProjects',
  'listMembers',
  'getWorkflow',
  'listTags',
  'listTasks',
  'getTask',
  'createTask',
  'updateTask',
  'changeTaskStatus',
  'completeTask',
  'checkKnowledge',
  'listKnowledge',
  'getKnowledgeNote',
  'getKnowledgeProposal',
  'proposeKnowledge',
  'reviewKnowledge'
];
const queues = new Map();
function projectRoot(env) {
  if (env.TEAM_TIME_PROJECT_DIR) return realpathSync(env.TEAM_TIME_PROJECT_DIR);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return process.cwd();
  }
}
export class LocalClient extends CommandClient {
  constructor(env = process.env) {
    super();
    const root = projectRoot(env);
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 24);
    const folder = resolve(
      env.TEAM_TIME_LOCAL_DIR ||
        join(homedir(), '.local', 'share', 'team-time-mcp', hash)
    );
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.file = join(realpathSync(folder), 'time.sqlite');
    closeSync(openSync(this.file, 'a', 0o600));
    this.db = new DatabaseSync(this.file);
    // Built-in SQLite lower() only folds ASCII. Use Unicode casing for multilingual notes.
    this.db.function('lower', { deterministic: true }, (value) =>
      value == null ? null : String(value).toLowerCase()
    );
    this.db.exec('PRAGMA busy_timeout=8000; PRAGMA foreign_keys=ON');
    // Acquire the writer lock before schema discovery when agents start simultaneously.
    // The default rollback journal also permits independent MCP processes to share this file.
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec(
        readFileSync(new URL('./knowledge/local.sql', import.meta.url), 'utf8')
      );
      this.db
        .prepare(
          'INSERT OR IGNORE INTO local_project (slot,id,name) VALUES (1,?,?)'
        )
        .run(randomUUID(), basename(root) || 'Local project');
      this.project = this.db
        .prepare('SELECT id,name FROM local_project WHERE slot=1')
        .get();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.organizationId = 'local-' + this.project.id;
    this.actor =
      env.TEAM_TIME_AGENT_NAME?.trim().slice(0, 120) || 'agent/' + randomUUID();
    this.tasks = localTasks(this.db, this.project, this.actor);
    this.store = new CommandStore(join(folder, 'receipts'));
    this.mode = 'local';
  }
  redact(value) {
    return value;
  }
  transaction(write, fn) {
    const previous = queues.get(this.file) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
          const value = await fn();
          this.db.exec('COMMIT');
          return value;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      });
    queues.set(this.file, next);
    return next.finally(() => {
      if (queues.get(this.file) === next) queues.delete(this.file);
    });
  }
  async send(method, path, { query = {}, body, commandId } = {}) {
    if (path === '/context')
      return {
        data: {
          storage: 'local',
          organization: { id: this.organizationId, name: this.project.name },
          userId: 'local',
          role: 'owner',
          operations,
          access: {
            type: 'project',
            projectId: this.project.id,
            projectName: this.project.name
          }
        }
      };
    const write = method !== 'GET';
    return this.transaction(write, async () => {
      const payload = write ? JSON.stringify([method, path, body]) : null;
      if (write) {
        const old = this.db
          .prepare('SELECT payload,result FROM local_receipt WHERE id=?')
          .get(commandId);
        if (old) {
          if (old.payload !== payload)
            throw new TeamTimeError(
              'idempotency_conflict',
              'Command contents changed.',
              { status: 409 }
            );
          return JSON.parse(old.result);
        }
      }
      let result;
      if (path.includes('/knowledge')) {
        const [, , project, feature, kind, id, action] = path.split('/');
        if (project !== this.project.id || feature !== 'knowledge')
          throw gone();
        const ledger = knowledgeLedger(
          async (statement, args) => this.db.prepare(statement).all(...args),
          project,
          this.actor
        );
        try {
          if (!write && !kind) result = await ledger.list(query);
          else if (!write && kind === 'notes')
            result = await ledger.getNote(id);
          else if (!write && kind === 'proposals' && action === 'check')
            result = await ledger.check(id);
          else if (!write && kind === 'proposals')
            result = await ledger.getProposal(id);
          else if (write && kind === 'proposals' && !id)
            result = await ledger.propose(body);
          else if (write && kind === 'proposals' && action === 'decision')
            result = await ledger.decide(id, body);
          else throw gone();
        } catch (error) {
          if (error instanceof KnowledgeError)
            throw new TeamTimeError(error.code, error.message, {
              status:
                error.code === 'stale_version'
                  ? 409
                  : error.code === 'resource_not_found'
                    ? 404
                    : 422
            });
          if (error.name === 'ZodError')
            throw new TeamTimeError(
              'validation_failed',
              'Invalid knowledge input.',
              { status: 422 }
            );
          throw error;
        }
        result = { data: result };
      } else
        result = write
          ? this.tasks.write(path, body)
          : this.tasks.read(path, query);
      if (write)
        this.db
          .prepare('INSERT INTO local_receipt VALUES (?,?,?)')
          .run(commandId, payload, JSON.stringify(result));
      return result;
    });
  }
  close() {
    this.db.close();
  }
}
