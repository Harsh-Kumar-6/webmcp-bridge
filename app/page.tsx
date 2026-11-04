"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompileRecord, CompiledTool, ExploreStep } from "@/lib/types";

const PASSWORD_REQUIRED =
  process.env.NEXT_PUBLIC_DEMO_MODE === "1" && process.env.NEXT_PUBLIC_REQUIRE_PASSWORD === "1";
const DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

type Usage = { requests: number; spentUsd: number; budgetUsd: number };

async function readNdjson(res: Response, onEvent: (event: Record<string, unknown>) => void) {
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed with status ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
  }
}

const money = (n: number) => `$${n < 0.1 ? n.toFixed(4) : n.toFixed(2)}`;

const PRESETS = [
  { label: "Hacker News", url: "https://hn.algolia.com/", goal: "search stories by keyword" },
  {
    label: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    goal: "Find Wikipedia articles by keyword: type a topic into the search box and wait for the suggestions without pressing Enter, then repeat with a different topic. Return matching article titles and short descriptions",
  },
  { label: "Canvas seat map", url: "/demo/seats.html", goal: "find free seats and select one" },
];

export default function Page() {
  const [url, setUrl] = useState(PRESETS[0].url);
  const [goal, setGoal] = useState(PRESETS[0].goal);
  const [logs, setLogs] = useState<string[]>([]);
  const [steps, setSteps] = useState<ExploreStep[]>([]);
  const [record, setRecord] = useState<CompileRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sites, setSites] = useState<CompileRecord[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [password, setPassword] = useState("");

  const refresh = useCallback(async () => {
    const [sitesRes, usageRes] = await Promise.all([fetch("/api/sites"), fetch("/api/usage")]);
    if (sitesRes.ok) {
      const loaded = ((await sitesRes.json()) as { sites: CompileRecord[] }).sites;
      setSites(loaded);
      if (DEMO && loaded[0]) {
        setRecord((current) => current ?? loaded[0]);
        setLogs((current) => (current.length ? current : loaded[0].logs));
      }
    }
    if (usageRes.ok) setUsage((await usageRes.json()) as Usage);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function compile() {
    setBusy(true);
    setLogs([]);
    setSteps([]);
    setRecord(null);
    setError(null);
    try {
      const res = await fetch("/api/compile", {
        method: "POST",
        headers: { "content-type": "application/json", "x-access-password": password },
        body: JSON.stringify({ url: new URL(url, window.location.origin).toString(), goal }),
      });
      await readNdjson(res, (event) => {
        if (event.type === "log") setLogs((l) => [...l, event.line as string]);
        if (event.type === "step") setSteps((s) => [...s, event.step as ExploreStep]);
        if (event.type === "done") setRecord(event.record as CompileRecord);
        if (event.type === "error") setError(event.message as string);
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  function openSite(site: CompileRecord) {
    setRecord(site);
    setLogs(site.logs);
    setSteps(site.steps);
    setError(null);
    setUrl(site.url);
    setGoal(site.goal);
  }

  return (
    <main className="min-h-screen">
      <header className="border-b border-[var(--panel-border)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="font-semibold tracking-tight">WebMCP Bridge</div>
          {usage && <UsageMeter usage={usage} />}
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-2">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          Turn websites into agent tools, without waiting for the owner.
        </h1>
        <p className="text-[var(--muted)] mt-2 max-w-2xl">
          Meta&apos;s models explore a site once and write tools for what they find. Only tools that pass their tests
          ship, and calling one needs no model.
        </p>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-6 items-start">
        <div className="flex flex-col gap-6 min-w-0">
          <section className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <h2 className="panel-title">
                <span className="step-number">1</span>Compile a site once
              </h2>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    className="btn-ghost"
                    onClick={() => {
                      setUrl(preset.url);
                      setGoal(preset.goal);
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="block text-xs text-[var(--muted)] mb-1" htmlFor="url">
              Website
            </label>
            <input id="url" className="field mono mb-3" value={url} onChange={(e) => setUrl(e.target.value)} />
            <label className="block text-xs text-[var(--muted)] mb-1" htmlFor="goal">
              What should agents be able to do there?
            </label>
            <textarea
              id="goal"
              rows={2}
              className="field mb-4 resize-y"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
            {PASSWORD_REQUIRED && (
              <>
                <label className="block text-xs text-[var(--muted)] mb-1" htmlFor="password">
                  Password (compiling and chat use paid API credit)
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="off"
                  className="field mb-4"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="btn-primary inline-flex items-center gap-2"
                onClick={compile}
                disabled={busy || !url || !goal || (PASSWORD_REQUIRED && !password)}
              >
                {busy && <span className="spinner" aria-hidden="true" />}
                {busy ? "Compiling…" : "Compile"}
              </button>
              <span className="text-xs text-[var(--muted)]">Uses Muse Spark, and SAM 3.1 on canvas pages.</span>
            </div>
            {error && (
              <p role="alert" className="mt-4 text-sm text-[var(--bad)] break-words border border-[var(--bad)]/30 rounded-lg p-3">
                {error}
              </p>
            )}
          </section>

          {(busy || logs.length > 0) && <Trace logs={logs} steps={steps} busy={busy} failed={Boolean(error)} />}
          {record && <SiteView key={record.siteId + record.createdAt} record={record} password={password} />}
          <Benchmark />
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-4">
          <section className="panel p-4">
            <h2 className="panel-title text-sm mb-3">Compiled sites</h2>
            {sites.length === 0 && <p className="text-xs text-[var(--muted)]">Nothing compiled yet.</p>}
            <ul className="flex flex-col gap-1">
              {sites.map((site) => {
                const active = record?.siteId === site.siteId;
                return (
                  <li key={site.siteId}>
                    <button
                      aria-current={active ? "true" : undefined}
                      className={`text-left w-full rounded-lg px-2 py-1.5 cursor-pointer hover:bg-[var(--panel-border)] ${
                        active ? "bg-[var(--panel-border)]" : ""
                      }`}
                      onClick={() => openSite(site)}
                    >
                      <div className="text-sm truncate">{site.siteId}</div>
                      <div className="text-xs text-[var(--muted)]">
                        {site.tools.length} tool{site.tools.length === 1 ? "" : "s"} · {money(site.costUsd)} to compile
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="panel p-4">
            <h2 className="panel-title text-sm mb-2">Where Meta&apos;s models run</h2>
            <dl className="text-xs text-[var(--muted)] space-y-2">
              <div>
                <dt className="text-[var(--foreground)]">Muse Spark 1.3</dt>
                <dd>Explores the site, writes tools and tests, reads canvases and runs the chat.</dd>
              </div>
              <div>
                <dt className="text-[var(--foreground)]">SAM 3.1</dt>
                <dd>Finds controls that exist only as pixels.</dd>
              </div>
              <div>
                <dt className="text-[var(--foreground)]">No model</dt>
                <dd>Tool calls, and the tests that decide which tools ship.</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </main>
  );
}

function UsageMeter({ usage }: { usage: Usage }) {
  const percent = Math.min(100, (usage.spentUsd / usage.budgetUsd) * 100);
  return (
    <div className="text-xs text-[var(--muted)] w-44">
      <div className="flex justify-between mono mb-1">
        <span>Meta API {money(usage.spentUsd)}</span>
        <span>of ${usage.budgetUsd}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Meta API spending"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 rounded-full bg-[var(--panel-border)] overflow-hidden"
      >
        <div className="h-full bg-[var(--accent)]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

const STAGES = ["Open", "Explore", "Write tools", "Test", "Ready"];

function stageOf(logs: string[]): number {
  const text = logs.join("\n");
  if (/^Done:/m.test(text)) return 4;
  if (/shipped|rejected/.test(text)) return 3;
  if (/writing tools|segmenting/.test(text)) return 2;
  if (/exploring|pixel path/.test(text)) return 1;
  return 0;
}

function Trace({ logs, steps, busy, failed }: { logs: string[]; steps: ExploreStep[]; busy: boolean; failed: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);
  const shot = [...steps].reverse().find((s) => s.screenshot)?.screenshot;
  const stage = stageOf(logs);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);
  return (
    <section className="panel p-5">
      <h2 className="panel-title mb-3">What the compiler did</h2>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-xs">
        {STAGES.map((name, i) => {
          const complete = i < stage || (i === stage && stage === 4);
          const current = i === stage && busy;
          return (
            <li
              key={name}
              aria-current={current ? "step" : undefined}
              className={`inline-flex items-center gap-1.5 ${
                complete ? "text-[var(--good)]" : current ? "text-[var(--foreground)]" : "text-[var(--muted)]"
              }`}
            >
              {current ? <span className="spinner !w-3 !h-3" aria-hidden="true" /> : <span aria-hidden="true">{complete ? "✓" : "○"}</span>}
              {name}
            </li>
          );
        })}
        {failed && !busy && <li className="text-[var(--bad)]">Stopped with an error</li>}
      </ol>
      <div className={shot ? "grid grid-cols-1 md:grid-cols-2 gap-4" : ""}>
        <div
          ref={logRef}
          aria-live="polite"
          className="mono text-xs text-[var(--muted)] bg-black/30 rounded-lg p-3 h-56 overflow-auto whitespace-pre-wrap break-words"
        >
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          {busy && <div className="opacity-60">working…</div>}
        </div>
        {shot && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot} alt="Latest page the explorer saw" className="rounded-lg w-full h-56 object-cover object-top" />
        )}
      </div>
    </section>
  );
}

function SiteView({ record, password }: { record: CompileRecord; password: string }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
  }, []);
  const mcpUrl = `${origin}/api/mcp/${record.siteId}`;
  return (
    <>
      <section className="panel p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
          <h2 className="panel-title">
            <span className="step-number">2</span>Verified tools ({record.tools.length})
          </h2>
          <span className="text-xs text-[var(--muted)]">Compile cost: {money(record.costUsd)}</span>
        </div>
        <p className="text-xs text-[var(--muted)] mb-4 truncate mono">{record.url}</p>
        {record.tools.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No tool passed its tests, so nothing shipped. Try a more specific goal. Sites that need a login, or that
            block automated requests, may not compile.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {record.tools.map((tool) => (
              <ToolCard key={tool.name} siteId={record.siteId} tool={tool} />
            ))}
          </div>
        )}
        {record.tools.length > 0 && (
          <div className="mt-5 pt-4 border-t border-[var(--panel-border)]">
            <h3 className="text-sm font-medium mb-3">Connect an agent</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <ExportRow label="MCP server URL" value={mcpUrl} />
              <ExportRow label="WebMCP script URL" value={`${origin}/api/webmcp/${record.siteId}`} />
            </div>
          </div>
        )}
      </section>
      {record.tools.length > 0 && <Chat tools={record.tools} siteId={record.siteId} password={password} />}
    </>
  );
}

function ExportRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0">
      <div className="text-xs text-[var(--muted)] mb-1">{label}</div>
      <div className="flex gap-2">
        <input readOnly aria-label={label} value={value} className="field mono !text-xs !py-1 min-w-0" />
        <button
          className="btn-ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function fieldsOf(tool: CompiledTool) {
  if (tool.kind === "pixel") {
    return tool.action === "click"
      ? [{ name: "label", hint: `${tool.itemNoun} label`, initial: (tool.tests[0]?.input.label as string) ?? "" }]
      : [];
  }
  return tool.params
    .filter((p) => p.exposed)
    .map((p) => ({
      name: p.name,
      hint: p.description ?? p.type,
      initial: typeof p.value === "object" ? JSON.stringify(p.value) : String(p.value ?? ""),
    }));
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "–";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function isSafeLink(value: string) {
  return /^https?:\/\//i.test(value);
}

function ResultView({ result }: { result: unknown }) {
  const seats = result as { available?: unknown; availableCount?: number; total?: number } | null;
  if (seats && Array.isArray(seats.available)) {
    return (
      <div>
        <p className="text-sm mb-2">
          {seats.availableCount} of {seats.total} available
        </p>
        <div className="flex flex-wrap gap-1">
          {seats.available.map((label) => (
            <span key={String(label)} className="chip mono">
              {String(label)}
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (Array.isArray(result) && result.length > 0 && result.every((row) => row && typeof row === "object")) {
    const rows = result as Array<Record<string, unknown>>;
    const columns = Object.keys(rows[0]).slice(0, 4);
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-[var(--muted)]">
            <tr>
              {columns.map((column) => (
                <th key={column} className="py-1 pr-3 font-normal">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((row, r) => (
              <tr key={r} className="border-t border-[var(--panel-border)] align-top">
                {columns.map((column) => {
                  const text = cellText(row[column]);
                  return (
                    <td key={column} className="py-1.5 pr-3 max-w-64 truncate" title={text}>
                      {isSafeLink(text) ? (
                        <a className="underline text-[var(--accent)]" href={text} target="_blank" rel="noreferrer noopener">
                          {new URL(text).hostname}
                        </a>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 8 && <p className="text-xs text-[var(--muted)] mt-1">Showing 8 of {rows.length} results.</p>}
      </div>
    );
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return (
      <dl className="text-sm space-y-1">
        {Object.entries(result as Record<string, unknown>).map(([key, value]) => (
          <div key={key} className="flex flex-wrap gap-x-2">
            <dt className="text-[var(--muted)] mono text-xs pt-0.5">{key}</dt>
            <dd className="break-words min-w-0">{cellText(value)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <p className="text-sm break-words">{Array.isArray(result) && result.length === 0 ? "No results." : cellText(result)}</p>;
}

function ToolCard({ siteId, tool }: { siteId: string; tool: CompiledTool }) {
  const fields = fieldsOf(tool);
  const [input, setInput] = useState(() => Object.fromEntries(fields.map((f) => [f.name, f.initial])));
  const [result, setResult] = useState<{ result?: unknown; durationMs?: number; error?: string } | null>(null);
  const [calling, setCalling] = useState(false);
  const passed = tool.tests.filter((t) => t.ok).length;

  async function call() {
    setCalling(true);
    try {
      const res = await fetch(`/api/sites/${siteId}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName: tool.name, input }),
      });
      setResult(await res.json());
    } catch (err) {
      setResult({ error: (err as Error).message });
    } finally {
      setCalling(false);
    }
  }

  return (
    <article className="border border-[var(--panel-border)] rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="mono text-sm font-semibold break-all">{tool.name}</h3>
        <div className="flex flex-wrap gap-1.5">
          <span className="badge badge-good">
            ✓ {passed}/{tool.tests.length} tests
          </span>
          <span className="badge">{tool.kind === "pixel" ? "found by SAM 3.1" : "network replay"}</span>
        </div>
      </div>
      <p className="text-sm text-[var(--muted)] mb-3">{tool.description}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void call();
        }}
      >
        {fields.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
            {fields.map((field) => (
              <label key={field.name} className="text-xs">
                <span className="mono block mb-1">{field.name}</span>
                <input
                  className="field !py-1"
                  placeholder={field.hint}
                  value={input[field.name] ?? ""}
                  onChange={(e) => setInput({ ...input, [field.name]: e.target.value })}
                />
              </label>
            ))}
          </div>
        )}
        <button className="btn-ghost !text-sm !py-1 inline-flex items-center gap-2" disabled={calling}>
          {calling && <span className="spinner !w-3 !h-3" aria-hidden="true" />}
          {calling ? "Calling…" : "Call without a model"}
        </button>
      </form>
      {result && (
        <div className="mt-3 bg-black/30 rounded-lg p-3">
          {result.error ? (
            <p role="alert" className="text-sm text-[var(--bad)] break-words">
              {result.error}
            </p>
          ) : (
            <>
              <div className="text-xs text-[var(--muted)] mb-2">Answered in {result.durationMs} ms, 0 model calls</div>
              <ResultView result={result.result} />
              <details className="mt-3 text-xs text-[var(--muted)]">
                <summary className="cursor-pointer">Raw JSON</summary>
                <pre className="mono mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(result.result, null, 2)?.slice(0, 4000)}
                </pre>
              </details>
            </>
          )}
        </div>
      )}
      <details className="mt-3 text-xs text-[var(--muted)]">
        <summary className="cursor-pointer">Test details</summary>
        <ul className="mt-2 space-y-1">
          {tool.tests.map((test, i) => (
            <li key={i}>
              {test.ok ? "✓" : "✗"} {test.label}: {test.note} ({test.durationMs} ms)
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

function suggestionsFor(tools: CompiledTool[]): string[] {
  const out: string[] = [];
  for (const tool of tools) {
    if (tool.kind === "pixel") {
      if (tool.action === "list") out.push(`Which ${tool.itemNoun.toLowerCase()}s are available?`);
      continue;
    }
    const sample = tool.tests.flatMap((t) => Object.values(t.input)).find((v) => typeof v === "string");
    if (sample) out.push(`Search for ${String(sample)}`);
  }
  return [...out.slice(0, 2), "What can you do on this site?"];
}

type ChatItem =
  | { kind: "user" | "assistant"; text: string }
  | { kind: "tool"; name: string; args?: unknown; text?: string; isError?: boolean; durationMs?: number }
  | { kind: "error"; text: string };

function Chat({ tools, siteId, password }: { tools: CompiledTool[]; siteId: string; password: string }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = PASSWORD_REQUIRED && !password;

  async function send(message: string) {
    const text = message.trim();
    if (!text || busy) return;
    const next: ChatItem[] = [...items, { kind: "user", text }];
    setItems(next);
    setDraft("");
    setBusy(true);
    const messages = next.flatMap((item) =>
      item.kind === "user" || item.kind === "assistant" ? [{ role: item.kind, content: item.text }] : [],
    );
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-access-password": password },
        body: JSON.stringify({ siteId, messages }),
      });
      await readNdjson(res, (event) => {
        if (event.type === "tool_call") {
          setItems((all) => [...all, { kind: "tool", name: event.name as string, args: event.args }]);
        }
        if (event.type === "tool_result") {
          setItems((all) => {
            const copy = [...all];
            const last = copy[copy.length - 1];
            if (last?.kind === "tool") {
              copy[copy.length - 1] = {
                ...last,
                text: event.text as string,
                isError: event.isError as boolean,
                durationMs: event.durationMs as number,
              };
            }
            return copy;
          });
        }
        if (event.type === "text") setItems((all) => [...all, { kind: "assistant", text: event.text as string }]);
        if (event.type === "error") setItems((all) => [...all, { kind: "error", text: event.message as string }]);
      });
    } catch (err) {
      setItems((all) => [...all, { kind: "error", text: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel p-5">
      <h2 className="panel-title mb-1">
        <span className="step-number">3</span>Ask in plain English
      </h2>
      <p className="text-xs text-[var(--muted)] mb-3">
        Muse Spark runs the conversation, and uses paid credit. Each tool call goes through this site&apos;s MCP server.
      </p>
      <div aria-live="polite" className="flex flex-col gap-2 mb-3">
        {items.map((item, i) => {
          if (item.kind === "tool") {
            return (
              <details key={i} className="text-xs border border-[var(--panel-border)] rounded-lg p-2">
                <summary className="cursor-pointer mono break-all">
                  {item.isError ? "✗" : "→"} {item.name}({JSON.stringify(item.args ?? {})})
                  {item.durationMs !== undefined && ` · ${item.durationMs} ms`}
                </summary>
                <pre className="mono mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[var(--muted)]">
                  {item.text ?? "running…"}
                </pre>
              </details>
            );
          }
          if (item.kind === "error") {
            return (
              <p key={i} role="alert" className="text-sm text-[var(--bad)] break-words">
                {item.text}
              </p>
            );
          }
          return (
            <div
              key={i}
              className={`text-sm rounded-lg px-3 py-2 max-w-[90%] whitespace-pre-wrap break-words ${
                item.kind === "user" ? "self-end bg-[var(--panel-border)]" : "self-start bg-black/30"
              }`}
            >
              {item.text}
            </div>
          );
        })}
        {busy && (
          <p className="text-xs text-[var(--muted)] inline-flex items-center gap-2">
            <span className="spinner !w-3 !h-3" aria-hidden="true" />
            Working…
          </p>
        )}
      </div>
      {items.length === 0 && !blocked && (
        <div className="flex flex-wrap gap-2 mb-3">
          {suggestionsFor(tools).map((suggestion) => (
            <button key={suggestion} className="btn-ghost" disabled={busy} onClick={() => void send(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          aria-label="Your request"
          className="field min-w-0"
          placeholder={blocked ? "Enter the password above to chat" : "What do you want from this site?"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn-primary" disabled={busy || !draft.trim() || blocked}>
          Send
        </button>
      </form>
    </section>
  );
}

type BenchmarkData = {
  runAt: string;
  rows: Array<{
    task: string;
    compiled: { ok: boolean; seconds: number; usd: number };
    baseline: { ok: boolean; seconds: number; usd: number; steps: number };
  }>;
};

function Benchmark() {
  const [data, setData] = useState<BenchmarkData | null>(null);
  useEffect(() => {
    void fetch("/api/benchmark")
      .then((res) => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => {});
  }, []);
  if (!data?.rows?.length) return null;
  const ratios = data.rows.map((row) => row.baseline.seconds / row.compiled.seconds);
  const compiledRight = data.rows.filter((row) => row.compiled.ok).length;
  const agentRight = data.rows.filter((row) => row.baseline.ok).length;
  return (
    <section className="panel p-5">
      <h2 className="panel-title mb-1">Measured: compiled tools vs Spark clicking screenshots</h2>
      <p className="text-sm text-[var(--muted)] mb-1">
        Compiled tools got {compiledRight}/{data.rows.length} right and the screenshot agent got {agentRight}/
        {data.rows.length}. Direct tool calls were {Math.floor(Math.min(...ratios))}–{Math.ceil(Math.max(...ratios))}{" "}
        times faster.
      </p>
      <p className="text-xs text-[var(--muted)] mb-3">
        One run per task, {new Date(data.runAt).toLocaleDateString()}. Chat adds Spark&apos;s own time and cost on top of
        a direct call.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-[var(--muted)] text-left">
            <tr>
              <th className="py-1 pr-3 font-normal">Task</th>
              <th className="py-1 pr-3 font-normal">Compiled</th>
              <th className="py-1 font-normal">Screenshot agent</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.task} className="border-t border-[var(--panel-border)] align-top">
                <td className="py-2 pr-3 min-w-44">{row.task}</td>
                <td className="py-2 pr-3 mono text-xs whitespace-nowrap">
                  {row.compiled.ok ? "✓" : "✗"} {row.compiled.seconds.toFixed(1)}s · no model
                </td>
                <td className="py-2 mono text-xs whitespace-nowrap">
                  {row.baseline.ok ? "✓" : "✗"} {row.baseline.seconds.toFixed(1)}s · {money(row.baseline.usd)} ·{" "}
                  {row.baseline.steps} step{row.baseline.steps === 1 ? "" : "s"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
