package com.xiaona;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;

/**
 * 版本差异的收敛点（1.21.1 / 1.21.8 实现）。
 *
 * <p>这一代用 {@code GameProfile} 表示玩家档案，命令执行走 {@code executeWithPrefix}；
 * 1.21.11 起换成了 {@code PlayerConfigEntry} 与 {@code parseAndExecute}。
 */
final class Compat {
    private Compat() {}

    static boolean isOp(MinecraftServer server, ServerPlayerEntity p) {
        try {
            return server.getPlayerManager().isOperator(p.getGameProfile());
        } catch (Exception e) {
            return false;
        }
    }

    static void executeCommand(MinecraftServer server, ServerCommandSource src, String command) {
        server.getCommandManager().executeWithPrefix(src, command);
    }
}
