import fs from "node:fs/promises";
import path from "node:path";
import { blobList, blobRead, blobWrite, hasBlobStore } from "./blob-store";
import { DEMO_MODE } from "./demo";
import { SCHEMA_VERSION, type CompileRecord } from "./types";

const DATA_DIR =
  process.env.WEBMCP_DATA_DIR ??
  (DEMO_MODE ? path.join(process.cwd(), "demo-data") : path.join(process.cwd(), ".webmcp-data"));

/** For anything sent to a browser: fixed values can hold site keys and stay on the server. */
export function toPublicRecord(record: CompileRecord): CompileRecord {
  return {
    ...record,
    tools: record.tools.map((tool) =>
      tool.kind === "network"
        ? { ...tool, params: tool.params.map((p) => (p.exposed ? p : { ...p, value: null })) }
        : tool,
    ),
  };
}

const blobPath = (siteId: string) => `sites/${siteId}.json`;

function parse(raw: string | null): CompileRecord | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as CompileRecord;
    return record.schemaVersion === SCHEMA_VERSION ? record : null;
  } catch {
    return null;
  }
}

async function loadFile(siteId: string): Promise<CompileRecord | null> {
  return parse(await fs.readFile(path.join(DATA_DIR, `${siteId}.json`), "utf8").catch(() => null));
}

export async function saveSite(record: CompileRecord): Promise<void> {
  if (hasBlobStore()) return blobWrite(blobPath(record.siteId), JSON.stringify(record));
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, `${record.siteId}.json`), JSON.stringify(record, null, 2));
}

export async function loadSite(siteId: string): Promise<CompileRecord | null> {
  if (!/^[a-z0-9-]+$/.test(siteId)) return null;
  if (hasBlobStore()) {
    const saved = parse(await blobRead(blobPath(siteId)));
    if (saved) return saved;
  }
  return loadFile(siteId);
}

export async function listSites(): Promise<CompileRecord[]> {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  const files = (await fs.readdir(DATA_DIR).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const ids = new Set(files.map((f) => f.slice(0, -5)));
  if (hasBlobStore()) {
    for (const p of await blobList("sites/")) ids.add(p.slice("sites/".length, -".json".length));
  }
  const sites = await Promise.all([...ids].map(loadSite));
  return sites
    .filter((s): s is CompileRecord => s !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
