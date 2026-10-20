// Gemini TTS でアナウンス音声を生成し src/assets/audio/<key>.wav に保存する。
// 使い方: GEMINI_API_KEY=... npm run voices [-- --force]
// 生成済みのファイルはスキップする（--force で上書き）。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "src/assets/audio");
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts";
const force = process.argv.includes("--force");

if (!apiKey) {
  console.error("環境変数 GEMINI_API_KEY を設定してください");
  process.exit(1);
}

const ann = JSON.parse(readFileSync(join(root, "src/data/announcements.json"), "utf8"));
const entries = Object.entries(ann.lines);
const linesDir = join(root, "src/data/lines");
for (const file of readdirSync(linesDir).filter((f) => f.endsWith(".json"))) {
  const line = JSON.parse(readFileSync(join(linesDir, file), "utf8"));
  for (const st of line.stations) {
    entries.push([`station_${line.id}_${st.id}`, ann.stationTemplate.replaceAll("{name}", st.name)]);
  }
}

/** 16bit モノラル PCM に WAV ヘッダーを付ける */
function toWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesize(text) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${ann.style}: ${text}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: ann.voice } } },
      },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error("音声データがありません");
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
  return toWav(Buffer.from(part.inlineData.data, "base64"), rate);
}

mkdirSync(outDir, { recursive: true });
for (const [key, text] of entries) {
  const path = join(outDir, `${key}.wav`);
  if (existsSync(path) && !force) continue;
  process.stdout.write(`${key}: ${text} ... `);
  try {
    writeFileSync(path, await synthesize(text));
    console.log("ok");
  } catch (e) {
    console.log(`失敗 (${e.message})`);
  }
}
