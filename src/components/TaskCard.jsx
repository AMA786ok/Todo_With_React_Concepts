function TaskCard({
  task,
  depth,
  tasks,
  subtasks,
  isExpanded,
  childValue,
  isDependencyPath,
  onToggleTask,
  onToggleDetails,
  onUpdate,
  onStartFocus,
  onBreakdown,
  onDelete,
  onChildChange,
  onAddSubtask,
  formatDate,
  today,
  renderTask,
}) {
  const blockedBy = task.dependsOn.map((id) => tasks.find((item) => item.id === id)).filter((item) => item && !item.isCompleted)

  return (
    <article className={`task-card ${task.isCompleted ? 'is-complete' : ''}`} style={{ '--task-depth': depth }}>
      <div className="task-main">
        <button className={`check-button ${task.isCompleted ? 'checked' : ''}`} aria-label={task.isCompleted ? 'Mark task incomplete' : 'Complete task'} onClick={onToggleTask}>{task.isCompleted ? '✓' : ''}</button>
        <button className="task-title-button" onClick={onToggleDetails}>{task.title}</button>
        <span className={`priority-dot priority-${task.priority}`} title={`${task.priority} priority`} />
        <button className="icon-button task-expand" aria-label="Toggle task details" onClick={onToggleDetails}>{isExpanded ? '−' : '+'}</button>
      </div>
      <div className="task-meta">
        {task.tag && <span className="tag-pill">#{task.tag}</span>}
        {task.project && <span>{task.project}</span>}
        {task.dueDate && <span className={task.dueDate < today && !task.isCompleted ? 'overdue-text' : ''}>{formatDate(task.dueDate, task.dueTime)}</span>}
        {task.recurrence && <span title="Repeating task">↻ {task.recurrence.replaceAll('-', ' ')}</span>}
        {task.poms > 0 && <span>🍅 {task.poms}</span>}
        {blockedBy.length > 0 && <span className="blocked-label">Blocked by {blockedBy.length}</span>}
      </div>
      {isExpanded && (
        <div className="task-details">
          <label>Due date<input type="date" value={task.dueDate} onChange={(event) => onUpdate({ dueDate: event.target.value })} /></label>
          <label>Time<input type="time" value={task.dueTime} onChange={(event) => onUpdate({ dueTime: event.target.value })} /></label>
          <label>Priority<select value={task.priority} onChange={(event) => onUpdate({ priority: event.target.value })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <label>Estimate (min)<input type="number" min="1" value={task.estimate} onChange={(event) => onUpdate({ estimate: Math.max(1, Number(event.target.value)) })} /></label>
          <label>Project<input value={task.project} onChange={(event) => onUpdate({ project: event.target.value })} /></label>
          <label>Tag<input value={task.tag} onChange={(event) => onUpdate({ tag: event.target.value.replace(/^#/, '') })} placeholder="work" /></label>
          <label className="wide-field">Repeat<select value={task.recurrence} onChange={(event) => onUpdate({ recurrence: event.target.value })}><option value="">Does not repeat</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option><option value="every-3rd-tuesday">Every 3rd Tuesday</option><option value="2-weeks-after-completion">2 weeks after completion</option></select></label>
          <label className="wide-field">Blocked by<select multiple value={task.dependsOn} onChange={(event) => onUpdate({ dependsOn: Array.from(event.target.selectedOptions, (option) => option.value) })}>{tasks.filter((item) => item.id !== task.id && !isDependencyPath(item.id, task.id)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <div className="time-summary">Tracked {Math.floor(task.secondsSpent / 3600)}h {Math.floor(task.secondsSpent % 3600 / 60)}m · {task.poms} pom{task.poms === 1 ? '' : 's'}</div>
          <div className="task-actions">
            <button className="small-button" onClick={onStartFocus}>Start focus</button>
            <button className="small-button" onClick={onBreakdown}>Break into 5 steps</button>
            <button className="small-button danger-button" onClick={onDelete}>Delete</button>
          </div>
          <form className="subtask-form" onSubmit={(event) => { event.preventDefault(); onAddSubtask() }}>
            <input value={childValue} onChange={(event) => onChildChange(event.target.value)} placeholder="Add a subtask" aria-label="Subtask title" />
            <button className="small-button" type="submit">Add subtask</button>
          </form>
          {subtasks.map((child) => renderTask(child, depth + 1))}
        </div>
      )}
    </article>
  )
}

export default TaskCard
