# Genie Azure Function App

This project runs a Node.js Azure Function locally in VS Code and deploys it back to Azure after validation.

## Project structure

```text
Genie/
├── src/
│   └── functions/
│       └── genieQuery.js
├── .vscode/
│   ├── launch.json
│   └── tasks.json
├── host.json
├── package.json
└── local.settings.json
```

## Local setup

1. Install dependencies with `npm install`.
2. Enter your Databricks keys in `.env`.
3. Keep `local.settings.json` for Azure Functions runtime settings like storage and debugger options.
4. Start local storage with `npm run storage` or let the VS Code task start Azurite for you.
5. Start the function host with `npm start` or `func start`.
6. Debug in VS Code using the `Attach to Azure Functions` launch configuration.

`AzureWebJobsStorage` points at Azurite locally. If Azurite is not running, the host can still discover the HTTP route but it will report unhealthy storage checks.

## Local request example

```bash
curl -X POST http://localhost:7071/api/genie-query \
  -H "Content-Type: application/json" \
  -H "x-correlation-id: local-debug-001" \
  -d "{\"question\":\"Show total sales by month\"}"
```

## Environment variables

Application secrets can live in `.env`. Azure Functions host settings still belong in `local.settings.json`.

- `DATABRICKS_INSTANCE`: Databricks workspace URL without trailing slash.
- `GENIE_SPACE_ID`: Genie space identifier.
- `DATABRICKS_TOKEN`: Personal access token or service principal token.
- `ALLOWED_ORIGIN`: Frontend origin for local CORS.
- `GENIE_POLL_INTERVAL_MS`: Delay between status polls.
- `GENIE_MAX_POLL_ATTEMPTS`: Maximum number of polling attempts.
- `GENIE_QUERY_RESULT_DELAY_MS`: Delay before fetching attachment query results.
- `GENIE_FETCH_TIMEOUT_MS`: Timeout for each Databricks API request.
- `INCLUDE_ATTACHMENT_DEBUG`: Set to `true` to return raw attachments in the response.

## Deployment

Use one of these options:

### Azure Functions extension in VS Code

1. Sign in to Azure in VS Code.
2. Right-click the function project.
3. Choose `Deploy to Function App`.
4. Select the existing Function App.

### Core Tools CLI

```bash
func azure functionapp publish <your-function-app-name>
```

Before publishing, keep `local.settings.json` out of source control and configure the same app settings in Azure Function App Configuration.

## Attachment handling guidance

- Treat `results[].visualization` as the source for renderable images or charts in React.
- Treat `results[].data` as structured table/query data.
- Keep `INCLUDE_ATTACHMENT_DEBUG=false` outside local debugging so raw payloads do not leak into the frontend.
- For signed image URLs, render them directly in the browser and avoid proxying unless your frontend cannot reach Databricks.
- If charts arrive without a direct image URL, log the raw attachment locally and adapt `summarizeAttachment` to the exact payload shape from your Genie workspace.

## Scalability notes

- HTTP-trigger polling is acceptable for short Genie queries.
- For long-running queries or high throughput, move polling into Durable Functions or a queue-backed worker pattern.
- Add Application Insights in Azure so request IDs from the frontend map to backend traces.
