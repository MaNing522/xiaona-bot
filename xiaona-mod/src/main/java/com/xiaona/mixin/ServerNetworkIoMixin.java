package com.xiaona.mixin;

import com.xiaona.BotState;
import com.xiaona.PortRelocator;
import net.minecraft.server.ServerNetworkIo;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

/**
 * 在 MC 真正 bind 端口的那一刻，把"被服务商固定住的端口"换成内部备用端口，
 * 从而把那个唯一对外开放的端口让给 {@link com.xiaona.PortMux}。
 *
 * 目标方法：{@code ServerNetworkIo.bind(InetAddress, int)}（1.21.11 yarn）
 */
@Mixin(ServerNetworkIo.class)
public class ServerNetworkIoMixin {
    @ModifyVariable(method = "bind", at = @At("HEAD"), argsOnly = true)
    private int xiaona$relocatePort(int port) {
        int mapped = PortRelocator.map(port);
        if (mapped != port) {
            BotState.log("🔧 MC 端口被固定在 " + port + "（服务商只放行这一个），"
                    + "已把 MC 实际绑定改到内部端口 " + mapped + "；对外仍统一走 " + port
                    + "（玩家照旧用原地址进服）。");
        }
        return mapped;
    }
}