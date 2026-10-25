package com.xiaona.mixin;

import com.xiaona.WhitelistGate;
import com.mojang.authlib.GameProfile;
import net.minecraft.server.PlayerManager;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.net.SocketAddress;

/**
 * 白名单模式的落点：在 MC 判定"这名玩家能不能进服"的时刻插一杠子。
 *
 * <p>1.21.1 / 1.21.8 的目标方法签名是
 * {@code PlayerManager#checkCanJoin(SocketAddress, GameProfile)}；
 * 1.21.11 起第二个参数换成了 {@code PlayerConfigEntry}（见根项目里的同名文件）。
 * 逻辑本身完全交给 {@link WhitelistGate}，这里只负责把档案传进去。
 */
@Mixin(PlayerManager.class)
public class PlayerManagerMixin {
    @Inject(method = "checkCanJoin", at = @At("HEAD"), cancellable = true)
    private void xiaona$whitelistGate(SocketAddress address, GameProfile profile,
                                      CallbackInfoReturnable<Text> cir) {
        try {
            WhitelistGate gate = WhitelistGate.instance();
            if (gate == null || !gate.shouldGate(profile)) return;
            // gate() 返回 null = 放行（已补进白名单）；非 null = 用这段文本踢出
            cir.setReturnValue(gate.gate(profile));
        } catch (Throwable ignored) {
        }
    }
}
