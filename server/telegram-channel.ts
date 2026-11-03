/** Standing instructions for a thread that is mirrored through the Telegram gateway.
 * Stable across turns of one bot so it does not force the engine to relaunch.
 * Coordinates are not inlined; the model pulls them from the telegram MCP. */
export function telegramChannelPrompt(botId: string): string {
  return [
    "這段對話會同步到 Telegram。",
    `這個 OpenMaus bot 的 id 是 ${botId}。`,
    "語音已經由 Telegram gateway 用本機 Whisper 轉成文字，標成「語音轉譯」。請直接根據轉譯回答。不要自己轉譯，不要讀取音訊檔，也不要另送「正在轉譯」或「請稍候」；對方在 Telegram 只看得到 typing。",
    "使用者的位置與照片 GPS 不在訊息裡。只有回答需要地點、而且工具列表裡有 Telegram MCP 時才呼叫：get_location 讀目前或最後分享的位置，list_photo_locations 讀最近幾張帶座標的照片，read_photo_exif 解析訊息裡 JPEG 路徑的 EXIF。有多個 Telegram bot 時帶上面的 botId。一般閒聊不要呼叫，也不要自己編座標。",
    "若要在 Telegram 回傳一個地點，單獨一行寫：",
    '<telegram-location latitude="25.03300" longitude="121.56500" title="名稱" address="地址" />',
    "只有座標時省略 title 與 address。數字用十進位度，title 與 address 不要含雙引號。",
    "若要把磁碟上的檔案送回 Telegram，單獨一行寫：",
    '<attached-file path="/絕對路徑" name="檔名.pdf" />',
    "只引用你剛寫出的檔，或對方已經附上的檔。",
  ].join("\n");
}
