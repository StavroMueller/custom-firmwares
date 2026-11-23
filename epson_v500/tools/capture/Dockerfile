# Epson's iscan stack for the V500, isolated from the host.
# Built by capture.sh from your own copy of the bundle; nothing of Epson's is in this repo.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      sane-utils gcc libc6-dev libltdl7 libgtk2.0-0 libxml2 libglib2.0-0 libusb-1.0-0 xsltproc udev \
 && rm -rf /var/lib/apt/lists/*

COPY debs/ /tmp/debs/
# The iscan packages ask for "libsane", which Ubuntu calls libsane1, so let dpkg skip that check.
RUN dpkg -i --force-depends /tmp/debs/iscan-data_*.deb /tmp/debs/iscan_*.deb /tmp/debs/iscan-plugin-*.deb \
 && rm -rf /tmp/debs \
 && ln -sf /usr/lib/sane/libsane-epkowa.so.1 /usr/lib/x86_64-linux-gnu/sane/libsane-epkowa.so.1 \
 && grep -qx epkowa /etc/sane.d/dll.d/iscan \
 && grep -q 0x0130 /var/lib/iscan/interpreter \
 && : > /etc/sane.d/dll.conf
# Only epkowa (from dll.d/iscan) is loaded: Ubuntu's ~70 other backends cost
# 14 s of probing, and one of them segfaults in sane_exit.

COPY usblog.c /tmp/usblog.c
RUN gcc -O2 -Wall -shared -fPIC -o /usr/local/lib/usblog.so /tmp/usblog.c -ldl && rm /tmp/usblog.c

COPY scan.sh /usr/local/bin/scan
ENTRYPOINT ["/usr/local/bin/scan"]
