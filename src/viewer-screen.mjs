import { mountKnowledge } from './explorer.mjs';
const token = location.hash.slice(1) || sessionStorage.getItem('viewer');
if (token) sessionStorage.setItem('viewer', token);
history.replaceState(null, '', location.pathname + location.search);
const root = document.getElementById('knowledge');
async function request(op, id, args) {
  const response = await fetch('/query', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ op, id, args, commandId: crypto.randomUUID() })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
try {
  const project = await request('info');
  document.getElementById('project').textContent = project.name + ' · Local';
  mountKnowledge(
    root,
    {
      list: (args) => request('list', undefined, args),
      note: (id) => request('note', id),
      proposal: (id) => request('proposal', id),
      check: (id) => request('check', id),
      decide: (id, args) => request('decide', id, args)
    },
    project.name,
    true
  );
} catch (error) {
  root.textContent = error.message;
}
