package com.xiaona.mixin;

import com.xiaona.PlayerNames;
import net.minecraft.util.StringHelper;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * 登录名校验：让服务器接受中文游戏ID。
 *
 * <p>各版本原版 {@code StringHelper#isValidPlayerName} 的字符集不一致（有的只认 ASCII），
 * 这里在方法开头先按 {@link PlayerNames} 判一次：符合「1~16 个 Unicode 字母/数字/下划线」
 * 就直接判为合法；不符合就**不接管**，仍由原版决定（不会额外放过空格、§、控制符等）。
 *
 * <p>没有玩家名冲突的副作用：本方法只用于校验，不改名字本身。
 */
@Mixin(StringHelper.class)
public class PlayerNameMixin {
    @Inject(method = "isValidPlayerName", at = @At("HEAD"), cancellable = true)
    private static void xiaona$allowUnicodeName(String name, CallbackInfoReturnable<Boolean> cir) {
        try {
            if (PlayerNames.valid(name)) cir.setReturnValue(true);
        } catch (Throwable ignored) {
        }
    }
}
