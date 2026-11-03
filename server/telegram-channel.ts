/** Standing instructions for a thread that is mirrored through the Telegram gateway.
 * Stable across turns of one bot so it does not force the engine to relaunch.
 * Coordinates are not inlined; the model pulls them from the telegram MCP. */
export function telegramChannelPrompt(botId: string): string {
  return [
    "這段對話會同步到 Telegram。",
    `這個 OpenMaus bot 的 id 是 ${botId}。`,
    "收到語音時，回覆必須包含語音轉文字的結果。15 秒以內的語音沒有現成逐字稿，音檔會直接附上，請先聽，回覆開頭寫兩行：「（語音轉譯）」以及你聽到的逐字內容，空一行後再回答。超過 15 秒的訊息裡已有「語音轉譯」，回覆必須先原樣附上那段逐字稿，再回答。不要改寫或省略逐字稿，也不要另送「正在轉譯」或「請稍候」；對方在 Telegram 只看得到 typing 與這則回覆。Gateway 不會另外貼一則逐字稿。",
    "使用者的位置與照片 GPS 不在訊息裡。只有回答需要地點、而且工具列表裡有 Telegram MCP 時才呼叫：get_location 讀目前或最後分享的位置，list_photo_locations 讀最近幾張帶座標的照片，read_photo_exif 解析訊息裡 JPEG 路徑的 EXIF。有多個 Telegram bot 時帶上面的 botId。一般閒聊不要呼叫，也不要自己編座標。",
    "若要在 Telegram 回傳一個地點，單獨一行寫：",
    '<telegram-location latitude="25.03300" longitude="121.56500" title="名稱" address="地址" />',
    "只有座標時省略 title 與 address。數字用十進位度，title 與 address 不要含雙引號。",
    "若要把磁碟上的檔案送回 Telegram，單獨一行寫：",
    '<attached-file path="/絕對路徑" name="檔名.pdf" />',
    "只引用你剛寫出的檔，或對方已經附上的檔。",
  ].join("\n");
}

const AUDIO_FILE_TAG = /<attached-file\b[^>]*\.(?:ogg|opus|mp3|m4a|wav|flac|aac|webm)"/i;

/** Per-turn reminder. The standing prompt is easy to skip once a session is
 * already running; this is attached only to the provider text for a voice turn. */
export function withTelegramVoiceReplyNote(
  text: string,
  options: { telegram?: boolean; audioCount?: number } = {},
): string {
  if (!options.telegram) return text;
  const transcribed = text.includes("（語音轉譯）");
  const heard = (options.audioCount ?? 0) > 0 || AUDIO_FILE_TAG.test(text);
  if (!transcribed && !heard) return text;
  const note = transcribed
    ? "這則訊息已有語音轉文字結果。回覆必須先原樣附上「語音轉譯」那幾行逐字稿，空一行後再回答。不要改寫或省略逐字稿，不要把這段要求貼回去，也不要另送「正在轉譯」或「請稍候」。"
    : "這則訊息是語音。回覆必須先寫出語音轉文字的結果：第一行是「（語音轉譯）」，下一行是你聽到的逐字內容，空一行後再回答。不要只回答、不附逐字稿，不要把這段要求貼回去，也不要另送「正在轉譯」或「請稍候」。";
  return `${text}\n\n${note}`;
}
