import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Navbar from '../components/Navbar'
import TaskCard from '../components/TaskCard'
import { apiRequest } from '../lib/api'

const DB_NAME = 'taskflow-db'
const DB_STORE = 'workspace'
const STORAGE_KEY = 'taskflow-workspace-v1'
const POMODORO_MINUTES = 25

function localDateString(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function currentTimestamp() {
  return new Date().toISOString()
}

function dateAfterDays(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return localDateString(date)
}

function formatHour(hour) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2000, 0, 1, hour))
}

function nextOccurrenceDate(recurrence) {
  const next = new Date()
  if (recurrence === 'daily') next.setDate(next.getDate() + 1)
  if (recurrence === 'weekly') next.setDate(next.getDate() + 7)
  if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1)
  if (recurrence === '2-weeks-after-completion') next.setDate(next.getDate() + 14)
  if (recurrence === 'every-3rd-tuesday') {
    const thirdTuesday = (year, month) => {
      const first = new Date(year, month, 1)
      const daysUntilTuesday = (2 - first.getDay() + 7) % 7
      return new Date(year, month, 1 + daysUntilTuesday + 14)
    }
    let candidate = thirdTuesday(next.getFullYear(), next.getMonth())
    if (candidate <= next) candidate = thirdTuesday(next.getFullYear(), next.getMonth() + 1)
    return candidate
  }
  return next
}

function calculateStreak(tasks) {
  const completedDays = new Set(tasks.filter((task) => task.completedAt).map((task) => task.completedAt.slice(0, 10)))
  let streak = 0
  const day = new Date()
  if (!completedDays.has(localDateString(day))) day.setDate(day.getDate() - 1)
  while (completedDays.has(localDateString(day))) {
    streak += 1
    day.setDate(day.getDate() - 1)
  }
  return streak
}

function getWeeklyStats(tasks) {
  const now = new Date()
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
  const weekStartKey = localDateString(weekStart)
  const completed = tasks.filter((task) => task.completedAt && task.completedAt.slice(0, 10) >= weekStartKey)
  const missed = tasks.filter((task) => !task.isCompleted && task.dueDate && task.dueDate < localDateString(now) && task.dueDate >= weekStartKey)
  const hours = new Map()
  tasks.flatMap((task) => task.workLogs ?? []).forEach((log) => {
    if (log.date >= weekStartKey) hours.set(log.hour, (hours.get(log.hour) ?? 0) + log.seconds)
  })
  const mostProductiveHour = [...hours.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const tagTime = new Map()
  tasks.forEach((task) => {
    if (!task.tag) return
    tagTime.set(task.tag, (tagTime.get(task.tag) ?? 0) + task.secondsSpent)
  })
  const totalTagTime = [...tagTime.values()].reduce((sum, value) => sum + value, 0)
  const timeByTag = [...tagTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([tag, seconds]) => ({ tag, seconds, percent: totalTagTime ? Math.round(seconds / totalTagTime * 100) : 0 }))
  return { completedCount: completed.length, missedCount: missed.length, mostProductiveHour, timeByTag }
}

function hasDependencyPath(tasks, fromId, targetId, visited = new Set()) {
  if (fromId === targetId) return true
  if (visited.has(fromId)) return false
  visited.add(fromId)
  const task = tasks.find((item) => item.id === fromId)
  return task?.dependsOn.some((dependency) => hasDependencyPath(tasks, dependency, targetId, visited)) ?? false
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser.'))
      return
    }
    const request = window.indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local task storage.'))
  })
}

async function readWorkspace(userId) {
  const storageKey = `${STORAGE_KEY}-${userId}`
  try {
    const database = await openDatabase()
    const saved = await new Promise((resolve, reject) => {
      const request = database.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(userId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Could not read local task storage.'))
    })
    database.close()
    if (saved) return saved
  } catch (error) {
    console.error('IndexedDB read failed; trying the browser storage backup.', error)
  }
  try {
    return JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
  } catch (error) {
    console.error('Could not read the browser storage backup.', error)
    return null
  }
}

async function writeWorkspace(userId, value) {
  const storageKey = `${STORAGE_KEY}-${userId}`
  try {
    const database = await openDatabase()
    await new Promise((resolve, reject) => {
      const request = database.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(value, userId)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Could not save local task storage.'))
    })
    database.close()
  } catch (error) {
    console.error('IndexedDB write failed; using the browser storage backup.', error)
    window.localStorage.setItem(storageKey, JSON.stringify(value))
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value))
  } catch (error) {
    console.error('Could not update the browser storage backup.', error)
  }
  if (!navigator.onLine) return { cloudError: '' }
  try {
    await apiRequest('/api/workspace', {
      method: 'PUT',
      body: JSON.stringify({ data: value }),
    })
    return { cloudError: '' }
  } catch (error) {
    console.error('Could not sync the workspace to the server.', error)
    return { cloudError: error.message || 'Could not reach the TaskFlow server.' }
  }
}

