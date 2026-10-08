// Types for deflate.js (plain JavaScript so worker threads can import it without a loader).

/** Compresses `input` to a raw DEFLATE stream (one final block). Same bytes on every host. */
export declare function deflate(input: Uint8Array): Uint8Array
/**
 * Decompresses a raw DEFLATE stream into exactly `size` bytes. Throws an error with code
 * `terrain/corrupt-pack` when the stream is damaged or doesn't hold `size` bytes.
 */
export declare function inflate(input: Uint8Array, size: number): Uint8Array
/** Huffman code lengths for `freqs`, at most `limit` bits, the same on every host. */
export declare function codeLengths(freqs: ArrayLike<number>, limit: number): Uint8Array
