// Voice notes and shared documents arrive as <attached-file> tags. Whisper runs
// locally before the provider sees the turn, and readable documents are inlined
// so the model does not have to discover them through a tool call.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

import { ATTACHMENTS_DIR, FILE_MAX_BYTES } from "./attachments.ts";
import { extractDocumentText, transcribeLocalAudio } from "./speech-worker.ts";

const TEXT_LIMIT = 80_000;
const AUDIO_EXT = new Set([".ogg", ".opus", ".mp3", ".m4a", ".wav", ".flac", ".aac", ".webm"]);
const TEXT_EXT = new Set([".txt", ".md", ".csv", ".tsv", ".json"]);
const OFFICE_EXT = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".odt"]);
const FILE_TAG =
  /^<attached-file[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/;

export interface InboundPreparation {
  text: string;
  transcripts: string[];
}

export interface InboundDeps {
  attachmentsDir?: string;
  /** Telegram voice is transcribed by the gateway. Skip Whisper for that origin. */
  transcribeAudio?: boolean;
  transcribe?: (filePath: string) => Promise<string>;
  extractDocument?: (filePath: string) => Promise<string>;
}

function decodeAttribute(value: string): string {
  return value.replace(
    /&(quot|lt|gt|amp);|&#(9|10|13);/g,
    (entity, named: string | undefined, numeric: string | undefined) => {
      if (numeric === "9") return "\t";
      if (numeric === "10") return "\n";
      if (numeric === "13") return "\r";
      if (named === "quot") return '"';
      if (named === "lt") return "<";
      if (named === "gt") return ">";
      if (named === "amp") return "&";
      return entity;
    },
  );
}

/** Only a file this process stored under the attachments directory. */
export function ownedAttachment(filePath: string, attachmentsDir: string): string | null {
  if (!filePath || filePath.includes("\0")) return null;
  const name = filePath.split(/[\\/]/).at(-1) ?? "";
  if (!name || name !== filePath.split(/[\\/]/).pop()) return null;
  const expected = resolve(attachmentsDir, name);
  if (resolve(filePath) !== expected) return null;
  try {
    const entry = lstatSync(expected);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > FILE_MAX_BYTES) return null;
    const root = realpathSync(attachmentsDir);
    const canonical = realpathSync(expected);
    if (dirname(canonical) !== root) return null;
    const rel = relative(root, canonical);
    if (!rel || rel.startsWith("..")) return null;
    return canonical;
  } catch {
    return null;
  }
}

function clip(text: string): string {
  const clean = text.replaceAll("\0", "").trim();
  if (clean.length <= TEXT_LIMIT) return clean;
  return `${clean.slice(0, TEXT_LIMIT).trimEnd()}\n（以下省略）`;
}

function readTextFile(filePath: string): string {
  return clip(readFileSync(filePath, "utf8"));
}

export async function prepareInboundText(text: string, deps: InboundDeps = {}): Promise<InboundPreparation> {
  if (!text.includes("<attached-file")) return { text, transcripts: [] };
  const attachmentsDir = deps.attachmentsDir ?? ATTACHMENTS_DIR;
  const transcribeAudio = deps.transcribeAudio !== false;
  const transcribe = deps.transcribe ?? transcribeLocalAudio;
  const extractDocument = deps.extractDocument ?? extractDocumentText;
  const transcripts: string[] = [];
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const match = FILE_TAG.exec(line.trim());
    if (!match) {
      out.push(line);
      continue;
    }
    const filePath = decodeAttribute(match[1] ?? "");
    const owned = ownedAttachment(filePath, attachmentsDir);
    if (!owned) {
      out.push(line);
      continue;
    }
    const ext = extname(owned).toLowerCase();
    const display = decodeAttribute(match[2] ?? "") || owned.split("/").at(-1) || "附件";
    if (AUDIO_EXT.has(ext)) {
      if (!transcribeAudio) {
        out.push(line);
        continue;
      }
      let transcript = "";
      try {
        transcript = (await transcribe(owned)).trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw Object.assign(new Error(`語音轉文字失敗：${message}`), { status: 502 });
      }
      const shown = transcript || "（沒有辨識到內容）";
      transcripts.push(shown);
      out.push(`（語音轉譯）${display}`);
      out.push(shown);
      out.push("");
      out.push(line);
      continue;
    }
    if (TEXT_EXT.has(ext) || OFFICE_EXT.has(ext)) {
      let body = "";
      try {
        body = clip(TEXT_EXT.has(ext) ? readTextFile(owned) : await extractDocument(owned));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw Object.assign(new Error(`讀取檔案失敗：${message}`), { status: 422 });
      }
      out.push(`（檔案 ${display}）`);
      out.push(body || "（沒有抽出文字）");
      out.push("");
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), transcripts };
}
