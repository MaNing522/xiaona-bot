package com.xiaona.mixin;

import com.xiaona.FakePlayerLimit;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * carpet 假人数量限制的落点（1.21.1 / 1.21.8）。
 *
 * <p>这一代命令的统一入口叫 {@code CommandManager#executeWithPrefix(source, command)}
 * （1.21.11 换成了 {@code parseAndExecute}，见共享源码里的同名类）。
 */
@Mixin(CommandManager.class)
public class CommandManagerMixin {
    @Inject(method = "executeWithPrefix", at = @At("HEAD"), cancellable = true)
    private void xiaona$fakePlayerLimit(ServerCommandSource source, String command, CallbackInfo ci) {
        try {
            if (FakePlayerLimit.blocked(source.getServer(), source, command)) ci.cancel();
        } catch (Throwable ignored) {
        }
    }
}
