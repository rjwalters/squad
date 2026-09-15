import * as fs from "node:fs";
import { resolve, dirname, join, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
let parseToml;

const source = fileURLToPath(new URL("../", import.meta.url)).replace(
  /\/$/,
  "",
);
const workflows = ["join", "goals", "card", "clear", "fanout", "steward"];
const localReceipt = ".claude/skills/squad/.install-local.json";
const globalReceipt = ".squad-install.json";
const metaPaths = [".claude", ".agents"].map(
  (r) => `${r}/skills/squad/install-metadata.json`,
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const shellQuote = (value) =>
  "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function options() {
  const [action, ...args] = process.argv.slice(2);
  const opts = {
    action,
    target: ".",
    codex: true,
    link: true,
    global: false,
    yes: false,
    check: false,
    dry: false,
    reentry: false,
  };
  let targetSeen = false;
  for (const arg of args) {
    if (arg === "-y") opts.yes = true;
    else if (arg === "--no-codex") {
      opts.codex = false;
      opts.link = false;
    } else if (arg === "--no-link") opts.link = false;
    else if (arg === "--global") opts.global = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--dry-run") opts.dry = true;
    else if (arg === "--reentry") opts.reentry = true;
    else if (arg === "--no-reentry") opts.reentry = false;
    else if (arg === "-h" || arg === "--help") {
      console.log(`usage: ./${action}.sh [options] [target-repo]
Install/update copies canonical workflows for Claude and Codex. Modified or
unowned files are preserved and reported; resolve conflicts and rerun.
  -y              accept optional machine-wide Codex registration / npm link
  --no-codex      skip ALL global setup (repo-scoped Codex skills still install)
  --no-link       skip the optional npm link
  --reentry       opt-in hook; requires SQUAD_CLAUDE_PERSONA=<unique-name>
  --no-reentry    do not add a hook (existing managed hooks remain installed)
  --check         read-only status against this source; nonzero means attention
  --dry-run       preflight and print planned changes without writing
  --global        uninstall only: also remove owned global Codex artifacts
Global Codex home: CODEX_HOME, or ~/.codex. Repo uninstall leaves globals alone.
Runtime stays in this checkout; build it and rerun install to refresh adapters.
Local metadata: both runtime skill directories. Global receipt: .squad-install.json.
CLI npm links are machine-wide and are never removed by repo uninstall.`);
      process.exit(0);
    } else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (targetSeen)
      throw new Error("only one target repository is accepted");
    else {
      opts.target = arg;
      targetSeen = true;
    }
  }
  if (!["install", "uninstall"].includes(action))
    throw new Error("expected install or uninstall");
  if (opts.global && action !== "uninstall")
    throw new Error("--global is an uninstall option");
  if (opts.check && action !== "install")
    throw new Error("--check is an install option");
  opts.target = fs.realpathSync(opts.target);
  opts.codexHome = resolve(
    process.env.CODEX_HOME || join(process.env.HOME || "", ".codex"),
  );
  return opts;
}

// Do not follow destination symlinks, including ancestor directories. Resolve
// macOS's /var -> /private/var through the caller's canonical target root only.
function safePath(root, rel) {
  if (
    typeof rel !== "string" ||
    !rel ||
    rel.startsWith("/") ||
    rel.split(/[\\/]/).some((p) => p === ".." || p === ".")
  )
    throw new Error(`unsafe receipt path: ${rel}`);
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep))
    throw new Error(`path escapes install root: ${rel}`);
  let current = root;
  for (const part of rel.split("/")) {
    current = join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error(`symlink destination preserved: ${current}`);
    if (current !== file && !stat.isDirectory())
      throw new Error(`destination ancestor is not a directory: ${current}`);
    if (current === file && !stat.isFile())
      throw new Error(`destination is not a regular file: ${current}`);
  }
  return file;
}
function safeGlobalRoot(path) {
  let current = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      // macOS exposes its system temporary directories through these aliases.
      if (process.platform === "darwin" && ["/var", "/tmp"].includes(current))
        current = fs.realpathSync(current);
      else throw new Error(`symlink Codex ancestor preserved: ${current}`);
    } else if (!stat.isDirectory())
      throw new Error(`Codex home ancestor is not a directory: ${current}`);
  }
  return current;
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function parseJson(text, file) {
  const value = text === null ? {} : JSON.parse(text);
  if (!object(value)) throw new Error(`expected JSON object: ${file}`);
  return value;
}

