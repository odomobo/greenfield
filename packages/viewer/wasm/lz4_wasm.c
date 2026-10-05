/* LZ4 (BSD 2-clause, see lz4.c) compiled freestanding for wasm, plus the entry point the benchmark calls. */
#define LZ4_FREESTANDING 1
#define LZ4_memcpy(dst, src, size) __builtin_memcpy(dst, src, size)
#define LZ4_memmove(dst, src, size) __builtin_memmove(dst, src, size)
#define LZ4_memset(p, v, n) __builtin_memset(p, v, n)
#include "lz4.c"

int lz4_decompress(const char *src, int src_size, char *dst, int capacity) {
    return LZ4_decompress_safe(src, dst, src_size, capacity);
}
