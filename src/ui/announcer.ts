// 音声アナウンス。src/assets/audio/<key>.(wav|mp3|ogg) があればそれを再生し、
// 無ければ OS の音声合成（Web Speech API）で代用する。
import announcements from "../data/announcements.json";

const files = import.meta.glob("../assets/audio/*.{wav,mp3,ogg}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const audioByKey = new Map<string, string>();
for (const [path, url] of Object.entries(files)) {
  const key = path.split("/").pop()!.replace(/\.[^.]+$/, "");
  audioByKey.set(key, url);
}

export type AnnouncementKey = keyof typeof announcements.lines;

export function stationAnnouncementKey(lineId: string, stationId: string): string {
  return `station_${lineId}_${stationId}`;
}

export function stationAnnouncementText(name: string): string {
  return announcements.stationTemplate.replaceAll("{name}", name);
}

export class Announcer {
  volume = 0.9;
  speechFallback = true;
  private current: HTMLAudioElement | null = null;
  private busyUntil = 0;

  /** 再生中のアナウンスを止めて再生する */
  play(key: string, text: string): void {
    this.stop();
    const url = audioByKey.get(key);
    if (url) {
      const audio = new Audio(url);
      audio.volume = this.volume;
      this.current = audio;
      audio.play().catch(() => this.speak(text));
      this.busyUntil = performance.now() + 4000;
      audio.addEventListener("ended", () => (this.busyUntil = 0));
      return;
    }
    this.speak(text);
  }

  playLine(key: AnnouncementKey): void {
    this.play(key, announcements.lines[key]);
  }

  /** アナウンス中か（効果音・警告の重複抑止用の目安） */
  get busy(): boolean {
    return performance.now() < this.busyUntil || (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking);
  }

  stop(): void {
    if (this.current) {
      this.current.pause();
      this.current = null;
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.busyUntil = 0;
  }

  private speak(text: string): void {
    if (!this.speechFallback || typeof speechSynthesis === "undefined") return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = 1.05;
    u.volume = this.volume;
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith("ja"));
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  }
}
