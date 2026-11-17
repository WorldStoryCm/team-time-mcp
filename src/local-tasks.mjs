import { createHash, randomUUID } from 'node:crypto';
import { TeamTimeError } from './api.mjs';

const statuses = [
  { id: 'todo', name: 'To do', category: 'not_started' },
  { id: 'doing', name: 'In progress', category: 'in_progress' },
  { id: 'done', name: 'Done', category: 'completed' }
].map((item, position) => ({
  ...item,
  columnId: item.id,
  position,
  isDefault: true
}));
export const workflow = {
  version: 0,
  statuses,
  columns: statuses.map(({ id, name, category, position }) => ({
    id,
    name,
    category,
    position
  }))
};
export const bad = (message) =>
  new TeamTimeError('validation_failed', message, { status: 422 });
export const gone = () =>
  new TeamTimeError(
    'resource_not_found',
    'This resource is unavailable in the local project.',
    { status: 404 }
  );
const stale = () =>
  new TeamTimeError(
    'stale_version',
    'Task changed. Read it again before writing.',
    { status: 409 }
  );
const tag = (name) => ({
  id: createHash('sha256')
    .update(name.toLowerCase())
    .digest('hex')
    .slice(0, 24),
  name
});

function page(items, filters) {
  const limit = filters.limit ?? 50;
  const rows = items
    .filter((x) => !filters.cursor || x.id > filters.cursor)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    data: rows.slice(0, limit),
    page: { nextCursor: rows.length > limit ? rows[limit - 1].id : null }
  };
}

export function localTasks(db, project, actor) {
  const get = (id) => {
    const row = db.prepare('SELECT payload FROM local_task WHERE id=?').get(id);
    if (!row) throw gone();
    return JSON.parse(row.payload);
  };
  const all = () =>
    db
      .prepare('SELECT payload FROM local_task')
      .all()
      .map((row) => JSON.parse(row.payload));
  function read(path, filters) {
    if (path === '/workflow') return { data: workflow };
    if (path === '/projects') return page([project], filters);
    if (path === '/members')
      return page(
        [
          {
            id: 'local-member',
            userId: 'local',
            name: 'Local user',
            role: 'owner'
          }
        ],
        filters
      );
    if (path === '/tags')
      return page(db.prepare('SELECT id,name FROM local_tag').all(), filters);
    if (path.startsWith('/tasks/')) return { data: get(path.split('/')[2]) };
    if (path !== '/tasks') throw gone();
    const matches = all().filter(
      (t) =>
        (!filters.projectId || filters.projectId === project.id) &&
        !filters.clientId &&
        (!filters.statusId || t.statusId === filters.statusId) &&
        (!filters.assigneeId || t.assigneeId === filters.assigneeId) &&
        (!filters.statusCategory ||
          t.statusCategory === filters.statusCategory) &&
        (!filters.dueFrom || (t.dueOn && t.dueOn >= filters.dueFrom)) &&
        (!filters.dueTo || (t.dueOn && t.dueOn <= filters.dueTo)) &&
        (!filters.query ||
          (t.title + ' ' + t.description)
            .toLowerCase()
            .includes(filters.query.toLowerCase())) &&
        (!filters.tagIds ||
          filters.tagIds.every((id) => t.tags.some((item) => item.id === id)))
    );
    return page(matches, filters);
  }
  function write(path, body) {
    if (body.projectId !== undefined && body.projectId !== project.id)
      throw gone();
    if (body.assigneeId && body.assigneeId !== 'local') throw gone();
    const creating = path === '/tasks';
    const now = new Date().toISOString();
    const task = creating
      ? {
          id: randomUUID(),
          version: 0,
          projectId: project.id,
          description: '',
          result: '',
          tags: [],
          priority: null,
          dueOn: null,
          assigneeId: null,
          assigneeAgentKeyId: null,
          assigneeAgentName: null,
          createdAt: now,
          completedAt: null,
          statusId: 'todo',
          statusCategory: 'not_started'
        }
      : get(path.split('/')[2]);
    if (!creating && task.version !== body.expectedVersion) throw stale();
    if (
      body.expectedWorkflowVersion !== undefined &&
      body.expectedWorkflowVersion !== workflow.version
    )
      throw stale();
    const statusId = path.endsWith('/complete') ? 'done' : body.statusId;
    if (statusId) {
      const next = statuses.find((item) => item.id === statusId);
      if (!next || (creating && next.category === 'completed'))
        throw bad('Choose a valid task status.');
      task.statusId = next.id;
      task.statusCategory = next.category;
      task.completedAt =
        next.category === 'completed' ? (task.completedAt ?? now) : null;
      if (next.category === 'in_progress' && !task.assigneeId) {
        task.assigneeId = 'local';
        task.assigneeAgentName = actor;
      }
    }
    for (const key of [
      'title',
      'description',
      'result',
      'priority',
      'assigneeId',
      'dueOn'
    ]) {
      if (Object.hasOwn(body, key)) task[key] = body[key];
    }
    if (!task.title?.trim()) throw bad('Enter a task title.');
    if (body.tags) {
      const tags = body.tags.map((name) => tag(name.trim()));
      if (tags.some((t) => !t.name)) throw bad('Enter a tag name.');
      for (const item of tags)
        db.prepare('INSERT OR IGNORE INTO local_tag VALUES (?,?)').run(
          item.id,
          item.name
        );
      task.tags = [...new Set(tags.map((t) => t.id))].map((id) =>
        db.prepare('SELECT id,name FROM local_tag WHERE id=?').get(id)
      );
    }
    if (!creating) task.version++;
    db.prepare(
      'INSERT INTO local_task (id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
    ).run(task.id, JSON.stringify(task));
    return { data: task };
  }
  return { read, write };
}
