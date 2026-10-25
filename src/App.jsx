import { useEffect, useState } from 'react'
import AdminPage from './components/AdminPage'
import AuthPage from './components/AuthPage'
import TaskWorkspace from './pages/TaskWorkspace'
import { apiRequest } from './lib/api'

function App() {
  const [user, setUser] = useState(null)
  const [page, setPage] = useState('tasks')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    apiRequest('/api/auth/me').then(({ user: currentUser }) => {
      if (active) setUser(currentUser)
    }).catch((requestError) => {
      if (requestError.message !== 'Not signed in.') {
        console.error('Could not restore the sign-in session.', requestError)
        if (active) setError(`${requestError.message} Make sure the TaskFlow server is running.`)
      }
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  async function signOut() {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
      setUser(null)
      setPage('tasks')
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  if (loading) return <div className="auth-loading">Loading your secure workspace…</div>
  if (error && !user) return <main className="auth-loading"><p className="auth-error">{error}</p><button className="small-button" onClick={() => window.location.reload()}>Try again</button></main>
  if (!user) return <AuthPage onAuthenticated={setUser} />
  if (page === 'admin' && user.role === 'admin') return <AdminPage user={user} onBack={() => setPage('tasks')} />
  return <TaskWorkspace user={user} role={user.role} onLogout={signOut} onOpenAdmin={() => setPage('admin')} />
}

export default App
