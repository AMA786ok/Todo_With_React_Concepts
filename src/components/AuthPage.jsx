import { useState } from 'react'
import Navbar from './Navbar'
import { apiRequest } from '../lib/api'

function AuthPage({ onAuthenticated }) {
  const [mode, setMode] = useState('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const endpoint = mode === 'sign-in' ? '/api/auth/login' : '/api/auth/signup'
      const result = await apiRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      onAuthenticated(result.user)
    } catch (submitError) {
      setError(submitError.message || 'Could not sign in. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  function changeMode() {
    setMode((current) => current === 'sign-in' ? 'sign-up' : 'sign-in')
    setError('')
    setMessage('')
  }

  return (
    <div className="auth-shell">
      <Navbar />
      <main className="auth-main">
        <section className="auth-card">
          <span className="auth-symbol">✓</span>
          <p className="auth-eyebrow">YOUR PERSONAL WORKSPACE</p>
          <h1>{mode === 'sign-in' ? 'Welcome back' : 'Create your account'}</h1>
          <p className="auth-description">Sign in to keep your tasks private and synced to your account.</p>
          <form className="auth-form" onSubmit={submit}>
            <label>Email address<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
            <label>Password<input type="password" autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} minLength="8" maxLength="128" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" /></label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            {message && <p className="auth-message" role="status">{message}</p>}
            <button className="auth-submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}</button>
          </form>
          <p className="auth-switch">{mode === 'sign-in' ? 'New to TaskFlow?' : 'Already have an account?'}{' '}
            <button onClick={changeMode}>{mode === 'sign-in' ? 'Create an account' : 'Sign in'}</button>
          </p>
          <p className="auth-security">Passwords are hashed on the server. Your session is stored in a secure, HTTP-only cookie.</p>
        </section>
      </main>
      <footer className="auth-footer">A focused place to plan your day.</footer>
    </div>
  )
}

export default AuthPage
