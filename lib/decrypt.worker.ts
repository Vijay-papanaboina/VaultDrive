import { decryptMetaZip } from "./crypto";

self.addEventListener("message", async (e: MessageEvent) => {
  const { fileId, identity, encryptedData } = e.data;
  try {
    const result = await decryptMetaZip(identity, encryptedData);
    self.postMessage({ fileId, success: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Decryption failed";
    self.postMessage({ fileId, success: false, error: msg });
  }
});
