package com.xiaona;

import java.net.InetSocketAddress;
import java.net.ServerSocket;

/**
 * MC 绑定端口重定向。
 *
 * 有些服务商把 MC 端口固定在唯一开放的端口上（server-port 写死、外网只放行这一个），
 * 此时 PortMux 没法再监听同一个端口。做法是：在 Minecraft **真正绑定端口的那一刻**把它拦下来，
 * 把实际绑定改到内部备用端口，对外仍旧统一走原端口（玩家用原来的地址进服，无感）。
 *
 * 为什么不用 ServerLifecycleEvents.SERVER_STARTING + MinecraftServer.setServerPort()：
 * 实测在 1.21.11 上改完仍然绑在写死端口（日志里是 "Starting Minecraft server on *:43733"），
 * 那个时机已经来不及，所以必须落到 {@link com.xiaona.mixin.ServerNetworkIoMixin} 上。
 */
public final class PortRelocator {
    private static volatile int redirectFrom = 0;
    private static volatile int redirectTo = 0;

    private PortRelocator() {}

    /** 由 XiaonaMod 初始化时配置；to <= 0 表示不重定向 */
    public static void configure(int from, int to) {
        redirectFrom = from > 0 && to > 0 && from != to ? from : 0;
        redirectTo = redirectFrom > 0 ? to : 0;
    }

    public static boolean active() { return redirectFrom > 0; }

    public static int from() { return redirectFrom; }
    public static int to() { return redirectTo; }

    /** 供 Mixin 调用：返回实际要绑定的端口 */
    public static int map(int requested) {
        int from = redirectFrom, to = redirectTo;
        if (from > 0 && to > 0 && requested == from) return to;
        return requested;
    }

    /** 从 base 起向上找一个可绑定端口；找不到返回 0 */
    public static int findFreePort(int base) {
        int start = Math.max(1024, Math.min(base, 65000));
        for (int p = start; p < start + 20 && p <= 65535; p++) {
            try (ServerSocket s = new ServerSocket()) {
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(p), 1);
                return p;
            } catch (Exception ignored) {
                // 换下一个
            }
        }
        return 0;
    }
}