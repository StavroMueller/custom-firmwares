/*
 * usblog: LD_PRELOAD shim that logs every libusb bulk and interrupt transfer,
 * with full data, to the file named by $USBLOG. usbmon can't do this on
 * machines whose IOMMU merges DMA buffers: it records large transfers with
 * no data (flag 'D').
 *
 * File: "V5USBLOG" then records of
 *   double t; u8 endpoint; u8 kind ('B' bulk, 'I' interrupt); i32 rc;
 *   u32 requested; u32 actual; u8 data[OUT ? requested : actual]
 * little-endian, packed. Decode with tools/usbpcap.py.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

typedef int (*xfer_fn)(void *, unsigned char, unsigned char *, int, int *, unsigned int);

static FILE *out;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void record(char kind, unsigned char ep, int rc, unsigned char *data, int len, int actual) {
    pthread_mutex_lock(&lock);
    if (!out) {
        const char *path = getenv("USBLOG");
        if (path && (out = fopen(path, "wb"))) fwrite("V5USBLOG", 1, 8, out);
    }
    if (out) {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        double t = ts.tv_sec + ts.tv_nsec / 1e9;
        uint8_t k = (uint8_t)kind;
        int32_t r = rc;
        uint32_t req = len, act = actual < 0 ? 0 : actual;
        uint32_t n = (ep & 0x80) ? act : req;
        fwrite(&t, 8, 1, out); fwrite(&ep, 1, 1, out); fwrite(&k, 1, 1, out);
        fwrite(&r, 4, 1, out); fwrite(&req, 4, 1, out); fwrite(&act, 4, 1, out);
        fwrite(data, 1, n, out);
        fflush(out);
    }
    pthread_mutex_unlock(&lock);
}

static int call(const char *name, char kind, void *h, unsigned char ep, unsigned char *data,
                int len, int *transferred, unsigned int timeout) {
    xfer_fn real = (xfer_fn)dlsym(RTLD_NEXT, name);
    int got = 0;
    int rc = real(h, ep, data, len, &got, timeout);
    if (transferred) *transferred = got;
    record(kind, ep, rc, data, len, got);
    return rc;
}

int libusb_bulk_transfer(void *h, unsigned char ep, unsigned char *data, int len,
                         int *transferred, unsigned int timeout) {
    return call("libusb_bulk_transfer", 'B', h, ep, data, len, transferred, timeout);
}

int libusb_interrupt_transfer(void *h, unsigned char ep, unsigned char *data, int len,
                              int *transferred, unsigned int timeout) {
    return call("libusb_interrupt_transfer", 'I', h, ep, data, len, transferred, timeout);
}
