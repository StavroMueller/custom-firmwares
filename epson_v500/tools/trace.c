/*
 * trace: load Epson's closed V500 plugin with fake USB callbacks and log
 * every transfer it makes. No scanner needed. This captures the traffic the
 * plugin sends from int_init(), which is the firmware upload.
 *
 *   gcc -O1 -Wall -rdynamic -o trace trace.c -ldl
 *   ISCAN_FW_DIR=/usr/share/iscan ./trace /usr/lib/iscan/libesint7C.so.2.0.1
 *
 * Writes a readable log to stderr. All bytes written, back to back, go to
 * writes.bin.
 *
 * Plugin interface (from disassembly):
 *   bool int_init(int fd, io_fn read, io_fn write);
 *   typedef int (*io_fn)(unsigned char *buf, unsigned len);
 *
 * FAKE_STATUS=<byte> sets the second byte of the fake 2-byte status reply.
 */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int (*io_fn)(unsigned char *buf, unsigned len);
typedef int (*init_fn)(int fd, io_fn read, io_fn write);

/* The plugin imports this from its host (iscan). */
int INTPowerSavingMode(void) { return 0; }

#define ACK 0x06
#define MAX_READS 200

static FILE *raw_log;
static long n_writes, n_bytes, n_reads;

static void dump(const char *dir, const unsigned char *buf, unsigned len) {
    fprintf(stderr, "%s %6u:", dir, len);
    for (unsigned i = 0; i < len && i < 24; i++) fprintf(stderr, " %02x", buf[i]);
    fputs(len > 24 ? " ...\n" : "\n", stderr);
}

static int fake_write(unsigned char *buf, unsigned len) {
    fwrite(buf, 1, len, raw_log);
    n_writes++;
    n_bytes += len;
    dump("->", buf, len);
    return len;
}

/* Every reply is an ACK, padded with zeros. */
static int fake_read(unsigned char *buf, unsigned len) {
    if (++n_reads > MAX_READS) {
        fprintf(stderr, "read budget spent: %ld writes, %ld bytes\n", n_writes, n_bytes);
        exit(0);
    }
    memset(buf, 0, len);
    if (len) buf[0] = ACK;
    const char *status = getenv("FAKE_STATUS");
    if (len == 2 && status) buf[1] = (unsigned char)strtol(status, NULL, 0);
    dump("<-", buf, len);
    return len;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s libesint7C.so\n", argv[0]);
        return 2;
    }
    void *plugin = dlopen(argv[1], RTLD_NOW | RTLD_GLOBAL);
    if (!plugin) {
        fprintf(stderr, "%s\n", dlerror());
        return 1;
    }
    init_fn int_init = (init_fn)dlsym(plugin, "int_init");
    if (!int_init) {
        fprintf(stderr, "no int_init in %s\n", argv[1]);
        return 1;
    }
    raw_log = fopen("writes.bin", "wb");
    if (!raw_log) {
        perror("writes.bin");
        return 1;
    }

    int ok = int_init(0, fake_read, fake_write);

    fclose(raw_log);
    fprintf(stderr, "int_init -> %d after %ld writes / %ld bytes\n", ok, n_writes, n_bytes);
    return ok ? 0 : 1;
}
