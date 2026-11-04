# WebMCP Bridge

**Turn websites into agent tools, without waiting for the owner.**

Meta's WebMCP and Meta AI Connectors only work when a site owner adds tools, and most sites never will. The usual workaround is a browser agent that runs a model on every click. WebMCP Bridge explores a site once and compiles what a person can do there into typed, tested tools. After that, agents call those tools with no model per click.

## How Meta's models are used

| Model | Job | When it runs |
|---|---|---|
| Muse Spark 1.3 | Explores the site, writes tools and tests, and reads canvas pages | Compile time |
| SAM 3.1 | Finds controls that exist only as pixels | Compile time |
| Muse Spark 1.3 | Runs the chat conversation | Only when someone uses chat |
| No model | Calling tools, and running the tests that decide which tools ship | Every call |

## How it works

**Network path, for sites with an API behind the page**
1. Spark drives a real browser toward your goal and runs the action twice with different inputs.
2. Plain code keeps the successful JSON requests and removes page noise.
3. Spark proposes tools: names, the few inputs an agent needs, and tests.
4. Plain code runs the tests. A tool ships only if every test passes and different inputs give different results.

**Pixel path, for pages drawn on a canvas**
1. Spark reads the screenshot and legend, then chooses a SAM prompt.
2. SAM 3.1 finds the controls, and plain code names them by grid position.
3. Each state's colour is measured from the page. At run time, plain code reads pixels and clicks coordinates.

## Measured results

One run per task on Nov 5, 2026. Correct answers came from the pages themselves, not from either agent. This is a small sample.

| Task | Compiled tool | Spark clicking screenshots |
|---|---|---|
| Top HN story for "rust" | ✓ 0.38s, no model | ✓ 14.2s, 3 steps, $0.0061 |
| Top HN story for "postgres" | ✓ 0.36s, no model | ✓ 14.6s, 3 steps, $0.0074 |
| Top HN story for "webassembly" | ✓ 0.36s, no model | ✓ 16.5s, 3 steps, $0.0091 |
| List every free seat on a canvas | ✓ 0.77s, no model | ✓ 6.4s, 1 step, $0.0038 |
| Select one seat on a canvas | ✓ 0.99s, no model | ✓ 49.6s, 5 steps, $0.0238 |

Both approaches got all 5 tasks right, so the difference is speed and cost per call. Compiling once cost $0.027 for Hacker News and $0.016 for the seat map. Compiled-tool times are direct calls: using chat adds Spark's own time and cost.

## Limits enforced in code

- Clicks on buttons such as buy, pay, delete, log in and sign up are blocked during exploration.
- Password fields are never filled. Exploration stops at a captcha.
- Only read-only API tools ship.
- Parameters with names like key, token or session are never exposed to agents, and are redacted before Spark sees them.
- Compiling stops when estimated Meta spend reaches `META_BUDGET_USD` (default $15).

## Known limits

- Sites that need a login, or that block replayed requests, will not compile.
- URL path parameters are not supported yet, only query and body parameters.
- Pixel tools assume grid-like layouts and that each state has its own colour.
- SAM 3.1 results depend on the prompt and on how recognisable the control is. It found no flat square seats when asked for "seat", but found all 60 chair-shaped seats.
- Self-healing after a redesign is not built.
- The server has no authentication, so run it locally or add auth before exposing it.

## Run it

```bash
npm install
npx playwright install chromium
echo 'MODEL_API_KEY=your_key_here' >> .env.local
npm run dev
```

Open http://localhost:3000. **Compiling and chatting spend Meta API credit.** Calling a compiled tool directly uses no model.

## Tests

```bash
npx tsx scripts/test-free.ts                                 # free: uses a local mock of the Meta API
npx tsx --env-file=.env.local scripts/smoke.ts --confirm     # paid: checks each real API feature
npx tsx --env-file=.env.local scripts/benchmark.ts --confirm # paid: compiled tools vs a screenshot agent
```

The mock tests prove the plumbing, not model quality.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/compile` | Compile a site, streaming progress |
| `POST /api/mcp/[siteId]` | MCP server: `initialize`, `tools/list`, `tools/call` |
| `GET /api/webmcp/[siteId]` | WebMCP registration script |
| `POST /api/sites/[siteId]/call` | Call a tool directly |
| `POST /api/chat` | Spark chat, with tool calls sent through MCP |
| `GET /api/usage` | Requests and estimated spend |
