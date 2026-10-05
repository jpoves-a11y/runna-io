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
