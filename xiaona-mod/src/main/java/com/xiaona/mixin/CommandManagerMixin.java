package com.xiaona.mixin;

import com.xiaona.FakePlayerLimit;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * carpet 假人数量限制的落点（1.21.11）。
 *
 * <p>所有命令（玩家聊天栏、控制台、{@code /execute} 包装）最后都会进
 * {@code CommandManager#parseAndExecute(source, command)}，在这里按原始命令字符串判断：
 * 非 OP 玩家执行 {@code player <名字> spawn} 且名下假人已达上限时取消执行。
 * 判定细节见 {@link FakePlayerLimit}；没装 carpet 或限额关闭时它直接放行，原版行为不变。
 *
 * <p>旧版（1.21.1 / 1.21.8）在 {@code legacy/src/main/java} 下有同名类，注入点换成
 * {@code executeWithPrefix}。
 */
@Mixin(CommandManager.class)
public class CommandManagerMixin {
    @Inject(method = "parseAndExecute", at = @At("HEAD"), cancellable = true)
    private void xiaona$fakePlayerLimit(ServerCommandSource source, String command, CallbackInfo ci) {
        try {
            if (FakePlayerLimit.blocked(source.getServer(), source, command)) ci.cancel();
        } catch (Throwable ignored) {
        }
    }
}
