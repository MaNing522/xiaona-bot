package com.xiaona;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.CommandOutput;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * 在服务端主线程执行一条游戏命令，并把它产生的反馈文本收集回来。
 *
 * 用途有两条：
 *   · 本机（管理员/主人）经 AI 执行游戏命令，见 {@link BridgeServer} 的 /bridge/command；
 *   · 本机把 QQ 黑名单同步到服务器封禁名单（/ban、/pardon），见 /bridge/ban。
 *
 * 命令用的是**服务器控制台的身份**（{@code server.getCommandSource()}，权限等同于控制台），
 * 因此能执行 /ban、/give 这类需要 OP 的命令。输出被替换成一个收集器、且不广播给在线 OP，
 * 避免把命令结果刷屏到服务器里。
 */
public final class GameCommands {
    private GameCommands() {}

    /** 命令执行的等待上限（毫秒）：超时就当没输出返回，绝不把 HTTP 线程挂住 */
    private static final long TIMEOUT_MS = 3000L;

    /**
     * 执行命令。**只能从 HTTP 线程调用**（内部走 server.execute 并等待，从 MC 线程调用会自锁）。
     * @return 捕获到的反馈文本；无输出或超时返回空串
     */
    public static String run(MinecraftServer server, String command) {
        if (server == null || command == null || command.isBlank()) return "";
        final StringBuilder sb = new StringBuilder();
        CommandOutput out = new CommandOutput() {
            @Override
            public void sendMessage(Text message) {
                if (message != null) sb.append(message.getString()).append('\n');
            }
            @Override
            public boolean shouldReceiveFeedback() { return true; }
            @Override
            public boolean shouldTrackOutput() { return true; }
            @Override
            public boolean shouldBroadcastConsoleToOps() { return false; }
        };
        CompletableFuture<Boolean> done = new CompletableFuture<>();
        try {
            server.execute(() -> {
                try {
                    ServerCommandSource src = server.getCommandSource().withOutput(out);
                    server.getCommandManager().parseAndExecute(src, command);
                } catch (Throwable t) {
                    sb.append("执行出错：").append(t.getMessage());
                } finally {
                    done.complete(Boolean.TRUE);
                }
            });
        } catch (Exception e) {
            return "调度失败：" + e.getMessage();
        }
        try {
            done.get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            // 超时：把已经收到的部分返回，聊胜于无
        }
        return sb.toString().trim();
    }
}
