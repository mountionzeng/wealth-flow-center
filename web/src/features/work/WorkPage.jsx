import React, { useEffect, useMemo, useState } from 'react';

const emptyProject = { title: '', description: '' };
const emptyTask = { title: '', notes: '' };

const shortDate = value => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return match ? `${match[2]}.${match[3]} ${match[4]}:${match[5]}` : '';
};

export default function WorkPage({ api, notify, onWorkChange }) {
  const [work, setWork] = useState(() => api.workState());
  const [selectedId, setSelectedId] = useState(() => api.workState().projects[0]?.id || null);
  const [projectForm, setProjectForm] = useState(emptyProject);
  const [taskForm, setTaskForm] = useState(emptyTask);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!work.projects.length) setSelectedId(null);
    else if (!work.projects.some(project => project.id === selectedId)) setSelectedId(work.projects[0].id);
  }, [selectedId, work.projects]);

  const selected = work.projects.find(project => project.id === selectedId) || null;
  const tasks = useMemo(() => selected
    ? [...selected.tasks].sort((left, right) => Number(left.status === 'done') - Number(right.status === 'done') || String(right.updated_at).localeCompare(String(left.updated_at)))
    : [], [selected]);
  const completedCount = work.projects.reduce((total, project) => total + project.tasks.filter(task => task.status === 'done').length, 0);
  const taskCount = work.projects.reduce((total, project) => total + project.tasks.length, 0);

  const commit = next => {
    setWork(next);
    onWorkChange?.(next);
    return next;
  };

  const createProject = async event => {
    event.preventDefault();
    setBusy('project');
    try {
      const next = commit(await api.createWorkProject(projectForm));
      setSelectedId(next.projects.at(-1)?.id || null);
      setProjectForm(emptyProject);
      notify?.('工作项目已建立');
    } catch (error) { notify?.(error?.message || '项目保存失败', 'error'); }
    finally { setBusy(''); }
  };

  const saveTask = async event => {
    event.preventDefault();
    if (!selected) return;
    setBusy('task');
    try {
      const next = editingTaskId
        ? await api.updateWorkTask(selected.id, editingTaskId, taskForm)
        : await api.createWorkTask(selected.id, taskForm);
      commit(next);
      setTaskForm(emptyTask);
      setEditingTaskId(null);
      notify?.(editingTaskId ? '工作任务已更新' : '工作任务已加入');
    } catch (error) { notify?.(error?.message || '任务保存失败', 'error'); }
    finally { setBusy(''); }
  };

  const editTask = task => {
    setEditingTaskId(task.id);
    setTaskForm({ title: task.title, notes: task.notes });
  };

  const toggleTask = async task => {
    const completed = task.status !== 'done';
    setBusy(`task-${task.id}`);
    try {
      commit(await api.setWorkTaskCompleted(selected.id, task.id, completed));
      notify?.(completed ? '已记入工作时间轴' : '已从工作时间轴撤回');
    } catch (error) { notify?.(error?.message || '任务状态保存失败', 'error'); }
    finally { setBusy(''); }
  };

  return (
    <section className="work-page" aria-labelledby="work-title">
      <div className="section-intro compact work-intro">
        <p className="eyebrow">WORK LEDGER</p>
        <h1 id="work-title">工作，是一件件完成的事</h1>
        <p>项目负责聚拢方向；只有真正完成的任务，才会进入工作时间轴。</p>
        <dl className="work-summary" aria-label="工作概览">
          <div><dt>项目</dt><dd>{work.projects.length}</dd></div>
          <div><dt>任务</dt><dd>{taskCount}</dd></div>
          <div><dt>完成</dt><dd>{completedCount}</dd></div>
        </dl>
      </div>

      <div className="work-ledger">
        <aside className="work-projects" aria-label="工作项目">
          <header><span>项目卷宗</span><small>{work.projects.length} 个</small></header>
          <nav className="work-project-list">
            {work.projects.map(project => {
              const done = project.tasks.filter(task => task.status === 'done').length;
              return <button key={project.id} type="button" className={project.id === selectedId ? 'active' : ''} onClick={() => { setSelectedId(project.id); setEditingTaskId(null); setTaskForm(emptyTask); }}>
                <span aria-hidden="true">{project.id === selectedId ? '◆' : '◇'}</span>
                <span><strong>{project.title}</strong><small>{done}/{project.tasks.length} 已完成</small></span>
              </button>;
            })}
            {!work.projects.length && <p className="work-empty-copy">先建立一个项目，工作的脉络会从这里展开。</p>}
          </nav>
          <form className="work-project-form" onSubmit={createProject}>
            <label>新项目<input value={projectForm.title} onChange={event => setProjectForm(current => ({ ...current, title: event.target.value }))} placeholder="例如：网站上线" maxLength="80" required/></label>
            <label>一句说明<textarea value={projectForm.description} onChange={event => setProjectForm(current => ({ ...current, description: event.target.value }))} placeholder="这个项目要抵达哪里？" rows="2" maxLength="300"/></label>
            <button type="submit" disabled={busy === 'project'}>{busy === 'project' ? '正在建立…' : '建立项目'}</button>
          </form>
        </aside>

        <main className="work-task-board">
          {selected ? <>
            <header className="work-project-heading">
              <div><p className="eyebrow">CURRENT PROJECT</p><h2>{selected.title}</h2>{selected.description && <p>{selected.description}</p>}</div>
              <span>{selected.tasks.filter(task => task.status === 'done').length} / {selected.tasks.length}</span>
            </header>

            <form className="work-task-form" onSubmit={saveTask}>
              <div className="work-form-heading"><strong>{editingTaskId ? '修改任务' : '加入一件具体的事'}</strong>{editingTaskId && <button type="button" onClick={() => { setEditingTaskId(null); setTaskForm(emptyTask); }}>取消修改</button>}</div>
              <input aria-label="任务标题" value={taskForm.title} onChange={event => setTaskForm(current => ({ ...current, title: event.target.value }))} placeholder="任务标题" maxLength="120" required/>
              <textarea aria-label="任务说明" value={taskForm.notes} onChange={event => setTaskForm(current => ({ ...current, notes: event.target.value }))} placeholder="补充标准、资料或下一步（可选）" rows="3" maxLength="1200"/>
              <button type="submit" disabled={busy === 'task'}>{busy === 'task' ? '正在保存…' : editingTaskId ? '确认修改' : '加入任务'}</button>
            </form>

            <section className="work-task-list" aria-label={`${selected.title}的任务`}>
              <header><span>进行中的任务</span><small>完成后自动留下时间</small></header>
              {tasks.length ? tasks.map(task => <article key={task.id} className={task.status === 'done' ? 'done' : ''}>
                <button className="work-check" type="button" aria-label={task.status === 'done' ? `撤回完成：${task.title}` : `完成：${task.title}`} disabled={busy === `task-${task.id}`} onClick={() => toggleTask(task)}>{task.status === 'done' ? '✓' : ''}</button>
                <div><h3>{task.title}</h3>{task.notes && <p>{task.notes}</p>}<small>{task.status === 'done' ? `完成于 ${shortDate(task.completed_at)}` : `更新于 ${shortDate(task.updated_at)}`}</small></div>
                <button className="work-edit" type="button" onClick={() => editTask(task)}>修改</button>
              </article>) : <div className="work-task-empty"><span aria-hidden="true">一</span><p>还没有任务。先写下一件可以真正完成的事。</p></div>}
            </section>
          </> : <div className="work-board-empty"><span aria-hidden="true">事</span><h2>先立一卷，再做一事</h2><p>在左侧建立工作项目，任务会在这里展开。</p></div>}
        </main>
      </div>
    </section>
  );
}

