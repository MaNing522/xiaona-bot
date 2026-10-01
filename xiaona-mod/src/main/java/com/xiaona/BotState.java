package com.xiaona;

import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedList;
import java.util.List;

/** 共享运行时状态：只保留日志缓冲，供 /xiaona 命令与控制台查看 */
public final class BotState {
    public static final int MAX_LOGS = 500;
    private static final List<String> logs = Collections.synchronizedList(new LinkedList<>());

    private BotState() {}

    public static void log(String line) {
        String ts = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"));
        String full = "[" + ts + "] " + line;
        synchronized (logs) {
            logs.add(full);
            while (logs.size() > MAX_LOGS) logs.remove(0);
        }
        System.out.println("[Xiaona] " + line);
    }

    public static void error(String line) {
        log("❌ " + line);
    }

    /** 只写控制台、不进日志缓冲（用于多行内容，避免刷爆缓冲） */
    public static void printRaw(String line) {
        System.out.println(line);
    }

    public static void flushConsole() {
        System.out.flush();
    }

    public static List<String> recentLogs(int n) {
        synchronized (logs) {
            int from = Math.max(0, logs.size() - n);
            return new ArrayList<>(logs.subList(from, logs.size()));
        }
    }
}