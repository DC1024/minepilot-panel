import secrets, string, re

alpha = string.ascii_letters + string.digits + "_-"
tok = "".join(secrets.choice(alpha) for _ in range(48))
ok = bool(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", tok))
with open(r"C:/Users/15657.DC-PC/WorkBuddy/2026-10-10-21-01-25/mcp_token.txt", "w") as f:
    f.write(tok)
print("len=%d valid=%s" % (len(tok), ok))
