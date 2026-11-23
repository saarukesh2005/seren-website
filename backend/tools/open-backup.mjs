// Opens a locked SEREN backup: node tools/open-backup.mjs seren-backup-2026-11-23.json.locked
// It asks for the backup password and writes the plain .json next to the file.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { webcrypto as crypto } from "node:crypto";

const file = process.argv[2];
if (!file) { console.error("Usage: node tools/open-backup.mjs <backup file>"); process.exit(1); }
const box = JSON.parse(readFileSync(file, "utf8"));
if (!box.locked) { console.error("This backup isn't locked; open it directly."); process.exit(1); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = (await rl.question("Backup password: ")).trim();
rl.close();
const from64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));
const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: from64(box.salt), iterations: box.iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
try {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: from64(box.iv) }, key, from64(box.data));
  const out = file.replace(/\.locked$/, "") + (file.endsWith(".locked") ? "" : ".json");
  writeFileSync(out, Buffer.from(plain));
  console.log(`Opened: ${out}`);
} catch {
  console.error("Wrong password, or the file is damaged.");
  process.exit(1);
}
