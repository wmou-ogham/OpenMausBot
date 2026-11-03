import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { extractTurnAudio } from "./turn-audio.ts";

let root = "";

afterEach(() => {
  if (root) removeTempDir(root);
  root = "";
});

describe("extractTurnAudio", () => {
  it("lifts an owned short voice note out of the prompt text", () => {
    root = join(tmpdir(), `omb-turn-audio-${process.pid}`);
    mkdirSync(root);
    const path = join(root, "voice.ogg");
    writeFileSync(path, Buffer.from("OggS"));
    const source = `（語音）\n\n<attached-file path="${path}" name="voice.ogg" />`;
    const result = extractTurnAudio(source, { attachmentsDir: root });
    expect(result.audio).toEqual([{ path, mime: "audio/ogg", bytes: 4 }]);
    expect(result.text).not.toContain("<attached-file");
    expect(result.text).toContain("（語音）");
  });

  it("leaves a fenced example and a non-audio file in the text", () => {
    root = join(tmpdir(), `omb-turn-audio-fence-${process.pid}`);
    mkdirSync(root);
    const path = join(root, "notes.txt");
    writeFileSync(path, "hello");
    const source = ["```", `<attached-file path="${path}" name="notes.txt" />`, "```", `<attached-file path="${path}" name="notes.txt" />`].join("\n");
    expect(extractTurnAudio(source, { attachmentsDir: root })).toEqual({ text: source, audio: [] });
  });
});
