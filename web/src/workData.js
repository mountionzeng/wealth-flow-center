const clean = (value, limit = 240) => String(value || '').trim().slice(0, limit);

const nowText = now => now.toISOString();

const normalizeTask = task => ({
  id: Number(task?.id) || 0,
  title: clean(task?.title, 120) || '未命名任务',
  notes: clean(task?.notes, 1200),
  status: task?.status === 'done' ? 'done' : 'todo',
  created_at: clean(task?.created_at, 40),
  updated_at: clean(task?.updated_at, 40),
  completed_at: task?.status === 'done' ? clean(task?.completed_at, 40) : '',
});

const normalizeProject = project => ({
  id: Number(project?.id) || 0,
  title: clean(project?.title, 80) || '未命名项目',
  description: clean(project?.description, 300),
  created_at: clean(project?.created_at, 40),
  updated_at: clean(project?.updated_at, 40),
  tasks: Array.isArray(project?.tasks)
    ? project.tasks.filter(task => task && task.id != null).map(normalizeTask)
    : [],
});

export const createWorkState = () => ({
  version: 1,
  next_project_id: 1,
  next_task_id: 1,
  projects: [],
});

export const normalizeWorkState = raw => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const projects = Array.isArray(source.projects)
    ? source.projects.filter(project => project && project.id != null).map(normalizeProject)
    : [];
  const projectIds = projects.map(project => project.id);
  const taskIds = projects.flatMap(project => project.tasks.map(task => task.id));
  return {
    version: 1,
    next_project_id: Math.max(1, Number(source.next_project_id) || 1, ...projectIds.map(id => id + 1)),
    next_task_id: Math.max(1, Number(source.next_task_id) || 1, ...taskIds.map(id => id + 1)),
    projects,
  };
};

export const addWorkProject = (raw, input, now = new Date()) => {
  const state = normalizeWorkState(raw);
  const title = clean(input?.title, 80);
  if (!title) throw new Error('请输入项目名称');
  const timestamp = nowText(now);
  state.projects.push({
    id: state.next_project_id++,
    title,
    description: clean(input?.description, 300),
    created_at: timestamp,
    updated_at: timestamp,
    tasks: [],
  });
  return state;
};

export const addWorkTask = (raw, projectId, input, now = new Date()) => {
  const state = normalizeWorkState(raw);
  const project = state.projects.find(item => item.id === Number(projectId));
  if (!project) throw new Error('工作项目不存在');
  const title = clean(input?.title, 120);
  if (!title) throw new Error('请输入任务标题');
  const timestamp = nowText(now);
  project.tasks.push({
    id: state.next_task_id++,
    title,
    notes: clean(input?.notes, 1200),
    status: 'todo',
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: '',
  });
  project.updated_at = timestamp;
  return state;
};

export const updateWorkTask = (raw, projectId, taskId, input, now = new Date()) => {
  const state = normalizeWorkState(raw);
  const project = state.projects.find(item => item.id === Number(projectId));
  const task = project?.tasks.find(item => item.id === Number(taskId));
  if (!project || !task) throw new Error('工作任务不存在');
  const title = clean(input?.title, 120);
  if (!title) throw new Error('请输入任务标题');
  const timestamp = nowText(now);
  task.title = title;
  task.notes = clean(input?.notes, 1200);
  task.updated_at = timestamp;
  project.updated_at = timestamp;
  return state;
};

export const setWorkTaskCompleted = (raw, projectId, taskId, completed, now = new Date()) => {
  const state = normalizeWorkState(raw);
  const project = state.projects.find(item => item.id === Number(projectId));
  const task = project?.tasks.find(item => item.id === Number(taskId));
  if (!project || !task) throw new Error('工作任务不存在');
  const timestamp = nowText(now);
  task.status = completed ? 'done' : 'todo';
  task.completed_at = completed ? timestamp : '';
  task.updated_at = timestamp;
  project.updated_at = timestamp;
  return state;
};

