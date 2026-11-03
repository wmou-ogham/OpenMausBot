// One local Whisper process for the life of the harness. Tests never import
// the default transcribe path; they pass their own function into prepareInboundText.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "./config.ts";

const SCRIPT = fileURLToPath(new URL("./stt/worker.py", import.meta.url));
const EXTRACT = fileURLToPath(new URL("./stt/extract_text.py", import.meta.url));
const JOB_TIMEOUT_MS = 20 * 60 * 1000;

type Pending = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

export function sttPythonPath(): string {
  return process.env.OMB_STT_PYTHON ?? join(DATA_DIR, "stt", "venv", "bin", "python");
}

function failAll(error: Error): void {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  pending.clear();
  child = null;
  starting = null;
}

function ensureWorker(): Promise<void> {
  if (child && starting) return starting;
  const python = sttPythonPath();
  if (!existsSync(python) || !existsSync(SCRIPT)) {
    return Promise.reject(Object.assign(
      new Error("本機語音轉文字還沒安裝。在 OpenMausBot 執行 server/stt/setup.sh"),
      { status: 503 },
    ));
  }
  const proc = spawn(python, [SCRIPT], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      OMB_DATA_DIR: DATA_DIR,
      OMB_STT_CACHE: process.env.OMB_STT_CACHE ?? join(DATA_DIR, "stt", "cache"),
    },
  });
  child = proc;
  starting = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(Object.assign(new Error("語音模型載入超過 20 分鐘"), { status: 504 }));
    }, JOB_TIMEOUT_MS);
    const lines = createInterface({ input: proc.stdout });
    const onReady = (line: string) => {
      let payload: { ready?: boolean; error?: string; id?: number; text?: string };
      try {
        payload = JSON.parse(line);
      } catch {
        return;
      }
      if (!payload.ready) {
        clearTimeout(timer);
        reject(Object.assign(new Error(payload.error || "語音模型沒有啟動"), { status: 502 }));
        return;
      }
      clearTimeout(timer);
      lines.removeListener("line", onReady);
      lines.on("line", (next) => {
        let body: { id?: number; text?: string; error?: string };
        try {
          body = JSON.parse(next);
        } catch {
          return;
        }
        if (body.id === undefined) return;
        const job = pending.get(body.id);
        if (!job) return;
        pending.delete(body.id);
        clearTimeout(job.timer);
        if (body.error) job.reject(Object.assign(new Error(body.error), { status: 502 }));
        else job.resolve(body.text ?? "");
      });
      resolve();
    };
    lines.on("line", onReady);
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once("exit", (code) => {
      failAll(Object.assign(new Error(`語音轉文字行程結束（${code ?? "無結束碼"}）`), { status: 502 }));
    });
  });
  starting.catch(() => {
    child = null;
    starting = null;
  });
  return starting;
}

export async function transcribeLocalAudio(filePath: string): Promise<string> {
  await ensureWorker();
  const stdin = child?.stdin;
  if (!stdin) throw Object.assign(new Error("語音轉文字沒有在執行"), { status: 503 });
  const id = ++seq;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error("語音轉文字超過 20 分鐘"), { status: 504 }));
    }, JOB_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    stdin.write(`${JSON.stringify({ id, path: filePath })}\n`);
  });
}

export async function extractDocumentText(filePath: string): Promise<string> {
  const python = sttPythonPath();
  if (!existsSync(python)) {
    throw Object.assign(new Error("文件抽取需要本機 STT 環境。執行 server/stt/setup.sh"), { status: 503 });
  }
  const { execFile } = await import("node:child_process");
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(python, [EXTRACT, filePath], { maxBuffer: 2_000_000, timeout: 120_000 }, (error, out, err) => {
      if (error) {
        reject(Object.assign(new Error(String(err || error.message).trim() || "文件抽取失敗"), { status: 422 }));
        return;
      }
      resolve(out);
    });
  });
  return stdout.trim();
}
