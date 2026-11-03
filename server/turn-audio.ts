// Short Telegram voice is not transcribed locally. This turns the current
// message's owned <attached-file> audio tags into the bytes a cloud model hears.
import { statSync } from "node:fs";
import { extname } from "node:path";

import { ATTACHMENTS_DIR } from "./attachments.ts";
import type { TurnAudioInput } from "./contracts.ts";
import { ownedAttachment } from "./inbound-attachments.ts";

/** Twelve seconds of a Telegram voice note is far smaller than this. A longer
 * file stays as a path instead of being copied into the provider prompt. */
export const TURN_AUDIO_MAX_BYTES = 2 * 1024 * 1024;
export const TURN_AUDIO_MAX_COUNT = 4;

const FILE_TAG =
  /^<attached-file[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/;

const MIME_BY_EXTENSION: Readonly<Record<string, TurnAudioInput["mime"]>> = {
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".webm": "audio/webm",
};

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

export function extractTurnAudio(
  text: string,
  options: { attachmentsDir?: string; maxCount?: number; maxBytes?: number } = {},
): { text: string; audio: TurnAudioInput[] } {
  if (!text.includes("<attached-file")) return { text, audio: [] };
  const attachmentsDir = options.attachmentsDir ?? ATTACHMENTS_DIR;
  const maxCount = options.maxCount ?? TURN_AUDIO_MAX_COUNT;
  const maxBytes = options.maxBytes ?? TURN_AUDIO_MAX_BYTES;
  const audio: TurnAudioInput[] = [];
  const kept: string[] = [];
  let inFence = false;
  let total = 0;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    const match = inFence ? null : FILE_TAG.exec(line.trim());
    const decoded = match ? decodeAttribute(match[1] ?? "") : "";
    const mime = match ? MIME_BY_EXTENSION[extname(decoded).toLowerCase()] : undefined;
    const owned = match && mime ? ownedAttachment(decoded, attachmentsDir) : null;
    if (owned && mime) {
      let size = 0;
      try {
        size = statSync(owned).size;
      } catch {
        size = 0;
      }
      if (size > 0 && audio.length < maxCount && total + size <= maxBytes) {
        audio.push({ path: owned, mime, bytes: size });
        total += size;
        continue;
      }
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), audio };
}
