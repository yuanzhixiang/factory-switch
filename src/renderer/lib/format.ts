/** 长 ID 只显示前 12 位，够区分又不占地方 */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 毫秒时间戳显示成 MM-DD HH:mm */
export function formatTime(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  const date = new Date(ms);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 毫秒时间戳显示成 HH:mm:ss，用于用量更新时间 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
