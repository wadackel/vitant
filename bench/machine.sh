#!/bin/sh
# What the machine is doing, every half minute until it is killed: the load,
# the memory and swap, and the processes using the most processor time, for
# reading a run that slowed down as it went.
cat /sys/kernel/mm/transparent_hugepage/enabled /sys/kernel/mm/transparent_hugepage/defrag 2>/dev/null | sed 's/^/thp: /'
while :; do
  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  uptime
  if [ "$(uname)" = Darwin ]; then
    sysctl -n vm.swapusage
    memory_pressure | tail -n 1
  else
    free -m
  fi
  echo "processes: $(ps -A -o pid= | wc -l), node: $(ps -A -o comm= | grep -c node)"
  ps -A -o pid=,ppid=,pcpu=,rss=,time=,etime=,args= | sort -k3 -nr | head -n 15 | cut -c 1-200
  sleep 30
done