function parseTaskText(input) {
  let title = input.trim()
  let tag = ''
  let dueDate = ''
  let dueTime = ''
  const tagMatch = title.match(/(?:^|\s)#([\w-]+)/)
  if (tagMatch) {
    tag = tagMatch[1]
    title = title.replace(tagMatch[0], ' ').trim()
  }

  const timeMatch = title.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (timeMatch) {
    let hour = Number(timeMatch[1]) % 12
    if (timeMatch[3].toLowerCase() === 'pm') hour += 12
    dueTime = `${String(hour).padStart(2, '0')}:${timeMatch[2] ?? '00'}`
    title = title.replace(timeMatch[0], ' ').trim()
  }

  const relativeMatch = title.match(/\b(today|tomorrow)\b/i)
  const weekdayMatch = title.match(/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i)
  if (relativeMatch) {
    const date = new Date()
    if (relativeMatch[1].toLowerCase() === 'tomorrow') date.setDate(date.getDate() + 1)
    dueDate = localDateString(date)
    title = title.replace(relativeMatch[0], ' ').trim()
  } else if (weekdayMatch) {
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    const target = weekdays.indexOf(weekdayMatch[1].toLowerCase())
    const date = new Date()
    let days = (target - date.getDay() + 7) % 7
    if (days === 0 || weekdayMatch[0].toLowerCase().startsWith('next')) days += 7
    date.setDate(date.getDate() + days)
    dueDate = localDateString(date)
    title = title.replace(weekdayMatch[0], ' ').trim()
  }

  return { title: title.replace(/\s+/g, ' ').trim(), tag, dueDate, dueTime }
}

function formatDueDate(date, time) {
  if (!date) return 'No due date'
  const parsed = new Date(`${date}T${time || '12:00'}:00`)
  const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parsed)
  if (!time) return day
  return `${day} · ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(parsed)}`
}

function getInitialWorkspace() {
  return {
    tasks: [], savedFilters: [], pomodoroLength: POMODORO_MINUTES,
    dailyGoal: 5, digestEnabled: false, lastDigestDate: '', remindedTaskIds: [],
  }
}

function normalizeWorkspace(saved) {
  if (!saved || typeof saved !== 'object') return getInitialWorkspace()
  const taskDefaults = {
    tag: '', dueDate: '', dueTime: '', isCompleted: false, priority: 'medium',
    estimate: 15, secondsSpent: 0, poms: 0, project: '', recurrence: '',
    dependsOn: [], parentId: '', createdAt: currentTimestamp(), completedAt: '', workLogs: [],
  }
  return {
    ...getInitialWorkspace(),
    ...saved,
    tasks: Array.isArray(saved.tasks) ? saved.tasks.filter((task) => task && typeof task === 'object').map((task) => ({
      ...taskDefaults,
      ...task,
      id: task.id || makeId(),
      title: String(task.title ?? ''),
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
      workLogs: Array.isArray(task.workLogs) ? task.workLogs : [],
    })) : [],
  }
}

const viewLabels = { list: 'List', board: 'Board', calendar: 'Calendar', timeline: 'Timeline' }

