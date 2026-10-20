// Gemini TTS でアナウンス音声を生成し src/assets/audio/<key>.wav に保存する。
// 使い方: GEMINI_API_KEY=... npm run voices                  （未作成のファイルだけ生成）
//         GEMINI_API_KEY=... npm run voices:force            （全部作り直す）
//         GEMINI_API_KEY=... npm run voices -- --list-voices   （使える声の一覧）
// 生成済みのファイル（wav / mp3 / ogg）は API を呼ばずにスキップする。
//
// 声は announcements.json の voice で指定する。指定できるのは
//   - 既製の声の名前（例: Kore）
//   - 自作した声の表示名（例: Midnight Storyteller 2）。声の一覧から ID を引く
//   - 声の ID（voice_... / voicekey_...）
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "src/assets/audio");
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_TTS_MODEL ?? "gemini-3.8-flash-tts";
const force = process.argv.includes("--force");
const API = "https://generativelanguage.googleapis.com/v1beta";

if (!apiKey) {
  console.error("環境変数 GEMINI_API_KEY を設定してください");
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...init.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

/** 使える声（既製の声と自作した声）をすべて取得する */
async function listVoices() {
  const voices = [];
  let pageToken;
  do {
    const query = new URLSearchParams(pageToken ? { pageToken } : {});
    const json = await api(`/voices?${query}`);
    voices.push(...(json.voices ?? []));
    pageToken = json.nextPageToken ?? json.next_page_token;
  } while (pageToken);
  return voices.map((v) => ({ id: v.id ?? v.name, displayName: v.displayName ?? v.display_name ?? "", raw: v }));
}

/** 声の一覧に出す 1 行（ID、表示名、言語、説明など API が返す情報） */
function describe(v) {
  const r = v.raw;
  const extra = [r.languageCode ?? r.language_code, r.gender, r.description, r.createTime ?? r.create_time].filter(Boolean);
  return [v.id, v.displayName, ...extra].join("\t");
}

if (process.argv.includes("--list-voices")) {
  for (const v of await listVoices()) console.log(describe(v));
  process.exit(0);
}

const ann = JSON.parse(readFileSync(join(root, "src/data/announcements.json"), "utf8"));
const entries = Object.entries(ann.lines);
const linesDir = join(root, "src/data/lines");
const catalog = JSON.parse(readFileSync(join(root, "src/data/catalog.json"), "utf8"));
const available = new Set(catalog.lines.filter((l) => l.available).map((l) => l.id));
for (const file of readdirSync(linesDir).filter((f) => f.endsWith(".json"))) {
  const line = JSON.parse(readFileSync(join(linesDir, file), "utf8"));
  // 路線図に出ない路線の駅は作らない
  if (!available.has(line.id)) continue;
  for (const st of line.stations) {
    entries.push([`station_${line.id}_${st.id}`, ann.stationTemplate.replaceAll("{name}", st.name)]);
  }
}

/** announcements.json の voice を、リクエストに渡す声の指定に変換する */
async function resolveVoice(voice) {
  if (/^voice(key)?_/.test(voice)) return voice;
  const voices = await listVoices();
  const matches = voices.filter((v) => v.displayName === voice);
  if (matches.length > 1) {
    // 同じ表示名の声が複数あると、どれを使うか決められない
    console.error(`表示名「${voice}」の声が ${matches.length} 個あります。announcements.json の voice に ID を指定してください:`);
    for (const v of matches) console.error(`  ${describe(v)}`);
    process.exit(1);
  }
  const custom = matches[0];
  if (custom) {
    console.log(`声「${voice}」→ ${custom.id}`);
    return custom.id;
  }
  // 一覧の表示名に無ければ、既製の声の名前としてそのまま渡す
  if (!voices.some((v) => v.id === voice || v.id?.endsWith(`/${voice}`))) {
    console.warn(`声「${voice}」が一覧に見つかりません。既製の声の名前として指定します（--list-voices で一覧を確認できます）`);
  }
  return voice;
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

async function synthesize(text, voice) {
  const json = await api("/interactions", {
    method: "POST",
    body: JSON.stringify({
      model,
      input: [
        {
          type: "user_input",
          // text は読み上げる文そのもの。読み方の指示は style で渡す
          content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: ann.style }] }],
        },
      ],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
    }),
  });
  const audio = (json.steps ?? [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "audio")
    .at(-1);
  if (!audio?.data) throw new Error("音声データがありません");
  const data = Buffer.from(audio.data, "base64");
  // 通常は WAV で返る。生の PCM なら WAV ヘッダーを付ける
  if (data.subarray(0, 4).toString("ascii") === "RIFF") return data;
  const rate = Number(/rate=(\d+)/.exec(audio.mimeType ?? audio.mime_type ?? "")?.[1] ?? 24000);
  return toWav(data, rate);
}

/** 同じ名前の音声ファイル（アプリが読む wav / mp3 / ogg）が既にあれば、そのパス */
const AUDIO_EXTS = ["wav", "mp3", "ogg"];
function existingAudio(key) {
  return AUDIO_EXTS.map((ext) => join(outDir, `${key}.${ext}`)).find((p) => existsSync(p)) ?? null;
}

mkdirSync(outDir, { recursive: true });
// API を叩く前に、作る予定のファイルが既にあるか確かめる（--force のときだけ作り直す）
const pending = entries.filter(([key]) => force || !existingAudio(key));
const skipped = entries.length - pending.length;
console.log(`${entries.length} 件中 ${skipped} 件は作成済みのためスキップ、${pending.length} 件を生成します`);
if (pending.length === 0) {
  console.log("生成済みです（作り直すには --force）");
  process.exit(0);
}
const voice = await resolveVoice(ann.voice);
for (const [key, text] of pending) {
  // 実行中に別の手段で作られた場合に備えて、リクエストの直前にも確かめる
  const existing = force ? null : existingAudio(key);
  if (existing) {
    console.log(`${key}: スキップ（${existing.slice(outDir.length + 1)} があります）`);
    continue;
  }
  process.stdout.write(`${key}: ${text} ... `);
  try {
    writeFileSync(join(outDir, `${key}.wav`), await synthesize(text, voice));
    console.log("ok");
  } catch (e) {
    console.log(`失敗 (${e.message})`);
  }
}
