// 新しい路線の開業を知らせる演出
import type { LineDef } from "../domain/types.ts";

const AUTO_CLOSE_MS = 9000;
const CONFETTI = 90;

let closeTimer: number | undefined;
let onClose: (() => void) | null = null;

function div(className: string, parent: HTMLElement, text?: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function root(): HTMLElement {
  return document.getElementById("celebration")!;
}

/** 開業した路線を画面いっぱいに知らせる。クリックか一定時間で閉じる */
export function celebrate(lines: readonly LineDef[], closed: () => void): void {
  const el = root();
  el.replaceChildren();
  el.style.setProperty("--line-color", lines[0].color);

  div("celebration-rays", el);
  const confetti = div("celebration-confetti", el);
  const colors = [...lines.map((l) => l.color), "#ffd400", "#ffffff", "#ff8fb1"];
  for (let i = 0; i < CONFETTI; i++) {
    const piece = div("confetti-piece", confetti);
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 2.5}s`;
    piece.style.animationDuration = `${2.8 + Math.random() * 2.5}s`;
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 240}px`);
    piece.style.setProperty("--spin", `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720)}deg`);
  }

  const card = div("celebration-card", el);
  div("celebration-kicker", card, "🎉 祝 開業 🎉");
  for (const line of lines) {
    const row = div("celebration-line", card);
    row.style.setProperty("--line-color", line.color);
    const badge = div("celebration-badge", row);
    div("celebration-badge-code", badge, line.sign?.code ?? "");
    const names = div("celebration-names", row);
    div("celebration-name", names, line.name);
    const first = line.stations[0].name;
    const last = line.stations[line.stations.length - 1].name;
    div("celebration-section", names, `${first} 〜 ${last}　${line.stations.length} 駅`);
  }
  div("celebration-message", card, "本日より路線図からご乗車いただけます");
  div("celebration-hint", card, "クリックで閉じる");

  el.hidden = false;
  onClose = closed;
  el.onclick = () => closeCelebration();
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(closeCelebration, AUTO_CLOSE_MS);
}

export function closeCelebration(): void {
  window.clearTimeout(closeTimer);
  const el = root();
  if (el.hidden) return;
  el.hidden = true;
  el.replaceChildren();
  const cb = onClose;
  onClose = null;
  cb?.();
}
