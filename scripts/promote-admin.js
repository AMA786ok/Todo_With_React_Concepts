import fs from 'node:fs/promises'
import path from 'node:path'
import 'dotenv/config'

const email = String(process.argv[2] ?? '').trim().toLowerCase()
if (!email) {
  console.error('Usage: npm run admin:promote -- person@example.com')
  process.exitCode = 1
} else {
  const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'))
  const dataFile = path.join(dataDirectory, 'taskflow.json')
  try {
    const store = JSON.parse(await fs.readFile(dataFile, 'utf8'))
    const user = store.users.find((item) => item.email === email)
    if (!user) {
      console.error(`No account found for ${email}. Create the account first.`)
      process.exitCode = 1
    } else {
      user.role = 'admin'
      const temporaryFile = `${dataFile}.tmp`
      await fs.writeFile(temporaryFile, JSON.stringify(store), { mode: 0o600 })
      await fs.rename(temporaryFile, dataFile)
      console.log(`Admin access granted to ${email}. Sign out and back in to refresh the session.`)
    }
  } catch (error) {
    console.error(`Could not update the admin account: ${error.message}`)
    process.exitCode = 1
  }
}
