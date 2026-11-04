export const SCHEMA_VERSION = 2;

export type CapturedRequest = {
  url: string;
  method: string;
  postData: string | null;
  requestContentType: string;
  headers: Record<string, string>;
  status: number;
  responseContentType: string;
  responseBodySample: string;
  durationMs: number;
};

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type ToolParam = {
  name: string;
  type: "string" | "number" | "boolean" | "json";
  in: "query" | "body";
  description?: string;
  required: boolean;
  /** Exposed params are chosen by the agent; the rest stay fixed on the server. */
  exposed: boolean;
  /** Value captured during exploration. */
  value: Json;
};

export type ToolTest = {
  label: string;
  input: Record<string, Json>;
  ok: boolean;
  note: string;
  durationMs: number;
};

type ToolBase = {
  name: string;
  description: string;
  tests: ToolTest[];
  lastVerified: string;
};

export type NetworkTool = ToolBase & {
  kind: "network";
  method: string;
  urlTemplate: string;
  bodyFormat: "json" | "form" | "none";
  headers: Record<string, string>;
  params: ToolParam[];
  resultPath: string;
  resultFields: string[];
};

export type PixelItem = { label: string; x: number; y: number; w: number; h: number };

export type PixelTool = ToolBase & {
  kind: "pixel";
  action: "list" | "click";
  pageUrl: string;
  viewport: { width: number; height: number };
  itemNoun: string;
  items: PixelItem[];
  /** Colours measured from the page and matched to the states Spark read from the legend. */
  states: Array<{ name: string; hex: string }>;
  availableState: string;
};

export type CompiledTool = NetworkTool | PixelTool;

export type ExploreStep = {
  step: number;
  action: string;
  detail: string;
  outcome: string;
  screenshot?: string;
};

export type CompileRecord = {
  schemaVersion: number;
  siteId: string;
  url: string;
  goal: string;
  createdAt: string;
  logs: string[];
  steps: Omit<ExploreStep, "screenshot">[];
  costUsd: number;
  tools: CompiledTool[];
};
