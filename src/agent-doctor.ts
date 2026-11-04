/**
 * `squad doctor` section for `squad agent <runtime>` adapters (#239).
 * Informational only: it reports, per registered adapter, whether the runtime
 * binary resolves and whether a re-entry state file exists for the default
 * persona. It makes no claim that a runtime is verified on a live host.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getAdapter, registeredRuntimes } from "./agent.js";
import { stateFile } from "./reentry-state.js";

export interface AgentAdapterHealth {
  runtime: string;
  bin: string;
  binFound: boolean;
  persona: string;
  stateFile: string;
  stateExists: boolean;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether `bin` is an executable path, or resolves on `pathEnv`. */
export function binResolves(bin: string, pathEnv: string = process.env.PATH ?? ""): boolean {
  if (bin.includes("/")) return existsSync(bin) && isExecutable(bin);
  return pathEnv.split(delimiter).some((d) => d !== "" && isExecutable(join(d, bin)));
}

export function inspectAgentAdapters(squadDir: string, pathEnv?: string): AgentAdapterHealth[] {
  const out: AgentAdapterHealth[] = [];
  for (const runtime of registeredRuntimes()) {
    const adapter = getAdapter(runtime);
    if (!adapter) continue;
    // Default bin/persona exactly as `squad agent <runtime>` would resolve them.
    const opts = adapter.parseArgs([]);
    const file = stateFile(squadDir, opts.persona, "reentry");
    out.push({
      runtime,
      bin: opts.bin,
      binFound: binResolves(opts.bin, pathEnv),
      persona: opts.persona,
      stateFile: file,
      stateExists: existsSync(file),
    });
  }
  return out;
}

export function formatAgentAdapterLines(items: AgentAdapterHealth[]): string[] {
  const lines = ["agent adapters (squad agent <runtime>; presence of a binary is not live verification):"];
  for (const a of items) {
    lines.push(
      `  ${a.runtime}: binary '${a.bin}' ${a.binFound ? "found" : "not found"}; ` +
        `re-entry state for '${a.persona}' ${a.stateExists ? `present (${a.stateFile})` : "absent"}`,
    );
  }
  return lines;
}