class Plan {
  constructor(opts) {
    this.opts = opts;
    this.changes = new Map();
    this.messages = [];
    this.conflicts = [];
    this.attention = [];
  }
  note(message) {
    this.messages.push(message);
  }
  conflict(message) {
    this.conflicts.push(message);
    this.note(`preserved: ${message}`);
  }
  change(file, content, mode) {
    const before = read(file);
    const modeChanged =
      before !== null &&
      content !== null &&
      mode !== undefined &&
      (fs.statSync(file).mode & 0o777) !== mode;
    if (before !== content || modeChanged)
      this.changes.set(file, { before, content, mode });
  }
  apply() {
    // Recheck the entire preflight snapshot before the first write, catching
    // edits that happened during prompts/dependency verification.
    for (const [file, entry] of this.changes) {
      if (read(file) !== entry.before)
        throw new Error(`file changed during preflight: ${file}`);
      const root = file.startsWith(this.opts.target + sep)
        ? this.opts.target
        : this.opts.codexHome;
      safePath(root, relative(root, file));
    }
    const applied = [];
    try {
      for (const [file, entry] of this.changes) {
        const oldMode =
          entry.before === null ? 0o644 : fs.statSync(file).mode & 0o777;
        applied.push({ file, before: entry.before, mode: oldMode });
        if (entry.content === null) fs.unlinkSync(file);
        else atomicWrite(file, entry.content, entry.mode ?? oldMode);
      }
    } catch (error) {
      for (const old of applied.reverse()) {
        if (old.before === null) fs.rmSync(old.file, { force: true });
        else atomicWrite(old.file, old.before, old.mode);
      }
      throw error;
    }
    if (this.opts.action === "uninstall") {
      const dirs = [...this.changes.keys()].flatMap((file) => {
        const root = file.startsWith(this.opts.target + sep)
          ? this.opts.target
          : this.opts.codexHome;
        const result = [];
        for (
          let p = dirname(file);
          p !== root && p.startsWith(root + sep);
          p = dirname(p)
        )
          result.push(p);
        return result;
      });
      for (const dir of [...new Set(dirs)].sort(
        (a, b) => b.length - a.length,
      )) {
        try {
          fs.rmdirSync(dir);
        } catch (e) {
          if (!["ENOTEMPTY", "ENOENT"].includes(e.code)) throw e;
        }
      }
    }
  }
}
function atomicWrite(file, content, mode) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.squad-${randomUUID()}`;
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

class Scope {
  constructor(plan, root, receiptRel, allowed) {
    this.plan = plan;
    this.root = root;
    this.receiptRel = receiptRel;
    this.allowed = allowed;
    const file = safePath(root, receiptRel),
      text = read(file);
    this.old = parseJson(text, file);
    if (text !== null && this.old.layout_version !== 2) {
      if (
        receiptRel !== localReceipt ||
        typeof this.old.source !== "string" ||
        typeof this.old.installed_at !== "string" ||
        Object.keys(this.old).some(
          (k) => !["source", "installed_at"].includes(k),
        )
      )
        throw new Error(`unrecognized receipt preserved: ${file}`);
      plan.note(
        `legacy receipt: ${file}; only exact matching artifacts can be adopted`,
      );
      this.old = {};
    }
    if (this.old.layout_version === 2) {
      if (
        this.old.package !== "@rjwalters/squad" ||
        !object(this.old.files) ||
        !object(this.old.fragments)
      )
        throw new Error(`invalid ownership receipt: ${file}`);
      for (const [rel, value] of Object.entries(this.old.files)) {
        if (!allowed.has(rel) || !/^[a-f0-9]{64}$/.test(value))
          throw new Error(`invalid artifact in receipt: ${rel}`);
        safePath(root, rel);
      }
    }
    this.next = {
      package: "@rjwalters/squad",
      layout_version: 2,
      source,
      files: {},
      fragments: {},
    };
  }
  file(rel, desired, mode) {
    if (!this.allowed.has(rel))
      throw new Error(`unrecognized artifact: ${rel}`);
    const path = safePath(this.root, rel),
      current = read(path),
      prior = this.old.files?.[rel];
    const removing = this.plan.opts.action === "uninstall";
    if (removing) desired = null;
    if (current === null) {
      if (desired !== null) this.plan.change(path, desired, mode);
    } else if (
      (prior && hash(current) === prior) ||
      (!removing && current === desired)
    )
      this.plan.change(path, desired, mode);
    else if (removing && !prior) return;
    else {
      this.plan.conflict(`${path} differs from its installed copy`);
      if (prior) this.next.files[rel] = prior;
      return;
    }
    if (!removing) this.next.files[rel] = hash(desired);
  }
  block(rel, begin, end, body) {
    const path = safePath(this.root, rel),
      original = read(path),
      current = original ?? "";
    const starts = [...current.matchAll(new RegExp(escapeRe(begin), "g"))],
      ends = [...current.matchAll(new RegExp(escapeRe(end), "g"))];
    if (
      starts.length !== ends.length ||
      starts.length > 1 ||
      (starts.length && starts[0].index > ends[0].index)
    )
      throw new Error(`malformed or duplicate markers: ${path}`);
    const existing = starts.length
      ? current.slice(starts[0].index, ends[0].index + end.length)
      : null;
    const desired = `${begin}\n${body.trimEnd()}\n${end}`;
    const old = this.old.fragments?.[rel];
    if (old && (old.kind !== "block" || typeof old.text !== "string"))
      throw new Error(`invalid block receipt: ${rel}`);
    const removing = this.plan.opts.action === "uninstall";
    if (existing !== null && existing !== old?.text && existing !== desired) {
      this.plan.conflict(`${path} has a modified or legacy unmanaged block`);
      if (old) this.next.fragments[rel] = old;
      return;
    }
    if (removing && !old) return;
    if (removing) {
      if (existing !== null) {
        let after = current.slice(starts[0].index + existing.length);
        if (after.startsWith("\n")) after = after.slice(1);
        const content = current.slice(0, starts[0].index) + after;
        this.plan.change(path, content || (old.created ? null : ""));
      }
    } else {
      const content =
        existing === null
          ? current +
            (current && !current.endsWith("\n") ? "\n" : "") +
            desired +
            "\n"
          : current.replace(existing, desired);
      this.plan.change(path, content);
      this.next.fragments[rel] = {
        kind: "block",
        text: desired,
        created: old?.created ?? original === null,
      };
    }
  }
  jsonFields(rel, fields, preserve = [], retain = [], equivalent = []) {
    const path = safePath(this.root, rel),
      text = read(path),
      cfg = parseJson(text, path),
      prior = this.old.fragments?.[rel];
    if (
      prior &&
      (prior.kind !== "fields" ||
        !object(prior.values) ||
        !Array.isArray(prior.containers))
    )
      throw new Error(`invalid JSON receipt: ${rel}`);
    const next = {
      kind: "fields",
      values: {},
      containers: prior?.containers ?? [],
      created: prior?.created ?? text === null,
    };
    const removing = this.plan.opts.action === "uninstall";
    let changed = false;
    for (const [key, desired] of Object.entries(fields)) {
      if (retain.includes(key) && prior?.values[key]) {
        next.values[key] = prior.values[key];
        this.plan.conflict(`${path}:${key} retained for customized launcher`);
        continue;
      }
      if (preserve.includes(key) && !prior?.values[key]) {
        this.plan.note(`preserved external launcher: ${path}:${key}`);
        continue;
      }
      const parts = key.split("/");
      let node = cfg;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i],
          prefix = parts.slice(0, i + 1).join("/");
        if (!own(node, part)) {
          if (removing) {
            node = null;
            break;
          }
          node[part] = {};
          next.containers.push(prefix);
        }
        if (!object(node[part]))
          throw new Error(`expected config object at ${rel}:${prefix}`);
        node = node[part];
      }
      if (!node) continue;
      const leaf = parts.at(-1),
        existing = node[leaf],
        previous = prior?.values[key];
      if (previous && (!object(previous) || !own(previous, "installed")))
        throw new Error(`invalid config field receipt: ${key}`);
      if (removing) {
        if (!previous) continue;
        if (equal(existing, previous.installed)) {
          delete node[leaf];
          changed = true;
        } else if (existing !== undefined) {
          this.plan.conflict(`${path}:${key} was customized`);
          next.values[key] = previous;
        }
      } else if (previous) {
        if (!equal(existing, previous.installed)) {
          if (equivalent.includes(key)) {
            // Accept alternate path spelling without adopting user edits.
            next.values[key] = previous;
            continue;
          }
          this.plan.conflict(`${path}:${key} was customized`);
          next.values[key] = previous;
        } else {
          node[leaf] = desired;
          changed ||= !equal(existing, desired);
          next.values[key] = { installed: desired };
        }
      } else if (existing === undefined) {
        node[leaf] = desired;
        changed = true;
        next.values[key] = { installed: desired };
      } else {
        this.plan.note(`preserved external config: ${path}:${key}`);
      }
    }
    // Receipts never grant arbitrary JSON pointer deletion privileges.
    if (prior && Object.keys(prior.values).some((k) => !own(fields, k)))
      throw new Error(`unknown config field in receipt: ${rel}`);
    if (removing) {
      for (const key of [...new Set(next.containers)].sort(
        (a, b) => b.length - a.length,
      )) {
        if (!Object.keys(fields).some((k) => k.startsWith(key + "/")))
          throw new Error(`invalid container receipt: ${key}`);
        const parts = key.split("/");
        let node = cfg;
        for (const part of parts.slice(0, -1)) node = node?.[part];
        if (
          node &&
          object(node[parts.at(-1)]) &&
          Object.keys(node[parts.at(-1)]).length === 0
        )
          delete node[parts.at(-1)];
      }
    }
    if (changed)
      this.plan.change(
        path,
        next.created && Object.keys(cfg).length === 0 ? null : json(cfg),
      );
    if (Object.keys(next.values).length) this.next.fragments[rel] = next;
    return cfg;
  }
  finish(version, commit) {
    const removing = this.plan.opts.action === "uninstall";
    const path = safePath(this.root, this.receiptRel);
    if (removing) {
      if (this.old.layout_version === 2)
        this.plan.change(
          path,
          Object.keys(this.next.files).length ||
            Object.keys(this.next.fragments).length
            ? json({
                ...this.old,
                files: this.next.files,
                fragments: this.next.fragments,
              })
            : null,
        );
    } else {
      this.next.version = version;
      this.next.commit = commit;
      this.plan.change(path, json(this.next), 0o600);
    }
  }
}
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  const opts = options();
  if (opts.reentry && !process.env.SQUAD_CLAUDE_PERSONA)
    throw new Error("--reentry requires SQUAD_CLAUDE_PERSONA=<unique-name>");
  if (!opts.check && !opts.dry) {
    if (opts.action === "install" && opts.codex)
      opts.codex = await confirm(
        opts,
        "Register/update global Codex prompts and managed MCP configuration?",
      );
    if (opts.action === "install" && opts.link)
      opts.link = await confirm(
        opts,
        "Link squad CLI with npm link (machine-wide)?",
      );
    if (opts.action === "uninstall" && opts.global)
      opts.global = await confirm(
        opts,
        "Remove unchanged Squad global Codex wiring for ALL repositories?",
      );
  }
  if ((opts.action === "install" && opts.codex) || opts.global) {
    opts.codexHome = safeGlobalRoot(opts.codexHome);
    try {
      ({ parse: parseToml } = await import("smol-toml"));
    } catch {
      throw new Error(
        `installer dependency missing; run CI=true pnpm install --frozen-lockfile in ${source}, then rerun (no target files changed)`,
      );
    }
  }
  const plan = new Plan(opts);
  const version = fs.readFileSync(join(source, "VERSION"), "utf8").trim();
  if (!version) throw new Error("VERSION is empty");
  const commitResult = spawnSync(
    "git",
    ["-C", source, "rev-parse", "--short", "HEAD"],
    { encoding: "utf8" },
  );
  const commit =
    commitResult.status === 0 ? commitResult.stdout.trim() : "unknown";
  const artifacts = new Map();
  for (const runtime of [".claude", ".agents"]) {
    artifacts.set(
      `${runtime}/skills/squad/SKILL.md`,
      fs.readFileSync(join(source, "skills/squad/SKILL.md"), "utf8"),
    );
    for (const name of fs
      .readdirSync(join(source, "skills/squad/references"))
      .filter((name) => name.endsWith(".md")))
      artifacts.set(
        `${runtime}/skills/squad/references/${name}`,
        fs.readFileSync(join(source, "skills/squad/references", name), "utf8"),
      );
  }
  for (const name of workflows)
    artifacts.set(
      `.claude/commands/squad/${name}.md`,
      fs.readFileSync(join(source, `commands/squad/${name}.md`), "utf8"),
    );
  const hookRel = ".claude/hooks/squad-reentry.sh";
  const allowed = new Set([...artifacts.keys(), ...metaPaths, hookRel]);
  const scope = new Scope(plan, opts.target, localReceipt, allowed);
  // A cloned consumer has tracked artifact hashes but no machine-local config
  // receipt. Recover only file ownership; never infer config ownership.
  if (!scope.old.layout_version && opts.action === "install") {
    const tracked = read(safePath(opts.target, metaPaths[0]));
    if (tracked) {
      const metadata = parseJson(tracked, metaPaths[0]);
      if (
        metadata.layout_version === 2 &&
        metadata.package === "@rjwalters/squad" &&
        object(metadata.artifacts)
      ) {
        for (const [rel, digest] of Object.entries(metadata.artifacts)) {
          if (!allowed.has(rel) || !/^[a-f0-9]{64}$/.test(digest))
            throw new Error(`invalid tracked ownership artifact: ${rel}`);
        }
        scope.old.files = { ...metadata.artifacts };
        for (const rel of metaPaths) {
          const copy = read(safePath(opts.target, rel));
          if (copy === tracked) scope.old.files[rel] = hash(copy);
        }
        plan.note(
          "recovered tracked artifact ownership; configuration remains externally managed",
        );
      }
    }
  }
  for (const [rel, body] of artifacts) scope.file(rel, body);
  const runtimePath = join(source, "dist/index.js");
  const siblingSource = dirname(source) === dirname(opts.target);
  const portableRuntime = siblingSource
    ? relative(opts.target, runtimePath)
    : runtimePath;
  if (!siblingSource && opts.action === "install")
    plan.note(
      "warning: Squad source is not a sibling of the target; the project MCP launcher uses an absolute path and must be refreshed after moving checkouts",
    );
  const fields = {
    "mcpServers/squad/command": "node",
    "mcpServers/squad/args": [portableRuntime],
    "mcpServers/squad/env/SQUAD_DIR": ".squad",
  };
  // Retain recorded pins on ordinary refresh. Explicit new pins only populate
  // missing values; changing an existing user pin remains a direct config edit.
  const oldPin =
    scope.old.fragments?.[".mcp.json"]?.values?.[
      "mcpServers/squad/env/SQUAD_PERSONA"
    ]?.installed;
  if (process.env.SQUAD_CLAUDE_PERSONA || oldPin)
    fields["mcpServers/squad/env/SQUAD_PERSONA"] =
      process.env.SQUAD_CLAUDE_PERSONA || oldPin;
  const beforeMcp = parseJson(
    read(safePath(opts.target, ".mcp.json")),
    ".mcp.json",
  );
  const previousLauncher = scope.old.fragments?.[".mcp.json"]?.values;
  const externalLauncher =
    (beforeMcp.mcpServers?.squad?.command !== undefined ||
      beforeMcp.mcpServers?.squad?.args !== undefined) &&
    !previousLauncher?.["mcpServers/squad/command"] &&
    !previousLauncher?.["mcpServers/squad/args"];
  const launcherKeys = ["mcpServers/squad/command", "mcpServers/squad/args"];
  const changedLauncher =
    opts.action === "uninstall" &&
    launcherKeys.some(
      (key) =>
        previousLauncher?.[key] &&
        !equal(
          beforeMcp.mcpServers?.squad?.[key.split("/").at(-1)],
          previousLauncher[key].installed,
        ),
    );
  const existingServer = beforeMcp.mcpServers?.squad;
  const equivalentPaths = [];
  if (
    existingServer?.command === "node" &&
    Array.isArray(existingServer.args) &&
    existingServer.args.length === 1 &&
    typeof existingServer.args[0] === "string" &&
    resolve(opts.target, existingServer.args[0]) === runtimePath
  )
    equivalentPaths.push("mcpServers/squad/args");
  if (
    typeof existingServer?.env?.SQUAD_DIR === "string" &&
    resolve(opts.target, existingServer.env.SQUAD_DIR) === join(opts.target, ".squad")
  )
    equivalentPaths.push("mcpServers/squad/env/SQUAD_DIR");
  const cfg = scope.jsonFields(
    ".mcp.json",
    fields,
    externalLauncher ? launcherKeys : [],
    changedLauncher ? launcherKeys : [],
    equivalentPaths,
  );
  if (opts.check && externalLauncher)
    plan.attention.push(
      "unmanaged Claude launcher: .mcp.json; verify its command/args separately",
    );
  if (
    opts.check &&
    cfg.mcpServers?.squad?.command === "node" &&
    typeof cfg.mcpServers.squad.args?.[0] === "string"
  ) {
    if (!fs.existsSync(resolve(opts.target, cfg.mcpServers.squad.args[0])))
      plan.attention.push(
        `broken Claude runtime path: ${cfg.mcpServers.squad.args[0]}`,
      );
    if (resolve(opts.target, cfg.mcpServers.squad.args[0]) !== runtimePath)
      plan.attention.push(
        `stale/different Claude runtime source: ${cfg.mcpServers.squad.args[0]}`,
      );
  }
  if (
    opts.reentry &&
    cfg.mcpServers?.squad?.env?.SQUAD_PERSONA !==
      process.env.SQUAD_CLAUDE_PERSONA
  )
    throw new Error(
      "--reentry persona conflicts with preserved MCP configuration",
    );
  const block = fs.readFileSync(
    join(source, "skills/squad/instructions.md"),
    "utf8",
  );
  for (const name of ["CLAUDE.md", "AGENTS.md"])
    scope.block(name, "<!-- BEGIN SQUAD -->", "<!-- END SQUAD -->", block);
  const reentry = opts.reentry || Boolean(scope.old.files?.[hookRel]);
  const retainHook = hookSettings(scope, reentry);
  if (reentry && retainHook && opts.action === "uninstall") {
    if (scope.old.files?.[hookRel])
      scope.next.files[hookRel] = scope.old.files[hookRel];
    plan.conflict(
      `${hookRel} retained because a surviving Stop hook still uses it`,
    );
  } else if (reentry) {
    const persona =
      process.env.SQUAD_CLAUDE_PERSONA ||
      cfg.mcpServers?.squad?.env?.SQUAD_PERSONA;
    if (opts.action === "install" && !persona)
      throw new Error("managed reentry hook requires its explicit MCP persona");
    const quoteDouble = (value) =>
      String(value ?? "").replace(/[\\"$`]/g, "\\$&");
    const hook = fs
      .readFileSync(join(source, "hooks/squad-reentry.sh"), "utf8")
      .replaceAll(
        "__SQUAD_REENTRY_JS__",
        quoteDouble(join(source, "dist/reentry-hook.js")),
      )
      .replaceAll("__SQUAD_REENTRY_PERSONA__", quoteDouble(persona));
    scope.file(hookRel, hook, 0o755);
  }
  gitignore(scope);
  const metadata = {
    package: "@rjwalters/squad",
    version,
    commit,
    layout_version: 2,
    artifacts: Object.fromEntries(
      [...artifacts].map(([rel, body]) => [rel, hash(body)]),
    ),
  };
  for (const rel of metaPaths) {
    // v1 metadata is recognized, but does not confer ownership on payloads.
    const file = safePath(opts.target, rel),
      existing = read(file);
    if (!scope.old.files?.[rel] && existing && opts.action === "install") {
      const old = parseJson(existing, file);
      if (
        old.layout_version === 1 &&
        typeof old.version === "string" &&
        typeof old.commit === "string" &&
        Object.keys(old).every((k) =>
          ["version", "commit", "layout_version"].includes(k),
        )
      )
        scope.old.files = { ...scope.old.files, [rel]: hash(existing) };
    }
    scope.file(rel, json(metadata));
  }
  scope.finish(version, commit);
  if ((opts.action === "install" && opts.codex) || opts.global)
    globalScope(plan, opts, version, commit);
  const stale = plan.changes.size > 0;
  if (opts.action === "install") {
    const result = spawnSync(
      process.execPath,
      ["-e", "import('./dist/mcp.js')"],
      { cwd: source, encoding: "utf8" },
    );
    if (result.status !== 0 || !fs.existsSync(join(source, "dist/index.js")))
      plan.attention.push(
        "runtime unavailable: run CI=true pnpm install --frozen-lockfile && pnpm build in the Squad source checkout",
      );
  }
  for (const message of plan.messages) console.log(message);
  for (const [file, entry] of plan.changes)
    console.log(
      `${entry.content === null ? "remove" : entry.before === null ? "install" : "update"}: ${file}`,
    );
  for (const message of plan.attention) console.error(message);
  if (opts.check) {
    console.log(
      stale || plan.conflicts.length || plan.attention.length
        ? `attention required; update with: bash ${shellQuote(join(source, "install.sh"))} --no-link ${shellQuote(opts.target)}`
        : "current: local and selected global Squad artifacts match this source",
    );
    process.exitCode =
      stale || plan.conflicts.length || plan.attention.length ? 1 : 0;
    return;
  }
  if (opts.dry) {
    console.log("dry-run: no files changed");
    process.exitCode = plan.conflicts.length || plan.attention.length ? 1 : 0;
    return;
  }
  if (plan.conflicts.length && opts.action === "install")
    throw new Error(
      "installation aborted before writing; back up and resolve the listed conflicts, then rerun",
    );
  if (plan.attention.length)
    throw new Error(
      "installation aborted before writing; repair the source runtime first",
    );
  plan.apply();
  if (opts.action === "install" && opts.link) {
    const link = spawnSync("npm", ["link", "--silent"], {
      cwd: source,
      stdio: "inherit",
    });
    if (link.status !== 0)
      console.log(
        `npm link unavailable; use node ${shellQuote(join(source, "dist/index.js"))} <command>`,
      );
  }
  console.log(
    opts.action === "install"
      ? "installed both runtime workflows; start Claude or Codex inside the target repository"
      : "removed unchanged managed artifacts; room data and machine-wide CLI links remain",
  );
  process.exitCode = plan.conflicts.length ? 1 : 0;
}

