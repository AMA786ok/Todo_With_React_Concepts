# TaskFlow

TaskFlow is a task manager built with React, Vite, and a small Node.js server. Login, account roles, and task sync are handled by the server, so the browser no longer connects to Supabase.

## Run locally

1. Install Node.js 20.19+ or 22.12+.
2. Run `npm install`.
3. Copy `.env.example` to `.env`. Set `TASKFLOW_ADMIN_EMAIL` to the email address that should have admin access.
4. Run `npm run dev` to start the API and web app together.
5. Open the Vite URL printed in the terminal and create your account with the admin email.

The first account is not automatically made admin. Only the email you configure as `TASKFLOW_ADMIN_EMAIL` gets admin access when it signs up.

## Promote an existing account

Stop the server, then run:

```text
npm run admin:promote -- person@example.com
```

Start the server again and sign out/in to refresh the account role.

## Hosting

Host this as a Node.js web service, not a static-only site. Set the build command to `npm run build`, the start command to `npm start`, and provide a persistent disk mounted to `DATA_DIR` (for example `/var/data`). Set `TASKFLOW_ADMIN_EMAIL` as a private environment variable on the host. The Node server serves the built web app and API from the same domain, so login cookies work without cross-site browser requests.

Use HTTPS in production. The server uses an HTTP-only, SameSite cookie, hashes passwords with scrypt, limits repeated login attempts, and checks admin permissions for admin endpoints. Keep the data directory private and backed up. The JSON data file is intended for a small, single-server deployment; use a managed database before running multiple server instances or scaling to many users.

## Where to make changes

- `src/App.jsx`: signed-in user state and page selection.
- `src/components/AuthPage.jsx`: sign-in and account creation form.
- `src/components/AdminPage.jsx`: account listing and role controls.
- `src/components/TaskCard.jsx`: task row, details, dependencies, and subtasks.
- `src/pages/TaskWorkspace.jsx`: tasks, views, offline storage, and focus timer.
- `server.js`: login API, sessions, workspace sync, and server-side admin checks.
- `src/index.css`: shared layout, colors, and responsive styles.

## Checks

- `npm run lint`
- `npm run build`
- `npm start` to serve the built app and API together
