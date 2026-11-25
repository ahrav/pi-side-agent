import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { JsonlReader, type ReaderStats, wantsRecord } from "./jsonl.ts";
import { CHILD_ENV, type BridgeMessage, type BridgeReply, isBridgeMessage } from "./protocol.ts";

export interface Invocation {
  command: string;
  args: string[];
}

export interface LaunchOptions {
  bridgePath: string;
  sessionDir: string;
  sessionFile?: string;
  trusted: boolean;
  systemPrompt: string;
}

export interface SideExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface SideProcessOptions {
  invocation: Invocation;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onRecord(record: Record<string, any>): void;
  onBridge(message: BridgeMessage): void;
  onExit(exit: SideExit): void;
}

const STDERR_TAIL_CHARS = 4096;
const KILL_AFTER_MS = 5000;

/** `piInvocation` falls back to `pi` on PATH when Node or Bun has no usable entry script. */
export function piInvocation(args: string[]): Invocation {
  const script = process.argv[1];
  const bunVirtual = script !== undefined && (script.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(script));
  if (script && !bunVirtual && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase())) return { command: process.execPath, args };
  return { command: "pi", args };
}

export function launchArgs(options: LaunchOptions): string[] {
  const args = ["--mode", "rpc", "--session-dir", options.sessionDir, "-e", options.bridgePath, "--append-system-prompt", options.systemPrompt];
  args.push(options.trusted ? "--approve" : "--no-approve");
  if (options.sessionFile) args.push("--session", options.sessionFile);
  return args;
}

export class SideProcess {
  private readonly options: SideProcessOptions;
  private readonly reader: JsonlReader;
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  private child: ChildProcess | undefined;
  private sequence = 0;
  private stderr = "";
  private exited = false;

  constructor(options: SideProcessOptions) {
    this.options = options;
    this.reader = new JsonlReader(wantsRecord, (line) => this.handleLine(line));
  }

  get running(): boolean {
    return this.child !== undefined && !this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stats(): ReaderStats {
    return this.reader.stats;
  }

  start(): void {
    if (this.child) throw new Error("The side agent process already started.");
    const { invocation, cwd, env } = this.options;
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, ...env, [CHILD_ENV]: "1" },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.child = child;
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => this.reader.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    child.on("message", (message) => {
      if (isBridgeMessage(message)) this.guard(() => this.options.onBridge(message));
    });
    child.once("error", (error) => this.finish(null, null, error.message));
    child.once("exit", (code, signal) => this.finish(code, signal, this.stderr));
  }

  request<T = any>(command: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.running) {
        reject(new Error("The side agent process is not running."));
        return;
      }
      const id = `r${++this.sequence}`;
      this.pending.set(id, { resolve, reject });
      this.write({ ...command, id });
    });
  }

  write(record: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (this.running && stdin?.writable) stdin.write(`${JSON.stringify(record)}\n`);
  }

  reply(reply: BridgeReply): void {
    const child = this.child;
    if (this.running && child?.connected) child.send(reply, () => {});
  }

  stop(): void {
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin?.end();
    child.kill("SIGTERM");
    if (child.connected) child.disconnect();
    setTimeout(() => {
      if (!this.exited) child.kill("SIGKILL");
    }, KILL_AFTER_MS).unref();
  }

  private handleLine(line: string): void {
    let record: Record<string, any>;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (record.type !== "response") {
      this.guard(() => this.options.onRecord(record));
      return;
    }
    const entry = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
    if (!entry) return;
    this.pending.delete(record.id);
    if (record.success) entry.resolve(record.data);
    else entry.reject(new Error(typeof record.error === "string" ? record.error : `${record.command} failed`));
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, stderr: string): void {
    if (this.exited) return;
    this.exited = true;
    const error = new Error("The side agent process exited.");
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.guard(() => this.options.onExit({ code, signal, stderr }));
  }

  private guard(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.stderr = `${this.stderr}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`.slice(-STDERR_TAIL_CHARS);
    }
  }
}
