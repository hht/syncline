/**
 * 设备与云端的协议版本怎么对：设备在网址上带自己的版本，对不上时按谁新决定停下等更新还是照常重试。
 * 不该知道的：消息的格式、怎么连、怎么重试。
 */

/**
 * 协议的版本：两端不兼容地改了消息格式才加一。设备在拉取与连接的网址上带 v=版本，共用空间的缓存键因此按版本分开；
 * 云端入口对不上就回云端的版本：HTTP 拉取回 409、正文是版本，WebSocket 先接受再以 versionMismatch 关闭、原因是版本。
 * 云端的新：设备停下，同步状态报要更新 App；云端的旧（部署回滚中）：照常退避重试
 * @see https://doc.replicache.dev/api/classes/Replicache#onupdateneeded
 * @see https://github.com/rocicorp/mono/blob/main/packages/zero-protocol/src/protocol-version.ts
 */
export const protocolVersion = 5;
export const versionParam = 'v';
export const versionMismatch = 4002;
export const versionConflict = 409;

/** 云端回的版本与设备的对不上；cloud 是云端的版本 */
export class VersionMismatch extends Error {
  readonly cloud: number;

  constructor(cloud: number) {
    super(
      cloud > protocolVersion ? `云端的同步协议更新（第 ${cloud} 版），要更新 App` : `云端的同步协议更旧（第 ${cloud} 版），等云端部署完`,
    );
    this.cloud = cloud;
  }
}
