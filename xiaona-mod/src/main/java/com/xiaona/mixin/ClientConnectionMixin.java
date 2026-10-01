package com.xiaona.mixin;

import com.xiaona.PortMux;
import net.minecraft.network.ClientConnection;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.net.InetSocketAddress;
import java.net.SocketAddress;

/**
 * 让服务端"看到"的玩家地址是真实 IP，而不是 127.0.0.1。
 *
 * 复用模式下玩家先连到 {@link PortMux}，再由它转发给 MC；因此 MC 侧每个连接的对端
 * 都是 {@code 127.0.0.1:<上游本地端口>}。这里在 {@code getAddress()} 出口处按该端口
 * 反查真实 IP，使 {@code ServerPlayNetworkHandler.getConnectionAddress()}、
 * {@code ServerPlayerEntity.getIp()}、控制台/日志/封禁等全部拿到真实地址。
 *
 * 目标方法：{@code ClientConnection.getAddress()} 与 {@code getAddressAsString(boolean)}（1.21.11 yarn）
 */
@Mixin(ClientConnection.class)
public class ClientConnectionMixin {
    @Shadow private SocketAddress address;

    @Inject(method = "getAddress", at = @At("HEAD"), cancellable = true)
    private void xiaona$realAddress(CallbackInfoReturnable<SocketAddress> cir) {
        SocketAddress real = xiaona$realAddressOrNull();
        if (real != null) cir.setReturnValue(real);
    }

    @Inject(method = "getAddressAsString", at = @At("HEAD"), cancellable = true)
    private void xiaona$realAddressString(boolean logFailed, CallbackInfoReturnable<String> cir) {
        SocketAddress real = xiaona$realAddressOrNull();
        if (real instanceof InetSocketAddress isa && isa.getAddress() != null) {
            cir.setReturnValue(isa.getAddress().getHostAddress());
        }
    }

    /**
     * 仅当当前地址是环回地址、且能在复用映射里反查到真实 IP 时才返回替换地址，
     * 其余情况返回 null —— 保持 MC 原有行为不变。
     */
    private SocketAddress xiaona$realAddressOrNull() {
        SocketAddress a = this.address;
        if (!(a instanceof InetSocketAddress isa)) return null;
        if (isa.getAddress() == null || !isa.getAddress().isLoopbackAddress()) return null;
        String real = PortMux.realIpOfActive(isa.getPort());
        if (real == null) return null;
        return new InetSocketAddress(real, isa.getPort());
    }
}