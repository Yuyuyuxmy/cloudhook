/**
 * CloudHook - 风控工具库
 * IP 提取、地理位置提取、地理白名单、IP 黑白名单判断
 * 借鉴 UGuard _shared.js / verify.js 的成熟实现，适配 CloudHook 的 risk_control 配置结构。
 *
 * 设计原则：全部为纯函数，不抛异常中断主流程，出错一律「放行」（fail-open），
 * 避免风控自身的边界问题误杀正常请求。
 */

// ============================================================================
// IP 提取
// ============================================================================

/**
 * 提取客户端真实 IP
 * 优先 Cloudflare 注入的 CF-Connecting-IP 头，回退各类代理 header。
 * @param {Request} request - Fetch API Request 对象
 * @returns {string} IP 字符串，无法获取时返回 'unknown'
 */
export function getClientIp(request) {
  try {
    const directIp =
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Real-IP') ||
      request.headers.get('X-Client-IP');

    if (directIp) {
      return directIp.trim();
    }

    // X-Forwarded-For 可能是逗号分隔的链路，取第一个非空
    const forwardedFor = request.headers.get('X-Forwarded-For');
    if (forwardedFor) {
      const firstIp = forwardedFor
        .split(',')
        .map(item => item.trim())
        .find(Boolean);
      if (firstIp) return firstIp;
    }
  } catch (error) {
    console.error('[risk] getClientIp error:', error);
  }

  return 'unknown';
}

// ============================================================================
// 地理位置提取
// ============================================================================

/**
 * 归一化地理字段：去空白，可选转大写
 */
function normalizeLocationValue(value, uppercase) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return uppercase ? normalized.toUpperCase() : normalized;
}

/**
 * 提取请求的地理信息
 * 优先 Cloudflare 注入的 request.cf，回退 CF-IPCountry / X-Geo-* header。
 * @param {Request} request - Fetch API Request 对象
 * @returns {{countryCode: string|null, countryName: string|null, regionCode: string|null, regionName: string|null}}
 */
export function getRequestLocation(request) {
  try {
    const cf = request?.cf ?? {};

    const countryCode =
      normalizeLocationValue(cf.country, true) ||
      normalizeLocationValue(request.headers.get('CF-IPCountry'), true) ||
      normalizeLocationValue(request.headers.get('X-Geo-Country'), true);
    const countryName =
      normalizeLocationValue(cf.country, false);
    const regionCode =
      normalizeLocationValue(cf.regionCode, true) ||
      normalizeLocationValue(request.headers.get('X-Geo-Region'), true);
    const regionName =
      normalizeLocationValue(cf.region, false);

    return { countryCode, countryName, regionCode, regionName };
  } catch (error) {
    console.error('[risk] getRequestLocation error:', error);
    return { countryCode: null, countryName: null, regionCode: null, regionName: null };
  }
}

// ============================================================================
// 工具：归一化字符串列表
// ============================================================================

function normalizeStringList(value, uppercase = false) {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map(item => String(item).trim())
    .filter(Boolean)
    .map(item => (uppercase ? item.toUpperCase() : item));
  return [...new Set(normalized)];
}

// ============================================================================
// 地理白名单判断
// ============================================================================

/**
 * 地理限制检查
 * 国家/地区白名单：列表为空表示该维度不限制；非空则要求命中。
 * @param {object} geoConfig - { enabled, allowed_countries, allowed_regions }
 * @param {Request} request - Fetch API Request 对象
 * @returns {{allowed: boolean, location: object, reason: string}}
 */
export function checkGeoRestriction(geoConfig, request) {
  const location = getRequestLocation(request);

  try {
    // 未开启地理限制：直接放行
    if (!geoConfig || !geoConfig.enabled) {
      return { allowed: true, location, reason: 'geo_disabled' };
    }

    const allowedCountries = normalizeStringList(geoConfig.allowed_countries, true);
    const allowedRegions = normalizeStringList(geoConfig.allowed_regions, true);

    const countryAllowed =
      allowedCountries.length === 0 ||
      (location.countryCode && allowedCountries.includes(location.countryCode));

    const regionAllowed =
      allowedRegions.length === 0 ||
      (location.regionCode && allowedRegions.includes(location.regionCode)) ||
      (location.regionName && allowedRegions.includes(location.regionName.toUpperCase()));

    const allowed = countryAllowed && regionAllowed;
    const reason = allowed
      ? 'geo_allowed'
      : `geo_blocked country=${location.countryCode || 'unknown'} region=${location.regionCode || location.regionName || 'unknown'}`;

    return { allowed, location, reason };
  } catch (error) {
    console.error('[risk] checkGeoRestriction error:', error);
    // 出错放行，避免误杀
    return { allowed: true, location, reason: 'geo_check_error' };
  }
}

// ============================================================================
// IP 黑白名单判断
// ============================================================================

/**
 * IP 访问检查
 * 三种模式：
 *   - off：不限制，全部放行
 *   - allowlist：仅 allowlist 内的 IP 放行
 *   - blocklist：blocklist 内的 IP 拒绝，其余放行
 * @param {object} ipConfig - { mode, allowlist, blocklist }
 * @param {string} ip - 客户端 IP
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkIpAccess(ipConfig, ip) {
  try {
    const mode = ipConfig?.mode || 'off';

    if (mode === 'off') {
      return { allowed: true, reason: 'ip_off' };
    }

    const target = String(ip || '').trim();

    if (mode === 'allowlist') {
      const allowlist = normalizeStringList(ipConfig.allowlist, false);
      const allowed = allowlist.includes(target);
      return {
        allowed,
        reason: allowed ? 'ip_allowlisted' : `ip_not_in_allowlist ip=${target || 'unknown'}`
      };
    }

    if (mode === 'blocklist') {
      const blocklist = normalizeStringList(ipConfig.blocklist, false);
      const blocked = blocklist.includes(target);
      return {
        allowed: !blocked,
        reason: blocked ? `ip_blocklisted ip=${target || 'unknown'}` : 'ip_allowed'
      };
    }

    // 未知模式：放行
    return { allowed: true, reason: 'ip_unknown_mode' };
  } catch (error) {
    console.error('[risk] checkIpAccess error:', error);
    return { allowed: true, reason: 'ip_check_error' };
  }
}
