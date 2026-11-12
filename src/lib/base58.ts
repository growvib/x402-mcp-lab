// Base58, the alphabet Solana writes every address, blockhash and signature in.
//
// Byte arithmetic rather than BigInt: the values here are 32 and 64 byte keys, and the leading
// zero rule (one "1" per leading zero byte, outside the arithmetic) is easier to get right when
// the digits are the representation rather than a conversion of one.
//
// The alphabet is Bitcoin's: the full base62 set with the four characters that misread by hand
// removed (0, O, I, l). That is the whole reason the encoding exists, and it is why an address
// can be compared across a screen and a wallet without a magnifier.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ZERO_DIGIT = "1";

const INDEX: ReadonlyMap<string, number> = new Map([...ALPHABET].map((character, i) => [character, i]));

export function encodeBase58(bytes: ArrayLike<number> | null | undefined): string {
  const input = Uint8Array.from(bytes ?? []);
  if (input.length === 0) return "";

  // Repeated division of the whole number by 58, carried through the digit array.
  const digits = [0];
  for (const byte of input) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += (digits[i] ?? 0) << 8;
      digits[i] = carry % 58;
      carry = Math.trunc(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.trunc(carry / 58);
    }
  }

  // The high-order zeros of the NUMBER are not digits: leading zero bytes are carried by the "1"
  // prefix below, and emitting them twice is how the all-zero key (the System Program id, which is
  // 32 zero bytes and reads as 32 ones) grows a 33rd character.
  while (digits.length > 1 && digits.at(-1) === 0) digits.pop();
  if (digits.length === 1 && digits[0] === 0) digits.pop();

  let out = "";
  // A leading zero byte carries no value, so it survives only as an explicit "1".
  for (let i = 0; i < input.length && input[i] === 0; i += 1) out += ZERO_DIGIT;
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i] ?? 0];
  return out;
}

/**
 * decodeBase58 returns the bytes, or null for anything that is not base58. Null rather than a
 * throw: every caller here is handling a string somebody pasted or a server sent, where "this is
 * not an address" is an ordinary answer rather than an exceptional one.
 */
export function decodeBase58(text: unknown): Uint8Array | null {
  const input = typeof text === "string" ? text : "";
  if (input.length === 0) return null;

  const bytes = [0];
  for (const character of input) {
    const value = INDEX.get(character);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Same rule in reverse: the accumulator keeps a high-order zero that the "1" prefix already
  // accounts for, and leaving it in makes the System Program id decode to 33 bytes. A 33 byte key
  // is not a key, and it shifts every byte after it in a serialized message.
  while (bytes.length > 0 && bytes.at(-1) === 0) bytes.pop();

  let zeros = 0;
  while (zeros < input.length && input[zeros] === ZERO_DIGIT) zeros += 1;
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[zeros + i] = bytes[bytes.length - 1 - i] ?? 0;
  return out;
}

/**
 * isBase58Address is the shape check: 32 bytes, which is every Solana public key, program id and
 * blockhash. It says nothing about whether the key exists or is on the curve.
 */
export function isBase58Address(text: unknown): text is string {
  const raw = decodeBase58(text);
  return raw !== null && raw.length === 32;
}
