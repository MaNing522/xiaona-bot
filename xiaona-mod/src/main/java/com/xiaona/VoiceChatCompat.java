package com.xiaona;

import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Simple Voice Chat 适配：让语音也走"唯一对外开放的那个端口"。
 *
 * 背景：本 mod 的端口复用（{@link PortMux}）占的是 **TCP**；而 Simple Voice Chat 的语音流量走 **UDP**，
 * 默认监听自己的独立端口 24454。服务商只放行一个端口时，24454 从公网根本到不了，客户端就一直显示"未连接"。
 *
 * 关键点：**TCP 与 UDP 可以在同一个端口号上共存**（互不冲突），所以这里不需要做 UDP 层的转发或多路复用，
 * 只要让 SVC 把 UDP 监听到那个对外端口上即可。做法是在 SVC 读取配置之前，把
 * {@code config/voicechat/voicechat-server.properties} 里的 {@code port} 改成对外端口。
 *
 * 同时把 {@code server.properties} 的 {@code enable-query} 关掉：MC 的 Query 也用 UDP 监听同一端口，
 * 会和语音抢端口（这正是 SVC 官方提示 {@code port=-1} 可能崩服的原因）。
 */
public final class VoiceChatCompat {
    private static final String MOD_ID = "voicechat";
    /** 只匹配未被注释的 port= 行 */
    private static final Pattern PORT_LINE = Pattern.compile("^\\s*port\\s*=.*$");
    private static final Pattern QUERY_LINE = Pattern.compile("^\\s*enable-query\\s*=.*$");

    private VoiceChatCompat() {}

    /**
     * 在 mod 初始化时调用（必须早于 SVC 读取它自己的配置）。
     * @param sharePort 对外统一走的那一个端口；&lt;= 0 表示未启用端口复用，不做任何改动
     */
    public static void apply(int sharePort) {
        if (sharePort <= 0) return;
        if (!FabricLoader.getInstance().isModLoaded(MOD_ID)) return;

        try {
            Path cfg = FabricLoader.getInstance().getConfigDir()
                    .resolve("voicechat").resolve("voicechat-server.properties");
            if (applyVoicePort(cfg, sharePort)) {
                BotState.log("🎙️ Simple Voice Chat：语音端口已指向对外端口 " + sharePort
                        + "（语音走 UDP，与该端口的 TCP 互不影响）。若本次语音仍未连上，重启一次服务器即可。");
            }
        } catch (Exception e) {
            BotState.error("[语音] 配置 Simple Voice Chat 端口失败：" + e.getMessage());
        }

        try {
            Path sp = FabricLoader.getInstance().getGameDir().resolve("server.properties");
            if (disableQuery(sp)) {
                BotState.log("🎙️ 已关闭 server.properties 的 enable-query：MC Query 同样占用 UDP，"
                        + "会和语音抢同一个端口。");
            }
        } catch (Exception e) {
            BotState.error("[语音] 关闭服务器 Query 失败：" + e.getMessage());
        }
    }

    /**
     * 把 SVC 配置里的 port 改成 sharePort；文件不存在则创建。
     * @return 是否发生了改动（已正确时为 false）
     */
    static boolean applyVoicePort(Path file, int sharePort) throws IOException {
        List<String> lines = Files.exists(file)
                ? new ArrayList<>(Files.readAllLines(file, StandardCharsets.UTF_8))
                : new ArrayList<>();
        String want = "port=" + sharePort;
        boolean found = false, changed = false;
        for (int i = 0; i < lines.size(); i++) {
            String l = lines.get(i);
            if (isComment(l) || !PORT_LINE.matcher(l).matches()) continue;
            found = true;
            if (!want.equals(l.trim())) {
                lines.set(i, want);
                changed = true;
            }
            break;
        }
        if (!found) {
            lines.add(want);
            changed = true;
        }
        if (!changed) return false;
        if (file.getParent() != null) Files.createDirectories(file.getParent());
        Files.write(file, lines, StandardCharsets.UTF_8);
        return true;
    }

    /**
     * 把 server.properties 的 enable-query 关掉（不改动其他行）。
     * @return 是否发生了改动（原本就是 false、或文件不存在时为 false）
     */
    static boolean disableQuery(Path file) throws IOException {
        if (!Files.exists(file)) return false;
        List<String> lines = new ArrayList<>(Files.readAllLines(file, StandardCharsets.UTF_8));
        boolean changed = false;
        for (int i = 0; i < lines.size(); i++) {
            String l = lines.get(i);
            if (isComment(l) || !QUERY_LINE.matcher(l).matches()) continue;
            String value = l.substring(l.indexOf('=') + 1).trim();
            if (!"false".equalsIgnoreCase(value)) {
                lines.set(i, "enable-query=false");
                changed = true;
            }
            break;
        }
        if (changed) Files.write(file, lines, StandardCharsets.UTF_8);
        return changed;
    }

    private static boolean isComment(String line) {
        String t = line.trim();
        return t.isEmpty() || t.startsWith("#") || t.startsWith("!");
    }
}
