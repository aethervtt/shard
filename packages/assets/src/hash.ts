const HEX: string[] = []
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'))

function hex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!]
  return out
}

/** SHA-256 of some bytes, as lowercase hex. WebCrypto, so it runs on every host. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)))
}

/** 128 random bits as 32 lowercase hex characters. */
export function randomGuid(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)))
}
