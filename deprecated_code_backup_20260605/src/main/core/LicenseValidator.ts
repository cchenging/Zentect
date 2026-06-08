import * as crypto from 'crypto';

export interface LicensePayload {
  version: string;
  expireAt: string;
  features: string[];
}

/** V1.1 License 本地校验器 — RSA 验签 + 过期检查 */
export class LicenseValidator {
  private static readonly PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn63B/4J9k13G31xdOFiT
2vE26HwZKU2p44TJ9QWpLlbJqdua+L9Lwe+AnyNTh56O9A0KhLTd/eBJ7/5xx0B6
6elV14Lv3+Pf3B3z4sfISu8W276YFo73yakEd/6l9IkEht6KHcInWcpOEklOlLve
8PZK6LY/ogdfSqmg3sXTJ//sKDBFnFOKe7aSv0LQi2+DgEtHRHreAj1DE4W10zDR
QljlFgEYaYgtfZUJaIqHTx5ywR3J9tqRegmbCF1Jl9DskpqhWlTB1RORT6waLfYc
XMIaRFgHLh1DegaDxxRhsRaHYvdDN8xgpqf9L8+sG7jXQhg0VTL1UtkW8zpxjCDk
UQIDAQAB
-----END PUBLIC KEY-----`;

  /** 验证 License Key 的 RSA 签名并解析 Payload */
  validate(licenseKey: string): { valid: true; payload: LicensePayload } | { valid: false; error: string } {
    try {
      const parts = licenseKey.split('.');
      if (parts.length !== 2) {
        return { valid: false, error: 'License Key 格式无效，需要 base64.payload.base64.signature' };
      }

      const [payloadB64, signatureB64] = parts;

      const payloadJson = Buffer.from(payloadB64, 'base64').toString('utf-8');
      const payload: LicensePayload = JSON.parse(payloadJson);

      if (!payload.version || !payload.expireAt) {
        return { valid: false, error: 'License 数据不完整，缺少必要字段' };
      }

      const expireDate = new Date(payload.expireAt);
      if (isNaN(expireDate.getTime())) {
        return { valid: false, error: 'License 过期时间格式无效' };
      }

      if (expireDate < new Date()) {
        return { valid: false, error: `License 已于 ${payload.expireAt} 过期` };
      }

      const verify = crypto.createVerify('SHA256');
      verify.update(payloadB64);
      verify.end();

      const signature = Buffer.from(signatureB64, 'base64');
      const isValid = verify.verify(LicenseValidator.PUBLIC_KEY, signature);

      if (!isValid) {
        return { valid: false, error: 'License 签名验证失败，密钥可能被篡改' };
      }

      return { valid: true, payload };
    } catch (err: any) {
      return { valid: false, error: `License 解析异常: ${err.message}` };
    }
  }
}
