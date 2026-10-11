# -*- coding: utf-8 -*-
"""拉取服务器本体配置现状：compose / server.properties / ops.json / whitelist.json / 容器 env。"""
import sys, re
sys.path.insert(0, r"<OPS_DIR>")   # 本机 ops 工具目录
from ssh_run import connect, run, close

BASE = r"<WORKSPACE_DIR>"          # 本机工作区目录
HOST, PORT, USER, PW = "<SERVER_IP>", 10000, "<NAS_USER>", "<NAS_PASSWORD>"
COMPOSE = "<COMPOSE_DIR>"          # 远端 Docker Compose 项目目录
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
res = []


def sh(cmd, label, timeout=120, cap=6000):
    try:
        rc, o, e = run(c, cmd, timeout=timeout)
        t = ANSI.sub("", o).replace("\r", "")
        res.append("### %s (rc=%s)\n%s" % (label, rc, t.strip()[:cap]))
    except Exception as ex:
        res.append("### %s EXC %s" % (label, ex))


try:
    c = connect(HOST, port=PORT, user=USER, password=PW, timeout=30)
    sh("echo %s | sudo -S cat %s/docker-compose.yml" % (PW, COMPOSE), "compose")
    sh("echo %s | sudo -S docker inspect mc-server "
       "--format '{{range .Config.Env}}{{println .}}{{end}}'" % PW, "container_env")
    sh("echo %s | sudo -S docker exec mc-server cat /data/server.properties" % PW, "server_properties")
    sh("echo %s | sudo -S docker exec mc-server sh -c 'ls -la /data/*.json 2>/dev/null'" % PW, "json_files")
    sh("echo %s | sudo -S docker exec mc-server sh -c 'cat /data/ops.json 2>/dev/null'" % PW, "ops_json")
    sh("echo %s | sudo -S docker exec mc-server sh -c 'cat /data/whitelist.json 2>/dev/null'" % PW, "whitelist_json")
    sh("echo %s | sudo -S docker exec mc-server sh -c 'cat /data/banned-players.json 2>/dev/null'" % PW, "banned_json")
finally:
    if c:
        try:
            close(c)
        except Exception:
            pass
    with open(BASE + "/server_cfg_dump.txt", "w", encoding="utf-8") as f:
        f.write("\n\n".join(res))
    print("done")
