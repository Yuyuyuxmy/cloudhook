/**
 * 认证相关 API
 */

import { apiClient } from './client';
import { ApiResponse } from '@/types/api';
import {
  getDeviceFingerprint,
  getLegacyFingerprints,
  getKnownDeviceJti,
  rememberDeviceJti,
} from '@/utils/deviceId';

export interface LoginRequest {
  device_name: string;
  master_password: string;
  user_id?: string;
  previous_jti?: string;
  device_fingerprint?: string;
  legacy_fingerprints?: string[];
  turnstile_token?: string;
}

export interface LoginResponse {
  success: boolean;
  token: string;
  device_name: string;
  user_id: string;
  jti?: string;
}

/**
 * 生成 Token（登录）
 * 单用户模式：仅凭 Master Password 登录，device_name 固定占位。
 * 设备身份三层线索（jti 续接 > v2 指纹 > 旧版指纹）见 utils/deviceId.ts。
 */
export async function login(
  masterPassword: string,
  turnstileToken?: string
): Promise<LoginResponse> {
  const response = await apiClient.post<LoginResponse>('/api/token', {
    device_name: 'Web',
    master_password: masterPassword,
    user_id: 'default', // 单用户模式
    previous_jti: getKnownDeviceJti(), // 本浏览器上次绑定的设备，重登时无条件续接
    device_fingerprint: await getDeviceFingerprint(), // v2 机器指纹，跨浏览器归并同一设备
    legacy_fingerprints: await getLegacyFingerprints(), // 历史指纹（v1 哈希/UUID），迁移期匹配旧记录
    turnstile_token: turnstileToken, // 人机验证 token，服务端配了 secret 才校验
  });
  if (response.data?.jti) {
    rememberDeviceJti(response.data.jti); // 绑定关系落盘，logout 后依然可续接
  }
  return response.data;
}

/**
 * 验证 Token 是否有效
 */
export async function validateToken(): Promise<boolean> {
  try {
    const response = await apiClient.get<ApiResponse>('/api/config');
    return response.data.success;
  } catch {
    return false;
  }
}

export interface SetupStatus {
  configured: boolean;
  turnstileSiteKey: string | null;
}

/**
 * 查询服务端是否已配置（MASTER_PASSWORD）。
 * 用于登录页提示部署者：未配置时无法登录，需先在控制台设置环境变量。
 * 同时下发 Turnstile Site Key（公开值），为空表示未启用人机验证。
 */
export async function getSetupStatus(): Promise<SetupStatus> {
  try {
    const response = await apiClient.get<{
      success: boolean;
      configured: boolean;
      turnstile_site_key?: string | null;
    }>('/api/setup-status');
    return {
      configured: response.data.configured,
      turnstileSiteKey: response.data.turnstile_site_key || null,
    };
  } catch {
    // 探测失败时按已配置处理，不阻断正常登录入口
    return { configured: true, turnstileSiteKey: null };
  }
}
