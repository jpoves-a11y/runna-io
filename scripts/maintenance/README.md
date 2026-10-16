# Maintenance scripts

One-off scripts that query or fix data directly in the production Turso database.
They read the credentials from the environment instead of having them in the code.

PowerShell (Windows):

```powershell
$env:TURSO_PIPELINE_URL = "https://<your-db>.turso.io/v3/pipeline"
$env:TURSO_AUTH_TOKEN = "<token>"
node scripts/maintenance/debug-query.js
```

bash / zsh:

```bash
TURSO_PIPELINE_URL="https://<your-db>.turso.io/v3/pipeline" TURSO_AUTH_TOKEN="<token>" node scripts/maintenance/debug-query.js
```

Many of them were written for a specific incident (hard-coded user or route IDs): read a script before running it.

Older scripts moved here from the repository root (run them from the repository root):

- `migrate.js`: applies `migrations/0000_empty_lyja.sql` to the database in `DATABASE_URL` / `TURSO_AUTH_TOKEN`.
- `migrate-colors.js`: reassigns user colours to the accessible palette without two friends sharing one.
- `calculate-spawn-time.js`: prints the treasure spawn hour for a date and competition id.
- `check-treasure-distance.js`: checks a route's distance to the active treasures against the production API.
