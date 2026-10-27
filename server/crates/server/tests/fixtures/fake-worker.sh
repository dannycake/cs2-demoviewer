#!/bin/sh
# A stand-in for `demoviewer-server parse-worker <demo> <pack>`, for tests/jobs.rs. What it
# does depends on byte 16 of the demo (the first byte `common::fake_demo` leaves free).
demo=$2
pack=$3
case $(od -An -tu1 -j16 -N1 "$demo" | tr -d ' ') in
1) printf 'pack bytes' > "$pack"
   echo 'a stray line before the outcome'
   echo '{"packed":{"summary":{"sha256":"","map":"de_script","rounds":3,"scoreT":2,"scoreCt":1,"durationS":600,"serverName":"script","gameBuild":"1","players":[],"createdUnix":0,"playedUnix":null,"matchId":null}}}' ;;
2) echo '{"failed":{"error":"scripted failure"}}' ;;
3) exit 3 ;;
4) echo $$ > "${pack%/*}/../slow-worker.pid"
   exec sleep 30 ;;
5) printf 'pack bytes' > "$pack"
   long=$(head -c 200000 /dev/zero | tr '\0' x)
   echo '{"packed":{"summary":{"sha256":"","map":"de_script","rounds":3,"scoreT":2,"scoreCt":1,"durationS":600,"serverName":"'"$long"'","gameBuild":"1","players":[],"createdUnix":0,"playedUnix":null,"matchId":null}}}' ;;
*) echo 'no outcome here' ;;
esac