function TaskWorkspace({ user, role, onLogout, onOpenAdmin }) {
  const [workspace, setWorkspace] = useState(getInitialWorkspace)
  const [loaded, setLoaded] = useState(false)
  const [storageError, setStorageError] = useState('')
  const [input, setInput] = useState('')
  const [view, setView] = useState('list')
  const [section, setSection] = useState('inbox')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState('')
  const [childInput, setChildInput] = useState({})
  const [pomodoroTask, setPomodoroTask] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(POMODORO_MINUTES * 60)
  const [timerRunning, setTimerRunning] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [cloudStatus, setCloudStatus] = useState('connecting')
  const [notificationStatus, setNotificationStatus] = useState('default')
  const [savedFilterName, setSavedFilterName] = useState('')
  const sessionElapsed = useRef(0)
  const secondsLeftRef = useRef(POMODORO_MINUTES * 60)
  const workspaceRef = useRef(workspace)
  const [calendarToday] = useState(() => new Date())
  const tasks = workspace.tasks

  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

  useEffect(() => {
    let active = true
    async function loadUserWorkspace() {
      let saved
      try {
        saved = await readWorkspace(user.id)
        if (active && saved) setWorkspace(normalizeWorkspace(saved))
      } catch (error) {
        console.error('Could not restore the saved workspace.', error)
        if (active) setStorageError('Could not restore your saved tasks. Your browser may be blocking local storage.')
      }
      if (navigator.onLine) {
        try {
          const { data: remote } = await apiRequest('/api/workspace')
          if (remote && active) {
            saved = remote
            setWorkspace(normalizeWorkspace(remote))
            setCloudStatus('synced')
          } else if (saved && active) {
            const result = await writeWorkspace(user.id, saved)
            setCloudStatus(result.cloudError ? 'offline' : 'synced')
          } else if (active) {
            setCloudStatus('synced')
          }
        } catch (error) {
          console.error('Could not load the server workspace.', error)
          if (active) setCloudStatus('offline')
        }
      } else if (active) {
        setCloudStatus('offline')
      }
      if (active) setLoaded(true)
    }
    loadUserWorkspace().catch((error) => {
      console.error('Could not initialize the user workspace.', error)
      if (active) {
        setStorageError('Could not load your workspace. Your local changes are still available.')
        setCloudStatus('offline')
        setLoaded(true)
      }
    })
    return () => { active = false }
  }, [user.id])

  useEffect(() => {
    if (!loaded || !('Notification' in window) || Notification.permission !== 'granted') return undefined
    const sendReminders = () => {
      const now = new Date()
      const date = localDateString(now)
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const alreadyReminded = new Set(workspace.remindedTaskIds ?? [])
      const dueNow = tasks.filter((task) => !task.isCompleted && task.dueDate === date && task.dueTime === time && !alreadyReminded.has(task.id))
      dueNow.forEach((task) => {
        new Notification('Task reminder', { body: task.title })
        alreadyReminded.add(task.id)
      })
      if (dueNow.length) {
        setWorkspace((current) => ({ ...current, remindedTaskIds: [...alreadyReminded] }))
      }
      if (workspace.digestEnabled && now.getHours() === 8 && workspace.lastDigestDate !== date) {
        const dueTodayTasks = tasks.filter((task) => !task.isCompleted && task.dueDate === date)
        new Notification('Your morning task digest', {
          body: dueTodayTasks.length ? `You have ${dueTodayTasks.length} task${dueTodayTasks.length === 1 ? '' : 's'} due today.` : 'You have no tasks due today. Enjoy the breathing room!',
        })
        setWorkspace((current) => ({ ...current, lastDigestDate: date }))
      }
    }
    const interval = window.setInterval(sendReminders, 60_000)
    return () => window.clearInterval(interval)
  }, [loaded, notificationStatus, tasks, workspace.digestEnabled, workspace.lastDigestDate, workspace.remindedTaskIds])

  useEffect(() => {
    if (!loaded) return
    const timeout = window.setTimeout(() => writeWorkspace(user.id, workspace).then(({ cloudError }) => {
      setStorageError('')
      setCloudStatus(cloudError ? 'offline' : navigator.onLine ? 'synced' : 'offline')
      if (cloudError) setStorageError(`Saved on this device, but cloud sync failed: ${cloudError}`)
    }).catch((error) => {
      console.error('Could not save the workspace.', error)
      setStorageError('Changes could not be saved locally. Check your browser storage settings.')
    }), 500)
    return () => window.clearTimeout(timeout)
  }, [loaded, user.id, workspace])

  useEffect(() => {
    if (!loaded || !navigator.onLine) return undefined
    const events = new EventSource('/api/workspace/events')
    events.addEventListener('workspace', (event) => {
      const incoming = JSON.parse(event.data)
      if (JSON.stringify(incoming) !== JSON.stringify(workspaceRef.current)) {
        workspaceRef.current = normalizeWorkspace(incoming)
        setWorkspace(workspaceRef.current)
      }
      setCloudStatus('synced')
    })
    events.onerror = () => setCloudStatus('offline')
    return () => {
      events.close()
    }
  }, [loaded, online, user.id])

  useEffect(() => {
    const updateOnline = () => {
      const isOnline = navigator.onLine
      setOnline(isOnline)
      setCloudStatus(isOnline ? 'connecting' : 'offline')
      if (isOnline) setWorkspace((current) => ({ ...current }))
    }
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [])

  const updateTasks = useCallback((updater) => {
    setWorkspace((current) => ({ ...current, tasks: typeof updater === 'function' ? updater(current.tasks) : updater }))
  }, [])

  function addTask(event) {
    event?.preventDefault()
    if (!input.trim()) return
    const parsed = parseTaskText(input)
    if (!parsed.title) return
    const task = {
      id: makeId(), ...parsed, isCompleted: false, priority: 'medium',
      estimate: 30, secondsSpent: 0, poms: 0, project: 'Inbox',
      recurrence: '', dependsOn: [], parentId: '', createdAt: currentTimestamp(), workLogs: [],
      completedAt: '',
    }
    updateTasks((current) => [task, ...current])
    setInput('')
  }

  function patchTask(id, changes) {
    updateTasks((current) => current.map((task) => task.id === id ? { ...task, ...changes } : task))
  }

  function deleteTask(id) {
    updateTasks((current) => {
      const deletedIds = new Set([id])
      let changed = true
      while (changed) {
        changed = false
        current.forEach((task) => {
          if (deletedIds.has(task.parentId) && !deletedIds.has(task.id)) {
            deletedIds.add(task.id)
            changed = true
          }
        })
      }
      return current.filter((task) => !deletedIds.has(task.id))
        .map((task) => ({ ...task, dependsOn: task.dependsOn.filter((dependency) => !deletedIds.has(dependency)) }))
    })
    if (pomodoroTask === id) stopTimer()
  }

  function toggleTask(task) {
    const blockedBy = task.dependsOn.map((id) => tasks.find((item) => item.id === id)).filter((item) => item && !item.isCompleted)
    if (!task.isCompleted && blockedBy.length) {
      window.alert(`Complete ${blockedBy.map((item) => item.title).join(', ')} first.`)
      return
    }
    const isCompleted = !task.isCompleted
    patchTask(task.id, { isCompleted, completedAt: isCompleted ? currentTimestamp() : '' })
    if (isCompleted && task.recurrence) {
      const next = nextOccurrenceDate(task.recurrence)
      if (['daily', 'weekly', 'monthly', '2-weeks-after-completion', 'every-3rd-tuesday'].includes(task.recurrence)) {
        updateTasks((current) => [{
          ...task, id: makeId(), isCompleted: false, completedAt: '',
          dueDate: localDateString(next), dependsOn: [], parentId: '',
          createdAt: currentTimestamp(), secondsSpent: 0, poms: 0, workLogs: [],
        }, ...current])
      }
    }
  }

  function addSubtask(parent) {
    const title = (childInput[parent.id] ?? '').trim()
    if (!title) return
    updateTasks((current) => [...current, {
      id: makeId(), title, tag: parent.tag, dueDate: parent.dueDate, dueTime: '',
      isCompleted: false, priority: parent.priority, estimate: 15, secondsSpent: 0,
      poms: 0, project: parent.project, recurrence: '', dependsOn: [],
      parentId: parent.id, createdAt: currentTimestamp(), completedAt: '', workLogs: [],
    }])
    setChildInput((current) => ({ ...current, [parent.id]: '' }))
  }

  function breakTaskDown(task) {
    const idea = task.title.toLowerCase()
    const suggestions = idea.includes('marketing')
      ? ['Define the target audience and positioning', 'Research competitors and market trends', 'Set measurable campaign goals', 'Choose channels, budget, and timeline', 'Create the launch plan and success metrics']
      : idea.includes('website') || idea.includes('app') || idea.includes('build')
        ? ['Define scope and success criteria', 'Gather requirements and references', 'Create a first draft or prototype', 'Review with stakeholders and refine', 'Finalize, deliver, and document the work']
        : ['Clarify the goal and expected outcome', 'Gather the information and resources needed', 'Break the work into a first small deliverable', 'Complete and review the main work', 'Share the result and capture follow-ups']
    updateTasks((current) => [...current, ...suggestions.map((title) => ({
      id: makeId(), title, tag: task.tag, dueDate: task.dueDate, dueTime: '',
      isCompleted: false, priority: task.priority, estimate: 30, secondsSpent: 0,
      poms: 0, project: task.project, recurrence: '', dependsOn: [],
      parentId: task.id, createdAt: currentTimestamp(), completedAt: '', workLogs: [],
    }))])
    setExpanded(task.id)
  }

  function startTimer(task) {
    if (pomodoroTask && pomodoroTask !== task.id) stopTimer()
    setPomodoroTask(task.id)
    const duration = (workspace.pomodoroLength || POMODORO_MINUTES) * 60
    secondsLeftRef.current = duration
    setSecondsLeft(duration)
    sessionElapsed.current = 0
    setTimerRunning(true)
  }

  function stopTimer() {
    if (pomodoroTask && sessionElapsed.current > 0) {
      const seconds = sessionElapsed.current
      updateTasks((current) => current.map((task) => task.id === pomodoroTask ? {
        ...task,
        secondsSpent: task.secondsSpent + seconds,
        workLogs: [...(task.workLogs ?? []), { date: localDateString(), seconds, hour: new Date().getHours() }],
      } : task))
    }
    sessionElapsed.current = 0
    setTimerRunning(false)
    setPomodoroTask('')
    secondsLeftRef.current = (workspace.pomodoroLength || POMODORO_MINUTES) * 60
    setSecondsLeft(secondsLeftRef.current)
  }

  const finishPomodoro = useCallback(() => {
    if (pomodoroTask) {
      const seconds = sessionElapsed.current
      updateTasks((current) => current.map((task) => task.id === pomodoroTask ? {
        ...task,
        poms: task.poms + 1,
        secondsSpent: task.secondsSpent + seconds,
        workLogs: [...(task.workLogs ?? []), { date: localDateString(), seconds, hour: new Date().getHours() }],
      } : task))
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Focus session complete', { body: 'Great work. Take a short break!' })
      }
    }
    sessionElapsed.current = 0
    setPomodoroTask('')
    setTimerRunning(false)
    secondsLeftRef.current = (workspace.pomodoroLength || POMODORO_MINUTES) * 60
    setSecondsLeft(secondsLeftRef.current)
  }, [pomodoroTask, updateTasks, workspace.pomodoroLength])

  useEffect(() => {
    if (!timerRunning) return undefined
    const interval = window.setInterval(() => {
      sessionElapsed.current += 1
      if (secondsLeftRef.current <= 1) {
        window.clearInterval(interval)
        secondsLeftRef.current = 0
        setSecondsLeft(0)
        finishPomodoro()
        return
      }
      secondsLeftRef.current -= 1
      setSecondsLeft(secondsLeftRef.current)
    }, 1000)
    return () => window.clearInterval(interval)
  }, [finishPomodoro, timerRunning])

  function requestNotifications() {
    if (!('Notification' in window)) {
      setNotificationStatus('unsupported')
      return
    }
    Notification.requestPermission().then(setNotificationStatus).catch((error) => {
      console.error('Could not request notification permission.', error)
      setNotificationStatus('denied')
    })
  }

  function exportCalendar() {
    const events = tasks.filter((task) => task.dueDate).map((task) => {
      const start = `${task.dueDate.replaceAll('-', '')}T${(task.dueTime || '0900').replace(':', '')}00`
      const endDate = new Date(`${task.dueDate}T${task.dueTime || '09:00'}:00`)
      endDate.setMinutes(endDate.getMinutes() + task.estimate)
      const end = `${localDateString(endDate).replaceAll('-', '')}T${String(endDate.getHours()).padStart(2, '0')}${String(endDate.getMinutes()).padStart(2, '0')}00`
      return `BEGIN:VEVENT\nUID:${task.id}@taskflow.local\nDTSTART:${start}\nDTEND:${end}\nSUMMARY:${task.title.replace(/[,;\\]/g, '\\$&')}\nEND:VEVENT`
    })
    const file = new Blob([`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//TaskFlow//EN\n${events.join('\n')}\nEND:VCALENDAR`], { type: 'text/calendar' })
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = 'taskflow-calendar.ics'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function saveAndSignOut() {
    try {
      const { cloudError } = await writeWorkspace(user.id, workspace)
      if (cloudError) setStorageError(`Saved on this device, but cloud sync failed: ${cloudError}`)
      onLogout()
    } catch (error) {
      console.error('Could not save before signing out.', error)
      setStorageError('Could not save your changes, so you have not been signed out. Check browser storage and try again.')
    }
  }

  function handleShortcut(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      document.querySelector('#task-search')?.focus()
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault()
      document.querySelector('#task-input')?.focus()
    }
    if (event.key === 'Escape') {
      document.activeElement?.blur()
      setSearch('')
    }
  }

  useEffect(() => {
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  })

  const childrenByParent = useMemo(() => {
    const groups = new Map()
    tasks.forEach((task) => {
      if (!task.parentId) return
      groups.set(task.parentId, [...(groups.get(task.parentId) ?? []), task])
    })
    return groups
  }, [tasks])

  const topLevelTasks = useMemo(() => {
    let result = tasks.filter((task) => !task.parentId)
    if (section === 'today') result = result.filter((task) => task.dueDate === localDateString())
    if (section === 'upcoming') result = result.filter((task) => task.dueDate && task.dueDate >= localDateString())
    if (section === 'completed') result = result.filter((task) => task.isCompleted)
    if (section === 'inbox') result = result.filter((task) => !task.isCompleted)
    if (filter === 'open') result = result.filter((task) => !task.isCompleted)
    if (filter === 'high') result = result.filter((task) => task.priority === 'high')
    if (filter === 'overdue') result = result.filter((task) => task.dueDate && task.dueDate < localDateString() && !task.isCompleted)
    if (filter.startsWith('tag:')) result = result.filter((task) => task.tag.toLowerCase() === filter.slice(4).toLowerCase())
    const query = search.trim().toLowerCase()
    const advancedTerms = [...query.matchAll(/(?:^|\s)(priority|due|tag):([^\s]+)/g)]
    const plainQuery = query.replace(/(?:^|\s)(priority|due|tag):([^\s]+)/g, ' ').trim()
    if (plainQuery) result = result.filter((task) => `${task.title} ${task.tag} ${task.project}`.toLowerCase().includes(plainQuery))
    if (advancedTerms.length) {
      const today = localDateString()
      const threeDaysFromNow = dateAfterDays(3)
      result = result.filter((task) => advancedTerms.every(([, field, value]) => {
        if (field === 'priority') return task.priority === value
        if (field === 'tag') return task.tag.toLowerCase() === value.replace(/^#/, '')
        if (field === 'due' && value === 'today') return task.dueDate === today
        if (field === 'due' && value === 'overdue') return Boolean(task.dueDate && task.dueDate < today && !task.isCompleted)
        if (field === 'due' && value === 'next-3-days') return Boolean(task.dueDate && task.dueDate >= today && task.dueDate <= threeDaysFromNow)
        return false
      }))
    }
    return result
  }, [tasks, section, filter, search])

  const completedToday = tasks.filter((task) => task.isCompleted && task.completedAt?.slice(0, 10) === localDateString()).length
  const dueToday = tasks.filter((task) => !task.isCompleted && task.dueDate === localDateString()).length
  const totalFocusHours = tasks.reduce((total, task) => total + task.secondsSpent, 0) / 3600
  const completionRate = tasks.length ? Math.round(tasks.filter((task) => task.isCompleted).length / tasks.length * 100) : 0
  const streak = calculateStreak(tasks)
  const weeklyStats = getWeeklyStats(tasks)
  const pomodoroTaskTitle = tasks.find((task) => task.id === pomodoroTask)?.title
  const sectionTitle = section === 'inbox' ? 'My tasks' : section[0].toUpperCase() + section.slice(1)

  function renderTask(task, depth = 0) {
    return (
      <TaskCard
        key={task.id}
        task={task}
        depth={depth}
        tasks={tasks}
        subtasks={childrenByParent.get(task.id) ?? []}
        isExpanded={expanded === task.id}
        childValue={childInput[task.id] ?? ''}
        isDependencyPath={(fromId, targetId) => hasDependencyPath(tasks, fromId, targetId)}
        onToggleTask={() => toggleTask(task)}
        onToggleDetails={() => setExpanded(expanded === task.id ? '' : task.id)}
        onUpdate={(changes) => patchTask(task.id, changes)}
        onStartFocus={() => startTimer(task)}
        onBreakdown={() => breakTaskDown(task)}
        onDelete={() => deleteTask(task.id)}
        onChildChange={(value) => setChildInput((current) => ({ ...current, [task.id]: value }))}
        onAddSubtask={() => addSubtask(task)}
        formatDate={formatDueDate}
        today={localDateString()}
        renderTask={renderTask}
      />
    )
  }

  function renderBoard() {
    const columns = [
      { key: false, title: 'To do', list: topLevelTasks.filter((task) => !task.isCompleted) },
      { key: true, title: 'Completed', list: topLevelTasks.filter((task) => task.isCompleted) },
    ]
    return <div className="board-grid">{columns.map((column) => <section className="board-column" key={column.title}><h3>{column.title}<span>{column.list.length}</span></h3>{column.list.map((task) => renderTask(task))}{!column.list.length && <p className="empty-column">Nothing here yet</p>}</section>)}</div>
  }

  function renderCalendar() {
    const today = calendarToday
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    const startOffset = (monthStart.getDay() + 6) % 7
    const days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    return <div className="calendar-view"><div className="calendar-month">{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(today)}<button className="small-button" onClick={exportCalendar}>Export .ics</button></div><div className="calendar-grid">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <div className="calendar-weekday" key={day}>{day}</div>)}{Array.from({ length: startOffset }, (_, index) => <div className="calendar-day empty-day" key={`empty-${index}`} />)}{Array.from({ length: days }, (_, index) => { const date = new Date(today.getFullYear(), today.getMonth(), index + 1); const dateKey = localDateString(date); const dayTasks = tasks.filter((task) => task.dueDate === dateKey); return <div className={`calendar-day ${dateKey === localDateString() ? 'today-cell' : ''}`} key={dateKey}><span>{index + 1}</span>{dayTasks.map((task) => <button className={`calendar-task ${task.isCompleted ? 'calendar-task-done' : ''}`} key={task.id} title={task.title} onClick={() => { setExpanded(task.id); setView('list') }}>{task.title}</button>)}</div> })}</div></div>
  }

  function renderTimeline() {
    const scheduled = topLevelTasks.filter((task) => task.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    return <div className="timeline-view">{scheduled.map((task) => <div className="timeline-item" key={task.id}><div className="timeline-date">{formatDueDate(task.dueDate, task.dueTime)}</div><div className="timeline-marker" /><div className="timeline-content">{renderTask(task)}</div></div>)}{!scheduled.length && <div className="empty-state">Add a due date to a task to see it on your timeline.</div>}</div>
  }

  const visibleTasks = topLevelTasks

  return (
    <div className="app-shell">
      <Navbar />
      <div className="workspace">
        <aside className="sidebar">
          <div className="workspace-label"><span className="workspace-avatar">T</span><div><strong>Personal space</strong><small>My workspace</small></div><span className="chevron">⌄</span></div>
          <button className="new-task-button" onClick={() => document.querySelector('#task-input')?.focus()}><span>＋</span> New task <kbd>Ctrl N</kbd></button>
          <nav className="side-nav" aria-label="Task lists">
            <button className={section === 'inbox' ? 'active' : ''} onClick={() => { setSection('inbox'); setView('list') }}><span>▣</span> My tasks <b>{tasks.filter((task) => !task.isCompleted && !task.parentId).length}</b></button>
            <button className={section === 'today' ? 'active' : ''} onClick={() => { setSection('today'); setView('list') }}><span>◷</span> Today <b>{dueToday}</b></button>
            <button className={section === 'upcoming' ? 'active' : ''} onClick={() => { setSection('upcoming'); setView('list') }}><span>▦</span> Upcoming</button>
            <button className={section === 'completed' ? 'active' : ''} onClick={() => { setSection('completed'); setView('list') }}><span>✓</span> Completed</button>
          </nav>
          <div className="sidebar-heading">VIEWS</div>
          <nav className="side-nav view-nav" aria-label="Task views">{Object.entries(viewLabels).map(([key, label]) => <button className={view === key ? 'active' : ''} key={key} onClick={() => setView(key)}><span>{key === 'list' ? '☷' : key === 'board' ? '▥' : key === 'calendar' ? '▦' : '⌁'}</span>{label}</button>)}</nav>
          <div className="sidebar-heading">QUICK FILTERS</div>
          <nav className="side-nav"><button onClick={() => { setFilter('high'); setSection('inbox') }}><span className="filter-dot red" /> High priority</button><button onClick={() => { setFilter('overdue'); setSection('inbox') }}><span className="filter-dot amber" /> Overdue</button><button onClick={() => { setFilter('open'); setSection('inbox') }}><span className="filter-dot blue" /> Incomplete</button></nav>
          <div className="sidebar-bottom"><div className={`sync-status ${online ? 'online' : ''}`}><span />{online ? 'Offline-ready' : 'Offline · changes saved locally'}</div><small>Keyboard shortcuts: <kbd>Ctrl K</kbd> search · <kbd>Esc</kbd> clear</small><button className="account-button" onClick={saveAndSignOut}>Sign out · {user.email}</button>{role === 'admin' && <button className="account-button" onClick={onOpenAdmin}>Admin dashboard</button>}</div>
        </aside>

        <main className="main-content">
          <header className="page-header"><div><div className="breadcrumb">Personal space <span>/</span> {sectionTitle}</div><h1>{sectionTitle}<span className="heading-count">{topLevelTasks.length}</span></h1></div><div className="header-actions"><div className={`connection-pill ${online ? '' : 'offline'}`}><span />{cloudStatus === 'synced' ? 'Cloud synced' : cloudStatus === 'offline' ? 'Saved offline' : cloudStatus === 'connecting' ? 'Connecting…' : 'On this device'}</div><button className="avatar-button" aria-label="Open productivity insights" onClick={() => setSection('insights')}>{user.email?.[0]?.toUpperCase() ?? 'A'}</button></div></header>
          {section === 'insights' ? (
            <section className="insights-page"><h2>Your productivity</h2><p className="muted">A weekly snapshot calculated from your local task history.</p><div className="stats-grid"><div className="stat-card"><span>Completed today</span><strong>{completedToday}</strong><small>Daily goal: {workspace.dailyGoal}</small></div><div className="stat-card"><span>Completion rate</span><strong>{completionRate}%</strong><small>All-time tasks</small></div><div className="stat-card"><span>Focus time</span><strong>{totalFocusHours.toFixed(1)}h</strong><small>Tracked across tasks</small></div><div className="stat-card"><span>Due today</span><strong>{dueToday}</strong><small>Keep your momentum</small></div><div className="stat-card"><span>Completion streak</span><strong>{streak} day{streak === 1 ? '' : 's'}</strong><small>Consecutive active days</small></div></div><div className="report-card"><h3>Last 7 days</h3><p>{weeklyStats.completedCount} task{weeklyStats.completedCount === 1 ? '' : 's'} completed · {weeklyStats.missedCount} overdue task{weeklyStats.missedCount === 1 ? '' : 's'} still open{weeklyStats.mostProductiveHour !== undefined ? ` · Most focused around ${formatHour(weeklyStats.mostProductiveHour)}` : ''}.</p><div className="report-bar"><span style={{ width: `${completionRate}%` }} /></div><small>{completionRate}% of all your tasks are complete</small></div><div className="report-card"><h3>Time by tag</h3>{weeklyStats.timeByTag.length ? weeklyStats.timeByTag.map(({ tag, seconds, percent }) => <div className="time-distribution" key={tag}><div className="distribution-row"><span>#{tag}</span><strong>{(seconds / 3600).toFixed(1)}h</strong></div><div className="report-bar"><span style={{ width: `${percent}%` }} /></div></div>) : <p className="muted">Add a #tag and track focus time to see where your time goes.</p>}</div></section>
          ) : (
            <>
              <section className="overview-strip"><div className="overview-item"><span className="overview-icon purple">✦</span><div><strong>{completedToday}<small> / {workspace.dailyGoal}</small></strong><span>Daily progress</span></div></div><div className="overview-item"><span className="overview-icon orange">◷</span><div><strong>{dueToday}</strong><span>Due today</span></div></div><div className="overview-item"><span className="overview-icon green">◉</span><div><strong>{totalFocusHours.toFixed(1)}h</strong><span>Focus time</span></div></div><div className="goal-control"><span>Daily goal</span><input aria-label="Daily completion goal" type="number" min="1" max="99" value={workspace.dailyGoal} onChange={(event) => setWorkspace((current) => ({ ...current, dailyGoal: Math.max(1, Number(event.target.value)) }))} /></div></section>
              <form className="quick-add" onSubmit={addTask}><span className="quick-add-icon">＋</span><input id="task-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Add a task… try “Meet John tomorrow at 4 PM #work”" aria-label="New task" /><button type="submit">Add task</button></form>
              <div className="parser-hint"><span>✦</span> Try natural language: <strong>tomorrow</strong>, <strong>at 4 PM</strong>, <strong>#work</strong> · search supports <strong>priority:high due:next-3-days tag:code</strong></div>
              <div className="task-toolbar"><div className="toolbar-title">{view === 'list' ? 'Tasks' : `${viewLabels[view]} view`}<span>{visibleTasks.length}</span></div><div className="toolbar-controls"><label className="search-control"><span>⌕</span><input id="task-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks" /><kbd>Ctrl K</kbd></label><select value={filter} aria-label="Filter tasks" onChange={(event) => setFilter(event.target.value)}><option value="all">All tasks</option><option value="open">Incomplete</option><option value="high">High priority</option><option value="overdue">Overdue</option>{[...new Set(tasks.map((task) => task.tag).filter(Boolean))].map((tag) => <option key={tag} value={`tag:${tag}`}>#{tag}</option>)}</select><button className="icon-button" aria-label="Open productivity insights" onClick={() => setSection('insights')}>↗</button></div></div>
              {storageError && <div className="error-banner" role="alert">{storageError}</div>}
              {!loaded ? <div className="empty-state">Loading your workspace…</div> : view === 'board' ? renderBoard() : view === 'calendar' ? renderCalendar() : view === 'timeline' ? renderTimeline() : <div className="task-list">{topLevelTasks.map((task) => renderTask(task))}{topLevelTasks.length === 0 && <div className="empty-state"><span>✦</span><strong>{tasks.length ? 'Nothing matches this view' : 'A clear head starts here'}</strong><p>{tasks.length ? 'Try changing your filters or search.' : 'Add your first task above. Use a date, time, or #tag and we’ll pick it up.'}</p></div>}</div>}
              {view === 'calendar' && <div className="calendar-notice">Calendar export creates an .ics file you can import into Google Calendar, Outlook, or Apple Calendar. Live two-way sync needs a connected provider account.</div>}
              <div className="save-filter"><input value={savedFilterName} onChange={(event) => setSavedFilterName(event.target.value)} placeholder="Name this perspective…" /><button className="small-button" onClick={() => { if (!savedFilterName.trim()) return; setWorkspace((current) => ({ ...current, savedFilters: [...current.savedFilters, { id: makeId(), name: savedFilterName.trim(), filter, search }] })); setSavedFilterName('') }}>Save perspective</button>{workspace.savedFilters.map((saved) => <button className="saved-filter-chip" key={saved.id} onClick={() => { setFilter(saved.filter); setSearch(saved.search); setSection('inbox') }}>{saved.name}</button>)}</div>
            </>
          )}

          <section className="settings-row"><div><h3>Focus & reminders</h3><p>Pomodoro sessions and reminder settings are saved on this device.</p></div><label>Focus length <select value={workspace.pomodoroLength} onChange={(event) => setWorkspace((current) => ({ ...current, pomodoroLength: Number(event.target.value) }))}><option value="15">15 min</option><option value="25">25 min</option><option value="40">40 min</option><option value="50">50 min</option></select></label><button className="small-button" onClick={requestNotifications}>Enable notifications</button><button className={`small-button ${workspace.digestEnabled ? 'active-button' : ''}`} onClick={() => setWorkspace((current) => ({ ...current, digestEnabled: !current.digestEnabled }))}>{workspace.digestEnabled ? 'Morning digest on' : 'Enable morning digest'}</button><button className="small-button" onClick={exportCalendar}>Export calendar</button></section>
          <div className="integration-note">Google/Outlook/Apple live calendar sync, Android APK sync, hosted AI task breakdown, and geolocation alerts need provider credentials or a backend. This workspace includes local .ics export, on-device task breakdown, and browser reminders while the app is open.</div>
        </main>
      </div>
      {pomodoroTask && <aside className="focus-widget"><span className="focus-pulse" /><div><strong>{timerRunning ? 'Focus session' : 'Focus paused'}</strong><small>{pomodoroTaskTitle}</small></div><time>{String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:{String(secondsLeft % 60).padStart(2, '0')}</time><button onClick={() => setTimerRunning((current) => !current)}>{timerRunning ? 'Pause' : 'Resume'}</button><button className="focus-stop" onClick={stopTimer}>Stop</button></aside>}
      <footer className="app-footer"><span>{online ? 'All changes saved on this device' : 'You’re offline · changes will stay on this device'}</span><button onClick={() => setSection('insights')}>Productivity insights <span>↗</span></button><span className="notification-state">{notificationStatus === 'granted' ? 'Notifications enabled' : notificationStatus === 'unsupported' ? 'Notifications unavailable' : ''}</span></footer>
    </div>
  )
}

export default TaskWorkspace
