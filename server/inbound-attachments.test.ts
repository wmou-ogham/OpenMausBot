import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareInboundText } from "./inbound-attachments.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "omb-inbound-"));
  mkdirSync(root, { recursive: true });
  return root;
}

describe("prepareInboundText", () => {
  it("transcribes an owned audio file and keeps the original tag", async () => {
    const root = fixture();
    const audio = join(root, "voice.ogg");
    writeFileSync(audio, Buffer.from("ogg"));
    const source = `幫我聽\n\n<attached-file path="${audio}" name="voice.ogg" />`;
    const prepared = await prepareInboundText(source, {
      attachmentsDir: root,
      transcribe: async (path) => {
        expect(path).toBe(audio);
        return "API 的 timeout 設成 30 秒";
      },
    });
    expect(prepared.transcripts).toEqual(["API 的 timeout 設成 30 秒"]);
    expect(prepared.text).toContain("（語音轉譯）voice.ogg");
    expect(prepared.text).toContain("API 的 timeout 設成 30 秒");
    expect(prepared.text).toContain("<attached-file");
    expect(prepared.text.startsWith("幫我聽")).toBe(true);
  });

  it("inlines a text file stored in the attachments directory", async () => {
    const root = fixture();
    const notes = join(root, "notes.md");
    writeFileSync(notes, "# 行程\n\n帶轉接頭");
    const prepared = await prepareInboundText(`<attached-file path="${notes}" name="notes.md" />`, {
      attachmentsDir: root,
      transcribe: async () => {
        throw new Error("should not transcribe text");
      },
    });
    expect(prepared.transcripts).toEqual([]);
    expect(prepared.text).toContain("（檔案 notes.md）");
    expect(prepared.text).toContain("帶轉接頭");
  });

  it("asks the document extractor for pdf files", async () => {
    const root = fixture();
    const pdf = join(root, "ticket.pdf");
    writeFileSync(pdf, Buffer.from("%PDF"));
    const prepared = await prepareInboundText(`<attached-file path="${pdf}" name="ticket.pdf" />`, {
      attachmentsDir: root,
      extractDocument: async () => "閘口 A12",
    });
    expect(prepared.text).toContain("閘口 A12");
  });

  it("leaves a file outside the attachments directory untouched", async () => {
    const root = fixture();
    const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
    writeFileSync(outside, "secret");
    const source = `<attached-file path="${outside}" name="outside.txt" />`;
    const prepared = await prepareInboundText(source, {
      attachmentsDir: root,
      extractDocument: async () => {
        throw new Error("should not read outside");
      },
    });
    expect(prepared.text).toBe(source);
  });

  it("leaves telegram audio for the gateway instead of running Whisper", async () => {
    const root = fixture();
    const audio = join(root, "voice.ogg");
    writeFileSync(audio, Buffer.from("ogg"));
    const source = `<attached-file path="${audio}" name="voice.ogg" />`;
    const prepared = await prepareInboundText(source, {
      attachmentsDir: root,
      transcribeAudio: false,
      transcribe: async () => {
        throw new Error("telegram voice is transcribed by the gateway");
      },
    });
    expect(prepared.text).toBe(source);
    expect(prepared.transcripts).toEqual([]);
  });

  it("does not transcribe an example inside a code fence", async () => {
    const root = fixture();
    const audio = join(root, "voice.ogg");
    writeFileSync(audio, Buffer.from("ogg"));
    const source = ["```", `<attached-file path="${audio}" name="voice.ogg" />`, "```"].join("\n");
    const prepared = await prepareInboundText(source, {
      attachmentsDir: root,
      transcribe: async () => {
        throw new Error("fenced example is not an attachment");
      },
    });
    expect(prepared.text).toBe(source);
    expect(prepared.transcripts).toEqual([]);
  });
});
