#!/bin/sh
# Runs inside the colima VM. Containers (boxes) may reach this Mac only on the
# machine API port, 7700, and on 7701, where checks run their own API's machine
# port. The people port, the stream server, Electric and anything else on the
# Mac's loopback stay out of reach, so a box can never pose as a person or read
# another session's live stream. Safe to run again.
set -eu
HOST=192.168.5.2
iptables -N DOCKER-USER 2>/dev/null || true
# Remove the rules wherever they are, then add them back in order: the allowed
# ports first, then the drop.
for port in 7700 7701; do
  while iptables -D DOCKER-USER -d $HOST -p tcp --dport $port -j ACCEPT 2>/dev/null; do :; done
done
while iptables -D DOCKER-USER -d $HOST -j DROP 2>/dev/null; do :; done
iptables -I DOCKER-USER -d $HOST -j DROP
for port in 7701 7700; do
  iptables -I DOCKER-USER -d $HOST -p tcp --dport $port -j ACCEPT
done
