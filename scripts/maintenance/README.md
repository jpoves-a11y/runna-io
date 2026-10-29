# Maintenance scripts

One-off scripts that query or fix data directly in the production Turso database.
They read the credentials from the environment instead of having them in the code.

PowerShell (Windows):

```powershell
$env:TURSO_PIPELINE_URL = "https://<your-db>.turso.io/v3/pipeline"
$env:TURSO_AUTH_TOKEN = "<token>"
node scripts/maintenance/fix-feed-areas.js
```

bash / zsh:

```bash
TURSO_PIPELINE_URL="https://<your-db>.turso.io/v3/pipeline" TURSO_AUTH_TOKEN="<token>" node scripts/maintenance/fix-feed-areas.js
```

Read a script before running it: they change production data. Scripts written for a specific incident (with real user or route IDs) are not kept in the repository.

Older scripts moved here from the repository root (run them from the repository root):

- `migrate.js`: applies `migrations/0000_empty_lyja.sql` to the database in `DATABASE_URL` / `TURSO_AUTH_TOKEN`.
- `migrate-colors.js`: reassigns user colours to the accessible palette without two friends sharing one.
- `calculate-spawn-time.js`: prints the treasure spawn hour for a date and competition id.
