import { useEffect, useState } from "react";
import Navbar from "./Navbar";
import { apiRequest } from "../lib/api";

function AdminPage({ user, onBack }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState("");

  async function loadUsers() {
    try {
      const result = await apiRequest("/api/admin/users");
      setUsers(result.users);
    } catch (loadError) {
      setError(loadError.message || "Could not load accounts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    apiRequest("/api/admin/users")
      .then((result) => {
        if (active) setUsers(result.users);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || "Could not load accounts.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function changeRole(profile) {
    setSavingId(profile.id);
    setError("");
    const nextRole = profile.role === "admin" ? "user" : "admin";
    try {
      const result = await apiRequest(
        `/api/admin/users/${encodeURIComponent(profile.id)}/role`,
        {
          method: "PATCH",
          body: JSON.stringify({ role: nextRole }),
        },
      );
      setUsers((current) =>
        current.map((item) => (item.id === profile.id ? result.user : item)),
      );
    } catch (updateError) {
      setError(updateError.message || "Could not update the role.");
    } finally {
      setSavingId("");
    }
  }

  return (
    <div className="admin-shell">
      <Navbar />
      <main className="admin-main">
        <button className="admin-back" onClick={onBack}>
          ← Back to tasks
        </button>
        <div className="admin-heading">
          <div>
            <p className="auth-eyebrow">WORKSPACE MANAGEMENT</p>
            <h1>Admin dashboard</h1>
            <p>Signed in as {user.email}</p>
          </div>
          <span className="admin-badge">Admin access</span>
        </div>
        <section className="admin-panel">
          <div className="admin-panel-heading">
            <div>
              <h2>Accounts</h2>
              <p>Manage the role assigned to each registered account.</p>
            </div>
            <button
              className="small-button"
              onClick={() => {
                setLoading(true);
                setError("");
                loadUsers();
              }}
            >
              Refresh
            </button>
          </div>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p className="muted">Loading accounts…</p>
          ) : users.length === 0 ? (
            <p className="muted">No accounts found.</p>
          ) : (
            <div className="profile-list">
              {users.map((profile) => (
                <div className="profile-row" key={profile.id}>
                  <span className="profile-avatar">
                    {profile.email?.[0]?.toUpperCase() ?? "?"}
                  </span>
                  <div className="profile-info">
                    <strong>{profile.email}</strong>
                    <small>
                      Joined{" "}
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: "medium",
                      }).format(new Date(profile.createdAt))}
                    </small>
                  </div>
                  <span
                    className={`role-pill ${profile.role === "admin" ? "admin-role" : ""}`}
                  >
                    {profile.role}
                  </span>
                  <button
                    className="small-button"
                    disabled={savingId === profile.id || profile.id === user.id}
                    title={
                      profile.id === user.id
                        ? "You cannot change your own role here."
                        : ""
                    }
                    onClick={() => changeRole(profile)}
                  >
                    {savingId === profile.id
                      ? "Saving…"
                      : profile.role === "admin"
                        ? "Make user"
                        : "Make admin"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        <p className="admin-security">
          The server checks your role before listing accounts or changing roles.
        </p>
      </main>
    </div>
  );
}

export default AdminPage;
