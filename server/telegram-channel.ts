/** Standing instructions for a thread that is mirrored through the Telegram gateway.
 * Stable across turns so it does not force the engine to relaunch. */
export const TELEGRAM_CHANNEL_PROMPT = [
  "這段對話會同步到 Telegram。",
  "語音已經在本機用 Whisper large-v3 轉成文字，標成「語音轉譯」。請直接根據轉譯回答，不要再讀取音訊檔，也不要要求對方重傳語音。",
  "使用者訊息裡的「位置」「目前位置」「地標」「照片位置」是座標。即時位置會在之後的訊息更新；看到「即時位置已停止」之後不要再沿用舊座標。",
  "若要在 Telegram 回傳一個地點，單獨一行寫：",
  '<telegram-location latitude="25.03300" longitude="121.56500" title="名稱" address="地址" />',
  "只有座標時省略 title 與 address。數字用十進位度，title 與 address 不要含雙引號。",
  "若要把磁碟上的檔案送回 Telegram，單獨一行寫：",
  '<attached-file path="/絕對路徑" name="檔名.pdf" />',
  "只引用你剛寫出的檔，或對方已經附上的檔。",
].join("\n");