function hookSettings(scope, requested) {
  const rel = ".claude/settings.json",
    path = safePath(scope.root, rel),
    text = read(path);
  const cfg = parseJson(text, path),
    prior = scope.old.fragments?.[rel];
  if (prior && (prior.kind !== "hook" || !object(prior.entry)))
    throw new Error("invalid hook receipt");
  const removing = scope.plan.opts.action === "uninstall";
  if (!requested && !prior) return;
  if (cfg.hooks !== undefined && !object(cfg.hooks))
    throw new Error("settings.hooks must be an object");
  if (cfg.hooks?.Stop !== undefined && !Array.isArray(cfg.hooks.Stop))
    throw new Error("settings.hooks.Stop must be an array");
  const entries = cfg.hooks?.Stop ?? [];
  const command = "${CLAUDE_PROJECT_DIR}/.claude/hooks/squad-reentry.sh";
  const desired = { matcher: "", hooks: [{ type: "command", command }] };
  const matching = entries.findIndex((entry) => equal(entry, prior?.entry));
  if (prior && matching === -1) {
    scope.plan.conflict(`${path}: managed Stop hook was customized or removed`);
    scope.next.fragments[rel] = prior;
    return true;
  }
  if (removing) {
    if (!prior)
      return entries.some((entry) =>
        entry.hooks?.some((h) => h.command === command),
      );
    entries.splice(matching, 1);
    if (!entries.length && prior.createdStop) delete cfg.hooks.Stop;
    if (cfg.hooks && !Object.keys(cfg.hooks).length && prior.createdHooks)
      delete cfg.hooks;
    scope.plan.change(
      path,
      prior.created && !Object.keys(cfg).length ? null : json(cfg),
    );
    return entries.some((entry) =>
      entry.hooks?.some((h) => h.command === command),
    );
  } else if (prior) scope.next.fragments[rel] = prior;
  else if (
    entries.some((entry) => entry.hooks?.some((h) => h.command === command))
  )
    scope.plan.note(`preserved external Stop hook: ${path}`);
  else {
    const receipt = {
      kind: "hook",
      entry: desired,
      created: text === null,
      createdHooks: cfg.hooks === undefined,
      createdStop: cfg.hooks?.Stop === undefined,
    };
    cfg.hooks ??= {};
    cfg.hooks.Stop ??= [];
    cfg.hooks.Stop.push(desired);
    scope.plan.change(path, json(cfg));
    scope.next.fragments[rel] = receipt;
  }
}
function gitignore(scope) {
  const rel = ".gitignore",
    path = safePath(scope.root, rel),
    text = read(path),
    current = text ?? "";
  const entries = [".squad/", localReceipt];
  // Keep ignores when removing: the room survives, as may customized receipts.
  // No user-owned lines are ever deleted.
  if (scope.plan.opts.action === "uninstall") return;
  let next = current;
  for (const line of entries)
    if (!next.split(/\r?\n/).includes(line))
      next += (next && !next.endsWith("\n") ? "\n" : "") + line + "\n";
  scope.plan.change(path, next);
}
function globalScope(plan, opts, version, commit) {
  const artifacts = new Map(
    workflows.map((name) => [
      `prompts/squad-${name}.md`,
      fs.readFileSync(join(source, `codex/prompts/squad-${name}.md`), "utf8"),
    ]),
  );
  const scope = new Scope(
    plan,
    opts.codexHome,
    globalReceipt,
    new Set(artifacts.keys()),
  );
  for (const [rel, body] of artifacts) scope.file(rel, body);
  const rel = "config.toml",
    path = safePath(scope.root, rel),
    text = read(path),
    config = parseToml(text ?? "");
  const prior = scope.old.fragments?.[rel];
  const begin = "# BEGIN SQUAD MCP",
    end = "# END SQUAD MCP";
  const pin = process.env.SQUAD_CODEX_PERSONA;
  const body = `[mcp_servers.squad]\ncommand = "node"\nargs = [${JSON.stringify(join(source, "dist/index.js"))}]\nenv = ${pin ? `{ SQUAD_PERSONA = ${JSON.stringify(pin)} }` : "{}"}\n`;
  const server = config.mcp_servers?.squad;
  if (prior) {
    // Refresh an owned block without overwriting its installed pin when the
    // caller omitted SQUAD_CODEX_PERSONA. All user block edits are preserved.
    const oldConfig = parseToml(prior.text ?? "");
    const existingPin = oldConfig.mcp_servers?.squad?.env?.SQUAD_PERSONA;
    const desired =
      !pin && existingPin
        ? body.replace(
            "env = {}",
            `env = { SQUAD_PERSONA = ${JSON.stringify(existingPin)} }`,
          )
        : body;
    scope.block(rel, begin, end, desired);
  } else if (server !== undefined) {
    plan.note(`preserved external Codex squad configuration: ${path}`);
    if (opts.check)
      plan.attention.push(
        `unmanaged Codex registration: ${path}; verify its launcher separately (existing configuration is never adopted automatically)`,
      );
  } else {
    // A marker block with no parsed squad server is malformed ownership state.
    if ((text ?? "").includes(begin) || (text ?? "").includes(end))
      throw new Error(
        `unmanaged Codex markers without a Squad server: ${path}`,
      );
    if (opts.action === "install") scope.block(rel, begin, end, body);
  }
  if (opts.check && server) {
    if (
      server.command === "node" &&
      Array.isArray(server.args) &&
      typeof server.args[0] === "string"
    ) {
      if (!isAbsolute(server.args[0])) {
        plan.attention.push(
          `relative global Codex runtime path depends on each project's working directory; verify separately: ${server.args[0]}`,
        );
      } else {
        if (!fs.existsSync(server.args[0]))
          plan.attention.push(`broken Codex runtime path: ${server.args[0]}`);
        if (server.args[0] !== join(source, "dist/index.js"))
          plan.attention.push(
            `stale/different Codex runtime source: ${server.args[0]}`,
          );
      }
    } else
      plan.attention.push(
        `custom Codex launcher requires operator verification: ${path}`,
      );
  }
  const plannedConfig = plan.changes.get(path);
  if (plannedConfig?.content !== null && plannedConfig?.content !== undefined)
    parseToml(plannedConfig.content);
  scope.finish(version, commit);
}
async function confirm(opts, question) {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`skipped: ${question} (use -y)`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
