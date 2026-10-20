// WebAudio で合成する簡単な効果音（音声ファイル不要）
let ctx: AudioContext | null = null;

function tone(freq: number, start: number, duration: number, volume: number, type: OscillatorType = "sine") {
  ctx ??= new AudioContext();
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export const sfx = {
  volume: 0.9,
  /** 発車ベル風 */
  depart() {
    const v = 0.12 * this.volume;
    [784, 988, 1175, 988].forEach((f, i) => tone(f, i * 0.12, 0.2, v, "triangle"));
  },
  /** ドアチャイム風（ピンポーン） */
  door() {
    const v = 0.15 * this.volume;
    tone(1320, 0, 0.5, v);
    tone(1046, 0.35, 0.8, v);
  },
  /** 警告ブザー */
  buzzer() {
    tone(220, 0, 0.25, 0.08 * this.volume, "square");
  },
  /** 路線開業ファンファーレ（タタタ・ターン、タ・ターン！） */
  fanfare() {
    const v = 0.12 * this.volume;
    [523, 659, 784].forEach((f, i) => tone(f, i * 0.12, 0.3, v, "triangle"));
    tone(1046, 0.36, 0.6, v, "triangle");
    tone(784, 0.8, 0.2, v, "triangle");
    // 最後は和音で伸ばす
    for (const f of [659, 784, 1046, 1318]) tone(f, 0.95, 1.6, v * 0.7, "triangle");
  },
};
