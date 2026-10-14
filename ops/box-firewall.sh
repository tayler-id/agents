#!/bin/sh
# Runs inside the colima VM, as root, at every start from colima's provision
# step. Safe to run again.
#
# Every container may reach this Mac only on the machine API port, 7700, and on
# 7701, where checks run their own API's machine port. The people port, the
# stream server, Electric and anything else on the Mac's loopback stay out of
# reach, so a box can never pose as a person or read another session's live
# stream.
#
# Boxes run on Docker's default bridge, docker0, and get less. As on the AWS box
# host, they reach no address in RANGES (BOX_CLOSED_RANGES in ops/aws/config.ts)
# and nothing of this VM except DNS on port 53, where its resolver answers them.
# Answers to connections made from outside a box still pass, so published ports
# keep working. Compose's services run on their own network and keep what
# they reach now, except for the Mac. test/step11g.ts checks all of this in a
# copy of the VM's network.
set -eu
HOST=192.168.5.2
RANGES='0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4'

iptables -N DOCKER-USER 2>/dev/null || true
# The boxes' chains, made or emptied, then filled.
for chain in AGENTS-BOXES AGENTS-BOXES-IN; do
  iptables -N $chain 2>/dev/null || iptables -F $chain
done
iptables -A AGENTS-BOXES -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for range in $RANGES; do
  iptables -A AGENTS-BOXES -d "$range" -j DROP
done
iptables -A AGENTS-BOXES-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for proto in udp tcp; do
  iptables -A AGENTS-BOXES-IN -p $proto --dport 53 -j RETURN
done
iptables -A AGENTS-BOXES-IN -j DROP

# Remove the jumps and this Mac's rules wherever they are, then add them back in
# order at the top: the machine ports, the drop for the rest of this Mac, then the
# boxes' chain.
for port in 7700 7701; do
  while iptables -D DOCKER-USER -d "$HOST" -p tcp --dport $port -j ACCEPT 2>/dev/null; do :; done
done
while iptables -D DOCKER-USER -d "$HOST" -j DROP 2>/dev/null; do :; done
while iptables -D DOCKER-USER -i docker0 -j AGENTS-BOXES 2>/dev/null; do :; done
while iptables -D INPUT -i docker0 -j AGENTS-BOXES-IN 2>/dev/null; do :; done
iptables -I DOCKER-USER -i docker0 -j AGENTS-BOXES
iptables -I DOCKER-USER -d "$HOST" -j DROP
for port in 7701 7700; do
  iptables -I DOCKER-USER -d "$HOST" -p tcp --dport $port -j ACCEPT
done
iptables -I INPUT -i docker0 -j AGENTS-BOXES-IN
