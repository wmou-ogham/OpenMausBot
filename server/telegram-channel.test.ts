import { describe, expect, it } from "vitest";

import { telegramChannelPrompt, withTelegramVoiceReplyNote } from "./telegram-channel.ts";

describe("telegram voice replies", () => {
  it("tells the model to include the transcript", () => {
    const prompt = telegramChannelPrompt("bot-1");
    expect(prompt).toContain("回覆必須包含語音轉文字的結果");
    expect(prompt).toContain("（語音轉譯）");
    expect(prompt).not.toContain("不要自己轉譯");
  });

  it("asks for a fresh transcript when the voice was not transcribed yet", () => {
    const noted = withTelegramVoiceReplyNote("（語音）", { telegram: true, audioCount: 1 });
    expect(noted).toContain("第一行是「（語音轉譯）」");
    expect(withTelegramVoiceReplyNote("（語音）", { telegram: false, audioCount: 1 })).toBe("（語音）");
    expect(withTelegramVoiceReplyNote("你好", { telegram: true })).toBe("你好");
  });

  it("asks to copy an existing transcript instead of writing a new one", () => {
    const source = "（語音轉譯）voice.ogg\n明天付款";
    const noted = withTelegramVoiceReplyNote(source, { telegram: true });
    expect(noted.startsWith(source)).toBe(true);
    expect(noted).toContain("原樣附上");
  });
});
