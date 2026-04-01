import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Cursor publishes `agent` (symlink) and/or `cursor-agent`; installs also land under versions/. */
function cursorCliFilenames(): string[] {
  if (process.platform === "win32") {
    return ["agent.exe", "cursor-agent.exe"];
  }
  return ["agent", "cursor-agent"];
}

function findCursorCliInDir(dir: string): string | null {
  for (const name of cursorCliFilenames()) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function localBinDir(root: string): string {
  return path.join(root, ".local", "bin");
}

function localBinHasAnyCursorCli(segment: string): boolean {
  return findCursorCliInDir(segment) != null;
}

/** Distinct homes: Node's idea of home plus shell/profile vars (they can differ and break resolution). */
function cursorAgentLocalBinRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    const t = typeof raw === "string" ? raw.trim() : "";
    if (!t) return;
    if (seen.has(t)) return;
    seen.add(t);
    roots.push(t);
  };
  try {
    add(os.homedir());
  } catch {
    /* ignore */
  }
  add(process.env.HOME);
  add(process.env.USERPROFILE);
  return roots;
}

function pathDirectoryList(env: NodeJS.ProcessEnv): string[] {
  const win = process.platform === "win32";
  const delim = win ? ";" : ":";
  const keys = win ? (["Path", "PATH"] as const) : (["PATH", "Path"] as const);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const raw = env[key];
    if (typeof raw !== "string" || !raw) continue;
    for (const dir of raw.split(delim).filter(Boolean)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      ordered.push(dir);
    }
  }
  return ordered;
}

function prependSegmentToProcessPath(target: NodeJS.ProcessEnv, segment: string): void {
  if (!segment) return;
  const win = process.platform === "win32";
  const delim = win ? ";" : ":";
  const primary = win
    ? typeof target.Path === "string" && target.Path.length > 0
      ? target.Path
      : (target.PATH ?? "")
    : (target.PATH ?? "");
  const parts = primary.split(delim).filter(Boolean);
  if (parts.includes(segment)) return;
  const next = primary ? `${segment}${delim}${primary}` : segment;
  if (win) {
    target.Path = next;
    target.PATH = next;
  } else {
    target.PATH = next;
  }
}

/**
 * Cursor keeps versioned binaries under ~/.local/share/cursor-agent/versions/<id>/cursor-agent.
 * Use when ~/.local/bin/agent is missing or is a broken symlink (Node reports it as absent).
 */
function findLatestVersionedCursorAgentUnderRoot(root: string): string | null {
  const versionsDir = path.join(root, ".local", "share", "cursor-agent", "versions");
  if (!existsSync(versionsDir)) return null;
  let versionNames: string[];
  try {
    versionNames = readdirSync(versionsDir);
  } catch {
    return null;
  }
  const cli = process.platform === "win32" ? "cursor-agent.exe" : "cursor-agent";
  const bins: string[] = [];
  for (const ver of versionNames) {
    const p = path.join(versionsDir, ver, cli);
    if (existsSync(p)) bins.push(p);
  }
  if (bins.length === 0) return null;
  bins.sort();
  return bins[bins.length - 1] ?? null;
}

/**
 * For each home root that has Cursor CLI under ~/.local/bin, prepend that bin dir so PATH resolution works.
 */
export function prependCursorAgentInstallBinToPath(target: NodeJS.ProcessEnv): void {
  for (const root of cursorAgentLocalBinRoots()) {
    const segment = localBinDir(root);
    if (!localBinHasAnyCursorCli(segment)) continue;
    prependSegmentToProcessPath(target, segment);
  }
}

/** Copy merged PATH keys into adapter env overlay so spawned children match resolution. */
export function copyPathEnvForSpawn(from: NodeJS.ProcessEnv, into: Record<string, string>): void {
  if (typeof from.PATH === "string") into.PATH = from.PATH;
  if (typeof from.Path === "string") into.Path = from.Path;
}

export function findAgentExecutableInPathEnv(env: NodeJS.ProcessEnv): string | null {
  for (const dir of pathDirectoryList(env)) {
    const found = findCursorCliInDir(dir);
    if (found) return found;
  }
  return null;
}

function looksLikeBareAgentCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (path.isAbsolute(trimmed) || trimmed.startsWith("./") || trimmed.startsWith("../")) return false;
  if (process.platform === "win32" && /^[a-zA-Z]:[\\/]/.test(trimmed)) return false;
  const base = path.basename(trimmed).replace(/\.exe$/i, "");
  return base.toLowerCase() === "agent" || base.toLowerCase() === "cursor-agent";
}

/**
 * Resolve default `agent` to an absolute path using the prepared env PATH, then typical install dirs.
 */
export function resolveCursorAgentExecutable(command: string, env: NodeJS.ProcessEnv): string {
  const trimmed = command.trim();
  if (!looksLikeBareAgentCommand(trimmed)) return trimmed;

  const fromPath = findAgentExecutableInPathEnv(env);
  if (fromPath) return fromPath;

  for (const root of cursorAgentLocalBinRoots()) {
    const inBin = findCursorCliInDir(localBinDir(root));
    if (inBin) return inBin;
    const versioned = findLatestVersionedCursorAgentUnderRoot(root);
    if (versioned) return versioned;
  }

  return trimmed;
}
