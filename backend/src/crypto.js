import crypto from "crypto";
import { cfg } from "./config.js";

// AES-256-GCM: output = base64(iv | tag | ciphertext)
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cfg.encKey, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    cfg.encKey,
    buf.subarray(0, 12)
  );
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString(
    "utf8"
  );
}
