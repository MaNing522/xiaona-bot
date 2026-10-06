package com.xiaona.mixin;

import com.xiaona.WhitelistGate;
import net.minecraft.server.PlayerConfigEntry;
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
 * 原版就是在这里查白名单 —— {@code PlayerManager#checkCanJoin(SocketAddress, PlayerConfigEntry)}
 * 返回 null 表示放行，返回 Text 则作为踢出理由（白名单不通过时是
 * {@code multiplayer.disconnect.not_whitelisted}）。它由登录处理器在**认证完成之后、
 * 真正入服之前**调用，所以在这里"补进白名单并放行 / 换成自定义提示踢出"都来得及。
 *
 * 是否接管、以及放行还是踢出，全交给 {@link WhitelistGate}：
 * 白名单模式没开时它返回 false，本注入什么都不做，原版行为分毫不变。
 *
 * 目标方法：{@code PlayerManager#checkCanJoin(SocketAddress, PlayerConfigEntry)}（1.21.11 yarn）
 */
@Mixin(PlayerManager.class)
public class PlayerManagerMixin {
    @Inject(method = "checkCanJoin", at = @At("HEAD"), cancellable = true)
    private void xiaona$whitelistGate(SocketAddress address, PlayerConfigEntry entry,
                                      CallbackInfoReturnable<Text> cir) {
        try {
            WhitelistGate gate = WhitelistGate.instance();
            if (gate == null || !gate.shouldGate(entry)) return;
            // gate() 返回 null = 放行（已补进白名单）；非 null = 用这段文本踢出
            cir.setReturnValue(gate.gate(entry));
        } catch (Throwable ignored) {
        }
    }
}
