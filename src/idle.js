// ============================================================
// idle.js - 闲时调度：把"不急"的维护任务挪到非高峰时段执行
//
// 背景：线上机器人控制不了用户什么时候来提问，但**后台维护任务**可以挑时间跑。
// 高峰时段（工作日 9:00-12:00、14:00-18:00）把 CPU / IO / 网络让给实时对话，
// 这些任务留到闲时再做：
//   · 语音缓存清理
//   · 记忆过期数据清理（超期消息/摘要）
//   · 以后加日志分析、非紧急统计之类，也挂到这里
//
// 注意：缓存优化（system prompt 前缀缓存、max_tokens 控制）在高峰同样有效，
// 不需要特殊处理 —— 这里只管"可延后的活儿"。
// ============================================================

/** 高峰时段（工作日）：9:00-12:00、14:00-18:00 */
const PEAK_RANGES = [
  { from: 9 * 60, to: 12 * 60 },
  { from: 14 * 60, to: 18 * 60 },
];

/**
 * 现在是不是高峰时段。
 * 周末不算高峰（大家作息散、也没有"上班摸鱼"那波集中流量）。
 * @param {Date} [now]
 */
export function isPeakHour(now = new Date()) {
  const day = now.getDay(); // 0=周日 6=周六
  if (day === 0 || day === 6) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return PEAK_RANGES.some((r) => minutes >= r.from && minutes < r.to);
}

/**
 * 距离下一个"闲时"开始还有多少毫秒（非高峰返回 0）。
 * @param {Date} [now]
 */
export function msUntilIdle(now = new Date()) {
  if (!isPeakHour(now)) return 0;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const next = PEAK_RANGES.map((r) => r.to).find((to) => to > minutes);
  if (next === undefined) return 0; // 理论上到不了这里
  const d = new Date(now);
  d.setHours(Math.floor(next / 60), next % 60, 0, 0);
  return Math.max(0, d.getTime() - now.getTime());
}

/** 生成"下一次该唤醒"的定时器延迟：闲时按间隔轮询，高峰则睡到高峰结束 */
function nextDelay(intervalMs, now = new Date()) {
  const wait = msUntilIdle(now);
  return wait > 0 ? wait : intervalMs;
}

/**
 * 启动闲时维护：每隔 intervalMs 尝试一次，但**高峰时段自动推迟**。
 * @param {Array<{name:string, run:Function}>} tasks
 * @param {{intervalMs?:number, kickOffMs?:number}} [opts]
 * @returns {{stop:Function}} 便于测试/退出时停掉
 */
export function startIdleMaintenance(tasks = [], opts = {}) {
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 6 * 3600000; // 默认 6 小时
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (isPeakHour()) {
      timer = setTimeout(tick, nextDelay(intervalMs));
      timer.unref?.();
      return;
    }
    for (const t of tasks) {
      try {
        await t.run();
      } catch {
        /* 维护任务失败不影响机器人运行 */
      }
    }
    timer = setTimeout(tick, nextDelay(intervalMs));
    timer.unref?.();
  };

  const kick = Number(opts.kickOffMs) >= 0 ? Number(opts.kickOffMs) : 10000;
  timer = setTimeout(tick, kick);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
