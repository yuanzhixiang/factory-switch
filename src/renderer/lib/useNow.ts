import { useEffect, useState } from "react";

// 重置倒计时精确到分钟，15 秒刷一次足够
const TICK_MS = 15_000;

/** 定时更新的当前时间，用于倒计时和判断周期是否过期 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
