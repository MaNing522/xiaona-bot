package com.xiaona;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;

/**
 * 版本差异的收敛点（1.21.11 实现）。
 *
 * <p>1.21.11 起玩家档案从 {@code GameProfile} 换成了 {@code PlayerConfigEntry}，
 * 命令执行也从 {@code executeWithPrefix} 换成了 {@code parseAndExecute}。
 * 共享代码只调这里，旧版由 {@code legacy/src/main/java} 下的同名类覆盖。
 */
final class Compat {
    private Compat() {}

    static boolean isOp(MinecraftServer server, ServerPlayerEntity p) {
        try {
            return server.getPlayerManager().isOperator(p.getPlayerConfigEntry());
        } catch (Exception e) {
            return false;
        }
    }

    static void executeCommand(MinecraftServer server, ServerCommandSource src, String command) {
        server.getCommandManager().parseAndExecute(src, command);
    }
}
