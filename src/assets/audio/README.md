# アナウンス音声

ここに置いた `<key>.wav` / `.mp3` / `.ogg` はビルド時にアプリへ同梱され、該当するアナウンスで再生されます。
ファイルが無いアナウンスは、Windows の音声合成（日本語音声）で読み上げます。

| key | 内容 |
|-----|------|
| `no_alighting` | 危ないので駅以外では下車しないでください！ |
| `delay_safety` / `delay_late` | 遅延アナウンス |
| `door_closing` | ドアが閉まります |
| `thanks` | ご乗車ありがとうございました |
| `station_<路線ID>_<駅ID>` | 到着駅の案内（例: `station_yamanote_shibuya`） |

文言は `src/data/announcements.json` と各路線データから生成されます。
Gemini TTS で一括生成する場合: `GEMINI_API_KEY=... npm run voices`
