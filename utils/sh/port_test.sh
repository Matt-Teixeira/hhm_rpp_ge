#!/bin/bash

# BOMB SCRIPT FOR UNDEFINED VAR OR ERR DURING EXECUTION
set -ue

# https://linux.die.net/man/1/nmap
# -Pn: Treat all hosts as online -- skip host discovery
# -sV: Probe open ports to determine service/version info
# nmap -p 21 -Pn --max-retries 1 --host-timeout 3s 172.31.3.19
nmap -p $1 -Pn --max-retries 1 --host-timeout 3s $2

# http://man.he.net/man1/netcat
# -z Only scan for listening daemons, without sending any data to them.  Cannot be used together with -l.
# -v Produce more verbose output.
# -w Timeout
# nc -zv -w3 172.31.3.19 21
# nc -zv -w3 $2 $1