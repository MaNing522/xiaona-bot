package com.xiaona;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;

/**
 * 以控制台权限执行一条服务器命令（Paradigm 的封禁写入只能走命令）。
 *
 * <p>1.21.11 的 CommandManager 提供 {@code parseAndExecute}，但它会把错误直接发给命令源、
 * 调用方拿不到失败原因。这里自己 parse + execute，失败统一抛 {@link BanException}。
 */
final class BanCommandRunner {
    private BanCommandRunner() {}

    static void run(MinecraftServer server, String cmd) {
        String root = root(cmd);
        try {
            CommandDispatcher<ServerCommandSource> dispatcher = server.getCommandManager().getDispatcher();
            ParseResults<ServerCommandSource> parsed = dispatcher.parse(cmd, server.getCommandSource());
            dispatcher.execute(parsed);
        } catch (CommandSyntaxException e) {
            throw new BanException("服务器没有可用的命令 /" + root + "：" + e.getMessage(), e);
        } catch (Throwable t) {
            throw new BanException("执行命令 /" + root + " 失败：" + (t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage()), t);
        }
    }

    /** /ban &lt;玩家&gt; [原因]；原因不加大引号（多数命令用 greedyString，引号会被当成原因的一部分） */
    static String banCommand(String name, String reason) {
        String r = cleanReason(reason);
        return r.isEmpty() ? "ban " + name : "ban " + name + " " + r;
    }

    static String unbanCommand(String name) {
        return "unban " + name;
    }

    /** 部分版本没有 /unban，用原版 /pardon 兜底 */
    static String pardonCommand(String name) {
        return "pardon " + name;
    }

    /** 原因压成一行、限长，避免换行把命令拆断 */
    static String cleanReason(String reason) {
        String r = String.valueOf(reason == null ? "" : reason)
                .replaceAll("[\\r\\n\\t]+", " ")
                .replaceAll("\\s{2,}", " ")
                .trim();
        return r.length() > 100 ? r.substring(0, 100) : r;
    }

    private static String root(String cmd) {
        int i = cmd.indexOf(' ');
        return i < 0 ? cmd : cmd.substring(0, i);
    }
}
